import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRunRoot, removeRunPayloads } from './run-root.mjs';
import { requireDisposableMacRunner, probeDisposableMacGui } from './macos-gui-prerequisites.mjs';
import { inspectReleaseDmg, downloadReleaseStartupBaselines, hashReleaseFile, assertNoPriorStartupFailure } from './release-startup-artifacts.mjs';
import { assertReleaseStartupReceipt, assertReleaseTrialEvidence } from './release-startup-contract.mjs';
import { createReleaseStartupProfile } from './release-startup-profile.mjs';
import { launchReleaseStartup, verifyReleaseJournal, waitReleaseStartup, captureReleaseStartupScreenshot, assertReleaseRetainedSession } from './release-startup-launch.mjs';
import { seedReleaseUnsettledProcess, releaseFixtureScope } from './release-startup-unsettled.mjs';
import { prepareReleaseService, releaseServiceStatus, seedStaleReleaseOwner, runReleaseCleanup } from './release-startup-service.mjs';
import { readBundleStartupState, assertNativeStartupUpgrade, assertNativeStartupReopen, readNativeStartupLogs } from './native-startup-benchmark.mjs';
import { captureQaElectronAppIdentity } from './artifact-evidence.mjs';
import { startOwnedProcess, reservePort } from './process.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { readRuntimeServiceOwner } from '../../packages/electron/runtime-service.mjs';
import { captureReleaseLocks } from './release-startup-evidence.mjs';
import { allowBaselineRelaunch } from './release-baseline-relaunch.mjs';
import { parseStartupPhaseLogs } from '../perf/electron-lifecycle-benchmark.mjs';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export function summarizeCompiledQualification(result, sanitizer) {
  const reason = result.error?.message ?? result.cleanupFailures[0]?.message ?? '';
  return { outcome: result.status, cases: result.cases.map(({ id, status }) => ({ id, status })),
    cleanupFailures: result.cleanupFailures.length, changedSources: result.sourceCohort.changedPaths.length,
    reason: sanitizer.sanitizeText(String(reason), { highEntropy: true }).slice(0, 1000) };
}
export function parseReleaseStartupArgs(args) {
  const { values, positionals } = parseArgs({ args, options: {
    'release-dmg': { type: 'string' }, version: { type: 'string' }, 'source-commit': { type: 'string' }, receipt: { type: 'string' }, diagnostic: { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false });
  assert.equal(positionals.length, 0);
  assert.match(values.version ?? '', /^2\.\d+\.\d+$/);
  assert.match(values['source-commit'] ?? '', /^[a-f0-9]{40}$/);
  for (const value of [values['release-dmg'], values.receipt]) assert.ok(path.isAbsolute(value ?? ''), 'Absolute DMG and receipt paths required');
  return { dmg: values['release-dmg'], version: values.version, sourceCommit: values['source-commit'], receiptPath: values.receipt, diagnostic: values.diagnostic };
}

export function assertReleaseDiagnosticEnvironment(diagnostic, env = process.env) {
  if (!diagnostic) return;
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Diagnostics require a manual dry run');
  assert.equal(env.RELEASE_DRY_RUN, 'true', 'Diagnostics cannot publish');
}

export function createReleaseScenarioRunner({ receipt, stop, diagnostic, sanitizeReason, onFailure = async () => {} }) {
  return async (id, operation, { dependsOn = [] } = {}) => {
    const blockedBy = dependsOn.filter(dependency => !receipt.scenarios.some(row => row.id === dependency && row.outcome === 'passed'));
    const row = { id, outcome: blockedBy.length ? 'blocked' : 'failed', attempts: blockedBy.length ? 0 : 1, cleanup: 'pending' };
    receipt.scenarios.push(row);
    if (blockedBy.length) { row.blockedBy = blockedBy; row.cleanup = 'not-run'; return row; }
    const started = performance.now();
    let failure;
    try { await operation(row); row.outcome = 'passed'; }
    catch (error) {
      failure = error; row.reason = sanitizeReason(error.message);
      try { await onFailure(row); }
      catch { row.evidenceError = 'failure_evidence_unavailable'; }
    }
    finally {
      try { await stop(); row.cleanup = 'passed'; }
      catch { row.cleanup = 'failed'; receipt.cleanupErrors.push(`${id}_foreground_cleanup_failed`); }
      if (failure?.code === 'release_startup_cleanup_failed') {
        row.cleanup = 'failed'; receipt.cleanupErrors.push(`${id}_launch_cleanup_failed`);
      }
      row.elapsedMs = performance.now() - started;
    }
    assert.equal(row.cleanup, 'passed');
    assert.deepEqual(receipt.cleanupErrors, [], 'A cleanup failure stops diagnostics');
    if (failure && (!diagnostic || failure.code === 'release_startup_prerequisite_failed')) throw failure;
    return row;
  };
}

export async function runReleaseStartup({ dmg, version, sourceCommit, receiptPath, diagnostic = false }) {
  assertReleaseDiagnosticEnvironment(diagnostic);
  requireDisposableMacRunner();
  assert.ok(dmg.startsWith(repository + path.sep) && receiptPath.startsWith(repository + path.sep));
  assert.equal(await fs.realpath(dmg), dmg);
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(), sourceCommit);
  assert.equal(process.env.GITHUB_SHA, sourceCommit);
  assert.equal((await exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repository })).stdout.trim(), '', 'Release source must be frozen');
  const receipt = { protocol: 'devryan.release-startup/1', outcome: 'failed', sourceCommit, version,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), ...(diagnostic ? { diagnostic: true } : {}),
    platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString(), guiPrerequisites: 'not-run',
    dmgSha256: await hashReleaseFile(dmg), scenarios: [], cleanupErrors: [], baselineRelaunches: 0 };
  let active, service, serviceProfile;
  const profiles = [];
  const stop = async () => { const current = active; active = null; if (current) await runReleaseCleanup(() => current.stop()); };
  const run = createRunRoot({ parent: path.join(repository, '.cache/release-startup'), prefix: 'release-',
    owner: 'release-startup', extraPayloads: ['installations', 'downloads', 'profiles', 'negative-control'],
    onInterrupt: async () => {
      try { await service?.cleanup(active); } finally { await stop(); for (const profile of profiles) await profile.close(); }
    } });
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME,
    pathMappings: [{ path: run.dir, placeholder: '<QA>' }, { path: repository, placeholder: '<REPOSITORY>' }] });
  const newProfile = async (id, options) => {
    const profile = await createReleaseStartupProfile(path.join(run.dir, 'profiles', id), options);
    profiles.push(profile); return profile;
  };
  const start = async (artifact, profile, options) => {
    assert.equal(active, null, 'A prior foreground owner must stop before launching');
    const row = receipt.scenarios.at(-1);
    const launchRecord = { artifact: { version: artifact.version, dmgSha256: artifact.dmgSha256, manifestSha256: artifact.manifestSha256 },
      profile: path.basename(profile.root), outcome: 'failed' };
    row.launches ??= []; row.launches.push(launchRecord);
    try {
      active = await launchReleaseStartup(artifact, profile, { ...options, serviceEnvironmentManaged: profile === serviceProfile,
        onStop: async launch => {
          launchRecord.afterStop = await captureReleaseLocks(profile, launch.app, sanitizer);
          launchRecord.navigation = launch.navigation;
          launchRecord.forcedCleanup = profile.forcedServiceCleanup === true;
          assert.ok(!launchRecord.forcedCleanup, 'Forced service cleanup rejects the sample');
          assert.ok(Object.values(launchRecord.afterStop.locks).every(lock => ['missing', 'valid'].includes(lock.state)), 'Malformed lock after stop');
        },
        onFailure: async launch => {
          launchRecord.beforeFailureStop = await captureReleaseLocks(profile, launch.app, sanitizer);
          launchRecord.failureLog = sanitizer.sanitizeText(launch.log, { highEntropy: true }).slice(-16000);
          launchRecord.terminalPhases = parseStartupPhaseLogs(launch.log).filter(phase => phase.outcome === 'failed');
          const codes = new Set(launchRecord.terminalPhases.map(phase => phase.code).filter(Boolean));
          launchRecord.terminalCode = codes.size === 1 ? [...codes][0] : null;
          row.failureInterface = launch.interfaceState;
          row.failureArtifact = { version: artifact.version, dmgSha256: artifact.dmgSha256, manifestSha256: artifact.manifestSha256 };
          row.failureLog = sanitizer.sanitizeText(launch.log, { highEntropy: true }).slice(-16000);
          row.failureScreenshot = 'unavailable';
          if (launch.cdp) {
            await screenshot(row, launch, `${row.id}-launch-${row.launches.length}-failure`);
            row.failureScreenshot = 'captured';
          }
        } });
      launchRecord.outcome = 'started';
      active.captureFailureEvidence = async () => {
        launchRecord.beforeFailureStop = await captureReleaseLocks(profile, active.app, sanitizer);
      };
      return active;
    } catch (error) {
      const row = receipt.scenarios.at(-1);
      if (row) {
        launchRecord.reason = sanitizer.sanitizeText(String(error.message), { highEntropy: true }).slice(0, 1000);
        if (error.evidenceError) launchRecord.evidenceError = 'failure_evidence_unavailable';
        try { row.failureJournal = { outcome: 'passed', gapRecords: await verifyReleaseJournal(profile) }; }
        catch (journalError) { row.failureJournal = { outcome: 'failed', reason: sanitizer.sanitizeText(String(journalError.message), { highEntropy: true }).slice(0, 256) }; }
      }
      throw error;
    }
  };
  active = null;
  const retainedSession = assertReleaseRetainedSession;
  const scenario = createReleaseScenarioRunner({ receipt, stop, diagnostic,
    onFailure: async () => { await active?.captureFailureEvidence(); },
    sanitizeReason: message => sanitizer.sanitizeText(String(message), { highEntropy: true }).slice(0, 1000) });
  let candidate;
  const startBaseline = async (artifact, id) => {
    let profile = await newProfile(id);
    const row = receipt.scenarios.at(-1);
    row.baselineLaunchAttempts = 1;
    try { return { profile, launch: await start(artifact, profile) }; }
    catch (error) {
      const failure = row.launches.at(-1);
      if (!allowBaselineRelaunch({ receipt, artifact, candidate, failure, error })) throw error;
      receipt.baselineRelaunches++;
      row.baselineLaunchAttempts++;
      failure.baselineRelaunchAuthorized = true;
      profile = await newProfile(`${id}-baseline-relaunch`);
      return { profile, launch: await start(artifact, profile) };
    }
  };
  const screenshot = async (row, launch, label = row.id) => {
    row.screenshots ??= [];
    row.screenshots.push(await captureReleaseStartupScreenshot(launch, path.dirname(receiptPath), `DevRyan-startup-${label}.png`, receipt));
  };
  const prove = async (row, profile, { priorSession } = {}) => {
    const launch = await start(candidate, profile);
    if (priorSession) { await retainedSession(launch, profile, priorSession); row.dataPreserved = true; }
    const id = await launch.submit();
    const state = readBundleStartupState(profile.controlRoot);
    assert.equal(state.artifactManifestSha256, candidate.manifestSha256);
    row.manifestSha256 = state.artifactManifestSha256;
    row.usableChat = true; row.eventStream = 'acknowledged'; row.submission = 'passed'; row.startup = launch.startup;
    await screenshot(row, launch);
    await stop(); row.gapRecords = await verifyReleaseJournal(profile);
    return { id, state };
  };
  try {
    assert.equal(receipt.runAttempt, 1, 'A rerun cannot erase a failed startup trial');
    await assertNoPriorStartupFailure(sourceCommit, process.env.GITHUB_RUN_ID);
    const gui = await probeDisposableMacGui(); receipt.guiPrerequisites = gui.status;
    assert.equal(gui.status, 'passed', 'Disposable GUI prerequisites unavailable');
    candidate = await inspectReleaseDmg({ dmg, version, directory: path.join(run.dir, 'installations/candidate') });
    receipt.manifestSha256 = candidate.manifestSha256; receipt.appSha256 = candidate.appSha256;
    const baselineDownloads = await downloadReleaseStartupBaselines({ version, directory: path.join(run.dir, 'downloads') });
    const baselines = [];
    for (const baseline of baselineDownloads) baselines.push({ ...await inspectReleaseDmg({ ...baseline,
      expectedSha256: baseline.sha256, directory: path.join(run.dir, 'installations', baseline.version), purpose: 'bundle-source' }), publishedTag: baseline.tag });
    const { runNativePackageAcceptance } = await import('../verify-opencode-v2-package.mjs');
    const compiled = await runNativePackageAcceptance({ artifactRoot: candidate.artifactRoot });
    receipt.compiledQualification = summarizeCompiledQualification(compiled, sanitizer);
    receipt.compiledNative = compiled.status;
    assert.equal(compiled.status, 'passed', 'Compiled native qualification failed');

    const empty = await newProfile('empty-profile', { fixtureSetup: false });
    let first;
    await scenario('empty-profile', async row => {
      const setup = await start(candidate, empty, { setupOnly: true });
      row.setupInterface = setup.startup.setupInterface;
      assert.equal(readBundleStartupState(empty.controlRoot).revision, 1);
      await stop();
      // Configure only the newly provisioned profile, after observing its normal setup interface.
      await empty.configure({ selected: true });
      first = await prove(row, empty);
    });
    await scenario('unchanged-reopen', async row => {
      const final = await prove(row, empty, { priorSession: first.id });
      assertNativeStartupReopen(first.state, final.state, row.startup.electronStartupPhases.records);
    }, { dependsOn: ['empty-profile'] });

    const upgrade = async (id, baseline, fault) => scenario(id, async row => {
      const { profile, launch: old } = await startBaseline(baseline, id), session = await old.submit();
      await stop();
      // Older releases dropped the initial service opt-out during setup projection.
      await profile.configure({ selected: true });
      const initial = readBundleStartupState(profile.controlRoot);
      row.baselineVersion = baseline.version; row.baselineDmgSha256 = baseline.dmgSha256;
      if (fault) await fault(profile, initial, row);
      const final = await prove(row, profile, { priorSession: session });
      if (initial.artifactManifestSha256 === candidate.manifestSha256) {
        assertNativeStartupReopen(initial, final.state, row.startup.electronStartupPhases.records);
        row.transition = 'unchanged';
      } else {
        assertNativeStartupUpgrade(initial, final.state, { opencodeVersion: candidate.opencodeVersion, artifactManifestSha256: candidate.manifestSha256 });
        row.transition = 'upgraded';
      }
      const reopen = await start(candidate, profile);
      await retainedSession(reopen, profile, final.id);
      assertNativeStartupReopen(final.state, readBundleStartupState(profile.controlRoot), reopen.startup.electronStartupPhases.records);
      row.stableReopen = true;
      await stop(); row.gapRecords = await verifyReleaseJournal(profile);
    });
    await upgrade('upgrade-previous', baselines[0]);
    await upgrade('upgrade-second-previous', baselines[1]);
    const sameVersion = baselines.find(row => row.opencodeVersion === candidate.opencodeVersion && row.manifestSha256 !== candidate.manifestSha256);
    assert.ok(sameVersion, 'A signed baseline with the same OpenCode version and different host artifacts is required');
    await upgrade('same-runtime-upgrade', sameVersion);

    await scenario('unsettled-process-upgrade', async row => {
      const { profile, launch: old } = await startBaseline(baselines[0], row.id), id = await old.submit();
      const scope = await releaseFixtureScope(old, profile, id);
      await stop(); await profile.configure({ selected: true });
      const initial = readBundleStartupState(profile.controlRoot);
      const database = profile.binding().descriptor.launch.opencodeDatabasePath;
      const before = await hashReleaseFile(database);
      await seedReleaseUnsettledProcess(profile, scope);
      const failed = await start(candidate, profile, { expectedFailure: 'bundle_execution_unsettled' });
      await screenshot(row, failed, `${row.id}-failure`);
      await failed.ui.click({ selector: 'a[href="openchamber://prepare-reboot-recovery"]', text: 'Prepare recovery for restart' });
      await failed.ui.waitVisibleText('Restart your computer to continue');
      await screenshot(row, failed, `${row.id}-prepared`);
      await stop();
      assert.deepEqual(readBundleStartupState(profile.controlRoot), initial);
      const refused = await start(candidate, profile, { expectedFailure: 'bundle_reboot_required' });
      await screenshot(row, refused, `${row.id}-same-boot`);
      await stop();
      assert.deepEqual(readBundleStartupState(profile.controlRoot), initial);
      assert.equal(await hashReleaseFile(database), before);
      Object.assign(row, { failureCode: 'bundle_execution_unsettled', recoveryPrepared: true, sameBootRefused: true,
        selectionPreserved: true, dataPreserved: true, manifestSha256: candidate.manifestSha256 });
      row.gapRecords = await verifyReleaseJournal(profile);
    });

    await upgrade('interrupted-upgrade', baselines[0], async (profile, initial, row) => {
      const environment = await prepareReleaseService(profile);
      const app = startOwnedProcess(candidate.binary, ['--use-mock-keychain'], { cwd: profile.workspace, env: profile.env });
      try {
        await waitReleaseStartup('in-progress artifact retention', async () =>
          (await fs.readdir(path.join(profile.controlRoot, 'artifacts'))).some(name => name.startsWith('.retaining-')), app.check);
        app.child.kill('SIGKILL'); await app.stop();
        assert.deepEqual(readBundleStartupState(profile.controlRoot), initial, 'Interrupted retention changed selection');
      } finally { await runReleaseCleanup(async () => {
        try { await app.stop(); } finally {
          try { await environment.cleanup(); }
          finally { row.interruptedStop = await captureReleaseLocks(profile, app, sanitizer); }
        }
      }); }
    });
    await upgrade('rejected-candidate', baselines[0], async (profile, initial, row) => {
      // A separate tampered copy is only a negative control. All successful starts use the unchanged installer app.
      const badApp = path.join(run.dir, 'negative-control/DevRyan.app');
      await fs.mkdir(path.dirname(badApp), { recursive: true });
      await exec('/usr/bin/ditto', [candidate.appPath, badApp], { timeout: 120_000 });
      const manifest = JSON.parse(await fs.readFile(path.join(candidate.artifactRoot, 'native-bundle.json'), 'utf8'));
      const payload = manifest.files.find(row => row.role === 'controller'); assert.ok(payload);
      await fs.truncate(path.join(badApp, 'Contents/Resources/revert-runtime/darwin-arm64', payload.path), 4);
      const database = profile.binding().descriptor.launch.opencodeDatabasePath, before = await hashReleaseFile(database);
      const environment = await prepareReleaseService(profile);
      const logOffset = readNativeStartupLogs(null, profile.env.HOME).length;
      const debugPort = await reservePort();
      const app = startOwnedProcess(path.join(badApp, 'Contents/MacOS/DevRyan'), [`--remote-debugging-port=${debugPort}`, '--use-mock-keychain'], { cwd: profile.workspace, env: profile.env });
      try {
        await waitReleaseStartup('terminal integrity rejection', () =>
          readNativeStartupLogs(app, profile.env.HOME, logOffset).includes('native_runtime_artifacts_unverified'), app.check);
      } finally {
        try {
          const log = readNativeStartupLogs(app, profile.env.HOME, logOffset);
          row.tampered = { log: sanitizer.sanitizeText(log, { highEntropy: true }).slice(-16000),
            terminalPhases: parseStartupPhaseLogs(log).filter(phase => phase.outcome === 'failed'),
            processAlive: app.child.exitCode === null && app.child.signalCode === null,
            integrityRejected: log.includes('native_runtime_artifacts_unverified'),
            selectionPreserved: JSON.stringify(readBundleStartupState(profile.controlRoot)) === JSON.stringify(initial),
            databaseBefore: before, databaseAfter: await hashReleaseFile(database),
            beforeStop: await captureReleaseLocks(profile, app, sanitizer) };
          let cdp;
          try {
            const target = await discoverPageTarget(debugPort, 2000);
            cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
            row.tampered.usable = await evaluate(cdp, 'window.__openchamberStartupReady === true && Boolean(document.querySelector("textarea:not(:disabled)"))', { timeoutMs: 2000 });
          } catch { row.tampered.usable = 'unavailable'; }
          finally { cdp?.close(); }
        } finally { await runReleaseCleanup(async () => {
          try { await app.stop(); } finally {
            try { await environment.cleanup(); }
            finally { row.tampered ??= {}; row.tampered.afterStop = await captureReleaseLocks(profile, app, sanitizer); }
          }
        }); }
        if (row.tampered.usable === true || row.tampered.selectionPreserved === false || row.tampered.databaseAfter !== before)
          throw Object.assign(Error('Tampered app violated protected startup state'), { code: 'release_startup_prerequisite_failed' });
      }
      assert.deepEqual(readBundleStartupState(profile.controlRoot), initial);
      assert.equal(await hashReleaseFile(database), before, 'Rejected candidate modified saved conversation data');
    });
    await scenario('stale-owner', async row => {
      const profile = await newProfile('stale-owner');
      await seedStaleReleaseOwner(profile);
      await prove(row, profile); row.liveOwnerProtected = true;
    });

    serviceProfile = await newProfile('service');
    service = await prepareReleaseService(serviceProfile);
    let warmIdentity, warmSession;
    await scenario('service-warm', async row => {
      const launch = await start(candidate, serviceProfile);
      const status = await service.enable(launch); warmIdentity = status.handshake.instanceId;
      assert.ok(warmIdentity);
      await stop();
      const ready = await start(candidate, serviceProfile);
      assert.equal((await releaseServiceStatus(ready)).handshake?.instanceId, warmIdentity);
      warmSession = await ready.submit();
      Object.assign(row, { manifestSha256: candidate.manifestSha256, usableChat: true, eventStream: 'acknowledged', submission: 'passed', startup: ready.startup });
      const journal = await ready.request('/api/diagnostics/status');
      assert.equal(journal.status, 200); assert.equal(journal.body.gapRecords, 0); assert.ok(!journal.body.lastError);
      row.gapRecords = 0;
      await screenshot(row, ready);
    });
    await scenario('service-cold', async row => {
      await service.cold();
      const ready = await start(candidate, serviceProfile);
      const status = await releaseServiceStatus(ready);
      assert.equal(status.connected, true); assert.notEqual(status.handshake?.instanceId, warmIdentity);
      await retainedSession(ready, serviceProfile, warmSession); await ready.submit();
      Object.assign(row, { manifestSha256: candidate.manifestSha256, usableChat: true, eventStream: 'acknowledged', submission: 'passed', startup: ready.startup });
      await screenshot(row, ready);
      await service.cleanup(ready); service = null;
      await stop(); row.gapRecords = await verifyReleaseJournal(serviceProfile);
    }, { dependsOn: ['service-warm'] });
    assert.equal((await captureQaElectronAppIdentity(candidate.appPath)).sha256, candidate.appSha256, 'Distributed app was modified');
    assert.equal(await hashReleaseFile(dmg), receipt.dmgSha256, 'Distributed DMG was modified');
    receipt.forcedServiceCleanup = profiles.some(profile => profile.forcedServiceCleanup === true);
    assertReleaseTrialEvidence(receipt);
    assert.ok(!diagnostic, 'Diagnostic receipts cannot qualify a release');
    receipt.outcome = 'passed';
    assertReleaseStartupReceipt(receipt, { sourceCommit, dmgSha256: receipt.dmgSha256, version });
  } catch (error) {
    receipt.outcome = 'failed';
    receipt.error = typeof error.code === 'string' && /^[a-z_]{1,100}$/.test(error.code) ? error.code : 'release_startup_contract_failed';
    receipt.reason = sanitizer.sanitizeText(String(error.message), { highEntropy: true }).slice(0, 1000);
    console.error('[release-startup] failed', receipt.scenarios.at(-1)?.id ?? 'artifact-or-prerequisite');
  } finally {
    try { await service?.cleanup(active); } catch { receipt.cleanupErrors.push('service_cleanup_failed'); }
    try { await stop(); } catch { receipt.cleanupErrors.push('foreground_cleanup_failed'); }
    if (serviceProfile && (await readRuntimeServiceOwner({ dataDirectory: serviceProfile.env.OPENCHAMBER_DATA_DIR })).state !== 'missing')
      receipt.cleanupErrors.push('service_owner_survived_cleanup');
    for (const profile of profiles) { try { await profile.close(); } catch { receipt.cleanupErrors.push('provider_cleanup_failed'); } }
    if (receipt.cleanupErrors.length) receipt.outcome = 'failed';
    receipt.forcedServiceCleanup = profiles.some(profile => profile.forcedServiceCleanup === true);
    if (receipt.outcome === 'passed' && !run.keepArtifacts) {
      try {
        const payloads = ['installations', 'downloads', 'profiles', 'negative-control'];
        removeRunPayloads(run.dir, { extra: payloads });
        for (const name of payloads) assert.equal(await fs.lstat(path.join(run.dir, name)).then(() => true, error => {
          if (error.code !== 'ENOENT') throw error;
          return false;
        }), false, 'Release payload survived cleanup');
      } catch { receipt.cleanupErrors.push('payload_cleanup_failed'); receipt.outcome = 'failed'; }
    }
    receipt.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    run.finish(receipt.outcome);
  }
  return { ...receipt, output: run.dir };
}
