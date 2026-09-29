import express from 'express';
import request from '../../test-supertest.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerGitRoutes } from './routes.js';

const PINNED_MODEL = 'deepseek-v4.1-flash';

const fileDiff = (path, lines) => [
  `diff --git a/${path} b/${path}`,
  'index 000..111 100644',
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1 +1 @@',
  ...Array.from({ length: lines }, (_, index) => `+line ${index} of ${path} ${'x'.repeat(60)}`),
].join('\n');

const defaultFailures = [{ model: PINNED_MODEL, reason: 'rate_limited', durationMs: 5 }];

const exhaustedError = (failures = defaultFailures, skipped = []) => Object.assign(
  new Error(`Zen could not generate a pull request description (${PINNED_MODEL}: ${failures.at(-1)?.reason})`),
  { code: 'FREE_ZEN_EXHAUSTED', attempts: failures.length, failures, skipped },
);

// Mirrors the real generator: journals every attempt through onAttempt.
const exhaustedGenerator = (failures = defaultFailures, skipped = []) => vi.fn(async ({ onAttempt }) => {
  failures.forEach((failure, index) => onAttempt?.({ ...failure, attempt: index + 1, outcome: 'failed' }));
  throw exhaustedError(failures, skipped);
});

const makeApp = ({
  generatePullRequestDescription = vi.fn(async ({ onAttempt }) => {
    onAttempt?.({ model: PINNED_MODEL, attempt: 1, durationMs: 12, outcome: 'complete' });
    return { title: 'Zen title', body: '## Summary\n- zen', _generation: { model: PINNED_MODEL, attempts: 1, failures: [], skipped: [] } };
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
    generatePullRequestDescription,
    generateTextWithSessionModel,
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
    expect(response.body).toMatchObject({ title: 'Zen title', source: 'zen', model: PINNED_MODEL });
    expect(generatePullRequestDescription.mock.calls[0][0].prompt).toBe('Return the Generate PR JSON');
  });

  it('always sends the pinned Zen model without a cooldown catalog', async () => {
    const { app, generatePullRequestDescription, recordCommitTiming } = makeApp();
    const response = await post(app, { providerId: 'openai', modelId: 'gpt-5' }).expect(200);
    expect(response.body).toMatchObject({ source: 'zen', attempts: [{ tier: 'zen', model: PINNED_MODEL, reason: null }] });
    expect(generatePullRequestDescription).toHaveBeenCalledWith(expect.objectContaining({ models: [PINNED_MODEL], cooldowns: null }));
    expect(recordCommitTiming).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'git_pr_description_model_attempt',
      tier: 'zen',
      model: PINNED_MODEL,
      catalogState: 'pinned',
    }));
  });

  it('uses the Builder model through the hidden helper agent when Zen fails', async () => {
    const generateTextWithSessionModel = vi.fn(async () => ({
      ok: true,
      value: { title: 'Session title', body: '## Summary\n- session' },
      attempts: 2,
      durationMs: 1_500,
    }));
    const { app, recordCommitTiming } = makeApp({
      generatePullRequestDescription: exhaustedGenerator([{ model: PINNED_MODEL, reason: 'timeout', durationMs: 15_000 }]),
      listConfigAgents: vi.fn(() => builderAgents),
      generateTextWithSessionModel,
    });

    const response = await post(app, { providerId: 'openai', modelId: 'gpt-5' }).expect(200);

    expect(response.body).toMatchObject({
      title: 'Session title',
      source: 'session_model',
      model: 'anthropic/claude-sonnet',
      attempts: [
        { tier: 'zen', model: PINNED_MODEL, reason: 'timeout' },
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
      ['zen', PINNED_MODEL, 'failed', 'timeout'],
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
      generatePullRequestDescription: exhaustedGenerator(),
      listConfigAgents: vi.fn(() => [{ name: 'planner', model: { providerID: 'x', modelID: 'y' } }]),
      generateTextWithSessionModel,
    });
    const response = await post(app, { providerId: 'openai', modelId: 'gpt-5' }).expect(200);
    expect(response.body.model).toBe('openai/gpt-5');
    expect(generateTextWithSessionModel).toHaveBeenCalledWith(expect.objectContaining({ providerID: 'openai', modelID: 'gpt-5' }));
  });

  it('returns FREE_ZEN_EXHAUSTED with the attempts when no session model can be resolved', async () => {
    const { app, generateTextWithSessionModel } = makeApp({
      generatePullRequestDescription: exhaustedGenerator(),
    });
    const response = await post(app).expect(502);
    expect(generateTextWithSessionModel).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      error: 'Zen could not generate a pull request description (deepseek-v4.1-flash: rate_limited)',
      code: 'FREE_ZEN_EXHAUSTED',
      attempts: [{ tier: 'zen', model: PINNED_MODEL, reason: 'rate_limited', durationMs: 5 }],
    });
  });

  it('returns SESSION_MODEL_FAILED when the session model tier fails too', async () => {
    const { app } = makeApp({
      generatePullRequestDescription: exhaustedGenerator(),
      listConfigAgents: vi.fn(() => builderAgents),
      generateTextWithSessionModel: vi.fn(async () => ({ ok: false, value: null, reason: 'timeout', attempts: 1, durationMs: 60_000 })),
    });
    const response = await post(app).expect(502);
    expect(response.body).toMatchObject({
      code: 'SESSION_MODEL_FAILED',
      error: expect.stringContaining('Builder model (anthropic/claude-sonnet)'),
      attempts: [
        { tier: 'zen', model: PINNED_MODEL, reason: 'rate_limited' },
        { tier: 'session_model', model: 'anthropic/claude-sonnet', reason: 'timeout' },
      ],
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
