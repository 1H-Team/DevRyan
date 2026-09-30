import { afterEach, expect, test, vi } from 'vitest';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  runtime: { admitDirect: vi.fn(), finishDirect: vi.fn(), executionReceipt: vi.fn(), reserve: vi.fn(), prepare: vi.fn(),
    begin: vi.fn(), claimLease: vi.fn(), leaseForCall: vi.fn(), finish: vi.fn(), cleanupLease: vi.fn(), drain: vi.fn() },
  classify: vi.fn(),
}));
vi.mock('@openchamber/harness-runtime', () => ({
  createSessionMutationRuntime: () => mocks.runtime,
  createSessionRevertCoordinator: () => ({}),
}));
vi.mock('@openchamber/harness-runtime/lib/session-execution.js', () => ({
  verifySessionExecutionLauncher: async () => true, sweepExecutionSocketDirectories: async () => 0,
  prepareSessionExecution: vi.fn(), readSessionExecutionReceipt: vi.fn(), startReadOnlySessionExecution: vi.fn(),
}));
vi.mock('@openchamber/harness-runtime/lib/session-changes-tools.js', async (importOriginal) => ({
  ...await importOriginal(), classifySessionChangeTool: mocks.classify,
}));
const { classifySessionChangeTool } = await vi.importActual('@openchamber/harness-runtime/lib/session-changes-tools.js');
import { createSessionExecutionHost } from './session-execution-host.js';

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
const finishes = (diagnostics) => diagnostics.filter((record) => record.phase === 'direct_finish' && record.state !== 'started');

test('native skill admission and completion use direct receipts without workspace preparation', async () => {
  const { host, recordReceipt } = fixture();
  const admitted = await host.plugin({ ...input, action: 'direct-admit' });
  expect(admitted).toMatchObject({ generation: 7, token: expect.any(String) });
  expect(await host.plugin({ ...input, ...admitted, action: 'direct-finish' })).toEqual({ files: [] });
  expect(mocks.runtime.finishDirect).toHaveBeenCalledWith(expect.objectContaining({
    tool: 'skill', userMessageID: 'msg_user', generation: 7, executionFingerprint: input.argsDigest,
  }));
  expect(mocks.runtime.reserve).not.toHaveBeenCalled();
  expect(mocks.runtime.prepare).not.toHaveBeenCalled();
});

test.each(['skill', 'read', 'glob', 'grep'])('read-only %s completion records only the ledger fence', async (tool) => {
  const { host, recordReceipt } = fixture({ tool });
  const admitted = await host.plugin({ ...input, tool, action: 'direct-admit' });
  expect(await host.plugin({ ...input, ...admitted, tool, action: 'direct-finish' })).toEqual({ files: [] });
  expect(mocks.runtime.finishDirect).toHaveBeenCalledTimes(1);
  expect(mocks.runtime.executionReceipt).not.toHaveBeenCalled();
  expect(recordReceipt).not.toHaveBeenCalled();
});

test('the ledger-only kill switch restores the session-change attestation', async () => {
  vi.stubEnv('DEVRYAN_DIRECT_LEDGER_ONLY', '0');
  const { host, recordReceipt } = fixture();
  const admitted = await host.plugin({ ...input, action: 'direct-admit' });
  await host.plugin({ ...input, ...admitted, action: 'direct-finish' });
  expect(mocks.runtime.executionReceipt).toHaveBeenCalledWith({ directory, token: admitted.token });
  expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ tool: 'skill', files: [], source: 'confined-execution' }));
});

test('a direct tool that is not read-only for session changes keeps its attestation', async () => {
  const { host, recordReceipt } = fixture();
  mocks.classify.mockReturnValue('execution');
  const admitted = await host.plugin({ ...input, action: 'direct-admit' });
  await host.plugin({ ...input, ...admitted, action: 'direct-finish' });
  expect(mocks.classify).toHaveBeenCalledWith('skill');
  expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ tool: 'skill', files: [] }));
});

test('a slow direct finish journals one summary with the tool run time and bookkeeping steps', async () => {
  const { host, diagnostics } = fixture({ admissionSummaryMinMs: 0 });
  const admitted = await host.plugin({ ...input, action: 'direct-admit' });
  await host.plugin({ ...input, ...admitted, action: 'direct-finish' });
  const [summary, ...rest] = finishes(diagnostics);
  expect(rest).toEqual([]);
  expect(summary).toMatchObject({ event: 'session_execution', phase: 'direct_finish', state: 'completed', executionTier: 'direct',
    sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, elapsedMs: expect.any(Number) });
  expect(summary.steps).toMatch(/(^|,)tool_execution:1\/\d+(,|$)/);
  expect(summary.steps).toMatch(/(^|,)identity_lookup:1\/\d+/);
  expect(summary.steps).toMatch(/(^|,)direct_receipt:1\/\d+/);
});

test('a finish journals one summary with the tool run time and each bookkeeping step', async () => {
  const { host, recordReceipt, diagnostics } = fixture({ tool: 'todowrite', admissionSummaryMinMs: 0 });
  const call = { ...input, tool: 'todowrite', kind: 'control' };
  const lease = { token: 'lease_token', directory, executionKind: 'control', scope: { messageID: input.messageID } };
  mocks.runtime.begin.mockResolvedValue(lease);
  mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.finish.mockResolvedValue({ files: [] });
  expect(await host.plugin({ ...call, action: 'begin' })).toEqual({ lease });
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(await host.plugin({ ...call, action: 'finish', token: lease.token })).toEqual({ files: [] });
  // Read-only for session changes: the ledger fence only, no attestation.
  expect(recordReceipt).not.toHaveBeenCalled();
  expect(mocks.runtime.executionReceipt).not.toHaveBeenCalled();
  expect(mocks.runtime.cleanupLease).toHaveBeenCalledWith({ directory, token: lease.token });
  await host.drain();
  expect(diagnostics.filter((record) => record.phase === 'lease_cleanup')).toEqual([
    expect.objectContaining({ state: 'completed', deferred: true })]);
  const summaries = diagnostics.filter((record) => record.phase === 'finish' && record.state !== 'started');
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({ event: 'session_execution', phase: 'finish', state: 'completed', executionTier: 'control',
    sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, elapsedMs: expect.any(Number) });
  const steps = Object.fromEntries(summaries[0].steps.split(',').map((step) => { const [name, value] = step.split(':'); return [name, value]; }));
  expect(Object.keys(steps)).toEqual(expect.arrayContaining(['identity_lookup', 'tool_identity_lookup', 'lease_lookup',
    'tool_execution', 'publication']));
  expect(steps.change_receipt).toBeUndefined();
  // The view is removed after the result is returned.
  expect(steps.lease_cleanup).toBeUndefined();
  expect(Number(steps.tool_execution.split('/')[1])).toBeGreaterThanOrEqual(10);
  expect(steps.termination_receipt).toBeUndefined();
});

test.each([
  ['a control tool that can change files', 'custom_writer', 'control', {}],
  ['a process tool', 'bash', 'process', {}],
  ['the kill switch', 'todowrite', 'control', { DEVRYAN_CONTROL_LEDGER_ONLY: '0' }],
])('%s keeps its session-change attestation', async (_name, tool, kind, env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { host, recordReceipt } = fixture({ tool });
  const { readSessionExecutionReceipt } = await import('@openchamber/harness-runtime/lib/session-execution.js');
  readSessionExecutionReceipt.mockResolvedValue({ terminated: true, confined: true, cancelled: false, exitCode: 0 });
  const lease = { token: 'lease_token', directory, executionKind: kind, scope: { messageID: input.messageID } };
  mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.finish.mockResolvedValue({ files: [] });
  await host.plugin({ ...input, tool, kind, action: 'finish', token: lease.token });
  expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ tool, files: [] }));
});

test('the tool result does not wait for the removal of its view, and shutdown does', async () => {
  const { host } = fixture({ tool: 'todowrite' });
  const lease = { token: 'lease_token', directory, executionKind: 'control', scope: { messageID: input.messageID } };
  let release, removed = false;
  mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.finish.mockResolvedValue({ files: [] });
  mocks.runtime.cleanupLease.mockImplementation(() => new Promise((resolve) => { release = () => { removed = true; resolve(true); }; }));
  expect(await host.plugin({ ...input, tool: 'todowrite', kind: 'control', action: 'finish', token: lease.token })).toEqual({ files: [] });
  expect(removed).toBe(false);
  const drained = host.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await drained;
  expect(removed).toBe(true);
});

test('the kill switch removes the view before returning the result', async () => {
  vi.stubEnv('DEVRYAN_DEFERRED_LEASE_CLEANUP', '0');
  const { host, diagnostics } = fixture({ tool: 'todowrite', admissionSummaryMinMs: 0 });
  const lease = { token: 'lease_token', directory, executionKind: 'control', scope: { messageID: input.messageID } };
  mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.finish.mockResolvedValue({ files: [] });
  mocks.runtime.cleanupLease.mockResolvedValue(true);
  await host.plugin({ ...input, tool: 'todowrite', kind: 'control', action: 'finish', token: lease.token });
  expect(diagnostics.find((record) => record.phase === 'finish' && record.state === 'completed').steps).toMatch(/lease_cleanup:1\/\d+/);
});

test('a confined process is watched for idleness from its launch to its finish', async () => {
  const idleWatchdog = { watch: vi.fn(), unwatch: vi.fn(), stop: vi.fn() };
  const { host } = fixture({ tool: 'bash', idleWatchdog });
  const { prepareSessionExecution, readSessionExecutionReceipt } = await import('@openchamber/harness-runtime/lib/session-execution.js');
  prepareSessionExecution.mockResolvedValue({ launcher: '/fixture/launcher', profile: '/views/abc/sandbox-1.sb', arguments: [], cwd: '/views/abc/worktree',
    scratchDirectory: '/views/abc/scratch', environment: {} });
  readSessionExecutionReceipt.mockResolvedValue({ terminated: true, confined: true, cancelled: false, exitCode: 0 });
  const lease = { token: 'lease_token', directory, executionKind: 'process', scope: { messageID: input.messageID } };
  mocks.runtime.begin.mockResolvedValue(lease);
  mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.finish.mockResolvedValue({ files: [] });
  const call = { ...input, tool: 'bash', kind: 'process' };

  await host.plugin({ ...call, action: 'begin' });
  expect(idleWatchdog.watch).toHaveBeenCalledWith({ token: lease.token, profile: '/views/abc/sandbox-1.sb',
    identity: { sessionID: input.sessionID, messageID: input.messageID, callID: input.callID } });
  expect(idleWatchdog.unwatch).not.toHaveBeenCalled();
  await host.plugin({ ...call, action: 'finish', token: lease.token });
  expect(idleWatchdog.unwatch).toHaveBeenCalledWith(lease.token);
  await host.drain();
  expect(idleWatchdog.stop).toHaveBeenCalled();
});

test('a cancelled confined call records that it changed nothing', async () => {
  const { host, recordReceipt } = fixture({ tool: 'bash' });
  const { readSessionExecutionReceipt } = await import('@openchamber/harness-runtime/lib/session-execution.js');
  readSessionExecutionReceipt.mockResolvedValue({ terminated: true, confined: true, cancelled: true, exitCode: 137 });
  const scope = { sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, userMessageID: 'msg_user' };
  const lease = { token: 'lease_token', directory, executionKind: 'process', scope };
  mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.cancelLease = vi.fn(async () => {});
  await expect(host.plugin({ ...input, tool: 'bash', kind: 'process', action: 'finish', token: lease.token }))
    .rejects.toMatchObject({ code: 'execution_cancelled' });
  expect(mocks.runtime.finish).not.toHaveBeenCalled();
  expect(recordReceipt).toHaveBeenCalledWith({ ...scope, directory, source: 'confined-execution', complete: true, files: [], tool: 'bash' });

  // A failing record never replaces the cancellation, and the kill switch records nothing.
  recordReceipt.mockReset(); recordReceipt.mockRejectedValue(new Error('store unavailable'));
  await expect(host.plugin({ ...input, tool: 'bash', kind: 'process', action: 'finish', token: lease.token }))
    .rejects.toMatchObject({ code: 'execution_cancelled' });
  vi.stubEnv('DEVRYAN_CANCELLED_RECEIPTS', '0'); recordReceipt.mockReset();
  await expect(host.plugin({ ...input, tool: 'bash', kind: 'process', action: 'finish', token: lease.token }))
    .rejects.toMatchObject({ code: 'execution_cancelled' });
  expect(recordReceipt).not.toHaveBeenCalled();
});

test('a failed finish is journaled and keeps its failure', async () => {
  const { host, diagnostics } = fixture({ tool: 'todowrite' });
  const lease = { token: 'lease_token', directory, executionKind: 'control', scope: { messageID: input.messageID } };
  mocks.runtime.leaseForCall.mockResolvedValue(lease);
  mocks.runtime.finish.mockRejectedValue(Object.assign(new Error('execution_reverted'), { code: 'execution_reverted' }));
  await expect(host.plugin({ ...input, tool: 'todowrite', kind: 'control', action: 'finish', token: lease.token }))
    .rejects.toMatchObject({ code: 'execution_reverted' });
  expect(diagnostics.filter((record) => record.phase === 'finish' && record.state === 'failed')).toHaveLength(1);
});

test('a fast direct finish journals nothing and gains no admission deadline', async () => {
  const { host, diagnostics } = fixture({ admissionTimeoutMs: 20, admissionIdleMs: 10 });
  mocks.runtime.finishDirect.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ files: [] }), 60)));
  const admitted = await host.plugin({ ...input, action: 'direct-admit' });
  expect(await host.plugin({ ...input, ...admitted, action: 'direct-finish' })).toEqual({ files: [] });
  expect(finishes(diagnostics)).toEqual([]);
});

test.each(['execution_cancelled', 'execution_reverted'])('skill completion preserves the %s fence', async code => {
  const { host, recordReceipt } = fixture();
  mocks.runtime.finishDirect.mockRejectedValue(Object.assign(new Error(code), { code }));
  await expect(host.plugin({ ...input, action: 'direct-finish', token: 'fixture', generation: 7 })).rejects.toMatchObject({ code });
  expect(recordReceipt).not.toHaveBeenCalled();
});

test('disabled direct receipts refuse skill admission for the companion fallback', async () => {
  vi.stubEnv('DEVRYAN_DIRECT_CONTROL_RECEIPTS', '0');
  const { host } = fixture();
  await expect(host.plugin({ ...input, action: 'direct-admit' })).rejects.toMatchObject({ code: 'direct_receipts_disabled' });
  expect(mocks.runtime.admitDirect).not.toHaveBeenCalled();
});

test.each([{ tool: 'bash' }, { sessionID: 'ses_other' }])('direct skill admission verifies canonical call identity: %j', async options => {
  const { host } = fixture(options);
  await expect(host.plugin({ ...input, action: 'direct-admit' })).rejects.toMatchObject({ code: 'capture_identity_mismatch' });
  expect(mocks.runtime.admitDirect).not.toHaveBeenCalled();
});

test('writers cannot use the expanded direct-receipt allowlist', async () => {
  const { host } = fixture({ tool: 'bash' });
  await expect(host.plugin({ ...input, tool: 'bash', action: 'direct-admit' })).rejects.toMatchObject({ code: 'invalid_capture_identity' });
  expect(mocks.runtime.admitDirect).not.toHaveBeenCalled();
});
