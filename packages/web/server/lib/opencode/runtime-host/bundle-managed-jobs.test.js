import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSqliteDriver } from '../sqlite-driver.js';
import { verifyBundleManagedJobs } from './bundle-managed-jobs.js';
import { NATIVE_MANAGED_SUBAGENT_JOB_CONTRACT, hasNativeManagedSubagentJobs } from './native-managed-job-contract.js';
import { MANAGED_NATIVE_JOB_PROOF_DIRECTORY, compactManagedOrchestrationState, createManagedTaskRecord, createManagedTaskResultEnvelope,
  encodeManagedNativeJobProofShard, managedNativeJobProofShard } from '@devryan/orchestration-runtime';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));
const capable = { compiledContracts: [NATIVE_MANAGED_SUBAGENT_JOB_CONTRACT] };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-managed-jobs-')); roots.push(root);
  await fs.writeFile(path.join(root, 'native.db'), '');
  const raw = resolveSqliteDriver().open(path.join(root, 'native.db'));
  raw.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT); CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT); CREATE TABLE job (notification_id TEXT PRIMARY KEY,id TEXT,session_id TEXT,child_session_id TEXT,kind TEXT,status TEXT,recovery TEXT)');
  const directory = path.join(root, 'project');
  raw.prepare('INSERT INTO session_v2 VALUES (?,?,?)').run('ses_root', null, directory);
  raw.prepare('INSERT INTO session_v2 VALUES (?,?,?)').run('ses_child', 'ses_root', directory);
  raw.prepare('INSERT INTO session_message VALUES (?,?)').run('msg_child', 'ses_child');
  const segment = { jobID: 'dvr_job_' + 'a'.repeat(32), notificationID: 'msg_notice', messageID: 'msg_child', state: 'accepted', completion: 'pending' };
  const task = { taskId: 'dvr_task_1', rootSessionId: 'ses_root', childSessionId: 'ses_child', directory,
    status: 'running', agent: 'fixer', executionBackend: 'native-job', nativeJobSegments: [segment] };
  const recovery = { kind: 'subagent', parentSessionID: 'ses_root', childSessionID: 'ses_child', agent: 'fixer', description: task.taskId };
  const save = async () => {
    await fs.mkdir(path.join(root, 'orchestration'), { recursive: true });
    await fs.writeFile(path.join(root, 'orchestration', 'ledger.json'), JSON.stringify({ tasks: [task] }));
  };
  const row = (changes = {}) => {
    const value = { notification_id: segment.notificationID, id: segment.jobID, session_id: task.rootSessionId,
      child_session_id: task.childSessionId, kind: 'subagent', status: 'running', recovery: JSON.stringify(recovery), ...changes };
    raw.prepare('INSERT OR REPLACE INTO job VALUES (?,?,?,?,?,?,?)').run(...Object.values(value));
  };
  const verify = targetManifest => verifyBundleManagedJobs({ db: { all: (sql, values = []) => raw.prepare(sql).all(...values) }, webDataDirectory: root, targetManifest });
  await save();
  return { raw, task, segment, recovery, save, row, verify, ledgerFile: path.join(root, 'orchestration', 'ledger.json') };
}

test('native jobs require the exact selected artifact declaration', () => {
  for (const manifest of [undefined, {}, { compiledContracts: [] }, { compiledContracts: ['devryan.managed-subagent-jobs/2'] }]) {
    expect(hasNativeManagedSubagentJobs(manifest)).toBe(false);
  }
  expect(hasNativeManagedSubagentJobs(capable)).toBe(true);
});
test('cold durable pending native work refuses an unaware artifact even before its job row exists', async () => {
  const f = await fixture();
  try {
    f.segment.state = 'reserved'; await f.save();
    await expect(f.verify(capable)).resolves.toBeUndefined();
    await expect(f.verify({})).rejects.toMatchObject({ code: 'bundle_managed_jobs_incompatible' });
    f.task.nativeJobSegments = []; f.task.childSessionId = null; await f.save();
    await expect(f.verify({})).rejects.toMatchObject({ code: 'bundle_managed_jobs_incompatible' });
  } finally { f.raw.close(); }
});
test('native job columns and recovery identities must agree with the managed segment', async () => {
  const f = await fixture();
  try {
    f.row(); await expect(f.verify(capable)).resolves.toBeUndefined();
    for (const changes of [{ notification_id: 'msg_foreign' }, { child_session_id: 'ses_root' }, { session_id: 'ses_child' },
      { kind: 'shell' }, { status: 'unknown' }, { recovery: '{}' }, { recovery: JSON.stringify({ ...f.recovery, childSessionID: 'ses_foreign' }) }]) {
      f.raw.exec('DELETE FROM job'); f.row(changes);
      await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_managed_job_reference_invalid' });
    }
    f.raw.exec('DELETE FROM job'); f.row();
    f.raw.prepare('UPDATE session_message SET session_id=? WHERE id=?').run('ses_root', f.segment.messageID);
    await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_managed_job_reference_invalid' });
  } finally { f.raw.close(); }
});
test('completed execution still blocks downgrade until its native result receipt is consumed', async () => {
  const f = await fixture();
  try {
    f.task.status = 'completed'; f.row({ status: 'completed' }); await f.save();
    await expect(f.verify({})).rejects.toMatchObject({ code: 'bundle_managed_jobs_incompatible' });
    f.segment.completion = 'done'; await f.save();
    await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_managed_job_reference_invalid' });
    f.raw.exec('DELETE FROM job'); await expect(f.verify({})).resolves.toBeUndefined();
  } finally { f.raw.close(); }
});
test('cold native orphan rows and competing notification turns cannot enter another bundle', async () => {
  const f = await fixture();
  try {
    f.row(); f.task.nativeJobSegments = []; await f.save();
    await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_managed_job_reference_invalid' });
    f.task.nativeJobSegments = [f.segment]; await f.save();
    f.raw.prepare('INSERT INTO session_message VALUES (?,?)').run(f.segment.notificationID, 'ses_root');
    await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_managed_job_reference_invalid' });
  } finally { f.raw.close(); }
});
test('cancelled segments still require their durable receipt before downgrade', async () => {
  const f = await fixture();
  try {
    f.task.status = 'aborted'; f.segment.state = 'cancelled'; await f.save();
    await expect(f.verify({})).rejects.toMatchObject({ code: 'bundle_managed_jobs_incompatible' });
    f.segment.completion = 'done'; await f.save(); await expect(f.verify({})).resolves.toBeUndefined();
  } finally { f.raw.close(); }
});
test('queued child input ownership and cross-segment message identity are checked without a native job row', async () => {
  const f = await fixture();
  try {
    f.raw.exec('CREATE TABLE session_inbox (id TEXT PRIMARY KEY,session_id TEXT); DELETE FROM session_message');
    f.raw.prepare('INSERT INTO session_inbox VALUES (?,?)').run(f.segment.messageID, 'ses_root');
    await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_managed_job_reference_invalid' });
    f.raw.prepare('UPDATE session_inbox SET session_id=?').run('ses_child');
    await expect(f.verify(capable)).resolves.toBeUndefined();
    f.task.nativeJobSegments.push({ ...f.segment, jobID: 'dvr_job_' + 'b'.repeat(32), notificationID: 'msg_notice2' }); await f.save();
    await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_managed_job_reference_invalid' });
  } finally { f.raw.close(); }
});
test('legacy tasks and unrelated shell jobs need no managed-job declaration', async () => {
  const f = await fixture();
  try {
    delete f.task.executionBackend; delete f.task.nativeJobSegments; await f.save();
    f.raw.prepare('INSERT INTO job VALUES (?,?,?,?,?,?,?)').run('msg_shell', 'shell_1', 'ses_root', null, 'shell', 'running', '{}');
    await expect(f.verify({})).resolves.toBeUndefined();
  } finally { f.raw.close(); }
});
// The ledger released this pending native receipt into its proof shard.
const releasedProof = (f, changes = {}) => {
  const task = { ...createManagedTaskRecord({ idempotencyKey: 'native-proof', rootSessionId: f.task.rootSessionId, parentTaskId: null, directory: f.task.directory,
    mode: 'orchestrator', providerId: 'openai', modelId: 'fixture', agent: f.task.agent, variant: null, label: 'Native', prompt: 'Fix.',
    taskId: f.task.taskId, sequence: 1, createdAt: 1, timeoutAt: null, attempt: 1, priorTaskId: null, executionKind: 'start', executionBackend: 'native-job' }),
    childSessionId: f.task.childSessionId, leaseToken: 'dvr_lease_1', status: 'failed', startedAt: 1, finishedAt: 2, failureReason: 'failed', partial: true,
    nativeJobSegments: [{ ...f.segment }], ...changes };
  const envelope = { ...createManagedTaskResultEnvelope(task, { sequence: 1, createdAt: 2, resumable: true }), action: 'abandon', acknowledgedAt: 2 };
  const compacted = compactManagedOrchestrationState({ version: 1, tasks: [task], resultEnvelopes: [envelope] }, { now: 30 * 24 * 60 * 60 * 1000 }).state;
  const shard = managedNativeJobProofShard(task.taskId);
  return { shard, text: encodeManagedNativeJobProofShard(shard, [{ task: compacted.tasks[0], envelope: compacted.resultEnvelopes[0] }]) };
};
test('released proof shards bind native job rows and pending receipts like ledger records; a ledger copy wins', async () => {
  const f = await fixture();
  try {
    const shardDirectory = path.join(path.dirname(f.ledgerFile), MANAGED_NATIVE_JOB_PROOF_DIRECTORY);
    const { shard, text } = releasedProof(f);
    await fs.mkdir(shardDirectory, { recursive: true }); await fs.writeFile(path.join(shardDirectory, `${shard}.json`), text);
    f.row({ status: 'error' });
    // Both stores hold the task (a crash between shard write and ledger commit): the ledger record binds the row once.
    await expect(f.verify(capable)).resolves.toBeUndefined();
    await fs.writeFile(f.ledgerFile, JSON.stringify({ tasks: [] }));
    await expect(f.verify(capable)).resolves.toBeUndefined();
    await expect(f.verify({})).rejects.toMatchObject({ code: 'bundle_managed_jobs_incompatible' });
    await fs.rm(path.join(shardDirectory, `${shard}.json`));
    await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_managed_job_reference_invalid' });
    await fs.writeFile(path.join(shardDirectory, `${shard}.json`), '{broken');
    await expect(f.verify(capable)).rejects.toMatchObject({ code: 'bundle_native_job_proof_invalid' });
  } finally { f.raw.close(); }
});
