import { afterEach, expect, test, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

const mocks = vi.hoisted(() => ({
  runtime: { admitDirect: vi.fn(), finishDirect: vi.fn(), executionReceipt: vi.fn(), reserve: vi.fn(), prepare: vi.fn(),
    begin: vi.fn(), claimLease: vi.fn(), leaseForCall: vi.fn(), finish: vi.fn(), cleanupLease: vi.fn(), drain: vi.fn(),
    assertAdmission: vi.fn(), registerChild: vi.fn(), prewarmView: vi.fn(), cancelUnstartedCall: vi.fn(), cancelLease: vi.fn(), warm: vi.fn() },
  classify: vi.fn(),
  resolveGit: vi.fn(),
  runtimeOptions: null,
}));
vi.mock('./execution-helper-command.js', () => ({ resolveControllerGitCommand: mocks.resolveGit }));
vi.mock('@devryan/harness-runtime', () => ({
  createSessionMutationHost: (options) => { mocks.runtimeOptions = options; return mocks.runtime; },
  createSessionRevertCoordinator: () => ({}),
}));
vi.mock('@devryan/harness-runtime/lib/session-execution.js', () => ({
  verifySessionExecutionLauncher: async () => true, sweepExecutionSocketDirectories: async () => 0,
  prepareSessionExecution: vi.fn(), readSessionExecutionReceipt: vi.fn(), startSessionExecution: vi.fn(), startReadOnlySessionExecution: vi.fn(), runReadOnlySessionExecution: vi.fn(),
}));
vi.mock('@devryan/harness-runtime/lib/execution-host-owner.js', async (importOriginal) => ({
  ...await importOriginal(), createExecutionHostOwner: async () => ({ id: 'owner_fixture', signal: new AbortController().signal,
    assert: () => {}, close: async () => {} }),
}));
vi.mock('@devryan/harness-runtime/lib/session-changes-tools.js', async (importOriginal) => ({
  ...await importOriginal(), classifySessionChangeTool: mocks.classify,
}));
const { classifySessionChangeTool } = await vi.importActual('@devryan/harness-runtime/lib/session-changes-tools.js');
import { createSessionExecutionHost } from './session-execution-host.js';
import { createRequiredCheckObserver } from '../orchestration/required-check-observer.js';
import { executionProgressMeter, executionSignal, withExecutionAdmission, withExecutionMeter } from '@devryan/harness-runtime/lib/execution-admission.js';
import { runReadOnlySessionExecution } from '@devryan/harness-runtime/lib/session-execution.js';

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const directory = process.cwd();
const input = { directory, sessionID: 'ses_test', messageID: 'msg_test', callID: 'call_test',
  tool: 'skill', argsDigest: 'a'.repeat(64), protocol: 3 };
function fixture({ tool = 'skill', sessionID = input.sessionID, ...options } = {}) {
  mocks.resolveGit.mockImplementation(async command => command);
  const recordReceipt = vi.fn();
  const diagnostics = [];
  const host = createSessionExecutionHost({ dataDirectory: path.join(directory, '.cache/unused-host-fixture'),
    getLauncher: () => '/fixture/launcher', recordReceipt, onDiagnostic: (record) => diagnostics.push(record),
    buildOpenCodeUrl: route => `http://127.0.0.1:1${route}`,
    fetchImpl: async url => Response.json(url.pathname.includes('/message/')
      ? { info: { role: 'assistant', sessionID, parentID: 'msg_user' }, parts: [{ type: 'tool', callID: input.callID, tool }] }
      : { id: input.sessionID, directory }),
    ...options,
  });
  mocks.classify.mockImplementation(classifySessionChangeTool);
  mocks.runtime.admitDirect.mockResolvedValue({ generation: 7 });
  mocks.runtime.finishDirect.mockResolvedValue({ files: [] });
  mocks.runtime.executionReceipt.mockResolvedValue({ files: [], source: 'confined-execution' });
  return { host, recordReceipt, diagnostics };
}

test('native execution errors preserve direct and private HTTP status contracts', async () => {
  const { host } = fixture();
  await expect(host.nativeExecution({ action: 'read', handle: 'unknown', cursor: 0 })).rejects
    .toMatchObject({ code: 'native_execution_handle_unknown', status: 404, statusCode: 404 });
  await expect(host.nativeExecution({ action: 'start' })).rejects
    .toMatchObject({ code: 'native_execution_authority_unavailable', status: 503, statusCode: 503 });
  await expect(host.nativeExecution({ action: 'cancel-sessions', sessions: [null] })).rejects
    .toMatchObject({ code: 'invalid_capture_identity', status: 400, statusCode: 400 });
});

// ---------------------------------------------------------------------------
// Generation 2 (DESIGN.md E item 13c): reads through `openCodeClient`; the
// companion bridge reports `capability_absent`.

const createFakeClient = ({ generation = 2, session = { id: input.sessionID, directory, revert: { messageID: 'msg_boundary' } } } = {}) => ({
  generation: () => generation,
  sessions: {
    get: vi.fn(async () => {
      if (session instanceof Error) throw session;
      return session;
    }),
    message: vi.fn(async () => ({ info: { id: 'msg_user', role: 'user', sessionID: input.sessionID }, parts: [] })),
  },
});

test('generation 2: the companion bridge is capability absent and contacts nothing', async () => {
  const fetchImpl = vi.fn(async () => { throw new Error('unexpected raw fetch'); });
  const openCodeClient = createFakeClient();
  const { host } = fixture({ fetchImpl, openCodeClient });
  const absent = (capability) => ({ code: 'capability_absent', status: 409, capability, generation: 2 });

  await expect(host.plugin({ ...input, action: 'direct-admit' })).rejects.toMatchObject(absent('execution_bridge'));
  await expect(host.nativeManagedChild({ directory, sessionID: 'ses_child', parentID: input.sessionID, parentCallID: input.callID }))
    .rejects.toMatchObject(absent('native_managed_execution'));
  expect(await host.isConfined({ directory })).toBe(false);
  await expect(host.persistCursorRecord({ sessionID: input.sessionID, directory, record: { info: { sessionID: input.sessionID } } }))
    .rejects.toMatchObject({ code: 'native_cursor_owner_unavailable', status: 503 });
  await expect(host.startCursor({ ...input, assistantMessageID: 'msg_assistant' })).rejects.toMatchObject({ code: 'native_cursor_owner_unavailable', status: 503 });
  await expect(host.executions.cancelAndWait({ directory, sessions: [input.sessionID] })).rejects.toMatchObject({ code: 'native_runner_settlement_unavailable', status: 503 });
  expect(await host.warmLedger({ directory })).toEqual({ skipped: 'not-confined' });

  expect(fetchImpl).not.toHaveBeenCalled();
  expect(openCodeClient.sessions.get).not.toHaveBeenCalled();
  expect(mocks.runtime.admitDirect).not.toHaveBeenCalled();
});

test('Cursor receipt drainage reuses the actual execution meter and advances only after published commit', async () => {
  const record={info:{id:'msg_cursor',sessionID:input.sessionID,role:'assistant'},parts:[]};
  const scope={sessionID:input.sessionID,messageID:record.info.id,callID:'cursor_msg_cursor'};
  mocks.runtime.leaseForCall.mockResolvedValue({state:'published',directory,token:'lease',scope});
  mocks.runtime.executionReceipt.mockResolvedValue({...scope,directory,files:[],source:'confined-execution'});
  const entered=Promise.withResolvers(), release=Promise.withResolvers();
  let ownerMeter, callerMeter;
  const recordReceipts=vi.fn(async receipts=>{
    ownerMeter=executionProgressMeter(); expect(ownerMeter).toBe(callerMeter);
    expect(receipts).toEqual([{...scope,directory,files:[],source:'confined-execution',tool:'cursor_sdk'}]);
    entered.resolve(); await release.promise;
  });
  const {host}=fixture({openCodeClient:createFakeClient(),recordReceipts,nativeExecution:{cursor:{persist:async()=>({messageID:record.info.id})}}});
  // fixture defaults are overwritten with the exact published owner record.
  mocks.runtime.executionReceipt.mockResolvedValue({...scope,directory,files:[],source:'confined-execution'});
  const work=withExecutionMeter(()=>{
    callerMeter=executionProgressMeter(); callerMeter.progress=7;
    return host.persistCursorRecord({sessionID:input.sessionID,directory,record});
  });
  void work.catch(error=>entered.reject(error));
  await entered.promise; expect(ownerMeter.progress).toBe(7);
  release.resolve(); expect(await work).toEqual({messageID:'msg_cursor'});
  expect(ownerMeter.progress).toBeGreaterThan(7);
  await withExecutionMeter(async()=>{
    const meter=executionProgressMeter(); meter.progress=7;
    expect(await host.persistCursorRecord({sessionID:input.sessionID,directory,record})).toEqual({messageID:'msg_cursor'});
    expect(meter.progress).toBe(7);
    expect(recordReceipts).toHaveBeenCalledTimes(1);
  });
  expect(executionProgressMeter()).toBeUndefined();
});

test('Cursor receipt failure and unpublished leases never supply completion progress', async()=>{
  const record={info:{id:'msg_cursor',sessionID:input.sessionID,role:'assistant'},parts:[]};
  const scope={sessionID:input.sessionID,messageID:record.info.id,callID:'cursor_msg_cursor'};
  const refusal=Object.assign(Error('owned receipt refused'),{code:'fixture_receipt_refused'});
  const recordReceipts=vi.fn(async()=>{throw refusal;});
  const {host}=fixture({openCodeClient:createFakeClient(),recordReceipts,nativeExecution:{cursor:{persist:async()=>({messageID:record.info.id})}}});
  mocks.runtime.executionReceipt.mockResolvedValue({...scope,directory,files:[],source:'confined-execution'});
  mocks.runtime.leaseForCall.mockResolvedValue({state:'published',directory,token:'lease',scope});
  await withExecutionMeter(async()=>{
    const meter=executionProgressMeter(); meter.progress=7;
    await expect(host.persistCursorRecord({sessionID:input.sessionID,directory,record})).rejects.toBe(refusal);
    expect(meter.progress).toBe(7);
  });
  mocks.runtime.leaseForCall.mockResolvedValue({state:'ready',directory,token:'other',scope});
  recordReceipts.mockClear();
  await withExecutionMeter(async()=>{
    const meter=executionProgressMeter(); meter.progress=7;
    await host.persistCursorRecord({sessionID:input.sessionID,directory,record});
    expect(meter.progress).toBe(7); expect(recordReceipts).not.toHaveBeenCalled();
  });
});

test('generation 2 Cursor persistence and execution require the constructor owner, preserving exact records', async () => {
  const record = { info: { id: 'msg_cursor', sessionID: input.sessionID, role: 'user' }, parts: [] };
  const persist = vi.fn(async value => ({ messageID: value.record.info.id }));
  const withExecution = vi.fn(async () => { throw Object.assign(Error('original grant revoked'), { code: 'fixture_revoked' }); });
  const client = createFakeClient();
  const { host } = fixture({ openCodeClient: client, nativeExecution: { cursor: { persist, withExecution } } });
  expect(await host.persistCursorRecord({ sessionID: input.sessionID, directory, record })).toEqual({ messageID: 'msg_cursor' });
  expect(persist).toHaveBeenCalledWith({ sessionID: input.sessionID, directory, record });
  expect(persist.mock.calls[0][0].record).toBe(record);
  const execution = { ...input, assistantMessageID: 'msg_cursor_assistant' };
  await expect(host.startCursor(execution)).rejects.toMatchObject({ code: 'fixture_revoked' });
  expect(withExecution).toHaveBeenCalledWith(execution, expect.any(Function));
  expect(client.sessions.get).not.toHaveBeenCalled();
  expect(mocks.runtime.reserve).not.toHaveBeenCalled();
});

test('ledger warming shares one selected pass and supersedes queued projects before they launch', async () => {
  const { executionSignal } = await import('@devryan/harness-runtime/lib/execution-admission.js');
  const { host } = fixture({ openCodeClient: createFakeClient(), nativeExecution: { isReady: async () => true } });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  const calls = [];
  mocks.runtime.warm.mockImplementation(async ({ directory: selected, refresh }) => {
    calls.push(selected); expect(refresh).toBe(true);
    if (calls.length === 1) {
      const signal = executionSignal(); entered();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await cleanup; signal.throwIfAborted();
    }
    return { built: true };
  });
  const first = host.warmLedger({ directory });
  expect(host.warmLedger({ directory })).toBe(first);
  await Promise.race([started, first.then(result => { throw new Error(`Warm pass never entered: ${JSON.stringify(result)}`); })]);
  const second = host.warmLedger({ directory: path.join(directory, 'second') });
  const third = host.warmLedger({ directory: path.join(directory, 'third') });
  expect(calls).toEqual([directory]);
  release();
  expect(await first).toEqual({ failed: 'ledger_warm_superseded' });
  expect(await second).toEqual({ failed: 'ledger_warm_superseded' });
  expect(await third).toEqual({ built: true });
  expect(calls).toEqual([directory, path.join(directory, 'third')]);
  await host.drain();
});

function nativeManagedFixture(nativeExecution = {}) {
  const invocation = { ...input, tool: 'devryan_task', input: { action: 'start', agent: 'fixer', prompt: 'Inspect' },
    permit: { token: 'sealed' }, authorization: { input: { provenance: { kind: 'plugin', id: 'devryan.managed-task' } } } };
  const message = { info: { id: input.messageID, role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    parts: [{ type: 'tool', callID: input.callID, tool: 'devryan_task' }],
    turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' } };
  const client = createFakeClient();
  client.sessions.get.mockImplementation(async id => ({ id, directory, ...(id === 'ses_child' ? { parentID: input.sessionID } : {}) }));
  client.sessions.message.mockImplementation(async () => message);
  const recheck = vi.fn(async () => {}), isReady = vi.fn(async () => true);
  const { host } = fixture({ openCodeClient: client, nativeExecution: { isReady, recheckPermit: recheck, ...nativeExecution } });
  const lease = { token: 'control_1', directory, state: 'ready', executionKind: 'control', preparation: 'none',
    scope: { sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, userMessageID: 'msg_user' } };
  mocks.runtime.begin.mockResolvedValue(lease); mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.finish.mockResolvedValue({ files: [], operationID: 'published_1' });
  mocks.runtime.registerChild.mockResolvedValue({ parentGeneration: 1 });
  return { host, invocation, message, client, recheck, isReady, lease };
}

test('native managed control binds its read effect to the actual reviewed origin', async () => {
  const origin = { kind: 'plugin', id: 'devryan.managed-task', manifestDigest: 'a'.repeat(64), capabilities: ['managed-task'] };
  const f = nativeManagedFixture({ reviewedToolOrigins: [origin] });
  f.invocation.authorization.input = { provenance: origin, toolID: 'devryan_task', callID: input.callID };
  const { lease } = await f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation });
  await f.host.nativeManagedControl({ action: 'finish', invocation: f.invocation, token: lease.token });
  expect(mocks.runtime.finish).toHaveBeenCalledWith({ directory, token: lease.token,
    effect: { tool: 'devryan_task', origin, reviewedOrigin: origin } });
});

test('ready native managed control rechecks the exact invocation and retains the closed legacy bridge', async () => {
  const f = nativeManagedFixture();
  const begin = await f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation });
  expect(begin.lease).toBe(f.lease);
  expect(f.recheck).toHaveBeenCalledWith(f.invocation);
  const digest = createHash('sha256').update(JSON.stringify(f.invocation.input)).digest('hex');
  expect(mocks.runtime.begin).toHaveBeenCalledWith(expect.objectContaining({ tool: 'devryan_task', kind: 'control', protocol: 3,
    argsDigest: digest, executionFingerprint: digest, userMessageID: 'msg_user', ownerID: 'owner_fixture' }));
  expect(mocks.runtime.claimLease).toHaveBeenCalledWith({ directory, token: 'control_1', kind: 'control' });
  expect(await f.host.nativeManagedControl({ action: 'finish', invocation: f.invocation, token: 'control_1' }))
    .toEqual({ files: [], operationID: 'published_1' });
  await expect(f.host.plugin({ ...input, action: 'begin', tool: 'devryan_task' }))
    .rejects.toMatchObject({ code: 'capability_absent', capability: 'execution_bridge' });
});

test('native managed control refuses unavailable hosts, wrong generations, revoked permits and forged native identity', async () => {
  const f = nativeManagedFixture();
  f.isReady.mockResolvedValue(false);
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation }))
    .rejects.toMatchObject({ code: 'capability_absent', capability: 'native_managed_execution' });
  f.isReady.mockResolvedValue(true); f.client.generation = () => 1;
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation }))
    .rejects.toMatchObject({ code: 'opencode_generation_invalid' });
  f.client.generation = () => 2; f.recheck.mockRejectedValue(Object.assign(Error('revoked'), { code: 'native_permit_revoked' }));
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation }))
    .rejects.toMatchObject({ code: 'native_permit_revoked' });
  expect(mocks.runtime.begin).not.toHaveBeenCalled();
  f.recheck.mockResolvedValue(); f.message.turnOwnership.source = 'metadata';
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation }))
    .rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  expect(mocks.runtime.begin).not.toHaveBeenCalled();
});

test('native managed control rechecks after canonical reads before changing the ledger', async () => {
  const f = nativeManagedFixture();
  let revoked = false;
  f.recheck.mockImplementation(async () => { if (revoked) throw Object.assign(Error('replaced'), { code: 'native_permit_invalid' }); });
  f.client.sessions.message.mockImplementation(async () => { revoked = true; return f.message; });
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation }))
    .rejects.toMatchObject({ code: 'native_permit_invalid' });
  expect(mocks.runtime.begin).not.toHaveBeenCalled();
  expect(mocks.runtime.claimLease).not.toHaveBeenCalled();
});

test('revocation during native control preparation cancels the unclaimed lease', async () => {
  const f = nativeManagedFixture();
  let revoked = false;
  f.recheck.mockImplementation(async () => { if (revoked) throw Object.assign(Error('revoked'), { code: 'native_permit_revoked' }); });
  mocks.runtime.begin.mockImplementation(async () => { revoked = true; return f.lease; });
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation }))
    .rejects.toMatchObject({ code: 'native_permit_revoked' });
  expect(mocks.runtime.claimLease).not.toHaveBeenCalled();
  expect(mocks.runtime.cancelUnstartedCall).toHaveBeenCalledWith(expect.objectContaining({ token: 'control_1', tool: 'devryan_task' }));
  expect(mocks.runtime.cleanupLease).toHaveBeenCalledWith(f.lease);
});

test.each(['wait', 'wait_any', 'status'])('published %s reattaches only with the original identity', async action => {
  const f = nativeManagedFixture(); f.invocation.input = { action };
  const digest = createHash('sha256').update(JSON.stringify(f.invocation.input)).digest('hex');
  const published = { ...f.lease, state: 'published', executionFingerprint: digest };
  mocks.runtime.begin.mockResolvedValue(published);
  expect(await f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation })).toEqual({ lease: published, reattached: true });
  expect(mocks.runtime.claimLease).toHaveBeenCalledWith({ directory, token: published.token, kind: 'control', reattach: true });
  mocks.runtime.begin.mockResolvedValue({ ...published, executionFingerprint: 'f'.repeat(64) });
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation })).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  mocks.runtime.begin.mockImplementation(async () => { f.recheck.mockRejectedValue(Object.assign(Error('revoked'), { code: 'native_permit_revoked' })); return published; });
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation })).rejects.toMatchObject({ code: 'native_permit_revoked' });
  expect(mocks.runtime.cancelUnstartedCall).not.toHaveBeenCalled(); expect(mocks.runtime.cleanupLease).not.toHaveBeenCalled();
});

test('published non-read control and already-claimed ready control cannot reattach', async () => {
  const f = nativeManagedFixture();
  mocks.runtime.claimLease.mockRejectedValue(Object.assign(Error('started'), { code: 'execution_already_started' }));
  mocks.runtime.begin.mockResolvedValue({ ...f.lease, state: 'published' });
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation })).rejects.toMatchObject({ code: 'execution_already_started' });
  expect(mocks.runtime.claimLease).toHaveBeenLastCalledWith({ directory, token: f.lease.token, kind: 'control' });
  f.invocation.input = { action: 'wait' }; mocks.runtime.begin.mockResolvedValue(f.lease);
  await expect(f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation })).rejects.toMatchObject({ code: 'execution_already_started' });
  expect(mocks.runtime.claimLease).toHaveBeenLastCalledWith({ directory, token: f.lease.token, kind: 'control' });
});

test('native scheduler child registration derives authority from the durable exact parent control call after tool release', async () => {
  const f = nativeManagedFixture();
  f.lease.state = 'published';
  // This path must not borrow the parent's expired request permit.
  f.recheck.mockRejectedValue(Error('old tool permit released'));
  const child = { directory, sessionID: 'ses_child', parentID: input.sessionID, parentCallID: input.callID };
  expect(await f.host.nativeManagedChild(child)).toEqual({ parentGeneration: 1 });
  expect(f.recheck).not.toHaveBeenCalled();
  expect(mocks.runtime.assertAdmission).toHaveBeenCalledWith({ directory, sessionID: 'ses_child' });
  expect(mocks.runtime.registerChild).toHaveBeenCalledWith(child);
  expect(mocks.runtime.prewarmView).not.toHaveBeenCalled();
});

test('a child that may write gets its view prewarmed after registration; a prewarm failure is not the registration\'s', async () => {
  const f = nativeManagedFixture();
  f.lease.state = 'published';
  mocks.runtime.prewarmView.mockRejectedValue(Object.assign(Error('busy'), { code: 'workspace_changing' }));
  const child = { directory, sessionID: 'ses_child', parentID: input.sessionID, parentCallID: input.callID };
  expect(await f.host.nativeManagedChild({ ...child, prewarmView: true })).toEqual({ parentGeneration: 1 });
  // The hint is the host's own; the ledger registration is unchanged.
  expect(mocks.runtime.registerChild).toHaveBeenCalledWith(child);
  expect(mocks.runtime.prewarmView).toHaveBeenCalledWith({ directory, sessionID: 'ses_child' });
});

test('native scheduler child registration refuses foreign lineage, process leases, untrusted parent ownership and durable revocation', async () => {
  const f = nativeManagedFixture();
  const child = { directory, sessionID: 'ses_child', parentID: input.sessionID, parentCallID: input.callID };
  await expect(f.host.nativeManagedChild({ ...child, parentID: 'ses_foreign' })).rejects.toMatchObject({ code: 'invalid_session_lineage' });
  f.lease.executionKind = 'process';
  await expect(f.host.nativeManagedChild(child)).rejects.toMatchObject({ code: 'invalid_session_lineage' });
  f.lease.executionKind = 'control'; f.message.turnOwnership.source = 'metadata';
  await expect(f.host.nativeManagedChild(child)).rejects.toMatchObject({ code: 'invalid_session_lineage' });
  expect(mocks.runtime.registerChild).not.toHaveBeenCalled();
  f.message.turnOwnership.source = 'native-sequence';
  mocks.runtime.registerChild.mockRejectedValue(Object.assign(Error('reverted'), { code: 'execution_reverted' }));
  await expect(f.host.nativeManagedChild(child)).rejects.toMatchObject({ code: 'execution_reverted' });
});

test('generation 2: session reads go through the client and keep the gen-1 failure codes', async () => {
  mocks.runtime.assertAdmission = vi.fn(async () => {});
  const fetchImpl = vi.fn(async () => { throw new Error('unexpected raw fetch'); });
  const openCodeClient = createFakeClient();
  const { host } = fixture({ fetchImpl, openCodeClient });

  expect(await host.beforeCursorPrompt({ directory, sessionID: input.sessionID })).toEqual({ messageID: 'msg_boundary' });
  expect(openCodeClient.sessions.get).toHaveBeenCalledWith(input.sessionID, { directory, signal: expect.any(AbortSignal) });

  const missing = fixture({ fetchImpl, openCodeClient: createFakeClient({ session: Object.assign(new Error('gone'), { statusCode: 404, code: 'opencode_not_found' }) }) });
  await expect(missing.host.beforeCursorPrompt({ directory, sessionID: input.sessionID })).rejects.toMatchObject({ code: 'mutation_history_unavailable' });
  const down = fixture({ fetchImpl, openCodeClient: createFakeClient({ session: Object.assign(new Error('down'), { statusCode: 503, code: 'opencode_unavailable' }) }) });
  await expect(down.host.beforeCursorPrompt({ directory, sessionID: input.sessionID })).rejects.toMatchObject({ code: 'mutation_runtime_unavailable' });
  const elsewhere = fixture({ fetchImpl, openCodeClient: createFakeClient({ session: { id: input.sessionID, directory: path.dirname(directory) } }) });
  await expect(elsewhere.host.beforeCursorPrompt({ directory, sessionID: input.sessionID })).rejects.toMatchObject({ code: 'session_directory_mismatch' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([undefined, {}, { generation: () => 1 }, { generation: () => 3 }])('unsupported execution identity has no companion fallback: %j', async openCodeClient => {
  const fetchImpl = vi.fn(); const { host } = fixture({ openCodeClient, fetchImpl });
  expect(() => host.plugin({ ...input, action: 'direct-admit' })).toThrow(expect.objectContaining({ code: 'opencode_generation_invalid' }));
  await expect(host.beforeCursorPrompt(input)).rejects.toMatchObject({ code: 'opencode_generation_invalid' });
  expect(fetchImpl).not.toHaveBeenCalled(); expect(mocks.runtime.admitDirect).not.toHaveBeenCalled();
});

async function nativePublicationFixture(options = {}, kind = 'writer') {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  const client = createFakeClient(), terminated = Promise.withResolvers(), launched = Promise.withResolvers(), diagnostics = [];
  client.sessions.message.mockResolvedValue({ info: { id: input.messageID, role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' }, parts: [{ id: `${input.messageID}:tool:${input.callID}`, type: 'tool', callID: input.callID, tool: kind === 'host-operation' ? 'devryan_operation' : kind === 'shell' ? 'bash' : 'write' }] });
  const lease = { token: 'native_publication', ownerID: 'owner_fixture', directory, projectDirectory: directory,
    viewDirectory: path.join(directory, '.cache/unused-native-view/worktree'), workingDirectory: path.join(directory, '.cache/unused-native-view/worktree'),
    scope: { ...input, tool: 'write' }, state: 'ready' };
  const receipt = { terminated: true, confined: true, cancelled: false, exitCode: 0 };
  mocks.runtime.reserve.mockResolvedValue(lease); mocks.runtime.prepare.mockResolvedValue(lease);
  mocks.runtime.finish.mockResolvedValue({ files: [{ path: 'fixture.txt', status: 'added' }], operationID: 'published_fixture' });
  mocks.runtime.leaseForCall.mockResolvedValue(lease); native.readSessionExecutionReceipt.mockResolvedValue(receipt);
  let processSignal;
  native.startSessionExecution.mockImplementation(async ({ onOutput, signal }) => {
    processSignal = signal;
    onOutput({ stream: 'stdout', data: Buffer.from(JSON.stringify({ type: 'result', ok: true, result: { content: 'Written fixture' } }) + '\n') });
    launched.resolve(); return { child: { stdin: { write: vi.fn() } }, pid: 200, result: terminated.promise };
  });
  const f = fixture({ openCodeClient: client, admissionSummaryMinMs: 0, ...options,
    onDiagnostic: record => { diagnostics.push(record); options.onDiagnostic?.(record); },
    nativeExecution: { workerCommand: '/fixture/bun', workerArgs: ['worker.ts'], recheckPermit: async () => {}, ...options.nativeExecution } });
  const specification = kind === 'host-operation' ? {kind:'host-operation',operationID:'host_verify'} : kind === 'shell'
    ? { kind: 'shell', command: '/bin/sh', args: ['-c', 'fixture'], env: {}, cwd: directory }
    : { kind: 'writer', tool: 'write', input: { filePath: 'fixture.txt', content: 'fixture' } };
  const start = (overrides={}) => f.host.nativeExecution({ ...input, ...specification, ...(kind === 'shell' ? { tool: 'shell' } : {}),
    ...(kind==='host-operation'?{tool:'devryan_operation',authorization:{input:{input:{operationID:'host_verify'}}}}:{}),...overrides, action: 'start', agent: 'build',
    argsDigest: createHash('sha256').update(JSON.stringify(specification)).digest('hex') });
  const settled = async handle => {
    let batch, cursor = 0; const events = [];
    do { batch = await f.host.nativeExecution({ action: 'read', handle, cursor }); cursor = batch.cursor; events.push(...batch.events); } while (!batch.done);
    return events.at(-1);
  };
  return { ...f, client, diagnostics, lease, receipt, terminated, launched, start, settled, processSignal: () => processSignal,
    finishes: () => diagnostics.filter(row => row.phase === 'finish') };
}

test('a shell whose command replaced ignored folders settles with them named, never as published', async () => {
  const f = await nativePublicationFixture({}, 'shell');
  mocks.runtime.finish.mockResolvedValue({ files: [{ path: 'src/app.ts', status: 'modified' }], operationID: 'published_dropped',
    ignoredInputs: ['test-results'] });
  try {
    const { handle } = await f.start(); await f.launched.promise;
    f.terminated.resolve(f.receipt);
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: true,
      publication: { outcome: 'complete', conflicts: [], ignoredInputs: ['test-results'] } });
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('deadline cancellation matches the exact live shell and waits for termination', async () => {
  const f = await nativePublicationFixture({}, 'shell');
  const fingerprint = { sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, partID: `${input.messageID}:tool:${input.callID}`, tool: 'bash' };
  try {
    await f.start(); await f.launched.promise;
    for (const key of ['sessionID', 'messageID', 'callID', 'partID', 'tool']) {
      expect(await f.host.cancelOwnedCommand({ directory, fingerprint: { ...fingerprint, [key]: 'different' } })).toBe(false);
    }
    expect(await f.host.cancelOwnedCommand({ directory: '/other', fingerprint })).toBe(false);
    expect(f.processSignal().aborted).toBe(false);
    let settled = false;
    const cancelled = f.host.cancelOwnedCommand({ directory, fingerprint }).then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(f.processSignal().aborted).toBe(true);
    expect(settled).toBe(false);
    f.terminated.resolve({ ...f.receipt, cancelled: true, exitCode: 137 });
    expect(await cancelled).toBe(true);
    expect(await f.host.cancelOwnedCommand({ directory, fingerprint })).toBe(false);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('registered host operation uses only host-resolved argv/capabilities and the normal settlement/publication boundary',async()=>{
 const native=await import('@devryan/harness-runtime/lib/session-execution.js'),grant=Object.freeze({fixture:true}),recheck=vi.fn();
 const resolveHostOperation=vi.fn(async()=>({command:'/fixture/node',args:['check.js'],cwd:directory,timeoutMs:1000,grant,recheck}));
 const f=await nativePublicationFixture({nativeExecution:{resolveHostOperation}},'host-operation');
 try{
  await expect(f.start({command:'/bin/sh',args:['-c','unregistered']})).rejects.toMatchObject({code:'host_operation_input_invalid'});
  const {handle}=await f.start();await f.launched.promise;
  expect(resolveHostOperation).toHaveBeenCalledWith('host_verify',directory,expect.objectContaining({sessionID:input.sessionID}));
  expect(recheck).toHaveBeenCalledWith(expect.stringContaining('worktree'));
  expect(native.startSessionExecution).toHaveBeenCalledWith(expect.objectContaining({command:'/fixture/node',args:['check.js'],hostOperationGrant:grant}));
  f.terminated.resolve(f.receipt);expect(await f.settled(handle)).toMatchObject({type:'settled',ok:true});
  expect(mocks.runtime.finish).toHaveBeenCalledOnce();
 }finally{f.terminated.resolve(f.receipt);await f.host.drain();}
});

test('Plan-mode host operation never resolves a privileged capability or launches',async()=>{
 const resolveHostOperation=vi.fn(),f=await nativePublicationFixture({nativeExecution:{readOnlyInvocation:async()=>true,resolveHostOperation}},'host-operation');
 try{await expect(f.start()).rejects.toMatchObject({code:'native_plan_write_denied'});expect(resolveHostOperation).not.toHaveBeenCalled();}
 finally{f.terminated.resolve(f.receipt);await f.host.drain();}
});

test('a confined shell exit 7 remains command failure evidence on a completed transport', async () => {
  const f = await nativePublicationFixture({}, 'shell');
  try {
    const { handle } = await f.start();
    await f.launched.promise;
    expect(mocks.runtime.finish).not.toHaveBeenCalled();
    f.terminated.resolve({ ...f.receipt, exitCode: 7 });
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: true,
      receipt: { terminated: true, confined: true, cancelled: false, exitCode: 7 } });
    expect(mocks.runtime.finish).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.cancelLease).not.toHaveBeenCalled();
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test.each([
  { label: 'complete Docker diagnostic', output: 'Cannot connect to the Docker daemon. Is the docker daemon running?', status: 'skipped', complete: true },
  { label: 'bounded diagnostic overflow', output: 'Cannot connect to the Docker daemon. ' + 'x'.repeat(16 * 1024), status: 'failed', complete: false },
  { label: 'mixed SQL failure', output: 'Cannot connect to the Docker daemon.\nSQLSTATE 42501: permission denied for table users', status: 'failed', complete: true },
])('tracks $label independently of acknowledged transport output', async ({ output, status, complete }) => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-check-diagnostics-'));
  await fs.writeFile(path.join(root, 'source.txt'), 'check content');
  const task = { taskId: 'dvr_task_diagnostics', directory: root, leaseToken: 'lease_check', requiredChecks: [
    { name: 'integration', command: 'bun test integration.test.js', paths: ['source.txt'] },
  ], requiredCheckReceipts: [] };
  const observer = createRequiredCheckObserver({ scheduler: {
    getRequiredCheckTask: () => task,
    recordRequiredChecks: async (_taskId, _leaseToken, receipts) => { task.requiredCheckReceipts = receipts; return true; },
  } });
  const observations = [];
  const observeRequiredCheck = async (phase, invocation, exitCode, execution) => {
    const observation = { directory: root, sessionId: invocation.sessionID, messageId: invocation.messageID,
      callId: invocation.callID, tool: 'bash', command: task.requiredChecks[0].command, executionDirectory: root,
      exitCode, output: execution.output, outputComplete: execution.outputComplete };
    if (phase === 'before') return observer.before(observation);
    observations.push(execution);
    return observer.after(observation);
  };
  const f = await nativePublicationFixture({ nativeExecution: { observeRequiredCheck } }, 'shell');
  native.startSessionExecution.mockImplementation(async ({ onOutput }) => {
    onOutput({ stream: 'stdout', data: Buffer.from(output) }); f.launched.resolve();
    return { child: { stdin: { write: vi.fn() } }, pid: 200, result: f.terminated.promise };
  });
  try {
    const { handle } = await f.start(); await f.launched.promise;
    const first = await f.host.nativeExecution({ action: 'read', handle, cursor: 0 });
    expect(first.events.some(event => event.type === 'output')).toBe(true);
    expect(first.done).toBe(false);
    // A second read acknowledges and removes stdout before process termination.
    const acknowledged = f.host.nativeExecution({ action: 'read', handle, cursor: first.cursor });
    await new Promise(resolve => setImmediate(resolve));
    f.terminated.resolve({ ...f.receipt, exitCode: 1 });
    let batch = await acknowledged;
    while (!batch.done) batch = await f.host.nativeExecution({ action: 'read', handle, cursor: batch.cursor });
    expect(batch.events.at(-1)?.type).toBe('settled');
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ outputComplete: complete });
    expect(Buffer.byteLength(observations[0].output)).toBeLessThanOrEqual(16 * 1024);
    expect((await observer.project(task))[0]).toMatchObject({ status, evidence: { exitCode: 1 } });
    expect(JSON.stringify(task.requiredCheckReceipts)).not.toContain('Cannot connect');
  } finally {
    f.terminated.resolve(f.receipt); await f.host.drain(); observer.dispose(); await fs.rm(root, { recursive: true, force: true });
  }
});

test('untracked shells retain no separate required-check output buffer', async () => {
  const observeRequiredCheck = vi.fn(async () => ({ tracked: false }));
  const f = await nativePublicationFixture({ nativeExecution: { observeRequiredCheck } }, 'shell');
  try {
    const { handle } = await f.start(); await f.launched.promise;
    f.terminated.resolve(f.receipt); await f.settled(handle);
    expect(observeRequiredCheck.mock.calls.find(([phase]) => phase === 'after')[3]).toMatchObject({ output: '', outputComplete: false });
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test.each([0, 7])('native required check exit %s persists after publication and before terminal delivery', async exitCode => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), phases = [];
  const observeRequiredCheck = vi.fn(async (phase, invocation, exit, execution) => {
    phases.push(phase);
    expect(execution).toMatchObject({ executionDirectory: expect.stringContaining('worktree') });
    if (phase === 'after') expect(execution).toMatchObject({ output: expect.any(String), outputComplete: expect.any(Boolean) });
    expect(invocation).toMatchObject({ sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, kind: 'shell' });
    if (phase === 'before') expect(native.startSessionExecution).not.toHaveBeenCalled();
    else {
      expect(exit).toBe(exitCode);
      expect(mocks.runtime.finish).toHaveBeenCalledTimes(1);
      expect(mocks.runtime.cleanupLease).not.toHaveBeenCalled();
      entered.resolve();
      await release.promise;
    }
  });
  const f = await nativePublicationFixture({ nativeExecution: { observeRequiredCheck } }, 'shell');
  try {
    const { handle } = await f.start(); await f.launched.promise;
    f.terminated.resolve({ ...f.receipt, exitCode });
    let delivered = false;
    const terminal = f.settled(handle).then(event => { delivered = true; return event; });
    await entered.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(delivered).toBe(false);
    release.resolve();
    expect(await terminal).toMatchObject({ type: 'settled', ok: true, receipt: { exitCode } });
    expect(phases).toEqual(['before', 'after']);
  } finally { release.resolve(); f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test.each([
  { terminated: true, confined: true, cancelled: true, exitCode: 143 },
  { terminated: true, confined: false, cancelled: false, exitCode: 0 },
])('cancelled or unconfined native checks remain unverified: %j', async receipt => {
  const observeRequiredCheck = vi.fn(async () => {});
  const f = await nativePublicationFixture({ nativeExecution: { observeRequiredCheck } }, 'shell');
  try {
    const { handle } = await f.start(); await f.launched.promise;
    f.terminated.resolve(receipt);
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: false });
    expect(observeRequiredCheck.mock.calls.map(([phase, , exit]) => [phase, exit])).toEqual([['before', undefined], ['after', null]]);
    expect(mocks.runtime.finish).not.toHaveBeenCalled();
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('a native check observer failure leaves its check unverified without changing publication', async () => {
  const observeRequiredCheck = vi.fn(async phase => { if (phase === 'after') throw Error('receipt unavailable'); });
  const f = await nativePublicationFixture({ nativeExecution: { observeRequiredCheck } }, 'shell');
  try {
    const { handle } = await f.start(); await f.launched.promise; f.terminated.resolve(f.receipt);
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: true });
    expect(observeRequiredCheck).toHaveBeenCalledTimes(2);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('a refused native check reservation never launches the command or fabricates an exit', async () => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  const observeRequiredCheck = vi.fn(async phase => { if (phase === 'before') throw Error('check reservation refused'); });
  const f = await nativePublicationFixture({ nativeExecution: { observeRequiredCheck } }, 'shell');
  try {
    const { handle } = await f.start();
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: false, error: { message: 'check reservation refused' } });
    expect(native.startSessionExecution).not.toHaveBeenCalled();
    expect(observeRequiredCheck.mock.calls.map(([phase, , exit]) => [phase, exit])).toEqual([['before', undefined], ['after', null]]);
  } finally { await f.host.drain(); }
});

if (process.platform !== 'win32') test('a read-only shell reserves no view copy on macOS and runs from the live project', async () => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-readonly-host-')));
  const f = await nativePublicationFixture({ nativeExecution: { readOnlyInvocation: async () => true } }, 'shell');
  try {
    const view = path.join(root, 'views', 'token', 'worktree'); await fs.mkdir(view, { recursive: true });
    const lease = { ...f.lease, viewDirectory: view, workingDirectory: view };
    mocks.runtime.reserve.mockImplementation(async request => ({ ...lease, ...(request.preparation ? { preparation: request.preparation } : {}) }));
    mocks.runtime.prepare.mockImplementation(async reserved => reserved);
    const { handle } = await f.start(); await f.launched.promise;
    const live = process.platform === 'darwin';
    expect(mocks.runtime.reserve).toHaveBeenCalledWith(expect.objectContaining({ kind: 'process', preparation: live ? 'read-only' : undefined }));
    expect(native.startSessionExecution.mock.calls[0][0].lease).toMatchObject({ readOnly: true, inputs: undefined,
      workingDirectory: path.join(root, 'views', 'token', 'read-only-worktree'), logicalWorkingDirectory: live ? await fs.realpath(directory) : view });
    f.terminated.resolve(f.receipt);
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: true });
    await f.host.drain();
    // Journal rows carry the tier and identity that `journal summary` groups by.
    expect(f.finishes()).toEqual([expect.objectContaining({ executionTier: 'process', sessionID: input.sessionID, userMessageID: 'msg_user', state: 'completed' })]);
    expect(f.diagnostics.filter(row => row.phase === 'lease_cleanup')).toEqual([expect.objectContaining({ deferred: true, executionTier: 'process',
      sessionID: input.sessionID, messageID: input.messageID, callID: input.callID })]);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); await fs.rm(root, { recursive: true, force: true }); }
});

test('an accepted Stop ends the stopped tree\'s running shell, records its cancellation and leaves other sessions running', async () => {
  const f = await nativePublicationFixture({}, 'shell');
  // The running shell belongs to a child of the stopped session.
  f.client.sessions.get.mockImplementation(async id => ({ id, directory, ...(id === input.sessionID ? { parentID: 'ses_parent' } : {}) }));
  try {
    await f.start(); await f.launched.promise;
    expect(f.host.activeExecutionCalls({ directory, sessionID: input.sessionID })).toEqual([input.callID]);
    expect(await f.host.stopSessionRuns({ sessions: ['ses_other'] })).toEqual({ stopped: 0 });
    expect(f.processSignal().aborted).toBe(false);
    await expect(f.host.stopSessionRuns({ sessions: ['bad id'] })).rejects.toMatchObject({ code: 'invalid_capture_identity' });
    const stopping = f.host.stopSessionRuns({ sessions: ['ses_parent'] });
    await vi.waitFor(() => expect(f.processSignal().aborted).toBe(true));
    f.terminated.resolve({ ...f.receipt, cancelled: true, exitCode: 143 });
    expect(await stopping).toEqual({ stopped: 1 });
    expect(mocks.runtime.cancelLease).toHaveBeenCalledWith({ directory, token: f.lease.token, stoppedBy: 'operator' });
    expect(f.recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ sessionID: input.sessionID, callID: input.callID,
      source: 'confined-execution', complete: true, files: [], tool: 'bash' }));
    expect(mocks.runtime.finish).not.toHaveBeenCalled();
    expect(f.host.activeExecutionCalls({ directory, sessionID: input.sessionID })).toEqual([]);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('a child\'s run carries its task attempt, and only that settled attempt\'s cleanup stops it, as task_settled', async () => {
  let attempt = { taskId: 'dvr_task_a', leaseToken: 'lease_a' };
  const f = await nativePublicationFixture({ attemptFor: async () => attempt }, 'shell');
  // The ledger stores the stamp on the lease that preparation returns.
  mocks.runtime.reserve.mockImplementation(async request => ({ ...f.lease, reservedAt: 1_000, ...(request.attempt ? { attempt: request.attempt } : {}) }));
  mocks.runtime.prepare.mockImplementation(async reserved => reserved);
  const cleanup = (overrides = {}) => f.host.stopAttemptRuns({ childSessionId: input.sessionID, directory, taskId: 'dvr_task_a', leaseToken: 'lease_a',
    settledAt: 2_000, reason: 'task_settled', ...overrides });
  try {
    await f.start(); await f.launched.promise;
    expect(mocks.runtime.reserve).toHaveBeenCalledWith(expect.objectContaining({ attempt: { taskId: 'dvr_task_a', leaseToken: 'lease_a' } }));
    await expect(cleanup({ reason: 'operator' })).rejects.toMatchObject({ code: 'invalid_capture_identity', status: 400 });
    await expect(cleanup({ settledAt: undefined })).rejects.toMatchObject({ code: 'invalid_capture_identity', status: 400 });
    // Another attempt's cleanup, and a cleanup while this attempt is still current, stop nothing.
    expect(await cleanup({ taskId: 'dvr_task_b', leaseToken: 'lease_b' })).toEqual({ stopped: 0 });
    expect(await cleanup()).toEqual({ stopped: 0 });
    expect(f.processSignal().aborted).toBe(false);
    attempt = { state: 'none' };
    const stopping = cleanup();
    await vi.waitFor(() => expect(f.processSignal().aborted).toBe(true));
    f.terminated.resolve({ ...f.receipt, cancelled: true, exitCode: 143 });
    expect(await stopping).toEqual({ stopped: 1 });
    expect(mocks.runtime.cancelLease).toHaveBeenCalledWith({ directory, token: f.lease.token, stoppedBy: 'task_settled' });
    expect(f.host.activeExecutionCalls({ directory, sessionID: input.sessionID })).toEqual([]);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('an unstamped run reserved after the attempt settled is left running', async () => {
  const f = await nativePublicationFixture({ attemptFor: async () => ({ state: 'none' }) }, 'shell');
  mocks.runtime.reserve.mockImplementation(async request => ({ ...f.lease, reservedAt: 3_000, attempt: request.attempt }));
  mocks.runtime.prepare.mockImplementation(async reserved => reserved);
  try {
    await f.start(); await f.launched.promise;
    expect(await f.host.stopAttemptRuns({ childSessionId: input.sessionID, directory, taskId: 'dvr_task_a', leaseToken: 'lease_a',
      settledAt: 2_000, reason: 'task_settled' })).toEqual({ stopped: 0 });
    expect(f.processSignal().aborted).toBe(false);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('the Stop kill switch leaves running shells untouched', async () => {
  vi.stubEnv('DEVRYAN_STOP_ENDS_BACKGROUND_RUNS', '0');
  const f = await nativePublicationFixture({}, 'shell');
  try {
    await f.start(); await f.launched.promise;
    expect(await f.host.stopSessionRuns({ sessions: [input.sessionID] })).toEqual({ stopped: 0 });
    expect(f.processSignal().aborted).toBe(false);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('deadline cancellation never attests termination from a resolved task without a confined receipt', async () => {
  const f = await nativePublicationFixture({}, 'shell');
  const fingerprint = { sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
    partID: `${input.messageID}:tool:${input.callID}`, tool: 'bash' };
  try {
    await f.start(); await f.launched.promise;
    const cancelled = f.host.cancelOwnedCommand({ directory, fingerprint });
    f.terminated.resolve({ ...f.receipt, terminated: false, confined: false, cancelled: true });
    expect(await cancelled).toBe(false);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

const deadlineFingerprint = () => ({ sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
  partID: `${input.messageID}:tool:${input.callID}`, tool: 'bash' });
const deadlineTiming = { source: 'registered', startedAt: 1_000, deadlineAt: 901_000, watchdogAt: 931_000, effectiveTimeoutMs: 900_000,
  requestedTimeoutMs: 900_000, graceMs: 30_000, elapsedMs: 930_000 };

test('shell job binding reports the projected call identity and the enforced timeout to the deadline watchdog', async () => {
  const bound = [];
  const f = await nativePublicationFixture({ onShellJobBound: value => { bound.push(value); } }, 'shell');
  mocks.runtime.bindNativeShellJob = vi.fn(async args => ({ token: args.token, nativeShellJob: { jobID: args.jobID, command: args.command },
    scope: { sessionID: args.sessionID, messageID: args.messageID, callID: args.callID } }));
  try {
    const { handle } = await f.start(); await f.launched.promise;
    await f.host.nativeExecution({ ...input, tool: 'shell', action: 'bind-shell-job', handle, jobID: 'job_fixture', command: 'fixture',
      startedAt: 5_000, requestedTimeoutMs: 900_000, effectiveTimeoutMs: 900_000 });
    expect(bound).toEqual([{ directory, sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
      partID: deadlineFingerprint().partID, tool: 'bash', startedAt: 5_000, requestedTimeoutMs: 900_000, effectiveTimeoutMs: 900_000 }]);
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); delete mocks.runtime.bindNativeShellJob; }
});

test('a deadline cancellation settles with its code and only the known timing fields', async () => {
  const f = await nativePublicationFixture({}, 'shell');
  try {
    const { handle } = await f.start(); await f.launched.promise;
    const cancelled = f.host.cancelOwnedCommand({ directory, fingerprint: deadlineFingerprint(), reason: 'command_deadline_exceeded',
      timing: { ...deadlineTiming, injected: 'value' } });
    f.terminated.resolve({ ...f.receipt, cancelled: true, exitCode: 137 });
    expect(await cancelled).toBe(true);
    const event = await f.settled(handle);
    expect(event).toMatchObject({ type: 'settled', ok: false,
      error: { message: 'command_deadline_exceeded', code: 'command_deadline_exceeded', metadata: deadlineTiming } });
    expect(event.error.metadata).not.toHaveProperty('injected');
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('a deadline cancellation never relabels an operator stop already under way', async () => {
  const f = await nativePublicationFixture({}, 'shell');
  try {
    const { handle } = await f.start(); await f.launched.promise;
    const stopping = f.host.stopSessionRuns({ sessions: [input.sessionID] });
    for (let turn = 0; turn < 50 && !f.processSignal().aborted; turn++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.processSignal().aborted).toBe(true);
    const cancelled = f.host.cancelOwnedCommand({ directory, fingerprint: deadlineFingerprint(), reason: 'command_deadline_exceeded', timing: deadlineTiming });
    f.terminated.resolve({ ...f.receipt, cancelled: true, exitCode: 137 });
    await stopping; await cancelled;
    expect((await f.settled(handle)).error).toEqual({ message: 'execution_cancelled' });
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('native writer finish observation follows durable receipt and precedes independently owned cleanup', async () => {
  const f = await nativePublicationFixture({ onDiagnostic: record => { if (record.phase === 'finish') throw Error('observer unavailable'); } });
  const publishing = Promise.withResolvers(), publication = Promise.withResolvers(), recording = Promise.withResolvers(), recorded = Promise.withResolvers(), cleaned = Promise.withResolvers();
  mocks.runtime.finish.mockImplementation(async () => { publishing.resolve(); return publication.promise; });
  f.recordReceipt.mockImplementation(async () => { recording.resolve(); await recorded.promise; });
  mocks.runtime.cleanupLease.mockImplementation(() => cleaned.promise);
  try {
    const { handle } = await f.start(); await f.launched.promise;
    expect(f.finishes()).toEqual([]); f.terminated.resolve(f.receipt); await publishing.promise;
    expect(f.finishes()).toEqual([]); expect(f.recordReceipt).not.toHaveBeenCalled();
    expect(f.host.activeExecutionCalls({ sessionID: input.sessionID })).toEqual([]);
    publication.resolve({ operationID: 'published_fixture', files: [] }); await recording.promise;
    expect(f.finishes()).toEqual([]); expect(mocks.runtime.cleanupLease).not.toHaveBeenCalled();
    recorded.resolve(); expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: true, result: { content: 'Written fixture' } });
    expect(f.finishes()).toEqual([expect.objectContaining({ event: 'session_execution', phase: 'finish', state: 'completed',
      sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, elapsedMs: expect.any(Number) })]);
    expect(f.recordReceipt).toHaveBeenCalledTimes(1); expect(mocks.runtime.cleanupLease).toHaveBeenCalledTimes(1);
  } finally { publication.resolve({ files: [] }); recorded.resolve(); cleaned.resolve(); await f.host.drain(); }
});

test('native writer receipt failure keeps the original timeout error and never reports completed publication', async () => {
  const f = await nativePublicationFixture();
  const cause = Object.assign(Error('original receipt lock timeout'), { code: 'LOCK_TIMEOUT', name: 'TimeoutError' });
  const failed = Promise.withResolvers();
  f.recordReceipt.mockImplementation(async () => { failed.resolve(); throw cause; });
  const { handle } = await withExecutionMeter(f.start); await f.launched.promise; f.terminated.resolve(f.receipt);
  await failed.promise;
  await expect(f.host.nativeExecution({ action: 'cancel', handle })).rejects.toBe(cause);
  expect(await f.settled(handle)).toMatchObject({ type: 'uncertain', error: { code: 'LOCK_TIMEOUT' } });
  expect(f.finishes()).toEqual([expect.objectContaining({ phase: 'finish', state: 'failed' })]);
  expect(mocks.runtime.finish).toHaveBeenCalledTimes(1); expect(mocks.runtime.cancelLease).not.toHaveBeenCalled();
  expect(mocks.runtime.cleanupLease).not.toHaveBeenCalled();
  await expect(f.host.drain()).rejects.toBe(cause);
});

test('native writer publication failure reports failed timing and retains the existing cancellation outcome', async () => {
  const f = await nativePublicationFixture(); const cause = Object.assign(Error('publication refused'), { code: 'fixture_publication_refused' });
  mocks.runtime.finish.mockRejectedValue(cause);
  try {
    const { handle } = await f.start(); await f.launched.promise; f.terminated.resolve(f.receipt);
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: false, error: { code: cause.code } });
    expect(f.finishes()).toEqual([expect.objectContaining({ phase: 'finish', state: 'failed' })]);
    expect(f.recordReceipt).not.toHaveBeenCalled(); expect(mocks.runtime.cancelLease).toHaveBeenCalledTimes(1);
  } finally { await f.host.drain(); }
});

test('native writer finish observation preserves inherited authority and a committed receipt after admission expiry', async () => {
  const f = await nativePublicationFixture(), controller = new AbortController(), recording = Promise.withResolvers(), recorded = Promise.withResolvers();
  let inherited;
  f.recordReceipt.mockImplementation(async () => {
    expect(executionSignal()).toBe(inherited); recording.resolve(); await recorded.promise;
    expect(executionSignal()).toBe(inherited); expect(inherited.aborted).toBe(true);
  });
  try {
    const { handle } = await withExecutionAdmission(input, () => { inherited = executionSignal(); return f.start(); }, { signal: controller.signal });
    await f.launched.promise; f.terminated.resolve(f.receipt); await recording.promise;
    controller.abort(Object.assign(Error('original admission expired'), { code: 'local_execution_timeout' })); recorded.resolve();
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: true });
    expect(f.finishes()).toEqual([expect.objectContaining({ phase: 'finish', state: 'completed' })]);
    expect(mocks.runtime.cancelLease).not.toHaveBeenCalled(); expect(f.recordReceipt).toHaveBeenCalledTimes(1);
  } finally { recorded.resolve(); await f.host.drain(); }
});

test('native writer cancellation before termination produces no successful finish observation', async () => {
  const f = await nativePublicationFixture();
  try {
    const { handle } = await f.start(); await f.launched.promise;
    const cancelled = f.host.nativeExecution({ action: 'cancel', handle });
    f.terminated.resolve({ ...f.receipt, cancelled: true, exitCode: 137 }); await cancelled;
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: false });
    expect(f.finishes()).toEqual([]); expect(mocks.runtime.finish).not.toHaveBeenCalled();
    expect(mocks.runtime.cancelLease).toHaveBeenCalledTimes(1);
  } finally { await f.host.drain(); }
});

test('native writer recovered publication observes its durable receipt only after the successful finish retry', async () => {
  const f = await nativePublicationFixture();
  mocks.runtime.finish.mockRejectedValueOnce(Error('materialization interrupted'));
  mocks.runtime.leaseForCall.mockResolvedValue({ ...f.lease, state: 'published' });
  try {
    const { handle } = await f.start(); await f.launched.promise; f.terminated.resolve(f.receipt);
    expect(await f.settled(handle)).toMatchObject({ type: 'settled', ok: true });
    expect(f.finishes().map(row => row.state)).toEqual(['failed', 'completed']);
    expect(mocks.runtime.finish).toHaveBeenCalledTimes(2); expect(f.recordReceipt).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.cancelLease).not.toHaveBeenCalled();
  } finally { await f.host.drain(); }
});

test.each([{ tool: 'patch', projected: 'apply_patch', input: { patchText: 'partial patch fixture' } },
  { tool: 'ast_grep_replace', projected: 'ast_grep_replace', input: { pattern: 'old()', rewrite: 'new()', lang: 'javascript', dryRun: false } }])(
  'native $tool failure waits termination, cancels its view, and publishes nothing', async ({ tool, projected, input: arguments_ }) => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  const openCodeClient = createFakeClient();
  openCodeClient.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' },
    parts: [{ type: 'tool', callID: input.callID, tool: projected }] });
  const lease = { token: 'native_lease', ownerID: 'owner_fixture', directory, projectDirectory: directory,
    viewDirectory: path.join(directory, '.cache/unused-native-view/worktree'),
    workingDirectory: path.join(directory, '.cache/unused-native-view/worktree'), scope: { ...input, tool }, state: 'ready' };
  mocks.runtime.reserve.mockResolvedValue(lease); mocks.runtime.prepare.mockResolvedValue(lease);
  mocks.runtime.cancelLease = vi.fn(async () => {});
  mocks.runtime.cancelUnstartedCall = vi.fn(async () => {});
  const terminated = Promise.withResolvers();
  const receipt = { terminated: true, confined: true, cancelled: false, exitCode: 0 };
  const reviewedAst = { path: '/artifacts/DevRyan-ast-grep-darwin-arm64', sha256: 'f'.repeat(64) };
  const reviewedAstOrigin = { kind: 'plugin', id: 'devryan.slim', manifestDigest: 'a'.repeat(64), capabilities: ['read', 'write', 'process'] };
  native.startSessionExecution.mockImplementation(async ({ onOutput, socketDirectory, workerBrowsers, input: workerInput }) => {
    expect(socketDirectory).toBeNull(); expect(workerBrowsers).toBe(false);
    expect(JSON.parse(workerInput).reviewedAst).toEqual(tool === 'patch' ? undefined : reviewedAst);
    onOutput({ stream: 'stdout', data: Buffer.from(JSON.stringify({ type: 'result', ok: false,
      error: { message: 'Unable to apply patch', metadata: { completed: 1 } } }) + '\n') });
    return { child: { stdin: { write: vi.fn() } }, pid: 200, result: terminated.promise };
  });
  const onTermination = vi.fn(), onOutcome = vi.fn();
  const { host, recordReceipt } = fixture({ openCodeClient, nativeExecution: { workerCommand: '/fixture/bun', workerArgs: ['worker.ts'],
    recheckPermit: async () => {}, socketDirectory: null, workerBrowsers: false, onTermination, onOutcome, reviewedAst, reviewedAstOrigin } });
  const specification = { kind: 'writer', tool, input: arguments_ };
  const started = await host.nativeExecution({ ...input, ...specification, action: 'start', agent: 'build',
    reviewedAst: { path: '/forged/asset', sha256: 'b'.repeat(64) }, authorization: { input: { provenance: reviewedAstOrigin } },
    argsDigest: createHash('sha256').update(JSON.stringify(specification)).digest('hex') });
  await host.nativeExecution({ action: 'read', handle: started.handle, cursor: 0 });
  expect(mocks.runtime.finish).not.toHaveBeenCalled(); expect(mocks.runtime.cancelLease).not.toHaveBeenCalled();
  terminated.resolve(receipt);
  await host.nativeExecution({ action: 'cancel', handle: started.handle });
  expect(onTermination).toHaveBeenCalledWith(expect.objectContaining({ receipt }));
  expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ state: 'cancelled' }));
  expect(mocks.runtime.cancelLease).toHaveBeenCalledTimes(1);
  expect(mocks.runtime.finish).not.toHaveBeenCalled(); expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ files: [] }));
  expect(mocks.runtime.cleanupLease).toHaveBeenCalled();
});

test('native AST launch refuses unreviewed origins before preparing a workspace', async () => {
  const reviewedAstOrigin = { kind: 'plugin', id: 'devryan.slim', manifestDigest: 'a'.repeat(64), capabilities: ['read', 'write', 'process'] };
  const { host } = fixture({ nativeExecution: { recheckPermit: async () => {}, reviewedAstOrigin,
    reviewedAst: { path: '/artifact/DevRyan-ast-grep-darwin-arm64', sha256: 'b'.repeat(64) } } });
  for (const provenance of [undefined, { ...reviewedAstOrigin, kind: 'native' }, { ...reviewedAstOrigin, manifestDigest: 'f'.repeat(64) },
    { ...reviewedAstOrigin, capabilities: ['read'] }]) {
    await expect(host.nativeExecution({ ...input, action: 'start', kind: 'writer', tool: 'ast_grep_search', agent: 'build',
      authorization: { input: { provenance } } })).rejects.toMatchObject({ code: 'native_ast_registration_required' });
  }
  expect(mocks.runtime.reserve).not.toHaveBeenCalled();
});

test('native host helpers allow only bounded reviewed Git discovery with a fresh environment', async () => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  native.runReadOnlySessionExecution.mockResolvedValue({ receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 },
    stdout: Buffer.from('.git\n.git\n/fixture\n'), stderr: Buffer.alloc(0) });
  const { host } = fixture({ nativeExecution: { helperRoots: [directory], gitCommand: '/usr/bin/git', socketDirectory: null } });
  const helper = { action: 'helper', command: 'git', args: ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], cwd: directory };
  const result = await host.nativeExecution(helper);
  expect(result.receipt.terminated).toBe(true);
  expect(native.runReadOnlySessionExecution).toHaveBeenCalledWith(expect.objectContaining({ command: '/usr/bin/git',
    socketDirectory: null, workerBrowsers: false, args: ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...helper.args],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CEILING_DIRECTORIES: path.dirname(await fs.realpath(directory)) } }));
  await expect(host.nativeExecution({ ...helper, args: ['fetch', 'origin'] })).rejects.toMatchObject({ code: 'native_helper_denied' });
  await expect(host.nativeExecution({ ...helper, timeoutMs: '100' })).rejects.toMatchObject({ code: 'native_helper_timeout_invalid' });
  await expect(host.nativeExecution({ ...helper, cwd: path.dirname(directory) })).rejects.toMatchObject({ code: 'native_helper_directory_denied' });
  expect(native.runReadOnlySessionExecution).toHaveBeenCalledTimes(1);
  expect(mocks.runtime.reserve).not.toHaveBeenCalled();
});

test('native helpers share successful Git selection, retry failed discovery, and remain confined', async () => {
  runReadOnlySessionExecution.mockResolvedValue({ receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 },
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  const { host } = fixture({ nativeExecution: { helperRoots: [directory], gitCommand: '/usr/bin/git', socketDirectory: null } });
  const helper = { action: 'helper', command: 'git', args: ['remote', 'get-url', 'origin'], cwd: directory };
  mocks.resolveGit.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'mutation_runtime_unsupported' }));
  await expect(host.nativeExecution(helper)).rejects.toMatchObject({ code: 'mutation_runtime_unsupported' });
  expect(runReadOnlySessionExecution).not.toHaveBeenCalled();
  mocks.resolveGit.mockResolvedValue('/Applications/Xcode.app/Contents/Developer/usr/bin/git');
  await Promise.all([host.nativeExecution(helper), host.nativeExecution(helper)]);
  expect(mocks.resolveGit).toHaveBeenCalledTimes(2);
  expect(runReadOnlySessionExecution).toHaveBeenCalledTimes(2);
  expect(runReadOnlySessionExecution).toHaveBeenCalledWith(expect.objectContaining({
    command: '/Applications/Xcode.app/Contents/Developer/usr/bin/git', workerBrowsers: false,
  }));
});

test('a removed unrelated native helper root does not block a valid current project or widen discovery', async () => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  native.runReadOnlySessionExecution.mockResolvedValue({ receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 },
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-helper-roots-')));
  try {
    const current = path.join(root, 'current'), removed = path.join(root, 'removed'), sibling = path.join(root, 'unregistered');
    await Promise.all([current, removed, sibling].map(directory => fs.mkdir(directory)));
    const { host } = fixture({ nativeExecution: { helperRoots: [removed, current], gitCommand: '/usr/bin/git', socketDirectory: null } });
    await fs.rm(removed, { recursive: true });
    const helper = { action: 'helper', command: 'git', args: ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], cwd: current };
    expect((await host.nativeExecution(helper)).receipt.terminated).toBe(true);
    expect(native.runReadOnlySessionExecution).toHaveBeenCalledWith(expect.objectContaining({ logicalDirectory: current,
      env: expect.objectContaining({ GIT_CEILING_DIRECTORIES: root }) }));
    await expect(host.nativeExecution({ ...helper, cwd: removed })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(host.nativeExecution({ ...helper, cwd: sibling })).rejects.toMatchObject({ code: 'native_helper_directory_denied' });
    const { host: noOwner } = fixture({ nativeExecution: { helperRoots: [removed] } });
    await expect(noOwner.nativeExecution(helper)).rejects.toMatchObject({ code: 'native_helper_directory_denied' });
    const file = path.join(root, 'invalid-root'); await fs.writeFile(file, 'owned fixture\n');
    const { host: invalid } = fixture({ nativeExecution: { helperRoots: [current, path.join(file, 'child')] } });
    await expect(invalid.nativeExecution(helper)).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(native.runReadOnlySessionExecution).toHaveBeenCalledTimes(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native Git discovery stays inside the registered project when only an unregistered parent is a repository', async () => {
  const { execFile } = await import('node:child_process');
  const os = await import('node:os');
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  // The supervisor stand-in runs the exact command, arguments, environment and directory with real Git.
  native.runReadOnlySessionExecution.mockImplementation(({ command, args, env, logicalDirectory }) => new Promise((resolve) => {
    execFile(command, args, { cwd: logicalDirectory, env, encoding: 'buffer' }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ receipt: { terminated: true, confined: true, cancelled: false, exitCode }, stdout, stderr });
    });
  }));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-nested-project-')));
  try {
    const parent = path.join(root, 'parent'), nested = path.join(parent, 'workspace', 'project');
    await fs.mkdir(nested, { recursive: true });
    await new Promise((resolve, reject) => execFile('/usr/bin/git', ['init', '--quiet', parent],
      { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root } }, error => error ? reject(error) : resolve()));
    const discovery = { action: 'helper', command: 'git', args: ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'] };
    // Registered nested non-Git folder: discovery never reports the unregistered parent repository.
    const { host } = fixture({ nativeExecution: { helperRoots: [nested], gitCommand: '/usr/bin/git', socketDirectory: null } });
    const scoped = await host.nativeExecution({ ...discovery, cwd: nested });
    expect(scoped.exitCode).not.toBe(0);
    expect(Buffer.from(scoped.stdout, 'base64').toString()).not.toContain(parent);
    expect(native.runReadOnlySessionExecution).toHaveBeenLastCalledWith(expect.objectContaining({ env: expect.objectContaining({ GIT_CEILING_DIRECTORIES: path.dirname(nested) }) }));
    await expect(host.nativeExecution({ ...discovery, cwd: parent })).rejects.toMatchObject({ code: 'native_helper_directory_denied' });
    // A registered repository root keeps full discovery for itself and its nested folders.
    const { host: registered } = fixture({ nativeExecution: { helperRoots: [nested, parent], gitCommand: '/usr/bin/git', socketDirectory: null } });
    for (const cwd of [nested, parent]) {
      const result = await registered.nativeExecution({ ...discovery, cwd });
      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout, 'base64').toString().trim().split('\n').at(-1)).toBe(parent);
    }
    expect(native.runReadOnlySessionExecution).toHaveBeenLastCalledWith(expect.objectContaining({ env: expect.objectContaining({ GIT_CEILING_DIRECTORIES: root }) }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native scans enforce Git exclusions, reject follow traversal and protect nested host roots', async () => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  native.startReadOnlySessionExecution.mockResolvedValue({ child: {}, pid: 200,
    result: Promise.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 0 }) });
  const openCodeClient = createFakeClient();
  const invoke = async (tool, args, nativeOptions = {}) => {
    openCodeClient.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
      turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' }, parts: [{ type: 'tool', callID: input.callID, tool }] });
    const { host } = fixture({ openCodeClient, nativeExecution: { recheckPermit: async () => {}, socketDirectory: null, ...nativeOptions } });
    const specification = { kind: 'read', command: '/fixture/rg', args, cwd: directory };
    try {
      return await host.nativeExecution({ ...input, ...specification, tool, agent: 'build', action: 'start',
        argsDigest: createHash('sha256').update(JSON.stringify(specification)).digest('hex') });
    } finally { await host.drain(); }
  };
  await invoke('glob', ['--no-config', '--files', '--hidden', '--glob=**/.git/**', '.']);
  expect(native.startReadOnlySessionExecution).toHaveBeenLastCalledWith(expect.objectContaining({
    args: ['--no-config', '--files', '--hidden', '--glob=**/.git/**', '--no-ignore', '--iglob=!**/.git', '--iglob=!**/.git/**', '--iglob=!**/node_modules', '--iglob=!**/node_modules/**', '--iglob=!**/.cache', '--iglob=!**/.cache/**', '--iglob=!**/dist', '--iglob=!**/dist/**', '--iglob=!**/.worktrees', '--iglob=!**/.worktrees/**', '--iglob=!**/generated-worktree', '--iglob=!**/generated-worktree/**', '--iglob=!**/generated-worktrees', '--iglob=!**/generated-worktrees/**', '--iglob=!**/worktrees', '--iglob=!**/worktrees/**', '--iglob=!**/.artifacts', '--iglob=!**/.artifacts/**', '.'] }));
  // A pattern named --follow is positional, so remains a legitimate grep.
  await invoke('grep', ['--no-config', '--json', '--hidden', '--glob=**/*', '--', '--follow', '.']);
  expect(native.startReadOnlySessionExecution).toHaveBeenLastCalledWith(expect.objectContaining({
    args: ['--no-config', '--json', '--hidden', '--glob=**/*', '--no-ignore', '--iglob=!**/.git', '--iglob=!**/.git/**', '--iglob=!**/node_modules', '--iglob=!**/node_modules/**', '--iglob=!**/.cache', '--iglob=!**/.cache/**', '--iglob=!**/dist', '--iglob=!**/dist/**', '--iglob=!**/.worktrees', '--iglob=!**/.worktrees/**', '--iglob=!**/generated-worktree', '--iglob=!**/generated-worktree/**', '--iglob=!**/generated-worktrees', '--iglob=!**/generated-worktrees/**', '--iglob=!**/worktrees', '--iglob=!**/worktrees/**', '--iglob=!**/.artifacts', '--iglob=!**/.artifacts/**', '--', '--follow', '.'] }));
  await expect(invoke('glob', ['--no-config', '--files', '--follow', '.'])).rejects.toMatchObject({ code: 'native_read_follow_denied' });
  await expect(invoke('grep', ['--no-config', '--json', '--', 'host', '.'], { protectedRoots: [import.meta.dirname] }))
    .rejects.toMatchObject({ code: 'native_read_root_denied' });
  for (const extra of [['--ignore-file=/outside/ignore'], ['--ignore-file', '/outside/ignore'], ['-g', '**/*'],
    ['--config=/outside/config'], ['--ignore'], ['--pre=/outside/program'], ['--follow']]) {
    await expect(invoke('grep', ['--no-config', '--json', ...extra, '--', 'host', '.'])).rejects.toMatchObject({ status: 403 });
  }
  expect(native.startReadOnlySessionExecution).toHaveBeenCalledTimes(2);
});

test('native scans accept location roots that do not exist yet and still honour missing protected roots', async () => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  native.startReadOnlySessionExecution.mockClear();
  native.startReadOnlySessionExecution.mockResolvedValue({ child: {}, pid: 201,
    result: Promise.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 0 }) });
  // The webfetch scratch root is only created once webfetch saves a binary.
  const webfetch = path.join(os.tmpdir(), `devryan-missing-${process.pid}-${Date.now()}`, 'devryan-webfetch', 'digest');
  let diagnostics = [];
  const invoke = async (tool, args, protectedRoots = []) => {
    const openCodeClient = createFakeClient();
    openCodeClient.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
      turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' }, parts: [{ type: 'tool', callID: input.callID, tool }] });
    const created = fixture({ openCodeClient, nativeExecution: { recheckPermit: async () => {}, socketDirectory: null,
      locations: [{ directory, readRoots: [directory, webfetch], protectedRoots }] } });
    const { host } = created; diagnostics = created.diagnostics;
    const specification = { kind: 'read', command: '/fixture/rg', args, cwd: directory };
    try {
      return await host.nativeExecution({ ...input, ...specification, tool, agent: 'build', action: 'start',
        argsDigest: createHash('sha256').update(JSON.stringify(specification)).digest('hex') });
    } finally { await host.drain(); }
  };
  await invoke('grep', ['--no-config', '--json', '--glob=AGENTS.md', '--', 'commit', '.']);
  await invoke('glob', ['--no-config', '--files', '--glob=scripts/*pending*', '--glob=!**/.*', '--glob=!**/.git/**', '.']);
  expect(native.startReadOnlySessionExecution).toHaveBeenCalledTimes(2);
  // A protected root that does not exist yet still blocks a scan that would contain it.
  await expect(invoke('grep', ['--no-config', '--json', '--', 'host', '.'], [path.join(directory, `missing-protected-${process.pid}`)]))
    .rejects.toMatchObject({ code: 'native_read_root_denied' });
  expect(native.startReadOnlySessionExecution).toHaveBeenCalledTimes(2);
  // The refusal is journaled with its code; OpenCode only reports "ripgrep execution failed".
  expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'session_execution', phase: 'native_read', state: 'failed',
    code: 'native_read_root_denied', tool: 'grep', callID: input.callID }));
});

test('Node helper independently validates pinned VCS info flags before launching a real supervisor', async () => {
  const { nativeVcsGitFlags } = await import('./execution-helper-policy.js');
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  native.runReadOnlySessionExecution.mockResolvedValue({ receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 }, stdout: Buffer.from('main\n'), stderr: Buffer.alloc(0) });
  const { host } = fixture({ nativeExecution: { helperRoots: [directory], gitCommand: '/usr/bin/git', socketDirectory: null } });
  const helper = { action: 'helper', command: 'git', args: [...nativeVcsGitFlags, 'symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: directory };
  await host.nativeExecution(helper);
  expect(native.runReadOnlySessionExecution).toHaveBeenCalledWith(expect.objectContaining({ args: ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...helper.args] }));
  await expect(host.nativeExecution({ ...helper, args: [...nativeVcsGitFlags, 'config', 'init.defaultBranch', 'new'] })).rejects.toMatchObject({ code: 'native_helper_denied' });
  const changed = [...nativeVcsGitFlags]; changed[2] = 'core.fsmonitor=arbitrary';
  await expect(host.nativeExecution({ ...helper, args: [...changed, 'remote'] })).rejects.toMatchObject({ code: 'native_helper_denied' });
  expect(native.runReadOnlySessionExecution).toHaveBeenCalledTimes(1);
  expect(mocks.runtime.reserve).not.toHaveBeenCalled();
});

test('real ledger preserves a committed publication across interrupted materialization and restart', async () => {
  const { createSessionMutationRuntime: createActualRuntime } = await vi.importActual('@devryan/harness-runtime/lib/session-mutations.js');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-publication-recovery-')));
  const project = path.join(root, 'project'), home = path.join(root, 'home'), temporary = path.join(root, 'tmp'), storage = path.join(root, 'ledger');
  await Promise.all([fs.mkdir(project), fs.mkdir(home), fs.mkdir(temporary)]);
  await fs.writeFile(path.join(temporary, 'package.json'), '{"type":"commonjs"}\n');
  for (const [name, value] of Object.entries({ HOME: home, TMPDIR: temporary, GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })) vi.stubEnv(name, value);
  await fs.writeFile(path.join(home, 'gitconfig'), '');
  const runtime = createActualRuntime({ directory: storage, onMaterialize: () => { throw new Error('fixture materialization interruption'); } });
  let reopened;
  try {
    await fs.writeFile(path.join(project, 'recover.txt'), 'old\n');
    // This is a ledger-only regression. It does not claim a process, invent a
    // termination receipt, or count as native tool acceptance.
    const lease = await runtime.begin({ directory: project, sessionID: 'ses_recovery', userMessageID: 'msg_user_recovery',
      messageID: 'msg_assistant_recovery', callID: 'call_recovery', tool: 'write', kind: 'process' });
    expect(lease.executionKind).toBeUndefined();
    await fs.writeFile(path.join(lease.viewDirectory, 'recover.txt'), 'new\n');
    await expect(runtime.finish({ directory: project, token: lease.token })).rejects.toThrow('fixture materialization interruption');
    expect(await fs.readFile(path.join(project, 'recover.txt'), 'utf8')).toBe('old\n');
    reopened = createActualRuntime({ directory: storage });
    const recovered = await reopened.leaseForCall({ directory: project, sessionID: 'ses_recovery', callID: 'call_recovery' });
    expect(recovered.state).toBe('published'); expect(recovered.result.operationID).toBeTruthy();
    expect(await fs.readFile(path.join(project, 'recover.txt'), 'utf8')).toBe('new\n');
    expect(await reopened.finish({ directory: project, token: lease.token })).toEqual(recovered.result);
    expect(await reopened.finish({ directory: project, token: lease.token })).toEqual(recovered.result);
    await expect(reopened.cancelLease({ directory: project, token: lease.token })).rejects.toMatchObject({ code: 'execution_already_published' });
  } finally {
    await Promise.allSettled([runtime.drain(), reopened?.drain()]);
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000); // Real Git publication and restart, not a unit-test latency bound.

test('native Council owns the exact reviewed control call and registers its canonical managed child', async () => {
  const f = nativeManagedFixture();
  f.invocation.tool = 'council_session'; f.invocation.input = { prompt: 'Compare designs', preset: 'default' };
  f.invocation.authorization.input.provenance.id = 'devryan.council';
  f.message.parts[0].tool = 'council_session';
  expect((await f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation })).lease).toBe(f.lease);
  expect(mocks.runtime.begin).toHaveBeenCalledWith(expect.objectContaining({ tool: 'council_session', kind: 'control', userMessageID: 'msg_user' }));
  await f.host.nativeManagedControl({ action: 'finish', invocation: f.invocation, token: f.lease.token });
  f.lease.state = 'published';
  f.recheck.mockRejectedValue(Error('completed tool permit released'));
  const child = { directory, sessionID: 'ses_child', parentID: input.sessionID, parentCallID: input.callID };
  expect(await f.host.nativeManagedChild(child)).toEqual({ parentGeneration: 1 });
  expect(mocks.runtime.registerChild).toHaveBeenCalledWith(child);
  f.message.turnOwnership.userMessageID = 'msg_foreign';
  await expect(f.host.nativeManagedChild(child)).rejects.toMatchObject({ code: 'invalid_session_lineage' });
  expect(mocks.runtime.registerChild).toHaveBeenCalledTimes(1);
});

test.each([
  ['council_session', 'devryan.managed-task'], ['devryan_task', 'devryan.council'], ['council_session', 'unknown'],
])('native control refuses mismatched reviewed tool %s/plugin %s before ledger effects', async (tool, pluginID) => {
  const f = nativeManagedFixture(); f.invocation.tool = tool; f.invocation.authorization.input.provenance.id = pluginID;
  await expect(Promise.resolve().then(() => f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation })))
    .rejects.toMatchObject({ code: 'invalid_capture_identity' });
  expect(mocks.runtime.begin).not.toHaveBeenCalled(); expect(mocks.runtime.claimLease).not.toHaveBeenCalled();
});

test('Slim webfetch control requires the exact constructor-reviewed origin and canonical control lease', async () => {
  const f = nativeManagedFixture();
  const origin = { kind: 'plugin', id: 'devryan.slim', manifestDigest: 'a'.repeat(64), capabilities: ['read', 'write', 'process', 'network'] };
  const { host } = fixture({ openCodeClient: f.client, nativeExecution: { isReady: f.isReady, recheckPermit: f.recheck, reviewedAstOrigin: origin } });
  f.message.parts[0].tool = 'webfetch';
  const invocation = { ...f.invocation, tool: 'webfetch', input: { url: 'https://fixture.invalid', format: 'markdown' },
    authorization: { input: { toolID: 'webfetch', provenance: origin } } };
  for (const altered of [
    { ...invocation, authorization: { input: { toolID: 'webfetch', provenance: { ...origin, manifestDigest: 'b'.repeat(64) } } } },
    { ...invocation, authorization: { input: { toolID: 'webfetch', provenance: { ...origin, capabilities: ['network'] } } } },
    { ...invocation, authorization: { input: { toolID: 'webfetch', nativeToolID: 'webfetch', provenance: origin } } },
    { ...invocation, tool: 'other' },
  ]) await expect(host.nativeExecution({ ...altered, action: 'control-begin' })).rejects.toMatchObject({ code: 'native_control_origin_denied' });
  expect(mocks.runtime.begin).not.toHaveBeenCalled();
  const begun = await host.nativeExecution({ ...invocation, action: 'control-begin' });
  expect(begun).toEqual({ lease: f.lease });
  expect(mocks.runtime.begin).toHaveBeenCalledWith(expect.objectContaining({ tool: 'webfetch', kind: 'control', userMessageID: 'msg_user' }));
  expect(await host.nativeExecution({ ...invocation, action: 'control-finish', token: f.lease.token }))
    .toEqual({ files: [], operationID: 'published_1' });
  await host.drain();
});

test('native question control keeps exact provenance, permit rechecks and cancellation cleanup', async () => {
  const f = nativeManagedFixture();
  f.message.parts[0].tool = 'question';
  const origin = { kind: 'native', id: 'opencode.tool.question', manifestDigest: 'a'.repeat(64), capabilities: ['control'] };
  const invocation = { ...f.invocation, tool: 'question', input: { questions: [{ question: 'Choose', options: [] }] },
    authorization: { input: { toolID: 'question', provenance: origin } } };
  for (const altered of [
    { ...invocation, authorization: { input: { toolID: 'question', provenance: { ...origin, kind: 'plugin' } } } },
    { ...invocation, authorization: { input: { toolID: 'question', provenance: { ...origin, id: 'opencode.tool.read' } } } },
    { ...invocation, authorization: { input: { toolID: 'question', provenance: { ...origin, capabilities: ['write'] } } } },
    { ...invocation, authorization: { input: { toolID: 'question', nativeToolID: 'question', provenance: origin } } },
    { ...invocation, tool: 'read' },
  ]) await expect(f.host.nativeExecution({ ...altered, action: 'control-begin' })).rejects.toMatchObject({ code: 'native_control_origin_denied' });
  expect(mocks.runtime.begin).not.toHaveBeenCalled();
  expect(await f.host.nativeExecution({ ...invocation, action: 'control-begin' })).toEqual({ lease: f.lease });
  expect(mocks.runtime.begin).toHaveBeenCalledWith(expect.objectContaining({ tool: 'question', kind: 'control', userMessageID: 'msg_user' }));
  f.recheck.mockRejectedValue(Object.assign(Error('retired question'), { code: 'native_permit_invalid' }));
  await expect(f.host.nativeExecution({ ...invocation, action: 'control-finish', token: f.lease.token })).rejects.toMatchObject({ code: 'native_permit_invalid' });
  expect(mocks.runtime.finish).not.toHaveBeenCalled();
  expect(mocks.runtime.cancelLease).toHaveBeenCalledWith({ directory, token: f.lease.token });
  expect(mocks.runtime.cleanupLease).toHaveBeenCalledWith(f.lease);
  await f.host.drain();
});

test('an answered native question finishes its canonical control lease', async () => {
  const f = nativeManagedFixture();
  f.message.parts[0].tool = 'question';
  const invocation = { ...f.invocation, tool: 'question', input: { questions: [] },
    authorization: { input: { toolID: 'question', provenance: { kind: 'native', id: 'opencode.tool.question',
      manifestDigest: 'a'.repeat(64), capabilities: ['control'] } } } };
  await f.host.nativeExecution({ ...invocation, action: 'control-begin' });
  expect(await f.host.nativeExecution({ ...invocation, action: 'control-finish', token: f.lease.token }))
    .toEqual({ files: [], operationID: 'published_1' });
  expect(f.recheck).toHaveBeenCalled();
  expect(mocks.runtime.cancelLease).not.toHaveBeenCalled();
  await f.host.drain();
});

async function browserHostFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'browser-host-')));
  const binaryPath = path.join(root, 'browser'), configPath = path.join(root, 'config.json');
  await fs.writeFile(binaryPath, 'owned fixture executable', { mode: 0o700 }); await fs.writeFile(configPath, '{}');
  const reviewedBrowser = { binaryPath, sha256: createHash('sha256').update('owned fixture executable').digest('hex'),
    configPath, configSha256: createHash('sha256').update('{}').digest('hex') };
  const origin = { kind: 'plugin', id: 'devryan.browser', manifestDigest: 'a'.repeat(64), capabilities: ['process'] };
  const client = createFakeClient();
  client.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' }, parts: [{ type: 'tool', callID: input.callID, tool: 'devryan_browser' }] });
  const lease = { token: 'browser_lease', ownerID: 'owner_fixture', directory, projectDirectory: directory,
    viewDirectory: path.join(root, 'worktree'), workingDirectory: path.join(root, 'worktree'), scope: { ...input, tool: 'devryan_browser' }, state: 'ready' };
  mocks.runtime.reserve.mockResolvedValue(lease); mocks.runtime.prepare.mockResolvedValue(lease);
  mocks.runtime.cancelLease = vi.fn(async () => {}); mocks.runtime.cancelUnstartedCall = vi.fn(async () => {});
  mocks.runtime.finish.mockResolvedValue({ files: [] });
  const specification = { kind: 'writer', tool: 'devryan_browser', input: { command: 'snapshot' } };
  const invocation = { ...input, ...specification, action: 'start', agent: 'build',
    authorization: { input: { provenance: origin } }, argsDigest: createHash('sha256').update(JSON.stringify(specification)).digest('hex') };
  return { root, lease, origin, reviewedBrowser, invocation, client };
}

test('browser worker privately binds canonical user scope, waits lease callbacks and real termination before publication', async () => {
  const f = await browserHostFixture(); let host;
  mocks.runtime.finish.mockResolvedValue({ files: [{ path: '.devryan-browser/owned.png', status: 'added' }] });
  try {
    const native = await import('@devryan/harness-runtime/lib/session-execution.js');
    const operation = Promise.withResolvers(), entered = Promise.withResolvers(), terminated = Promise.withResolvers();
    const browserOperation = vi.fn(async (invocation, event) => {
      expect(invocation).toMatchObject({ userMessageID: 'msg_user', token: f.lease.token });
      expect(event.scope).toEqual({ opencodeSessionID: input.sessionID, messageID: 'msg_user', directory, agent: 'build' });
      entered.resolve(); return operation.promise;
    });
    const replies = []; let worker;
    native.startSessionExecution.mockImplementation(async ({ onOutput, input: workerInput, socketDirectory }) => {
      expect(socketDirectory).toBe(path.join(path.dirname(f.lease.viewDirectory), 'scratch', 's'));
      worker = JSON.parse(workerInput);
      onOutput({ stream: 'stdout', data: Buffer.from(JSON.stringify({ type: 'browser', id: 'request_1', operation: 'acquire',
        scope: { opencodeSessionID: input.sessionID, messageID: 'msg_user', directory, agent: 'build' } }) + '\n') });
      return { pid: 200, result: terminated.promise, child: { stdin: { write(line, callback) {
        const reply = JSON.parse(line);
        if (reply.type === 'browser') { replies.push(reply); onOutput({ stream: 'stdout', data: Buffer.from(JSON.stringify({ type: 'result', ok: true, result: { content: 'Original snapshot' } }) + '\n') }); }
        callback?.();
      } } } };
    });
    ({ host } = fixture({ openCodeClient: f.client, nativeExecution: { workerCommand: '/fixture/bun', workerArgs: ['worker.ts'],
      isReady: async () => true, recheckPermit: async () => {}, reviewedBrowserOrigin: f.origin, getReviewedBrowser: async () => f.reviewedBrowser,
      browserOperation, socketDirectory: null, workerBrowsers: false } }));
    const started = await host.nativeExecution(f.invocation); await entered.promise;
    expect(worker.reviewedBrowser).toEqual(f.reviewedBrowser); expect(worker.context.userMessageID).toBe('msg_user');
    expect(worker.browserSocketDirectory).toBe(path.join(path.dirname(f.lease.viewDirectory), 'scratch', 's'));
    expect(mocks.runtime.finish).not.toHaveBeenCalled();
    terminated.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 0 });
    await Promise.resolve(); expect(mocks.runtime.finish).not.toHaveBeenCalled();
    operation.resolve({ leaseId: 'lease_exact', wsUrl: 'ws://127.0.0.1:1234/private' });
    let batch, cursor = 0;
    do { batch = await host.nativeExecution({ action: 'read', handle: started.handle, cursor }); cursor = batch.cursor; } while (!batch.done);
    expect(replies).toEqual([{ type: 'browser', id: 'request_1', ok: true, result: { leaseId: 'lease_exact', wsUrl: 'ws://127.0.0.1:1234/private' } }]);
    expect(mocks.runtime.finish).toHaveBeenCalledTimes(1); expect(mocks.runtime.cancelLease).not.toHaveBeenCalled();
    expect(batch.events.at(-1)).toMatchObject({ type: 'settled', ok: true, result: { metadata: { browserArtifacts: [path.join(directory, '.devryan-browser/owned.png')] } } });
    expect(batch.events.at(-1).result.content).toContain(path.join(directory, '.devryan-browser/owned.png'));
  } finally { if (host) await host.drain(); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('browser worker refuses caller assets and forged scope without publishing the private view', async () => {
  const f = await browserHostFixture(); let host;
  try {
    const native = await import('@devryan/harness-runtime/lib/session-execution.js');
    const callback = vi.fn(); const receipt = { terminated: true, confined: true, cancelled: true, exitCode: 137 };
    native.startSessionExecution.mockImplementation(async ({ onOutput }) => {
      onOutput({ stream: 'stdout', data: Buffer.from(JSON.stringify({ type: 'browser', id: 'request_forged', operation: 'acquire',
        scope: { opencodeSessionID: input.sessionID, messageID: 'msg_assistant', directory, agent: 'build' } }) + '\n') });
      return { pid: 200, result: Promise.resolve(receipt), child: { stdin: { write: vi.fn() } } };
    });
    ({ host } = fixture({ openCodeClient: f.client, nativeExecution: { workerCommand: '/fixture/bun', workerArgs: ['worker.ts'],
      isReady: async () => true, recheckPermit: async () => {}, reviewedBrowserOrigin: f.origin, getReviewedBrowser: async () => f.reviewedBrowser,
      browserOperation: callback, socketDirectory: null, workerBrowsers: false } }));
    for (const extra of [{ reviewedBrowser: f.reviewedBrowser }, { browserSocketDirectory: '/forged/socket' }, { userMessageID: 'msg_user' },
      { authorization: { input: { provenance: { ...f.origin, manifestDigest: 'b'.repeat(64) } } } }]) {
      await expect(host.nativeExecution({ ...f.invocation, ...extra })).rejects.toMatchObject({ code: extra.authorization ? 'native_browser_registration_required' : 'native_browser_caller_asset_denied' });
    }
    expect(mocks.runtime.reserve).not.toHaveBeenCalled();
    const started = await host.nativeExecution(f.invocation);
    let batch, cursor = 0;
    do { batch = await host.nativeExecution({ action: 'read', handle: started.handle, cursor }); cursor = batch.cursor; } while (!batch.done);
    expect(batch.events.at(-1)).toMatchObject({ type: 'settled', ok: false, receipt });
    expect(callback).not.toHaveBeenCalled(); expect(mocks.runtime.cancelLease).toHaveBeenCalledTimes(1); expect(mocks.runtime.finish).not.toHaveBeenCalled();
  } finally { if (host) await host.drain(); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('document control requires the exact constructor-reviewed registration and canonical lease', async () => {
  const f = nativeManagedFixture();
  const origin = { kind: 'plugin', id: 'devryan.document-reader', manifestDigest: 'a'.repeat(64), capabilities: ['read', 'control'] };
  const { host } = fixture({ openCodeClient: f.client, nativeExecution: { isReady: f.isReady, recheckPermit: f.recheck, reviewedDocumentOrigin: origin } });
  f.message.parts[0].tool = 'devryan_document';
  const invocation = { ...f.invocation, tool: 'devryan_document', input: { action: 'list' },
    authorization: { input: { toolID: 'devryan_document', provenance: origin } } };
  for (const altered of [
    { ...invocation, authorization: { input: { toolID: 'devryan_document', provenance: { ...origin, manifestDigest: 'b'.repeat(64) } } } },
    { ...invocation, authorization: { input: { toolID: 'devryan_document', provenance: { ...origin, capabilities: ['read'] } } } },
    { ...invocation, authorization: { input: { toolID: 'devryan_document', nativeToolID: 'devryan_document', provenance: origin } } },
    { ...invocation, tool: 'other' },
  ]) await expect(host.nativeExecution({ ...altered, action: 'control-begin' })).rejects.toMatchObject({ code: 'native_control_origin_denied' });
  expect(mocks.runtime.begin).not.toHaveBeenCalled();
  expect(await host.nativeExecution({ ...invocation, action: 'control-begin' })).toEqual({ lease: f.lease });
  expect(mocks.runtime.begin).toHaveBeenCalledWith(expect.objectContaining({ tool: 'devryan_document', kind: 'control', userMessageID: 'msg_user' }));
  expect(await host.nativeExecution({ ...invocation, action: 'control-finish', token: f.lease.token })).toEqual({ files: [], operationID: 'published_1' });
  await host.drain();
});

test('native image launch requires the exact constructor-reviewed original registration and transport owner', async () => {
  const reviewedImagegenOrigin = { kind: 'plugin', id: 'opencode-gpt-imagegen', manifestDigest: 'a'.repeat(64), capabilities: ['read', 'write', 'process', 'network'] };
  const { host } = fixture({ nativeExecution: { recheckPermit: async () => {}, reviewedImagegenOrigin, imageGeneration: async () => ({ base64: '' }) } });
  for (const provenance of [undefined, { ...reviewedImagegenOrigin, kind: 'native' }, { ...reviewedImagegenOrigin, id: 'gpt_imagegen' },
    { ...reviewedImagegenOrigin, manifestDigest: 'f'.repeat(64) }, { ...reviewedImagegenOrigin, capabilities: ['network'] }]) {
    await expect(host.nativeExecution({ ...input, action: 'start', kind: 'writer', tool: 'gpt_imagegen', agent: 'build',
      authorization: { input: { provenance } } })).rejects.toMatchObject({ code: 'native_imagegen_registration_required' });
  }
  const unavailable = fixture({ nativeExecution: { recheckPermit: async () => {}, reviewedImagegenOrigin } }).host;
  await expect(unavailable.nativeExecution({ ...input, action: 'start', kind: 'writer', tool: 'gpt_imagegen', agent: 'build',
    authorization: { input: { provenance: reviewedImagegenOrigin } } })).rejects.toMatchObject({ code: 'native_imagegen_owner_unavailable' });
  expect(mocks.runtime.reserve).not.toHaveBeenCalled();
});

test('controller settlement joins a helper paused before handle acquisition and fences its old lifetime', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const realpath = fs.realpath.bind(fs);
  vi.spyOn(fs, 'realpath').mockImplementationOnce(async file => {
    entered.resolve(); await release.promise; return realpath(file);
  });
  const { host } = fixture({ nativeExecution: { helperRoots: [directory] } });
  const helper = { action: 'helper', command: '/usr/bin/git', args: ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], cwd: directory };
  const old = host.nativeExecution(helper);
  const refusal = expect(old).rejects.toMatchObject({ code: 'execution_cancelled' });
  try {
    await entered.promise;
    let settled = false; const settling = host.settleController().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await expect(host.nativeExecution(helper)).rejects.toMatchObject({ code: 'execution_cancelled' });
    release.resolve(); await refusal; await settling;
    expect(runReadOnlySessionExecution).not.toHaveBeenCalled();
    runReadOnlySessionExecution.mockResolvedValue({ receipt: { exitCode: 0 }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    await expect(host.nativeExecution(helper)).resolves.toMatchObject({ exitCode: 0 });
    expect(runReadOnlySessionExecution).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); vi.restoreAllMocks(); await host.drain(); }
});

test('controller exit concurrent with final drain joins terminal settlement without reopening acquisitions', async () => {
  const release = Promise.withResolvers(); mocks.runtime.drain.mockReturnValue(release.promise);
  const { host } = fixture({ nativeExecution: { helperRoots: [directory] } });
  const final = host.drain();
  expect(host.settleController()).toBe(final);
  await expect(host.nativeExecution({ action: 'helper' })).rejects.toMatchObject({ code: 'execution_cancelled' });
  release.resolve([]); await Promise.all([final, host.settleController()]);
  expect(host.drain()).toBe(final);
  await expect(host.nativeExecution({ action: 'helper' })).rejects.toMatchObject({ code: 'execution_cancelled' });
});

test('failed controller settlement retains the old acquisition fence', async () => {
  const uncertain = Object.assign(Error('owned_termination_unconfirmed'), { code: 'owned_termination_unconfirmed' });
  mocks.runtime.drain.mockRejectedValue(uncertain);
  const { host } = fixture();
  const settling = host.settleController();
  await expect(settling).rejects.toBe(uncertain);
  expect(host.settleController()).toBe(settling);
  await expect(host.nativeExecution({ action: 'helper' })).rejects.toMatchObject({ code: 'execution_cancelled' });
  await expect(host.drain()).rejects.toBe(uncertain);
});

test('a helper missing its actual termination receipt fences replacement even after its handle disappears', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const uncertain = Object.assign(Error('mutation_termination_unconfirmed'), { code: 'mutation_termination_unconfirmed' });
  runReadOnlySessionExecution.mockImplementation(async () => { entered.resolve(); await release.promise; throw uncertain; });
  const { host } = fixture({ nativeExecution: { helperRoots: [directory] } });
  const old = host.nativeExecution({ action: 'helper', command: '/usr/bin/git', args: ['remote', 'get-url', 'origin'], cwd: directory });
  const refusal = expect(old).rejects.toBe(uncertain);
  await entered.promise;
  const settling = host.settleController(); const rejected = expect(settling).rejects.toBe(uncertain);
  release.resolve(); await refusal; await rejected;
  expect(host.settleController()).toBe(settling);
  await expect(host.nativeExecution({ action: 'helper' })).rejects.toMatchObject({ code: 'execution_cancelled' });
  await expect(host.drain()).rejects.toBe(uncertain);
});


test.each(['read', 'glob', 'grep', 'skill'])('native direct %s receipt verifies canonical ownership and preserves the ledger fence', async tool => {
  const client = createFakeClient();
  client.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    parts: [{ type: 'tool', callID: input.callID, tool }], turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' } });
  const recheck = vi.fn(async () => {}); const { host, recordReceipt } = fixture({ openCodeClient: client, nativeExecution: { recheckPermit: recheck } });
  const call = { ...input, tool };
  const admitted = await host.nativeExecution({ ...call, action: 'direct-admit' });
  expect(admitted).toMatchObject({ generation: 7, token: expect.any(String) });
  expect(await host.nativeExecution({ ...call, ...admitted, action: 'direct-finish' })).toEqual({ files: [] });
  expect(recheck).toHaveBeenCalled(); expect(mocks.runtime.reserve).not.toHaveBeenCalled();
  expect(recordReceipt).not.toHaveBeenCalled();
  mocks.runtime.finishDirect.mockRejectedValue(Object.assign(Error('cancelled'), { code: 'execution_cancelled' }));
  await expect(host.nativeExecution({ ...call, ...admitted, action: 'direct-finish' })).rejects.toMatchObject({ code: 'execution_cancelled' });
});

test('native direct read binds effects to the independently reviewed registration', async () => {
  const client = createFakeClient();
  client.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    parts: [{ type: 'tool', callID: input.callID, tool: 'read' }], turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' } });
  const origin = { kind: 'native', id: 'opencode.tool.read', manifestDigest: 'a'.repeat(64), capabilities: ['read'] };
  const { host } = fixture({ openCodeClient: client, nativeExecution: { recheckPermit: async () => {}, reviewedToolOrigins: [origin] } });
  const call = { ...input, tool: 'read', authorization: { input: { toolID: 'read', callID: input.callID, provenance: origin } } };
  const admitted = await host.nativeExecution({ ...call, action: 'direct-admit' });
  await host.nativeExecution({ ...call, ...admitted, action: 'direct-finish' });
  expect(mocks.runtime.finishDirect).toHaveBeenLastCalledWith(expect.objectContaining({ effect: { tool: 'read', origin, reviewedOrigin: origin } }));
  const forged = { ...origin, manifestDigest: 'b'.repeat(64) };
  const next = { ...call, authorization: { input: { toolID: 'read', callID: input.callID, provenance: forged } } };
  const again = await host.nativeExecution({ ...next, action: 'direct-admit' });
  await host.nativeExecution({ ...next, ...again, action: 'direct-finish' });
  expect(mocks.runtime.finishDirect.mock.lastCall[0].effect).toBeUndefined();
});

test('native direct admission resolves a committed provisional boundary before executing', async () => {
  const client = createFakeClient();
  client.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    parts: [{ type: 'tool', callID: input.callID, tool: 'read' }], turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' } });
  const recover = vi.fn(async () => true);
  const { host } = fixture({ openCodeClient: client, nativeExecution: { recheckPermit: async () => {}, recoverPromptBoundary: recover } });
  mocks.runtime.admitDirect.mockRejectedValueOnce(Object.assign(Error('uncommitted'), { code: 'prompt_boundary_uncommitted' }));
  await host.nativeExecution({ ...input, tool: 'read', action: 'direct-admit' });
  expect(recover).toHaveBeenCalledWith({ directory, sessionID: input.sessionID, userMessageID: 'msg_user' });
  expect(mocks.runtime.admitDirect).toHaveBeenCalledTimes(2);
});

test('native direct admissions and finishes are journaled like plugin ones without changing their failures', async () => {
  const client = createFakeClient();
  client.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    parts: [{ type: 'tool', callID: input.callID, tool: 'read' }], turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' } });
  const { host, diagnostics } = fixture({ openCodeClient: client, nativeExecution: { recheckPermit: async () => {} }, admissionSummaryMinMs: 0 });
  const call = { ...input, tool: 'read' };
  const admitted = await host.nativeExecution({ ...call, action: 'direct-admit' });
  expect(await host.nativeExecution({ ...call, ...admitted, action: 'direct-finish' })).toEqual({ files: [] });
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'session_execution', phase: 'direct_admit', state: 'completed', sessionID: input.sessionID,
      callID: input.callID, executionTier: 'direct', steps: expect.stringContaining('direct_admission:1/') }),
    expect.objectContaining({ event: 'session_execution', phase: 'direct_finish', state: 'completed', sessionID: input.sessionID,
      callID: input.callID, executionTier: 'direct', steps: expect.stringMatching(/tool_execution:1\/\d+.*direct_receipt:1\//) }),
  ]));
  // A lock timeout reaches the controller with its original code, as before.
  const lockTimeout = Object.assign(Error('lock'), { code: 'LOCK_TIMEOUT' });
  mocks.runtime.finishDirect.mockRejectedValue(lockTimeout);
  await expect(host.nativeExecution({ ...call, ...admitted, action: 'direct-finish' })).rejects.toBe(lockTimeout);
  expect(diagnostics.at(-1)).toMatchObject({ phase: 'direct_finish', state: 'failed' });
});

test('a direct finish reuses its own admission identities once; anything else reads them again', async () => {
  const client = createFakeClient();
  client.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    parts: [{ type: 'tool', callID: input.callID, tool: 'grep' }], turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' } });
  const { host } = fixture({ openCodeClient: client, nativeExecution: { recheckPermit: async () => {} } });
  const call = { ...input, tool: 'grep' };
  const admitted = await host.nativeExecution({ ...call, action: 'direct-admit' });
  const reads = () => [client.sessions.get.mock.calls.length, client.sessions.message.mock.calls.length];
  const before = reads();
  expect(await host.nativeExecution({ ...call, ...admitted, action: 'direct-finish' })).toEqual({ files: [] });
  expect(reads()).toEqual(before);
  expect(mocks.runtime.finishDirect).toHaveBeenLastCalledWith(expect.objectContaining({ userMessageID: 'msg_user', callID: input.callID }));
  // The admission is consumed: a retry with the same token verifies again.
  await host.nativeExecution({ ...call, ...admitted, action: 'direct-finish' });
  expect(reads()).toEqual([before[0] + 1, before[1] + 1]);
  // A finish naming another call never borrows this admission.
  const other = await host.nativeExecution({ ...call, action: 'direct-admit' });
  const counted = reads();
  await expect(host.nativeExecution({ ...call, ...other, callID: 'call_other', action: 'direct-finish' })).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  expect(reads()).toEqual([counted[0] + 1, counted[1] + 1]);
});

test('ledger lock timings reach the host observer', () => {
  const timings = [];
  fixture({ onLockTiming: (timing) => timings.push(timing) });
  mocks.runtimeOptions.onLockTiming({ operation: 'registerNativeSession', sessionID: 'ses_test', queueMs: 1, waitMs: 2, holdMs: 3, wrote: true, failed: false });
  expect(timings).toEqual([{ operation: 'registerNativeSession', sessionID: 'ses_test', queueMs: 1, waitMs: 2, holdMs: 3, wrote: true, failed: false }]);
  fixture({ onLockTiming: () => { throw new Error('observer failure'); } });
  expect(() => mocks.runtimeOptions.onLockTiming({ operation: 'ledger' })).not.toThrow();
});

test('native direct receipts reject foreign canonical parents and writers before admission', async () => {
  const client = createFakeClient();
  const record = { info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' }, parts: [{ type: 'tool', callID: input.callID, tool: 'skill' }],
    turnOwnership: { source: 'native-sequence', userMessageID: 'msg_foreign' } };
  client.sessions.message.mockResolvedValue(record);
  const { host } = fixture({ openCodeClient: client, nativeExecution: { recheckPermit: async () => {} } });
  await expect(host.nativeExecution({ ...input, action: 'direct-admit' })).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  record.turnOwnership.userMessageID = 'msg_user'; record.parts[0].tool = 'bash';
  await expect(host.nativeExecution({ ...input, tool: 'bash', action: 'direct-admit' })).rejects.toMatchObject({ code: 'invalid_capture_identity' });
  expect(mocks.runtime.admitDirect).not.toHaveBeenCalled();
});

test('native control result returns before deferred view removal, and drain waits for it', async () => {
  const f = nativeManagedFixture(); let remove;
  mocks.runtime.cleanupLease.mockImplementation(() => new Promise(resolve => { remove = resolve; }));
  await f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation });
  await f.host.nativeManagedControl({ action: 'finish', invocation: f.invocation, token: f.lease.token });
  let drained = false; const drain = f.host.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
  remove(); await drain; expect(drained).toBe(true);
});

test.each(['execution_cancelled', 'execution_reverted'])('native control completion preserves %s and publishes no false receipt', async code => {
  const f = nativeManagedFixture(); mocks.runtime.finish.mockRejectedValue(Object.assign(Error(code), { code }));
  await expect(f.host.nativeManagedControl({ action: 'finish', invocation: f.invocation, token: f.lease.token })).rejects.toMatchObject({ code });
  expect(f.host).toBeDefined(); expect(mocks.runtime.executionReceipt).not.toHaveBeenCalled();
});

test('a finish refused after the tool permit retired cancels and cleans the exact ready control lease', async () => {
  const f = nativeManagedFixture();
  await f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation });
  f.recheck.mockRejectedValue(Object.assign(Error('retired'), { code: 'native_permit_invalid' }));
  await expect(f.host.nativeManagedControl({ action: 'finish', invocation: f.invocation, token: f.lease.token }))
    .rejects.toMatchObject({ code: 'native_permit_invalid' });
  expect(mocks.runtime.finish).not.toHaveBeenCalled();
  expect(mocks.runtime.leaseForCall).toHaveBeenCalledWith({ directory, sessionID: input.sessionID, callID: input.callID });
  expect(mocks.runtime.cancelLease).toHaveBeenCalledWith({ directory, token: f.lease.token });
  expect(mocks.runtime.cleanupLease).toHaveBeenCalledWith(f.lease);
});

test.each([
  ['another token', f => ({ token: 'control_other' })], ['a published lease', () => ({ state: 'published' })],
  ['a process lease', () => ({ executionKind: 'process', preparation: undefined })],
  ['another message', f => ({ scope: { ...f.lease.scope, messageID: 'msg_other' } })],
])('a failed finish leaves %s untouched', async (_label, change) => {
  const f = nativeManagedFixture();
  mocks.runtime.leaseForCall.mockResolvedValue({ ...f.lease, ...change(f) });
  f.recheck.mockRejectedValue(Object.assign(Error('retired'), { code: 'native_permit_invalid' }));
  await expect(f.host.nativeManagedControl({ action: 'finish', invocation: f.invocation, token: f.lease.token }))
    .rejects.toMatchObject({ code: 'native_permit_invalid' });
  expect(mocks.runtime.cancelLease).not.toHaveBeenCalled();
  expect(mocks.runtime.cleanupLease).not.toHaveBeenCalled();
});

test('a failed settlement never replaces the finish failure', async () => {
  const f = nativeManagedFixture();
  f.recheck.mockRejectedValue(Object.assign(Error('retired'), { code: 'native_permit_invalid' }));
  mocks.runtime.cancelLease.mockRejectedValue(Object.assign(Error('locked'), { code: 'LOCK_TIMEOUT' }));
  await expect(f.host.nativeManagedControl({ action: 'finish', invocation: f.invocation, token: f.lease.token }))
    .rejects.toMatchObject({ code: 'native_permit_invalid' });
});

test('read-only execution receives only the host-owned Windows storage authority', async () => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  const windowsOwner = { ensureDirectory: vi.fn(), createDirectory: vi.fn() };
  const callerOwner = { ensureDirectory: vi.fn() };
  native.startReadOnlySessionExecution.mockResolvedValue({ child: {}, result: Promise.resolve({ confined: true }) });
  const { host } = fixture({ windowsOwner });
  await host.startReadOnly({ command: '/fixture/command', windowsOwner: callerOwner });
  expect(native.startReadOnlySessionExecution).toHaveBeenCalledWith(expect.objectContaining({ windowsOwner }));
  expect(mocks.runtimeOptions.windowsOwner).toBe(windowsOwner);
});

test.each(['limited', 'unconfined', 'unterminated', 'user-abort', 'overflow'])('native bounded grep %s preserves complete records and authoritative termination', async outcome => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  const client = createFakeClient(), controller = new AbortController();
  client.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' }, parts: [{ type: 'tool', callID: input.callID, tool: 'grep' }] });
  let launchSignal;
  native.startReadOnlySessionExecution.mockImplementation(async ({ onOutput, signal }) => {
    launchSignal = signal;
    const records = Array.from({ length: 250 }, () => JSON.stringify({ type: 'match', data: {} }) + '\n').join('');
    onOutput({ stream: 'stdout', data: Buffer.from(records) });
    if (outcome === 'user-abort') controller.abort(new Error('user stop'));
    return { child: {}, pid: 42, result: Promise.resolve({ terminated: outcome !== 'unterminated', confined: outcome !== 'unconfined', cancelled: true, exitCode: 137 }) };
  });
  const { host } = fixture({ openCodeClient: client, nativeExecution: { recheckPermit: async () => {}, socketDirectory: null,
    ...(outcome === 'overflow' ? { maxEventBytes: 32 } : {}) } });
  const specification = { kind: 'read', command: '/fixture/rg', args: ['--no-config', '--json', '--', 'fixture', '.'], cwd: directory };
  try {
    const { handle } = await host.nativeExecution({ ...input, ...specification, tool: 'grep', agent: 'build', action: 'start',
      argsDigest: createHash('sha256').update(JSON.stringify(specification)).digest('hex') }, { signal: controller.signal });
    let cursor = 0, batch; const events = [];
    do { batch = await host.nativeExecution({ action: 'read', handle, cursor }); cursor = batch.cursor; events.push(...batch.events); } while (!batch.done);
    expect(launchSignal.aborted).toBe(true);
    const terminal = events.at(-1);
    expect(terminal.ok).toBe(outcome === 'limited');
    if (outcome === 'limited') {
      expect(terminal).toMatchObject({ truncated: true, receipt: { cancelled: true, exitCode: 137 }, truncation: { returnedRecords: 200 } });
      const stdout = events.filter(event => event.type === 'output').map(event => Buffer.from(event.data, 'base64').toString()).join('');
      expect(stdout.trim().split('\n').map(line => JSON.parse(line))).toHaveLength(200);
    }
  } finally { await host.drain(); }
});

test('default scan exclusions cannot be widened by globs, but exact canonical generated/dependency scopes expand', async () => {
  const native = await import('@devryan/harness-runtime/lib/session-execution.js');
  native.startReadOnlySessionExecution.mockResolvedValue({ child: {}, pid: 42,
    result: Promise.resolve({ terminated: true, confined: true, cancelled: false, exitCode: 0 }) });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-search-scope-')));
  const excluded = ['node_modules', '.cache', 'dist', '.worktrees', 'generated-worktree', 'generated-worktrees', 'worktrees', '.artifacts'];
  const invoke = async cwd => {
    const client = createFakeClient({ session: { id: input.sessionID, directory: root } });
    client.sessions.message.mockResolvedValue({ info: { role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
      turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' }, parts: [{ type: 'tool', callID: input.callID, tool: 'grep' }] });
    const { host } = fixture({ openCodeClient: client, nativeExecution: { readRoots: [root], recheckPermit: async () => {}, socketDirectory: null } });
    const specification = { kind: 'read', command: '/fixture/rg', args: ['--no-config', '--json', '--glob=**/node_modules/**', '--', 'needle', '.'], cwd };
    try {
      await host.nativeExecution({ ...input, directory: root, ...specification, tool: 'grep', agent: 'build', action: 'start',
        argsDigest: createHash('sha256').update(JSON.stringify(specification)).digest('hex') });
      return native.startReadOnlySessionExecution.mock.calls.at(-1)[0].args;
    } finally { await host.drain(); }
  };
  try {
    const broad = await invoke(root);
    for (const name of excluded) expect(broad).toContain(`--iglob=!**/${name}/**`);
    expect(broad.indexOf('--iglob=!**/node_modules/**')).toBeGreaterThan(broad.indexOf('--glob=**/node_modules/**'));
    for (const name of excluded) {
      const scope = path.join(root, ...(name === 'worktrees' ? ['.claude', name] : [name]), 'owned-package'); await fs.mkdir(scope, { recursive: true });
      const args = await invoke(await fs.realpath(scope));
      expect(args).not.toContain(`--iglob=!**/${name}/**`);
      expect(args).toContain('--iglob=!**/.git/**'); expect(args).toContain('--no-ignore');
      for (const other of excluded.filter(item => item !== name)) expect(args).toContain(`--iglob=!**/${other}/**`);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verification rejects an unpublished same-step writer before reserving its snapshot', async () => {
  const f = await nativePublicationFixture({}, 'shell');
  const record = await f.client.sessions.message();
  record.parts.unshift({ id: 'unpublished-part', type: 'tool', callID: 'unpublished-edit', tool: 'edit' });
  try {
    await expect(f.start({ authorization: { input: { input: { command: 'bun test' } } } })).rejects.toMatchObject({ code: 'native_verification_publication_pending' });
    expect(mocks.runtime.reserve).not.toHaveBeenCalled();
    expect(mocks.runtime.prepare).not.toHaveBeenCalled();
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test('dependent verification cancellation never reserves, and a retry snapshots only after writer publication', async () => {
  const f = await nativePublicationFixture();
  const record = await f.client.sessions.message();
  const verificationID = 'verify_after_writer';
  record.parts.push({ id: 'verification-part', type: 'tool', callID: verificationID, tool: 'bash' });
  const specification = { kind: 'shell', command: '/bin/sh', args: ['-c', 'bun test'], env: {}, cwd: directory };
  const verification = { ...input, ...specification, callID: verificationID, action: 'start', agent: 'build', tool: 'shell',
    authorization: { input: { input: { command: 'bun test' } } }, argsDigest: createHash('sha256').update(JSON.stringify(specification)).digest('hex') };
  const publishing = Promise.withResolvers(), publication = Promise.withResolvers();
  let published = false;
  mocks.runtime.leaseForCall.mockImplementation(async scope => scope.callID === input.callID ? { ...f.lease, state: published ? 'published' : 'ready' } : undefined);
  mocks.runtime.reserve.mockImplementation(async scope => ({ ...f.lease, token: scope.callID, scope }));
  mocks.runtime.prepare.mockImplementation(async lease => lease);
  mocks.runtime.finish.mockImplementation(async scope => {
    if (scope.token === input.callID) { publishing.resolve(); await publication.promise; published = true; }
    return { operationID: 'published_fixture', files: [] };
  });
  try {
    const writer = await f.start(); await f.launched.promise;
    const cancelled = new AbortController();
    const waiting = f.host.nativeExecution(verification, { signal: cancelled.signal });
    await vi.waitFor(() => expect(mocks.runtime.leaseForCall).toHaveBeenCalled());
    cancelled.abort(Object.assign(Error('cancel check'), { code: 'cancelled_check' }));
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled_check' });
    expect(mocks.runtime.reserve).toHaveBeenCalledTimes(1);
    const retry = f.host.nativeExecution(verification);
    f.terminated.resolve(f.receipt); await publishing.promise;
    expect(mocks.runtime.reserve).toHaveBeenCalledTimes(1);
    publication.resolve(); await f.settled(writer.handle);
    const checking = await retry;
    expect(mocks.runtime.reserve).toHaveBeenCalledTimes(2);
    expect(published).toBe(true);
    expect(await f.settled(checking.handle)).toMatchObject({ type: 'settled', ok: true });
  } finally { publication.resolve(); f.terminated.resolve(f.receipt); await f.host.drain(); }
});

test.each([false, true])('root check objective is captured and rechecked at settlement (changed: %s)', async changed => {
  let objective = { objectiveId: 'msg_objective', cancellationGeneration: 3 };
  const captureRequiredCheckObjective = vi.fn(async scope => {
    expect(scope).toMatchObject({ sessionID: input.sessionID, directory, userMessageID: 'msg_user' });
    return objective;
  });
  const observeRequiredCheck = vi.fn(async () => ({ tracked: true }));
  const f = await nativePublicationFixture({ nativeExecution: { captureRequiredCheckObjective, observeRequiredCheck } }, 'shell');
  try {
    const { handle } = await f.start(); await f.launched.promise;
    if (changed) objective = { objectiveId: 'msg_new', cancellationGeneration: 4 };
    f.terminated.resolve(f.receipt);
    await f.settled(handle);
    expect(captureRequiredCheckObjective).toHaveBeenCalledTimes(2);
    expect(observeRequiredCheck.mock.calls.find(([phase]) => phase === 'before')[3].objectiveId).toBe('msg_objective');
    expect(observeRequiredCheck.mock.calls.find(([phase]) => phase === 'after')[3].objectiveId).toBe(changed ? undefined : 'msg_objective');
  } finally { f.terminated.resolve(f.receipt); await f.host.drain(); }
});
