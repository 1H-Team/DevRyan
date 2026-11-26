// The reference tap (BH1; design file 31 §3, §5.3): a Node preload
// (`node --import=<this file>`) that observes a server from inside without
// changing what it does, and writes records of each HTTP exchange.
//
// It is inert unless DEVRYAN_BACKEND_TAP names its setup file (JSON, written
// by the harness inside the run root):
//   { "v": 1, "outDir": <absolute private directory>, "group": <name>,
//     "groupFiles": [<absolute source files that count as the group's>],
//     "expressFrom": <absolute file or directory the product resolves express from>,
//     "declaredBackground": [{ "file": <absolute>, "line": <n|null>, "reason": <text> }],
//     "servers": "tagged" | "all" }
// It writes <outDir>/tap-<pid>.ndjson, created exclusively, one JSON object
// per line (docs/TESTING.md, "Record format", is the reference for readers):
//   tap             first line: format version, pid, Node, group, blind spots
//   host            what the group host composed (profile, steps, source digests)
//   registration    every route, use() and param() registration the router saw
//   problem         a registration the tap could not classify, or classified oddly
//   exchange-start  when a request starts (so a crash mid-exchange leaves a trace)
//   exchange        when the response ends: request, entry, response (`headAt`: when its head
//                   was written), effects
//   blind           something the tap cannot see completely, after the exchange record
//   quiescent       when no async resource the exchange started is pending
//   late            an effect or new work after the exchange ended or went quiescent
//   unattributed    an effect no exchange owns
//   effect-update   an effect already written (in an exchange, late or unattributed record)
//                   that changed afterwards: its whole new state, written when it finishes
//                   (a child's exit, an outbound answer or failure), when its exchange goes
//                   quiescent, or when /quiescent times out
//   coverage        a take of the group files' block coverage, written by the group host when it
//                   runs with --coverage (phase start, quiescent, pending or stop; seq; files)
//   clock           how late the group host's timer aimed at a second boundary fired, each time it
//                   was later than before (Node refreshes its cached Date header with such a timer)
// Bodies are base64. Nothing is redacted (records never leave the run's
// scratch), except child environment values, which are written as digests.
//
// How it observes, and why each is behaviour-preserving:
// - Registration: Route.prototype.<method>, Router.prototype.use, .param and
//   .route of the router package express uses. A handler registered from a
//   group file (or claimed by the host as made by a group handler factory) is
//   a Proxy whose call goes straight to the handler (no frame is added); the
//   router's read of its `length` right before the call marks the group's entry.
// - Context: the request runs in an AsyncLocalStorage context entered when the
//   request starts (the channel is published synchronously before 'request').
// - Exchanges: the http.server.request.start and http.server.response.finish
//   channels; raw request bytes by copying what the HTTP parser pushes; header
//   writes, the head and wire bytes on ServerResponse.prototype; the group's own
//   body by wrapping the response's write/end at group entry. Every patched
//   method keeps its name, and an error thrown through it has the tap's frame
//   removed and the stack depth the untapped call would have had.
// - Effects: undici and http.client channels (fetch and http.request with
//   headers, body and the answer), child processes (argv, cwd, environment
//   changes as digests, stdin, exit status), and recordHub() for hub recorders.
// - Quiescence: async_hooks (see TAP_BLIND_SPOTS for what it cannot see; each
//   detectable case is written as a `blind` mark on the exchange). An effect
//   that has not finished (`finished: false`: a child that has not exited, an
//   outbound request not answered) is pending work of its exchange; one whose
//   end the tap cannot see is marked `unfinished-effect` when the exchange goes
//   quiescent. A timer that product or group code started under one exchange
//   and that fires after a later exchange entered the group marks that later
//   exchange crossed (`event: 'timer'`): its work may ride on the timer.
import { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId } from 'node:async_hooks';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import dc from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TAP_SETUP_VARIABLE = 'DEVRYAN_BACKEND_TAP';
export const TAP_FORMAT = 2;
export const TAP_BLIND_SPOTS = Object.freeze([
  'work handed to a long-lived queue through a plain closure (no async resource carries it) is not attributed to the exchange',
  'work in native threads that creates no async resource is not seen',
  'worker threads are separate isolates and are not observed',
  'a child process is seen while its process handle lives, not its own descendants',
  'a pooled outbound connection (undici or http.Agent socket and keep-alive timer) is not waited for; the request is, through its promise',
  'a JavaScript AsyncResource created by product or group code is a context, never pending work: the exchange gets a blind mark (async-resource)',
  'a listener the group adds to an emitter created outside the exchange gets a blind mark (foreign-listener); if it fires under another exchange, that exchange gets a crossed mark',
  'timers, immediates and promises created by product or group code from a response callback (finish, close, a write callback) get a blind mark (response-callback); they are not waited for',
  'a promise that never settles (an unread fetch body, a race against a cleared timer) keeps the exchange pending: /quiescent answers quiescent:false with the pending sites when its deadline passes',
  'work a later exchange hands to an earlier exchange\'s timer (a debounce, a coalescing queue) is that earlier exchange\'s: the later one is marked crossed when the timer fires, and is quiescent before that work ran',
  'an AbortSignal.timeout(n) given to an outbound call is a timer of the exchange: it is pending for n ms after the work is done',
]);
const SELF = fileURLToPath(import.meta.url);
const TAP_KEY = Symbol.for('devryan.backend-conformance.tap');

const inert = Object.freeze({
  armed: false, tagServer() {}, recordHub() {}, whenQuiescent: async () => { throw new Error('the tap is not armed'); },
  pendingOf: () => [], blindOf: () => [], registrations: () => [], problems: () => [], beginGroupRegistration() {}, endGroupRegistration() {},
  markTopRouter() {}, claimHandler: (fn) => fn, markTail() {}, recordHost() {}, recordCoverage() {}, recordClock() {}, flushOf() {}, flushAll() {}, observeEntry() {}, file: null,
});

function readSetup() {
  const file = process.env[TAP_SETUP_VARIABLE];
  if (file === undefined || file === '') return null;
  if (!path.isAbsolute(file)) throw new Error(`${TAP_SETUP_VARIABLE} must name an absolute setup file`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${TAP_SETUP_VARIABLE} does not name a regular file`);
  const setup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (setup?.v !== 1) throw new Error(`tap setup version ${setup?.v} is not 1`);
  for (const key of ['outDir', 'expressFrom']) if (typeof setup[key] !== 'string' || !path.isAbsolute(setup[key])) throw new Error(`tap setup ${key} must be an absolute path`);
  if (!Array.isArray(setup.groupFiles) || setup.groupFiles.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) throw new Error('tap setup groupFiles must be absolute paths');
  if (!['tagged', 'all'].includes(setup.servers)) throw new Error('tap setup servers must be tagged or all');
  const declared = setup.declaredBackground ?? [];
  if (!Array.isArray(declared) || declared.some((entry) => typeof entry?.file !== 'string' || !path.isAbsolute(entry.file) || typeof entry.reason !== 'string' || !entry.reason.trim())) throw new Error('tap setup declaredBackground entries need an absolute file and a reason');
  const out = fs.lstatSync(setup.outDir);
  if (!out.isDirectory() || out.isSymbolicLink() || (out.mode & 0o077) !== 0 || fs.realpathSync(setup.outDir) !== setup.outDir) throw new Error('tap outDir must be a private canonical directory');
  return { ...setup, declaredBackground: declared };
}

// ------------------------------------------------------------ transparency
/** Removes the tap's frames from an error's stack, keeping the depth the untapped call would have had. */
const scrub = (error, limit) => {
  if (!error || typeof error !== 'object') return;
  let stack;
  try { stack = error.stack; } catch { return; }
  if (typeof stack !== 'string' || !stack.includes(SELF)) return;
  const lines = stack.split('\n');
  const kept = lines.filter((line) => !line.includes(SELF));
  const frames = kept.filter((line) => /^\s+at /.test(line));
  let surplus = typeof limit === 'number' ? frames.length - limit : 0;
  for (let index = kept.length - 1; index >= 0 && surplus > 0; index -= 1) if (/^\s+at /.test(kept[index])) { kept.splice(index, 1); surplus -= 1; }
  try { Object.defineProperty(error, 'stack', { value: kept.join('\n'), writable: true, configurable: true, enumerable: false }); } catch { /* frozen */ }
};
/** Calls `original` with one more stack frame of room; an error thrown through it loses the tap's frame. */
const callThrough = (original, self, args) => {
  const limit = Error.stackTraceLimit;
  const bump = typeof limit === 'number' && Number.isFinite(limit);
  if (bump) Error.stackTraceLimit = limit + 1;
  try { return Reflect.apply(original, self, args); } catch (error) { scrub(error, bump ? limit : undefined); throw error; } finally { if (bump) Error.stackTraceLimit = limit; }
};
/** A replacement named as the original, with its arity (so `fn.name`, `fn.length` and frames read the same). */
const named = (name, body, length = 0) => {
  const fn = ({ [name](...args) { return body(this, args); } })[name];
  Object.defineProperty(fn, 'length', { value: length, configurable: true });
  return fn;
};

function arm(setup) {
  const { O_CREAT, O_EXCL, O_WRONLY, O_APPEND, O_NOFOLLOW } = fs.constants;
  const file = path.join(setup.outDir, `tap-${process.pid}.ndjson`);
  const fd = fs.openSync(file, O_CREAT | O_EXCL | O_WRONLY | O_APPEND | O_NOFOLLOW, 0o600);
  // Synchronous writes create no async resource, so the tap never adds work of its own.
  const emit = (record) => { fs.writeSync(fd, `${JSON.stringify(record)}\n`); };
  const groupFiles = new Set(setup.groupFiles.map((entry) => fs.realpathSync(entry)));
  const declared = setup.declaredBackground.map((entry) => ({ ...entry, file: fs.realpathSync(entry.file) }));
  const problems = [];
  const problem = (text) => { problems.push(text); emit({ type: 'problem', text }); };
  emit({ type: 'tap', v: TAP_FORMAT, pid: process.pid, node: process.version, group: setup.group ?? null, servers: setup.servers, groupFiles: [...groupFiles], declaredBackground: declared, blindSpots: TAP_BLIND_SPOTS });

  // ------------------------------------------------------------ stack frames
  const realCache = new Map();
  const real = (file) => {
    if (!realCache.has(file)) { try { realCache.set(file, fs.realpathSync(file)); } catch { realCache.set(file, file); } }
    return realCache.get(file);
  };
  const FRAME = /\(?((?:file:\/\/)?\/[^():]+|node:[^():]+):(\d+):(\d+)\)?$/;
  const frames = (stack) => {
    const out = [];
    for (const line of String(stack).split('\n').slice(1)) {
      const match = line.match(FRAME);
      if (!match) continue;
      const raw = match[1];
      if (raw.startsWith('node:')) { out.push({ file: raw, line: Number(match[2]), node: true }); continue; }
      const absolute = raw.startsWith('file://') ? fileURLToPath(raw) : raw;
      const resolved = real(absolute);
      if (resolved === SELF) continue;
      out.push({ file: resolved, line: Number(match[2]), column: Number(match[3]), node: false });
    }
    return out;
  };
  const captureFrames = (depth = 64) => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = depth;
    const holder = {};
    Error.captureStackTrace(holder, captureFrames);
    Error.stackTraceLimit = limit;
    return frames(holder.stack);
  };
  const packageOf = (file) => {
    const index = file.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (index < 0) return null;
    const rest = file.slice(index + 14).split(path.sep);
    return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  };
  const isGroupFile = (file) => groupFiles.has(file);
  // The first frame outside Node; when every frame is Node's own (undici, timers), the first frame, so a pending site is never blank.
  const siteOf = (stackFrames) => { const first = stackFrames.find((frame) => !frame.node) ?? stackFrames.find((frame) => !/^node:internal\/(?:async_hooks|promise_hooks)$/.test(frame.file)); return first ? `${first.file}:${first.line}` : null; };
  /**
   * The product or group code that made the call itself (the first frame past the timer, event and
   * async-hooks machinery), or null when Node or a package made it on someone's behalf.
   */
  const CALL_MACHINERY = /^node:(?:events|timers|async_hooks|internal\/timers|internal\/process\/task_queues|internal\/async_hooks)$/;
  const codeFrame = (stackFrames) => {
    const caller = stackFrames.find((frame) => !(frame.node && CALL_MACHINERY.test(frame.file)));
    return caller && !caller.node && !packageOf(caller.file) ? caller : null;
  };
  // Modules that act for their caller: a header they set is the caller's.
  const ACTS_FOR_CALLER = /[\\/]node_modules[\\/](?:express[\\/]lib[\\/](?:response|request)\.js|send[\\/]|content-disposition[\\/]|etag[\\/]|fresh[\\/]|on-finished[\\/]|on-headers[\\/]|vary[\\/])/;
  // Packages that carry a response someone else decided to write (who answered is the one who called them).
  const TRANSPORT = new Set(['compression', 'on-headers', 'on-finished', 'ee-first']);
  // The dispatch machinery: a header set from a helper it called belongs to that helper.
  const DISPATCH = new Set(['router', 'express', 'finalhandler']);
  const edgeFiles = new Set(); // files that registered a layer that is not the group's
  /** Who made a write: 'group' (a group file decides), or the edge module, by the first deciding frame. */
  const originOf = (stackFrames) => {
    let helper = null;
    for (const frame of stackFrames) {
      if (frame.node) continue;
      if (isGroupFile(frame.file)) return { owner: 'group', file: frame.file, line: frame.line, column: frame.column };
      if (ACTS_FOR_CALLER.test(frame.file)) continue;
      const pkg = packageOf(frame.file);
      if (pkg) {
        if (DISPATCH.has(pkg) && helper) return { owner: 'edge', module: helper.file, file: helper.file, line: helper.line };
        return { owner: 'edge', module: pkg, file: frame.file, line: frame.line };
      }
      if (edgeFiles.has(frame.file)) return { owner: 'edge', module: frame.file, file: frame.file, line: frame.line };
      helper ??= frame; // a product helper: keep walking to see who called it
    }
    if (helper) return { owner: 'edge', module: helper.file, file: helper.file, line: helper.line };
    return { owner: 'node', module: 'http', file: null, line: null };
  };
  /** Who answered (wrote the status line): like originOf, but compression and its helpers carry, they do not decide. */
  const answererOf = (stackFrames) => originOf(stackFrames.filter((frame) => frame.node || !TRANSPORT.has(packageOf(frame.file))));

  // ------------------------------------------------------------ exchanges
  let sequence = 0;
  const tagged = new WeakSet();
  const exchangeOfRequest = new WeakMap();
  const exchangeOfResponse = new WeakMap();
  const requestsOnSocket = new WeakMap();
  const exchanges = new Map(); // seq -> exchange, until quiescent
  const als = new AsyncLocalStorage();
  const b64 = (buffers) => Buffer.concat(buffers).toString('base64');
  const toBuffer = (chunk, encoding) => {
    if (chunk === undefined || chunk === null) return null;
    if (Buffer.isBuffer(chunk)) return Buffer.from(chunk);
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    return null;
  };
  const blind = (exchange, kind, site) => {
    const mark = { kind, site };
    if (exchange.ended) emit({ type: 'blind', seq: exchange.seq, ...mark });
    if (exchange.blind.length < 32) exchange.blind.push(mark);
  };

  dc.subscribe('http.server.request.start', ({ request, response, socket, server }) => {
    if (setup.servers === 'tagged' && !tagged.has(server)) return;
    const index = (requestsOnSocket.get(socket) ?? 0) + 1;
    requestsOnSocket.set(socket, index);
    const exchange = {
      seq: ++sequence, startedAt: Date.now(), request, response,
      peer: { address: socket.remoteAddress ?? null, port: socket.remotePort ?? null, requestOnSocket: index },
      startUrl: request.url, rawBody: [], entry: null, ops: [], groupWrites: [], afterEnd: [], wire: [], head: null, answeredBy: null, tail: false,
      promiseSites: 0, groupEnded: false, edgeEffects: [], effects: [], pending: new Map(), declaredWork: [], transmissionWork: 0, poolWork: 0, unsampledPromises: 0,
      blind: [], crossed: [], ended: false, quiescent: false, waiters: [], aborted: false, owned: [],
    };
    exchangeOfRequest.set(request, exchange);
    exchangeOfResponse.set(response, exchange);
    ownEmitters.add(request); ownEmitters.add(response);
    exchanges.set(exchange.seq, exchange);
    emit({ type: 'exchange-start', seq: exchange.seq, startedAt: exchange.startedAt, peer: exchange.peer, method: request.method, url: request.url });
    // The rest of this request runs in the exchange's context (the channel is published synchronously
    // right before the server emits 'request'). Nothing is wrapped around the handlers.
    als.enterWith({ exchange });
  });
  dc.subscribe('http.server.response.finish', ({ response }) => {
    const exchange = exchangeOfResponse.get(response);
    if (exchange && !exchange.ended) finishExchange(exchange);
  });

  const IncomingMessage = http.IncomingMessage;
  const originalPush = IncomingMessage.prototype.push;
  IncomingMessage.prototype.push = named('push', (self, args) => {
    const exchange = exchangeOfRequest.get(self);
    if (exchange) { const bytes = toBuffer(args[0], args[1]); if (bytes) exchange.rawBody.push(bytes); }
    return callThrough(originalPush, self, args);
  }, originalPush.length);

  const ServerResponse = http.ServerResponse;
  // An aborted response: seen when the response emits 'close' unfinished (no listener is added).
  const originalResponseEmit = ServerResponse.prototype.emit;
  ServerResponse.prototype.emit = named('emit', (self, args) => {
    if (args[0] === 'close') {
      const exchange = exchangeOfResponse.get(self);
      if (exchange && !exchange.ended) { exchange.aborted = !self.writableFinished; finishExchange(exchange); }
    }
    return callThrough(originalResponseEmit, self, args);
  }, originalResponseEmit.length);
  let inWriteHead = 0;
  const record = (exchange, op, response) => {
    if (!exchange.entry || exchange.ended) return;
    let after = null;
    if (op.name && op.op !== 'status') { const value = response.getHeader(op.name); after = value === undefined ? null : Array.isArray(value) ? value.map(String) : String(value); }
    exchange.ops.push({ ...op, after, origin: originOf(captureFrames(32)) });
  };
  for (const name of ['setHeader', 'removeHeader', 'appendHeader']) {
    const original = ServerResponse.prototype[name];
    if (typeof original !== 'function') continue;
    ServerResponse.prototype[name] = named(name, (self, args) => {
      const exchange = exchangeOfResponse.get(self);
      const result = callThrough(original, self, args);
      if (exchange && !inWriteHead) record(exchange, { op: name, name: String(args[0]), ...(name === 'removeHeader' ? {} : { value: Array.isArray(args[1]) ? args[1].map(String) : String(args[1]) }) }, self);
      return result;
    }, original.length);
  }
  const originalWriteHead = ServerResponse.prototype.writeHead;
  ServerResponse.prototype.writeHead = named('writeHead', (self, args) => {
    const exchange = exchangeOfResponse.get(self);
    if (exchange && exchange.head === null && !exchange.answeredBy) {
      const stackFrames = captureFrames(32);
      exchange.answeredBy = exchange.tail ? { owner: 'tail', module: 'harness tail stand-in', file: null, line: null } : answererOf(stackFrames);
    }
    if (exchange && exchange.entry && !exchange.ended) {
      const headers = args.slice(1).find((value) => value && typeof value === 'object');
      const origin = answererOf(captureFrames(32));
      if (headers) {
        const pairs = Array.isArray(headers) ? [] : Object.entries(headers);
        if (Array.isArray(headers)) for (let i = 0; i + 1 < headers.length; i += 2) pairs.push([headers[i], headers[i + 1]]);
        for (const [headerName, value] of pairs) exchange.ops.push({ op: 'writeHead', name: String(headerName), value: Array.isArray(value) ? value.map(String) : String(value), after: Array.isArray(value) ? value.map(String) : String(value), origin });
      }
      exchange.ops.push({ op: 'status', value: Number(args[0]), origin });
    }
    inWriteHead += 1;
    let result;
    try { result = callThrough(originalWriteHead, self, args); } finally { inWriteHead -= 1; }
    // When the head was written (the Date header Node put in it is checked against this: the comparer's Date lag).
    if (exchange && exchange.head === null && typeof self._header === 'string') { exchange.head = self._header; exchange.headAt = Date.now(); }
    return result;
  }, originalWriteHead.length);
  for (const name of ['write', 'end']) {
    const original = ServerResponse.prototype[name];
    ServerResponse.prototype[name] = named(name, (self, args) => {
      const exchange = exchangeOfResponse.get(self);
      if (exchange && typeof args[0] !== 'function' && !self.writableEnded) { const bytes = toBuffer(args[0], args[1]); if (bytes) exchange.wire.push(bytes); }
      return callThrough(original, self, args);
    }, original.length);
  }

  // Resources created while the response is being written (compression's zlib
  // stream, the socket write, Node's Date-header timer) are the response's
  // transmission, not the group's work: counted, never pending.
  let transmitting = 0;
  const transmit = (action) => { transmitting += 1; try { return action(); } finally { transmitting -= 1; } };
  // The host's reading of the request's context at entry (group-host.mjs: the request-context store's
  // assignment, the peer, whether the principal's authorisation is live), with the product's own functions.
  let entryObserver = null;
  /** At the group's first handler: what the handler receives, and the group's own body writes from here on. */
  const enterExchange = (exchange, registration, req) => {
    if (exchange.entry || exchange.ended) return;
    const res = exchange.response;
    const principal = principalOf(req.principal);
    exchange.entry = {
      at: Date.now(), registration, method: req.method, url: req.url, originalUrl: req.originalUrl ?? null, baseUrl: req.baseUrl ?? null,
      httpVersion: req.httpVersion, headers: { ...req.headers }, rawHeaders: [...req.rawHeaders],
      // body-parser 2 leaves req.body undefined unless a parser read the body; readableEnded says the stream was consumed.
      bodyParsedByEdge: req.body !== undefined, bodyConsumedBeforeEntry: req.readableEnded === true,
      bodyBytesBeforeEntry: exchange.rawBody.reduce((sum, chunk) => sum + chunk.length, 0), complete: req.complete,
      principal, ip: safe(() => req.ip), ips: safe(() => [...(req.ips ?? [])]), socket: { localAddress: req.socket?.localAddress ?? null, localPort: req.socket?.localPort ?? null, remoteAddress: req.socket?.remoteAddress ?? null },
      edgeHeaders: Object.entries(res.getHeaders()).map(([headerName, value]) => [headerName, Array.isArray(value) ? value.map(String) : String(value)]),
      statusAtEntry: res.statusCode,
      context: entryObserver ? safe(() => JSON.parse(JSON.stringify(entryObserver(req)))) : null,
    };
    const instanceWrite = res.write;
    const instanceEnd = res.end;
    res.write = named('write', (self, args) => {
      if (typeof args[0] !== 'function') {
        const bytes = toBuffer(args[0], args[1]);
        if (bytes) (exchange.groupEnded ? exchange.afterEnd : exchange.groupWrites).push({ op: 'write', bytes, origin: originOf(captureFrames(32)) });
      }
      return transmit(() => callThrough(instanceWrite, self, args));
    }, instanceWrite.length);
    res.end = named('end', (self, args) => {
      const bytes = typeof args[0] === 'function' ? null : toBuffer(args[0], args[1]);
      // Bytes after the group's first end were never part of its body, whatever the stream does with them.
      if (exchange.groupEnded) exchange.afterEnd.push({ op: 'end', bytes, origin: originOf(captureFrames(32)) });
      else { exchange.groupEnded = true; if (bytes) exchange.groupWrites.push({ op: 'end', bytes, origin: originOf(captureFrames(32)) }); }
      return transmit(() => callThrough(instanceEnd, self, args));
    }, instanceEnd.length);
  };
  const safe = (action) => { try { return action(); } catch { return null; } };
  const principalOf = (principal) => {
    if (!principal || typeof principal !== 'object') return null;
    const out = {};
    for (const key of ['id', 'email', 'displayName', 'role', 'scope', 'status', 'policy', 'assignments', 'offlineGrace']) if (Object.hasOwn(principal, key)) out[key] = principal[key];
    try { return JSON.parse(JSON.stringify(out)); } catch { return { unserialisable: true }; }
  };

  // ------------------------------------------------------------ headers, per name and per element
  const LIST_HEADERS = new Set(['vary', 'cache-control', 'set-cookie']);
  const elementsOf = (key, value) => {
    if (value === null || value === undefined) return [];
    if (key === 'set-cookie') return (Array.isArray(value) ? value : [value]).map(String);
    return (Array.isArray(value) ? value.join(',') : String(value)).split(',').map((part) => part.trim()).filter(Boolean);
  };
  const sameElement = (key, left, right) => (key === 'vary' ? left.toLowerCase() === right.toLowerCase() : left === right);
  const ownerLabel = (origin) => ({ owner: origin.owner, module: origin.module ?? null });
  const headerSummary = (exchange, finalHeaders) => {
    const byName = new Map();
    const slot = (headerName) => {
      const key = headerName.toLowerCase();
      if (!byName.has(key)) byName.set(key, { name: headerName, key, lastOwner: null, group: null, elements: [] });
      return byName.get(key);
    };
    for (const [headerName, value] of exchange.entry?.edgeHeaders ?? []) {
      const entry = slot(headerName);
      entry.lastOwner = { owner: 'edge', module: 'before-entry' };
      entry.elements = elementsOf(entry.key, value).map((element) => ({ value: element, owner: entry.lastOwner }));
    }
    for (const op of exchange.ops) {
      if (!op.name) continue;
      const entry = slot(op.name);
      const owner = ownerLabel(op.origin);
      entry.lastOwner = op.op === 'removeHeader' ? null : owner;
      const now = elementsOf(entry.key, op.after);
      const kept = [];
      for (const element of now) {
        const previous = entry.elements.find((known) => sameElement(entry.key, known.value, element) && !kept.includes(known));
        // An element that was already there keeps who put it there; a new one is the writer's.
        kept.push(previous ?? { value: element, owner });
      }
      entry.elements = kept;
      if (owner.owner === 'group') entry.group = { value: op.after, op: op.op };
    }
    const out = [];
    const finalKeys = new Set();
    // A name written on several head lines (Set-Cookie) is one entry whose value is the list of lines.
    const merged = new Map();
    for (const [headerName, value] of finalHeaders) {
      const key = headerName.toLowerCase();
      if (!merged.has(key)) merged.set(key, [headerName, []]);
      merged.get(key)[1].push(...(Array.isArray(value) ? value : [value]));
    }
    for (const [headerName, values] of merged.values()) {
      const value = values.length === 1 ? values[0] : values;
      const key = headerName.toLowerCase();
      finalKeys.add(key);
      const entry = byName.get(key);
      const summary = { name: headerName, value, owner: !exchange.entry ? { owner: 'edge', module: 'no group handler ran' } : entry?.lastOwner ?? { owner: 'node', module: 'http' }, group: entry?.group ?? null };
      if (LIST_HEADERS.has(key)) {
        const known = entry?.elements ?? [];
        summary.elements = elementsOf(key, value).map((element) => known.find((item) => sameElement(key, item.value, element)) ?? { value: element, owner: summary.owner });
      }
      out.push(summary);
    }
    // Headers the group wrote that are not in the final head (removed later by the edge or by the group).
    for (const entry of byName.values()) if (!finalKeys.has(entry.key) && entry.group) out.push({ name: entry.name, value: null, owner: null, group: entry.group, ...(LIST_HEADERS.has(entry.key) ? { elements: [] } : {}) });
    return out;
  };

  // A stack frame line as printed raw (\n    at f (file:1:2)), in finalhandler's HTML error page (<br> &nbsp; &nbsp;at …), or escaped in JSON (\\n    at …).
  const STACK_IN_BODY = /(?:\n|\\n|<br\s*\/?>)(?:[ \t]|&nbsp;)*at [^\n<"]*?:\d+:\d+/;
  const finishExchange = (exchange) => {
    exchange.ended = true;
    exchange.endedAt = Date.now();
    const res = exchange.response;
    const finalHeaders = res.headersSent || typeof res.getHeaders !== 'function' ? parseHead(exchange.head) : Object.entries(res.getHeaders()).map(([headerName, value]) => [headerName, Array.isArray(value) ? value.map(String) : String(value)]);
    const writes = exchange.groupWrites;
    const body = Buffer.concat(writes.map((write) => write.bytes));
    const wire = Buffer.concat(exchange.wire);
    const entered = Boolean(exchange.entry);
    emit({
      type: 'exchange', seq: exchange.seq,
      kind: entered ? 'group' : exchange.tail ? 'tail' : 'edge', entered, tail: exchange.tail,
      answeredBy: exchange.answeredBy ?? (exchange.tail ? { owner: 'tail', module: 'harness tail stand-in', file: null, line: null } : null),
      startedAt: exchange.startedAt, endedAt: exchange.endedAt, aborted: exchange.aborted,
      peer: exchange.peer,
      request: {
        method: exchange.request.method, startUrl: exchange.startUrl, httpVersion: exchange.request.httpVersion, rawHeaders: [...exchange.request.rawHeaders],
        body: b64(exchange.rawBody), bodyComplete: exchange.request.complete === true,
      },
      entry: exchange.entry,
      response: {
        status: res.statusCode, head: exchange.head, headAt: exchange.headAt ?? null,
        headers: headerSummary(exchange, finalHeaders),
        ops: exchange.ops,
        body: body.toString('base64'),
        bodyOrigins: [...new Set(writes.map((write) => write.origin.owner))],
        afterEnd: exchange.afterEnd.map((write) => ({ op: write.op, bytes: write.bytes ? write.bytes.toString('base64') : null, origin: write.origin })),
        wire: wire.toString('base64'),
        // An error page printing a stack: its text depends on how the process composed its layers. Unrecordable.
        bodyHasStack: STACK_IN_BODY.test(body.toString('latin1')) || STACK_IN_BODY.test(wire.toString('latin1')),
      },
      effects: exchange.effects,
      edgeEffects: exchange.edgeEffects,
      pendingAtEnd: [...exchange.pending.values()],
      blind: exchange.blind,
      crossed: exchange.crossed,
      declaredWork: exchange.declaredWork,
      transmissionWork: exchange.transmissionWork,
      poolWork: exchange.poolWork,
      unsampledPromises: exchange.unsampledPromises,
    });
    // What was just written is the effects' state now; a later change is an effect-update.
    exchange.effects.forEach((effect, index) => placed(effect, { seq: exchange.seq, list: 'effects', index }));
    exchange.edgeEffects.forEach((effect, index) => placed(effect, { seq: exchange.seq, list: 'edgeEffects', index }));
    exchange.request = null;
    checkQuiescent(exchange);
  };
  const parseHead = (head) => {
    if (typeof head !== 'string') return [];
    return head.split('\r\n').slice(1).filter(Boolean).map((line) => { const at = line.indexOf(':'); return [line.slice(0, at), line.slice(at + 1).trim()]; });
  };

  // ------------------------------------------------------------ registration
  const requireFrom = createRequire(setup.expressFrom.endsWith(path.sep) ? setup.expressFrom : fs.statSync(setup.expressFrom).isDirectory() ? `${setup.expressFrom}${path.sep}` : setup.expressFrom);
  const expressPath = requireFrom.resolve('express');
  const Router = createRequire(expressPath)('router');
  const registrations = [];
  let window = null; // { name } while the group host runs the group's registrar
  const site = (stackFrames) => stackFrames.find((frame) => !frame.node && !packageOf(frame.file)) ?? null;
  const routerIds = new WeakMap();
  let routerCount = 0;
  const routerId = (router) => { if (!routerIds.has(router)) routerIds.set(router, ++routerCount); return routerIds.get(router); };
  const topRouters = new WeakSet();
  const routeRouter = new WeakMap();
  const claimed = new WeakSet();
  const noteRegistration = (entry, stackFrames, router, handlers) => {
    const fromGroupFile = stackFrames.some((frame) => !frame.node && isGroupFile(frame.file));
    const viaFactory = handlers.some((handler) => typeof handler === 'function' && claimed.has(handler));
    const group = fromGroupFile || viaFactory;
    const where = site(stackFrames);
    if (!group && where) edgeFiles.add(where.file);
    const registration = { ...entry, group, claimed: viaFactory && !fromGroupFile, file: where?.file ?? null, line: where?.line ?? null, inWindow: Boolean(window), router: router ? routerId(router) : null, top: Boolean(router && topRouters.has(router)) };
    registrations.push(registration);
    emit({ type: 'registration', ...registration });
    if (window && !group) problem(`a ${entry.kind} ${entry.method ?? ''} ${entry.path ?? ''} registered while the group's registrar ran was not attributed to the group (${registration.file}:${registration.line})`);
    if (!window && fromGroupFile && setup.servers === 'tagged') problem(`a ${entry.kind} ${entry.path ?? ''} was attributed to the group outside the group's registrar (${registration.file}:${registration.line})`);
    return registration;
  };
  // A group handler is a Proxy whose call goes straight to the handler (`apply: Reflect.apply` adds no
  // stack frame). The router reads a handler's `length` right before it calls it (Layer.handleRequest
  // calls a handler of arity 3 or less, Layer.handleError one of arity 4); that read, seen by the `get`
  // trap with the exchange's context current, is the group's entry.
  const LAYER_FILE = /[\\/]node_modules[\\/]router[\\/]lib[\\/]layer\.js:/;
  const noteDispatch = (entry, req) => {
    const exchange = als.getStore()?.exchange;
    if (!exchange || exchange.entry || exchange.ended) return;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 4;
    const holder = {};
    Error.captureStackTrace(holder, noteDispatch);
    Error.stackTraceLimit = limit;
    const caller = String(holder.stack).split('\n').slice(1).find((line) => !line.includes(SELF));
    if (!caller || !LAYER_FILE.test(caller)) return;
    const errorPath = /\bhandleError\b/.test(caller);
    if (errorPath ? entry.arity !== 4 : entry.arity > 3) return;
    enterExchange(exchange, { kind: entry.kind, method: entry.method ?? null, path: entry.path ?? null, file: entry.file, line: entry.line, errorHandler: errorPath, claimed: entry.claimed }, req ?? exchange.request);
  };
  const wrapHandler = (fn, registration) => {
    if (typeof fn !== 'function') return fn;
    const entry = { ...registration, arity: fn.length };
    return new Proxy(fn, {
      get(target, property) {
        if (property === 'length') noteDispatch(entry, null);
        return Reflect.get(target, property);
      },
      apply: Reflect.apply,
    });
  };
  const flattenAll = (values) => values.flat(Infinity);
  const Route = Router.Route;
  const originalRoute = Router.prototype.route;
  Router.prototype.route = named('route', (self, args) => {
    const route = callThrough(originalRoute, self, args);
    if (route && typeof route === 'object') routeRouter.set(route, self);
    return route;
  }, originalRoute.length);
  for (const method of [...Object.getOwnPropertyNames(Route.prototype)].filter((name) => !['constructor', '_handlesMethod', '_methods', 'dispatch'].includes(name))) {
    const original = Route.prototype[method];
    if (typeof original !== 'function') continue;
    Route.prototype[method] = named(method, (self, handlers) => {
      const stackFrames = captureFrames();
      const flat = flattenAll(handlers);
      const registration = noteRegistration({ kind: 'route', method: method.toUpperCase(), path: typeof self.path === 'string' ? self.path : String(self.path) }, stackFrames, routeRouter.get(self) ?? null, flat);
      if (!registration.group) return callThrough(original, self, handlers);
      return callThrough(original, self, flat.map((handler) => wrapHandler(handler, registration)));
    }, original.length);
  }
  const originalUse = Router.prototype.use;
  Router.prototype.use = named('use', (self, args) => {
    const handler = args[0];
    let offset = 0;
    if (typeof handler !== 'function') {
      let first = handler;
      while (Array.isArray(first) && first.length !== 0) first = first[0];
      if (typeof first !== 'function') offset = 1;
    }
    const mountPath = offset ? args[0] : '/';
    const stackFrames = captureFrames();
    const flat = flattenAll(args.slice(offset));
    const registration = noteRegistration({ kind: 'use', method: null, path: Array.isArray(mountPath) ? mountPath.map(String) : String(mountPath) }, stackFrames, self, flat);
    if (!registration.group) return callThrough(originalUse, self, args);
    return callThrough(originalUse, self, [...args.slice(0, offset), ...flat.map((fn) => wrapHandler(fn, registration))]);
  }, originalUse.length);
  const originalParam = Router.prototype.param;
  Router.prototype.param = named('param', (self, args) => {
    const registration = noteRegistration({ kind: 'param', method: null, path: String(args[0]) }, captureFrames(), self, [args[1]]);
    if (registration.group) throw new Error(`backend tap: a param() callback registered by a group file (${registration.file}:${registration.line}) cannot be classified`);
    return callThrough(originalParam, self, args);
  }, originalParam.length);

  // ------------------------------------------------------------ effects
  const currentExchange = () => ownerExchange(executionAsyncId()) ?? als.getStore()?.exchange ?? null;
  // ---- effect completion: an effect is written once with its exchange (or as a late or unattributed record);
  // what changes afterwards is written as an effect-update record naming where it was written.
  const effectPlace = new WeakMap(); // effect -> { seq, list, index | id }
  const effectWaits = new WeakMap(); // effect -> { exchange, key } while it keeps its exchange pending
  const dirtyEffects = new Set();
  let effectIds = 0;
  const describeEffect = (effect) => (effect.kind === 'child' ? `child ${effect.file}` : effect.kind === 'fetch' ? `fetch ${effect.method} ${effect.url}` : `http-request ${effect.method} ${effect.host ?? ''}:${effect.port ?? ''}${effect.path ?? ''}`);
  const placed = (effect, place) => { effectPlace.set(effect, place); dirtyEffects.delete(effect); };
  const changed = (effect) => { if (effectPlace.has(effect)) dirtyEffects.add(effect); };
  const flushEffect = (effect) => {
    if (!dirtyEffects.delete(effect)) return;
    let copy;
    try { copy = JSON.parse(JSON.stringify(effect)); } catch { copy = { unserialisable: true }; }
    emit({ type: 'effect-update', ...effectPlace.get(effect), effect: copy });
  };
  /** The effect has finished: its final fields, written at once if its record was already written. */
  const finishEffect = (effect, fields = {}) => {
    if (!effect || effect.finished !== false) return;
    Object.assign(effect, fields, { finished: true });
    changed(effect);
    flushEffect(effect);
    const waits = effectWaits.get(effect);
    if (waits) { effectWaits.delete(effect); if (waits.exchange.pending.delete(waits.key)) checkQuiescent(waits.exchange); }
  };
  /** `waits`: the tap sees how the effect ends (an exit, an answer, a failure), so it is pending work until then. */
  const addEffect = (effect, { waits = false } = {}) => {
    const exchange = currentExchange();
    if (!exchange) { const id = ++effectIds; emit({ type: 'unattributed', id, effect }); placed(effect, { seq: null, list: 'unattributed', id }); return; }
    if (typeof effect.finished === 'boolean') exchange.owned.push(effect);
    if (waits && !exchange.quiescent) { const key = `effect-${++effectIds}`; effectWaits.set(effect, { exchange, key }); exchange.pending.set(key, { type: 'EFFECT', site: describeEffect(effect) }); }
    if (!exchange.entry && !exchange.ended) { exchange.edgeEffects.push(effect); return; }
    if (exchange.ended) { const id = ++effectIds; emit({ type: 'late', seq: exchange.seq, id, phase: exchange.quiescent ? 'after-quiescent' : 'after-end', effect }); placed(effect, { seq: exchange.seq, list: 'late', id }); return; }
    exchange.effects.push(effect);
  };
  const pairsOf = (headers) => {
    if (Array.isArray(headers)) { const out = []; for (let i = 0; i + 1 < headers.length; i += 2) out.push([String(headers[i]), String(headers[i + 1])]); return out; }
    if (typeof headers === 'string') return headers.split('\r\n').filter(Boolean).map((line) => { const at = line.indexOf(':'); return [line.slice(0, at), line.slice(at + 1).trim()]; });
    if (headers && typeof headers === 'object') return Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.map(String) : String(value)]);
    return [];
  };
  const outbound = new WeakMap();
  dc.subscribe('undici:request:create', ({ request }) => {
    const effect = { kind: 'fetch', method: request.method, url: `${request.origin}${request.path}`, headers: pairsOf(request.headers), body: [], bodyEnded: false, response: null, error: null, finished: false };
    outbound.set(request, effect);
    addEffect(effect, { waits: true });
  });
  dc.subscribe('undici:request:bodyChunkSent', ({ request, chunk }) => {
    const effect = outbound.get(request);
    const bytes = toBuffer(chunk);
    if (effect && bytes) { effect.body.push(bytes.toString('base64')); changed(effect); }
  });
  dc.subscribe('undici:request:bodySent', ({ request }) => { const effect = outbound.get(request); if (effect) { effect.bodyEnded = true; changed(effect); } });
  dc.subscribe('undici:request:headers', ({ request, response }) => {
    const effect = outbound.get(request);
    if (effect) { effect.response = { status: response?.statusCode ?? null, headers: pairsOf(response?.headers) }; changed(effect); }
  });
  // The answer is complete (its trailers, possibly none), or the request failed.
  dc.subscribe('undici:request:trailers', ({ request }) => finishEffect(outbound.get(request)));
  dc.subscribe('undici:request:error', ({ request, error }) => finishEffect(outbound.get(request), { error: String(error?.code ?? error?.message ?? error) }));
  const clientRequests = new WeakMap();
  // The start channel is published when the request is sent, after the body writes that preceded it: bodies are kept per request.
  const clientBodies = new WeakMap();
  const clientBody = (request) => { if (!clientBodies.has(request)) clientBodies.set(request, []); return clientBodies.get(request); };
  const clientHeaders = (request) => safe(() => pairsOf(request.getRawHeaderNames().map((name) => [name, request.getHeader(name)]).flat())) ?? [];
  // The request is recorded when it is created (its body may be written long after), and its headers again when it is sent.
  const clientRequestSeen = ({ request }) => {
    if (clientRequests.has(request)) return;
    // The port the request names (its Host header); the socket may not be connected yet when the request starts.
    const hostHeader = safe(() => String(request.getHeader('host') ?? ''));
    const namedPort = /:(\d+)$/.exec(hostHeader ?? '')?.[1];
    const effect = { kind: 'http-request', method: request.method, host: request.host ?? null, port: namedPort ? Number(namedPort) : request.agent?.defaultPort ?? null, path: request.path ?? null,
      headers: clientHeaders(request), body: clientBody(request), bodyEnded: request.writableEnded === true, response: null, error: null, finished: false };
    clientRequests.set(request, effect);
    addEffect(effect, { waits: true });
  };
  dc.subscribe('http.client.request.created', clientRequestSeen);
  dc.subscribe('http.client.request.start', ({ request }) => {
    clientRequestSeen({ request });
    const effect = clientRequests.get(request);
    const headers = clientHeaders(request);
    if (JSON.stringify(headers) !== JSON.stringify(effect.headers)) { effect.headers = headers; changed(effect); }
  });
  dc.subscribe('http.client.response.finish', ({ request, response }) => {
    finishEffect(clientRequests.get(request), { response: { status: response?.statusCode ?? null, headers: pairsOf(response?.rawHeaders) } });
  });
  dc.subscribe('http.client.request.error', ({ request, error }) => finishEffect(clientRequests.get(request), { error: String(error?.code ?? error?.message ?? error) }));
  const ClientRequest = http.ClientRequest;
  for (const name of ['write', 'end']) {
    const original = ClientRequest.prototype[name];
    ClientRequest.prototype[name] = named(name, (self, args) => {
      if (typeof args[0] !== 'function') { const bytes = toBuffer(args[0], args[1]); if (bytes) clientBody(self).push(bytes.toString('base64')); }
      const effect = clientRequests.get(self);
      if (effect) { if (name === 'end') effect.bodyEnded = true; changed(effect); }
      return callThrough(original, self, args);
    }, original.length);
  }
  // A request closed without an answer or an error (destroyed) has finished too.
  const originalClientEmit = ClientRequest.prototype.emit;
  ClientRequest.prototype.emit = named('emit', (self, args) => {
    if (args[0] === 'close') finishEffect(clientRequests.get(self), { closedUnanswered: !clientRequests.get(self)?.response });
    return callThrough(originalClientEmit, self, args);
  }, originalClientEmit.length);
  // Children: environment changes as digests (values may be secrets), stdin bytes, the exit status.
  const digestOf = (value) => `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
  const envChange = (pairs) => {
    if (!pairs) return { inherited: true };
    const given = new Map(pairs.map((pair) => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)]; }));
    const set = {};
    for (const [key, value] of given) if (process.env[key] !== value) set[key] = digestOf(value);
    const unset = Object.keys(process.env).filter((key) => !given.has(key)).sort();
    return { inherited: false, set, unset };
  };
  const envPairsOf = (env) => (env && typeof env === 'object' ? Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`) : null);
  const STDIN_CAP = 64 * 1024;
  const stdinRecord = () => ({ bytes: [], length: 0, ended: false });
  const addStdin = (stdin, bytes) => { if (!bytes) return; stdin.length += bytes.length; const room = STDIN_CAP - stdin.bytes.reduce((sum, chunk) => sum + Buffer.from(chunk, 'base64').length, 0); if (room > 0) stdin.bytes.push(bytes.subarray(0, room).toString('base64')); };
  const ChildProcess = childProcess.ChildProcess;
  const originalSpawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = named('spawn', (self, args) => {
    const options = args[0];
    const effect = { kind: 'child', file: options?.file ?? null, args: Array.isArray(options?.args) ? options.args.map(String) : null, cwd: options?.cwd ? String(options.cwd) : null, sync: false,
      env: envChange(Array.isArray(options?.envPairs) ? options.envPairs : null), stdin: stdinRecord(), exit: null, finished: false };
    // Its exit is seen through the process handle's onexit, so it is pending work until then.
    addEffect(effect, { waits: true });
    let result;
    try { result = callThrough(originalSpawn, self, args); } catch (error) { finishEffect(effect, { error: String(error?.code ?? error?.message ?? error) }); throw error; }
    const stdin = self.stdin;
    if (stdin && typeof stdin.write === 'function') {
      for (const name of ['write', 'end']) {
        const original = stdin[name];
        stdin[name] = named(name, (stream, streamArgs) => {
          if (typeof streamArgs[0] !== 'function') addStdin(effect.stdin, toBuffer(streamArgs[0], streamArgs[1]));
          if (name === 'end') effect.stdin.ended = true;
          changed(effect);
          return callThrough(original, stream, streamArgs);
        });
      }
    }
    const handle = self._handle;
    if (handle && typeof handle.onexit === 'function') {
      const onexit = handle.onexit;
      handle.onexit = named('onexit', (target, exitArgs) => { finishEffect(effect, { exit: { code: exitArgs[0] ?? null, signal: exitArgs[1] || null } }); return callThrough(onexit, target, exitArgs); });
    } else {
      // No handle to watch: the exit cannot be seen; the exchange is marked unfinished-effect when it goes quiescent.
      const waits = effectWaits.get(effect);
      if (waits) { effectWaits.delete(effect); if (waits.exchange.pending.delete(waits.key)) checkQuiescent(waits.exchange); }
    }
    return result;
  }, originalSpawn.length);
  for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = named(name, (self, args) => {
      const [fileArg, second, third] = args;
      const argv = name !== 'execSync' && Array.isArray(second) ? second.map(String) : null;
      const options = (name === 'execSync' ? second : argv ? third : second) ?? {};
      const effect = { kind: 'child', file: String(fileArg), args: argv, cwd: options?.cwd ? String(options.cwd) : null, sync: true, via: name,
        env: envChange(envPairsOf(options?.env)), stdin: stdinRecord(), exit: null, finished: false };
      addStdin(effect.stdin, toBuffer(options?.input, options?.encoding));
      effect.stdin.ended = true;
      addEffect(effect);
      try {
        const result = callThrough(original, self, args);
        finishEffect(effect, { exit: name === 'spawnSync' ? { code: result?.status ?? null, signal: result?.signal ?? null } : { code: 0, signal: null } });
        return result;
      } catch (error) {
        finishEffect(effect, { exit: { code: error?.status ?? null, signal: error?.signal ?? null } });
        throw error;
      }
    }, original.length);
  }
  syncBuiltinESMExports();

  // ------------------------------------------------------------ emitters: foreign listeners and crossed effects
  // An emitter created while an exchange's context was current belongs to it; the request and
  // response belong to theirs. A listener that group or product code adds, while an exchange is in
  // its group phase, to an emitter of no exchange or of another one is foreign: the exchange is
  // marked blind (the tap cannot wait for it), and when that emitter later emits under another
  // exchange's context, that exchange is marked crossed.
  const emitterExchange = new WeakMap();
  const ownEmitters = new WeakSet();
  const originalInit = EventEmitter.init;
  EventEmitter.init = named('init', (self, args) => {
    const exchange = als.getStore()?.exchange;
    if (exchange) emitterExchange.set(self, exchange.seq);
    return callThrough(originalInit, self, args);
  }, originalInit.length);
  const listenerOwner = new WeakMap(); // listener -> seq that added it
  const hooked = new WeakSet();
  const hookEmit = (emitter) => {
    if (hooked.has(emitter)) return;
    hooked.add(emitter);
    const original = emitter.emit;
    Object.defineProperty(emitter, 'emit', { configurable: true, writable: true, enumerable: false, value: named('emit', (self, args) => {
      const current = currentExchange();
      for (const listener of self.rawListeners(args[0])) {
        const from = listenerOwner.get(listener) ?? listenerOwner.get(listener?.listener);
        if (from !== undefined && current && current.seq !== from && !current.crossed.some((entry) => entry.from === from && entry.event === String(args[0]))) {
          current.crossed.push({ from, event: String(args[0]) });
          if (current.ended) emit({ type: 'blind', seq: current.seq, kind: 'crossed', site: `listener of exchange ${from} on '${String(args[0])}'` });
        }
      }
      return callThrough(original, self, args);
    }, original.length) });
  };
  // once() and prependOnceListener() go through on() and prependListener().
  for (const name of ['addListener', 'prependListener']) {
    const original = EventEmitter.prototype[name];
    const replacement = named(name, (self, args) => {
      const exchange = als.getStore()?.exchange;
      if (exchange && exchange.entry && !exchange.ended && typeof args[1] === 'function' && !ownEmitters.has(self) && emitterExchange.get(self) !== exchange.seq) {
        const stackFrames = captureFrames(16);
        const code = codeFrame(stackFrames);
        if (code) {
          listenerOwner.set(args[1], exchange.seq);
          blind(exchange, 'foreign-listener', `${code.file}:${code.line} on '${String(args[0])}'`);
          hookEmit(self);
        }
      }
      return callThrough(original, self, args);
    }, original.length);
    EventEmitter.prototype[name] = replacement;
    if (name === 'addListener') EventEmitter.prototype.on = replacement;
  }

  // ------------------------------------------------------------ quiescence
  const owners = new Map(); // asyncId -> { exchange, declared, transmission, pool }
  const codeTimers = new Map(); // asyncId -> { seq, site } of a Timeout product or group code started under an exchange
  const POOL_FRAME = /^node:(?:internal\/deps\/undici\/|_http_agent$)/;
  const IO_TYPES = new Set(['Timeout', 'Immediate', 'PROMISE', 'TickObject', 'Microtask']);
  const CLOSED_BY_CALL = new Set(['ZLIB', 'BROTLIENCODER', 'BROTLIDECODER', 'ZSTDCOMPRESS', 'ZSTDDECOMPRESS']);
  const ownerExchange = (asyncId) => owners.get(asyncId)?.exchange ?? null;
  const declaredSite = (stackFrames) => declared.find((entry) => stackFrames.some((frame) => frame.file === entry.file && (entry.line === null || entry.line === undefined || frame.line === entry.line))) ?? null;
  const PROMISE_SITES = 256;
  const hook = createHook({
    init(asyncId, type, _trigger, resource) {
      const parent = owners.get(executionAsyncId());
      // Work is the group's when the group's handlers created it (between entry and the response's end),
      // or when work the group owns created it (at any time).
      const stored = als.getStore()?.exchange;
      const exchange = parent?.exchange ?? (stored && stored.entry && !stored.ended ? stored : null);
      if (!exchange) return;
      // A JavaScript AsyncResource (AsyncResource.bind, as raw-body uses) is a context, destroyed only by
      // garbage collection: the work it binds runs through native resources, which are counted. One that
      // product or group code creates may carry work to a queue the tap cannot see: a blind mark.
      // Node's own queueMicrotask resource is an AsyncResource that emits its destroy once the callback ran: ordinary work.
      if (resource instanceof AsyncResource && type !== 'Microtask') {
        owners.set(asyncId, { exchange, declared: parent?.declared ?? null, transmission: parent?.transmission ?? false });
        if (!parent?.declared) { const code = codeFrame(captureFrames(16)); if (code) blind(exchange, 'async-resource', `${code.file}:${code.line}`); }
        return;
      }
      if (parent?.pool) { owners.set(asyncId, { exchange, declared: null, transmission: false, pool: true }); exchange.poolWork += 1; return; }
      if (transmitting > 0) { owners.set(asyncId, { exchange, declared: null, transmission: true }); exchange.transmissionWork += 1; return; }
      if (parent?.transmission) {
        // Work a response callback (finish, close, a write callback) starts: Node's own (no product frame)
        // is transmission; product or group code's is not waited for and marks the exchange blind.
        owners.set(asyncId, { exchange, declared: null, transmission: true });
        exchange.transmissionWork += 1;
        if (IO_TYPES.has(type)) { const code = codeFrame(captureFrames(16)); if (code) blind(exchange, 'response-callback', `${type} at ${code.file}:${code.line}`); }
        return;
      }
      let declaredBy = parent?.declared ?? null;
      let where = null;
      const sample = type !== 'PROMISE' || exchange.promiseSites++ < PROMISE_SITES;
      if (!declaredBy && (declared.length || sample)) {
        const stackFrames = captureFrames(type === 'PROMISE' ? 24 : 48);
        declaredBy = declared.length ? declaredSite(stackFrames) : null;
        where = siteOf(stackFrames);
        // A pooled outbound connection (undici's or an http.Agent's socket and its keep-alive timer) outlives the
        // request that opened it; the request itself is pending through its promise. Counted, never pending.
        if (type !== 'PROMISE' && stackFrames.some((frame) => POOL_FRAME.test(frame.file)) && (!stackFrames.find((frame) => !frame.node) || /^(?:TCPWRAP|TCPCONNECTWRAP|Timeout|TIMERWRAP|GETADDRINFOREQWRAP|PIPEWRAP)$/.test(type))) {
          owners.set(asyncId, { exchange, declared: null, transmission: false, pool: true });
          exchange.poolWork += 1;
          return;
        }
      } else if (type === 'PROMISE') exchange.unsampledPromises += 1;
      owners.set(asyncId, { exchange, declared: declaredBy });
      // A timer product or group code started: when it fires, a later exchange that entered the group meanwhile may ride on it.
      if (type === 'Timeout' && !declaredBy && where) { const code = codeFrame(captureFrames(16)); if (code) codeTimers.set(asyncId, { seq: exchange.seq, site: `${code.file}:${code.line}` }); }
      // A compression handle (zlib.gzip and friends) is destroyed only at garbage collection, long after its stream
      // closed it: its close ends the work.
      if (CLOSED_BY_CALL.has(type) && typeof resource?.close === 'function') {
        const close = resource.close;
        try { Object.defineProperty(resource, 'close', { configurable: true, writable: true, enumerable: false, value: named('close', (self, args) => { try { return callThrough(close, self, args); } finally { settle(asyncId); } }, close.length) }); } catch { /* a frozen handle stays pending until destroyed */ }
      }
      if (declaredBy) { if (exchange.declaredWork.length < 64) exchange.declaredWork.push({ type, reason: declaredBy.reason }); return; }
      if (exchange.quiescent) { emit({ type: 'late', seq: exchange.seq, phase: 'after-quiescent', effect: { kind: 'work', resource: type, site: where } }); }
      exchange.pending.set(asyncId, { type, site: where });
    },
    before(asyncId) { const timer = codeTimers.get(asyncId); if (timer) crossLater(timer); },
    promiseResolve(asyncId) { settle(asyncId); },
    destroy(asyncId) { settle(asyncId); owners.delete(asyncId); codeTimers.delete(asyncId); },
  });
  /** Every exchange after the timer's own that has entered the group is marked crossed by it (once per exchange). */
  function crossLater(timer) {
    for (let seq = timer.seq + 1; seq <= sequence; seq += 1) {
      const live = exchanges.get(seq);
      const done = live ? null : retired.get(seq);
      if (!(live ? live.entry : done?.entered)) continue;
      const crossed = live ? live.crossed : done.crossed;
      if (crossed.some((entry) => entry.from === timer.seq && entry.event === 'timer')) continue;
      crossed.push({ from: timer.seq, event: 'timer', site: timer.site });
      if (!live || live.ended) emit({ type: 'blind', seq, kind: 'crossed', site: `a timer of exchange ${timer.seq} at ${timer.site} fired after this exchange entered the group` });
    }
  }
  const settle = (asyncId) => {
    const owner = owners.get(asyncId);
    if (!owner) return;
    if (owner.exchange.pending.delete(asyncId)) checkQuiescent(owner.exchange);
  };
  const flushExchange = (exchange) => { for (const effect of exchange.owned) flushEffect(effect); };
  const checkQuiescent = (exchange) => {
    if (!exchange.ended || exchange.quiescent || exchange.pending.size) return;
    // Every effect's last state is written before the exchange is called quiescent; one whose end the tap could not see is marked.
    flushExchange(exchange);
    for (const effect of exchange.owned) if (effect.finished === false) blind(exchange, 'unfinished-effect', describeEffect(effect));
    exchange.quiescent = true;
    emit({ type: 'quiescent', seq: exchange.seq, blind: exchange.blind, crossed: exchange.crossed });
    exchanges.delete(exchange.seq);
    retired.set(exchange.seq, { blind: exchange.blind, crossed: exchange.crossed, entered: Boolean(exchange.entry) });
    exchange.owned = [];
    for (const resolve of exchange.waiters.splice(0)) resolve({ seq: exchange.seq, quiescent: true, pending: [], blind: exchange.blind, crossed: exchange.crossed });
  };
  const retired = new Map();
  hook.enable();

  return {
    armed: true,
    file,
    setup,
    /** Only tagged servers are observed (servers: "tagged"). */
    tagServer(server) { tagged.add(server); },
    /** The host's app router: its registrations are top-level layers. */
    markTopRouter(router) { topRouters.add(router); },
    /** A handler made by a group handler factory: registered by any code, it is the group's. */
    claimHandler(fn) { if (typeof fn === 'function') claimed.add(fn); return fn; },
    /** The tail stand-in answers this request. */
    markTail(req) { const exchange = exchangeOfRequest.get(req); if (exchange) exchange.tail = true; },
    /** What the host composed (written once, before serving). */
    recordHost(info) { emit({ type: 'host', ...info }); },
    /** A take of the group's block coverage (group-host.mjs --coverage): `{ phase, seq, files }`. */
    recordCoverage(take) { emit({ type: 'coverage', ...take }); },
    /** How late the host's timer aimed at a second boundary fired, when it was the latest so far (group-host.mjs): `{ dateLagMs, at }`. */
    recordClock(entry) { emit({ type: 'clock', ...entry }); },
    /** A hub publication by the group, through the recorder the group host injects. */
    recordHub(channel, payload) {
      let copy;
      try { copy = JSON.parse(JSON.stringify(payload)); } catch { copy = { unserialisable: String(payload) }; }
      addEffect({ kind: 'hub', channel: String(channel), payload: copy });
    },
    /** Resolves when exchange `seq` has ended and nothing it started is pending. Never times out: the host bounds it. */
    whenQuiescent(seq) {
      if (!Number.isInteger(seq) || seq < 1 || seq > sequence) return Promise.reject(new RangeError(`no exchange ${seq}`));
      const exchange = exchanges.get(seq);
      if (!exchange) { const done = retired.get(seq) ?? { blind: [], crossed: [] }; return Promise.resolve({ seq, quiescent: true, pending: [], ...done }); }
      return new Promise((resolve) => { exchange.waiters.push(resolve); });
    },
    /** Writes the changed state of exchange `seq`'s effects now (when /quiescent gives up on it). */
    flushOf(seq) { const exchange = exchanges.get(seq); if (exchange) flushExchange(exchange); },
    /** Writes the changed state of every effect (when the host stops). */
    flushAll() { for (const effect of [...dirtyEffects]) flushEffect(effect); },
    /** What exchange `seq` still has pending (empty once quiescent). */
    pendingOf(seq) { return [...(exchanges.get(seq)?.pending.values() ?? [])]; },
    /** The blind and crossed marks of exchange `seq`. */
    blindOf(seq) { const exchange = exchanges.get(seq); return exchange ? { blind: exchange.blind, crossed: exchange.crossed } : retired.get(seq) ?? { blind: [], crossed: [] }; },
    lastSeq: () => sequence,
    registrations: () => registrations.map((entry) => ({ ...entry })),
    problems: () => [...problems],
    /** `observer(req)` is called at the group's entry; what it returns is the entry's `context` (the scenario driver's envelope check). */
    observeEntry(observer) { entryObserver = typeof observer === 'function' ? observer : null; },
    beginGroupRegistration(name) { window = { name }; },
    endGroupRegistration() { window = null; },
  };
}

const setup = readSetup();
export const tap = globalThis[TAP_KEY] ?? (globalThis[TAP_KEY] = setup ? arm(setup) : inert);
