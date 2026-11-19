// The pilot's scenarios against the real group host (BH2; full suite and CI
// only, by its name): every scenario of magic-prompts recorded on the
// reference arm, what the recordings say the group answered, and that a run
// made of them exits 2 with every row inconclusive and none passed.
//
// The assertions on answers pin facts the comparer (BH3) will compare against;
// they are the server's own answers today (the routes and runtime in
// packages/web/server/lib/magic-prompts/), so an edit of the group can fail
// this file, which is its purpose: the reference must be re-read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { referenceArm } from './arms.mjs';
import { AWAITING, interruptTeardown, liveGroups, rowsFromRecording, runScenario } from './driver.mjs';
import { GROUPS } from './groups.mjs';
import { judgeRun } from './outcomes.mjs';
import { createBackendRun } from './run-scratch.mjs';
import { PRINCIPALS, defineScenario, jsonBody, step } from './scenario.mjs';
import { READS_AND_WRITES, RESTARTS, WRITE_LOCK } from './scenarios/magic-prompts.mjs';
import { GROUPS as TOY_GROUPS } from './toy/toy-groups.mjs';
import { groupAlive } from './tree.mjs';

const DEADLINE = { timeout: 900_000 };
const TOY_TABLE = fileURLToPath(new URL('./toy/toy-groups.mjs', import.meta.url));
const GROUP = GROUPS['magic-prompts'];
const text = (base64) => Buffer.from(base64 ?? '', 'base64').toString('utf8');

async function record(t, scenario, { name = 'magic-prompts', group = GROUP, table = null, wrap = (arm) => arm, hooks = {} } = {}) {
  const run = createBackendRun({ owner: 'backend-conformance-pilot', signals: 'exit' });
  let status = 'failed';
  t.after(() => { try { run.finish(status); } catch { /* finished */ } });
  const arm = wrap(referenceArm({ run, name, group, table, label: 'reference' }));
  const recording = await runScenario({ scenario, arm, run, label: 'reference', hooks });
  for (const proc of recording.processes) assert.equal(groupAlive(proc.pgid), false, `the host's group ${proc.pgid} is gone`);
  const steps = Object.fromEntries(recording.steps.map((result) => [result.id, result]));
  const answer = (id, index = 0) => { const response = steps[id].exchanges[index].response; return { status: response.status, body: text(response.body) }; };
  return { recording, steps, answer, rows: rowsFromRecording(recording), pass: () => { status = 'passed'; } };
}
const problemsOf = (recording) => [recording.setup, ...recording.steps].flatMap((result) => result.problems.map((entry) => `${result.id}: ${entry.check}: ${entry.text}`));

describe('pilot scenarios on the reference arm', { concurrency: true, ...DEADLINE }, () => {
after(() => interruptTeardown());

test('reads and writes: every principal class, the value matrices, validation and the edge-answered cases', DEADLINE, async (t) => {
  const { recording, answer, rows, steps, pass } = await record(t, READS_AND_WRITES);
  // Expected recording problems: the managed principals (not producible here).
  const expected = (line) => /: principal-unavailable: /.test(line);
  assert.deepEqual(problemsOf(recording).filter((line) => !expected(line)), []);
  // A text/plain body the group answers before reading: a fact of the exchange (the driver sent the bytes), not a tap mark.
  assert.equal(steps['put-text-plain'].requestBodyUnread?.sentBytes, Buffer.byteLength('{"text":"plain"}'));
  assert.equal(answer('put-text-plain').status, 400);
  assert.deepEqual(answer('get-empty'), { status: 200, body: '{"version":1,"overrides":{}}' });
  assert.deepEqual(answer('put-visible'), { status: 200, body: '{"version":1,"overrides":{"git.pr.generate.visible":"Write the PR description."}}' });
  for (const [id, error] of [['put-id-161', 'Invalid prompt id'], ['put-id-upper', 'Invalid prompt id'], ['put-deprecated-1', 'Deprecated prompt id'], ['put-visible-blank', 'Visible prompt text cannot be empty'], ['put-text-200001', 'Prompt text is too long'], ['put-text-number', 'text is required'], ['put-body-array', 'text is required'], ['delete-invalid', 'Invalid prompt id']]) {
    assert.deepEqual(answer(id), { status: 400, body: JSON.stringify({ error }) }, id);
  }
  assert.equal(answer('put-id-160').status, 200);
  assert.equal(answer('put-text-200000').status, 200);
  // A space before the id is trimmed by the runtime: the trimmed id is stored.
  assert.match(answer('put-id-space').body, /"git\.pr\.generate\.instructions":"Write the PR description\."/);
  // Inputs a stricter parser would refuse reach the handler and are stored as given (design §4.2).
  assert.match(answer('put-text-lone-surrogate').body, /"git\.pr\.generate\.instructions":"\\ud800"/);
  assert.match(answer('put-duplicate-keys').body, /"git\.pr\.generate\.instructions":"b"/);
  assert.deepEqual(answer('put-text-2-53-plus-1'), { status: 400, body: '{"error":"text is required"}' });
  // Edge exchanges: the parser's answers and the tunnel boundary's refusals, never the group's.
  for (const id of ['put-body-null', 'put-malformed-json']) { assert.equal(answer(id).status, 400, id); assert.equal(steps[id].exchanges[0].tap.kind, 'edge', id); }
  for (const id of ['get-remote', 'put-remote']) { assert.equal(answer(id).status, 401, id); assert.equal(steps[id].exchanges[0].tap.kind, 'edge', id); }
  assert.deepEqual(answer('delete-all'), { status: 200, body: '{"version":1,"overrides":{}}' });
  // The group writes nothing under the arm's HOME (a tracked root like the data root).
  for (const result of recording.steps) for (const exchange of result.exchanges) if (exchange.s2) assert.deepEqual(exchange.s2.roots.home.entries, [], result.id);
  // Every group exchange the tap saw carried the local administrator the envelope names.
  for (const result of recording.steps) for (const exchange of result.exchanges) if (exchange.tap?.kind === 'group') assert.equal(exchange.tap.entry.principal.scope, 'local-admin');
  // Rows: recorded, awaiting comparison, or inconclusive with a named reason; none passed. Managed rows are waived by the table.
  assert.ok(rows.every((row) => row.outcome === 'inconclusive'));
  assert.equal(rows.filter((row) => row.awaiting === AWAITING).length, rows.length - 5);
  const waivers = Object.fromEntries(Object.entries(READS_AND_WRITES.waivers).map(([id, waiver]) => [`${READS_AND_WRITES.id}/${id}`, waiver]));
  const judged = judgeRun({ rows, waivers });
  assert.deepEqual([judged.exit, judged.verdict, judged.counts.passed, judged.counts.waived], [2, 'INCOMPLETE', 0, 5]);
  pass();
});

test('on the reference, a principal other than the envelope\'s and an edge expectation the tap contradicts are named', DEADLINE, async (t) => {
  // The toy group's /api/toy/principal path has a middleware that gives the principal another scope (toy/toy-groups.mjs).
  const scenario = defineScenario({ id: 'toy.reference-checks', group: 'toy', principals: { 'local-admin': PRINCIPALS['local-admin'] }, fixture: () => {},
    steps: () => [
      step.exchange('other-principal', { method: 'GET', target: '/api/toy/principal', principal: 'local-admin' }),
      step.exchange('said-edge', { method: 'GET', target: '/api/toy/direct', principal: 'local-admin', edge: true }),
      step.exchange('plain', { method: 'GET', target: '/api/toy/direct', principal: 'local-admin' }),
    ] });
  const { recording, rows, pass } = await record(t, scenario, { name: 'toy', group: TOY_GROUPS.toy, table: TOY_TABLE });
  assert.deepEqual([...new Set(problemsOf(recording).map((line) => line.split(': ').slice(0, 2).join(': ')))], ['other-principal: envelope', 'said-edge: edge-expectation']);
  // The other principal is a new object: its scope differs, its authorisation is not the edge's, and the store does not hold it.
  const texts = problemsOf(recording).filter((line) => line.startsWith('other-principal: envelope')).join('\n');
  for (const expected of [/saw principal .*toy-scope/, /does not confirm the envelope's authorizationActive/, /store does not hold the request's principal/]) assert.match(texts, expected);
  assert.deepEqual(rows.map((row) => [row.id, row.awaiting]), [['toy.reference-checks/other-principal', null], ['toy.reference-checks/said-edge', null], ['toy.reference-checks/plain', AWAITING]]);
  pass();
});

// The reference with one thing changed around it (the real host inside), so a check that only the reference's tap
// and admissible sets have can be made to fire: these checks exist only on an arm with a tap, which only the group host is.
const around = (arm, overrides) => Object.assign(Object.create(arm), overrides);
const MANAGED_ONLY = { outcome: 'inconclusive', checks: ['principal-unavailable'], reason: 'managed principals are not producible on the reference' };

test('the tap\'s records: a lost exchange is a correlation problem, a late record is a tap mark, and a waiver does not hide it', DEADLINE, async (t) => {
  const scenario = defineScenario({ id: 'magic-prompts.tap-records', group: 'magic-prompts', principals: { 'local-admin': PRINCIPALS['local-admin'], 'managed-admin': PRINCIPALS['managed-admin'] }, fixture: () => {},
    steps: () => [step.exchange('lost', { method: 'GET', target: '/api/magic-prompts', principal: 'local-admin' }), step.exchange('managed', { method: 'GET', target: '/api/magic-prompts', principal: 'managed-admin' }), step.exchange('plain', { method: 'GET', target: '/api/magic-prompts', principal: 'local-admin' })],
    waivers: { managed: MANAGED_ONLY } });
  let late = false;
  let at = null;
  const wrap = (arm) => around(arm, {
    // The tap's exchange record of the first exchange is lost; a late record appears (once, in place) while the managed step runs.
    records() {
      const kept = arm.records().filter((entry) => !(entry.type === 'exchange' && entry.seq === 1));
      if (late) at ??= kept.length;
      return at === null ? kept : [...kept.slice(0, at), { type: 'late', id: 'planted', seq: 1, site: 'the pilot test' }, ...kept.slice(at)];
    },
  });
  const { recording, rows, pass } = await record(t, scenario, { wrap, hooks: { beforeStep: ({ step: entry }) => { if (entry.id === 'managed') late = true; } } });
  assert.deepEqual(problemsOf(recording).map((line) => line.split(': ').slice(0, 2).join(': ')).sort(), ['lost: correlation', 'managed: principal-unavailable', 'managed: tap-marks']);
  const judged = judgeRun({ rows, waivers: { [`${scenario.id}/managed`]: MANAGED_ONLY } });
  assert.deepEqual([judged.rows.find((row) => row.id.endsWith('/managed')).waived, judged.exit], [null, 2]);
  assert.match(judged.problems.join('\n'), /covers only principal-unavailable, but the row also has tap-marks/);
  pass();
});

test('admissible sets: a concurrent result no order gives is not linearisable, and a tree that does not come back is a restore problem', DEADLINE, async (t) => {
  const scenario = defineScenario({ id: 'magic-prompts.admissible-checks', group: 'magic-prompts', principals: { 'local-admin': PRINCIPALS['local-admin'] }, fixture: () => {},
    steps: (v) => [step.concurrent('both', [['a', { method: 'PUT', target: '/api/magic-prompts/git.pr.generate.visible', headers: [['Content-Type', 'application/json']], body: jsonBody({ text: v.text('text.a', 'first writer') }), principal: 'local-admin' }],
      ['b', { method: 'PUT', target: '/api/magic-prompts/git.commit.generate.visible', headers: [['Content-Type', 'application/json']], body: jsonBody({ text: v.text('text.b', 'other writer') }), principal: 'local-admin' }]])] });
  let starts = 0;
  const wrap = (arm) => around(arm, {
    // Starts 2 and 3 run the serial orders: their first writer writes other text, so no order gives the concurrent result.
    // Start 4 follows the restore: a file planted before it, so the restored tree is not the concurrent one.
    async start(options) { starts += 1; if (starts === 4) fs.writeFileSync(path.join(options.dataRoot, 'planted-at-restore'), 'x'); return arm.start(options); },
    prepare: (request, meta) => arm.prepare(starts === 2 || starts === 3 ? { ...request, body: request.body && Buffer.from(request.body.toString('utf8').replace('first writer', 'serial writer')) } : request, meta),
  });
  const { recording, pass } = await record(t, scenario, { wrap });
  assert.deepEqual(problemsOf(recording).map((line) => line.split(': ').slice(0, 2).join(': ')).sort(), ['both: not-linearisable', 'both: restore']);
  pass();
});

test('the write lock: concurrent writes land in an order the reference produces one at a time', DEADLINE, async (t) => {
  const { recording, steps, rows, pass } = await record(t, WRITE_LOCK);
  assert.deepEqual(problemsOf(recording), []);
  for (const id of ['two-puts', 'put-and-delete']) {
    assert.equal(steps[id].admissible.length, 2, id);
    assert.ok(steps[id].admissible.every((serial) => serial.problems.length === 0 && serial.outcome), id);
    // Two orders, two different outcomes: both are admissible (design §5.6).
    assert.notEqual(steps[id].admissible[0].outcome, steps[id].admissible[1].outcome, id);
    // The members overlapped on the wire.
    assert.ok(steps[id].overlap.lastSent < steps[id].overlap.firstAnswer, JSON.stringify(steps[id].overlap));
  }
  // The seeded file's deprecated override is filtered on read.
  assert.equal(text(steps['get-seeded'].exchanges[0].response.body), '{"version":1,"overrides":{"git.commit.generate.visible":"seeded"}}');
  assert.ok(rows.every((row) => row.outcome === 'inconclusive' && row.awaiting === AWAITING));
  pass();
});

test('restarts and kills: state is read again at start, external edits are seen, and nothing of a killed host survives', DEADLINE, async (t) => {
  const { recording, steps, answer, rows, pass } = await record(t, RESTARTS);
  assert.deepEqual(problemsOf(recording), []);
  assert.match(answer('get-after-restart').body, /before the restart/);
  assert.match(answer('get-after-external').body, /written by someone else/);
  assert.deepEqual(answer('get-malformed-file'), { status: 200, body: '{"version":1,"overrides":{}}' });
  assert.match(answer('get-after-kill').body, /answered, then killed/);
  assert.equal(steps['kill-after-write'].nondeterministic, null);
  // Both kills were SIGKILL of the host's group, and the one at request-sent landed before any answer was read.
  for (const id of ['kill-after-write', 'kill-during-write']) assert.equal(steps[id].exchanges[0].exit.signal, 'SIGKILL', id);
  assert.equal(steps['kill-during-write'].exchanges[0].killedBeforeResponse, true);
  assert.match(steps['kill-during-write'].nondeterministic, /races the arm/);
  assert.deepEqual(answer('get-after-delete'), { status: 200, body: '{"version":1,"overrides":{}}' });
  // Four processes: the start, the restart and one after each kill; every group gone.
  assert.equal(recording.processes.length, 4);
  assert.ok(rows.every((row) => row.outcome === 'inconclusive' && row.awaiting === AWAITING));
  assert.deepEqual(liveGroups().filter((pgid) => recording.processes.some((proc) => proc.pgid === pgid)), []);
  pass();
});
});
