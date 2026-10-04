import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from './native-bundle-credential-contract.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from '../../../test-supertest.js';
import { afterEach, expect, test, vi } from 'vitest';
import { createRuntimeBundleLifecycle, createRuntimeBundleAdmissionGate, createRuntimeBundleWorkFence,
  registerRuntimeBundleLifecycleRoutes } from './runtime-bundle-lifecycle.js';

const roots = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture({ unknownController = false, unsettledController = false, failDrain = false, failProjection = false, failRestart = false } = {}) {
  const parent = new URL('../../../../../../.cache/runtime-bundle-lifecycle-tests/', import.meta.url);
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent.pathname, 'case-')); roots.push(root);
  const launch = { opencodeDatabasePath: path.join(root, 'a.db'), webDataDirectory: path.join(root, 'web'),
    webConfigDirectory: path.join(root, 'web-config'), opencodeConfigDirectory: path.join(root, 'config'),
    controllerBinary: path.join(root, 'old-controller'), writerBinary: path.join(root, 'old-writer'),
    artifactManifestPath: path.join(root, 'old-manifest.json'), artifactManifestSha256: 'a'.repeat(64),
    reviewedNativeConfigPath: path.join(root, 'reviewed.json') };
  await fs.writeFile(launch.opencodeDatabasePath, 'fixture database');
  for (const directory of [launch.webDataDirectory, launch.webConfigDirectory, launch.opencodeConfigDirectory]) await fs.mkdir(directory);
  const descriptor = { bundleID: 'A', generation: 2, launch, projectMap: [{ sourceDirectory: root, targetDirectory: root, mode: 'identity' }] };
  const binding = { controlRoot: root, descriptor, selection: { revision: 1, selectedBundleID: 'A', previousBundleID: 'prior', reconciliationRequired: false } };
  let selected = structuredClone({ descriptor, selection: binding.selection });
  let exited = false, closed = false, prepared, callbacks;
  const events = [];
  const controller = { hasExited: () => exited, call: async input => { events.push(input.action); },
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
    if (input.action.action === 'project') {
      if (failProjection) throw Object.assign(new Error('incompatible'), { code: 'bundle_credential_contract_incompatible' });
      return { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, status: 'projected', ...input.action.binding, appliedSha256: input.action.binding.sourceSha256 };
    }
    return { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, status: 'captured', sha256: 'd'.repeat(64), snapshot: { credentials: [] } };
  });
  const storeFactory = options => {
    callbacks = options;
    return {
      readSelected: async () => selected,
      prepare: async input => options.withQuiescedSource(input.source, async (proof, scope) => {
        await scope.assertHeld(); events.push('prepare');
        await options.captureCredentials({ descriptor, checkpoint: proof, assertHeld: scope.assertHeld });
        prepared = { ...descriptor, bundleID: input.bundleID, sourceBundleID: 'A', launch: { ...launch, ...input.launchArtifacts } };
        return prepared;
      }),
      select: async input => options.withQuiescedSource({ kind: 'bundle', bundleID: 'A' }, async (proof, scope) => {
        await scope.assertHeld(); await options.captureCredentials({ descriptor, checkpoint: proof, assertHeld: scope.assertHeld });
        events.push('select');
        selected = { descriptor: prepared, selection: { revision: input.expectedRevision + 1,
          selectedBundleID: input.bundleID, previousBundleID: 'A', reconciliationRequired: false } };
        return selected.selection;
      }),
      rollback: async input => options.withQuiescedSource({ kind: 'bundle', bundleID: 'A' }, async (proof, scope) => {
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
  const lifecycle = createRuntimeBundleLifecycle({ binding, artifactDirectory, verifyArtifacts, credentialProcess, storeFactory,
    retainArtifacts: async () => { events.push('retain'); return retained; }, requestRecomposition: restart,
    getController: () => unknownController ? null : controller,
    closeAdmission: async () => { events.push('admission-close'); closed = true; },
    assertAdmissionClosed: async () => { if (!closed) throw Error('not closed'); },
    stopProducers: async () => { events.push('producers-stop'); },
    beforeControllerStop: async () => { events.push('credentials-drain'); },
    afterExit: async () => { events.push('owner-close'); },
    executionHost: { drain: async () => { events.push('execution-drain'); } },
    drainStores: async () => { events.push('stores-drain'); if (failDrain) throw Object.assign(Error('failed'), { code: 'bundle_stores_unsettled' }); },
  });
  return { lifecycle, events, credentialProcess, binding, restart, candidateHash, retained, callbacks: () => callbacks };
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
