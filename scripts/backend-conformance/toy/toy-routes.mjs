// A toy route group whose every write is known exactly, for the self-test of
// the group host and the tap (conformance.test.mjs). It is served behind the
// real web edge (edge.mjs), so its /api paths get the edge's no-store headers,
// compression, the body parser and the local-administrator principal.
// Nothing here sleeps: work that must stay pending waits on a gate, or on a
// long timer, that a later request opens or clears.
import { AsyncResource } from 'node:async_hooks';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { declaredWork } from './toy-background.mjs';
import { registerLaterFromHelper, registerThroughHelper } from './toy-helper.mjs';

// Gates: a promise a later request resolves.
const gates = new Map();
const gate = (name = 'default') => new Promise((resolve) => { gates.set(name, resolve); });
const open = (name = 'default') => { const release = gates.get(name); gates.delete(name); release?.(); return Boolean(release); };
// Long timers a later request clears.
const timers = new Set();
// Machinery created at registration, outside any exchange.
const bus = new EventEmitter();
const outside = new AsyncResource('toy-outside');
const big = 'abcdefghij'.repeat(600);
const unreadAnswers = [];
const unsettled = [];
const debounced = [];
let debounceTimer = null;
let debounceFlush = false;

export function registerToyRoutes(app, { express, publish, absentDependency }) {
  // Product code logs to stdout while it registers: the launcher must not take this for the ready line.
  console.log('toy registrar: a log line on stdout before the ready line');
  // Registered directly.
  app.get('/api/toy/direct', (_req, res) => { res.json({ route: 'direct' }); });
  // Through a router, mounted with app.use.
  const router = express.Router();
  router.get('/inner', (req, res) => { res.json({ route: 'router', baseUrl: req.baseUrl, url: req.url }); });
  app.use('/api/toy/router', router);
  // Through a mounted sub-app.
  const sub = express();
  sub.get('/inner', (req, res) => { res.json({ route: 'mount', baseUrl: req.baseUrl }); });
  app.use('/api/toy/mount', sub);
  // A use() middleware that answers, and one that passes on to what follows (the tail stand-in).
  app.use('/api/toy/use-answers', (_req, res) => { res.json({ route: 'use-answers' }); });
  app.use('/api/toy/use-passes', (_req, _res, next) => { next(); });
  // app.route(), app.all() and an array of handlers.
  app.route('/api/toy/chain').get((_req, res) => { res.json({ route: 'chain-get' }); }).post(express.json(), (req, res) => { res.json({ route: 'chain-post', body: req.body }); });
  app.all('/api/toy/all', (req, res) => { res.json({ route: 'all', method: req.method }); });
  app.get('/api/toy/array', [(req, _res, next) => { req.toyStep = 1; next(); }, (req, _res, next) => { req.toyStep += 1; next(); }], (req, res) => { res.json({ route: 'array', step: req.toyStep }); });
  // Registered through a helper in another file, called from here.
  registerThroughHelper(app, '/api/toy/helper', (_req, res) => { res.json({ route: 'helper' }); });

  // ---------- headers
  // The edge sets Cache-Control (no-store) before the handler; the handler overrides it.
  app.get('/api/toy/override', (_req, res) => { res.setHeader('Cache-Control', 'private, max-age=5'); res.setHeader('X-Toy', 'draft'); res.setHeader('X-Toy', 'set'); res.json({ route: 'override' }); });
  // A dependency the host leaves absent, called at request time (toy table only).
  app.get('/api/toy/absent', (_req, res) => { try { absentDependency(); res.json({ called: true }); } catch (error) { res.status(500).type('text/plain').send(error.message); } });
  // A header the edge appends to after the group (compression adds Accept-Encoding to Vary).
  app.get('/api/toy/vary', (req, res) => { res.setHeader('Vary', 'Origin'); res.json(req.query.large ? { big } : { small: 1 }); });
  app.get('/api/toy/cookies', (_req, res) => { res.append('Set-Cookie', 'a=1'); res.append('Set-Cookie', 'b=2'); res.removeHeader('X-Robots-Tag'); res.json({ route: 'cookies' }); });
  app.get('/api/toy/invalid-header', (_req, res) => { res.setHeader('X-Bad', 'a\nb'); res.json({}); });
  app.get('/api/toy/identity', (req, res) => {
    res.json({ write: res.write.name, end: res.end.name, setHeader: res.setHeader.name, setHeaderLength: res.setHeader.length, push: req.push.name, on: res.on.name, emit: res.emit.name, closeListeners: res.listenerCount('close') });
  });

  // ---------- bodies
  // A body large enough for the edge to compress.
  app.get('/api/toy/large', (_req, res) => { res.json({ route: 'large', text: big }); });
  // Exactly n bytes, for the compression threshold probes.
  app.get('/api/toy/size', (req, res) => { res.type('text/plain').send('a'.repeat(Number(req.query.n))); });
  // Several writes, and a body of 256 KiB (more than one TCP read).
  app.get('/api/toy/chunks', (_req, res) => { res.setHeader('Content-Type', 'text/plain'); res.write('a'); res.write(Buffer.from('b')); res.end('c'); });
  app.get('/api/toy/huge', (_req, res) => { res.setHeader('Content-Type', 'application/octet-stream'); for (let i = 0; i < 4; i += 1) res.write(Buffer.alloc(64 * 1024, 65 + i)); res.end(); });
  app.post('/api/toy/upload', (req, res) => { let length = 0; req.on('data', (chunk) => { length += chunk.length; }); req.on('end', () => res.json({ length })); });
  // Bytes after the group's end: never part of its body.
  app.get('/api/toy/twice-compressed', (_req, res) => { res.json({ big }); res.end('EXTRA'); });
  app.get('/api/toy/write-after-end', (_req, res) => { res.on('error', () => {}); res.end('x'); res.write('late'); });
  // Bodies that print a stack (unrecordable: the frames depend on how the process composed its layers): raw text, escaped in JSON; and one that does not.
  app.get('/api/toy/text-stack', (_req, res) => { res.status(500).type('text/plain').send(new Error('toy text stack').stack); });
  app.get('/api/toy/json-stack', (_req, res) => { res.status(500).json({ error: 'toy json stack', stack: new Error('toy json stack').stack }); });
  app.get('/api/toy/no-stack', (_req, res) => { res.json({ note: 'meet at 10:30:00', path: '/a/b.js:1:2' }); });
  // A handler that throws, and a response ended twice.
  app.get('/api/toy/throws', () => { throw new Error('toy handler failure'); });
  // Ending again without data is a no-op; ending again with data would emit an unhandled 'error' (write after end) and stop any server.
  app.get('/api/toy/twice', (_req, res) => { res.end('first'); res.end(); });
  // Express's form of answering twice: the second res.json throws (headers already sent).
  app.get('/api/toy/twice-json', (_req, res) => { res.json({ answer: 1 }); res.json({ answer: 2 }); });
  // A response the client abandons: the first chunk, then a gate.
  app.get('/api/toy/abandoned', async (_req, res) => { res.setHeader('Content-Type', 'text/plain'); res.write('part'); await gate('abandoned'); res.end('rest'); });

  // ---------- edge probes (edge-probes.mjs)
  app.get('/api/devryan/toy-alias', (req, res) => { res.json({ originalUrl: req.originalUrl, url: req.url }); });
  app.all('/api/toy/listeners', (_req, res) => { res.json({ finish: res.listenerCount('finish'), close: res.listenerCount('close') }); });
  app.post('/api/preview/toy-json', (req, res) => { res.json({ parsedByEdge: req.body !== undefined, keys: req.body && typeof req.body === 'object' ? Object.keys(req.body).length : null }); });
  app.post('/api/session/:id/message', (_req, res) => { res.json({ route: 'session-message' }); });
  app.get('/api/toy/ip', (req, res) => { res.json({ ip: req.ip, protocol: req.protocol }); });
  // The composed app's settings (trust proxy is not visible to a client through this edge: it refuses forwarded requests from loopback).
  app.get('/api/toy/settings', (req, res) => { res.json(Object.fromEntries(Object.entries(req.app.settings).filter(([, value]) => typeof value !== 'function'))); });
  app.get('/api/toy/principal', (req, res) => { res.json({ scope: req.principal?.scope ?? null }); });
  // The principal the edge attached to a plain loopback request (no cookie, no forwarding header).
  app.get('/api/toy/whoami', (req, res) => { res.json({ scope: req.principal?.scope ?? null, role: req.principal?.role ?? null }); });

  // ---------- work after the response
  // Fire-and-forget work: declared (toy-background.mjs is a declared site), and not declared.
  app.post('/api/toy/declared', (_req, res) => { void declaredWork(() => gate('declared')); res.json({ route: 'declared' }); });
  app.post('/api/toy/undeclared', (_req, res) => { void (async () => { await gate('undeclared'); await Promise.resolve(); })(); res.json({ route: 'undeclared' }); });
  app.post('/api/toy/release', (req, res) => { res.json({ released: open(String(req.query.gate ?? 'default')) }); });
  // A long timer, and one created by work the response started (nested): pending until cleared.
  app.get('/api/toy/timer', (_req, res) => { timers.add(setTimeout(() => {}, 600_000)); res.json({ route: 'timer' }); });
  app.get('/api/toy/nested-timer', (_req, res) => { res.json({ route: 'nested-timer' }); setImmediate(() => { timers.add(setTimeout(() => {}, 600_000)); }); });
  app.post('/api/toy/clear-timers', (_req, res) => { for (const timer of timers) clearTimeout(timer); const cleared = timers.size; timers.clear(); res.json({ cleared }); });
  // An effect after the response ended (late), and one from a context no exchange owns (unattributed).
  app.get('/api/toy/late', (_req, res) => { res.json({ route: 'late' }); void gate('late').then(() => publish({ type: 'toy.late' })); });
  app.get('/api/toy/unattributed', (_req, res) => { outside.runInAsyncScope(() => publish({ type: 'toy.unattributed' })); res.json({ route: 'unattributed' }); });
  // Blind spots the tap must mark: work from a response callback, a listener on a module emitter,
  // an AsyncResource created by group code.
  app.get('/api/toy/on-finish', (_req, res) => { res.on('finish', () => { timers.add(setTimeout(() => {}, 600_000)); }); res.json({ route: 'on-finish' }); });
  app.get('/api/toy/bus-listener', async (_req, res) => { bus.once('go', () => publish({ type: 'toy.bus' })); res.json({ route: 'bus-listener' }); });
  app.get('/api/toy/bus-emit', (_req, res) => { bus.emit('go'); res.json({ route: 'bus-emit' }); });
  app.get('/api/toy/async-resource', (_req, res) => { const resource = new AsyncResource('toy-queue'); void resource; res.json({ route: 'async-resource' }); });
  // Work that ends without a destroy the tap can wait for in time: a queueMicrotask chain (Node's Microtask
  // resource) and zlib.gzip (its handle is destroyed at garbage collection; its close ends the work). Both quiescent, no blind mark.
  app.get('/api/toy/microtasks', (_req, res) => { res.json({ route: 'microtasks' }); let left = 1000; const step = () => { left -= 1; if (left) queueMicrotask(step); }; queueMicrotask(step); });
  app.get('/api/toy/gzip', (_req, res) => { zlib.gzip(Buffer.alloc(256 * 1024, 1), () => { res.json({ route: 'gzip' }); }); });
  // Kept referenced: an unread body that garbage collection may take settles its promises, so whether it stays pending would be the collector's call.
  // A debounce: the first request starts a timer (re-armed until a later request allows the flush), later requests only queue
  // onto it. Their work runs on the first exchange's timer: each later exchange is marked crossed when the timer fires.
  app.post('/api/toy/debounce', (req, res) => {
    debounced.push(String(req.query.n));
    const tick = () => {
      if (!debounceFlush) { debounceTimer = setTimeout(tick, 1); return; }
      debounceTimer = null;
      debounceFlush = false;
      publish({ type: 'toy.debounce', items: debounced.splice(0) });
    };
    if (!debounceTimer) debounceTimer = setTimeout(tick, 1);
    res.json({ queued: debounced.length });
  });
  app.post('/api/toy/debounce-flush', (_req, res) => { debounceFlush = true; res.json({ flushing: true }); });
  app.get('/api/toy/fetch-unread', async (req, res) => { const answer = await fetch(String(req.query.to)); unreadAnswers.push(answer); res.json({ route: 'fetch-unread', status: answer.status }); });
  // A promise that never settles (a race against a cleared timer): never quiescent; /quiescent says so when its deadline passes.
  app.get('/api/toy/race-cleared', async (_req, res) => {
    let timer;
    const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 600_000); });
    unsettled.push(timeout); // referenced, so garbage collection cannot settle it either
    const value = await Promise.race([Promise.resolve(1), timeout]);
    clearTimeout(timer);
    res.json({ value });
  });

  // ---------- effects
  app.post('/api/toy/hub', (_req, res) => { publish({ type: 'toy.event', n: 1 }); publish({ type: 'toy.event', n: 2 }); res.json({ route: 'hub' }); });
  app.get('/api/toy/fetch', async (req, res) => {
    const answer = await fetch(String(req.query.to), { method: 'POST', body: Readable.from(['toy-', 'out', 'bound']), duplex: 'half', headers: { 'X-Toy-Out': 'f' } });
    res.json({ route: 'fetch', status: answer.status, text: await answer.text() });
  });
  app.get('/api/toy/http-request', (req, res) => {
    const outbound = http.request(String(req.query.to), { method: 'POST', headers: { 'X-Toy-Out': 'h' } }, (answer) => {
      const chunks = [];
      answer.on('data', (chunk) => chunks.push(chunk));
      answer.on('end', () => res.json({ route: 'http-request', status: answer.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    outbound.write('http-');
    outbound.end('body');
  });
  app.get('/api/toy/child', (_req, res) => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("toy-child:" + require("fs").readFileSync(0, "utf8"))'], { encoding: 'utf8', input: 'stdin-bytes', env: { ...process.env, TOY_CHILD: 'x' } });
    res.json({ route: 'child', stdout: result.stdout, status: result.status });
  });
  // Effects that finish after the response: the tap completes their record with effect-update records.
  // A child that exits 3 once its stdin ends, written to before and after the response.
  app.get('/api/toy/child-late-exit', (_req, res) => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(3))'], { stdio: ['pipe', 'ignore', 'inherit'] });
    child.stdin.write('early-');
    void gate('child-exit').then(() => child.stdin.end('late'));
    res.json({ route: 'child-late-exit' });
  });
  // An outbound fetch whose body ends, and whose answer comes, after the response.
  app.get('/api/toy/fetch-late', (req, res) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('early-')); void gate('fetch-body').then(() => { controller.enqueue(encoder.encode('late')); controller.close(); }); } });
    void fetch(String(req.query.to), { method: 'POST', body, duplex: 'half', headers: { 'X-Toy-Out': 'fl' } }).then((answer) => answer.text());
    res.json({ route: 'fetch-late' });
  });
  // An http.request whose body ends, and whose answer comes, after the response; and one never ended (never answered).
  app.get('/api/toy/http-late', (req, res) => {
    const outbound = http.request(String(req.query.to), { method: 'POST', headers: { 'X-Toy-Out': 'hl' } }, (answer) => { answer.resume(); });
    outbound.write('early-');
    void gate('http-body').then(() => outbound.end('late'));
    res.json({ route: 'http-late' });
  });
  app.get('/api/toy/http-unended', (req, res) => {
    const outbound = http.request(String(req.query.to), { method: 'POST', headers: { 'X-Toy-Out': 'hu' } }, (answer) => { answer.resume(); });
    outbound.on('error', () => {});
    unsettled.push(outbound);
    outbound.write('never-ended');
    res.json({ route: 'http-unended' });
  });
  // A child whose exit the tap cannot watch (no exit hook on its handle when it spawned): written unfinished, and marked when the exchange goes quiescent.
  app.get('/api/toy/child-unseen-exit', (_req, res) => {
    const child = new ChildProcess();
    const onexit = child._handle.onexit;
    child._handle.onexit = null;
    child.spawn({ file: process.execPath, args: [process.execPath, '-e', ''], stdio: 'ignore', envPairs: Object.entries(process.env).map(([key, value]) => `${key}=${value}`) });
    child._handle.onexit = onexit;
    child.on('exit', (code) => res.json({ route: 'child-unseen-exit', code }));
  });
  app.get('/api/toy/child-async', (_req, res) => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('close', (code) => res.json({ route: 'child-async', stdout: Buffer.concat(chunks).toString(), code }));
    child.stdin.write('async-');
    child.stdin.end('stdin');
  });
}

/** A registrar during whose run a route is registered with no group frame on the stack: the host must refuse. */
export async function registerToyUnattributed(app) {
  app.get('/api/toy-late/own', (_req, res) => { res.json({}); });
  registerLaterFromHelper(app);
  await new Promise((resolve) => { setImmediate(resolve); });
}

/** A registrar the tap cannot classify: a param() callback from a group file. */
export function registerToyParam(app) {
  app.param('toyId', (_req, _res, next) => next());
  app.get('/api/toy-param/:toyId', (_req, res) => { res.json({}); });
}

/** A registrar that patches the framework while it registers (behaviour unchanged): the host must refuse. */
export function registerToyFrameworkPatch(app, { express }) {
  const json = express.response.json;
  express.response.json = function json_(body) { return json.call(this, body); };
  app.get('/api/toy-patch/own', (_req, res) => { res.json({}); });
}
