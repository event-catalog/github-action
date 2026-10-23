import { describe, it, expect, vi, beforeEach, MockedFunction } from 'vitest';
import { Context } from '@actions/github/lib/context';
import { getChangedFilesInCatalogDirectory } from '../../src/lib/github';
import { GitHub } from '@actions/github/lib/utils';

const mockOctokit = {
  rest: {
    pulls: {
      listFiles: vi.fn(),
    },
  },
} as unknown as InstanceType<typeof GitHub>;

// Cast listFiles to the mocked function type
const mockListFiles = mockOctokit.rest.pulls.listFiles as MockedFunction<typeof mockOctokit.rest.pulls.listFiles>;

const mockContext = {
  repo: {
    owner: 'test-owner',
    repo: 'test-repo',
  },
  payload: {
    pull_request: {
      number: 123,
    },
  },
} as unknown as Context;

const owner = 'test-owner';
const repo = 'test-repo';
const pullRequestNumber = 123;

describe('github', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockListFiles.mockReset();
  });

  describe('getChangedFilesInCatalogDirectory', () => {
    it('only returns files that have changed the catalog directory', async () => {
      // mock out pull request files
      mockListFiles.mockResolvedValue({
        data: [{ filename: 'catalog/events/event1.json' }, { filename: 'docs/README.md' }, { filename: 'package.json' }],
        status: 200,
        headers: {},
        url: 'test-url',
      } as any);

      const changedFiles = await getChangedFilesInCatalogDirectory(mockOctokit, mockContext, 'catalog');

      expect(mockListFiles).toHaveBeenCalledWith({
        owner,
        repo,
        pull_number: pullRequestNumber,
      });
      expect(changedFiles).toEqual(['catalog/events/event1.json']);
    });

    it('if the catalogDirectory is not specified, it returns all changed files, as it assumes the catalog directory is the root', async () => {
      mockListFiles.mockResolvedValue({
        data: [{ filename: 'events/event1.json' }, { filename: 'services/service1.yaml' }],
        status: 200,
        headers: {},
        url: 'test-url',
      } as any);

      const changedFiles = await getChangedFilesInCatalogDirectory(mockOctokit, mockContext, undefined);

      expect(mockListFiles).toHaveBeenCalledWith({
        owner,
        repo,
        pull_number: pullRequestNumber,
      });
      expect(changedFiles).toEqual(['events/event1.json', 'services/service1.yaml']);
    });

    it('if the catalogDirectory is specified, it returns an empty array if no files match the catalogDirectory', async () => {
      const mockFiles = [{ filename: 'src/other/somefile.ts' }, { filename: 'docs/README.md' }];
      mockListFiles.mockResolvedValue({
        data: mockFiles,
        status: 200,
        headers: {},
        url: 'test-url',
      } as any);

      const catalogDirectory = 'catalog';
      const changedFiles = await getChangedFilesInCatalogDirectory(mockOctokit, mockContext, catalogDirectory);

      expect(changedFiles).toEqual([]);
    });
  });
});

// Metadata remains available to the schema task while string-list callers retain their contract.
describe('PR change metadata filtering', () => {
  it('retains a rename crossing the catalog boundary and its previous filename', async () => {
    const { getChangedFileDetailsInCatalogDirectory } = await import('../../src/lib/github');
    const renamed = {
      filename: 'archive/events/E/schema.json',
      previous_filename: 'docs/catalog/events/E/schema.json',
      status: 'renamed',
    };
    mockListFiles.mockResolvedValue({ data: [renamed, { filename: 'README.md', status: 'modified' }] } as any);
    expect(await getChangedFileDetailsInCatalogDirectory(mockOctokit, mockContext, 'docs/catalog')).toEqual([renamed]);
    expect(await getChangedFilesInCatalogDirectory(mockOctokit, mockContext, 'docs/catalog')).toEqual([renamed.filename]);
  });
  it('retains supported status for additions in a nested catalog', async () => {
    const { getChangedFileDetailsInCatalogDirectory } = await import('../../src/lib/github');
    const added = { filename: 'docs/catalog/events/E/schema.json', status: 'added' };
    mockListFiles.mockResolvedValue({ data: [added] } as any);
    expect(await getChangedFileDetailsInCatalogDirectory(mockOctokit, mockContext, 'docs/catalog')).toEqual([added]);
  });
});
