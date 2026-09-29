import { afterEach, expect, test, vi } from 'vitest';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  runtime: { admitDirect: vi.fn(), finishDirect: vi.fn(), executionReceipt: vi.fn(), reserve: vi.fn(), prepare: vi.fn() },
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
