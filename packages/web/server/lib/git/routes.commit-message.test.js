import express from 'express';
import request from '../../test-supertest.js';
import { describe, expect, it, vi } from 'vitest';

import { generateCommitMessageDirect } from './commit-message.js';
import { registerGitRoutes } from './routes.js';

const PINNED_MODEL = 'deepseek-v4.1-flash';

const makeApp = ({
  resolveZenModel = vi.fn(async (override) => override || 'gpt-5-nano'),
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
    generateCommitMessage,
    generatePullRequestDescription,
    recordCommitTiming,
    loadGitLibraries,
  });
  return {
    app,
    generateCommitMessage,
    generatePullRequestDescription,
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
  it('uses the pinned Zen model without resolving a session model', async () => {
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
      models: [PINNED_MODEL],
      cooldowns: null,
    }));
  });

  it('ignores a requested Zen model and keeps the pinned model', async () => {
    const { app, generateCommitMessage } = makeApp();
    await request(app).post('/api/git/commit-message?directory=/repo')
      .send({ ...requestBody, zenModel: 'big-pickle' }).expect(200);
    expect(generateCommitMessage).toHaveBeenCalledWith(expect.objectContaining({ models: [PINNED_MODEL] }));
  });

  it.each(['/commit-message', '/commit-message/draft'])('generates through the real generator for %s and journals the attempt', async (route) => {
    const requestText = vi.fn(async () => JSON.stringify({ subject: 'fix: recover generation', details: ['Use the pinned model', 'Keep staged scope'] }));
    const { app, recordCommitTiming } = makeApp({
      generateCommitMessage: (options) => generateCommitMessageDirect({ ...options, requestText }),
    });
    const response = await request(app).post(`/api/git${route}?directory=/repo`)
      .send(route.endsWith('/draft') ? { selectedFiles: ['new-file.ts'] } : requestBody).expect(200);
    const message = response.body.message ?? response.body.commits[0];
    expect(message.subject).toBe('fix: recover generation');
    expect(response.body.warnings).toBeUndefined();
    expect(requestText.mock.calls.map(([input]) => input.zenModel)).toEqual([PINNED_MODEL]);
    const attempts = recordCommitTiming.mock.calls.map(([, payload]) => payload).filter(({ event }) => event === 'git_commit_message_model_attempt');
    expect(attempts.map(({ tier, attempt, model, providerOutcome }) => [tier, attempt, model, providerOutcome])).toEqual([
      ['zen', 1, PINNED_MODEL, 'complete'],
    ]);
    expect(recordCommitTiming).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      source: 'ai', retried: false, model: PINNED_MODEL, catalogState: 'pinned',
    }));
  });

  it('returns a disclosed local draft when the pinned model fails', async () => {
    const requestText = vi.fn(async () => {
      throw Object.assign(new Error('Zen generation timed out'), { reason: 'timeout' });
    });
    const { app, recordCommitTiming } = makeApp({
      generateCommitMessage: (options) => generateCommitMessageDirect({ ...options, requestText }),
    });
    const response = await request(app).post('/api/git/commit-message/draft?directory=/repo')
      .send({ selectedFiles: ['new-file.ts'] }).expect(200);
    expect(response.body.status).toBe('complete');
    expect(response.body.commits[0].subject).toBeTruthy();
    expect(response.body.warnings).toEqual(['Zen generation failed (deepseek-v4.1-flash: timeout); created a local commit draft']);
    expect(requestText).toHaveBeenCalledTimes(1);
    expect(recordCommitTiming).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      source: 'local_fallback', providerOutcome: 'exhausted', catalogState: 'pinned',
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
    const { app, generateCommitMessage, recordCommitTiming } = makeApp();

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
      models: [PINNED_MODEL],
      context: expect.objectContaining({
        selectedFiles: [expect.objectContaining({ path: 'new-file.ts' })],
      }),
    }));
    expect(response.headers['server-timing']).toMatch(/commit-context;dur=/);
    expect(recordCommitTiming).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'complete',
      selectedFileCount: 1,
      catalogState: 'pinned',
    }));
  });

  it('keeps staged-only context and selected paths in the prompt', async () => {
    const getDiff = vi.fn(async () => '+staged fixture change');
    const requestText = vi.fn(async () => 'fix: describe staged changes');
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
    expect(requestText).toHaveBeenCalledTimes(1);
    const [{ prompt }] = requestText.mock.calls[0];
    expect(prompt).toContain('"stagedOnly":true');
    expect(prompt).not.toContain('unselected.ts');
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
  it('uses the pinned Zen model and rendered prompt without model selection', async () => {
    const { app, generatePullRequestDescription, resolveZenModel } = makeApp();
    const response = await request(app)
      .post('/api/git/pr-description?directory=/repo')
      .send({ base: 'main', head: 'feature/direct-pr', prompt: 'Return the Generate PR JSON' })
      .expect(200);

    expect(response.body).toMatchObject({
      title: 'Use direct Zen PR generation',
      body: '## Summary\n- Avoid chat sessions',
      source: 'zen',
    });
    expect(generatePullRequestDescription).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Return the Generate PR JSON',
      models: [PINNED_MODEL],
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
