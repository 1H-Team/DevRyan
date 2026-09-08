import http from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreeZenCooldowns } from '@openchamber/shared-runtime';
import { generateCommitMessageDirect } from './commit-message.js';
import { generatePullRequestDescriptionDirect } from './pr-description.js';

const context = { selectedFiles: [{ path: 'fixture.ts', index: 'M', workingDir: ' ' }], stagedOnly: true };
const draft = {
  commit: { subject: 'fix: rotate free models', details: ['Skip failed providers', 'Preserve staged changes'] },
  pr: { title: 'Rotate free models', body: '## Summary\n- Skip failed providers\n## Testing\n- Fixture transport' },
};
const generate = (kind, options) => kind === 'commit'
  ? generateCommitMessageDirect({ context, ...options })
  : generatePullRequestDescriptionDirect({ prompt: 'Describe the fixture change', ...options });

describe('Git generation over real isolated HTTP transport', () => {
  let server;
  let handle;
  let calls;
  let signals;
  const realFetch = globalThis.fetch;
  beforeEach(async () => {
    calls = [];
    signals = [];
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(body.model);
      handle(req, res, body);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    vi.stubGlobal('fetch', (url, options) => {
      expect(String(url)).toMatch(/^https:\/\/opencode.ai\/zen\/v1\/(chat\/completions|responses)$/);
      signals.push(options.signal);
      return realFetch(`${origin}${new URL(url).pathname}`, options);
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });

  it.each(['commit', 'pr'])('%s immediately recovers from rejected HTTP and invalid output using the third model', async (kind) => {
    handle = (_req, res, body) => {
      res.setHeader('Content-Type', 'application/json');
      if (body.model === 'a') {
        res.writeHead(429);
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: body.model === 'b' ? '{}' : JSON.stringify(draft[kind]) } }] }));
      }
    };
    const onAttempt = vi.fn();
    const result = await generate(kind, { models: ['a', 'b', 'c'], cooldowns: createFreeZenCooldowns(), onAttempt });
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(result._generation).toMatchObject({ model: 'c', attempts: 3 });
    expect(onAttempt.mock.calls.map(([attempt]) => attempt.reason)).toEqual(['rate_limited', 'invalid_output', undefined]);
  });

  it.each(['commit', 'pr'])('%s aborts a stalled response body before recovering with the next model', async (kind) => {
    let closedFirst;
    const firstClosed = new Promise((resolve) => { closedFirst = resolve; });
    handle = (_req, res, body) => {
      res.setHeader('Content-Type', 'application/json');
      if (body.model === 'a') {
        res.writeHead(200);
        res.write('{');
        res.on('close', closedFirst);
      } else {
        expect(signals[0].aborted).toBe(true);
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft[kind]) } }] }));
      }
    };
    const onAttempt = vi.fn();
    const result = await generate(kind, { models: ['a', 'b'], timeoutMs: 100, cooldowns: createFreeZenCooldowns(), onAttempt });
    await firstClosed;
    expect(result._generation).toMatchObject({ model: 'b', attempts: 2 });
    expect(calls).toEqual(['a', 'b']);
    expect(onAttempt.mock.calls[0][0]).toMatchObject({ reason: 'timeout' });
  });

  it('recovers immediately from a disconnected socket and supports the Responses endpoint', async () => {
    handle = (req, res, body) => {
      if (body.model === 'a') req.socket.destroy();
      else res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(draft.pr) }] }] }));
    };
    const result = await generate('pr', { models: ['a', 'gpt-free-fixture'], cooldowns: createFreeZenCooldowns() });
    expect(calls).toEqual(['a', 'gpt-free-fixture']);
    expect(result.title).toBe(draft.pr.title);
  });
});
