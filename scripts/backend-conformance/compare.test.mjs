// The comparer's self-test (BH3; fast, in memory, no process): hand-made
// pairs of recordings for every rule of design §7 and every check of §8.1,
// each pair differing in exactly one thing and reported by its named rule and
// component; the archived attempt's false passes (§1.1) as cases; and pairs
// that must compare equal (the same value under other roots, ports, ids,
// inodes and times). It imports nothing but the comparer, so the comparer's
// planted-fault test can run a copy of the two files alone.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';
import {
  RULES, allOf, compareRecordings, createPairing, createSubstitution, dateInWindow, dateLagOf, deepDifference, labelTimes, weakEtagOf, writersOf,
} from './compare.mjs';

// ------------------------------------------------------------------ builders
const b64 = (text) => Buffer.from(text).toString('base64');
const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
const T0 = 1_800_000_000_000;
/** An arm: its roots and port; R and C differ in every supplied value. */
const ARMS = {
  R: { root: '/private/var/h/run-1/reference/data', home: '/private/var/h/run-1/reference/home', port: 41001, t: T0 },
  C: { root: '/private/var/h/run-1/candidate/data', home: '/private/var/h/run-1/candidate/home', port: 52002, t: T0 + 50_000 },
};
const armValues = (arm) => [
  { name: 'data-root', kind: 'path', value: arm.root, forms: { given: arm.root, canonical: arm.root, alias: arm.root.replace(/^\/private/, '') } },
  { name: 'home', kind: 'path', value: arm.home, forms: { given: arm.home, canonical: arm.home, alias: arm.home.replace(/^\/private/, '') } },
  { name: 'listen.1', kind: 'port', value: arm.port },
];
/** A file entry and its bytes. */
const file = (filePath, text, { mode = 0o644, ino = 1, mtimeMs } = {}) => ({ entry: { path: filePath, type: 'file', mode, size: Buffer.byteLength(text), ino, mtimeMs, sha256: sha(text) }, text });
/** A snapshot of the data root (and an empty HOME) at `at`, from file specs. */
const tree = (at, files = [], { order, links = [] } = {}) => {
  const entries = [...files.map((spec) => ({ ...spec.entry, mtimeMs: spec.entry.mtimeMs ?? at - 1 })), ...links];
  return { entries, order: order ?? { '.': entries.map((entry) => entry.path) }, roots: { home: { entries: [], order: { '.': [] } } }, stable: true, openByArm: [], takenAt: { start: at, end: at + 1 } };
};
const blobsOf = (...trees) => Object.fromEntries(trees.flat().filter(Boolean).flatMap((spec) => (spec.entry && spec.text !== undefined ? [[spec.entry.sha256, b64(spec.text)]] : [])));

const GROUP_JSON = [['Content-Type', 'application/json; charset=utf-8']];
/**
 * One exchange on one arm. `side`: 'reference' gets a tap record (the group's
 * view) and the client's view of the whole head; 'candidate' the client's view.
 * `group` headers are [name, value] the group wrote; `edge` [name, value, module] the edge added.
 */
function exchange(side, arm, spec, t) {
  const { status = 200, group = GROUP_JSON, edge = [], body = '{"ok":true}', method = 'GET', target = '/api/x', requestBody = '', effects = [], transport, clientHeaders, requestHeaders } = spec;
  const bytes = Buffer.from(body);
  const groupHeaders = [...group, ...(spec.contentLength === false ? [] : [['Content-Length', String(spec.contentLengthValue ?? bytes.length)]])];
  const head = side === 'reference'
    ? [['X-Powered-By', 'Express'], ...groupHeaders, ...edge.map(([name, value]) => [name, value]), ['Date', new Date(t + 1).toUTCString()], ['Connection', 'close']]
    : [...groupHeaders, ...(transport ?? [['Date', new Date(t + 1).toUTCString()], ['Connection', 'close']])];
  const reqHeaders = requestHeaders ?? [['Host', `127.0.0.1:${arm.port}`], ['Connection', 'close'], ...(requestBody ? [['Content-Length', String(Buffer.byteLength(requestBody))]] : [])];
  const sentHeaders = side === 'candidate' ? [...reqHeaders, ['X-DevRyan-Harness-Seq', '1']] : reqHeaders;
  const response = {
    t0: t, t1: t + 5, status, headers: clientHeaders ?? head, body: b64(body), complete: spec.complete ?? true, error: spec.error ?? null,
    request: { method, target, headers: sentHeaders, bytes: b64(`${method} ${target} HTTP/1.1\r\n${sentHeaders.map(([n, v]) => `${n}: ${v}`).join('\r\n')}\r\n\r\n${requestBody}`) },
  };
  const record = { member: spec.member ?? null, seq: 1, response, replaced: spec.replaced ?? [], removed: spec.removed ?? [] };
  // A candidate is observed from outside (observe.mjs); `candidateEffects: null` is an arm that was not.
  if (side === 'candidate') record.effects = spec.candidateEffects === undefined ? { seenBy: ['path-shim', 'stubs', 'process-group'], events: [], outbound: [], children: [] } : spec.candidateEffects;
  if (side === 'reference') {
    const owner = (who, module = null) => ({ owner: who, module });
    record.tap = {
      kind: spec.edgeAnswered ? 'edge' : 'group',
      request: { body: b64(spec.tapRequestBody ?? requestBody), bodyComplete: spec.tapBodyComplete ?? true },
      entry: { method, url: target, rawHeaders: reqHeaders.flat(), principal: { id: 'local-admin' }, context: null },
      response: {
        status,
        body: b64(body),
        headers: [
          { name: 'X-Powered-By', value: 'Express', owner: owner('edge', 'before-entry'), group: null },
          ...groupHeaders.map(([name, value]) => (name.toLowerCase() === 'vary' || name.toLowerCase() === 'cache-control'
            ? { name, value, owner: owner('group'), group: { value, op: 'setHeader' }, elements: value.split(',').map((element) => ({ value: element.trim(), owner: owner('group') })) }
            : { name, value, owner: owner('group'), group: { value, op: 'setHeader' } })),
          ...edge.map(([name, value, module]) => ({ name, value, owner: owner('edge', module), group: null, ...(name.toLowerCase() === 'vary' ? { elements: [{ value, owner: owner('edge', module) }] } : {}) })),
          { name: 'Date', value: 'x', owner: owner('node', 'http'), group: null },
          { name: 'Connection', value: 'close', owner: owner('node', 'http'), group: null },
        ],
      },
      effects,
    };
  }
  return record;
}
/** A scenario's recording on one arm: `steps` are [id, { ...exchange spec, s1, s2 }] for exchange steps, or full step objects. */
function recording(side, armName, steps, { start = [], exit = null, extraBlobs = [], values } = {}) {
  const arm = ARMS[armName];
  const out = { scenario: 'toy.compare', arm: { role: side }, values: values ?? { scenario: [{ name: 'text.a', kind: 'text', value: 'hello' }], arm: armValues(arm) }, steps: [], edgeFiles: side === 'reference' ? ['multi-user-vault.json'] : [] };
  const files = [...start, ...extraBlobs];
  out.start = tree(arm.t - 10, start);
  let t = arm.t;
  for (const [id, spec] of steps) {
    if (spec.kind && spec.kind !== 'exchange') { out.steps.push({ id, problems: [], exchanges: [], ...spec }); continue; }
    const record = exchange(side, arm, { ...spec, ...(typeof spec.body === 'function' ? { body: spec.body(arm) } : {}), ...(typeof spec.group === 'function' ? { group: spec.group(arm) } : {}) }, t);
    const s1 = spec.s1 ? tree(t + 10, spec.s1(arm, t)) : tree(t + 10, []);
    const s2 = spec.s2 ? tree(t + 20, spec.s2(arm, t)) : { ...s1, takenAt: { start: t + 20, end: t + 21 } };
    files.push(...(spec.s1 ? spec.s1(arm, t) : []), ...(spec.s2 ? spec.s2(arm, t) : []));
    record.s1 = s1;
    record.s2 = s2;
    out.steps.push({ id, kind: 'exchange', problems: [], exchanges: [record] });
    t += 100;
  }
  out.exitTree = exit ? tree(t + 50, exit(arm, t)) : null;
  out.blobs = blobsOf(files);
  return out;
}
const compare = (reference, other, { mode = 'candidate', declarations = {} } = {}) => compareRecordings({ reference, other, mode, declarations });
const differences = (result) => allOf(result, 'differences');
const inconclusive = (result) => allOf(result, 'inconclusive');
/** Exactly one kind of difference: by component (prefix) and rule. */
function assertOnly(result, component, rule) {
  const found = differences(result);
  assert.ok(found.length > 0, `expected a difference at ${component} [${rule}], found none`);
  for (const difference of found) assert.ok(difference.component.startsWith(component) && difference.rule === rule, `unexpected difference ${JSON.stringify(difference)} (expected only ${component} [${rule}])`);
  assert.deepEqual(inconclusive(result), []);
}
const assertEqual = (result) => { assert.deepEqual(differences(result), []); assert.deepEqual(inconclusive(result), []); };
const pair = (steps, candidateSteps = steps, options = {}) => [recording('reference', 'R', steps, options), recording('candidate', 'C', candidateSteps, options.candidate ?? options)];

// ------------------------------------------------------------------ tests
describe('the comparer', () => {
  test('every rule of design §7 has a description, and equal recordings under other roots, ports and times compare equal', () => {
    for (const rule of ['supplied', 'paired', 'time-window', 'etag', 'inode', 'last-writer', 'listing-order', 'bytes', 'null-undefined-absent', 'headers', 'edge-files', 'concurrency', 'stream', 'effects', 'request', 'steps', 'log-lines']) assert.ok(RULES[rule], rule);
    const store = (arm, t) => [file('magic-prompts.json', '{"a":1}', { ino: arm.port, mtimeMs: t + 3 })];
    const steps = [['get', {}], ['put', { method: 'PUT', target: '/api/x/a', requestBody: '{"text":"hello"}', body: '{"a":1}', s1: store, s2: store }]];
    assertEqual(compare(...pair(steps)));
    // A second reference: every component, inside and outside.
    assertEqual(compare(recording('reference', 'R', steps), recording('reference', 'C', steps), { mode: 'stability' }));
  });

  // ---------------------------------------------------------------- rule S
  test('rule S: a supplied root is substituted in every spelling, and only where it stands whole', () => {
    const message = (spelling) => (arm) => JSON.stringify({ error: `ENOENT: no such file or directory, open '${spelling(arm)}/magic-prompts.json'` });
    // Equal: each arm's own root, as given; the firmlink alias; URL-encoded.
    for (const spelling of [(arm) => arm.root, (arm) => arm.root.replace(/^\/private/, ''), (arm) => encodeURIComponent(arm.root)]) assertEqual(compare(...pair([['get', { body: message(spelling) }]])));
    // The candidate writes the other spelling than the reference did: the bytes differ.
    const [reference] = pair([['get', { body: message((arm) => arm.root.replace(/^\/private/, '')) }]]);
    const [, canonical] = pair([], [['get', { body: message((arm) => arm.root) }]]);
    assertOnly(compare(reference, canonical), 'body', 'bytes');
    // A value that merely contains the root as text is never rewritten: compared as is, so it differs.
    for (const near of [(arm) => `${arm.root}base`, (arm) => `${arm.root}.tmp`, (arm) => `/x${arm.root}`]) {
      const result = compare(...pair([['get', { body: (arm) => JSON.stringify({ path: near(arm) }) }]]));
      assertOnly(result, 'body', 'bytes');
    }
    // The reference's root hard-coded by the candidate is not the candidate's root.
    const [r2] = pair([['get', { body: (arm) => JSON.stringify({ path: arm.root }) }]]);
    const [, hardCoded] = pair([], [['get', { body: () => JSON.stringify({ path: ARMS.R.root }) }]]);
    assertOnly(compare(r2, hardCoded), 'body', 'bytes');
    // A path outside every supplied root is compared as is (equal when equal).
    assertEqual(compare(...pair([['get', { body: '{"path":"/usr/lib"}' }]])));
  });

  test('rule S: substitution units (boundaries, ports, conflicts, a shared root)', () => {
    const substitution = createSubstitution(armValues(ARMS.R), armValues(ARMS.C));
    const apply = (text) => substitution.apply(Buffer.from(text)).toString();
    assert.equal(apply(`${ARMS.R.root}/a and ${ARMS.R.root}`), `${ARMS.C.root}/a and ${ARMS.C.root}`);
    assert.equal(apply(`file://${ARMS.R.root}/a`), `file://${ARMS.C.root}/a`);
    assert.equal(apply(`${ARMS.R.root}data`), `${ARMS.R.root}data`);
    assert.equal(apply(`http://127.0.0.1:${ARMS.R.port}/x`), `http://127.0.0.1:${ARMS.C.port}/x`);
    assert.equal(apply(`n=${ARMS.R.port}0 :${ARMS.R.port}1`), `n=${ARMS.R.port}0 :${ARMS.R.port}1`);
    assert.deepEqual(substitution.problems, []);
    assert.match(createSubstitution(armValues(ARMS.R), armValues(ARMS.R)).problems.join(), /share a root/);
    const shared = compare(recording('reference', 'R', [['get', {}]]), recording('candidate', 'R', [['get', {}]]));
    assert.ok(inconclusive(shared).some((item) => /share a root/.test(item.why)));
  });

  // ---------------------------------------------------------------- rule P
  test('rule P: identifiers at a declared key are paired by position, one to one, and never from one side alone', () => {
    const declarations = { identifierKeys: ['id'] };
    const steps = (ids) => [['create', { body: JSON.stringify({ id: ids[0] }) }], ['read', { body: JSON.stringify({ items: [{ id: ids[0], name: 'n' }], last: ids[0] }) }]];
    assertEqual(compare(recording('reference', 'R', steps(['a1b2'])), recording('candidate', 'C', steps(['zz99'])), { declarations }));
    // A conflict: the reference's a1b2 is paired with zz99, then the candidate shows yy88 at the same place.
    const conflict = compare(recording('reference', 'R', steps(['a1b2'])), recording('candidate', 'C', [['create', { body: '{"id":"zz99"}' }], ['read', { body: '{"items":[{"id":"yy88","name":"n"}],"last":"zz99"}' }]]), { declarations });
    assert.ok(differences(conflict).some((difference) => difference.rule === 'paired' && difference.component === 'identifier'), JSON.stringify(differences(conflict)));
    // Undeclared place: no pairing, so a different value is a difference.
    assertOnly(compare(recording('reference', 'R', [['create', { body: '{"token":"a1b2"}' }]]), recording('candidate', 'C', [['create', { body: '{"token":"zz99"}' }]]), { declarations }), 'body', 'bytes');
    // A value only the candidate has is never learned: an extra identifier is a difference.
    assertOnly(compare(recording('reference', 'R', [['create', { body: '{"other":1}' }]]), recording('candidate', 'C', [['create', { body: '{"other":1,"id":"zz99"}' }]]), { declarations }), 'body', 'bytes');
    // A pair used once is reported.
    const once = compare(recording('reference', 'R', [['create', { body: '{"id":"a1b2"}' }]]), recording('candidate', 'C', [['create', { body: '{"id":"zz99"}' }]]), { declarations });
    assert.ok(once.notes.some((note) => /a1b2 was seen once/.test(note)));
    const pairing = createPairing({ keys: ['id'] });
    pairing.align({ id: 'a' }, { id: 'b' });
    pairing.align({ id: 'c' }, { id: 'b' });
    assert.equal(pairing.conflicts.length, 1);
  });

  // ---------------------------------------------------------------- rule W
  test('rule W: times by window and rank; a time outside every window is compared as is', () => {
    const declarations = { timeKeys: ['createdAt', 'updatedAt'] };
    const body = (offsetA, offsetB) => (arm) => JSON.stringify({ createdAt: arm.t + offsetA, updatedAt: arm.t + offsetB });
    // Each arm's own window: equal, though the numbers differ.
    assertEqual(compare(...pair([['put', { body: body(1, 2) }]]), { declarations }));
    // Equal times stay equal, ordered times stay ordered.
    assertEqual(compare(...pair([['put', { body: body(2, 2) }]]), { declarations }));
    assertOnly(compare(...pair([['put', { body: body(1, 2) }]], [['put', { body: body(2, 1) }]]), { declarations }), 'body', 'bytes');
    assertOnly(compare(...pair([['put', { body: body(1, 2) }]], [['put', { body: body(2, 2) }]]), { declarations }), 'body', 'bytes');
    // A time from the previous exchange's window (the candidate's first exchange is at t, its second at t + 100).
    const stale = compare(...pair([['a', {}], ['b', { body: (arm) => JSON.stringify({ updatedAt: arm.t + 101 }) }]], [['a', {}], ['b', { body: (arm) => JSON.stringify({ updatedAt: arm.t + 1 }) }]]), { declarations });
    assertOnly(stale, 'body', 'bytes');
    // Outside every window: compared as is.
    assertEqual(compare(...pair([['a', { body: '{"updatedAt":5}' }]]), { declarations }));
    assertOnly(compare(...pair([['a', { body: '{"updatedAt":5}' }]], [['a', { body: '{"updatedAt":6}' }]]), { declarations }), 'body', 'bytes');
    // Undeclared keys are never windowed (no pattern: a 13-digit number under any key is a value).
    assertOnly(compare(...pair([['a', { body: (arm) => JSON.stringify({ at: arm.t + 1 }) }]])), 'body', 'bytes');
    const labelled = labelTimes(Buffer.from('{"updatedAt":105}'), { keys: ['updatedAt'], windows: [{ label: 'w', start: 100, end: 110 }] });
    assert.equal(labelled.buffer.toString(), '{"updatedAt":<time w #1 of 1>}');
  });

  test('rule W: the Date header falls in its exchange\'s window', () => {
    assert.equal(dateInWindow(new Date(T0 + 1).toUTCString(), { t0: T0, t1: T0 + 5 }), true);
    assert.equal(dateInWindow(new Date(T0 - 5_000).toUTCString(), { t0: T0, t1: T0 + 5 }), false);
    // Without a measured lag the Date names the second of t0 or later: the previous second never passes, even 1 ms in.
    assert.equal(dateInWindow(new Date(T0 - 1_000).toUTCString(), { t0: T0 + 1, t1: T0 + 5 }), false);
    assert.equal(dateInWindow(new Date(T0 - 1_000).toUTCString(), { t0: T0, t1: T0 + 5 }), false);
    assert.equal(dateInWindow(new Date(T0).toUTCString(), { t0: T0 + 999, t1: T0 + 1_005 }), true);
    // Node's cached Date names the previous second for as long as its refresh is late: within the measured lag, never beyond it.
    assert.equal(dateInWindow(new Date(T0 - 1_000).toUTCString(), { t0: T0 + 1, t1: T0 + 5 }, 2), true);
    assert.equal(dateInWindow(new Date(T0 - 1_000).toUTCString(), { t0: T0 + 2, t1: T0 + 5 }, 2), false);
    assert.equal(dateInWindow(new Date(T0 - 1_000).toUTCString(), { t0: T0 + 40, t1: T0 + 50 }, 41), true);
    assert.equal(dateInWindow(new Date(T0 - 2_000).toUTCString(), { t0: T0 + 1, t1: T0 + 5 }, 900), false);
    // A measured lag over a second (a loop frozen under load) reaches back one second at most: never two.
    assert.equal(dateInWindow(new Date(T0 - 2_000).toUTCString(), { t0: T0, t1: T0 + 5 }, 1_700), false);
    assert.equal(dateInWindow(new Date(T0 - 1_000).toUTCString(), { t0: T0 + 998, t1: T0 + 1_005 }, 1_700), true);
    assert.equal(dateInWindow(new Date(T0 + 1_000).toUTCString(), { t0: T0, t1: T0 + 5 }, 900), false, 'a Date after t1 never passes');
    assert.equal(dateInWindow('not a date', { t0: T0, t1: T0 + 5 }, 900), false);
    assert.equal(dateInWindow(new Date(T0).toUTCString(), { t0: T0, t1: T0 + 5 }, -1), false, 'a lag is never negative');
    // The reference's measured lag (recording.dateLagMs) is the candidate's bound; without one the candidate gets none.
    const stale = [['Date', new Date(ARMS.C.t - 1_000).toUTCString()], ['Connection', 'close']];
    const [lagless, staleCandidate] = pair([['a', {}]], [['a', { transport: stale }]]);
    assertOnly(compare(lagless, staleCandidate), 'headers.date', 'time-window');
    assert.equal(dateLagOf(lagless), 0);
    assertEqual(compare({ ...lagless, dateLagMs: 1 }, staleCandidate));
    assertEqual(compareRecordings({ reference: lagless, other: staleCandidate, mode: 'candidate', dateLagMs: 1 }));
    assertOnly(compareRecordings({ reference: { ...lagless, dateLagMs: 1 }, other: staleCandidate, mode: 'candidate', dateLagMs: 0 }), 'headers.date', 'time-window');
    // Two seconds stale is beyond any lag the window takes (it is under a second).
    const older = [['Date', new Date(ARMS.C.t - 2_000).toUTCString()], ['Connection', 'close']];
    assertOnly(compare({ ...lagless, dateLagMs: 999 }, pair([['a', {}]], [['a', { transport: older }]])[1]), 'headers.date', 'time-window');
    const late = [['Date', new Date(ARMS.C.t + 60_000).toUTCString()], ['Connection', 'close']];
    assertOnly(compare(...pair([['a', {}]], [['a', { transport: late }]])), 'headers.date', 'time-window');
    // Connection is framing (not compared); the presence of Date is a rule (M2 of the BH3/BH4 review).
    assertEqual(compare(...pair([['a', {}]], [['a', { transport: [['Date', new Date(ARMS.C.t + 1).toUTCString()]] }]])));
    assertOnly(compare(...pair([['a', {}]], [['a', { transport: [] }]])), 'headers.date', 'headers');
  });

  // ---------------------------------------------------------------- headers, ETag, status, body
  test('headers: by name case-insensitively, each line exactly, extra and missing, Content-Length, an edge-only header from a candidate', () => {
    const etag = [...GROUP_JSON, ['ETag', 'W/"7-abc"']];
    assertEqual(compare(...pair([['a', { group: etag }]], [['a', { group: [['content-type', 'application/json; charset=utf-8'], ['etag', 'W/"7-abc"']] }]])));
    assertOnly(compare(...pair([['a', { group: etag }]], [['a', { group: GROUP_JSON }]])), 'headers.etag', 'headers');
    assertOnly(compare(...pair([['a', {}]], [['a', { group: [...GROUP_JSON, ['X-Cache', 'miss']] }]])), 'headers.x-cache', 'headers');
    assertOnly(compare(...pair([['a', {}]], [['a', { group: [...GROUP_JSON, ['Content-Encoding', 'gzip']] }]])), 'headers.content-encoding', 'headers');
    assertOnly(compare(...pair([['a', {}]], [['a', { group: [['Content-Type', 'application/json; charset=UTF-8']] }]])), 'headers.content-type', 'headers');
    // Within a name, order counts.
    assertOnly(compare(...pair([['a', { group: [...GROUP_JSON, ['Link', 'a'], ['Link', 'b']] }]], [['a', { group: [...GROUP_JSON, ['Link', 'b'], ['Link', 'a']] }]])), 'headers.link', 'headers');
    // Content-Length must be the body's length.
    assertOnly(compare(...pair([['a', {}]], [['a', { contentLengthValue: 99 }]])), 'headers.content-length', 'headers');
    assertOnly(compare(...pair([['a', {}]], [['a', { contentLength: false }]])), 'headers.content-length', 'headers');
    // The envelope echoed in a response header is a header the group did not set.
    assertOnly(compare(...pair([['a', {}]], [['a', { group: [...GROUP_JSON, ['X-DevRyan-Harness-Envelope', 'e30=']] }]])), 'headers.x-devryan-harness-envelope', 'headers');
  });

  test('headers per element with their owner: the edge\'s elements are not the group\'s', () => {
    // The edge (compression) adds Vary: Accept-Encoding; the group sets nothing: a candidate sends no Vary.
    assertEqual(compare(...pair([['a', { edge: [['Vary', 'Accept-Encoding', 'compression']] }]], [['a', {}]])));
    // A candidate that sends the edge's element as its own fails.
    assertOnly(compare(...pair([['a', { edge: [['Vary', 'Accept-Encoding', 'compression']] }]], [['a', { group: [...GROUP_JSON, ['Vary', 'Accept-Encoding']] }]])), 'headers.vary', 'headers');
    // The group's own element is expected.
    assertEqual(compare(...pair([['a', { group: [...GROUP_JSON, ['Vary', 'Origin']] }]])));
    assertOnly(compare(...pair([['a', { group: [...GROUP_JSON, ['Cache-Control', 'no-cache, private']] }]], [['a', { group: [...GROUP_JSON, ['Cache-Control', 'private, no-cache']] }]])), 'headers.cache-control', 'headers');
    // In stability mode the owners themselves are compared.
    const reference = recording('reference', 'R', [['a', { edge: [['Vary', 'Accept-Encoding', 'compression']] }]]);
    const second = recording('reference', 'C', [['a', { edge: [['Vary', 'Accept-Encoding', 'compression']] }]]);
    second.steps[0].exchanges[0].tap.response.headers.find((summary) => summary.name === 'Vary').elements[0].owner = { owner: 'group', module: null };
    assert.ok(differences(compare(reference, second, { mode: 'stability' })).some((difference) => difference.component.startsWith('headers')));
  });

  test('ETag exactly (never by length), status, and body bytes with offset and JSON path', () => {
    const etag = (value) => [...GROUP_JSON, ['ETag', value]];
    assertOnly(compare(...pair([['a', { group: etag('W/"7-abc"') }]], [['a', { group: etag('W/"7-abd"') }]])), 'headers.etag', 'etag');
    // Over a body that holds a supplied value the ETag cannot be compared: inconclusive, never passed.
    const holding = (arm) => JSON.stringify({ path: arm.root });
    const result = compare(...pair([['a', { group: etag('W/"1-x"'), body: holding }]], [['a', { group: etag('W/"1-y"'), body: holding }]]));
    assert.deepEqual(differences(result), []);
    assert.ok(inconclusive(result).some((item) => item.component === 'headers.etag'));
    // Unless each side's ETag is Express's weak ETag of its own body (the reference's checked to be): compared as that function.
    const weak = (arm) => etag(weakEtagOf(Buffer.from(holding(arm))));
    const own = compare(...pair([['a', { group: weak, body: holding }]]));
    assert.deepEqual(differences(own), []);
    assert.equal(inconclusive(own).some((item) => item.component === 'headers.etag'), false);
    // Two references whose bodies hold their own roots, each with its body's weak ETag: equal (the owners' list too).
    const references = ['R', 'C'].map((name) => recording('reference', name, [['a', { group: weak, body: holding }]]));
    assert.deepEqual(differences(compare(references[0], references[1], { mode: 'stability' })), []);
    // The candidate sends the reference's ETag (not its own body's), or a strong one: a difference.
    for (const other of [() => etag(weakEtagOf(Buffer.from(holding(ARMS.R)))), (arm) => etag(weakEtagOf(Buffer.from(holding(arm))).slice(2))]) assertOnly(compare(...pair([['a', { group: weak, body: holding }]], [['a', { group: other, body: holding }]])), 'headers.etag', 'etag');
    assertOnly(compare(...pair([['a', { status: 400 }]], [['a', { status: 422 }]])), 'status', 'bytes');
    const body = compare(...pair([['a', { body: '{"version":1,"overrides":{}}' }]], [['a', { body: '{"version":1,"override":{}}' }]]));
    assertOnly(body, 'body', 'bytes');
    assert.match(differences(body)[0].location, /byte 22, JSON \$\.overrides/);
    // Key order, whitespace, a type change: bytes.
    for (const other of ['{"overrides":{},"version":1}', '{"version": 1,"overrides":{}}', '{"version":"1","overrides":{}}']) assertOnly(compare(...pair([['a', { body: '{"version":1,"overrides":{}}' }]], [['a', { body: other }]])), 'body', 'bytes');
    // Error text exactly.
    assertOnly(compare(...pair([['a', { status: 500, body: '{"error":"ENOENT: no such file or directory"}' }]], [['a', { status: 500, body: '{"error":"No such file or directory (os error 2)"}' }]])), 'body', 'bytes');
  });

  test('null, undefined and absent are kept apart, and so are 3 and "3"', () => {
    assert.ok(deepDifference({ a: null }, {}));
    assert.ok(deepDifference({ a: undefined }, {}));
    assert.ok(deepDifference({ a: null }, { a: undefined }));
    assert.ok(deepDifference([3], ['3']));
    assert.equal(deepDifference({ a: [1, { b: null }] }, { a: [1, { b: null }] }), null);
    assert.match(deepDifference({ a: null }, {}).reference, /^null/);
    assert.equal(deepDifference({ a: null }, {}).candidate, 'absent');
    const events = (payload) => [['a', { effects: [{ kind: 'hub', channel: 'plans', payload }], candidateEffects: { events: [{ channel: 'plans', payload }], outbound: [], children: [] } }]];
    const [reference] = pair(events({ x: null }));
    const [, candidate] = pair([], events({}));
    assertOnly(compare(reference, candidate, { declarations: { effects: ['events'] } }), 'events[0]', 'effects');
  });

  test('the request a candidate was given is the request the group received', () => {
    assertOnly(compare(...pair([['a', { method: 'PUT', requestBody: '{"text":"a"}', tapRequestBody: '{"text":"b"}' }]], [['a', { method: 'PUT', requestBody: '{"text":"a"}' }]])), 'request.body', 'request');
    assertOnly(compare(...pair([['a', { target: '/api/x/a' }]], [['a', { target: '/api/x/b' }]])), 'request.url', 'request');
    // The group answered before the body ended: not confirmed, inconclusive.
    const [reference, candidate] = pair([['a', { method: 'PUT', requestBody: 'plain', tapBodyComplete: false }]]);
    reference.steps[0].requestBodyUnread = { seq: 1, sentBytes: 5, seenByTap: 5 };
    const result = compare(reference, candidate);
    assert.deepEqual(differences(result), []);
    assert.ok(inconclusive(result).some((item) => item.component === 'request.body'));
  });

  // ---------------------------------------------------------------- files
  test('files: type, mode, bytes, link target, extra and missing, replaced or rewritten in place; never inode or time values', () => {
    const store = (spec = {}) => (arm, t) => [file('p.json', spec.text ?? '{"a":1}', { mode: spec.mode ?? 0o644, ino: spec.ino ?? arm.port, mtimeMs: t + 3 })];
    const steps = (spec, extra = {}) => [['put', { method: 'PUT', s1: store(spec), s2: store(spec), ...extra }]];
    assertEqual(compare(...pair(steps({}), steps({ ino: 7 }))));
    assertOnly(compare(...pair(steps({}), steps({ mode: 0o600 }))), 'tree.p.json.mode', 'inode');
    assertOnly(compare(...pair(steps({}), steps({ text: '{"a":2}' }))), 'tree.p.json.bytes', 'bytes');
    assertOnly(compare(...pair(steps({}), steps({ text: '{\n    "a": 1\n}' }))), 'tree.p.json.bytes', 'bytes');
    assertOnly(compare(...pair(steps({}), steps({}, { replaced: ['0:p.json'] }))), 'tree.p.json.replaced', 'inode');
    assertOnly(compare(...pair(steps({}), steps({}, { removed: ['0:p.json'] }))), 'tree.p.json.removed', 'inode');
    const extra = (arm, t) => [...store({})(arm, t), file('p.json.bak', '{"a":1}', { ino: 9, mtimeMs: t + 3 })];
    const extraResult = compare(...pair(steps({}), [['put', { method: 'PUT', s1: extra, s2: extra }]]));
    assert.ok(differences(extraResult).every((difference) => difference.component.startsWith('tree.p.json.bak')), JSON.stringify(differences(extraResult)));
    assert.ok(differences(extraResult).some((difference) => /extra/.test(difference.location)));
    const missing = compare(...pair(steps({}), [['put', { method: 'PUT' }]]));
    assert.ok(differences(missing).some((difference) => difference.component === 'tree.p.json' && /missing/.test(difference.location)));
    // Bytes holding a supplied root: substituted, equal.
    const rooted = (arm, t) => [file('p.json', JSON.stringify({ dir: arm.root }), { ino: 1, mtimeMs: t + 3 })];
    assertEqual(compare(...pair([['put', { method: 'PUT', s1: rooted, s2: rooted }]])));
    // Link targets (substituted), and a type change.
    const link = (target) => (arm, t) => [{ entry: { path: 'l', type: 'symlink', mode: 0o755, size: 3, ino: 1, mtimeMs: t + 3, target: target(arm) } }];
    assertEqual(compare(...pair([['put', { s1: link((arm) => `${arm.root}/x`), s2: link((arm) => `${arm.root}/x`) }]])));
    assertOnly(compare(...pair([['put', { s1: link(() => 'x'), s2: link(() => 'x') }]], [['put', { s1: link(() => 'y'), s2: link(() => 'y') }]])), 'tree.l.link', 'inode');
    const asFile = (arm, t) => [file('l', 'x', { ino: 1, mtimeMs: t + 3 })];
    assertOnly(compare(...pair([['put', { s1: link(() => 'x'), s2: link(() => 'x') }]], [['put', { s1: asFile, s2: asFile }]])), 'tree.l.type', 'inode');
    // Bytes the snapshot did not keep: inconclusive, never equal by digest.
    const [reference, candidate] = pair(steps({}));
    candidate.blobs = {};
    assert.ok(inconclusive(compare(reference, candidate)).some((item) => item.component === 'tree.p.json.bytes'));
  });

  test('files: the last writer and the mtime window', () => {
    const at = (offset, ino) => (arm, t) => [file('p.json', '{"a":1}', { ino: ino ?? arm.port, mtimeMs: (offset === 'start' ? arm.t - 20 : t + offset) })];
    const start = (arm) => [file('p.json', '{"a":1}', { ino: arm.port, mtimeMs: arm.t - 20 })];
    // The reference rewrites the same bytes in place on DELETE of an absent id; a candidate that skips the write differs.
    const reference = recording('reference', 'R', [['delete-absent', { s1: at(3), s2: at(3) }]], { start: [start(ARMS.R)[0]] });
    reference.start = tree(ARMS.R.t - 10, start(ARMS.R));
    const candidate = recording('candidate', 'C', [['delete-absent', { s1: at('start'), s2: at('start') }]]);
    candidate.start = tree(ARMS.C.t - 10, start(ARMS.C));
    assertOnly(compare(reference, candidate), 'tree.p.json.lastWriter', 'last-writer');
    // A write whose mtime is outside the span between the two snapshots (a preserved old mtime).
    const preserved = recording('candidate', 'C', [['delete-absent', { s1: (arm) => [file('p.json', '{"a":2}', { ino: 5, mtimeMs: arm.t - 5000 })], s2: (arm) => [file('p.json', '{"a":2}', { ino: 5, mtimeMs: arm.t - 5000 })] }]]);
    preserved.start = tree(ARMS.C.t - 10, start(ARMS.C));
    const result = compare(recording('reference', 'R', [['delete-absent', { s1: (arm, t) => [file('p.json', '{"a":2}', { ino: 5, mtimeMs: t + 3 })], s2: (arm, t) => [file('p.json', '{"a":2}', { ino: 5, mtimeMs: t + 3 })] }]], { start: [] }), preserved);
    assert.ok(differences(result).some((difference) => difference.component === 'tree.p.json.mtimeWindow' && difference.rule === 'time-window'), JSON.stringify(differences(result)));
    assert.equal(writersOf(candidate).touched.size, 0);
  });

  test('files: listing order exactly, and the edge\'s files', () => {
    const two = () => (arm, t) => [file('a', '1', { ino: 1, mtimeMs: t + 3 }), file('b', '2', { ino: 2, mtimeMs: t + 3 })];
    const withOrder = (names) => { const r = recording('reference', 'R', [['s', { s1: two(), s2: two() }]]); const c = recording('candidate', 'C', [['s', { s1: two(), s2: two() }]]); c.steps[0].exchanges[0].s1.order = { '.': names }; c.steps[0].exchanges[0].s2.order = { '.': names }; return [r, c]; };
    assertEqual(compare(...withOrder(['a', 'b'])));
    assertOnly(compare(...withOrder(['b', 'a'])), 'tree..(listing order)', 'listing-order');
    // The reference's edge files are not the group's; a candidate that writes one fails.
    const vault = (arm, t) => [file('magic-prompts.json', '{}', { ino: 1, mtimeMs: t + 3 }), { entry: { ...file('multi-user-vault.json', 'cipher', { ino: 2, mtimeMs: arm.t - 30 }).entry, edge: true }, text: 'cipher' }, file('multi-user-vault.key', 'key', { ino: 3, mtimeMs: arm.t - 30 })];
    const plain = (arm, t) => [file('magic-prompts.json', '{}', { ino: 1, mtimeMs: t + 3 })];
    const declarations = { edgeFiles: ['multi-user-vault.json'], startupFiles: ['multi-user-vault.key'] };
    const reference = recording('reference', 'R', [['s', { s1: vault, s2: vault }]], { start: [] });
    reference.start = tree(ARMS.R.t - 10, vault(ARMS.R, ARMS.R.t).slice(1));
    const candidate = recording('candidate', 'C', [['s', { s1: plain, s2: plain }]]);
    assertEqual(compare(reference, candidate, { declarations }));
    const writesKey = recording('candidate', 'C', [['s', { s1: (arm, t) => [...plain(arm, t), file('multi-user-vault.key', 'k', { ino: 4, mtimeMs: t + 3 })], s2: (arm, t) => [...plain(arm, t), file('multi-user-vault.key', 'k', { ino: 4, mtimeMs: t + 3 })] }]]);
    assertOnly(compare(reference, writesKey, { declarations }), 'tree.multi-user-vault.key', 'edge-files');
    // A startup file the reference changed after its first start: a difference of that step.
    const changed = recording('reference', 'R', [['s', { s1: vault, s2: (arm, t) => vault(arm, t).map((spec) => (spec.entry.path === 'multi-user-vault.key' ? file('multi-user-vault.key', 'other', { ino: 3, mtimeMs: t + 15 }) : spec)) }]], { start: [] });
    changed.start = reference.start;
    assert.ok(differences(compare(changed, candidate, { declarations })).some((difference) => difference.rule === 'edge-files'));
    // A candidate that has the edge's file from its first snapshot on (never changed after): still a difference, of each snapshot.
    const withKey = (arm, t) => [...plain(arm, t), file('multi-user-vault.key', 'k', { ino: 4, mtimeMs: arm.t - 30 })];
    const keyFromStart = recording('candidate', 'C', [['s', { s1: withKey, s2: withKey }]]);
    keyFromStart.start = tree(ARMS.C.t - 10, [file('multi-user-vault.key', 'k', { ino: 4, mtimeMs: ARMS.C.t - 30 })]);
    const found = differences(compare(reference, keyFromStart, { declarations }));
    assert.ok(found.length > 0 && found.every((difference) => difference.component === 'tree.multi-user-vault.key' && difference.rule === 'edge-files' && /a file only the reference's edge writes/.test(difference.location)), JSON.stringify(found));
  });

  // ---------------------------------------------------------------- concurrency
  test('concurrency: admissible only as one of the reference\'s serialisations; a lost update or two winners never is', () => {
    const state = (text) => (arm, t) => [file('p.json', text, { ino: 1, mtimeMs: t + 3 })];
    const member = (name, body) => ({ member: name, method: 'PUT', target: `/api/x/${name}`, body });
    const concurrentStep = (side, armName, members, final) => {
      const arm = ARMS[armName];
      const records = members.map((spec, index) => exchange(side, arm, spec, arm.t + index));
      return { id: 'two-puts', kind: 'concurrent', problems: [], exchanges: records, s1: tree(arm.t + 10, final(arm, arm.t)), s2: tree(arm.t + 20, final(arm, arm.t)), replaced: [], removed: [] };
    };
    const serial = (order, bodies, final) => ({ order, exchanges: order.map((name, index) => ({ ...exchange('reference', ARMS.R, member(name, bodies[index]), ARMS.R.t + 200 + index), s2: tree(ARMS.R.t + 300, final(ARMS.R, ARMS.R.t)) })), tree: tree(ARMS.R.t + 300, final(ARMS.R, ARMS.R.t)) });
    const both = '{"a":"1","b":"2"}';
    const build = (candidateMembers, candidateFinal) => {
      const reference = { scenario: 'toy.compare', values: { scenario: [], arm: armValues(ARMS.R) }, steps: [concurrentStep('reference', 'R', [member('a', '{"a":"1"}'), member('b', both)], state(both))], blobs: blobsOf(state(both)(ARMS.R, 0), state('{"a":"1"}')(ARMS.R, 0), state('{"b":"2"}')(ARMS.R, 0)), edgeFiles: [] };
      reference.steps[0].admissible = [serial(['a', 'b'], ['{"a":"1"}', both], state(both)), serial(['b', 'a'], ['{"b":"2"}', both], state(both))];
      const candidate = { scenario: 'toy.compare', values: { scenario: [], arm: armValues(ARMS.C) }, steps: [concurrentStep('candidate', 'C', candidateMembers, candidateFinal)], blobs: blobsOf(candidateFinal(ARMS.C, 0)), edgeFiles: [] };
      return [reference, candidate];
    };
    // The other order: admissible.
    const other = compare(...build([member('a', both), member('b', '{"b":"2"}')], state(both)));
    assertEqual(other);
    assert.ok([...other.steps.values()].some((entry) => entry.notes.some((note) => /b then a/.test(note))));
    // A lost update: both read the empty state, the last write wins.
    assertOnly(compare(...build([member('a', '{"a":"1"}'), member('b', '{"b":"2"}')], state('{"b":"2"}'))), 'concurrency(not admissible)', 'concurrency');
    // Two winners: both answer as if each were last.
    assertOnly(compare(...build([member('a', both), member('b', both)], state(both))), 'concurrency(not admissible)', 'concurrency');
    // No serialisations recorded: inconclusive, never admissible.
    const [reference, candidate] = build([member('a', both), member('b', '{"b":"2"}')], state(both));
    delete reference.steps[0].admissible;
    assert.ok(inconclusive(compare(reference, candidate)).some((item) => item.component === 'concurrency'));
  });

  test('a staged step is judged exactly: the other order of writes is a difference, though it would be admissible', () => {
    const state = (text) => (arm, t) => [file('p.json', text, { ino: 1, mtimeMs: t + 3 })];
    const member = (name, body) => ({ member: name, method: 'PUT', target: `/api/x/${name}`, body });
    const stagedStep = (side, armName, members, final) => {
      const arm = ARMS[armName];
      const records = members.map((spec, index) => exchange(side, arm, spec, arm.t + index));
      return { id: 'timeline', kind: 'staged', problems: [], exchanges: records, s1: tree(arm.t + 10, final(arm, arm.t)), s2: tree(arm.t + 20, final(arm, arm.t)), replaced: [], removed: [] };
    };
    const build = (candidateMembers, candidateFinal) => [
      { scenario: 'toy.compare', values: { scenario: [], arm: armValues(ARMS.R) }, steps: [stagedStep('reference', 'R', [member('a', '{"a":"1"}'), member('b', '{"a":"1","b":"2"}')], state('{"a":"1","b":"2"}'))], blobs: blobsOf(state('{"a":"1","b":"2"}')(ARMS.R, 0)), edgeFiles: [] },
      { scenario: 'toy.compare', values: { scenario: [], arm: armValues(ARMS.C) }, steps: [stagedStep('candidate', 'C', candidateMembers, candidateFinal)], blobs: blobsOf(candidateFinal(ARMS.C, 0)), edgeFiles: [] },
    ];
    assertEqual(compare(...build([member('a', '{"a":"1"}'), member('b', '{"a":"1","b":"2"}')], state('{"a":"1","b":"2"}'))));
    // b then a: each answer is what that order gives, and the final tree is the same, but the answers are not the reference's.
    const found = differences(compare(...build([member('a', '{"b":"2","a":"1"}'), member('b', '{"b":"2"}')], state('{"b":"2","a":"1"}'))));
    assert.ok(found.some((difference) => difference.component === 'body' && difference.rule === 'bytes'), JSON.stringify(found));
    assert.ok(found.some((difference) => difference.component.startsWith('tree.p.json') && difference.rule === 'bytes'), JSON.stringify(found));
    assert.ok(!found.some((difference) => difference.rule === 'concurrency'), 'no admissible set is consulted');
  });

  // ---------------------------------------------------------------- streams and effects
  test('streams item by item, by count and by their end; effects in order', () => {
    const streamStep = (items, extra = {}) => ({ kind: 'stream-barrier', items, exchanges: [], ...extra });
    const run = (left, right) => compare(recording('reference', 'R', [['b', left]]), recording('candidate', 'C', [['b', right]]));
    assertEqual(run(streamStep(['data: 0', 'data: 1']), streamStep(['data: 0', 'data: 1'])));
    assertOnly(run(streamStep(['data: 0', 'data: 1']), streamStep(['data: 0', 'data: 2'])), 'stream[1]', 'stream');
    assertOnly(run(streamStep(['data: 0']), streamStep(['data: 0', 'data: 1'])), 'stream(count)', 'stream');
    const close = (extra) => ({ kind: 'stream-close', exchanges: [], trailing: [], partial: '', ...extra });
    assertOnly(compare(recording('reference', 'R', [['c', close({})]]), recording('candidate', 'C', [['c', close({ trailing: ['data: 9'] })]])), 'stream(count)', 'stream');
    assertOnly(compare(recording('reference', 'R', [['c', close({})]]), recording('candidate', 'C', [['c', close({ endedBeforeClose: true })]])), 'stream(end)', 'stream');
    const effects = (list) => ({ effects: list.map((effect) => ({ kind: effect.kind, ...effect })), candidateEffects: { events: list.filter((effect) => effect.kind === 'hub'), outbound: list.filter((effect) => effect.kind === 'fetch'), children: list.filter((effect) => effect.kind === 'child') } });
    const declarations = { effects: ['events', 'outbound', 'children'] };
    const one = (list, other = list) => compare(recording('reference', 'R', [['a', effects(list)]]), recording('candidate', 'C', [['a', { ...effects(other), effects: [] }]]), { declarations });
    const hub = (n) => ({ kind: 'hub', channel: 'plans', payload: { n } });
    assertEqual(one([hub(1), hub(2)]));
    assertOnly(one([hub(1), hub(2)], [hub(2), hub(1)]), 'events[', 'effects');
    assertOnly(one([hub(1), hub(2)], [hub(1)]), 'events(count)', 'effects');
    const call = (body) => ({ kind: 'fetch', method: 'POST', url: `http://127.0.0.1:${ARMS.R.port}/x`, headers: [], body });
    const callC = (body) => ({ ...call(body), url: `http://127.0.0.1:${ARMS.C.port}/x` });
    assertEqual(compare(recording('reference', 'R', [['a', effects([call('b')])]]), recording('candidate', 'C', [['a', { ...effects([callC('b')]), effects: [] }]]), { declarations }));
    assertOnly(compare(recording('reference', 'R', [['a', effects([call('b')])]]), recording('candidate', 'C', [['a', { ...effects([callC('c')]), effects: [] }]]), { declarations }), 'outbound[0]', 'effects');
    const child = (args) => ({ kind: 'child', file: 'git', args, cwd: null });
    assertOnly(one([child(['status'])], [child(['status', '-s'])]), 'children[0]', 'effects');
    // Effects the candidate's side does not report are inconclusive when the reference made one.
    const unseen = compare(recording('reference', 'R', [['a', { effects: [hub(1)] }]]), recording('candidate', 'C', [['a', { candidateEffects: { seenBy: ['stubs'], events: null, outbound: [], children: [] } }]]), { declarations });
    assert.ok(inconclusive(unseen).some((item) => item.component === 'events'));
  });

  // ---------------------------------------------------------------- steps and late effects
  test('steps: a missing step, another kind, an exchange sent that the edge answers; a late write is a tree difference at S2', () => {
    assertOnly(compare(recording('reference', 'R', [['a', {}], ['b', {}]]), recording('candidate', 'C', [['a', {}]])), 'step', 'steps');
    assertOnly(compare(recording('reference', 'R', [['a', {}]]), recording('candidate', 'C', [['a', { kind: 'snapshot', tree: tree(ARMS.C.t, []) }]])), 'step', 'steps');
    const edge = compare(recording('reference', 'R', [['a', { edgeAnswered: true }]]), recording('candidate', 'C', [['a', {}]]));
    assertOnly(edge, 'exchange', 'steps');
    // The candidate answers, claims quiescence and writes later: its S2 lacks the write that the reference's has.
    const written = (arm, t) => [file('p.json', '{"a":1}', { ino: 1, mtimeMs: t + 3 })];
    const late = compare(recording('reference', 'R', [['put', { s1: written, s2: written }]]), recording('candidate', 'C', [['put', {}]]));
    assert.ok(differences(late).some((difference) => difference.component === 'tree.p.json' && /S2: missing/.test(difference.location)));
  });

  // ---------------------------------------------------------------- the review's gaps (S4 of the BH3/BH4 review): each a rule no other test pins
  test('supplied values: one present in one arm only is said; the scenario\'s own values must be the same', () => {
    const extra = [...armValues(ARMS.R), { name: 'project', kind: 'path', value: '/private/var/h/p', forms: { given: '/private/var/h/p' } }];
    const result = compare(recording('reference', 'R', [['a', {}]], { values: { scenario: [{ name: 'text.a', kind: 'text', value: 'hello' }], arm: extra } }), recording('candidate', 'C', [['a', {}]]));
    assert.deepEqual(differences(result), []);
    assert.ok(inconclusive(result).some((item) => item.component === 'values' && /project is in one arm only/.test(item.why)), JSON.stringify(inconclusive(result)));
    const other = compare(recording('reference', 'R', [['a', {}]]), recording('candidate', 'C', [['a', {}]], { values: { scenario: [{ name: 'text.a', kind: 'text', value: 'hello!' }], arm: armValues(ARMS.C) } }));
    assertOnly(other, 'values', 'supplied');
  });

  test('the request: its method and its headers, as the group received them', () => {
    const [reference, candidate] = pair([['a', { method: 'PUT' }]]);
    candidate.steps[0].exchanges[0].response.request.method = 'POST';
    assertOnly(compare(reference, candidate), 'request.method', 'request');
    const sent = [['Host', `127.0.0.1:${ARMS.C.port}`], ['Connection', 'close'], ['If-None-Match', 'W/"1-a"']];
    assertOnly(compare(...pair([['a', {}]], [['a', { requestHeaders: sent }]])), 'request.headers', 'request');
  });

  test('a request body the group answered before reading: judged on the bytes sent, never on how many the tap saw', () => {
    const unread = (seen, complete = false) => (record) => { record.tap.request = { body: b64(seen), bodyComplete: complete }; record.tap.entry.bodyParsedByEdge = false; record.tap.entry.bodyConsumedBeforeEntry = false; };
    const build = (seen, candidateBody = '{"text":"plain"}') => {
      const [reference, candidate] = pair([['a', { method: 'PUT', requestBody: '{"text":"plain"}' }]], [['a', { method: 'PUT', requestBody: candidateBody }]]);
      unread(seen)(reference.steps[0].exchanges[0]);
      reference.steps[0].requestBodyUnread = { seq: 1, sentBytes: 16, seenByTap: Buffer.byteLength(seen) };
      return [reference, candidate];
    };
    // Any prefix the tap saw: the same judgment.
    for (const seen of ['', '{"te', '{"text":"plain"}']) assertEqual(compare(...build(seen)));
    // The candidate given other bytes than were sent: a difference.
    assertOnly(compare(...build('{"te', '{"text":"plaim"}')), 'request.body', 'request');
    // The tap saw bytes that are not a prefix of what was sent: not judged.
    const result = compare(...build('{"xx'));
    assert.deepEqual(differences(result), []);
    assert.ok(inconclusive(result).some((item) => item.component === 'request.body' && /not a prefix/.test(item.why)));
    // Something may have read it (an edge parser): not judged.
    const [parsed, candidate] = build('{"te');
    parsed.steps[0].exchanges[0].tap.entry.bodyParsedByEdge = true;
    assert.ok(inconclusive(compare(parsed, candidate)).some((item) => item.component === 'request.body'));
    // Stability: R saw 16 bytes, R' none: equal (the prefix rule), so the row cannot flake to unstable.
    const a = recording('reference', 'R', [['a', { method: 'PUT', requestBody: '{"text":"plain"}' }]]);
    const b = recording('reference', 'C', [['a', { method: 'PUT', requestBody: '{"text":"plain"}' }]]);
    unread('{"text":"plain"}')(a.steps[0].exchanges[0]);
    unread('')(b.steps[0].exchanges[0]);
    assertEqual(compare(a, b, { mode: 'stability' }));
    unread('{"x')(b.steps[0].exchanges[0]);
    assert.ok(inconclusive(compare(a, b, { mode: 'stability' })).some((item) => item.component === 'request.body'));
  });

  test('a HEAD answer: no body, and its Content-Length compared as a value', () => {
    const head = (length) => ({ method: 'HEAD', body: '', contentLengthValue: length });
    assertEqual(compare(...pair([['h', head(28)]])));
    assertOnly(compare(...pair([['h', head(28)]], [['h', head(29)]])), 'headers.content-length', 'headers');
  });

  test('a candidate response that did not complete is a difference, even with the same bytes', () => {
    const result = compare(...pair([['a', {}]], [['a', { complete: false, error: 'socket hang up' }]]));
    assertOnly(result, 'body', 'bytes');
    assert.ok(differences(result).some((difference) => /not complete/.test(difference.location)));
  });

  test('effects: unobserved is never "none"; a group declared unable to cause one; what the outside view compares', () => {
    const hub = { kind: 'hub', channel: 'plans', payload: {} };
    // A candidate arm not run under observation: inconclusive with its own check, even when the reference made none.
    const unobserved = compare(...pair([['a', {}]], [['a', { candidateEffects: null }]]));
    assert.deepEqual(differences(unobserved), []);
    assert.deepEqual(inconclusive(unobserved).map((item) => [item.component, item.check]), [['effects', 'candidate-effects-unobserved']]);
    // The reference made an effect its group is declared unable to cause: a difference.
    const declaredNone = compare(recording('reference', 'R', [['a', { effects: [hub] }]]), recording('candidate', 'C', [['a', { candidateEffects: null }]]), { declarations: { effects: [] } });
    assert.ok(differences(declaredNone).some((difference) => difference.component === 'events' && difference.rule === 'effects'), JSON.stringify(differences(declaredNone)));
    // Seen from outside: a child by name and arguments, an outbound call by method, target and body.
    const child = { kind: 'child', seenBy: 'path-shim', file: 'true', cwd: '/x', args: [], argvHasName: false };
    assertOnly(compare(...pair([['a', {}]], [['a', { candidateEffects: { seenBy: ['path-shim'], events: null, outbound: [], children: [child] } }]])), 'children(count)', 'effects');
    const tapChild = { kind: 'child', file: 'git', args: ['git', 'status'], cwd: null };
    assertEqual(compare(recording('reference', 'R', [['a', { effects: [tapChild] }]]), recording('candidate', 'C', [['a', { candidateEffects: { seenBy: ['path-shim'], events: null, outbound: [], children: [{ ...child, file: 'git', args: ['status'] }] } }]]), { declarations: { effects: ['children'] } }));
    assertOnly(compare(recording('reference', 'R', [['a', { effects: [tapChild] }]]), recording('candidate', 'C', [['a', { candidateEffects: { seenBy: ['path-shim'], events: null, outbound: [], children: [{ ...child, file: 'git', args: ['log'] }] } }]]), { declarations: { effects: ['children'] } }), 'children[0]', 'effects');
    const call = { kind: 'fetch', method: 'POST', url: `http://127.0.0.1:${ARMS.R.port}/hook`, headers: [], body: [b64('x')] };
    const stub = (body) => ({ kind: 'http-request', seenBy: 'stub', stub: 'outbound', method: 'POST', target: `127.0.0.1:${ARMS.C.port}/hook`, headers: ['Host', 'x'], body: b64(body) });
    assertEqual(compare(recording('reference', 'R', [['a', { effects: [call] }]]), recording('candidate', 'C', [['a', { candidateEffects: { seenBy: ['stubs'], events: null, outbound: [stub('x')], children: [] } }]]), { declarations: { effects: ['outbound'] } }));
    assertOnly(compare(recording('reference', 'R', [['a', { effects: [call] }]]), recording('candidate', 'C', [['a', { candidateEffects: { seenBy: ['stubs'], events: null, outbound: [stub('y')], children: [] } }]]), { declarations: { effects: ['outbound'] } }), 'outbound[0]', 'effects');
  });

  test('trees: an unstable snapshot and bytes not kept are never compared as equal; the root\'s own mode', () => {
    const store = (text) => (arm, t) => [file('p.json', text, { ino: 1, mtimeMs: t + 3 })];
    const [reference, candidate] = pair([['put', { s1: store('{"a":1}'), s2: store('{"a":1}') }]]);
    candidate.steps[0].exchanges[0].s2 = { ...candidate.steps[0].exchanges[0].s2, stable: false };
    const unstable = compare(reference, candidate);
    assert.deepEqual(differences(unstable), []);
    assert.ok(inconclusive(unstable).some((item) => item.component === 'tree(S2)'));
    const [r2, c2] = pair([['put', { s1: store('{"a":1}'), s2: store('{"a":1}') }]], [['put', { s1: store('{"a":2}'), s2: store('{"a":2}') }]]);
    c2.blobs = {};
    const unkept = compare(r2, c2);
    assert.deepEqual(differences(unkept), []);
    assert.ok(inconclusive(unkept).some((item) => item.component === 'tree.p.json.bytes' && /digests differ/.test(item.why)));
    // M1: the data root's own permission bits (and HOME's) are compared.
    const [r3, c3] = pair([['put', {}]]);
    for (const record of [r3, c3]) for (const moment of ['s1', 's2']) record.steps[0].exchanges[0][moment] = { ...record.steps[0].exchanges[0][moment], rootMode: 0o700 };
    assertEqual(compare(r3, c3));
    c3.steps[0].exchanges[0].s2 = { ...c3.steps[0].exchanges[0].s2, rootMode: 0o755 };
    assertOnly(compare(r3, c3), 'tree.(root).mode', 'inode');
  });

  test('the mtime window is widened by the measured lag of the file system\'s clock, and only by it', () => {
    const at = (offset) => (arm, t) => [file('p.json', '{"a":1}', { ino: 2, mtimeMs: t + 10 + offset })];
    const build = (granularity, offset) => {
      const result = recording('reference', 'R', [['put', { s1: at(offset), s2: at(offset) }]]);
      result.mtimeGranularityMs = granularity;
      return result;
    };
    // The previous snapshot (start) ends at arm.t - 9; an mtime 3 ms before the window's start (t + 10 - 22 = t - 12).
    assert.equal(writersOf(build(0, -22)).mtimeProblems.length, 1);
    assert.equal(writersOf(build(4, -22)).mtimeProblems.length, 0);
    assert.equal(writersOf(build(4, -30)).mtimeProblems.length, 1);
  });

  test('streams: the bytes after the last item and the stream\'s head status', () => {
    const close = (extra) => ({ kind: 'stream-close', exchanges: [], trailing: [], partial: '', ...extra });
    assertOnly(compare(recording('reference', 'R', [['c', close({})]]), recording('candidate', 'C', [['c', close({ partial: 'data: half' })]])), 'stream(end)', 'stream');
    const opened = (status) => ({ kind: 'stream-open', exchanges: [{ head: { status, headers: [] } }] });
    assert.ok(differences(compare(recording('reference', 'R', [['o', opened(200)]]), recording('candidate', 'C', [['o', opened(500)]]))).some((difference) => difference.component === 'stream.status' && difference.rule === 'stream'));
    assert.ok(!differences(compare(recording('reference', 'R', [['o', opened(200)]]), recording('candidate', 'C', [['o', opened(200)]]))).some((difference) => difference.component === 'stream.status'));
  });

  test('stability mode\'s inside view: the tap\'s kind, the group\'s entry, each header\'s owner, the response\'s completeness', () => {
    const two = (change) => { const a = recording('reference', 'R', [['a', {}]]); const b = recording('reference', 'C', [['a', {}]]); change(b.steps[0].exchanges[0]); return compare(a, b, { mode: 'stability' }); };
    assertOnly(two((record) => { record.tap.kind = 'edge'; }), 'tap.kind', 'steps');
    assertOnly(two((record) => { record.tap.entry.principal = { id: 'someone-else' }; }), 'entry', 'request');
    assertOnly(two((record) => { record.tap.response.headers[0].owner = { owner: 'edge', module: 'another-layer' }; }), 'headers(owners)', 'headers');
    assertOnly(two((record) => { record.response.complete = false; }), 'response(complete)', 'bytes');
  });

  test('kills, unsent exchanges and missing steps are never silent', () => {
    const killed = (signal) => ({ kind: 'kill-after', exchanges: [{ point: 'request-sent', response: { complete: false, status: null }, exit: { signal } }] });
    assertOnly(compare(recording('reference', 'R', [['k', killed('SIGKILL')]]), recording('candidate', 'C', [['k', killed('SIGTERM')]])), 'kill(exit)', 'steps');
    // The reference did not make an exchange (a principal it cannot produce): inconclusive.
    const unsent = (recorded, why) => { recorded.steps[0].exchanges = [{ member: null, notSent: why }]; return recorded; };
    const notMade = compare(unsent(recording('reference', 'R', [['a', {}]]), 'principal unavailable'), unsent(recording('candidate', 'C', [['a', {}]]), 'principal unavailable'));
    assert.ok(inconclusive(notMade).some((item) => item.component === 'exchange #0' && /reference did not make/.test(item.why)));
    // The candidate was not given an exchange the reference made: inconclusive.
    const [reference] = pair([['a', {}]]);
    const notGiven = compare(reference, unsent(recording('candidate', 'C', [['a', {}]]), 'not given'));
    assert.ok(inconclusive(notGiven).some((item) => item.component === 'exchange #0' && /candidate was not given/.test(item.why)));
    // A missing step is a difference of that step (its row), not only of the recording.
    const missing = compare(recording('reference', 'R', [['a', {}], ['b', {}]]), recording('candidate', 'C', [['a', {}]]));
    assert.ok(missing.steps.get('b').differences.some((difference) => difference.component === 'step'));
  });

  test('structured values: key order, and 0 against -0, are differences', () => {
    assert.ok(deepDifference({ a: 1, b: 2 }, { b: 2, a: 1 }));
    assert.ok(deepDifference({ n: 0 }, { n: -0 }));
  });

  // ---------------------------------------------------------------- the archived attempt's false passes (design §1.1)
  test('the archived attempt\'s false passes are differences here', () => {
    // A consistently wrong value (a pseudonym map would pass it).
    assertOnly(compare(...pair([['a', { body: '{"id":"git.pr"}' }], ['b', { body: '{"id":"git.pr"}' }]], [['a', { body: '{"id":"git.px"}' }], ['b', { body: '{"id":"git.px"}' }]])), 'body', 'bytes');
    // 3 and "3" (one pseudonym for both).
    assertOnly(compare(...pair([['a', { body: '{"n":3}' }]], [['a', { body: '{"n":"3"}' }]])), 'body', 'bytes');
    // Header names lowercased never matched: names match case-insensitively, values do not.
    assertEqual(compare(...pair([['a', { group: [['X-Thing', 'v'], ...GROUP_JSON] }]], [['a', { group: [['x-thing', 'v'], ...GROUP_JSON] }]])));
    // Trailing stream items never read.
    assertOnly(compare(recording('reference', 'R', [['c', { kind: 'stream-close', exchanges: [], trailing: [], partial: '' }]]), recording('candidate', 'C', [['c', { kind: 'stream-close', exchanges: [], trailing: ['data: late'], partial: '' }]])), 'stream(count)', 'stream');
    // A truncated body, or one never read to its end.
    const truncated = compare(...pair([['a', { body: '{"text":"assembled"}' }]], [['a', { body: '{"text":"assem', contentLengthValue: 20, complete: false, error: 'socket hang up' }]]));
    assert.ok(differences(truncated).some((difference) => difference.component === 'body'));
    // Epoch milliseconds under any key masked; an ETag compared by its length.
    assertOnly(compare(...pair([['a', { body: `{"epoch":${T0}}` }]], [['a', { body: `{"epoch":${T0 + 1}}` }]])), 'body', 'bytes');
    assertOnly(compare(...pair([['a', { group: [...GROUP_JSON, ['ETag', 'W/"7-aaaa"']] }]], [['a', { group: [...GROUP_JSON, ['ETag', 'W/"7-bbbb"']] }]])), 'headers.etag', 'etag');
    // The version is compared.
    assertOnly(compare(...pair([['a', { body: '{"version":1}' }]], [['a', { body: '{"version":2}' }]])), 'body', 'bytes');
    // An extra event.
    const declarations = { effects: ['events'] };
    const hub = { kind: 'hub', channel: 'plans', payload: {} };
    assertOnly(compare(recording('reference', 'R', [['a', { effects: [hub] }]]), recording('candidate', 'C', [['a', { candidateEffects: { events: [hub, hub], outbound: [], children: [] } }]]), { declarations }), 'events(count)', 'effects');
  });
});
