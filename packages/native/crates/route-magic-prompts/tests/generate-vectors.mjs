#!/usr/bin/env node
// Vectors that tie devryan-route-magic-prompts to the JavaScript it ports,
// byte for byte, made by running that JavaScript:
//
//   runtime.tsv   operation sequences on the group's own runtime module (its
//                 data file as bytes before the first operation; then each
//                 setOverride, resetOverride, resetAllOverrides or
//                 readPromptState with its result, the state as res.json
//                 writes it or the error's message, and the data file's bytes
//                 after it)
//   bodies.tsv    requests through the product's own request decoding
//                 (registerCommonRequestMiddleware under Express, as the
//                 candidate adapter composes it): path, Content-Type,
//                 Content-Encoding, body bytes, and what the group's PUT
//                 handler reads (`req.body?.text` when it is a string) or the
//                 status of the edge's refusal
//   answers.tsv   Express's weak ETag of bodies, and fresh's verdict on
//                 conditional request headers
//   encodings.tsv compressed request bodies as Node's zlib and body-parser
//                 take them, in the same form as bodies.tsv: gzip with zero
//                 bytes, junk, a stray `1f` or another member after it, members
//                 cut short or with a wrong CRC, length or header CRC, the
//                 optional header fields; deflate with bytes after the stream
//                 or a wrong Adler-32; brotli cut short or followed by bytes;
//                 random bit flips; output just under and over the 16 KiB and
//                 50 MB limits, failures before and after a 16 KiB piece
//                 crosses the limit (each body small enough to reach Node in
//                 one read with its head)
//
// Every field is base64 (text fields of UTF-16 code units little-endian, so
// lone surrogates survive). Inputs are drawn from a seeded generator; the
// outputs are computed from the inputs with the installed packages.
//
//   node packages/native/crates/route-magic-prompts/tests/generate-vectors.mjs           writes the three files
//   node packages/native/crates/route-magic-prompts/tests/generate-vectors.mjs --check   recomputes every stored
//        row's output from its stored input and fails on any difference (inputs are not redrawn, so a change of
//        the platform's zlib output does not matter; a package or Node change that alters an output does)
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
// Express's own dependencies, resolved from Express as it resolves them.
const requireFromExpress = createRequire(requireFromServer.resolve('express'));
const FILES = Object.freeze({ runtime: path.join(HERE, 'runtime.tsv'), bodies: path.join(HERE, 'bodies.tsv'), answers: path.join(HERE, 'answers.tsv'), encodings: path.join(HERE, 'encodings.tsv') });

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const units = (text) => Buffer.from(text, 'utf16le').toString('base64');
const fromUnits = (field) => Buffer.from(field, 'base64').toString('utf16le');
const fromB64 = (field) => Buffer.from(field, 'base64');

// ------------------------------------------------------------------ seeded draws
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

const ID_POOL = [
  'git.pr.generate.visible', 'git.pr.generate.instructions', 'git.commit.generate.visible', 'a', 'z.visible', '0', '12', '7', '4294967294', '4294967295', '01',
  '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'git.commit.draft.visible', 'git.commit.plan.instructions', 'a'.repeat(160), 'b'.repeat(161),
  'Git.PR', 'has space', '', ' git.pr.generate.visible', 'git.pr.generate.visible ', '﻿x.visible', ' y', 'x\n', 'é', 'a-b_c.d', '.visible',
];
function drawText(r) {
  const pieces = ['', ' ', '　', '\t\n', 'plain', 'quote " back \\ slash /', '\u0000\u0001\u001f\u007f', 'é ü 中文', '😀', '\ud800', '\udc00x', '\ud800𐀀', '  ', '</script>', '﻿'];
  let text = '';
  const count = r.int(4);
  for (let index = 0; index < count; index += 1) text += r.pick(pieces);
  return text;
}
function drawFile(r) {
  const kind = r.int(12);
  const entries = () => {
    const parts = [];
    for (let index = r.int(5); index > 0; index -= 1) parts.push(`${JSON.stringify(r.pick(ID_POOL))}:${r.int(5) ? JSON.stringify(drawText(r)) : r.pick(['1', 'null', 'true', '{}', '[]'])}`);
    return parts.join(',');
  };
  switch (kind) {
    case 0: return null;
    case 1: return Buffer.from('{not json');
    case 2: return Buffer.from(`﻿{"version":1,"overrides":{${entries()}}}`);
    case 3: return Buffer.from(r.pick(['null', '[]', '"s"', '5', '{"overrides":[]}', '{"overrides":"x"}', '{"overrides":null}', '{"__proto__":{"overrides":{"a":"b"}}}']));
    case 4: return Buffer.concat([Buffer.from('{"overrides":{"a":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('"}}')]);
    default: return Buffer.from(JSON.stringify({ version: 1, overrides: {} }, null, r.int(3)).replace('{}', `{${entries()}}`));
  }
}

// ------------------------------------------------------------------ runtime.tsv
async function runtimeRow(module, scratch, input) {
  const [fileField, ...ops] = input;
  const dir = fs.mkdtempSync(path.join(scratch, 'case-'));
  const filePath = path.join(dir, 'magic-prompts.json');
  if (fileField !== '-') fs.writeFileSync(filePath, fromB64(fileField));
  const runtime = module.createMagicPromptRuntime({ fsPromises: fs.promises, path, filePath });
  const warn = console.warn;
  console.warn = () => {};
  const out = [];
  try {
    for (const op of ops) {
      const [kind, idField, textField] = op.split(':');
      let result;
      try {
        const state = kind === 'set' ? await runtime.setOverride(fromUnits(idField), fromUnits(textField))
          : kind === 'reset' ? await runtime.resetOverride(fromUnits(idField))
            : kind === 'all' ? await runtime.resetAllOverrides() : await runtime.readPromptState();
        result = `ok:${b64(Buffer.from(JSON.stringify(state)))}`;
      } catch (error) {
        result = `error:${b64(Buffer.from(error instanceof Error ? error.message : String(error)))}`;
      }
      const file = fs.existsSync(filePath) ? b64(fs.readFileSync(filePath)) : '-';
      out.push(`${result}:${file}`);
    }
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}
function drawRuntimeInputs(count) {
  const r = random(0x5eed01);
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const file = drawFile(r);
    const ops = [];
    for (let index = 1 + r.int(6); index > 0; index -= 1) {
      const kind = r.pick(['set', 'set', 'set', 'reset', 'read', 'all']);
      ops.push(`${kind}:${units(r.pick(ID_POOL))}:${units(drawText(r))}`);
    }
    rows.push([file === null ? '-' : b64(file), ...ops]);
  }
  return rows;
}

// ------------------------------------------------------------------ bodies.tsv
async function bodyServer() {
  const express = requireFromServer('express');
  const { registerCommonRequestMiddleware } = await import(pathToFileURL(path.join(SERVER, 'lib/opencode/core-routes.js')).href);
  const app = express();
  app.disable('x-powered-by');
  registerCommonRequestMiddleware(app, { express });
  app.use((req, res) => { const text = req.body?.text; res.json({ text: typeof text === 'string' ? units(text) : null }); });
  // The edge's refusal: only its status is kept.
  app.use((error, _req, res, _next) => { res.status(error.status ?? error.statusCode ?? 500).json({ refused: true }); });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
function send(port, [target, contentType, encoding, body]) {
  return new Promise((resolve, reject) => {
    const bytes = fromB64(body);
    const head = [`PUT ${fromB64(target).toString('latin1')} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
    if (contentType !== '-') head.push(`Content-Type: ${fromB64(contentType).toString('latin1')}`);
    if (encoding !== '-') head.push(`Content-Encoding: ${fromB64(encoding).toString('latin1')}`);
    head.push(`Content-Length: ${bytes.length}`);
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('a vector request had no answer in 30 s')); }, 30_000);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('latin1');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]);
      const body = text.slice(text.indexOf('\r\n\r\n') + 4);
      if (status !== 200) { resolve(`refused:${status}`); return; }
      const parsed = JSON.parse(Buffer.from(body, 'latin1').toString('utf8'));
      resolve(parsed.text === null ? 'none' : `text:${parsed.text}`);
    });
    socket.write(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'), bytes]));
  });
}
function drawBodyInputs(count) {
  const r = random(0x5eed02);
  const paths = ['/api/magic-prompts/git.pr.generate.visible', '/api/Magic-Prompts/x', '/API/MAGIC-PROMPTS/x', '/api/magic-prompts/x?y=1', '/api/other', '/elsewhere'];
  const jsonTypes = ['application/json', 'Application/JSON', 'application/json; charset=utf-8', 'application/json; charset="UTF-8"', 'application/json;charset=utf-16le', 'application/json; charset=utf-16', 'application/json; charset=utf-16be', 'application/json; charset=UTF-16BE', 'application/json; charset=utf-32be', 'application/json; charset=utf-32', 'application/json; charset=utf-32le', 'application/json; charset=latin1', 'application/json; charset=utf-9', 'application/json;', 'application/json; x="a\\"b"', 'application/merge-patch+json', 'text/plain', ' application/json ', 'application/jsonx', '-'];
  const formTypes = ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded; charset=iso-8859-1', 'application/x-www-form-urlencoded; charset=utf-16'];
  const jsonBodies = ['{"text":"a"}', '{"text":"a","text":"b"}', '{"text":12}', '["x"]', 'null', '', '   ', '{}', '{"text":"\\ud800"}', '{"__proto__":{"text":"p"}}', '{"text":"x"} ', '{"text":', '{"text":"é"}', ' \n{"text":"lead"}', '[{"text":"in array"}]', '{"text":null}', '{"a":{"text":"nested"}}'];
  const formBodies = ['text=from%20a+form', 'text[nested]=value', 'text=a&text=b', '[text]=x', 'text=a&[text]=', 'text=&[text]=b', 'text=a]=b', 'te%78t=%E2%9C%93', 'text=%ff', 'text', 'text%5Bx%5D=1', 'text=%E9', `x${'[a]'.repeat(33)}=1`, `x${'[a]'.repeat(32)}=1&text=deep`, `${'a=1&'.repeat(1000)}text=many`, `${'a=1&'.repeat(998)}text=few`, `${Array.from({ length: 120 }, (_, i) => `text[${i}]=v`).join('&')}`, 'text[]=a&text[]=b', 'text[150]=x', 'text[0]=z', '', 'a=1&b=2', 'text=1&text[x]=2', '__proto__[text]=p&text=ok'];
  const encodings = ['-', '-', '-', 'identity', 'gzip', 'GZIP', 'deflate', 'br', 'compress', 'gzip, gzip'];
  const encode = (encoding, bytes) => {
    const lower = encoding.toLowerCase();
    if (lower === 'gzip') return zlib.gzipSync(bytes);
    if (lower === 'deflate') return zlib.deflateSync(bytes);
    if (lower === 'br') return zlib.brotliCompressSync(bytes);
    return bytes;
  };
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const form = r.int(3) === 0;
    const type = form ? r.pick(formTypes) : r.pick(jsonTypes);
    const text = form ? r.pick(formBodies) : r.pick(jsonBodies);
    let bytes = /utf-16/.test(type) && !/be/.test(type) ? Buffer.from(text, 'utf16le') : /utf-16be/.test(type) ? Buffer.from(text, 'utf16le').swap16() : /utf-32/.test(type) ? Buffer.concat([...text].map((ch) => { const b = Buffer.alloc(4); b.writeUInt32LE(ch.codePointAt(0)); return b; })) : /iso-8859-1/.test(type) ? Buffer.from(text, 'latin1') : Buffer.from(text);
    if (r.int(8) === 0) bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
    if (r.int(10) === 0) bytes = Buffer.concat([bytes.subarray(0, bytes.length >> 1), Buffer.from([0xc3, 0x28]), bytes.subarray(bytes.length >> 1)]);
    const encoding = r.pick(encodings);
    rows.push([b64(Buffer.from(r.pick(paths), 'latin1')), type === '-' ? '-' : b64(Buffer.from(type, 'latin1')), encoding === '-' ? '-' : b64(Buffer.from(encoding, 'latin1')), b64(encode(encoding, bytes))]);
  }
  return rows;
}

// ------------------------------------------------------------------ encodings.tsv
function gzipMember(payload, { flags = 0, extra = null, name = null, comment = null, headerCrc = 'right', crc = 'right', size = 'right' } = {}) {
  const header = [Buffer.from([0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 3])];
  if (flags & 4) { const field = extra ?? Buffer.from('ab'); const length = Buffer.alloc(2); length.writeUInt16LE(field.length); header.push(length, field); }
  if (flags & 8) header.push(Buffer.from(`${name ?? 'name'}\0`, 'latin1'));
  if (flags & 16) header.push(Buffer.from(`${comment ?? 'comment'}\0`, 'latin1'));
  if (flags & 2) { const check = Buffer.alloc(2); check.writeUInt16LE((zlib.crc32(Buffer.concat(header)) & 0xffff) ^ (headerCrc === 'right' ? 0 : 1)); header.push(check); }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE((zlib.crc32(payload) ^ (crc === 'right' ? 0 : 1)) >>> 0, 0);
  trailer.writeUInt32LE(((payload.length ^ (size === 'right' ? 0 : 1)) >>> 0) % 4294967296, 4);
  return Buffer.concat([...header, zlib.deflateRawSync(payload), trailer]);
}
function drawEncodingInputs(count) {
  const r = random(0x5eed04);
  const paths = ['/api/magic-prompts/git.pr.generate.visible', '/api/preview/x'];
  // Bodies that inflate to a few bytes, or to just under, at and over 16 384 (the preview path's limit) and its pieces.
  const payload = () => {
    const kind = r.int(4);
    if (kind === 0) return Buffer.from(`{"text":"${r.pick(['a', 'inflated', 'é 中 😀'])}"}`);
    const target = kind === 1 ? r.pick([16_382, 16_383, 16_384, 16_385, 16_400]) : kind === 2 ? r.pick([32_767, 32_768, 32_769, 40_000]) : r.int(70_000);
    const head = '{"text":"padded","pad":"';
    return Buffer.from(`${head}${'x'.repeat(Math.max(0, target - head.length - 2))}"}`);
  };
  const flip = (bytes) => { const out = Buffer.from(bytes); if (out.length) { const at = r.int(out.length); out[at] ^= 1 << r.int(8); } return out; };
  const cut = (bytes) => bytes.subarray(0, r.int(bytes.length + 1));
  const rows = [];
  while (rows.length < count) {
    const body = payload();
    const encoding = r.pick(['gzip', 'gzip', 'gzip', 'deflate', 'deflate', 'br']);
    let bytes;
    if (encoding === 'gzip') {
      const member = (options) => gzipMember(body, options);
      switch (r.int(14)) {
        case 0: bytes = member(); break;
        case 1: bytes = Buffer.concat([member(), Buffer.alloc(1 + r.int(4))]); break;
        case 2: bytes = Buffer.concat([member(), Buffer.from(r.pick(['junk', '\0junk', '\0\x1f\x8b']), 'latin1')]); break;
        case 3: bytes = Buffer.concat([member(), Buffer.from(r.pick([[0x1f], [0x1f, 0x00], [0x1f, 0x8b], [0x1f, 0x8b, 0x08], [0x00, 0x1f]]))]); break;
        case 4: bytes = Buffer.concat([member(), gzipMember(Buffer.from(r.pick([' ', '', 'x'])))]); break;
        case 5: bytes = Buffer.concat([member(), cut(gzipMember(Buffer.from('second')))]); break;
        case 6: bytes = Buffer.concat([member(), gzipMember(Buffer.from('second'), { crc: 'wrong' })]); break;
        case 7: bytes = member({ crc: 'wrong' }); break;
        case 8: bytes = member({ size: 'wrong' }); break;
        case 9: bytes = member({ flags: r.pick([2, 4, 8, 16, 30, 6]), headerCrc: r.int(3) ? 'right' : 'wrong' }); break;
        case 10: bytes = member({ flags: r.pick([0x20, 0x40, 0x80]) }); break;
        case 11: bytes = cut(member()); break;
        case 12: bytes = flip(member()); break;
        default: bytes = Buffer.concat([zlib.gzipSync(body), zlib.gzipSync(Buffer.from(''))]); break;
      }
    } else if (encoding === 'deflate') {
      const stream = zlib.deflateSync(body, { level: r.pick([1, 6, 9]) });
      switch (r.int(7)) {
        case 0: bytes = stream; break;
        case 1: bytes = Buffer.concat([stream, Buffer.from(r.pick(['junk', '\0', '\x78\x9c']), 'latin1')]); break;
        case 2: { bytes = Buffer.from(stream); bytes[bytes.length - 1] ^= 1; break; }
        case 3: bytes = cut(stream); break;
        case 4: bytes = flip(stream); break;
        case 5: bytes = Buffer.concat([Buffer.from([0x78, 0x01]), zlib.deflateRawSync(body, { level: 0 }), Buffer.from([0, 0, 0, 0])]); break;
        default: bytes = Buffer.concat([stream, stream]); break;
      }
    } else {
      const stream = zlib.brotliCompressSync(body);
      switch (r.int(4)) {
        case 0: bytes = stream; break;
        case 1: bytes = Buffer.concat([stream, Buffer.from(r.pick(['junk', '\0', 'x']), 'latin1')]); break;
        case 2: bytes = cut(stream); break;
        default: bytes = Buffer.concat([stream, stream]); break;
      }
    }
    // One read with its head: small enough for one loopback segment.
    if (bytes.length > 6000) continue;
    rows.push([b64(Buffer.from(r.pick(paths), 'latin1')), b64(Buffer.from('application/json', 'latin1')), b64(Buffer.from(encoding, 'latin1')), b64(bytes)]);
  }
  return rows;
}

// ------------------------------------------------------------------ answers.tsv
function answerRow(kind, fields) {
  if (kind === 'etag') {
    const etag = requireFromExpress('etag');
    return etag(fromB64(fields[0]), { weak: true });
  }
  const fresh = requireFromExpress('fresh');
  const [etagText, noneMatch, modifiedSince, cacheControl] = fields.map((field) => (field === '-' ? undefined : fromB64(field).toString('latin1')));
  return String(fresh({ 'if-none-match': noneMatch, 'if-modified-since': modifiedSince, 'cache-control': cacheControl }, { etag: etagText, 'last-modified': undefined }));
}
function drawAnswerInputs(count) {
  const r = random(0x5eed03);
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    if (r.int(2)) {
      const length = r.pick([0, 1, 27, 28, 55, 56, 63, 64, 65, 200, 1000, 4096]);
      rows.push(['etag', b64(Buffer.from(Array.from({ length }, () => r.int(256))))]);
    } else {
      const etag = r.pick(['W/"1c-6Aa9gYo6XdlCcEbGlu1hyPIy8Xs"', 'W/"2-abc"']);
      const noneMatch = r.pick(['-', '', '*', ' * ', etag, `"x", ${etag}`, etag.slice(2), `W/${etag}`, '"other"', `  ${etag}  ,`, ',', `${etag},${etag}`]);
      const since = r.pick(['-', '', 'Tue, 01 Jan 2030 00:00:00 GMT']);
      const cache = r.pick(['-', '', 'no-cache', 'max-age=0, no-cache', 'no-cache-x', ' no-cache ', 'No-Cache', 'x,no-cache,y']);
      rows.push(['fresh', b64(Buffer.from(etag)), noneMatch === '-' ? '-' : b64(Buffer.from(noneMatch)), since === '-' ? '-' : b64(Buffer.from(since)), cache === '-' ? '-' : b64(Buffer.from(cache))]);
    }
  }
  return rows;
}

// ------------------------------------------------------------------ files
const HEADER = (what) => `# devryan-route-magic-prompts vectors: ${what}. Made by tests/generate-vectors.mjs from the JavaScript it ports; every field base64.\n`;
const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'));

/** Every set's rows as [input fields, output fields] from the given inputs (or drawn ones). */
export async function computeVectors(inputs = null) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-route-vectors-'));
  const server = await bodyServer();
  try {
    const module = await import(pathToFileURL(path.join(SERVER, 'lib/magic-prompts/runtime.js')).href);
    const runtimeInputs = inputs?.runtime ?? drawRuntimeInputs(600);
    const runtime = [];
    for (const input of runtimeInputs) runtime.push([input, await runtimeRow(module, scratch, input)]);
    const bodyInputs = inputs?.bodies ?? drawBodyInputs(1200);
    const bodies = [];
    for (const input of bodyInputs) bodies.push([input, [await send(server.address().port, input)]]);
    const answerInputs = inputs?.answers ?? drawAnswerInputs(300);
    const answers = answerInputs.map(([kind, ...fields]) => [[kind, ...fields], [answerRow(kind, fields)]]);
    const encodingInputs = inputs?.encodings ?? drawEncodingInputs(1500);
    const encodings = [];
    for (const input of encodingInputs) encodings.push([input, [await send(server.address().port, input)]]);
    return { runtime, bodies, answers, encodings };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

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
    tracked[name].forEach(([, output], index) => {
      if (JSON.stringify(output) !== JSON.stringify(computed[name][index][1])) problems.push(`${name}.tsv row ${index + 1}: stored ${JSON.stringify(output).slice(0, 120)}, computed ${JSON.stringify(computed[name][index][1]).slice(0, 120)}`);
    });
  }
  return problems;
}

async function main(argv) {
  if (argv.includes('--check')) {
    const problems = await vectorProblems();
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stdout.write(problems.length ? `${problems.length} vector rows differ; regenerate with: node packages/native/crates/route-magic-prompts/tests/generate-vectors.mjs\n` : 'vectors: every row is what the JavaScript gives\n');
    return problems.length ? 1 : 0;
  }
  const computed = await computeVectors();
  const what = { runtime: 'the runtime module\'s operation sequences', bodies: 'the request decoding\'s req.body?.text', answers: 'Express\'s ETag and fresh\'s verdict', encodings: 'compressed request bodies as Node\'s zlib and body-parser take them' };
  for (const [name, file] of Object.entries(FILES)) fs.writeFileSync(file, HEADER(what[name]) + computed[name].map(([input, output]) => [...input, '=>', ...output].join('\t')).join('\n') + '\n');
  process.stdout.write(`wrote ${Object.entries(computed).map(([name, rows]) => `${rows.length} ${name}`).join(', ')} rows\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
