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
  resolveHelperSelection,
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
    resolveHelperSelection,
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
    expect(response.body).toMatchObject({ title: 'Zen title', source: 'helper_model', selectionMode: 'configured', model: `opencode/${PINNED_MODEL}` });
    expect(generatePullRequestDescription.mock.calls[0][0].prompt).toBe('Return the Generate PR JSON');
  });

  it('always sends the pinned Zen model without a cooldown catalog', async () => {
    const { app, generatePullRequestDescription, recordCommitTiming } = makeApp();
    const response = await post(app, { sessionID: 'ses_active', providerId: 'foreign', modelId: 'ignored' }).expect(200);
    expect(response.body).toMatchObject({ source: 'helper_model', attempts: [{ tier: 'zen', model: PINNED_MODEL, reason: null }] });
    expect(generatePullRequestDescription).toHaveBeenCalledWith(expect.objectContaining({ models: [PINNED_MODEL], cooldowns: null }));
    expect(recordCommitTiming).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'git_pr_description_model_attempt',
      tier: 'zen',
      model: PINNED_MODEL,
      catalogState: 'pinned',
    }));
  });

  it('uses only the authorized active model through the existing helper agent when the configured helper fails', async () => {
    const generateTextWithSessionModel = vi.fn(async () => ({
      ok: true,
      value: { title: 'Session title', body: '## Summary\n- session' },
      attempts: 2,
      durationMs: 1_500,
    }));
    const { app, recordCommitTiming } = makeApp({
      generatePullRequestDescription: exhaustedGenerator([{ model: PINNED_MODEL, reason: 'timeout', durationMs: 15_000 }]),
      listConfigAgents: vi.fn(() => builderAgents),
      resolveHelperSelection: async ({ selectionMode }) => selectionMode === 'configured' ? { providerID: 'opencode', modelID: PINNED_MODEL, selectionMode, selectionRevision: '1' } : { providerID: 'anthropic', modelID: 'claude-sonnet', selectionMode, selectionRevision: 'active-session' },
      generateTextWithSessionModel,
    });

    const response = await post(app, { sessionID: 'ses_active', providerId: 'foreign', modelId: 'ignored' }).expect(200);

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

  it('ignores Builder and request model hints without an authorized active session', async () => {
    const { app, generateTextWithSessionModel, listConfigAgents } = makeApp({ generatePullRequestDescription: exhaustedGenerator(), listConfigAgents: vi.fn(() => builderAgents) });
    const response = await post(app, { providerId: 'openai', modelId: 'gpt-5' }).expect(502);
    expect(response.body.code).toBe('HELPER_ACTIVE_MODEL_REQUIRED');
    expect(generateTextWithSessionModel).not.toHaveBeenCalled();
    expect(listConfigAgents).not.toHaveBeenCalled();
  });

  it('refuses a revoked active session even with a supplied model hint', async () => {
    const resolver = vi.fn(async ({ selectionMode }) => {
      if (selectionMode === 'active') throw Object.assign(new Error('native_session_access_revoked'), { code: 'native_session_access_revoked', statusCode: 403 });
      return { providerID: 'opencode', modelID: PINNED_MODEL, selectionMode, selectionRevision: '1' };
    });
    const { app, generateTextWithSessionModel } = makeApp({ generatePullRequestDescription: exhaustedGenerator(), resolveHelperSelection: resolver });
    const response = await post(app, { sessionID: 'ses_revoked', providerId: 'openai', modelId: 'gpt-5' }).expect(403);
    expect(response.body.code).toBe('native_session_access_revoked');
    expect(generateTextWithSessionModel).not.toHaveBeenCalled();
  });
  it.each(['selection','generation'])('refuses a changed helper %s without authorizing active fallback',async phase=>{
    const changed=Object.assign(Error('private source'),{code:'native_helper_selection_changed',statusCode:403});
    const resolver=vi.fn(async()=>{if(phase==='selection')throw changed;return {providerID:'saved',modelID:'model',selectionMode:'configured',selectionRevision:'old'};});
    const {app,generateTextWithSessionModel}=makeApp({resolveHelperSelection:resolver,generatePullRequestDescription:async()=>{throw changed;}});
    const response=await post(app,{sessionID:'ses_active'}).expect(409);
    expect(response.body.code).toBe('HELPER_SELECTION_CHANGED');expect(response.body.error).toContain('Refresh');
    expect(resolver).toHaveBeenCalledTimes(1);expect(generateTextWithSessionModel).not.toHaveBeenCalled();
  });

  it('returns an actionable refusal with attempts when no active model can be authorized', async () => {
    const { app, generateTextWithSessionModel } = makeApp({
      generatePullRequestDescription: exhaustedGenerator(),
    });
    const response = await post(app).expect(502);
    expect(generateTextWithSessionModel).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      error: 'Select an accessible active chat with a model, or change the helper model in Settings → Agents → Session Defaults.',
      code: 'HELPER_ACTIVE_MODEL_REQUIRED',
      attempts: [{ tier: 'zen', model: PINNED_MODEL, reason: 'rate_limited', durationMs: 5 }],
    });
  });

  it('returns SESSION_MODEL_FAILED when the session model tier fails too', async () => {
    const { app } = makeApp({
      generatePullRequestDescription: exhaustedGenerator(),
      listConfigAgents: vi.fn(() => builderAgents),
      resolveHelperSelection: async ({ selectionMode }) => selectionMode === 'configured' ? { providerID: 'opencode', modelID: PINNED_MODEL, selectionMode, selectionRevision: '1' } : { providerID: 'anthropic', modelID: 'claude-sonnet', selectionMode, selectionRevision: 'active-session' },
      generateTextWithSessionModel: vi.fn(async () => ({ ok: false, value: null, reason: 'timeout', attempts: 1, durationMs: 60_000 })),
    });
    const response = await post(app, { sessionID: 'ses_active' }).expect(502);
    expect(response.body).toMatchObject({
      code: 'SESSION_MODEL_FAILED',
      error: expect.stringContaining('active session model (anthropic/claude-sonnet)'),
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
