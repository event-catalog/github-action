import * as core from '@actions/core';
import type { GitHub } from '@actions/github/lib/utils';
import utils from '@eventcatalog/sdk';
import path from 'path';

import {
  getChangedFileDetailsInCatalogDirectory,
  getSchemaSourcePaths,
  SchemaSourceError,
  ReviewedFile,
  upsertComment,
} from '@/lib/github';
import { Context } from '@actions/github/lib/context';
import { getSchemasFromFilePaths } from '@/lib/eventcatalog';
import { reviewSchema } from './review';
import { generateGitHubCommentForSchemaReview } from './github-comment';
import { responseSchema } from './prompt';
import { DEFAULT_OPENAI_MODEL } from '@/ai-models/openai';

const COMMENT_MARKER = '<!-- eventcatalog-schema-review-comment -->';

interface TaskParams {
  octokit: InstanceType<typeof GitHub>;
  context: Context;
  catalogDirectory: string;
}

export const task = async ({ octokit, context, catalogDirectory }: TaskParams) => {
  const failureThresholdInput = core.getInput('failure_threshold');
  const failureThreshold = parseInt(failureThresholdInput, 10);
  const CATALOG_PATH = path.join(process.cwd(), catalogDirectory);

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullRequestNumber = context.payload.pull_request!.number;
  const model = core.getInput('model') || DEFAULT_OPENAI_MODEL;
  const provider = core.getInput('provider') || 'openai';

  const { getMessageBySchemaPath, getProducersAndConsumersForMessage } = utils(CATALOG_PATH);

  core.info(`Catalog path: ${CATALOG_PATH}`);

  if (isNaN(failureThreshold) || failureThreshold < 0 || failureThreshold > 100) {
    core.setFailed('Invalid input for `failure_threshold`. Must be a number between 0 and 100.');
    return;
  }

  const changedEventCatalogFilesInPullRequest = await getChangedFileDetailsInCatalogDirectory(octokit, context, catalogDirectory);
  const changedSchemasInPullRequest = changedEventCatalogFilesInPullRequest.filter(
    (file) => getSchemasFromFilePaths([file.filename, file.previous_filename || '']).length > 0
  );

  if (changedSchemasInPullRequest.length === 0) {
    core.info('No schemas have changed, skipping schema review');
    return;
  }

  const reviewedFiles: ReviewedFile[] = [];

  // Review all the schemas, the new schema vs the old one
  for (const change of changedSchemasInPullRequest) {
    const filePath = change.filename;
    try {
      getSchemaSourcePaths(change);
      const relativePath = path.relative(catalogDirectory || '.', filePath);
      if (
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath) ||
        getSchemasFromFilePaths([filePath]).length === 0
      ) {
        throw new SchemaSourceError(
          'Schema moved outside the selected catalog or schema formats; review this change manually.',
          'unsupported_change'
        );
      }
      core.info(`Reviewing schema: ${filePath}`);
      const message = await getMessageBySchemaPath(relativePath);
      const { consumers = [] } = await getProducersAndConsumersForMessage(message.id, message.version);
      core.info(`Message consumers: ${consumers.map((c) => `${c.name} (${c.version})`).join(', ')}`);
      const schemaReviewResponse = await reviewSchema(octokit, context, filePath, consumers, change);
      reviewedFiles.push(schemaReviewResponse);
    } catch (error) {
      core.error(`Error reviewing schema: ${filePath}`);
      reviewedFiles.push({
        filePath,
        aiError:
          error instanceof SchemaSourceError
            ? error.message
            : 'Schema review could not be completed. Check the schema mapping in EventCatalog.',
        ...(error instanceof SchemaSourceError && { sourceError: error }),
      });
    }
  }

  // Fail closed on incomplete reviews. A successful sibling cannot supply a
  // score for a failed file, and zero is a valid score.
  for (const file of reviewedFiles) {
    if (!file.aiError && !responseSchema.safeParse(file.aiReview).success) {
      file.aiError = 'No valid AI review was returned.';
    }
  }
  const failedReviews = reviewedFiles.filter((file) => file.aiError);
  const successfulReviews = reviewedFiles.filter((file) => !file.aiError && file.aiReview);
  const lowestScore = Math.min(...successfulReviews.map((file) => file.aiReview!.score));

  // Set the outcome before publishing so a comment failure cannot hide an AI failure.
  if (failedReviews.length > 0) {
    core.setFailed(`${failedReviews.length} schema review(s) could not be completed. See the review comment for details.`);
  } else if (lowestScore < failureThreshold) {
    core.setFailed(`Schema review failed with a score of ${lowestScore}`);
  }

  const orderedReviewedFiles = [...reviewedFiles].sort((a, b) => {
    if (Boolean(a.aiError) !== Boolean(b.aiError)) return a.aiError ? -1 : 1;
    return (a.aiReview?.score ?? Infinity) - (b.aiReview?.score ?? Infinity);
  });

  const commentBody = await generateGitHubCommentForSchemaReview({
    context,
    reviewedFiles: orderedReviewedFiles,
    model,
    provider,
    catalogDirectory,
  });

  const newOrUpdatedCommentId = await upsertComment(octokit, context, pullRequestNumber, commentBody, COMMENT_MARKER);

  core.setOutput(
    'comment-url',
    `https://github.com/${owner}/${repo}/pull/${pullRequestNumber}#issuecomment-${newOrUpdatedCommentId}`
  );
};
