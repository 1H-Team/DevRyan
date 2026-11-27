// The census's self-test (BH5; fast, one process, no child): its judgement
// on fixed inputs. A toy group (TOY below) is written to the test's scratch,
// imported under V8 block coverage in this process (block-coverage.mjs, the
// group host's own probe), and driven by hand: each call of a handler is one
// "exchange", and each coverage take is that exchange's. The takes, the
// registrations and the stale heads are written as the tap writes them, in
// one tap file per process (the toy restarts once), and read back by the
// driver's own reader (driver.mjs groupCoverage), so the recordings have the
// shape a run writes. The run's census path (scenario-rows.mjs
// produceScenarioRows, with the closure check replaced by the toy's rows) is
// judged too: gaps and problems become the run's census gaps, and a run of
// some scenarios is never complete.
//
// Every planted mistake below (the builder's, the reviewer's and this fix
// round's, each in a copy of one module) is run against every named check;
// each must make at least one fail, and the table says which.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { startBlockCoverage } from './block-coverage.mjs';
import * as source from './census-source.mjs';
import * as census from './coverage-census.mjs';
import * as driver from './driver.mjs';
import { judgeRun, lastLine } from './outcomes.mjs';
import { createBackendRun } from './run-scratch.mjs';
import * as rowsModule from './scenario-rows.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOY = `export const registerToy = (app, { fsPromises }) => {
  app.get('/api/toy', async (req, res) => {
    if (req.query.fail) {
      return res.status(400).json({ error: 'refused' });
    }
    res.json({ ok: true, from: req.ip ?? null });
  });
  app.put('/api/toy/:id', async (req, res) => {
    const size = typeof req.body?.size === 'number' ? req.body.size : 0;
    try {
      await fsPromises.writeFile('toy', String(size));
      return res.json({ size: size > 1 || size < -1 ? 'big' : 'small' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
  app.post('/api/toy', async (req, res) => {
    try {
      if (req.body === undefined) throw new Error('no body');
      const value = JSON.parse(req.body.text); return res.status(201).json({ value });
    } catch {
      return res.status(500).json({ error: 'not json' });
    }
  });
  app.get('/api/toy/read', async (req, res) => {
    try {
      return res.json(await fsPromises.readFile(req.query.name));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
};
`;
const SCENARIO = 'toy.census';
const PRINCIPALS = [{ name: 'local-admin', class: 'local-admin' }, { name: 'remote', class: 'unauthenticated' }];
const T0 = 1_800_000_000_000;

let run;
let toyFile;
let world;
let scratchCount = 0;

/** The current group frame of a call into the toy's response (the tap's answer site). */
const siteIn = (file) => {
  const holder = {};
  Error.captureStackTrace(holder);
  for (const line of String(holder.stack).split('\n').slice(1)) {
    const match = /\(?((?:file:\/\/)?\/[^():]+):(\d+):(\d+)\)?$/.exec(line.trim());
    if (match && (match[1] === file || match[1] === pathToFileURL(file).href)) return { owner: 'group', file, line: Number(match[2]), column: Number(match[3]) };
  }
  return null;
};

/**
 * The toy run by hand: every exchange's request, answer, answer site and coverage take, as a reference
 * recording; the takes, registrations and heads written to one tap file per process, as the tap does.
 */
async function recordToy() {
  const coverage = startBlockCoverage();
  toyFile = run.writeFile('toy/routes.js', TOY, { mode: 0o600 });
  const { registerToy } = await import(pathToFileURL(toyFile).href);
  const handlers = new Map();
  const tap = [[]];
  const registrations = [];
  const app = Object.fromEntries(['get', 'put', 'post'].map((method) => [method, (routePath, handler) => {
    handlers.set(`${method.toUpperCase()} ${routePath}`, handler);
    const line = TOY.split('\n').findIndex((text) => text.includes(`app.${method}('${routePath}'`)) + 1;
    registrations.push({ type: 'registration', group: true, kind: 'route', method: method.toUpperCase(), path: routePath, file: toyFile, line });
  }]));
  registerToy(app, { fsPromises: {
    writeFile: async (_name, text) => { if (text === '13') throw new Error('EIO: i/o error, write'); },
    readFile: async (name) => { if (name === 'nope') throw new Error(`ENOENT: no such file or directory, open '${name}'`); return `the text of ${name}`; },
  } });
  const digest = crypto.createHash('sha256').update(fs.readFileSync(toyFile)).digest('hex').slice(0, 16);
  tap[0].push({ type: 'host', groupSources: { [toyFile]: digest } }, ...registrations, { type: 'coverage', phase: 'start', seq: 0, files: coverage.take([toyFile]) });
  // How late the toy's "host" was: a timer 3 ms late; a head written 4 ms into the next second (5 ms over, counting the ms it began).
  tap[0].push({ type: 'clock', dateLagMs: 3, at: T0 }, { type: 'exchange', seq: 1, response: { head: `HTTP/1.1 200 OK\r\nDate: ${new Date(T0 - 1_000).toUTCString()}\r\n\r\n`, headAt: T0 + 4 } });
  const steps = [];
  let processIndex = 0;
  let seq = 0;
  const call = async ({ route, query = {}, body }) => {
    let status = 200;
    let answer = '';
    let answeredBy = null;
    const res = { status(code) { status = code; return res; }, json(value) { answeredBy ??= siteIn(toyFile); answer = JSON.stringify(value); return res; } };
    await handlers.get(`${route[0]} ${route[1]}`)({ query, body, params: {} }, res);
    return { status, answer, answeredBy };
  };
  const recordOf = (spec, armSeq, result) => {
    const { method, url, route, body, headers = [], principal = 'local-admin', kind = 'group', bodyParsed = true } = spec;
    const rawBody = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return { process: processIndex, armSeq, principal, tap: {
      kind, entry: kind === 'group' ? { registration: { kind: 'route', method: route[0], path: route[1] }, bodyParsedByEdge: bodyParsed } : null,
      answeredBy: result.answeredBy,
      request: { method, startUrl: url, rawHeaders: headers.flat(), body: Buffer.from(rawBody).toString('base64'), bodyComplete: true },
      response: { status: result.status, body: Buffer.from(result.answer).toString('base64'), ops: [] },
    } };
  };
  /** One exchange: the group's handler runs (or the edge or tail answers), then its take, as at the host's quiescence answer. */
  const exchange = async (id, spec) => {
    seq += 1;
    const result = (spec.kind ?? 'group') === 'group' ? await call(spec) : { status: spec.kind === 'tail' ? 599 : 400, answer: spec.kind, answeredBy: null };
    tap[processIndex].push({ type: 'coverage', phase: 'quiescent', seq, files: coverage.take([toyFile]) });
    steps.push({ id, kind: 'exchange', problems: [], exchanges: [recordOf(spec, seq, result)] });
  };
  const restart = () => {
    processIndex += 1;
    seq = 0;
    tap.push([{ type: 'coverage', phase: 'start', seq: 0, files: coverage.take([toyFile]) }]);
    steps.push({ id: `restart-${processIndex}`, kind: 'restart', problems: [], exchanges: [] });
  };
  const GET = ['GET', '/api/toy'];
  const PUT = ['PUT', '/api/toy/:id'];
  const POST = ['POST', '/api/toy'];
  const READ = ['GET', '/api/toy/read'];
  const JSON_TYPE = [['Content-Type', 'application/json']];
  await exchange('get-ok', { method: 'GET', url: '/api/toy', route: GET });
  await exchange('get-fail', { method: 'GET', url: '/api/toy?fail=1', route: GET, query: { fail: '1' } });
  await exchange('head', { method: 'HEAD', url: '/api/toy', route: GET });
  await exchange('put-small', { method: 'PUT', url: '/api/toy/a', route: PUT, body: { size: 0 }, headers: JSON_TYPE });
  await exchange('put-big', { method: 'PUT', url: '/api/toy/a/', route: PUT, body: { size: 5 }, headers: JSON_TYPE });
  await exchange('put-negative', { method: 'PUT', url: '/api/toy/a', route: PUT, body: { size: -5 }, headers: JSON_TYPE });
  await exchange('put-fail', { method: 'PUT', url: '/api/toy/a', route: PUT, body: { size: 13 }, headers: JSON_TYPE });
  await exchange('put-string', { method: 'PUT', url: '/api/toy/a', route: PUT, body: { size: 'x' }, headers: JSON_TYPE });
  await exchange('put-malformed', { method: 'PUT', url: '/api/toy/a', body: '{"size":', headers: JSON_TYPE, kind: 'edge' });
  await exchange('put-remote', { method: 'PUT', url: '/api/toy/a', body: { size: 1 }, headers: JSON_TYPE, principal: 'remote', kind: 'edge' });
  // The answer after a call that throws (P1 of the BH5 review) and the answer of an awaited rejection (P2): V8 counts both blocks.
  await exchange('post-not-json', { method: 'POST', url: '/api/toy', route: POST, body: { text: '{' }, headers: JSON_TYPE });
  await exchange('read-missing', { method: 'GET', url: '/api/toy/read?name=nope', route: READ, query: { name: 'nope' } });
  await exchange('options-tail', { method: 'OPTIONS', url: '/api/toy', kind: 'tail' });
  await exchange('get-doubled-slash', { method: 'GET', url: '//api/toy', kind: 'tail' });
  // After a restart the arm's sequence numbers start again: a take of process 1 is never one of process 0.
  restart();
  await exchange('get-fail-restarted', { method: 'GET', url: '/api/toy?fail=1', route: GET, query: { fail: '1' } });
  await exchange('post-json', { method: 'POST', url: '/api/toy', route: POST, body: { text: '1' }, headers: JSON_TYPE });
  await exchange('read-present', { method: 'GET', url: '/api/toy/read?name=here', route: READ, query: { name: 'here' } });
  // A concurrent step whose admissible serialisation reran GET ?fail=1 (a reference-only rerun: it owns its take, credits nothing).
  seq += 1;
  const member = await call({ route: GET, query: {} });
  tap[processIndex].push({ type: 'coverage', phase: 'quiescent', seq, files: coverage.take([toyFile]) });
  const memberRecord = recordOf({ method: 'GET', url: '/api/toy', route: GET }, seq, member);
  seq += 1;
  const serial = await call({ route: GET, query: { fail: '1' } });
  tap[processIndex].push({ type: 'coverage', phase: 'quiescent', seq, files: coverage.take([toyFile]) });
  const serialRecord = recordOf({ method: 'GET', url: '/api/toy/?fail=1', route: GET }, seq, serial);
  steps.push({ id: 'concurrent-gets', kind: 'concurrent', problems: [], exchanges: [{ ...memberRecord, member: 'a' }], admissible: [{ order: ['a'], exchanges: [{ ...serialRecord, member: 'a' }] }] });
  const tapFiles = tap.map((records, index) => run.writeFile(`toy/tap-${index}.ndjson`, records.map((record) => `${JSON.stringify(record)}\n`).join('')));
  return { steps, tapFiles, digest };
}

// Read once per module (a planted copy is another module): the checks never change what they are given.
const cached = (cache, key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };
const recordings = new WeakMap();
const readings = new WeakMap();
/** The recording the driver writes from the toy's steps and tap files, read with `m.driver` (the real reader or a planted copy). */
const recordingOf = (m) => ({ scenario: SCENARIO, steps: world.steps, ...cached(recordings, m.driver, () => m.driver.groupCoverage(world.tapFiles)) });
/** The toy's items and routes, read with `m.source` (each reader once). */
const readToy = (m) => cached(readings, m.source, () => m.source.fileItems({ file: toyFile, relative: 'routes.js', text: TOY, dependencies: ['fsPromises'] }));
/** The steps that changed the toy's "data root": the PUTs whose write did not fail. */
const TOUCHED = ['put-small', 'put-big', 'put-negative', 'put-string'];
const WRITE_ID = "routes.js:registerToy>PUT /api/toy/:id handler:call fsPromises.writeFile('toy', String(size))";
const ERRORS = [{ call: WRITE_ID, codes: ['EIO'], why: 'the toy\'s disk fails on 13' }];

/** Rows: every step passed (group), waived as an edge or tail exchange, unless `outcomes` says otherwise. */
function rowsFor(steps, outcomes = {}, scenario = SCENARIO) {
  const kindOf = (step) => step.exchanges[0]?.tap.kind ?? 'group';
  const rows = [...steps.filter((step) => step.kind !== 'restart').map((step) => {
    const kind = kindOf(step);
    const outcome = outcomes[step.id] ?? (kind === 'group' ? 'passed' : 'inconclusive');
    return { id: `${scenario}/${step.id}`, outcome, checks: outcome === 'inconclusive' ? [kind === 'group' ? 'stability-incomplete' : `${kind}-exchange`] : outcome === 'passed' ? [] : ['difference'], differences: [], whole: false };
  }), { id: `${scenario}/recording`, outcome: outcomes.recording ?? 'passed', checks: outcomes.recording === 'inconclusive' ? ['stability-incomplete'] : [], differences: [], whole: true }];
  const waivers = Object.fromEntries(rows.filter((row) => ['edge-exchange', 'tail-exchange'].includes(row.checks[0])).map((row) => [row.id, { outcome: 'inconclusive', checks: [row.checks[0]], reason: 'the edge or tail answers it in this toy' }]));
  return judgeRun({ rows, waivers }).rows;
}
const inputOf = (m, overrides = {}) => {
  const { items, routes } = readToy(m);
  return { group: 'toy', items, routes, recordings: [{ scenario: SCENARIO, recording: recordingOf(m), touched: TOUCHED }], rows: rowsFor(world.steps), principals: PRINCIPALS, errors: ERRORS, ...overrides };
};
const judge = (m, overrides) => m.census.judgeCensus(inputOf(m, overrides));
const itemOf = (result, id) => { const found = result.items.find((item) => item.id === id); assert.ok(found, `no item ${id}: ${result.items.map((item) => item.id).join('\n')}`); return found; };
const codeId = (fn, rest) => `routes.js:registerToy>${fn}:${rest}`;
const PUT_FN = 'PUT /api/toy/:id handler';
const GET_FN = 'GET /api/toy handler';
const POST_FN = 'POST /api/toy handler';
const READ_FN = 'GET /api/toy/read handler';
const row = (step) => `${SCENARIO}/${step}`;
const statusOf = (result, id) => itemOf(result, id).status;

/** An observation, as observationsOf makes them, for the form predicates. */
const obs = (spec) => ({ method: spec.method ?? 'PUT', url: spec.url ?? '/api/toy/x', headers: census.headerMap((spec.headers ?? []).flat()), body: Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body ?? ''), status: spec.status ?? 200, bodyParsed: spec.bodyParsed ?? null, bodyComplete: spec.bodyComplete ?? true });
const J = [['Content-Type', 'application/json']];
const json = (body, extra = {}) => ({ headers: J, body, ...extra });
const PUT_ROUTE = { method: 'PUT', path: '/api/toy/:id', reads: ['body', 'params'] };
const GET_ROUTE = { method: 'GET', path: '/api/toy', reads: [] };
const DELETE_ROUTE = { method: 'DELETE', path: '/api/toy/:id', reads: ['params'] };
/**
 * Every request form with the routes it applies to and not, and observations that have it and that do not.
 * A form the catalog adds without cases here fails the check.
 */
const FORM_CASES = {
  'trailing-slash': { applies: [PUT_ROUTE, GET_ROUTE], yes: [{ url: '/api/toy/x/' }], no: [{ url: '/api/toy/x' }, { url: '/api/toy/x?y=/' }] },
  'letter-case': { applies: [GET_ROUTE, DELETE_ROUTE], not: [PUT_ROUTE], route: GET_ROUTE, yes: [{ method: 'GET', url: '/API/toy' }], no: [{ method: 'GET', url: '/api/toy' }] },
  'letter-case-body-parsed': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ url: '/API/TOY/x', bodyParsed: true }], no: [{ url: '/API/TOY/x', bodyParsed: false }, { url: '/api/toy/X', bodyParsed: true }] },
  'letter-case-body-unparsed': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ url: '/api/Toy/x', bodyParsed: false }], no: [{ url: '/api/Toy/x', bodyParsed: true }, { url: '/api/toy/x', bodyParsed: false }] },
  'query-string': { applies: [PUT_ROUTE], not: [{ ...GET_ROUTE, reads: ['query'] }], yes: [{ url: '/api/toy/x?y=1' }], no: [{ url: '/api/toy/x' }] },
  'param-percent-encoded': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ url: '/api/toy/a%2Eb' }, { url: '/api/toy/%20a' }], no: [{ url: '/api/toy/a.b' }, { url: '/api/toy/a%2Fb' }, { url: '/api/toy/%zz' }, { url: '/api%2Dx/toy/a' }] },
  'param-percent-slash': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ url: '/api/toy/a%2Fb' }, { url: '/api/toy/a%2fb' }], no: [{ url: '/api/toy/a%2Eb' }, { url: '/api/toy/%zz%2F' }] },
  'param-percent-malformed': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ url: '/api/toy/%zz' }, { url: '/api/toy/a%' }, { url: '/api/toy/%2' }], no: [{ url: '/api/toy/%20' }, { url: '/api/toy/a%2Fb' }] },
  'literal-percent-encoded': { applies: [PUT_ROUTE, GET_ROUTE], yes: [{ url: '/api/t%6Fy/x' }, { url: '/%61pi/toy/x' }, { url: '/api/T%6Fy/x' }], no: [{ url: '/api/toy/x' }, { url: '/api/toy/%78' }, { url: '/api/t%6Fz/x' }] },
  'empty-segment': { applies: [PUT_ROUTE, GET_ROUTE], yes: [{ url: '//api/toy/x' }, { url: '/api//toy/x' }], no: [{ url: '/api/toy/x' }, { url: '/api/toy/x/' }] },
  'body-malformed-json': { applies: [PUT_ROUTE, GET_ROUTE], yes: [json('{"a":')], no: [json('{"a":1}'), { headers: [['Content-Type', 'text/plain']], body: '{' }, json('{"a":', { bodyComplete: false }), json('')] },
  'conditional-fresh': { applies: [GET_ROUTE], not: [PUT_ROUTE], yes: [{ method: 'GET', headers: [['If-None-Match', 'W/"x"']], status: 304 }], no: [{ method: 'GET', headers: [['If-None-Match', 'W/"x"']], status: 200 }, { method: 'GET', status: 304 }] },
  'conditional-stale': { applies: [GET_ROUTE], not: [PUT_ROUTE], yes: [{ method: 'GET', headers: [['If-None-Match', 'W/"x"']], status: 200 }], no: [{ method: 'GET', headers: [['If-None-Match', 'W/"x"']], status: 304 }, { method: 'GET', headers: [['If-None-Match', 'W/"x"'], ['Cache-Control', 'no-cache']] }, { method: 'GET' }] },
  'conditional-no-cache': { applies: [GET_ROUTE], not: [PUT_ROUTE], yes: [{ method: 'GET', headers: [['If-None-Match', 'W/"x"'], ['Cache-Control', 'no-cache']] }], no: [{ method: 'GET', headers: [['Cache-Control', 'no-cache']] }, { method: 'GET', headers: [['If-None-Match', 'W/"x"']] }] },
  'if-modified-since': { applies: [GET_ROUTE], not: [PUT_ROUTE], yes: [{ method: 'GET', headers: [['If-Modified-Since', 'Tue, 01 Jan 2030 00:00:00 GMT']] }], no: [{ method: 'GET', headers: [['If-Modified-Since', 'x'], ['If-None-Match', 'y']] }, { method: 'GET' }] },
  'conditional-on-write': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['If-None-Match', '*']] }], no: [{}] },
  'accept-encoding-gzip': { applies: [GET_ROUTE], not: [PUT_ROUTE], yes: [{ method: 'GET', headers: [['Accept-Encoding', 'br, GZIP']] }], no: [{ method: 'GET', headers: [['Accept-Encoding', 'br']] }, { method: 'GET' }] },
  'json-array': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [json('[1]')], no: [json('{"a":[1]}'), { headers: [['Content-Type', 'text/plain']], body: '[1]' }] },
  'json-primitive': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [json('null'), json('5'), json('"s"')], no: [json('{}'), json('[]'), json('{')] },
  'json-wrong-type-field': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [json('{"text":12}'), json('{"text":{"a":1}}')], no: [json('{"text":"a"}'), json('{"text":null}'), json('[12]')] },
  'json-duplicate-key': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [json('{"a":1,"a":2}')], no: [json('{"a":{"a":1},"b":"a"}'), json('[{"a":1},{"a":2}]'), { headers: [['Content-Type', 'text/plain']], body: '{"a":1,"a":2}' }] },
  'json-lone-surrogate': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [json('{"a":"\\ud800"}'), json('{"a":"\\udc00"}')], no: [json('{"a":"\\ud83d\\ude00"}'), json('{"a":"x"}')] },
  'json-big-integer': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [json('{"a":9007199254740993}'), json('[-12345678901234567]')], no: [json('{"a":"9007199254740993"}'), json('{"a":1.2345678901234567}'), json('{"a":1}')] },
  'json-not-utf8': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: J, body: Buffer.from([0x7b, 0xff, 0x7d]) }], no: [json('{"a":"é"}'), { headers: [['Content-Type', 'text/plain']], body: Buffer.from([0xff]) }, { headers: [...J, ['Content-Encoding', 'gzip']], body: Buffer.from([0x1f, 0x8b, 0xff]) }] },
  'json-bom': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: J, body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]) }], no: [json('{}'), { headers: [['Content-Type', 'text/plain']], body: Buffer.from([0xef, 0xbb, 0xbf]) }] },
  'json-empty': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [json(''), { headers: [['Content-Type', 'application/merge-patch+json']], body: '' }], no: [json('{}'), { headers: [['Content-Type', 'text/plain']], body: '' }] },
  'json-charset-utf8': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Type', 'application/json; charset="UTF-8"']], body: '{}' }], no: [json('{}'), { headers: [['Content-Type', 'application/json; charset=latin1']], body: '{}' }] },
  'json-charset-other': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Type', 'application/json; charset=latin1']], body: '{}' }], no: [{ headers: [['Content-Type', 'application/json; charset=utf-8']], body: '{}' }, json('{}'), { headers: [['Content-Type', 'text/plain; charset=latin1']], body: 'x' }] },
  'json-plus-type': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Type', 'application/merge-patch+json']], body: '{}' }], no: [json('{}'), { headers: [['Content-Type', 'text/x+json']], body: '{}' }] },
  'not-json-type': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Type', 'text/plain']], body: 'x' }], no: [json('{}'), { headers: [['Content-Type', 'text/plain']], body: '' }, { headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: 'a=1' }, { body: 'x' }] },
  'no-content-type': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ body: 'x' }], no: [{ body: '' }, json('{}')] },
  'urlencoded': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Type', 'Application/X-WWW-Form-Urlencoded']], body: 'a=1' }], no: [json('{}')] },
  'encoding-gzip': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Encoding', 'GZIP']] }], no: [{ headers: [['Content-Encoding', 'deflate']] }, {}] },
  'encoding-deflate': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Encoding', 'deflate']] }], no: [{ headers: [['Content-Encoding', 'gzip']] }, {}] },
  'encoding-brotli': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Encoding', 'br']] }], no: [{ headers: [['Content-Encoding', 'gzip']] }, {}] },
  'encoding-unsupported': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ headers: [['Content-Encoding', 'compress']] }], no: [{ headers: [['Content-Encoding', 'GZIP']] }, { headers: [['Content-Encoding', 'identity']] }, {}] },
  'body-over-limit': { applies: [PUT_ROUTE], not: [GET_ROUTE], yes: [{ status: 413 }], no: [{ status: 400 }, {}] },
};
const PATH_FORM_CASES = {
  options: { yes: [{ method: 'OPTIONS' }], no: [{ method: 'GET' }], registered: new Set(['GET', 'HEAD']), registeredNo: [{ method: 'OPTIONS', methods: new Set(['OPTIONS']) }] },
  'unregistered-method': { yes: [{ method: 'PATCH' }, { method: 'POST' }], no: [{ method: 'GET' }, { method: 'HEAD' }, { method: 'OPTIONS' }], registered: new Set(['GET', 'HEAD']), registeredNo: [{ method: 'POST', methods: new Set(['POST']) }] },
};

/** The run's census path with the closure check replaced by the toy's recording and rows (scenario-rows.mjs produceScenarioRows). */
async function runRows(m, { scenarios, options = {}, censusWaivers = {}, rows = rowsFor(world.steps) }) {
  scratchCount += 1;
  const prefix = `rows-${scratchCount}`;
  const scratch = { writeFile: (relative, data) => run.writeFile(`${prefix}/${relative}`, data), path: prefix };
  const group = { files: [toyFile], dependencies: () => ({ fsPromises: {} }) };
  const recording = recordingOf(m);
  const closure = async ({ scenario }) => ({ rows: rows.filter((entry) => entry.id.startsWith(`${scenario.id}/`)).map((entry) => ({ ...entry, reason: '', inconclusive: [], nondeterministic: [], judged: null })), recordings: { reference: { ...recording, scenario: scenario.id } } });
  const lines = [];
  const produced = await m.rows.produceScenarioRows({ run: scratch, group, name: 'toy', options, log: (line) => lines.push(line), scenarios, censusWaivers, censusErrors: ERRORS, closure });
  return { produced, lines };
}
const TOY_SCENARIO = Object.freeze({ id: SCENARIO, waivers: Object.fromEntries(['put-malformed', 'put-remote', 'options-tail', 'get-doubled-slash'].map((id) => [id, { outcome: 'inconclusive', checks: [id.startsWith('put') ? 'edge-exchange' : 'tail-exchange'], reason: 'the edge or tail answers it in this toy' }])) });

/**
 * The named checks. Each takes the modules (`m`: census, source, driver, rows: the real ones, or one of them a
 * planted copy) and throws when the census or its wiring is wrong.
 */
export const CHECKS = {
  'every item of the universe appears in the census, with a status': (m) => {
    const { items, routes } = readToy(m);
    const result = judge(m);
    const forms = routes.reduce((sum, route) => sum + m.census.FORMS.filter((form) => form.applies(route)).length, 0);
    const paths = new Set(routes.map((route) => route.path)).size;
    // Four routes and HEAD for each of the two GET routes; each route by both principal classes; the forms that apply; two path
    // forms per path; the code items; one declared error.
    assert.equal(routes.length, 4);
    assert.equal(result.items.length, 6 + 4 * 2 + forms + 2 * paths + items.length + 1);
    for (const item of result.items) assert.ok(m.census.STATUSES.includes(item.status), item.id);
    assert.equal(m.census.STATUSES.reduce((sum, status) => sum + result.counts[status], 0), result.items.length);
    assert.equal(result.gaps.length, result.counts.gap);
    assert.deepEqual(result.problems, []);
  },
  'the source reading finds every construct of the toy as its item': (m) => {
    const ids = readToy(m).items.map((item) => item.id);
    for (const expected of [
      'routes.js:(module):module', 'routes.js:registerToy:function registerToy',
      codeId(GET_FN, 'then if (req.query.fail)'), codeId(GET_FN, 'else if (req.query.fail) (no else)'), codeId(GET_FN, 'answer res.status(400).json({ error: \'refused\' })'), codeId(GET_FN, 'answer res.json({ ok: true, from: req.ip ?? null })'),
      codeId(GET_FN, 'envelope peer (req.ip)'),
      codeId(PUT_FN, "true typeof req.body?.size === 'number' ? req.body.size"), codeId(PUT_FN, "false typeof req.body?.size === 'number' : 0"),
      WRITE_ID, codeId(PUT_FN, 'catch catch (error)'),
      codeId(PUT_FN, 'decides size > 1 (operand 1 of || chain size > 1 || size < -1)'), codeId(PUT_FN, 'reached size < -1 (operand 2 of || chain size > 1 || size < -1)'),
      codeId(PUT_FN, "true size > 1 || size < -1 ? 'big'"), codeId(PUT_FN, "false size > 1 || size < -1 : 'small'"), codeId(PUT_FN, 'answer res.status(500).json({ error: error.message })'),
      codeId(POST_FN, 'answer res.status(201).json({ value })'), codeId(POST_FN, "throw new Error('no body')"), codeId(READ_FN, 'answer res.json(await fsPromises.readFile(req.query.name))'), codeId(READ_FN, 'call fsPromises.readFile(req.query.name)'),
    ]) assert.ok(ids.includes(expected), `no item ${expected}`);
    const write = readToy(m).items.find((item) => item.id === WRITE_ID);
    assert.equal(write.writes, true);
    assert.equal(readToy(m).items.find((item) => item.id === codeId(READ_FN, 'call fsPromises.readFile(req.query.name)')).writes, false);
    const answer = readToy(m).items.find((item) => item.id === codeId(POST_FN, 'answer res.status(201).json({ value })'));
    const line = TOY.split('\n').findIndex((text) => text.includes('res.status(201)')) + 1;
    const start = TOY.split('\n')[line - 1].indexOf('res.status(201)');
    assert.deepEqual(answer.span, { from: { line, column: start + 1 }, to: { line, column: start + 'res.status(201).json({ value })'.length + 1 } });
    // What each handler reads, from its source.
    assert.deepEqual(readToy(m).routes.map((route) => [route.method, route.path, route.reads.join(',')]), [['GET', '/api/toy', 'peer,query'], ['PUT', '/api/toy/:id', 'body'], ['POST', '/api/toy', 'body'], ['GET', '/api/toy/read', 'query']]);
  },
  'an id names the whole construct: a cut text carries a digest of all of it': (m) => {
    const long = (tail) => `export const r = (app) => { app.get('/x', async (_req, res) => { res.status(500).json({ error: 'a message long enough to be cut by the reader at seventy characters', tail: '${tail}' }); }); };\n`;
    const idOf = (text) => m.source.fileItems({ file: '/toy/x.js', relative: 'x.js', text }).items.find((item) => item.kind === 'answer').id;
    assert.notEqual(idOf(long('one')), idOf(long('two')), 'an edit past the cut changes the id');
    assert.equal(idOf(long('one')), idOf(long('one')));
    assert.match(idOf(long('one')), /…~[0-9a-f]{8}$/);
    assert.doesNotMatch(m.source.fileItems({ file: '/toy/y.js', relative: 'y.js', text: "export const r = (app) => { app.get('/x', async (_req, res) => { res.json(1); }); };\n" }).items.find((item) => item.kind === 'answer').id, /~/);
  },
  'a handler whose use of the request the reader cannot read, or an import outside the group, is a problem': (m) => {
    const handler = (body) => `export const r = (app, helper) => { app.put('/x/:id', async ${body}); };\n`;
    const read = (text) => m.source.fileItems({ file: '/toy/h.js', relative: 'h.js', text }).routes[0];
    assert.deepEqual(read(handler('(req, res) => { res.json(req.body.text, req.params?.id); }')).opaque, []);
    assert.deepEqual(read(handler('(req, res) => { res.json(req.body.text, req.params?.id); }')).reads, ['body', 'params']);
    for (const body of ['(req, res) => { const { body } = req; res.json(body); }', '(req, res) => { helper(req); res.json(1); }', '(req, res) => { res.json(req[\'body\']); }', '({ body }, res) => { res.json(body); }']) {
      const route = read(handler(body));
      assert.equal(route.opaque.length, 1, body);
      // Read as reading everything: the forms never shrink because the reader is blind.
      assert.deepEqual(route.reads, [...m.source.ALL_REQUEST_PARTS], body);
    }
    const dir = run.makeDirectory(`imports-${(scratchCount += 1)}`);
    const write = (name, text) => { fs.writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
    const a = write('a.js', "import { b } from './b.js';\nimport { c } from './c.js';\nimport fs from 'node:fs';\nexport const r = (app) => { app.get('/x', async (req, res) => { const { query } = req; res.json([b, c, query, fs]); }); };\nexport const later = () => import(process.env.X);\n");
    const b = write('b.js', 'export const b = 1;\n');
    const c = write('c.js', 'export const c = 2;\n');
    const problems = m.source.groupItems({ files: [a, b] }).problems;
    assert.ok(problems.some((line) => /imports \.\/c\.js .*not one of the group's files/.test(line)), problems.join('\n'));
    assert.ok(problems.some((line) => /named by an expression/.test(line)), problems.join('\n'));
    assert.ok(problems.some((line) => /uses its request in a way the census cannot read \(const \{ query \} = req;\)/.test(line)), problems.join('\n'));
    assert.equal(problems.some((line) => /b\.js|node:fs/.test(line)), false, problems.join('\n'));
    assert.equal(m.source.groupItems({ files: [a, b], outside: [c] }).problems.some((line) => /c\.js/.test(line)), false);
    // The census carries what the reading could not read as its problems.
    assert.ok(judge(m, { sourceProblems: ['x.js imports ./y.js'] }).problems.includes('source: x.js imports ./y.js'));
  },
  'a route counts only through a passed row that entered it by that registration; HEAD through the GET route': (m) => {
    const result = judge(m);
    assert.equal(statusOf(result, 'route GET /api/toy'), 'exercised');
    assert.deepEqual(itemOf(result, 'route HEAD /api/toy').exercisedBy, [row('head')]);
    assert.deepEqual(itemOf(result, 'route PUT /api/toy/:id').owners, ['group']);
    // The PUT route's only group rows not passed: the edge's answers on the same path never exercise the route.
    const onlyEdge = judge(m, { rows: rowsFor(world.steps, Object.fromEntries(['put-small', 'put-big', 'put-negative', 'put-fail', 'put-string'].map((id) => [id, 'unstable']))) });
    assert.equal(statusOf(onlyEdge, 'route PUT /api/toy/:id'), 'gap');
    assert.equal(statusOf(onlyEdge, 'principal unauthenticated PUT /api/toy/:id'), 'reference-only');
  },
  'a principal item counts only through an exchange of that principal class': (m) => {
    const result = judge(m);
    assert.equal(statusOf(result, 'principal local-admin GET /api/toy'), 'exercised');
    // No remote GET was made: the local administrator's rows never stand for another class.
    assert.equal(statusOf(result, 'principal unauthenticated GET /api/toy'), 'gap');
    assert.deepEqual(itemOf(result, 'principal unauthenticated PUT /api/toy/:id').exercisedBy, [row('put-remote')]);
  },
  'an item that only a row not passed reached is a gap, never exercised': (m) => {
    const branch = codeId(PUT_FN, 'catch catch (error)');
    assert.equal(statusOf(judge(m), branch), 'exercised');
    for (const outcome of ['inconclusive', 'unstable', 'unrecordable', 'failed']) {
      const result = judge(m, { rows: rowsFor(world.steps, { 'put-fail': outcome }) });
      assert.equal(statusOf(result, branch), 'gap', outcome);
      assert.ok(result.gaps.some((gap) => gap.includes(branch)), outcome);
    }
    // An inconclusive row waived for another check than edge-exchange exercises nothing either.
    const rows = rowsFor(world.steps, { 'put-fail': 'inconclusive' }).map((entry) => (entry.id === row('put-fail') ? { ...entry, waived: 'waived for another reason' } : entry));
    assert.equal(statusOf(judge(m, { rows }), branch), 'gap');
  },
  'a code item counts when V8 counted its position in a take of that exchange': (m) => {
    const result = judge(m);
    const by = (id) => itemOf(result, id).exercisedBy;
    assert.deepEqual(by(codeId(GET_FN, 'then if (req.query.fail)')).sort(), [row('get-fail'), row('get-fail-restarted')].sort());
    assert.deepEqual(by(codeId(GET_FN, 'else if (req.query.fail) (no else)')).sort(), [row('concurrent-gets'), row('get-ok'), row('head')].sort());
    assert.deepEqual(by(codeId(PUT_FN, 'decides size > 1 (operand 1 of || chain size > 1 || size < -1)')), [row('put-big')]);
    assert.deepEqual(by(codeId(PUT_FN, "false typeof req.body?.size === 'number' : 0")), [row('put-string')]);
    assert.deepEqual(by(codeId(PUT_FN, 'catch catch (error)')), [row('put-fail')]);
    // The registrar ran at the start only: the recording row.
    assert.deepEqual(by('routes.js:registerToy:function registerToy'), [row('recording')]);
    // Without its row's take, an item is not exercised (the take, not the row's claim, decides).
    const recording = recordingOf(m);
    const cut = { ...recording, coverage: recording.coverage.filter((take) => !(take.process === 0 && take.seq === 5)) };
    assert.equal(statusOf(judge(m, { recordings: [{ scenario: SCENARIO, recording: cut, touched: TOUCHED }] }), codeId(PUT_FN, 'decides size > 1 (operand 1 of || chain size > 1 || size < -1)')), 'gap');
    // A recording without coverage establishes no code item, and says so.
    const bare = judge(m, { recordings: [{ scenario: SCENARIO, recording: { ...recording, coverage: [] }, touched: TOUCHED }] });
    assert.ok(bare.problems.some((line) => /no block coverage/.test(line)));
    assert.equal(statusOf(bare, codeId(GET_FN, 'then if (req.query.fail)')), 'gap');
  },
  'after a restart, a take belongs to the exchange of its own process': (m) => {
    const recording = recordingOf(m);
    assert.deepEqual([...new Set(recording.coverage.map((take) => take.process))], [0, 1]);
    // Process 1's first exchange took the then-branch; process 0's first exchange (get-ok, the same seq) did not.
    const then = itemOf(judge(m), codeId(GET_FN, 'then if (req.query.fail)'));
    assert.ok(then.exercisedBy.includes(row('get-fail-restarted')));
    assert.equal(then.exercisedBy.includes(row('get-ok')), false);
    // Only get-fail-restarted: without get-fail, the then-branch stays exercised through process 1.
    assert.equal(statusOf(judge(m, { rows: rowsFor(world.steps, { 'get-fail': 'unstable' }) }), codeId(GET_FN, 'then if (req.query.fail)')), 'exercised');
    assert.equal(statusOf(judge(m, { rows: rowsFor(world.steps, { 'get-fail': 'unstable', 'get-fail-restarted': 'unstable' }) }), codeId(GET_FN, 'then if (req.query.fail)')), 'gap');
  },
  'the reference\'s Date lag is read from its tap: stale heads and late boundary timers': (m) => {
    const recording = recordingOf(m);
    assert.deepEqual(recording.dateLag, { heads: 5, timer: 3 });
    assert.equal(recording.dateLagMs, 5);
    assert.equal(m.driver.staleDateMs({ head: `HTTP/1.1 200 OK\r\nDate: ${new Date(T0).toUTCString()}\r\n\r\n`, headAt: T0 + 999 }), 0);
    assert.equal(m.driver.staleDateMs({ head: `HTTP/1.1 200 OK\r\nDate: ${new Date(T0).toUTCString()}\r\n\r\n`, headAt: T0 + 1_000 }), 1);
    assert.equal(m.driver.staleDateMs({ head: 'HTTP/1.1 200 OK\r\n\r\n', headAt: T0 }), 0);
  },
  'the start-up take counts only for a recording row that passed': (m) => {
    assert.equal(statusOf(judge(m), 'routes.js:registerToy:function registerToy'), 'exercised');
    const result = judge(m, { rows: rowsFor(world.steps, { recording: 'inconclusive' }) });
    assert.equal(statusOf(result, 'routes.js:registerToy:function registerToy'), 'gap');
    assert.equal(statusOf(result, 'routes.js:(module):module'), 'gap');
  },
  'an answer counts only when the tap saw the group answer from it; a write only when its step changed the tree': (m) => {
    const result = judge(m);
    const created = codeId(POST_FN, 'answer res.status(201).json({ value })');
    const read = codeId(READ_FN, 'answer res.json(await fsPromises.readFile(req.query.name))');
    // V8 counted both answers' blocks in the failing exchanges (P1, P2): the block count alone would say they ran.
    const recording = recordingOf(m);
    const items = new Map(readToy(m).items.map((item) => [item.id, item]));
    const takeOf = (step) => { const record = world.steps.find((entry) => entry.id === step).exchanges[0]; return recording.coverage.find((take) => take.process === record.process && take.seq === record.armSeq); };
    assert.equal(m.census.probeExecuted(takeOf('post-not-json'), items.get(created)), true);
    assert.equal(m.census.probeExecuted(takeOf('read-missing'), items.get(read)), true);
    assert.deepEqual(itemOf(result, created).exercisedBy, [row('post-json')]);
    assert.deepEqual(itemOf(result, read).exercisedBy, [row('read-present')]);
    const withoutSuccess = judge(m, { rows: rowsFor(world.steps, { 'post-json': 'unstable', 'read-present': 'unstable' }) });
    assert.equal(statusOf(withoutSuccess, created), 'gap');
    assert.equal(statusOf(withoutSuccess, read), 'gap');
    // Their catch answers are what those exchanges answered.
    assert.ok(itemOf(withoutSuccess, codeId(POST_FN, "answer res.status(500).json({ error: 'not json' })")).exercisedBy.includes(row('post-not-json')));
    // The write: exercised by the PUTs that changed the tree, never by put-fail (the write threw); unknown steps: a problem.
    assert.deepEqual(itemOf(result, WRITE_ID).exercisedBy.sort(), TOUCHED.map(row).sort());
    assert.equal(statusOf(judge(m, { recordings: [{ scenario: SCENARIO, recording, touched: [] }] }), WRITE_ID), 'gap');
    const unknown = judge(m, { recordings: [{ scenario: SCENARIO, recording, touched: null }] });
    assert.ok(unknown.problems.some((line) => /without the steps that changed its data root/.test(line)));
    assert.equal(statusOf(unknown, WRITE_ID), 'gap');
    // The answer site is matched by position: a site elsewhere in the file does not count.
    const answer = items.get(created);
    assert.equal(m.census.answeredAt({ sites: [{ owner: 'group', file: toyFile, line: answer.span.from.line, column: answer.span.from.column + 3 }] }, { ...answer, file: toyFile }), true);
    assert.equal(m.census.answeredAt({ sites: [{ owner: 'group', file: toyFile, line: answer.span.from.line, column: answer.span.from.column - 1 }] }, { ...answer, file: toyFile }), false);
    assert.equal(m.census.answeredAt({ sites: [{ owner: 'group', file: toyFile, line: answer.span.to.line + 1, column: 1 }] }, { ...answer, file: toyFile }), false);
  },
  'a declared error counts when its call ran and the exchange answered its code': (m) => {
    const result = judge(m);
    const id = `error EIO ${WRITE_ID}`;
    assert.deepEqual(itemOf(result, id).exercisedBy, [row('put-fail')]);
    assert.equal(statusOf(judge(m, { rows: rowsFor(world.steps, { 'put-fail': 'unstable' }) }), id), 'gap');
    assert.equal(statusOf(judge(m, { errors: [{ call: WRITE_ID, codes: ['EACCES'], why: 'not met by the toy' }] }), `error EACCES ${WRITE_ID}`), 'gap');
    assert.ok(judge(m, { errors: [{ call: 'routes.js:nothing', codes: ['EIO'], why: 'x' }] }).problems.some((line) => /no call item has that id/.test(line)));
  },
  'a take no exchange owns, or a V8 function the source does not name, is a problem': (m) => {
    const recording = recordingOf(m);
    const stray = { ...recording, coverage: [...recording.coverage, { ...recording.coverage.find((take) => take.process === 0 && take.seq === 2), seq: 99 }] };
    assert.ok(judge(m, { recordings: [{ scenario: SCENARIO, recording: stray, touched: TOUCHED }] }).problems.some((line) => /no exchange of the recording owns/.test(line)));
    const take = recording.coverage.find((entry) => entry.process === 0 && entry.seq === 1);
    const shifted = { ...recording, coverage: [...recording.coverage, { ...take, files: take.files.map((script) => ({ ...script, functions: script.functions.map((fn) => ({ ...fn, start: fn.start + 1 })) })) }] };
    assert.ok(judge(m, { recordings: [{ scenario: SCENARIO, recording: shifted, touched: TOUCHED }] }).problems.some((line) => /cannot be placed/.test(line)));
    // A function counted without block counts cannot say which block ran.
    const blockless = { ...recording, coverage: [...recording.coverage, { ...take, files: take.files.map((script) => ({ ...script, functions: script.functions.map((fn) => ({ ...fn, block: false })) })) }] };
    assert.ok(judge(m, { recordings: [{ scenario: SCENARIO, recording: blockless, touched: TOUCHED }] }).problems.some((line) => /without block counts/.test(line)));
  },
  'group code in a take of an exchange the edge or the tail answered is a problem, and credits nothing': (m) => {
    const recording = recordingOf(m);
    const groupTake = recording.coverage.find((take) => take.process === 0 && take.seq === 2);
    const edgeSeq = world.steps.find((step) => step.id === 'put-malformed').exchanges[0].armSeq;
    const tailSeq = world.steps.find((step) => step.id === 'options-tail').exchanges[0].armSeq;
    for (const seq of [edgeSeq, tailSeq]) {
      const moved = { ...recording, coverage: recording.coverage.map((take) => (take.process === 0 && take.seq === seq ? { ...groupTake, seq } : take)) };
      const result = judge(m, { recordings: [{ scenario: SCENARIO, recording: moved, touched: TOUCHED }] });
      assert.ok(result.problems.some((line) => /during an exchange the (edge|tail) answered/.test(line)), result.problems.join('\n'));
      const then = itemOf(result, codeId(GET_FN, 'then if (req.query.fail)'));
      assert.equal(then.exercisedBy.some((id) => id === row('put-malformed') || id === row('options-tail')), false);
    }
  },
  'a concurrent step\'s admissible serialisation owns its take and credits nothing': (m) => {
    const result = judge(m);
    assert.deepEqual(result.problems, []);
    assert.equal(itemOf(result, codeId(GET_FN, 'then if (req.query.fail)')).exercisedBy.includes(row('concurrent-gets')), false);
    // The serialisation's request had a trailing slash (the member's had none): the form is not exercised by the rerun.
    assert.equal(statusOf(result, 'form trailing-slash GET /api/toy'), 'gap');
  },
  'a form is owned by whoever the tap saw answer it; one only the edge or the tail answered is reference only': (m) => {
    const result = judge(m);
    assert.deepEqual(itemOf(result, 'form body-malformed-json PUT /api/toy/:id').owners, ['edge']);
    assert.equal(statusOf(result, 'form body-malformed-json PUT /api/toy/:id'), 'reference-only');
    assert.deepEqual(itemOf(result, 'form trailing-slash PUT /api/toy/:id').exercisedBy, [row('put-big')]);
    assert.equal(statusOf(result, 'form trailing-slash PUT /api/toy/:id'), 'exercised');
    assert.equal(statusOf(result, 'form trailing-slash GET /api/toy'), 'gap');
    // A doubled slash reaches no route of Express (the tail): matched by the normalised path, reference only.
    assert.deepEqual(itemOf(result, 'form empty-segment GET /api/toy').exercisedBy, [row('get-doubled-slash')]);
    assert.equal(statusOf(result, 'form empty-segment GET /api/toy'), 'reference-only');
    assert.equal(statusOf(result, 'form options /api/toy'), 'reference-only');
    assert.equal(result.counts['reference-only'], result.items.filter((item) => item.status === 'reference-only').length);
    assert.ok(m.census.censusLines(result).some((line) => /^CENSUS ref {2}form options \/api\/toy <- toy\.census\/options-tail \[tail\] \(reference only: never sent to a candidate\)$/.test(line)));
    // The edge's row not waived (unstable): the form is not exercised at all.
    assert.equal(statusOf(judge(m, { rows: rowsFor(world.steps, { 'put-malformed': 'unstable' }) }), 'form body-malformed-json PUT /api/toy/:id'), 'gap');
  },
  'a tail exchange counts only through a row waived for exactly tail-exchange': (m) => {
    assert.equal(statusOf(judge(m), 'form options /api/toy'), 'reference-only');
    const open = rowsFor(world.steps).map((entry) => (entry.id === row('options-tail') ? { ...entry, waived: null } : entry));
    assert.equal(statusOf(judge(m, { rows: open }), 'form options /api/toy'), 'gap');
    const more = rowsFor(world.steps).map((entry) => (entry.id === row('options-tail') ? { ...entry, checks: ['tail-exchange', 'stability-incomplete'] } : entry));
    assert.equal(statusOf(judge(m, { rows: more }), 'form options /api/toy'), 'gap');
  },
  'census waivers: a waived item is not a gap; one naming no item, without a reason or of an exercised item is a problem': (m) => {
    const branch = codeId(GET_FN, 'answer res.status(400).json({ error: \'refused\' })');
    const rows = rowsFor(world.steps, { 'get-fail': 'unstable', 'get-fail-restarted': 'unstable' });
    const waived = judge(m, { rows, waivers: { [branch]: { reason: 'a reason long enough to be one' } } });
    assert.equal(statusOf(waived, branch), 'waived');
    assert.equal(waived.gaps.some((gap) => gap.includes(branch)), false);
    assert.deepEqual(waived.problems, []);
    const nothing = judge(m, { waivers: { 'routes.js:no such item': { reason: 'a reason long enough to be one' } } });
    assert.ok(nothing.problems.some((line) => /names no item/.test(line)));
    const reasonless = judge(m, { rows, waivers: { [branch]: { reason: 'x' } } });
    assert.ok(reasonless.problems.some((line) => /has no reason/.test(line)));
    assert.equal(statusOf(reasonless, branch), 'gap');
    const exercised = judge(m, { waivers: { [branch]: { reason: 'a reason long enough to be one' } } });
    assert.ok(exercised.problems.some((line) => /waives an item that is exercised/.test(line)));
    const referenceOnly = judge(m, { waivers: { 'form options /api/toy': { reason: 'a reason long enough to be one' } } });
    assert.ok(referenceOnly.problems.some((line) => /waives an item that is exercised/.test(line)));
  },
  'registrations against the source: a route only one of them names is a problem': (m) => {
    const recording = recordingOf(m);
    const extra = { ...recording, registrations: [...recording.registrations, { kind: 'route', method: 'DELETE', path: '/api/toy', file: toyFile, line: 99 }] };
    assert.ok(judge(m, { recordings: [{ scenario: SCENARIO, recording: extra, touched: TOUCHED }] }).problems.some((line) => /does not register as a literal/.test(line)));
    const missing = judge(m, { routes: [...readToy(m).routes, { method: 'DELETE', path: '/api/toy/:id', line: 30, file: toyFile, reads: [] }] });
    assert.ok(missing.problems.some((line) => /never saw registered/.test(line)));
  },
  'two references that registered other routes, a file digest that changed or is missing, or an item twice are problems': (m) => {
    const recording = recordingOf(m);
    const other = { ...recording, registrations: recording.registrations.slice(1) };
    const two = judge(m, { recordings: [{ scenario: SCENARIO, recording, touched: TOUCHED }, { scenario: 'toy.other', recording: other, touched: [] }] });
    assert.ok(two.problems.some((line) => /registered other routes than the reference of toy\.census/.test(line)), two.problems.join('\n'));
    assert.deepEqual(judge(m, { sources: { [toyFile]: world.digest } }).problems, []);
    assert.ok(judge(m, { sources: { [toyFile]: '0'.repeat(16) } }).problems.some((line) => /is not the one read now/.test(line)));
    assert.ok(judge(m, { sources: { [toyFile]: world.digest }, recordings: [{ scenario: SCENARIO, recording: { ...recording, groupSources: null }, touched: TOUCHED }] }).problems.some((line) => /does not say which group files its host ran/.test(line)));
    const items = readToy(m).items;
    assert.ok(judge(m, { items: [...items, items[3]] }).problems.some((line) => /appears twice/.test(line)));
  },
  'without a scenario, the items it alone exercised become gaps, and the census names them': (m) => {
    const recording = recordingOf(m);
    const second = { scenario: 'toy.second', recording: { ...recording, steps: world.steps.filter((step) => step.id === 'get-ok'), coverage: recording.coverage.filter((take) => take.process === 0 && take.seq <= 1) }, touched: [] };
    const input = inputOf(m, { recordings: [{ scenario: SCENARIO, recording, touched: TOUCHED }, second], rows: [...rowsFor(world.steps), ...rowsFor(second.recording.steps, {}, 'toy.second')] });
    const both = m.census.judgeCensus(input);
    const sole = both.sole[SCENARIO];
    assert.ok(sole.includes(codeId(PUT_FN, 'catch catch (error)')));
    assert.equal(sole.includes(codeId(GET_FN, 'else if (req.query.fail) (no else)')), false, 'the second scenario exercises it too');
    const without = m.census.judgeCensus(m.census.withoutScenario(input, SCENARIO));
    const lost = without.items.filter((item) => item.status === 'gap').map((item) => item.id);
    for (const id of sole) assert.ok(lost.includes(id), `${id} lost its only exercise`);
    assert.equal(statusOf(without, codeId(GET_FN, 'else if (req.query.fail) (no else)')), 'exercised');
  },
  'a comparer rule the group declares nothing for is said unused; one it declares is a problem until shown applied': (m) => {
    const none = judge(m, { declarations: { identifierKeys: [], timeKeys: [], effects: [] } });
    assert.equal(none.notes.filter((note) => /: unused, the group declares nothing for it$/.test(note)).length, 3);
    assert.deepEqual(none.problems, []);
    const declared = judge(m, { declarations: { identifierKeys: [], timeKeys: ['updatedAt'], effects: [] } });
    assert.ok(declared.problems.some((line) => /^rule W .* declared for updatedAt/.test(line)));
  },
  'every request form: the routes it applies to, and observations that have it and that do not': (m) => {
    assert.deepEqual(m.census.FORMS.map((form) => form.id).sort(), Object.keys(FORM_CASES).sort(), 'every form of the catalog has cases');
    assert.deepEqual(m.census.PATH_FORMS.map((form) => form.id).sort(), Object.keys(PATH_FORM_CASES).sort());
    for (const form of m.census.FORMS) {
      const cases = FORM_CASES[form.id];
      for (const route of cases.applies) assert.equal(form.applies(route), true, `${form.id} applies to ${route.method} ${route.path}`);
      for (const route of cases.not ?? []) assert.equal(form.applies(route), false, `${form.id} does not apply to ${route.method} ${route.path} (${route.reads})`);
      const route = cases.route ?? cases.applies[0];
      for (const spec of cases.yes) assert.equal(form.has(obs(spec), route), true, `${form.id} has ${JSON.stringify(spec)}`);
      for (const spec of cases.no) assert.equal(form.has(obs(spec), route), false, `${form.id} has not ${JSON.stringify(spec)}`);
    }
    for (const form of m.census.PATH_FORMS) {
      const cases = PATH_FORM_CASES[form.id];
      for (const spec of cases.yes) assert.equal(form.has(obs(spec), cases.registered), true, `${form.id} has ${JSON.stringify(spec)}`);
      for (const spec of cases.no) assert.equal(form.has(obs(spec), cases.registered), false, `${form.id} has not ${JSON.stringify(spec)}`);
      for (const spec of cases.registeredNo) assert.equal(form.has(obs(spec), spec.methods), false, `${form.id}: a registered method`);
    }
    assert.equal(m.census.hasDuplicateKey('{"a":1,"a":2}'), true);
    assert.equal(m.census.routeMatcher('/api/toy/:id').test('/API/Toy/x/'), true);
    assert.equal(m.census.routeMatcher('/api/toy/:id').test('/api/toy/x/y'), false);
    assert.equal(m.census.routeMatcher('/api/toy/*rest'), null);
  },
  'the run: census gaps and problems are run gaps; a run of some scenarios is never complete': async (m) => {
    const whole = await runRows(m, { scenarios: [TOY_SCENARIO] });
    const gaps = whole.produced.gaps;
    // The toy's census has gaps (GET with a trailing slash, the remote GET) and, with a waiver naming nothing, a problem: both are run gaps.
    assert.ok(gaps.some((gap) => gap.startsWith('toy: form trailing-slash GET /api/toy ')), gaps.join('\n'));
    assert.ok(gaps.some((gap) => gap.startsWith('toy: principal unauthenticated GET /api/toy ')), gaps.join('\n'));
    assert.deepEqual(whole.produced.unjudged, []);
    assert.ok(whole.lines.some((line) => /^census: \d+ items: \d+ exercised, \d+ reference only, 0 waived, \d+ gaps; 0 problems$/.test(line)), whole.lines.join('\n'));
    assert.equal(whole.produced.limits.some((limit) => limit.name === 'census-not-judged'), false);
    const problem = await runRows(m, { scenarios: [TOY_SCENARIO], censusWaivers: { 'routes.js:no such item': { reason: 'a reason long enough to be one' } } });
    assert.ok(problem.produced.gaps.includes('toy: census problem: census waiver routes.js:no such item names no item'), problem.produced.gaps.join('\n'));
    const judged = judgeRun({ rows: whole.produced.rows, waivers: whole.produced.waivers, gaps, unjudged: whole.produced.unjudged });
    assert.equal(judged.exit, 2);
    assert.equal(judged.verdict, 'INCOMPLETE');
    // Some scenarios: no census, the named limit, and the run incomplete with the reason on its last line.
    const some = await runRows(m, { scenarios: [TOY_SCENARIO, { id: 'toy.other', waivers: {} }], options: { scenarios: [SCENARIO] } });
    assert.deepEqual(some.produced.unjudged, ['census']);
    assert.equal(some.produced.gaps.length, 0);
    assert.ok(some.produced.limits.some((limit) => limit.name === 'census-not-judged' && limit.count === 1));
    assert.equal(some.lines.some((line) => line.startsWith('census:')), false);
    const allPassed = rowsFor(world.steps).filter((entry) => entry.outcome === 'passed').map((entry) => ({ ...entry, waived: undefined }));
    const partial = judgeRun({ rows: allPassed, gaps: [], unjudged: some.produced.unjudged });
    assert.equal(partial.exit, 2);
    assert.match(lastLine(partial), /^backend conformance: INCOMPLETE \(.*; 0 census gaps; 0 problems; not judged: census\) exit 2$/);
    assert.equal(judgeRun({ rows: allPassed }).exit, 0, 'the same rows with the census judged and clean pass');
  },
};

/** Planted mistakes, each in a copy of one module (the builder's, the BH5 reviewer's, and this fix round's own). */
const BUILDER = [
  ['item-dropped', 'coverage-census.mjs', "  for (const item of codeItems) add({ ...item, kind: 'code', codeKind: item.kind });", "  for (const item of codeItems) if (item.kind !== 'catch') add({ ...item, kind: 'code', codeKind: item.kind });"],
  ['path-forms-dropped', 'coverage-census.mjs', '  for (const routePath of paths) for (const form of PATH_FORMS) add(', '  for (const routePath of []) for (const form of PATH_FORMS) add('],
  ['catch-not-read', 'census-source.mjs', '    } else if (ts.isCatchClause(node)) {', '    } else if (false) {'],
  ['gap-counted-as-exercised', 'coverage-census.mjs', "  if (row.outcome === 'passed' && !row.whole) return 'passed';", "  if (row.outcome !== 'failed' && !row.whole) return 'passed';"],
  ['edge-row-exercises-route', 'coverage-census.mjs', "        if (owner === 'group' && obs.method === item.route.method && obs.registration?.path === item.route.path && obs.registration.method === (item.route.implicitOf ?? item.route.method)) exercise(item, obs, 'group');", '        if (targets(item.route, obs) && obs.method === item.route.method) exercise(item, obs, owner);'],
  ['row-claim-trusted', 'coverage-census.mjs', '      const ran = codeItemsHere.filter((item) => probeExecuted(take, item));', '      const ran = codeItemsHere.filter((item) => probeExecuted(take, item) || take.seq > 0);'],
  ['outer-range-counted', 'coverage-census.mjs', '(best === null || end - start <= best[1] - best[0])', '(best === null || end - start >= best[1] - best[0])'],
  ['unowned-take-silent', 'coverage-census.mjs', '      if (!rowId) { problems.push(', '      if (!rowId) { continue; problems.push('],
  ['unwaived-edge-form-counted', 'coverage-census.mjs', "  if (row.outcome === 'inconclusive' && row.waived && row.checks?.length === 1 && row.checks[0] === 'edge-exchange') return 'edge';", "  if (row.checks?.includes('edge-exchange') || row.outcome === 'unstable') return 'edge';"],
  ['waiver-matching-nothing-accepted', 'coverage-census.mjs', "    if (!byId.has(id)) { problems.push(`census waiver ${id} names no item`); continue; }", '    if (!byId.has(id)) continue;'],
  ['waiver-of-exercised-accepted', 'coverage-census.mjs', '    else if (byId.get(id).exercisedBy.length) problems.push(', '    else if (false) problems.push('],
  ['unregistered-route-silent', 'coverage-census.mjs', '  for (const entry of routeRegistrations) if (!routes.some((route) => route.method === entry.method && route.path === entry.path)) problems.push(', '  for (const entry of []) if (!routes.some((route) => route.method === entry.method && route.path === entry.path)) problems.push('],
  ['sole-from-any-scenario', 'coverage-census.mjs', '.filter((item) => item.exercisedBy.length && item.exercisedBy.every((row) => row.startsWith(`${scenario}/`)))', '.filter((item) => item.exercisedBy.length && item.exercisedBy.some((row) => row.startsWith(`${scenario}/`)))'],
];
// The reviewer's 33 (reports/BH5-review-probes/review-plants.mjs). Where this round moved the code a plant weakens, its anchor is
// the same mistake on the code as it is now (noted per plant in the BH5 report).
const REVIEWER = [
  ['answers-dropped', 'census-source.mjs', '      if (!methods.some((method) => ANSWER_METHODS.has(method))) return;', '      return;'],
  ['throws-dropped', 'census-source.mjs', '    } else if (ts.isThrowStatement(node)) {', '    } else if (false) {'],
  ['dependency-calls-dropped', 'census-source.mjs', '    } else if (dependencyNames.has(base.text) && ts.isPropertyAccessExpression(outer.expression)) {', '    } else if (false) {'],
  ['envelope-reads-dropped', 'census-source.mjs', "      if (ENVELOPE_OF[part]) add('envelope'", "      if (false) add('envelope'"],
  ['implicit-else-no-minus', 'census-source.mjs', '{ at: node.getStart(source), minus: node.thenStatement.getStart(source) }', '{ at: node.getStart(source) }'],
  ['decides-no-minus', 'census-source.mjs', '{ at: operand.getStart(source), minus: operands[index + 1].getStart(source) }', '{ at: operand.getStart(source) }'],
  ['body-reads-ignored', 'census-source.mjs', "const REQUEST_PARTS = Object.freeze({ body: 'body',", "const REQUEST_PARTS = Object.freeze({ body: 'nobody',"],
  ['ternary-false-dropped', 'census-source.mjs', "      add('false', node,", "      if (false) add('false', node,"],
  ['start-take-credited-always', 'coverage-census.mjs', "(take.seq === 0 && counts === 'recording')", '(take.seq === 0)'],
  ['edge-take-credits-code', 'coverage-census.mjs', "      if (obs && obs.kind !== 'group') { problems.push(", "      if (false) { problems.push("],
  ['waived-edge-row-credits-code', 'coverage-census.mjs', "      if (obs && obs.kind !== 'group') { problems.push(", '      if (obs && obs.kind !== \'group\' && counts === null) { problems.push('],
  ['minus-greater-or-equal', 'coverage-census.mjs', '  return at > countAt(take, item.file, item.fn, item.probe.minus);', '  return at >= countAt(take, item.file, item.fn, item.probe.minus);'],
  ['function-count-not-block', 'coverage-census.mjs', '  for (const [start, end, count] of found.ranges) if (start <= at && at < end && (best === null || end - start <= best[1] - best[0])) best = [start, end, count];', '  best = found.ranges[0];'],
  ['principal-class-ignored', 'coverage-census.mjs', '        if (obs.principalClass === item.principalClass && targets(item.route, obs)) exercise(item, obs, owner);', '        if (targets(item.route, obs)) exercise(item, obs, owner);'],
  ['tail-row-unwaived-counts', 'coverage-census.mjs', "  if (row.outcome === 'inconclusive' && row.waived && row.checks?.length === 1 && row.checks[0] === 'tail-exchange') return 'tail';", "  if (row.checks?.includes('tail-exchange')) return 'tail';"],
  ['waiver-any-reason', 'coverage-census.mjs', "waiver && typeof waiver.reason === 'string' && waiver.reason.trim().length >= 20 ? 'waived' : 'gap'", "waiver ? 'waived' : 'gap'"],
  ['source-digest-unchecked', 'coverage-census.mjs', '    if (sources) for (const [file, digest]', '    if (false) for (const [file, digest]'],
  ['no-coverage-silent', 'coverage-census.mjs', '    if (!(recording.coverage ?? []).length) problems.push(', '    if (false) problems.push('],
  ['head-item-dropped', 'coverage-census.mjs', "    if (route.method === 'GET') add({ id: `route HEAD", '    if (false) add({ id: `route HEAD'],
  ['conditional-fresh-any', 'coverage-census.mjs', "has: (obs) => header(obs, 'if-none-match') !== null && obs.status === 304 },", 'has: () => true },'],
  ['trailing-slash-any', 'coverage-census.mjs', "has: (obs, route) => !route.path.endsWith('/') && pathOf(obs.url).endsWith('/') },", 'has: () => true },'],
  ['unplaced-function-silent', 'coverage-census.mjs', '        if (!knownFunctions.has(key) && !unplaced.has(key)) { unplaced.add(key); problems.push(', '        if (false) { unplaced.add(key); problems.push('],
  ['block-false-silent', 'coverage-census.mjs', '        if (fn.block === false && fn.ranges.some(', '        if (false && fn.ranges.some('],
  ['registrations-differ-silent', 'coverage-census.mjs', '    if (mine !== JSON.stringify(registrations.map(', '    if (false && mine !== JSON.stringify(registrations.map('],
  ['duplicate-ids-silent', 'coverage-census.mjs', '  for (const item of items) { if (ids.has(item.id)) problems.push(`item ${item.id} appears twice`); ids.add(item.id); }', ''],
  ['declared-rules-silent', 'coverage-census.mjs', '    else problems.push(`rule ${rule} is declared for', '    else notes.push(`rule ${rule} is declared for'],
  ['census-gaps-not-counted', 'scenario-rows.mjs', '    gaps.push(...census.gaps, ...census.problems.map(', '    gaps.push(...census.problems.map('],
  ['census-problems-not-counted', 'scenario-rows.mjs', '    gaps.push(...census.gaps, ...census.problems.map((problem) => `${name}: census problem: ${problem}`));', '    gaps.push(...census.gaps);'],
  ['census-never-judged', 'scenario-rows.mjs', '  if (chosen.length < scenarios.length) { runLimits.push(', '  if (true) { runLimits.push('],
  ['take-process-zero', 'driver.mjs', "      if (record.type === 'coverage') coverage.push({ process: index,", "      if (record.type === 'coverage') coverage.push({ process: 0,"],
];
// This round's own (S2 to S6, M1 to M3, the Date lag reader).
const ROUND = [
  ['subset-unjudged-dropped', 'scenario-rows.mjs', " unjudged.push('census'); }", ' }'],
  ['answer-site-ignored', 'coverage-census.mjs', "        if (item.codeKind === 'answer' && !(obs && answeredAt(obs, item))) continue;", ''],
  ['answer-site-by-line-only', 'coverage-census.mjs', '(Number.isInteger(site.column) ? before(item.span.from, site) && before(site, item.span.to) :', '(false ? null :'],
  ['write-untouched-credited', 'coverage-census.mjs', "        if (item.codeKind === 'call' && item.writes && !(obs && obs.touched === true)) continue;", ''],
  ['touched-unknown-silent', 'coverage-census.mjs', "    if (touched === null || touched === undefined) problems.push(", '    if (false) problems.push('],
  ['serial-credited', 'coverage-census.mjs', '      if (obs?.serial) continue;', ''],
  ['serial-forms-credited', 'coverage-census.mjs', '    if (obs.serial) continue;', ''],
  ['reference-only-as-exercised', 'coverage-census.mjs', "    item.status = item.owners.has('group') ? 'exercised' : item.exercisedBy.length ? 'reference-only'", "    item.status = item.exercisedBy.length ? 'exercised' : item.exercisedBy.length ? 'reference-only'"],
  ['no-digests-silent', 'coverage-census.mjs', '    if (sources && !recording.groupSources) problems.push(', '    if (false) problems.push('],
  ['error-any-answer', 'coverage-census.mjs', ' && obs.answer.includes(`${item.code}:`)) {', ') {'],
  ['source-problems-dropped', 'coverage-census.mjs', '  const problems = [...sourceProblems.map((text) => `source: ${text}`)];', '  const problems = [];'],
  ['normalised-forms-raw', 'coverage-census.mjs', '    if (normalised) return obs.kind !== \'group\' && method && route.matcher?.test(normalisedPath(obs.url));', ''],
  ['opaque-request-ignored', 'census-source.mjs', '    if (handler && handler.request && ts.isIdentifier(node) && node.text === handler.request && !isReadOfPart(node) && !isDeclarationName(node)) {', '    if (false) {'],
  ['opaque-reads-shrink', 'census-source.mjs', 'reads: entry.opaque.length ? [...ALL_REQUEST_PARTS] : [...entry.reads].sort()', 'reads: [...entry.reads].sort()'],
  ['outside-import-silent', 'census-source.mjs', "      if (!own.has(target) && !declared.has(target)) problems.push(", '      if (false) problems.push('],
  ['id-cut-without-digest', 'census-source.mjs', '  return `${flat.slice(0, max - 1)}…~${crypto.createHash(\'sha256\').update(flat).digest(\'hex\').slice(0, 8)}`;', '  return `${flat.slice(0, max - 1)}…`;'],
  ['stale-head-unread', 'driver.mjs', "      if (record.type === 'exchange') dateLag.heads = Math.max(dateLag.heads, staleDateMs(record.response));", ''],
  ['clock-unread', 'driver.mjs', "      if (record.type === 'clock' && Number.isFinite(record.dateLagMs)) dateLag.timer = Math.max(dateLag.timer, record.dateLagMs);", ''],
];
export const CENSUS_PLANTS = Object.freeze([...BUILDER.map((entry) => [...entry, 'builder']), ...REVIEWER.map((entry) => [...entry, 'reviewer']), ...ROUND.map((entry) => [...entry, 'fix round 1'])].map(([id, module, find, replace, by]) => Object.freeze({ id, module, find, replace, by })));
const KEY = { 'coverage-census.mjs': 'census', 'census-source.mjs': 'source', 'driver.mjs': 'driver', 'scenario-rows.mjs': 'rows' };
const REAL = { census, source, driver, rows: rowsModule };

/** A planted copy of one module, its relative imports pointed at the real modules here (so only the plant differs). */
async function plantedModule(plant, sources) {
  let text = sources[plant.module].replace(plant.find, plant.replace);
  text = text.replace("createRequire(path.join(HERE, '../../package.json'))", `createRequire(${JSON.stringify(path.join(HERE, '../../package.json'))})`);
  text = text.replace(/(from |import\()'(\.\.?\/[^']+)'/g, (_all, lead, specifier) => `${lead}'${pathToFileURL(path.resolve(HERE, specifier)).href}'`);
  const file = run.writeFile(`plants/${plant.id}/${plant.module}`, text);
  return import(pathToFileURL(file).href);
}
/** Runs every named check against `m`; returns the names of those that failed. */
async function failingChecks(m) {
  const failed = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    try { await check(m); } catch { failed.push(name); }
  }
  return failed;
}

describe('the census on fixed inputs', () => {
  before(async () => {
    run = createBackendRun({ owner: 'backend-conformance-census-test', signals: 'exit' });
    world = await recordToy();
  });
  let status = 'failed';
  after(() => { try { run?.finish(status); } catch { /* finished */ } });

  for (const [name, check] of Object.entries(CHECKS)) test(name, () => check(REAL));

  test('the census of the toy: a few gaps, each named, and the table says why', () => {
    const result = judge(REAL);
    assert.deepEqual(result.problems, []);
    const lines = census.censusLines(result);
    assert.match(lines.at(-1), /^census: \d+ items: \d+ exercised, \d+ reference only, 0 waived, \d+ gaps; 0 problems$/);
    assert.ok(lines.some((line) => line.startsWith('CENSUS GAP  form trailing-slash GET /api/toy')));
    assert.ok(lines.some((line) => /^CENSUS ok {3}route GET \/api\/toy <- toy\.census\/get-ok \(\+\d+\) \[group\]$/.test(line)));
  });

  test('planted mistakes: each fails at least one named check (every plant against every check)', async (t) => {
    const sources = Object.fromEntries(Object.keys(KEY).map((name) => [name, fs.readFileSync(path.join(HERE, name), 'utf8')]));
    const table = [];
    for (const plant of CENSUS_PLANTS) {
      assert.equal(sources[plant.module].split(plant.find).length - 1, 1, `plant ${plant.id}: its anchor is found once in ${plant.module}`);
      let planted;
      try { planted = await plantedModule(plant, sources); } catch (error) { table.push({ plant, failed: [], broken: String(error.message).split('\n')[0] }); continue; }
      const failed = await failingChecks({ ...REAL, [KEY[plant.module]]: planted });
      table.push({ plant, failed });
    }
    t.diagnostic(table.map(({ plant, failed, broken }) => `${plant.id} (${plant.by}, ${plant.module}): ${broken ? `PLANT BROKEN: ${broken}` : failed.length ? `caught by ${failed.length}: ${failed.join(' | ')}` : 'ESCAPED'}`).join('\n'));
    assert.deepEqual(table.filter((entry) => entry.broken).map((entry) => `${entry.plant.id}: ${entry.broken}`), [], 'every plant is a module that loads');
    assert.deepEqual(table.filter((entry) => entry.failed.length === 0).map((entry) => entry.plant.id), [], 'every plant is caught');
    // The unchanged modules pass every check (the plants are caught by the change, not by the copy).
    assert.deepEqual(await failingChecks(REAL), []);
    status = 'passed';
  });
});
