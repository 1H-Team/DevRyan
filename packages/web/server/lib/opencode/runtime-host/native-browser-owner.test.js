import { expect, it, vi } from 'vitest';
import { createBrowserLeaseRuntime } from '../../browser-cdp/lease-runtime.js';
import { createNativeBrowserOwner } from './native-browser-owner.js';

const origin = { kind: 'plugin', id: 'devryan.browser', manifestDigest: 'a'.repeat(64), capabilities: ['process'] };
const invocation = { sessionID: 'ses_child', messageID: 'msg_assistant', callID: 'call_browser', directory: '/owned',
  agent: 'builder', tool: 'devryan_browser', permit: { token: 'original' },
  authorization: { input: { provenance: origin } } };
const scope = { opencodeSessionID: 'ses_child', messageID: 'msg_user', directory: '/owned', agent: 'builder' };
const event = (operation, leaseID) => ({ type: 'browser', id: 'request_1', operation, scope, ...(leaseID ? { leaseID } : {}) });
const fixture = () => {
  let allowed = true, beforeCreate = async () => {}, completed = false;
  const sessions = { ses_child: { id: 'ses_child', directory: '/owned', parentID: 'ses_root' }, ses_root: { id: 'ses_root', directory: '/owned' } };
  const openCodeClient = { generation: () => 2, sessions: {
    get: async id => sessions[id],
    message: async (sessionID, messageID) => messageID === 'msg_assistant' ? {
      info: { id: messageID, sessionID, role: 'assistant', parentID: 'msg_user', agent: 'builder', time: completed ? { completed: 1 } : {} },
      turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' },
      parts: [{ type: 'tool', tool: 'devryan_browser', callID: 'call_browser', state: { status: 'running' } }],
    } : { info: { id: messageID, sessionID, role: 'user' } },
  } };
  const create = vi.fn(async ({ leaseId }) => { await beforeCreate(); return { wsUrl: `ws://127.0.0.1:32145/devtools/page/${leaseId}` }; });
  const release = vi.fn(async () => {});
  const runtime = createBrowserLeaseRuntime({ openCodeClient, createBrowserLease: create, releaseBrowserLease: release,
    touchBrowserLease: async () => ({ clients: 0 }), resolveBrowserLeaseContext: async () => ({ metadata: { previewUrl: 'http://127.0.0.1:1234' } }),
    createLeaseID: () => 'lease_owned' });
  const operation = createNativeBrowserOwner({ origin, openCodeClient, getLeaseRuntime: () => runtime,
    admissionOwner: { recheckExecution: async input => {
      if (input.permit !== invocation.permit || !allowed) throw Object.assign(Error('revoked'), { code: 'revoked' });
    } } });
  return { operation, runtime, create, release, revoke: () => { allowed = false; }, complete: () => { completed = true; },
    beforeCreate: action => { beforeCreate = action; } };
};

it('the actual lease owner reuses the canonical child turn and keeps root lineage', async () => {
  const f = fixture();
  try {
    await expect(f.operation(invocation, event('assert-current'))).resolves.toEqual({ current: true });
    await expect(f.operation(invocation, event('resolve'))).resolves.toEqual({ previewUrl: 'http://127.0.0.1:1234' });
    const lease = await f.operation(invocation, event('acquire'));
    expect(lease).toMatchObject({ leaseId: 'lease_owned', created: true });
    expect(await f.operation(invocation, event('acquire'))).toMatchObject({ leaseId: 'lease_owned', created: false });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls[0][0].metadata).toMatchObject({ rootSessionId: 'ses_root', ...scope });
    await expect(f.operation(invocation, event('touch', lease.leaseId))).resolves.toMatchObject({ touched: true });
    await f.operation(invocation, event('release', lease.leaseId));
    expect(f.runtime.getSnapshot()).toEqual([]);
  } finally { await f.runtime.closeAll(); }
});

it('foreign origins, turns, directories, fields and completed calls never acquire a lease', async () => {
  const f = fixture();
  try {
    for (const changed of [{ messageID: 'msg_foreign' }, { opencodeSessionID: 'ses_root' }, { directory: '/foreign' }, { agent: 'oracle' }]) {
      await expect(f.operation(invocation, { ...event('acquire'), scope: { ...scope, ...changed } })).rejects.toMatchObject({ code: 'native_browser_scope_mismatch' });
    }
    await expect(f.operation(invocation, { ...event('acquire'), url: 'http://foreign' })).rejects.toMatchObject({ code: 'native_browser_operation_invalid' });
    await expect(f.operation({ ...invocation, authorization: { input: { provenance: { ...origin, manifestDigest: 'b'.repeat(64) } } } }, event('acquire')))
      .rejects.toMatchObject({ code: 'native_browser_origin_required' });
    f.complete();
    await expect(f.operation(invocation, event('acquire'))).rejects.toMatchObject({ code: 'native_browser_call_stale' });
    expect(f.create).not.toHaveBeenCalled();
  } finally { await f.runtime.closeAll(); }
});

it('revocation or cancellation during Electron acquisition retires the newly created exact lease', async () => {
  for (const cancellation of [false, true]) {
    const f = fixture(), controller = new AbortController();
    try {
      f.beforeCreate(async () => { if (cancellation) controller.abort(Error('cancelled')); else f.revoke(); });
      await expect(f.operation(invocation, event('acquire'), { signal: controller.signal })).rejects.toThrow(cancellation ? 'cancelled' : 'revoked');
      expect(f.runtime.getSnapshot()).toEqual([]);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.release.mock.calls[0][0]).toMatchObject({ leaseId: 'lease_owned' });
    } finally { await f.runtime.closeAll(); }
  }
});
