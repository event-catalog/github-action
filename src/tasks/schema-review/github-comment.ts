import { ReviewedFile } from '@/lib/github';
import mustache from 'mustache';
import { Context } from '@actions/github/lib/context';
import utils from '@eventcatalog/sdk';
import { getInput } from '@actions/core';
import { responseSchema } from './prompt';

const COMMENT_MARKER = '<!-- eventcatalog-schema-review-comment -->';

const TEMPLATE = `
# EventCatalog: Schema Review

The following schemas were modified in this pull request:
{{#reviewedFiles}}

## [{{{name}}} ({{{version}}}) ({{{scorePrefix}}})]({{{fileDiffLink}}})

{{#reviewFailed}}
**Review failed:** {{aiError}}

No risk score is available for this schema. Resolve the failure and rerun the action.
{{/reviewFailed}}
{{^reviewFailed}}
| Schema Format | Risk Score |
|---------------|------------|
| {{{aiReview.schemaFormat}}} | {{{aiReview.score}}}/100 |

{{aiReview.executiveSummary}}

{{#hasEffectedConsumers}}
### Potential Effected Consumers

{{#aiReview.effectedConsumers}}
- {{name}} ({{version}}) - {{warning}}
{{/aiReview.effectedConsumers}}
{{/hasEffectedConsumers}}
{{^hasEffectedConsumers}}
### Potential Effected Consumers

{{name}} ({{version}}) has no consumers mapped in EventCatalog.
{{/hasEffectedConsumers}}
{{/reviewFailed}}
{{/reviewedFiles}}

<sub>Using Model: {{model}} | Provider: {{provider}}</sub>
${COMMENT_MARKER}`;

export const generateGitHubCommentForSchemaReview = async ({
  context,
  reviewedFiles,
  model,
  provider,
  catalogDirectory,
}: {
  context: Context;
  reviewedFiles: ReviewedFile[];
  model: string;
  provider: string;
  catalogDirectory: string;
}) => {
  const { getMessageBySchemaPath } = utils(catalogDirectory);
  const catalogFolderName = getInput('catalog_directory');

  const getScorePrefix = (score: number) => {
    if (score < 50) {
      return '🚨 Danger';
    } else if (score < 80) {
      return '⚠️ Warning';
    } else {
      return '✅ Safe';
    }
  };

  const messages = await Promise.all(
    reviewedFiles.map(async (file) => {
      const relativeFilePath = file.filePath.replace(catalogFolderName, '');
      const message =
        file.sourceError?.category === 'unsupported_change'
          ? undefined
          : await getMessageBySchemaPath(relativeFilePath).catch(() => undefined);
      return {
        ...file,
        name: message?.name || file.filePath,
        version: message?.version || 'unknown',
      };
    })
  );

  const data = messages.map((file) => {
    const reviewFailed = Boolean(file.aiError) || !responseSchema.safeParse(file.aiReview).success;
    return {
      ...file,
      reviewFailed,
      aiError: file.aiError || 'No valid AI review was returned.',
      scorePrefix: reviewFailed ? '❌ Review failed' : getScorePrefix(file.aiReview!.score),
      fileDiffLink: `https://github.com/${context.repo.owner}/${context.repo.repo}/pull/${context.payload.pull_request?.number}/files#${encodeURIComponent(file.filePath)}`,
      hasEffectedConsumers: (file.aiReview?.effectedConsumers?.length || 0) > 0,
    };
  });

  const commentBody = mustache.render(TEMPLATE, {
    reviewedFiles: data,
    model,
    provider,
    catalogDirectory,
  });

  return commentBody;
};
