import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from './native-bundle-credential-contract.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import request from '../../../test-supertest.js';
import { afterEach, expect, test, vi } from 'vitest';
import { createRuntimeBundleLifecycle, createRuntimeBundleAdmissionGate, createRuntimeBundleWorkFence,
  registerRuntimeBundleLifecycleRoutes } from './runtime-bundle-lifecycle.js';

const roots = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture({ unknownController = false, unsettledController = false, failDrain = false, drainFailures = 0, failProjection = false,
  failRestart = false, failQuiesce = false, failCapture = false, failRetain = false, failStore = null, reconciliationRequired = false,
  retainCheckpoint, beforeReadSelected, beforeDrain, neverStarted = false, assertOwner } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'runtime-bundle-lifecycle-')); roots.push(root);
  const launch = { opencodeDatabasePath: path.join(root, 'a.db'), webDataDirectory: path.join(root, 'web'),
    webConfigDirectory: path.join(root, 'web-config'), opencodeConfigDirectory: path.join(root, 'config'),
    controllerBinary: path.join(root, 'old-controller'), writerBinary: path.join(root, 'old-writer'),
    artifactManifestPath: path.join(root, 'old-manifest.json'), artifactManifestSha256: 'a'.repeat(64),
    reviewedNativeConfigPath: path.join(root, 'reviewed.json') };
  await fs.writeFile(launch.opencodeDatabasePath, 'fixture database');
  for (const directory of [launch.webDataDirectory, launch.webConfigDirectory, launch.opencodeConfigDirectory]) await fs.mkdir(directory);
  const descriptor = { bundleID: 'A', generation: 2, launch, projectMap: [{ sourceDirectory: root, targetDirectory: root, mode: 'identity' }] };
  const binding = { controlRoot: root, descriptor, selection: { revision: 1, selectedBundleID: 'A', previousBundleID: 'prior', reconciliationRequired } };
  let selected = structuredClone({ descriptor, selection: binding.selection });
  let exited = false, prepared, callbacks, remainingDrainFailures = drainFailures;
  const events = [];
  // The real application admission gate, as composed by application.js main().
  const gate = createRuntimeBundleAdmissionGate();
  const injected = code => Object.assign(new Error(code), { code });
  const controller = { hasExited: () => exited, call: async input => { events.push(input.action); if (failQuiesce) throw injected('bundle_controller_quiesce_failed'); },
    close: async () => { events.push('controller-close'); exited = !unsettledController; } };
  const manifest = { opencodeVersion: '2.0.20', inputs: { coreDigest: 'c'.repeat(64), reviewedPlugins: [] },
    compiledContracts: ['devryan-v2-clone/1', NATIVE_BUNDLE_CREDENTIAL_CONTRACT, 'devryan.bundle.credential-owners/2'] };
  const artifactDirectory = path.join(root, 'app-resources'); await fs.mkdir(artifactDirectory);
  const bytes = JSON.stringify(manifest); await fs.writeFile(path.join(artifactDirectory, 'native-bundle.json'), bytes);
  const candidateHash = digest(bytes);
  const retained = { manifest, manifestSha256: candidateHash, manifestPath: path.join(root, 'artifacts', candidateHash, 'native-bundle.json'),
    controller: path.join(root, 'new-controller'), writer: path.join(root, 'new-writer') };
  const verifyArtifacts = vi.fn(async input => input.manifestSha256 === 'a'.repeat(64)
    ? { manifest, controller: launch.controllerBinary, writer: launch.writerBinary } : retained);
  const credentialProcess = vi.fn(async input => {
    await input.assertHeld(); events.push(input.action.action);
    if (failCapture && input.action.action === 'capture') throw injected('bundle_credential_capture_failed');
    if (input.action.action === 'project') {
      if (failProjection) throw Object.assign(new Error('incompatible'), { code: 'bundle_credential_contract_incompatible' });
      return { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, status: 'projected', ...input.action.binding, appliedSha256: input.action.binding.sourceSha256 };
    }
    return { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, status: 'captured', sha256: 'd'.repeat(64), snapshot: { credentials: [] } };
  });
  const storeFactory = options => {
    callbacks = options;
    return {
      readSelected: async () => { await beforeReadSelected?.(); return selected; },
      prepare: async input => options.withQuiescedSource(failStore === 'source' ? { kind: 'bundle', bundleID: 'B' } : input.source, async (proof, scope) => {
        await scope.assertHeld(); events.push('prepare');
        if (failStore === 'prepare') throw injected('bundle_prepare_copy_failed');
        await options.captureCredentials({ descriptor, checkpoint: proof, assertHeld: scope.assertHeld });
        prepared = { ...descriptor, bundleID: input.bundleID, sourceBundleID: 'A', launch: { ...launch, ...input.launchArtifacts } };
        return prepared;
      }),
      select: async input => options.withQuiescedSource({ kind: 'bundle', bundleID: 'A' }, async (proof, scope) => {
        await scope.assertHeld(); await options.captureCredentials({ descriptor, checkpoint: proof, assertHeld: scope.assertHeld });
        if (failStore === 'select') throw injected('bundle_selection_write_failed');
        events.push('select');
        selected = { descriptor: prepared, selection: { revision: input.expectedRevision + 1,
          selectedBundleID: input.bundleID, previousBundleID: 'A', reconciliationRequired: false } };
        return selected.selection;
      }),
      rollback: async input => failStore === 'rollback-precheck' ? Promise.reject(injected('bundle_rollback_target_invalid')) : options.withQuiescedSource({ kind: 'bundle', bundleID: 'A' }, async (proof, scope) => {
        const captured = await options.captureCredentials({ descriptor, checkpoint: proof, assertHeld: scope.assertHeld });
        const target = { ...descriptor, bundleID: input.targetBundleID };
        const credentialBinding = { sourceBundleID: 'A', targetBundleID: target.bundleID, targetManifestSha256: launch.artifactManifestSha256,
          expectedTargetSha256: 'e'.repeat(64), sourceSha256: captured.sha256 };
        const reconciled = await options.reconcileRollback({ candidate: descriptor, target, credentialBinding, assertHeld: scope.assertHeld });
        selected = { descriptor: target, selection: { revision: 2, selectedBundleID: target.bundleID, previousBundleID: 'A',
          reconciliationRequired: reconciled.status === 'blocked' } };
        return { selection: selected.selection, reason: reconciled.reason ?? null };
      }),
    };
  };
  const restart = vi.fn(async () => { events.push('restart'); if (failRestart) throw new Error('host refused restart'); });
  const lifecycle = createRuntimeBundleLifecycle({ binding, artifactDirectory, verifyArtifacts, credentialProcess, storeFactory, retainCheckpoint, neverStarted,
    retainArtifacts: async () => { events.push('retain'); if (failRetain) throw injected('bundle_retain_failed'); return retained; }, requestRecomposition: restart,
    getController: () => unknownController ? null : controller,
    closeAdmission: async () => { events.push('admission-close'); gate.close(); },
    assertAdmissionClosed: async () => { gate.assertClosed(); await assertOwner?.(); },
    stopProducers: async () => { events.push('producers-stop'); },
    beforeControllerStop: async () => { events.push('credentials-drain'); },
    afterExit: async () => { events.push('owner-close'); },
    executionHost: { drain: async () => { events.push('execution-drain'); } },
    drainStores: async () => {
      events.push('stores-drain');
      await beforeDrain?.();
      if (failDrain || remainingDrainFailures-- > 0) throw Object.assign(Error('failed'), { code: 'bundle_stores_unsettled' });
    },
  });
  return { lifecycle, events, credentialProcess, binding, restart, candidateHash, retained, gate, artifactDirectory, callbacks: () => callbacks,
    changeSelection: value => { selected.selection = { ...selected.selection, ...value }; } };
}

test('production lifecycle detects only the app artifact and holds the actual original owner through clone and selector CAS', async () => {
  const value = await fixture();
  expect(await value.lifecycle.inspect()).toMatchObject({ state: 'upgrade_available', revision: 1, availableManifestSha256: value.candidateHash });
  expect(value.events).toEqual([]);
  const result = await value.lifecycle.upgrade({ expectedRevision: 1 });
  expect(result).toMatchObject({ state: 'restart_required', restartRequired: true, previousBundleID: 'A', revision: 2 });
  expect(value.events).toEqual(['retain', 'admission-close', 'quiesce', 'producers-stop', 'credentials-drain', 'controller-close',
    'execution-drain', 'owner-close', 'stores-drain', 'prepare', 'capture', 'capture', 'select']);
  expect(value.credentialProcess.mock.calls[0][0].captureArtifacts.manifestSha256).toBe(value.candidateHash);
  expect(value.restart).not.toHaveBeenCalled();
  await value.lifecycle.recompose(); expect(value.restart).toHaveBeenCalledOnce();
  await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_selection_revision_conflict' });
});

test.each([
  [{ unknownController: true }, 'bundle_checkpoint_controller_unknown'],
  [{ unsettledController: true }, 'bundle_checkpoint_exit_unconfirmed'],
  [{ failDrain: true }, 'bundle_stores_unsettled'],
])('missing original ACK or a failed host drain cannot create/select a candidate (%j)', async (options, code) => {
  const value = await fixture(options);
  await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code });
  expect(value.events).not.toContain('prepare'); expect(value.events).not.toContain('select');
  expect(await value.lifecycle.inspect()).toMatchObject({ state: 'held', revision: 1, reason: code });
});

test('a never-started cold owner upgrades without a controller and every held step re-proves its owner', async () => {
  let proofs = 0, foreign = false;
  const value = await fixture({ unknownController: true, neverStarted: true,
    assertOwner: async () => { proofs++; if (foreign) throw Object.assign(new Error('owned'), { code: 'bundle_upgrade_owner_active' }); } });
  const result = await value.lifecycle.upgrade({ expectedRevision: 1 });
  expect(result).toMatchObject({ state: 'restart_required', previousBundleID: 'A', revision: 2 });
  expect(value.events).toEqual(['retain', 'admission-close', 'producers-stop', 'credentials-drain', 'execution-drain', 'owner-close',
    'stores-drain', 'prepare', 'capture', 'capture', 'select']);
  expect(proofs).toBeGreaterThan(3);
  const refused = await fixture({ unknownController: true, neverStarted: true,
    assertOwner: async () => { if (foreign) throw Object.assign(new Error('owned'), { code: 'bundle_upgrade_owner_active' }); } });
  foreign = true;
  await expect(refused.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_upgrade_owner_active' });
  expect(refused.events).not.toContain('prepare'); expect(refused.events).not.toContain('select');
});

test('incompatible credential rollback preserves both identities and publishes held recovery', async () => {
  const value = await fixture({ failProjection: true });
  const result = await value.lifecycle.rollback({ expectedRevision: 1 });
  expect(result).toMatchObject({ state: 'restart_required', bundleID: 'prior', previousBundleID: 'A',
    reconciliationRequired: true, reason: 'bundle_credential_contract_incompatible' });
  expect(value.credentialProcess.mock.calls[1][0]).not.toHaveProperty('captureArtifacts');
});

test('actual administrator route invokes lifecycle and emits the result before host recomposition', async () => {
  const value = await fixture(); const app = express();
  registerRuntimeBundleLifecycleRoutes(app, { lifecycle: value.lifecycle, isAdministrator: req => req.headers['x-fixture-admin'] === '1' });
  expect((await request(app).get('/api/runtime/bundle')).status).toBe(403);
  expect((await request(app).post('/api/runtime/bundle/upgrade').send({ expectedRevision: 1 })).status).toBe(403);
  expect((await request(app).post('/api/runtime/bundle/upgrade').set('x-fixture-admin', '1').send({ expectedRevision: 1 })).body.code).toBe('bundle_csrf_required');
  const forged = await request(app).post('/api/runtime/bundle/upgrade').set('x-fixture-admin', '1').set('x-devryan-csrf', '1')
    .send({ expectedRevision: 1, controller: '/forged' });
  expect(forged.body.code).toBe('bundle_selection_revision_conflict');
  expect(value.events).toEqual([]);
  const result = await request(app).post('/api/runtime/bundle/upgrade').set('x-fixture-admin', '1').set('x-devryan-csrf', '1').send({ expectedRevision: 1 });
  expect(result.status).toBe(200); expect(result.body.restartRequired).toBe(true);
  expect(value.events.at(-1)).toBe('restart');
});

test('a failed host recomposition remains inspectable after the successful selector response', async () => {
  const value = await fixture({ failRestart: true }); const app = express();
  registerRuntimeBundleLifecycleRoutes(app, { lifecycle: value.lifecycle, isAdministrator: () => true });
  const result = await request(app).post('/api/runtime/bundle/upgrade').set('x-devryan-csrf', '1').send({ expectedRevision: 1 });
  expect(result.status).toBe(200);
  expect((await request(app).get('/api/runtime/bundle')).body).toMatchObject({ state: 'restart_required',
    reason: 'bundle_host_restart_failed', revision: 2, restartRequired: true });
});

test.each(['upgrade', 'rollback'])('a disconnected %s caller cannot strand a committed selection', async action => {
  let commit, entered, disconnected;
  const accepted = new Promise(resolve => { entered = resolve; });
  const closed = new Promise(resolve => { disconnected = resolve; });
  const committed = new Promise(resolve => { commit = resolve; });
  const recompose = vi.fn(async () => {});
  const app = express();
  app.use((_req, res, next) => { res.once('close', disconnected); next(); });
  registerRuntimeBundleLifecycleRoutes(app, { isAdministrator: () => true, lifecycle: {
    [action]: async () => { entered(); await committed; return { restartAvailable: true, restartRequired: true }; },
    recompose,
  } });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = http.request({ host: '127.0.0.1', port: server.address().port,
    path: `/api/runtime/bundle/${action}`, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-devryan-csrf': '1' } });
  client.on('error', () => {});
  try {
    client.end(JSON.stringify({ expectedRevision: 1 }));
    await accepted; client.destroy(); await closed;
    expect(recompose).not.toHaveBeenCalled();
    commit(); await vi.waitFor(() => expect(recompose).toHaveBeenCalledOnce());
  } finally {
    commit(); client.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('write admission refuses unacknowledged requests and blocks migrating reads while held', () => {
  const gate = createRuntimeBundleAdmissionGate(); const response = new EventEmitter();
  gate.middleware({ method: 'POST', path: '/api/config' }, response, () => {});
  expect(() => gate.close()).toThrow('bundle_host_requests_unsettled');
  response.emit('close');
  expect(() => gate.assertClosed()).toThrow('bundle_host_requests_unsettled');
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }; const next = vi.fn();
  gate.middleware({ method: 'GET', path: '/api/settings' }, res, next);
  expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(503);
});

test('application work fence waits original promises and rejects late restart timers', async () => {
  const fence = createRuntimeBundleWorkFence(); let release;
  const original = fence.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  let drained = false; const drain = fence.holdForCheckpoint().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  await expect(fence.run(() => 'late restart')).rejects.toMatchObject({ code: 'bundle_host_work_held' });
  release(); await original; await drain; expect(drained).toBe(true);
});

test('a rejected original host mutation cannot become a successful checkpoint after its caller handles the error', async () => {
  const fence = createRuntimeBundleWorkFence();
  await expect(fence.run(() => { throw new Error('partial bootstrap'); })).rejects.toThrow('partial bootstrap');
  await expect(fence.holdForCheckpoint()).rejects.toMatchObject({ code: 'bundle_host_work_unsettled' });
});

test('lifecycle forwards the verified target artifact capability to the core clone gate',async()=>{
 const value=await fixture();
 const target={controllerBinary:value.retained.controller,writerBinary:value.retained.writer,
  artifactManifestPath:value.retained.manifestPath,artifactManifestSha256:value.retained.manifestSha256};
 const verified=await value.callbacks().verifyArtifacts({generation:2,launch:target});
 expect(verified).toBe(value.retained);
 expect(verified.manifest.compiledContracts).toContain('devryan.bundle.credential-owners/2');
 expect(value.events).toEqual([]);
});

test('a checkpoint-held host stays held after a retry that fails before the checkpoint', async () => {
  const value = await fixture({ drainFailures: 1 });
  await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_stores_unsettled' });
  expect(await value.lifecycle.inspect()).toMatchObject({ state: 'held', reason: 'bundle_stores_unsettled', revision: 1, rollbackAvailable: false });
  expect(value.gate.isHeld()).toBe(true);
  // The retry would fail before reaching any checkpoint (the candidate disappeared).
  await fs.rm(path.join(value.artifactDirectory, 'native-bundle.json'));
  const mark = value.events.length;
  await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_runtime_admission_held' });
  expect(await value.lifecycle.inspect()).toMatchObject({ state: 'held', reason: 'bundle_stores_unsettled', rollbackAvailable: false });
  expect(value.gate.isHeld()).toBe(true); expect(value.events.slice(mark)).toEqual([]);
});

test('a failed settlement cannot be retried in-process into a prepared and selected candidate', async () => {
  const value = await fixture({ drainFailures: 1 });
  await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_stores_unsettled' });
  const mark = value.events.length;
  await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_runtime_admission_held' });
  await expect(value.lifecycle.rollback({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_runtime_admission_held' });
  await expect(value.lifecycle.recompose()).rejects.toMatchObject({ code: 'bundle_host_restart_required' });
  expect(value.events.slice(mark)).toEqual([]);
  expect(await value.lifecycle.inspect()).toMatchObject({ state: 'held', revision: 1, reason: 'bundle_stores_unsettled' });
});

test.each([
  ['candidate artifact missing', { removeCandidate: true }, false],
  ['retained artifact copy', { failRetain: true }, false],
  ['checkpoint source mismatch', { failStore: 'source' }, false],
  ['unacknowledged application write', { uncertainWrite: true }, true],
  ['unknown original controller', { unknownController: true }, true],
  ['controller quiesce', { failQuiesce: true }, true],
  ['unconfirmed controller exit', { unsettledController: true }, true],
  ['store drain', { failDrain: true }, true],
  ['candidate preparation', { failStore: 'prepare' }, true],
  ['credential capture', { failCapture: true }, true],
  ['selector write', { failStore: 'select' }, true],
])('reported state agrees with application admission after a failed upgrade: %s', async (_name, { removeCandidate, uncertainWrite, ...options }, held) => {
  const value = await fixture(options);
  if (removeCandidate) await fs.rm(path.join(value.artifactDirectory, 'native-bundle.json'));
  if (uncertainWrite) {
    const response = new EventEmitter();
    value.gate.middleware({ method: 'POST', path: '/api/config' }, response, () => {}); response.emit('close');
  }
  const failure = await value.lifecycle.upgrade({ expectedRevision: 1 }).then(() => null, error => error);
  expect(failure).not.toBeNull();
  const snapshot = await value.lifecycle.inspect();
  expect(value.gate.isHeld()).toBe(held);
  expect(snapshot.state === 'held').toBe(held);
  expect(snapshot.restartRequired).toBe(false); expect(snapshot.revision).toBe(1);
  if (held) {
    expect(snapshot.rollbackAvailable).toBe(false);
    await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_runtime_admission_held' });
    expect((await value.lifecycle.inspect()).state).toBe('held');
  } else {
    expect(['ready', 'upgrade_available']).toContain(snapshot.state);
    expect(value.events).not.toContain('admission-close');
  }
  expect(value.events).not.toContain('select');
});

test('reconciliation-held construction keeps its rollback until a checkpoint is taken', async () => {
  const precheck = await fixture({ reconciliationRequired: true, failStore: 'rollback-precheck' });
  expect(await precheck.lifecycle.inspect()).toMatchObject({ state: 'held', reason: 'bundle_rollback_reconciliation_required', rollbackAvailable: true });
  await expect(precheck.lifecycle.rollback({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_rollback_target_invalid' });
  expect(precheck.gate.isHeld()).toBe(false);
  expect(await precheck.lifecycle.inspect()).toMatchObject({ state: 'held', reconciliationRequired: true, rollbackAvailable: true });

  const drained = await fixture({ reconciliationRequired: true, failDrain: true });
  await expect(drained.lifecycle.rollback({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_stores_unsettled' });
  expect(drained.gate.isHeld()).toBe(true);
  expect(await drained.lifecycle.inspect()).toMatchObject({ state: 'held', reason: 'bundle_stores_unsettled', rollbackAvailable: false });
  await expect(drained.lifecycle.rollback({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_runtime_admission_held' });

  const reconciled = await fixture({ reconciliationRequired: true });
  expect(await reconciled.lifecycle.rollback({ expectedRevision: 1 })).toMatchObject({ state: 'restart_required', restartRequired: true });
  expect(await reconciled.lifecycle.inspect()).toMatchObject({ state: 'restart_required', rollbackAvailable: false });
});

test('the held route refusal keeps the original failure inspectable', async () => {
  const value = await fixture({ failDrain: true }); const app = express();
  registerRuntimeBundleLifecycleRoutes(app, { lifecycle: value.lifecycle, isAdministrator: () => true });
  const first = await request(app).post('/api/runtime/bundle/upgrade').set('x-devryan-csrf', '1').send({ expectedRevision: 1 });
  expect(first.status).toBe(503); expect(first.body.code).toBe('bundle_stores_unsettled');
  for (const action of ['upgrade', 'rollback']) {
    const refused = await request(app).post(`/api/runtime/bundle/${action}`).set('x-devryan-csrf', '1').send({ expectedRevision: 1 });
    expect(refused.status).toBe(503); expect(refused.body.code).toBe('bundle_runtime_admission_held');
  }
  expect((await request(app).get('/api/runtime/bundle')).body).toMatchObject({ state: 'held', reason: 'bundle_stores_unsettled', rollbackAvailable: false });
});

test('constructor grant is synchronous, frozen, narrow, and settles the genuine owner once', async () => {
  const retain = vi.fn(); const value = await fixture({ retainCheckpoint: retain });
  expect(retain).toHaveBeenCalledOnce(); const grant = retain.mock.calls[0][0];
  expect(Object.isFrozen(grant)).toBe(true);
  expect(Object.keys(grant).sort()).toEqual(['controlRoot', 'ownerID', 'withHeldCheckpoint']);
  expect(grant.ownerID).toBe('A'); expect(grant.controlRoot).toBe(value.binding.controlRoot);
  expect(Object.keys(value.lifecycle).sort()).toEqual(['inspect', 'recompose', 'resume', 'rollback', 'upgrade']);
  let expired;
  expect(await grant.withHeldCheckpoint(async scope => {
    expect(Object.isFrozen(scope)).toBe(true); expect(Object.keys(scope)).toEqual(['assertHeld']);
    await scope.assertHeld(); expired = scope.assertHeld; return 'captured';
  })).toBe('captured');
  await expect(expired()).rejects.toMatchObject({ code: 'bundle_checkpoint_scope_expired' });
  await grant.withHeldCheckpoint(async scope => {
    await scope.assertHeld();
    await expect(expired()).rejects.toMatchObject({ code: 'bundle_checkpoint_scope_expired' });
  });
  expect(value.events).toEqual(['admission-close', 'quiesce', 'producers-stop', 'credentials-drain', 'controller-close',
    'execution-drain', 'owner-close', 'stores-drain']);
  expect(await value.lifecycle.inspect()).toMatchObject({ state: 'held', rollbackAvailable: false, revision: 1 });
  await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_runtime_admission_held' });
});

test('held grant reserves before selection awaits and excludes transitions and other actions', async () => {
  let grant, unblock; const wait = new Promise(resolve => { unblock = resolve; });
  const value = await fixture({ retainCheckpoint: value => { grant = value; }, beforeReadSelected: () => wait });
  const action = vi.fn(async scope => scope.assertHeld()); const work = grant.withHeldCheckpoint(action);
  await expect(grant.withHeldCheckpoint(action)).rejects.toMatchObject({ code: 'bundle_lifecycle_busy' });
  await expect(value.lifecycle.rollback({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_lifecycle_busy' });
  unblock(); await work; expect(action).toHaveBeenCalledOnce();
});

test('failed settlement permanently revokes the retained grant; action failure only expires that action', async () => {
  let grant; const value = await fixture({ retainCheckpoint: value => { grant = value; }, drainFailures: 1 });
  const action = vi.fn();
  await expect(grant.withHeldCheckpoint(action)).rejects.toMatchObject({ code: 'bundle_stores_unsettled' });
  await expect(grant.withHeldCheckpoint(action)).rejects.toMatchObject({ code: 'bundle_checkpoint_grant_revoked' });
  expect(action).not.toHaveBeenCalled(); expect(value.events.filter(event => event === 'stores-drain')).toHaveLength(1);
  const settled = await fixture({ retainCheckpoint: value => { grant = value; } });
  let expired;
  await expect(grant.withHeldCheckpoint(async scope => { expired = scope.assertHeld; throw Error('capture refused'); })).rejects.toThrow('capture refused');
  await grant.withHeldCheckpoint(async scope => {
    await expect(expired()).rejects.toMatchObject({ code: 'bundle_checkpoint_scope_expired' }); await scope.assertHeld();
  });
  expect(settled.events.filter(event => event === 'stores-drain')).toHaveLength(1);
});

test('a failed public settlement also revokes retained authority', async () => {
  let grant; const value = await fixture({ retainCheckpoint: value => { grant = value; }, failDrain: true });
  await expect(value.lifecycle.upgrade({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'bundle_stores_unsettled' });
  await expect(grant.withHeldCheckpoint(async () => {})).rejects.toMatchObject({ code: 'bundle_checkpoint_grant_revoked' });
});

test('grant refuses invalid actions, reconciliation, changed selection, and restart-required hosts', async () => {
  await expect(fixture({ retainCheckpoint: true })).rejects.toMatchObject({ code: 'bundle_checkpoint_grant_invalid' });
  let grant; const value = await fixture({ retainCheckpoint: value => { grant = value; } });
  await expect(grant.withHeldCheckpoint(null)).rejects.toMatchObject({ code: 'bundle_checkpoint_grant_invalid' });
  value.changeSelection({ revision: 2 });
  await expect(grant.withHeldCheckpoint(async () => {})).rejects.toMatchObject({ code: 'bundle_selection_revision_conflict' });
  expect(value.events).toEqual([]);
  await fixture({ retainCheckpoint: value => { grant = value; }, reconciliationRequired: true });
  await expect(grant.withHeldCheckpoint(async () => {})).rejects.toMatchObject({ code: 'bundle_rollback_reconciliation_required' });
  const upgraded = await fixture({ retainCheckpoint: value => { grant = value; } });
  await upgraded.lifecycle.upgrade({ expectedRevision: 1 });
  await expect(grant.withHeldCheckpoint(async () => {})).rejects.toMatchObject({ code: 'bundle_host_restart_required' });
});

test('selector change during settlement cannot expose a held credential scope', async () => {
  let grant, value; value = await fixture({ retainCheckpoint: result => { grant = result; },
    beforeDrain: () => value.changeSelection({ selectedBundleID: 'foreign', revision: 2 }) });
  const action = vi.fn();
  await expect(grant.withHeldCheckpoint(action)).rejects.toMatchObject({ code: 'bundle_selection_revision_conflict' });
  expect(action).not.toHaveBeenCalled();
  await expect(grant.withHeldCheckpoint(action)).rejects.toMatchObject({ code: 'bundle_checkpoint_grant_revoked' });
});
