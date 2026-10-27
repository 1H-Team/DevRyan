import { expect, test } from 'vitest';
import { createNativeAdmissionOwner } from './native-admission-owner.js';

for (const row of [
  { state: 'published', cancelled: false, exitCode: 0, expected: 'completed' },
  { state: 'published', cancelled: false, exitCode: 2, expected: 'error' },
  { state: 'published', cancelled: false, exitCode: 0, expected: 'completed', partial: true },
  { state: 'cancelled', cancelled: true, exitCode: 137, expected: 'cancelled' },
  { state: 'cancelled', cancelled: false, exitCode: 137, expected: 'error' },
]) test(`background shell projects ${row.expected} from its host receipt`, async () => {
  const directory = '/project', sessionID = 'ses_root', jobID = 'job_shell', id = 'msg_notice', command = 'fixture';
  const lease = { state: row.state, token: 'lease', scope: { sessionID }, nativeShellJob: { jobID, notificationID: id, command },
    ...(row.partial ? { result: { outcome: 'partial', conflicts: [{ path: 'conflict.txt' }] } } : {}) };
  const owner = createNativeAdmissionOwner({ directory, ownerID: 'fixture', getSession: async id => ({ id, directory }),
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ revision: 0, held: false }) },
    authorizeOperation: async () => {}, getShellJobReceipt: async () => ({ lease,
      receipt: { terminated: true, confined: true, cancelled: row.cancelled, exitCode: row.exitCode } }) });
  const nativeJob = { id: jobID, type: 'shell', status: 'completed', title: command, notificationID: id, output: 'partial output' };
  const input = { id, sessionID, description: command, nativeJob, metadata: { jobID, shellID: jobID },
    text: `<shell id="${jobID}" state="completed" command="${command}">\npartial output\n</shell>` };
  try {
    const permit = await owner.handleRpc('native.admission.authorize', { operation: 'session.synthetic', sessionID, messageID: id, input });
    const sealed = await owner.handleRpc('native.admission.sealSynthetic', { permit, input });
    expect(sealed.state).toBe(row.expected);
    expect(sealed.exit).toBe(row.exitCode);
    expect(sealed.nativeShellText).toContain(`state="${row.expected}"`);
    expect(sealed.nativeShellText).toContain('partial output');
    if (row.partial) { expect(sealed.nativeShellText).toContain('conflict.txt'); expect(sealed.publication).toEqual({ outcome: 'partial', conflicts: ['conflict.txt'] }); }
    await expect(owner.handleRpc('native.admission.sealSynthetic', { permit, input: { ...input, text: 'forged' } })).rejects.toMatchObject({ code: 'native_completion_capability_required' });
  } finally { owner.dispose(); }
});

test('background completion refuses uncertain or unconfined termination', async () => {
  const directory = '/project', sessionID = 'ses_root', jobID = 'job_shell', id = 'msg_notice', command = 'fixture';
  const lease = { state: 'published', token: 'lease', scope: { sessionID }, nativeShellJob: { jobID, notificationID: id, command } };
  let receipt;
  const owner = createNativeAdmissionOwner({ directory, ownerID: 'fixture', getSession: async id => ({ id, directory }),
    runtime: { registerNativeSession: async () => {}, nativeAdmissionState: async () => ({ revision: 0, held: false }) },
    authorizeOperation: async () => {}, getShellJobReceipt: async () => ({ lease, receipt }) });
  const nativeJob = { id: jobID, type: 'shell', status: 'completed', title: command, notificationID: id, output: 'partial' };
  const input = { id, sessionID, description: command, nativeJob, metadata: { jobID, shellID: jobID },
    text: `<shell id="${jobID}" state="completed" command="${command}">\npartial\n</shell>` };
  try {
    for (receipt of [undefined, { terminated: false, confined: true }, { terminated: true, confined: false }])
      await expect(owner.handleRpc('native.admission.authorize', { operation: 'session.synthetic', sessionID, messageID: id, input }))
        .rejects.toMatchObject({ code: 'native_completion_receipt_invalid' });
  } finally { owner.dispose(); }
});
