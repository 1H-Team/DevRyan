import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMMIT_GENERATION_DEFAULT_ZEN_MODEL } from './commit-message.js';
import { registerGitRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

const makeApp = (resolveZenModel = vi.fn(async (override) => override || 'gpt-5-nano')) => {
  const app = express();
  app.use(express.json());
  registerGitRoutes(app, { resolveZenModel });
  return { app, resolveZenModel };
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
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses the commit-specific free Zen model without calling OpenCode session endpoints', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'feat: add generated source file' } }],
      }),
    }));
    globalThis.fetch = fetchMock;
    const { app, resolveZenModel } = makeApp();

    const response = await request(app)
      .post('/api/git/commit-message?directory=/repo')
      .send(requestBody)
      .expect(200);

    expect(response.body).toEqual({
      message: { subject: 'feat: add generated source file', highlights: [] },
    });
    expect(resolveZenModel).toHaveBeenCalledWith(COMMIT_GENERATION_DEFAULT_ZEN_MODEL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    const requestPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestedUrl).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(requestPayload.model).toBe(COMMIT_GENERATION_DEFAULT_ZEN_MODEL);
    expect(requestedUrl).not.toMatch(/session|prompt_async/);
  });

  it('preserves an explicit Zen model override', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'chore: update generated fixture' } }],
      }),
    }));
    globalThis.fetch = fetchMock;
    const { app, resolveZenModel } = makeApp();

    await request(app)
      .post('/api/git/commit-message?directory=/repo')
      .send({ ...requestBody, zenModel: 'big-pickle' })
      .expect(200);

    expect(resolveZenModel).toHaveBeenCalledWith('big-pickle');
    const requestPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestPayload.model).toBe('big-pickle');
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
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'this is not a conventional commit' } }],
      }),
    }));
    const { app } = makeApp(vi.fn(async () => 'big-pickle'));

    const response = await request(app)
      .post('/api/git/commit-message?directory=/repo')
      .send(requestBody)
      .expect(500);

    expect(response.body.error).toMatch(/valid conventional commit/);
  });
});
