import { afterEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

const mocks = vi.hoisted(() => ({
  runtime: { admitDirect: vi.fn(), finishDirect: vi.fn(), executionReceipt: vi.fn(), reserve: vi.fn(), prepare: vi.fn(),
    begin: vi.fn(), claimLease: vi.fn(), leaseForCall: vi.fn(), finish: vi.fn(), cleanupLease: vi.fn(), drain: vi.fn(),
    assertAdmission: vi.fn(), registerChild: vi.fn(), cancelUnstartedCall: vi.fn() },
  classify: vi.fn(),
}));
vi.mock('@openchamber/harness-runtime', () => ({
  createSessionMutationRuntime: () => mocks.runtime,
  createSessionRevertCoordinator: () => ({}),
}));
vi.mock('@openchamber/harness-runtime/lib/session-execution.js', () => ({
  verifySessionExecutionLauncher: async () => true, sweepExecutionSocketDirectories: async () => 0,
  prepareSessionExecution: vi.fn(), readSessionExecutionReceipt: vi.fn(), startSessionExecution: vi.fn(), startReadOnlySessionExecution: vi.fn(), runReadOnlySessionExecution: vi.fn(),
}));
vi.mock('@openchamber/harness-runtime/lib/execution-host-owner.js', async (importOriginal) => ({
  ...await importOriginal(), createExecutionHostOwner: async () => ({ id: 'owner_fixture', signal: new AbortController().signal,
    assert: () => {}, close: async () => {} }),
}));
vi.mock('@openchamber/harness-runtime/lib/session-changes-tools.js', async (importOriginal) => ({
  ...await importOriginal(), classifySessionChangeTool: mocks.classify,
}));
const { classifySessionChangeTool } = await vi.importActual('@openchamber/harness-runtime/lib/session-changes-tools.js');
import { createSessionExecutionHost } from './session-execution-host.js';
import { runReadOnlySessionExecution } from '@openchamber/harness-runtime/lib/session-execution.js';

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const directory = process.cwd();
const input = { directory, sessionID: 'ses_test', messageID: 'msg_test', callID: 'call_test',
  tool: 'skill', argsDigest: 'a'.repeat(64), protocol: 3 };
function fixture({ tool = 'skill', sessionID = input.sessionID, ...options } = {}) {
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

function nativeManagedFixture() {
  const invocation = { ...input, tool: 'devryan_task', input: { action: 'start', agent: 'fixer', prompt: 'Inspect' },
    permit: { token: 'sealed' }, authorization: { input: { provenance: { kind: 'plugin', id: 'devryan.managed-task' } } } };
  const message = { info: { id: input.messageID, role: 'assistant', sessionID: input.sessionID, parentID: 'msg_user' },
    parts: [{ type: 'tool', callID: input.callID, tool: 'devryan_task' }],
    turnOwnership: { source: 'native-sequence', userMessageID: 'msg_user' } };
  const client = createFakeClient();
  client.sessions.get.mockImplementation(async id => ({ id, directory, ...(id === 'ses_child' ? { parentID: input.sessionID } : {}) }));
  client.sessions.message.mockImplementation(async () => message);
  const recheck = vi.fn(async () => {}), isReady = vi.fn(async () => true);
  const { host } = fixture({ openCodeClient: client, nativeExecution: { isReady, recheckPermit: recheck } });
  const lease = { token: 'control_1', directory, state: 'ready', executionKind: 'control', preparation: 'none',
    scope: { sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, userMessageID: 'msg_user' } };
  mocks.runtime.begin.mockResolvedValue(lease); mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.finish.mockResolvedValue({ files: [], operationID: 'published_1' });
  mocks.runtime.registerChild.mockResolvedValue({ parentGeneration: 1 });
  return { host, invocation, message, client, recheck, isReady, lease };
}

test('ready native managed control rechecks the exact invocation and retains the closed legacy bridge', async () => {
  const f = nativeManagedFixture();
  const begin = await f.host.nativeManagedControl({ action: 'begin', invocation: f.invocation });
  expect(begin.lease).toBe(f.lease);
  expect(f.recheck).toHaveBeenCalledWith(f.invocation);
  const digest = createHash('sha256').update(JSON.stringify(f.invocation.input)).digest('hex');
  expect(mocks.runtime.begin).toHaveBeenCalledWith(expect.objectContaining({ tool: 'devryan_task', kind: 'control', protocol: 3,
    argsDigest: digest, executionFingerprint: digest, userMessageID: 'msg_user' }));
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

test.each([{ tool: 'patch', projected: 'apply_patch', input: { patchText: 'partial patch fixture' } },
  { tool: 'ast_grep_replace', projected: 'ast_grep_replace', input: { pattern: 'old()', rewrite: 'new()', lang: 'javascript', dryRun: false } }])(
  'native $tool failure waits termination, cancels its view, and publishes nothing', async ({ tool, projected, input: arguments_ }) => {
  const native = await import('@openchamber/harness-runtime/lib/session-execution.js');
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
  const native = await import('@openchamber/harness-runtime/lib/session-execution.js');
  native.runReadOnlySessionExecution.mockResolvedValue({ receipt: { terminated: true, confined: true, cancelled: false, exitCode: 0 },
    stdout: Buffer.from('.git\n.git\n/fixture\n'), stderr: Buffer.alloc(0) });
  const { host } = fixture({ nativeExecution: { helperRoots: [directory], gitCommand: '/usr/bin/git', socketDirectory: null } });
  const helper = { action: 'helper', command: 'git', args: ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], cwd: directory };
  const result = await host.nativeExecution(helper);
  expect(result.receipt.terminated).toBe(true);
  expect(native.runReadOnlySessionExecution).toHaveBeenCalledWith(expect.objectContaining({ command: '/usr/bin/git',
    socketDirectory: null, workerBrowsers: false, args: ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...helper.args],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' } }));
  await expect(host.nativeExecution({ ...helper, args: ['fetch', 'origin'] })).rejects.toMatchObject({ code: 'native_helper_denied' });
  await expect(host.nativeExecution({ ...helper, timeoutMs: '100' })).rejects.toMatchObject({ code: 'native_helper_timeout_invalid' });
  await expect(host.nativeExecution({ ...helper, cwd: path.dirname(directory) })).rejects.toMatchObject({ code: 'native_helper_directory_denied' });
  expect(native.runReadOnlySessionExecution).toHaveBeenCalledTimes(1);
  expect(mocks.runtime.reserve).not.toHaveBeenCalled();
});

test('native scans enforce Git exclusions, reject follow traversal and protect nested host roots', async () => {
  const native = await import('@openchamber/harness-runtime/lib/session-execution.js');
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
    args: ['--no-config', '--files', '--hidden', '--glob=**/.git/**', '--no-ignore', '--iglob=!**/.git', '--iglob=!**/.git/**', '.'] }));
  // A pattern named --follow is positional, so remains a legitimate grep.
  await invoke('grep', ['--no-config', '--json', '--hidden', '--glob=**/*', '--', '--follow', '.']);
  expect(native.startReadOnlySessionExecution).toHaveBeenLastCalledWith(expect.objectContaining({
    args: ['--no-config', '--json', '--hidden', '--glob=**/*', '--no-ignore', '--iglob=!**/.git', '--iglob=!**/.git/**', '--', '--follow', '.'] }));
  await expect(invoke('glob', ['--no-config', '--files', '--follow', '.'])).rejects.toMatchObject({ code: 'native_read_follow_denied' });
  await expect(invoke('grep', ['--no-config', '--json', '--', 'host', '.'], { protectedRoots: [import.meta.dirname] }))
    .rejects.toMatchObject({ code: 'native_read_root_denied' });
  for (const extra of [['--ignore-file=/outside/ignore'], ['--ignore-file', '/outside/ignore'], ['-g', '**/*'],
    ['--config=/outside/config'], ['--ignore'], ['--pre=/outside/program'], ['--follow']]) {
    await expect(invoke('grep', ['--no-config', '--json', ...extra, '--', 'host', '.'])).rejects.toMatchObject({ status: 403 });
  }
  expect(native.startReadOnlySessionExecution).toHaveBeenCalledTimes(2);
});

test('Node helper independently validates pinned VCS info flags before launching a real supervisor', async () => {
  const { nativeVcsGitFlags } = await import('./execution-helper-policy.js');
  const native = await import('@openchamber/harness-runtime/lib/session-execution.js');
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
  const { createSessionMutationRuntime: createActualRuntime } = await vi.importActual('@openchamber/harness-runtime/lib/session-mutations.js');
  const base = path.resolve(import.meta.dirname, '../../../../../.cache/v2-validation');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'publication-recovery-'));
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
});

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
    const native = await import('@openchamber/harness-runtime/lib/session-execution.js');
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
    const native = await import('@openchamber/harness-runtime/lib/session-execution.js');
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
