import * as core from '@actions/core';
import { Buffer } from 'buffer'; // Needed for Buffer.from
import path from 'path';
import { TextDecoder } from 'util';
import type { GitHub } from '@actions/github/lib/utils';
import type { Context } from '@actions/github/lib/context';

// Define a simple interface for the file object from Octokit
export interface ChangedFile {
  filename: string;
  status?: string;
  previous_filename?: string;
}

function getHttpStatus(cause: unknown): number | undefined {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export class GitHubOperationError extends Error {
  readonly cause?: unknown;
  constructor(
    message: string,
    readonly status?: number,
    cause?: unknown
  ) {
    super(message);
    this.name = 'GitHubOperationError';
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
  }
}

export class SchemaSourceError extends GitHubOperationError {
  constructor(
    message: string,
    readonly category: string,
    status?: number,
    cause?: unknown
  ) {
    super(message, status, cause);
    this.name = 'SchemaSourceError';
  }
}

export function getSchemaSourcePaths(change: ChangedFile): { base?: string; head: string } {
  if (change.status === 'removed') {
    throw new SchemaSourceError('Removed schema review is unsupported. Review this deletion manually.', 'unsupported_change');
  }
  if (!['modified', 'added', 'renamed'].includes(change.status || '')) {
    throw new SchemaSourceError('Schema review requires supported, unambiguous PR change metadata.', 'unsupported_change');
  }
  if (change.status === 'renamed' && (typeof change.previous_filename !== 'string' || !change.previous_filename)) {
    throw new SchemaSourceError('Renamed schema review requires its previous filename.', 'unsupported_change');
  }
  return {
    base: change.status === 'added' ? undefined : change.status === 'renamed' ? change.previous_filename : change.filename,
    head: change.filename,
  };
}

// Interface for AI Review data (matching the updated AiResponseSchema in ai.ts)
export interface AiReview {
  executiveSummary: string;
  effectedConsumers: {
    name: string;
    version: string;
    warning: string;
    url: string;
  }[];
  score: number;
  schemaFormat: string;
}

export interface ReviewedFile {
  filePath: string;
  oldFileContent?: string | null;
  newFileContent?: string;
  sourceError?: SchemaSourceError;
  aiReview?: AiReview;
  aiError?: string;
}

export interface InitialChecksResult {
  changedFilePaths: string[];
  shouldContinue: boolean;
}

function containsDirectory(targetPath: string, directoryName: string) {
  const segments = path.normalize(targetPath).split(path.sep);
  const directorySegments = path
    .normalize(directoryName)
    .split(path.sep)
    .filter((segment) => segment !== '.');
  return (
    directorySegments.length === 0 ||
    segments.some((_, index) => directorySegments.every((segment, offset) => segments[index + offset] === segment))
  );
}

// A successful result is exact UTF-8 file content, including an empty string.
// Absence is established separately by PR change metadata, never by a caught 404.
export async function getFileContentAtRef(
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  filePath: string,
  ref: string
): Promise<string> {
  let response: unknown;
  try {
    const result = await octokit.rest.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: filePath,
      ref,
    });
    response = result.data;
  } catch (cause) {
    const status = getHttpStatus(cause);
    const nestedCause = (cause as { cause?: unknown } | null)?.cause;
    const timedOut = [cause, nestedCause].some(
      (error) => error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
    );
    const transportFailure =
      cause instanceof TypeError || (nestedCause instanceof Error && !(cause as { response?: unknown }).response);
    throw new SchemaSourceError(
      timedOut
        ? 'Schema source retrieval timed out or was aborted.'
        : `Schema source retrieval failed (${transportFailure || !status ? 'network error' : `HTTP ${status}`}).`,
      timedOut ? 'timeout' : transportFailure || !status ? 'network' : 'request_failed',
      status,
      cause
    );
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new SchemaSourceError('Schema source response is not a file.', 'invalid_response');
  }
  const file = response as Record<string, unknown>;
  if (
    file.type !== 'file' ||
    file.submodule_git_url ||
    typeof file.content !== 'string' ||
    !Number.isSafeInteger(file.size) ||
    (file.size as number) < 0 ||
    file.truncated === true
  ) {
    throw new SchemaSourceError('Schema source response has missing, unsupported or truncated file content.', 'invalid_response');
  }
  if (file.encoding !== 'base64') {
    throw new SchemaSourceError(
      'Schema source encoding is unsupported; complete base64 content is required.',
      'unsupported_encoding'
    );
  }
  const encoded = file.content.replace(/\s/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length !== file.size) {
    throw new SchemaSourceError('Schema source content is malformed or incomplete.', 'invalid_content');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new SchemaSourceError('Schema source is not valid UTF-8 text.', 'invalid_content', undefined, cause);
  }
}

/**
 * Get the changed files in the catalog directory
 * @param octokit - The octokit instance
 * @param context - The context object
 * @param catalogDirectory - The catalog directory
 * @returns The changed files in the catalog directory
 */
export async function getChangedFileDetailsInCatalogDirectory(
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  catalogDirectory: string | undefined
): Promise<ChangedFile[]> {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request!.number,
  });
  if (!catalogDirectory) return files;
  core.info(`Filtering changed files for directory: ${catalogDirectory}`);
  return files.filter(
    (file) =>
      containsDirectory(file.filename, catalogDirectory) ||
      Boolean(file.previous_filename && containsDirectory(file.previous_filename, catalogDirectory))
  );
}

// Preserve the string-list contract for the action entrypoint and existing callers.
export async function getChangedFilesInCatalogDirectory(
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  catalogDirectory: string | undefined
): Promise<string[]> {
  return (await getChangedFileDetailsInCatalogDirectory(octokit, context, catalogDirectory)).map((file) => file.filename);
}

export async function upsertComment(
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  pullRequestNumber: number,
  commentBody: string,
  commentMarker: string
): Promise<number> {
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  let existingCommentId: number | undefined;

  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullRequestNumber,
    });
    for (const comment of comments) {
      if (comment.body?.includes(commentMarker)) {
        existingCommentId = comment.id;
        break;
      }
    }
  } catch (error) {
    core.warning(
      `Failed to list comments (${getHttpStatus(error) ? `HTTP ${getHttpStatus(error)}` : 'request error'}). Proceeding to create a new comment.`
    );
  }

  try {
    if (existingCommentId) {
      core.info(`Updating existing comment id: ${existingCommentId}`);
      const { data: updatedComment } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingCommentId,
        body: commentBody,
      });
      return updatedComment.id;
    } else {
      core.info('Creating new comment');
      const { data: newComment } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullRequestNumber,
        body: commentBody,
      });
      return newComment.id;
    }
  } catch (cause) {
    const status = getHttpStatus(cause);
    throw new GitHubOperationError(
      `Schema review comment publication failed (${status ? `HTTP ${status}` : 'request error'}).`,
      status,
      cause
    );
  }
}
