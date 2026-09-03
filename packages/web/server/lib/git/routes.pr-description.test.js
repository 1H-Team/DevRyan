import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreeZenCooldowns } from '@openchamber/shared-runtime';

import { registerGitRoutes } from './routes.js';

const fileDiff = (path, lines) => [
  `diff --git a/${path} b/${path}`,
  'index 000..111 100644',
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1 +1 @@',
  ...Array.from({ length: lines }, (_, index) => `+line ${index} of ${path} ${'x'.repeat(60)}`),
].join('\n');

const exhaustedError = (failures = [{ model: 'free-a', reason: 'rate_limited', durationMs: 5 }], skipped = []) => Object.assign(
  new Error('Unable to generate a pull request description with the available free Zen models'),
  { code: 'FREE_ZEN_EXHAUSTED', attempts: failures.length, failures, skipped },
);

// Mirrors the real generator: journals every attempt through onAttempt.
const exhaustedGenerator = (failures, skipped) => vi.fn(async ({ onAttempt }) => {
  failures.forEach((failure, index) => onAttempt?.({ ...failure, attempt: index + 1, outcome: 'failed' }));
  throw exhaustedError(failures, skipped);
});

const makeApp = ({
  fetchFreeZenModels = vi.fn(async () => [{ id: 'free-a' }, { id: 'free-b' }]),
  getCachedFreeZenModels,
  generatePullRequestDescription = vi.fn(async ({ onAttempt }) => {
    onAttempt?.({ model: 'free-a', attempt: 1, durationMs: 12, outcome: 'complete' });
    return { title: 'Free Zen title', body: '## Summary\n- free', _generation: { model: 'free-a', attempts: 1, failures: [], skipped: [] } };
  }),
  generateTextWithSessionModel = vi.fn(async () => ({ ok: false, value: null, reason: 'timeout', attempts: 1, durationMs: 60_000 })),
  listConfigAgents = vi.fn(() => []),
  buildOpenCodeUrl = (requestPath) => `http://opencode.test${requestPath}`,
  getOpenCodeAuthHeaders = () => ({}),
  recordCommitTiming = vi.fn(),
  loadGitLibraries = async () => ({
    getRangeDiff: vi.fn(async () => ''),
    runGitCommand: vi.fn(async () => ({ success: true, stdout: '' })),
  }),
} = {}) => {
  const app = express();
  app.use(express.json());
  registerGitRoutes(app, {
    fetchFreeZenModels,
    getCachedFreeZenModels,
    generatePullRequestDescription,
    generateTextWithSessionModel,
    freeZenCooldowns: createFreeZenCooldowns(),
    listConfigAgents,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    recordCommitTiming,
    loadGitLibraries,
  });
  return { app, generatePullRequestDescription, generateTextWithSessionModel, recordCommitTiming, listConfigAgents };
};

const post = (app, body = {}) => request(app)
  .post('/api/git/pr-description?directory=/repo')
  .send({ base: 'main', head: 'feature/pr', prompt: 'Return the Generate PR JSON', ...body });

const builderAgents = [{ name: 'builder', model: { providerID: 'anthropic', modelID: 'claude-sonnet' } }];

describe('POST /api/git/pr-description', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('feeds the diff stat and a capped unified diff for base...head into the prompt, skipping binary files', async () => {
    const getRangeDiff = vi.fn(async () => [
      fileDiff('src/small.ts', 3),
      'diff --git a/logo.png b/logo.png\nindex 000..111\nBinary files a/logo.png and b/logo.png differ',
      fileDiff('src/huge.ts', 1_200),
    ].join('\n'));
    const runGitCommand = vi.fn(async () => ({ success: true, stdout: ' src/small.ts | 3 +\n 3 files changed' }));
    const { app, generatePullRequestDescription } = makeApp({
      loadGitLibraries: async () => ({ getRangeDiff, runGitCommand }),
    });

    await post(app).expect(200);

    expect(getRangeDiff).toHaveBeenCalledWith('/repo', { base: 'main', head: 'feature/pr', contextLines: 2 });
    expect(runGitCommand).toHaveBeenCalledWith('/repo', ['diff', '--stat=120', '--no-color', 'main...feature/pr']);
    const { prompt } = generatePullRequestDescription.mock.calls[0][0];
    expect(prompt.startsWith('Return the Generate PR JSON\n\nDiff stat:\nsrc/small.ts | 3 +')).toBe(true);
    expect(prompt).toMatch(/Diff \(truncated to \d+ of \d+ chars\) — binary files skipped: logo\.png:/);
    expect(prompt).toContain('+line 2 of src/small.ts');
    expect(prompt).not.toContain('Binary files');
    expect(prompt).not.toContain('+line 1199 of src/huge.ts');
    expect(prompt.length).toBeLessThanOrEqual('Return the Generate PR JSON'.length + 40_000 + 400);
  });

  it('keeps generating when diff collection fails', async () => {
    const { app, generatePullRequestDescription } = makeApp({
      loadGitLibraries: async () => ({
        getRangeDiff: vi.fn(async () => { throw new Error('bad revision'); }),
        runGitCommand: vi.fn(async () => ({ success: false, stdout: '', stderr: 'fatal' })),
      }),
    });
    const response = await post(app).expect(200);
    expect(response.body).toMatchObject({ title: 'Free Zen title', source: 'free_zen', model: 'free-a' });
    expect(generatePullRequestDescription.mock.calls[0][0].prompt).toBe('Return the Generate PR JSON');
  });

  it('falls back to the stale catalog when the live catalog fetch fails', async () => {
    const { app, generatePullRequestDescription } = makeApp({
      fetchFreeZenModels: vi.fn(async () => { throw new Error('offline'); }),
      getCachedFreeZenModels: vi.fn(() => [{ id: 'stale-a' }]),
    });
    const response = await post(app).expect(200);
    expect(response.body).toMatchObject({ source: 'free_zen', attempts: [{ tier: 'free_zen', model: 'free-a', reason: null }] });
    expect(generatePullRequestDescription).toHaveBeenCalledWith(expect.objectContaining({ models: [{ id: 'stale-a' }] }));
  });

  it('remembers the last catalog it saw and reuses it when the fetch later fails', async () => {
    let calls = 0;
    const { app, generatePullRequestDescription } = makeApp({
      fetchFreeZenModels: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return [{ id: 'remembered' }];
        throw new Error('offline');
      }),
    });
    await post(app).expect(200);
    await post(app).expect(200);
    expect(generatePullRequestDescription.mock.calls[1][0].models).toEqual([{ id: 'remembered' }]);
  });

  it('goes straight to the Builder session model when no free models are available', async () => {
    const generateTextWithSessionModel = vi.fn(async () => ({
      ok: true,
      value: { title: 'Session title', body: '## Summary\n- session' },
      attempts: 1,
      durationMs: 800,
    }));
    const { app, generatePullRequestDescription, recordCommitTiming } = makeApp({
      fetchFreeZenModels: vi.fn(async () => { throw new Error('offline'); }),
      listConfigAgents: vi.fn(() => builderAgents),
      generateTextWithSessionModel,
    });
    const response = await post(app).expect(200);
    expect(generatePullRequestDescription).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      title: 'Session title',
      body: '## Summary\n- session',
      source: 'session_model',
      model: 'anthropic/claude-sonnet',
      attempts: [{ tier: 'session_model', model: 'anthropic/claude-sonnet', reason: null, durationMs: 800 }],
    });
    expect(recordCommitTiming).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'git_pr_description_model_attempt',
      tier: 'session_model',
      outcome: 'complete',
      model: 'anthropic/claude-sonnet',
      catalogState: 'builder',
      source: 'session_model',
    }));
  });

  it('uses the Builder model through the hidden helper agent when free Zen is exhausted', async () => {
    const generateTextWithSessionModel = vi.fn(async () => ({
      ok: true,
      value: { title: 'Session title', body: '## Summary\n- session' },
      attempts: 2,
      durationMs: 1_500,
    }));
    const { app, recordCommitTiming } = makeApp({
      generatePullRequestDescription: exhaustedGenerator(
        [{ model: 'free-a', reason: 'rate_limited', durationMs: 5 }, { model: 'free-b', reason: 'timeout', durationMs: 15_000 }],
        [{ model: 'free-c', reason: 'cooling_down' }],
      ),
      listConfigAgents: vi.fn(() => builderAgents),
      generateTextWithSessionModel,
    });

    const response = await post(app, { providerId: 'openai', modelId: 'gpt-5' }).expect(200);

    expect(response.body).toMatchObject({
      title: 'Session title',
      source: 'session_model',
      model: 'anthropic/claude-sonnet',
      attempts: [
        { tier: 'free_zen', model: 'free-a', reason: 'rate_limited' },
        { tier: 'free_zen', model: 'free-b', reason: 'timeout' },
        { tier: 'free_zen', model: 'free-c', reason: 'cooling_down' },
        { tier: 'session_model', model: 'anthropic/claude-sonnet', reason: null },
      ],
    });
    expect(generateTextWithSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      agent: 'devryan-pr',
      prompt: 'Return the Generate PR JSON',
      repairPrompt: expect.stringContaining('{"title": string, "body": string}'),
      timeoutMs: 60_000,
      accept: expect.any(Function),
      buildOpenCodeUrl: expect.any(Function),
    }));
    // One journal record per attempt, including tier and outcome.
    const journal = recordCommitTiming.mock.calls.map(([, payload]) => [payload.tier, payload.model, payload.outcome, payload.providerOutcome]);
    expect(journal).toEqual([
      ['free_zen', 'free-a', 'failed', 'rate_limited'],
      ['free_zen', 'free-b', 'failed', 'timeout'],
      ['session_model', 'anthropic/claude-sonnet', 'complete', 'complete'],
    ]);
  });

  it('uses the model from the request body when no Builder agent is configured', async () => {
    const generateTextWithSessionModel = vi.fn(async () => ({
      ok: true,
      value: { title: 'Session title', body: 'body' },
      attempts: 1,
      durationMs: 10,
    }));
    const { app } = makeApp({
      generatePullRequestDescription: exhaustedGenerator([{ model: 'free-a', reason: 'rate_limited', durationMs: 5 }]),
      listConfigAgents: vi.fn(() => [{ name: 'planner', model: { providerID: 'x', modelID: 'y' } }]),
      generateTextWithSessionModel,
    });
    const response = await post(app, { providerId: 'openai', modelId: 'gpt-5' }).expect(200);
    expect(response.body.model).toBe('openai/gpt-5');
    expect(generateTextWithSessionModel).toHaveBeenCalledWith(expect.objectContaining({ providerID: 'openai', modelID: 'gpt-5' }));
  });

  it('returns FREE_ZEN_EXHAUSTED with the attempts when no session model can be resolved', async () => {
    const { app, generateTextWithSessionModel } = makeApp({
      generatePullRequestDescription: exhaustedGenerator([{ model: 'free-a', reason: 'rate_limited', durationMs: 5 }]),
    });
    const response = await post(app).expect(502);
    expect(generateTextWithSessionModel).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      error: 'Unable to generate a pull request description with the available free Zen models',
      code: 'FREE_ZEN_EXHAUSTED',
      attempts: [{ tier: 'free_zen', model: 'free-a', reason: 'rate_limited', durationMs: 5 }],
    });
  });

  it('returns SESSION_MODEL_FAILED when the session model tier fails too', async () => {
    const { app } = makeApp({
      generatePullRequestDescription: exhaustedGenerator([{ model: 'free-a', reason: 'rate_limited', durationMs: 5 }]),
      listConfigAgents: vi.fn(() => builderAgents),
      generateTextWithSessionModel: vi.fn(async () => ({ ok: false, value: null, reason: 'timeout', attempts: 1, durationMs: 60_000 })),
    });
    const response = await post(app).expect(502);
    expect(response.body).toMatchObject({
      code: 'SESSION_MODEL_FAILED',
      error: expect.stringContaining('Builder model (anthropic/claude-sonnet)'),
      attempts: [
        { tier: 'free_zen', model: 'free-a', reason: 'rate_limited' },
        { tier: 'session_model', model: 'anthropic/claude-sonnet', reason: 'timeout' },
      ],
    });
  });

  it('returns NO_FREE_MODELS and CATALOG_UNAVAILABLE instead of 503 when nothing can run', async () => {
    const empty = makeApp({ fetchFreeZenModels: vi.fn(async () => []) });
    const emptyResponse = await post(empty.app).expect(500);
    expect(emptyResponse.body).toEqual({
      error: 'No free Zen models are currently available and no session model is configured',
      code: 'NO_FREE_MODELS',
      attempts: [],
    });
    expect(empty.generatePullRequestDescription).not.toHaveBeenCalled();

    const offline = makeApp({ fetchFreeZenModels: vi.fn(async () => { throw new Error('offline'); }) });
    const offlineResponse = await post(offline.app).expect(500);
    expect(offlineResponse.body).toEqual({
      error: 'Free Zen model catalog is unavailable',
      code: 'CATALOG_UNAVAILABLE',
      attempts: [],
    });
  });

  it('rejects missing base/head and prompt', async () => {
    const { app, generatePullRequestDescription } = makeApp();
    await request(app).post('/api/git/pr-description?directory=/repo').send({ base: 'main', prompt: 'x' }).expect(400);
    await request(app).post('/api/git/pr-description?directory=/repo').send({ base: 'main', head: 'feature' }).expect(400);
    await request(app).post('/api/git/pr-description').send({ base: 'main', head: 'feature', prompt: 'x' }).expect(400);
    expect(generatePullRequestDescription).not.toHaveBeenCalled();
  });
});
