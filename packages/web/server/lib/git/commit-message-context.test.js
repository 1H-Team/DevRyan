import { describe, expect, it, vi } from 'vitest';

import {
  COMMIT_DRAFT_CONTEXT_LIMITS,
  COMMIT_DRAFT_MAX_SELECTED_FILES,
  collectCommitMessageContext,
} from './commit-message-context.js';

const statusFile = (path, index = 'M', workingDir = ' ') => ({
  path,
  index,
  working_dir: workingDir,
});

const baseStatus = (files) => ({
  current: 'main',
  tracking: 'origin/main',
  files,
  diffStats: {},
  mergeInProgress: null,
  rebaseInProgress: null,
});

describe('commit message host context collection', () => {
  it('fetches status and recent history together, deduplicates paths, and uses one batched scoped diff', async () => {
    let statusStarted = false;
    let logStarted = false;
    let releaseStatus;
    let releaseLog;
    const statusReady = new Promise((resolve) => { releaseStatus = resolve; });
    const logReady = new Promise((resolve) => { releaseLog = resolve; });
    const getStatus = vi.fn(async () => {
      statusStarted = true;
      await statusReady;
      return baseStatus([statusFile('src/app.ts')]);
    });
    const getLog = vi.fn(async () => {
      logStarted = true;
      await logReady;
      return { all: Array.from({ length: 8 }, (_, index) => ({ message: `fix: subject ${index}` })) };
    });
    const getDiff = vi.fn(async () => '+const fast = true');

    const pending = collectCommitMessageContext({
      directory: '/repo',
      selectedFiles: ['./src/app.ts', 'src/app.ts', 'src/new.ts'],
      stagedOnly: true,
      getStatus,
      getLog,
      getDiff,
    });

    await Promise.resolve();
    expect(statusStarted).toBe(true);
    expect(logStarted).toBe(true);
    releaseStatus();
    releaseLog();

    const result = await pending;
    expect(result).toMatchObject({
      status: 'ready',
      context: {
        scope: 'staged-only',
        stagedOnly: true,
        recentCommitSubjects: Array.from({ length: 6 }, (_, index) => `fix: subject ${index}`),
        selectedFiles: [
          expect.objectContaining({ path: 'src/app.ts' }),
          expect.objectContaining({ path: 'src/new.ts', index: '?' }),
        ],
        patch: '+const fast = true',
      },
    });
    expect(getStatus).toHaveBeenCalledOnce();
    expect(getLog).toHaveBeenCalledWith('/repo', { maxCount: 6 });
    expect(getDiff).toHaveBeenCalledOnce();
    expect(getDiff).toHaveBeenCalledWith('/repo', {
      paths: ['src/app.ts', 'src/new.ts'],
      staged: true,
      contextLines: 1,
    });
  });

  it('blocks merge conflicts before loading file diffs', async () => {
    const getDiff = vi.fn();
    const result = await collectCommitMessageContext({
      directory: '/repo',
      selectedFiles: ['src/conflict.ts'],
      getStatus: vi.fn(async () => ({
        ...baseStatus([statusFile('src/conflict.ts', 'U', 'U')]),
        rebaseInProgress: { head: 'feature' },
      })),
      getLog: vi.fn(async () => ({ all: [] })),
      getDiff,
    });

    expect(result).toEqual({
      status: 'blocked',
      message: 'Merge or rebase conflicts must be resolved before generating a commit message',
    });
    expect(getDiff).not.toHaveBeenCalled();
  });

  it('includes each selected untracked file alongside tracked diffs without staging or widening the selection', async () => {
    const getDiff = vi.fn(async (_directory, options) => {
      if (options.path) return `diff --git a/${options.path} b/${options.path}\n+new ${options.path}`;
      return options.staged ? '+staged tracked change' : '+unstaged tracked change';
    });
    const result = await collectCommitMessageContext({
      directory: '/repo',
      selectedFiles: ['tracked.ts', 'new-a.ts', 'new-b.ts'],
      getStatus: async () => baseStatus([
        statusFile('tracked.ts'), statusFile('new-a.ts', '?', '?'),
        statusFile('new-b.ts', '?', '?'), statusFile('unselected.ts', '?', '?'),
      ]),
      getLog: async () => ({ all: [] }),
      getDiff,
    });
    expect(result.context.patch).toContain('+staged tracked change');
    expect(result.context.patch).toContain('+unstaged tracked change');
    expect(result.context.patch).toContain('+new new-a.ts');
    expect(result.context.patch).toContain('+new new-b.ts');
    expect(result.context.patch).not.toContain('unselected.ts');
    expect(getDiff.mock.calls.map(([, options]) => options)).toEqual([
      { paths: ['tracked.ts'], staged: true, contextLines: 1 },
      { paths: ['tracked.ts'], staged: false, contextLines: 1 },
      { path: 'new-a.ts', staged: false, contextLines: 1 },
      { path: 'new-b.ts', staged: false, contextLines: 1 },
    ]);
  });

  it('bounds concurrent untracked reads and preserves remaining context after one file fails', async () => {
    let active = 0;
    let peak = 0;
    const files = Array.from({ length: 8 }, (_, index) => statusFile(`new-${index}.ts`, '?', '?'));
    const result = await collectCommitMessageContext({
      directory: '/repo', selectedFiles: files.map((file) => file.path),
      getStatus: async () => baseStatus(files), getLog: async () => ({ all: [] }),
      getDiff: async (_directory, options) => {
        expect(options.paths).toBeUndefined();
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        if (options.path === 'new-2.ts') throw new Error('File became unavailable');
        return `+${options.path}`;
      },
    });
    expect(peak).toBe(2);
    expect(result.context.patch).toContain('+new-7.ts');
    expect(result.context.contextWarning).toBe('some diff context was unavailable');
  });

  it('generates from selected diffs when optional recent history is unavailable', async () => {
    const result = await collectCommitMessageContext({
      directory: '/repo', selectedFiles: ['tracked.ts'], stagedOnly: true,
      getStatus: async () => baseStatus([statusFile('tracked.ts')]),
      getLog: async () => { throw new Error('History unavailable'); },
      getDiff: async () => '+selected staged change',
    });
    expect(result).toMatchObject({ status: 'ready', context: {
      patch: '+selected staged change', recentCommitSubjects: [],
      contextWarning: 'recent commit history was unavailable',
    } });
  });

  it('enforces a total combined patch budget and preserves line statistics', async () => {
    const files = ['a.ts', 'b.ts', 'large.ts'].map((filePath) => statusFile(filePath));
    const result = await collectCommitMessageContext({
      directory: '/repo',
      selectedFiles: files.map((file) => file.path),
      getStatus: vi.fn(async () => ({
        ...baseStatus(files),
        diffStats: { 'large.ts': { insertions: 201, deletions: 0 } },
      })),
      getLog: vi.fn(async () => ({ all: [] })),
      getDiff: vi.fn(async () => '1234567890'),
      limits: {
        ...COMMIT_DRAFT_CONTEXT_LIMITS,
        maxTotalDiffChars: 8,
      },
    });

    expect(result.status).toBe('ready');
    expect(result.context.selectedFiles).toEqual([
      expect.objectContaining({ path: 'a.ts' }),
      expect.objectContaining({ path: 'b.ts' }),
      expect.objectContaining({ path: 'large.ts', insertions: 201, deletions: 0 }),
    ]);
    expect(result.context.patch).toHaveLength(8);
    expect(result.context.patchNote).toBe('combined patch truncated');
  });

  it('uses at most two concurrent batch diff reads for large selections', async () => {
    const files = Array.from({ length: 12 }, (_, index) => statusFile(`src/file-${index}.ts`));
    let active = 0;
    let peak = 0;
    const getDiff = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return '+change';
    });

    await collectCommitMessageContext({
      directory: '/repo',
      selectedFiles: files.map((file) => file.path),
      getStatus: vi.fn(async () => baseStatus(files)),
      getLog: vi.fn(async () => ({ all: [] })),
      getDiff,
    });

    expect(getDiff).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    expect(getDiff.mock.calls[0][1].paths).toHaveLength(files.length);
  });

  it('validates selected paths after deduplication and caps unique paths at 200', async () => {
    const dependencies = {
      directory: '/repo',
      getStatus: vi.fn(async () => baseStatus([])),
      getLog: vi.fn(async () => ({ all: [] })),
      getDiff: vi.fn(async () => ''),
    };

    await expect(collectCommitMessageContext({
      ...dependencies,
      selectedFiles: Array.from({ length: 250 }, () => 'same.ts'),
    })).resolves.toMatchObject({ status: 'ready' });
    await expect(collectCommitMessageContext({
      ...dependencies,
      selectedFiles: Array.from({ length: COMMIT_DRAFT_MAX_SELECTED_FILES + 1 }, (_, index) => `file-${index}.ts`),
    })).rejects.toMatchObject({ statusCode: 400, code: 'COMMIT_DRAFT_TOO_MANY_FILES' });
    await expect(collectCommitMessageContext({
      ...dependencies,
      selectedFiles: ['../secret.ts'],
    })).rejects.toMatchObject({ statusCode: 400, code: 'COMMIT_DRAFT_INVALID_PATH' });
    await expect(collectCommitMessageContext({
      ...dependencies,
      selectedFiles: ['C:\\secret.ts'],
    })).rejects.toMatchObject({ statusCode: 400, code: 'COMMIT_DRAFT_INVALID_PATH' });
  });
});
