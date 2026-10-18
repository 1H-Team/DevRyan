import fs from 'node:fs/promises';
import { createClaudeCandidate, preserveManagedClaude } from './managed-claude-candidate.js';
import { checkLatestClaudeRelease, claudeVersionFromManifest } from '../claude-runtime-update.js';
import { newerClaude } from './managed-claude-installation.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { createRuntimeBundleStore } from './runtime-bundle.js';
import { createRuntimeBundleCheckpoint } from './bundle-checkpoint.js';
import { retainNativeArtifacts } from './retained-native-artifacts.js';
import { verifyNativeRuntimeArtifacts, readNativeRuntimeManifest } from './native-artifacts.js';
import { defaultNativeRegistrations } from './native-default-bundle.js';
import {resumeRuntimeBundle} from './runtime-bundle-resume.js';
import { executionArtifacts } from '../execution-artifacts.js';
import { runNativeBundleCredentialProcess, NATIVE_BUNDLE_CREDENTIAL_CONTRACT } from './native-bundle-credential-process.js';
import { verifyNativeCloneCompatibility } from './native-bundle-compatibility.js';
import { timeStartupPhase } from '../startup-timing.js';

const fail = code => Object.assign(new Error(code), { code, status: 503 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cloneContract = 'devryan-v2-clone/1';
const finiteCode = error => /^bundle_[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'bundle_lifecycle_failed';
const selectedMatches = (binding, current) => current?.selection.revision === binding.selection.revision
  && current.selection.selectedBundleID === binding.descriptor.bundleID;
/** The candidate an upgrade from `revision` to the retained manifest prepares. */
export const nativeUpgradeBundleID = (manifestSha256, revision) => `native-${manifestSha256.slice(0, 24)}-r${revision}`;

/** The application supplies the original live owner and all host drains. No
 * caller may choose a controller, source path, checkpoint or credential value.
 * `neverStarted` is only for the cold startup owner, which has no controller
 * and proves the absence of any other live owner through assertAdmissionClosed. */
export function createRuntimeBundleLifecycle({ binding, getController, closeAdmission, assertAdmissionClosed,
  stopProducers, drainStores, executionHost, afterExit, beforeControllerStop, requestRecomposition,
  artifactDirectory = executionArtifacts().directory, verifyArtifacts = verifyNativeRuntimeArtifacts,
  credentialProcess = runNativeBundleCredentialProcess, storeFactory = createRuntimeBundleStore,
  retainArtifacts = retainNativeArtifacts, retainCheckpoint, privatePersistence={}, neverStarted = false,
  waitForClaudeIdle, onClaudePhase = () => {}, createClaude = createClaudeCandidate, checkClaudeRelease = checkLatestClaudeRelease }) {
  if (retainCheckpoint !== undefined && typeof retainCheckpoint !== 'function') throw fail('bundle_checkpoint_grant_invalid');
  // Permanent for this process: the application admission gate never reopens
  // after a checkpoint starts closing it, so neither may the lifecycle.
  let checkpointHeld = false;
  const checkpoint = createRuntimeBundleCheckpoint({ ownerID: binding.descriptor.bundleID, generation: 2,
    launch: binding.descriptor.launch, getController, assertAdmissionClosed,
    closeAdmission: () => { checkpointHeld = true; state = 'held'; return closeAdmission(); },
    stopProducers, drainStores, executionHost, afterExit, beforeControllerStop, neverStarted });
  let state = binding.selection.reconciliationRequired ? 'held' : 'ready';
  let reason = state === 'held' ? 'bundle_rollback_reconciliation_required' : null;
  let transition;
  let heldAction = false, checkpointFailed = false;
  const withCheckpoint = async (source, action) => {
    let entered = false;
    try {
      return await checkpoint(source, async (...args) => { entered = true; return action(...args); });
    } catch (error) {
      if (!entered && checkpointHeld) checkpointFailed = true;
      throw error;
    }
  };
  let captureArtifacts;
  const snapshots = new Map();
  const verifyLaunch = async (launch,purpose) => {
    const result = await timeStartupPhase('bundle_artifact_verification', () => verifyArtifacts({ manifestPath: launch.artifactManifestPath,
      manifestSha256: launch.artifactManifestSha256, launcher: executionArtifacts(path.dirname(launch.artifactManifestPath)).launcher,...purpose?{purpose}:{} }));
    if (result.controller !== launch.controllerBinary || result.writer !== launch.writerBinary) throw fail('bundle_artifact_generation_mismatch');
    return result;
  };
  const compatible = async ({ source, artifacts }) => {
    const [left, right] = await Promise.all([verifyLaunch(source.launch,'bundle-source'), verifyLaunch(artifacts)]);
    verifyNativeCloneCompatibility({ left: left.manifest, right: right.manifest, databasePath: source.launch.opencodeDatabasePath });
    return { source: left, proof: { status: 'compatible', binding: { protocol: cloneContract, sourceBundleID: source.bundleID,
      sourceManifestSha256: source.launch.artifactManifestSha256, targetManifestSha256: artifacts.artifactManifestSha256 } } };
  };
  const store = storeFactory({ ...privatePersistence, controlRoot: binding.controlRoot, allowRecoveredInputStartup: true,
    withQuiescedSource: withCheckpoint,
    runMigration: async () => { throw fail('bundle_migration_generation_invalid'); },
    verifyArtifacts: async ({ launch,purpose }) => verifyLaunch(launch,purpose),
    verifyV2Compatibility: async input => (await compatible(input)).proof,
    captureCredentials: async ({ descriptor, assertHeld }) => {
      const captured = await credentialProcess({ descriptor, assertHeld,
        ...(captureArtifacts ? { captureArtifacts } : {}),
        action: { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, action: 'capture' } });
      snapshots.set(descriptor.bundleID, captured);
      return captured;
    },
    reconcileRollback: async ({ candidate, target, credentialBinding, assertHeld }) => {
      const captured = snapshots.get(candidate.bundleID);
      if (captured?.sha256 !== credentialBinding.sourceSha256) throw fail('bundle_credential_checkpoint_required');
      try {
        const credentialReceipt = await credentialProcess({ descriptor: target, assertHeld,
          action: { protocol: NATIVE_BUNDLE_CREDENTIAL_CONTRACT, action: 'project',
            source: captured.snapshot, binding: credentialBinding } });
        return { status: 'reconciled', credentialReceipt };
      } catch (error) {
        return { status: 'blocked', reason: finiteCode(error) };
      }
    },
  });
  const readCandidate = async () => {
    const manifestPath = path.join(artifactDirectory, 'native-bundle.json');
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw fail('bundle_candidate_artifact_invalid');
    const manifestSha256 = hash(await fs.readFile(manifestPath));
    const artifacts = await timeStartupPhase('bundle_artifact_verification', () => verifyArtifacts({ manifestPath, manifestSha256, launcher: executionArtifacts(artifactDirectory).launcher }));
    const candidate = { artifacts, manifestSha256, manifestPath };
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return candidate;
    const current = await readNativeRuntimeManifest(binding.descriptor.launch.artifactManifestPath, 'bundle-source');
    if (!current.manifest.claudeInstallation) return candidate;
    const source = await verifyLaunch(binding.descriptor.launch, 'bundle-source');
    return preserveManagedClaude({ controlRoot: binding.controlRoot, source, candidate, verifyArtifacts });
  };
  const inspect = async ({ checkUpdates = true } = {}) => {
    const current = await store.readSelected();
    const snapshot = { state, reason, bundleID: current?.selection.selectedBundleID ?? binding.descriptor.bundleID,
      previousBundleID: current?.selection.previousBundleID ?? null, revision: current?.selection.revision ?? binding.selection.revision,
      selectedManifestSha256: current?.descriptor.launch.artifactManifestSha256 ?? binding.descriptor.launch.artifactManifestSha256,
      restartRequired: !selectedMatches(binding, current), reconciliationRequired: current?.selection.reconciliationRequired === true };
    // Mirrors run(): only an unchecked host with a selector-owned target may roll back.
    snapshot.rollbackAvailable = !checkpointHeld && !transition && !heldAction && !snapshot.restartRequired && ['ready', 'held'].includes(state)
      && Boolean(snapshot.reconciliationRequired ? current?.selection.selectedBundleID : current?.selection.previousBundleID);
    if (!checkUpdates || snapshot.restartRequired || state === 'held' || state === 'transitioning') return snapshot;
    try {
      const candidate = await readCandidate();
      snapshot.availableManifestSha256 = candidate.manifestSha256;
      if (candidate.manifestSha256 !== binding.descriptor.launch.artifactManifestSha256) snapshot.state = 'upgrade_available';
    } catch (error) { snapshot.updateReason = finiteCode(error); }
    return snapshot;
  };
  const run = (kind, input, action) => {
    if (transition || heldAction) return Promise.reject(fail('bundle_lifecycle_busy'));
    if (!input || Object.keys(input).some(key => key !== 'expectedRevision') || !Number.isSafeInteger(input.expectedRevision)) {
      return Promise.reject(fail('bundle_selection_revision_conflict'));
    }
    transition = (async () => {
      const current = await store.readSelected();
      if (!selectedMatches(binding, current) || input.expectedRevision !== current.selection.revision) throw fail('bundle_selection_revision_conflict');
      if (checkpointHeld) throw fail('bundle_runtime_admission_held');
      const previous = state;
      state = 'transitioning'; reason = null;
      try {
        const result = await action(current);
        const selection = result.selection ?? result;
        state = 'restart_required'; reason = result.reason ?? null;
        return { ...await inspect(), state, reason, restartRequired: true, restartAvailable: typeof requestRecomposition === 'function',
          transition: kind, revision: selection.revision };
      } catch (error) {
        reason = finiteCode(error);
        // Once a checkpoint closes admission its owner cannot be reused; a
        // failure before any checkpoint leaves the prior state unchanged.
        state = checkpointHeld ? 'held' : previous;
        throw error;
      } finally { snapshots.clear(); captureArtifacts = undefined; }
    })().finally(() => { transition = undefined; });
    return transition;
  };
  const applyCandidate = async (input, current, candidate, claudeUpdate = false) => {
      const retained = await timeStartupPhase('bundle_artifact_retention', () => retainArtifacts({ ...privatePersistence, controlRoot: binding.controlRoot, ...candidate, verifyArtifacts }));
      const inputRoot = path.join(binding.controlRoot, 'upgrade-inputs', retained.manifestSha256);
      await fs.mkdir(inputRoot, { recursive: true, mode: 0o700 });
      if (await fs.realpath(inputRoot) !== inputRoot) throw fail('bundle_path_invalid');
      const reviewedPluginManifestPath = path.join(inputRoot, 'reviewed-plugins.json');
      const contents = JSON.stringify({ schema: 1, plugins: defaultNativeRegistrations(retained.manifest.inputs.reviewedPlugins) }) + '\n';
      try { await fs.writeFile(reviewedPluginManifestPath, contents, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(reviewedPluginManifestPath, 'utf8') !== contents) throw fail('bundle_candidate_registration_changed'); }
      const launchArtifacts = { controllerBinary: retained.controller, writerBinary: retained.writer,
        artifactManifestPath: retained.manifestPath, artifactManifestSha256: retained.manifestSha256,
        reviewedNativeConfigPath: current.descriptor.launch.reviewedNativeConfigPath, reviewedPluginManifestPath };
      const { source: original } = await compatible({ source: current.descriptor, artifacts: launchArtifacts });
      captureArtifacts = original.manifest.opencodeVersion === retained.manifest.opencodeVersion
        && original.manifest.inputs.coreDigest === retained.manifest.inputs.coreDigest
        ? { manifestPath: retained.manifestPath, manifestSha256: retained.manifestSha256 } : undefined;
      const bundleID = nativeUpgradeBundleID(retained.manifestSha256, current.selection.revision);
      let releaseIdle;
      if (claudeUpdate) {
        onClaudePhase('waiting-for-idle');
        releaseIdle = await waitForClaudeIdle();
        onClaudePhase('activating');
      }
      try {
      await timeStartupPhase('bundle_candidate_preparation', () => store.prepare({ bundleID, generation: 2, source: { kind: 'bundle', bundleID: current.descriptor.bundleID },
        projectMap: current.descriptor.projectMap, auxiliary: { kind: 'absent' }, launchArtifacts }));
      return await timeStartupPhase('bundle_selection', () => store.select({ bundleID, expectedRevision: input.expectedRevision, ...(claudeUpdate ? { claudeUpdate: true } : {}) }));
      } finally { releaseIdle?.(); }
  };
  const handle = {
    inspect,
    resume: input=>resumeRuntimeBundle({controlRoot:binding.controlRoot,input}),
    recompose: async () => {
      if (state !== 'restart_required' || typeof requestRecomposition !== 'function') throw fail('bundle_host_restart_required');
      try { await requestRecomposition(); }
      catch { reason = 'bundle_host_restart_failed'; throw fail(reason); }
    },
    upgrade: input => run('upgrade', input, async current => {
      const candidate = await readCandidate();
      if (candidate.manifestSha256 === current.descriptor.launch.artifactManifestSha256) throw fail('bundle_upgrade_not_available');
      return applyCandidate(input, current, candidate);
    }),
    upgradeClaude: input => run('claude', input, async current => {
      if (process.platform !== 'darwin' || process.arch !== 'arm64' || typeof waitForClaudeIdle !== 'function') throw fail('bundle_claude_update_unavailable');
      const source = await verifyLaunch(current.descriptor.launch, 'bundle-source');
      const release = await checkClaudeRelease();
      const installed = claudeVersionFromManifest(source.manifest);
      if (!installed) throw fail('bundle_claude_version_unavailable');
      if (!newerClaude(release.latestVersion, installed)) throw fail('bundle_upgrade_not_available');
      const candidate = await createClaude({ controlRoot: binding.controlRoot, source, version: release.latestVersion, verifyArtifacts, onPhase: onClaudePhase });
      return applyCandidate(input, current, candidate, true);
    }),
    rollback: input => run('rollback', input, async current => {
      const targetBundleID = current.selection.reconciliationRequired ? current.selection.selectedBundleID : current.selection.previousBundleID;
      if (!targetBundleID) throw fail('bundle_rollback_target_invalid');
      let releaseIdle;
      if (waitForClaudeIdle) { onClaudePhase('waiting-for-idle'); releaseIdle = await waitForClaudeIdle(); onClaudePhase('activating'); }
      try { return await store.rollback({ targetBundleID, expectedRevision: input.expectedRevision }); }
      finally { releaseIdle?.(); }
    }),
  };
  if (retainCheckpoint) {
    let revoked = false;
    const ownerID = binding.descriptor.bundleID, controlRoot = binding.controlRoot;
    const revision = binding.selection.revision;
    const matches = current => current?.selection.selectedBundleID === ownerID && current.selection.revision === revision;
    const withHeldCheckpoint = action => {
      if (typeof action !== 'function') return Promise.reject(fail('bundle_checkpoint_grant_invalid'));
      if (revoked || checkpointFailed) return Promise.reject(fail('bundle_checkpoint_grant_revoked'));
      if (transition || heldAction) return Promise.reject(fail('bundle_lifecycle_busy'));
      if (binding.selection.reconciliationRequired) return Promise.reject(fail('bundle_rollback_reconciliation_required'));
      if (state === 'restart_required') return Promise.reject(fail('bundle_host_restart_required'));
      // Reserve synchronously: selection reads and settlement both suspend.
      heldAction = true;
      return (async () => {
        if (!matches(await store.readSelected())) throw fail('bundle_selection_revision_conflict');
        let entered = false;
        try {
          return await withCheckpoint({ kind: 'bundle', bundleID: ownerID }, async (_stamp, scope) => {
            if (!matches(await store.readSelected())) throw fail('bundle_selection_revision_conflict');
            entered = true;
            return action(Object.freeze({ assertHeld: scope.assertHeld }));
          });
        } catch (error) {
          if (!entered) revoked = true;
          throw error;
        }
      })().finally(() => { heldAction = false; });
    };
    retainCheckpoint(Object.freeze({ ownerID, controlRoot, withHeldCheckpoint }));
  }
  return handle;
}

/** Install after authentication; request data supplies only the selector CAS. */
export function registerRuntimeBundleLifecycleRoutes(app, { lifecycle, isAdministrator }) {
  const guard = (req, res, next) => isAdministrator(req) ? next() : res.status(403).json({ error: 'Administrator access required', code: 'bundle_administrator_required' });
  const mutationGuard = (req, res, next) => req.headers['x-devryan-csrf'] === '1'
    ? next() : res.status(403).json({ code: 'bundle_csrf_required' });
  app.get('/api/runtime/bundle', guard, async (_req, res) => {
    try { res.json(await lifecycle.inspect()); } catch (error) { res.status(503).json({ code: finiteCode(error) }); }
  });
  for (const action of ['upgrade', 'rollback']) app.post(`/api/runtime/bundle/${action}`, guard, mutationGuard, express.json({ limit: '1kb' }), async (req, res) => {
    try {
      const result = await lifecycle[action](req.body);
      if (result.restartAvailable) {
        let restarted = false;
        const restart = () => {
          if (restarted) return;
          restarted = true;
          res.off('finish', restart); res.off('close', restart);
          void lifecycle.recompose().catch(() => {});
        };
        res.once('finish', restart); res.once('close', restart);
        // Selection belongs to the host after commit, even when the caller
        // disconnected while its checkpoint was settling.
        if (res.destroyed || res.writableFinished) restart();
      }
      res.json(result);
    } catch (error) { res.status(error.status ?? 503).json({ code: finiteCode(error) }); }
  });
}

/** Application writes stop before any owner checkpoint. A disconnected write
 * has no completion ACK; keep that uncertainty until a fresh host composition. */
export function createRuntimeBundleAdmissionGate() {
  let held = false, idleReservation = false, checkingIdle = false, activeWrites = 0, uncertainWrite = false;
  return {
    middleware(req, res, next) {
      const lifecycle = /^\/api\/runtime\/bundle(?:\/|$)/.test(req.path) || /^\/api\/config\/claude-update(?:\/|$)/.test(req.path);
      if (held && !lifecycle && !['/health', '/api/health'].includes(req.path)) {
        return res.status(503).json({ code: 'bundle_runtime_admission_held' });
      }
      if (!lifecycle && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (checkingIdle) return res.status(503).json({ code: 'bundle_runtime_waiting_for_idle' });
        activeWrites++;
        let finished = false;
        res.once('finish', () => { if (!finished) { finished = true; activeWrites--; } });
        res.once('close', () => {
          if (!finished) { finished = true; activeWrites--; uncertainWrite = true; }
        });
      }
      next();
    },
    async reserveIdle(isIdle) {
      if (held || checkingIdle || activeWrites || uncertainWrite) return false;
      checkingIdle = true;
      try {
        if (!await isIdle() || activeWrites || uncertainWrite) return false;
        held = true; idleReservation = true;
        return true;
      } finally { checkingIdle = false; }
    },
    releaseIdle() { if (idleReservation) { held = false; idleReservation = false; } },
    close() {
      idleReservation = false;
      held = true;
      if (activeWrites || uncertainWrite) throw fail('bundle_host_requests_unsettled');
    },
    assertClosed() {
      if (!held || activeWrites || uncertainWrite) throw fail('bundle_host_requests_unsettled');
    },
    isHeld: () => held,
  };
}

/** Original application promises remain owned after their HTTP caller returns.
 * A hold prevents delayed timers from creating replacement runtime work. */
export function createRuntimeBundleWorkFence() {
  let held = false, failed = false;
  const pending = new Set();
  return {
    run(action) {
      if (held) return Promise.reject(fail('bundle_host_work_held'));
      const operation = Promise.resolve().then(action);
      pending.add(operation);
      operation.then(() => pending.delete(operation), () => { failed = true; pending.delete(operation); });
      return operation;
    },
    holdForCheckpoint() {
      held = true;
      return Promise.allSettled([...pending]).then(() => {
        // A rejected mutation can have changed only part of its owned state.
        // Its HTTP caller handling the error does not establish a checkpoint.
        if (failed) throw fail('bundle_host_work_unsettled');
      });
    },
    isHeld: () => held,
  };
}
