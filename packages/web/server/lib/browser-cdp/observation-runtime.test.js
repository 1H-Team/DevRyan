import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';

import {
  BROWSER_AGENT_LEASES_PATH,
  createBrowserObservationRuntime,
} from './observation-runtime.js';

const developer = (id = 'developer-1') => ({
  id,
  scope: 'managed',
  role: 'developer',
  policy: { browser: true },
});

const record = (overrides = {}) => ({
  leaseId: 'lease-1',
  rootSessionId: 'root-1',
  ownerUserId: 'developer-1',
  opencodeSessionID: 'child-secret',
  directory: '/host/private/repository',
  previewUrl: 'https://preview.example.test/path?token=secret',
  agent: 'Builder',
  lastActivityAt: 100,
  ...overrides,
});

const fixture = (overrides = {}) => {
  let records = [record(), record({ leaseId: 'lease-2', rootSessionId: 'root-2', ownerUserId: 'developer-2' })];
  const changed = vi.fn();
  const audit = vi.fn(async () => {});
  const runtime = createBrowserObservationRuntime({
    getLeaseRecords: () => records,
    ownsSession: async (principal, sessionId) => records.some((entry) => (
      entry.rootSessionId === sessionId && entry.ownerUserId === principal.id
    )),
    getHostLeaseMetadata: async () => ({
      leases: [{
        leaseId: 'lease-1',
        title: 'Current preview',
        hostname: 'current.example.test',
        clientAttached: true,
        lastActivityAt: 200,
      }],
    }),
    openHostLeaseStream: async () => ({
      contentType: 'multipart/x-mixed-replace; boundary=test-frame',
      body: (async function* stream() {
        yield Buffer.from('--test-frame\r\nContent-Type: image/jpeg\r\n\r\nframe\r\n');
      })(),
    }),
    onPrincipalChanged: changed,
    audit,
    ...overrides,
  });
  return {
    runtime,
    changed,
    audit,
    setRecords: (next) => { records = next; },
  };
};

describe('managed agent-browser observation runtime', () => {
  test('returns only the owner-safe projection and never exposes host or capability fields', async () => {
    const { runtime } = fixture();
    const snapshot = await runtime.list(developer());

    expect(snapshot.leases).toEqual([{
      leaseId: 'lease-1',
      rootSessionId: 'root-1',
      agent: 'Builder',
      title: 'Current preview',
      hostname: 'current.example.test',
      lastActivityAt: 200,
      clientAttached: true,
    }]);
    expect(JSON.stringify(snapshot)).not.toContain('/host/private');
    expect(JSON.stringify(snapshot)).not.toContain('child-secret');
    expect(JSON.stringify(snapshot)).not.toContain('token=secret');
  });

  test('has no cross-user or administrator bypass', async () => {
    const { runtime } = fixture();
    await expect(runtime.startView(developer('developer-2'), 'lease-1')).rejects.toMatchObject({
      code: 'browser_lease_not_found',
      statusCode: 404,
    });
    await expect(runtime.startView({
      ...developer('administrator-1'),
      role: 'admin',
    }, 'lease-1')).rejects.toMatchObject({ code: 'browser_lease_not_found' });
    await expect(runtime.list({ ...developer(), policy: { browser: false } })).rejects.toMatchObject({
      code: 'browser_observation_forbidden',
      statusCode: 403,
    });
  });

  test('uses one-time viewer sessions and cleans them after streaming', async () => {
    const { runtime, audit } = fixture();
    const started = await runtime.startView(developer(), 'lease-1');
    expect(runtime.getViewCount()).toBe(1);

    class Response extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      headers = new Map();
      chunks = [];
      statusCode = 0;
      status(value) { this.statusCode = value; return this; }
      setHeader(key, value) { this.headers.set(key.toLowerCase(), value); }
      flushHeaders() {}
      write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
      end() { this.writableEnded = true; }
    }
    const response = new Response();
    await runtime.openView(developer(), 'lease-1', started.view.id, response);

    expect(response.statusCode).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.concat(response.chunks).toString()).toContain('frame');
    expect(runtime.getViewCount()).toBe(0);
    await expect(runtime.openView(developer(), 'lease-1', started.view.id, new Response())).rejects.toMatchObject({
      code: 'browser_view_not_found',
    });
    expect(audit).toHaveBeenCalledWith(developer(), 'browser.agent_view.start', expect.any(Object));
    expect(audit).toHaveBeenCalledWith(developer(), 'browser.agent_view.stop', expect.any(Object));
  });

  test('replaces duplicate views, aborts closed leases, and emits owner-filtered revisions', async () => {
    const { runtime, changed, setRecords } = fixture();
    const first = await runtime.startView(developer(), 'lease-1');
    const second = await runtime.startView(developer(), 'lease-1');
    expect(first.view.id).not.toBe(second.view.id);
    expect(runtime.getViewCount()).toBe(1);

    setRecords([]);
    expect(runtime.handleLeaseChanged({ leaseId: 'lease-1', ownerUserId: 'developer-1' })).toBe(1);
    expect(runtime.getViewCount()).toBe(0);
    expect(changed).toHaveBeenCalledWith('developer-1', 1);
  });

  test('registers only the authenticated public observation contract', () => {
    const { runtime } = fixture();
    const routes = [];
    const app = {
      get: (path) => routes.push(['GET', path]),
      post: (path) => routes.push(['POST', path]),
      delete: (path) => routes.push(['DELETE', path]),
    };
    runtime.registerRoutes(app);
    expect(routes).toEqual([
      ['GET', BROWSER_AGENT_LEASES_PATH],
      ['POST', `${BROWSER_AGENT_LEASES_PATH}/:leaseId/views`],
      ['GET', `${BROWSER_AGENT_LEASES_PATH}/:leaseId/views/:viewId/stream`],
      ['DELETE', `${BROWSER_AGENT_LEASES_PATH}/:leaseId/views/:viewId`],
    ]);
  });
});
