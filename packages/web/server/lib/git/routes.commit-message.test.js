import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { COMMIT_GENERATION_DEFAULT_ZEN_MODEL } from './commit-message.js';
import { registerGitRoutes } from './routes.js';

const makeApp = ({
  resolveZenModel = vi.fn(async (override) => override || 'gpt-5-nano'),
  generateCommitMessage = vi.fn(async () => ({
    subject: 'feat: add generated source file',
    highlights: [],
  })),
} = {}) => {
  const app = express();
  app.use(express.json());
  registerGitRoutes(app, { resolveZenModel, generateCommitMessage });
  return { app, generateCommitMessage, resolveZenModel };
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
    expect(generateCommitMessage).toHaveBeenCalledWith({
      context: requestBody.context,
      guidance: undefined,
      zenModel: COMMIT_GENERATION_DEFAULT_ZEN_MODEL,
    });
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
});
