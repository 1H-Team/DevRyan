#!/usr/bin/env node
// The JavaScript candidate adapter, J (BH4; design file 31 §5.1, §5.5): the
// group's own registrar behind the candidate protocol (§5.2), in a process of
// its own on a data root of its own, given only what a candidate is given:
// the starting tree (its data root), the request, and the principal envelope.
// It is the closure check's proof that a correct standalone implementation,
// seen from outside, equals what the reference's tap saw inside.
//
//   node scripts/backend-conformance/js-candidate.mjs --group <name> --listen 127.0.0.1:0 --control 127.0.0.1:0
//       --data-root <dir> --home <dir> [--stub name=URL ...] [--handlers <dir>] [--compose <file.mjs>]
// `--handlers` loads the group's registrar from <dir>/<the registrar's file name> instead of the
// repository (a copy, for planted differences); `--compose` replaces what J composes before the
// registrar with the `compose(parts)` export of <file.mjs> (planted differences in J's own layers: it
// gets { app, express, registerCommonRequestMiddleware, runWithRequestPrincipal, envelopeOf,
// envelopeLayer }); everything else is the same. The stubs are handed to the group's dependencies.
// It prints one line `{"ready":{"listen":port,"control":port}}`. Control: GET /quiescent?seq=n, POST /stop.
// It stops on POST /stop, SIGTERM, SIGINT and the end of its stdin (its launcher gone).
//
// What J composes besides the registrar, and why (no other edge layer):
//   - Express itself, as the server resolves it (the group's handlers are Express handlers); with
//     `x-powered-by` off (that header is the edge's, never the group's).
//   - The product's request decoding (registerCommonRequestMiddleware: the shared JSON parser with the
//     path's limit and the URL-encoded parser). The protocol gives a candidate the raw body; turning it
//     into req.body as the group receives it is part of what any candidate must do.
//   - The envelope (design §6): `principal` becomes req.principal and, with `assignment`, the
//     request-context store (the product's runWithRequestPrincipal), around the group's handlers. The
//     envelope and sequence headers are removed before the group can read headers.
// Envelope fields J does not use: `peer` (no layer of J reads it), `authorizationActive` (J has no
// live authorisation check to bind), `originalUrl` (J serves the URL it is sent, which is the URL the
// group saw; the driver confirms the two against the tap). `v` must be 1 and `seq` must equal the
// sequence header, or J answers 400 with a harness error (visible to the comparer as a difference).
//
// Quiescence: every async resource of the runtime's own kinds (WORK: file system requests, timers,
// immediates, ticks, sockets, writes, children) created while one request's handlers run (its own
// AsyncResource scope) is that request's work until destroyed; promises and JavaScript AsyncResources
// carry the attribution but are not counted (a context is not work). A ZLIB handle is not counted
// either: it is destroyed only when garbage collection takes it, and a request body it inflates has ended
// before the response (the shared parser reads it to its end first). An exchange is quiescent once its response has finished and none
// of its work is pending. The driver never takes the claim on trust (its next-step check).
import { AsyncResource, createHook, executionAsyncId } from 'node:async_hooks';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT, SERVER_ROOT, importFromServer } from './edge.mjs';
import { GROUPS } from './groups.mjs';

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : null; };
const fail = (text) => { process.stderr.write(`js candidate: ${text}\n`); process.exit(64); };
const groupName = option('group');
const dataRoot = option('data-root');
const handlers = option('handlers');
const composeFile = option('compose');
const stubs = {};
for (let index = 0; index < args.length; index += 1) if (args[index] === '--stub') { const [name, ...url] = String(args[index + 1] ?? '').split('='); stubs[name] = url.join('='); }
const group = GROUPS[groupName] ?? null;
if (!group) fail(`unknown group ${groupName}`);
if (!dataRoot || !path.isAbsolute(dataRoot) || !fs.statSync(dataRoot, { throwIfNoEntry: false })?.isDirectory()) fail('--data-root must be an existing absolute directory');
const QUIESCENT_MS = 30_000;
const ENVELOPE = 'x-devryan-harness-envelope';
const SEQ = 'x-devryan-harness-seq';

// ------------------------------------------------------------------ quiescence
const WORK = new Set(['FSREQCALLBACK', 'FSREQPROMISE', 'FILEHANDLECLOSEREQ', 'STATWATCHER', 'FSEVENTWRAP', 'GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP', 'QUERYWRAP', 'HTTPCLIENTREQUEST', 'TCPCONNECTWRAP', 'PIPECONNECTWRAP', 'TCPWRAP', 'PIPEWRAP', 'PROCESSWRAP', 'SHUTDOWNWRAP', 'WRITEWRAP', 'UDPSENDWRAP', 'PBKDF2REQUEST', 'RANDOMBYTESREQUEST', 'SCRYPTREQUEST', 'TLSWRAP', 'WORKER', 'Timeout', 'Immediate', 'TickObject', 'Microtask']);
const owners = new Map(); // asyncId -> exchange
const exchanges = new Map(); // seq -> { seq, pending: Set, finished, waiters }
const settle = (exchange) => { if (exchange.finished && exchange.pending.size === 0) for (const waiter of exchange.waiters.splice(0)) waiter(); };
createHook({
  init(asyncId, type, triggerAsyncId) {
    const exchange = owners.get(executionAsyncId()) ?? owners.get(triggerAsyncId);
    if (!exchange) return;
    owners.set(asyncId, exchange);
    // Only the runtime's own kinds of work are pending; a promise or a JavaScript AsyncResource (a bound
    // callback of a library) carries the attribution but is a context, not work.
    if (WORK.has(type)) exchange.pending.set(asyncId, type);
  },
  destroy(asyncId) {
    const exchange = owners.get(asyncId);
    if (!exchange) return;
    owners.delete(asyncId);
    if (exchange.pending.delete(asyncId)) settle(exchange);
  },
}).enable();

// ------------------------------------------------------------------ the group
const express = await importFromServer('express');
const { registerCommonRequestMiddleware } = await import(pathToFileURL(path.join(SERVER_ROOT, 'lib/opencode/core-routes.js')).href);
const { runWithRequestPrincipal } = await import(pathToFileURL(path.join(SERVER_ROOT, 'lib/multi-user/request-context.js')).href);
const registrarFile = handlers ? path.join(path.resolve(handlers), path.basename(group.registrar.module)) : path.join(REPOSITORY_ROOT, group.registrar.module);
const register = (await import(pathToFileURL(registrarFile).href))[group.registrar.export];
if (typeof register !== 'function') fail(`${registrarFile} exports no ${group.registrar.export}`);

const app = express();
const envelopeOf = (req) => { try { return JSON.parse(Buffer.from(String(req.harnessEnvelope ?? ''), 'base64').toString('utf8')); } catch { return null; } };
// The envelope, as the edge would leave it on the request (design §6).
const envelopeLayer = (req, res, next) => {
  const envelope = envelopeOf(req);
  if (!envelope || envelope.v !== 1 || envelope.seq !== req.harnessSeq) {
    res.status(400).json({ error: `harness: the envelope is missing, not version 1, or names another exchange (seq ${req.harnessSeq})` });
    return;
  }
  req.principal = envelope.principal;
  runWithRequestPrincipal(envelope.principal, () => next(), { assignment: envelope.assignment ?? null });
};
if (composeFile) {
  const { compose } = await import(pathToFileURL(path.resolve(composeFile)).href);
  if (typeof compose !== 'function') fail(`${composeFile} exports no compose`);
  await compose({ app, express, registerCommonRequestMiddleware, runWithRequestPrincipal, envelopeOf, envelopeLayer });
} else {
  app.disable('x-powered-by');
  registerCommonRequestMiddleware(app, { express });
  app.use(envelopeLayer);
}
register(app, group.dependencies({ dataRoot, stubs }));

const listen = http.createServer((req, res) => {
  const seq = Number(req.headers[SEQ]);
  // The harness's headers leave the request before anything of the group can read them.
  req.harnessEnvelope = req.headers[ENVELOPE];
  req.harnessSeq = seq;
  delete req.headers[ENVELOPE];
  delete req.headers[SEQ];
  for (let index = req.rawHeaders.length - 2; index >= 0; index -= 2) if ([ENVELOPE, SEQ].includes(req.rawHeaders[index].toLowerCase())) req.rawHeaders.splice(index, 2);
  const exchange = { seq, pending: new Map(), finished: false, waiters: [] };
  if (Number.isInteger(seq)) exchanges.set(seq, exchange);
  const done = () => { exchange.finished = true; settle(exchange); };
  res.once('finish', done);
  res.once('close', done);
  const scope = new AsyncResource('DEVRYAN_JS_CANDIDATE_REQUEST');
  owners.set(scope.asyncId(), exchange);
  scope.runInAsyncScope(() => app(req, res));
});

const answer = (res, status, body) => { const bytes = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Connection: 'close' }); res.end(bytes); };
const control = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/quiescent') {
    const seq = Number(url.searchParams.get('seq'));
    const started = Date.now();
    const check = () => {
      const exchange = exchanges.get(seq);
      if (exchange?.finished && exchange.pending.size === 0) { answer(res, 200, { seq, quiescent: true, pending: [] }); return; }
      if (Date.now() - started >= QUIESCENT_MS) { answer(res, 200, { seq, quiescent: false, pending: exchange ? [...exchange.pending.values()].map((type) => ({ type, site: 'js candidate' })) : [{ type: 'unknown-exchange', site: `no exchange ${seq}` }] }); return; }
      if (exchange) { const timer = setTimeout(check, QUIESCENT_MS); exchange.waiters.push(() => { clearTimeout(timer); check(); }); } else setTimeout(check, 20);
    };
    check();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/stop') { answer(res, 200, { stopping: true }); res.on('finish', () => process.exit(0)); return; }
  answer(res, 404, { error: 'no route' });
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0));
process.stdin.on('end', () => process.exit(0)).resume();
const [listenHost, listenPort] = (option('listen') ?? '127.0.0.1:0').split(':');
const [controlHost, controlPort] = (option('control') ?? '127.0.0.1:0').split(':');
await new Promise((resolve) => { listen.listen(Number(listenPort), listenHost, resolve); });
await new Promise((resolve) => { control.listen(Number(controlPort), controlHost, resolve); });
process.stdout.write(`${JSON.stringify({ ready: { listen: listen.address().port, control: control.address().port } })}\n`);
