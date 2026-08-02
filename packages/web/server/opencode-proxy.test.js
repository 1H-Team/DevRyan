import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import express from 'express';
import path from 'path';
import { promisify } from 'node:util';

import { createSseBoundaryTracker, registerOpenCodeProxy, writeSseChunkWithBackpressure } from './lib/opencode/proxy.js';
import { bindScopedRevertRequestAbort, runScopedSessionRevert } from './lib/opencode/session-scoped-revert.js';
import { createTurnTimingRuntime } from './lib/opencode/turn-timing.js';

const execFileAsync = promisify(execFile);

const listen = (app, host = '127.0.0.1') => new Promise((resolve, reject) => {
  const server = app.listen(0, host, () => resolve(server));
  server.once('error', reject);
});

const closeServer = (server) => new Promise((resolve, reject) => {
  if (!server) {
    resolve();
    return;
  }
  server.close((error) => {
    if (error) {
      reject(error);
      return;
    }
    resolve();
  });
});

const createTestRepo = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-scoped-revert-'));
  await execFileAsync('git', ['init'], { cwd: directory });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
  await execFileAsync('git', ['config', 'user.name', 'OpenChamber Test'], { cwd: directory });
  return directory;
};

const commitAll = async (directory, message = 'baseline') => {
  await execFileAsync('git', ['add', '.'], { cwd: directory });
  await execFileAsync('git', ['commit', '-m', message], { cwd: directory });
};

const createProxyApp = (upstreamPort, options = {}) => {
  const app = express();
  registerOpenCodeProxy(app, {
    fs: {},
    os: {},
    path,
    OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({
      openCodePort: upstreamPort,
      isOpenCodeReady: true,
      openCodeNotReadySince: 0,
      isRestartingOpenCode: false,
    }),
    getOpenCodeAuthHeaders: () => options.authHeaders ?? {},
    buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
    turnTimingRuntime: options.turnTimingRuntime,
    openCodeSnapshotRoot: options.openCodeSnapshotRoot,
    scopedRevertTimeoutMs: options.scopedRevertTimeoutMs,
  });
  return app;
};

const userMessageWithDiff = (id, diff) => ({
  info: {
    id,
    sessionID: 'session-a',
    role: 'user',
    time: { created: id === 'msg-target' ? 1 : 2 },
    agent: 'build',
    model: { providerID: 'test', modelID: 'test' },
    summary: { diffs: [diff] },
  },
  parts: [],
});

const addedLinePatch = (filePath, beforeLine, addedLine) => `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@ -1 +1,2 @@
 ${beforeLine}
+${addedLine}
`;

const createOpenCodeSnapshotRepo = async (directory, snapshotRoot, projectID) => {
  const projectSnapshotRoot = path.join(snapshotRoot, projectID);
  const snapshotGitDir = path.join(projectSnapshotRoot, 'snapshot.git');
  await fs.mkdir(projectSnapshotRoot, { recursive: true });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: directory });
  await execFileAsync('git', ['clone', '--bare', directory, snapshotGitDir]);
  return stdout.trim();
};

const createOpenCodeSnapshotRepoWithFiles = async (directory, snapshotRoot, projectID, files) => {
  const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-snapshot-source-'));
  try {
    await execFileAsync('git', ['clone', '--quiet', directory, sourceDirectory]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceDirectory });
    await execFileAsync('git', ['config', 'user.name', 'OpenChamber Test'], { cwd: sourceDirectory });
    for (const [file, content] of Object.entries(files)) {
      const absolute = path.join(sourceDirectory, file);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content);
    }
    await commitAll(sourceDirectory, 'snapshot state');
    const snapshotHash = await createOpenCodeSnapshotRepo(sourceDirectory, snapshotRoot, projectID);
    return snapshotHash;
  } finally {
    await fs.rm(sourceDirectory, { recursive: true, force: true });
  }
};

describe('OpenCode proxy SSE forwarding', () => {
  let upstreamServer;
  let proxyServer;

  afterEach(async () => {
    await closeServer(proxyServer);
    await closeServer(upstreamServer);
    proxyServer = undefined;
    upstreamServer = undefined;
  });

  it('forwards event streams with nginx-safe headers', async () => {
    let seenAuthorization = null;

    const upstream = express();
    upstream.get('/global/event', (req, res) => {
      seenAuthorization = req.headers.authorization ?? null;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=0');
      res.setHeader('X-Upstream-Test', 'ok');
      res.write('data: {"ok":true}\n\n');
      res.end();
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/global/event`, {
      headers: { Accept: 'text/event-stream' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('x-upstream-test')).toBe('ok');
    expect(await response.text()).toBe('data: {"ok":true}\n\n');
    expect(seenAuthorization).toBe('Bearer test-token');
  });

  it('waits for drain when writing to a slow SSE response', async () => {
    const writes = [];
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = false;
    res.write = (value) => {
      writes.push(value);
      return false;
    };
    const controller = new AbortController();

    const write = writeSseChunkWithBackpressure(res, Buffer.from('data: {"ok":true}\n\n'), controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toHaveLength(1);

    res.emit('drain');

    await expect(write).resolves.toBe(true);
  });

  it('tracks whether a raw SSE stream is between event blocks', () => {
    const tracker = createSseBoundaryTracker();

    expect(tracker.isAtBoundary()).toBe(true);
    expect(tracker.observe(Buffer.from('id: evt-1\n'))).toBe(false);
    expect(tracker.observe(Buffer.from('data: {"ok"'))).toBe(false);
    expect(tracker.observe(Buffer.from(':true}\n'))).toBe(false);
    expect(tracker.observe(Buffer.from('\n'))).toBe(true);
    expect(tracker.observe(Buffer.from('data: next\r\n\r\n'))).toBe(true);
  });

  it('routes generic API requests through external OpenCode base URL', async () => {
    const upstream = express();
    upstream.get('/config/providers', (_req, res) => {
      res.json({ ok: true, source: 'external-host' });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;
    const externalBaseUrl = `http://127.0.0.1:${upstreamPort}`;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: 3902,
        openCodeBaseUrl: externalBaseUrl,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${externalBaseUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/config/providers`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, source: 'external-host' });
  });

  it('forwards MCP connect actions with auth headers', async () => {
    let seenAuthorization = null;

    const upstream = express();
    upstream.post('/mcp/mobbin/connect', (req, res) => {
      seenAuthorization = req.headers.authorization ?? null;
      res.setHeader('X-Upstream-Test', 'mcp-connect');
      res.json({ ok: true, name: 'mobbin' });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port, {
      authHeaders: { Authorization: 'Bearer test-token' },
    }));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/mcp/mobbin/connect`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream-test')).toBe('mcp-connect');
    expect(await response.json()).toEqual({ ok: true, name: 'mobbin' });
    expect(seenAuthorization).toBe('Bearer test-token');
  });

  it('returns JSON when upstream MCP connect fails with an empty body', async () => {
    const upstream = express();
    upstream.post('/mcp/mobbin/connect', (_req, res) => {
      res.status(503).end();
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/mcp/mobbin/connect`, {
      method: 'POST',
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(payload).toEqual(expect.objectContaining({
      error: 'MCP server connect failed',
      server: 'mobbin',
      status: 503,
      harness: expect.objectContaining({
        status: 'error',
        summary: 'MCP server "mobbin" connect failed',
      }),
    }));
  });

  it('returns JSON when upstream MCP connect is unavailable', async () => {
    const unavailableServer = await listen(express());
    const unavailablePort = unavailableServer.address().port;
    await closeServer(unavailableServer);

    proxyServer = await listen(createProxyApp(unavailablePort));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/mcp/mobbin/connect`, {
      method: 'POST',
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(payload).toEqual(expect.objectContaining({
      error: 'OpenCode service unavailable while connecting MCP server',
      server: 'mobbin',
      harness: expect.objectContaining({
        status: 'error',
        summary: 'MCP server "mobbin" connect unavailable',
      }),
    }));
  });

  it('passes unrelated MCP actions through the generic proxy', async () => {
    const upstream = express();
    upstream.post('/mcp/mobbin/status', (_req, res) => {
      res.json({ ok: true, status: 'connected' });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/mcp/mobbin/status`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'connected' });
  });

  it('records prompt_async proxy timing without forwarding diagnostic headers upstream', async () => {
    let now = 1_000;
    const runtime = createTurnTimingRuntime({ now: () => now });
    let upstreamMessageIdHeader = null;

    const upstream = express();
    upstream.use(express.json());
    upstream.post('/session/ses-1/prompt_async', (req, res) => {
      upstreamMessageIdHeader = req.headers['x-openchamber-message-id'] ?? null;
      now = 1_250;
      res.status(204).end();
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port, {
      turnTimingRuntime: runtime,
    }));
    const response = await fetch(
      `http://127.0.0.1:${proxyServer.address().port}/api/session/ses-1/prompt_async?directory=${encodeURIComponent('/project')}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openchamber-message-id': 'msg-user',
        },
        body: JSON.stringify({
          messageID: 'msg-user',
          model: { providerID: 'openai', modelID: 'gpt-5.6' },
          agent: 'builder',
          variant: 'high',
          parts: [{ type: 'text', text: 'Test prompt' }],
        }),
      }
    );

    expect(response.status).toBe(204);
    expect(upstreamMessageIdHeader).toBeNull();
    expect(runtime.getRecentTimings({ sessionId: 'ses-1' }).records[0]).toEqual(expect.objectContaining({
      sessionId: 'ses-1',
      userMessageId: 'msg-user',
      directory: '/project',
      model: {
        providerID: 'openai',
        modelID: 'gpt-5.6',
        agent: 'builder',
        variant: 'high',
      },
      durationsMs: {
        send_started_to_prompt_accepted: 250,
      },
    }));
  });

  it('replays parsed JSON bodies when proxying prompt_async requests', async () => {
    let upstreamBody = null;

    const upstream = express();
    upstream.use(express.json());
    upstream.post('/session/ses-1/prompt_async', (req, res) => {
      upstreamBody = req.body;
      res.status(204).end();
    });
    upstreamServer = await listen(upstream);

    const app = express();
    app.use(express.json());
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamServer.address().port,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamServer.address().port}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);

    const body = {
      messageID: 'msg-user',
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      parts: [{ type: 'text', text: 'Test prompt' }],
    };

    const response = await fetch(
      `http://127.0.0.1:${proxyServer.address().port}/api/session/ses-1/prompt_async?directory=${encodeURIComponent('/project')}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openchamber-message-id': 'msg-user',
        },
        body: JSON.stringify(body),
      }
    );

    expect(response.status).toBe(204);
    expect(upstreamBody).toEqual(body);
  });
});

describe('OpenCode scoped session revert', () => {
  let upstreamServer;
  let proxyServer;
  let repoDirectory;
  let snapshotRoot;
  let upstreamRevertCalls = 0;

  afterEach(async () => {
    await closeServer(proxyServer);
    await closeServer(upstreamServer);
    if (repoDirectory) {
      await fs.rm(repoDirectory, { recursive: true, force: true });
    }
    if (snapshotRoot) {
      await fs.rm(snapshotRoot, { recursive: true, force: true });
    }
    proxyServer = undefined;
    upstreamServer = undefined;
    repoDirectory = undefined;
    snapshotRoot = undefined;
    upstreamRevertCalls = 0;
  });

  it('returns a deterministic timeout when the upstream revert never settles', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async () => {
      upstreamRevertCalls += 1;
      await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port, { scopedRevertTimeoutMs: 100 }));
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload).toEqual({
      error: 'Scoped session revert timed out',
      code: 'SCOPED_REVERT_TIMEOUT',
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(upstreamRevertCalls).toBe(1);
    expect(await fs.readFile(path.join(repoDirectory, 'file-a.txt'), 'utf8')).toBe('base\nsession-a\n');
  });

  it('releases the directory lock after a timeout so the next revert can proceed', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      if (upstreamRevertCalls === 1) return;
      await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port, { scopedRevertTimeoutMs: 100 }));
    const url = `http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`;
    const firstResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });
    expect(firstResponse.status).toBe(504);

    const secondResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(secondResponse.status).toBe(200);
    expect(upstreamRevertCalls).toBe(2);
    expect(await fs.readFile(path.join(repoDirectory, 'file-a.txt'), 'utf8')).toBe('base\n');
  });

  it('aborts a scoped revert when the HTTP client socket disconnects', () => {
    const req = new EventEmitter();
    req.socket = new EventEmitter();
    const res = new EventEmitter();
    res.writableEnded = false;

    const requestAbort = bindScopedRevertRequestAbort(req, res);
    req.socket.emit('close');

    expect(requestAbort.signal.aborted).toBe(true);
    expect(requestAbort.signal.reason).toEqual(expect.objectContaining({
      code: 'SCOPED_REVERT_CANCELLED',
    }));
    requestAbort.dispose();
  });

  it('restores a delayed upstream mutation after cancellation before releasing the lock', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');

    let resolveFirstRevertStarted;
    const firstRevertStarted = new Promise((resolve) => {
      resolveFirstRevertStarted = resolve;
    });
    let resolveDelayedMutation;
    const delayedMutation = new Promise((resolve) => {
      resolveDelayedMutation = resolve;
    });
    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      if (upstreamRevertCalls === 1) {
        resolveFirstRevertStarted();
        await new Promise((resolve) => setTimeout(resolve, 75));
        await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
        resolveDelayedMutation();
        return res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
      }
      await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    const cancellation = new AbortController();
    const cancelledRevert = runScopedSessionRevert({
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamServer.address().port}${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      directory: repoDirectory,
      sessionID: 'session-a',
      messageID: 'msg-target',
      timeoutMs: 300,
      signal: cancellation.signal,
    });
    await firstRevertStarted;
    const cancellationError = new Error('test client disconnected');
    cancellationError.code = 'SCOPED_REVERT_CANCELLED';
    cancellation.abort(cancellationError);

    await expect(cancelledRevert).rejects.toEqual(expect.objectContaining({
      code: 'SCOPED_REVERT_CANCELLED',
    }));
    await delayedMutation;
    expect(await fs.readFile(path.join(repoDirectory, 'file-a.txt'), 'utf8')).toBe('base\nsession-a\n');

    const secondRevert = await runScopedSessionRevert({
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamServer.address().port}${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      directory: repoDirectory,
      sessionID: 'session-a',
      messageID: 'msg-target',
      timeoutMs: 300,
    });

    expect(secondRevert).toEqual(expect.objectContaining({ id: 'session-a' }));
    expect(upstreamRevertCalls).toBe(2);
    expect(await fs.readFile(path.join(repoDirectory, 'file-a.txt'), 'utf8')).toBe('base\n');
  });

  it('reports an unconfirmed rollback when final interruption cleanup fails', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 125));
      await fs.rm(path.join(repoDirectory, 'file-a.txt'), { force: true });
      await fs.mkdir(path.join(repoDirectory, 'file-a.txt'));
      res.json({ id: 'session-a' });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port, { scopedRevertTimeoutMs: 100 }));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: 'Scoped session revert rollback could not be confirmed',
      code: 'SCOPED_REVERT_ROLLBACK_FAILED',
    });
    expect((await fs.stat(path.join(repoDirectory, 'file-a.txt'))).isDirectory()).toBe(true);
  });

  it('does not rewrite protected files that already match their desired snapshot', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');
    await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'base\nsession-b\n');
    await fs.utimes(path.join(repoDirectory, 'file-b.txt'), 1_000_000_000, 1_000_000_000);
    const beforeMtime = (await fs.stat(path.join(repoDirectory, 'file-b.txt'))).mtimeMs;

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(200);
    expect((await fs.stat(path.join(repoDirectory, 'file-b.txt'))).mtimeMs).toBe(beforeMtime);
    expect(await fs.readFile(path.join(repoDirectory, 'file-b.txt'), 'utf8')).toBe('base\nsession-b\n');
  });

  it('reverts only files changed by the clicked session', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');
    await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'base\nsession-b\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
      await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'base\n');
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(200);
    expect(upstreamRevertCalls).toBe(1);
    expect(await fs.readFile(path.join(repoDirectory, 'file-a.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(repoDirectory, 'file-b.txt'), 'utf8')).toBe('base\nsession-b\n');
  });

  it('reverts an added file whose patch has no final newline', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'baseline.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'added.txt'), 'session-a');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'added.txt',
          status: 'added',
          patch: `Index: added.txt
===================================================================
--- added.txt
+++ added.txt
@@ -0,0 +1,1 @@
+session-a
\\ No newline at end of file
`,
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      await fs.rm(path.join(repoDirectory, 'added.txt'));
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(200);
    expect(upstreamRevertCalls).toBe(1);
    await expect(fs.access(path.join(repoDirectory, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves unrelated hunks in the same file', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'same.txt'), 'one\ntwo\nthree\nfour\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'same.txt'), 'one\nsession-a\ntwo\nthree\nsession-b\nfour\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'same.txt',
          status: 'modified',
          patch: `diff --git a/same.txt b/same.txt
--- a/same.txt
+++ b/same.txt
@@ -1,2 +1,3 @@
 one
+session-a
 two
`,
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      await fs.writeFile(path.join(repoDirectory, 'same.txt'), 'one\ntwo\nthree\nfour\n');
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(200);
    expect(upstreamRevertCalls).toBe(1);
    expect(await fs.readFile(path.join(repoDirectory, 'same.txt'), 'utf8')).toBe('one\ntwo\nthree\nsession-b\nfour\n');
  });

  it('does not resurrect an absent file from another session snapshot', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await commitAll(repoDirectory);

    snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-snapshot-root-'));
    const projectID = 'project-a';
    const snapshotHash = await createOpenCodeSnapshotRepoWithFiles(
      repoDirectory,
      snapshotRoot,
      projectID,
      {
        'file-a.txt': 'base\nsession-a\n',
        'file-b.txt': 'session-b\n',
      },
    );

    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID', (_req, res) => {
      res.json({ id: 'session-a', projectID });
    });
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
        {
          info: {
            id: 'msg-assistant',
            sessionID: 'session-a',
            role: 'assistant',
            time: { created: 2, completed: 3 },
            parentID: 'msg-target',
          },
          parts: [
            {
              id: 'part-patch',
              sessionID: 'session-a',
              messageID: 'msg-assistant',
              type: 'patch',
              hash: snapshotHash,
              files: [path.join(repoDirectory, 'file-a.txt')],
            },
          ],
        },
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
      await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'session-b\n');
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port, { openCodeSnapshotRoot: snapshotRoot }));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(200);
    expect(upstreamRevertCalls).toBe(1);
    expect(await fs.readFile(path.join(repoDirectory, 'file-a.txt'), 'utf8')).toBe('base\n');
    await expect(fs.access(path.join(repoDirectory, 'file-b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('moves an existing revert boundary earlier without replaying already reverted diffs', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await commitAll(repoDirectory);

    snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-snapshot-root-'));
    const projectID = 'project-a';
    const snapshotHash = await createOpenCodeSnapshotRepoWithFiles(
      repoDirectory,
      snapshotRoot,
      projectID,
      {
        'file-a.txt': 'base\ncheckpoint\nafter\n',
        'file-b.txt': 'session-b\n',
      },
    );

    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\ncheckpoint\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID', (_req, res) => {
      res.json({
        id: 'session-a',
        projectID,
        revert: { messageID: 'msg-later', snapshot: snapshotHash },
      });
    });
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'checkpoint'),
          additions: 1,
          deletions: 0,
        }),
        userMessageWithDiff('msg-later', {
          file: 'file-a.txt',
          status: 'modified',
          patch: `diff --git a/file-a.txt b/file-a.txt
--- a/file-a.txt
+++ b/file-a.txt
@@ -1,2 +1,3 @@
 base
 checkpoint
+after
`,
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
      await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'session-b\n');
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port, { openCodeSnapshotRoot: snapshotRoot }));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(200);
    expect(upstreamRevertCalls).toBe(1);
    expect(await fs.readFile(path.join(repoDirectory, 'file-a.txt'), 'utf8')).toBe('base\n');
    await expect(fs.access(path.join(repoDirectory, 'file-b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores aborted patch files from OpenCode snapshots when message diffs are not finalized', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'target.txt'), 'base\n');
    await fs.writeFile(path.join(repoDirectory, 'unrelated.txt'), 'base\n');
    await commitAll(repoDirectory);
    snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-snapshot-root-'));
    const projectID = 'project-a';
    const snapshotHash = await createOpenCodeSnapshotRepo(repoDirectory, snapshotRoot, projectID);

    await fs.writeFile(path.join(repoDirectory, 'target.txt'), 'base\naborted-tool\n');
    await fs.writeFile(path.join(repoDirectory, 'unrelated.txt'), 'base\nunrelated\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID', (_req, res) => {
      res.json({ id: 'session-a', projectID });
    });
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        {
          info: {
            id: 'msg-target',
            sessionID: 'session-a',
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: { providerID: 'test', modelID: 'test' },
            summary: { diffs: [] },
          },
          parts: [],
        },
        {
          info: {
            id: 'msg-assistant',
            sessionID: 'session-a',
            role: 'assistant',
            time: { created: 2, completed: 3 },
            parentID: 'msg-target',
          },
          parts: [
            {
              id: 'part-patch',
              sessionID: 'session-a',
              messageID: 'msg-assistant',
              type: 'patch',
              hash: snapshotHash,
              files: [path.join(repoDirectory, 'target.txt')],
            },
          ],
        },
      ]);
    });
    upstream.post('/session/:sessionID/revert', (_req, res) => {
      upstreamRevertCalls += 1;
      res.json({ id: 'session-a', title: 'session-a', revert: { messageID: 'msg-target' } });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port, { openCodeSnapshotRoot: snapshotRoot }));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(200);
    expect(upstreamRevertCalls).toBe(1);
    expect(await fs.readFile(path.join(repoDirectory, 'target.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(repoDirectory, 'unrelated.txt'), 'utf8')).toBe('base\nunrelated\n');
  });

  it('fails safely when another change edits the same hunk', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'same.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'same.txt'), 'base\nsession-a edited elsewhere\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'same.txt',
          status: 'modified',
          patch: addedLinePatch('same.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', (_req, res) => {
      upstreamRevertCalls += 1;
      res.json({ id: 'session-a' });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(409);
    expect(upstreamRevertCalls).toBe(0);
    expect(await fs.readFile(path.join(repoDirectory, 'same.txt'), 'utf8')).toBe('base\nsession-a edited elsewhere\n');
  });

  it('restores protected files when upstream revert mutates files then fails', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
    await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'base\n');
    await commitAll(repoDirectory);
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');
    await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'base\nsession-b\n');

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: addedLinePatch('file-a.txt', 'base', 'session-a'),
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', async (_req, res) => {
      upstreamRevertCalls += 1;
      await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\n');
      await fs.writeFile(path.join(repoDirectory, 'file-b.txt'), 'base\n');
      res.status(500).json({ error: 'upstream failed after mutation' });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(409);
    expect(upstreamRevertCalls).toBe(1);
    expect(await fs.readFile(path.join(repoDirectory, 'file-a.txt'), 'utf8')).toBe('base\nsession-a\n');
    expect(await fs.readFile(path.join(repoDirectory, 'file-b.txt'), 'utf8')).toBe('base\nsession-b\n');
  });

  it('rejects incomplete diffs before calling the broad upstream revert', async () => {
    repoDirectory = await createTestRepo();
    await fs.writeFile(path.join(repoDirectory, 'file-a.txt'), 'base\nsession-a\n');
    await commitAll(repoDirectory);

    const upstream = express();
    upstream.use(express.json());
    upstream.get('/session/:sessionID/message', (_req, res) => {
      res.json([
        userMessageWithDiff('msg-target', {
          file: 'file-a.txt',
          status: 'modified',
          patch: '',
          additions: 1,
          deletions: 0,
        }),
      ]);
    });
    upstream.post('/session/:sessionID/revert', (_req, res) => {
      upstreamRevertCalls += 1;
      res.json({ id: 'session-a' });
    });
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg-target' }),
    });

    expect(response.status).toBe(409);
    expect(upstreamRevertCalls).toBe(0);
  });

  it('rejects scoped revert requests missing a message id', async () => {
    repoDirectory = await createTestRepo();

    const upstream = express();
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: 'messageID is required' });
  });

  it('rejects malformed scoped revert json bodies', async () => {
    repoDirectory = await createTestRepo();

    const upstream = express();
    upstreamServer = await listen(upstream);

    proxyServer = await listen(createProxyApp(upstreamServer.address().port));
    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session/session-a/scoped-revert?directory=${encodeURIComponent(repoDirectory)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: 'Invalid JSON body' });
  });
});
