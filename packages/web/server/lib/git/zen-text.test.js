import http from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFreeZenCooldowns } from '@openchamber/shared-runtime';
import { createGitZenTextTransport } from './zen-text.js';
import { SESSION_MODEL_TEXT_ADVERTISE_ONLY_PATTERN } from '../opencode/session-model-text.js';
import { generateCommitMessageDirect } from './commit-message.js';
import { generatePullRequestDescriptionDirect } from './pr-description.js';

const context = { selectedFiles: [{ path: 'fixture.ts', index: 'M', workingDir: ' ' }], stagedOnly: true };
const drafts = {
  commit: JSON.stringify({ subject: 'fix: recover native generation', details: ['Rotate failed models', 'Clean up helper sessions'] }),
  pr: JSON.stringify({ title: 'Recover native generation', body: '## Summary\n- Rotate failed models\n## Testing\n- Isolated HTTP' }),
};

describe('native OpenCode Git generation transport', () => {
  let server;
  let origin;
  let calls;
  let message;
  let count;
  beforeEach(async () => {
    calls = [];
    count = 0;
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const url = new URL(req.url, 'http://localhost');
      calls.push({ path: url.pathname, method: req.method, directory: url.searchParams.get('directory'), body });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/session' && req.method === 'POST') res.end(JSON.stringify({ id: `ses_${++count}` }));
      else if (url.pathname.endsWith('/message') && req.method === 'POST') message(res, body);
      else if (url.pathname.endsWith('/abort') || req.method === 'DELETE') res.end('true');
      else res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const generate = (kind, extra = {}) => {
    const options = {
      ...createGitZenTextTransport({ buildOpenCodeUrl: (url) => `${origin}${url}`, directory: '/isolated/fixture', agent: kind === 'commit' ? 'devryan-commit' : 'devryan-pr' }),
      models: ['a', 'b', 'c'], cooldowns: createFreeZenCooldowns(), ...extra,
    };
    return kind === 'commit'
      ? generateCommitMessageDirect({ context, ...options })
      : generatePullRequestDescriptionDirect({ prompt: 'Describe the fixture', ...options });
  };

  it.each(['commit', 'pr'])('%s uses native free models, rejects embedded provider errors, and deletes all helpers', async (kind) => {
    message = (res, body) => {
      expect(body.model.providerID).toBe('opencode');
      expect(body.agent).toBe(kind === 'commit' ? 'devryan-commit' : 'devryan-pr');
      if (body.model.modelID === 'a') res.end(JSON.stringify({ info: { role: 'assistant', error: { name: 'APIError', data: { statusCode: 429, message: 'private upstream detail' } } }, parts: [] }));
      else res.end(JSON.stringify({ info: { role: 'assistant' }, parts: [{ type: 'text', text: body.model.modelID === 'b' ? '{}' : drafts[kind] }] }));
    };
    const attempts = [];
    const result = await generate(kind, { onAttempt: (attempt) => attempts.push(attempt) });
    expect(result._generation).toMatchObject({ model: 'c', attempts: 3 });
    expect(attempts.map(({ reason }) => reason)).toEqual(['rate_limited', 'invalid_output', undefined]);
    const helperPermission = [
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: '*', pattern: SESSION_MODEL_TEXT_ADVERTISE_ONLY_PATTERN, action: 'deny' },
    ];
    expect(calls.filter(({ path }) => path === '/session').map(({ body }) => body.permission)).toEqual([
      helperPermission, helperPermission, helperPermission,
    ]);
    expect(calls.filter(({ method }) => method === 'DELETE').map(({ path }) => path)).toEqual(['/session/ses_1', '/session/ses_2', '/session/ses_3']);
    expect(calls.every(({ directory }) => directory === '/isolated/fixture')).toBe(true);
    expect(JSON.stringify(attempts)).not.toContain('private');
  });

  it.each(['commit', 'pr'])('%s aborts and deletes a timed-out helper before creating the next one', async (kind) => {
    message = (res, body) => {
      if (body.model.modelID === 'a') return;
      res.end(JSON.stringify({ info: { role: 'assistant' }, parts: [{ type: 'text', text: drafts[kind] }] }));
    };
    const result = await generate(kind, { timeoutMs: 100 });
    expect(result._generation).toMatchObject({ model: 'b', attempts: 2 });
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /session', 'POST /session/ses_1/message', 'POST /session/ses_1/abort', 'DELETE /session/ses_1',
      'POST /session', 'POST /session/ses_2/message', 'DELETE /session/ses_2',
    ]);
  });

  it.each(['commit', 'pr'])('%s stops after one free-tier policy rejection', async (kind) => {
    message = (res) => res.end(JSON.stringify({ info: { role: 'assistant', error: { name: 'APIError', data: { statusCode: 403, message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode" } } }, parts: [] }));
    const cooldowns = createFreeZenCooldowns();
    const attempts = [];
    const outcome = await generate(kind, { cooldowns, onAttempt: (attempt) => attempts.push(attempt) }).catch((error) => error);
    expect(attempts.map(({ model, reason }) => [model, reason])).toEqual([['a', 'free_tier_rejected']]);
    expect(cooldowns.snapshot()).toEqual([]);
    expect(calls.filter(({ path }) => path === '/session')).toHaveLength(1);
    if (kind === 'commit') {
      expect(outcome._generation).toMatchObject({ source: 'local_fallback', providerOutcome: 'free_tier_rejected', attempts: 1 });
      expect(outcome._generation.warning).toBe('Free Zen rejected the request; created a local commit draft');
    } else {
      expect(outcome).toMatchObject({ code: 'FREE_ZEN_EXHAUSTED', attempts: 1 });
    }
  });
});
