// The closure check's outcome order (BH4; fast, in memory, no process):
// closureRows on hand-made recordings of R, R', J and C, one row per step,
// each built to reach one branch of the order, and the rule that what the
// judged arm did is never hidden by an earlier class (S2 of the BH3/BH4
// review, with its two reproductions); the waiver and "one row passed"
// rules of the outcomes that depend on the rows' `judged` and `whole`; and
// the run's output after an interrupt.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { closureRows } from './closure.mjs';
import { interruptGate } from './conformance-run.mjs';
import { CANDIDATE_EFFECT_LIMIT } from './observe.mjs';
import { judgeRun, reportLines } from './outcomes.mjs';

const b64 = (text) => Buffer.from(text).toString('base64');
const T = 1_800_000_000_000;
const ROOTS = { R: '/private/var/h/r', R2: '/private/var/h/r2', J: '/private/var/h/j', C: '/private/var/h/c' };
const values = (arm) => ({ scenario: [], arm: [{ name: 'data-root', kind: 'path', value: ROOTS[arm], forms: { given: ROOTS[arm] } }, { name: 'home', kind: 'path', value: `${ROOTS[arm]}-home`, forms: { given: `${ROOTS[arm]}-home` } }] });
const tree = (at) => ({ entries: [], order: { '.': [] }, rootMode: 0o700, roots: { home: { entries: [], order: { '.': [] }, rootMode: 0o700 } }, stable: true, openByArm: [], takenAt: { start: at, end: at + 1 } });
const OBSERVED = { seenBy: ['path-shim', 'stubs', 'process-group'], events: null, outbound: [], children: [] };

/** One exchange record. `arm` R/R2 get a tap record; J and C are seen from outside. */
function record(arm, { status = 200, body = '{"ok":true}', edge = false, method = 'GET', requestBody = '', tap = {} } = {}) {
  const head = [['Content-Type', 'application/json; charset=utf-8'], ['Content-Length', String(Buffer.byteLength(body))], ['Date', new Date(T + 1).toUTCString()]];
  const requestHeaders = [['Host', '127.0.0.1:1'], ['Connection', 'close']];
  const response = { t0: T, t1: T + 5, status, headers: head, body: b64(body), complete: true, error: null, request: { method, target: '/api/x', headers: requestHeaders, bytes: b64(`${method} /api/x HTTP/1.1\r\n\r\n${requestBody}`) } };
  const out = { member: null, seq: 1, response, s1: tree(T + 10), s2: tree(T + 20), replaced: [], removed: [] };
  if (arm === 'R' || arm === 'R2') {
    out.tap = {
      kind: edge ? 'edge' : 'group', answeredBy: edge ? 'json-parser' : 'group',
      request: { body: b64(requestBody), bodyComplete: true },
      entry: { method, url: '/api/x', rawHeaders: requestHeaders.flat(), principal: null, context: null, bodyParsedByEdge: false, bodyConsumedBeforeEntry: false },
      response: { status, body: b64(body), headers: head.filter(([name]) => name !== 'Date').map(([name, value]) => ({ name, value, owner: { owner: 'group' }, group: { value } })) },
      effects: [],
      ...tap,
    };
  } else out.effects = OBSERVED;
  return out;
}
/** A recording of `arm` with `steps`: [id, { record options, problems, notSent, change(record) }]. */
function recording(arm, steps) {
  return {
    scenario: 's', arm: { role: arm.startsWith('R') ? 'reference' : 'candidate' }, values: values(arm), setup: { problems: [] }, start: tree(T - 10), edgeFiles: [], blobs: {},
    steps: steps.map(([id, spec = {}]) => {
      const exchange = spec.notSent ? { member: null, notSent: spec.notSent } : record(arm, spec);
      spec.change?.(exchange);
      return { id, kind: 'exchange', problems: spec.problems ?? [], exchanges: [exchange] };
    }),
  };
}
/** Rows for one step whose arms are specified separately (defaults: all equal, a group exchange). */
function rowOf({ r = {}, r2 = {}, j = {}, c = null }) {
  const { rows } = closureRows({ scenario: { id: 's' }, reference: recording('R', [['a', r]]), second: recording('R2', [['a', r2]]), js: recording('J', [['a', j]]), candidate: c ? recording('C', [['a', c]]) : null });
  return rows.find((row) => row.id === 's/a');
}
const outcome = (row) => [row.outcome, row.checks];
const died = [{ check: 'arm-died', text: 'the arm died' }];

describe('the closure check\'s outcome order', () => {
  test('each class in its order, a row of each', () => {
    assert.deepEqual(outcome(rowOf({ c: {} })), ['passed', []]);
    assert.deepEqual(outcome(rowOf({})), ['passed', []]);
    assert.deepEqual(outcome(rowOf({ r: { problems: [{ check: 'tap-marks', text: 'late record' }] } })), ['inconclusive', ['tap-marks']]);
    assert.deepEqual(outcome(rowOf({ r: { problems: [{ check: 'not-linearisable', text: 'x' }] } })), ['unrecordable', ['not-linearisable']]);
    // The unstable branch: R against R' differs.
    const unstable = rowOf({ r2: { body: '{"ok":false}' } });
    assert.deepEqual(outcome(unstable), ['unstable', ['unstable']]);
    assert.ok(unstable.differences.some((line) => /body \[bytes\]/.test(line)));
    assert.deepEqual(outcome(rowOf({ r2: { change: (item) => { item.s2 = { ...item.s2, stable: false }; } } })), ['inconclusive', ['stability-incomplete']]);
    assert.deepEqual(outcome(rowOf({ r: { edge: true }, r2: { edge: true }, j: { notSent: 'edge' }, c: { notSent: 'edge' } })), ['inconclusive', ['edge-exchange']]);
    assert.deepEqual(outcome(rowOf({ j: { problems: died } })), ['unrecordable', ['closure']]);
    assert.deepEqual(outcome(rowOf({ j: { body: '{"ok":0}' } })), ['unrecordable', ['closure']]);
    assert.deepEqual(outcome(rowOf({ j: { change: (item) => { item.effects = null; } } })), ['inconclusive', ['candidate-effects-unobserved']]);
    assert.deepEqual(outcome(rowOf({ c: { problems: died } })), ['failed', ['arm-died']]);
    assert.deepEqual(outcome(rowOf({ c: { status: 500 } })), ['failed', ['difference']]);
    assert.deepEqual(outcome(rowOf({ c: { problems: [{ check: 'deadline', text: 'slow' }] } })), ['inconclusive', ['deadline']]);
    assert.deepEqual(outcome(rowOf({ c: { change: (item) => { item.effects = null; } } })), ['inconclusive', ['candidate-effects-unobserved']]);
  });

  test('a candidate fault or difference fails the row whatever the class before it (the review\'s two reproductions)', () => {
    // 1. An edge step: the candidate has a death recorded on it and answered it with something: failed, never edge-exchange.
    const edge = rowOf({ r: { edge: true }, r2: { edge: true }, j: { notSent: 'edge' }, c: { status: 200, problems: died } });
    assert.equal(edge.outcome, 'failed');
    assert.ok(edge.checks.includes('arm-died') && edge.checks.includes('difference'), JSON.stringify(edge));
    assert.match(edge.reason, /before the judged arm was looked at, the row was inconclusive \(edge-exchange\)/);
    // 2. R against J not compared in full (a body something may have read), and the candidate answers with its own error.
    const partial = (item) => { item.tap.request.bodyComplete = false; item.tap.entry.bodyParsedByEdge = true; };
    const own = rowOf({ r: { method: 'PUT', requestBody: '{"a":1}', change: partial }, r2: { method: 'PUT', requestBody: '{"a":1}', change: partial }, j: { method: 'PUT', requestBody: '{"a":1}' }, c: { method: 'PUT', requestBody: '{"a":1}', status: 400, body: '{"error":"unsupported media type"}' } });
    assert.deepEqual(own.outcome, 'failed');
    assert.ok(own.differences.some((line) => / status \[bytes\]/.test(line)) && own.differences.some((line) => / body \[bytes\]/.test(line)), own.differences.join('\n'));
    // On an unstable row and on a row with a reference problem, too.
    assert.equal(rowOf({ r2: { body: '{"ok":false}' }, c: { status: 500 } }).outcome, 'failed');
    assert.equal(rowOf({ r: { problems: [{ check: 'tap-marks', text: 'x' }] }, c: { problems: died } }).outcome, 'failed');
    // J's fault on a row an earlier class left inconclusive: unrecordable, never the earlier class.
    assert.deepEqual(outcome(rowOf({ r: { edge: true }, r2: { edge: true }, j: { notSent: 'edge', change: () => {} }, c: null })), ['inconclusive', ['edge-exchange']]);
    const jEdge = rowOf({ r: { edge: true }, r2: { edge: true }, j: { notSent: 'edge' } });
    assert.deepEqual(jEdge.judged, { arm: 'js', differences: 0, faults: [] });
    const jDied = rowOf({ r: { problems: [{ check: 'tap-marks', text: 'x' }] }, j: { problems: died } });
    assert.deepEqual(outcome(jDied), ['unrecordable', ['closure', 'arm-died']]);
  });

  test('a waiver never covers a row with a difference or a fault of the judged arm; one passed row means one judged exchange', () => {
    const waivers = { 's/a': { outcome: 'inconclusive', reason: 'waived by the table', checks: ['edge-exchange'] } };
    const clean = { id: 's/a', outcome: 'inconclusive', checks: ['edge-exchange'], judged: { arm: 'candidate', differences: 0, faults: [] } };
    const passedRow = { id: 's/b', outcome: 'passed', checks: [] };
    assert.equal(judgeRun({ rows: [clean, passedRow], waivers }).exit, 0);
    for (const judged of [{ arm: 'candidate', differences: 2, faults: [] }, { arm: 'candidate', differences: 0, faults: ['arm-died'] }]) {
      const result = judgeRun({ rows: [{ ...clean, judged }, passedRow], waivers });
      assert.equal(result.exit, 2);
      assert.equal(result.rows[0].waived, null);
      assert.ok(result.problems.some((problem) => /cannot cover a row with/.test(problem)), result.problems.join('\n'));
    }
    // M4: the recording's own row passing is not a judged exchange.
    const whole = judgeRun({ rows: [{ id: 's/recording', outcome: 'passed', checks: [], whole: true }, clean], waivers });
    assert.deepEqual([whole.exit, whole.verdict], [2, 'NOTHING JUDGED']);
    const recordingRow = closureRows({ scenario: { id: 's' }, reference: recording('R', [['a']]), second: recording('R2', [['a']]), js: recording('J', [['a']]) }).rows.find((row) => row.id === 's/recording');
    assert.equal(recordingRow.whole, true);
  });

  test('the limit of what a candidate\'s observation cannot see is printed in every summary, with its count', () => {
    const lines = reportLines(judgeRun({ rows: [{ id: 's/a', outcome: 'passed', checks: [] }], limits: [{ ...CANDIDATE_EFFECT_LIMIT, count: 7, unit: 'candidate exchanges' }] }));
    assert.equal(lines.at(-2), `LIMIT candidate-effects-unseen (7 candidate exchanges): ${CANDIDATE_EFFECT_LIMIT.text}`);
    assert.match(CANDIDATE_EFFECT_LIMIT.text, /absolute path/);
    assert.match(CANDIDATE_EFFECT_LIMIT.text, /did not hand out/);
  });

  test('after an interrupt the run says so once and prints no summary', () => {
    const lines = [];
    const gate = interruptGate((line) => lines.push(line));
    gate.log('compared s: 2 rows: 2 passed');
    gate.interrupt('SIGTERM');
    gate.interrupt('SIGINT');
    gate.log('compared t: 5 rows: 5 unrecordable');
    gate.log('backend conformance: INCOMPLETE (5 rows ...)');
    assert.equal(gate.interrupted, 'SIGTERM');
    assert.deepEqual(lines, ['compared s: 2 rows: 2 passed', 'backend conformance: interrupted by SIGTERM; nothing recorded is judged, and no summary is printed']);
  });
});
