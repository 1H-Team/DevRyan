#!/usr/bin/env node
// The JavaScript arm of the object-database tests (plan package L3a), run on
// the reference runtime (the Node inside Electron): today's writer and
// readers of the ledger repository, as the product calls them.
//
//   node odb-js-arm.mjs trace                 one writeLooseObject through a recording
//                                             node:fs/promises (JSON on stdin and stdout;
//                                             the twin of odb-probe's write-trace)
//   node odb-js-arm.mjs write <git> <format>  writeLooseObject of each `<type> <length>\n<bytes>` record
//   node odb-js-arm.mjs store <git> <ref>     openChangeStore(...).records(): one JSON line per row
//   node odb-js-arm.mjs list <git> <tree>     listTreeRows over the persistent cat-file readers, as
//                                             the store's whole direct listing calls it (JSON rows, or null)
//   node odb-js-arm.mjs entries <git> <ref> <prefix>
//                                             the store's entries(prefix) on its paged path (a listing
//                                             bound of one byte): one JSON line { key, oid } per row
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { readGitObject } from '../../packages/harness-runtime/lib/session-changes-git.js';
import { openChangeStore } from '../../packages/harness-runtime/lib/session-changes-store.js';
import { listTreeRows, listedRowText, writeLooseObject } from '../../packages/harness-runtime/lib/session-changes-trees.js';

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/** Installs a recording `node:fs/promises`, a scripted `randomUUID` and a fixed `new Date()`. */
function record(request) {
  const trace = [];
  const relative = (file) => (file.startsWith(`${request.root}/`) ? file.slice(request.root.length + 1) : file);
  const seen = new Map();
  const syscalls = { utimes: 'utime', mkdir: 'mkdir', stat: 'stat', writeFile: 'open', link: 'link', unlink: 'unlink' };
  // The scenario's change to the fan-out directory, made with the unrecorded calls.
  const alter = (fault, op, file) => {
    const directory = op === 'mkdir' || op === 'stat' ? file : path.dirname(file);
    const mkdir = () => originals.mkdir.call(fs, directory);
    return fault.alter === 'remove-dir' ? fs.rm(directory, { recursive: true, force: true })
      : fault.alter === 'replace-dir' ? fs.rename(directory, `${directory}.replaced`).then(mkdir, mkdir).catch(() => {})
        : Promise.resolve();
  };
  const wrap = (op, original, extra) => async (...args) => {
    const entry = { op, path: relative(String(args[0])), ...extra(...args) };
    trace.push(entry);
    let injected = null;
    // A fault names the nth call of its operation.
    const count = (seen.get(op) ?? 0) + 1;
    seen.set(op, count);
    for (const fault of request.faults ?? []) {
      if (fault.op !== op || (fault.nth ?? 1) !== count) continue;
      await alter(fault, op, String(args[0]));
      injected = Object.assign(new Error(`${fault.code}: injected, ${syscalls[op]} '${args[0]}'`), { code: fault.code, syscall: syscalls[op], path: String(args[0]) });
      break;
    }
    entry.injected = injected ? injected.code : null;
    try {
      if (injected) throw injected;
      return await original.apply(fs, args);
    } catch (error) {
      entry.error = error.code;
      throw error;
    }
  };
  const originals = { utimes: fs.utimes, mkdir: fs.mkdir, stat: fs.stat, writeFile: fs.writeFile, link: fs.link, unlink: fs.unlink };
  const seconds = (time) => (time instanceof Date ? time.getTime() / 1000 : time);
  fs.utimes = wrap('utimes', originals.utimes, (_, atime, mtime) => ({ atime: seconds(atime), mtime: seconds(mtime) }));
  fs.mkdir = wrap('mkdir', originals.mkdir, (_, options) => ({ recursive: options?.recursive === true }));
  fs.stat = wrap('stat', originals.stat, () => ({}));
  fs.writeFile = wrap('writeFile', originals.writeFile, (_, __, options) => ({ mode: options.mode, flag: options.flag }));
  fs.link = wrap('link', originals.link, (_, to) => ({ dest: relative(to) }));
  fs.unlink = wrap('unlink', originals.unlink, () => ({}));
  const uuids = [...(request.uuids ?? [])];
  crypto.randomUUID = () => uuids.shift() ?? '00000000-0000-4000-8000-000000000000';
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(request.now); }
  };
  return trace;
}

async function trace() {
  const request = JSON.parse((await readStdin()).toString());
  const recorded = record(request);
  let result;
  try {
    result = { oid: await writeLooseObject(path.join(request.root, request.gitDir), request.kind, Buffer.from(request.content), request.format === 'sha256' ? 64 : 40) };
  } catch (error) {
    const relative = typeof error.path === 'string' && error.path.startsWith(`${request.root}/`) ? error.path.slice(request.root.length + 1) : error.path;
    result = { error: { code: error.code, ...(error.syscall ? { syscall: error.syscall } : {}), ...(relative ? { path: relative } : {}) } };
  }
  process.stdout.write(`${JSON.stringify({ result, trace: recorded })}\n`);
}

async function write(gitDir, format) {
  const input = await readStdin();
  const ids = [];
  for (let at = 0; at < input.length;) {
    const end = input.indexOf(10, at);
    const [type, length] = input.subarray(at, end).toString().split(' ');
    const content = input.subarray(end + 1, end + 1 + Number(length));
    at = end + 1 + Number(length);
    ids.push(await writeLooseObject(gitDir, type, content, format === 'sha256' ? 64 : 40));
  }
  process.stdout.write(`${ids.join('\n')}\n`);
}

async function store(gitDir, ref) {
  const opened = await openChangeStore(os.tmpdir(), gitDir, { ref });
  const out = [];
  for await (const row of opened.records()) out.push(JSON.stringify({ key: row.key, oid: row.oid, value: row.value }));
  process.stdout.write(out.length ? `${out.join('\n')}\n` : '');
}

async function entries(gitDir, ref, prefix) {
  const opened = await openChangeStore(os.tmpdir(), gitDir, { ref, listingLimitBytes: 1 });
  const out = [];
  for await (const row of opened.entries(prefix)) out.push(JSON.stringify({ key: row.key, oid: row.oid }));
  process.stdout.write(out.length ? `${out.join('\n')}\n` : '');
}

async function list(gitDir, tree) {
  const args = ['--git-dir', gitDir];
  const oidLength = tree.length;
  const rows = await listTreeRows({ tree, oidLength,
    readTree: async (oid) => { const found = await readGitObject(os.tmpdir(), args, oid); return found?.type === 'tree' ? found.data : null; },
    sizeOf: async (oid) => { const found = await readGitObject(os.tmpdir(), args, oid, { check: true }); return found?.type === 'blob' ? found.size : null; } });
  // One JSON value: null (ask Git) or the rows, each also as `ls-tree -l` text.
  process.stdout.write(`${JSON.stringify(rows && rows.map((row) => ({ ...row, text: listedRowText(row) })))}\n`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'trace') await trace();
else if (mode === 'write') await write(rest[0], rest[1]);
else if (mode === 'store') await store(rest[0], rest[1]);
else if (mode === 'list') await list(rest[0], rest[1]);
else if (mode === 'entries') await entries(rest[0], rest[1], rest[2]);
else { process.stderr.write(`odb-js-arm: unknown mode ${mode}\n`); process.exitCode = 2; }
// Persistent cat-file readers are unreferenced; nothing else keeps the process.
process.exit(process.exitCode ?? 0);
