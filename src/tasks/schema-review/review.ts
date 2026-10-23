import * as core from '@actions/core';
import { ReviewedFile, getFileContentAtRef, ChangedFile, getSchemaSourcePaths, SchemaSourceError } from '@/lib/github';
import { sendPromptToModel, getAIErrorMessage } from '@/lib/ai';
import { GitHub } from '@actions/github/lib/utils';
import { Context } from '@actions/github/lib/context';
import { Message } from '@eventcatalog/sdk';

import { getSystemPromptForSchemaReview, getUserPromptForSchemaReview, responseSchema } from './prompt';

export const reviewSchema = async (
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  schemaFilePath: string,
  messages: Message[],
  change: ChangedFile = { filename: schemaFilePath, status: 'modified' }
): Promise<ReviewedFile> => {
  core.info(`Performing schema review for file: ${schemaFilePath}`);

  const baseSha = context.payload.pull_request!.base.sha;
  const headSha = context.payload.pull_request!.head.sha;

  const reviewedFileEntry: ReviewedFile = { filePath: schemaFilePath };

  try {
    const paths = getSchemaSourcePaths(change);
    const previousFileContent =
      paths.base === undefined ? null : await getFileContentAtRef(octokit, context, paths.base, baseSha);
    reviewedFileEntry.oldFileContent = previousFileContent;
    const newFileContent = await getFileContentAtRef(octokit, context, paths.head, headSha);
    reviewedFileEntry.newFileContent = newFileContent;
    if (previousFileContent === '' || newFileContent === '') {
      throw new SchemaSourceError('Schema source is empty; an empty schema cannot be reviewed.', 'empty_schema');
    }
    const systemPrompt = getSystemPromptForSchemaReview();
    const userPrompt = getUserPromptForSchemaReview(previousFileContent, newFileContent, messages, change.status);
    core.info(`Requesting AI review for schema changes in ${schemaFilePath}...`);
    const response = responseSchema.parse(await sendPromptToModel(systemPrompt, userPrompt, responseSchema));
    core.info(`AI review received for ${schemaFilePath}: Score ${response.score}`);
    reviewedFileEntry.aiReview = response;
  } catch (error) {
    if (error instanceof SchemaSourceError) reviewedFileEntry.sourceError = error;
    const errorMessage = error instanceof SchemaSourceError ? error.message : getAIErrorMessage(error);
    core.error(`Schema review failed for ${schemaFilePath}: ${errorMessage}`);
    reviewedFileEntry.aiError = errorMessage;
  }
  return reviewedFileEntry;
};
