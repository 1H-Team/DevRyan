import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { REHEARSAL_PHASE_SECONDS, freezeReleaseSmokeBudget, assertReleaseSmokeRetry, assertReleaseSmokeReceipt, correlateReleaseNativeJournal, assertReleaseSmokeArtifactIdentity } from './release-startup-smoke-contract.mjs';
import { assertReleaseUpgradeRollbackReceipt } from './release-startup-upgrade-rollback.mjs';
import { assertReleaseRetainedSession } from './release-startup-launch.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readReleaseSmokeReceipt } from './release-startup-smoke-contract.mjs';
import { createSmokePhaseClock, runReleaseSmokeSetup, runReleaseSmokePhase, writeReleaseSmokeReceipt, admitReleaseSmokeAttempt, readReleaseSmokePriorReceipts, runReleaseStartupSmoke } from './release-startup-smoke.mjs';

const identity = { sourceCommit: 'a'.repeat(40), version: '2.0.10', dmgSha256: 'b'.repeat(64), rehearsal: true };
const receipt = sample => { const value = { protocol: 'devryan.release-startup-smoke/1', ...identity, sample, runID: '17', runAttempt: 1, qualificationAttempt: 1, runnerID: 100 + sample,
  outcome: 'passed', ioWitness: { protocol: 'devryan.release-receipt-io/1', receiptSha256: 'e'.repeat(64) }, manifestSha256: 'c'.repeat(64), appSha256: 'd'.repeat(64), appStarted: true, fixtureAttempts: 1,
  safeCleanup: true, cleanupErrors: [], eventStream: 'acknowledged', guiPrerequisites: 'passed', providerObservation: 'passed',
  completedAssistant: 'passed', renderedResponse: 'passed', retainedHistory: 'passed', gapRecords: 0, nativeCorrelation: { status: 'passed' },
  elapsedMs: 80_000, phases: Object.fromEntries(Object.entries(REHEARSAL_PHASE_SECONDS).map(([name, limitSeconds]) => [name, { status: 'passed', elapsedMs: 1000, limitSeconds }])) };
  value.ioObservation = { protocol: 'devryan.release-receipt-observation/1', receiptSha256: value.ioWitness.receiptSha256,
    witnessSha256: 'f'.repeat(64), phase: value.phases.receipt, elapsedMs: value.elapsedMs };
  return value; };
test('three same-source same-byte green rehearsals freeze ceil(3x slowest) with readiness and IO floors', () => {
  const receipts = [1, 2, 3].map(receipt); receipts[2].phases.chat.elapsedMs = 4300;
  const limits = freezeReleaseSmokeBudget(receipts, identity);
  assert.equal(limits.chat, 13); assert.equal(limits.firstReady, 30); assert.equal(limits.reopen, 30); assert.equal(limits.inspection, 10);
  for (const change of [{ sample: 2 }, { dmgSha256: 'e'.repeat(64) }, { manifestSha256: 'e'.repeat(64) }, { appSha256: 'e'.repeat(64) }, { sourceCommit: 'f'.repeat(40) }, { outcome: 'failed' }, { fixtureAttempts: 2 }])
    assert.throws(() => freezeReleaseSmokeBudget([receipt(1), receipt(2), { ...receipt(3), ...change }], identity));
  for (const row of receipts) for (const phase of Object.values(row.phases)) phase.elapsedMs = phase.limitSeconds * 1000;
  assert.throws(() => freezeReleaseSmokeBudget(receipts, identity), /570/);
});
test('three green rehearsals require distinct original hosted runners',()=>{
  const receipts=[1,2,3].map(receipt);receipts[2].runnerID=receipts[1].runnerID;
  assert.throws(()=>freezeReleaseSmokeBudget(receipts,identity),/distinct original hosted runners/);
});
test('one shared absolute deadline reserves cleanup and receipt time instead of resetting every wait', () => {
  let now = 0;
  const clock = createSmokePhaseClock(REHEARSAL_PHASE_SECONDS, { now: () => now });
  assert.equal(clock.deadline('inspection'), 150_000); now = 470_000;
  assert.equal(clock.deadline('firstReady'), 480_000);
  assert.equal(clock.deadline('cleanup'), 530_000); now = 540_000;
  assert.throws(() => clock.deadline('history'), /remaining/);
  assert.equal(clock.deadline('receipt'), 570_000); now = 571_000;
  assert.throws(() => clock.deadline('cleanup'));
});
test('setup shares a separate finite deadline and waits for an aborted owner before receipt cleanup', async () => {
  let now = 0;
  const record = {};
  await runReleaseSmokeSetup(record, async (deadline, signal) => {
    assert.equal(deadline, 180_000); assert.equal(signal.aborted, false); now = 120_000;
  }, { now: () => now });
  assert.deepEqual(record.setup, { status: 'passed', limitSeconds: 180, elapsedMs: 120_000 });
  assert.equal(createSmokePhaseClock(REHEARSAL_PHASE_SECONDS, { now: () => now }).absoluteDeadline, 690_000,
    'Pre-app setup cannot consume or renew the later absolute smoke budget');
  await assert.rejects(runReleaseSmokeSetup(record, async () => { now = 180_000; }, { now: () => now, maximumMs: 10 }), /setup deadline/);
  let settled = false;
  await assert.rejects(runReleaseSmokeSetup(record, async (_deadline, signal) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    settled = true; signal.throwIfAborted();
  }, { maximumMs: 5 }));
  assert.equal(settled, true); assert.equal(record.setup.status, 'failed');
});
test('only two typed pre-app GUI retries with all previous safe receipts retain the same run, sample and bytes', () => {
  const base = { ...receipt(1), outcome: 'failed', appStarted: false, fixtureAttempts: 0, failureClass: 'pre_app_gui_unavailable' };
  const latest = { ...base, runAttempt: 12, qualificationAttempt: 3, runnerID: 103 };
  assertReleaseSmokeRetry([base, { ...base, runAttempt: 7, qualificationAttempt: 2, runnerID: 102 }], latest);
  assert.throws(() => assertReleaseSmokeRetry([base], latest), /Every previous/);
  assert.throws(() => assertReleaseSmokeRetry([], { ...latest, qualificationAttempt: 4 }), /two fresh/);
  for (const change of [{ appStarted: true }, { fixtureAttempts: 1 }, { safeCleanup: false }, { outcome: 'passed' }, { cleanupErrors: ['failure'] }, { runnerID: 103 }, { dmgSha256: 'e'.repeat(64) }, { runID: '18' }, { sample: 2 }, { failureClass: 'native_process_boot_timeout' }])
    assert.throws(() => assertReleaseSmokeRetry([{ ...base, ...change }], { ...latest, qualificationAttempt: 2 }));
});
test('native correlation reads the original sanitized journal and binds canonical user, assistant, controller, config, request and physical span', () => {
  const directory = '/fixture/release-project', sessionID = 'ses_release';
  const common = { schema: 1, controllerInstanceID: 'controller_release', configurationDigest: 'c'.repeat(64), sessionID, directory };
  const execution = { agent: 'builder', providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'high' };
  const attempt = { traceID: 'trace_release', spanID: 'span_release' };
  const raw = [
    { ...common, stage: 'accepted-user', messageID: 'msg_user', fingerprint: 'd'.repeat(64), intent: { source: 'prompt', variantPresent: false } },
    { ...common, stage: 'step-link', userMessageID: 'msg_user', assistantMessageID: 'msg_assistant', eventID: 'event_release', sequence: 1, created: 1000, execution, attempt },
    { ...common, stage: 'model-prepared', requestID: 'request_release', kind: 'primary', execution, options: {}, hookOptions: {}, modelLimits: { context: 32768, input: null, output: 4096 } },
    { ...common, stage: 'physical', requestID: 'request_release', kind: 'primary', transport: 'http', wireOptions: {}, ordinal: 1, attempt },
  ];
  const sanitizer = createDiagnosticSanitizer({ worktreeRoots: [directory] });
  const journal = raw.map(payload => sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'native_observation', sessionID, directory, payload }));
  const messages = [{ info: { id: 'msg_user', role: 'user' } }, { info: { id: 'msg_assistant', role: 'assistant', time: { completed: 2000 } } }];
  assert.equal(correlateReleaseNativeJournal(journal, { sessionID, directory, messages }).requestID, 'request_release');
  for (const index of [0, 1, 2, 3]) assert.throws(() => correlateReleaseNativeJournal(journal.filter((_, i) => i !== index), { sessionID, directory, messages }));
  for (const key of ['controllerInstanceID', 'configurationDigest', 'sessionID']) {
    const changed = structuredClone(journal); changed[3].payload[key] = key === 'configurationDigest' ? 'e'.repeat(64) : 'foreign_release';
    assert.throws(() => correlateReleaseNativeJournal(changed, { sessionID, directory, messages }));
  }
  assert.throws(() => correlateReleaseNativeJournal(journal, { sessionID, directory: '/fixture/foreign', messages }));
  assert.throws(() => correlateReleaseNativeJournal(journal, { sessionID, directory, messages: messages.slice(0, 1) }));
});
test('short smoke receipts cannot substitute legacy qualification, incomplete chat or unsafe cleanup', () => {
  assertReleaseSmokeReceipt(receipt(1), identity);
  for (const change of [{ protocol: 'devryan.release-startup/1' }, { completedAssistant: 'pending' }, { gapRecords: 1 }, { safeCleanup: false }, { retainedHistory: 'missing' }, { rehearsal: false }])
    assert.throws(() => assertReleaseSmokeReceipt({ ...receipt(1), ...change }, identity));
});

test('pre-tag compiled upgrade and rollback require actual original-owner cases and frozen baseline identities', () => {
  const evidence = { protocol: 'devryan.release-upgrade-rollback/1', ...identity, outcome: 'passed', manifestSha256: 'c'.repeat(64),
    baseline: { sourceCommit: 'd'.repeat(40), version: '2.0.9', dmgSha256: 'e'.repeat(64), manifestSha256: 'f'.repeat(64) },
    diagnostic: false, attempts: 1, safeCleanup: true, cleanupErrors: [], sourceChanged: false,
    cases: ['compiled-clone-layout-legacy', 'compiled-clone-layout-fresh-install', 'compiled-fresh-install-clone',
      'compiled-fresh-install-rollback', 'candidate-work-rollback-retention'].map(id => ({ id, status: 'passed' })) };
  assertReleaseUpgradeRollbackReceipt(evidence, identity);
  for (const change of [{ protocol: 'devryan.release-startup-smoke/1' }, { attempts: 2 }, { diagnostic: true }, { cases: evidence.cases.slice(1) },
    { baseline: { ...evidence.baseline, sourceCommit: undefined } }, { safeCleanup: false }])
    assert.throws(() => assertReleaseUpgradeRollbackReceipt({ ...evidence, ...change }, identity));
});

test('history rendering is tied to the persisted assistant row, so an echoed user prompt cannot qualify', async () => {
  const messages = [{ info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'DevRyan live QA ready.' }] },
    { info: { id: 'msg_assistant', role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'DevRyan live QA ready.' }] }];
  const observed = [];
  const launch = { request: async route => ({ status: 200, body: route.includes('/message?') ? messages : [{ id: 'ses_release' }] }),
    ui: { click: async () => {}, waitVisibleText: async (text, selector) => observed.push({ text, selector }) } };
  await assertReleaseRetainedSession(launch, { workspace: '/fixture/project' }, 'ses_release');
  assert.deepEqual(observed, [{ text: 'DevRyan live QA ready.', selector: '[data-message-id="msg_assistant"]' }]);
  messages.pop(); await assert.rejects(assertReleaseRetainedSession(launch, { workspace: '/fixture/project' }, 'ses_release'), /Completed fixture response/);
});

test('a phase waits for the cancelled owner to settle before cleanup may begin', async () => {
  const record = { phases: {} }, started = performance.now(); let settled = false;
  await assert.rejects(runReleaseSmokePhase({ receipt: record, clock: { deadline: () => started + 10 }, name: 'chat',
    operation: (_deadline, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      setTimeout(() => { settled = true; reject(signal.reason); }, 5);
    }, { once: true })) }));
  assert.equal(settled, true); assert.equal(record.phases.chat.status, 'failed');
});
test('receipt write/rename failures and deadline expiry never leave a passing JSON or I/O witness', async t => {
  const parent = new URL('../../.cache/release-startup-tests/', import.meta.url); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(new URL('receipt-', parent).pathname); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const failedAt of ['write', 'rename', 'witness', 'observation', 'late-rename', 'late-witness', 'late-observation']) {
    const file = `${root}/${failedAt}.json`, record = receipt(1); delete record.ioWitness;
    let now = 0;
    const io = { ...fs, writeFile: async (target, ...args) => {
      if (failedAt === 'write' || failedAt === 'witness' && target.endsWith('.receipt-io')
        || failedAt === 'observation' && target.endsWith('.receipt-observation')) throw Error('fixture disk failure');
      await fs.writeFile(target, ...args); if (failedAt === 'late-witness' && target.endsWith('.receipt-io')) now = 31;
      if (failedAt === 'late-observation' && target.endsWith('.receipt-observation')) now = 31;
    }, rename: async (...args) => {
      if (failedAt === 'rename') throw Error('fixture rename failure');
      await fs.rename(...args); if (failedAt === 'late-rename') now = 31;
    } };
    await assert.rejects(writeReleaseSmokeReceipt({ receipt: record, receiptPath: file, deadline: 30, clockStarted: 0, limitSeconds: 30, io, now: () => now }));
    assert.equal(record.outcome, 'failed');
    for (const target of [file, `${file}.receipt-io`, `${file}.receipt-observation`]) await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  }
});
test('only a digest-bound post-rename I/O witness can qualify a committed receipt', async t => {
  const parent = new URL('../../.cache/release-startup-tests/', import.meta.url); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(new URL('receipt-ok-', parent).pathname); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = `${root}/receipt.json`, record = receipt(1); delete record.ioWitness;
  await writeReleaseSmokeReceipt({ receipt: record, receiptPath: file, deadline: performance.now() + 30000, clockStarted: performance.now(), limitSeconds: 30 });
  const saved = await readReleaseSmokeReceipt(file); assertReleaseSmokeReceipt(saved, identity);
  const bytes = await fs.readFile(file); assert.equal(saved.ioWitness.receiptSha256, createHash('sha256').update(bytes).digest('hex'));
  const witness = JSON.parse(await fs.readFile(`${file}.receipt-io`, 'utf8')); witness.receiptSha256 = 'f'.repeat(64);
  await fs.writeFile(`${file}.receipt-io`, JSON.stringify(witness));
  await assert.rejects(readReleaseSmokeReceipt(file), /other bytes/);
});
test('settled three-second witness I/O is measured by the external owner and freezes the final receipt budget', async t => {
  const parent = new URL('../../.cache/release-startup-tests/', import.meta.url); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(new URL('receipt-measurement-', parent).pathname); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipts = [];
  for (const sample of [1, 2, 3]) {
    const file = `${root}/receipt-${sample}.json`, record = receipt(sample), started = performance.now();
    const io = sample === 3 ? { ...fs, rename: async (...args) => {
      await fs.rename(...args); await new Promise(resolve => setTimeout(resolve, 2000));
    }, writeFile: async (target, ...args) => {
      await fs.writeFile(target, ...args);
      if (target.endsWith('.receipt-io')) await new Promise(resolve => setTimeout(resolve, 3000));
    } } : fs;
    await writeReleaseSmokeReceipt({ receipt: record, receiptPath: file, deadline: started + 30000, clockStarted: started, limitSeconds: 30, io });
    const saved = await readReleaseSmokeReceipt(file); assertReleaseSmokeReceipt(saved, identity); receipts.push(saved);
  }
  assert.ok(receipts[2].phases.receipt.elapsedMs >= 5000, 'The observed interval must include settled JSON rename and witness I/O');
  assert.equal(receipts[2].ioObservation.clockScope, 'receipt-json-and-digest-witness-io');
  assert.equal(receipts[2].ioObservation.observationCommit, 'bounded-by-receipt-deadline-excluded-from-observation');
  const budget = freezeReleaseSmokeBudget(receipts, identity);
  assert.ok(budget.receipt >= 15, 'Three-second witness I/O cannot disappear into the ten-second minimum');
  const file = `${root}/receipt-3.json`, original = await fs.readFile(`${file}.receipt-observation`);
  await fs.rm(`${file}.receipt-observation`);
  await assert.rejects(readReleaseSmokeReceipt(file), { code: 'ENOENT' });
  const forged = JSON.parse(original); forged.witnessSha256 = '0'.repeat(64);
  await fs.writeFile(`${file}.receipt-observation`, JSON.stringify(forged));
  await assert.rejects(readReleaseSmokeReceipt(file), /another witness/);
});

test('final tag proof is bound to the exact rehearsed installer, extracted app and native manifest', () => {
  const expected = { ...identity, appSha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64) };
  assertReleaseSmokeArtifactIdentity({ ...expected }, expected);
  for (const key of ['sourceCommit', 'version', 'dmgSha256', 'appSha256', 'manifestSha256'])
    assert.throws(() => assertReleaseSmokeArtifactIdentity({ ...expected, [key]: 'changed' }, expected), /exact qualified candidate/);
});

test('qualification ordinals count actual same-gate jobs, not late workflow attempts or skipped samples', () => {
  const current = { ...receipt(0), rehearsal: false, runAttempt: 8 };
  const jobs = [{ id: 71, name: 'final-dmg-smoke', run_attempt: 1, conclusion: 'skipped', runner_id: 71 },
    { id: 72, name: 'final-dmg-smoke', run_attempt: 3, conclusion: 'cancelled', started_at: '2026-10-14T10:00:00Z', runner_id: null, steps: [] },
    { id: 78, name: 'final-dmg-smoke', run_attempt: 8, conclusion: null, runner_id: 78 }];
  admitReleaseSmokeAttempt(current, jobs, []);
  assert.equal(current.qualificationAttempt, 1); assert.equal(current.runnerID, 78); assert.equal(current.runAttempt, 8);
  const failed = { ...current, outcome: 'failed', failureClass: 'pre_app_gui_unavailable', appStarted: false, fixtureAttempts: 0 };
  const retry = { ...current, runAttempt: 11 };
  const retryJobs = [...jobs.map(job => job.id === 78 ? { ...job, conclusion: 'failure' } : job),
    { id: 81, name: 'final-dmg-smoke', run_attempt: 11, conclusion: null, runner_id: 81 }];
  admitReleaseSmokeAttempt(retry, retryJobs, [failed]);
  assert.equal(retry.qualificationAttempt, 2);
  for (const change of [{ runnerID: 81 }, { runnerID: 999 }, { qualificationAttempt: 2 }, { outcome: 'passed' }, { cleanupErrors: ['failed'] }])
    assert.throws(() => admitReleaseSmokeAttempt({ ...retry }, retryJobs, [{ ...failed, ...change }]));
  assert.throws(() => admitReleaseSmokeAttempt({ ...retry }, retryJobs, []), /Every previous qualification/);
  assert.throws(() => admitReleaseSmokeAttempt({ ...retry }, [...retryJobs, { name: 'qualify-release-startup', conclusion: 'failure' }], [failed]), /Complete gate attempt inventory/);
});
test('receipt-only executed GUI failures consume the same finite physical retry budget',()=>{
  const sparseJobs=[1,2,3].map(n=>({id:n,name:'candidate-startup-1',run_attempt:n,conclusion:'failure',runner_id:null,started_at:null,steps:[]}));
  const prior=[1,2,3].map(n=>({...receipt(1),jobID:n,runAttempt:n,qualificationAttempt:n,runnerID:100+n,
    outcome:'failed',failureClass:'pre_app_gui_unavailable',appStarted:false,fixtureAttempts:0}));
  const current=attempt=>({...receipt(1),runAttempt:attempt});
  const job=attempt=>({id:attempt,name:'candidate-startup-1',run_attempt:attempt,conclusion:null,runner_id:100+attempt});
  const third=current(3);admitReleaseSmokeAttempt(third,[...sparseJobs.slice(0,2),job(3)],prior.slice(0,2));
  assert.equal(third.qualificationAttempt,3);
  assert.throws(()=>admitReleaseSmokeAttempt(current(4),[...sparseJobs,job(4)],prior),/two fresh-runner GUI retries/);
  for(const change of [{failureClass:'product_failure'},{safeCleanup:false},{runnerID:103},{runnerID:undefined},{qualificationAttempt:2}])
    assert.throws(()=>admitReleaseSmokeAttempt(current(3),[...sparseJobs.slice(0,2),job(3)],[{...prior[0],...change},prior[1]]));
});

test('corrupt/missing prior witness is unavailable evidence and admission refusal still emits a failed receipt without GUI work', async t => {
  const parent = path.resolve('.cache/test-fixtures'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'release-smoke-admission-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'prior.json'), JSON.stringify(receipt(1)));
  await fs.writeFile(path.join(directory, 'failed.json.partial'), '{"outcome":"failed"}');
  assert.deepEqual(await readReleaseSmokePriorReceipts(directory), []);
  assert.deepEqual(await readReleaseSmokePriorReceipts(path.join(directory, 'missing')), []);
  const cancelled = AbortSignal.abort(Error('setup expired'));
  await assert.rejects(readReleaseSmokePriorReceipts(directory, { signal: cancelled }), /setup expired/);
  await assert.rejects(readReleaseSmokeReceipt(path.join(directory, 'prior.json'), { signal: cancelled }), { name: 'AbortError' });
  const runRoot = path.resolve('.cache/release-startup-smoke');
  await fs.mkdir(runRoot, { recursive: true }); const before = new Set(await fs.readdir(runRoot));
  t.after(async () => {
    for (const name of await fs.readdir(runRoot)) if (!before.has(name)) {
      const run = path.join(runRoot, name);
      const manifest = JSON.parse(await fs.readFile(path.join(run, 'run.json'), 'utf8'));
      assert.equal(manifest.owner, 'release-startup-smoke'); await fs.rm(run, { recursive: true, force: true });
    }
  });
  const file = path.join(directory, 'current.json');
  const result = await runReleaseStartupSmoke({ dmg: path.join(directory, 'missing.dmg'), receiptPath: file,
    metadata: { protocol: 'devryan.release-candidate/1', ...identity }, rehearsal: true, sample: 1, environment: {} });
  assert.equal(result.outcome, 'failed'); assert.equal(result.appStarted, false); assert.equal(result.fixtureAttempts, 0);
  const saved = await readReleaseSmokeReceipt(file);
  assert.equal(saved.outcome, 'failed'); assert.equal(saved.failureClass, 'release_smoke_product_or_evidence_failure');
  assert.throws(() => assertReleaseSmokeReceipt(saved, identity), /passed/);
});

test('malformed CLI admission input retains failed partial evidence and a deterministic nonzero exit before native work', async t => {
  const parent = path.resolve('.cache/test-fixtures'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'release-smoke-input-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const metadata = path.join(directory, 'candidate.json'), file = path.join(directory, 'receipts/final.json');
  await fs.writeFile(metadata, '{broken');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./release-startup-smoke.mjs', import.meta.url)),
    '--dmg', path.join(directory, 'missing.dmg'), '--metadata', metadata, '--receipt', file], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, GITHUB_RUN_ID: '50', GITHUB_RUN_ATTEMPT: '9' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  const failed = JSON.parse(await fs.readFile(`${file}.partial`, 'utf8'));
  assert.equal(failed.outcome, 'failed'); assert.equal(failed.failureClass, 'release_smoke_input_or_receipt_failed');
  assert.equal(failed.appStarted, false); assert.equal(failed.fixtureAttempts, 0);
  assert.equal(failed.runAttempt, 9);
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  assert.equal(JSON.parse(result.stdout).outcome, 'failed');
});
