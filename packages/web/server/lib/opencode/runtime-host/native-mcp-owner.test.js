import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { createNativeMcpOwner } from './native-mcp-owner.js';

const digest = 'a'.repeat(64), directory = '/owned/native/project';
const fixture = async (run, handler) => {
  const requests = [], cancellations = [];
  let principal = 'caller_a', active = true;
  const server = http.createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const value = await handler?.(req) ?? (req.url === '/api/mcp'
      ? [{ name: 'remote', status: { status: 'needs_auth' }, integrationID: 'int_actual_mcp' }]
      : req.url === '/api/integration/int_actual_mcp'
        ? { id: 'int_actual_mcp', name: 'remote', metadata: { source: 'mcp' }, methods: [{ id: 'oauth_actual', type: 'oauth' }],
          connections: [{ id: 'cred_actual', type: 'credential', method: 'oauth' }] }
        : req.url === '/api/integration/int_actual_mcp/connect/oauth'
          ? { attemptID: 'attempt_actual', mode: 'auto', url: 'http://127.0.0.1/fixture-authorize', time: { created: 1, expires: 1000 } }
          : req.method === 'GET' && req.url === '/api/integration/int_actual_mcp/connect/oauth/attempt_actual'
            ? { status: 'complete', time: { created: 1, expires: 1000 } } : {});
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const owner = createNativeMcpOwner({ reviewedServersByDirectory: new Map([[directory, new Map([
    ['remote', { configurationDigest: digest, disabled: false }], ['disabled', { configurationDigest: digest, disabled: true }],
  ])]]),
  captureCaller: async () => {
    const original = principal;
    return { identityKey: original, reauthorize: async () => { if (!active || original !== principal) throw new Error('fixture_access_revoked'); } };
  },
  withCallerOperation: async (_spec, action) => action(),
  requestNative: async request => (await fetch(new URL(request.path, base), { method: request.method,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body), headers: { 'content-type': 'application/json' } }) })).json(),
  cancelOwnedAttempt: async binding => { cancellations.push(binding.attemptID); },
  });
  try { await run({ owner, requests, cancellations, input: { directory, server: 'remote' },
    switchPrincipal: value => { principal = value; }, revoke: () => { active = false; } }); }
  finally { await owner.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
};

describe('native MCP browser owner', () => {
  it('resolves actual native integration/method and removes only its projected OAuth connection', async () => {
    await fixture(async ({ owner, requests, input }) => {
      const start = await owner.authStart(input);
      expect(start.authorizationUrl).toBe('http://127.0.0.1/fixture-authorize');
      expect((await owner.authStatus({ ...input, attemptID: start.attemptID })).status).toBe('complete');
      await owner.authComplete(input); await owner.authRemove(input); await owner.authCancel(input);
      expect(requests).toContain('DELETE /api/credential/cred_actual');
      expect(requests.some(request => request === 'GET /api/credential')).toBe(false);
      expect(requests).toContain('POST /api/integration/int_actual_mcp/connect/oauth/attempt_actual/complete');
    });
  });
  it('disabled definitions and foreign attempts have no native effect', async () => {
    await fixture(async ({ owner, requests, input, switchPrincipal }) => {
      await expect(owner.connect({ ...input, server: 'disabled' })).rejects.toMatchObject({ code: 'native_mcp_server_unreviewed' });
      expect(requests).toHaveLength(0);
      await owner.authStart(input); const count = requests.length;
      await expect(owner.authComplete({ ...input, attemptID: 'foreign' })).rejects.toMatchObject({ code: 'native_mcp_attempt_owner_mismatch' });
      switchPrincipal('caller_b');
      await expect(owner.authStatus(input)).rejects.toMatchObject({ code: 'native_mcp_attempt_owner_mismatch' });
      expect(requests).toHaveLength(count);
    });
  });
  it('revocation after native attempt creation cancels that exact owned attempt', async () => {
    let revoke;
    await fixture(async ({ owner, input, cancellations, revoke: revokeFixture }) => {
      revoke = revokeFixture;
      await expect(owner.authStart(input)).rejects.toThrow('fixture_access_revoked');
      expect(cancellations).toEqual(['attempt_actual']);
    }, req => { if (req.url.endsWith('/connect/oauth')) revoke(); });
  });
  it('revocation after asynchronous connection projection cannot delete credentials', async () => {
    let revoke;
    await fixture(async ({ owner, input, requests, revoke: revokeFixture }) => {
      revoke = revokeFixture;
      await expect(owner.authRemove(input)).rejects.toThrow('fixture_access_revoked');
      expect(requests.some(request => request.startsWith('DELETE /api/credential/'))).toBe(false);
    }, async req => { if (req.url === '/api/integration/int_actual_mcp') { await Promise.resolve(); revoke(); } });
  });
  it('closing the caller owner invalidates old attempt controls without granting cancellation authority to a new caller', async () => {
    await fixture(async ({ owner, input, requests, cancellations }) => {
      const attempt = await owner.authStart(input); await owner.close();
      const count = requests.length;
      await expect(owner.authComplete({ ...input, attemptID: attempt.attemptID })).rejects.toMatchObject({ code: 'native_mcp_owner_closed' });
      await expect(owner.authCancel(input)).rejects.toMatchObject({ code: 'native_mcp_owner_closed' });
      expect(requests).toHaveLength(count); expect(cancellations).toEqual([attempt.attemptID]);
    });
  });
  it('one pending start per server and close await in-flight creation then dispose its native scope', async () => {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    await fixture(async ({ owner, input, cancellations }) => {
      const first = owner.authStart(input); const failed = expect(first).rejects.toMatchObject({ code: 'native_mcp_owner_closed' });
      await started;
      await expect(owner.authStart(input)).rejects.toMatchObject({ code: 'native_mcp_attempt_in_progress' });
      const closed = owner.close(); release(); await failed; await closed;
      expect(cancellations).toEqual(['attempt_actual']);
    }, async req => { if (req.url.endsWith('/connect/oauth')) { entered(); await barrier; } });
  });
});
