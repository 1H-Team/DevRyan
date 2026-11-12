#!/usr/bin/env node
// The Rust front's real-server lane (packages/native/DOCUMENTATION.md, "Real-server lane").
// On one private QA profile with the deterministic loopback model it:
//   1. starts `devryan serve --foreground` under `devryan-front serve --spawn`, inside the
//      test isolation guard's private environment (createTestIsolation);
//   2. sends a fixed set of requests through the front and, the same bytes, directly to the
//      server: health, a static asset, the owner enrolment page, the first events of the
//      SSE stream, and a WebSocket upgrade with one ping/pong exchange. Each must succeed
//      both ways; a response whose bytes are deterministic (two direct sends agree, the
//      Date header aside) must be byte-identical through the front;
//   3. kills the child with SIGKILL while a stream is open through the front, and checks
//      what the docs say the front does: `child-exited`, the open stream ends, `stopped`,
//      exit code 3, the listen port closed, and no process the lane started left.
// Nothing touches the owner's app, data or ports; no credential is used. Everything is
// made in this run's scratch folder under the OS temp dir, except the runtime clone the
// profile preparation requires under the repository's .cache, which the run owns. On
// success, failure, SIGINT, SIGTERM or SIGHUP the lane stops every process it started
// (recorded by pid, start time and process group while they run) and removes both. On
// failure the result keeps the tail of the server's and the front's logs, and both whole
// logs are kept beside the result file (or in a folder the lane names).
//
//   node scripts/qa/front-lane.mjs [--result FILE] [--keep-artifacts]
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { prepareRuntimeUiProfile } from './native-backend-ui-diagnostic.mjs';
import { createQaHostLaunchEnvironment } from './launch-environment.mjs';
import { cloneTree, createRunRoot, scratchParent } from './run-root.mjs';
import { createTestIsolation } from '../test-isolation-guard.mjs';

const repository = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const workspaceDir = path.join(repository, 'packages/native');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const resultFile = option('--result') && path.resolve(option('--result'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => process.stderr.write(`[front-lane] ${message}\n`);
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// The run's scratch, and the guard's private environment for the front (its own root, marker
// and HOME) and for every tool the lane runs. Signals are handled below, by `teardown`.
const run = createRunRoot({ parent: scratchParent('qa'), prefix: 'front-lane-', owner: 'front-lane', signals: 'exit' });
const isolation = createTestIsolation();
// The profile preparation accepts a runtime clone only under the repository's .cache. The run
// owns the clone (removed with the run on every path) and the parents it had to create.
const cacheParent = path.join(repository, '.cache', 'front-lane');
const createdParents = [path.dirname(cacheParent), cacheParent].filter(directory => !fs.existsSync(directory)).reverse();
const removeCreatedParents = () => { for (const directory of createdParents) { try { fs.rmdirSync(directory); } catch { /* not empty or gone */ } } };
process.on('exit', removeCreatedParents);
const profiles = [];
// Where this run's files are, so a caller can check that they are gone afterwards.
const result = { loadStart: os.loadavg(), node: process.version, scratch: { run: run.dir, isolation: isolation.root, runtimeClone: path.join(cacheParent, path.basename(run.dir)) } };
const logs = { server: path.join(run.dir, 'server.log'), front: path.join(run.dir, 'front.log') };
let front = null;
let building = null;

// Every process the lane starts, directly or not: the lane's descendants, read from the
// process table while they run (pid, start time and group), so one that is reparented
// after its parent dies is still found. The lane's own group is not a marker: the tools
// it runs share it, and so may the shell that started it.
const seen = new Map();
const groups = new Map();
let teardownPromise = null;
let lateSignal = null;
const psArgs = ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command='];
function parseTable(text, psPid) {
  return text.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, pgid, start, command]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), start, command }))
    .filter(entry => entry.pid !== psPid && entry.pid !== process.pid);
}
const ownGroup = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
function record(table) {
  const children = new Map();
  for (const entry of table) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  // `front`: started by the front (the front itself, the server and what the server starts).
  const frontPid = front?.child.pid;
  const queue = (children.get(process.pid) ?? []).map(entry => ({ entry, viaFront: entry.pid === frontPid }));
  while (queue.length) {
    const { entry, viaFront } = queue.shift();
    if (!seen.has(entry.pid) || seen.get(entry.pid).start !== entry.start) seen.set(entry.pid, { start: entry.start, pgid: entry.pgid, viaFront, command: entry.command.slice(0, 300) });
    if (entry.pgid !== ownGroup && entry.pgid > 1 && !groups.get(entry.pgid)) groups.set(entry.pgid, viaFront);
    queue.push(...(children.get(entry.pid) ?? []).map(child => ({ entry: child, viaFront })));
  }
}
function tableNow() {
  const output = execFileSync('/bin/ps', psArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return parseTable(output, -1).filter(entry => !(entry.ppid === process.pid && entry.command.startsWith('/bin/ps ')));
}
/** A recorded group still is the lane's unless a different process now has its leader's pid (a reused id). */
const groupIsOurs = (pgid, table) => groups.has(pgid) && !table.some(entry => entry.pid === pgid && seen.get(pgid)?.start !== entry.start);
/** The processes the lane started that are still running (the lane's own children included). */
function survivors() {
  const table = tableNow();
  record(table);
  return table.filter(entry => seen.get(entry.pid)?.start === entry.start || groupIsOurs(entry.pgid, table))
    .map(({ pid, pgid, start, command }) => ({ pid, pgid, viaFront: seen.get(pid)?.start === start ? seen.get(pid).viaFront : groups.get(pgid), command: command.slice(0, 300) }));
}
let polling = false;
const poller = setInterval(() => {
  if (polling) return;
  polling = true;
  const child = execFile('/bin/ps', psArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, output) => {
    polling = false;
    if (!error) record(parseTable(output, child.pid));
  });
}, 400);
poller.unref();

const alive = child => child && child.exitCode === null && child.signalCode === null;
const exitOf = child => new Promise(resolve => { if (!alive(child)) resolve({ code: child.exitCode, signal: child.signalCode }); else child.once('exit', (code, signal) => resolve({ code, signal })); });

/** Stops what the lane started: the front first (it stops its child), then anything left, by pid and by group. Returns what was still running before it was forced. */
async function stopEverything() {
  if (alive(front?.child)) {
    front.child.kill('SIGTERM');
    if (await Promise.race([front.exited.then(() => true), pause(30_000).then(() => false)]) === false) front.child.kill('SIGKILL');
  }
  if (alive(building)) { building.kill('SIGTERM'); await Promise.race([exitOf(building), pause(10_000)]); if (alive(building)) building.kill('SIGKILL'); }
  for (const profile of profiles.splice(0)) { try { await profile.close(); } catch (error) { log(`profile close: ${error.message}`); } }
  let left = survivors();
  const forced = left;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (left.length === 0) break;
    for (const entry of left) {
      try { process.kill(entry.pid, signal); } catch { /* gone */ }
      if (groups.has(entry.pgid)) { try { process.kill(-entry.pgid, signal); } catch { /* gone */ } }
    }
    const deadline = Date.now() + (signal === 'SIGTERM' ? 5000 : 10_000);
    while (Date.now() < deadline && (left = survivors()).length) await pause(200);
  }
  if (left.length) log(`still running after SIGKILL: ${JSON.stringify(left)}`);
  return { forced, left };
}

const tail = (file, bytes = 8000) => { try { const text = fs.readFileSync(file, 'utf8'); return text.slice(-bytes); } catch (error) { return `(no log: ${error.code ?? error.message})`; } };
/** A failed run's whole logs, kept outside the run's folder: beside the result file, or in a folder of their own. */
function keepLogs() {
  if (!fs.existsSync(logs.server) && !fs.existsSync(logs.front)) return { server: '(none written)', front: '(none written)' };
  const target = resultFile ? { server: `${resultFile}.server.log`, front: `${resultFile}.front.log` }
    : (() => { const directory = fs.mkdtempSync(path.join(scratchParent('qa'), 'front-lane-failed-logs-')); return { server: path.join(directory, 'server.log'), front: path.join(directory, 'front.log') }; })();
  const kept = {};
  for (const name of ['server', 'front']) { try { fs.copyFileSync(logs[name], target[name]); kept[name] = target[name]; } catch (error) { kept[name] = `(not kept: ${error.code ?? error.message})`; } }
  return kept;
}

/** The one way out: stop every process, report, remove the run's files, exit. Idempotent; a signal during it only changes the exit code. */
function teardown(status, { signal } = {}) {
  if (teardownPromise) return teardownPromise;
  teardownPromise = (async () => {
    log(`tearing down (${signal ? `${signal}, ` : ''}${status})`);
    result.status = status;
    if (signal) result.signal = signal;
    try {
      const { forced, left } = await stopEverything();
      clearInterval(poller);
      result.processes = { started: seen.size, groups: [...groups.keys()], stoppedByTheLane: forced, leftRunning: left,
        recorded: [...seen].slice(0, 500).map(([pid, entry]) => ({ pid, ...entry })) };
      if ((forced.length || left.length) && result.status === 'passed') result.status = 'failed';
    } catch (error) { result.teardownError = String(error?.stack ?? error).slice(0, 2000); if (result.status === 'passed') result.status = 'failed'; }
    result.loadEnd = os.loadavg();
    if (result.status !== 'passed') result.logs = { server: tail(logs.server), front: tail(logs.front) };
    if (result.status === 'failed') {
      result.logs.kept = run.keepArtifacts ? { server: logs.server, front: logs.front } : keepLogs();
      log(`the server's and the front's logs are kept at ${result.logs.kept.server} and ${result.logs.kept.front}`);
    }
    const text = JSON.stringify(result, null, 2);
    try { if (resultFile) fs.writeFileSync(resultFile, `${text}\n`); } catch (error) { log(`result file: ${error.message}`); }
    process.stdout.write(`${text}\n`);
    isolation.cleanup(result.status);
    run.finish(result.status);
    removeCreatedParents();
    const code = signal ? 128 + os.constants.signals[signal] : result.status === 'passed' ? 0 : 1;
    process.exit(lateSignal ? 128 + os.constants.signals[lateSignal] : code);
  })();
  return teardownPromise;
}
// A closed terminal (SIGHUP) can take stdout and stderr with it: a failed write must not end the lane before its teardown.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
for (const signal of STOP_SIGNALS) {
  process.on(signal, () => {
    if (teardownPromise) { lateSignal ??= signal; log(`${signal} during teardown: finishing it first`); return; }
    void teardown('interrupted', { signal });
  });
}

// The pinned toolchain, without changing the default one. The binary is built into the run's folder.
async function buildFront() {
  const toolchainFile = fs.readFileSync(path.join(workspaceDir, 'rust-toolchain.toml'), 'utf8');
  const channel = /channel\s*=\s*"([^"]+)"/.exec(toolchainFile)?.[1];
  result.rust = channel;
  const rustBin = execFileSync('rustup', ['which', '--toolchain', channel, 'cargo'], { encoding: 'utf8', env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' } }).trim();
  const targetDir = path.join(run.dir, 'target');
  log(`building devryan-front (release) with Rust ${channel}`);
  building = spawn(rustBin, ['build', '--release', '--locked', '--offline', '-p', 'devryan-front', '--target-dir', targetDir], { cwd: workspaceDir, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PATH: `${path.dirname(rustBin)}:${process.env.PATH}`, RUSTUP_TOOLCHAIN: channel, CARGO_TARGET_DIR: targetDir } });
  const { code, signal } = await exitOf(building);
  building = null;
  if (code !== 0) throw new Error(`cargo build failed (${signal ?? code})`);
  return path.join(targetDir, 'release/devryan-front');
}

async function prepareProfile() {
  const root = path.join(run.dir, 'profile');
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(cacheParent, { recursive: true, mode: 0o700 });
  const artifactRoot = run.own(path.join(cacheParent, path.basename(run.dir)));
  cloneTree(path.join(repository, 'packages/web/runtime/darwin-arm64'), artifactRoot);
  const runtimeRoot = path.join(root, 'runtime'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  // In the guard's environment: its HOME and .gitconfig, no system config, no templates or hooks.
  execFileSync('git', ['init', '--quiet', workspace], { env: isolation.env });
  // The lane sends no prompt; the responder only has to exist.
  const profile = await prepareRuntimeUiProfile({ cell: { transport: 'runtime-fixture' }, runtimeRoot, workspace, targetGeneration: 2, artifactRoot, runScope: run.scope,
    fixtureResponder: () => ({ items: [{ type: 'textDelta', text: 'Front lane reply.' }], reason: 'stop' }) });
  profiles.push(profile);
  await profile.verifyInputs();
  const env = createQaHostLaunchEnvironment(profile.env, { DEVRYAN_DIST_DIR: path.join(repository, 'packages/web/dist') });
  const envFile = path.join(root, 'child-env.json');
  fs.writeFileSync(envFile, JSON.stringify(env), { mode: 0o600 });
  return { root, envFile };
}

/** Starts the front; resolves with its ready line, a way to wait for later lines, and the process. */
function startFront(frontBinary, args) {
  const child = spawn(frontBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: isolation.env });
  const events = [];
  let waiting = null;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { events.push(JSON.parse(line)); waiting?.(); } catch { /* not a status line */ } });
  child.stderr.pipe(fs.createWriteStream(logs.front));
  const exited = exitOf(child);
  front = { child, exited };
  const next = (type, timeout) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`no ${type} line within ${timeout} ms`)), timeout);
    const check = () => { const found = events.find(event => event.event === type); if (found) { clearTimeout(deadline); waiting = null; resolve(found); } };
    waiting = check; check();
    exited.then(({ code }) => { if (!events.some(event => event.event === type)) { clearTimeout(deadline); setTimeout(() => reject(new Error(`the front exited (${code}) before ${type}`)), 100); } });
  });
  return next('ready', 240_000).then(ready => ({ ready, next, exited, child, events }));
}

/** Sends `bytes` to 127.0.0.1:`port`; resolves with every byte the server sent, until it closes or `until(received)` holds. */
function exchange(port, bytes, { until, timeout = 30_000, onData } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = Buffer.alloc(0), done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(received); };
    const timer = setTimeout(() => finish(new Error(`no complete answer on port ${port} within ${timeout} ms`)), timeout);
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', chunk => { received = Buffer.concat([received, chunk]); onData?.(socket, received); if (until?.(received)) finish(); });
    socket.on('end', () => finish());
    socket.on('error', finish);
  });
}

const headEnd = buffer => buffer.indexOf('\r\n\r\n');
/** The head without its Date line: the only header that changes between two sends of a deterministic response. */
const withoutDate = buffer => buffer.toString('latin1').replace(/\r\nDate: [^\r\n]*/i, '');
const statusLine = buffer => buffer.toString('latin1').split('\r\n')[0];
const headerNames = buffer => buffer.subarray(0, Math.max(0, headEnd(buffer))).toString('latin1').split('\r\n').slice(1).map(line => line.split(':')[0].toLowerCase());

/** One request sent the same way twice directly and once through the front, interleaved. */
async function compare(name, request, { front, direct, mask }) {
  const first = await exchange(direct, request);
  const through = await exchange(front, request);
  const second = await exchange(direct, request);
  const normal = buffer => (mask ? mask(withoutDate(buffer)) : withoutDate(buffer));
  const deterministic = normal(first) === normal(second);
  const out = { name, status: { direct: statusLine(first), front: statusLine(through) }, bytes: { direct: first.length, front: through.length },
    sameHeaderNames: JSON.stringify(headerNames(first)) === JSON.stringify(headerNames(through)), deterministic,
    identical: deterministic ? normal(through) === normal(first) : null, masked: Boolean(mask) };
  out.ok = /^HTTP\/1\.1 2\d\d /.test(out.status.direct) && out.status.direct === out.status.front && out.sameHeaderNames && out.identical !== false;
  return out;
}

/** Decodes a chunked body that may be incomplete; returns what has arrived whole. */
function dechunk(buffer) {
  let at = 0, out = Buffer.alloc(0);
  for (;;) {
    const line = buffer.indexOf('\r\n', at);
    if (line < 0) return out;
    const size = Number.parseInt(buffer.subarray(at, line).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0 || buffer.length < line + 2 + size + 2) return out;
    out = Buffer.concat([out, buffer.subarray(line + 2, line + 2 + size)]);
    at = line + 2 + size + 2;
  }
}
const sseEventNames = buffer => {
  const start = headEnd(buffer);
  if (start < 0) return [];
  const head = buffer.subarray(0, start).toString('latin1');
  const body = /\r\ntransfer-encoding: chunked/i.test(head) ? dechunk(buffer.subarray(start + 4)) : buffer.subarray(start + 4);
  // The last block is still arriving until a blank line ends it.
  const blocks = body.toString('utf8').replace(/\r\n/g, '\n').split('\n\n').slice(0, -1).filter(Boolean);
  return blocks.map(block => /^event: ?(.*)$/m.exec(block)?.[1] ?? (block.split('\n').every(line => line.startsWith(':')) ? ':comment' : 'message'));
};
const SUBSCRIBED = 'devryan.subscription-ready';
const sseRequest = (host, clientID) => Buffer.from(`GET /api/global/event HTTP/1.1\r\nHost: ${host}\r\nAccept: text/event-stream\r\nAccept-Encoding: identity\r\nX-DevRyan-Events: devryan\r\n`
  + `X-DevRyan-Subscription-Ready: 1\r\nX-DevRyan-Client-ID: ${clientID}\r\n\r\n`);

/** WebSocket frames from the server (unmasked), as { opcode, payload }; stops at an incomplete frame. */
function frames(buffer) {
  const out = [];
  let at = 0;
  while (buffer.length >= at + 2) {
    const opcode = buffer[at] & 0x0f;
    let length = buffer[at + 1] & 0x7f, offset = at + 2;
    if (length === 126) { if (buffer.length < at + 4) break; length = buffer.readUInt16BE(at + 2); offset = at + 4; }
    else if (length === 127) { if (buffer.length < at + 10) break; length = Number(buffer.readBigUInt64BE(at + 2)); offset = at + 10; }
    if (buffer.length < offset + length) break;
    out.push({ opcode, payload: buffer.subarray(offset, offset + length) });
    at = offset + length;
  }
  return out;
}
/** A masked client frame. */
function clientFrame(opcode, payload) {
  const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), key, Buffer.from(payload.map((byte, index) => byte ^ key[index % 4]))]);
}
const PING = Buffer.from('front-lane ping');

/** The upgrade, the server's frames up to its ready message, then a ping answered by a pong, then a close. */
async function websocket(port, host) {
  const request = Buffer.from(`GET /api/global/event/ws?clientID=front-lane-ws&events=devryan HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://${host}\r\nUpgrade: websocket\r\n`
    + 'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  let pinged = false, closed = false;
  const received = await exchange(port, request, {
    onData: (socket, buffer) => {
      const start = headEnd(buffer);
      if (start < 0) return;
      const seen = frames(buffer.subarray(start + 4));
      if (!pinged && seen.some(frame => frame.opcode === 1 && /"type":"ready"/.test(frame.payload.toString('utf8')))) { pinged = true; socket.write(clientFrame(0x9, PING)); }
      if (pinged && !closed && seen.some(frame => frame.opcode === 0xa)) { closed = true; socket.write(clientFrame(0x8, Buffer.from([0x03, 0xe8]))); }
    },
    until: buffer => closed && frames(buffer.subarray(headEnd(buffer) + 4)).some(frame => frame.opcode === 0x8),
  });
  const start = headEnd(received);
  const list = frames(received.subarray(start + 4));
  const ready = list.findIndex(frame => frame.opcode === 1 && /"type":"ready"/.test(frame.payload.toString('utf8')));
  return { head: withoutDate(received.subarray(0, start + 4)), status: statusLine(received),
    beforeReady: list.slice(0, ready + 1).map(frame => (frame.opcode === 1 ? JSON.parse(frame.payload.toString('utf8')).type : `op${frame.opcode}`)),
    pong: list.find(frame => frame.opcode === 0xa)?.payload.toString('utf8') ?? null, close: list.some(frame => frame.opcode === 0x8) };
}

const refusedOn = port => new Promise(resolve => { const socket = net.connect(port, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(false); }); socket.on('error', error => resolve(error.code)); });
const pidGone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };

try {
  const frontBinary = await buildFront();
  const profile = await prepareProfile();
  log('profile ready; starting the server under the front');
  const startedAt = performance.now();
  front = await startFront(frontBinary, ['serve', '--listen', '127.0.0.1:0', '--spawn', '--child-env-file', profile.envFile, '--child-cwd', repository, '--child-log', logs.server,
    '--ready-field', 'isOpenCodeReady', '--ready-timeout-ms', '240000', '--', process.execPath, path.join(repository, 'packages/web/bin/cli.js'), 'serve', '--foreground', '--port', '{port}']);
  result.ready = { ...front.ready, healthyAfterMs: Math.round(performance.now() - startedAt) };
  log(`healthy after ${result.ready.healthyAfterMs} ms`);
  record(tableNow());
  const frontPort = Number(front.ready.listen.split(':').pop()), directPort = Number(front.ready.upstream.split(':').pop());
  // The same request bytes go both ways: the front keeps Host as sent, so the server sees one request.
  const host = front.ready.upstream;
  const ports = { front: frontPort, direct: directPort };
  const get = target => Buffer.from(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
  const asset = fs.readdirSync(path.join(repository, 'packages/web/dist/assets')).filter(file => file.endsWith('.css')).sort()[0];
  result.requests = [
    await compare('health', get('/api/health'), ports),
    await compare(`static asset /assets/${asset}`, get(`/assets/${asset}`), ports),
    // The page carries a fresh 16-byte nonce in its policy header and its script, and its ETag hashes the page:
    // with those masked, the rest must match byte for byte.
    await compare('owner enrolment page', get('/auth/local-owner-bootstrap'), { ...ports, mask: text => text.replace(/nonce-[A-Za-z0-9+/=]{24}/g, 'nonce-<n>')
      .replace(/nonce="[A-Za-z0-9+/=]{24}"/g, 'nonce="<n>"').replace(/\r\nETag: W\/"([0-9a-f]+)-[^"]*"/i, '\r\nETag: W/"$1-<hash>"') }),
  ];
  // The asset and the enrolment page must have been compared byte for byte, not only by status.
  result.byteCompared = result.requests.filter(entry => entry.identical === true).map(entry => entry.name);
  const sse = {};
  for (const [side, port] of Object.entries(ports)) {
    const received = await exchange(port, sseRequest(host, `front-lane-sse-${side}`), { until: buffer => sseEventNames(buffer).includes(SUBSCRIBED) });
    // Up to the subscription's ready event: what follows it in the same read depends on timing.
    const events = sseEventNames(received);
    sse[side] = { status: statusLine(received), contentType: /\r\ncontent-type: ([^\r\n]*)/i.exec(received.subarray(0, headEnd(received)).toString('latin1'))?.[1],
      events: events.slice(0, events.indexOf(SUBSCRIBED) + 1) };
  }
  result.sse = { ...sse, ok: sse.direct.status === 'HTTP/1.1 200 OK' && sse.front.status === sse.direct.status && sse.front.contentType === sse.direct.contentType
    && JSON.stringify(sse.front.events) === JSON.stringify(sse.direct.events) && sse.front.events.includes(SUBSCRIBED) };
  const ws = { direct: await websocket(directPort, host), front: await websocket(frontPort, host) };
  result.websocket = { ...ws, ok: ws.direct.status.startsWith('HTTP/1.1 101 ') && ws.front.head === ws.direct.head && JSON.stringify(ws.front.beforeReady) === JSON.stringify(ws.direct.beforeReady)
    && ws.front.pong === PING.toString() && ws.direct.pong === PING.toString() && ws.front.close && ws.direct.close };
  for (const entry of Object.values(ws)) { entry.headBytes = entry.head.length; delete entry.head; }
  // The child dies with a stream open through the front.
  log('killing the child with SIGKILL');
  let streamEnded = null;
  const held = new Promise(resolve => {
    const socket = net.connect(frontPort, '127.0.0.1', () => socket.write(sseRequest(host, 'front-lane-held')));
    socket.on('data', () => {});
    const end = how => { if (streamEnded === null) { streamEnded = how; resolve(how); } };
    socket.on('end', () => end('end'));
    socket.on('error', error => end(error.code ?? 'error'));
    socket.on('close', () => end('close'));
  });
  await pause(1500);
  const killedAt = performance.now();
  process.kill(front.ready.child_pid, 'SIGKILL');
  const exitedLine = await front.next('child-exited', 30_000);
  const heldEnd = await Promise.race([held, pause(20_000).then(() => 'still open after 20 s')]);
  const stopped = await front.next('stopped', 60_000);
  const exit = await front.exited;
  const refused = await refusedOn(frontPort);
  // Every process the lane started, the server's own descendants included, must go once the
  // front has exited: the front ends the child's group, and the server's watchdogs end its host.
  const fromTheFront = () => survivors().filter(entry => entry.viaFront);
  let processesLeft = fromTheFront();
  for (const deadline = Date.now() + 10_000; processesLeft.length && Date.now() < deadline; processesLeft = fromTheFront()) await pause(250);
  // Anything else still running is the lane's own (none is expected); teardown stops it and reports it.
  result.childDeath = { otherProcesses: survivors().filter(entry => !entry.viaFront) };
  result.childDeath = { ...result.childDeath, childExited: exitedLine, heldStream: heldEnd, stopped, exit, msToExit: Math.round(performance.now() - killedAt), listenAfterExit: refused,
    upstreamAfterExit: await refusedOn(directPort), childGone: pidGone(front.ready.child_pid), watchdogGone: pidGone(front.ready.watchdog_pid), processesLeft };
  result.childDeath.ok = exitedLine.status === 'signal 9' && heldEnd !== 'still open after 20 s' && exit.code === 3 && refused === 'ECONNREFUSED'
    && result.childDeath.upstreamAfterExit === 'ECONNREFUSED' && result.childDeath.childGone && result.childDeath.watchdogGone && processesLeft.length === 0;
  front = null;
  const ok = result.requests.every(entry => entry.ok) && result.byteCompared.length >= 2 && result.sse.ok && result.websocket.ok && result.childDeath.ok;
  await teardown(ok ? 'passed' : 'failed');
} catch (error) {
  result.error = String(error?.stack ?? error).slice(0, 4000);
  await teardown('failed');
}
