import { describe, expect, it, vi } from 'vitest';

import {
  BROWSER_LEASES_PATH,
  BrowserLeaseError,
  createBrowserLeaseRuntime,
} from './lease-runtime.js';

const scope = (overrides = {}) => ({
  opencodeSessionID: 'ses_child',
  messageID: 'msg_turn',
  directory: '/workspace',
  agent: 'builder',
  ...overrides,
});

const createResponse = () => {
  const headers = new Map([['access-control-allow-origin', '*']]);
  return {
    body: null,
    statusCode: 200,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
};

const createRequest = ({
  address = '127.0.0.1',
  token = 'secret-token',
  body = scope(),
  leaseId,
} = {}) => ({
  socket: { remoteAddress: address },
  headers: token === null ? {} : { authorization: `Bearer ${token}` },
  body,
  params: leaseId ? { leaseId } : {},
});

const createRuntime = (overrides = {}) => {
  const sessions = overrides.sessions ?? {
    ses_child: { id: 'ses_child', parentID: 'ses_root' },
    ses_root: { id: 'ses_root' },
  };
  let leaseIndex = 0;
  let fenceIndex = 0;
  const hostClosed = new Map();
  const createBrowserLease = overrides.createBrowserLease ?? vi.fn(async ({ leaseId, onClosed }) => {
    hostClosed.set(leaseId, onClosed);
    return { wsUrl: `ws://127.0.0.1:54321/devtools/page/${leaseId}` };
  });
  const fetchImpl = overrides.fetchImpl ?? vi.fn(async (url) => {
    const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    const session = sessions[id];
    return {
      ok: Boolean(session),
      status: session ? 200 : 404,
      json: async () => session ?? { error: 'missing' },
    };
  });
  const runtime = createBrowserLeaseRuntime({
    getDiscoveryToken: () => 'secret-token',
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic internal' }),
    fetchImpl,
    createLeaseID: overrides.createLeaseID ?? (() => `dvr_lease_${++leaseIndex}`),
    createFence: overrides.createFence ?? (() => `dvr_lease_fence_${++fenceIndex}`),
    createBrowserLease,
    touchBrowserLease: overrides.touchBrowserLease ?? vi.fn(async () => {}),
    releaseBrowserLease: overrides.releaseBrowserLease ?? vi.fn(async () => {}),
    ...overrides.runtime,
  });
  return { runtime, createBrowserLease, fetchImpl, hostClosed };
};

describe('browser lease runtime', () => {
  it('resolves child lineage and reuses exactly one lease for a session turn', async () => {
    const { runtime, createBrowserLease } = createRuntime();

    const first = await runtime.acquire(scope());
    const second = await runtime.acquire(scope());

    expect(first).toMatchObject({ leaseId: 'dvr_lease_1', created: true });
    expect(second).toMatchObject({ leaseId: 'dvr_lease_1', created: false });
    expect(createBrowserLease).toHaveBeenCalledTimes(1);
    expect(createBrowserLease).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: 'dvr_lease_1',
      metadata: {
        rootSessionId: 'ses_root',
        opencodeSessionID: 'ses_child',
        messageID: 'msg_turn',
        directory: '/workspace',
        agent: 'builder',
      },
      onClosed: expect.any(Function),
    }));
    await expect(runtime.acquire(scope({ directory: '/other-workspace' }))).rejects.toMatchObject({
      code: 'browser_lease_scope_mismatch',
      statusCode: 403,
    });
    await expect(runtime.acquire(scope({ agent: 'reviewer' }))).rejects.toMatchObject({
      code: 'browser_lease_scope_mismatch',
      statusCode: 403,
    });
    await expect(runtime.acquire(scope({ agent: ' builder ' }))).resolves.toMatchObject({
      leaseId: first.leaseId,
      created: false,
    });
  });

  it('adds authoritative preview metadata while passing credentials only to the host callback', async () => {
    const resolveBrowserLeaseContext = vi.fn(async () => ({
      metadata: {
        authoritativeOwner: true,
        ownerUserId: 'user-1',
        projectId: 'project-1',
        branchName: 'dev',
        previewUrl: 'https://dev1.1health.ae/',
        previewOrigin: 'https://dev1.1health.ae',
        serviceTokenConfigured: true,
      },
      credential: {
        origin: 'https://dev1.1health.ae',
        clientId: 'client.access',
        clientSecret: 'secret',
      },
    }));
    const { runtime, createBrowserLease } = createRuntime({
      runtime: { resolveBrowserLeaseContext },
    });

    const lease = await runtime.acquire(scope());
    expect(lease).toMatchObject({
      previewUrl: 'https://dev1.1health.ae/',
      serviceTokenConfigured: true,
    });
    expect(resolveBrowserLeaseContext).toHaveBeenCalledWith(expect.objectContaining({
      rootSessionId: 'ses_root',
      directory: '/workspace',
    }));
    expect(createBrowserLease).toHaveBeenCalledWith(expect.objectContaining({
      previewCredential: {
        origin: 'https://dev1.1health.ae',
        clientId: 'client.access',
        clientSecret: 'secret',
      },
      metadata: expect.objectContaining({
        ownerUserId: 'user-1',
        previewUrl: 'https://dev1.1health.ae/',
      }),
    }));
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain('client.access');
    expect(JSON.stringify(runtime.getSnapshot())).not.toContain('secret');
  });

  it('preserves the branch preview authentication failure code', async () => {
    const { runtime } = createRuntime({
      runtime: {
        resolveBrowserLeaseContext: vi.fn(async () => {
          throw Object.assign(new Error('Branch preview service-token authentication failed'), {
            code: 'branch_preview_auth_failed',
            statusCode: 401,
          });
        }),
      },
    });
    await expect(runtime.acquire(scope())).rejects.toMatchObject({
      code: 'branch_preview_auth_failed',
      statusCode: 401,
    });
  });

  it('serializes concurrent acquisition only within the exact reuse key', async () => {
    let releaseCreate;
    const createGate = new Promise((resolve) => { releaseCreate = resolve; });
    const createBrowserLease = vi.fn(async ({ leaseId }) => {
      await createGate;
      return { wsUrl: `ws://127.0.0.1:54321/devtools/page/${leaseId}` };
    });
    const { runtime } = createRuntime({ createBrowserLease });

    const first = runtime.acquire(scope());
    const duplicate = runtime.acquire(scope());
    const sibling = runtime.acquire(scope({ messageID: 'msg_other' }));
    await vi.waitFor(() => expect(createBrowserLease).toHaveBeenCalledTimes(2));
    releaseCreate();

    const results = await Promise.all([first, duplicate, sibling]);
    expect(results.map((result) => result.leaseId)).toEqual([
      'dvr_lease_1',
      'dvr_lease_1',
      'dvr_lease_2',
    ]);
    expect(createBrowserLease).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly for missing or cyclic lineage', async () => {
    const missing = createRuntime({ sessions: {} }).runtime;
    await expect(missing.acquire(scope())).rejects.toMatchObject({
      code: 'lineage_unavailable',
      statusCode: 503,
    });

    const cyclic = createRuntime({
      sessions: {
        ses_child: { id: 'ses_child', parentID: 'ses_parent' },
        ses_parent: { id: 'ses_parent', parentID: 'ses_child' },
      },
    }).runtime;
    await expect(cyclic.acquire(scope())).rejects.toMatchObject({
      code: 'lineage_cycle',
      statusCode: 409,
    });
  });

  it('scopes lineage cache entries by directory', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      const id = decodeURIComponent(parsed.pathname.split('/').at(-1));
      const directory = parsed.searchParams.get('directory');
      const rootID = directory === '/workspace-a' ? 'ses_root_a' : 'ses_root_b';
      const session = id === 'ses_shared'
        ? { id, parentID: rootID }
        : { id: rootID };
      return { ok: true, status: 200, json: async () => session };
    });
    const { runtime } = createRuntime({ fetchImpl });

    await expect(runtime.resolveRootSessionID({
      opencodeSessionID: 'ses_shared',
      directory: '/workspace-a',
    })).resolves.toBe('ses_root_a');
    await expect(runtime.resolveRootSessionID({
      opencodeSessionID: 'ses_shared',
      directory: '/workspace-b',
    })).resolves.toBe('ses_root_b');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('retries transient lineage failures twice but never retries authoritative missing sessions', async () => {
    let attempts = 0;
    const transientFetch = vi.fn(async (url) => {
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      attempts += 1;
      if (id === 'ses_child' && attempts <= 2) {
        return { ok: false, status: 503, json: async () => ({ error: 'starting' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => id === 'ses_child'
          ? { id, parentID: 'ses_root' }
          : { id: 'ses_root' },
      };
    });
    const transient = createRuntime({
      fetchImpl: transientFetch,
      runtime: { lineageRetryDelaysMs: [0, 0] },
    }).runtime;

    await expect(transient.resolveRootSessionID(scope())).resolves.toBe('ses_root');
    expect(transientFetch).toHaveBeenCalledTimes(4);

    const missingFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'missing' }),
    }));
    const missing = createRuntime({
      fetchImpl: missingFetch,
      runtime: { lineageRetryDelaysMs: [0, 0] },
    }).runtime;

    await expect(missing.resolveRootSessionID(scope())).rejects.toMatchObject({
      code: 'lineage_unavailable',
    });
    expect(missingFetch).toHaveBeenCalledTimes(1);
  });

  it('retains resolved lineage until deletion and invalidates the deleted session entry', async () => {
    const { runtime, fetchImpl } = createRuntime();

    await expect(runtime.resolveRootSessionID(scope())).resolves.toBe('ses_root');
    await expect(runtime.resolveRootSessionID(scope())).resolves.toBe('ses_root');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await runtime.processOpenCodeEvent({
      type: 'session.deleted',
      properties: { info: { id: 'ses_child' } },
    });
    await expect(runtime.resolveRootSessionID(scope())).resolves.toBe('ses_root');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('single-flights concurrent lineage fetches across different message reuse keys', async () => {
    let releaseFetch;
    const gate = new Promise((resolve) => { releaseFetch = resolve; });
    const fetchImpl = vi.fn(async (url) => {
      await gate;
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      return {
        ok: true,
        status: 200,
        json: async () => id === 'ses_child'
          ? { id, parentID: 'ses_root' }
          : { id: 'ses_root' },
      };
    });
    const { runtime } = createRuntime({ fetchImpl });
    const first = runtime.acquire(scope({ messageID: 'msg_one' }));
    const second = runtime.acquire(scope({ messageID: 'msg_two' }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releaseFetch();

    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('enforces scope on touch and release while keeping absent release idempotent', async () => {
    const touchBrowserLease = vi.fn(async () => {});
    const releaseBrowserLease = vi.fn(async () => {});
    const { runtime } = createRuntime({ touchBrowserLease, releaseBrowserLease });
    const lease = await runtime.acquire(scope());

    await expect(runtime.touch(lease.leaseId, scope({ messageID: 'wrong' }))).rejects.toMatchObject({
      code: 'browser_lease_scope_mismatch',
      statusCode: 403,
    });
    await expect(runtime.release(lease.leaseId, scope({ directory: '/other' }))).rejects.toMatchObject({
      code: 'browser_lease_scope_mismatch',
      statusCode: 403,
    });
    await expect(runtime.touch(lease.leaseId, scope({ agent: null }))).rejects.toMatchObject({
      code: 'browser_lease_scope_mismatch',
      statusCode: 403,
    });
    await expect(runtime.touch(lease.leaseId, scope())).resolves.toEqual({
      leaseId: lease.leaseId,
      touched: true,
    });
    expect(touchBrowserLease).toHaveBeenCalledWith({
      leaseId: lease.leaseId,
      metadata: expect.objectContaining({ opencodeSessionID: 'ses_child' }),
    });
    await expect(runtime.release(lease.leaseId, scope())).resolves.toEqual({
      leaseId: lease.leaseId,
      released: true,
    });
    await expect(runtime.release(lease.leaseId, scope())).resolves.toEqual({
      leaseId: lease.leaseId,
      released: false,
    });
    expect(releaseBrowserLease).toHaveBeenCalledTimes(1);
  });

  it('removes a fenced server record when the host reports it missing on touch', async () => {
    const { runtime } = createRuntime({
      touchBrowserLease: vi.fn(async () => ({ ok: false, state: 'not_found' })),
    });
    const lease = await runtime.acquire(scope());

    await expect(runtime.touch(lease.leaseId, scope())).rejects.toMatchObject({
      code: 'browser_lease_not_found',
      statusCode: 404,
    });
    expect(runtime.getSnapshot()).toEqual([]);
    await expect(runtime.acquire(scope())).resolves.toMatchObject({
      leaseId: 'dvr_lease_2',
      created: true,
    });
  });

  it('fences stale host callbacks from a replacement lease', async () => {
    const { runtime, hostClosed } = createRuntime();
    const first = await runtime.acquire(scope());
    const firstClosed = hostClosed.get(first.leaseId);
    await runtime.release(first.leaseId, scope());
    const replacement = await runtime.acquire(scope());

    firstClosed('late_close');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.getSnapshot().map((entry) => entry.leaseId)).toEqual([replacement.leaseId]);
  });

  it('cleans only leases owned by the exact OpenCode session lifecycle event', async () => {
    const releaseBrowserLease = vi.fn(async () => {});
    const { runtime } = createRuntime({ releaseBrowserLease });
    await runtime.acquire(scope());
    await runtime.acquire(scope({ opencodeSessionID: 'ses_root', messageID: 'msg_root' }));

    expect(await runtime.processOpenCodeEvent({
      type: 'session.deleted',
      properties: {
        sessionID: 'ses_root',
        info: { id: 'ses_child' },
      },
    })).toBe(1);
    expect(runtime.getSnapshot()).toEqual([
      expect.objectContaining({ opencodeSessionID: 'ses_root' }),
    ]);
    expect(releaseBrowserLease).toHaveBeenCalledWith({
      leaseId: 'dvr_lease_1',
      reason: 'session.deleted',
    });
  });

  it('does not admit an acquisition whose lineage lookup outlives shutdown', async () => {
    let releaseFetch;
    const gate = new Promise((resolve) => { releaseFetch = resolve; });
    const createBrowserLease = vi.fn();
    const fetchImpl = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ id: 'ses_child' }) };
    });
    const { runtime } = createRuntime({ fetchImpl, createBrowserLease });
    const pending = runtime.acquire(scope());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await runtime.closeAll('shutdown');
    releaseFetch();

    await expect(pending).rejects.toMatchObject({ code: 'browser_runtime_stopping' });
    expect(createBrowserLease).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('invalidates and drains lineage acquisition before a managed runtime reset', async () => {
    let releaseFetch;
    let shouldBlock = true;
    const gate = new Promise((resolve) => { releaseFetch = resolve; });
    const createBrowserLease = vi.fn(async ({ leaseId }) => ({
      wsUrl: `ws://127.0.0.1:54321/devtools/page/${leaseId}`,
    }));
    const fetchImpl = vi.fn(async (url) => {
      if (shouldBlock) {
        shouldBlock = false;
        // Deliberately ignore AbortSignal to prove reset drains an operation
        // that was already inside a dependency before admitting the new epoch.
        await gate;
      }
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      return {
        ok: true,
        status: 200,
        json: async () => id === 'ses_child'
          ? { id, parentID: 'ses_root' }
          : { id: 'ses_root' },
      };
    });
    const { runtime } = createRuntime({ fetchImpl, createBrowserLease });

    const staleAcquire = runtime.acquire(scope());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const reset = runtime.pauseForReset('opencode_restart');
    let resetSettled = false;
    void reset.then(() => { resetSettled = true; });
    await Promise.resolve();

    expect(resetSettled).toBe(false);
    await expect(runtime.acquire(scope({ messageID: 'msg_during_restart' }))).rejects.toMatchObject({
      code: 'browser_runtime_resetting',
      statusCode: 503,
    });

    releaseFetch();
    await expect(staleAcquire).rejects.toMatchObject({
      code: 'browser_runtime_resetting',
      statusCode: 503,
    });
    const resetHandle = await reset;
    expect(createBrowserLease).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toEqual([]);

    await expect(runtime.resumeAfterReset(resetHandle)).resolves.toBe(true);
    await expect(runtime.acquire(scope())).resolves.toMatchObject({
      leaseId: 'dvr_lease_1',
      created: true,
    });
  });

  it('returns a typed disabled error before create and before existing-lease reuse', async () => {
    let enabled = true;
    const releaseBrowserLease = vi.fn(async () => {});
    const getBrowserLeaseAvailability = vi.fn(async () => ({
      state: enabled ? 'lease_required' : 'disabled',
    }));
    const { runtime, createBrowserLease } = createRuntime({
      releaseBrowserLease,
      runtime: { getBrowserLeaseAvailability },
    });
    const first = await runtime.acquire(scope());
    enabled = false;

    await expect(runtime.acquire(scope())).rejects.toMatchObject({
      name: 'BrowserLeaseError',
      code: 'agent_browser_disabled',
      message: 'Agent browser control is disabled',
      statusCode: 403,
    });
    expect(createBrowserLease).toHaveBeenCalledTimes(1);
    expect(releaseBrowserLease).toHaveBeenCalledWith({
      leaseId: first.leaseId,
      reason: 'agent_browser_disabled',
    });
    expect(runtime.getSnapshot()).toEqual([]);

    await expect(runtime.acquire(scope({ messageID: 'msg_disabled' }))).rejects.toMatchObject({
      code: 'agent_browser_disabled',
      statusCode: 403,
    });
    expect(createBrowserLease).toHaveBeenCalledTimes(1);
  });

  it('classifies a host disabled race as a deterministic lease error', async () => {
    const disabled = Object.assign(new Error('agent_browser_disabled'), {
      code: 'agent_browser_disabled',
    });
    const runtime = createRuntime({
      createBrowserLease: vi.fn(async () => { throw disabled; }),
    }).runtime;

    await expect(runtime.acquire(scope())).rejects.toMatchObject({
      name: 'BrowserLeaseError',
      code: 'agent_browser_disabled',
      message: 'Agent browser control is disabled',
      statusCode: 403,
    });
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('maps a missing Electron owner window to a distinct typed host error', async () => {
    const unavailable = Object.assign(new Error('browser_lease_window_unavailable'), {
      code: 'browser_lease_window_unavailable',
    });
    const runtime = createRuntime({
      createBrowserLease: vi.fn(async () => { throw unavailable; }),
    }).runtime;

    await expect(runtime.acquire(scope())).rejects.toMatchObject({
      name: 'BrowserLeaseError',
      code: 'browser_owner_context_unavailable',
      message: 'No desktop window currently owns this browser session context',
      statusCode: 503,
    });
  });

  it('releases current leases and holds admission until a managed runtime reset resumes', async () => {
    const releaseBrowserLease = vi.fn(async () => {});
    const { runtime } = createRuntime({ releaseBrowserLease });
    await runtime.acquire(scope());

    const resetHandle = await runtime.pauseForReset('opencode_restart');
    expect(resetHandle.released).toBe(1);
    expect(releaseBrowserLease).toHaveBeenCalledWith({
      leaseId: 'dvr_lease_1',
      reason: 'opencode_restart',
    });
    await expect(runtime.acquire(scope())).rejects.toMatchObject({
      code: 'browser_runtime_resetting',
      statusCode: 503,
    });
    await expect(runtime.resumeAfterReset(resetHandle)).resolves.toBe(true);
    await expect(runtime.acquire(scope())).resolves.toMatchObject({
      leaseId: 'dvr_lease_2',
      created: true,
    });
  });

  it('uses hardened loopback bearer routes and registers the complete contract', async () => {
    const { runtime } = createRuntime();
    const routes = [];
    runtime.attach({
      post(path) { routes.push(['POST', path]); },
      delete(path) { routes.push(['DELETE', path]); },
    });
    expect(routes).toEqual([
      ['POST', BROWSER_LEASES_PATH],
      ['POST', `${BROWSER_LEASES_PATH}/:leaseId/touch`],
      ['DELETE', `${BROWSER_LEASES_PATH}/:leaseId`],
    ]);

    const remote = createResponse();
    await runtime.handleAcquireRequest(createRequest({ address: '192.168.1.10' }), remote);
    expect(remote.statusCode).toBe(404);

    const unauthorized = createResponse();
    await runtime.handleAcquireRequest(createRequest({ token: 'wrong' }), unauthorized);
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.getHeader('cache-control')).toContain('no-store');
    expect(unauthorized.getHeader('access-control-allow-origin')).toBeUndefined();

    const accepted = createResponse();
    await runtime.handleAcquireRequest(createRequest(), accepted);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toMatchObject({ leaseId: 'dvr_lease_1', created: true });
  });

  it('returns typed errors without leaking host failures', async () => {
    const runtime = createRuntime({
      createBrowserLease: vi.fn(async () => {
        throw new Error('secret host detail');
      }),
    }).runtime;
    await expect(runtime.acquire(scope())).rejects.toEqual(expect.objectContaining({
      code: 'browser_host_unavailable',
      message: 'The desktop browser host could not create a lease',
    }));
    expect(runtime.getSnapshot()).toEqual([]);
    expect(new BrowserLeaseError('x', 'y', 418)).toMatchObject({ statusCode: 418 });
  });
});
