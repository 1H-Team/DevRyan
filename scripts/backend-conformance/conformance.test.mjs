// Self-test of the backend route-group conformance harness (docs/TESTING.md,
// "Backend route-group conformance harness"): BH0 (the run root, the
// isolation refusal, outcomes, waivers, exit codes and the report) and BH1
// (the composition detectors on synthetic compositions, the group host and
// the tap on toy registrars whose every write is known, the edge probes).
//
// What it does not do, on purpose: read the server's composition files or run
// the product route census (the second test file of this folder does that
// with relative assertions, and every harness run checks the real files). So an
// edit to the server's composition neither selects nor fails this test.
//
// Nothing here waits on a timer: work that must stay pending waits on a gate or
// a long timer that a later request opens or clears, and every wait for an
// event is bounded (each test has a deadline, each control call a timeout).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, OUTCOMES, judgeRun, lastLine, reportLines, validateRows } from './outcomes.mjs';
import { RunRefused, createBackendRun, sweepKilledRuns } from './run-scratch.mjs';
import { parseArguments } from './conformance-run.mjs';
import { SERVER_ROOT, importFromServer } from './edge.mjs';
import { checkSpan, declarationsOf, draftTable, spanOf } from './composition.mjs';
import { layerStackProblems, reachProblems } from './reach.mjs';
import { EDGE_PROBES, edgeProbeProblems, rawRequest } from './edge-probes.mjs';
import { readTapRecords, startGroupHost, stopAllHosts, tapSetupFor } from './host-launch.mjs';
import { onceFinished } from './child-finish.mjs';
import { GROUPS } from './groups.mjs';
import { GROUPS as TOY_GROUPS } from './toy/toy-groups.mjs';
import { harmlessnessVerdict, learnVaryingSpans, maskVaryingSpans, parseVitestJunit } from './harmlessness-judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '../..');
const ISOLATION_PRELOAD = pathToFileURL(path.join(REPOSITORY_ROOT, 'scripts/test-isolation-preload.mjs')).href;
const TOY_TABLE = path.join(HERE, 'toy/toy-groups.mjs');
const decode = (base64) => Buffer.from(base64 ?? '', 'base64').toString('utf8');
// Every test has a deadline: a regression fails instead of hanging the suite.
const DEADLINE = { timeout: 120_000 };

/** A run root for one test, finished by the test's outcome (and removed if the test process is interrupted). */
const runFor = (t) => {
  const run = createBackendRun({ owner: 'backend-conformance-selftest' });
  let status = 'failed';
  t.after(() => { try { run.finish(status); } catch { /* a test that swapped its own root cleans up itself */ } });
  return { run, pass: () => { status = 'passed'; } };
};

/** Runs a child to its exit (killed after `timeoutMs`); `onLine` sees each stdout line (it may signal the child). */
const runChild = (args, { env = process.env, onLine = () => {}, timeoutMs = 90_000 } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: REPOSITORY_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let pending = '';
  const timer = setTimeout(() => { stderr += `\n(killed after ${timeoutMs} ms)`; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); onLine(line, child); }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  onceFinished(child, (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
});
/** Waits (bounded) until `pid` no longer exists. */
const processGone = async (pid, timeoutMs = 30_000) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
    if (Date.now() > until) return false;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
};

describe('backend conformance self-test', { concurrency: true, ...DEADLINE }, () => {
// Whatever a failed test left running is stopped, so the file always ends.
after(() => stopAllHosts());
// ------------------------------------------------------------------ BH0: outcomes
test('every outcome reaches its exit code, and the last line prints every count', DEADLINE, () => {
  const one = (outcome) => judgeRun({ rows: [{ id: `row-${outcome}`, outcome }] });
  assert.equal(one('passed').exit, EXIT.passed);
  assert.equal(one('failed').exit, EXIT.failed);
  for (const outcome of ['inconclusive', 'unstable', 'unrecordable']) assert.equal(one(outcome).exit, EXIT.incomplete, outcome);
  const mixed = judgeRun({ rows: OUTCOMES.map((outcome) => ({ id: outcome, outcome })) });
  assert.equal(mixed.exit, EXIT.failed);
  const line = lastLine(mixed);
  for (const words of ['5 rows', '1 passed', '1 failed', '1 inconclusive', '1 unstable', '1 unrecordable', '0 waived by 0 waivers', '0 census gaps', 'exit 1']) assert.ok(line.includes(words), `${words} in ${line}`);
  assert.equal(reportLines(mixed).at(-1), line);
  assert.throws(() => validateRows([{ id: 'a', outcome: 'passed' }, { id: 'a', outcome: 'passed' }]), /twice/);
  assert.throws(() => validateRows([{ id: 'a', outcome: 'ok' }]), /unknown outcome/);
  // A passed row carries no differences (a comparer that reports and still passes is a harness defect).
  assert.throws(() => validateRows([{ id: 'a', outcome: 'passed', differences: ['body'] }]), /passed with 1 differences/);
  assert.doesNotThrow(() => validateRows([{ id: 'a', outcome: 'failed', differences: ['body'] }]));
});

test('zero rows, only waived rows, census gaps and waivers that waive nothing never exit 0', DEADLINE, () => {
  assert.deepEqual([judgeRun({ rows: [] }).exit, judgeRun({ rows: [] }).verdict], [EXIT.incomplete, 'NOTHING RECORDED']);
  const waiver = { outcome: 'unrecordable', reason: 'the reference is not linearisable here' };
  const onlyWaived = judgeRun({ rows: [{ id: 'r', outcome: 'unrecordable' }], waivers: { r: waiver } });
  assert.deepEqual([onlyWaived.exit, onlyWaived.verdict, onlyWaived.counts.waived], [EXIT.incomplete, 'NOTHING JUDGED', 1]);
  const waived = judgeRun({ rows: [{ id: 'p', outcome: 'passed' }, { id: 'r', outcome: 'unrecordable' }], waivers: { r: waiver } });
  assert.equal(waived.exit, EXIT.passed);
  assert.match(reportLines(waived).join('\n'), /UNRECORDABLE r \(waived: the reference is not linearisable here\)/);
  const cases = [
    [{ p: { outcome: 'inconclusive', reason: 'a reason long enough' } }, /waives nothing: the row passed/],
    [{ ghost: { outcome: 'inconclusive', reason: 'a reason long enough' } }, /waives nothing: no such row/],
    [{ r: { outcome: 'unstable', reason: 'a reason long enough' } }, /covers unstable, but the row is unrecordable/],
    [{ r: { outcome: 'unrecordable', reason: '' } }, /has no reason/],
    [{ r: { outcome: 'unrecordable', reason: 'short' } }, /has no reason/],
    [{ r: { outcome: 'passed', reason: 'a reason long enough' } }, /only inconclusive, unstable, unrecordable can be waived/],
  ];
  for (const [waivers, problem] of cases) {
    const judged = judgeRun({ rows: [{ id: 'p', outcome: 'passed' }, { id: 'r', outcome: 'unrecordable' }], waivers });
    assert.equal(judged.exit, EXIT.incomplete, String(problem));
    assert.ok(judged.problems.some((entry) => problem.test(entry)), `${problem} in ${judged.problems}`);
  }
  const failure = judgeRun({ rows: [{ id: 'f', outcome: 'failed' }], waivers: { f: { outcome: 'inconclusive', reason: 'cannot waive this one' } } });
  assert.equal(failure.exit, EXIT.failed);
  assert.ok(failure.problems.some((entry) => /cannot waive a failure/.test(entry)));
  const gap = judgeRun({ rows: [{ id: 'p', outcome: 'passed' }], gaps: ['route GET /x never exercised'] });
  assert.deepEqual([gap.exit, gap.problems], [EXIT.incomplete, ['census gap: route GET /x never exercised']]);
});

// ------------------------------------------------------------------ BH0: the run, end to end
// Children run the run module with a composition check of their own (the CLI's real one reads the server's files).
// After runMain returns (before the process exits) the child says whether the run root is still there:
// a run finishes its root itself, it never leaves that to the exit hook.
const CHILD_RUN = (rows, { extra = '', drift = [] } = {}) => `
import { existsSync } from 'node:fs';
import { runMain } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'conformance-run.mjs')).href)};
let runDir = null;
process.exitCode = await runMain({ argv: process.argv.slice(1), checkComposition: async ({ run }) => { runDir = run.dir; console.log('RUNDIR ' + run.dir); return ${JSON.stringify(drift)}; },
  produceRows: async ({ run }) => { console.log('ROWS'); ${extra} return { rows: ${JSON.stringify(rows)}, waivers: {} }; } });
if (runDir) console.log('ROOT AFTER RUN ' + (existsSync(runDir) ? 'present' : 'removed'));
`;
const childArgs = (source, argv = ['--group=magic-prompts']) => [`--import=${ISOLATION_PRELOAD}`, '--input-type=module', '-e', source, '--', ...argv];
const runDirOf = (stdout) => /^RUNDIR (.+)$/m.exec(stdout)?.[1];

test('a run exits by its rows, judges nothing on composition drift, removes its root, and keeps it only when asked', DEADLINE, async (t) => {
  const outcomes = [['passed', 0], ['failed', 1], ['unstable', 2], ['unrecordable', 2]];
  const [results, empty, kept, allowed, allowedOther, refused, drifted] = await Promise.all([
    Promise.all(outcomes.map(([outcome]) => runChild(childArgs(CHILD_RUN([{ id: `row-${outcome}`, outcome }]))))),
    runChild(childArgs(CHILD_RUN([]))),
    runChild(childArgs(CHILD_RUN([{ id: 'kept', outcome: 'passed' }]), ['--group=magic-prompts', '--keep-artifacts'])),
    runChild(childArgs(CHILD_RUN([{ id: 'p', outcome: 'passed' }, { id: 'i', outcome: 'inconclusive' }]), ['--group=magic-prompts', '--allow-inconclusive=i'])),
    // --allow-inconclusive waives an inconclusive row only, never an unstable or unrecordable one.
    runChild(childArgs(CHILD_RUN([{ id: 'p', outcome: 'passed' }, { id: 'u', outcome: 'unstable' }, { id: 'r', outcome: 'unrecordable' }]), ['--group=magic-prompts', '--allow-inconclusive=u,r'])),
    runChild(childArgs(CHILD_RUN([{ id: 'x', outcome: 'passed' }]), ['--group=magic-prompts', '--frobnicate'])),
    runChild(childArgs(CHILD_RUN([{ id: 'p', outcome: 'passed' }], { drift: ['unclassified: fixture.js:3 app.param(...)'] }))),
  ]);
  // The kept root is the test's to remove, whatever fails first.
  const keptDir = runDirOf(kept.stdout);
  t.after(() => { if (keptDir) fs.rmSync(keptDir, { recursive: true, force: true }); });
  outcomes.forEach(([outcome, exit], index) => {
    const result = results[index];
    assert.equal(result.code, exit, `${outcome}: ${result.stdout}${result.stderr}`);
    const dir = runDirOf(result.stdout);
    assert.ok(dir && !fs.existsSync(dir), `${outcome}: the run root ${dir} was removed`);
    assert.match(result.stdout, /^ROOT AFTER RUN removed$/m, `${outcome}: the run removed its root itself, before the process exit`);
    assert.match(result.stdout.trim().split('\n').filter((line) => !line.startsWith('ROOT AFTER RUN')).at(-1), new RegExp(`exit ${exit}$`), 'the report\'s last line');
  });
  // An unrecordable row is judged, never dropped: it is on the report and counted.
  assert.match(results[3].stdout, /UNRECORDABLE row-unrecordable/);
  assert.match(results[3].stdout, /1 unrecordable/);
  assert.equal(empty.code, EXIT.incomplete);
  assert.match(empty.stdout, /NOTHING RECORDED \(0 rows/);
  assert.equal(kept.code, 0);
  assert.match(kept.stdout, /^ROOT AFTER RUN present$/m);
  assert.ok(fs.existsSync(path.join(keptDir, 'report.json')), 'kept with --keep-artifacts');
  assert.equal(JSON.parse(fs.readFileSync(path.join(keptDir, 'report.json'), 'utf8')).exit, 0);
  assert.equal(allowed.code, 0);
  assert.match(allowed.stdout, /INCONCLUSIVE i \(waived: \(allowed\) by --allow-inconclusive/);
  assert.equal(allowedOther.code, EXIT.incomplete, allowedOther.stdout);
  assert.match(allowedOther.stdout, /waiver u covers inconclusive, but the row is unstable/);
  assert.match(allowedOther.stdout, /waiver r covers inconclusive, but the row is unrecordable/);
  assert.equal(refused.code, EXIT.refused, refused.stderr);
  assert.equal(runDirOf(refused.stdout), undefined, 'a usage error writes nothing');
  // Composition drift: inconclusive, the statement named, no row produced, the root removed.
  assert.equal(drifted.code, EXIT.incomplete, drifted.stdout);
  assert.match(drifted.stdout, /^DRIFT unclassified: fixture\.js:3 app\.param/m);
  assert.match(drifted.stdout, /COMPOSITION DRIFT \(0 rows/);
  assert.match(drifted.stdout, /^ROOT AFTER RUN removed$/m);
  assert.doesNotMatch(drifted.stdout, /^ROWS$/m);
  assert.ok(!fs.existsSync(runDirOf(drifted.stdout)));
  for (const argv of [['--group=nope'], ['--group=magic-prompts', '--frobnicate'], [], ['--group=magic-prompts', '--group=magic-prompts']]) assert.ok(parseArguments(argv).error, String(argv));
  assert.deepEqual(parseArguments(['--group=magic-prompts', '--allow-inconclusive=a,b']).options, { allowInconclusive: ['a', 'b'], keepArtifacts: false, group: 'magic-prompts' });
});

test('SIGTERM, SIGINT and SIGHUP remove the run root; after SIGKILL the next run removes it', DEADLINE, async () => {
  await Promise.all([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]].map(async ([signal, code]) => {
    let dir;
    let existed = false;
    const result = await runChild(childArgs(CHILD_RUN([], { extra: 'process.stdin.resume(); await new Promise(() => {});' })), {
      onLine: (line, child) => { const match = /^RUNDIR (.+)$/.exec(line); if (match) { dir = match[1]; existed = fs.existsSync(dir); } if (line === 'ROWS') child.kill(signal); },
    });
    assert.equal(result.code, code, `${signal}: ${result.stderr}`);
    assert.ok(existed && !fs.existsSync(dir), `${signal}: the root existed while running and is removed`);
  }));
  let dir;
  const killed = await runChild(childArgs(CHILD_RUN([], { extra: 'process.stdin.resume(); await new Promise(() => {});' })), {
    onLine: (line, child) => { const match = /^RUNDIR (.+)$/.exec(line); if (match) dir = match[1]; if (line === 'ROWS') child.kill('SIGKILL'); },
  });
  assert.equal(killed.signal, 'SIGKILL');
  assert.ok(fs.existsSync(dir), 'SIGKILL cannot clean up');
  assert.deepEqual(sweepKilledRuns(path.dirname(dir)).filter((entry) => entry === dir), [dir], 'the next run removes a killed run');
  assert.ok(!fs.existsSync(dir));
});

test('a group host does not outlive its launcher, whatever kills the launcher', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const launcher = (signal) => `
import { createBackendRun } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'run-scratch.mjs')).href)};
import { startGroupHost } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'host-launch.mjs')).href)};
import { GROUPS } from ${JSON.stringify(pathToFileURL(TOY_TABLE).href)};
const run = createBackendRun({ owner: 'backend-conformance-selftest-launcher', parent: ${JSON.stringify(run.dir)} + '/' + ${JSON.stringify(signal)} });
const host = await startGroupHost({ run, name: 'toy-bare', group: GROUPS['toy-bare'], label: 'bare', table: ${JSON.stringify(TOY_TABLE)} });
console.log('HOST ' + host.child.pid + ' ' + run.dir);
await new Promise(() => {});
`;
  // A host that is not ready in time is killed, not left running.
  const late = await startGroupHost({ run, name: 'toy-bare', group: TOY_GROUPS['toy-bare'], label: 'not-ready', table: TOY_TABLE, limits: { readyMs: 1, controlMs: 1_000, stopMs: 1_000 } }).then(() => null, (error) => error);
  assert.match(late?.message ?? '', /not ready within 1 ms/);
  assert.ok(await processGone(late.pid), `the host ${late.pid} that was not ready was killed`);
  // The launcher alive and its pipe closed: the host stops by its stdin alone (the parent-process watch cannot see this).
  // A hung host (SIGSTOP): a control call rejects at its bound, and stop() kills it.
  const [piped, hung] = await Promise.all(['stdin-closed', 'hung'].map((label) => startGroupHost({ run, name: 'toy-bare', group: TOY_GROUPS['toy-bare'], label, table: TOY_TABLE, limits: { readyMs: 120_000, controlMs: 300, stopMs: 300 } })));
  piped.child.stdin.end();
  const closed = await Promise.race([piped.exit, new Promise((resolve) => { setTimeout(() => resolve(null), 10_000).unref(); })]);
  assert.equal(closed?.code, 0, 'a host whose stdin closed stops by itself');
  process.kill(hung.child.pid, 'SIGSTOP');
  const askedAt = Date.now();
  t.after(() => { try { hung.child.kill('SIGKILL'); } catch { /* gone */ } });
  const unbounded = new Promise((_resolve, reject) => { setTimeout(() => reject(new Error('the control call neither answered nor timed out within 10 s')), 10_000).unref(); });
  await assert.rejects(Promise.race([hung.control('/status'), unbounded]), (error) => error.name === 'TimeoutError', 'a control call to a hung host is bounded');
  assert.ok(Date.now() - askedAt < 10_000, 'within its bound');
  assert.equal((await hung.stop()).signal, 'SIGKILL', 'a hung host is killed');
  const outcomes = await Promise.all(['SIGKILL', 'SIGHUP'].map(async (signal) => {
    fs.mkdirSync(path.join(run.dir, signal), { mode: 0o700 });
    let hostPid = null;
    let dir = null;
    const result = await runChild([`--import=${ISOLATION_PRELOAD}`, '--input-type=module', '-e', launcher(signal)], {
      onLine: (line, child) => { const match = /^HOST (\d+) (.+)$/.exec(line); if (match) { hostPid = Number(match[1]); dir = match[2]; child.kill(signal); } },
    });
    return { signal, result, hostPid, dir, gone: hostPid ? await processGone(hostPid) : false };
  }));
  for (const { signal, result, hostPid, gone, dir } of outcomes) {
    assert.ok(hostPid, `${signal}: the host started (${result.stderr})`);
    assert.ok(gone, `${signal}: the host ${hostPid} stopped when its launcher died`);
    if (signal === 'SIGHUP') { assert.equal(result.code, 129); assert.ok(!fs.existsSync(dir), 'SIGHUP removes the run root'); }
    else { assert.equal(result.signal, 'SIGKILL'); assert.deepEqual(sweepKilledRuns(path.dirname(dir)), [dir]); }
  }
  pass();
});

test('outside the isolation guard a run and a host refuse with 64 and write nothing', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const tmp = run.makeDirectory('foreign-tmp');
  const env = { ...process.env, TMPDIR: tmp };
  delete env.DEVRYAN_TEST_ISOLATION_ROOT;
  const [cli, host] = await Promise.all([
    runChild(['--input-type=module', '-e', CHILD_RUN([{ id: 'p', outcome: 'passed' }]), '--', '--group=magic-prompts'], { env }),
    runChild([path.join(HERE, 'group-host.mjs'), '--group=magic-prompts', `--data-root=${tmp}`], { env }),
  ]);
  assert.equal(cli.code, EXIT.refused, cli.stderr);
  assert.match(cli.stderr, /refusing to run outside the test isolation guard/);
  assert.equal(host.code, EXIT.refused, host.stderr);
  assert.deepEqual(fs.readdirSync(tmp), [], 'nothing was written under the temp dir');
  assert.throws(() => createBackendRun({ env, signals: false }), RunRefused);
  pass();
});

test('a symbolic link at the run root, or a link or directory swapped in after the check, is refused', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const real = run.makeDirectory('real-parent');
  const link = path.join(run.dir, 'linked-parent');
  fs.symlinkSync(real, link);
  assert.throws(() => createBackendRun({ parent: link, signals: false }), /symbolic link/);
  const open = run.makeDirectory('open-parent');
  fs.chmodSync(open, 0o755);
  assert.throws(() => createBackendRun({ parent: open, signals: false }), /not private/);
  assert.deepEqual(fs.readdirSync(real), [], 'nothing was created through the link');

  const parent = run.makeDirectory('private-parent');
  for (const swap of ['link', 'directory']) {
    const inner = createBackendRun({ parent, signals: false });
    inner.writeFile('before.txt', 'checked');
    assert.throws(() => inner.writeFile('before.txt', 'again'), /EEXIST/);
    fs.symlinkSync(real, path.join(inner.dir, 'sub'));
    assert.throws(() => inner.writeFile('sub/escape.txt', 'x'), /not a plain directory/);
    assert.throws(() => inner.writeFile('../escape.txt', 'x'), /not a plain relative run path/);
    const moved = path.join(parent, `moved-away-${swap}`);
    fs.renameSync(inner.dir, moved);
    // A link to elsewhere, or a plain private directory of the same name: neither is the held directory.
    if (swap === 'link') fs.symlinkSync(real, inner.dir); else fs.mkdirSync(inner.dir, { mode: 0o700 });
    assert.throws(() => inner.writeFile('after.txt', 'x'), /replaced after it was checked/, swap);
    assert.throws(() => inner.makeDirectory('after'), /replaced after it was checked/, swap);
    assert.throws(() => inner.finish('failed'), /identity changed/, swap);
    assert.ok(fs.existsSync(path.join(moved, 'before.txt')), `${swap}: a swapped root is never removed through the path`);
    assert.deepEqual(fs.readdirSync(real), [], `${swap}: nothing was written through the swap`);
    if (swap === 'directory') assert.deepEqual(fs.readdirSync(inner.dir), [], 'nothing was written into the swapped-in directory');
    fs.rmSync(inner.dir, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
  }
  pass();
});

// ------------------------------------------------------------------ BH1: the composition detector, on a synthetic composition
// A composition shaped like the server's: a start statement, edge layers, aliases of the app and the
// server, a binding a composed statement reads, a definition outside the span, and the feature-routes call;
// and a feature-routes registrar up to the group's own call. The table is classified here from the baseline.
const SYNTHETIC = `import express from 'express';
import http from 'http';
import fs from 'fs';
import compression from 'compression';
import { registerA } from './a.js';
import { registerOther } from './other.js';
const DATA_DIR = resolveRoot();
const fsPromises = fs.promises;
let server = null;
let expressApp = null;
async function construct(options) {
  const configured = options.password ?? null;
  const report = (phase) => console.log(phase);
  console.log(\`Starting on port \${options.port}\`);
  const app = express();
  app.use(rewrite);
  app.set('trust proxy', true);
  registerA(app);
  app.use(compression({ threshold: 1024 }));
  app.use(noStore);
  expressApp = app;
  server = http.createServer(app);
  console.log('started');
  const uiPassword = typeof options.uiPassword === 'string' ? options.uiPassword : null;
  setupBase(app, { uiPassword, server });
  registerOther(app);
  await feature.registerRoutes(app, { dataDir: DATA_DIR, fsPromises });
  report('listener');
  listen(server);
}
`;
const SYNTHETIC_FEATURE = `export const createFeature = () => {
  const registerRoutes = async (app, deps) => {
    const { dataDir, path } = deps;
    const unrelated = makeThing();
    registerOtherRoutes(app, {});
    registerGroup(app, { dataDir });
    registerLaterRoutes(app);
  };
  return { registerRoutes };
};
`;
const syntheticTable = (file, text, spec, roots, classify) => {
  const base = { file, spec, roots, entries: [], definitions: {} };
  let entries = [];
  for (let round = 0; round < 4; round += 1) {
    entries = draftTable({ table: { ...base, entries }, text }).map((statement) => {
      const [, cls, step, reads] = classify.find(([prefix]) => statement.text.startsWith(prefix)) ?? [null, 'UNCLASSIFIED'];
      return { class: cls, step, reads: reads ?? [], digest: statement.digest, text: statement.text, reason: 'synthetic' };
    });
  }
  const table = { ...base, entries };
  const { sourceFile } = spanOf({ file, text, spec });
  const outside = checkSpan({ table, text }).outside;
  table.definitions = Object.fromEntries(outside.map((name) => [name, { digests: declarationsOf(sourceFile, name).map((entry) => entry.digest), reads: [] }]));
  return table;
};
const SYNTHETIC_TABLE = syntheticTable('composition-fixture.js', SYNTHETIC, { start: 'const app = express();', endCall: 'feature.registerRoutes' }, ['app', 'server', 'expressApp'], [
  ['const app = express();', 'composed', 'express-app', ['express']], ['app.use(rewrite);', 'composed', 'rewrite'], ["app.set('trust proxy', true);", 'composed', 'trust-proxy'],
  ['registerA(app);', 'composed', 'a', ['registerA']], ['app.use(compression(', 'composed', 'compression', ['compression']], ['app.use(noStore);', 'composed', 'no-store'], ['expressApp = app;', 'no-request'],
  ['server = http.createServer(app);', 'composed', 'http-server', ['http']], ['const uiPassword', 'composed', 'base'], ['setupBase(app', 'composed', 'base', ['uiPassword', 'server']],
  ['registerOther(app);', 'not-applicable', null, ['registerOther']], ['await feature.registerRoutes(app', 'composed', 'group', ['DATA_DIR', 'fsPromises']], ['listen(server);', 'no-request'],
]);
const SYNTHETIC_FEATURE_TABLE = syntheticTable('feature-fixture.js', SYNTHETIC_FEATURE, { functionNamed: 'registerRoutes', endCall: 'registerGroup' }, 'first-parameter', [
  ['const { dataDir, path } = deps;', 'composed', 'group', ['deps']], ['registerOtherRoutes(app', 'not-applicable', null, ['registerOtherRoutes']], ['registerGroup(app', 'composed', 'group-call', ['dataDir']],
  ['registerLaterRoutes(app);', 'not-applicable', null, ['registerLaterRoutes']],
]);
const once = (text, from, to) => { assert.equal(text.split(from).length, 2, `one ${from}`); return text.replace(from, to); };
const beforeFeature = (line) => once(SYNTHETIC, '  await feature.registerRoutes(app', `${line}\n  await feature.registerRoutes(app`);
const afterFeature = (line) => once(SYNTHETIC, "  report('listener');", `${line}\n  report('listener');`);
const beforeGroup = (line) => once(SYNTHETIC_FEATURE, '    registerGroup(app', `${line}\n    registerGroup(app`);
const renameSpan = () => { const from = SYNTHETIC.indexOf('  const app = express();'); const to = SYNTHETIC.indexOf("  report('listener');"); return SYNTHETIC.slice(0, from) + SYNTHETIC.slice(from, to).replace(/\bapp\b/g, 'webApp') + SYNTHETIC.slice(to); };
// The first review's 26 planted changes (BH01-review.md, B1), in their synthetic form: [name, application text, feature text, problem].
const COMPOSITION_PLANTS = [
  ['a composed layer moved', once(once(SYNTHETIC, "  app.set('trust proxy', true);\n", ''), '  expressApp = app;', "  app.set('trust proxy', true);\n  expressApp = app;"), SYNTHETIC_FEATURE, /moved: composition-fixture\.js:\d+ app\.set\('trust proxy', true\)/],
  ['app.use(extra) before the group', beforeFeature('  app.use(extraLayer);'), SYNTHETIC_FEATURE, /unclassified: composition-fixture\.js:\d+ app\.use\(extraLayer\)/],
  ['a body parser with another limit on the group path', beforeFeature("  app.use('/api/g', express.json({ limit: '1kb' }));"), SYNTHETIC_FEATURE, /unclassified: .*app\.use\('\/api\/g', express\.json/],
  ['expressApp.use(extra) (an alias of the app)', beforeFeature('  expressApp.use(extraLayer);'), SYNTHETIC_FEATURE, /unclassified: .*expressApp\.use\(extraLayer\)/],
  ['app.param', beforeFeature("  app.param('id', (req, res, next) => next());"), SYNTHETIC_FEATURE, /unclassified: .*app\.param\('id'/],
  ['app.options on the group path', beforeFeature("  app.options('/api/g', (req, res) => res.sendStatus(204));"), SYNTHETIC_FEATURE, /unclassified: .*app\.options\(/],
  ['app.head on the group path', beforeFeature("  app.head('/api/g', (req, res) => res.end());"), SYNTHETIC_FEATURE, /unclassified: .*app\.head\(/],
  ['app.route().get', beforeFeature("  app.route('/api/g').get((req, res) => res.json({}));"), SYNTHETIC_FEATURE, /unclassified: .*app\.route\('\/api\/g'\)/],
  ['app.disable', beforeFeature("  app.disable('x-powered-by');"), SYNTHETIC_FEATURE, /unclassified: .*app\.disable\('x-powered-by'\)/],
  ['app.enable', beforeFeature("  app.enable('case sensitive routing');"), SYNTHETIC_FEATURE, /unclassified: .*app\.enable\(/],
  ['app.set later', beforeFeature("  app.set('json spaces', 2);"), SYNTHETIC_FEATURE, /unclassified: .*app\.set\('json spaces', 2\)/],
  ['a registrar taking the app second', beforeFeature('  registerExtra(server, app);'), SYNTHETIC_FEATURE, /unclassified: .*registerExtra\(server, app\)/],
  ["app['use'](extra)", beforeFeature("  app['use'](extraLayer);"), SYNTHETIC_FEATURE, /unclassified: .*app\['use'\]\(extraLayer\)/],
  ['the router stack edited', beforeFeature('  app.router.stack.unshift(extraLayer);'), SYNTHETIC_FEATURE, /unclassified: .*app\.router\.stack\.unshift/],
  ["server.on('request')", beforeFeature("  server.on('request', (req) => { req.headers['x-spy'] = '1'; });"), SYNTHETIC_FEATURE, /unclassified: .*server\.on\('request'/],
  ['server limits', beforeFeature('  server.maxHeadersCount = 5;'), SYNTHETIC_FEATURE, /unclassified: .*server\.maxHeadersCount = 5/],
  ['a composed statement\'s argument (threshold)', once(SYNTHETIC, 'threshold: 1024', 'threshold: 2048'), SYNTHETIC_FEATURE, /changed: composition-fixture\.js: the composed statement app\.use\(compression\(\{ threshold: 1024 \}\)\)/],
  ['a binding a composed statement reads (uiPassword)', once(SYNTHETIC, "? options.uiPassword : null", "? options.uiPassword : 'secret'"), SYNTHETIC_FEATURE, /unclassified: .*const uiPassword = .*'secret'.*a classified statement reads a name it binds/],
  ['a composed registrar\'s argument', once(SYNTHETIC, 'registerA(app);', 'registerA(app, { strict: true });'), SYNTHETIC_FEATURE, /changed: .*registerA\(app\);/],
  ['the feature call\'s dependencies', once(SYNTHETIC, '{ dataDir: DATA_DIR, fsPromises }', "{ dataDir: path.join(DATA_DIR, 'x'), fsPromises }"), SYNTHETIC_FEATURE, /changed: .*await feature\.registerRoutes\(app, \{ dataDir: DATA_DIR, fsPromises \}\)/],
  ['the group call\'s argument', SYNTHETIC, once(SYNTHETIC_FEATURE, 'registerGroup(app, { dataDir });', "registerGroup(app, { dataDir: path.join(dataDir, 'x') });"), /changed: feature-fixture\.js: the composed statement registerGroup\(app, \{ dataDir \}\)/],
  ['a binding re-derived around the unchanged group call', SYNTHETIC, once(SYNTHETIC_FEATURE, '    registerGroup(app, { dataDir });', "    { const dataDir = 'elsewhere'; registerGroup(app, { dataDir }); }"), /unclassified: feature-fixture\.js:\d+ \{ const dataDir = 'elsewhere'/],
  ['the app wrapped for the group', SYNTHETIC, once(SYNTHETIC_FEATURE, 'registerGroup(app, {', 'registerGroup(withAudit(app), {'), /unclassified: .*registerGroup\(withAudit\(app\)/],
  ['a middleware before the group inside the feature routes', SYNTHETIC, beforeGroup('    app.use(extraLayer);'), /unclassified: feature-fixture\.js:\d+ app\.use\(extraLayer\)/],
  ['a definition outside the span', once(SYNTHETIC, 'const DATA_DIR = resolveRoot();', "const DATA_DIR = path.join(resolveRoot(), 'v2');"), SYNTHETIC_FEATURE, /changed: composition-fixture\.js: the definition of DATA_DIR/],
  ['a comment holding a call (not drift)', beforeFeature('  // app.use(fake)'), SYNTHETIC_FEATURE, null],
];
// The second review's 18 changes that alter what the group sees (BH01-review-2.md, B1, A1-A18), in synthetic form: each is drift, named by the rule that sees it.
const COMPOSITION_ALTERS = [
  ['A1 a function declared after the span registers a layer; called inside', once(beforeFeature('  installExtraLayers();'), '  listen(server);\n', '  listen(server);\n  function installExtraLayers() { app.use(extraLayer); }\n'), SYNTHETIC_FEATURE, /unclassified: composition-fixture\.js:\d+ installExtraLayers\(\); — it calls installExtraLayers, a function of this file that reaches/],
  ['A2 a closure declared before the span start registers a layer; called inside', once(beforeFeature('  installEarly();'), '  const app = express();', '  const installEarly = () => app.use(extraLayer);\n  const app = express();'), SYNTHETIC_FEATURE, /unclassified: .*installEarly\(\); — it calls installEarly/],
  ['A3 a layer through a state object (a root read as a property)', beforeFeature('  lifecycleState.expressApp.use(extraLayer);'), SYNTHETIC_FEATURE, /unclassified: .*lifecycleState\.expressApp\.use\(extraLayer\); — it reads expressApp as a property/],
  ['A4 express.response.json patched in the span', beforeFeature('  express.response.json = function patchedJson(body) { return this.send(JSON.stringify({ wrapped: body })); };'), SYNTHETIC_FEATURE, /unclassified: .*express\.response\.json = .* — it mutates express, an object the composition uses/],
  ['A5 http.ServerResponse.prototype.setHeader patched in a block', beforeFeature("  { const original = http.ServerResponse.prototype.setHeader; http.ServerResponse.prototype.setHeader = function (n, v) { return original.call(this, n, n === 'ETag' ? 'W/\"x\"' : v); }; }"), SYNTHETIC_FEATURE, /unclassified: .*http\.ServerResponse\.prototype\.setHeader = .* — it mutates http/],
  ['A6 compression.filter (read by the composed filter) mutated', beforeFeature('  compression.filter = () => true;'), SYNTHETIC_FEATURE, /unclassified: .*compression\.filter = \(\) => true; — it mutates compression/],
  ['A7 a conditional registration', beforeFeature("  if (process.env.AUDIT === '1') app.use(auditLayer);"), SYNTHETIC_FEATURE, /unclassified: .*if \(process\.env\.AUDIT === '1'\) app\.use\(auditLayer\); — it mentions app/],
  ['A8 the span\'s app renamed', renameSpan(), SYNTHETIC_FEATURE, /composition start .* found 0 times/],
  ['A9 the import of a not-applicable registrar swapped to another module', once(SYNTHETIC, "import { registerOther } from './other.js';", "import { registerOther } from './other-v2.js';"), SYNTHETIC_FEATURE, /changed: composition-fixture\.js: the definition of registerOther/],
  ['A10 a second app mounted into the first', beforeFeature('  const auditApp = express(); auditApp.use(auditLayer); app.use(auditApp);'), SYNTHETIC_FEATURE, /unclassified: .*app\.use\(auditApp\)/],
  ['A11 app.use monkey-patched', once(SYNTHETIC, '  expressApp = app;\n', '  const originalUse = app.use.bind(app); app.use = (...args) => originalUse(auditLayer, ...args);\n  expressApp = app;\n'), SYNTHETIC_FEATURE, /unclassified: .*const originalUse = app\.use\.bind\(app\)/],
  ['A12 a middleware right after trust proxy', once(SYNTHETIC, "  app.set('trust proxy', true);\n", "  app.set('trust proxy', true);\n  app.use(requestIdLayer);\n"), SYNTHETIC_FEATURE, /unclassified: .*app\.use\(requestIdLayer\)/],
  ['A13 feature routes: the dependency object mutated before the destructuring', SYNTHETIC, once(SYNTHETIC_FEATURE, '    const { dataDir, path } = deps;', '    deps.dataDir = elsewhere;\n    const { dataDir, path } = deps;'), /unclassified: feature-fixture\.js:\d+ deps\.dataDir = elsewhere; — it mutates deps/],
  ['A14 a pinned dependency object mutated (fsPromises.writeFile)', beforeFeature('  fsPromises.writeFile = auditedWriteFile;'), SYNTHETIC_FEATURE, /unclassified: .*fsPromises\.writeFile = auditedWriteFile; — it mutates fsPromises/],
  ['A15 a registration in an async continuation', beforeFeature('  setImmediate(() => expressApp.use(lateLayer));'), SYNTHETIC_FEATURE, /unclassified: .*setImmediate\(\(\) => expressApp\.use\(lateLayer\)\)/],
  ['A16 a globalThis holder registers through it', beforeFeature('  globalThis.__app = app;\n  globalThis.__app.use(extraLayer);'), SYNTHETIC_FEATURE, /unclassified: .*globalThis\.__app = app;/],
  ['A17 a setting after the group\'s call (json spaces)', afterFeature("  app.set('json spaces', 2);"), SYNTHETIC_FEATURE, /unclassified: composition-fixture\.js:\d+ app\.set\('json spaces', 2\); — after the group's call, it mentions app/],
  ['A18 a setting after the group\'s call (etag)', afterFeature("  app.disable('etag');"), SYNTHETIC_FEATURE, /unclassified: .*app\.disable\('etag'\); — after the group's call/],
];
// The second review's edits that do not change what the group sees (N1-N12): none is drift, except N9, which mentions the app (flagged by design).
const COMPOSITION_HARMLESS = [
  ['N1 a comment line in the span', beforeFeature('  // the feature routes register the groups'), SYNTHETIC_FEATURE, null],
  ['N2 a composed call reformatted', once(SYNTHETIC, '  app.use(compression({ threshold: 1024 }));', '  app.use(compression({\n    threshold: 1024\n  }));'), SYNTHETIC_FEATURE, null],
  ['N3 a missing semicolon', once(SYNTHETIC, '  app.use(noStore);\n', '  app.use(noStore)\n'), SYNTHETIC_FEATURE, null],
  ['N4 double quotes instead of single', once(SYNTHETIC, "  app.set('trust proxy', true);", '  app.set("trust proxy", true);'), SYNTHETIC_FEATURE, null],
  ['N5 an unrelated const in the span', beforeFeature("  const note = 'feature routes';"), SYNTHETIC_FEATURE, null],
  ['N6 an unrelated console.log in the span', beforeFeature("  console.log('[startup] registering feature routes');"), SYNTHETIC_FEATURE, null],
  ['N7 an extra startup report', beforeFeature("  report('features');"), SYNTHETIC_FEATURE, null],
  ['N8 redundant parentheses around a composed argument', once(SYNTHETIC, '  app.use(noStore);', '  app.use((noStore));'), SYNTHETIC_FEATURE, null],
  ['N9 a log line that reads the app (flagged by design: it mentions the app)', beforeFeature("  console.log('[startup] layers', app.router.stack.length);"), SYNTHETIC_FEATURE, /unclassified: .*console\.log\('\[startup\] layers', app\.router\.stack\.length\); — it mentions app/],
  ['N10 a trailing comma in a composed call', once(SYNTHETIC, '  app.use(compression({ threshold: 1024 }));', '  app.use(compression({ threshold: 1024 }),);'), SYNTHETIC_FEATURE, null],
  ['N11 an unrelated statement in the feature routes before the group', SYNTHETIC, beforeGroup('    const groupCount = 1;'), null],
  ['N12 the startup log line before the span changed', once(SYNTHETIC, 'Starting on port', 'Starting the web host on port'), SYNTHETIC_FEATURE, null],
];

test('the composition detector catches every planted change of a synthetic composition and nothing in a comment', DEADLINE, () => {
  const drift = (applicationText, featureText) => [...checkSpan({ table: SYNTHETIC_TABLE, text: applicationText }).problems, ...checkSpan({ table: SYNTHETIC_FEATURE_TABLE, text: featureText }).problems];
  for (const table of [SYNTHETIC_TABLE, SYNTHETIC_FEATURE_TABLE]) assert.deepEqual(table.entries.filter((entry) => entry.class === 'UNCLASSIFIED').map((entry) => entry.text), [], 'every relevant synthetic statement is classified');
  assert.deepEqual(drift(SYNTHETIC, SYNTHETIC_FEATURE), []);
  // The table really covers the aliases, the binding, the definitions and the statements after the group's call.
  assert.ok(SYNTHETIC_TABLE.entries.some((entry) => entry.text === 'expressApp = app;'));
  assert.ok(SYNTHETIC_TABLE.entries.some((entry) => entry.text.startsWith('const uiPassword')));
  assert.ok(SYNTHETIC_TABLE.entries.some((entry) => entry.text === 'listen(server);'), 'a statement after the group\'s call that mentions the server is classified');
  assert.deepEqual(Object.keys(SYNTHETIC_TABLE.definitions).sort(), ['DATA_DIR', 'compression', 'express', 'fsPromises', 'http', 'registerA', 'registerOther']);
  assert.deepEqual([COMPOSITION_PLANTS.length, COMPOSITION_ALTERS.length, COMPOSITION_HARMLESS.length], [26, 18, 12]);
  for (const [name, applicationText, featureText, problem] of [...COMPOSITION_PLANTS, ...COMPOSITION_ALTERS, ...COMPOSITION_HARMLESS]) {
    const problems = drift(applicationText, featureText);
    if (problem === null) assert.deepEqual(problems, [], name);
    else assert.ok(problems.some((entry) => problem.test(entry)), `${name}: ${problem} in ${JSON.stringify(problems)}`);
  }
  // A start statement that is gone, or found twice, is drift too.
  assert.match(checkSpan({ table: SYNTHETIC_TABLE, text: SYNTHETIC.replace('const app = express();', 'const app = express(options);') }).problems.join('\n'), /composition start .* found 0 times/);
  // A table whose not-applicable entry does not read the registrar it calls through is refused (the module that registers must be pinned).
  const unpinned = { ...SYNTHETIC_TABLE, entries: SYNTHETIC_TABLE.entries.map((entry) => (entry.text === 'registerOther(app);' ? { ...entry, reads: [] } : entry)) };
  assert.match(checkSpan({ table: unpinned, text: SYNTHETIC }).problems.join('\n'), /the not-applicable entry at line \d+ calls through registerOther, which its reads do not list/);
  // The group's own call is always checked, even when it names no tracked name.
  const viaRouter = 'export const make = () => {\n  const registerRoutes = async (app, deps) => {\n    const router = deps.router;\n    registerGroup(router);\n  };\n};\n';
  const viaRouterTable = syntheticTable('router-fixture.js', viaRouter, { functionNamed: 'registerRoutes', endCall: 'registerGroup' }, 'first-parameter', [['registerGroup(', 'composed', 'group-call']]);
  assert.match(checkSpan({ table: viaRouterTable, text: viaRouter.replace('registerGroup(router);', 'registerGroup(router, { audit: true });') }).problems.join('\n'), /changed: router-fixture\.js: the composed statement registerGroup\(router\)/);
  // Aliases are tracked: a name a relevant statement binds is tracked for the statements after it.
  assert.match(drift(beforeFeature('  const alias = app;\n  alias.use(extraLayer);'), SYNTHETIC_FEATURE).join('\n'), /unclassified: .*alias\.use\(extraLayer\); — it mentions alias/);
});

// ------------------------------------------------------------------ BH1: the reach and layer-stack checks, on synthetic census entries
const GROUP_FILE = 'lib/toy-group/routes.js';
const SYNTHETIC_GROUP = { files: [`packages/web/server/${GROUP_FILE}`] };
const syntheticCensus = (extraRoutes = [], extraMounts = []) => ({
  routes: [
    { method: 'GET', path: '/api/toy-group', order: 50, file: GROUP_FILE, line: 1, viaRouter: false },
    { method: 'PUT', path: '/api/toy-group/:id', order: 51, file: GROUP_FILE, line: 2, viaRouter: false },
    { method: 'GET', path: '/robots.txt', order: 2, file: 'lib/indexing-policy.js', line: 9, viaRouter: false },
    ...extraRoutes,
  ],
  mounts: [
    { method: 'USE', path: null, order: 1, file: 'lib/indexing-policy.js', line: 5, viaRouter: false },
    { method: 'USE', path: null, order: 3, file: 'lib/runtime-service/routes.js', line: 137, viaRouter: false },
    { method: 'USE', path: '/api', order: 4, file: 'lib/opencode/core-routes.js', line: 700, viaRouter: false },
    ...extraMounts,
  ],
});

test('the reach check decides by the router\'s own matching: patterns, regexes, arrays, parameters and case', DEADLINE, async () => {
  const express = await importFromServer('express');
  const reach = (routes, mounts) => reachProblems({ group: SYNTHETIC_GROUP, census: syntheticCensus(routes, mounts), values: { id: 'abc' }, express });
  assert.deepEqual(await reach(), []);
  const omitted = 'lib/diagnostics/routes.js';
  const caught = [
    ['a route pattern', [{ method: 'GET', path: '/api/:name', order: 5, file: omitted, line: 1 }], []],
    ['a wildcard route', [{ method: 'PUT', path: '/api/toy-group/*splat', order: 5, file: omitted, line: 2 }], []],
    ['a regex route', [{ method: 'GET', path: 'regex:toy', order: 5, file: omitted, line: 3 }], []],
    ['an all-methods route', [{ method: 'ALL', path: '/api/toy-group', order: 5, file: omitted, line: 4 }], []],
    ['HEAD runs a GET route', [{ method: 'GET', path: '/api/toy-group', order: 5, file: omitted, line: 5 }], []],
    ['a HEAD route runs for the HEAD requests of a GET route', [{ method: 'HEAD', path: '/api/toy-group', order: 5, file: omitted, line: 12 }], []],
    ['a parameter mount', [], [{ method: 'USE', path: '/api/toy-group/:id', order: 5, file: omitted, line: 6 }]],
    ['a parameter in a prefix mount', [], [{ method: 'USE', path: '/api/:x', order: 5, file: omitted, line: 7 }]],
    ['an array mount', [], [{ method: 'USE', path: ['/a', '/api'], order: 5, file: omitted, line: 8 }]],
    ['a mount on a concrete value of a group parameter', [], [{ method: 'USE', path: '/api/toy-group/fixed', order: 5, file: omitted, line: 9 }]],
    ['a mount in another case', [], [{ method: 'USE', path: '/API', order: 5, file: omitted, line: 10 }]],
    ['a layer on every path', [], [{ method: 'USE', path: null, order: 5, file: omitted, line: 11 }]],
  ];
  for (const [name, routes, mounts] of caught) assert.match((await reach(routes, mounts)).join('\n'), new RegExp(`reach: .* from ${omitted.replace(/[./]/g, '\\$&')}:${(routes[0] ?? mounts[0]).line} runs for`), name);
  const clean = [
    ['a longer literal prefix', [], [{ method: 'USE', path: '/api/toy-groupx', order: 5, file: omitted, line: 20 }]],
    ['another method', [{ method: 'POST', path: '/api/toy-group', order: 5, file: omitted, line: 21 }], []],
    ['a deeper mount than any group route', [], [{ method: 'USE', path: '/api/toy-group/a/b', order: 5, file: omitted, line: 22 }]],
    ['a layer after the group', [], [{ method: 'USE', path: null, order: 60, file: omitted, line: 23 }]],
    ['a layer of a composed step', [], [{ method: 'USE', path: '/api', order: 5, file: 'lib/tunnels/access-control.js', line: 24 }]],
  ];
  for (const [name, routes, mounts] of clean) assert.deepEqual(await reach(routes, mounts), [], name);
  const withoutOmission = { ...syntheticCensus(), mounts: syntheticCensus().mounts.filter((mount) => mount.file !== 'lib/runtime-service/routes.js') };
  assert.match((await reachProblems({ group: SYNTHETIC_GROUP, census: withoutOmission, express })).join('\n'), /the omission of lib\/runtime-service\/routes\.js matches no layer/);
});

test('the layer-stack check compares the layers that run for the group, in order', DEADLINE, async () => {
  const express = await importFromServer('express');
  const census = syntheticCensus();
  const host = (entries) => [...entries.map(([file, line, kind, routePath, method = null]) => ({ kind, method, path: routePath, file: path.join(SERVER_ROOT, file), line, group: false, top: true })),
    { kind: 'route', method: 'GET', path: '/api/toy-group', file: path.join(SERVER_ROOT, GROUP_FILE), line: 1, group: true, top: true }];
  const same = host([['lib/indexing-policy.js', 5, 'use', '/'], ['lib/indexing-policy.js', 9, 'route', '/robots.txt', 'GET'], ['lib/opencode/core-routes.js', 700, 'use', '/api']]);
  assert.deepEqual(await layerStackProblems({ group: SYNTHETIC_GROUP, census, hostRegistrations: same, express }), []);
  const swapped = host([['lib/opencode/core-routes.js', 700, 'use', '/api'], ['lib/indexing-policy.js', 5, 'use', '/']]);
  assert.match((await layerStackProblems({ group: SYNTHETIC_GROUP, census, hostRegistrations: swapped, express })).join('\n'), /layer stack: layer 1 that runs for the group's requests is lib\/opencode\/core-routes\.js:700/);
  const missing = host([['lib/indexing-policy.js', 5, 'use', '/']]);
  assert.match((await layerStackProblems({ group: SYNTHETIC_GROUP, census, hostRegistrations: missing, express })).join('\n'), /layer 2 .* is <none> in the group host and lib\/opencode\/core-routes\.js:700/);
  // A layer inside a mounted router of a composed step: the host must have it too.
  const nestedCensus = { ...census, mounts: [...census.mounts, { method: 'USE', path: '/', order: 4, file: 'lib/opencode/core-routes.js', line: 701, viaRouter: true }] };
  const nested = { kind: 'use', method: null, path: '/', file: path.join(SERVER_ROOT, 'lib/opencode/core-routes.js'), line: 701, group: false, top: false };
  assert.deepEqual(await layerStackProblems({ group: SYNTHETIC_GROUP, census: nestedCensus, hostRegistrations: [...same.slice(0, -1), nested, same.at(-1)], express }), []);
  assert.match((await layerStackProblems({ group: SYNTHETIC_GROUP, census: nestedCensus, hostRegistrations: same, express })).join('\n'), /the census mounts lib\/opencode\/core-routes\.js:701 inside a router, running for the group's requests; the group host does not/);
});

// ------------------------------------------------------------------ BH1: the group host and the tap on the toy group
test('the tap records the toy group exactly, and the edge probes find the re-statement composed as stated', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const outbound = [];
  const stub = http.createServer((req, res) => { const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => { outbound.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    // ?hold: the answer's body never ends (a fetch whose body is not read stays pending for certain).
    if (req.url.includes('hold')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('part'); return; }
    res.end('stub-answer'); }); });
  await new Promise((resolve) => { stub.listen(0, '127.0.0.1', resolve); });
  t.after(() => { stub.closeAllConnections(); stub.close(); });
  const stubUrl = `http://127.0.0.1:${stub.address().port}/stub`;
  const host = await startGroupHost({ run, name: 'toy', group: TOY_GROUPS.toy, label: 'toy', table: TOY_TABLE });
  t.after(() => host.stop());
  const port = host.ready.listen;
  const seqs = {};
  let seq = 0;
  const exchange = async (name, method, route, init = {}) => {
    const answer = await rawRequest(port, method, route, { ...init, headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers } });
    seqs[name] = ++seq;
    return { status: answer.status, headers: answer.headers, text: answer.body.toString('latin1'), body: answer.body };
  };
  const control = (route) => host.control(route).then((answer) => answer.body);
  // The edge probes first: a re-statement that composes something else (a UI password, a skipped layer) is named here,
  // before any toy assertion fails on its consequence. Their exchanges are the first ones of the host.
  const probed = await edgeProbeProblems({ port });
  assert.deepEqual(probed.problems, [], 'the re-statement composes what it states');
  assert.equal(probed.probes.length, EDGE_PROBES.length);
  assert.equal(EDGE_PROBES.length, 14);
  seq = (await control('/status')).lastSeq;
  assert.deepEqual(host.output(), ['toy registrar: a log line on stdout before the ready line'], 'a product log line before the ready line is output, not a failed start');

  assert.equal((await exchange('direct', 'GET', '/api/toy/direct')).text, '{"route":"direct"}');
  assert.equal((await exchange('router', 'GET', '/api/toy/router/inner')).text, '{"route":"router","baseUrl":"/api/toy/router","url":"/inner"}');
  assert.equal((await exchange('mount', 'GET', '/api/toy/mount/inner')).text, '{"route":"mount","baseUrl":"/api/toy/mount"}');
  assert.equal((await exchange('chainGet', 'GET', '/api/toy/chain')).text, '{"route":"chain-get"}');
  const duplicate = '{"text":"a","text":"b","n":9007199254740993}';
  assert.equal((await exchange('chainPost', 'POST', '/api/toy/chain', { body: duplicate })).text, '{"route":"chain-post","body":{"text":"b","n":9007199254740992}}');
  // The edge's shared parser covers listed /api prefixes only; /api/toy is left raw.
  assert.equal((await exchange('unparsed', 'POST', '/api/toy/all', { body: '{"text":' })).text, '{"route":"all","method":"POST"}');
  assert.equal((await exchange('all', 'DELETE', '/api/toy/all')).text, '{"route":"all","method":"DELETE"}');
  assert.equal((await exchange('array', 'GET', '/api/toy/array')).text, '{"route":"array","step":2}');
  assert.equal((await exchange('helper', 'GET', '/api/toy/helper')).text, '{"route":"helper"}');
  assert.equal((await exchange('override', 'GET', '/api/toy/override')).headers['cache-control'], 'private, max-age=5');
  // A dependency the host leaves absent, reached at request time: refused loudly and counted, never silently stubbed.
  const absentAnswer = await exchange('absent', 'GET', '/api/toy/absent');
  assert.deepEqual([absentAnswer.status, /which the group host does not provide/.test(absentAnswer.text)], [500, true], absentAnswer.text);
  assert.equal((await exchange('large', 'GET', '/api/toy/large', { headers: { 'accept-encoding': 'gzip' } })).headers['content-encoding'], 'gzip');
  assert.equal((await exchange('throws', 'GET', '/api/toy/throws')).status, 500);
  await exchange('textStack', 'GET', '/api/toy/text-stack');
  await exchange('jsonStack', 'GET', '/api/toy/json-stack');
  await exchange('noStack', 'GET', '/api/toy/no-stack');
  assert.equal((await exchange('twice', 'GET', '/api/toy/twice')).text, 'first');
  assert.equal((await exchange('twiceJson', 'GET', '/api/toy/twice-json')).text, '{"answer":1}');
  await exchange('hub', 'POST', '/api/toy/hub', { body: '{}' });
  assert.equal(JSON.parse((await exchange('fetch', 'GET', `/api/toy/fetch?to=${encodeURIComponent(stubUrl)}`)).text).text, 'stub-answer');
  assert.equal(JSON.parse((await exchange('httpRequest', 'GET', `/api/toy/http-request?to=${encodeURIComponent(stubUrl)}`)).text).text, 'stub-answer');
  assert.equal(JSON.parse((await exchange('child', 'GET', '/api/toy/child')).text).stdout, 'toy-child:stdin-bytes');
  assert.equal(JSON.parse((await exchange('childAsync', 'GET', '/api/toy/child-async')).text).stdout, 'async-stdin');
  assert.equal((await exchange('malformed', 'POST', '/api/toy/chain', { body: '{"text":' })).status, 400);
  assert.equal((await exchange('useAnswers', 'GET', '/api/toy/use-answers')).text, '{"route":"use-answers"}');
  assert.equal((await exchange('usePasses', 'GET', '/api/toy/use-passes')).status, 599);
  assert.equal((await exchange('factory', 'GET', '/api/toy/factory')).text, '{"route":"factory"}');
  assert.equal((await exchange('unclaimed', 'GET', '/api/toy/unclaimed')).text, '{"route":"unclaimed"}');
  assert.equal((await exchange('principal', 'GET', '/api/toy/principal')).text, '{"scope":"toy-scope"}');
  assert.equal((await exchange('varyLarge', 'GET', '/api/toy/vary?large=1', { headers: { 'accept-encoding': 'gzip' } })).headers.vary, 'Origin, Accept-Encoding');
  await exchange('varySmall', 'GET', '/api/toy/vary');
  assert.deepEqual((await exchange('cookies', 'GET', '/api/toy/cookies')).headers['set-cookie'], ['a=1', 'b=2']);
  const invalid = await exchange('invalidHeader', 'GET', '/api/toy/invalid-header');
  assert.equal(invalid.status, 500);
  assert.doesNotMatch(invalid.text, /tap\.mjs/, 'the tap\'s frame never reaches a body');
  const identity = JSON.parse((await exchange('identity', 'GET', '/api/toy/identity')).text);
  assert.deepEqual({ ...identity, closeListeners: undefined }, { write: 'write', end: 'end', setHeader: 'setHeader', setHeaderLength: 2, push: 'push', on: 'on', emit: 'emit', closeListeners: undefined });
  assert.equal((await exchange('chunks', 'GET', '/api/toy/chunks')).text, 'abc');
  const huge = await exchange('huge', 'GET', '/api/toy/huge');
  assert.equal(huge.body.length, 256 * 1024);
  const upload = Buffer.alloc(256 * 1024, 0x55);
  assert.equal((await exchange('upload', 'POST', '/api/toy/upload', { body: upload, headers: { 'content-type': 'application/octet-stream' } })).text, `{"length":${upload.length}}`);
  await exchange('twiceCompressed', 'GET', '/api/toy/twice-compressed', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal((await exchange('writeAfterEnd', 'GET', '/api/toy/write-after-end')).text, 'x');
  // A client that abandons the response after its first chunk.
  await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('data', () => socket.destroy());
    socket.on('close', resolve);
    socket.on('error', () => {});
    socket.write('GET /api/toy/abandoned HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  });
  seqs.abandoned = ++seq;
  assert.deepEqual(JSON.parse((await exchange('releaseAbandoned', 'POST', '/api/toy/release?gate=abandoned', { body: '{}' })).text), { released: true });

  // Work after the response. /quiescent is bounded: a test asks /pending first and never waits on work it expects to stay.
  await exchange('declared', 'POST', '/api/toy/declared', { body: '{}' });
  assert.deepEqual((await control(`/pending?seq=${seqs.declared}`)).pending, []);
  await exchange('undeclared', 'POST', '/api/toy/undeclared', { body: '{}' });
  // An exchange whose effects come while an earlier one is still pending: each keeps its own effects.
  await exchange('hubOverlap', 'POST', '/api/toy/hub', { body: '{}' });
  const pending = (await control(`/pending?seq=${seqs.undeclared}`)).pending;
  assert.ok(pending.length > 0 && pending.every((entry) => entry.type === 'PROMISE' && typeof entry.site === 'string'), `undeclared work is pending, with its sites: ${JSON.stringify(pending)}`);
  await exchange('releaseUndeclared', 'POST', '/api/toy/release?gate=undeclared', { body: '{}' });
  await exchange('timer', 'GET', '/api/toy/timer');
  assert.ok((await control(`/pending?seq=${seqs.timer}`)).pending.some((entry) => entry.type === 'Timeout'), 'a timer the group started is pending');
  await exchange('nestedTimer', 'GET', '/api/toy/nested-timer');
  assert.ok((await host.quiescent(seqs.nestedTimer, 400)).body.pending.some((entry) => entry.type === 'Timeout'), 'a timer started by work the group started is pending');
  await exchange('late', 'GET', '/api/toy/late');
  await exchange('releaseLate', 'POST', '/api/toy/release?gate=late', { body: '{}' });
  await exchange('unattributed', 'GET', '/api/toy/unattributed');
  await exchange('onFinish', 'GET', '/api/toy/on-finish');
  await exchange('busListener', 'GET', '/api/toy/bus-listener');
  await exchange('busEmit', 'GET', '/api/toy/bus-emit');
  await exchange('asyncResource', 'GET', '/api/toy/async-resource');
  await exchange('microtasks', 'GET', '/api/toy/microtasks');
  // The handler answers after zlib.gzip called back: its handle is closed, so nothing of it is pending (at once, not after a GC).
  await exchange('gzip', 'GET', '/api/toy/gzip');
  assert.deepEqual((await control(`/pending?seq=${seqs.gzip}`)).pending, [], 'a closed compression handle is not pending');
  // A fetch whose body is never read: pending for good, with sites inside Node (the unread stream), never blank.
  await exchange('fetchUnread', 'GET', `/api/toy/fetch-unread?to=${encodeURIComponent(`${stubUrl}?hold=1`)}`);
  const unread = (await host.quiescent(seqs.fetchUnread, 300)).body;
  assert.equal(unread.quiescent, false, 'an unread fetch body is never quiescent');
  assert.ok(unread.pending.length > 0 && unread.pending.every((entry) => typeof entry.site === 'string' && !/async_hooks|promise_hooks/.test(entry.site)), `pending sites: ${JSON.stringify(unread.pending)}`);
  // Effects that finish after the response: pending until they finish, then the record is completed (effect-update records).
  await exchange('childLateExit', 'GET', '/api/toy/child-late-exit');
  await exchange('fetchLate', 'GET', `/api/toy/fetch-late?to=${encodeURIComponent(stubUrl)}`);
  await exchange('httpLate', 'GET', `/api/toy/http-late?to=${encodeURIComponent(stubUrl)}`);
  assert.ok((await control(`/pending?seq=${seqs.httpLate}`)).pending.some((entry) => entry.type === 'EFFECT' && /^http-request POST /.test(entry.site)), 'an outbound request not answered yet is pending work');
  assert.ok((await control(`/pending?seq=${seqs.childLateExit}`)).pending.some((entry) => entry.type === 'EFFECT' && /^child /.test(entry.site)), 'a child that has not exited is pending work');
  for (const name of ['child-exit', 'fetch-body', 'http-body']) await exchange(`release-${name}`, 'POST', `/api/toy/release?gate=${name}`, { body: '{}' });
  for (const name of ['childLateExit', 'fetchLate', 'httpLate']) assert.equal((await host.quiescent(seqs[name])).body.quiescent, true, `${name} is quiescent once its effect finished`);
  await exchange('childUnseenExit', 'GET', '/api/toy/child-unseen-exit');
  const unseen = (await host.quiescent(seqs.childUnseenExit)).body;
  assert.deepEqual([unseen.quiescent, unseen.blind.map((mark) => mark.kind)], [true, ['unfinished-effect']], 'an effect whose end the tap cannot see is marked when its exchange goes quiescent');
  // An outbound request never ended is never answered: never quiescent, and /quiescent names it.
  await exchange('httpUnended', 'GET', `/api/toy/http-unended?to=${encodeURIComponent(stubUrl)}`);
  const unended = (await host.quiescent(seqs.httpUnended, 300)).body;
  assert.equal(unended.quiescent, false, 'an unanswered outbound request is never quiescent');
  assert.ok(unended.pending.some((entry) => entry.type === 'EFFECT' && /^http-request POST /.test(entry.site)), JSON.stringify(unended.pending));
  // A debounce: the second exchange's work runs on the first one's timer. It is quiescent at once, and marked crossed when the timer fires.
  await exchange('debounceA', 'POST', '/api/toy/debounce?n=a', { body: '{}' });
  await exchange('debounceB', 'POST', '/api/toy/debounce?n=b', { body: '{}' });
  await exchange('debounceFlush', 'POST', '/api/toy/debounce-flush', { body: '{}' });
  assert.equal((await host.quiescent(seqs.debounceA)).body.quiescent, true);
  const riding = (await host.quiescent(seqs.debounceB)).body;
  assert.ok(riding.crossed.some((entry) => entry.from === seqs.debounceA && entry.event === 'timer'), `a later exchange riding on an earlier one's timer is marked crossed: ${JSON.stringify(riding)}`);
  await exchange('raceCleared', 'GET', '/api/toy/race-cleared');
  await exchange('clearTimers', 'POST', '/api/toy/clear-timers', { body: '{}' });
  const never = (await host.quiescent(seqs.raceCleared, 300)).body;
  assert.equal(never.quiescent, false, 'a promise that never settles: never quiescent, and /quiescent says so');
  assert.ok(never.pending.length > 0 && never.pending.every((entry) => entry.type === 'PROMISE' && typeof entry.site === 'string'), JSON.stringify(never));
  const neverQuiescent = new Set([seqs.raceCleared, seqs.fetchUnread, seqs.httpUnended]);
  for (let index = 1; index <= seq; index += 1) {
    if (neverQuiescent.has(index)) continue;
    const answer = (await host.quiescent(index)).body;
    assert.equal(answer.quiescent, true, `exchange ${index}: ${JSON.stringify(answer)}`);
  }
  const status = await control('/status');
  assert.deepEqual([status.lastSeq, status.problems, status.absentCalls], [seq, [], ['toyAbsent']]);

  assert.equal((await host.stop()).code, 0);
  assert.equal(outbound.length, 5, 'four outbound requests with bodies and the unread fetch');
  assert.deepEqual(outbound.filter((entry) => entry.headers['x-toy-out']).map((entry) => [entry.headers['x-toy-out'], entry.body]), [['f', 'toy-outbound'], ['h', 'http-body'], ['fl', 'early-late'], ['hl', 'early-late']]);

  const records = readTapRecords(host.tapFile);
  assert.equal(records[0].type, 'tap');
  assert.equal(records.filter((entry) => entry.type === 'host').length, 1);
  assert.deepEqual(records.filter((entry) => entry.type === 'problem'), []);
  const registrations = records.filter((entry) => entry.type === 'registration');
  const groupRegistrations = registrations.filter((entry) => entry.group);
  assert.ok(groupRegistrations.filter((entry) => !entry.claimed).every((entry) => entry.inWindow));
  assert.ok(registrations.filter((entry) => !entry.group).every((entry) => !entry.inWindow));
  const toyRoutes = path.join(HERE, 'toy/toy-routes.mjs');
  const registered = (kind, method, routePath) => groupRegistrations.find((entry) => entry.kind === kind && entry.method === method && JSON.stringify(entry.path) === JSON.stringify(routePath));
  for (const [kind, method, routePath] of [['route', 'GET', '/api/toy/direct'], ['route', 'GET', '/inner'], ['use', null, '/api/toy/router'], ['use', null, '/api/toy/mount'], ['use', null, '/api/toy/use-answers'],
    ['route', 'GET', '/api/toy/chain'], ['route', 'POST', '/api/toy/chain'], ['route', 'DELETE', '/api/toy/all'], ['route', 'GET', '/api/toy/all'], ['route', 'GET', '/api/toy/array'], ['route', 'GET', '/api/toy/helper']]) {
    assert.ok(registered(kind, method, routePath), `registration ${kind} ${method} ${routePath}`);
  }
  // Express 5's app.all registers the route once per method.
  assert.ok(groupRegistrations.filter((entry) => entry.path === '/api/toy/all').length > 20);
  assert.equal(registered('route', 'GET', '/api/toy/helper').file, path.join(HERE, 'toy/toy-helper.mjs'), 'a helper registers for the group');
  assert.equal(registered('route', 'GET', '/api/toy/direct').file, toyRoutes);
  assert.equal(registered('route', 'GET', '/api/toy/direct').top, true, 'registered on the app router');
  assert.equal(registered('route', 'GET', '/inner').top, false, 'registered on a mounted router');
  const factoryRegistration = registered('use', null, '/api/toy/factory');
  assert.deepEqual([factoryRegistration?.claimed, factoryRegistration?.inWindow], [true, false], 'a handler from the group\'s factory, registered by edge code, is the group\'s');
  assert.ok(registrations.some((entry) => !entry.group && JSON.stringify(entry.path) === '"/api/toy/unclaimed"'), 'a group-file handler no factory made, registered by edge code, is the edge\'s');
  const exchanges = new Map(records.filter((entry) => entry.type === 'exchange').map((entry) => [entry.seq, entry]));
  const starts = new Set(records.filter((entry) => entry.type === 'exchange-start').map((entry) => entry.seq));
  const quiescent = new Set(records.filter((entry) => entry.type === 'quiescent').map((entry) => entry.seq));
  assert.ok(exchanges.size >= seq);
  for (let index = 1; index <= seq; index += 1) {
    assert.ok(starts.has(index), `exchange ${index} has a start record`);
    if (!neverQuiescent.has(index)) assert.ok(quiescent.has(index), `exchange ${index} went quiescent`);
  }
  const of = (name) => exchanges.get(seqs[name]);
  const header = (record, name) => record.response.headers.find((entry) => entry.name.toLowerCase() === name);
  const owner = (record, name) => { const entry = header(record, name); return entry && `${entry.owner?.owner}:${entry.owner?.module ?? ''}`; };

  const direct = of('direct');
  assert.deepEqual([direct.kind, direct.entered, direct.answeredBy.owner], ['group', true, 'group']);
  assert.equal(decode(direct.response.body), '{"route":"direct"}');
  assert.equal(direct.entry.principal.scope, 'local-admin');
  assert.deepEqual(direct.entry.edgeHeaders.map(([name]) => name), ['x-powered-by', 'x-robots-tag', 'cache-control', 'pragma', 'expires']);
  for (const name of ['content-type', 'content-length', 'etag']) assert.equal(header(direct, name).owner.owner, 'group', name);
  for (const name of ['x-powered-by', 'x-robots-tag', 'cache-control', 'pragma', 'expires']) assert.equal(header(direct, name).owner.owner, 'edge', name);
  assert.match(owner(direct, 'vary'), /^edge:compression$/);
  assert.match(owner(direct, 'date'), /^node:/);
  assert.ok(direct.response.ops.filter((op) => op.op === 'status').every((op) => op.origin.owner === 'group'), 'the status write is the group\'s, not compression\'s');
  assert.equal(of('router').entry.originalUrl, '/api/toy/router/inner');
  assert.equal(of('mount').entry.originalUrl, '/api/toy/mount/inner');
  const chainPost = of('chainPost');
  assert.equal(decode(chainPost.request.body), duplicate, 'the raw request bytes, duplicate key and large integer included');
  assert.deepEqual([chainPost.entry.bodyParsedByEdge, chainPost.entry.bodyConsumedBeforeEntry], [false, false], 'the group parses its own body');
  assert.equal(of('unparsed').entry.bodyParsedByEdge, false);

  const override = of('override');
  assert.deepEqual(override.entry.edgeHeaders.find(([name]) => name === 'cache-control'), ['cache-control', 'no-store, max-age=0']);
  assert.deepEqual([header(override, 'cache-control').value, header(override, 'cache-control').owner.owner, header(override, 'cache-control').group.value], ['private, max-age=5', 'group', 'private, max-age=5']);
  assert.deepEqual(header(override, 'cache-control').elements.map((element) => [element.value, element.owner.owner]), [['private', 'group'], ['max-age=5', 'group']]);
  assert.equal(header(override, 'x-toy').owner.owner, 'group');
  assert.deepEqual(header(override, 'x-toy').group, { value: 'set', op: 'setHeader' }, 'the group\'s value is its last write');

  const large = of('large');
  const largeBody = JSON.stringify({ route: 'large', text: 'abcdefghij'.repeat(600) });
  assert.equal(decode(large.response.body), largeBody, 'the body before compression');
  assert.notEqual(Buffer.from(large.response.wire, 'base64').length, Buffer.byteLength(largeBody));
  assert.equal(owner(large, 'content-encoding'), 'edge:compression');
  assert.equal(header(large, 'content-length').value, null, 'removed by compression after the group set it');
  assert.equal(header(large, 'content-length').group.value, String(Buffer.byteLength(largeBody)), 'the group\'s value is kept');
  assert.ok(large.response.ops.some((op) => op.op === 'removeHeader' && op.name === 'Content-Length' && op.origin.module === 'compression'));
  assert.ok(large.transmissionWork > 0, 'compression work is transmission, not pending');

  const threw = of('throws');
  assert.deepEqual([threw.kind, threw.entered, threw.response.status, threw.answeredBy.owner, threw.answeredBy.module], ['group', true, 500, 'edge', 'finalhandler']);
  assert.match(decode(threw.response.body), /toy handler failure/);
  assert.deepEqual(threw.response.bodyOrigins, ['edge'], 'the error page is the edge\'s (finalhandler)');
  assert.match(decode(threw.response.body), /<br> &nbsp; &nbsp;at /, 'the edge\'s error page prints the stack as HTML');
  // Marked: the edge's HTML error page (a throw, an invalid header), a raw text stack, a stack escaped in JSON. Not marked: ordinary bodies.
  for (const [name, marked] of [['throws', true], ['invalidHeader', true], ['textStack', true], ['jsonStack', true], ['noStack', false], ['direct', false], ['large', false], ['chunks', false]]) {
    assert.equal(of(name).response.bodyHasStack, marked, `${name}: bodyHasStack ${marked}`);
  }
  assert.equal(decode(of('twice').response.body), 'first');
  assert.deepEqual(of('twice').response.afterEnd.map((entry) => [entry.op, entry.bytes]), [['end', null]], 'the second end is recorded, outside the body');
  assert.deepEqual([decode(of('twiceJson').response.body), of('twiceJson').response.status], ['{"answer":1}', 200]);
  assert.deepEqual(of('hub').effects, [{ kind: 'hub', channel: 'toy', payload: { type: 'toy.event', n: 1 } }, { kind: 'hub', channel: 'toy', payload: { type: 'toy.event', n: 2 } }]);
  const fetched = of('fetch').effects.filter((effect) => effect.kind === 'fetch');
  assert.equal(fetched.length, 1);
  assert.deepEqual([fetched[0].method, fetched[0].url, fetched[0].body.map(decode).join(''), fetched[0].response.status], ['POST', stubUrl, 'toy-outbound', 200]);
  assert.ok(fetched[0].body.length > 1, 'a body sent in several chunks is recorded whole');
  assert.ok(fetched[0].headers.some(([name, value]) => name.toLowerCase() === 'x-toy-out' && value === 'f'));
  const httpRequest = of('httpRequest').effects.find((effect) => effect.kind === 'http-request');
  assert.deepEqual([httpRequest.method, httpRequest.path, httpRequest.port, httpRequest.body.map(decode).join(''), httpRequest.response.status], ['POST', '/stub', stub.address().port, 'http-body', 200]);
  assert.ok(httpRequest.headers.some(([name, value]) => name.toLowerCase() === 'x-toy-out' && value === 'h'));
  const child = of('child').effects.find((effect) => effect.kind === 'child');
  assert.deepEqual([child.file, child.args[0], child.sync, child.stdin.bytes.map(decode).join(''), child.exit], [process.execPath, '-e', true, 'stdin-bytes', { code: 0, signal: null }]);
  assert.deepEqual([child.env.inherited, Object.keys(child.env.set), child.env.unset], [false, ['TOY_CHILD'], []]);
  assert.match(child.env.set.TOY_CHILD, /^sha256:[0-9a-f]{16}$/, 'environment values are written as digests');
  const childAsync = of('childAsync').effects.find((effect) => effect.kind === 'child');
  assert.deepEqual([childAsync.sync, childAsync.stdin.bytes.map(decode).join(''), childAsync.stdin.ended, childAsync.exit, childAsync.env.inherited], [false, 'async-stdin', true, { code: 0, signal: null }, false]);
  assert.deepEqual(Object.keys(childAsync.env.set), [], 'an inherited environment changes nothing');
  // The group's own parser refused the body; the edge's error handler wrote the answer.
  assert.deepEqual([of('malformed').kind, of('malformed').response.status, of('malformed').answeredBy.owner, of('malformed').response.bodyOrigins], ['group', 400, 'edge', ['edge']]);
  assert.deepEqual([of('useAnswers').kind, of('useAnswers').answeredBy.owner], ['group', 'group'], 'a use() middleware of the group is entered and answers');
  assert.deepEqual([of('usePasses').kind, of('usePasses').entered, of('usePasses').tail, of('usePasses').answeredBy.owner], ['group', true, true, 'tail'], 'what the group passes on reaches the tail stand-in, never compared');
  assert.deepEqual([of('factory').kind, of('factory').entry.registration.claimed, of('factory').answeredBy.owner], ['group', true, 'group']);
  assert.deepEqual([of('unclaimed').kind, of('unclaimed').entered], ['edge', false]);
  assert.equal(of('principal').entry.principal.scope, 'toy-scope', 'the principal as the group saw it');

  // A header the edge appends to after the group: the group's value, the final value, and each element's owner.
  const varyLarge = header(of('varyLarge'), 'vary');
  assert.deepEqual([varyLarge.value, varyLarge.group.value], ['Origin, Accept-Encoding', 'Origin']);
  assert.deepEqual(varyLarge.elements.map((element) => [element.value, `${element.owner.owner}:${element.owner.module ?? ''}`]), [['Origin', 'group:'], ['Accept-Encoding', 'edge:compression']]);
  assert.equal(header(of('varySmall'), 'vary').group.value, 'Origin');
  const cookies = of('cookies');
  assert.deepEqual(header(cookies, 'set-cookie').elements.map((element) => [element.value, element.owner.owner]), [['a=1', 'group'], ['b=2', 'group']]);
  assert.ok(cookies.response.ops.some((op) => op.op === 'removeHeader' && op.name === 'X-Robots-Tag' && op.origin.owner === 'group'), 'a removed edge header is recorded');
  assert.deepEqual([header(cookies, 'x-robots-tag').value, header(cookies, 'x-robots-tag').group], [null, { value: null, op: 'removeHeader' }], 'a header the group removed: absent at the end, removed by the group');
  assert.doesNotMatch(decode(of('invalidHeader').response.body) + decode(of('invalidHeader').response.wire), /tap\.mjs/);
  assert.equal(decode(of('chunks').response.body), 'abc', 'every write and the end chunk');
  assert.equal(Buffer.from(of('huge').response.body, 'base64').length, 256 * 1024, 'a body of many TCP writes, whole');
  assert.equal(Buffer.from(of('upload').request.body, 'base64').length, upload.length, 'a request body of many TCP reads, whole');
  assert.equal(of('upload').request.bodyComplete, true);
  const twiceCompressed = of('twiceCompressed');
  assert.equal(decode(twiceCompressed.response.body), JSON.stringify({ big: 'abcdefghij'.repeat(600) }), 'bytes after the group\'s end are not body');
  assert.deepEqual(twiceCompressed.response.afterEnd.map((entry) => [entry.op, decode(entry.bytes)]), [['end', 'EXTRA']]);
  assert.equal(decode(of('writeAfterEnd').response.body), 'x');
  assert.deepEqual(of('writeAfterEnd').response.afterEnd.map((entry) => [entry.op, decode(entry.bytes)]), [['write', 'late']]);
  assert.equal(of('abandoned').aborted, true, 'a response the client abandoned');
  assert.equal(of('direct').aborted, false);

  assert.ok(of('declared').declaredWork.length > 0);
  assert.ok(of('undeclared').pendingAtEnd.length > 0);
  assert.deepEqual([of('undeclared').effects, of('hubOverlap').effects.length], [[], 2], 'effects during an overlap go to the exchange that made them');
  const marks = (name) => [...of(name).blind, ...records.filter((entry) => entry.type === 'blind' && entry.seq === seqs[name])].map((mark) => mark.kind);
  assert.ok(marks('onFinish').includes('response-callback'), 'work from a response callback is marked blind');
  assert.ok(marks('busListener').includes('foreign-listener'), 'a listener on an emitter of no exchange is marked blind');
  assert.ok(marks('asyncResource').includes('async-resource'), 'an AsyncResource the group made is marked blind');
  assert.deepEqual(of('busEmit').crossed, [{ from: seqs.busListener, event: 'go' }], 'an effect of one exchange\'s listener under another is marked crossed');
  for (const name of ['direct', 'large', 'fetch', 'httpRequest', 'childAsync', 'hub', 'declared', 'timer', 'microtasks', 'gzip']) assert.deepEqual([of(name).blind, of(name).crossed], [[], []], `${name} has no blind mark`);
  const late = records.filter((entry) => entry.type === 'late');
  assert.deepEqual(late.filter((entry) => entry.effect.kind === 'hub').map((entry) => [entry.seq, entry.effect.payload?.type, entry.effect.payload?.items]), [[seqs.late, 'toy.late', undefined], [seqs.debounceA, 'toy.debounce', ['a', 'b']]], 'only the late publications are late; the debounced one is the first exchange\'s');
  assert.deepEqual(late.filter((entry) => !['hub', 'fetch'].includes(entry.effect.kind) || (entry.effect.kind === 'fetch' && entry.seq !== seqs.fetchLate)), [], 'no other late effect');
  // The record of an effect that finished after the response, completed by its effect-update records.
  const updates = records.filter((entry) => entry.type === 'effect-update');
  const completed = (name) => [
    ...of(name).effects.map((effect, index) => updates.filter((update) => update.seq === seqs[name] && update.list === 'effects' && update.index === index).reduce((_last, update) => update.effect, effect)),
    ...late.filter((entry) => entry.seq === seqs[name]).map((entry) => updates.filter((update) => update.list === 'late' && update.id === entry.id).reduce((_last, update) => update.effect, entry.effect)),
  ];
  const writtenChild = of('childLateExit').effects.find((effect) => effect.kind === 'child');
  assert.deepEqual([writtenChild.exit, writtenChild.finished], [null, false], 'written with the exchange before the child exited, and saying so');
  const lateChild = completed('childLateExit').find((effect) => effect.kind === 'child');
  assert.deepEqual([lateChild.exit, lateChild.finished, lateChild.stdin.bytes.map(decode).join(''), lateChild.stdin.ended], [{ code: 3, signal: null }, true, 'early-late', true], 'a child that exits 3 after the response');
  const lateFetch = completed('fetchLate').find((effect) => effect.kind === 'fetch');
  assert.deepEqual([lateFetch.body.map(decode).join(''), lateFetch.bodyEnded, lateFetch.response?.status, lateFetch.finished], ['early-late', true, 200, true], 'a fetch whose body ends and whose answer comes after the response');
  assert.equal(of('httpLate').effects.find((effect) => effect.kind === 'http-request')?.finished, false, 'written with the exchange before its answer');
  const lateHttp = completed('httpLate').find((effect) => effect.kind === 'http-request');
  assert.deepEqual([lateHttp.body.map(decode).join(''), lateHttp.bodyEnded, lateHttp.response?.status, lateHttp.finished], ['early-late', true, 200, true], 'an http.request whose body ends and whose answer comes after the response');
  const unendedEffect = completed('httpUnended').find((effect) => effect.kind === 'http-request');
  assert.deepEqual([unendedEffect.finished, unendedEffect.response, unendedEffect.bodyEnded], [false, null, false], 'an unanswered request never looks complete');
  for (const name of ['fetch', 'httpRequest', 'childAsync', 'child']) assert.ok(completed(name).filter((effect) => typeof effect.finished === 'boolean').every((effect) => effect.finished), `${name}: every effect finished`);
  assert.deepEqual(records.filter((entry) => entry.type === 'unattributed').map((entry) => entry.effect.payload?.type), ['toy.unattributed']);
  pass();
});

test('the group host refuses what it cannot host faithfully', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  // A tap set up for another group, no tap at all, a data root that is not private, an unknown variant.
  const otherSetup = run.writeFile('mismatch/tap-setup.json', JSON.stringify(tapSetupFor('toy', TOY_GROUPS.toy, { outDir: run.makeDirectory('mismatch/tap') })));
  const data = run.makeDirectory('mismatch/data');
  const openData = run.makeDirectory('mismatch/open-data');
  fs.chmodSync(openData, 0o755);
  const host = (dataRoot, env = process.env, tapped = true, extra = []) => runChild([...(tapped ? [`--import=${pathToFileURL(path.join(HERE, 'tap.mjs')).href}`] : []), path.join(HERE, 'group-host.mjs'), '--group=magic-prompts', `--data-root=${dataRoot}`, ...extra], { env });
  const withSetup = { ...process.env, DEVRYAN_BACKEND_TAP: otherSetup };
  const pilotSetup = run.writeFile('mismatch/pilot-setup.json', JSON.stringify(tapSetupFor('magic-prompts', GROUPS['magic-prompts'], { outDir: run.makeDirectory('mismatch/pilot-tap') })));
  const withPilotSetup = { ...process.env, DEVRYAN_BACKEND_TAP: pilotSetup };
  const [, , , mismatch, unarmed, open, badOption, variant] = await Promise.all([
    assert.rejects(startGroupHost({ run, name: 'toy-param', group: TOY_GROUPS['toy-param'], label: 'param', table: TOY_TABLE }),
      (error) => error.code === 1 && /param\(\) callback registered by a group file/.test(error.stderr)),
    // A route registered while the group's registrar ran, with no group frame on its stack: a registration problem, so the host refuses.
    // A composition that patches the framework's shared objects: the host refuses (no table can read that from the server's text).
    assert.rejects(startGroupHost({ run, name: 'toy-framework-patch', group: TOY_GROUPS['toy-framework-patch'], label: 'framework-patch', table: TOY_TABLE }),
      (error) => error.code === 1 && /changed express\.response\.json \(replaced\)/.test(error.stderr)),
    assert.rejects(startGroupHost({ run, name: 'toy-unattributed', group: TOY_GROUPS['toy-unattributed'], label: 'unattributed', table: TOY_TABLE }),
      (error) => error.code === 1 && /registered while the group's registrar ran was not attributed to the group/.test(error.stderr)),
    host(data, withSetup),
    host(data, process.env, false),
    host(openData, withPilotSetup),
    runChild([path.join(HERE, 'group-host.mjs'), '--group=magic-prompts', `--data-root=${data}`, '--listen=0.0.0.0:0'], { env: withSetup }),
    host(data, withPilotSetup, true, ['--variants=nope']),
  ]);
  assert.equal(mismatch.code, EXIT.refused, mismatch.stderr);
  assert.match(mismatch.stderr, /the tap is set up for group toy/);
  assert.equal(unarmed.code, EXIT.refused);
  assert.match(unarmed.stderr, /the tap is not armed/);
  assert.equal(open.code, EXIT.refused);
  assert.match(open.stderr, /--data-root must be an existing private canonical directory/);
  assert.equal(badOption.code, EXIT.refused);
  assert.match(badOption.stderr, /--listen and --control take 127\.0\.0\.1:<port>/);
  assert.equal(variant.code, EXIT.refused);
  assert.match(variant.stderr, /unknown variant nope/);
  pass();
});

// ------------------------------------------------------------------ BH1: the edge probes, on synthetic answers
test('each edge probe fails on answers that lack its layer, a threshold one byte off included', DEADLINE, async () => {
  const probe = (id) => EDGE_PROBES.find((entry) => entry.id === id);
  const answer = (headers = {}) => ({ status: 200, headers, body: Buffer.from('{}') });
  const good = { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache', 'x-robots-tag': 'noindex' };
  // Compression from `threshold` bytes, skipped for event streams unless `skips` is false.
  const compressing = (threshold, skips = true) => async (_method, url, init = {}) => {
    const size = Number(new URL(url, 'http://127.0.0.1').searchParams.get('n'));
    const stream = /text\/event-stream/.test(init.headers?.accept ?? '');
    return answer({ ...good, ...(size >= threshold && init.headers?.['accept-encoding'] === 'gzip' && !(stream && skips) ? { 'content-encoding': 'gzip' } : {}) });
  };
  assert.deepEqual(await probe('compression-threshold').run(compressing(1024)), []);
  for (const threshold of [1023, 1025, 8192]) assert.notDeepEqual(await probe('compression-threshold').run(compressing(threshold)), [], `threshold ${threshold}`);
  assert.deepEqual(await probe('compression-skip').run(compressing(1024)), []);
  assert.notDeepEqual(await probe('compression-skip').run(compressing(1024, false)), [], 'an event stream compressed');
  assert.notDeepEqual(await probe('compression-skip').run(compressing(Infinity)), [], 'nothing compressed at all');
  assert.deepEqual(await probe('no-store').run(async () => answer(good)), []);
  assert.notDeepEqual(await probe('no-store').run(async () => answer({ ...good, 'cache-control': 'public, max-age=60' })), [], 'cache-control without no-store');
  assert.notDeepEqual(await probe('no-store').run(async () => answer({ ...good, pragma: undefined })), [], 'no pragma');
  assert.deepEqual(await probe('indexing-policy').run(async () => answer(good)), []);
  assert.notDeepEqual(await probe('indexing-policy').run(async () => answer({ ...good, 'x-robots-tag': undefined })), [], 'no X-Robots-Tag');
});

// ------------------------------------------------------------------ the harmlessness judge, on fixed inputs
test('the harmlessness verdict reads vitest junit and counts lost tests and output differences', DEADLINE, () => {
  const xml = (status) => `<?xml version="1.0"?><testsuites><testsuite name="server/a.test.js" tests="2"><testcase classname="server/a.test.js" name="suite &gt; one" time="0.1"></testcase><testcase classname="server/a.test.js" name="suite &gt; two" time="0.2">${status}</testcase></testsuite></testsuites>`;
  const plain = parseVitestJunit(xml(''));
  assert.deepEqual(plain.map((entry) => [entry.file, entry.name, entry.status]), [['server/a.test.js', 'suite > one', 'passed'], ['server/a.test.js', 'suite > two', 'passed']]);
  const ok = harmlessnessVerdict({ plain: [{ tests: plain, output: 'x\n' }, { tests: plain, output: 'x\n' }], tapped: { tests: plain, output: 'x\n', tapFiles: 1, tapProcesses: 1, wrapped: 1 }, expectedFiles: ['server/a.test.js'] });
  assert.deepEqual([ok.differences, ok.incomplete], [[], []]);
  const failed = harmlessnessVerdict({ plain: [{ tests: plain, output: '' }, { tests: plain, output: '' }], tapped: { tests: parseVitestJunit(xml('<failure message="x"/>')), output: '', tapFiles: 1, tapProcesses: 1, wrapped: 1 }, expectedFiles: ['server/a.test.js'] });
  assert.equal(failed.differences.length, 1);
  const unarmed = harmlessnessVerdict({ plain: [{ tests: plain, output: '' }, { tests: plain, output: '' }], tapped: { tests: plain, output: '', tapFiles: 0, tapProcesses: 0, wrapped: 0 }, expectedFiles: ['server/a.test.js'], wraps: true });
  assert.ok(unarmed.incomplete.some((entry) => /the tap wrote no record/.test(entry.detail)));
  assert.ok(unarmed.incomplete.some((entry) => /wrapped no group handler/.test(entry.detail)));
  // A word two plain runs disagree on is learned between its prefix and suffix; a line with another difference is not masked.
  const spans = learnVaryingSpans(['Serving from /tmp/host-AbCdEf/dist', 'same'], ['Serving from /tmp/host-XyZwVu/dist', 'same']);
  assert.deepEqual(spans, [{ prefix: 'Serving from /tmp/host-', suffix: '/dist' }]);
  assert.deepEqual(maskVaryingSpans(['Serving from /tmp/host-QqQqQq/dist', 'Serving from /tmp/host-Qq Qq/dist', 'Serving from /tmp/host-Qq/other'], spans),
    { lines: ['Serving from /tmp/host-«varies»/dist', 'Serving from /tmp/host-Qq Qq/dist', 'Serving from /tmp/host-Qq/other'], masked: 1 });
  assert.deepEqual(learnVaryingSpans(['retry in 500ms'], ['retry in 500ms']), []);
  assert.deepEqual(learnVaryingSpans(['a completely different line'], ['nothing alike here at all']), []);
});
});
