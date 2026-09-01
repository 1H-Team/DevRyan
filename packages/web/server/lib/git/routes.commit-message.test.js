import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { COMMIT_GENERATION_DEFAULT_ZEN_MODEL } from './commit-message.js';
import { registerGitRoutes } from './routes.js';

const makeApp = ({
  resolveZenModel = vi.fn(async (override) => override || 'gpt-5-nano'),
  resolveCommitZenModel,
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
    resolveCommitZenModel,
    fetchFreeZenModels,
    generateCommitMessage,
    generatePullRequestDescription,
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
    expect(resolveZenModel).toHaveBeenCalledWith(COMMIT_GENERATION_DEFAULT_ZEN_MODEL);
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({
      context: requestBody.context,
      guidance: undefined,
      zenModel: COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
    }));
  });

  it('preserves an explicit Zen model override', async () => {
    const generateCommitMessage = vi.fn(async () => ({
      subject: 'chore: update generated fixture',
      highlights: [],
    }));
    const { app, resolveZenModel } = makeApp({ generateCommitMessage });

    await request(app)
      .post('/api/git/commit-message?directory=/repo')
      .send({ ...requestBody, zenModel: 'big-pickle' })
      .expect(200);

    expect(resolveZenModel).toHaveBeenCalledWith('big-pickle');
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({
      zenModel: 'big-pickle',
    }));
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
    const resolveCommitZenModel = vi.fn(() => ({
      model: COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
      fallbackModel: 'another-free-model',
      catalogState: 'stale',
    }));
    const { app, generateCommitMessage, recordCommitTiming } = makeApp({ resolveCommitZenModel });

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
    expect(resolveCommitZenModel).toHaveBeenCalledWith(COMMIT_GENERATION_DEFAULT_ZEN_MODEL);
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({
      guidance: 'Prefer a source scope',
      zenModel: COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
      fallbackZenModel: null,
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

    expect(response.body).toEqual({
      title: 'Use direct Zen PR generation',
      body: '## Summary\n- Avoid chat sessions',
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
