import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withCrossProcessFileLock } from '../../../../../harness-runtime/lib/atomic-file.js';
import { readSessionExecutionReceipt } from '../../../../../harness-runtime/lib/session-execution.js';
import { executionHostOwnerLost } from '../../../../../harness-runtime/lib/execution-host-owner.js';
import { isRebootRecoveredLease, recoverProcessLeaseAfterReboot, rebootRecoveryCanonical, rebootRecoveryHash } from '../../../../../harness-runtime/lib/session-reboot-recovery.js';
import { readRuntimeBundleBinding } from './runtime-bundle-binding.js';
import { readBundleLeaseInventory } from './native-bundle-lease-recovery.js';
import { assertNoLiveOwner } from './native-bundle-startup-upgrade.js';
import { canonicalJSON, readBundleJSON, saveBundleJSON, containsPath } from './bundle-migration-inventory.js';
import { executionArtifacts } from '../execution-artifacts.js';
import { verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { git } from '../../../../../harness-runtime/lib/session-changes-git.js';

const exec = promisify(execFile), protocol = 'devryan.bundle-reboot-recovery/1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = code => Object.assign(Error(code), { code, status: 503 });
const intentPath = root => path.join(root, 'recovery', 'reboot.json');
const unsettled = lease => !['published', 'cancelled'].includes(lease.state) || lease.cleanupPending;

export async function readMacosBootIdentity() {
  if (process.platform !== 'darwin') throw fail('bundle_reboot_recovery_unsupported');
  let value;
  try { value = (await exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 2000, maxBuffer: 256 })).stdout.trim().toLowerCase(); }
  catch { throw fail('bundle_reboot_identity_unavailable'); }
  if (!uuid.test(value)) throw fail('bundle_reboot_identity_unavailable');
  return value;
}

async function privateRoot(root) {
  if (!path.isAbsolute(root ?? '') || path.normalize(root) !== root) throw fail('bundle_reboot_recovery_invalid');
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root
    || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail('bundle_reboot_recovery_invalid');
}

const selected = controlRoot => {
  const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }, { allowHeldInspection: true });
  if (binding.admission === 'held' || binding.selection.reconciliationRequired) throw fail('bundle_runtime_admission_held');
  return binding;
};
const bindingHash = binding => rebootRecoveryHash({ descriptor: binding.descriptor, selection: binding.selection });
const lockLedgers = (ledgers, action, index = 0) => index === ledgers.length ? action()
  : withCrossProcessFileLock(path.join(ledgers[index].root, 'owner.lock'), () => lockLedgers(ledgers, action, index + 1));

async function assertLeasePins(ledgers, intent) {
  for (const ledger of ledgers) {
    const expected = intent.leasePins.filter(pin => pin.root === ledger.root);
    for (const pin of ledger.leasePins) if (!expected.some(row => row.ref === pin.ref && row.oid === pin.oid)) throw fail('bundle_reboot_recovery_changed');
    for (const pin of expected) {
      const active = ledger.leasePins.find(row => row.ref === pin.ref);
      if (active?.oid === pin.oid) continue;
      if (!pin.archiveRef) throw fail('bundle_reboot_recovery_changed');
      const archived = (await git(ledger.root, ['--git-dir', path.join(ledger.root, 'git'), 'for-each-ref', '--format=%(objectname)', pin.archiveRef])).toString().trim();
      if (active || archived !== pin.oid) throw fail('bundle_reboot_recovery_changed');
    }
  }
}

async function retainLeasePins(ledger, intent) {
  for (const pin of intent.leasePins.filter(row => row.root === ledger.root && row.archiveRef)) {
    const args = ['--git-dir', path.join(ledger.root, 'git')];
    const active = (await git(ledger.root, [...args, 'for-each-ref', '--format=%(objectname)', pin.ref])).toString().trim();
    if (!active) continue; // The exact archive was checked under this same lock.
    await git(ledger.root, [...args, 'update-ref', '--stdin'], { input: `start\ncreate ${pin.archiveRef} ${pin.oid}\ndelete ${pin.ref} ${pin.oid}\nprepare\ncommit\n` });
  }
}

/** Hash private evidence without following symlinks or exposing its contents.
 * The digest is the canonical hash of the row list, built without retaining it:
 * a view holds every project file, and its scratch may hold sockets. */
async function viewHash(ledgerRoot, lease) {
  const parent = path.dirname(lease.viewDirectory ?? '');
  if (!path.isAbsolute(lease.viewDirectory ?? '') || !containsPath(path.join(ledgerRoot, 'views'), parent)
    || parent === path.join(ledgerRoot, 'views') || await fs.realpath(parent) !== parent) throw fail('bundle_execution_path_unknown');
  const digest = createHash('sha256').update('['); let count = 0;
  const rows = { push: row => digest.update(`${count++ ? ',' : ''}${rebootRecoveryCanonical(row)}`) };
  const walk = async (directory, relative = '') => {
    if (await fs.realpath(directory) !== directory) throw fail('bundle_execution_path_unknown');
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) rows.push({ path: name, link: await fs.readlink(file) });
      else if (stat.isDirectory()) { rows.push({ path: name, directory: true }); await walk(file, name); }
      else if (stat.isFile()) {
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await handle.stat(), hash = createHash('sha256');
          if (before.ino !== stat.ino || before.dev !== stat.dev) throw fail('bundle_reboot_recovery_changed');
          for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
          const after = await fs.lstat(file);
          if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail('bundle_reboot_recovery_changed');
          rows.push({ path: name, mode: stat.mode & 0o777, sha256: hash.digest('hex') });
        } finally { await handle.close(); }
      } else rows.push({ path: name, special: stat.mode & constants.S_IFMT });
    }
  };
  await walk(parent);
  return digest.update(']').digest('hex');
}

async function readIntent(controlRoot) {
  try {
    await privateRoot(path.join(controlRoot, 'recovery'));
    const file = intentPath(controlRoot), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
      || await fs.realpath(file) !== file) throw fail('bundle_reboot_recovery_invalid');
    const intent = await readBundleJSON(file);
    if (intent?.protocol !== protocol || !uuid.test(intent.fenceID) || !uuid.test(intent.previousBoot)
      || !['prepared', 'completed'].includes(intent.state) || !Number.isSafeInteger(intent.revision)
      || !/^[a-f0-9]{64}$/.test(intent.bindingSha256) || !/^[a-f0-9]{64}$/.test(intent.inventorySha256)
      || !Array.isArray(intent.leases) || !intent.leases.length || intent.leases.length > 128) throw fail('bundle_reboot_recovery_invalid');
    if (!Array.isArray(intent.leasePins) || intent.leasePins.length > 1024 || intent.leasePins.some(pin =>
      typeof pin.root !== 'string' || !/^refs\/devryan\/leases\/[a-f0-9-]{36}$/.test(pin.ref ?? '') || !/^[a-f0-9]{40,64}$/.test(pin.oid ?? '')
      || pin.archiveRef !== undefined && pin.archiveRef !== `refs/devryan/reboot/${intent.fenceID}/${pin.ref.split('/').at(-1)}`)) throw fail('bundle_reboot_recovery_invalid');
    return intent;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Trusted native action only; prepares evidence but never reboots the machine. */
export async function beginNativeBundleRebootRecovery({ controlRoot, expectedRevision, readBootIdentity = readMacosBootIdentity,
  assertOwnerAbsent = assertNoLiveOwner, verifyArtifacts = verifyNativeRuntimeArtifacts, ownerLost = executionHostOwnerLost, storeOptions = {} }) { // storeOptions: openChangeStore overrides (tests shrink listingLimitBytes)
  await privateRoot(controlRoot);
  return withCrossProcessFileLock(path.join(controlRoot, 'bootstrap.lock'), () =>
    withCrossProcessFileLock(path.join(controlRoot, 'selection.lock'), async () => {
    const binding = selected(controlRoot), launch = binding.descriptor.launch;
    if (expectedRevision !== binding.selection.revision) throw fail('bundle_selection_revision_conflict');
    await assertOwnerAbsent(launch);
    const previousBoot = await readBootIdentity();
    if (!uuid.test(previousBoot)) throw fail('bundle_reboot_identity_unavailable');
    const prior = await readIntent(controlRoot);
    const launcher = executionArtifacts(path.dirname(launch.artifactManifestPath)).launcher;
    const artifacts = await verifyArtifacts({ manifestPath: launch.artifactManifestPath, manifestSha256: launch.artifactManifestSha256, launcher, purpose: 'bundle-source' });
    if (artifacts.controller !== launch.controllerBinary) throw fail('bundle_artifact_generation_mismatch');
    const before = await readBundleLeaseInventory(launch, { storeOptions });
    return lockLedgers(before, async () => {
      if (prior?.state === 'prepared') {
        let held = false;
        try {
          const ledgers = await readBundleLeaseInventory(launch, { allRecords: true, intent: prior, storeOptions });
          held = prior.bindingSha256 === bindingHash(binding) && prior.previousBoot === previousBoot && ledgers.inventorySha256 === prior.inventorySha256
            && canonicalJSON(before.map(row => row.root)) === canonicalJSON(ledgers.map(row => row.root));
          if (held) await assertLeasePins(ledgers, prior);
          for (const entry of held ? prior.leases : []) {
            const ledger = ledgers.find(row => row.root === entry.root), row = ledger?.records.find(row => row.key === entry.key);
            if (!row || await viewHash(ledger.root, row.value) !== entry.viewSha256) throw fail('bundle_reboot_recovery_changed');
          }
        } catch (error) { if (error.code !== 'bundle_reboot_recovery_changed') throw error; held = false; }
        if (held) return { status: 'reboot_required', protocol, revision: expectedRevision, leaseCount: prior.leases.length };
        // The evidence under an unfinished fence changed, so it can never
        // complete. Leases it already recovered stay recovered; retire it and
        // fence the current evidence instead of refusing every later launch.
        await fs.rename(intentPath(controlRoot), path.join(controlRoot, 'recovery', `reboot-superseded-${prior.fenceID}.json`));
      }
      const ledgers = await readBundleLeaseInventory(launch, { allRecords: true, storeOptions });
      if (canonicalJSON(before.map(row => row.root)) !== canonicalJSON(ledgers.map(row => row.root))) throw fail('bundle_reboot_recovery_changed');
      const leases = [];
      for (const ledger of ledgers) for (const row of ledger.records) {
        if (!row.key.startsWith('leases/') || !unsettled(row.value)) continue;
        const lease = row.value;
        if (lease.executionKind !== 'process' || lease.state !== 'ready' || !uuid.test(lease.ownerID) || lease.cancelledBeforeStart)
          throw fail('bundle_execution_unsettled');
        if (!await ownerLost({ directory: path.join(launch.webDataDirectory, 'harness', 'execution-owners'), launcher, id: lease.ownerID })) throw fail('bundle_upgrade_owner_active');
        try { await readSessionExecutionReceipt(lease, { launcher }); throw fail('bundle_reboot_recovery_receipt_available'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        leases.push({ root: ledger.root, key: row.key, originalLeaseSha256: rebootRecoveryHash(lease), viewSha256: await viewHash(ledger.root, lease) });
      }
      if (!leases.length || leases.length > 128) throw fail('bundle_reboot_recovery_unavailable');
      await assertOwnerAbsent(launch);
      if (bindingHash(selected(controlRoot)) !== bindingHash(binding) || await readBootIdentity() !== previousBoot) throw fail('bundle_reboot_recovery_changed');
      const fenceID = randomUUID();
      const leasePins = ledgers.flatMap(ledger => ledger.leasePins.map(pin => ({ root: ledger.root, ...pin,
        ...(leases.some(entry => entry.root === ledger.root && ledger.records.find(row => row.key === entry.key)?.value.token === pin.ref.split('/').at(-1))
          ? { archiveRef: `refs/devryan/reboot/${fenceID}/${pin.ref.split('/').at(-1)}` } : {}) })));
      const intent = { protocol, fenceID, state: 'prepared', previousBoot, revision: expectedRevision,
        bindingSha256: bindingHash(binding), inventorySha256: ledgers.inventorySha256, leases, leasePins };
      await fs.mkdir(path.join(controlRoot, 'recovery'), { recursive: true, mode: 0o700 });
      await privateRoot(path.join(controlRoot, 'recovery'));
      await saveBundleJSON(intentPath(controlRoot), intent);
      return { status: 'reboot_required', protocol, revision: expectedRevision, leaseCount: leases.length };
    });
  }));
}

/** Caller holds bootstrap.lock; selection precedes ledger locks, never vice versa. */
export async function finishNativeBundleRebootRecoveryAtStartup({ controlRoot, readBootIdentity = readMacosBootIdentity,
  assertOwnerAbsent = assertNoLiveOwner, verifyArtifacts = verifyNativeRuntimeArtifacts, ownerLost = executionHostOwnerLost, storeOptions = {} }) { // storeOptions: openChangeStore overrides (tests shrink listingLimitBytes)
  await privateRoot(controlRoot);
  const intent = await readIntent(controlRoot);
  if (!intent || intent.state === 'completed') return { status: intent ? 'completed' : 'none' };
  return withCrossProcessFileLock(path.join(controlRoot, 'selection.lock'), async () => {
  const binding = selected(controlRoot), launch = binding.descriptor.launch;
  if (binding.selection.revision !== intent.revision || bindingHash(binding) !== intent.bindingSha256) throw fail('bundle_reboot_recovery_changed');
  const currentBoot = await readBootIdentity();
  if (!uuid.test(currentBoot)) throw fail('bundle_reboot_identity_unavailable');
  if (currentBoot.toLowerCase() === intent.previousBoot.toLowerCase()) throw fail('bundle_reboot_required');
  await assertOwnerAbsent(launch);
  const launcher = executionArtifacts(path.dirname(launch.artifactManifestPath)).launcher;
  const artifacts = await verifyArtifacts({ manifestPath: launch.artifactManifestPath, manifestSha256: launch.artifactManifestSha256,
    launcher, purpose: 'bundle-source' });
  if (artifacts.controller !== launch.controllerBinary) throw fail('bundle_artifact_generation_mismatch');
  const before = await readBundleLeaseInventory(launch, { storeOptions });
  return lockLedgers(before, async () => {
    const ledgers = await readBundleLeaseInventory(launch, { allRecords: true, intent, storeOptions });
    if (canonicalJSON(before.map(row => row.root)) !== canonicalJSON(ledgers.map(row => row.root))
      || ledgers.inventorySha256 !== intent.inventorySha256) throw fail('bundle_reboot_recovery_changed');
    await assertLeasePins(ledgers, intent);
    for (const entry of intent.leases) {
      const ledger = ledgers.find(row => row.root === entry.root), row = ledger?.records.find(row => row.key === entry.key);
      if (!row || await viewHash(ledger.root, row.value) !== entry.viewSha256) throw fail('bundle_reboot_recovery_changed');
      if (!await ownerLost({ directory: path.join(launch.webDataDirectory, 'harness', 'execution-owners'), launcher, id: row.value.ownerID }))
        throw fail('bundle_upgrade_owner_active');
      if (row.value.rebootRecovery) {
        if (!isRebootRecoveredLease(row.value) || row.value.rebootRecovery.fenceID !== intent.fenceID
          || row.value.rebootRecovery.previousBoot !== intent.previousBoot) throw fail('bundle_reboot_recovery_changed');
      } else row.value = recoverProcessLeaseAfterReboot(row.value, { ...entry, fenceID: intent.fenceID, previousBoot: intent.previousBoot, currentBoot });
    }
    await assertOwnerAbsent(launch);
    if (bindingHash(selected(controlRoot)) !== intent.bindingSha256 || await readBootIdentity() !== currentBoot) throw fail('bundle_reboot_recovery_changed');
    for (const ledger of ledgers) {
      for (const entry of intent.leases.filter(row => row.root === ledger.root)) {
        const row = ledger.records.find(record => record.key === entry.key);
        ledger.db.set(row.key, row.value);
      }
      await ledger.db.commit();
      await retainLeasePins(ledger, intent);
    }
    await saveBundleJSON(intentPath(controlRoot), { ...intent, state: 'completed', currentBoot });
    return { status: 'completed', recoveredLeases: intent.leases.length, outcome: 'uncertain' };
  });
  });
}
