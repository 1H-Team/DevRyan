import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createFreeZenCooldowns } from '@openchamber/shared-runtime';

import { generateCommitMessageDirect } from './commit-message.js';
import { registerGitRoutes } from './routes.js';

const makeApp = ({
  resolveZenModel = vi.fn(async (override) => override || 'gpt-5-nano'),
  getCachedFreeZenModels,
  fetchFreeZenModels = vi.fn(async () => [{ id: 'free-a' }, { id: 'free-b' }]),
  generateCommitMessage = vi.fn(async () => ({
    subject: 'feat: add generated source file',
    highlights: [],
  })),
  generatePullRequestDescription = vi.fn(async () => ({
    title: 'Use direct Zen PR generation',
    body: '## Summary\n- Avoid chat sessions',
  })),
  recordCommitTiming = vi.fn(),
  loadGitLibraries = async () => ({
    getStatus: vi.fn(async () => ({
      current: 'main',
      tracking: 'origin/main',
      files: [{ path: 'new-file.ts', index: '?', working_dir: '?' }],
      diffStats: { 'new-file.ts': { insertions: 1, deletions: 0 } },
      mergeInProgress: null,
      rebaseInProgress: null,
    })),
    getLog: vi.fn(async () => ({ all: [] })),
    getDiff: vi.fn(async () => '+export const created = true'),
  }),
} = {}) => {
  const app = express();
  app.use(express.json());
  registerGitRoutes(app, {
    resolveZenModel,
    getCachedFreeZenModels,
    fetchFreeZenModels,
    generateCommitMessage,
    generatePullRequestDescription,
    freeZenCooldowns: createFreeZenCooldowns(),
    recordCommitTiming,
    loadGitLibraries,
  });
  return {
    app,
    generateCommitMessage,
    generatePullRequestDescription,
    fetchFreeZenModels,
    resolveZenModel,
    recordCommitTiming,
  };
};

const requestBody = {
  context: {
    branch: 'main',
    tracking: 'origin/main',
    scope: 'staged-and-unstaged',
    stagedOnly: false,
    recentCommitSubjects: [],
    selectedFiles: [{
      path: 'new-file.ts',
      index: '?',
      workingDir: '?',
      diff: '+export const created = true',
    }],
  },
};

describe('POST /api/git/commit-message', () => {
  it('uses the commit-specific free Zen model without calling OpenCode session endpoints', async () => {
    const { app, generateCommitMessage, resolveZenModel } = makeApp();

    const response = await request(app)
      .post('/api/git/commit-message?directory=/repo')
      .send(requestBody)
      .expect(200);

    expect(response.body).toEqual({
      message: { subject: 'feat: add generated source file', highlights: [] },
    });
    expect(resolveZenModel).not.toHaveBeenCalled();
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({
      context: requestBody.context,
      guidance: undefined,
      models: [{ id: 'free-a' }, { id: 'free-b' }],
    }));
  });

  it('preserves an explicit Zen model override', async () => {
    const generateCommitMessage = vi.fn(async () => ({
      subject: 'chore: update generated fixture',
      highlights: [],
    }));
    const { app, resolveZenModel } = makeApp({ generateCommitMessage, fetchFreeZenModels: async () => [{ id: 'free-a' }, { id: 'big-pickle' }] });

    await request(app)
      .post('/api/git/commit-message?directory=/repo')
      .send({ ...requestBody, zenModel: 'big-pickle' })
      .expect(200);

    expect(resolveZenModel).not.toHaveBeenCalled();
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({
      models: [{ id: 'big-pickle' }, { id: 'free-a' }],
    }));
  });

  it('ignores a requested model that is absent from the free catalog', async () => {
    const { app, generateCommitMessage } = makeApp();
    await request(app).post('/api/git/commit-message?directory=/repo')
      .send({ ...requestBody, zenModel: 'paid-or-retired' }).expect(200);
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({ models: [{ id: 'free-a' }, { id: 'free-b' }] }));
  });

  it.each(['/commit-message', '/commit-message/draft'])('rotates through actual generators for %s and journals each failure', async (route) => {
    const requestText = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 401 }))
      .mockResolvedValueOnce('invalid draft')
      .mockResolvedValueOnce(JSON.stringify({ subject: 'fix: recover generation', details: ['Try models in order', 'Keep staged scope'] }));
    const { app, recordCommitTiming } = makeApp({
      fetchFreeZenModels: async () => ['a', 'b', 'c'],
      generateCommitMessage: (options) => generateCommitMessageDirect({ ...options, requestText }),
    });
    const response = await request(app).post(`/api/git${route}?directory=/repo`)
      .send(route.endsWith('/draft') ? { selectedFiles: ['new-file.ts'] } : requestBody).expect(200);
    const message = response.body.message ?? response.body.commits[0];
    expect(message.subject).toBe('fix: recover generation');
    expect(response.body.warnings).toBeUndefined();
    expect(requestText.mock.calls.map(([input]) => input.zenModel)).toEqual(['a', 'b', 'c']);
    const attempts = recordCommitTiming.mock.calls.map(([, payload]) => payload).filter(({ event }) => event === 'git_commit_message_model_attempt');
    expect(attempts.map(({ attempt, model, providerOutcome }) => [attempt, model, providerOutcome])).toEqual([
      [1, 'a', 'unauthorized'], [2, 'b', 'invalid_output'], [3, 'c', 'complete'],
    ]);
    expect(recordCommitTiming).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ source: 'ai', retried: true, model: 'c' }));
  });

  it.each(['empty', 'unavailable', 'stale'])('handles a %s catalog through the real generator', async (state) => {
    const requestText = vi.fn(async () => 'fix: use stale catalog');
    const { app, recordCommitTiming } = makeApp({
      fetchFreeZenModels: async () => { if (state !== 'empty') throw new Error('offline'); return []; },
      getCachedFreeZenModels: () => state === 'stale' ? ['remembered'] : [],
      generateCommitMessage: (options) => generateCommitMessageDirect({ ...options, requestText }),
    });
    const response = await request(app).post('/api/git/commit-message/draft?directory=/repo')
      .send({ selectedFiles: ['new-file.ts'] }).expect(200);
    if (state === 'stale') {
      expect(response.body.commits[0].subject).toBe('fix: use stale catalog');
      expect(requestText).toHaveBeenCalledTimes(1);
    } else {
      expect(response.body.warnings[0]).toMatch(state === 'empty' ? /No free Zen models/ : /catalog was unavailable/);
      expect(requestText).not.toHaveBeenCalled();
    }
    expect(recordCommitTiming).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ catalogState: state }));
  });

  it('rejects missing directory and worktree context', async () => {
    const { app } = makeApp();

    await request(app).post('/api/git/commit-message').send(requestBody).expect(400);
    await request(app)
      .post('/api/git/commit-message?directory=/repo')
      .send({ context: { selectedFiles: [] } })
      .expect(400);
  });

  it('returns a deterministic error for malformed model output', async () => {
    const generateCommitMessage = vi.fn(async () => {
      throw new Error('Generated commit subject is not a valid conventional commit');
    });
    const { app } = makeApp({
      resolveZenModel: vi.fn(async () => 'big-pickle'),
      generateCommitMessage,
    });

    const response = await request(app)
      .post('/api/git/commit-message?directory=/repo')
      .send(requestBody)
      .expect(500);

    expect(response.body.error).toMatch(/valid conventional commit/);
  });

  it('collects commit context in the host and returns the workflow result', async () => {
    const { app, generateCommitMessage, recordCommitTiming } = makeApp({
      fetchFreeZenModels: async () => { throw new Error('catalog offline'); },
      getCachedFreeZenModels: () => [{ id: 'free-a' }, { id: 'free-b' }],
    });

    const response = await request(app)
      .post('/api/git/commit-message/draft?directory=/repo')
      .send({
        selectedFiles: ['new-file.ts', 'new-file.ts'],
        stagedOnly: false,
        guidance: 'Prefer a source scope',
      })
      .expect(200);

    expect(response.body).toEqual({
      status: 'complete',
      commits: [{ subject: 'feat: add generated source file', highlights: [] }],
    });
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({
      guidance: 'Prefer a source scope',
      models: [{ id: 'free-a' }, { id: 'free-b' }],
      context: expect.objectContaining({
        selectedFiles: [expect.objectContaining({ path: 'new-file.ts' })],
      }),
    }));
    expect(response.headers['server-timing']).toMatch(/commit-context;dur=/);
    expect(recordCommitTiming).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'complete',
      selectedFileCount: 1,
      catalogState: 'stale',
    }));
  });

  it('keeps staged-only context and selected paths unchanged across attempts', async () => {
    const getDiff = vi.fn(async () => '+staged fixture change');
    const requestText = vi.fn().mockRejectedValueOnce(new Error('network failure')).mockResolvedValueOnce('fix: describe staged changes');
    const { app } = makeApp({
      generateCommitMessage: (options) => generateCommitMessageDirect({ ...options, requestText }),
      loadGitLibraries: async () => ({
        getStatus: async () => ({ current: 'main', files: [
          { path: 'selected.ts', index: 'M', working_dir: 'M' },
          { path: 'unselected.ts', index: 'M', working_dir: ' ' },
        ] }),
        getLog: async () => ({ all: [] }), getDiff,
      }),
    });
    await request(app).post('/api/git/commit-message/draft?directory=/repo')
      .send({ selectedFiles: ['selected.ts'], stagedOnly: true }).expect(200);
    expect(getDiff).toHaveBeenCalledExactlyOnceWith('/repo', { paths: ['selected.ts'], staged: true, contextLines: 1 });
    expect(requestText).toHaveBeenCalledTimes(2);
    const prompts = requestText.mock.calls.map(([input]) => input.prompt);
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[0]).toContain('"stagedOnly":true');
    expect(prompts[0]).not.toContain('unselected.ts');
  });

  it('returns a blocked workflow without calling the model during conflicts', async () => {
    const generateCommitMessage = vi.fn();
    const { app, recordCommitTiming } = makeApp({
      generateCommitMessage,
      loadGitLibraries: async () => ({
        getStatus: vi.fn(async () => ({
          current: 'main',
          tracking: null,
          files: [{ path: 'new-file.ts', index: 'U', working_dir: 'U' }],
          mergeInProgress: { head: 'feature' },
          rebaseInProgress: null,
        })),
        getLog: vi.fn(async () => ({ all: [] })),
        getDiff: vi.fn(),
      }),
    });

    const response = await request(app)
      .post('/api/git/commit-message/draft?directory=/repo')
      .send({ selectedFiles: ['new-file.ts'] })
      .expect(200);

    expect(response.body).toMatchObject({ status: 'blocked', commits: [] });
    expect(generateCommitMessage).not.toHaveBeenCalled();
    expect(recordCommitTiming).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'blocked' }));
  });

  it('bounds slow Git context collection and returns a disclosed metadata draft', async () => {
    const generateCommitMessage = vi.fn(async ({ context }) => ({
      subject: 'chore: update selected files',
      highlights: ['Use selected file metadata', 'Keep generation responsive'],
      _generation: {
        source: 'ai',
        warning: null,
        providerOutcome: 'complete',
      },
      context,
    }));
    const { app } = makeApp({
      generateCommitMessage,
      loadGitLibraries: async () => ({
        getStatus: vi.fn(() => new Promise(() => {})),
        getLog: vi.fn(async () => ({ all: [] })),
        getDiff: vi.fn(async () => ''),
      }),
    });

    const startedAt = Date.now();
    const response = await request(app)
      .post('/api/git/commit-message/draft?directory=/repo')
      .send({ selectedFiles: ['src/slow.ts'] })
      .expect(200);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(response.body.warnings).toContain(
      'Git context exceeded the speed budget; generated from selected file metadata',
    );
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        selectedFiles: [{ path: 'src/slow.ts', index: '?', workingDir: '?' }],
      }),
    }));
  });
});

describe('POST /api/git/pr-description', () => {
  it('uses the complete free catalog and rendered prompt without model selection', async () => {
    const { app, generatePullRequestDescription, fetchFreeZenModels, resolveZenModel } = makeApp();
    const response = await request(app)
      .post('/api/git/pr-description?directory=/repo')
      .send({ base: 'main', head: 'feature/direct-pr', prompt: 'Return the Generate PR JSON' })
      .expect(200);

    expect(response.body).toMatchObject({
      title: 'Use direct Zen PR generation',
      body: '## Summary\n- Avoid chat sessions',
      source: 'free_zen',
    });
    expect(fetchFreeZenModels).toHaveBeenCalledTimes(1);
    expect(generatePullRequestDescription).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Return the Generate PR JSON',
      models: [{ id: 'free-a' }, { id: 'free-b' }],
    }));
    expect(resolveZenModel).not.toHaveBeenCalled();
  });

  it('rejects missing Generate PR instructions', async () => {
    const { app, generatePullRequestDescription } = makeApp();
    await request(app)
      .post('/api/git/pr-description?directory=/repo')
      .send({ base: 'main', head: 'feature/direct-pr' })
      .expect(400);
    expect(generatePullRequestDescription).not.toHaveBeenCalled();
  });
});
