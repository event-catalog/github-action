import { describe, it, expect } from 'vitest';

import { generateGitHubCommentForSchemaReview } from '../../../src/tasks/schema-review/github-comment';
import { ReviewedFile } from '../../../src/lib/github';
import { Context } from '@actions/github/lib/context';
import path from 'path';

const context = {
  repo: {
    owner: 'owner',
    repo: 'repo',
  },
  payload: {
    pull_request: {
      number: 1,
    },
  },
} as unknown as Context;

// /Users/dboyne/dev/eventcatalog/eventcatalog-github-action/tests/tasks/eventcatalog

describe('generateGitHubCommentForSchemaReview', () => {
  it('should generate a GitHubcomment body for a single reviewed file', async () => {
    const reviewedFiles: ReviewedFile[] = [
      {
        filePath: 'events/InventoryAdjusted/schema.json',
        oldFileContent: 'Hello world',
        newFileContent: 'Hello world',
        aiReview: {
          executiveSummary: 'Executive summary',
          effectedConsumers: [
            {
              name: 'Consumer 1',
              version: '1.0.0',
              url: 'https://example.invalid/consumer',
              warning: 'Warning 1',
            },
            {
              name: 'Consumer 2',
              version: '1.0.1',
              url: 'https://example.invalid/consumer',
              warning: 'Warning 2',
            },
          ],
          score: 100,
          schemaFormat: 'json',
        },
      },
    ];
    const commentBody = await generateGitHubCommentForSchemaReview({
      context,
      reviewedFiles,
      model: 'o4-mini',
      provider: 'openai',
      catalogDirectory: path.join(__dirname, '../eventcatalog'),
    });

    expect(commentBody.trim()).toEqual(`# EventCatalog: Schema Review

The following schemas were modified in this pull request:

## [Inventory adjusted (1.0.1) (✅ Safe)](https://github.com/owner/repo/pull/1/files#events%2FInventoryAdjusted%2Fschema.json)

| Schema Format | Risk Score |
|---------------|------------|
| json | 100/100 |

Executive summary

### Potential Effected Consumers

- Consumer 1 (1.0.0) - Warning 1
- Consumer 2 (1.0.1) - Warning 2

<sub>Using Model: o4-mini | Provider: openai</sub>
<!-- eventcatalog-schema-review-comment -->`);
  });

  it('should return a message with no consumers for message if that schema has no consumers', async () => {
    const reviewedFiles: ReviewedFile[] = [
      {
        filePath: 'events/InventoryAdjusted/schema.json',
        oldFileContent: 'Hello world',
        newFileContent: 'Hello world',
        aiReview: {
          executiveSummary: 'Executive summary',
          effectedConsumers: [],
          score: 100,
          schemaFormat: 'json',
        },
      },
    ];
    const commentBody = await generateGitHubCommentForSchemaReview({
      context,
      reviewedFiles,
      model: 'o4-mini',
      provider: 'openai',
      catalogDirectory: path.join(__dirname, '../eventcatalog'),
    });

    expect(commentBody.trim()).toEqual(`# EventCatalog: Schema Review

The following schemas were modified in this pull request:

## [Inventory adjusted (1.0.1) (✅ Safe)](https://github.com/owner/repo/pull/1/files#events%2FInventoryAdjusted%2Fschema.json)

| Schema Format | Risk Score |
|---------------|------------|
| json | 100/100 |

Executive summary

### Potential Effected Consumers

Inventory adjusted (1.0.1) has no consumers mapped in EventCatalog.

<sub>Using Model: o4-mini | Provider: openai</sub>
<!-- eventcatalog-schema-review-comment -->`);
  });
});
