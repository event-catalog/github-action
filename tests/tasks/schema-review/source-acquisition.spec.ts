import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import * as ai from '../../../src/lib/ai';
import * as github from '../../../src/lib/github';
import { task } from '../../../src/tasks/schema-review';
import type { Context } from '@actions/github/lib/context';

const metadata = vi.hoisted(() => ({ read: vi.fn(async () => ({ id: 'event', name: 'Synthetic event', version: '1.0.0' })) }));
vi.mock('@eventcatalog/sdk', () => ({
  default: () => ({ getMessageBySchemaPath: metadata.read, getProducersAndConsumersForMessage: async () => ({ consumers: [] }) }),
}));
const context = {
  repo: { owner: 'owner', repo: 'repo' },
  payload: { pull_request: { number: 1, base: { sha: 'exact-base' }, head: { sha: 'exact-head' } } },
} as unknown as Context;
const filePath = 'events/Event/schema.json';
const second = 'events/Other/schema.json';
const secret = 'SECRET_SOURCE_FIXTURE';
const content = (text = '{"type":"object"}') => ({
  data: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) },
});
const httpError = (status: number) =>
  Object.assign(new Error(secret), { status, response: { headers: { authorization: secret }, data: secret } });
const adverse: [string, () => any][] = [
  ...[401, 403, 404, 503].map(
    (status) =>
      [
        `HTTP ${status}`,
        () => {
          throw httpError(status);
        },
      ] as [string, () => any]
  ),
  [
    'network',
    () => {
      throw new TypeError(secret);
    },
  ],
  [
    'timeout',
    () => {
      throw new DOMException(secret, 'TimeoutError');
    },
  ],
  ['directory', () => ({ data: [] })],
  ['symlink', () => ({ data: { ...content().data, type: 'symlink' } })],
  ['submodule', () => ({ data: { ...content().data, submodule_git_url: secret } })],
  ['truncated flag', () => ({ data: { ...content().data, truncated: true } })],
  ['missing size', () => ({ data: { type: 'file', encoding: 'base64', content: 'e30=' } })],
  ['no content', () => ({ data: { type: 'file', encoding: 'base64', size: 10 } })],
  ['unsupported encoding', () => ({ data: { type: 'file', encoding: 'none', content: '', size: 2000000 } })],
  ['truncated', () => ({ data: { ...content().data, size: 999 } })],
  ['malformed', () => ({ data: null })],
  ['bad base64', () => ({ data: { type: 'file', encoding: 'base64', content: '%%%bad', size: 3 } })],
  ['invalid UTF8', () => ({ data: { type: 'file', encoding: 'base64', content: '/w==', size: 1 } })],
];
let octokit: any;
let failed: any;
let provider: any;
let diagnostics: any[];
let threshold: string;
let score: number;
let changes: any[];
let catalogDirectory: string;

beforeEach(() => {
  catalogDirectory = '';
  changes = [{ filename: filePath, status: 'modified' }];
  threshold = '75';
  score = 100;
  metadata.read.mockClear();
  vi.spyOn(core, 'getInput').mockImplementation(
    (name) =>
      ({ failure_threshold: threshold, provider: 'openai', model: 'gpt-5.6-terra', catalog_directory: catalogDirectory })[name] ||
      ''
  );
  diagnostics = [
    vi.spyOn(core, 'error'),
    vi.spyOn(core, 'warning'),
    vi.spyOn(core, 'info'),
    vi.spyOn(console, 'error'),
    vi.spyOn(console, 'warn'),
    vi.spyOn(console, 'log'),
  ];
  diagnostics.forEach((spy) => spy.mockImplementation(() => {}));
  vi.spyOn(core, 'setOutput').mockImplementation(() => {});
  failed = vi.spyOn(core, 'setFailed').mockImplementation(() => {});
  provider = vi.spyOn(ai, 'sendPromptToModel').mockImplementation(async () => ({
    score,
    executiveSummary: 'Synthetic result',
    schemaFormat: 'json',
    effectedConsumers: [],
  }));
  octokit = {
    rest: {
      pulls: { listFiles: vi.fn(async () => ({ data: changes })) },
      repos: { getContent: vi.fn(async () => content()) },
      issues: { listComments: vi.fn(async () => ({ data: [] })), createComment: vi.fn(async () => ({ data: { id: 1 } })) },
    },
  };
});
afterEach(() => vi.restoreAllMocks());
async function run() {
  await task({ octokit, context, catalogDirectory });
  return octokit.rest.issues.createComment.mock.calls[0]?.[0].body as string;
}
function failAt(ref: string, response: () => any, target = filePath) {
  octokit.rest.repos.getContent.mockImplementation(async (request: any) =>
    request.ref === ref && request.path === target ? response() : content()
  );
}
function assertRefusal(body: string) {
  expect(failed).toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(body).toContain('Review failed');
  expect(body).not.toMatch(/Safe|\/100/);
  expect(JSON.stringify([body, ...diagnostics.map((spy) => spy.mock.calls), provider.mock.calls])).not.toContain(secret);
}

describe('source acquisition through the actual task with a score-100 negative control', () => {
  for (const ref of ['exact-base', 'exact-head']) {
    it.each(adverse)(`${ref} %s cannot become a scored review`, async (_name, response) => {
      failAt(ref, response);
      assertRefusal(await run());
    });
  }
  it('fails the action before comment publication even when publishing fails', async () => {
    failAt('exact-head', () => {
      throw httpError(403);
    });
    octokit.rest.issues.createComment.mockImplementation(async () => {
      expect(failed).toHaveBeenCalled();
      throw new Error('Synthetic comment failure');
    });
    await expect(run()).rejects.toThrow('Schema review comment publication failed');
    expect(provider).not.toHaveBeenCalled();
  });
  it('retains a successful sibling without covering source failure', async () => {
    changes.push({ filename: second, status: 'modified' });
    failAt('exact-head', () => {
      throw httpError(404);
    });
    const body = await run();
    expect(failed).toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    const failedSection = body.split('## [').find((section) => section.includes(encodeURIComponent(filePath)))!;
    expect(failedSection).toContain('Review failed');
    expect(failedSection).not.toMatch(/Safe|\/100/);
    expect(body).toContain('100/100');
    expect(JSON.stringify(provider.mock.calls)).not.toContain(secret);
  });
  it('reviews both exact revisions for a modified file', async () => {
    expect(await run()).toContain('100/100');
    expect(failed).not.toHaveBeenCalled();
    expect(octokit.rest.repos.getContent.mock.calls.map(([request]: any) => [request.path, request.ref])).toEqual([
      [filePath, 'exact-base'],
      [filePath, 'exact-head'],
    ]);
  });
  it('reviews an addition with explicit base absence and no base request', async () => {
    changes[0].status = 'added';
    failAt('exact-base', () => {
      throw httpError(404);
    });
    const body = await run();
    expect(body).toContain('100/100');
    expect(failed).not.toHaveBeenCalled();
    expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
    expect(octokit.rest.repos.getContent.mock.calls[0][0]).toMatchObject({ path: filePath, ref: 'exact-head' });
    expect(provider.mock.calls[0][1]).toMatch(/added[\s\S]*absent/i);
  });
  it('reports removal as unsupported without a head catalog lookup or provider score', async () => {
    changes[0].status = 'removed';
    assertRefusal(await run());
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
    expect(metadata.read).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([true, false])('binds previous path for a rename (changed bytes=%s)', async (changed) => {
    changes[0] = { filename: filePath, status: 'renamed', previous_filename: 'events/Old/schema.json' };
    octokit.rest.repos.getContent.mockImplementation(async ({ ref }: any) =>
      content(changed && ref === 'exact-head' ? '{"new":true}' : '{"old":true}')
    );
    expect(await run()).toContain('100/100');
    expect(failed).not.toHaveBeenCalled();
    expect(octokit.rest.repos.getContent.mock.calls.map(([request]: any) => [request.path, request.ref])).toEqual([
      ['events/Old/schema.json', 'exact-base'],
      [filePath, 'exact-head'],
    ]);
    expect(provider.mock.calls[0][1]).toContain('renamed');
  });
  it.each([{ status: 'renamed' }, { status: 'copied' }, {}])('refuses ambiguous/unsupported change %j', async (change) => {
    changes[0] = { filename: filePath, ...change };
    assertRefusal(await run());
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
  });
  it.each(['exact-base', 'exact-head'])('distinguishes an empty file at %s and refuses an unreviewable schema', async (ref) => {
    failAt(ref, () => content(''));
    assertRefusal(await run());
  });
  it('fails an addition if its required head is missing', async () => {
    changes[0].status = 'added';
    failAt('exact-head', () => {
      throw httpError(404);
    });
    assertRefusal(await run());
    expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
  });
  it('fails a rename if the metadata-bound previous path cannot be read', async () => {
    changes[0] = { filename: filePath, status: 'renamed', previous_filename: 'events/Old/schema.json' };
    failAt(
      'exact-base',
      () => {
        throw httpError(404);
      },
      'events/Old/schema.json'
    );
    assertRefusal(await run());
  });
  it('does not silently skip a schema renamed to an unsupported extension', async () => {
    changes[0] = { filename: 'events/Event/schema.txt', status: 'renamed', previous_filename: filePath };
    assertRefusal(await run());
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
  });
  it.each(['modified', 'renamed'])('reviews %s metadata through nested catalog filtering', async (status) => {
    catalogDirectory = 'docs/catalog';
    changes[0] = {
      filename: `${catalogDirectory}/${filePath}`,
      status,
      ...(status === 'renamed' && { previous_filename: 'archive/events/Event/schema.json' }),
    };
    expect(await run()).toContain('100/100');
    expect(failed).not.toHaveBeenCalled();
    expect(metadata.read.mock.calls[0][0]).toBe(filePath);
    expect(octokit.rest.repos.getContent.mock.calls[0][0].path).toBe(
      status === 'renamed' ? 'archive/events/Event/schema.json' : changes[0].filename
    );
  });
  it('reports a rename leaving the selected catalog instead of silently skipping it', async () => {
    catalogDirectory = 'docs/catalog';
    changes[0] = {
      filename: 'archive/events/Event/schema.json',
      previous_filename: `${catalogDirectory}/${filePath}`,
      status: 'renamed',
    };
    assertRefusal(await run());
    expect(metadata.read).not.toHaveBeenCalled();
  });
  it('retains the acquisition error and original cause on the real review result', async () => {
    const original = httpError(403);
    octokit.rest.repos.getContent.mockRejectedValue(original);
    const { reviewSchema } = await import('../../../src/tasks/schema-review/review');
    const result = await reviewSchema(octokit, context, filePath, [], changes[0]);
    expect(result.sourceError?.cause).toBe(original);
    expect(result.sourceError?.status).toBe(403);
    expect(result.oldFileContent).toBeUndefined();
    expect(result.newFileContent).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each(['modified', 'added'])('keeps %s base evidence distinct from a failed head acquisition', async (status) => {
    changes[0].status = status;
    failAt('exact-head', () => {
      throw httpError(404);
    });
    const { reviewSchema } = await import('../../../src/tasks/schema-review/review');
    const result = await reviewSchema(octokit, context, filePath, [], changes[0]);
    expect(result.oldFileContent).toBe(status === 'added' ? null : '{"type":"object"}');
    expect(result.newFileContent).toBeUndefined();
    expect(result.sourceError?.status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
  });
  it('redacts failed comment-listing and comment-write messages while preserving publication cause', async () => {
    const original = httpError(503);
    failAt('exact-head', () => {
      throw httpError(401);
    });
    octokit.rest.issues.listComments.mockRejectedValue(httpError(403));
    octokit.rest.issues.createComment.mockRejectedValue(original);
    const error = await run().catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(original);
    expect(error.status).toBe(503);
    expect(failed).toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(JSON.stringify([error, ...diagnostics.map((spy) => spy.mock.calls)])).not.toContain(secret);
  });
  it('does not ban legitimate schema text resembling the old sentinel', async () => {
    const text = 'Could not retrieve content (Error: these are legitimate file bytes)';
    octokit.rest.repos.getContent.mockResolvedValue(content(text));
    expect(await run()).toContain('100/100');
    expect(provider.mock.calls[0][1]).toContain(text);
  });
  it('preserves score zero and recovers in a later healthy task', async () => {
    failAt('exact-head', () => {
      throw httpError(401);
    });
    assertRefusal(await run());
    failed.mockClear();
    octokit.rest.issues.createComment.mockClear();
    octokit.rest.repos.getContent.mockResolvedValue(content());
    score = 0;
    const body = await run();
    expect(body).toContain('0/100');
    expect(body).toContain('Danger');
    expect(failed).toHaveBeenCalledWith('Schema review failed with a score of 0');
    failed.mockClear();
    octokit.rest.issues.createComment.mockClear();
    threshold = '0';
    expect(await run()).toContain('0/100');
    expect(failed).not.toHaveBeenCalled();
  });
});

describe('shared fetch contract', () => {
  it.each(['', '\ufeff{"title":"Å雪"}\n', 'line1\r\nline2\n'])('returns exact UTF-8 file content %j', async (text) => {
    octokit.rest.repos.getContent.mockResolvedValue(content(text));
    expect(await github.getFileContentAtRef(octokit, context, filePath, 'exact-base')).toBe(text);
  });
  it('throws a safe typed error retaining original status and cause', async () => {
    const original = httpError(404);
    octokit.rest.repos.getContent.mockRejectedValue(original);
    const error = await github.getFileContentAtRef(octokit, context, filePath, 'exact-base').catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SchemaSourceError');
    expect(error.status).toBe(404);
    expect(error.cause).toBe(original);
    expect(error.message).toContain('404');
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
