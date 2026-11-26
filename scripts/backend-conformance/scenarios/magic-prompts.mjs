// The pilot's scenarios (BH2; design file 31 §4.2, §9 "Why magic-prompts"):
// the four routes of packages/web/server/lib/magic-prompts/routes.js, as the
// server registers them through the feature routes (groups.mjs).
//
// Principal classes the managed policy distinguishes for this group: the local
// administrator (every route); a managed administrator (every route); a
// managed member such as a developer (GET only: PUT and DELETE are refused by
// the policy gate); and an unauthenticated request from outside loopback (the
// tunnel boundary refuses it, an edge exchange). The reference produces the
// first and the last; the managed classes need the Supabase-backed runtime,
// so their steps are waived on the reference with that reason (design §6).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PRINCIPALS, defineScenario, jsonBody, rawBody, step } from '../scenario.mjs';

const principals = Object.fromEntries(['local-admin', 'managed-admin', 'managed-developer', 'remote-unauthenticated'].map((name) => [name, PRINCIPALS[name]]));
const JSON_TYPE = [['Content-Type', 'application/json']];
const BASE = '/api/magic-prompts';
const MANAGED_WAIVER = { outcome: 'inconclusive', checks: ['principal-unavailable'], reason: 'managed principals need the Supabase-backed runtime, which the reference group host does not run (design §6, pilot scope; inventory B12)' };
// Edge exchanges are recorded on the reference only and never sent to a candidate (design §2.1): a stable one has
// nothing of the group's to judge. The waiver covers that check alone; an edge row that is unstable stays open.
const EDGE_WAIVER = { outcome: 'inconclusive', checks: ['edge-exchange'], reason: 'an edge exchange: the edge answers it before the group (design §2.1); it is compared reference against reference only, and no candidate is sent it' };
const DEPRECATED = ['git.commit.draft.visible', 'git.commit.draft.instructions', 'git.commit.plan.visible', 'git.commit.plan.instructions'];

const get = (principal = 'local-admin', extra = {}) => ({ method: 'GET', target: BASE, principal, ...extra });
const put = (id, body, principal = 'local-admin', headers = JSON_TYPE) => ({ method: 'PUT', target: `${BASE}/${id}`, headers, body, principal });
const del = (id, principal = 'local-admin') => ({ method: 'DELETE', target: id === null ? BASE : `${BASE}/${id}`, principal });

/** The data file as the runtime writes it. */
const promptFile = (overrides) => `${JSON.stringify({ version: 1, overrides }, null, 2)}`;

/** Reads and writes for each principal class, the value matrices, validation failures and the edge-answered cases. */
export const READS_AND_WRITES = defineScenario({
  id: 'magic-prompts.reads-and-writes', group: 'magic-prompts',
  description: 'every route for each principal class, the id, text and body matrices, validation failures, malformed JSON and a remote request',
  principals,
  fixture: () => {},
  steps: (v) => {
    const visible = v.id('id.visible', 'git.pr.generate.visible');
    const instructions = v.id('id.instructions', 'git.pr.generate.instructions');
    const longest = v.id('id.160', 'a'.repeat(160));
    const tooLong = v.id('id.161', 'b'.repeat(161));
    const upper = v.id('id.upper', 'Git.PR.Generate.Visible');
    const text = v.text('text.first', 'Write the PR description.');
    const second = v.text('text.second', 'Write it shorter.');
    const longText = v.text('text.200000', 'x'.repeat(200_000));
    const overLong = v.text('text.200001', 'y'.repeat(200_001));
    const managedText = v.text('text.managed', 'managed edit');
    return [
      step.exchange('get-empty', get()),
      step.exchange('put-visible', put(visible, jsonBody({ text }))),
      step.exchange('get-after-put', get()),
      step.exchange('put-replace', put(visible, jsonBody({ text: second }))),
      step.exchange('put-id-160', put(longest, jsonBody({ text }))),
      step.exchange('put-id-161', put(tooLong, jsonBody({ text }))),
      step.exchange('put-id-upper', put(upper, jsonBody({ text }))),
      step.exchange('put-id-space', put(`%20${instructions}`, jsonBody({ text }))),
      ...DEPRECATED.map((id, index) => step.exchange(`put-deprecated-${index + 1}`, put(v.id(`id.deprecated.${index + 1}`, id), jsonBody({ text })))),
      step.exchange('put-visible-blank', put(visible, jsonBody({ text: v.text('text.blank', '   ') }))),
      step.exchange('put-text-empty', put(instructions, jsonBody({ text: v.text('text.empty', '') }))),
      step.exchange('put-text-200000', put(instructions, jsonBody({ text: longText }))),
      step.exchange('put-text-200001', put(instructions, jsonBody({ text: overLong }))),
      step.exchange('put-text-number', put(instructions, jsonBody({ text: 12 }))),
      step.exchange('put-body-array', put(instructions, jsonBody([text]))),
      // The shared JSON parser is strict: a body that is not an object or array never reaches the group.
      step.exchange('put-body-null', { ...put(instructions, rawBody('null')), edge: true }),
      step.exchange('put-text-lone-surrogate', put(instructions, rawBody(`{"text":"${v.text('text.lone-surrogate-escape', '\\ud800')}"}`))),
      step.exchange('put-duplicate-keys', put(instructions, rawBody(`{"text":"${v.text('text.duplicate-first', 'a')}","text":"${v.text('text.duplicate-second', 'b')}"}`))),
      step.exchange('put-text-2-53-plus-1', put(instructions, rawBody(`{"text":${v.text('text.2-53-plus-1', '9007199254740993')}}`))),
      // Non-UTF-8 bytes, registered as their latin1 text (one character per byte).
      step.exchange('put-non-utf8', put(instructions, rawBody(`{"text":"${v.text('text.non-utf8', '\xff\xfe')}"}`, 'latin1'))),
      step.exchange('put-text-plain', put(instructions, rawBody(`{"text":"${v.text('text.plain', 'plain')}"}`), 'local-admin', [['Content-Type', 'text/plain']])),
      step.exchange('put-malformed-json', { ...put(instructions, rawBody('{"text":')), edge: true }),
      step.exchange('get-remote', { ...get('remote-unauthenticated'), edge: true }),
      step.exchange('put-remote', { ...put(visible, jsonBody({ text })), principal: 'remote-unauthenticated', edge: true }),
      step.exchange('get-managed-admin', get('managed-admin')),
      step.exchange('put-managed-admin', put(visible, jsonBody({ text: managedText }), 'managed-admin')),
      step.exchange('get-managed-developer', get('managed-developer')),
      step.exchange('put-managed-developer', put(visible, jsonBody({ text: managedText }), 'managed-developer')),
      step.exchange('delete-managed-developer', del(visible, 'managed-developer')),
      step.exchange('delete-one', del(visible)),
      step.exchange('delete-absent', del(visible)),
      step.exchange('delete-invalid', del(upper)),
      step.exchange('get-before-reset', get()),
      step.exchange('delete-all', del(null)),
      step.exchange('get-after-reset', get()),
    ];
  },
  waivers: Object.fromEntries([
    ...['get-managed-admin', 'put-managed-admin', 'get-managed-developer', 'put-managed-developer', 'delete-managed-developer'].map((id) => [id, MANAGED_WAIVER]),
    ...['put-body-null', 'put-malformed-json', 'get-remote', 'put-remote'].map((id) => [id, EDGE_WAIVER]),
  ]),
});

/** The write lock: concurrent PUTs, and a PUT with a DELETE of the same id (§5.6). */
export const WRITE_LOCK = defineScenario({
  id: 'magic-prompts.write-lock', group: 'magic-prompts',
  description: 'concurrent writes, each judged against every order the reference produces one at a time',
  principals,
  fixture: (root, v) => { fs.writeFileSync(path.join(root, 'magic-prompts.json'), promptFile({ 'git.commit.generate.visible': v.text('text.seeded', 'seeded'), 'git.commit.draft.visible': v.text('text.deprecated-filtered', 'deprecated, filtered on read') })); },
  steps: (v) => {
    const first = v.id('id.first', 'git.pr.generate.visible');
    const other = v.id('id.other', 'git.commit.generate.visible');
    return [
      step.exchange('get-seeded', get()),
      step.concurrent('two-puts', [['first', put(first, jsonBody({ text: v.text('text.first', 'first writer') }))], ['other', put(other, jsonBody({ text: v.text('text.other', 'other writer') }))]]),
      step.concurrent('put-and-delete', [['put', put(first, jsonBody({ text: v.text('text.again', 'written again') }))], ['delete', del(first)]]),
      step.exchange('get-after', get()),
    ];
  },
});

/** State across a restart, a file changed under the arm, and kills after a write and during one (§5.4). */
export const RESTARTS = defineScenario({
  id: 'magic-prompts.restarts', group: 'magic-prompts',
  description: 'a restart between a write and a read, external edits, a kill after a write and a kill during one',
  principals,
  fixture: () => {},
  steps: (v) => {
    const id = v.id('id.visible', 'git.pr.generate.visible');
    return [
      step.exchange('put', put(id, jsonBody({ text: v.text('text.before', 'before the restart') }))),
      step.restart('restart'),
      step.exchange('get-after-restart', get()),
      step.external('external-edit', { op: 'write', path: 'magic-prompts.json', data: Buffer.from(promptFile({ [id]: v.text('text.external', 'written by someone else') })) }),
      step.exchange('get-after-external', get()),
      step.external('external-malformed', { op: 'write', path: 'magic-prompts.json', data: Buffer.from(v.text('text.malformed-file', '{not json')) }),
      step.exchange('get-malformed-file', get()),
      step.exchange('put-over-malformed', put(id, jsonBody({ text: v.text('text.repair', 'repaired') }))),
      step.killAfter('kill-after-write', 'response-end', put(id, jsonBody({ text: v.text('text.killed-after', 'answered, then killed') }))),
      step.exchange('get-after-kill', get()),
      step.killAfter('kill-during-write', 'request-sent', put(id, jsonBody({ text: v.text('text.killed-during', 'killed while it was written') }))),
      step.exchange('get-after-kill-during', get()),
      step.external('external-delete', { op: 'delete', path: 'magic-prompts.json' }),
      step.exchange('get-after-delete', get()),
    ];
  },
});

/** Express's weak ETag of a body (etag 1.8: the length in hex, then 27 characters of its SHA-1 in base64). */
const weakEtag = (text) => `W/"${Buffer.byteLength(text).toString(16)}-${crypto.createHash('sha1').update(text, 'utf8').digest('base64').slice(0, 27)}"`;
const EMPTY_STATE = '{"version":1,"overrides":{}}';

/**
 * What Express and the shared body parser give the JavaScript group for free, and a port must give itself
 * (S3 of the BH3/BH4 review). Each step states who answers it in the reference (the tap says: the group, or
 * the edge with `edge: true`). An edge step is never sent to a candidate, so its neighbour that the group
 * answers is here too (an explicit UTF-8 charset beside latin1; the body limit is crossed at 200 000
 * characters of reads-and-writes with 50 MB allowed, and refused here by the declared length alone).
 */
export const REQUEST_FORMS = defineScenario({
  id: 'magic-prompts.request-forms', group: 'magic-prompts',
  description: 'a conditional GET, a trailing slash, another letter case, HEAD, a query, charsets, a gzip body, a body over the limit, a BOM, an empty JSON body and an application/*+json type',
  principals,
  fixture: () => {},
  steps: (v) => {
    const id = v.id('id.visible', 'git.pr.generate.visible');
    const etag = v.token('etag.empty', weakEtag(EMPTY_STATE));
    const body = (name, text) => `{"text":"${v.text(name, text)}"}`;
    const putAs = (contentType, bytes, extra = []) => ({ method: 'PUT', target: `${BASE}/${id}`, headers: [...(contentType ? [['Content-Type', contentType]] : []), ...extra], body: rawBody(bytes), principal: 'local-admin' });
    return [
      step.exchange('get-etag', get()),
      step.exchange('get-if-none-match', get('local-admin', { headers: [['If-None-Match', etag]] })),
      step.exchange('get-trailing-slash', { ...get(), target: `${BASE}/` }),
      step.exchange('get-other-case', { ...get(), target: '/API/Magic-Prompts' }),
      step.exchange('head', { ...get(), method: 'HEAD' }),
      step.exchange('get-query', { ...get(), target: `${BASE}?x=1` }),
      step.exchange('put-charset-latin1', { ...putAs('application/json; charset=latin1', body('text.latin1', 'latin1 charset')), edge: true }),
      step.exchange('put-charset-utf8', putAs('application/json; charset=utf-8', body('text.utf8', 'explicit utf-8'))),
      step.exchange('put-gzip', putAs('application/json', zlib.gzipSync(Buffer.from(body('text.gzip', 'inflated by the parser'))), [['Content-Encoding', 'gzip']])),
      // One byte over the path's 50 MB: the shared parser reads the whole body before it answers (body-parser drains
      // it), so the bytes are really sent. Not a supplied value: the edge refuses it and nothing can echo it.
      step.exchange('put-over-limit', { ...putAs('application/json', Buffer.alloc(50 * 1024 * 1024 + 1, 0x20)), edge: true }),
      step.exchange('put-bom', putAs('application/json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body('text.bom', 'after a byte-order mark'))]))),
      step.exchange('put-empty-json', putAs('application/json', '')),
      step.exchange('put-plus-json', putAs('application/merge-patch+json', body('text.plus-json', 'a +json type'))),
      step.exchange('get-after', get()),
    ];
  },
  waivers: Object.fromEntries(['put-charset-latin1', 'put-over-limit'].map((id) => [id, EDGE_WAIVER])),
});

// What happens after the group (a method no route of it registers): the server's later layers answer it, which
// the group host's tail stand-in stands for. Never sent to a candidate; compared reference against reference.
const TAIL_WAIVER = { outcome: 'inconclusive', checks: ['tail-exchange'], reason: 'a tail exchange: a method no route of the group registers, answered by what the server composes after the group (the group host\'s stand-in); compared reference against reference only, and no candidate is sent it' };

/** The four routes as [step name, method, path after the collection, extra request fields]. */
const ROUTE_SPECS = Object.freeze([
  ['get', 'GET', () => '', () => ({})],
  ['put', 'PUT', (id) => `/${id}`, (v, name) => ({ headers: JSON_TYPE, body: jsonBody({ text: v.text(`text.${name}-spelling`, 'never the group\'s') }) })],
  ['delete', 'DELETE', (id) => `/${id}`, () => ({})],
  ['delete-all', 'DELETE', () => '', () => ({})],
]);

/**
 * The forms the census (coverage-census.mjs) found no row for (BH5): every route in the routing forms (a
 * trailing slash, another letter case, a query string, a percent-encoded id), the conditional forms of the GET
 * route and of the writes, the body forms of the PUT route not covered elsewhere (no Content-Type, a form
 * body, deflate, brotli, an encoding the parser does not know), a malformed JSON body on the routes that do not
 * read one, the remote principal on the DELETE routes, and the methods no route registers (the tail).
 */
export const ROUTES_AND_FORMS = defineScenario({
  id: 'magic-prompts.routes-and-forms', group: 'magic-prompts',
  description: 'the routing, conditional and body forms of every route the other scenarios leave out, the remote principal on the DELETE routes and the methods no route registers',
  principals,
  fixture: (root, v) => { fs.writeFileSync(path.join(root, 'magic-prompts.json'), promptFile({ 'git.pr.generate.visible': v.text('text.seeded', 'seeded') })); },
  steps: (v) => {
    const id = v.id('id.visible', 'git.pr.generate.visible');
    const other = v.id('id.instructions', 'git.pr.generate.instructions');
    // The state the fixture writes, as GET answers it (the file is written with indentation, the answer without).
    const current = v.token('etag.seeded', weakEtag(JSON.stringify({ version: 1, overrides: { [id]: 'seeded' } })));
    const body = (name, text) => `{"text":"${v.text(name, text)}"}`;
    const putAs = (target, contentType, bytes, extra = []) => ({ method: 'PUT', target, headers: [...(contentType ? [['Content-Type', contentType]] : []), ...extra], body: rawBody(bytes), principal: 'local-admin' });
    const malformed = (spec) => ({ ...spec, headers: [...(spec.headers ?? []), ['Content-Type', 'application/json']], body: rawBody('{"text":'), edge: true });
    const encoded = id.split('.').join('%2E');
    const slashed = id.replace('.pr.', '%2Fpr.');
    return [
      // GET: conditional forms, compression asked for, a malformed body it never reads.
      step.exchange('get-if-none-match-other', get('local-admin', { headers: [['If-None-Match', v.token('etag.other', 'W/"1c-0000000000000000000000000000"')]] })),
      step.exchange('get-if-none-match-no-cache', get('local-admin', { headers: [['If-None-Match', current], ['Cache-Control', 'no-cache']] })),
      step.exchange('get-if-modified-since', get('local-admin', { headers: [['If-Modified-Since', v.token('date.modified-since', 'Tue, 01 Jan 2030 00:00:00 GMT')]] })),
      step.exchange('get-accept-gzip', get('local-admin', { headers: [['Accept-Encoding', 'gzip']] })),
      step.exchange('get-malformed-body', malformed(get())),
      // PUT: the routing forms (two letter cases: the shared parser picks its limit by the path as written), the conditional
      // form, and the body forms the other scenarios leave out.
      step.exchange('put-trailing-slash', putAs(`${BASE}/${id}/`, 'application/json', body('text.trailing', 'with a trailing slash'))),
      step.exchange('put-other-case-api', putAs(`/api/Magic-Prompts/${id}`, 'application/json', body('text.case-api', 'another case under /api'))),
      step.exchange('put-other-case-all', putAs(`/API/MAGIC-PROMPTS/${id}`, 'application/json', body('text.case-all', 'another case everywhere'))),
      step.exchange('put-query', putAs(`${BASE}/${id}?x=1`, 'application/json', body('text.query', 'with a query'))),
      step.exchange('put-percent-encoded', putAs(`${BASE}/${encoded}`, 'application/json', body('text.encoded', 'a percent-encoded id'))),
      // %2F decodes into a slash inside the id (the group refuses it as an id); a % without two hex digits never reaches the group.
      step.exchange('put-percent-slash', putAs(`${BASE}/${slashed}`, 'application/json', body('text.encoded-slash', 'an id holding a slash'))),
      step.exchange('put-percent-malformed', { ...putAs(`${BASE}/%zz`, 'application/json', body('text.malformed-escape', 'an id the router cannot decode')), edge: true }),
      step.exchange('put-if-none-match', putAs(`${BASE}/${id}`, 'application/json', body('text.conditional', 'a conditional write'), [['If-None-Match', '*']])),
      step.exchange('put-no-content-type', putAs(`${BASE}/${id}`, null, body('text.untyped', 'no content type'))),
      step.exchange('put-urlencoded', putAs(`${BASE}/${other}`, 'application/x-www-form-urlencoded', `text=${encodeURIComponent(v.text('text.form', 'from a form'))}`)),
      step.exchange('put-urlencoded-nested', putAs(`${BASE}/${other}`, 'application/x-www-form-urlencoded', `text[${v.text('text.form-key', 'nested')}]=${v.text('text.form-value', 'value')}`)),
      step.exchange('put-deflate', putAs(`${BASE}/${other}`, 'application/json', zlib.deflateSync(Buffer.from(body('text.deflate', 'inflated from deflate'))), [['Content-Encoding', 'deflate']])),
      step.exchange('put-brotli', putAs(`${BASE}/${other}`, 'application/json', zlib.brotliCompressSync(Buffer.from(body('text.brotli', 'decompressed from brotli'))), [['Content-Encoding', 'br']])),
      step.exchange('put-unknown-encoding', { ...putAs(`${BASE}/${other}`, 'application/json', body('text.compress', 'an encoding nobody reads'), [['Content-Encoding', 'compress']]), edge: true }),
      step.exchange('get-after-puts', get()),
      // DELETE of one id.
      step.exchange('delete-trailing-slash', { ...del(other), target: `${BASE}/${other}/` }),
      step.exchange('delete-other-case', { ...del(id), target: `/api/Magic-Prompts/${id}` }),
      step.exchange('delete-query', { ...del(id), target: `${BASE}/${id}?x=1` }),
      step.exchange('delete-percent-encoded', { ...del(id), target: `${BASE}/${encoded}` }),
      step.exchange('delete-percent-slash', { ...del(id), target: `${BASE}/${slashed}` }),
      step.exchange('delete-percent-malformed', { ...del(id), target: `${BASE}/%zz`, edge: true }),
      step.exchange('delete-if-none-match', { ...del(id), headers: [['If-None-Match', '*']] }),
      step.exchange('delete-malformed-body', malformed(del(id))),
      step.exchange('delete-remote', { ...del(id, 'remote-unauthenticated'), edge: true }),
      // DELETE of all.
      step.exchange('delete-all-trailing-slash', { ...del(null), target: `${BASE}/` }),
      step.exchange('delete-all-other-case', { ...del(null), target: '/API/Magic-Prompts' }),
      step.exchange('delete-all-query', { ...del(null), target: `${BASE}?x=1` }),
      step.exchange('delete-all-if-none-match', { ...del(null), headers: [['If-None-Match', '*']] }),
      step.exchange('delete-all-malformed-body', malformed(del(null))),
      step.exchange('delete-all-remote', { ...del(null, 'remote-unauthenticated'), edge: true }),
      // Methods no route registers, on both paths: the tail.
      step.exchange('options-collection', { method: 'OPTIONS', target: BASE, principal: 'local-admin', tail: true }),
      step.exchange('post-collection', { method: 'POST', target: BASE, headers: JSON_TYPE, body: jsonBody({ text: v.text('text.post', 'posted') }), principal: 'local-admin', tail: true }),
      step.exchange('options-item', { method: 'OPTIONS', target: `${BASE}/${id}`, principal: 'local-admin', tail: true }),
      step.exchange('patch-item', { method: 'PATCH', target: `${BASE}/${id}`, headers: JSON_TYPE, body: jsonBody({ text: v.text('text.patch', 'patched') }), principal: 'local-admin', tail: true }),
      // Spellings only a router that decodes or normalises before matching would give the group: a percent-encoded literal segment
      // and an empty segment. Express routes neither to it (the tail answers), and a port must not either.
      ...ROUTE_SPECS.flatMap(([name, method, suffix, extra]) => [
        step.exchange(`${name}-literal-encoded`, { method, target: `/api/magic%2Dprompts${suffix(id)}`, principal: 'local-admin', ...extra(v, name), tail: true }),
        step.exchange(`${name}-empty-segment`, { method, target: `//api/magic-prompts${suffix(id)}`, principal: 'local-admin', ...extra(v, name), tail: true }),
      ]),
      step.exchange('get-after', get()),
    ];
  },
  waivers: Object.fromEntries([
    ...['get-malformed-body', 'put-unknown-encoding', 'put-percent-malformed', 'delete-malformed-body', 'delete-percent-malformed', 'delete-remote', 'delete-all-malformed-body', 'delete-all-remote'].map((stepId) => [stepId, EDGE_WAIVER]),
    ...['options-collection', 'post-collection', 'options-item', 'patch-item', ...ROUTE_SPECS.flatMap(([name]) => [`${name}-literal-encoded`, `${name}-empty-segment`])].map((stepId) => [stepId, TAIL_WAIVER]),
  ]),
});

/**
 * The data file in the states the runtime reads but never writes (BH5: branches of sanitizeOverrides and of the
 * read's error handling the census found no row for), and the data file's path taken by a directory, so that
 * every write fails with Node's EISDIR text (the 500 answers of PUT and of both DELETEs); then by a file the arm
 * may not write (EACCES) and by a link to itself (ELOOP), each with its own text (CENSUS_ERRORS below).
 */
export const FILE_STATES = defineScenario({
  id: 'magic-prompts.file-states', group: 'magic-prompts',
  description: 'a data file without overrides, with overrides that are null, a string or an array, with keys and entries the read filters out, a directory where the data file belongs, a data file the arm cannot write, and a data file that is a link to itself',
  principals,
  fixture: () => {},
  steps: (v) => {
    const id = v.id('id.visible', 'git.pr.generate.visible');
    const write = (stepId, text) => step.external(stepId, { op: 'write', path: 'magic-prompts.json', data: Buffer.from(text) });
    return [
      write('file-no-overrides', `{"version":1,"${v.text('text.other-key', 'other')}":true}`),
      step.exchange('get-no-overrides', get()),
      write('file-null', 'null'),
      step.exchange('get-null-file', get()),
      write('file-overrides-string', `{"version":1,"overrides":"${v.text('text.overrides-string', 'not an object')}"}`),
      step.exchange('get-overrides-string', get()),
      write('file-overrides-array', `{"version":1,"overrides":["${v.text('text.overrides-array', 'an array')}"]}`),
      step.exchange('get-overrides-array', get()),
      write('file-filtered', JSON.stringify({ version: 1, overrides: { [v.id('id.bad-key', 'Not A Valid Id')]: 'dropped', [v.id('id.number-entry', 'git.number.visible')]: 5, 'git.commit.plan.visible': v.text('text.deprecated', 'deprecated, dropped'), [id]: v.text('text.kept', 'kept') } }, null, 2)),
      step.exchange('get-filtered', get()),
      step.exchange('put-over-filtered', put(v.id('id.instructions', 'git.pr.generate.instructions'), jsonBody({ text: v.text('text.added', 'added') }))),
      step.external('file-removed', { op: 'delete', path: 'magic-prompts.json' }),
      step.external('file-is-directory', { op: 'mkdir', path: 'magic-prompts.json' }),
      step.exchange('get-directory', get()),
      step.exchange('put-directory', put(id, jsonBody({ text: v.text('text.directory', 'cannot be written') }))),
      step.exchange('delete-directory', del(id)),
      step.exchange('delete-all-directory', del(null)),
      step.exchange('put-invalid-directory', put(v.id('id.invalid', 'Not.Valid'), jsonBody({ text: v.text('text.invalid', 'refused before the write') }))),
      step.external('directory-removed', { op: 'delete', path: 'magic-prompts.json' }),
      // A data file the arm may read but not write: every write answers Node's EACCES text (fix round 1 of BH5, S6). Written with
      // its mode in one step (the write op chmods it): a chmod step alone changes the file's mode and not its mtime, which rule W's
      // mtime window takes for a write made earlier (the mtime falls before the step that changed the file).
      step.external('file-read-only', { op: 'write', path: 'magic-prompts.json', data: Buffer.from(promptFile({ [id]: v.text('text.read-only', 'read only') })), mode: 0o444 }),
      step.exchange('get-read-only', get()),
      step.exchange('put-read-only', put(id, jsonBody({ text: v.text('text.denied', 'denied by the file mode') }))),
      step.exchange('delete-read-only', del(id)),
      step.exchange('delete-all-read-only', del(null)),
      step.external('read-only-removed', { op: 'delete', path: 'magic-prompts.json' }),
      // The data file a link to itself: the read fails (and answers empty), every write answers Node's ELOOP text.
      step.external('file-link-loop', { op: 'symlink', path: 'magic-prompts.json', target: 'magic-prompts.json' }),
      step.exchange('get-link-loop', get()),
      step.exchange('put-link-loop', put(id, jsonBody({ text: v.text('text.looped', 'a write through a loop') }))),
      step.exchange('delete-link-loop', del(id)),
      step.exchange('delete-all-link-loop', del(null)),
      step.external('link-loop-removed', { op: 'delete', path: 'magic-prompts.json' }),
      step.exchange('get-after', get()),
    ];
  },
});

/**
 * The order of writes as the JavaScript gives it to timelines of bytes (fix round 1 of BH6): a request's handler
 * runs, and a write takes its place in the promise chain, when its head has arrived if no parser reads its body
 * (no type the parsers take, or a path spelling with no JSON parser), when its body has arrived if a parser reads
 * it plainly, and when zlib's last thread-pool call reports back if it is compressed; requests that become
 * readable in one turn of the loop go in the order they became readable (the probe member's answer makes sure
 * both connections were accepted first). A read never waits for a write. Each staged step is judged exactly
 * against the reference's own result, then a GET shows the state each order leaves.
 */
export const WRITE_ORDER = defineScenario({
  id: 'magic-prompts.write-order', group: 'magic-prompts',
  description: 'writes whose bodies no parser reads, a compressed write and a plain one, two requests readable together, and a read during a slow write: the order of writes judged exactly',
  principals,
  fixture: (root, v) => { fs.writeFileSync(path.join(root, 'magic-prompts.json'), promptFile({ 'git.pr.generate.visible': v.text('text.seeded', 'seeded') })); },
  steps: (v) => {
    const id = v.id('id.visible', 'git.pr.generate.visible');
    const other = v.id('id.instructions', 'git.pr.generate.instructions');
    const slow = (spec, type, bytes) => ({ ...spec, headers: [['Content-Type', type]], body: rawBody(bytes) });
    const headFirst = (late, early) => [['send', late, 'head'], ['send', early, 'all'], ['await', early], ['send', late, 'body'], ['await', late]];
    // Padding the parser inflates (40 MiB of spaces, a few kilobytes compressed) and nobody echoes.
    const padded = zlib.gzipSync(Buffer.from(`{"text":"${v.text('text.gzip', 'inflated last')}","pad":"${' '.repeat(40 * 1024 * 1024)}"}`), { level: 9 });
    // A data file large enough that a write reads, parses and writes it for a while, and that Node's readFile still
    // reads in one piece (under 512 KiB: a file read in pieces leaves the reference's quiescence waiting on its
    // requests until a garbage collection, up to the claim's deadline).
    const large = promptFile({ [id]: v.text('text.large', `${'l'.repeat(400_000)}`) });
    return [
      step.staged('unread-body-delete-all', [['delete-all', slow(del(null), 'text/plain', 'abcde')], ['put', put(id, jsonBody({ text: v.text('text.put-1', 'written while the delete-all body waits') }))]], headFirst('delete-all', 'put')),
      step.exchange('get-after-unread-delete-all', get()),
      step.staged('unparsed-spelling-delete', [['delete', { ...slow(del(id), 'application/json', '{}'), target: `/api/Magic-Prompts/${id}` }], ['put', put(id, jsonBody({ text: v.text('text.put-2', 'written while the unparsed delete body waits') }))]], headFirst('delete', 'put')),
      step.exchange('get-after-unparsed-delete', get()),
      step.staged('unread-body-get', [['get', slow(get(), 'text/plain', 'abc')], ['put', put(id, jsonBody({ text: v.text('text.put-3', 'written while the get body waits') }))]], headFirst('get', 'put')),
      step.exchange('get-after-unread-get', get()),
      step.staged('compressed-and-plain', [['gzip', put(id, rawBody(padded), 'local-admin', [['Content-Type', 'application/json'], ['Content-Encoding', 'gzip']])], ['plain', put(id, jsonBody({ text: v.text('text.plain-second', 'plain, sent second') }))]], [['send', 'gzip', 'all'], ['send', 'plain', 'all'], ['await', 'plain'], ['await', 'gzip']]),
      step.exchange('get-after-compressed', get()),
      step.staged('readable-together', [['probe', get()], ['first', put(id, jsonBody({ text: v.text('text.connected-first', 'connected first, written second') }))], ['second', put(id, jsonBody({ text: v.text('text.connected-second', 'connected second, written first') }))]],
        [['send', 'probe', 'all'], ['await', 'probe'], ['send', 'second', 'all'], ['send', 'first', 'all'], ['await', 'first'], ['await', 'second']]),
      step.exchange('get-after-together', get()),
      step.external('file-large', { op: 'write', path: 'magic-prompts.json', data: Buffer.from(large) }),
      step.staged('read-during-write', [['put', put(other, jsonBody({ text: v.text('text.during', 'written while a read runs') }))], ['get', get()]], [['send', 'put', 'all'], ['send', 'get', 'all'], ['await', 'get'], ['await', 'put']]),
      step.exchange('get-after-read-during-write', get()),
      step.exchange('delete-all-after', del(null)),
    ];
  },
});

/**
 * Texts, ids, data files and a body form the other scenarios leave out (the review's plants that escaped, S7):
 * a DELETE whose id carries spaces (trimmed), visible text of Unicode spaces only (JavaScript's trim), a text at
 * the limit in UTF-16 units that is twice as long in UTF-8, data files holding a `__proto__` key and a byte-order
 * mark, and a gzip body of two members.
 */
export const TEXTS_AND_FILES = defineScenario({
  id: 'magic-prompts.texts-and-files', group: 'magic-prompts',
  description: 'a DELETE of a padded id, visible text of Unicode spaces, a text at the limit in UTF-16 units, data files with a __proto__ key and a byte-order mark, and a gzip body of two members',
  principals,
  fixture: () => {},
  steps: (v) => {
    const visible = v.id('id.visible', 'git.pr.generate.visible');
    const instructions = v.id('id.instructions', 'git.pr.generate.instructions');
    const gzipTwo = Buffer.concat([zlib.gzipSync(Buffer.from(`{"text":"${v.text('text.member-1', 'from the first member')}`)), zlib.gzipSync(Buffer.from(` ${v.text('text.member-2', 'and the second')}"}`))]);
    return [
      step.exchange('put-visible', put(visible, jsonBody({ text: v.text('text.visible', 'visible text') }))),
      step.exchange('delete-id-space', del(`%20${visible}%20`)),
      step.exchange('get-after-padded-delete', get()),
      step.exchange('put-visible-unicode-spaces', put(visible, jsonBody({ text: v.text('text.unicode-spaces', '\u00a0\u3000\ufeff\u2028') }))),
      step.exchange('put-text-emoji-200000', put(instructions, jsonBody({ text: v.text('text.emoji-200000', '\u{1f600}'.repeat(100_000)) }))),
      step.exchange('put-text-emoji-200002', put(instructions, jsonBody({ text: v.text('text.emoji-200002', '\u{1f601}'.repeat(100_001)) }))),
      step.external('file-proto', { op: 'write', path: 'magic-prompts.json', data: Buffer.from(`{"version":1,"overrides":{"__proto__":"${v.text('text.proto', 'a prototype key')}","${visible}":"${v.text('text.beside-proto', 'kept beside it')}"}}`) }),
      step.exchange('get-proto-file', get()),
      step.external('file-bom', { op: 'write', path: 'magic-prompts.json', data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(promptFile({ [visible]: v.text('text.after-bom', 'after a byte-order mark') }))]) }),
      step.exchange('get-bom-file', get()),
      step.exchange('put-gzip-two-members', { method: 'PUT', target: `${BASE}/${instructions}`, headers: [['Content-Type', 'application/json'], ['Content-Encoding', 'gzip']], body: rawBody(gzipTwo), principal: 'local-admin' }),
      step.exchange('get-after', get()),
    ];
  },
});

export const SCENARIOS = Object.freeze([READS_AND_WRITES, WRITE_LOCK, RESTARTS, REQUEST_FORMS, ROUTES_AND_FORMS, FILE_STATES, WRITE_ORDER, TEXTS_AND_FILES]);

const GET_HANDLER = 'routes.js:registerMagicPromptRoutes>GET /api/magic-prompts handler';
const PUT_HANDLER = 'routes.js:registerMagicPromptRoutes>PUT /api/magic-prompts/:id handler';
const DELETE_HANDLER = 'routes.js:registerMagicPromptRoutes>DELETE /api/magic-prompts/:id handler';
const RESET_HANDLER = 'routes.js:registerMagicPromptRoutes>DELETE /api/magic-prompts handler';
const RUNTIME = 'runtime.js:createMagicPromptRuntime';
const NEVER_THROWS = 'unreachable: readPromptState (runtime.js) catches every error and answers an empty state, so nothing in the GET handler\'s try throws';
const ID_IS_STRING = 'unreachable: Express sets a named route parameter to the decoded path segment, a string, whenever the route matches';
const ERRORS_ARE_ERRORS = 'unreachable: everything that reaches this catch is an Error (the runtime throws Error objects; fs.promises rejects with Error objects)';
const TRIMMED_ID = 'unreachable: both routes pass req.params.id, a string, so the runtime\'s typeof check is always true';
/** The census waivers (coverage-census.mjs): items of the group no scenario can exercise, each with why. */
export const CENSUS_WAIVERS = Object.freeze({
  // Managed principals: the reference cannot produce them (the same reason as the rows' principal-unavailable waivers).
  ...Object.fromEntries(['GET /api/magic-prompts', 'PUT /api/magic-prompts/:id', 'DELETE /api/magic-prompts/:id', 'DELETE /api/magic-prompts'].flatMap((route) => ['managed-admin', 'managed-developer'].map((principalClass) => [`principal ${principalClass} ${route}`, { reason: MANAGED_WAIVER.reason }]))),
  [`${GET_HANDLER}:catch catch (error)`]: { reason: NEVER_THROWS },
  [`${GET_HANDLER}:answer res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read ma…~5d541ad5`]: { reason: NEVER_THROWS },
  [`${GET_HANDLER}:true error instanceof Error ? error.message`]: { reason: NEVER_THROWS },
  [`${GET_HANDLER}:false error instanceof Error : 'Failed to read magic prompts'`]: { reason: NEVER_THROWS },
  [`${PUT_HANDLER}:false typeof req.params?.id === 'string' : ''`]: { reason: ID_IS_STRING },
  [`${PUT_HANDLER}:false error instanceof Error : String(error)`]: { reason: ERRORS_ARE_ERRORS },
  [`${DELETE_HANDLER}:false typeof req.params?.id === 'string' : ''`]: { reason: ID_IS_STRING },
  [`${DELETE_HANDLER}:false error instanceof Error : String(error)`]: { reason: ERRORS_ARE_ERRORS },
  [`${RESET_HANDLER}:false error instanceof Error : String(error)`]: { reason: ERRORS_ARE_ERRORS },
  [`${RESET_HANDLER}:reached 'Failed to reset magic prompts' (operand 2 of || chain message || 'Failed to reset magic prompts')`]: { reason: 'unreachable: the errors that reach this catch come from fs.promises (mkdir, writeFile), whose messages are never empty' },
  ['runtime.js:isVisiblePromptID:decides typeof id === \'string\' (operand 1 of && chain typeof id === \'string\' && id.endsWith(\'.visible\'))']: { reason: 'unreachable: its one caller, setOverride, passes the trimmed id, a string' },
  [`${RUNTIME}>readPromptState:decides error (operand 1 of && chain error && typeof error === 'object' && error.code …~81461a19)`]: { reason: 'unreachable: only fs.promises.readFile and JSON.parse run in the try, and both throw Error objects, never a falsy value' },
  [`${RUNTIME}>readPromptState:decides typeof error === 'object' (operand 2 of && chain error && typeof error === 'object' && error.code …~81461a19)`]: { reason: 'unreachable: only fs.promises.readFile and JSON.parse run in the try, and both throw Error objects' },
  [`${RUNTIME}>setOverride:false typeof id === 'string' : ''`]: { reason: TRIMMED_ID },
  [`${RUNTIME}>setOverride:then if (typeof text !== 'string')`]: { reason: 'unreachable: the PUT route answers 400 before it calls setOverride unless text is a string' },
  [`${RUNTIME}>setOverride:throw new Error('Prompt text must be a string')`]: { reason: 'unreachable: the PUT route answers 400 before it calls setOverride unless text is a string' },
  [`${RUNTIME}>resetOverride:false typeof id === 'string' : ''`]: { reason: TRIMMED_ID },
});

/**
 * The errors each write of the group can meet in a state of its data root (census `error` items: the call's block
 * ran in an exchange whose answer holds Node's `<code>:` message). The file-states scenario makes each state:
 * a directory at the data file's path (EISDIR), a file the arm may not write (EACCES), a link to itself (ELOOP).
 * Not reachable from a data-root state: ENOENT (mkdir makes the directory first), ENOTDIR (the data root is a
 * directory the harness owns), ENOSPC and EROFS (the machine, not the data root).
 */
export const CENSUS_ERRORS = Object.freeze([
  Object.freeze({ call: `${RUNTIME}>writePromptState:call fsPromises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8')`, codes: Object.freeze(['EISDIR', 'EACCES', 'ELOOP']), why: 'a directory, a file the arm may not write, or a link to itself at the data file\'s path' }),
]);
