#!/usr/bin/env node
// A fake candidate (BH2 self-test only): speaks the candidate protocol (design
// file 31 §5.2) over a toy store, logs every call it receives, and can be told
// to misbehave, so the driver's checks can be shown to catch each misbehaviour.
//
//   node toy/fake-candidate.mjs --listen 127.0.0.1:0 --control 127.0.0.1:0 --data-root <dir> --home <dir>
//       [--stub name=URL ...]   (accepted and logged)
// Environment (the arm launcher passes the harness's environment through):
//   FAKE_CANDIDATE_LOG=<file>          every call, one JSON line each (appended; one file across restarts)
//   FAKE_CANDIDATE_MISBEHAVE=<a,b>     early-quiescent  a PUT answers and claims quiescence first; it writes when its
//                                                    claim is asked a second time (before that answer)
//                                      late-listen      the same, but it writes when the next listen connection comes
//                                      late-request     the same, but it writes when the next request arrives (the
//                                                    driver cannot tell this from that request's own write)
//                                      exit-after-put   a PUT answers in full, then the process exits
//                                      flush-on-term    a PUT answers first and writes later (at the next request);
//                                                    SIGTERM writes what is pending, then exits (SIGKILL loses it)
//                                      escape           a quiet child in a session of its own (it left the group)
//                                      wrong-seq        /quiescent?seq=n answers seq n+1
//                                      never-quiescent  /quiescent never answers
//                                      claims-busy      /quiescent answers quiescent: false
//                                      leak-descriptor  a PUT keeps the written file open
//                                      survive-restart  a process of the group that outlives the candidate
//                                      ignore-stop      /stop and SIGTERM are ignored
//                                      crash-on-put     a PUT ends the process before it answers
//                                      write-at-exit    /stop writes a file, then exits
//                                      trailing-bytes   a GET of a file sends bytes past its Content-Length
// Routes: GET/PUT/DELETE /f/<name> (a file of the data root), GET /sse?n=<k>[&end=1][&extra=<j>][&cut=1]
// (k items, j more right after, then the end when asked, or the connection destroyed without the
// terminating chunk), GET /hang (never answered).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : null; };
const dataRoot = option('data-root');
const misbehave = new Set((process.env.FAKE_CANDIDATE_MISBEHAVE ?? '').split(',').filter(Boolean));
const logFile = process.env.FAKE_CANDIDATE_LOG ?? null;
const log = (entry) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
// Deferred writes, each with when it runs: 'second-ask' (its seq asked again), 'listen-connection', 'request', 'term'.
const deferred = [];
const leaked = [];
const asked = new Map();
const runDeferred = (when, seq = null) => { for (const item of deferred.filter((entry) => entry.when === when && (seq === null || entry.seq === seq))) { deferred.splice(deferred.indexOf(item), 1); item.action(); } };
const deferral = () => (misbehave.has('early-quiescent') ? 'second-ask' : misbehave.has('late-listen') ? 'listen-connection' : misbehave.has('late-request') ? 'request' : misbehave.has('flush-on-term') ? 'request' : null);
const fileOf = (name) => path.join(dataRoot, name.replace(/[^a-z0-9._-]/gi, '_'));
log({ event: 'start', args });

const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => resolve(Buffer.concat(chunks))); });
const answer = (res, status, body, type = 'application/json') => { const bytes = Buffer.from(body); res.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length }); res.end(bytes); };

const listen = http.createServer(async (req, res) => {
  log({ server: 'listen', method: req.method, url: req.url, headers: req.rawHeaders });
  runDeferred('request');
  const url = new URL(req.url, 'http://127.0.0.1');
  const file = url.pathname.startsWith('/f/') ? fileOf(url.pathname.slice(3)) : null;
  if (file && req.method === 'GET') {
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { answer(res, 404, '{"error":"missing"}'); return; }
    if (misbehave.has('trailing-bytes')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }); res.end(Buffer.concat([bytes, Buffer.from('trailing')])); return; }
    answer(res, 200, bytes, 'application/octet-stream');
    return;
  }
  if (file && req.method === 'PUT') {
    const body = await readBody(req);
    if (misbehave.has('crash-on-put')) process.exit(3);
    const write = () => { fs.writeFileSync(file, body); if (misbehave.has('leak-descriptor')) leaked.push(fs.openSync(file, 'r')); };
    const when = deferral();
    if (when) deferred.push({ when, seq: Number(req.headers['x-devryan-harness-seq']), action: write }); else write();
    answer(res, 200, JSON.stringify({ written: body.length }));
    if (misbehave.has('exit-after-put')) res.on('finish', () => process.exit(0));
    return;
  }
  if (file && req.method === 'DELETE') { fs.rmSync(file, { force: true }); answer(res, 200, '{"deleted":true}'); return; }
  if (url.pathname === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const count = Number(url.searchParams.get('n') ?? 1) + Number(url.searchParams.get('extra') ?? 0);
    // Cut off: the connection ended once the last item is on the socket, without the terminating chunk.
    const cut = url.searchParams.get('cut') === '1';
    for (let index = 0; index < count; index += 1) res.write(`data: ${index}\n\n`, cut && index === count - 1 ? () => res.socket.end() : undefined);
    if (url.searchParams.get('end') === '1') res.end();
    return;
  }
  if (url.pathname === '/hang') return; // never answered
  answer(res, 404, '{"error":"no route"}');
});

const control = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  log({ server: 'control', method: req.method, url: req.url });
  if (req.method === 'GET' && url.pathname === '/quiescent') {
    if (misbehave.has('never-quiescent')) return;
    const seq = Number(url.searchParams.get('seq'));
    asked.set(seq, (asked.get(seq) ?? 0) + 1);
    if (asked.get(seq) === 2) runDeferred('second-ask', seq);
    answer(res, 200, JSON.stringify({ seq: misbehave.has('wrong-seq') ? seq + 1 : seq, quiescent: !misbehave.has('claims-busy'), ...(misbehave.has('claims-busy') ? { pending: [{ type: 'fake', site: 'busy' }] } : {}) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/stop') {
    if (misbehave.has('ignore-stop')) { answer(res, 200, '{"stopping":false}'); return; }
    answer(res, 200, '{"stopping":true}');
    if (misbehave.has('write-at-exit')) fs.writeFileSync(fileOf('at-exit'), 'late');
    res.on('finish', () => { for (const fd of leaked) fs.closeSync(fd); process.exit(0); });
    return;
  }
  answer(res, 404, '{"error":"no route"}');
});
// The next listen connection runs what was deferred to it.
listen.on('connection', () => runDeferred('listen-connection'));

if (misbehave.has('ignore-stop')) process.on('SIGTERM', () => { log({ event: 'SIGTERM ignored' }); });
// A graceful end writes what is pending; SIGKILL cannot.
if (misbehave.has('flush-on-term')) process.on('SIGTERM', () => { for (const item of deferred.splice(0)) item.action(); process.exit(0); });
if (misbehave.has('escape')) {
  // Quiet: it writes nothing, so only the process-tree walk can see it.
  const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e8);', 'fake-candidate-escapee'], { stdio: 'ignore', detached: true });
  escaped.unref();
  log({ event: 'escaped', pid: escaped.pid });
}
if (misbehave.has('survive-restart')) {
  // Same process group, no pipes to the launcher, and deaf to SIGTERM: it outlives the candidate.
  const survivor = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e8);"], { stdio: 'ignore' });
  survivor.unref();
  log({ event: 'survivor', pid: survivor.pid });
}
// The launcher gone (its pipe to stdin ended): stop, as any candidate should.
process.stdin.on('end', () => process.exit(0)).resume();

await new Promise((resolve) => { listen.listen(0, '127.0.0.1', resolve); });
await new Promise((resolve) => { control.listen(0, '127.0.0.1', resolve); });
process.stdout.write(`${JSON.stringify({ ready: { listen: listen.address().port, control: control.address().port } })}\n`);
