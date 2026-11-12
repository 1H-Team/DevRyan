// The suites of the full dual run (dual-run-harness.mjs): scenarios, cross-reading,
// the aged-profile corpus, planted differences, crash points, lock contention
// and the coverage report. Each row has an outcome: passed, failed,
// inconclusive (not comparable, never a pass) or info (a characterisation).
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeValue, encodeValue } from './dual-run-codec.mjs';
import { compareRefMoves, createDifferences, refMoves } from './dual-run-compare.mjs';
import { dualRun, freshStage, parkStage, prepareFixture } from './dual-run.mjs';
import { readGitLog } from './dual-run-git-shim.mjs';
import { MUTANTS, buildMutant, catching } from './dual-run-mutants.mjs';
import { Arm, PRODUCT_LIB, QUIET_MAINTENANCE, armEnvironment, replayRecording, shimEnvironment } from './dual-run-runner.mjs';
import { SCENARIOS, copyOf, probeScenario, scenarioNamed } from './dual-run-scenarios.mjs';
import { AGED_MUTATIONS, COVERAGE_NOTES, COVERAGE_SCENARIOS } from './dual-run-scenarios-coverage.mjs';
import { readRepository } from './dual-run-snapshot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SUITES = Object.freeze(['scenarios', 'cross-read', 'aged', 'mutants', 'crash', 'contention']);
export const ALL_SCENARIOS = Object.freeze([...SCENARIOS, ...COVERAGE_SCENARIOS]);
const summarize = (differences, limit = 8) => differences.slice(0, limit).map((difference) => `${difference.category} | ${difference.where} | ${JSON.stringify(difference.detail).slice(0, 300)}`);
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(check, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return true; await wait(stepMs); }
  return false;
}

// ---------------------------------------------------------------- coverage
/** The seam's message types (file 26 §4b), plus the stdio transport's `init`. */
export const MESSAGE_TYPES = Object.freeze(['init', 'ready', 'call', 'abort', 'report', 'progress', 'observe', 'callback', 'callback-result', 'result', 'pull', 'chunk', 'stream-return']);
/**
 * Methods and message types no scenario needs to exercise, each with why.
 * Every method of SESSION_MUTATION_METHODS and every message type must be
 * exercised by the full run or listed here, or the run fails.
 */
export const COVERAGE_WAIVERS = Object.freeze({
  methods: Object.freeze({}),
  // Methods driven only by calls the ledger refuses: their refusals are compared, never a success.
  refusedOnly: Object.freeze({}),
  messages: Object.freeze({
    // The stdio transport's first line (ledger-process.mjs, a native ledger); the worker transport passes workerData instead. Seen by the harness, never logged as a seam message.
    init: 'transport framing of the process implementations, not a seam message: every js-process and native run starts with it, and a ledger that mishandles it never sends `ready`',
  }),
});
const hostMethods = async () => (await import(path.join(PRODUCT_LIB, 'session-mutation-host.js'))).SESSION_MUTATION_METHODS;

function coverageRows({ recordings, methods }) {
  const byMethod = new Map(methods.map((method) => [method, new Set()])), byMessage = new Map(MESSAGE_TYPES.map((type) => [type, new Set()]));
  // Per method, the scenarios where a call that succeeded was replayed and its result and the disk after it compared.
  const compared = new Map(methods.map((method) => [method, new Set()]));
  for (const { name, recording, runs } of recordings) {
    for (const call of Object.values(recording.calls)) {
      byMethod.get(call.method)?.add(name);
      if (call.ok && runs.length) compared.get(call.method)?.add(name);
    }
    for (const generations of [recording.generations, ...runs.map((run) => run.generations)]) {
      for (const generation of generations) for (const { message } of generation.entries) if (message?.type) byMessage.get(message.type)?.add(name);
    }
  }
  return { byMethod, byMessage, compared };
}

export async function coverageReport({ recordings, full }) {
  const methods = await hostMethods();
  const { byMethod, byMessage, compared } = coverageRows({ recordings, methods });
  const rows = [];
  const missing = [];
  for (const [method, scenarios] of byMethod) {
    const waiver = COVERAGE_WAIVERS.methods[method];
    rows.push({ kind: 'method', name: method, scenarios: [...scenarios], compared: [...compared.get(method)], waiver: waiver ?? null, note: COVERAGE_NOTES[method] ?? null });
    if (!scenarios.size && !waiver) missing.push(`method ${method}`);
    else if (scenarios.size && !compared.get(method).size && !COVERAGE_WAIVERS.refusedOnly[method]) missing.push(`method ${method} (called, but never a successful call compared)`);
  }
  for (const [type, scenarios] of byMessage) {
    const waiver = COVERAGE_WAIVERS.messages[type];
    rows.push({ kind: 'message', name: type, scenarios: [...scenarios], waiver: waiver ?? null });
    if (!scenarios.size && !waiver) missing.push(`message ${type}`);
  }
  const exercised = rows.filter((row) => row.scenarios.length);
  const refusedOnly = rows.filter((row) => row.kind === 'method' && row.scenarios.length && !row.compared.length).map((row) => row.name);
  return { rows, missing, full, refusedOnly, summary: `methods ${exercised.filter((row) => row.kind === 'method').length}/${methods.length} called, ${rows.filter((row) => row.kind === 'method' && row.compared.length).length} with a successful call compared${refusedOnly.length ? ` (only called or refused: ${refusedOnly.join(', ')})` : ''}, ${rows.filter((row) => row.kind === 'method' && !row.scenarios.length && row.waiver).length} waived; message types ${exercised.filter((row) => row.kind === 'message').length}/${MESSAGE_TYPES.length} seen, ${rows.filter((row) => row.kind === 'message' && !row.scenarios.length && row.waiver).length} waived` };
}

// ---------------------------------------------------------------- suites
export async function runSuites({ workspace, suites = SUITES, scenarios, implementations, allowInconclusive = [], log = () => {} }) {
  const report = { passed: true, counts: { passed: 0, failed: 0, inconclusive: 0, info: 0 }, suites: {}, startedAt: new Date().toISOString() };
  const parked = new Map();
  const recordings = [];
  const note = (suite, row) => {
    const outcome = row.outcome === 'inconclusive' && allowInconclusive.includes(row.scenario) ? 'inconclusive' : row.outcome;
    (report.suites[suite] ??= []).push({ ...row, outcome, allowed: row.outcome === 'inconclusive' && allowInconclusive.includes(row.scenario) });
    report.counts[outcome] += 1;
    if (outcome === 'failed' || (outcome === 'inconclusive' && !allowInconclusive.includes(row.scenario))) report.passed = false;
    const mark = { passed: 'ok  ', failed: 'FAIL', inconclusive: 'INCONCLUSIVE', info: 'info' }[outcome];
    log(`[${suite}] ${mark} ${row.name}${row.summary ? `: ${row.summary}` : ''}`);
    for (const line of row.differences ?? []) log(`    ${line}`);
  };
  const full = !scenarios && SUITES.every((suite) => suites.includes(suite));
  const selected = (scenarios ?? ALL_SCENARIOS.map((scenario) => scenario.name)).map((name) => scenarioNamed(name, COVERAGE_SCENARIOS));
  const withLib = implementations.map((implementation) => ({ libDir: PRODUCT_LIB, ...implementation }));
  const keep = (name, outcome) => recordings.push({ name, recording: outcome.recording, runs: outcome.outcomes.map((row) => row.run) });

  if (suites.includes('scenarios')) {
    for (const scenario of selected) {
      let outcome;
      let recordings = 0;
      try {
        // The recording's own commit order may be the rare one of a race: a
        // concurrent scenario whose replays never met it is recorded again
        // (at most twice more), and stays inconclusive if that never helps.
        for (;;) {
          recordings += 1;
          outcome = await dualRun({ workspace, scenario, label: recordings > 1 ? `${scenario.name}-r${recordings}` : scenario.name, implementations: withLib });
          if (!scenario.concurrent || recordings >= 3 || !outcome.outcomes.some((row) => row.outcome === 'inconclusive')) break;
        }
      } catch (error) { note('scenarios', { name: scenario.name, scenario: scenario.name, outcome: 'failed', summary: `harness error: ${error.stack ?? error}` }); continue; }
      parked.set(scenario.name, outcome);
      keep(scenario.name, outcome);
      for (const row of outcome.outcomes) {
        note('scenarios', { name: `${scenario.name} / ${row.implementation}`, scenario: scenario.name, outcome: row.outcome,
          summary: `${row.differences.length} differences; record ${outcome.msA} ms, replay ${row.ms} ms; ${Object.keys(outcome.recording.calls).length} calls; payload types ${JSON.stringify(outcome.recording.census)}${scenario.concurrent ? `; commit order (from each run's Git history) ${row.orderMatched ? 'matched' : row.orderMatched === null ? 'NOT A REORDERING' : 'NEVER MATCHED'} after ${row.attempts} replay(s) of recording ${recordings}` : ''}`,
          differences: summarize(row.differences), notes: row.notes });
      }
    }
  }

  if (suites.includes('cross-read')) {
    // Run A's ledger read by each implementation, and each implementation's ledger read by the product.
    const source = parked.get('undo') ?? await dualRun({ workspace, scenario: scenarioNamed('undo'), implementations: withLib });
    const stores = [['A', source.dirA], ...source.outcomes.map((row) => [row.implementation, row.dirB])];
    for (const [writer, dir] of stores) {
      const probe = probeScenario({ name: `cross-read-${writer}`, fixture: copyOf(dir) });
      const outcome = await dualRun({ workspace, scenario: probe, implementations: withLib });
      keep(probe.name, outcome);
      for (const row of outcome.outcomes) note('cross-read', { name: `ledger written by ${writer}, read by product (A) and ${row.implementation}`, outcome: row.outcome,
        summary: `${row.differences.length} differences`, differences: summarize(row.differences), notes: row.notes });
    }
  }

  if (suites.includes('aged')) {
    // The aged-profile corpus, written once by the product's own writers at the stage path, then read back and mutated by each implementation.
    const agedFixture = async (stage) => {
      await new Promise((resolve, reject) => {
        const child = fork(path.join(here, 'aged-writer.mjs'), [stage], { env: armEnvironment(stage, { DEVRYAN_LEDGER_WORKER: '0' }), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`aged writer exited ${code}`))));
      });
    };
    const agedOptions = { buildAtStage: true, storage: 'webdata/harness/session-mutations', options: (stage) => ({ directory: path.join(stage, 'webdata', 'harness', 'session-mutations') }) };
    const read = { ...probeScenario({ name: 'aged-profile', fixture: agedFixture, sessions: ['ses_aged_control', 'ses_aged_claimed'] }), ...agedOptions };
    const outcome = await dualRun({ workspace, scenario: read, implementations: withLib });
    keep('aged-profile', outcome);
    for (const row of outcome.outcomes) note('aged', { name: `aged-profile corpus read back and warmed / ${row.implementation}`, outcome: row.outcome,
      summary: `${row.differences.length} differences, ${Object.keys(outcome.recording.calls).length} calls`, differences: summarize(row.differences), notes: row.notes });
    const mutate = { ...AGED_MUTATIONS, fixture: agedFixture, ...agedOptions };
    const mutated = await dualRun({ workspace, scenario: mutate, implementations: withLib, fixture: outcome.fixture });
    keep(mutate.name, mutated);
    for (const row of mutated.outcomes) note('aged', { name: `aged-profile corpus mutated (${AGED_MUTATIONS.name}) / ${row.implementation}`, outcome: row.outcome,
      summary: `${row.differences.length} differences, ${Object.keys(mutated.recording.calls).length} calls`, differences: summarize(row.differences), notes: row.notes });
  }

  if (suites.includes('mutants')) await mutantSuite({ workspace, note });
  if (suites.includes('crash')) await crashSuite({ workspace, note, withLib });
  if (suites.includes('contention')) await contentionSuite({ workspace, note, withLib });
  report.coverage = await coverageReport({ recordings, full });
  log(`[coverage] ${report.coverage.summary}`);
  for (const row of report.coverage.rows) log(`    ${row.kind} ${row.name}: ${row.scenarios.length ? `${row.kind === 'method' ? `compared on success in ${row.compared.length ? row.compared.join(', ') : 'NONE (only called or refused)'}; called in ` : ''}${row.scenarios.join(', ')}` : `WAIVED: ${row.waiver ?? 'NOT EXERCISED'}`}`);
  if (full && report.coverage.missing.length) {
    note('coverage', { name: 'every method and message type exercised or waived', outcome: 'failed', summary: `not exercised and not waived: ${report.coverage.missing.join(', ')}` });
  } else if (full) note('coverage', { name: 'every method and message type exercised or waived', outcome: 'passed', summary: report.coverage.summary });
  report.finishedAt = new Date().toISOString();
  return report;
}

// ---------------------------------------------------------------- planted differences
/**
 * Each planted difference is replayed twice against its recording: with the
 * identifier protocol (seeded, as a conforming native ledger runs) and
 * without it (the ledger's own random identifiers). It counts as caught only
 * when the finding it names appears; mutants that need the seeded comparison
 * say why.
 */
async function mutantSuite({ workspace, note }) {
  const recordings = new Map();
  for (const mutant of MUTANTS.filter((entry) => entry.scenario !== 'crash')) {
    const libDir = await buildMutant(mutant, workspace.dir);
    const scenario = scenarioNamed(mutant.scenario, COVERAGE_SCENARIOS);
    for (const mode of ['seeded', 'unseeded']) {
      const plantLog = path.join(workspace.dir, `plant-${mutant.name}-${mode}.log`);
      const previous = recordings.get(mutant.scenario);
      const outcome = await dualRun({ workspace, scenario, label: `mutant-${mutant.name}-${mode}`, recording: previous?.recording, dirA: previous?.dirA, fixture: previous?.fixture,
        implementations: [{ name: `${mutant.name}-${mode}`, libDir, endpoint: { kind: 'worker' }, env: { LEDGER_DUAL_RUN_PLANT_LOG: plantLog }, ...(mode === 'unseeded' ? { ids: null } : {}) }] });
      if (!previous) recordings.set(mutant.scenario, { recording: outcome.recording, dirA: outcome.dirA, fixture: outcome.fixture });
      const [row] = outcome.outcomes;
      const reached = existsSync(plantLog);
      const found = catching(mutant, row.differences);
      const exempt = mode === 'unseeded' && mutant.seededOnly;
      note('mutants', { name: `${mutant.name} (${mode}): ${mutant.kind}`, outcome: reached && (found || exempt) ? 'passed' : 'failed',
        summary: `${reached ? 'planted code ran' : 'PLANTED CODE NEVER RAN'}; ${found ? `caught by ${found.category} | ${found.where}` : exempt ? `not caught unseeded, as declared: ${mutant.seededOnly}` : 'NOT CAUGHT by the expected check'} (${row.differences.length} differences)`,
        differences: summarize(found ? [found] : row.differences, 4) });
    }
  }
}

// ---------------------------------------------------------------- crash points
/**
 * Crash points inside one publication (the smoke scenario's `finish`) and a
 * first build (its `begin`). `via: 'shim'` points are made from outside the
 * implementation by the git shim (it kills the process that called
 * `git update-ref`), so they exist for every implementation and the crash is
 * made by each in turn; `via: 'preload'` points are the JavaScript ledger's
 * own file operations (ledger-preload.cjs), made by the stdio-process
 * JavaScript implementation. `reachable: false` names a point not expected to
 * be reached, with why; any other point not reached fails the run.
 */
export const CRASH_POINTS = Object.freeze([
  { label: 'edit:finish', via: 'shim', phase: 'before', nth: 1, why: 'objects written, the intent commit not made' },
  { label: 'edit:finish', via: 'shim', phase: 'after', nth: 1, why: 'intent committed, project file not written (between the two commits)', intent: true },
  { label: 'edit:finish', via: 'shim', phase: 'before', nth: 2, why: 'project written, before the commit that records it', intent: true },
  { label: 'edit:begin', via: 'shim', phase: 'before', nth: 2, why: 'inside the first build (an install batch commit)' },
  { label: 'edit:finish', via: 'preload', point: 'owner-lock:after', nth: 1, why: 'holding the owner lock, nothing written yet' },
  { label: 'edit:finish', via: 'preload', point: 'content-object-link:after', nth: 1, why: 'a content object installed, not yet committed' },
  { label: 'edit:finish', via: 'preload', point: 'git-object-link:after', nth: 1, why: 'tree objects being written, ref not moved' },
  { label: 'edit:finish', via: 'preload', point: 'directory-sync:before', nth: 1, why: 'objects directory sync before the commit that names it' },
  { label: 'edit:finish', via: 'preload', point: 'project-write:after', nth: 1, why: 'project file written, second commit not made', intent: true },
  { label: 'edit:finish', via: 'preload', point: 'metadata-index-removed:after', nth: 1, why: 'persistent index removed before a commit',
    reachable: false, because: 'the store commits through direct tree writes (session-changes-trees.js); the persistent-index path does not run in these scenarios' },
  { label: 'edit:begin', via: 'preload', point: 'project-write:after', nth: 1, why: 'view materialization of the lease' },
]);
const pointName = (spec) => (spec.via === 'shim' ? `update-ref:${spec.phase}#${spec.nth} (git shim)` : `${spec.point}#${spec.nth}`);

async function crashSuite({ workspace, note, withLib }) {
  const scenario = scenarioNamed('smoke');
  const base = await dualRun({ workspace, scenario, label: 'crash-base', implementations: [] });
  const original = await fs.readFile(path.join(base.fixture.template, 'project', 'src/m0/f0.js'), 'utf8');
  const edited = await fs.readFile(path.join(base.dirA, 'project', 'src/m0/f0.js'), 'utf8');
  const planted = MUTANTS.find((mutant) => mutant.name === 'recovery-drops-observation');
  const plantLog = path.join(workspace.dir, 'plant-recovery.log');
  const recovering = [...withLib, { name: planted.name, libDir: await buildMutant(planted, workspace.dir), endpoint: { kind: 'worker' }, planted, env: { LEDGER_DUAL_RUN_PLANT_LOG: plantLog } }];
  const projectOf = async (dir) => fs.readFile(path.join(dir, 'project', 'src/m0/f0.js'), 'utf8').catch(() => null);
  const fsckOf = async (dir) => {
    const storage = path.join(dir, 'ledger');
    const out = [];
    for (const name of await fs.readdir(storage).catch(() => [])) if (existsSync(path.join(storage, name, 'git'))) { const { fsck } = await readRepository(path.join(storage, name, 'git')); if (fsck.code !== 0 || fsck.output) out.push(fsck.output || `exit ${fsck.code}`); }
    return out;
  };
  let index = 0;
  for (const spec of CRASH_POINTS) {
    // Shim points are made by every implementation; preload points by the JavaScript process ledger.
    const producers = spec.via === 'shim' ? withLib : withLib.filter((implementation) => implementation.endpoint.kind === 'process' && !implementation.endpoint.command);
    for (const producer of producers) {
      index += 1;
      const marker = path.join(workspace.dir, `crash-${index}.marker`), armFile = path.join(workspace.dir, `crash-${index}.armed`);
      await fs.rm(marker, { force: true }); await fs.rm(`${marker}.count`, { force: true }); await fs.rm(armFile, { force: true });
      const stage = await freshStage(workspace);
      await base.fixture.place(stage);
      const crash = spec.via === 'preload' ? { point: spec.point, nth: spec.nth, action: 'kill', marker, armFile, label: spec.label } : undefined;
      const shimCrash = spec.via === 'shim' ? { phase: spec.phase, nth: spec.nth, action: 'kill', marker, armFile, label: spec.label } : undefined;
      const crashed = await replayRecording({ stage, recording: base.recording, libDir: producer.libDir, implementation: producer.endpoint, crash, ids: producer.ids,
        shim: { bin: workspace.bin, log: path.join(workspace.dir, 'audit', `crash-${index}.git`), crash: shimCrash } });
      const dir = await parkStage(workspace, `crash-${index}`);
      const reached = existsSync(marker);
      const name = `${spec.label} ${pointName(spec)} made by ${producer.name}`;
      if (!reached) {
        note('crash', { name, outcome: spec.reachable === false ? 'info' : 'failed',
          summary: spec.reachable === false ? `not reached, as expected: ${spec.because}` : `EXPECTED POINT NOT REACHED (${spec.why}); run completed: ${!crashed.crashed}` });
        continue;
      }
      if (spec.reachable === false) note('crash', { name, outcome: 'info', summary: `reached although listed as unreachable (${spec.because}): update the list` });
      // Recovery: the product (record mode) and each implementation open the crashed ledger.
      const probe = probeScenario({ name: `recover-${index}`, fixture: copyOf(dir), sessions: ['s1'] });
      await fs.rm(plantLog, { force: true });
      const outcome = await dualRun({ workspace, scenario: probe, label: `recover-${index}`, implementations: recovering });
      const stages = [['product (A)', outcome.dirA], ...outcome.outcomes.map((row) => [row.implementation, row.dirB])];
      // Atomicity and fsck of every recovering run's own stage.
      const own = new Map();
      for (const [who, stageDir] of stages) {
        const after = await projectOf(stageDir);
        own.set(who, { atomic: after === original || after === edited, after, fsck: await fsckOf(stageDir) });
      }
      for (const row of outcome.outcomes) {
        const mine = own.get(row.implementation), product = own.get('product (A)');
        const ok = mine.atomic && product.atomic && !mine.fsck.length && !product.fsck.length;
        const implementation = recovering.find((entry) => entry.name === row.implementation);
        let outcomeName, extra = '';
        if (implementation.planted) {
          // The planted recovery fault shows only where a materialization intent was left to recover, and must be named by its own check.
          const found = catching(implementation.planted, row.differences);
          const ran = existsSync(plantLog);
          if (spec.intent) { outcomeName = ok && ran && found ? 'passed' : 'failed'; extra = ` (planted: ${ran ? 'ran' : 'NEVER RAN'}, ${found ? `caught by ${found.category} | ${found.where}` : 'NOT CAUGHT by the expected check'})`; }
          else { outcomeName = ok && row.differences.length === 0 ? 'passed' : 'failed'; extra = ' (planted; nothing to recover here)'; }
        } else outcomeName = ok && row.outcome === 'passed' ? 'passed' : 'failed';
        note('crash', { name: `${name} (${spec.why}), recovered by ${row.implementation}`, outcome: outcomeName,
          summary: `project file after its recovery ${mine.after === edited ? 'has the edit' : mine.after === original ? 'is unchanged' : 'IS NEITHER BEFORE NOR AFTER'}; fsck ${mine.fsck.length ? mine.fsck.join('; ') : 'clean'}; ${row.differences.length} differences${extra}`,
          differences: summarize(row.differences, implementation.planted ? 2 : 8) });
      }
    }
  }
}

// ---------------------------------------------------------------- contention
async function contentionSuite({ workspace, note, withLib }) {
  const scenario = scenarioNamed('smoke');
  const fixture = await prepareFixture(workspace, scenario, 'contention');
  const options = (stage) => ({ directory: path.join(stage, 'ledger'), maintenance: QUIET_MAINTENANCE });
  const workerData = (stage) => ({ directory: path.join(stage, 'ledger'), maintenance: QUIET_MAINTENANCE, observers: { onChange: true, onMaterialize: true, onDiagnostic: true, onLockTiming: true, onWorkerStall: false } });
  const input = (stage, session, user) => ({ directory: path.join(stage, 'project'), sessionID: session, userMessageID: user, messageID: `${user}-assistant`, callID: `call-${user}` });
  // A party is a product host (record arm) or an implementation behind the replay arm's host side; both make live calls.
  const party = async (stage, who, { log, crash } = {}) => {
    const env = shimEnvironment({ bin: workspace.bin, log, crash });
    if (who === 'product') return { name: 'product', arm: await Arm.start({ stage, mode: 'record', options: options(stage), ids: null, env }), live: (arm, label, method, args) => arm.call(label, method, encodeValue([args])) };
    const arm = await Arm.start({ stage, mode: 'replay', libDir: who.libDir, implementation: who.endpoint, workerData: workerData(stage), env });
    return { name: who.name, arm, live: (target, label, method, args) => target.invoke(label, method, encodeValue([args])) };
  };
  const call = async (side, label, method, args) => { const started = Date.now(); const reply = await side.live(side.arm, label, method, args); return { ...reply, ms: Date.now() - started }; };
  const lockFile = async (stage) => {
    const storage = path.join(stage, 'ledger');
    for (const name of await fs.readdir(storage).catch(() => [])) { const text = await fs.readFile(path.join(storage, name, 'owner.lock'), 'utf8').catch(() => null); if (text) return JSON.parse(text); }
    return null;
  };
  const fsckOf = async (stage) => {
    const storage = path.join(stage, 'ledger');
    const results = [];
    for (const name of await fs.readdir(storage).catch(() => [])) if (existsSync(path.join(storage, name, 'git'))) results.push((await readRepository(path.join(storage, name, 'git'))).fsck);
    return results;
  };
  const edit = async (side, stage, session, user) => {
    await call(side, `${user}:prompt`, 'registerPrompt', { directory: path.join(stage, 'project'), sessionID: session, userMessageID: user });
    const begun = await call(side, `${user}:begin`, 'begin', input(stage, session, user));
    if (!begun.ok) return { begun };
    const lease = decodeValue(begun.value);
    await call(side, `${user}:claim`, 'claimLease', { directory: path.join(stage, 'project'), token: lease.token, kind: 'process' });
    await fs.appendFile(path.join(lease.workingDirectory, 'src/m0/f0.js'), `// ${session}\n`);
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory), 'termination.json'), JSON.stringify({ terminated: true, confined: true, exitCode: 0, cancelled: false }), { flag: 'wx', mode: 0o600 });
    const finished = await call(side, `${user}:finish`, 'finish', { directory: path.join(stage, 'project'), token: lease.token });
    return { begun, finished };
  };
  // The git shim's lock oracle over every process that moved the state ref in this stage.
  const lockOracle = (log, stage) => {
    const differences = createDifferences();
    const moves = refMoves(readGitLog(log), path.join(stage, 'ledger'));
    compareRefMoves({ movesA: moves, movesB: {}, a: { ledgers: {} }, b: { ledgers: {} }, identities: null, maskers: null, differences, objectPairs: new Map() });
    const pids = new Set(Object.values(moves).flatMap((root) => root.state.map((move) => move.pid)));
    return { bad: differences.list.filter((difference) => difference.category === 'lock'), moves: Object.values(moves).reduce((sum, root) => sum + root.state.length, 0), pids: pids.size };
  };

  // 1. Two ledgers on one project, edits issued together: two product hosts, then the product and each implementation.
  const pairs = [['product', 'product'], ...withLib.map((implementation) => ['product', implementation])];
  for (const [index, [left, right]] of pairs.entries()) {
    const stage = await freshStage(workspace);
    await fixture.place(stage);
    const log = path.join(workspace.dir, 'audit', `contention-1-${index}.git`);
    const sides = await Promise.all([left, right].map((who) => party(stage, who, { log })));
    const title = `${sides[0].name} and ${sides[1].name} edit one project at once`;
    try {
      const started = Date.now();
      const results = await Promise.all(sides.map((side, at) => edit(side, stage, `s${at + 1}`, `u${at + 1}`)));
      const ms = Date.now() - started;
      const text = await fs.readFile(path.join(stage, 'project', 'src/m0/f0.js'), 'utf8');
      const both = text.includes('// s1') && text.includes('// s2');
      const fsck = await fsckOf(stage);
      const ok = results.every((result) => result.begun.ok && result.finished?.ok);
      const oracle = lockOracle(log, stage);
      note('contention', { name: title, outcome: ok && both && fsck.every((result) => result.code === 0 && !result.output) && !oracle.bad.length && oracle.pids === 2 ? 'passed' : 'failed',
        summary: `both published: ${ok}; project has both edits: ${both}; ${ms} ms; ${oracle.moves} state-ref moves by ${oracle.pids} processes, ${oracle.bad.length ? `NOT ALL UNDER THE MOVER'S LOCK: ${oracle.bad.map((difference) => difference.detail).join('; ')}` : 'each under owner.lock held by its mover (git shim)'}; fsck ${fsck.map((result) => result.code).join(',')}`,
        differences: results.flatMap((result) => [result.begun, result.finished]).filter((reply) => reply && !reply.ok).map((reply) => JSON.stringify(reply.error).slice(0, 200)) });
    } finally { await Promise.all(sides.map((side) => side.arm.close())); }
    await parkStage(workspace, `contention-1-${index}`);
  }

  // 2. A holder stopped from outside inside owner.lock (the git shim holds its first state-ref move), then killed: the survivor waits while it lives, then reclaims the dead owner's lock.
  const holds = [['product', 'product'], ...withLib.flatMap((implementation) => [[implementation, 'product'], ['product', implementation]])];
  for (const [index, [holderWho, survivorWho]] of holds.entries()) {
    const stage = await freshStage(workspace);
    await fixture.place(stage);
    const marker = path.join(workspace.dir, `contention-hold-${index}.marker`), armFile = path.join(workspace.dir, `contention-hold-${index}.armed`);
    const log = path.join(workspace.dir, 'audit', `contention-2-${index}.git`);
    const holder = await party(stage, holderWho, { log, crash: { phase: 'before', nth: 1, action: 'hold', marker, armFile } });
    const survivor = await party(stage, survivorWho, { log });
    const title = `holder ${holder.name} stopped inside owner.lock and killed (SIGKILL of its ledger process); survivor ${survivor.name}`;
    try {
      await call(survivor, 'warm', 'warm', { directory: path.join(stage, 'project') });
      await fs.writeFile(armFile, 'armed\n');
      const held = call(holder, 'held', 'begin', input(stage, 's1', 'u1')).catch((error) => ({ ok: false, error: { message: error.message } }));
      const holding = await until(() => existsSync(marker), 120_000);
      const owner = await lockFile(stage);
      const issued = Date.now();
      const waiting = call(survivor, 'survivor', 'begin', input(stage, 's2', 'u2'));
      await wait(3_000);
      const stillWaiting = await Promise.race([waiting.then(() => false), wait(0).then(() => true)]);
      const killedAt = Date.now();
      // The ledger's own process: the arm for a worker-thread ledger, the child for a process ledger.
      const victim = holder.arm.ledgerPid;
      try { process.kill(victim, 'SIGKILL'); } catch { /* gone */ }
      const result = await waiting;
      const done = Date.now();
      await held;
      const namedHolder = owner?.pid === victim;
      note('contention', { name: title, outcome: holding && namedHolder && stillWaiting && result.ok ? 'passed' : 'failed',
        summary: `lock named pid ${owner?.pid} (holder's ledger process ${victim}${namedHolder ? '' : ', NOT THE HOLDER'}); survivor ${stillWaiting ? 'still waiting' : 'DID NOT WAIT'} after ${killedAt - issued} ms while the holder lived, then finished ${done - killedAt} ms after the kill: ${result.ok ? 'published' : `failed ${JSON.stringify(result.error)}`}` });
    } finally { await holder.arm.kill(); await survivor.arm.close(); }
    await parkStage(workspace, `contention-2-${index}`);
  }

  // 3. File 26 §8.1: the ledger's worker thread dies while holding owner.lock; its host process lives on (the product's own worker host, characterisation).
  {
    const stage = await freshStage(workspace);
    await fixture.place(stage);
    const marker = path.join(workspace.dir, 'contention-thread.marker'), armFile = path.join(workspace.dir, 'contention-thread.armed');
    const host = await Arm.start({ stage, mode: 'record', options: options(stage), ids: null, crash: { point: 'owner-lock:after', nth: 1, action: 'exit-thread', marker, armFile } });
    const rows = [];
    const recordCall = async (label, method, args) => { const started = Date.now(); const reply = await host.call(label, method, encodeValue([args])); return { ...reply, ms: Date.now() - started }; };
    try {
      await recordCall('warm', 'warm', { directory: path.join(stage, 'project') });
      await fs.writeFile(armFile, 'armed\n');
      const first = await recordCall('dies', 'begin', input(stage, 's1', 'u1'));
      const owner = await lockFile(stage);
      rows.push(`call during which the worker died: ${first.ok ? 'ok' : first.error?.code} after ${first.ms} ms; owner.lock left naming pid ${owner?.pid} (host process ${host.pid}, alive)`);
      for (const user of ['u2', 'u3']) {
        const next = await recordCall(`after-${user}`, 'begin', input(stage, 's1', user));
        rows.push(`next call in the same host (new worker): ${next.ok ? 'ok' : `${next.error?.code} (${next.error?.message}${next.error?.cause ? `, cause ${next.error.cause.code}` : ''})`} after ${next.ms} ms`);
      }
      const stillThere = await lockFile(stage);
      rows.push(`owner.lock still present: ${Boolean(stillThere)}${stillThere ? ` (pid ${stillThere.pid})` : ''}`);
    } finally { await host.close(); }
    const restarted = await Arm.start({ stage, mode: 'record', options: options(stage), ids: null });
    try {
      const started = Date.now();
      const after = await restarted.call('after-restart', 'begin', encodeValue([input(stage, 's1', 'u4')]));
      rows.push(`after the host process exits, a new process: ${after.ok ? 'ok' : after.error?.code} after ${Date.now() - started} ms`);
    } finally { await restarted.close(); }
    const reproduced = rows.some((row) => /LOCK_TIMEOUT|local_execution_timeout/.test(row));
    note('contention', { name: 'ledger worker thread dies holding owner.lock, host process lives (file 26 §8.1, characterisation)', outcome: 'info',
      summary: `${reproduced ? 'REPRODUCED' : 'not reproduced'}: ${rows.join('; ')}` });
    await parkStage(workspace, 'contention-3');
  }
}
