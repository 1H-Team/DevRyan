import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { recoverStoppedBundleManagedTasks } from './native-bundle-task-recovery.js';
import { MANAGED_NATIVE_JOB_PROOF_DIRECTORY, compactManagedOrchestrationState, createManagedTaskRecord, createManagedTaskResultEnvelope,
  decodeLedgerSnapshot, decodeManagedNativeJobProofShard, encodeManagedNativeJobProofShard, managedNativeJobProofShard } from '@devryan/orchestration-runtime';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bundle-task-recovery-'))); roots.push(root);
  const controlRoot = path.join(root, 'control'), bundleRoot = path.join(controlRoot, 'bundles', 'selected');
  const launch = { opencodeDatabasePath: path.join(bundleRoot, 'opencode', 'opencode.db'), webDataDirectory: path.join(bundleRoot, 'web-data'),
    webConfigDirectory: path.join(bundleRoot, 'config', 'openchamber'), opencodeConfigDirectory: path.join(bundleRoot, 'config', 'opencode'),
    reviewedNativeConfigPath: path.join(bundleRoot, 'config', 'reviewed-native.json'), reviewedPluginManifestPath: path.join(bundleRoot, 'config', 'reviewed-plugins.json'),
    controllerBinary: path.join(root, 'controller'), writerBinary: path.join(root, 'writer'),
    artifactManifestPath: path.join(root, 'native-bundle.json'), artifactManifestSha256: 'a'.repeat(64), global: {} };
  for (const key of ['home', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp']) launch.global[key] = path.join(bundleRoot, 'global', key);
  launch.global.config = launch.opencodeConfigDirectory;
  for (const directory of [launch.webDataDirectory, launch.webConfigDirectory, ...Object.values(launch.global)]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const descriptor = { schema: 1, bundleID: 'selected', generation: 2, createdAt: 1, launch,
    projectMap: [{ sourceDirectory: project, targetDirectory: project, mode: 'identity' }],
    checkpoint: { checkpointID: 'checkpoint', ownerID: 'owner', generation: 2, settledAt: 1, databasePath: launch.opencodeDatabasePath,
      webDataDirectory: launch.webDataDirectory, webConfigDirectory: launch.webConfigDirectory, opencodeConfigDirectory: launch.opencodeConfigDirectory },
    preparedManifestPath: path.join(bundleRoot, 'prepared.json'), migrationReceiptPath: path.join(bundleRoot, 'sources', 'migration.json') };
  for (const file of [launch.opencodeDatabasePath, launch.reviewedNativeConfigPath, launch.reviewedPluginManifestPath, descriptor.migrationReceiptPath]) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '{}');
  }
  const descriptorBytes = JSON.stringify(descriptor); await fs.writeFile(path.join(bundleRoot, 'descriptor.json'), descriptorBytes);
  const preparedBytes = JSON.stringify({ schema: 1, bundleID: 'selected', checkpointID: 'checkpoint', descriptorSha256: hash(descriptorBytes) });
  await fs.writeFile(descriptor.preparedManifestPath, preparedBytes);
  await fs.writeFile(path.join(controlRoot, 'selection.json'), JSON.stringify({ schema: 1, revision: 1, selectedBundleID: 'selected', previousBundleID: null,
    transition: 'activate', reconciliationRequired: false, preparedManifestSha256: hash(preparedBytes) }), { mode: 0o600 });
  const controllerDirectory = path.join(bundleRoot, '.native-controller', randomUUID());
  await fs.mkdir(controllerDirectory, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(controllerDirectory, 'termination.json');
  await fs.writeFile(receiptFile, JSON.stringify({ terminated: true, confined: true, cancelled: true, exitCode: 130 }), { mode: 0o600 });
  const golden = JSON.parse(await fs.readFile(new URL('../../../../../orchestration-runtime/fixtures/ledger-current.json', import.meta.url), 'utf8'));
  const running = { ...golden.tasks[0], status: 'running', leaseToken: 'dvr_lease_stopped', finishedAt: null, attempt: 2, executionKind: 'resume' };
  const queued = { ...running, taskId: 'dvr_task_queued', idempotencyKey: 'queued', sequence: 2, status: 'queued', leaseToken: null,
    childSessionId: null, startedAt: null, executionKind: 'start', attempt: 1 };
  const ledgerFile = path.join(launch.webDataDirectory, 'orchestration', 'ledger.json');
  await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
  await fs.writeFile(ledgerFile, JSON.stringify({ version: 1, tasks: [running, queued], resultEnvelopes: [] }));
  const before = await fs.readFile(ledgerFile, 'utf8');
  return { controlRoot, launch, running, receiptFile, ledgerFile, before,
    read: async () => decodeLedgerSnapshot(JSON.parse(await fs.readFile(ledgerFile, 'utf8'))) };
}

test('cold recovery settles a stopped active task once without relaunching its resume or queued sibling', async () => {
  const f = await fixture();
  expect(await recoverStoppedBundleManagedTasks(f)).toEqual({ status: 'recovered' });
  const saved = await f.read();
  expect(saved.tasks.find(task => task.taskId === f.running.taskId)).toMatchObject({ status: 'interrupted',
    childSessionId: f.running.childSessionId, recoverablePreview: f.running.recoverablePreview, canonicalRefs: f.running.canonicalRefs });
  expect(saved.tasks.find(task => task.taskId === 'dvr_task_queued')?.status).toBe('queued');
  expect(saved.resultEnvelopes).toHaveLength(1);
  const bytes = await fs.readFile(f.ledgerFile, 'utf8');
  expect(await recoverStoppedBundleManagedTasks(f)).toEqual({ status: 'clean' });
  expect(await fs.readFile(f.ledgerFile, 'utf8')).toBe(bytes);
  await expect(fs.access(path.join(path.dirname(f.ledgerFile), 'owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

for (const kind of ['missing-receipt', 'unconfined-receipt', 'active-owner', 'unverifiable-owner', 'provider-writer', 'symlink-receipt']) {
  test(`cold recovery refuses ${kind} evidence and preserves the active ledger`, async () => {
    const f = await fixture();
    if (kind === 'missing-receipt') await fs.unlink(f.receiptFile);
    if (kind === 'unconfined-receipt') await fs.writeFile(f.receiptFile, JSON.stringify({ terminated: true, confined: false, cancelled: true, exitCode: 130 }));
    if (kind === 'active-owner') await fs.writeFile(path.join(path.dirname(f.ledgerFile), 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, token: randomUUID(), acquiredAt: Date.now() }));
    if (kind === 'unverifiable-owner') await fs.writeFile(path.join(path.dirname(f.ledgerFile), 'owner.lock'), '{}');
    if (kind === 'provider-writer') await fs.writeFile(path.join(f.launch.global.state, 'managed-native-provider-processes.json'), JSON.stringify({ version: 2, processes: [{ childPid: process.pid }] }));
    if (kind === 'symlink-receipt') { await fs.rename(f.receiptFile, `${f.receiptFile}.saved`); await fs.symlink(`${f.receiptFile}.saved`, f.receiptFile); }
    const expected = kind === 'missing-receipt' ? 'ENOENT'
      : kind === 'active-owner' || kind === 'unverifiable-owner' ? 'bundle_upgrade_owner_active'
        : kind === 'provider-writer' ? 'bundle_recovery_exit_unverified' : 'bundle_task_stop_unverified';
    await expect(recoverStoppedBundleManagedTasks(f)).rejects.toMatchObject({ code: expected });
    expect(await fs.readFile(f.ledgerFile, 'utf8')).toBe(f.before);
  });
}

test('cold recovery keeps released native proofs in their shards and releases an aged inline proof shard-first', async () => {
  const f = await fixture();
  const proof = index => {
    const task = { ...createManagedTaskRecord({ idempotencyKey: `native-${index}`, rootSessionId: `ses_proof_${index}`, parentTaskId: null, directory: f.running.directory,
      mode: 'orchestrator', providerId: 'openai', modelId: 'fixture', agent: 'fixer', variant: null, label: 'Native', prompt: `Fix ${index}. ${'Context. '.repeat(32)}`,
      taskId: `dvr_task_native_${index}`, sequence: 100 + index, createdAt: 1, timeoutAt: null, attempt: 1, priorTaskId: null, executionKind: 'start', executionBackend: 'native-job' }),
      childSessionId: `ses_proof_child_${index}`, leaseToken: `dvr_lease_proof_${index}`, status: 'failed', startedAt: 1, finishedAt: 2, failureReason: 'failed', partial: true,
      nativeJobSegments: [{ jobID: `dvr_job_${index}`, notificationID: `msg_notice_${index}`, messageID: `msg_prompt_${index}`, state: 'accepted', completion: 'done' }] };
    return { task, envelope: { ...createManagedTaskResultEnvelope(task, { sequence: 100 + index, createdAt: 2, resumable: true }), action: 'abandon', acknowledgedAt: 2 } };
  };
  const released = compactManagedOrchestrationState({ version: 1, tasks: [proof(1).task], resultEnvelopes: [proof(1).envelope] }, { now: 30 * 24 * 60 * 60 * 1000 }).state;
  const proofDirectory = path.join(path.dirname(f.ledgerFile), MANAGED_NATIVE_JOB_PROOF_DIRECTORY);
  const releasedShard = managedNativeJobProofShard(released.tasks[0].taskId);
  await fs.mkdir(proofDirectory, { recursive: true });
  await fs.writeFile(path.join(proofDirectory, `${releasedShard}.json`), encodeManagedNativeJobProofShard(releasedShard, [{ task: released.tasks[0], envelope: released.resultEnvelopes[0] }]));
  const inline = proof(2), original = JSON.parse(f.before);
  await fs.writeFile(f.ledgerFile, JSON.stringify({ ...original, tasks: [...original.tasks, inline.task], resultEnvelopes: [inline.envelope] }));
  expect(await recoverStoppedBundleManagedTasks(f)).toEqual({ status: 'recovered' });
  const saved = await f.read();
  expect(saved.tasks.map(task => task.taskId)).not.toContain(inline.task.taskId);
  expect(saved.tasks.find(task => task.taskId === f.running.taskId)?.status).toBe('interrupted');
  const proofs = [];
  for (const name of await fs.readdir(proofDirectory)) proofs.push(...decodeManagedNativeJobProofShard(JSON.parse(await fs.readFile(path.join(proofDirectory, name), 'utf8')), name.slice(0, 2)));
  expect(proofs.map(entry => entry.task.taskId).sort()).toEqual([released.tasks[0].taskId, inline.task.taskId].sort());
  expect(proofs.find(entry => entry.task.taskId === released.tasks[0].taskId)).toEqual({ task: released.tasks[0], envelope: released.resultEnvelopes[0] });
});
