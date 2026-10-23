import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import * as providers from '../../../src/ai-models';
import * as reviews from '../../../src/tasks/schema-review/review';
import { task } from '../../../src/tasks/schema-review';
import { sendPromptToModel } from '../../../src/lib/ai';
import { responseSchema } from '../../../src/tasks/schema-review/prompt';
import type { Context } from '@actions/github/lib/context';

vi.mock('@eventcatalog/sdk', () => ({
  default: () => ({
    getMessageBySchemaPath: vi.fn(async (file: string) => ({
      name: file.includes('Second') ? 'Second event' : 'First event',
      id: 'test-event',
      version: '1.0.0',
    })),
    getProducersAndConsumersForMessage: vi.fn(async () => ({ consumers: [] })),
  }),
}));

const context = {
  repo: { owner: 'owner', repo: 'repo' },
  payload: { pull_request: { number: 1, base: { sha: 'base' }, head: { sha: 'head' } } },
} as unknown as Context;
const first = 'catalog/events/First/schema.json';
const second = 'catalog/events/Second/schema.json';
const valid = (score = 85) => ({ executiveSummary: 'Synthetic review', score, schemaFormat: 'json', effectedConsumers: [] });
let inputs: Record<string, string>;
let octokit: any;
let setFailed: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let rawErrorLog: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

function completion(value: unknown, tool = false) {
  const content = value === null ? null : typeof value === 'string' ? value : JSON.stringify(value);
  const message =
    tool && content !== null
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'test', type: 'function', function: { name: 'json', arguments: content } }],
        }
      : { role: 'assistant', content };
  return new Response(
    JSON.stringify({
      id: 'test',
      created: 1,
      model: inputs.model,
      choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { headers: { 'content-type': 'application/json' } }
  );
}
function reply(value: unknown) {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
    completion(value, !!JSON.parse(init.body as string).tools)
  );
}
async function run(files = [first]) {
  octokit.rest.pulls.listFiles.mockResolvedValue({ data: files.map((filename) => ({ filename, status: 'modified' })) });
  await task({ octokit, context, catalogDirectory: 'catalog' });
  return octokit.rest.issues.createComment.mock.calls[0]?.[0].body as string;
}

beforeEach(() => {
  inputs = {
    model: 'gpt-5.6-terra',
    provider: 'openai',
    api_key: 'sk-synthetic-private',
    failure_threshold: '75',
    catalog_directory: 'catalog',
  };
  vi.spyOn(core, 'getInput').mockImplementation((name) => inputs[name] || '');
  vi.spyOn(core, 'info').mockImplementation(() => {});
  vi.spyOn(core, 'setSecret').mockImplementation(() => {});
  vi.spyOn(core, 'setOutput').mockImplementation(() => {});
  setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {});
  errorLog = vi.spyOn(core, 'error').mockImplementation(() => {});
  rawErrorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  octokit = {
    rest: {
      pulls: { listFiles: vi.fn() },
      repos: {
        getContent: vi.fn(async () => ({
          data: {
            type: 'file',
            size: Buffer.byteLength('{"synthetic-private-schema":true}'),
            content: Buffer.from('{"synthetic-private-schema":true}').toString('base64'),
            encoding: 'base64',
          },
        })),
      },
      issues: {
        listComments: vi.fn(async () => ({ data: [] })),
        createComment: vi.fn(async () => ({ data: { id: 123 } })),
        updateComment: vi.fn(async () => ({ data: { id: 123 } })),
      },
    },
  };
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('real schema review task and rendered outcome (offline boundaries)', () => {
  it.each([
    [
      'SDK rejection',
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'private request sk-synthetic-private',
              type: 'invalid_request_error',
              param: 'temperature',
              code: 'unsupported_value',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json', 'x-private': 'private header' } }
        ),
    ],
    [
      'authentication failure',
      () =>
        new Response(
          JSON.stringify({
            error: { message: 'private request sk-synthetic-private', type: 'invalid_request_error', code: 'invalid_api_key' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        ),
    ],
    [
      'timeout',
      () => {
        throw new DOMException('private request sk-synthetic-private', 'TimeoutError');
      },
    ],
    [
      'network error',
      () => {
        throw new TypeError('private request sk-synthetic-private');
      },
    ],
    ['invalid JSON', () => completion('not json; private request sk-synthetic-private')],
    ['invalid schema', () => completion({ ...valid(), score: 101 })],
    ['missing review', () => completion(null)],
  ] as const)(
    'fails visibly on %s without a fabricated score or leaking request data',
    async (_name, response) => {
      fetchMock.mockImplementation(async () => response());
      const body = await run();
      expect(setFailed).toHaveBeenCalled();
      expect(body).toContain('Review failed');
      expect(body).not.toContain('Safe');
      expect(body).not.toContain('/100');
      expect(body).not.toContain('no consumers');
      expect(JSON.stringify([body, errorLog.mock.calls, rawErrorLog.mock.calls])).not.toMatch(
        /sk-synthetic-private|private request|private header|synthetic-private-schema/
      );
      expect(rawErrorLog).not.toHaveBeenCalled();
    },
    15000
  );

  it.each([undefined, { score: 100 }, { ...valid(), score: NaN }])(
    'rejects an absent or invalid review at the review boundary: %j',
    async (response) => {
      vi.spyOn(providers, 'getProvider').mockReturnValue({ generateObject: async () => ({ object: response }) } as any);
      const body = await run();
      expect(setFailed).toHaveBeenCalled();
      expect(body).toContain('Review failed');
      expect(body).not.toContain('Safe');
      expect(body).not.toContain('/100');
    }
  );

  it('fails if the task receives a file with no review result', async () => {
    vi.spyOn(reviews, 'reviewSchema').mockResolvedValue({ filePath: first, oldFileContent: '', newFileContent: '' });
    const body = await run();
    expect(setFailed).toHaveBeenCalled();
    expect(body).toContain('Review failed');
    expect(body).not.toContain('Safe');
  });

  it.each([
    [85, false],
    [74, true],
    [75, false],
    [0, true],
  ])('uses the real score %i against threshold 75 (fails=%s)', async (score, fails) => {
    reply(valid(score));
    const body = await run();
    expect(setFailed.mock.calls.length > 0).toBe(fails);
    expect(body).toContain(`${score}/100`);
    expect(body).toContain(score === 0 ? '🚨 Danger' : score >= 80 ? '✅ Safe' : '⚠️ Warning');
    if (score === 0) expect(body).not.toContain('Safe');
  });

  it('accepts real zero at threshold zero', async () => {
    inputs.failure_threshold = '0';
    reply(valid(0));
    const body = await run();
    expect(setFailed).not.toHaveBeenCalled();
    expect(body).toContain('0/100');
    expect(body).toContain('🚨 Danger');
  });

  it('retains failed siblings alongside successful ones and fails the action', async () => {
    fetchMock
      .mockImplementationOnce(async (_url, init) => completion(valid(100), !!JSON.parse(init.body).tools))
      .mockImplementationOnce(async () => completion(null));
    const body = await run([first, second]);
    expect(setFailed).toHaveBeenCalled();
    const sections = body.split('## [');
    expect(sections.find((s) => s.startsWith('First event'))).toContain('100/100');
    const failed = sections.find((s) => s.startsWith('Second event'))!;
    expect(failed).toContain('Review failed');
    expect(failed).not.toContain('Safe');
    expect(failed).not.toContain('/100');
  });

  it('treats an error as a failure even if a score was also returned', async () => {
    vi.spyOn(reviews, 'reviewSchema').mockResolvedValue({
      filePath: first,
      oldFileContent: '',
      newFileContent: '',
      aiReview: valid(100),
      aiError: 'Synthetic incomplete review',
    });
    const body = await run();
    expect(setFailed).toHaveBeenCalled();
    expect(body).toContain('Review failed');
    expect(body).not.toContain('Safe');
    expect(body).not.toContain('/100');
  });

  it('orders zero ahead of healthy scores', async () => {
    fetchMock
      .mockImplementationOnce(async (_url, init) => completion(valid(100), !!JSON.parse(init.body).tools))
      .mockImplementationOnce(async (_url, init) => completion(valid(0), !!JSON.parse(init.body).tools));
    const body = await run([first, second]);
    expect(body.indexOf('Second event')).toBeLessThan(body.indexOf('First event'));
    expect(setFailed).toHaveBeenCalledWith('Schema review failed with a score of 0');
  });

  it('recovers on a later healthy task without stale failure state', async () => {
    reply(null);
    expect(await run()).toContain('Review failed');
    expect(setFailed).toHaveBeenCalled();
    setFailed.mockClear();
    octokit.rest.issues.createComment.mockClear();
    reply(valid());
    expect(await run()).toContain('85/100');
    expect(setFailed).not.toHaveBeenCalled();
  });

  it('marks a failed review before attempting to publish its comment', async () => {
    reply(null);
    octokit.rest.issues.createComment.mockImplementation(async () => {
      expect(setFailed).toHaveBeenCalled();
      throw new Error('Synthetic GitHub failure');
    });
    await expect(run()).rejects.toThrow('Schema review comment publication failed');
  });

  it('preserves the original thrown error without dumping the SDK object', async () => {
    const original = new Error('private request sk-synthetic-private');
    vi.spyOn(providers, 'getProvider').mockReturnValue({
      generateObject: async () => {
        throw original;
      },
    } as any);
    await expect(sendPromptToModel('Synthetic', 'Synthetic', responseSchema)).rejects.toBe(original);
    expect(rawErrorLog).not.toHaveBeenCalled();
  });
});
