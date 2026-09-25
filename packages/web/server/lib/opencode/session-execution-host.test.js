import { afterEach, expect, test, vi } from 'vitest';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  runtime: { admitDirect: vi.fn(), finishDirect: vi.fn(), executionReceipt: vi.fn(), reserve: vi.fn(), prepare: vi.fn() },
}));
vi.mock('@openchamber/harness-runtime', () => ({
  createSessionMutationRuntime: () => mocks.runtime,
  createSessionRevertCoordinator: () => ({}),
}));
vi.mock('@openchamber/harness-runtime/lib/session-execution.js', () => ({
  verifySessionExecutionLauncher: async () => true,
  prepareSessionExecution: vi.fn(), readSessionExecutionReceipt: vi.fn(), startReadOnlySessionExecution: vi.fn(),
}));
import { createSessionExecutionHost } from './session-execution-host.js';

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const directory = process.cwd();
const input = { directory, sessionID: 'ses_test', messageID: 'msg_test', callID: 'call_test',
  tool: 'skill', argsDigest: 'a'.repeat(64), protocol: 3 };
function fixture({ tool = 'skill', sessionID = input.sessionID } = {}) {
  const recordReceipt = vi.fn();
  const host = createSessionExecutionHost({ dataDirectory: path.join(directory, '.cache/unused-host-fixture'),
    getLauncher: () => '/fixture/launcher', recordReceipt,
    buildOpenCodeUrl: route => `http://127.0.0.1:1${route}`,
    fetchImpl: async url => Response.json(url.pathname.includes('/message/')
      ? { info: { role: 'assistant', sessionID, parentID: 'msg_user' }, parts: [{ type: 'tool', callID: input.callID, tool }] }
      : { id: input.sessionID, directory }),
  });
  mocks.runtime.admitDirect.mockResolvedValue({ generation: 7 });
  mocks.runtime.finishDirect.mockResolvedValue({ files: [] });
  mocks.runtime.executionReceipt.mockResolvedValue({ files: [], source: 'confined-execution' });
  return { host, recordReceipt };
}

test('native skill admission and completion use direct receipts without workspace preparation', async () => {
  const { host, recordReceipt } = fixture();
  const admitted = await host.plugin({ ...input, action: 'direct-admit' });
  expect(admitted).toMatchObject({ generation: 7, token: expect.any(String) });
  expect(await host.plugin({ ...input, ...admitted, action: 'direct-finish' })).toEqual({ files: [] });
  expect(mocks.runtime.finishDirect).toHaveBeenCalledWith(expect.objectContaining({
    tool: 'skill', userMessageID: 'msg_user', generation: 7, executionFingerprint: input.argsDigest,
  }));
  expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ tool: 'skill', files: [] }));
  expect(mocks.runtime.reserve).not.toHaveBeenCalled();
  expect(mocks.runtime.prepare).not.toHaveBeenCalled();
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
