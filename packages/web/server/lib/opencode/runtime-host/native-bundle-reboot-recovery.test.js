import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { git } from '../../../../../harness-runtime/lib/session-changes-git.js';
import { openChangeStore, changeKey } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { isRebootRecoveredLease, rebootRecoveryHash } from '../../../../../harness-runtime/lib/session-reboot-recovery.js';
import { createSessionMutationRuntime } from '../../../../../harness-runtime/lib/session-mutations.js';
import { withCrossProcessFileLock } from '../../../../../harness-runtime/lib/atomic-file.js';
import { beginNativeBundleRebootRecovery, finishNativeBundleRebootRecoveryAtStartup } from './native-bundle-reboot-recovery.js';
import { assertSelectedBundleLeasesSettled, readBundleLeaseInventory, recoverAbandonedControlLeases } from './native-bundle-lease-recovery.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectBundleHarness } from './bundle-harness-integrity.js';

const roots = [], oldBoot = '10000000-0000-4000-8000-000000000001', newBoot = '20000000-0000-4000-8000-000000000002';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-reboot-recovery-'))); roots.push(root);
  const controlRoot = path.join(root, 'control'); await fs.mkdir(controlRoot, { mode: 0o700 });
  const bundleRoot = path.join(controlRoot, 'bundles', 'selected'), project = path.join(root, 'project');
  await fs.mkdir(project);
  const launch = { opencodeDatabasePath: path.join(bundleRoot, 'opencode', 'opencode.db'), webDataDirectory: path.join(bundleRoot, 'web-data'),
    webConfigDirectory: path.join(bundleRoot, 'config', 'openchamber'), opencodeConfigDirectory: path.join(bundleRoot, 'config', 'opencode'),
    reviewedNativeConfigPath: path.join(bundleRoot, 'config', 'reviewed-native.json'), reviewedPluginManifestPath: path.join(bundleRoot, 'config', 'reviewed-plugins.json'),
    controllerBinary: path.join(root, 'DevRyan-controller'), writerBinary: path.join(root, 'DevRyan-writer'),
    artifactManifestPath: path.join(root, 'native-bundle.json'), artifactManifestSha256: 'a'.repeat(64), global: {} };
  for (const key of ['home', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp']) launch.global[key] = path.join(bundleRoot, 'global', key);
  launch.global.config = launch.opencodeConfigDirectory;
  for (const directory of [launch.webDataDirectory, launch.webConfigDirectory, ...Object.values(launch.global)]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [launch.opencodeDatabasePath, launch.reviewedNativeConfigPath, launch.reviewedPluginManifestPath,
    path.join(bundleRoot, 'sources', 'migration.json')];
  for (const file of files) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '{}'); }
  const descriptor = { schema: 1, bundleID: 'selected', generation: 2, createdAt: 1, launch,
    projectMap: [{ sourceDirectory: project, targetDirectory: project, mode: 'identity' }],
    checkpoint: { checkpointID: 'checkpoint', ownerID: 'owner', generation: 2, settledAt: 1, databasePath: launch.opencodeDatabasePath,
      webDataDirectory: launch.webDataDirectory, webConfigDirectory: launch.webConfigDirectory, opencodeConfigDirectory: launch.opencodeConfigDirectory },
    preparedManifestPath: path.join(bundleRoot, 'prepared.json'), migrationReceiptPath: files[3] };
  const descriptorBytes = JSON.stringify(descriptor); await fs.writeFile(path.join(bundleRoot, 'descriptor.json'), descriptorBytes);
  const preparedBytes = JSON.stringify({ schema: 1, bundleID: 'selected', checkpointID: 'checkpoint', descriptorSha256: hash(descriptorBytes) });
  await fs.writeFile(descriptor.preparedManifestPath, preparedBytes);
  const selection = { schema: 1, revision: 1, selectedBundleID: 'selected', previousBundleID: null,
    transition: 'activate', reconciliationRequired: false, preparedManifestSha256: hash(preparedBytes) };
  await fs.writeFile(path.join(controlRoot, 'selection.json'), JSON.stringify(selection), { mode: 0o600 });
  const ledgerRoot = path.join(launch.webDataDirectory, 'harness', 'session-mutations', changeKey(project));
  await fs.mkdir(ledgerRoot, { recursive: true, mode: 0o700 }); await git(ledgerRoot, ['init', '--bare', '--quiet', path.join(ledgerRoot, 'git')]);
  const token = randomUUID(), key = `leases/${changeKey(token)}.json`;
  const lease = { token, ownerID: randomUUID(), state: 'ready', executionKind: 'process', directory: project,
    generation: 0, scope: { sessionID: 'session', messageID: 'message', userMessageID: 'user', callID: 'call' },
    viewDirectory: path.join(ledgerRoot, 'views', token, 'view'), cleaned: false, cleanupPending: false };
  await fs.mkdir(lease.viewDirectory, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(lease.viewDirectory, 'proof.txt'), 'unpublished work');
  const open = () => openChangeStore(ledgerRoot, path.join(ledgerRoot, 'git'));
  const db = await open(); db.set('meta.json', { version: 1, directory: project, sequence: 0 }); db.set(key, lease); await db.commit();
  const options = { controlRoot, expectedRevision: 1, readBootIdentity: async () => oldBoot,
    assertOwnerAbsent: async () => {}, ownerLost: async () => true, verifyArtifacts: async () => ({ controller: launch.controllerBinary }) };
  return { root, controlRoot, launch, lease, key, open, options, ledgerRoot, selection,
    finish: extra => withCrossProcessFileLock(path.join(controlRoot, 'bootstrap.lock'), () =>
      finishNativeBundleRebootRecoveryAtStartup({ ...options, readBootIdentity: async () => newBoot, ...extra })) };
}

test('receiptless process recovery requires reboot and preserves an uncertain private view', async () => {
  const f = await fixture();
  await expect(assertSelectedBundleLeasesSettled(f)).rejects.toMatchObject({ code: 'bundle_execution_unsettled' });
  expect(await beginNativeBundleRebootRecovery(f.options)).toMatchObject({ status: 'reboot_required', revision: 1, leaseCount: 1 });
  expect(await beginNativeBundleRebootRecovery(f.options)).toMatchObject({ status: 'reboot_required' });
  await expect(f.finish({ readBootIdentity: async () => oldBoot })).rejects.toMatchObject({ code: 'bundle_reboot_required' });
  expect((await (await f.open()).get(f.key)).state).toBe('ready');
  expect(await f.finish()).toEqual({ status: 'completed', recoveredLeases: 1, outcome: 'uncertain' });
  const recovered = await (await f.open()).get(f.key);
  expect(isRebootRecoveredLease(recovered)).toBe(true);
  expect(recovered.cancelledBeforeStart).toBeUndefined(); expect(recovered.result).toBeUndefined();
  expect(await fs.readFile(path.join(f.lease.viewDirectory, 'proof.txt'), 'utf8')).toBe('unpublished work');
  await expect(fs.access(path.join(path.dirname(f.lease.viewDirectory), 'termination.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await assertSelectedBundleLeasesSettled(f);
  await inspectBundleHarness(f.launch.webDataDirectory, { sessionIDs: ['session'], messageIDs: ['message', 'user'] });
  expect(JSON.parse(await fs.readFile(path.join(f.controlRoot, 'selection.json'), 'utf8'))).toEqual(f.selection);
  expect(await f.finish()).toEqual({ status: 'completed' });
  // Interrupted after ledger commit, before the private intent completion write.
  const intentFile = path.join(f.controlRoot, 'recovery', 'reboot.json'), intent = JSON.parse(await fs.readFile(intentFile, 'utf8'));
  intent.state = 'prepared'; delete intent.currentBoot; await fs.writeFile(intentFile, JSON.stringify(intent), { mode: 0o600 });
  expect(await f.finish({ readBootIdentity: async () => '30000000-0000-4000-8000-000000000003' })).toMatchObject({ status: 'completed' });
  expect((await (await f.open()).get(f.key)).rebootRecovery.currentBoot).toBe(newBoot);
});

test('fences refuse owner activity, wrong revisions, unknown boot, materialization and changed evidence', async () => {
  for (const change of ['owner', 'revision', 'boot', 'materialization', 'lease', 'view']) {
    const f = await fixture();
    if (change === 'owner') { await expect(beginNativeBundleRebootRecovery({ ...f.options, ownerLost: async () => false })).rejects.toMatchObject({ code: 'bundle_upgrade_owner_active' }); continue; }
    if (change === 'revision') { await expect(beginNativeBundleRebootRecovery({ ...f.options, expectedRevision: 2 })).rejects.toMatchObject({ code: 'bundle_selection_revision_conflict' }); continue; }
    if (change === 'boot') { await expect(beginNativeBundleRebootRecovery({ ...f.options, readBootIdentity: async () => null })).rejects.toMatchObject({ code: 'bundle_reboot_identity_unavailable' }); continue; }
    await beginNativeBundleRebootRecovery(f.options);
    if (change === 'view') await fs.writeFile(path.join(f.lease.viewDirectory, 'proof.txt'), 'changed');
    else { const db = await f.open(); db.set(change === 'materialization' ? 'materialization.json' : f.key,
      change === 'materialization' ? { pending: true } : { ...f.lease, generation: 1 }); await db.commit(); }
    await expect(f.finish()).rejects.toMatchObject({ code: change === 'materialization' ? 'bundle_materialization_pending' : 'bundle_reboot_recovery_changed' });
    expect((await (await f.open()).get(f.key)).rebootRecovery).toBeUndefined();
  }
});

test('invalid receipts are never reboot proof; genuine receipts use ordinary recovery', async () => {
  const f = await fixture(), receiptFile = path.join(path.dirname(f.lease.viewDirectory), 'termination.json');
  await fs.writeFile(receiptFile, '{}', { mode: 0o600 });
  await expect(beginNativeBundleRebootRecovery(f.options)).rejects.toMatchObject({ code: 'mutation_termination_unconfirmed' });
  await fs.writeFile(receiptFile, JSON.stringify({ terminated: true, confined: true, cancelled: true, exitCode: 137 }), { mode: 0o600 });
  await expect(beginNativeBundleRebootRecovery(f.options)).rejects.toMatchObject({ code: 'bundle_reboot_recovery_receipt_available' });
  const calls = [];
  const runtime = { activeLeases: async () => [f.lease], pendingCleanup: async () => [], cancelLease: async lease => calls.push(lease), drain: async () => {} };
  await recoverAbandonedControlLeases({ ...f.options, launch: f.launch, createRuntime: () => runtime });
  expect(calls).toEqual([f.lease]);
});

test('a relocated old recovery does not prevent a later independent fence', async () => {
  const f = await fixture(); await beginNativeBundleRebootRecovery(f.options); await f.finish();
  const db = await f.open(), old = await db.get(f.key);
  db.set(f.key, { ...old, directory: path.join(f.root, 'relocated'), viewDirectory: path.join(f.root, 'relocated', 'view') });
  const lease = { ...f.lease, token: randomUUID(), ownerID: randomUUID(), scope: { ...f.lease.scope, callID: 'next-call' } };
  lease.viewDirectory = path.join(f.ledgerRoot, 'views', lease.token, 'view'); await fs.mkdir(lease.viewDirectory, { recursive: true });
  const key = `leases/${changeKey(lease.token)}.json`; db.set(key, lease); await db.commit();
  await beginNativeBundleRebootRecovery({ ...f.options, readBootIdentity: async () => newBoot });
  await f.finish({ readBootIdentity: async () => '30000000-0000-4000-8000-000000000003' });
  expect(isRebootRecoveredLease(await (await f.open()).get(key))).toBe(true);
});

test('a genuine reserved/prepared/claimed process retains its pin and supports clone relocation', async () => {
  const f = await fixture(), initial = await f.open(); initial.remove(f.key); await initial.commit();
  const project = f.lease.directory; await git(project, ['init', '--quiet']); await fs.writeFile(path.join(project, 'input.txt'), 'project unchanged');
  const storage = path.join(f.launch.webDataDirectory, 'harness', 'session-mutations');
  const runtime = createSessionMutationRuntime({ directory: storage });
  const reserved = await runtime.reserve({ directory: project, sessionID: 'real-session', userMessageID: 'real-user', messageID: 'real-message',
    callID: 'real-call', ownerID: randomUUID() });
  const prepared = await runtime.prepare(reserved);
  const lease = await runtime.claimLease({ directory: project, token: prepared.token, kind: 'process' });
  const pin = `refs/devryan/leases/${lease.token}`, gitArgs = ['--git-dir', path.join(f.ledgerRoot, 'git')];
  const originalPin = (await git(f.ledgerRoot, [...gitArgs, 'rev-parse', '--verify', pin])).toString().trim();
  await beginNativeBundleRebootRecovery(f.options); await f.finish();
  expect((await git(f.ledgerRoot, [...gitArgs, 'for-each-ref', '--format=%(objectname)', pin])).toString().trim()).toBe('');
  const archive = (await git(f.ledgerRoot, [...gitArgs, 'for-each-ref', '--format=%(objectname)', 'refs/devryan/reboot/'])).toString().trim();
  expect(archive).toBe(originalPin);
  const query = { directory: project, sessionID: 'real-session', calls: [{ messageID: 'real-message', callID: 'real-call' }] };
  expect((await runtime.executionOutcomes(query))[0].outcome).toBe('uncertain');
  await expect(runtime.cancelUnstartedCall({ directory: project, sessionID: 'real-session', messageID: 'real-message', callID: 'real-call' }))
    .rejects.toMatchObject({ code: 'execution_already_started' });
  expect(await runtime.cleanupLease(lease)).toBe(false);
  const source = await inspectBundleHarness(f.launch.webDataDirectory, { sessionIDs: ['real-session'], messageIDs: ['real-user', 'real-message'] });
  const copied = path.join(f.root, 'copied-web-data'); await fs.cp(f.launch.webDataDirectory, copied, { recursive: true });
  await inspectBundleHarness(copied, { relocate: true, sourceWebDataDirectory: f.launch.webDataDirectory,
    projectMap: [{ sourceDirectory: project, targetDirectory: project, mode: 'identity' }],
    sessionIDs: ['real-session'], messageIDs: ['real-user', 'real-message'] });
  await inspectBundleHarness(copied, { preservedRefs: { checkpointID: 'checkpoint', refs: source.refs },
    projectMap: [{ sourceDirectory: project, targetDirectory: project, mode: 'identity' }], sessionIDs: ['real-session'], messageIDs: ['real-user', 'real-message'] });
  expect(await fs.readFile(path.join(project, 'input.txt'), 'utf8')).toBe('project unchanged');
  expect((await runtime.executionOutcomes(query))[0].outcome).toBe('uncertain');
  await runtime.drain();
}, 30000);

test('a symlinked private Git store never receives recovery reads or writes', async () => {
  const f = await fixture(), gitDirectory = path.join(f.ledgerRoot, 'git'), foreign = path.join(f.root, 'foreign-git');
  await fs.rename(gitDirectory, foreign); await fs.symlink(foreign, gitDirectory);
  await expect(beginNativeBundleRebootRecovery(f.options)).rejects.toMatchObject({ code: 'bundle_path_invalid' });
  await expect(fs.access(path.join(f.controlRoot, 'recovery', 'reboot.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('both native actions hold selector ownership before observing or mutating leases', async () => {
  const f = await fixture(), observed = [];
  const assertOwnerAbsent = async () => {
    await fs.access(path.join(f.controlRoot, 'bootstrap.lock'));
    await fs.access(path.join(f.controlRoot, 'selection.lock'));
    observed.push(true);
  };
  await beginNativeBundleRebootRecovery({ ...f.options, assertOwnerAbsent });
  await f.finish({ assertOwnerAbsent });
  expect(observed.length).toBeGreaterThanOrEqual(4);
  await expect(fs.access(path.join(f.controlRoot, 'selection.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a ledger and view beyond the former inventory caps still prepare, with the released digest', async () => {
  const f = await fixture(), db = await f.open();
  for (let index = 0; index < 34000; index++) db.set(`files/${String(index).padStart(6, '0')}.json`, { index, nested: { b: 1, a: [index] } });
  await db.commit();
  await promisify(execFile)('/usr/bin/mkfifo', [path.join(path.dirname(f.lease.viewDirectory), 'pipe')]);
  const rows = []; for await (const { key, value } of (await f.open()).records()) rows.push({ key, value });
  expect(rows.length).toBeGreaterThan(32768);
  const ledgers = await readBundleLeaseInventory(f.launch, { allRecords: true });
  // Intents prepared by 2.0.9 hashed the materialized list; the digest must not move.
  expect(ledgers.inventorySha256).toBe(rebootRecoveryHash([{ root: f.ledgerRoot, directory: f.lease.directory, records: rows }]));
  expect(ledgers[0].records.map(row => row.key)).toEqual([f.key]);
  expect(await beginNativeBundleRebootRecovery(f.options)).toMatchObject({ status: 'reboot_required', leaseCount: 1 });
  expect(await f.finish()).toMatchObject({ status: 'completed', recoveredLeases: 1 });
}, 120000);

test('a new preparation retires a fence whose evidence changed', async () => {
  const f = await fixture(); await beginNativeBundleRebootRecovery(f.options);
  const intentFile = path.join(f.controlRoot, 'recovery', 'reboot.json'), first = JSON.parse(await fs.readFile(intentFile, 'utf8'));
  await fs.writeFile(path.join(f.lease.viewDirectory, 'proof.txt'), 'changed');
  await expect(f.finish()).rejects.toMatchObject({ code: 'bundle_reboot_recovery_changed' });
  expect(await beginNativeBundleRebootRecovery({ ...f.options, readBootIdentity: async () => newBoot })).toMatchObject({ status: 'reboot_required', leaseCount: 1 });
  const second = JSON.parse(await fs.readFile(intentFile, 'utf8'));
  expect(second.fenceID).not.toBe(first.fenceID); expect(second.previousBoot).toBe(newBoot);
  expect(JSON.parse(await fs.readFile(path.join(f.controlRoot, 'recovery', `reboot-superseded-${first.fenceID}.json`), 'utf8'))).toEqual(first);
  expect(await f.finish({ readBootIdentity: async () => '30000000-0000-4000-8000-000000000003' })).toMatchObject({ status: 'completed' });
});

test('cold recovery cancels an aged receiptless process lease as never started; young or started ones stay held', async () => {
  const f = await fixture(), initial = await f.open(); initial.remove(f.key); await initial.commit();
  const project = f.lease.directory; await git(project, ['init', '--quiet']); await fs.writeFile(path.join(project, 'input.txt'), 'project unchanged');
  const storage = path.join(f.launch.webDataDirectory, 'harness', 'session-mutations');
  const seed = async (callID) => {
    const runtime = createSessionMutationRuntime({ directory: storage });
    const reserved = await runtime.reserve({ directory: project, sessionID: 'real-session', userMessageID: 'real-user', messageID: 'real-message', callID, ownerID: randomUUID() });
    const lease = await runtime.claimLease({ directory: project, token: (await runtime.prepare(reserved)).token, kind: 'process' });
    await runtime.drain(); return { lease, key: `leases/${changeKey(lease.token)}.json` };
  };
  const age = async ({ key }) => { const db = await f.open(); db.set(key, { ...await db.get(key), reservedAt: Date.now() - 11 * 60_000 }); await db.commit(); };
  const recover = () => recoverAbandonedControlLeases({ ...f.options, launch: f.launch });
  const young = await seed('young-call');
  expect(await recover()).toEqual({ status: 'failed', code: 'bundle_lease_recovery_failed:ENOENT' });
  expect((await (await f.open()).get(young.key)).state).toBe('ready');
  await age(young);
  expect(await recoverAbandonedControlLeases({ ...f.options, launch: f.launch, ownerLost: async () => false })).toMatchObject({ status: 'failed' });
  expect(await recover()).toEqual({ status: 'recovered' });
  expect(await (await f.open()).get(young.key)).toMatchObject({ state: 'cancelled', cancelledBeforeStart: true, cleaned: true, cleanupPending: false });
  await expect(fs.access(young.lease.viewDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  await assertSelectedBundleLeasesSettled(f);
  await inspectBundleHarness(f.launch.webDataDirectory, { sessionIDs: ['real-session'], messageIDs: ['real-user', 'real-message'] });
  // The supervisor created its receipt: the command may have run.
  const started = await seed('started-call'); await age(started);
  await fs.writeFile(path.join(path.dirname(started.lease.viewDirectory), 'termination.json'), '', { mode: 0o600 });
  expect(await recover()).toEqual({ status: 'failed', code: 'mutation_termination_unconfirmed' });
  expect((await (await f.open()).get(started.key)).state).toBe('ready');
  expect(await fs.readFile(path.join(project, 'input.txt'), 'utf8')).toBe('project unchanged');
}, 60000);
