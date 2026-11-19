// Self-test of the scenario driver (BH2; docs/TESTING.md, "Backend route-group
// conformance harness"): the scenario format and the supplied-value registry,
// the driver against the fake candidate (the exact calls of every step kind,
// and each misbehaviour caught by its named check), the snapshot of a tree
// whose writer is frozen, the facts a walk records (modes, link targets,
// listing order), the driver's teardown under SIGINT, SIGTERM and SIGHUP and
// after SIGKILL (the keeper, and the next run's sweep), waivers that cover only
// the checks they name, and the rule that a recording never passes a row.
//
// Nothing here waits on a timer for an outcome: a deadline is used only where
// the fake never answers on purpose (it is the thing being shown), and every
// other wait is bounded by a deadline that names what did not answer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidateArm } from './arms.mjs';
import { killRecorded, recordFor } from './arm-groups.mjs';
import { onceFinished } from './child-finish.mjs';
import { runMain } from './conformance-run.mjs';
import { AWAITING, CANDIDATE_FAULTS, CHECKS, interruptTeardown, liveGroups, rowsFromRecording, runScenario } from './driver.mjs';
import { sseItems } from './http-exchange.mjs';
import { EXIT, judgeRun } from './outcomes.mjs';
import { createBackendRun, sweepKilledRuns } from './run-scratch.mjs';
import { HARNESS_HEADERS, PRINCIPALS, ScenarioError, createSuppliedValues, defineScenario, jsonBody, rawBody, step, validateSteps } from './scenario.mjs';
import { groupAlive, groupGone, groupMembers, holdDescriptors, openFilesUnder, signalGroup, snapshotTree, treeChanges, treeFingerprint, walkTree, whileFrozen } from './tree.mjs';
import { sigkillOnce } from './toy/sigkill-run.mjs';
import { ALL_KINDS, CUT_CLIENT, CUT_SERVER, ENDLESS, EXTERNAL_MISSING, KILL_HANG, KILL_LOSES, PUT_GET, RESTART, SHORT_STREAM, TRAILING } from './toy/toy-scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '../..');
const FAKE = path.join(HERE, 'toy/fake-candidate.mjs');
const DEADLINE = { timeout: 180_000 };

const runFor = (t) => {
  const run = createBackendRun({ owner: 'backend-conformance-driver-selftest', signals: 'exit' });
  let status = 'failed';
  t.after(() => { try { run.finish(status); } catch { /* finished by the test */ } });
  return { run, pass: () => { status = 'passed'; } };
};
const calls = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
/**
 * The fake on `scenario`, misbehaving as told; returns the recording, the fake's call log and the rows.
 * A test that fails or times out while this runs prints where the driver was: the scenario, the last
 * trace events, the arm's process group and state, and the fake's last calls.
 */
async function onFake(t, scenario, { misbehave = [], limits = {}, armLimits = {} } = {}) {
  const { run, pass } = runFor(t);
  const log = path.join(run.makeDirectory('fake-log'), 'calls.ndjson');
  const arm = candidateArm({ command: [process.execPath, FAKE], label: 'fake', env: { ...process.env, FAKE_CANDIDATE_LOG: log, FAKE_CANDIDATE_MISBEHAVE: misbehave.join(',') }, limits: { readyMs: 120_000, controlMs: 60_000, quiescentMs: 120_000, stopMs: 60_000, ...armLimits } });
  let seen = null;
  let finished = false;
  t.after(() => {
    if (finished || !seen) return;
    const pgid = seen.proc?.pgid;
    process.stderr.write(`driver self-test: ${scenario.id} (${misbehave.join(',') || 'no misbehaviour'}) did not finish; last trace ${JSON.stringify(seen.trace.slice(-12))}; arm group ${pgid ?? '(none)'} ${pgid ? JSON.stringify(groupMembers(pgid)) : ''}; the fake's last calls ${JSON.stringify(calls(log).slice(-5))}\n`);
  });
  const recording = await runScenario({ scenario, arm, run, label: 'fake', limits, hooks: { afterStart: ({ ctx }) => { seen = ctx; } } });
  finished = true;
  // Whatever happened, the driver left nothing running and holds nothing.
  for (const proc of recording.processes) { assert.equal(groupAlive(proc.pgid), false, `group ${proc.pgid} gone`); assert.ok(!liveGroups().includes(proc.pgid)); }
  return { recording, calls: calls(log), rows: rowsFromRecording(recording), pass };
}
const checksOf = (recording) => [...recording.steps, recording.setup].flatMap((result) => result.problems.map((entry) => `${result.id}:${entry.check}`));
const header = (raw, name) => { for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i].toLowerCase() === name.toLowerCase()) return raw[i + 1]; return undefined; };

describe('scenario driver self-test', { concurrency: true, ...DEADLINE }, () => {
after(() => interruptTeardown());

test('the scenario format refuses malformed scenarios and steps, naming each problem', DEADLINE, () => {
  assert.throws(() => defineScenario({ id: 'x', group: 'y', fixture: null, steps: null, principals: {} }), (error) => error instanceof ScenarioError && error.problems.length === 3);
  assert.throws(() => defineScenario({ id: 'g.a', group: 'g', fixture() {}, steps() {}, principals: { 'local-admin': { ...PRINCIPALS['local-admin'] } } }), /not a PRINCIPALS entry/);
  const scenario = defineScenario({ id: 'g.a', group: 'g', fixture() {}, steps() {}, principals: { 'local-admin': PRINCIPALS['local-admin'], 'remote-unauthenticated': PRINCIPALS['remote-unauthenticated'] }, waivers: { ghost: { outcome: 'inconclusive', checks: ['principal-unavailable'], reason: 'a reason long enough' } } });
  const as = { principal: 'local-admin' };
  const bad = [
    step.exchange('a', { method: 'GET', target: 'no-slash', ...as }),
    step.exchange('a', { method: 'G T', target: '/x', headers: [['X', 'a\nb']], ...as }),
    step.exchange('b', { method: 'GET', target: '/x', headers: [[HARNESS_HEADERS.seq, '1']], ...as }),
    step.exchange('c', { method: 'GET', target: '/x', principal: 'remote-unauthenticated' }),
    step.exchange('d', { method: 'GET', target: '/x', principal: 'managed-admin' }),
    step.concurrent('e', [['m', { method: 'GET', target: '/x', ...as }]]),
    step.killAfter('f', 'never', { method: 'GET', target: '/x', ...as }),
    step.external('g', { op: 'write', path: '../out', data: Buffer.from('x') }),
    step.streamBarrier('h', 'nothing', 1),
    step.streamOpen('i', 's', { method: 'GET', target: '/s', ...as }),
    step.restart('j'),
  ];
  let caught;
  try { validateSteps(scenario, bad); } catch (error) { caught = error; }
  assert.ok(caught instanceof ScenarioError);
  for (const expected of [/target must start with \//, /method "G T" is not a token/, /without line breaks/, /id appears twice/, /harness headers are the driver's/, /must be marked edge/, /principal "managed-admin" is not one of/, /2 or 3 members/, /kill point/, /plain relative path/, /stream nothing is not open/, /a restart while a stream is open/, /stream s is never closed/, /waiver ghost names no step/]) {
    assert.ok(caught.problems.some((entry) => expected.test(entry)), `${expected} in ${caught.problems.join('\n')}`);
  }
});

test('the supplied-value registry pairs by name and refuses ambiguity', DEADLINE, () => {
  const values = createSuppliedValues('test');
  assert.equal(values.id('a', 'alpha'), 'alpha');
  assert.equal(values.id('a', 'alpha'), 'alpha');
  assert.throws(() => values.id('a', 'beta'), /twice with different values/);
  assert.throws(() => values.id('b', 'alpha'), /a comparer could not pair them/);
  assert.equal(values.text('b', 'alpha'), 'alpha'); // another kind is another space
  assert.throws(() => values.supply('Bad Name', 'id', 'x'), /plain identifier/);
  assert.throws(() => values.port('p', '1'), /wrong type/);
  const root = fs.realpathSync(path.dirname(FAKE));
  values.path('root', root);
  assert.ok(values.list().find((entry) => entry.name === 'root').spellings.includes(encodeURIComponent(root)));
  assert.deepEqual(values.usedIn(Buffer.from('{"x":"alpha"}')).sort(), ['a', 'b']);
  values.close();
  assert.throws(() => values.id('c', 'gamma'), /after the registry was closed/);
});

test('every step kind against the fake: the driver\'s own sequence and the exact calls the arm receives', DEADLINE, async (t) => {
  const { recording, calls: received, rows, pass } = await onFake(t, ALL_KINDS);
  assert.deepEqual(checksOf(recording), [], JSON.stringify([recording.setup, ...recording.steps].flatMap((result) => result.problems.map((item) => `${result.id}:${item.check}: ${item.text.slice(0, 300)}`))));
  // §5.3 for one exchange, in order; then the next step's check.
  const at = (id) => recording.trace.indexOf(`step:${id}`);
  const slice = (from, to) => recording.trace.slice(at(from) + 1, at(to));
  const recheck = ['recheck', 'connect', 'freeze', 'recheck', 'thaw'];
  assert.deepEqual(slice('put', 'get-managed'), [...recheck, 'hold', 'send', 'response', 'freeze', 'S1', 'thaw', 'quiescent:1', 'freeze', 'S2', 'thaw', 'release']);
  assert.deepEqual(slice('both', 'edit'), [...recheck, 'hold', 'send', 'response', 'freeze', 'S1', 'thaw', 'quiescent:3', 'quiescent:4', 'freeze', 'S2', 'thaw', 'release']);
  assert.deepEqual(slice('edit', 'restart'), [...recheck, 'external:write', 'freeze', 'after', 'thaw']);
  assert.deepEqual(slice('restart', 'kill'), [...recheck, 'stop', 'gone', 'start', 'keep', 'freeze', 'started', 'thaw']);
  assert.deepEqual(slice('kill', 'open'), [...recheck, 'hold', 'send', 'response', 'kill', 'kill', 'gone', 'S1', 'release', 'start', 'keep', 'freeze', 'started', 'thaw']);
  assert.deepEqual(slice('open', 'barrier'), [...recheck, 'send']);
  assert.deepEqual(slice('barrier', 'end'), [...recheck, 'barrier:2', 'freeze', 'barrier', 'thaw']);
  assert.deepEqual(slice('end', 'quiet'), [...recheck, 'await-end', 'quiescent:6', 'freeze', 'S2', 'thaw']);
  assert.deepEqual(slice('quiet', 'look'), [...recheck, 'quiescent:6', 'freeze', 'quiescent', 'thaw']);
  assert.deepEqual(recording.trace.slice(at('look') + 1), [...recheck, 'freeze', 'snapshot', 'thaw', ...recheck, 'stop', 'gone', 'exit']);
  // The calls, process by process: what the arm was asked, in order (concurrent members in either order).
  const byProcess = [];
  for (const entry of received) { if (entry.event === 'start') byProcess.push([]); else if (entry.server) byProcess.at(-1).push(`${entry.server} ${entry.method} ${entry.url}${entry.server === 'listen' ? ` seq=${header(entry.headers, HARNESS_HEADERS.seq)}` : ''}`); }
  assert.equal(byProcess.length, 3);
  const [first, second, third] = byProcess;
  // Each claim is asked once after the exchange and once more at the next step (the next-step check).
  const both = first.slice(6, 8).sort();
  assert.deepEqual([...first.slice(0, 6), ...both, ...first.slice(8)], [
    'listen PUT /f/note seq=1', 'control GET /quiescent?seq=1', 'control GET /quiescent?seq=1',
    'listen GET /f/note seq=2', 'control GET /quiescent?seq=2', 'control GET /quiescent?seq=2',
    'listen PUT /f/a seq=3', 'listen PUT /f/b seq=4', 'control GET /quiescent?seq=3', 'control GET /quiescent?seq=4', 'control GET /quiescent?seq=4',
    'control POST /stop',
  ]);
  assert.deepEqual(second, ['listen PUT /f/k seq=5']);
  assert.deepEqual(third, ['listen GET /sse?n=2&end=1 seq=6', 'control GET /quiescent?seq=6', 'control GET /quiescent?seq=6', 'control GET /quiescent?seq=6', 'control GET /quiescent?seq=6', 'control POST /stop']);
  // The envelope a candidate gets is the scenario's principal, version 1, with the sequence number.
  const managed = received.find((entry) => entry.url === '/f/note' && entry.method === 'GET');
  const envelope = JSON.parse(Buffer.from(header(managed.headers, HARNESS_HEADERS.envelope), 'base64').toString('utf8'));
  assert.deepEqual(envelope, { v: 1, ...JSON.parse(JSON.stringify(PRINCIPALS['managed-developer'].envelope)), originalUrl: '/f/note', seq: 2 });
  // What was recorded: the tree before, during and after; descriptors; the external write; the stream's items.
  const steps = Object.fromEntries(recording.steps.map((result) => [result.id, result]));
  assert.equal(Buffer.from(steps.put.exchanges[0].response.body, 'base64').toString(), '{"written":10}');
  assert.deepEqual(steps.put.exchanges[0].s2.entries.map((entry) => entry.path), ['note', 'seed']);
  assert.deepEqual([steps.put.exchanges[0].replaced, steps.put.exchanges[0].removed], [[], []]);
  assert.deepEqual(treeChanges(steps.both.s1, steps.edit.tree), ['note']);
  assert.deepEqual(steps.barrier.items, ['data: 0', 'data: 1']);
  assert.deepEqual(steps.end.itemsToEnd, []);
  assert.ok(recording.values.scenario.some((entry) => entry.name === 'note' && entry.value === 'hello fake'));
  assert.ok(recording.values.arm.some((entry) => entry.name === 'listen.3'));
  assert.deepEqual(steps.put.exchanges[0].uses, ['note']);
  // The concurrent members overlapped on the wire; the kill was SIGKILL; HOME is a tracked root; the late window is named.
  assert.ok(steps.both.overlap.lastSent < steps.both.overlap.firstAnswer, JSON.stringify(steps.both.overlap));
  assert.deepEqual(steps.kill.exchanges[0].exit, { code: null, signal: 'SIGKILL' });
  assert.deepEqual(steps.put.exchanges[0].s2.roots.home, { entries: [], order: { '.': [] } });
  assert.equal(steps.put.lateUntil, 'get-managed');
  assert.equal(recording.steps.at(-1).lateUntil, '(the arm\'s exit)');
  // Every row is recorded and awaiting comparison; none passed.
  assert.equal(rows.length, ALL_KINDS.steps(createSuppliedValues('count')).length);
  for (const row of rows) assert.deepEqual([row.outcome, row.awaiting], ['inconclusive', AWAITING], row.id);
  pass();
});

test('each misbehaviour of the arm is caught by its named check', DEADLINE, async (t) => {
  const cases = [
    { name: 'a quiescence claim made before the write', scenario: PUT_GET, misbehave: ['early-quiescent'], expect: ['put:late-effect'] },
    { name: 'a write deferred to the next listen connection', scenario: PUT_GET, misbehave: ['late-listen'], expect: ['put:late-effect'] },
    // Deferred to the next request: it lands in that request's step, with that step's own effects; the driver
    // cannot tell them apart and says so (lateUntil); the evidence is in the snapshots, for the comparer.
    { name: 'a write deferred to the next request', scenario: PUT_GET, misbehave: ['late-request'], expect: [], after: ({ steps }) => {
      assert.equal(steps.put.lateUntil, 'get');
      assert.deepEqual(treeChanges(steps.put.exchanges[0].s2, steps.get.exchanges[0].s1), ['(listing order)', 'x']);
    } },
    { name: 'an arm that exits after a complete answer', scenario: PUT_GET, misbehave: ['exit-after-put'], expect: ['put:arm-died', 'get:arm-died'], outcomes: { put: 'failed', get: 'failed' } },
    { name: 'a quiet child that leaves the arm\'s process group', scenario: PUT_GET, misbehave: ['escape'], expect: ['(start):group-escaped'], outcomes: { put: 'inconclusive', get: 'inconclusive' }, after: ({ calls: received }) => {
      const pid = received.find((entry) => entry.event === 'escaped').pid;
      assert.throws(() => process.kill(pid, 0), /ESRCH/, `the escaped process ${pid} was killed when the arm stopped`);
    } },
    // SIGKILL, not a stop: the write the arm had not made by then is lost (a SIGTERM would let it flush).
    { name: 'a kill after the answer loses what the arm deferred', scenario: KILL_LOSES, misbehave: ['flush-on-term'], expect: [], after: ({ steps }) => {
      assert.deepEqual(steps.kill.exchanges[0].exit, { code: null, signal: 'SIGKILL' });
      assert.equal(steps.get.exchanges[0].response.status, 404);
      assert.ok(!steps.get.exchanges[0].s2.entries.some((entry) => entry.path === 'k'));
    } },
    // The request is never answered: the kill must land when it is written, before any answer.
    { name: 'a kill as soon as the request is written', scenario: KILL_HANG, misbehave: [], limits: { exchangeMs: 30_000 }, expect: [], after: ({ steps, recording }) => {
      assert.equal(steps.kill.exchanges[0].killedBeforeResponse, true, JSON.stringify(recording.trace));
      assert.equal(steps.kill.exchanges[0].response.complete, false);
      assert.deepEqual(steps.kill.exchanges[0].exit, { code: null, signal: 'SIGKILL' });
    } },
    // The second item never comes: the barrier waits for it (the deadline is the thing shown).
    { name: 'a barrier on an item that never comes', scenario: SHORT_STREAM, misbehave: [], limits: { barrierMs: 500 }, expect: ['barrier:deadline'] },
    { name: 'a stream the arm cuts off before the client closes it', scenario: CUT_CLIENT, misbehave: [], expect: ['close:stream-truncated'], outcomes: { close: 'failed' } },
    { name: 'a stream the arm cuts off, awaited to its end', scenario: CUT_SERVER, misbehave: [], expect: ['end:response-incomplete'] },
    // The harness's own step could not be done: said, and the next step still runs and is recorded.
    { name: 'an external change the tree does not allow', scenario: EXTERNAL_MISSING, misbehave: [], expect: ['gone:step-error'], after: ({ steps }) => { assert.equal(steps.get.exchanges[0].response.status, 404); } },
    { name: 'a claim naming another exchange', scenario: PUT_GET, misbehave: ['wrong-seq'], expect: ['put:claim-seq', 'put:claim-seq', 'get:claim-seq', 'get:claim-seq'] },
    { name: 'a descriptor kept after the claim', scenario: PUT_GET, misbehave: ['leak-descriptor'], expect: ['put:open-files', 'put:open-files', 'get:open-files', 'get:open-files'] },
    { name: 'a crash in the middle of a request', scenario: PUT_GET, misbehave: ['crash-on-put'], expect: ['put:response-incomplete', 'put:arm-died', 'get:arm-died'], outcomes: { put: 'failed', get: 'failed' } },
    { name: 'a write after the last step', scenario: PUT_GET, misbehave: ['write-at-exit'], expect: ['get:final-tree'] },
    { name: 'a process that survives a restart', scenario: RESTART, misbehave: ['survive-restart'], expect: ['restart:group-survived', 'restart:group-survived'] },
    { name: 'a stream with items after its barrier', scenario: TRAILING, misbehave: [], expect: ['close:stream-trailing'] },
    // The fake never ends this stream: the deadline names it, and the stream is still open at the end.
    { name: 'a stream that never ends', scenario: ENDLESS, misbehave: [], limits: { streamEndMs: 500 }, expect: ['end:deadline', 'open:stream-unclosed'] },
    { name: 'a claim that is not quiescent', scenario: PUT_GET, misbehave: ['claims-busy'], expect: ['put:quiescence', 'put:late-effect', 'get:quiescence', 'get:late-effect'] },
    { name: 'a stop that is ignored', scenario: RESTART, misbehave: ['ignore-stop'], armLimits: { stopMs: 500 }, expect: ['restart:stop-escalated', 'restart:stop-escalated'] },
    // The fake never answers, so the outcome does not depend on how short the deadline is.
    { name: 'a quiescence claim never answered', scenario: PUT_GET, misbehave: ['never-quiescent'], limits: { quiescentMs: 500 }, expect: ['put:deadline', 'put:deadline', 'get:deadline', 'get:deadline'], text: /the candidate's control answer to GET \/quiescent\?seq=1 within 500 ms/ },
  ];
  // The candidate's faults, stated here rather than read from the driver (a check taken out of the set must fail this test).
  const FAULTS = ['arm-start', 'arm-died', 'response-incomplete', 'claim-seq', 'quiescence', 'late-effect', 'final-tree', 'open-files', 'stream-trailing', 'stream-truncated', 'stop-escalated', 'group-survived', 'group-escaped'];
  assert.deepEqual([...CANDIDATE_FAULTS].sort(), [...FAULTS].sort());
  await Promise.all(cases.map(async (entry) => {
    const { recording, rows, calls: received, pass } = await onFake(t, entry.scenario, entry);
    const problems = () => `${entry.name}: ${JSON.stringify([recording.setup, ...recording.steps].flatMap((result) => result.problems.map((item) => `${result.id}:${item.check}: ${item.text.slice(0, 200)}`)), null, 1)}`;
    assert.deepEqual(checksOf(recording).sort(), [...entry.expect].sort(), problems());
    // On a candidate a row fails when one of its checks is the candidate's fault; otherwise it stays inconclusive.
    for (const row of rows.filter((item) => item.checks.length)) assert.equal(row.outcome, row.checks.some((check) => FAULTS.includes(check)) ? 'failed' : 'inconclusive', `${entry.name}: ${row.id}`);
    for (const [id, outcome] of Object.entries(entry.outcomes ?? {})) assert.equal(rows.find((row) => row.id.endsWith(`/${id}`)).outcome, outcome, `${entry.name}: row ${id}`);
    // A deadline names what did not answer.
    if (entry.text) assert.match(recording.steps[0].problems[0].text, entry.text);
    entry.after?.({ recording, steps: Object.fromEntries(recording.steps.map((result) => [result.id, result])), calls: received });
    pass();
  }));
});

test('a snapshot of a tree whose writer is frozen is stable, holds its open files, and the writer continues after', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const root = run.makeDirectory('writer');
  const writer = spawn(process.execPath, [path.join(HERE, 'toy/tree-writer.mjs'), root], { cwd: REPOSITORY_ROOT, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  // The writer is killed, and waited for, before the run root is removed (on every path).
  try {
    await new Promise((resolve, reject) => { writer.stdout.once('data', resolve); writer.once('exit', reject); });
    let inside;
    await whileFrozen(writer.pid, async () => {
      const members = groupMembers(writer.pid);
      assert.ok(members.length >= 1 && members.every((member) => member.state.startsWith('T')), JSON.stringify(members));
      const first = snapshotTree(root);
      const again = walkTree(root);
      inside = { first, again, open: openFilesUnder([writer.pid], [root]) };
    });
    assert.equal(inside.first.stable, true);
    assert.equal(treeFingerprint(inside.first), treeFingerprint(inside.again));
    assert.ok(inside.open.some((entry) => entry.file.endsWith(`${path.sep}held`)), JSON.stringify(inside.open));
    // Continued on every path: the writer is running again and the counter moves past what the frozen walk saw.
    assert.ok(groupMembers(writer.pid).every((member) => !member.state.startsWith('T')));
    const seen = inside.first.entries.find((entry) => entry.path === 'counter').sha256;
    const until = Date.now() + 60_000;
    while (snapshotTree(root).entries.find((entry) => entry.path === 'counter').sha256 === seen) {
      assert.ok(Date.now() < until, 'the writer did not continue within 60000 ms');
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    // A failing action still continues the group.
    await assert.rejects(whileFrozen(writer.pid, async () => { throw new Error('the walk failed'); }), /the walk failed/);
    assert.ok(groupMembers(writer.pid).every((member) => !member.state.startsWith('T')));
  } finally {
    try { signalGroup(writer.pid, 'SIGCONT'); signalGroup(writer.pid, 'SIGKILL'); } catch { /* gone */ }
    await groupGone(writer.pid);
  }
  pass();
});

test('a walk that sees the tree move is not a snapshot', DEADLINE, (t) => {
  const { run, pass } = runFor(t);
  const root = run.makeDirectory('moving');
  fs.writeFileSync(path.join(root, 'a'), '1');
  assert.equal(snapshotTree(root).stable, true);
  const moved = snapshotTree(root, { between: () => fs.writeFileSync(path.join(root, 'a'), '2') });
  assert.equal(moved.stable, false);
  assert.deepEqual(treeChanges(moved.firstWalk, moved), ['a']);
  pass();
});

test('held descriptors tell a file rewritten in place from one replaced or removed, and are all released', DEADLINE, (t) => {
  const { run, pass } = runFor(t);
  const root = run.makeDirectory('held');
  for (const name of ['same', 'swapped', 'gone']) fs.writeFileSync(path.join(root, name), name);
  const held = holdDescriptors([root]);
  assert.equal(held.size, 3);
  fs.writeFileSync(path.join(root, 'same'), 'rewritten');
  fs.writeFileSync(path.join(root, 'next'), 'new');
  fs.renameSync(path.join(root, 'next'), path.join(root, 'swapped'));
  fs.rmSync(path.join(root, 'gone'));
  assert.deepEqual(held.release(), { replaced: ['0:swapped'], removed: ['0:gone'] });
  assert.equal(held.size, 0);
  pass();
});

test('a walk records each entry\'s permission bits, link target and the listing order, and a change of any is a change', DEADLINE, (t) => {
  const { run, pass } = runFor(t);
  const root = run.makeDirectory('facts');
  fs.writeFileSync(path.join(root, 'file'), 'x', { mode: 0o600 });
  fs.symlinkSync('one', path.join(root, 'link'));
  const before = snapshotTree(root);
  const entry = (tree, name) => tree.entries.find((item) => item.path === name);
  assert.deepEqual([entry(before, 'file').mode, entry(before, 'link').target, entry(before, 'link').type], [0o600, 'one', 'symlink']);
  fs.chmodSync(path.join(root, 'file'), 0o640);
  assert.deepEqual(treeChanges(before, snapshotTree(root)), ['file']);
  assert.equal(entry(snapshotTree(root), 'file').mode, 0o640);
  const chmodded = snapshotTree(root);
  fs.rmSync(path.join(root, 'link'));
  fs.symlinkSync('two', path.join(root, 'link'));
  assert.deepEqual(treeChanges(chmodded, snapshotTree(root)), ['link']);
  // The same entries listed in another order: only the order changed.
  const listed = snapshotTree(root);
  const reordered = { ...listed, order: { ...listed.order, '.': [...listed.order['.']].reverse() } };
  assert.deepEqual(treeChanges(listed, reordered), ['(listing order)']);
  // Another tracked root is compared too, its paths named with the root's name.
  const home = run.makeDirectory('facts-home');
  const both = snapshotTree(root, { others: { home } });
  fs.writeFileSync(path.join(home, 'h'), 'h');
  assert.deepEqual(treeChanges(both, snapshotTree(root, { others: { home } })), ['home:(listing order)', 'home:h']);
  pass();
});

test('a waiver covers only the checks it names: any other problem on the row keeps it open', DEADLINE, () => {
  const waiver = { outcome: 'inconclusive', checks: ['principal-unavailable'], reason: 'managed principals are not producible here' };
  const row = (checks) => ({ id: 'g.s/managed', outcome: 'inconclusive', checks, differences: [] });
  const waived = judgeRun({ rows: [row(['principal-unavailable'])], waivers: { 'g.s/managed': waiver } });
  assert.equal(waived.rows[0].waived, waiver.reason);
  // The reviewer's case: a late tap record landing on a managed row.
  const late = judgeRun({ rows: [row(['principal-unavailable', 'tap-marks'])], waivers: { 'g.s/managed': waiver } });
  assert.deepEqual([late.rows[0].waived, late.exit, late.verdict], [null, EXIT.incomplete, 'INCOMPLETE']);
  assert.match(late.problems.join('\n'), /covers only principal-unavailable, but the row also has tap-marks/);
  assert.throws(() => defineScenario({ id: 'g.a', group: 'g', fixture() {}, steps() {}, principals: {}, waivers: { a: { outcome: 'inconclusive', reason: 'a reason long enough' } } }), /names no checks/);
});

test('after SIGKILL of the harness no arm and no keeper survives: by the keeper alone, and by the next run\'s sweep without it', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  // Each killed run in a parent of its own: no other run (of this test or anyone's) sweeps it first.
  const parents = () => run.makeDirectory(`sigkill-${Math.random().toString(36).slice(2)}`);
  const results = await Promise.all(['hang', 'frozen', 'restart'].flatMap((mode) => [false, true].map((keeperToo) => sigkillOnce({ mode, keeperToo, parent: parents() }))));
  for (const result of results) {
    const where = `${result.mode}${result.keeperToo ? ' (keeper killed too)' : ''}: ${result.describe}`;
    if (result.mode !== 'hang') assert.equal(result.frozenAtKill, true, `${where}: the arm was frozen when the harness was killed`);
    if (!result.keeperToo) assert.equal(result.groupGoneAlone, true, where);
    // Without the keeper the frozen arm is still stopped: only the sweep can end it.
    if (result.keeperToo && result.mode !== 'hang') assert.equal(result.frozenAfterKill, true, where);
    assert.deepEqual([result.groupsAfterSweep, result.runAfterSweep, result.keepersAlive], [[], false, []], where);
  }
  pass();
});

test('the sweep never signals a recorded process that is no longer the one recorded', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e8);', 'sweep-identity-probe'], { stdio: 'ignore', detached: true });
  try {
    await new Promise((resolve, reject) => { other.once('spawn', resolve); other.once('error', reject); });
    const record = recordFor({ kind: 'arm', pid: other.pid, pgid: other.pid, marker: 'sweep-identity-probe' });
    // Another start time, or another command line: not ours, never signalled.
    assert.equal(killRecorded({ ...record, start: 'Thu Jan  1 00:00:00 1970' }), 'not-ours');
    assert.equal(killRecorded({ ...record, marker: 'some other process' }), 'not-ours');
    // A killed run whose record names it with the wrong start time: the directory goes, the process stays.
    const parent = run.makeDirectory('sweep-parent');
    const dead = path.join(parent, 'run-dead');
    fs.mkdirSync(path.join(dead, 'process-groups'), { recursive: true });
    fs.writeFileSync(path.join(dead, 'harness-pid'), '999999\n');
    fs.writeFileSync(path.join(dead, 'run.json'), JSON.stringify({ status: 'running' }));
    fs.writeFileSync(path.join(dead, 'process-groups', '1-arm.json'), JSON.stringify({ ...record, start: 'Thu Jan  1 00:00:00 1970' }));
    assert.deepEqual(sweepKilledRuns(parent), [dead]);
    assert.ok(groupAlive(other.pid), 'the unrelated process was not signalled');
    // The same record with the true start time: killed, then the directory removed.
    fs.mkdirSync(path.join(dead, 'process-groups'), { recursive: true });
    fs.writeFileSync(path.join(dead, 'harness-pid'), '999999\n');
    fs.writeFileSync(path.join(dead, 'run.json'), JSON.stringify({ status: 'running' }));
    fs.writeFileSync(path.join(dead, 'process-groups', '1-arm.json'), JSON.stringify(record));
    assert.deepEqual(sweepKilledRuns(parent), [dead]);
    // Bounded: a sweep that kills nothing must fail here, not hang the file (the process is killed in finally).
    const exited = await new Promise((resolve) => { if (other.exitCode !== null || other.signalCode !== null) { resolve(true); return; } const timer = setTimeout(() => resolve(false), 60_000); other.once('exit', () => { clearTimeout(timer); resolve(true); }); });
    assert.ok(exited && other.signalCode === 'SIGKILL', `the sweep did not kill the recorded process ${other.pid} within 60000 ms`);
  } finally { try { process.kill(-other.pid, 'SIGKILL'); } catch { /* gone */ } }
  pass();
});

test('the driver\'s teardown leaves no process and no scratch on SIGINT, SIGTERM and SIGHUP, mid-exchange or frozen', DEADLINE, async () => {
  const one = (signal, mode) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'toy/driver-child.mjs'), mode], { cwd: REPOSITORY_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = '';
    let waiting = null;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // On any failure the arm's group is continued and killed here, so a failed test leaves no frozen arm behind.
    const started = [];
    const cleanUp = () => { for (const pgid of started) { try { signalGroup(pgid, 'SIGCONT'); signalGroup(pgid, 'SIGKILL'); } catch { /* gone */ } } };
    // A child that never finishes is asked with SIGTERM first (its own teardown runs), then killed.
    const killer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); cleanUp(); }, 30_000).unref(); reject(new Error(`${signal}/${mode}: the child did not finish within 120000 ms\n${stderr}`)); }, 120_000);
    child.stdout.on('data', async (chunk) => {
      buffered += chunk;
      let line = null;
      while (!waiting && buffered.includes('\n')) {
        line = JSON.parse(buffered.slice(0, buffered.indexOf('\n')));
        buffered = buffered.slice(buffered.indexOf('\n') + 1);
        if (line.started) started.push(line.started.pgid);
        if (line.waiting) waiting = line.waiting;
      }
      if (!waiting || line?.waiting !== waiting) return;
      // Mid-exchange: the never-answered request has reached the arm.
      const until = Date.now() + 60_000;
      while (mode === 'hang' && !calls(waiting.log).some((entry) => entry.url === '/hang')) {
        if (Date.now() > until) { cleanUp(); reject(new Error('the hang request never reached the fake')); return; }
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      if (mode === 'frozen') assert.ok(groupMembers(waiting.pgid).every((member) => member.state.startsWith('T')));
      // The keeper is killed first: what is left must be cleaned by the driver's own teardown, not by the keeper.
      if (waiting.keeper) { try { process.kill(waiting.keeper, 'SIGKILL'); } catch { /* gone */ } }
      child.kill(signal);
    });
    onceFinished(child, async (code, childSignal) => {
      clearTimeout(killer);
      try {
        assert.ok(waiting, `${signal}/${mode}: the child never reached its waiting point (${code ?? childSignal})\n${stderr}`);
        await groupGone(waiting.pgid, { deadlineMs: 60_000 });
        assert.equal(fs.existsSync(waiting.run), false, `${signal}/${mode}: the run directory was removed`);
        resolve({ signal, mode, code });
      } catch (error) { cleanUp(); reject(error); }
    });
  });
  const results = await Promise.all(['SIGINT', 'SIGTERM', 'SIGHUP'].flatMap((signal) => ['hang', 'frozen'].map((mode) => one(signal, mode))));
  assert.equal(results.length, 6);
});

test('a recording never passes a row, and a run with recorded rows exits 2', DEADLINE, async () => {
  const recording = { scenario: 'g.s', arm: { role: 'reference' }, setup: { problems: [] }, steps: [
    { id: 'clean', problems: [], exchanges: [{ seq: 1 }] },
    { id: 'late', problems: [{ check: 'late-effect', text: 'x' }], exchanges: [{ seq: 2 }] },
    { id: 'stack', problems: [{ check: 'body-has-stack', text: 'x' }], exchanges: [{ seq: 3 }] },
    { id: 'managed', problems: [{ check: 'principal-unavailable', text: 'x' }], exchanges: [{ notSent: 'x' }] },
    { id: 'edge', problems: [], exchanges: [{ notSent: 'edge' }] },
  ] };
  const rows = rowsFromRecording(recording);
  assert.deepEqual(rows.map((row) => [row.id, row.outcome, row.awaiting]), [['g.s/clean', 'inconclusive', AWAITING], ['g.s/late', 'inconclusive', null], ['g.s/stack', 'unrecordable', null], ['g.s/managed', 'inconclusive', null], ['g.s/edge', 'inconclusive', null]]);
  const candidate = rowsFromRecording({ ...recording, arm: { role: 'candidate' } });
  assert.deepEqual(candidate.map((row) => row.outcome), ['inconclusive', 'failed', 'unrecordable', 'inconclusive', 'inconclusive']);
  for (const check of new Set(Object.keys(CHECKS))) {
    const single = rowsFromRecording({ ...recording, steps: [{ id: 'one', problems: [{ check, text: 'x' }], exchanges: [] }] });
    assert.notEqual(single[0].outcome, 'passed', check);
  }
  // Through the run: recorded rows exit 2; a waiver of an awaiting row is refused (CLI) or dropped as a gap (table).
  const lines = [];
  const base = { env: process.env, log: (line) => lines.push(line), error: (line) => lines.push(line), checkComposition: async () => [] };
  const produced = { rows: rows.slice(0, 1), waivers: {} };
  assert.equal(await runMain({ ...base, argv: ['--group=magic-prompts'], produceRows: async () => produced }), EXIT.incomplete);
  assert.match(lines.at(-1), /INCOMPLETE \(1 rows: 0 passed, 0 failed, 1 inconclusive/);
  assert.equal(await runMain({ ...base, argv: ['--group=magic-prompts', '--allow-inconclusive=g.s/clean'], produceRows: async () => produced }), EXIT.refused);
  assert.ok(lines.some((line) => /names a row awaiting comparison/.test(line)));
  assert.equal(await runMain({ ...base, argv: ['--group=magic-prompts'], produceRows: async () => ({ rows: rows.slice(0, 1), waivers: { 'g.s/clean': { outcome: 'inconclusive', reason: 'a stale waiver' } } }) }), EXIT.incomplete);
  assert.match(lines.at(-1), /1 census gaps/);
  assert.equal(await runMain({ ...base, argv: ['--group=magic-prompts', '--scenario=ghost'], produceRows: async ({ options }) => ({ rows: [], waivers: {}, gaps: options.scenarios.map((id) => `no ${id}`) }) }), EXIT.incomplete);
});

test('server-sent events are read item by item; the HTTP reader decodes chunked bodies', DEADLINE, () => {
  assert.deepEqual(sseItems(Buffer.from('data: a\n\ndata: b\r\n\r\ndata: c')), { items: ['data: a', 'data: b'], rest: 'data: c' });
  // The rest of the reader is exercised by every exchange above (content-length, chunked SSE, close-delimited, HEAD-less bodies).
  assert.ok(jsonBody({ a: 1 }).bytes.equals(Buffer.from('{"a":1}')) && rawBody(Buffer.from([0xff])).bytes[0] === 0xff);
});
});
