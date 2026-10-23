import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import { task } from '../../../src/tasks/schema-review';
import path from 'path';
import { Context } from '@actions/github/lib/context';

// Factory for Octokit mock
const createMockOctokit = (listFilesData: any[] = []) => {
  return {
    rest: {
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: listFilesData.map((file) => ({ status: 'modified', ...file })) }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({ data: { id: 123 } }),
      },
    },
  } as any; // Cast to any to simplify mocking for tests not needing full Octokit
};

// Factory for Context mock
const createMockContext = () => {
  return {
    eventName: 'pull_request',
    repo: {
      owner: 'test-owner',
      repo: 'test-repo',
    },
    payload: {
      pull_request: {
        number: 123,
        base: { sha: 'base-sha' },
        head: { sha: 'head-sha' },
      },
    },
  } as unknown as Context;
};

describe('schema-review', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(core, 'setFailed').mockImplementation(() => {});
    // override process.cwd() to return the tests directory, this would be the github workspace directory
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(__dirname, '../../../'));
  });

  it('when no schemas have changed, the action does nothing and passes', async () => {
    const infoSpy = vi.spyOn(core, 'info');
    const getInputSpy = vi.spyOn(core, 'getInput').mockReturnValue('75');
    const setFailedSpy = vi.spyOn(core, 'setFailed');

    await task({
      octokit: createMockOctokit([]), // Use factory, expecting no files
      context: createMockContext(),
      catalogDirectory: 'test-catalog',
    });

    expect(getInputSpy).toHaveBeenCalledWith('failure_threshold');
    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('No schemas have changed, skipping schema review');
  });

  it('when no eventcatalog schemas have changed, but other files have, the action does nothing and passes', async () => {
    const infoSpy = vi.spyOn(core, 'info');
    vi.spyOn(core, 'getInput').mockReturnValue('75');

    await task({
      octokit: createMockOctokit([
        {
          filename: 'some-random-file-not-related-to-eventcatalog.txt',
        },
      ]), // Octokit mock, data doesn't matter here
      context: createMockContext(),
      catalogDirectory: path.join(__dirname, 'eventcatalog'),
    });

    expect(infoSpy).toHaveBeenCalledWith('No schemas have changed, skipping schema review');
  });

  it('if eventcatalog schemas have changed, but the action fails to find the messages in the catalog, the action fails', async () => {
    vi.spyOn(core, 'getInput').mockReturnValue('75');
    const setFailedSpy = vi.spyOn(core, 'setFailed');

    await task({
      octokit: createMockOctokit([
        {
          filename: 'my-awesome-project/eventcatalog/events/RandomEventThatDoesNotExist/schema.json',
        },
      ]), // Octokit mock, data doesn't matter here
      context: createMockContext(),
      catalogDirectory: 'eventcatalog',
    });

    expect(setFailedSpy).toHaveBeenCalled();
  });

  it('when failureThreshold is set below 0, the action fails', async () => {
    const getInputSpy = vi.spyOn(core, 'getInput').mockReturnValue('-1');
    const setFailedSpy = vi.spyOn(core, 'setFailed');

    await task({
      octokit: createMockOctokit(), // Octokit mock, data doesn't matter here
      context: createMockContext(),
      catalogDirectory: 'test-catalog',
    });

    expect(getInputSpy).toHaveBeenCalledWith('failure_threshold');
    expect(setFailedSpy).toHaveBeenCalledWith('Invalid input for `failure_threshold`. Must be a number between 0 and 100.');
  });

  it('when failureThreshold is set above 100, the action fails', async () => {
    const getInputSpy = vi.spyOn(core, 'getInput').mockReturnValue('101'); // Invalid threshold
    const setFailedSpy = vi.spyOn(core, 'setFailed');

    await task({
      octokit: createMockOctokit(), // Octokit mock, data doesn't matter here
      context: createMockContext(),
      catalogDirectory: 'test-catalog',
    });

    expect(getInputSpy).toHaveBeenCalledWith('failure_threshold');
    expect(setFailedSpy).toHaveBeenCalledWith('Invalid input for `failure_threshold`. Must be a number between 0 and 100.');
  });
});
