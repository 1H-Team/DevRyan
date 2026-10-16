import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRunRoot, removeRunPayloads } from './run-root.mjs';
import { requireDisposableMacRunner, probeDisposableMacGui } from './macos-gui-prerequisites.mjs';
import { inspectReleaseDmg, hashReleaseFile } from './release-startup-artifacts.mjs';
import { createReleaseStartupProfile } from './release-startup-profile.mjs';
import { launchReleaseStartup, assertReleaseRetainedSession, verifyReleaseJournal } from './release-startup-launch.mjs';
import { REHEARSAL_PHASE_SECONDS, assertReleaseSmokeRetry, assertReleaseSmokeReceipt, correlateReleaseNativeJournal, readReleaseSmokeReceipt, assertReleaseSmokeArtifactIdentity } from './release-startup-smoke-contract.mjs';
import { collectGapPaths, readRecordsFromPaths } from '../journal.mjs';
import { hash } from '../release-artifacts.mjs';
import { assertPriorGateAttempts, githubReleaseClient, isExecutedReleaseGateJob, releaseGateExecutions } from '../release-publication.mjs';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export async function runReleaseSmokeSetup(receipt, operation, { now = () => performance.now(), maximumMs = 180_000 } = {}) {
  const started = now(), deadline = started + maximumMs;
  const signal = AbortSignal.timeout(maximumMs);
  receipt.setup = { status: 'failed', limitSeconds: maximumMs / 1000, elapsedMs: 0 };
  try {
    const result = await operation(deadline, signal);
    signal.throwIfAborted(); assert.ok(now() < deadline, 'Release smoke setup deadline expired');
    receipt.setup.status = 'passed'; return result;
  } finally { receipt.setup.elapsedMs = now() - started; }
}
export function createSmokePhaseClock(limits, { now = () => performance.now(), maximumMs = 570_000 } = {}) {
  assert.deepEqual(Object.keys(limits).sort(), Object.keys(REHEARSAL_PHASE_SECONDS).sort());
  assert.ok(Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0));
  assert.ok(Object.values(limits).reduce((sum, value) => sum + value, 0) <= 570);
  const started = now(), absoluteDeadline = started + maximumMs;
  return { started, absoluteDeadline, limits, deadline(name) {
    const reserve = name === 'receipt' ? 0 : name === 'cleanup' ? limits.receipt : limits.cleanup + limits.receipt;
    const deadline = Math.min(now() + limits[name] * 1000, absoluteDeadline - reserve * 1000);
    assert.ok(deadline > now(), `No remaining release smoke budget for ${name}`); return deadline;
  } };
}
export async function runReleaseSmokePhase({ receipt, clock, name, operation, now = () => performance.now() }) {
  const started = now(), deadline = clock.deadline(name), controller = new AbortController();
  const row = receipt.phases[name] = { status: 'failed', limitSeconds: clock.limits?.[name] ?? (deadline - started) / 1000, elapsedMs: 0 };
  const timer = setTimeout(() => controller.abort(Object.assign(Error(`Release smoke ${name} timed out`), { code: 'release_smoke_phase_timeout' })), Math.max(1, deadline - now()));
  try {
    const result = await operation(deadline, controller.signal);
    controller.signal.throwIfAborted(); assert.ok(now() <= deadline, `Release smoke ${name} exceeded its captured deadline`);
    row.status = 'passed'; return result;
  } finally { clearTimeout(timer); row.elapsedMs = now() - started; }
}
export async function writeReleaseSmokeReceipt({ receipt, receiptPath, deadline, clockStarted, limitSeconds, io = fs, now = () => performance.now() }) {
  const started = now(), partial = `${receiptPath}.partial`, witnessPath = `${receiptPath}.receipt-io`, observationPath = `${receiptPath}.receipt-observation`;
  const controller = new AbortController(), check = () => { controller.signal.throwIfAborted(); assert.ok(now() < deadline, 'Receipt I/O deadline expired'); };
  const timer = setTimeout(() => controller.abort(Error('Receipt I/O deadline expired')), Math.max(1, deadline - now()));
  receipt.phases.receipt = { status: 'pending', limitSeconds, elapsedMs: 0 };
  delete receipt.ioWitness; delete receipt.ioObservation;
  try {
    check(); await io.mkdir(path.dirname(receiptPath), { recursive: true }); check();
    assert.equal(await io.lstat(receiptPath).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; }), false);
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    await io.writeFile(partial, bytes, { mode: 0o600, flag: 'wx', signal: controller.signal }); check();
    await io.rename(partial, receiptPath); check();
    const scope = { sourceCommit: receipt.sourceCommit, dmgSha256: receipt.dmgSha256, sample: receipt.sample, runID: receipt.runID, runAttempt: receipt.runAttempt,
      qualificationAttempt: receipt.qualificationAttempt, runnerID: receipt.runnerID };
    const witness = { protocol: 'devryan.release-receipt-io/1', receiptSha256: hash(bytes), ...scope };
    const witnessBytes = JSON.stringify(witness) + '\n';
    await io.writeFile(witnessPath, witnessBytes, { mode: 0o600, flag: 'wx', signal: controller.signal }); check();
    // The receipt owner can now measure both writes. This external observation
    // cannot measure its own commit; that commit is fenced by the same deadline.
    const phase = { status: 'passed', limitSeconds, elapsedMs: now() - started };
    const observation = { protocol: 'devryan.release-receipt-observation/1', receiptSha256: hash(bytes), witnessSha256: hash(witnessBytes),
      phase, elapsedMs: now() - clockStarted, ...scope,
      clockScope: 'receipt-json-and-digest-witness-io', observationCommit: 'bounded-by-receipt-deadline-excluded-from-observation' };
    await io.writeFile(observationPath, JSON.stringify(observation) + '\n', { mode: 0o600, flag: 'wx', signal: controller.signal }); check();
    receipt.phases.receipt = phase; receipt.elapsedMs = observation.elapsedMs; receipt.ioWitness = witness; receipt.ioObservation = observation;
  } catch (error) {
    receipt.outcome = 'failed'; receipt.phases.receipt.status = 'failed'; receipt.phases.receipt.elapsedMs = now() - started;
    await io.rm(observationPath, { force: true });
    await io.rm(witnessPath, { force: true });
    await io.rm(receiptPath, { force: true });
    await io.writeFile(partial, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }).catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}
export function admitReleaseSmokeAttempt(receipt, jobs, priorReceipts) {
  jobs = releaseGateExecutions(jobs);
  for (const job of jobs.filter(job => isExecutedReleaseGateJob(job, priorReceipts))) assert.ok(Number.isSafeInteger(job.run_attempt) && job.run_attempt >= 1, 'Complete gate attempt inventory required');
  const jobName = receipt.rehearsal ? `candidate-startup-${receipt.sample}` : 'final-dmg-smoke';
  const current = jobs.filter(row => row.name === jobName && row.run_attempt === receipt.runAttempt);
  assert.equal(current.length, 1); receipt.jobID = current[0].id; receipt.runnerID = current[0].runner_id;
  assert.ok(Number.isSafeInteger(receipt.jobID) && receipt.jobID > 0, 'Current gate job identity required');
  const previous = jobs.filter(row => row.name === jobName && isExecutedReleaseGateJob(row, priorReceipts) && row.run_attempt < receipt.runAttempt)
    .sort((left, right) => left.run_attempt - right.run_attempt);
  receipt.qualificationAttempt = previous.length + 1;
  const receipts = previous.map((job, index) => {
    const matches = priorReceipts.filter(row => row.jobID === job.id && row.runAttempt === job.run_attempt);
    assert.equal(matches.length, 1, 'Every previous qualification receipt is required');
    if (job.runner_id != null && job.runner_id !== 0) assert.equal(matches[0].runnerID, job.runner_id, 'Qualification runner identity changed');
    assert.equal(matches[0].qualificationAttempt, index + 1, 'Qualification sequence changed');
    return matches[0];
  });
  assertReleaseSmokeRetry(receipts, receipt);
  assertPriorGateAttempts(jobs.filter(row => row.run_attempt < receipt.runAttempt), priorReceipts,
    { source: receipt.sourceCommit, version: receipt.version, runID: receipt.runID, dmgSha256: receipt.dmgSha256 });
  return receipt;
}
export async function readReleaseSmokePriorReceipts(directory, { signal } = {}) {
  const receipts = [];
  const names = await fs.readdir(directory, { recursive: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names.filter(name => name.endsWith('.json'))) {
    signal?.throwIfAborted();
    try { receipts.push(await readReleaseSmokeReceipt(path.join(directory, name), { signal })); }
    catch { /* A missing witness or partial receipt never excuses its original job. */ }
  }
  signal?.throwIfAborted();
  return receipts;
}
export async function runReleaseStartupSmoke({ dmg, metadata, receiptPath, rehearsal = false, sample = 0, limits = REHEARSAL_PHASE_SECONDS, expectedIdentity, priorReceipts = [], priorDirectory, environment = process.env }) {
  const receipt = { protocol: 'devryan.release-startup-smoke/1', sourceCommit: metadata.sourceCommit, version: metadata.version,
    dmgSha256: metadata.dmgSha256, rehearsal, sample, runID: String(environment.GITHUB_RUN_ID), runAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    outcome: 'failed', appStarted: false, fixtureAttempts: 0, safeCleanup: false, cleanupErrors: [], phases: {} };
  let clock, profile, launch, stop = async () => {};
  const run = createRunRoot({ parent: path.join(repository, '.cache/release-startup-smoke'), owner: 'release-startup-smoke',
    extraPayloads: ['installations', 'profiles'], onInterrupt: async () => {
      await stop({ deadline: clock ? clock.deadline('cleanup') : performance.now() + limits.cleanup * 1000 });
      await profile?.close();
    } });
  const phase = (name, operation) => runReleaseSmokePhase({ receipt, clock, name, operation });
  try {
    await runReleaseSmokeSetup(receipt, async (deadline, signal) => {
      requireDisposableMacRunner(environment);
      if (!rehearsal) assert.ok(expectedIdentity, 'Final smoke requires the admitted candidate installer/app/manifest identity');
      assert.equal(metadata.protocol, 'devryan.release-candidate/1');
      assert.equal(metadata.lockfile, await hashReleaseFile(path.join(repository, 'bun.lock'), { signal }), 'Candidate lockfile differs from frozen source');
      assert.equal(metadata.sourceCommit, environment.GITHUB_SHA);
      assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: repository, signal })).stdout.trim(), metadata.sourceCommit);
      assert.equal(path.basename(dmg), `DevRyan-${metadata.version}-arm64.dmg`);
      assert.equal(await hashReleaseFile(dmg, { signal }), metadata.dmgSha256, 'Retained installer bytes changed');
      if (priorDirectory) priorReceipts = await readReleaseSmokePriorReceipts(priorDirectory, { signal });
      const jobs = await githubReleaseClient(environment, fetch, { signal }).pages(`/actions/runs/${receipt.runID}/jobs?filter=all`, 'jobs');
      admitReleaseSmokeAttempt(receipt, jobs, priorReceipts);
      const gui = await probeDisposableMacGui({ deadline, signal }); receipt.guiPrerequisites = gui.status;
      signal.throwIfAborted();
      if (gui.status !== 'passed') {
        assert.equal(gui.safeCleanup, true, 'GUI prerequisite cleanup was not proved');
        receipt.failureClass = gui.failureClass ?? 'gui_probe_failed';
        receipt.safeCleanup = true; throw Object.assign(Error('GUI prerequisite unavailable'), { code: receipt.failureClass });
      }
    });
    clock = createSmokePhaseClock(limits);
    const artifact = await phase('inspection', (deadline, signal) => inspectReleaseDmg({ deadline, signal, dmg, expectedSha256: metadata.dmgSha256,
      version: metadata.version, directory: path.join(run.dir, 'installations') }));
    Object.assign(receipt, { manifestSha256: artifact.manifestSha256, appSha256: artifact.appSha256 });
    if (expectedIdentity) assertReleaseSmokeArtifactIdentity(receipt, expectedIdentity);
    launch = await phase('firstReady', async (deadline, signal) => {
      receipt.fixtureAttempts++;
      const prepared = await createReleaseStartupProfile(path.join(run.dir, 'profiles'), { fixtureSetup: true, deadline, signal });
      profile = prepared;
      return launchReleaseStartup(artifact, profile, { deadline, signal, cleanupDeadline: clock.absoluteDeadline - limits.receipt * 1000, onStarted: () => { receipt.appStarted = true; }, onLaunchStop: value => { stop = value; } });
    });
    assert.ok(launch.startup.healthObservations.some(row => row.state === 'ready' && row.attempt === 1), 'The fixture must admit native boot attempt one');
    assert.ok(launch.startup.healthObservations.every(row => row.attempt === 0 || row.attempt === 1), 'Boot retries cannot qualify');
    assert.equal(launch.subscription.transport, 'sse');
    assert.ok(Number.isFinite(launch.subscription.readyAcknowledgedAtMs));
    receipt.eventStream = 'acknowledged';
    assert.equal(profile.binding().descriptor.launch.artifactManifestSha256, artifact.manifestSha256, 'Native execution must use the exact extracted manifest');
    let sessionID;
    await phase('chat', async (deadline, signal) => {
      sessionID = await launch.submit({ deadline, signal });
      const observation = profile.provider.observations.find(row => row.model === 'smoke-write' && row.completedAt);
      assert.ok(observation); receipt.providerObservation = 'passed';
      receipt.providerRequest = { model: observation.model, requestID: observation.requestID, requestSha256: observation.requestSha256 };
      const result = await launch.request(`/api/session/${encodeURIComponent(sessionID)}/message?directory=${encodeURIComponent(profile.workspace)}`, undefined, deadline);
      assert.equal(result.status, 200);
      const journal = [], directory = path.join(profile.binding().descriptor.launch.webDataDirectory, 'harness/journal');
      for await (const row of readRecordsFromPaths(await collectGapPaths(directory, { verify: true }))) journal.push(row);
      receipt.nativeCorrelation = correlateReleaseNativeJournal(journal, { sessionID, directory: profile.workspace, messages: result.body });
      assert.ok(result.body.some(row => row.info?.role === 'assistant' && row.info?.time?.completed
        && row.parts?.some(part => part.type === 'text' && part.text?.includes('DevRyan live QA ready.'))));
      receipt.completedAssistant = 'passed';
      await launch.uiForDeadline(deadline, signal).waitVisibleText('DevRyan live QA ready.', `[data-message-id=${JSON.stringify(receipt.nativeCorrelation.assistantMessageID)}]`);
      receipt.renderedResponse = 'passed';
    });
    await phase('stop', deadline => stop({ deadline }));
    launch = await phase('reopen', (deadline, signal) => launchReleaseStartup(artifact, profile, { deadline, signal, cleanupDeadline: clock.absoluteDeadline - limits.receipt * 1000, onLaunchStop: value => { stop = value; } }));
    await phase('history', async (deadline, signal) => { assert.ok(launch.startup.healthObservations.every(row => row.attempt === 0 || row.attempt === 1), 'Reopen boot retries cannot qualify'); assert.equal(profile.binding().descriptor.launch.artifactManifestSha256, artifact.manifestSha256); await assertReleaseRetainedSession(launch, profile, sessionID, { deadline, signal }); receipt.retainedHistory = 'passed'; });
  } catch (error) {
    receipt.failureClass ??= 'release_smoke_product_or_evidence_failure';
    receipt.error = /^[a-z_]{1,100}$/.test(error.code ?? '') ? error.code : 'release_smoke_failed';
  } finally {
    try {
      const cleanup = async (deadline, signal) => {
        await stop({ deadline });
        if (profile) { receipt.gapRecords = await verifyReleaseJournal(profile, { deadline, signal }); await profile.close(); }
        removeRunPayloads(run.dir, { extra: ['installations', 'profiles'] });
        for (const name of ['installations', 'profiles']) assert.equal(await fs.lstat(path.join(run.dir, name)).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; }), false);
        receipt.safeCleanup = true;
      };
      if (clock) await phase('cleanup', cleanup); else await cleanup();
    } catch { receipt.cleanupErrors.push('release_smoke_cleanup_failed'); receipt.safeCleanup = false; }
    receipt.elapsedMs = clock ? performance.now() - clock.started : 0;
    receipt.outcome = !receipt.error && receipt.safeCleanup && receipt.cleanupErrors.length === 0 ? 'passed' : 'failed';
    receipt.finishedAt = new Date().toISOString();
    try {
      const deadline = clock ? clock.deadline('receipt') : performance.now() + 30000;
      await writeReleaseSmokeReceipt({ receipt, receiptPath, deadline, clockStarted: clock?.started ?? performance.now(), limitSeconds: limits.receipt });
    } catch { receipt.outcome = 'failed'; receipt.error = 'release_smoke_receipt_failed'; }
    run.finish(receipt.outcome);
  }
  if (receipt.outcome === 'passed') assertReleaseSmokeReceipt(receipt, { ...metadata, rehearsal });
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { dmg: { type: 'string' }, metadata: { type: 'string' }, receipt: { type: 'string' },
    rehearsal: { type: 'boolean', default: false }, sample: { type: 'string', default: '0' }, limits: { type: 'string' }, identity: { type: 'string' }, prior: { type: 'string' } }, strict: true });
  const read = file => fs.readFile(file, 'utf8').then(JSON.parse);
  let result;
  try {
    result = await runReleaseStartupSmoke({ dmg: path.resolve(values.dmg), metadata: await read(values.metadata), receiptPath: path.resolve(values.receipt),
      rehearsal: values.rehearsal, sample: Number(values.sample), limits: values.limits ? await read(values.limits) : undefined, expectedIdentity: values.identity ? await read(values.identity) : undefined, priorDirectory: values.prior });
  } catch {
    result = { protocol: 'devryan.release-startup-smoke/1', runID: String(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      outcome: 'failed', failureClass: 'release_smoke_input_or_receipt_failed', appStarted: false, fixtureAttempts: 0 };
    try {
      await fs.mkdir(path.dirname(path.resolve(values.receipt)), { recursive: true });
      await fs.writeFile(`${path.resolve(values.receipt)}.partial`, JSON.stringify(result) + '\n', { mode: 0o600, flag: 'wx' });
    } catch { result.error = 'release_smoke_failed_evidence_unavailable'; }
  }
  console.log(JSON.stringify({ outcome: result.outcome, failureClass: result.failureClass, error: result.error })); process.exitCode = result.outcome === 'passed' ? 0 : 1;
}
