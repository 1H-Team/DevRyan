// Planted differences behind the JavaScript candidate adapter (BH4; the
// BH3/BH4 review and its fix round). Each plant is a candidate that differs
// from the group in one way: a copy of the group's files with exactly-once
// replacements (`changes`), and/or J's own layers replaced (`compose`: the
// text of a module whose `compose(parts)` js-candidate.mjs runs instead of its
// default composition). Each states what must happen when it runs as the
// candidate against a scenario's R, R' and J recordings (`expect`):
//   caught       a row fails with a difference of `component` (a prefix) and `rule`, at `step` when
//                named, or with the candidate fault `fault`;
//   limit        no row fails: what it does is under the named limit of the candidate's observation
//                (observe.mjs CANDIDATE_EFFECT_LIMIT), printed in every run's summary;
//   by-design    no row fails: a part of the exchange that is not compared, and why (`why`);
//   equivalent   no row fails: the plant does not change what a client can see (`why`);
//   unjudgeable  no row fails: the pilot cannot judge it (`why`).
// closure-plants.mjs runs them all; closure.full.test.mjs runs a few within its CPU budget.
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT } from './edge.mjs';
import { GROUPS } from './groups.mjs';
import { READS_AND_WRITES, REQUEST_FORMS, RESTARTS, WRITE_LOCK } from './scenarios/magic-prompts.mjs';

const GROUP = GROUPS['magic-prompts'];
const SOURCE = path.join(REPOSITORY_ROOT, path.dirname(GROUP.registrar.module));

// ------------------------------------------------------------------ the builder's 31 (each a difference caught by its rule)
const RW = READS_AND_WRITES.id;
const WL = WRITE_LOCK.id;
const RS = RESTARTS.id;
const GET_LINE = '      const state = await runtime.readPromptState();\n      res.json(state);';
const getAs = (replacement) => ({ file: 'routes.js', find: GET_LINE, replace: `      const state = await runtime.readPromptState();\n      ${replacement}` });
const WRITE_LINE = "    await fsPromises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');";
const write = (replacement) => ({ file: 'runtime.js', find: WRITE_LINE, replace: replacement });
const PERSIST_WRITE = '      await writePromptState(next);';
const REGISTRAR = 'export const registerMagicPromptRoutes = (app, dependencies) => {';
const PUT_ANSWER = '      const state = await runtime.setOverride(id, text);\n      return res.json(state);';
/** Each plant: id, what it changes (one or more exactly-once replacements), the scenario that shows it, and the component and rule that must catch it. */
export const PLANTS = Object.freeze([
  { id: 'status-422', changes: [{ file: 'routes.js', find: "message.includes('cannot be empty') ? 400 : 500", replace: "message.includes('cannot be empty') ? 422 : 500" }], scenario: RW, component: 'status', rule: 'bytes' },
  { id: 'empty-visible-accepted', changes: [{ file: 'runtime.js', find: 'text.trim().length === 0', replace: 'text.length === 0' }], scenario: RW, component: 'status', rule: 'bytes' },
  { id: 'limit-off-by-one', changes: [{ file: 'runtime.js', find: 'if (text.length > MAX_PROMPT_TEXT_LENGTH) {', replace: 'if (text.length >= MAX_PROMPT_TEXT_LENGTH) {' }], scenario: RW, component: 'status', rule: 'bytes' },
  { id: 'id-not-trimmed', changes: [{ file: 'runtime.js', find: "const setOverride = async (id, text) => {\n    const normalizedId = typeof id === 'string' ? id.trim() : '';", replace: "const setOverride = async (id, text) => {\n    const normalizedId = typeof id === 'string' ? id : '';" }], scenario: RW, component: 'status', rule: 'bytes' },
  { id: 'lone-surrogate-rejected', changes: [{ file: 'routes.js', find: '    if (text === null) {', replace: "    if (text !== null && /[\\ud800-\\udbff](?![\\udc00-\\udfff])/.test(text)) return res.status(400).json({ error: 'text is not well-formed' });\n    if (text === null) {" }], scenario: RW, component: 'status', rule: 'bytes' },
  { id: 'etag-off', changes: [{ file: 'routes.js', find: REGISTRAR, replace: `${REGISTRAR}\n  app.set('etag', false);` }], scenario: RW, component: 'headers.etag', rule: 'headers' },
  { id: 'etag-strong', changes: [{ file: 'routes.js', find: REGISTRAR, replace: `${REGISTRAR}\n  app.set('etag', 'strong');` }], scenario: RW, component: 'headers.etag', rule: 'etag' },
  { id: 'extra-header', changes: [getAs("res.set('X-Cache', 'miss').json(state);")], scenario: RW, component: 'headers.x-cache', rule: 'headers' },
  { id: 'content-encoding', changes: [getAs("res.set('Content-Encoding', 'identity').json(state);")], scenario: RW, component: 'headers.content-encoding', rule: 'headers' },
  { id: 'content-type', changes: [getAs("res.type('text/json').json(state);")], scenario: RW, component: 'headers.content-type', rule: 'headers' },
  { id: 'no-content-length', changes: [getAs("res.type('application/json'); res.write(JSON.stringify(state)); res.end();")], scenario: RW, component: 'headers.content-length', rule: 'headers' },
  { id: 'body-key-order', changes: [getAs('res.json({ overrides: state.overrides, version: state.version });')], scenario: RW, component: 'body', rule: 'bytes' },
  { id: 'body-byte', changes: [getAs("res.json({ ...state, version: 2 });")], scenario: RW, component: 'body', rule: 'bytes' },
  { id: 'version-string', changes: [{ file: 'runtime.js', find: 'const FILE_VERSION = 1;', replace: "const FILE_VERSION = '1';" }], scenario: RW, component: 'body', rule: 'bytes' },
  { id: 'error-text', changes: [{ file: 'routes.js', find: "error: 'text is required'", replace: "error: 'text is required.'" }], scenario: RW, component: 'body', rule: 'bytes' },
  { id: 'error-text-detail', changes: [{ file: 'runtime.js', find: "throw new Error('Deprecated prompt id');", replace: "throw new Error(`Deprecated prompt id: ${normalizedId}`);" }], scenario: RW, component: 'body', rule: 'bytes' },
  { id: 'reset-all-key-order', changes: [{ file: 'runtime.js', find: 'return persist(async () => ({ version: FILE_VERSION, overrides: {} }));', replace: 'return persist(async () => ({ overrides: {}, version: FILE_VERSION }));' }], scenario: RW, component: 'body', rule: 'bytes' },
  { id: 'file-mode-600', changes: [write("    await fsPromises.writeFile(filePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });")], scenario: RW, component: 'tree.magic-prompts.json.mode', rule: 'inode' },
  { id: 'replaced-not-in-place', changes: [write("    await fsPromises.writeFile(`${filePath}.tmp`, JSON.stringify(state, null, 2), 'utf8');\n    await fsPromises.rename(`${filePath}.tmp`, filePath);")], scenario: RW, component: 'tree.magic-prompts.json.replaced', rule: 'inode' },
  { id: 'indent-4', changes: [write("    await fsPromises.writeFile(filePath, JSON.stringify(state, null, 4), 'utf8');")], scenario: RW, component: 'tree.magic-prompts.json.bytes', rule: 'bytes' },
  { id: 'trailing-newline', changes: [write("    await fsPromises.writeFile(filePath, `${JSON.stringify(state, null, 2)}\\n`, 'utf8');")], scenario: RW, component: 'tree.magic-prompts.json.bytes', rule: 'bytes' },
  { id: 'extra-file', changes: [write(`${WRITE_LINE}\n    await fsPromises.writeFile(\`\${filePath}.bak\`, JSON.stringify(state, null, 2), 'utf8');`)], scenario: RW, component: 'tree.magic-prompts.json.bak', rule: 'inode' },
  { id: 'extra-directory', changes: [write(`${WRITE_LINE}\n    await fsPromises.mkdir(path.join(path.dirname(filePath), 'cache'), { recursive: true });`)], scenario: RW, component: 'tree.cache', rule: 'inode' },
  { id: 'home-write', changes: [write(`${WRITE_LINE}\n    await fsPromises.writeFile(path.join(process.env.HOME, 'magic-prompts.cache'), '{}', 'utf8');`)], scenario: RW, component: 'tree.home:magic-prompts.cache', rule: 'inode' },
  { id: 'missing-write', changes: [{ file: 'runtime.js', find: PERSIST_WRITE, replace: '      // planted: the state is answered but never written' }], scenario: RW, component: 'tree.magic-prompts.json', rule: 'inode' },
  { id: 'no-op-write-skipped', changes: [{ file: 'runtime.js', find: PERSIST_WRITE, replace: '      if (JSON.stringify(next) !== JSON.stringify(current)) await writePromptState(next);' }], scenario: RW, component: 'tree.magic-prompts.json.lastWriter', rule: 'last-writer' },
  { id: 'mtime-preserved', changes: [write(`${WRITE_LINE}\n    await fsPromises.utimes(filePath, 1, 1);`)], scenario: RW, component: 'tree.magic-prompts.json.mtimeWindow', rule: 'time-window' },
  { id: 'answered-before-durable', changes: [
    { file: 'runtime.js', find: PERSIST_WRITE, replace: '      globalThis.plantedDeferredWrite = () => writePromptState(next);' },
    { file: 'routes.js', find: PUT_ANSWER, replace: "      const state = await runtime.setOverride(id, text);\n      const deferred = globalThis.plantedDeferredWrite;\n      globalThis.plantedDeferredWrite = null;\n      if (deferred) req.socket.server.once('connection', () => { deferred(); });\n      return res.json(state);" },
  ], scenario: RW, component: 'tree.magic-prompts.json', rule: 'inode' },
  { id: 'lock-admits-two-writers', changes: [
    { file: 'runtime.js', find: '  let writeLock = Promise.resolve();', replace: '  let waiting = null;\n  // planted: every write waits for a second writer, then both go on with what they read\n  const rendezvous = () => new Promise((resolve) => { if (waiting) { waiting(); waiting = null; resolve(); } else waiting = resolve; });' },
    { file: 'runtime.js', find: '      const current = await readPromptState();', replace: '      const current = await readPromptState();\n      await rendezvous();' },
    { file: 'runtime.js', find: '    writeLock = writeLock.then(run, run);\n    return writeLock;', replace: '    return run();' },
  ], scenario: WL, component: 'concurrency(not admissible)', rule: 'concurrency' },
  { id: 'stale-after-external-write', changes: [
    { file: 'runtime.js', find: '  const readPromptState = async () => {\n    try {', replace: '  let cached = null;\n  const readPromptState = async () => {\n    if (cached) return cached;\n    try {' },
    { file: 'runtime.js', find: '      return {\n        version: FILE_VERSION,\n        overrides,\n      };', replace: '      cached = {\n        version: FILE_VERSION,\n        overrides,\n      };\n      return cached;' },
    { file: 'runtime.js', find: PERSIST_WRITE, replace: `${PERSIST_WRITE}\n      cached = next;` },
  ], scenario: RS, component: 'body', rule: 'bytes' },
  { id: 'stale-after-restart', changes: [
    { file: 'runtime.js', find: PERSIST_WRITE, replace: '      globalThis.plantedBufferedWrite = () => writePromptState(next);' },
    { file: 'routes.js', find: "  app.get('/api/magic-prompts', async (_req, res) => {", replace: "  app.get('/api/magic-prompts', async (_req, res) => {\n    if (globalThis.plantedBufferedWrite) { const flush = globalThis.plantedBufferedWrite; globalThis.plantedBufferedWrite = null; await flush(); }" },
  ], scenario: RS, component: 'body', rule: 'bytes' },
]);


// ------------------------------------------------------------------ the review's 30 (reports/BH34-review-probes/review-candidate-plants.mjs), with what must happen now
const RF = REQUEST_FORMS.id;
const PUT_TOP = "    const text = typeof req.body?.text === 'string' ? req.body.text : null;";
const putTop = (code) => ({ file: 'routes.js', find: PUT_TOP, replace: `${PUT_TOP}\n${code}` });
/** J's default composition with `before` (layers ahead of the shared parser), the parser line and `after` (between the parser and the envelope). */
const composeJ = ({ before = '', parser = 'registerCommonRequestMiddleware(app, { express });', after = '', envelope = 'app.use(envelopeLayer);' } = {}) => `export function compose({ app, express, registerCommonRequestMiddleware, runWithRequestPrincipal, envelopeOf, envelopeLayer }) {
  void runWithRequestPrincipal; void envelopeOf; void envelopeLayer;
  app.disable('x-powered-by');
  ${before}
  ${parser}
  ${after}
  ${envelope}
}
`;
const OWN_ENVELOPE = (body) => `app.use((req, res, next) => { const envelope = envelopeOf(req); ${body} });`;
const NOT_COMPARED = 'header-name case, the order of different header names, the reason phrase and Connection are the transport\'s framing, which no client of this server reads (docs: the comparer, M2)';
export const REVIEW_PLANTS = Object.freeze([
  { id: 'header-name-lowercase', scenario: RW, changes: [getAs("res.setHeader('content-type', 'application/json; charset=utf-8'); res.send(JSON.stringify(state));")], expect: 'by-design', why: NOT_COMPARED },
  { id: 'header-duplicated', scenario: RW, changes: [getAs("const wh = res.writeHead; res.writeHead = function (...a) { const ct = res.getHeader('content-type'); res.setHeader('Content-Type', [ct, ct]); return wh.apply(this, a); }; res.json(state);")], expect: 'caught', component: 'headers.content-type', rule: 'headers' },
  { id: 'header-order', scenario: RW, changes: [getAs("const wh = res.writeHead; res.writeHead = function (...a) { const ct = res.getHeader('content-type'); res.removeHeader('content-type'); res.setHeader('Content-Type', ct); return wh.apply(this, a); }; res.json(state);")], expect: 'by-design', why: NOT_COMPARED },
  { id: 'trailing-byte', scenario: RW, changes: [getAs("res.type('application/json').send(`${JSON.stringify(state)}\\n`);")], expect: 'caught', component: 'body', rule: 'bytes' },
  { id: 'charset-case', scenario: RW, changes: [getAs("res.set('Content-Type', 'application/json; charset=UTF-8').send(JSON.stringify(state));")], expect: 'equivalent', why: 'Express normalises the charset parameter (res.set lowercases it through setCharset)' },
  { id: 'write-then-delete-temp', scenario: RW, changes: [write(`    await fsPromises.writeFile(\`\${filePath}.tmp\`, 'x', 'utf8');\n    await fsPromises.unlink(\`\${filePath}.tmp\`);\n${WRITE_LINE}`)], expect: 'by-design', why: 'a file written and removed between two snapshots leaves no trace in either (docs: the driver, M1)' },
  { id: 'data-root-mode', scenario: RW, changes: [write(`${WRITE_LINE}\n    await fsPromises.chmod(path.dirname(filePath), 0o755);`)], expect: 'caught', component: 'tree.(root).mode', rule: 'inode' },
  { id: 'subdir-temp-left-empty', scenario: RW, changes: [write(`${WRITE_LINE}\n    await fsPromises.mkdir(path.join(path.dirname(filePath), '.tmp'), { recursive: true });`)], expect: 'caught', component: 'tree..tmp', rule: 'inode' },
  { id: 'response-ends-early', scenario: RW, changes: [getAs("const b = JSON.stringify(state); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(b.length) }); res.write(b.slice(0, 5)); setTimeout(() => res.socket.destroy(), 20);")], expect: 'caught', fault: 'response-incomplete' },
  { id: 'error-body-extra-key', scenario: RW, changes: [{ file: 'routes.js', find: "      return res.status(status).json({ error: message });\n    }\n  });\n\n  app.delete('/api/magic-prompts/:id'", replace: "      return res.status(status).json({ error: message, code: status });\n    }\n  });\n\n  app.delete('/api/magic-prompts/:id'" }], expect: 'caught', component: 'body', rule: 'bytes' },
  { id: 'outbound-request', scenario: RW, changes: [getAs("(await import('node:http')).get('http://127.0.0.1:9/planted').on('error', () => {}); res.json(state);")], expect: 'limit', why: 'a connection to an address the harness did not hand out' },
  { id: 'child-process', scenario: RW, changes: [getAs("(await import('node:child_process')).execFileSync('/usr/bin/true'); res.json(state);")], expect: 'limit', why: 'a child started by absolute path that exits before the next look at the process group' },
  { id: 'if-none-match-ignored', scenario: RF, changes: [getAs("delete _req.headers['if-none-match']; res.json(state);")], expect: 'caught', step: 'get-if-none-match', component: 'status', rule: 'bytes' },
  { id: 'trailing-slash-404', scenario: RF, changes: [getAs("if (_req.originalUrl !== '/api/magic-prompts') return res.status(404).json({ error: 'no' }); res.json(state);")], expect: 'caught', step: 'get-trailing-slash', component: 'status', rule: 'bytes' },
  { id: 'head-405', scenario: RF, changes: [getAs("if (_req.method === 'HEAD') return res.status(405).end(); res.json(state);")], expect: 'caught', step: 'head', component: 'status', rule: 'bytes' },
  { id: 'query-400', scenario: RF, changes: [getAs("if (Object.keys(_req.query ?? {}).length) return res.status(400).json({ error: 'q' }); res.json(state);")], expect: 'caught', step: 'get-query', component: 'status', rule: 'bytes' },
  { id: 'text-plain-own-error', scenario: RW, changes: [putTop("    if (req.is('text/plain')) return res.status(400).json({ error: 'unsupported media type' });")], expect: 'caught', step: 'put-text-plain', component: 'body', rule: 'bytes' },
  { id: 'reason-phrase', scenario: RW, changes: [getAs("res.statusMessage = 'Fine'; res.json(state);")], expect: 'by-design', why: NOT_COMPARED },
  { id: 'no-date-header', scenario: RW, changes: [getAs('res.sendDate = false; res.json(state);')], expect: 'caught', component: 'headers.date', rule: 'headers' },
  { id: 'connection-close', scenario: RW, changes: [getAs("res.set('Connection', 'close'); res.json(state);")], expect: 'by-design', why: NOT_COMPARED },
  { id: 'late-write-timer', scenario: RW, changes: [write(`${WRITE_LINE}\n    setTimeout(() => { fsPromises.writeFile(\`\${filePath}.late\`, 'x').catch(() => {}); }, 30);`)], expect: 'caught', component: 'tree.magic-prompts.json.late', rule: 'inode' },
  { id: 'restart-loses-file-mode', scenario: RS, changes: [write(`${WRITE_LINE}\n    await fsPromises.chmod(filePath, 0o644);`)], expect: 'equivalent', why: 'the file is already 0644' },
  { id: 'j-principal-ignored', scenario: RW, compose: composeJ({ envelope: 'app.use((req, _res, next) => { req.principal = null; runWithRequestPrincipal(null, () => next(), { assignment: null }); });' }), expect: 'unjudgeable', why: 'magic-prompts never reads the principal and only local-admin is judged (M3)' },
  { id: 'j-assignment-ignored', scenario: RW, compose: composeJ({ envelope: OWN_ENVELOPE('req.principal = envelope.principal; runWithRequestPrincipal(envelope.principal, () => next(), { assignment: { bogus: true } });') }), expect: 'unjudgeable', why: 'magic-prompts never reads the assignment (M3)' },
  { id: 'j-peer-used-wrongly', scenario: RW, compose: composeJ({ envelope: OWN_ENVELOPE("if (envelope.peer?.directLocal === true && req.method === 'DELETE' && req.url === '/api/magic-prompts') { res.status(403).json({ error: 'remote' }); return; } envelopeLayer(req, res, next);") }), expect: 'caught', component: 'status', rule: 'bytes' },
  { id: 'j-authorization-used-wrongly', scenario: RW, compose: composeJ({ envelope: OWN_ENVELOPE("if (envelope.authorizationActive === true && req.method === 'PUT' && req.url.includes('instructions')) { res.status(403).json({ error: 'forbidden' }); return; } envelopeLayer(req, res, next);") }), expect: 'caught', component: 'status', rule: 'bytes' },
  { id: 'j-originalurl-used', scenario: RW, compose: composeJ({ envelope: OWN_ENVELOPE("if (envelope.originalUrl !== req.url) { res.status(400).json({ error: 'url' }); return; } envelopeLayer(req, res, next);") }), expect: 'equivalent', why: 'originalUrl is always the URL the candidate is sent' },
  { id: 'j-json-latin1', scenario: RW, compose: composeJ({ parser: "app.use((req, res, next) => { if (!req.is('application/json')) { next(); return; } const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { try { req.body = JSON.parse(Buffer.concat(parts).toString('latin1')); next(); } catch { res.status(400).json({ error: 'bad json' }); } }); });" }), expect: 'caught', step: 'put-non-utf8', component: 'body', rule: 'bytes' },
  { id: 'j-json-first-key-wins', scenario: RW, compose: composeJ({ after: "app.use((req, _res, next) => { if (req.body && req.headers['content-type'] === 'application/json' && req.body.text === 'b') req.body.text = 'a'; next(); });" }), expect: 'caught', step: 'put-duplicate-keys', component: 'body', rule: 'bytes' },
  { id: 'j-json-bigint-lossless', scenario: RW, compose: composeJ({ after: "app.use((req, _res, next) => { if (req.body?.text === 9007199254740992) req.body.text = 9007199254740993n.toString(); next(); });" }), expect: 'caught', step: 'put-text-2-53-plus-1', component: 'status', rule: 'bytes' },
]);

// ------------------------------------------------------------------ the fix round's own (S1: effects observed from outside; S3: what J gets for free)
export const FIX_PLANTS = Object.freeze([
  { id: 'child-process-path', scenario: RW, changes: [getAs("(await import('node:child_process')).execFileSync('true'); res.json(state);")], expect: 'caught', step: 'get-empty', component: 'children(count)', rule: 'effects' },
  { id: 'outbound-to-stub', scenario: RW, changes: [getAs("const planted = await import('node:http'); await new Promise((resolve) => { planted.get(`${process.env.DEVRYAN_HARNESS_STUB_OUTBOUND}/planted`, (answer) => { answer.resume(); answer.on('end', resolve); }).on('error', resolve); }); res.json(state);")], expect: 'caught', step: 'get-empty', component: 'outbound(count)', rule: 'effects' },
  { id: 'child-absolute-still-running', scenario: RW, changes: [getAs("(await import('node:child_process')).spawn('/bin/sleep', ['3'], { stdio: 'ignore' }); res.json(state);")], expect: 'caught', step: 'get-empty', component: 'children(count)', rule: 'effects' }, // by absolute path, but still running at S1: the process-group look
  { id: 'j-etag-ignored', scenario: RF, compose: composeJ({ before: "app.use((req, _res, next) => { delete req.headers['if-none-match']; next(); });" }), expect: 'caught', step: 'get-if-none-match', component: 'status', rule: 'bytes' },
  { id: 'j-strict-routing', scenario: RF, compose: composeJ({ before: "app.set('strict routing', true);" }), expect: 'caught', step: 'get-trailing-slash', component: 'status', rule: 'bytes' },
  { id: 'j-case-sensitive-routing', scenario: RF, compose: composeJ({ before: "app.set('case sensitive routing', true);" }), expect: 'caught', step: 'get-other-case', component: 'status', rule: 'bytes' },
  { id: 'j-head-refused', scenario: RF, compose: composeJ({ before: "app.use((req, res, next) => { if (req.method === 'HEAD') { res.status(405).end(); return; } next(); });" }), expect: 'caught', step: 'head', component: 'status', rule: 'bytes' },
  { id: 'j-query-refused', scenario: RF, compose: composeJ({ before: "app.use((req, res, next) => { if (req.url.includes('?')) { res.status(400).json({ error: 'query' }); return; } next(); });" }), expect: 'caught', step: 'get-query', component: 'status', rule: 'bytes' },
  { id: 'j-charset-refused', scenario: RF, compose: composeJ({ before: "app.use((req, res, next) => { if (/charset=/i.test(req.headers['content-type'] ?? '')) { res.status(415).json({ error: 'charset' }); return; } next(); });" }), expect: 'caught', step: 'put-charset-utf8', component: 'status', rule: 'bytes' },
  { id: 'j-no-inflate', scenario: RF, compose: composeJ({ before: "app.use((req, res, next) => { if (req.headers['content-encoding']) { res.status(415).json({ error: 'encoding' }); return; } next(); });" }), expect: 'caught', step: 'put-gzip', component: 'status', rule: 'bytes' },
  { id: 'j-limit-100kb', scenario: RW, compose: composeJ({ parser: "app.use(express.json({ limit: '100kb' })); app.use(express.urlencoded({ extended: true, limit: '50mb' }));" }), expect: 'caught', step: 'put-text-200000', component: 'status', rule: 'bytes' },
  { id: 'j-bom-kept', scenario: RF, compose: composeJ({ parser: "app.use((req, res, next) => { if (!req.is('application/json')) { next(); return; } const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); if (text.charCodeAt(0) === 0xfeff) { res.status(400).json({ error: 'Unexpected token' }); return; } try { req.body = text ? JSON.parse(text) : {}; next(); } catch { res.status(400).json({ error: 'bad json' }); } }); });" }), expect: 'caught', step: 'put-bom', component: 'status', rule: 'bytes' },
  { id: 'j-empty-json-refused', scenario: RF, compose: composeJ({ before: "app.use((req, res, next) => { if (req.headers['content-length'] === '0' && /json/.test(req.headers['content-type'] ?? '')) { res.status(400).json({ error: 'empty body' }); return; } next(); });" }), expect: 'caught', step: 'put-empty-json', component: 'body', rule: 'bytes' },
  { id: 'j-plus-json-parsed', scenario: RF, compose: composeJ({ before: "app.use((req, _res, next) => { if (/\\+json/.test(req.headers['content-type'] ?? '')) req.headers['content-type'] = 'application/json'; next(); });" }), expect: 'caught', step: 'put-plus-json', component: 'status', rule: 'bytes' },
]);

/** Every plant, each id once. */
export const ALL_PLANTS = Object.freeze([...PLANTS.map((plant) => ({ ...plant, expect: 'caught', origin: 'builder' })), ...REVIEW_PLANTS.map((plant) => ({ ...plant, origin: 'review' })), ...FIX_PLANTS.map((plant) => ({ ...plant, origin: 'fix round 1' }))]);
if (new Set(ALL_PLANTS.map((plant) => plant.id)).size !== ALL_PLANTS.length) throw new Error('plants: an id is given twice');

/** A copy of the group's files with `plant.changes` applied (each found exactly once), and J's `compose` module when it has one, under `plants/<id>/` of `run`. */
export function plantedFiles(run, plant) {
  const dir = run.makeDirectory(`plants/${plant.id}/handlers`);
  for (const name of fs.readdirSync(SOURCE)) if (name.endsWith('.js') && !name.endsWith('.test.js')) fs.copyFileSync(path.join(SOURCE, name), path.join(dir, name));
  for (const change of plant.changes ?? []) {
    const file = path.join(dir, change.file);
    const text = fs.readFileSync(file, 'utf8');
    const count = text.split(change.find).length - 1;
    if (count !== 1) throw new Error(`plant ${plant.id}: the anchor ${JSON.stringify(change.find.slice(0, 60))} is found ${count} times in ${change.file}`);
    fs.writeFileSync(file, text.replace(change.find, change.replace));
  }
  const compose = plant.compose ? run.writeFile(`plants/${plant.id}/compose.mjs`, plant.compose) : null;
  return { handlers: dir, compose };
}

/**
 * What a plant's run shows: `{ outcome: 'caught' | 'escaped', by, failedRows, rules }`, from the rows
 * and the R-against-C comparison of `runClosure` (a fault named by a failed row's checks, or a difference
 * of the named component and rule at the named step).
 */
export function plantResult(plant, { rows, comparisons }) {
  const failed = rows.filter((row) => row.outcome === 'failed');
  const found = [...comparisons.judged.steps.entries()].flatMap(([step, entry]) => entry.differences.map((difference) => ({ ...difference, step })));
  const atStep = (step) => !plant.step || step === plant.step;
  const byFault = plant.fault ? failed.find((row) => row.checks.includes(plant.fault) && atStep(row.id.split('/').pop())) : null;
  const byDifference = plant.component ? found.find((difference) => difference.component.startsWith(plant.component) && difference.rule === plant.rule && atStep(difference.step)) : null;
  const hit = byFault ? `${byFault.id.split('/').pop()} fault ${plant.fault}` : byDifference ? `${byDifference.step} ${byDifference.component} [${byDifference.rule}]` : null;
  return { outcome: failed.length ? 'caught' : 'escaped', matches: Boolean(hit) && failed.length > 0, by: hit ?? (failed[0] ? `${failed[0].id.split('/').pop()}: ${failed[0].checks.join(',')}` : null), failedRows: failed.length, rules: [...new Set(found.map((difference) => difference.rule))].join(',') };
}
