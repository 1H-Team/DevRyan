// The JavaScript candidate adapter of session-folders (J) under a process file-size limit and with a client that
// leaves mid-response (BH7 fix round 1, B1), against the expectation the Rust binary is held to as well
// (packages/native/crates/route-session-folders/tests/process-limits.json, read by that crate's process_limits.rs):
// Node ignores SIGXFSZ, so a save past the limit answers 500 with libuv's EFBIG text, its temporary file is
// removed and the next save works; a GET whose client closes while the answer is still being written costs only
// that connection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { onceFinished } from './child-finish.mjs';
import { REPOSITORY_ROOT } from './edge.mjs';
import { PRINCIPALS, encodeEnvelope, envelopeFor } from './scenario.mjs';

const EXPECTED = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'packages/native/crates/route-session-folders/tests/process-limits.json'), 'utf8'));
const FILE = 'sessions-directories.json';
const READY_MS = 30_000;
const EXCHANGE_MS = 60_000;
const STOP_MS = 10_000;

/** J on its own scratch roots, under `ulimit -f <blocks>` (the shell's exec keeps the pid). */
async function startArm(t, blocks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-process-limits-'));
  const root = path.join(dir, 'data');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(dir, 'home'));
  const child = spawn('/bin/sh', ['-c', `ulimit -f ${blocks} && exec "$0" "$@"`, process.execPath, path.join(REPOSITORY_ROOT, 'scripts/backend-conformance/js-candidate.mjs'),
    '--group', 'session-folders', '--listen', '127.0.0.1:0', '--control', '127.0.0.1:0', '--data-root', root, '--home', path.join(dir, 'home')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TZ: 'UTC' } });
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { if (stderr.length < 16 * 1024) stderr += chunk; });
  const finished = new Promise((resolve) => { onceFinished(child, (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => { process.stderr.write(`process-limits: the JavaScript candidate (pid ${child.pid}) did not stop in ${STOP_MS} ms; killed\n`); child.kill('SIGKILL'); }, STOP_MS);
    await finished;
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`no ready line in ${READY_MS} ms: ${stderr}`)), READY_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline >= 0) { clearTimeout(timer); resolve(JSON.parse(buffered.slice(0, newline)).ready); }
    });
    finished.then(({ code, signal }) => { clearTimeout(timer); reject(new Error(`exited (${code ?? signal}) before ready: ${stderr}`)); });
  });
  let seq = 0;
  const send = (method, body) => {
    seq += 1;
    const envelope = encodeEnvelope(envelopeFor(PRINCIPALS['local-admin'], { originalUrl: '/api/session-folders', seq }));
    const socket = net.connect(ready.listen, '127.0.0.1');
    socket.write(Buffer.concat([Buffer.from(`${method} /api/session-folders HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nX-DevRyan-Harness-Envelope: ${envelope}\r\nX-DevRyan-Harness-Seq: ${seq}\r\n\r\n`, 'latin1'), body]));
    return socket;
  };
  const exchange = (method, body = Buffer.alloc(0)) => new Promise((resolve, reject) => {
    const socket = send(method, body);
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer to ${method} in ${EXCHANGE_MS} ms`)); }, EXCHANGE_MS);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      const answer = Buffer.concat(chunks);
      const split = answer.indexOf('\r\n\r\n');
      resolve({ status: Number(answer.subarray(9, 12).toString('latin1')), body: answer.subarray(split + 4).toString('utf8') });
    });
  });
  return { root, send, exchange, alive: () => child.exitCode === null && child.signalCode === null };
}

const pad = (bytes, unit) => Buffer.from(JSON.stringify({ pad: unit.repeat(bytes) }));
const pretty = (bytes, unit) => JSON.stringify({ pad: unit.repeat(bytes) }, null, 2);
const leftovers = (root) => fs.readdirSync(root).filter((name) => name.includes('.tmp-')).sort();

test('a save past the file-size limit answers EFBIG, cleans up, and the next save works', async (t) => {
  const arm = await startArm(t, EXPECTED.ulimitBlocks);
  assert.deepEqual(await arm.exchange('POST', pad(EXPECTED.smallPad, 'a')), { status: 200, body: EXPECTED.saved });
  assert.equal(fs.readFileSync(path.join(arm.root, FILE), 'utf8'), pretty(EXPECTED.smallPad, 'a'));
  assert.deepEqual(await arm.exchange('POST', pad(EXPECTED.largePad, 'b')), { status: 500, body: EXPECTED.tooLarge });
  assert.ok(arm.alive(), 'the process survives the limit');
  assert.equal(fs.readFileSync(path.join(arm.root, FILE), 'utf8'), pretty(EXPECTED.smallPad, 'a'));
  assert.deepEqual(leftovers(arm.root), [], 'the temporary file is removed');
  assert.deepEqual(await arm.exchange('POST', pad(EXPECTED.smallPad, 'c')), { status: 200, body: EXPECTED.saved });
  assert.deepEqual(await arm.exchange('GET'), { status: 200, body: pad(EXPECTED.smallPad, 'c').toString() });
});

test('a client that leaves mid-response costs only its connection', async (t) => {
  const arm = await startArm(t, 1 << 30);
  fs.writeFileSync(path.join(arm.root, FILE), pretty(EXPECTED.disconnectPad, 'd'));
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve, reject) => {
      const socket = arm.send('GET', Buffer.alloc(0));
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer started')); }, EXCHANGE_MS);
      socket.once('data', (chunk) => { clearTimeout(timer); assert.ok(chunk.subarray(0, 12).toString('latin1') === 'HTTP/1.1 200'); socket.destroy(); resolve(); });
      socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }
  assert.ok(arm.alive(), 'the process survives the closed connections');
  const answer = await arm.exchange('GET');
  assert.deepEqual([answer.status, answer.body.length], [200, pad(EXPECTED.disconnectPad, 'd').length]);
  assert.deepEqual(await arm.exchange('POST', pad(10, 'e')), { status: 200, body: EXPECTED.saved });
});
