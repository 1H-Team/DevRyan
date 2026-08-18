import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProjectPreviewInstancesRuntime,
  normalizeProjectPreviewUrl,
} from './project-instances-runtime.js';

const projectDirectory = fileURLToPath(new URL('../../../../../', import.meta.url));

const principal = (id, projectId = 'project-1', directory = projectDirectory) => ({
  id,
  role: 'developer',
  scope: 'managed',
  assignments: [{
    projectId,
    repositoryPath: directory,
    publicDirectory: directory,
    worktreeContainerPath: path.join(directory, '.worktrees'),
  }],
});

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return body;
  },
});

const runtimes = [];

const createRuntime = ({
  reachable = true,
  probeUrl = async () => reachable,
  now,
  grantTtlMs,
  resolveManagedProjectForDirectory,
} = {}) => {
  const sessions = new Map();
  const touchSession = vi.fn((sessionId, ownerUserId) => (
    sessions.get(sessionId)?.ownerUserId === ownerUserId
  ));
  const runtime = createProjectPreviewInstancesRuntime({
    crypto,
    fs,
    path,
    probeUrl,
    ...(now ? { now } : {}),
    ...(grantTtlMs ? { grantTtlMs } : {}),
    ...(resolveManagedProjectForDirectory ? { resolveManagedProjectForDirectory } : {}),
    getTerminalRuntime: () => ({
      getSessionDescriptor: (sessionId) => sessions.get(sessionId) ?? null,
      touchSession,
    }),
  });
  runtimes.push(runtime);
  return { runtime, sessions, touchSession };
};

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
});

describe('project preview URL normalization', () => {
  it('accepts loopback HTTP targets while retaining the user-facing path', () => {
    expect(normalizeProjectPreviewUrl('http://localhost:4173/docs?tab=1#intro')).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:4173',
      url: 'http://127.0.0.1:4173/docs?tab=1#intro',
      port: '4173',
    });
  });

  it('rejects public targets and embedded credentials', () => {
    expect(normalizeProjectPreviewUrl('https://example.com').ok).toBe(false);
    expect(normalizeProjectPreviewUrl('http://user:secret@localhost:3000').ok).toBe(false);
  });
});

describe('project preview grants', () => {
  it('requires a terminal owned by the caller in the exact canonical directory', async () => {
    const { runtime, sessions } = createRuntime();
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });

    const wrongOwner = await runtime.register({
      principal: principal('other'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });
    expect(wrongOwner).toMatchObject({ ok: false, status: 404 });

    const wrongDirectory = await runtime.register({
      principal: principal('owner'),
      directory: path.join(projectDirectory, 'packages', 'web'),
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });
    expect(wrongDirectory).toMatchObject({ ok: false, status: 403 });

    const registered = await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173/docs',
      label: 'Fixture app',
    });
    expect(registered.ok).toBe(true);
    expect(runtime.getSnapshot()).toHaveLength(1);
  });

  it('renews the source terminal when a reachable preview registers and refreshes', async () => {
    const { runtime, sessions, touchSession } = createRuntime();
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });

    const registered = await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });
    expect(registered.ok).toBe(true);
    expect(touchSession).toHaveBeenLastCalledWith('terminal-1', 'owner');

    touchSession.mockClear();
    const listed = await runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    expect(listed.instances).toHaveLength(1);
    expect(touchSession).toHaveBeenCalledOnce();
    expect(touchSession).toHaveBeenLastCalledWith('terminal-1', 'owner');
  });

  it('shares live grants inside one project but not across project identities', async () => {
    const { runtime, sessions } = createRuntime();
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });

    const shared = await runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    expect(shared.ok).toBe(true);
    expect(shared.instances).toHaveLength(1);
    expect(shared.instances[0]).not.toHaveProperty('terminalSessionId');
    expect(shared.instances[0]).not.toHaveProperty('directory');

    const isolated = await runtime.list({
      principal: principal('outsider', 'project-2'),
      directory: projectDirectory,
    });
    expect(isolated).toMatchObject({ ok: true, instances: [] });
  });

  it('denies managed users whose assignment does not include the directory', async () => {
    const { runtime } = createRuntime();
    const result = await runtime.list({
      principal: { ...principal('unassigned'), assignments: [] },
      directory: projectDirectory,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: 'Directory is outside your assigned workspace',
    });
  });

  it('removes grants and their targets when the source terminal closes', async () => {
    const { runtime, sessions } = createRuntime();
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    const removed = [];
    runtime.setGrantRemovalHandler((grant) => removed.push(grant));
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });

    runtime.handleTerminalSessionClosed({ sessionId: 'terminal-1' });
    expect(runtime.getSnapshot()).toEqual([]);
    expect(removed).toHaveLength(1);
    expect(removed[0].reason).toBe('terminal-closed');
  });

  it('rejects unreachable registrations', async () => {
    const { runtime, sessions, touchSession } = createRuntime({ reachable: false });
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    const result = await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(runtime.getSnapshot()).toEqual([]);
    expect(touchSession).not.toHaveBeenCalled();
  });

  it('removes an existing grant after a failed liveness check', async () => {
    let reachable = true;
    const { runtime, sessions } = createRuntime({ probeUrl: async () => reachable });
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });
    reachable = false;
    const result = await runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    expect(result).toMatchObject({ ok: true, instances: [] });
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('removes a grant when its source terminal descriptor disappears', async () => {
    const { runtime, sessions } = createRuntime();
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });
    sessions.delete('terminal-1');

    const result = await runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    expect(result).toMatchObject({ ok: true, instances: [] });
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('removes a grant when terminal renewal loses a race with closure', async () => {
    const { runtime, sessions, touchSession } = createRuntime();
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    const removed = [];
    runtime.setGrantRemovalHandler((grant) => removed.push(grant));
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });

    touchSession.mockReturnValue(false);
    const result = await runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    expect(result).toMatchObject({ ok: true, instances: [] });
    expect(runtime.getSnapshot()).toEqual([]);
    expect(removed.at(-1)?.reason).toBe('terminal-closed');
  });

  it('coalesces concurrent project reads onto one liveness refresh', async () => {
    let probeCalls = 0;
    let releaseProbe = () => {};
    const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    let markProbeStarted = () => {};
    const probeStarted = new Promise((resolve) => { markProbeStarted = resolve; });
    const { runtime, sessions } = createRuntime({
      probeUrl: async () => {
        probeCalls += 1;
        if (probeCalls > 1) {
          markProbeStarted();
          await probeGate;
        }
        return true;
      },
    });
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });

    const first = runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    const second = runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    await probeStarted;
    expect(probeCalls).toBe(2);
    releaseProbe();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.instances).toHaveLength(1);
    expect(secondResult.instances).toHaveLength(1);
    expect(probeCalls).toBe(2);
  });

  it('renews an expired lease while its source terminal and app remain live', async () => {
    let clock = 1_000;
    const { runtime, sessions } = createRuntime({
      now: () => clock,
      grantTtlMs: 15_000,
    });
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });

    clock += 15_001;
    const result = await runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    expect(result.ok).toBe(true);
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0].expiresAt).toBe(clock + 15_000);
  });

  it('maps an unassigned administrator grant to the registered project', async () => {
    const { runtime, sessions } = createRuntime({
      resolveManagedProjectForDirectory: async () => ({ id: 'project-1' }),
    });
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'admin-owner',
    });
    const admin = {
      id: 'admin-owner',
      role: 'admin',
      scope: 'managed',
      assignments: [],
    };
    const registered = await runtime.register({
      principal: admin,
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });
    expect(registered.ok).toBe(true);
    expect(registered.grant.projectKey).toBe('project:project-1');

    const shared = await runtime.list({ principal: principal('viewer'), directory: projectDirectory });
    expect(shared.ok).toBe(true);
    expect(shared.instances).toHaveLength(1);
  });

  it('returns a stable code and actionable guidance for unapproved remote ports', async () => {
    const { runtime } = createRuntime();
    const result = await runtime.authorizeTarget({
      principal: principal('viewer'),
      directory: projectDirectory,
      url: 'http://localhost:4173',
    });
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: 'project_preview_not_approved',
    });
    expect(result.error).toContain('live DevRyan terminal');
  });

  it('removes every grant owned by a revoked user', async () => {
    const { runtime, sessions } = createRuntime();
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });

    runtime.revokeOwner('owner');
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('enforces CSRF on registration routes', async () => {
    const { runtime } = createRuntime();
    const routes = new Map();
    runtime.attach({
      post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
      get(route, handler) { routes.set(`GET ${route}`, handler); },
    }, {
      express: { json: () => (_req, _res, next) => next() },
      uiAuthController: { enabled: false },
      isRequestOriginAllowed: async () => true,
    });
    const response = createResponse();
    await routes.get('POST /api/preview/instances/register')({
      principal: principal('owner'),
      body: {},
      headers: {},
      get: () => undefined,
    }, response);
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'Missing CSRF request header' });
  });

  it('allows authenticated GET polling without an Origin header', async () => {
    const { runtime, sessions } = createRuntime();
    sessions.set('terminal-1', {
      sessionId: 'terminal-1',
      cwd: projectDirectory,
      ownerUserId: 'owner',
    });
    await runtime.register({
      principal: principal('owner'),
      directory: projectDirectory,
      terminalSessionId: 'terminal-1',
      url: 'http://localhost:4173',
    });

    const routes = new Map();
    let originChecks = 0;
    runtime.attach({
      post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
      get(route, handler) { routes.set(`GET ${route}`, handler); },
    }, {
      express: { json: () => (_req, _res, next) => next() },
      uiAuthController: { enabled: true, ensureSessionToken: async () => 'session' },
      isRequestOriginAllowed: async () => {
        originChecks += 1;
        return false;
      },
    });
    const response = createResponse();
    await routes.get('GET /api/preview/instances')({
      principal: principal('viewer'),
      query: { directory: projectDirectory },
      headers: {},
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.instances).toHaveLength(1);
    expect(originChecks).toBe(0);
  });

  it('gates only Browser grant routes on the effective Browser capability', async () => {
    const { runtime } = createRuntime();
    const routes = new Map();
    runtime.attach({
      post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
      get(route, handler) { routes.set(`GET ${route}`, handler); },
    }, {
      express: { json: () => (_req, _res, next) => next() },
      uiAuthController: { enabled: false },
      isRequestOriginAllowed: async () => true,
      canUseBrowser: () => false,
    });

    const browserResponse = createResponse();
    await routes.get('GET /api/browser/instances')({
      principal: principal('viewer'),
      query: { directory: projectDirectory },
      headers: {},
    }, browserResponse);
    expect(browserResponse.statusCode).toBe(403);
    expect(browserResponse.body).toEqual({ error: 'Browser access is disabled' });

    const previewResponse = createResponse();
    await routes.get('GET /api/preview/instances')({
      principal: principal('viewer'),
      query: { directory: projectDirectory },
      headers: {},
    }, previewResponse);
    expect(previewResponse.statusCode).toBe(200);
  });
});
