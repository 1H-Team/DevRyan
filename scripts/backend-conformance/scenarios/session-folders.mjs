// The scenarios of the second group, session-folders (BH7; design file 31 §9 "Next groups"): the two routes of
// packages/web/server/lib/session-folders/routes.js, as the server registers them through the feature routes
// (groups.mjs). GET answers the stored document re-serialised (JSON.parse then res.json), or the empty
// document when the file is missing, empty or not JSON; POST stores any object the request decoding gives it
// (a JSON object or a form), pretty-printed, refused over 4 MiB, through a temporary file per save renamed over
// the file, saves one at a time in the order their handlers call `persist`, with the stale temporary files of
// earlier crashes (a day old) removed before each save.
//
// Principal classes: as for the pilot (scenarios/magic-prompts.mjs). Managed principals need the
// Supabase-backed runtime the reference does not run; the remote request is refused by the tunnel boundary.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PRINCIPALS, defineScenario, jsonBody, rawBody, step } from '../scenario.mjs';

const principals = Object.fromEntries(['local-admin', 'managed-admin', 'managed-developer', 'remote-unauthenticated'].map((name) => [name, PRINCIPALS[name]]));
const JSON_TYPE = [['Content-Type', 'application/json']];
const BASE = '/api/session-folders';
const FILE = 'sessions-directories.json';
const MANAGED_WAIVER = { outcome: 'inconclusive', checks: ['principal-unavailable'], reason: 'managed principals need the Supabase-backed runtime, which the reference group host does not run (design §6, pilot scope; inventory B12); for them the multi-user runtime answers this path' };
const EDGE_WAIVER = { outcome: 'inconclusive', checks: ['edge-exchange'], reason: 'an edge exchange: the edge answers it before the group (design §2.1); it is compared reference against reference only, and no candidate is sent it' };
const TAIL_WAIVER = { outcome: 'inconclusive', checks: ['tail-exchange'], reason: 'a tail exchange: a method or spelling no route of the group takes, answered by what the server composes after the group (the group host\'s stand-in); compared reference against reference only, and no candidate is sent it' };
/** What GET answers when there is nothing to read. */
export const EMPTY_DOCUMENT = '{"version":1,"foldersMap":{},"collapsedFolderIds":[],"updatedAt":0}';
/** The largest document the group stores: `Buffer.byteLength(JSON.stringify(body, null, 2)) > 4 MiB` is refused. */
const LIMIT = 4 * 1024 * 1024;

const get = (principal = 'local-admin', extra = {}) => ({ method: 'GET', target: BASE, principal, ...extra });
const post = (body, principal = 'local-admin', headers = JSON_TYPE, target = BASE) => ({ method: 'POST', target, headers, body, principal });
/** A document as the client sends it, its texts registered (an arm stores and echoes them). */
const documentOf = (v, label) => ({
  version: 1,
  foldersMap: { [v.text(`project.${label}`, `/projects/${label}`)]: [{ id: v.id(`folder.${label}`, `folder-${label}`), name: v.text(`name.${label}`, `Folder ${label}`), sessionIds: [v.id(`session.${label}`, `ses_${label}`)], createdAt: 1700000000000, parentId: null }] },
  collapsedFolderIds: [v.id(`collapsed.${label}`, `collapsed-${label}`)],
  updatedAt: 1700000000001,
});
/** The file as a save writes it. */
const stored = (value) => JSON.stringify(value, null, 2);
/** A body whose pretty form is exactly `bytes` long: `{\n  "pad": "<x…>"\n}` is 15 bytes plus the text. */
const sizedBody = (v, name, bytes, unit) => ({ pad: v.text(name, unit.repeat(bytes - 15)) });

/** Every route for each principal class; the body matrix; the 4 MiB limit; validation; edge-answered bodies. */
export const READS_AND_WRITES = defineScenario({
  id: 'session-folders.reads-and-writes', group: 'session-folders',
  description: 'both routes for each principal class, the stored and echoed bytes of JSON values, the 4 MiB limit of a save, bodies that are not objects, and the edge-answered cases',
  principals,
  fixture: () => {},
  steps: (v) => [
    step.exchange('get-empty', get()),
    step.exchange('post-document', post(jsonBody(documentOf(v, 'first')))),
    step.exchange('get-after-post', get()),
    step.exchange('post-replace', post(jsonBody(documentOf(v, 'second')))),
    step.exchange('get-after-replace', get()),
    step.exchange('post-empty-object', post(jsonBody({}))),
    step.exchange('get-empty-object', get()),
    step.exchange('post-array', post(jsonBody([v.text('text.array', 'an array')]))),
    // JSON values the parse and the two serialisations change: number spellings, escapes, lone surrogates, a
    // repeated key (last value, first place), array-index keys first, an own __proto__ key, non-UTF-8 bytes.
    step.exchange('post-values', post(rawBody(`{"numbers":[1.0,1e2,-0,0.1,1e21,1e-7,123456789012345678901234567890,1e400,-1e400,5e-324],"escapes":"\\u0041\\/\\b\\f\\n\\r\\t\\u0001\\u001f\\u007f\\u2028\\u2029\\"\\\\","lone":"\\ud800","pair":"\\ud83d\\ude00","reversed":"\\ude00\\ud83d","dup":"${v.text('text.dup-first', 'first')}","between":true,"2":"${v.text('text.index-2', 'two')}","dup":"${v.text('text.dup-last', 'last')}","1":"${v.text('text.index-1', 'one')}","4294967295":"not an index","__proto__":{"own":true},"flags":[true,false,null],"empty":{},"none":[],"deep":{"a":{"b":{"c":[[[]]]}}}}`))),
    step.exchange('get-values', get()),
    // The same kinds of values in a document V8 keeps in its order (no index-like or repeated key): odd and long
    // numbers, a tie of two shortest spellings (V8 writes the even one), escapes, nested containers with numbers,
    // and `"01"`, `"00"` and `"-0"` keys (no array index: they keep their place). BH7 fix round 1, S2 and B2.
    step.exchange('post-values-in-order', post(rawBody(`{"n":[1.0,1e2,-0,0.10,1e21,1e-7,123456789012345678901234567890,12345678901234567,9007199254740993,1e400,-1e400,5e-324,97312000038578.125,1000000000000042.25],"nested":{"m":[0.5,[1E3,{"x":-0.0,"y":[2.50]}]]},"escapes":"\\u0041\\/\\b\\f\\n\\r\\t\\u0001\\u001f\\u007f\\u2028\\u2029\\"\\\\","inner":["\\u00e9\\ud83d\\ude00",{"e":"\\ud800x"}],"01":"${v.text('text.key-01', 'zero one')}","00":1,"-0":2}`))),
    step.exchange('get-values-in-order', get()),
    // An array over the limit is refused for its type first (400), as the handler checks the type before the size.
    step.exchange('post-array-over-limit', post(jsonBody([v.text('text.array-over-limit', 'z'.repeat(LIMIT))]))),
    // A form over the limit by its indentation and newlines: the URL-encoded parser's object, pretty-printed one byte over.
    step.exchange('post-form-over-limit', post(rawBody(`pad=${v.text('text.form-over-limit', 'w'.repeat(LIMIT + 1 - 15))}`), 'local-admin', [['Content-Type', 'application/x-www-form-urlencoded']])),
    step.exchange('post-form-at-limit', post(rawBody(`pad=${v.text('text.form-at-limit', 'v'.repeat(LIMIT - 15))}`), 'local-admin', [['Content-Type', 'application/x-www-form-urlencoded']])),
    step.exchange('post-non-utf8', post(rawBody(`{"bytes":"${v.text('text.non-utf8', '\xff\xfe\xc3(')}"}`, 'latin1'))),
    step.exchange('get-non-utf8', get()),
    step.exchange('post-unicode', post(jsonBody({ [v.text('text.key-unicode', 'clé ✓')]: v.text('text.unicode', 'ünïcødé 😀 中文') }))),
    // At the limit (exactly 4 MiB pretty-printed, stored) and one byte over (the group answers 413, nothing written).
    step.exchange('post-at-limit', post(jsonBody(sizedBody(v, 'text.at-limit', LIMIT, 'x')))),
    step.exchange('post-over-limit', post(jsonBody(sizedBody(v, 'text.over-limit', LIMIT + 1, 'y')))),
    // Over the limit in UTF-8 bytes only: 2-byte characters under 4 MiB in UTF-16 units.
    step.exchange('post-over-limit-utf8', post(jsonBody({ pad: v.text('text.over-limit-utf8', 'é'.repeat(LIMIT / 2)) }))),
    step.exchange('post-small-after-limit', post(jsonBody(documentOf(v, 'third')))),
    step.exchange('post-text-plain', post(rawBody(JSON.stringify(documentOf(v, 'plain'))), 'local-admin', [['Content-Type', 'text/plain']])),
    step.exchange('post-no-content-type', post(rawBody(JSON.stringify(documentOf(v, 'untyped'))), 'local-admin', [])),
    step.exchange('post-empty-json', post(rawBody(''))),
    step.exchange('get-after-empty-json', get()),
    // The shared JSON parser is strict (an object or an array only), and refuses what does not parse.
    step.exchange('post-body-null', { ...post(rawBody('null')), edge: true }),
    step.exchange('post-body-string', { ...post(rawBody(`"${v.text('text.string-body', 'a string')}"`)), edge: true }),
    step.exchange('post-malformed-json', { ...post(rawBody('{"version":')), edge: true }),
    step.exchange('get-remote', { ...get('remote-unauthenticated'), edge: true }),
    step.exchange('post-remote', { ...post(jsonBody(documentOf(v, 'remote'))), principal: 'remote-unauthenticated', edge: true }),
    step.exchange('get-managed-admin', get('managed-admin')),
    step.exchange('post-managed-admin', post(jsonBody(documentOf(v, 'managed')), 'managed-admin')),
    step.exchange('get-managed-developer', get('managed-developer')),
    step.exchange('post-managed-developer', post(jsonBody(documentOf(v, 'managed')), 'managed-developer')),
    step.exchange('get-last', get()),
  ],
  waivers: Object.fromEntries([
    ...['get-managed-admin', 'post-managed-admin', 'get-managed-developer', 'post-managed-developer'].map((id) => [id, MANAGED_WAIVER]),
    ...['post-body-null', 'post-body-string', 'post-malformed-json', 'get-remote', 'post-remote'].map((id) => [id, EDGE_WAIVER]),
  ]),
});

/** Concurrent saves (§5.6): each result one of the orders the reference gives the same saves one at a time. */
export const SAVE_ORDER = defineScenario({
  id: 'session-folders.save-order', group: 'session-folders',
  description: 'two and three saves at once, and a save with a read: one save at a time, the last written stored',
  principals,
  fixture: (root, v) => { fs.writeFileSync(path.join(root, FILE), stored(documentOf(v, 'seeded'))); },
  steps: (v) => [
    step.exchange('get-seeded', get()),
    step.concurrent('two-saves', [['a', post(jsonBody(documentOf(v, 'a')))], ['b', post(jsonBody(documentOf(v, 'b')))]]),
    step.exchange('get-after-two', get()),
    step.concurrent('three-saves', [['c', post(jsonBody(documentOf(v, 'c')))], ['d', post(jsonBody(documentOf(v, 'd')))], ['e', post(jsonBody(documentOf(v, 'e')))]]),
    step.exchange('get-after-three', get()),
    step.concurrent('save-and-read', [['save', post(jsonBody(documentOf(v, 'f')))], ['read', get()]]),
    step.exchange('get-after', get()),
  ],
});

/**
 * The order of saves the JavaScript gives timelines of bytes (BH6 fix round 1, its three situations for this
 * group): a GET whose body no parser reads runs at its head, before a save that completes while its body waits;
 * a compressed save takes its place when its inflation ends, after a plain save sent just after it; two saves
 * readable in one turn of the loop go in the order they became readable; a read during a save reads the file the
 * save replaces (the rename comes after the read has opened it). Judged exactly, each followed by a GET.
 */
export const WRITE_ORDER = defineScenario({
  id: 'session-folders.write-order', group: 'session-folders',
  description: 'a read whose body no parser reads, a compressed save and a plain one, two saves readable together, and a read during a large save: the order of saves judged exactly',
  principals,
  fixture: (root, v) => { fs.writeFileSync(path.join(root, FILE), stored(documentOf(v, 'seeded'))); },
  steps: (v) => {
    const headFirst = (late, early) => [['send', late, 'head'], ['send', early, 'all'], ['await', early], ['send', late, 'body'], ['await', late]];
    // 40 MiB of JSON whitespace the parser inflates and the serialisation drops: the inflation is long, the document small.
    const padded = zlib.gzipSync(Buffer.from(`{"version":1,"text":"${v.text('text.gzip', 'inflated last')}"${' '.repeat(40 * 1024 * 1024)}}`), { level: 9 });
    // A small save whose document is large: nested 1 400 deep, its 8 KB body arrives at once (its place in the order of
    // saves comes first) and its indentation makes a 3.9 MB document that takes a while to write, while the read that
    // comes next reads the file it replaces (a file a read takes in one piece, under 512 KiB) on both arms; a read that
    // waited for the save would read the new one.
    const large = JSON.parse(`${'{"a":'.repeat(1400)}"${v.text('text.large-save', 'nested save')}"${'}'.repeat(1400)}`);
    return [
      step.staged('unread-body-get', [['get', { ...get(), headers: [['Content-Type', 'text/plain']], body: rawBody('abc') }], ['post', post(jsonBody(documentOf(v, 'while-get-waits')))]], headFirst('get', 'post')),
      step.exchange('get-after-unread-get', get()),
      step.staged('unparsed-spelling-post', [['unparsed', post(rawBody(JSON.stringify(documentOf(v, 'unparsed'))), 'local-admin', JSON_TYPE, '/api/Session-Folders')], ['post', post(jsonBody(documentOf(v, 'while-unparsed-waits')))]], headFirst('unparsed', 'post')),
      step.exchange('get-after-unparsed', get()),
      step.staged('compressed-and-plain', [['gzip', post(rawBody(padded), 'local-admin', [['Content-Type', 'application/json'], ['Content-Encoding', 'gzip']])], ['plain', post(jsonBody(documentOf(v, 'plain-second')))]], [['send', 'gzip', 'all'], ['send', 'plain', 'all'], ['await', 'plain'], ['await', 'gzip']]),
      step.exchange('get-after-compressed', get()),
      step.staged('readable-together', [['probe', get()], ['first', post(jsonBody(documentOf(v, 'connected-first')))], ['second', post(jsonBody(documentOf(v, 'connected-second')))]],
        [['send', 'probe', 'all'], ['await', 'probe'], ['send', 'second', 'all'], ['send', 'first', 'all'], ['await', 'first'], ['await', 'second']]),
      step.exchange('get-after-together', get()),
      step.external('file-large', { op: 'write', path: FILE, data: Buffer.from(stored({ version: 1, pad: v.text('text.large-file', 'f'.repeat(400_000)) })) }),
      step.staged('read-during-write', [['post', post(jsonBody(large))], ['get', get()]], [['send', 'post', 'all'], ['send', 'get', 'all'], ['await', 'get'], ['await', 'post']]),
      step.exchange('post-small-after', post(jsonBody(documentOf(v, 'after')))),
      step.exchange('get-after', get()),
    ];
  },
});

/** State across a restart, files changed under the arm, and kills after a save and during one (§5.4). */
export const RESTARTS = defineScenario({
  id: 'session-folders.restarts', group: 'session-folders',
  description: 'a restart between a save and a read, external edits, a kill after a save and a kill during one',
  principals,
  fixture: () => {},
  steps: (v) => [
    step.exchange('post', post(jsonBody(documentOf(v, 'before-restart')))),
    step.restart('restart'),
    step.exchange('get-after-restart', get()),
    step.external('external-edit', { op: 'write', path: FILE, data: Buffer.from(stored(documentOf(v, 'external'))) }),
    step.exchange('get-after-external', get()),
    step.external('external-malformed', { op: 'write', path: FILE, data: Buffer.from(v.text('text.malformed-file', '{not json')) }),
    step.exchange('get-malformed-file', get()),
    step.exchange('post-over-malformed', post(jsonBody(documentOf(v, 'repair')))),
    step.killAfter('kill-after-save', 'response-end', post(jsonBody(documentOf(v, 'killed-after')))),
    step.exchange('get-after-kill', get()),
    step.killAfter('kill-during-save', 'request-sent', post(jsonBody(documentOf(v, 'killed-during')))),
    step.exchange('get-after-kill-during', get()),
    step.external('external-delete', { op: 'delete', path: FILE }),
    step.exchange('get-after-delete', get()),
  ],
});

/**
 * The data file in the states GET reads and POST replaces: JSON values that are not documents, files GET answers
 * empty, a document nested 100 000 deep (JSON.parse is iterative in V8, and so is res.json's JSON.stringify,
 * which has no replacer and no gap: echoed at any depth), a directory at the file's path (GET fails reading, a save fails
 * renaming, with the temporary file's name in the text, and removes it), a file nobody may read (GET fails
 * opening it; a save replaces it), a link to itself (GET fails; a save replaces the link), a dangling link (GET
 * answers empty), a link to another file (GET reads it; a save replaces the link and leaves the file), and a
 * data root nobody may write (a save's temporary file is refused).
 */
export const FILE_STATES = defineScenario({
  id: 'session-folders.file-states', group: 'session-folders',
  description: 'data files that are other JSON values, empty, blank, BOM-prefixed, not UTF-8, deeply nested, a directory, unreadable, links, and a read-only data root',
  principals,
  fixture: () => {},
  steps: (v) => {
    const write = (id, data, mode) => step.external(id, { op: 'write', path: FILE, data: Buffer.isBuffer(data) ? data : Buffer.from(data), ...(mode === undefined ? {} : { mode }) });
    const remove = (id) => step.external(id, { op: 'delete', path: FILE });
    const deep = (depth) => `${'{"a":'.repeat(depth)}[]${'}'.repeat(depth)}`;
    return [
      write('file-null', 'null'), step.exchange('get-null-file', get()),
      write('file-number', ' 1e3 '), step.exchange('get-number-file', get()),
      write('file-string', `"${v.text('text.string-file', 'a string')}"`), step.exchange('get-string-file', get()),
      write('file-array', `[1,"${v.text('text.array-file', 'two')}",{"3":4}]`), step.exchange('get-array-file', get()),
      write('file-false', 'false'), step.exchange('get-false-file', get()),
      write('file-empty', ''), step.exchange('get-empty-file', get()),
      write('file-blank', ' \n\t '), step.exchange('get-blank-file', get()),
      write('file-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(stored(documentOf(v, 'bom')))])), step.exchange('get-bom-file', get()),
      write('file-not-utf8', Buffer.concat([Buffer.from('{"s":"'), Buffer.from([0xff, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98]), Buffer.from('"}')])), step.exchange('get-not-utf8-file', get()),
      write('file-values', `{"z":1,"10":"ten","2":"two","z":2,"__proto__":null,"n":[1E2,0.10,-0,1e400],"lone":"\\udc00x"}`), step.exchange('get-values-file', get()),
      // Values the one pass converts, in a file V8 keeps in order (BH7 fix round 1, S2).
      write('file-values-in-order', `{"n":[1E2,0.10,-0,1e400,12345678901234567890,97312000038578.125,{"m":[2.50,-0.0]}],"s":["\\u0041\\/","\\ud800","x\\u2028"],"01":true}`), step.exchange('get-values-in-order-file', get()),
      write('file-deep-ok', deep(200)), step.exchange('get-deep-ok', get()),
      write('file-deep-overflow', deep(100_000)), step.exchange('get-deep-overflow', get()),
      remove('file-removed'),
      step.external('file-is-directory', { op: 'mkdir', path: FILE }),
      step.exchange('get-directory', get()),
      step.exchange('post-directory', post(jsonBody(documentOf(v, 'into-directory')))),
      step.external('directory-removed', { op: 'delete', path: FILE }),
      write('file-unreadable', stored(documentOf(v, 'unreadable')), 0o000),
      step.exchange('get-unreadable', get()),
      step.exchange('post-over-unreadable', post(jsonBody(documentOf(v, 'over-unreadable')))),
      step.exchange('get-after-unreadable', get()),
      remove('unreadable-replaced-removed'),
      step.external('file-link-loop', { op: 'symlink', path: FILE, target: FILE }),
      step.exchange('get-link-loop', get()),
      step.exchange('post-over-link-loop', post(jsonBody(documentOf(v, 'over-loop')))),
      remove('loop-replaced-removed'),
      step.external('file-dangling-link', { op: 'symlink', path: FILE, target: 'missing.json' }),
      step.exchange('get-dangling-link', get()),
      step.exchange('post-over-dangling-link', post(jsonBody(documentOf(v, 'over-dangling')))),
      remove('dangling-replaced-removed'),
      step.external('other-file', { op: 'write', path: 'other.json', data: Buffer.from(stored(documentOf(v, 'linked'))) }),
      step.external('file-link-other', { op: 'symlink', path: FILE, target: 'other.json' }),
      step.exchange('get-linked-file', get()),
      step.exchange('post-over-link', post(jsonBody(documentOf(v, 'over-link')))),
      step.exchange('get-after-link', get()),
      step.external('root-read-only', { op: 'chmod', path: '.', mode: 0o555 }),
      step.exchange('post-read-only-root', post(jsonBody(documentOf(v, 'read-only-root')))),
      step.exchange('get-read-only-root', get()),
      step.external('root-writable', { op: 'chmod', path: '.', mode: 0o755 }),
      step.exchange('post-after', post(jsonBody(documentOf(v, 'after')))),
    ];
  },
});

/**
 * The stale-file rule of each save (harness-runtime's cleanupStaleAtomicFiles, called before the save's own
 * temporary file is written): every regular file of the data root named `sessions-directories.json.tmp-…` whose
 * mtime is a day or more before the arm's clock is removed; a newer one, a directory, a link, another file's
 * temporary file, a file in a folder below, and a name without the dash stay; a save that then fails has still
 * removed them; a root nobody may write stops the cleanup at its first refusal (and the save fails).
 * Clock dependence: "a day before the arm's clock" is judged without the real time, with mtimes no clock between
 * 1970-01-03 and 2100 can put on the other side: 1970-01-02 (stale) and 2100-01-01 (fresh). The boundary
 * itself (exactly 24 hours, and a millisecond either side) needs a clock both arms share: it is judged without
 * real time by the crate's vectors (packages/native/crates/route-session-folders/tests/cleanup.tsv, made by
 * harness-runtime's cleanup with a given clock; tests/vectors.rs).
 */
export const TEMPORARY_FILES = defineScenario({
  id: 'session-folders.temporary-files', group: 'session-folders',
  description: 'stale and fresh temporary files of earlier saves, files the cleanup must leave, a cleanup a read-only root stops, a failing save that still cleans, and a file written now that stays',
  principals,
  fixture: (root) => {
    const STALE = 86_400; // 1970-01-02, in seconds
    const FRESH = 4_102_444_800; // 2100-01-01
    const make = (name, mtime, { dir = false, data = 'partial' } = {}) => {
      const file = path.join(root, ...name.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (dir) fs.mkdirSync(file); else fs.writeFileSync(file, data);
      fs.utimesSync(file, mtime, mtime);
    };
    make(`${FILE}.tmp-1-stale`, STALE);
    make(`${FILE}.tmp-`, STALE);
    make(`${FILE}.tmp-2-fresh`, FRESH);
    make(`${FILE}.tmp-3-stale-dir`, STALE, { dir: true });
    make(`${FILE}.tmp`, STALE);
    make(`other.json.tmp-4-stale`, STALE);
    make(`folder/${FILE}.tmp-5-stale`, STALE);
    make('stale-target', STALE);
    fs.symlinkSync('stale-target', path.join(root, `${FILE}.tmp-6-link`));
    fs.lutimesSync(path.join(root, `${FILE}.tmp-6-link`), STALE, STALE);
  },
  steps: (v) => [
      step.exchange('get-before', get()),
      // A root nobody may write: the cleanup's first removal is refused, which stops it (the group's catch takes it, and
      // every stale file stays), then the save's own temporary file is refused (500, EACCES).
      step.external('root-read-only', { op: 'chmod', path: '.', mode: 0o555 }),
      step.exchange('post-read-only-root', post(jsonBody(documentOf(v, 'read-only')))),
      step.external('root-writable', { op: 'chmod', path: '.', mode: 0o755 }),
      // A save that fails (a directory at the file's path) has removed the stale files first.
      step.external('file-is-directory', { op: 'mkdir', path: FILE }),
      step.exchange('post-fails-after-cleaning', post(jsonBody(documentOf(v, 'into-directory')))),
      step.external('directory-removed', { op: 'delete', path: FILE }),
      step.exchange('post-saves', post(jsonBody(documentOf(v, 'first')))),
      // A temporary file written now is fresh by its mtime (a write sets it): it stays.
      step.external('tmp-written-now', { op: 'write', path: `${FILE}.tmp-7-now`, data: Buffer.from('partial') }),
      step.exchange('post-keeps-new', post(jsonBody(documentOf(v, 'second')))),
      step.exchange('get-after', get()),
  ],
});

/**
 * What Express and the shared body parser give the group, and a port must give itself: the GET route's routing
 * and conditional forms and HEAD; the POST route's routing forms (the shared JSON parser chooses its limit by the
 * path as written: `/api/Session-Folders` is left unparsed, `/API/SESSION-FOLDERS` is parsed), charsets, a BOM,
 * an `application/*+json` type, compressed bodies (gzip of two members, deflate, brotli), forms (the extended
 * parser's objects, arrays, overflow and depth), the body limits, and the methods and spellings the tail answers.
 */
export const REQUEST_FORMS = defineScenario({
  id: 'session-folders.request-forms', group: 'session-folders',
  description: 'routing, conditional and body forms of both routes, forms of the extended URL-encoded parser, compressed bodies, the limits, and what the tail answers',
  principals,
  fixture: (root, v) => { fs.writeFileSync(path.join(root, FILE), stored(documentOf(v, 'seeded'))); },
  steps: (v) => {
    const seeded = JSON.stringify(documentOf(v, 'seeded'));
    const etag = v.token('etag.seeded', `W/"${Buffer.byteLength(seeded).toString(16)}-${crypto.createHash('sha1').update(seeded, 'utf8').digest('base64').slice(0, 27)}"`);
    const typed = (contentType, bytes, extra = [], target = BASE) => post(rawBody(bytes), 'local-admin', [...(contentType ? [['Content-Type', contentType]] : []), ...extra], target);
    const doc = (label) => JSON.stringify(documentOf(v, label));
    const form = (text) => typed('application/x-www-form-urlencoded', text);
    const malformed = (spec) => ({ ...spec, headers: [...(spec.headers ?? []), ['Content-Type', 'application/json']], body: rawBody('{"version":'), edge: true });
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(doc('utf16'), 'utf16le')]);
    // A chunked body: each [data, extension] a chunk, then the last chunk with its own extension.
    const chunked = (chunks, last) => Buffer.from(`${chunks.map(([data, extension]) => `${Buffer.byteLength(data).toString(16)}${extension}\r\n${data}\r\n`).join('')}0${last}\r\n\r\n`);
    const twoMembers = Buffer.concat([zlib.gzipSync(Buffer.from(`{"version":1,"text":"${v.text('text.member-1', 'first member')}`)), zlib.gzipSync(Buffer.from(` ${v.text('text.member-2', 'and second')}"}`))]);
    return [
      // GET.
      step.exchange('get-etag', get()),
      step.exchange('get-if-none-match', get('local-admin', { headers: [['If-None-Match', etag]] })),
      step.exchange('get-if-none-match-other', get('local-admin', { headers: [['If-None-Match', v.token('etag.other', 'W/"1c-0000000000000000000000000000"')]] })),
      step.exchange('get-if-none-match-no-cache', get('local-admin', { headers: [['If-None-Match', etag], ['Cache-Control', 'no-cache']] })),
      step.exchange('get-if-modified-since', get('local-admin', { headers: [['If-Modified-Since', v.token('date.modified-since', 'Tue, 01 Jan 2030 00:00:00 GMT')]] })),
      step.exchange('get-accept-gzip', get('local-admin', { headers: [['Accept-Encoding', 'gzip']] })),
      step.exchange('head', { ...get(), method: 'HEAD' }),
      step.exchange('get-trailing-slash', { ...get(), target: `${BASE}/` }),
      step.exchange('get-other-case', { ...get(), target: '/API/Session-Folders' }),
      step.exchange('get-query', { ...get(), target: `${BASE}?x=1` }),
      step.exchange('get-text-body', { ...get(), headers: [['Content-Type', 'text/plain']], body: rawBody('ignored') }),
      step.exchange('get-malformed-body', malformed(get())),
      // POST: routing forms.
      step.exchange('post-trailing-slash', typed('application/json', doc('trailing'), [], `${BASE}/`)),
      step.exchange('post-other-case-api', typed('application/json', doc('case-api'), [], '/api/Session-Folders')),
      step.exchange('post-other-case-all', typed('application/json', doc('case-all'), [], '/API/SESSION-FOLDERS')),
      step.exchange('post-query', typed('application/json', doc('query'), [], `${BASE}?x=1`)),
      step.exchange('post-if-none-match', typed('application/json', doc('conditional'), [['If-None-Match', '*']])),
      // POST: charsets, types and encodings.
      step.exchange('post-charset-utf8', typed('application/json; charset=utf-8', doc('utf8'))),
      step.exchange('post-charset-latin1', { ...typed('application/json; charset=latin1', doc('latin1')), edge: true }),
      step.exchange('post-utf16', typed('application/json; charset=utf-16', utf16)),
      step.exchange('post-bom', typed('application/json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(doc('bom'))]))),
      step.exchange('post-plus-json', typed('application/vnd.folders+json', doc('plus-json'))),
      step.exchange('post-gzip', typed('application/json', zlib.gzipSync(Buffer.from(doc('gzip'))), [['Content-Encoding', 'gzip']])),
      step.exchange('post-gzip-two-members', typed('application/json', twoMembers, [['Content-Encoding', 'gzip']])),
      step.exchange('post-deflate', typed('application/json', zlib.deflateSync(Buffer.from(doc('deflate'))), [['Content-Encoding', 'deflate']])),
      step.exchange('post-brotli', typed('application/json', zlib.brotliCompressSync(Buffer.from(doc('brotli'))), [['Content-Encoding', 'br']])),
      step.exchange('post-unknown-encoding', { ...typed('application/json', doc('compress'), [['Content-Encoding', 'compress']]), edge: true }),
      // The shared parser's 50 MB: one byte over is refused by the edge after reading it all.
      step.exchange('post-over-parser-limit', { ...typed('application/json', Buffer.alloc(50 * 1024 * 1024 + 1, 0x20)), edge: true }),
      // Forms: the extended parser (qs) builds the object the group stores.
      step.exchange('post-form', form(`version=1&${v.text('text.form-key', 'name')}=${encodeURIComponent(v.text('text.form-value', 'a form & more'))}&list[]=a&list[]=b&nested[x][y]=z&plus=a+b`)),
      step.exchange('get-after-form', get()),
      step.exchange('post-form-shapes', form('a=1&a=2&b[1]=x&b[0]=y&c[2]=sparse&d[x]=1&d=2&e[]=&f[%5B%5D]=bracket&__proto__=p&g[__proto__]=q&h[toString]=t&9=nine&i%5Bj%5D=encoded')),
      step.exchange('get-after-form-shapes', get()),
      step.exchange('post-form-overflow', form(Array.from({ length: 102 }, (_, index) => `big[${index}]=${index}`).join('&'))),
      step.exchange('post-form-depth-32', form(`${'k'}${'[k]'.repeat(32)}=deep`)),
      step.exchange('post-form-depth-33', { ...form(`${'k'}${'[k]'.repeat(33)}=deeper`), edge: true }),
      step.exchange('post-form-latin1', typed('application/x-www-form-urlencoded; charset=iso-8859-1', Buffer.from(`t=${'%E9'}&r=caf\xe9`, 'latin1'))),
      step.exchange('post-form-unparsed-path', typed('application/x-www-form-urlencoded', `version=${v.text('text.form-unparsed', '2')}`, [], '/api/Session-Folders')),
      step.exchange('post-form-empty', form('')),
      // body-parser's parameter limit: 1 000 parameters are parsed (and stored); 1 001 the edge refuses (413).
      step.exchange('post-form-1000-params', form(Array.from({ length: 1000 }, (_, index) => `p${index}=${index % 7}`).join('&'))),
      step.exchange('post-form-1001-params', { ...form(Array.from({ length: 1001 }, (_, index) => `p${index}=${index % 7}`).join('&')), edge: true }),
      // A chunked body with chunk extensions (Node's parser reads past them).
      step.exchange('post-chunked-extension', post(rawBody(chunked([[doc('chunked').slice(0, 9), ';name=value'], [doc('chunked').slice(9), ';x']], ';last')), 'local-admin', [['Content-Type', 'application/json'], ['Transfer-Encoding', 'chunked']])),
      step.exchange('get-after-forms', get()),
      // What the tail answers: methods no route registers, and spellings Express routes to neither route.
      step.exchange('put-collection', { method: 'PUT', target: BASE, headers: JSON_TYPE, body: jsonBody({ version: 1 }), principal: 'local-admin', tail: true }),
      step.exchange('delete-collection', { method: 'DELETE', target: BASE, principal: 'local-admin', tail: true }),
      step.exchange('options-collection', { method: 'OPTIONS', target: BASE, principal: 'local-admin', tail: true }),
      step.exchange('patch-collection', { method: 'PATCH', target: BASE, headers: JSON_TYPE, body: jsonBody({ version: 1 }), principal: 'local-admin', tail: true }),
      step.exchange('get-literal-encoded', { ...get(), target: '/api/session%2Dfolders', tail: true }),
      step.exchange('post-literal-encoded', { ...post(jsonBody(documentOf(v, 'encoded'))), target: '/api/session%2Dfolders', tail: true }),
      step.exchange('get-empty-segment', { ...get(), target: '//api/session-folders', tail: true }),
      step.exchange('post-empty-segment', { ...post(jsonBody(documentOf(v, 'empty-segment'))), target: '//api/session-folders', tail: true }),
      step.exchange('get-sub-path', { ...get(), target: `${BASE}/x`, tail: true }),
      step.exchange('get-after', get()),
    ];
  },
  waivers: Object.fromEntries([
    ...['get-malformed-body', 'post-charset-latin1', 'post-unknown-encoding', 'post-over-parser-limit', 'post-form-depth-33', 'post-form-1001-params'].map((id) => [id, EDGE_WAIVER]),
    ...['put-collection', 'delete-collection', 'options-collection', 'patch-collection', 'get-literal-encoded', 'post-literal-encoded', 'get-empty-segment', 'post-empty-segment', 'get-sub-path'].map((id) => [id, TAIL_WAIVER]),
  ]),
});

/**
 * Saves that truly overlap (BH7 fix round 1, S1): a small body whose document is large (nested 1 400 deep: 8 KB
 * sent, 3.9 MB written) and one or two small saves written right after it, back to back, so they reach the arm
 * together, in order. The JavaScript takes them in that order and saves one at a time: the last small one is
 * stored, every answer is a success and no temporary file stays. Without the save queue the small saves are
 * written and renamed while the large one is still being written, and its rename comes last: the large document
 * is stored. Repeated, so no lucky scheduling hides it; judged exactly, each followed by a GET.
 */
export const OVERLAPPING_SAVES = defineScenario({
  id: 'session-folders.overlapping-saves', group: 'session-folders',
  description: 'a large save and small saves sent right after it, together: one save at a time, the last sent stored',
  principals,
  fixture: (root, v) => { fs.writeFileSync(path.join(root, FILE), stored(documentOf(v, 'seeded'))); },
  steps: (v) => {
    const large = (label) => JSON.parse(`${'{"a":'.repeat(1400)}"${v.text(`text.large.${label}`, `large ${label}`)}"${'}'.repeat(1400)}`);
    const together = (names) => [...names.map((name) => ['send', name, 'all']), ...names.map((name) => ['await', name])];
    const steps = [];
    for (const round of [1, 2, 3]) {
      steps.push(step.staged(`two-saves-${round}`, [['large', post(jsonBody(large(`two-${round}`)))], ['small', post(jsonBody(documentOf(v, `two-${round}`)))]], together(['large', 'small'])));
      steps.push(step.exchange(`get-after-two-${round}`, get()));
    }
    for (const round of [1, 2]) {
      steps.push(step.staged(`three-saves-${round}`, [['large', post(jsonBody(large(`three-${round}`)))], ['first', post(jsonBody(documentOf(v, `three-${round}-a`)))], ['second', post(jsonBody(documentOf(v, `three-${round}-b`)))]], together(['large', 'first', 'second'])));
      steps.push(step.exchange(`get-after-three-${round}`, get()));
    }
    return steps;
  },
});

/**
 * The data file's mode under umasks other than the harness's 022 (BH7 fix round 1, S4): each save's temporary file
 * is created 0666 before the umask and renamed over the file, so under 027 the file is 0640 and under 000 0666; a
 * port that sets 0644 itself (equal under 022) differs.
 */
const umaskScenario = (umask, name) => defineScenario({
  id: `session-folders.umask-${name}`, group: 'session-folders',
  description: `saves and a failing save with the arms' umask at ${name}: the file's mode is 0666 masked`,
  principals,
  umask,
  fixture: () => {},
  steps: (v) => [
    step.exchange('post-new', post(jsonBody(documentOf(v, `umask-${name}-first`)))),
    step.exchange('post-replace', post(jsonBody(documentOf(v, `umask-${name}-second`)))),
    step.exchange('get-after', get()),
  ],
});
export const UMASK_027 = umaskScenario(0o027, '027');
export const UMASK_000 = umaskScenario(0o000, '000');

export const SCENARIOS = Object.freeze([READS_AND_WRITES, SAVE_ORDER, WRITE_ORDER, RESTARTS, FILE_STATES, TEMPORARY_FILES, REQUEST_FORMS, OVERLAPPING_SAVES, UMASK_027, UMASK_000]);

const HANDLERS = 'routes.js:registerSessionFoldersRoutes';
const ERRORS_ARE_ERRORS = 'unreachable: everything that reaches this catch comes from fs.promises, which rejects with Error objects';
/** The census waivers (coverage-census.mjs): items of the group no scenario can exercise, each with why. */
export const CENSUS_WAIVERS = Object.freeze({
  ...Object.fromEntries(['GET /api/session-folders', 'POST /api/session-folders'].flatMap((route) => ['managed-admin', 'managed-developer'].map((principalClass) => [`principal ${principalClass} ${route}`, { reason: MANAGED_WAIVER.reason }]))),
  [`${HANDLERS}>persist>run>fsPromises.rm(tmp, { force: true }).cat…~b9e28563(callback):function fsPromises.rm(tmp, { force: true }).cat…~b9e28563(callback)`]: { reason: 'unreachable: rm with force resolves when the temporary file is missing, and the folder that let the save create it lets it be removed' },
  [`${HANDLERS}>GET /api/session-folders handler>fsPromises.readFile(filePath, 'utf8').c…~18c50510(callback):decides error (operand 1 of && chain error && error.code === 'ENOENT')`]: { reason: 'unreachable: readFile rejects with an Error object, never a falsy value' },
  [`${HANDLERS}>GET /api/session-folders handler:false error instanceof Error : 'Failed to read session folde…~25e63910`]: { reason: ERRORS_ARE_ERRORS },
  [`${HANDLERS}>POST /api/session-folders handler:decides typeof body !== 'object' (operand 2 of || chain !body || typeof body !== 'object' || Array.isArra…~0ffdcddc)`]: { reason: 'unreachable: the shared JSON parser is strict (an object or an array) and the URL-encoded parser builds an object, so a truthy body is always an object' },
  [`${HANDLERS}>POST /api/session-folders handler:false error instanceof Error : 'Failed to write session fold…~1813c7ae`]: { reason: ERRORS_ARE_ERRORS },
});

/**
 * The errors a save meets in a state of the data root (census `error` items): its temporary file refused by a
 * root nobody may write (EACCES), its rename over a directory at the file's path (EISDIR). Not reachable from a
 * data-root state: ENOENT (mkdir makes the folder first), ENOSPC and EROFS (the machine).
 */
export const CENSUS_ERRORS = Object.freeze([
  Object.freeze({ call: `${HANDLERS}>persist>run:call fsPromises.writeFile(tmp, serialized, 'utf8')`, codes: Object.freeze(['EACCES']), why: 'a data root nobody may write' }),
  Object.freeze({ call: `${HANDLERS}>persist>run:call fsPromises.rename(tmp, filePath)`, codes: Object.freeze(['EISDIR']), why: 'a directory at the file\'s path' }),
]);
