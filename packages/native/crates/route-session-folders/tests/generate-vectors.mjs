#!/usr/bin/env node
// Vectors that tie devryan-route-session-folders to the JavaScript it ports, byte for byte, made by running that
// JavaScript (BH7 fix round 1, S2):
//
//   requests.tsv  requests through the product's own request decoding (registerCommonRequestMiddleware under
//                 Express, as the candidate adapter composes it) and the group's own registrar on a data root in a
//                 given state (no file, a file's bytes, a directory): method, path, Content-Type,
//                 Content-Encoding and body, then the answer (its status and body, or the edge's refusal's status),
//                 the data file's bytes after it and how many temporary files are left. The data root's path in
//                 an answer is written `<root>`, a temporary file's name `<tmp>`. JSON documents of every shape the
//                 two parsing paths treat apart (index-like, repeated, escaped and `"01"`-like keys, odd and long
//                 numbers, ties of two shortest spellings, escapes, lone surrogates, ill-formed bytes, nesting),
//                 forms (qs's shapes, 1 000 and 1 001 parameters), charsets, compressed bodies, files GET reads.
//   cleanup.tsv   harness-runtime's stale-file cleanup with a given clock: files, folders and links named like
//                 temporary files with mtimes at a day before the clock exactly and a millisecond either side (and
//                 further off), and what is left; mtimes as the file system keeps them (nanoseconds read back), so
//                 the Rust sets the same ones.
//
// Every field is base64 but the tags. Inputs are drawn from a seeded generator; outputs are computed from the
// inputs with the installed packages. tests/vectors.rs runs every row through the crate (both parsing paths for
// JSON: the group's one pass and the tree).
//
//   node packages/native/crates/route-session-folders/tests/generate-vectors.mjs           writes the two files
//   node packages/native/crates/route-session-folders/tests/generate-vectors.mjs --check   recomputes every stored
//        row's output from its stored input and fails on any difference
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const SERVER = path.join(ROOT, 'packages/web/server');
const requireFromServer = createRequire(path.join(SERVER, 'package.json'));
const FILES = Object.freeze({ requests: path.join(HERE, 'requests.tsv'), cleanup: path.join(HERE, 'cleanup.tsv') });
const FILE = 'sessions-directories.json';
const DAY_MS = 24 * 60 * 60 * 1000;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (field) => Buffer.from(field, 'base64');

function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  return { next, int, pick };
}

// ------------------------------------------------------------------ documents
const KEYS = ['version', 'foldersMap', 'a', 'b', 'é', '0', '1', '2', '10', '01', '00', '-0', '4294967294', '4294967295', '__proto__', 'constructor', '', ' ', '\\u0061', '\\u0031', '\\ud800', '\\udc00', 'a\\nb', '\\u00e9', 'x"y'];
const NUMBERS = ['0', '-0', '1', '-1', '1.0', '1e2', '1E2', '1e+2', '0.1', '0.10', '1e21', '1e-7', '1e-6', '5e-324', '1e400', '-1e400', '123456789012345678', '123456789012345', '1234567890123456', '9007199254740993', '97312000038578.125', '1000000000000042.25', '83176082636972.125', '0.30000000000000004', '1.7976931348623157e308', '2.2250738585072014e-308', '1700000000000'];
const STRINGS = ['""', '"plain"', '"\\u0041\\/\\b\\f\\n\\r\\t"', '"\\u0001\\u001f\\u007f"', '"\\u2028\\u2029"', '"\\ud800"', '"\\udc00x"', '"\\ud83d\\ude00"', '"\\ude00\\ud83d"', '"é ü 中文 😀"', '"\\"\\\\"', '"</script>"'];
function drawValue(r, depth) {
  const kind = r.int(depth > 3 ? 3 : 6);
  if (kind === 0) return r.pick(NUMBERS);
  if (kind === 1) return r.pick(STRINGS);
  if (kind === 2) return r.pick(['true', 'false', 'null', '[]', '{}']);
  if (kind === 3) return `[${Array.from({ length: r.int(4) }, () => drawValue(r, depth + 1)).join(r.pick([',', ' , ']))}]`;
  return drawObject(r, depth + 1);
}
function drawObject(r, depth) {
  const members = Array.from({ length: r.int(6) }, () => `"${r.pick(KEYS)}"${r.pick([':', ' : '])}${drawValue(r, depth)}`);
  // Sometimes a key defined again later, or an index key after the others.
  if (members.length && r.int(3) === 0) members.push(`"${r.pick(KEYS)}":${drawValue(r, depth)}`);
  return `{${members.join(',')}}`;
}
function drawJson(r) {
  const kind = r.int(20);
  if (kind === 0) return Buffer.from(r.pick(['', ' ', 'null', '"s"', '5', '[1]', '{"a":', '{"a":1,}', '{"a" 1}', '[1,]', '{}x', '﻿{}']));
  if (kind === 1) return Buffer.concat([Buffer.from('{"s":"'), Buffer.from(r.pick([[0xff], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x98], [0xe2, 0x82]])), Buffer.from('","k":1}')]);
  if (kind === 2) { const depth = 8 + r.int(12); return Buffer.from(`${'{"a":['.repeat(depth)}1${']}'.repeat(depth)}`); }
  if (kind === 3) return Buffer.from(`[${drawValue(r, 0)}]`);
  return Buffer.from(drawObject(r, 0));
}

// ------------------------------------------------------------------ forms
function drawForm(r) {
  const pieces = ['version=1', 'a=1', 'a=2', 'b[c]=d', 'b[0]=x', 'b[1]=y', 'c[]=1', 'c[]=2', 'd[3]=sparse', '__proto__=p', 'e[__proto__]=q', 'f[toString]=t', '9=nine', 'g%5Bh%5D=encoded', 'plus=a+b', 't=%E9', 'u=%ff', 'k', 'k=', '=v', 'n=12', 'm[x][y][z]=deep'];
  const kind = r.int(30);
  if (kind === 0) return Array.from({ length: 98 + r.int(8) }, (_, i) => `big[${i}]=${i}`).join('&');
  if (kind < 3) return `k${'[k]'.repeat(31 + r.int(3))}=deep`;
  return Array.from({ length: 1 + r.int(6) }, () => r.pick(pieces)).join('&');
}

// ------------------------------------------------------------------ requests.tsv
const PATHS = ['/api/session-folders', '/api/session-folders', '/api/session-folders', '/API/SESSION-FOLDERS', '/api/session-folders/', '/api/session-folders?x=1', '/api/Session-Folders'];
const JSON_TYPES = ['application/json', 'application/json', 'application/json; charset=utf-8', 'application/json; charset=utf-16', 'application/json; charset=utf-16le', 'application/json; charset=utf-16be', 'application/vnd.folders+json', 'text/plain', '-'];
const FORM_TYPES = ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded; charset=iso-8859-1'];
const ENCODINGS = ['-', '-', '-', '-', 'gzip', 'deflate', 'br', 'identity'];
const encode = (encoding, bytes) => (encoding === 'gzip' ? zlib.gzipSync(bytes) : encoding === 'deflate' ? zlib.deflateSync(bytes) : encoding === 'br' ? zlib.brotliCompressSync(bytes) : bytes);
const charsetBytes = (type, text) => {
  if (/utf-16be/.test(type)) return Buffer.from(text.toString('utf8'), 'utf16le').swap16();
  if (/utf-16/.test(type)) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.toString('utf8'), 'utf16le')]);
  if (/iso-8859-1/.test(type)) return Buffer.from(text.toString('utf8'), 'latin1');
  return text;
};

function drawRequestInputs(count) {
  const r = random(0x5f01de75);
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const stateKind = r.int(10);
    const state = stateKind < 6 ? '-' : stateKind < 9 ? `f:${b64(r.int(4) === 0 ? drawJson(r) : Buffer.from(JSON.stringify(JSON.parse(`{"version":1,"foldersMap":{"/p":[{"id":"f","createdAt":1}]},"updatedAt":2}`), null, 2)))}` : 'dir';
    const get = r.int(5) === 0;
    if (get) {
      // A GET of a file: its bytes drawn like a body (index keys, repeated keys, numbers, escapes, ill-formed bytes).
      const file = r.int(6) === 0 ? 'dir' : `f:${b64(r.int(8) === 0 ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), drawJson(r)]) : drawJson(r))}`;
      rows.push([file, b64(Buffer.from('GET')), b64(Buffer.from(r.pick(PATHS))), '-', '-', '']);
      continue;
    }
    const form = r.int(5) === 0;
    const type = form ? r.pick(FORM_TYPES) : r.pick(JSON_TYPES);
    const text = form ? Buffer.from(drawForm(r)) : drawJson(r);
    const encoding = r.pick(ENCODINGS);
    rows.push([state, b64(Buffer.from('POST')), b64(Buffer.from(r.pick(PATHS))), type === '-' ? '-' : b64(Buffer.from(type)), encoding === '-' ? '-' : b64(Buffer.from(encoding)), b64(encode(encoding, charsetBytes(type, text)))]);
  }
  // body-parser's parameter limit: 1 000 parameters are parsed, 1 001 refused (413), plain and compressed.
  for (const count of [1000, 1001]) {
    for (const encoding of ['-', 'gzip']) {
      const text = Buffer.from(Array.from({ length: count }, (_, i) => `p${i}=${i % 7}`).join('&'));
      rows.push(['-', b64(Buffer.from('POST')), b64(Buffer.from('/api/session-folders')), b64(Buffer.from('application/x-www-form-urlencoded')), encoding === '-' ? '-' : b64(Buffer.from(encoding)), b64(encode(encoding, text))]);
    }
  }
  return rows;
}

async function requestServer(root) {
  const express = requireFromServer('express');
  const { registerCommonRequestMiddleware } = await import(pathToFileURL(path.join(SERVER, 'lib/opencode/core-routes.js')).href);
  const { registerSessionFoldersRoutes } = await import(pathToFileURL(path.join(SERVER, 'lib/session-folders/routes.js')).href);
  const app = express();
  app.disable('x-powered-by');
  registerCommonRequestMiddleware(app, { express });
  registerSessionFoldersRoutes(app, { fsPromises: fs.promises, path, devryanDataDir: root });
  // The edge's refusal (the body parsers' errors and a handler's throw): only its status is kept.
  app.use((error, _req, res, _next) => { res.status(error.status ?? error.statusCode ?? 500).json({ refused: true }); });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const TMP = new RegExp(`${FILE.replace(/\./g, '\\.')}\\.tmp-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`, 'g');
/** The data root in the state a row names: emptied, then no file, the file's bytes, or a directory at its path. */
function setState(root, state) {
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  if (state === 'dir') fs.mkdirSync(path.join(root, FILE));
  else if (state.startsWith('f:')) fs.writeFileSync(path.join(root, FILE), fromB64(state.slice(2)));
}
function afterState(root) {
  const file = path.join(root, FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  const leftovers = fs.readdirSync(root).filter((name) => name.startsWith(`${FILE}.tmp-`)).length;
  return [stat?.isFile() ? b64(fs.readFileSync(file)) : stat ? 'dir' : '-', String(leftovers)];
}
function send(port, root, [state, method, target, contentType, encoding, body]) {
  setState(root, state);
  return new Promise((resolve, reject) => {
    const bytes = fromB64(body);
    const head = [`${fromB64(method).toString('latin1')} ${fromB64(target).toString('latin1')} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
    if (contentType !== '-') head.push(`Content-Type: ${fromB64(contentType).toString('latin1')}`);
    if (encoding !== '-') head.push(`Content-Encoding: ${fromB64(encoding).toString('latin1')}`);
    if (bytes.length) head.push(`Content-Length: ${bytes.length}`);
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('a vector request had no answer in 30 s')); }, 30_000);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      const answer = Buffer.concat(chunks);
      const split = answer.indexOf('\r\n\r\n');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(answer.subarray(0, 12).toString('latin1'))?.[1]);
      const text = answer.subarray(split + 4).toString('utf8');
      const refused = text.startsWith('{"refused":true}');
      const shown = text.split(root).join('<root>').replace(TMP, '<tmp>');
      resolve([refused ? `refused:${status}` : String(status), refused ? '' : b64(Buffer.from(shown)), ...afterState(root)]);
    });
    socket.write(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'), bytes]));
  });
}

// ------------------------------------------------------------------ cleanup.tsv
// Each row: the clock, then each entry as `<kind>:<base64 name>:<mtime ms set>:<mtime ns kept>` (kind f, d or l; a
// link points to a file beside it); out: the names left, sorted, base64 and comma-separated.
function drawCleanupInputs(count) {
  const r = random(0xc1ea70);
  const rows = [];
  const base = 1_700_000_000_000;
  for (let row = 0; row < count; row += 1) {
    const now = base + r.int(1000) * 1000;
    const entries = [];
    const offsets = [0, -1, 1, -1000, 1000, -DAY_MS, DAY_MS, -2 * DAY_MS];
    for (let index = 0; index < 1 + r.int(6); index += 1) {
      const name = r.pick([`${FILE}.tmp-${index}-a`, `${FILE}.tmp-`, `${FILE}.tmp`, `other.json.tmp-${index}`, `${FILE}.tmp-${index}-é`, `x${FILE}.tmp-${index}`]);
      if (entries.some(([, other]) => other === name)) continue;
      const kind = r.pick(['f', 'f', 'f', 'f', 'd', 'l']);
      entries.push([kind, name, now - DAY_MS + r.pick(offsets)]);
    }
    rows.push([String(now), ...entries.map(([kind, name, mtimeMs]) => `${kind}:${b64(Buffer.from(name))}:${mtimeMs}`)]);
  }
  return rows;
}
/** Makes a row's entries (the mtime set in milliseconds, then read back in nanoseconds) and runs the cleanup. */
async function cleanupRow(cleanup, scratch, [now, ...entries]) {
  const dir = fs.mkdtempSync(path.join(scratch, 'cleanup-'));
  try {
    const made = [];
    for (const entry of entries) {
      const [kind, name, mtime] = entry.split(':');
      const seconds = Number(mtime) / 1000;
      const file = path.join(dir, fromB64(name).toString('utf8'));
      if (kind === 'd') fs.mkdirSync(file);
      else if (kind === 'l') { fs.writeFileSync(`${file}.target`, 'x'); fs.symlinkSync(path.basename(`${file}.target`), file); }
      else fs.writeFileSync(file, 'partial');
      if (kind === 'l') fs.lutimesSync(file, seconds, seconds); else fs.utimesSync(file, seconds, seconds);
      made.push(`${kind}:${name}:${mtime}:${fs.lstatSync(file, { bigint: true }).mtimeNs}`);
    }
    await cleanup(path.join(dir, FILE), { now: () => Number(now) });
    const left = fs.readdirSync(dir).filter((name) => !name.endsWith('.target')).sort().map((name) => b64(Buffer.from(name)));
    return { input: [now, ...made], output: [left.join(',') || '-'] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Every set's rows as [input fields, output fields], from the given inputs (or drawn ones). */
export async function computeVectors(inputs = null) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-session-folders-vectors-'));
  const root = path.join(scratch, 'data');
  fs.mkdirSync(root);
  const server = await requestServer(root);
  try {
    const requestInputs = inputs?.requests ?? drawRequestInputs(1000);
    const requests = [];
    for (const input of requestInputs) requests.push([input, await send(server.address().port, root, input)]);
    const { cleanupStaleAtomicFiles } = await import(pathToFileURL(path.join(ROOT, 'packages/harness-runtime/lib/atomic-file.js')).href);
    const cleanupInputs = inputs?.cleanup ?? drawCleanupInputs(160);
    const cleanup = [];
    for (const input of cleanupInputs) { const { input: made, output } = await cleanupRow(cleanupStaleAtomicFiles, scratch, input); cleanup.push([made, output]); }
    return { requests, cleanup };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const HEADER = (what) => `# devryan-route-session-folders vectors: ${what}. Made by tests/generate-vectors.mjs from the JavaScript it ports; fields base64 but tags.\n`;
const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'));

/** The tracked files' rows split at their `=>` field into input and output. */
export function trackedVectors() {
  const split = (row) => { const at = row.indexOf('=>'); return [row.slice(0, at), row.slice(at + 1)]; };
  return Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, readRows(file).map(split)]));
}

/** Rows whose stored output is not what the installed packages compute from the stored input. */
export async function vectorProblems() {
  const tracked = trackedVectors();
  const computed = await computeVectors(Object.fromEntries(Object.entries(tracked).map(([name, rows]) => [name, rows.map(([input]) => input)])));
  const problems = [];
  for (const name of Object.keys(FILES)) {
    tracked[name].forEach(([input, output], index) => {
      const [again, wanted] = computed[name][index];
      if (JSON.stringify([input, output]) !== JSON.stringify([again, wanted])) problems.push(`${name}.tsv row ${index + 1}: stored ${JSON.stringify(output).slice(0, 120)}, computed ${JSON.stringify(wanted).slice(0, 120)}`);
    });
  }
  return problems;
}

async function main(argv) {
  if (argv.includes('--check')) {
    const problems = await vectorProblems();
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stdout.write(problems.length ? `${problems.length} vector rows differ; regenerate with: node packages/native/crates/route-session-folders/tests/generate-vectors.mjs\n` : 'vectors: every row is what the JavaScript gives\n');
    return problems.length ? 1 : 0;
  }
  const computed = await computeVectors();
  const what = { requests: 'requests through the product\'s decoding and the group\'s routes, and the data file after each', cleanup: 'the stale temporary-file cleanup with a given clock' };
  for (const [name, file] of Object.entries(FILES)) fs.writeFileSync(file, HEADER(what[name]) + computed[name].map(([input, output]) => [...input, '=>', ...output].join('\t')).join('\n') + '\n');
  process.stdout.write(`wrote ${Object.entries(computed).map(([name, rows]) => `${rows.length} ${name}`).join(', ')} rows\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
