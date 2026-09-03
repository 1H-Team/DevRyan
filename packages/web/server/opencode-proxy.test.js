import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import express from 'express';
import path from 'path';
import { promisify } from 'node:util';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import { createSseBoundaryTracker, registerOpenCodeProxy, writeSseChunkWithBackpressure } from './lib/opencode/proxy.js';
import { registerQuestionRoutes } from './lib/opencode/question-routes.js';
import {
  bindScopedRevertRequestAbort,
  resolveRevertJournalPath,
  reverseApplyUnifiedPatch,
  runScopedSessionRevert,
} from './lib/opencode/session-scoped-revert.js';
import { createTurnTimingRuntime } from './lib/opencode/turn-timing.js';
import { translateDirectoryHeaderValue } from './lib/multi-user/path-translation.js';

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

// Scoped reverts record a redo journal under the data dir; keep test runs out
// of the real ~/.config/openchamber.
const TEST_DATA_DIR = path.join(os.tmpdir(), `openchamber-proxy-test-data-${process.pid}`);

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
    openchamberDataDir: options.openchamberDataDir ?? TEST_DATA_DIR,
    scopedRevertTimeoutMs: options.scopedRevertTimeoutMs,
    ensureOAuthLoopbackPortAvailable: options.ensureOAuthLoopbackPortAvailable,
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

  it('forwards an SDK-shaped question reply after canonicalizing its encoded directory header', async () => {
    const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-question-proxy-'));
    try {
      let upstreamBody = null;
      let upstreamDirectoryHeader = null;
      let upstreamDirectoryQuery = null;
      const upstream = express();
      upstream.use(express.json());
      upstream.post('/question/:requestID/reply', (req, res) => {
        upstreamBody = req.body;
        upstreamDirectoryHeader = req.headers['x-opencode-directory'] ?? null;
        upstreamDirectoryQuery = req.query.directory ?? null;
        res.json(true);
      });
      upstreamServer = await listen(upstream);
      const upstreamPort = upstreamServer.address().port;
      const principal = {
        id: 'developer-1',
        role: 'developer',
        scope: 'managed',
        assignments: [{
          projectId: 'project-1',
          publicDirectory: repositoryPath,
          repositoryPath,
          worktreeContainerPath: path.join(repositoryPath, '.worktrees'),
        }],
      };

      const app = express();
      app.use(async (req, res, next) => {
        const header = req.headers['x-opencode-directory'];
        if (typeof header !== 'string' || !header.trim()) return next();
        const translated = await translateDirectoryHeaderValue(principal, header);
        if (!translated) return res.status(403).json({ error: 'Directory is outside your assigned workspace' });
        req.headers['x-opencode-directory'] = translated;
        return next();
      });
      registerQuestionRoutes(app, {
        cursorSdkRuntime: {
          listPendingQuestions: () => [],
          replyToQuestion: async () => false,
          rejectQuestion: async () => false,
        },
        buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
        getOpenCodeAuthHeaders: () => ({}),
      });
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
        getOpenCodeAuthHeaders: () => ({}),
        buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
        ensureOpenCodeApiPrefix: () => {},
      });
      proxyServer = await listen(app);
      const client = createOpencodeClient({
        baseUrl: `http://127.0.0.1:${proxyServer.address().port}/api`,
        directory: repositoryPath,
      });

      const result = await client.question.reply({
        requestID: 'que_sdk',
        directory: repositoryPath,
        answers: [['Entire web app']],
      });

      expect(result.error).toBeUndefined();
      expect(result.data).toBe(true);
      expect(upstreamBody).toEqual({ answers: [['Entire web app']] });
      expect(upstreamDirectoryHeader).toBe(await fs.realpath(repositoryPath));
      expect(upstreamDirectoryQuery).toBe(repositoryPath);
    } finally {
      await fs.rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it('holds a question reply while OpenCode is not ready and attributes the hold in the slow-request log', async () => {
    let upstreamBody = null;
    const upstream = express();
    upstream.use(express.json());
    upstream.post('/question/:requestID/reply', (req, res) => {
      upstreamBody = req.body;
      res.json(true);
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const runtimeState = {
      openCodePort: upstreamPort,
      isOpenCodeReady: false,
      openCodeNotReadySince: Date.now(),
      isRestartingOpenCode: false,
    };
    const loggedSlowRequests = [];

    const app = express();
    registerQuestionRoutes(app, {
      cursorSdkRuntime: {
        listPendingQuestions: () => [],
        replyToQuestion: async () => false,
        rejectQuestion: async () => false,
      },
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      logger: {
        warn: (message, details) => {
          if (message === '[questions] slow request') loggedSlowRequests.push(details);
        },
        error: () => {},
      },
      slowRequestThresholdMs: 0,
    });
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 5000,
      getRuntime: () => runtimeState,
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    setTimeout(() => {
      runtimeState.isOpenCodeReady = true;
    }, 150);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/question/que_held/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [['Held answer']] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toBe(true);
    expect(upstreamBody).toEqual({ answers: [['Held answer']] });

    await new Promise((resolve) => setImmediate(resolve));
    expect(loggedSlowRequests).toHaveLength(1);
    expect(loggedSlowRequests[0].url).toBe('/api/question/que_held/reply');
    expect(loggedSlowRequests[0].holdMs).toBeGreaterThan(0);
    expect(loggedSlowRequests[0].totalMs).toBeGreaterThanOrEqual(loggedSlowRequests[0].holdMs);
  });
});

describe('OpenAI OAuth loopback preflight', () => {
  let upstreamServer;
  let proxyServer;

  afterEach(async () => {
    await closeServer(proxyServer);
    await closeServer(upstreamServer);
    proxyServer = undefined;
    upstreamServer = undefined;
  });

  const startAuthorizeUpstream = async () => {
    const upstream = express();
    const authorized = [];
    upstream.post('/provider/:providerID/oauth/authorize', (req, res) => {
      authorized.push(req.params.providerID);
      res.json({ url: 'https://auth.example/authorize', method: 'auto' });
    });
    upstreamServer = await listen(upstream);
    return authorized;
  };

  it('blocks the OpenAI flow with an actionable 503 when the loopback port is held', async () => {
    const authorized = await startAuthorizeUpstream();
    proxyServer = await listen(createProxyApp(upstreamServer.address().port, {
      ensureOAuthLoopbackPortAvailable: async () => ({
        ok: false,
        reaped: [],
        message: 'OpenAI browser sign-in needs local port 1455, but another process is already listening on it: PID 4242 (rogue).',
      }),
    }));

    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/provider/openai/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 0 }),
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.code).toBe('oauth_loopback_port_busy');
    // The UI reads `error` for its message, so the human-readable text must live there.
    expect(payload.error).toContain('1455');
    expect(payload.retryable).toBe(true);
    expect(authorized).toEqual([]);
  });

  it('proxies through when the preflight passes', async () => {
    const authorized = await startAuthorizeUpstream();
    proxyServer = await listen(createProxyApp(upstreamServer.address().port, {
      ensureOAuthLoopbackPortAvailable: async () => ({ ok: true, reaped: [] }),
    }));

    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/provider/openai/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 0 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://auth.example/authorize', method: 'auto' });
    expect(authorized).toEqual(['openai']);
  });

  it('never preflights other providers', async () => {
    const authorized = await startAuthorizeUpstream();
    let preflightCalls = 0;
    proxyServer = await listen(createProxyApp(upstreamServer.address().port, {
      ensureOAuthLoopbackPortAvailable: async () => {
        preflightCalls += 1;
        return { ok: false, reaped: [], message: 'should not be consulted' };
      },
    }));

    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/provider/anthropic/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 0 }),
    });

    expect(response.status).toBe(200);
    expect(preflightCalls).toBe(0);
    expect(authorized).toEqual(['anthropic']);
  });

  // A preflight that cannot run must never block a sign-in that might have worked.
  it('falls through when the preflight itself throws', async () => {
    const authorized = await startAuthorizeUpstream();
    proxyServer = await listen(createProxyApp(upstreamServer.address().port, {
      ensureOAuthLoopbackPortAvailable: async () => { throw new Error('lsof exploded'); },
    }));

    const response = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/provider/openai/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 0 }),
    });

    expect(response.status).toBe(200);
    expect(authorized).toEqual(['openai']);
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
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
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
      openchamberDataDir: TEST_DATA_DIR,
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
      openchamberDataDir: TEST_DATA_DIR,
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

describe('OpenCode tree-scoped revert, redo and change summary', () => {
  let upstreamServer;
  let proxyServer;
  let repoDirectory;
  let dataDir;
  let snapshotRoot;

  afterEach(async () => {
    await closeServer(proxyServer);
    await closeServer(upstreamServer);
    if (repoDirectory) await fs.rm(repoDirectory, { recursive: true, force: true });
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
    if (snapshotRoot) await fs.rm(snapshotRoot, { recursive: true, force: true });
    proxyServer = undefined;
    upstreamServer = undefined;
    repoDirectory = undefined;
    dataDir = undefined;
    snapshotRoot = undefined;
  });

  // Fake OpenCode: sessions keyed by id (children resolved through parentID),
  // transcripts keyed by session id, a status map, and native revert/unrevert
  // handlers that update the session's revert marker like OpenCode does.
  const createOpenCodeStub = ({ sessions = {}, messages = {}, statuses = {}, onRevert, onUnrevert } = {}) => {
    const app = express();
    app.use(express.json());
    const calls = { revert: [], unrevert: [] };
    app.get('/session/status', (_req, res) => res.json(statuses));
    app.get('/session/:sessionID', (req, res) => {
      const session = sessions[req.params.sessionID];
      if (!session) return res.status(404).json({ error: 'Session not found' });
      return res.json(session);
    });
    app.get('/session/:sessionID/children', (req, res) => {
      if (!sessions[req.params.sessionID]) return res.status(404).json({ error: 'Session not found' });
      return res.json(Object.values(sessions).filter((session) => session.parentID === req.params.sessionID));
    });
    app.get('/session/:sessionID/message', (req, res) => {
      const records = messages[req.params.sessionID];
      if (!records) return res.status(404).json({ error: 'Session not found' });
      return res.json(records);
    });
    app.post('/session/:sessionID/revert', async (req, res) => {
      const sessionID = req.params.sessionID;
      const messageID = req.body?.messageID;
      calls.revert.push({ sessionID, messageID });
      try {
        if (onRevert) await onRevert(sessionID, messageID);
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
      const session = sessions[sessionID] ?? { id: sessionID };
      session.revert = { messageID };
      return res.json(session);
    });
    app.post('/session/:sessionID/unrevert', async (req, res) => {
      const sessionID = req.params.sessionID;
      calls.unrevert.push(sessionID);
      try {
        if (onUnrevert) await onUnrevert(sessionID);
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
      const session = sessions[sessionID];
      if (!session) return res.status(404).json({ error: 'Session not found' });
      delete session.revert;
      return res.json(session);
    });
    return { app, calls };
  };

  const stubSession = (id, extra = {}) => ({ id, title: id, time: { created: 1, updated: 1 }, ...extra });
  const userMessage = ({ id, sessionID, created, diffs = [] }) => ({
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'test', modelID: 'test' },
      summary: { diffs },
    },
    parts: [],
  });
  const assistantMessage = ({ id, sessionID, created, parts = [] }) => ({
    info: { id, sessionID, role: 'assistant', time: { created, completed: created + 1 } },
    parts,
  });
  const modifiedDiff = (file, beforeLine, addedLine) => ({
    file,
    status: 'modified',
    patch: addedLinePatch(file, beforeLine, addedLine),
    additions: 1,
    deletions: 0,
  });
  const postJson = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const readRepoFile = (file) => fs.readFile(path.join(repoDirectory, file), 'utf8');
  const writeRepoFile = (file, content) => fs.writeFile(path.join(repoDirectory, file), content);

  const startStack = async (stub, options = {}) => {
    upstreamServer = await listen(stub.app);
    proxyServer = await listen(createProxyApp(upstreamServer.address().port, { openchamberDataDir: dataDir, ...options }));
    const base = `http://127.0.0.1:${proxyServer.address().port}/api/openchamber/session`;
    const query = `directory=${encodeURIComponent(repoDirectory)}`;
    return {
      revertUrl: (sessionID) => `${base}/${sessionID}/scoped-revert?${query}`,
      unrevertUrl: (sessionID) => `${base}/${sessionID}/scoped-unrevert?${query}`,
      changesUrl: (sessionID) => `${base}/${sessionID}/changes?${query}`,
    };
  };

  const setupRepo = async (files) => {
    repoDirectory = await createTestRepo();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-revert-journal-'));
    for (const [file, content] of Object.entries(files)) await writeRepoFile(file, content);
    await commitAll(repoDirectory);
  };

  // Root turn aborted (no summary), child finished its own turn: only the
  // child's transcript knows about child.txt.
  const childOnlyScenario = () => ({
    sessions: {
      root: stubSession('root'),
      child: stubSession('child', { parentID: 'root' }),
    },
    messages: {
      root: [userMessage({ id: 'msg-root', sessionID: 'root', created: 10 })],
      child: [userMessage({ id: 'msg-child', sessionID: 'child', created: 20, diffs: [modifiedDiff('child.txt', 'base', 'child')] })],
    },
  });

  it('reverts edits made only by a descendant sub-agent session', async () => {
    await setupRepo({ 'child.txt': 'base\n', 'other.txt': 'base\n' });
    await writeRepoFile('child.txt', 'base\nchild\n');
    await writeRepoFile('other.txt', 'base\nother\n');
    const stub = createOpenCodeStub(childOnlyScenario());
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-root' });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(stub.calls.revert).toEqual([
      { sessionID: 'child', messageID: 'msg-child' },
      { sessionID: 'root', messageID: 'msg-root' },
    ]);
    expect(payload.id).toBe('root');
    expect(payload.session).toEqual(expect.objectContaining({ id: 'root', revert: { messageID: 'msg-root' } }));
    expect(payload.reverted).toEqual({
      files: [{ path: 'child.txt', status: 'restored' }],
      sessions: [
        { id: 'child', targetMessageID: 'msg-child' },
        { id: 'root', targetMessageID: 'msg-root' },
      ],
    });
    expect(payload.verification).toEqual({ ok: true, files: [] });
    expect(payload.redoAvailable).toBe(true);
    expect(await readRepoFile('child.txt')).toBe('base\n');
    expect(await readRepoFile('other.txt')).toBe('base\nother\n');
  });

  it('reverts each descendant from its first message at or after the root target', async () => {
    await setupRepo({ 'a.txt': 'base\n', 'b.txt': 'base\n', 'c.txt': 'base\n', 'd.txt': 'base\n', 'e.txt': 'base\n' });
    await writeRepoFile('a.txt', 'base\nfirst\n');
    await writeRepoFile('b.txt', 'base\nafter\n');
    await writeRepoFile('c.txt', 'base\nbefore\n');
    await writeRepoFile('d.txt', 'base\nstraddle-1\n');
    await writeRepoFile('e.txt', 'base\nstraddle-2\n');
    const stub = createOpenCodeStub({
      sessions: {
        root: stubSession('root'),
        'child-after': stubSession('child-after', { parentID: 'root' }),
        'child-before': stubSession('child-before', { parentID: 'root' }),
        'child-straddle': stubSession('child-straddle', { parentID: 'root' }),
      },
      messages: {
        root: [
          userMessage({ id: 'msg-1', sessionID: 'root', created: 10, diffs: [modifiedDiff('a.txt', 'base', 'first')] }),
          userMessage({ id: 'msg-target', sessionID: 'root', created: 20 }),
        ],
        'child-after': [
          userMessage({ id: 'msg-ca', sessionID: 'child-after', created: 30, diffs: [modifiedDiff('b.txt', 'base', 'after')] }),
        ],
        'child-before': [
          userMessage({ id: 'msg-cb', sessionID: 'child-before', created: 5, diffs: [modifiedDiff('c.txt', 'base', 'before')] }),
        ],
        'child-straddle': [
          userMessage({ id: 'msg-cs1', sessionID: 'child-straddle', created: 15, diffs: [modifiedDiff('d.txt', 'base', 'straddle-1')] }),
          userMessage({ id: 'msg-cs2', sessionID: 'child-straddle', created: 25, diffs: [modifiedDiff('e.txt', 'base', 'straddle-2')] }),
        ],
      },
    });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-target' });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(stub.calls.revert).toEqual([
      { sessionID: 'child-after', messageID: 'msg-ca' },
      { sessionID: 'child-straddle', messageID: 'msg-cs2' },
      { sessionID: 'root', messageID: 'msg-target' },
    ]);
    expect(payload.reverted.files).toEqual([
      { path: 'b.txt', status: 'restored' },
      { path: 'e.txt', status: 'restored' },
    ]);
    expect(await readRepoFile('a.txt')).toBe('base\nfirst\n');
    expect(await readRepoFile('b.txt')).toBe('base\n');
    expect(await readRepoFile('c.txt')).toBe('base\nbefore\n');
    expect(await readRepoFile('d.txt')).toBe('base\nstraddle-1\n');
    expect(await readRepoFile('e.txt')).toBe('base\n');
  });

  it('rolls back completed native reverts and restores files when a later native revert fails', async () => {
    await setupRepo({ 'child.txt': 'base\n', 'other.txt': 'base\n' });
    await writeRepoFile('child.txt', 'base\nchild\n');
    await writeRepoFile('other.txt', 'base\nother\n');
    const stub = createOpenCodeStub({
      ...childOnlyScenario(),
      onRevert: async (sessionID) => {
        if (sessionID === 'child') {
          await writeRepoFile('child.txt', 'base\n');
          return;
        }
        await writeRepoFile('other.txt', 'base\n');
        throw new Error('root revert exploded');
      },
    });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-root' });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual({ error: 'root revert exploded' });
    expect(stub.calls.revert).toEqual([
      { sessionID: 'child', messageID: 'msg-child' },
      { sessionID: 'root', messageID: 'msg-root' },
    ]);
    expect(stub.calls.unrevert).toEqual(['child']);
    expect(await readRepoFile('child.txt')).toBe('base\nchild\n');
    expect(await readRepoFile('other.txt')).toBe('base\nother\n');
    await expect(fs.access(resolveRevertJournalPath({ openchamberDataDir: dataDir, directory: repoDirectory, rootSessionID: 'root' })))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("restores a descendant's aborted tool edits from OpenCode patch snapshots", async () => {
    await setupRepo({ 'target.txt': 'base\n', 'unrelated.txt': 'base\n' });
    snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-snapshot-root-'));
    const projectID = 'project-a';
    const snapshotHash = await createOpenCodeSnapshotRepo(repoDirectory, snapshotRoot, projectID);
    await writeRepoFile('target.txt', 'base\naborted-tool\n');
    await writeRepoFile('unrelated.txt', 'base\nunrelated\n');
    const stub = createOpenCodeStub({
      // Only the root carries the project id; the descendant inherits it.
      sessions: { root: stubSession('root', { projectID }), child: stubSession('child', { parentID: 'root' }) },
      messages: {
        root: [userMessage({ id: 'msg-root', sessionID: 'root', created: 10 })],
        child: [
          userMessage({ id: 'msg-child', sessionID: 'child', created: 20 }),
          assistantMessage({ id: 'msg-child-assistant', sessionID: 'child', created: 21, parts: [
            { id: 'part-patch', sessionID: 'child', messageID: 'msg-child-assistant', type: 'patch', hash: snapshotHash, files: [path.join(repoDirectory, 'target.txt')] },
          ] }),
        ],
      },
    });
    const urls = await startStack(stub, { openCodeSnapshotRoot: snapshotRoot });

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-root' });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.reverted.files).toEqual([{ path: 'target.txt', status: 'restored' }]);
    expect(await readRepoFile('target.txt')).toBe('base\n');
    expect(await readRepoFile('unrelated.txt')).toBe('base\nunrelated\n');
  });

  it('skips the redo journal above 8 MB and reports redoAvailable false', async () => {
    const line = 'x'.repeat(63);
    const big = `${line}\n`.repeat(120_000);
    await setupRepo({ 'big.txt': big });
    await writeRepoFile('big.txt', `${big}session-line\n`);
    const stub = createOpenCodeStub({
      sessions: { root: stubSession('root') },
      messages: {
        root: [userMessage({ id: 'msg-target', sessionID: 'root', created: 1, diffs: [{
          file: 'big.txt',
          status: 'modified',
          patch: `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -120000 +120000,2 @@\n ${line}\n+session-line\n`,
          additions: 1,
          deletions: 0,
        }] })],
      },
    });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-target' });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.reverted.files).toEqual([{ path: 'big.txt', status: 'restored' }]);
    expect(payload.redoAvailable).toBe(false);
    expect(await readRepoFile('big.txt')).toBe(big);
    await expect(fs.access(resolveRevertJournalPath({ openchamberDataDir: dataDir, directory: repoDirectory, rootSessionID: 'root' })))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reverse a hunk twice when the parent turn diff already covers the child edit', async () => {
    await setupRepo({ 'b.txt': 'base\n' });
    await writeRepoFile('b.txt', 'base\nchild-line\n');
    const stub = createOpenCodeStub({
      sessions: { root: stubSession('root'), child: stubSession('child', { parentID: 'root' }) },
      messages: {
        // OpenCode summary diffs are worktree-wide for the turn window, so the
        // parent's diff already contains the synchronous sub-agent's hunk.
        root: [userMessage({ id: 'msg-target', sessionID: 'root', created: 20, diffs: [modifiedDiff('b.txt', 'base', 'child-line')] })],
        child: [userMessage({ id: 'msg-c', sessionID: 'child', created: 30, diffs: [modifiedDiff('b.txt', 'base', 'child-line')] })],
      },
    });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-target' });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.reverted.files).toEqual([{ path: 'b.txt', status: 'restored' }]);
    expect(await readRepoFile('b.txt')).toBe('base\n');
  });

  it('refuses with working_tree_changed when a protected file changes between snapshot and revert', async () => {
    await setupRepo({ 'file-a.txt': 'base\n', 'other.txt': 'base\n' });
    await writeRepoFile('file-a.txt', 'base\nsession-a\n');
    await writeRepoFile('other.txt', 'base\nother\n');
    const stub = createOpenCodeStub({
      sessions: { root: stubSession('root') },
      messages: { root: [userMessage({ id: 'msg-target', sessionID: 'root', created: 1, diffs: [modifiedDiff('file-a.txt', 'base', 'session-a')] })] },
    });
    upstreamServer = await listen(stub.app);

    await expect(runScopedSessionRevert({
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamServer.address().port}${requestPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      directory: repoDirectory,
      sessionID: 'root',
      messageID: 'msg-target',
      openchamberDataDir: dataDir,
      onBeforeUpstreamRevert: () => writeRepoFile('other.txt', 'base\nother\nforeign\n'),
    })).rejects.toMatchObject({ code: 'working_tree_changed', status: 409, files: ['other.txt'] });

    expect(stub.calls.revert).toEqual([]);
    expect(await readRepoFile('file-a.txt')).toBe('base\nsession-a\n');
    expect(await readRepoFile('other.txt')).toBe('base\nother\nforeign\n');
    await expect(fs.access(resolveRevertJournalPath({ openchamberDataDir: dataDir, directory: repoDirectory, rootSessionID: 'root' })))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses with ambiguous_hunk when a shifted hunk matches repeated blocks', async () => {
    const patch = `diff --git a/same.txt b/same.txt
--- a/same.txt
+++ b/same.txt
@@ -1 +1,2 @@
 x
+added
`;
    // Without drift the stated position disambiguates the repeated block.
    expect(reverseApplyUnifiedPatch('x\nadded\nx\nadded\n', patch, 'same.txt')).toBe('x\nx\nadded\n');

    await setupRepo({ 'same.txt': 'x\nx\n' });
    await writeRepoFile('same.txt', 'intro\nx\nadded\nx\nadded\n');
    const stub = createOpenCodeStub({
      sessions: { root: stubSession('root') },
      messages: {
        root: [userMessage({ id: 'msg-target', sessionID: 'root', created: 1, diffs: [{ file: 'same.txt', status: 'modified', patch, additions: 1, deletions: 0 }] })],
      },
    });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-target' });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(expect.objectContaining({ code: 'ambiguous_hunk', file: 'same.txt' }));
    expect(stub.calls.revert).toEqual([]);
    expect(await readRepoFile('same.txt')).toBe('intro\nx\nadded\nx\nadded\n');
  });

  it('undoes session A without touching hunks written by an unrelated session B', async () => {
    await setupRepo({ 'same.txt': 'one\ntwo\nthree\nfour\n' });
    await writeRepoFile('same.txt', 'one\nsession-a\ntwo\nthree\nsession-b\nfour\n');
    const stub = createOpenCodeStub({
      sessions: { 'session-a': stubSession('session-a'), 'session-b': stubSession('session-b') },
      statuses: { 'session-a': { type: 'idle' }, 'session-b': { type: 'idle' } },
      messages: {
        'session-a': [userMessage({ id: 'msg-a', sessionID: 'session-a', created: 1, diffs: [{
          file: 'same.txt',
          status: 'modified',
          patch: 'diff --git a/same.txt b/same.txt\n--- a/same.txt\n+++ b/same.txt\n@@ -1,2 +1,3 @@\n one\n+session-a\n two\n',
          additions: 1,
          deletions: 0,
        }] })],
        'session-b': [userMessage({ id: 'msg-b', sessionID: 'session-b', created: 2, diffs: [{
          file: 'same.txt',
          status: 'modified',
          patch: 'diff --git a/same.txt b/same.txt\n--- a/same.txt\n+++ b/same.txt\n@@ -3,2 +4,3 @@\n three\n+session-b\n four\n',
          additions: 1,
          deletions: 0,
        }] })],
      },
    });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('session-a'), { messageID: 'msg-a' });

    expect(response.status).toBe(200);
    expect(stub.calls.revert).toEqual([{ sessionID: 'session-a', messageID: 'msg-a' }]);
    expect(await readRepoFile('same.txt')).toBe('one\ntwo\nthree\nsession-b\nfour\n');
  });

  it('refuses with directory_busy when another session is working in the directory', async () => {
    await setupRepo({ 'child.txt': 'base\n' });
    await writeRepoFile('child.txt', 'base\nchild\n');
    const stub = createOpenCodeStub({ ...childOnlyScenario(), statuses: { root: { type: 'idle' }, elsewhere: { type: 'busy' } } });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-root' });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(expect.objectContaining({ code: 'directory_busy', sessions: ['elsewhere'] }));
    expect(stub.calls.revert).toEqual([]);
    expect(await readRepoFile('child.txt')).toBe('base\nchild\n');
  });

  it('refuses with session_busy when a session inside the tree is still running', async () => {
    await setupRepo({ 'child.txt': 'base\n' });
    const stub = createOpenCodeStub({ ...childOnlyScenario(), statuses: { child: { type: 'retry', attempt: 1, message: 'rate limited' } } });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-root' });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(expect.objectContaining({ code: 'session_busy', sessions: ['child'] }));
    expect(stub.calls.revert).toEqual([]);
  });

  it('refuses with binary_diff_unsupported before writing when a diff has no text patch', async () => {
    await setupRepo({ 'image.png': 'PNG', 'file-a.txt': 'base\n' });
    await writeRepoFile('image.png', 'PNG2');
    await writeRepoFile('file-a.txt', 'base\nsession-a\n');
    const stub = createOpenCodeStub({
      sessions: { root: stubSession('root') },
      messages: {
        root: [userMessage({ id: 'msg-target', sessionID: 'root', created: 1, diffs: [
          modifiedDiff('file-a.txt', 'base', 'session-a'),
          { file: 'image.png', status: 'modified', additions: 0, deletions: 0 },
        ] })],
      },
    });
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-target' });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(expect.objectContaining({ code: 'binary_diff_unsupported', file: 'image.png' }));
    expect(stub.calls.revert).toEqual([]);
    expect(await readRepoFile('file-a.txt')).toBe('base\nsession-a\n');
    expect(await readRepoFile('image.png')).toBe('PNG2');
  });

  it('merges consecutive reverts into one journal keeping the earliest before', async () => {
    await setupRepo({ 'a.txt': 'base\n' });
    await writeRepoFile('a.txt', 'base\none\ntwo\n');
    const stub = createOpenCodeStub({
      sessions: { root: stubSession('root') },
      messages: {
        root: [
          userMessage({ id: 'msg-1', sessionID: 'root', created: 1, diffs: [modifiedDiff('a.txt', 'base', 'one')] }),
          userMessage({ id: 'msg-2', sessionID: 'root', created: 2, diffs: [{
            file: 'a.txt',
            status: 'modified',
            patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n base\n one\n+two\n',
            additions: 1,
            deletions: 0,
          }] }),
        ],
      },
    });
    const urls = await startStack(stub);
    const journalPath = resolveRevertJournalPath({ openchamberDataDir: dataDir, directory: repoDirectory, rootSessionID: 'root' });

    const first = await postJson(urls.revertUrl('root'), { messageID: 'msg-2' });
    expect(first.status).toBe(200);
    expect(await readRepoFile('a.txt')).toBe('base\none\n');
    const firstJournal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    expect(firstJournal.sessions).toEqual([{ id: 'root', targetMessageID: 'msg-2' }]);
    expect(firstJournal.files).toEqual([expect.objectContaining({
      path: 'a.txt',
      before: Buffer.from('base\none\ntwo\n').toString('base64'),
      after: Buffer.from('base\none\n').toString('base64'),
    })]);

    const second = await postJson(urls.revertUrl('root'), { messageID: 'msg-1' });
    expect(second.status).toBe(200);
    expect(await readRepoFile('a.txt')).toBe('base\n');
    const secondJournal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    expect(secondJournal.createdAt).toBe(firstJournal.createdAt);
    expect(secondJournal.sessions).toEqual([{ id: 'root', targetMessageID: 'msg-1' }]);
    expect(secondJournal.files).toEqual([expect.objectContaining({
      path: 'a.txt',
      before: Buffer.from('base\none\ntwo\n').toString('base64'),
      after: Buffer.from('base\n').toString('base64'),
    })]);
    expect(secondJournal.files[0].beforeHash).toBe(firstJournal.files[0].beforeHash);
    expect(secondJournal.files[0].afterHash).not.toBe(firstJournal.files[0].afterHash);
    expect(stub.calls.revert).toEqual([
      { sessionID: 'root', messageID: 'msg-2' },
      { sessionID: 'root', messageID: 'msg-1' },
    ]);
  });

  it('redoes a tree revert from the journal and protects unrelated files from the native unrevert', async () => {
    await setupRepo({ 'child.txt': 'base\n', 'other.txt': 'base\n' });
    await writeRepoFile('child.txt', 'base\nchild\n');
    await writeRepoFile('other.txt', 'base\nother\n');
    const stub = createOpenCodeStub({
      ...childOnlyScenario(),
      onUnrevert: async (sessionID) => {
        if (sessionID !== 'root') return;
        // OpenCode's unrevert restores the whole worktree snapshot.
        await writeRepoFile('child.txt', 'base\nchild\n');
        await writeRepoFile('other.txt', 'clobbered\n');
      },
    });
    const urls = await startStack(stub);
    const journalPath = resolveRevertJournalPath({ openchamberDataDir: dataDir, directory: repoDirectory, rootSessionID: 'root' });

    const revert = await postJson(urls.revertUrl('root'), { messageID: 'msg-root' });
    expect(revert.status).toBe(200);
    expect(await readRepoFile('child.txt')).toBe('base\n');
    await fs.access(journalPath);

    const response = await postJson(urls.unrevertUrl('root'), {});
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(stub.calls.unrevert).toEqual(['child', 'root']);
    expect(payload.id).toBe('root');
    expect(payload.session.revert).toBeUndefined();
    expect(payload.restored).toEqual([{ path: 'child.txt', status: 'restored' }]);
    expect(payload.sessions).toEqual([{ id: 'child' }, { id: 'root' }]);
    expect(payload.verification).toEqual({ ok: true, files: [] });
    expect(await readRepoFile('child.txt')).toBe('base\nchild\n');
    expect(await readRepoFile('other.txt')).toBe('base\nother\n');
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const again = await postJson(urls.unrevertUrl('root'), {});
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual(expect.objectContaining({ code: 'redo_unavailable' }));
  });

  it('refuses to redo when a journaled file changed since the revert', async () => {
    await setupRepo({ 'child.txt': 'base\n' });
    await writeRepoFile('child.txt', 'base\nchild\n');
    const stub = createOpenCodeStub(childOnlyScenario());
    const urls = await startStack(stub);
    const journalPath = resolveRevertJournalPath({ openchamberDataDir: dataDir, directory: repoDirectory, rootSessionID: 'root' });

    expect((await postJson(urls.revertUrl('root'), { messageID: 'msg-root' })).status).toBe(200);
    await writeRepoFile('child.txt', 'base\nedited after revert\n');

    const response = await postJson(urls.unrevertUrl('root'), {});
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual(expect.objectContaining({ code: 'working_tree_changed', files: ['child.txt'] }));
    expect(stub.calls.unrevert).toEqual([]);
    expect(await readRepoFile('child.txt')).toBe('base\nedited after revert\n');
    await fs.access(journalPath);
  });

  it('summarizes tree changes since the first user message without writing', async () => {
    await setupRepo({ 'a.txt': 'base\n', 'c.txt': 'gone\n' });
    await writeRepoFile('a.txt', 'base\nroot-line\nchild-line\n');
    await writeRepoFile('b.txt', 'new\nfile\nhere\n');
    await fs.rm(path.join(repoDirectory, 'c.txt'));
    const stub = createOpenCodeStub({
      sessions: { root: stubSession('root'), child: stubSession('child', { parentID: 'root' }) },
      messages: {
        root: [
          userMessage({ id: 'msg-1', sessionID: 'root', created: 1, diffs: [
            modifiedDiff('a.txt', 'base', 'root-line'),
            { file: 'b.txt', status: 'added', patch: 'diff --git a/b.txt b/b.txt\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1,3 @@\n+new\n+file\n+here\n', additions: 3, deletions: 0 },
          ] }),
          userMessage({ id: 'msg-2', sessionID: 'root', created: 5 }),
        ],
        child: [
          userMessage({ id: 'msg-c', sessionID: 'child', created: 10, diffs: [
            { file: 'a.txt', status: 'modified', patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n base\n root-line\n+child-line\n', additions: 1, deletions: 0 },
            { file: 'c.txt', status: 'deleted', patch: 'diff --git a/c.txt b/c.txt\n--- a/c.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n', additions: 0, deletions: 1 },
          ] }),
          assistantMessage({ id: 'msg-c-assistant', sessionID: 'child', created: 11, parts: [
            { id: 'part-bash', sessionID: 'child', messageID: 'msg-c-assistant', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'sed -i s/a/b/ a.txt' } } },
          ] }),
        ],
      },
    });
    const urls = await startStack(stub);

    const response = await fetch(urls.changesUrl('root'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      files: [
        { path: 'a.txt', status: 'modified', additions: 2, deletions: 0, sessions: ['root', 'child'] },
        { path: 'b.txt', status: 'added', additions: 3, deletions: 0, sessions: ['root'] },
        { path: 'c.txt', status: 'deleted', additions: 0, deletions: 1, sessions: ['child'] },
      ],
      sessionCount: 2,
      sessions: [
        { id: 'root', targetMessageID: 'msg-1' },
        { id: 'child', targetMessageID: 'msg-c' },
      ],
      hasUnattributedMutations: true,
      firstUserMessageID: 'msg-1',
      rootSessionID: 'root',
    });
    expect(stub.calls.revert).toEqual([]);
    expect(await readRepoFile('a.txt')).toBe('base\nroot-line\nchild-line\n');
    await expect(fs.access(resolveRevertJournalPath({ openchamberDataDir: dataDir, directory: repoDirectory, rootSessionID: 'root' })))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports no unattributed mutations when only file tools ran', async () => {
    await setupRepo({ 'a.txt': 'base\n' });
    await writeRepoFile('a.txt', 'base\nroot-line\n');
    const stub = createOpenCodeStub({
      sessions: { root: stubSession('root') },
      messages: {
        root: [
          userMessage({ id: 'msg-1', sessionID: 'root', created: 1, diffs: [modifiedDiff('a.txt', 'base', 'root-line')] }),
          assistantMessage({ id: 'msg-1-assistant', sessionID: 'root', created: 2, parts: [
            { id: 'part-edit', sessionID: 'root', messageID: 'msg-1-assistant', type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: 'a.txt' } } },
            { id: 'part-bash-failed', sessionID: 'root', messageID: 'msg-1-assistant', type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'false' } } },
          ] }),
        ],
      },
    });
    const urls = await startStack(stub);

    const payload = await (await fetch(urls.changesUrl('root'))).json();

    expect(payload.hasUnattributedMutations).toBe(false);
    expect(payload.files).toEqual([{ path: 'a.txt', status: 'modified', additions: 1, deletions: 0, sessions: ['root'] }]);
  });

  it("keeps single-session behaviour with scope 'session'", async () => {
    await setupRepo({ 'child.txt': 'base\n' });
    await writeRepoFile('child.txt', 'base\nchild\n');
    const stub = createOpenCodeStub(childOnlyScenario());
    const urls = await startStack(stub);

    const response = await postJson(urls.revertUrl('root'), { messageID: 'msg-root', scope: 'session' });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(stub.calls.revert).toEqual([{ sessionID: 'root', messageID: 'msg-root' }]);
    expect(payload.reverted).toEqual({ files: [], sessions: [{ id: 'root', targetMessageID: 'msg-root' }] });
    expect(await readRepoFile('child.txt')).toBe('base\nchild\n');

    const invalid = await postJson(urls.revertUrl('root'), { messageID: 'msg-root', scope: 'everything' });
    expect(invalid.status).toBe(400);
  });
});
