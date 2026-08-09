import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodePty from 'node-pty';

import { createTerminalRuntime } from './runtime.js';

const mockPtyProcess = {
  pid: 12345,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPtyProcess),
}));

function createRuntime(server, options = {}) {
  const routes = {
    post: new Map(),
    get: new Map(),
    delete: new Map(),
  };

  const app = {
    use() {},
    post(route, ...handlers) {
      routes.post.set(route, handlers);
    },
    get(route, ...handlers) {
      routes.get.set(route, handlers);
    },
    delete(route, ...handlers) {
      routes.delete.set(route, handlers);
    },
  };

  const runtime = createTerminalRuntime({
    app,
    server,
    express: { text: () => (_req, _res, next) => next?.() },
    fs,
    path,
    uiAuthController: null,
    buildAugmentedPath: () => process.env.PATH || '',
    searchPathFor: () => null,
    isExecutable: options.isExecutable ?? (() => false),
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {},
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1_000,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3,
    multiUserRuntime: options.multiUserRuntime,
    onTerminalSessionClosed: options.onTerminalSessionClosed,
  });

  return { runtime, routes };
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function callRoute(routes, method, route, req) {
  const handlers = routes[method].get(route);
  expect(handlers).toBeTruthy();
  const handler = handlers.at(-1);
  const res = createMockResponse();
  await handler(req, res);
  return res;
}

describe('terminal runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes its websocket upgrade listener on shutdown', async () => {
    const server = new EventEmitter();
    const { runtime } = createRuntime(server);

    expect(server.listenerCount('upgrade')).toBe(1);

    await runtime.shutdown();

    expect(server.listenerCount('upgrade')).toBe(0);
  });

  it('returns 404 when touching a missing terminal session', async () => {
    const server = new EventEmitter();
    const { runtime, routes } = createRuntime(server);

    const res = await callRoute(routes, 'post', '/api/terminal/:sessionId/touch', {
      params: { sessionId: 'missing-session' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Terminal session not found' });

    await runtime.shutdown();
  });

  it('touches an existing terminal session and returns the updated activity timestamp', async () => {
    const server = new EventEmitter();
    const { runtime, routes } = createRuntime(server, {
      isExecutable: (candidate) => candidate === '/bin/sh',
    });

    const createRes = await callRoute(routes, 'post', '/api/terminal/create', {
      body: { cwd: process.cwd(), cols: 80, rows: 24 },
    });

    expect(createRes.statusCode).toBe(200);
    const sessionId = createRes.body.sessionId;
    const beforeTouch = Date.now();

    const touchRes = await callRoute(routes, 'post', '/api/terminal/:sessionId/touch', {
      params: { sessionId },
    });

    expect(touchRes.statusCode).toBe(200);
    expect(touchRes.body.success).toBe(true);
    expect(touchRes.body.lastActivity).toBeGreaterThanOrEqual(beforeTouch);

    await runtime.shutdown();
  });

  it('builds managed terminal environments from an allowlist with no server secrets', async () => {
    const server = new EventEmitter();
    const originalValues = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      OPENCODE_JWT_SECRET: process.env.OPENCODE_JWT_SECRET,
      OPENCHAMBER_UI_PASSWORD: process.env.OPENCHAMBER_UI_PASSWORD,
      DEVRYAN_ORCHESTRATION_TOKEN: process.env.DEVRYAN_ORCHESTRATION_TOKEN,
      OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    };
    process.env.OPENAI_API_KEY = 'openai-secret-test';
    process.env.CURSOR_API_KEY = 'cursor-secret-test';
    process.env.OPENCODE_JWT_SECRET = 'jwt-secret-test';
    process.env.OPENCHAMBER_UI_PASSWORD = 'ui-password-test';
    process.env.DEVRYAN_ORCHESTRATION_TOKEN = 'orchestration-secret-test';
    process.env.OPENCODE_SERVER_PASSWORD = 'opencode-server-password-test';
    process.env.SUPABASE_SECRET_KEY = 'supabase-secret-test';
    const { runtime, routes } = createRuntime(server, {
      isExecutable: (candidate) => candidate === '/bin/sh',
    });

    try {
      const response = await callRoute(routes, 'post', '/api/terminal/create', {
        principal: { id: 'developer', scope: 'managed' },
        body: { cwd: process.cwd(), cols: 80, rows: 24 },
      });

      expect(response.statusCode).toBe(200);
      const spawnedEnv = vi.mocked(nodePty.spawn).mock.calls.at(-1)[2].env;
      expect(spawnedEnv.PATH).toBeTruthy();
      expect(spawnedEnv.HOME).toBe(process.env.HOME);
      for (const key of Object.keys(originalValues)) expect(spawnedEnv[key]).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(originalValues)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await runtime.shutdown();
    }
  });

  it('adds only the assigned project public environment on create and reloads it on restart', async () => {
    const server = new EventEmitter();
    const repositoryPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devryan-terminal-project-'));
    const worktreePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devryan-terminal-worktree-'));
    await Promise.all([
      fs.promises.writeFile(path.join(repositoryPath, '.env'), [
        'VITE_SUPABASE_URL=https://base.supabase.test',
        'SUPABASE_URL=https://compat.supabase.test',
        'SUPABASE_SECRET_KEY=server-secret',
      ].join('\n')),
      fs.promises.writeFile(path.join(repositoryPath, '.env.development.local'), [
        'VITE_SUPABASE_URL=https://development.supabase.test',
        'VITE_SUPABASE_PUBLISHABLE_KEY=publishable-test-key',
        'VITE_SUPABASE_SERVICE_ROLE_KEY=server-secret-too',
      ].join('\n')),
    ]);
    const resolveManagedProjectForDirectory = vi.fn(async () => ({
      id: 'project-1',
      repository_path: repositoryPath,
    }));
    const { runtime, routes } = createRuntime(server, {
      isExecutable: (candidate) => candidate === '/bin/sh',
      multiUserRuntime: { resolveManagedProjectForDirectory },
    });
    const principal = {
      id: 'developer',
      role: 'developer',
      scope: 'managed',
      assignments: [{ projectId: 'project-1', repositoryPath }],
    };

    try {
      const createResponse = await callRoute(routes, 'post', '/api/terminal/create', {
        principal,
        body: { cwd: worktreePath, cols: 80, rows: 24 },
      });

      expect(createResponse.statusCode).toBe(200);
      const createdEnvironment = vi.mocked(nodePty.spawn).mock.calls.at(-1)[2].env;
      expect(createdEnvironment).toMatchObject({
        VITE_SUPABASE_URL: 'https://development.supabase.test',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key',
        SUPABASE_URL: 'https://compat.supabase.test',
      });
      expect(createdEnvironment.SUPABASE_SECRET_KEY).toBeUndefined();
      expect(createdEnvironment.VITE_SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();

      await fs.promises.writeFile(
        path.join(repositoryPath, '.env.development.local'),
        'VITE_SUPABASE_URL=https://restarted.supabase.test\nVITE_SUPABASE_ANON_KEY=anon-test-key\n',
      );
      const restartResponse = await callRoute(routes, 'post', '/api/terminal/:sessionId/restart', {
        principal,
        params: { sessionId: createResponse.body.sessionId },
        body: { cwd: worktreePath, cols: 100, rows: 30 },
      });

      expect(restartResponse.statusCode).toBe(200);
      const restartedEnvironment = vi.mocked(nodePty.spawn).mock.calls.at(-1)[2].env;
      expect(restartedEnvironment.VITE_SUPABASE_URL).toBe('https://restarted.supabase.test');
      expect(restartedEnvironment.VITE_SUPABASE_ANON_KEY).toBe('anon-test-key');
      expect(resolveManagedProjectForDirectory).toHaveBeenCalledTimes(2);
      expect(resolveManagedProjectForDirectory).toHaveBeenNthCalledWith(1, worktreePath);
      expect(resolveManagedProjectForDirectory).toHaveBeenNthCalledWith(2, worktreePath);
    } finally {
      await runtime.shutdown();
      await Promise.all([
        fs.promises.rm(repositoryPath, { recursive: true, force: true }),
        fs.promises.rm(worktreePath, { recursive: true, force: true }),
      ]);
    }
  });

  it('does not load public environment values from a project missing from the developer assignments', async () => {
    const server = new EventEmitter();
    const repositoryPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devryan-terminal-other-project-'));
    const worktreePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devryan-terminal-other-worktree-'));
    await fs.promises.writeFile(path.join(repositoryPath, '.env'), 'VITE_OTHER_PROJECT=must-not-leak\n');
    const { runtime, routes } = createRuntime(server, {
      isExecutable: (candidate) => candidate === '/bin/sh',
      multiUserRuntime: {
        resolveManagedProjectForDirectory: async () => ({
          id: 'project-2',
          repository_path: repositoryPath,
        }),
      },
    });

    try {
      const response = await callRoute(routes, 'post', '/api/terminal/create', {
        principal: {
          id: 'developer',
          role: 'developer',
          scope: 'managed',
          assignments: [{ projectId: 'project-1', repositoryPath: '/different/project' }],
        },
        body: { cwd: worktreePath, cols: 80, rows: 24 },
      });

      expect(response.statusCode).toBe(200);
      const spawnedEnvironment = vi.mocked(nodePty.spawn).mock.calls.at(-1)[2].env;
      expect(spawnedEnvironment.VITE_OTHER_PROJECT).toBeUndefined();
    } finally {
      await runtime.shutdown();
      await Promise.all([
        fs.promises.rm(repositoryPath, { recursive: true, force: true }),
        fs.promises.rm(worktreePath, { recursive: true, force: true }),
      ]);
    }
  });

  it('keeps the local-admin environment unchanged and skips managed project resolution', async () => {
    const server = new EventEmitter();
    const environmentKey = 'VITE_DEVRYAN_LOCAL_ADMIN_TEST';
    const originalValue = process.env[environmentKey];
    process.env[environmentKey] = 'host-value';
    const resolveManagedProjectForDirectory = vi.fn();
    const { runtime, routes } = createRuntime(server, {
      isExecutable: (candidate) => candidate === '/bin/sh',
      multiUserRuntime: { resolveManagedProjectForDirectory },
    });

    try {
      const response = await callRoute(routes, 'post', '/api/terminal/create', {
        body: { cwd: process.cwd(), cols: 80, rows: 24 },
      });

      expect(response.statusCode).toBe(200);
      const spawnedEnvironment = vi.mocked(nodePty.spawn).mock.calls.at(-1)[2].env;
      expect(spawnedEnvironment[environmentKey]).toBe('host-value');
      expect(resolveManagedProjectForDirectory).not.toHaveBeenCalled();
    } finally {
      if (originalValue === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = originalValue;
      await runtime.shutdown();
    }
  });

  it('kills every PTY owned by a revoked principal without touching another owner', async () => {
    const server = new EventEmitter();
    const setTerminalOwnerTerminator = vi.fn();
    const onTerminalSessionClosed = vi.fn();
    const { runtime, routes } = createRuntime(server, {
      isExecutable: (candidate) => candidate === '/bin/sh',
      multiUserRuntime: { setTerminalOwnerTerminator },
      onTerminalSessionClosed,
    });
    const first = await callRoute(routes, 'post', '/api/terminal/create', {
      principal: { id: 'revoked-user', scope: 'managed' },
      body: { cwd: process.cwd(), cols: 80, rows: 24 },
    });
    const second = await callRoute(routes, 'post', '/api/terminal/create', {
      principal: { id: 'other-user', scope: 'managed' },
      body: { cwd: process.cwd(), cols: 80, rows: 24 },
    });

    expect(setTerminalOwnerTerminator).toHaveBeenCalledWith(runtime.terminateOwnerSessions);
    expect(runtime.getSessionDescriptor(first.body.sessionId)).toMatchObject({
      cwd: process.cwd(),
      ownerUserId: 'revoked-user',
    });
    expect(await runtime.terminateOwnerSessions('revoked-user')).toBe(1);
    expect(onTerminalSessionClosed).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: first.body.sessionId,
      ownerUserId: 'revoked-user',
      reason: 'owner-revoked',
    }));
    expect((await callRoute(routes, 'post', '/api/terminal/:sessionId/touch', {
      params: { sessionId: first.body.sessionId },
    })).statusCode).toBe(404);
    expect((await callRoute(routes, 'post', '/api/terminal/:sessionId/touch', {
      params: { sessionId: second.body.sessionId },
    })).statusCode).toBe(200);

    await runtime.shutdown();
  });
});
