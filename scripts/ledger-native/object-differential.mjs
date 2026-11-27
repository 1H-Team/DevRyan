// The native ledger's content object store (ledger-native/src/objects.rs,
// durability.rs) against the product's JavaScript
// (lib/session-mutation-files.js, object-durability.js, and `bytesFor` of
// session-mutations.js): both arms run the same requests against
// directories built the same way, each arm's server started with the same
// environment. Arms: Electron's Node running the product's modules (the
// reference) and the Rust (`ledger-native-probe objects`).
//
// Compared, request by request: every result and every error field by field
// (`name`, `message`, `code`, `status`, `errno`, `syscall`), each arm's own
// directory written as `<root>`, and a file's identity and stamp with their
// device, inode and times masked (size and mode kept). After every
// scenario: every entry under the scenario's directory (the project files,
// `objects/`, `verified-objects.v1`, the views): its name (a temporary's
// UUID masked), type, permission bits, size, the SHA-256 of its bytes or
// its link target; for a view's file whether its modification time is the
// object's (a copy of nothing) or the copy's; `verified-objects.v1` as the
// sorted list of its lines, each identity told apart as the object's
// present one or a stale one. Then the system calls per installed object
// (macOS, interposed), the sync shim's log (every platform), a file-size
// limit, and the dual-run crash points `content-object-link:before`,
// `content-object-link:after` and `directory-sync:before`: after a crash at
// each, the disk is the JavaScript's after the same crash, and the next run
// recovers identically.
//
// Every wait has a deadline and names what it waited for; a server that
// stops answering fails the rest at once. Only processes the arms started
// are signalled; the scratch is removed on success and failure (kept with
// --keep-artifacts). A failing comparison prints the platform and both
// arms' raw values.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXTENDED_VARIABLE, LEDGER_PROBE_VARIABLE, buildLedgerBinaries } from '../build-ledger-native.mjs';
import { keepArtifactsRequested, scratchParent } from '../qa/run-root.mjs';
import { referenceRuntime } from './reference-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reference = referenceRuntime();
const extended = process.env[EXTENDED_VARIABLE] === '1';
const STEP_MS = 60_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

let probe = process.env[LEDGER_PROBE_VARIABLE];
let dispose = () => {};
let scratch, baseEnv;
const arms = [];
const where = () => `[${process.platform} ${process.arch}, ${reference.electron ? `Electron ${reference.versions.electron}` : 'system Node'}]`;
const raw = (value) => { const text = JSON.stringify(value); return text.length > 6000 ? `${text.slice(0, 6000)}…` : text; };

/** One arm's server: one JSON line per request, one per answer, each within its deadline. */
function server(name, command, args, env) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered = '', stderr = '';
  const waiting = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      waiting.shift()?.resolve(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => {
    for (const entry of waiting.splice(0)) entry.reject(Object.assign(new Error(`${name} exited (${code ?? signal}) while answering: ${stderr}`), { exit: { code, signal } }));
    resolve({ code, signal });
  }));
  return {
    name,
    exited,
    request(request) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { reject(new Error(`${name} exited (${child.exitCode ?? child.signalCode}): ${stderr}`)); return; }
        const timer = setTimeout(() => reject(new Error(`${name} did not answer ${JSON.stringify(request).slice(0, 300)} within ${STEP_MS / 1000} s`)), STEP_MS);
        waiting.push({ resolve: (line) => { clearTimeout(timer); resolve(JSON.parse(line)); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    close: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    }),
  };
}

/** One arm's server (`js` or `rust`), started with `env` over the run's base environment (`wrap`: a command line around it). */
function startArm(arm, label, env = {}, { jsArgs = [], wrap = [] } = {}) {
  const [command, args] = arm === 'js'
    ? [reference.command, ['--no-warnings', ...jsArgs, path.join(here, 'object-js-arm.mjs')]]
    : [probe, ['objects']];
  const full = wrap.length ? [wrap[0], [...wrap.slice(1), command, ...args]] : [command, args];
  return server(`${label}: ${arm === 'js' ? 'Electron\'s Node' : 'the Rust'}`, full[0], full[1], { ...baseEnv, ...(arm === 'js' ? reference.env : {}), ...env });
}

before(() => {
  if (!probe) { const built = buildLedgerBinaries(); probe = built.binaries.probe; dispose = built.dispose; }
  assert.ok(fs.existsSync(probe), `${probe} does not exist`);
  const parent = scratchParent('ledger-native');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'objects-')));
  baseEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(DEVRYAN_|LEDGER_|GIT_)/.test(key)) baseEnv[key] = value;
  baseEnv.LANG = 'en_US.UTF-8';
  for (const name of ['js', 'rust']) fs.mkdirSync(path.join(scratch, name));
  for (const name of ['js', 'rust']) arms.push({ name, root: path.join(scratch, name), server: startArm(name, 'main') });
  process.stdout.write(`# object differential on ${where()}\n`);
});

after(async () => {
  for (const arm of arms) await arm.server.close();
  if (scratch) {
    const failed = process.exitCode !== undefined && process.exitCode !== 0;
    if (!(failed && keepArtifactsRequested())) fs.rmSync(scratch, { recursive: true, force: true });
  }
  dispose();
});

/** `value` with `<root>` put in for the arm's root. */
function placed(value, root) {
  if (typeof value === 'string') return value.split('<root>').join(root);
  if (Array.isArray(value)) return value.map((item) => placed(item, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, placed(item, root)]));
  return value;
}
/** The arm's root replaced by `<root>`, UUIDs and a file's device, inode and times masked. */
function rooted(value, root) {
  if (typeof value === 'string') {
    const text = value.split(root).join('<root>').replace(UUID, '<uuid>');
    const stamp = /^-?\d+:\d+:(\d+):\d+:\d+(?::(\d+))?$/.exec(text);
    if (stamp) return `<dev>:<ino>:${stamp[1]}:<mtime>:<ctime>${stamp[2] === undefined ? '' : `:${stamp[2]}`}`;
    if (/^-?\d+:\d+$/.test(text)) return '<dev>:<ino>';
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => rooted(item, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rooted(item, root)]));
  return value;
}

/** Sends one request to both arms at once; each answer normalized. */
async function both(request, label, pair = arms) {
  const answers = await Promise.all(pair.map(async (arm) => {
    assert.ok(!arm.stuck, `${arm.name} did not answer before; its later requests are not run`);
    try { return rooted(await arm.server.request(placed(request, arm.root)), arm.root); } catch (error) { arm.stuck = true; throw error; }
  }));
  const [js, rust] = answers;
  assert.ok(!rust.timeout, `${where()} ${label}: the Rust: ${rust.timeout}`);
  assert.deepEqual(rust, js, `${where()} ${label}: the answers differ\n  JavaScript: ${raw(js)}\n  Rust:       ${raw(rust)}`);
  return js;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identityOf = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** What a scenario left on one arm's disk, comparable across arms. */
function diskOf(dir, root) {
  const rows = [];
  const objectStat = (hash) => { try { return fs.statSync(path.join(dir, 'ledger', 'objects', hash), { bigint: true }); } catch { return null; } };
  const walk = (relative) => {
    for (const name of fs.readdirSync(path.join(dir, relative)).sort()) {
      const file = relative ? `${relative}/${name}` : name, full = path.join(dir, file);
      const stat = fs.lstatSync(full, { bigint: true }), shown = file.replace(UUID, '<uuid>'), mode = (Number(stat.mode) & 0o7777).toString(8);
      if (stat.isSymbolicLink()) { const target = fs.readlinkSync(full, { encoding: 'buffer' }); rows.push(`${shown} link ${root && target.includes(root) ? target.toString().split(root).join('<root>') : target.toString('base64')}`); continue; }
      if (stat.isDirectory()) { rows.push(`${shown} dir ${mode}`); walk(file); continue; }
      const bytes = fs.readFileSync(full);
      if (name === 'verified-objects.v1') {
        // A set of lines; each identity is the object's present one or stale.
        const lines = bytes.toString('utf8').split('\n').filter(Boolean).map((line) => {
          const match = /^([a-f0-9]{64}) (\S+)$/.exec(line);
          if (!match) return `raw ${line}`;
          const present = objectStat(match[1]);
          return `${match[1]} ${present && identityOf(present) === match[2] ? 'present' : 'stale'}`;
        }).sort();
        rows.push(`${shown} file ${mode} ${JSON.stringify(lines)}`);
        continue;
      }
      let times = '';
      if (/^view/.test(file)) {
        const object = objectStat(sha(bytes));
        times = object ? ` mtime:${object.mtimeNs === stat.mtimeNs ? 'object' : 'copy'}` : ' mtime:no-object';
      }
      rows.push(`${shown} file ${mode} ${stat.size} ${sha(bytes)}${times}`);
    }
  };
  walk('');
  return rows;
}

/** The scenario's disk is the same on both arms. */
function sameDisk(name, label, pair = arms) {
  const [js, rust] = pair.map((arm) => diskOf(path.join(arm.root, name), arm.root));
  assert.deepEqual(rust, js, `${where()} ${label}: the disks differ\n  JavaScript: ${raw(js)}\n  Rust:       ${raw(rust)}`);
  return js;
}

/** Builds `name` on both arms with `build(dir)` (each arm its own, the same way). */
function prepare(name, build) {
  for (const arm of arms) {
    const dir = path.join(arm.root, name);
    assert.ok(!fs.existsSync(dir), `the scenario directory ${name} is used twice`);
    fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true, mode: 0o700 });
    build(dir);
  }
}
const onBoth = (name, action) => { for (const arm of arms) action(path.join(arm.root, name)); };

/** Deterministic bytes: `length` of them from `seed` (an LCG), as text when `text`. */
function bytesOf(length, seed, { text = false } = {}) {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = text ? 0x20 + (state >>> 24) % 95 : state >>> 24;
  }
  return out;
}

/** The project files the inputs scenarios read: every shape the inputs suite uses. */
function inputFiles(dir) {
  const project = path.join(dir, 'project'), put = (file, bytes, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), bytes, { mode });
    fs.chmodSync(path.join(project, file), mode);
  };
  put('empty.txt', '');
  put('small.txt', 'hello\n');
  put('run.sh', '#!/bin/sh\necho hi\n', 0o755);
  put('odd-mode.txt', 'odd\n', 0o604);
  put('multi.txt', bytesOf(300 * 1024 + 17, 7, { text: true }));
  // A three-byte character across the 128 KiB read boundary: still text.
  const straddle = Buffer.concat([Buffer.alloc(128 * 1024 - 1, 0x61), Buffer.from('€', 'utf8'), Buffer.from('tail\n')]);
  put('straddle.txt', straddle);
  put('truncated.txt', Buffer.from([0x61, 0x62, 0xe2, 0x82]));
  put('nul.bin', Buffer.from([0x61, 0x00, 0x62]));
  put('invalid.bin', Buffer.from([0x61, 0xff, 0x62]));
  put('surrogate.bin', Buffer.from([0xed, 0xa0, 0x80]));
  put('overlong.bin', Buffer.from([0x61, 0xc0, 0xaf]));
  put('beyond.bin', Buffer.from([0xf4, 0x90, 0x80, 0x80]));
  put('four-byte.txt', Buffer.from('a😀b\n', 'utf8'));
  put('binary.bin', bytesOf(4096, 3));
  put('big.txt', Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  put('at-limit.txt', Buffer.alloc(8 * 1024 * 1024, 0x62));
  put('dup-a.txt', 'same bytes\n');
  put('dup-b.txt', 'same bytes\n');
  put('deep/er/file.txt', 'nested\n');
  fs.symlinkSync('small.txt', path.join(project, 'link'));
  fs.symlinkSync(Buffer.from([0x74, 0xff, 0x2f, 0x78]), path.join(project, 'odd-link'));
  fs.symlinkSync('deep', path.join(project, 'dir-link'));
  fs.mkdirSync(path.join(project, 'a-directory'));
}

const inspect = (dir, file, extra = {}) => ({ s: 'inspect', root: `<root>/${dir}/ledger`, directory: `<root>/${dir}/project`, file, ...extra });
const objectsOf = (dir) => `<root>/${dir}/ledger/objects`;

describe('the content object store against the JavaScript', () => {
  test('inputs: every file shape installed, reused and refused the same', async () => {
    const name = 'inputs';
    prepare(name, inputFiles);
    const files = ['empty.txt', 'small.txt', 'run.sh', 'odd-mode.txt', 'multi.txt', 'straddle.txt', 'truncated.txt', 'nul.bin', 'invalid.bin', 'surrogate.bin',
      'overlong.bin', 'beyond.bin', 'four-byte.txt', 'binary.bin', 'big.txt', 'at-limit.txt', 'dup-a.txt', 'dup-b.txt', 'deep/er/file.txt', 'link', 'odd-link', 'dir-link'];
    await both({ op: 'objects', steps: [{ s: 'reset' }, ...files.map((file) => inspect(name, file))] }, 'every shape, installed in turn');
    await both({ op: 'objects', steps: [
      inspect(name, 'missing.txt'), inspect(name, 'small.txt/under-a-file'), inspect(name, 'dir-link/er/file.txt'), inspect(name, '../escape.txt'), inspect(name, 'x/.git/config'),
      inspect(name, 'a-directory'), inspect(name, 'small.txt', { preview: true }), inspect(name, 'new-preview.txt', { preview: true }),
      { s: 'stamp', directory: `<root>/${name}/project`, file: 'small.txt' }, { s: 'stamp', directory: `<root>/${name}/project`, file: 'missing.txt' },
      { s: 'stamp', directory: `<root>/${name}/project`, file: 'small.txt/x' },
      { s: 'space', directory: objectsOf(name), bytes: 1 }, { s: 'space', directory: objectsOf(name), bytes: 2 ** 62 }, { s: 'space', directory: `<root>/${name}/absent`, bytes: 1 },
    ] }, 'absent paths, refusals, previews, stamps and the space probe');
    // Reuse: the same content again, and the same name with another size (a stale object of that name).
    onBoth(name, (dir) => fs.writeFileSync(path.join(dir, 'project', 'again.txt'), 'hello\n'));
    onBoth(name, (dir) => fs.writeFileSync(path.join(dir, 'ledger', 'objects', sha(Buffer.from('short object\n'))), 'short'));
    onBoth(name, (dir) => fs.writeFileSync(path.join(dir, 'project', 'short.txt'), 'short object\n'));
    // A corrupt object of the right size is reused without a check (the JavaScript's rule: name and size).
    onBoth(name, (dir) => fs.writeFileSync(path.join(dir, 'ledger', 'objects', sha(Buffer.from('trusted size\n'))), 'XXXXXXXXXXXX\n'));
    onBoth(name, (dir) => fs.writeFileSync(path.join(dir, 'project', 'trusted.txt'), 'trusted size\n'));
    await both({ op: 'objects', steps: [inspect(name, 'again.txt'), inspect(name, 'short.txt'), inspect(name, 'trusted.txt'), { s: 'sync', root: `<root>/${name}/ledger` }] }, 'reused, replaced and trusted objects');
    // Concurrent installs of one new content (one link wins, the other finds it present) beside another.
    onBoth(name, (dir) => { for (const file of ['c1.txt', 'c2.txt', 'c3.txt']) fs.writeFileSync(path.join(dir, 'project', file), 'concurrent bytes\n'); fs.writeFileSync(path.join(dir, 'project', 'c4.txt'), bytesOf(200 * 1024, 11)); });
    await both({ op: 'objects', steps: [{ s: 'concurrent', steps: ['c1.txt', 'c2.txt', 'c3.txt', 'c4.txt'].map((file) => inspect(name, file)) }] }, 'concurrent installs of the same object');
    await both({ op: 'objects', abort: 'before', steps: [inspect(name, 'small.txt'), inspect(name, 'missing.txt')] }, 'aborted before the call');
    sameDisk(name, 'inputs');
  });

  test('observation changes: a file changed at each stamp check, in either pass, fails observation_changed and leaves nothing', async () => {
    const name = 'changes';
    const cases = ['open', 'eof', 'close'].flatMap((at) => [1, 2].map((nth) => ({ at, nth, file: `changed-${at}-${nth}.txt` })));
    prepare(name, (dir) => { for (const { file } of cases) fs.writeFileSync(path.join(dir, 'project', file), `${file} bytes\n`.repeat(9000)); });
    // Each change is seen at the first check after it: the handle's events
    // and the shim's log (a temporary made, written and removed) say where.
    const steps = [{ s: 'reset' }, { s: 'syncShim', faults: [] }];
    for (const { at, nth, file } of cases) steps.push({ s: 'changeAt', file: `<root>/${name}/project/${file}`, at, nth }, inspect(name, file), { s: 'changeLog' }, inspect(name, file));
    steps.push({ s: 'changeAt', off: true }, { s: 'syncLog' }, { s: 'syncShim', off: true });
    const answer = await both({ op: 'objects', steps }, 'a change at each check');
    cases.forEach(({ at, nth }, index) => assert.equal(answer.ok[3 + index * 4]?.error?.$error?.code, 'observation_changed', `${where()} a change at ${at} #${nth} was not seen: ${raw(answer.ok[3 + index * 4])}`));
    sameDisk(name, 'observation changes');
  });

  test('durability: the sync shim on both handles, faults included', async () => {
    const name = 'durability';
    prepare(name, (dir) => {
      for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']) fs.writeFileSync(path.join(dir, 'project', file), `${file} bytes\n`);
      fs.writeFileSync(path.join(dir, 'project', 'h.txt'), 'g.txt bytes\n');
      fs.mkdirSync(path.join(dir, 'other', 'objects'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'other', 'objects', sha(Buffer.from('a.txt bytes\n'))), 'a.txt bytes\n', { mode: 0o600 });
    });
    const ledger = `<root>/${name}/ledger`, view = `<root>/${name}/view`;
    const segments = [
      [[], [inspect(name, 'a.txt'), { s: 'sync', root: ledger }, { s: 'sync', root: ledger }], [/^sync .*\/\.pending-<uuid> ok$/, /^sync .*\/objects ok$/]],
      [['sync:pending'], [inspect(name, 'b.txt')], [/^sync .*\/\.pending-<uuid> EIO$/, /^close .*\/\.pending-<uuid> ok$/]],
      [['close:pending'], [inspect(name, 'c.txt')], [/^close .*\/\.pending-<uuid> EIO$/]],
      [['sync:objects'], [inspect(name, 'd.txt'), { s: 'sync', root: ledger }, { s: 'sync', root: ledger }], [/^sync .*\/objects EIO$/, /^sync .*\/objects ok$/]],
      [['close:objects'], [inspect(name, 'e.txt'), { s: 'sync', root: ledger }, { s: 'sync', root: ledger }], [/^close .*\/objects EIO$/]],
      [['close:pending', 'close:pending'], [inspect(name, 'f.txt')], [/^close .*\/\.pending-<uuid> EIO$/]],
      [[], [inspect(name, 'g.txt'), inspect(name, 'h.txt'), { s: 'sync', root: ledger }], [/^link .*\/\.pending-<uuid> ok$/]],
      // An object another process linked (never synced by this one): reusing it marks its directory.
      [[], [{ ...inspect(name, 'a.txt'), root: `<root>/${name}/other` }, { s: 'sync', root: `<root>/${name}/other` }], [/^sync .*\/other\/objects ok$/]],
      [[], [{ s: 'copy', root: ledger, entry: { hash: sha(Buffer.from('a.txt bytes\n')), mode: '100644' }, target: `${view}/durable.txt`, mode: 0o644 }], [/^sync .*\.devryan-<uuid> ok$/]],
      [['sync:copy'], [{ s: 'copy', root: ledger, entry: { hash: sha(Buffer.from('a.txt bytes\n')), mode: '100644' }, target: `${view}/failed.txt`, mode: 0o644 }], [/^sync .*\.devryan-<uuid> EIO$/]],
      [['close:copy', 'close:copy'], [{ s: 'copy', root: ledger, entry: { hash: sha(Buffer.from('a.txt bytes\n')), mode: '100644' }, target: `${view}/closed.txt`, mode: 0o644 }], [/^close .*\.devryan-<uuid> EIO$/]],
      [[], [{ s: 'copy', root: ledger, entry: { hash: sha(Buffer.from('a.txt bytes\n')), mode: '100644' }, target: `${view}/disposable.txt`, mode: 0o644, durable: false }], []],
    ];
    const steps = [{ s: 'reset' }];
    for (const [faults, inner] of segments) steps.push({ s: 'syncShim', faults }, ...inner, { s: 'syncLog' });
    steps.push({ s: 'syncShim', off: true });
    const answer = await both({ op: 'objects', steps }, 'syncs through the shim');
    const logs = answer.ok.filter((entry) => Array.isArray(entry.ok)).map((entry) => entry.ok);
    segments.forEach(([faults, , expected], index) => {
      for (const pattern of expected) assert.ok(logs[index].some((line) => pattern.test(line)), `${where()} segment ${index} (faults ${faults.join(', ') || 'none'}): no ${pattern} in ${raw(logs[index])}`);
    });
    sameDisk(name, 'durability');
  });

  test('views: the materializer, copies, verification and verified-objects.v1', async () => {
    const name = 'views';
    const contents = { 'a.txt': 'a\n', 'b.txt': 'bee\n', 'empty.txt': '', 'big.bin': null, 'c.txt': 'corrupt me\n', 'd.txt': 'vanish\n', 'e.txt': 'copied\n' };
    prepare(name, (dir) => {
      fs.writeFileSync(path.join(dir, 'project', 'kill.txt'), 'installed with the kill switch on\n');
      for (const [file, text] of Object.entries(contents)) fs.writeFileSync(path.join(dir, 'project', file), text ?? bytesOf(300 * 1024, 5));
      for (const n of [1, 2, 4, 5, 6]) fs.mkdirSync(path.join(dir, `view${n}`));
      fs.mkdirSync(path.join(dir, 'outside'));
      fs.writeFileSync(path.join(dir, 'view1', 'exists.txt'), 'there before\n');
      fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'view1', 'planted'));
      fs.symlinkSync(path.join(dir, 'outside', 'target'), path.join(dir, 'view1', 'linked.txt'));
    });
    const hash = (file) => sha(contents[file] === null ? bytesOf(300 * 1024, 5) : Buffer.from(contents[file]));
    const entry = (file, mode = '100644') => ({ hash: hash(file), mode });
    const ledger = `<root>/${name}/ledger`, view = (n) => `<root>/${name}/view${n}`;
    const m = (as, n) => ({ s: 'materializer', as, root: ledger, view: view(n) });
    const put = (as, file, ent, mode = 0o644) => ({ s: 'materialize', m: as, file, entry: ent, mode });
    await both({ op: 'objects', steps: [{ s: 'reset' }, ...Object.keys(contents).map((file) => inspect(name, file))] }, 'the objects installed');
    await both({ op: 'objects', steps: [
      { s: 'reset' }, m('m1', 1),
      put('m1', 'a.txt', entry('a.txt')), put('m1', 'dir/b.txt', entry('b.txt'), 0o600), put('m1', 'empty.txt', entry('empty.txt')), put('m1', 'big.bin', entry('big.bin'), 0o755),
      { s: 'concurrent', steps: ['x/y/1.txt', 'x/y/2.txt', 'x/z/3.txt', 'x/4.txt'].map((file) => put('m1', file, entry('a.txt'), 0o640)) },
      put('m1', 'link', entry('a.txt', '120000')), put('m1', 'bad-link', { hash: 'nothex', mode: '120000' }), put('m1', 'exists.txt', entry('a.txt')), put('m1', 'linked.txt', entry('a.txt')),
      put('m1', 'planted/a.txt', entry('a.txt')), put('m1', 'planted/b.txt', entry('b.txt')), put('m1', '../escape.txt', entry('a.txt')), put('m1', 'q.txt', { hash: 'nothex', mode: '100644' }),
      put('m1', 'r.txt', null), put('m1', 's.txt', { mode: '100644' }), put('m1', 'exists.txt/under', entry('a.txt')),
    ] }, 'materialized, deferred and refused');
    // A corrupt object (same size), a vanished one: verification fails them; reset first, as a new process.
    onBoth(name, (dir) => fs.writeFileSync(path.join(dir, 'ledger', 'objects', hash('c.txt')), 'CORRUPT ME\n'));
    onBoth(name, (dir) => fs.rmSync(path.join(dir, 'ledger', 'objects', hash('d.txt'))));
    await both({ op: 'objects', steps: [
      { s: 'reset' }, m('m2', 2),
      put('m2', 'c.txt', entry('c.txt')), put('m2', 'd.txt', entry('d.txt')), put('m2', 'a.txt', entry('a.txt')),
      { s: 'copy', root: ledger, entry: entry('e.txt'), target: `${view(3)}/durable/e.txt`, mode: 0o640 },
      { s: 'copy', root: ledger, entry: entry('e.txt'), target: `${view(3)}/disposable/e.txt`, mode: 0o600, durable: false },
      { s: 'copy', root: ledger, entry: entry('empty.txt'), target: `${view(3)}/disposable/empty.txt`, mode: 0o644, durable: false },
      { s: 'copy', root: ledger, entry: entry('c.txt'), target: `${view(3)}/durable/c.txt`, mode: 0o644 },
      { s: 'copy', root: ledger, entry: entry('c.txt'), target: `${view(3)}/disposable/c.txt`, mode: 0o644, durable: false },
      { s: 'copy', root: ledger, entry: entry('d.txt'), target: `${view(3)}/durable/d.txt`, mode: 0o644 },
      { s: 'copy', root: ledger, entry: null, target: `${view(3)}/null.txt`, mode: 0o644 },
      { s: 'copy', root: ledger, entry: { hash: 'nothex' }, target: `${view(3)}/bad.txt`, mode: 0o644 },
      { s: 'env', set: { DEVRYAN_VIEW_CLONE: '0' } },
      { s: 'copy', root: ledger, entry: entry('b.txt'), target: `${view(3)}/noclone/b.txt`, mode: 0o600, durable: false },
      { s: 'copy', root: ledger, entry: entry('empty.txt'), target: `${view(3)}/noclone/empty.txt`, mode: 0o600, durable: false },
      { s: 'env', set: { DEVRYAN_VIEW_CLONE: null } },
      { s: 'bytes', root: ledger, hash: hash('a.txt') }, { s: 'bytes', root: ledger, hash: hash('c.txt') }, { s: 'bytes', root: ledger, hash: hash('d.txt') },
      { s: 'bytes', root: ledger, hash: 'nothex' }, { s: 'bytes', root: ledger, hash: 7 }, { s: 'bytes', root: ledger, hash: hash('a.txt').toUpperCase() },
    ] }, 'corrupt and vanished objects, durable and disposable copies, bytesFor');
    // A new process: the persisted identities load (no new lines); with the kill switch, a rehash and no append.
    await both({ op: 'objects', steps: [{ s: 'reset' }, m('m4', 4), put('m4', 'a.txt', entry('a.txt')), put('m4', 'b.txt', entry('b.txt')),
      { s: 'env', set: { DEVRYAN_PERSISTENT_OBJECT_VERIFY: '0' } }, { s: 'reset' }, m('m5', 5), put('m5', 'a.txt', entry('a.txt')), inspect(name, 'kill.txt'),
      { s: 'env', set: { DEVRYAN_PERSISTENT_OBJECT_VERIFY: null } }] }, 'persisted identities and the kill switch');
    // Compaction: 1,100 repeated lines for two objects (more than 1,024 and twice the live count).
    onBoth(name, (dir) => {
      const file = path.join(dir, 'ledger', 'verified-objects.v1');
      const lines = [];
      for (let index = 0; index < 1100; index += 1) lines.push(`${hash(index % 2 ? 'a.txt' : 'b.txt')} 1:${index}:2:3:4\n`);
      fs.appendFileSync(file, `${lines.join('')}not a line\n${'f'.repeat(64)} -1:2:3:4:5\n`);
    });
    await both({ op: 'objects', steps: [{ s: 'reset' }, m('m6', 6), put('m6', 'a.txt', entry('a.txt'))] }, 'verified-objects.v1 compacted');
    sameDisk(name, 'views');
  });

  test('job order: where no I/O intervenes, every call settles after the JavaScript\'s jobs, and an abort is seen at the next check', async () => {
    const name = 'order';
    prepare(name, (dir) => { fs.writeFileSync(path.join(dir, 'project', 'a.txt'), 'a\n'); fs.mkdirSync(path.join(dir, 'view')); fs.writeFileSync(path.join(dir, 'view', 'file'), 'x'); });
    const ledger = `<root>/${name}/ledger`, ticks = Array.from({ length: 9 }, (_, n) => ({ s: 'ticks', n }));
    const entry = { hash: sha(Buffer.from('a\n')), mode: '100644' };
    const put = (file, ent = entry) => ({ s: 'materialize', m: 'o', file, entry: ent, mode: 0o644 });
    const answer = await both({ op: 'objects', steps: [
      { s: 'reset' }, inspect(name, 'a.txt'), { s: 'materializer', as: 'o', root: ledger, view: `<root>/${name}/view` }, put('file/under'),
      { s: 'settleOrder', steps: [...ticks, inspect(name, '../x'), { s: 'stamp', directory: `<root>/${name}/project`, file: '../x' }, put('../x'), put('q', { hash: 'x' }), put('l', { ...entry, mode: '120000' }), put('l2', { hash: 'x', mode: '120000' }),
        put('file/again'), { s: 'copy', root: ledger, entry: null, target: `<root>/${name}/t`, mode: 0o644 }, { s: 'bytes', root: ledger, hash: 'x' }, { s: 'sync', root: ledger }, { s: 'sync', root: `<root>/${name}/elsewhere` }] },
      { s: 'settleOrder', steps: [...ticks, inspect(name, 'a.txt'), { s: 'abort' }] },
    ] }, 'settle orders against chains of 0 to 8 jobs');
    assert.ok(Array.isArray(answer.ok?.[4]?.ok) && answer.ok[4].ok.length === 20, `${where()} no settle order: ${raw(answer)}`);
    // An abort while an object is verified: seen in the read stream's loop, which is closed.
    const aborted = await both({ op: 'objects', steps: [{ s: 'reset' }, { s: 'materializer', as: 'v', root: ledger, view: `<root>/${name}/view` },
      { s: 'settleOrder', steps: [{ s: 'materialize', m: 'v', file: 'verified.txt', entry, mode: 0o644 }, { s: 'abort' }] }, { s: 'materialize', m: 'v', file: 'after.txt', entry, mode: 0o644 }] }, 'an abort during a verification');
    assert.equal(aborted.ok?.[3]?.error?.$error?.code, 'call_aborted', `${where()} the abort was not seen: ${raw(aborted)}`);
    // A view path that is not normalized: the directory chain reaches `/`, whose parent is itself.
    await both({ op: 'objects', steps: [{ s: 'materializer', as: 'slash', root: ledger, view: `<root>/${name}/view/` }, { s: 'materialize', m: 'slash', file: 'x/y.txt', entry, mode: 0o644 }] }, 'a view path with a trailing slash');
    sameDisk(name, 'job order');
  });

  test('a full disk, as a file-size limit: the write fails and nothing is left', async () => {
    const name = 'full';
    prepare(name, (dir) => { fs.writeFileSync(path.join(dir, 'project', 'big.txt'), bytesOf(100 * 1024, 9, { text: true })); fs.writeFileSync(path.join(dir, 'project', 'small.txt'), 'fits\n'); });
    // 64 blocks of 512 bytes; SIGXFSZ ignored (Node ignores it itself), so the write fails with EFBIG.
    const wrap = ['/bin/sh', '-c', 'trap "" XFSZ; ulimit -f 64; exec "$@"', 'sh'];
    const pair = arms.map((arm) => ({ name: arm.name, root: arm.root, server: startArm(arm.name, 'a 32 KiB file-size limit', {}, { wrap }) }));
    try {
      await both({ op: 'objects', steps: [{ s: 'reset' }, inspect(name, 'big.txt'), inspect(name, 'small.txt')] }, 'past the file-size limit', pair);
    } finally { for (const arm of pair) await arm.server.close(); }
    sameDisk(name, 'full');
  });

  test('system calls per installed object and per directory sync are the JavaScript\'s (macOS, interposed)', { skip: process.platform !== 'darwin' && 'DYLD interposition exists only on macOS; the sync shim covers the syncs on every platform' }, async () => {
    const library = path.join(scratch, 'trace-interpose.dylib');
    const built = spawnSync('cc', ['-O1', '-dynamiclib', '-o', library, path.join(here, 'trace-interpose.c')], { encoding: 'utf8' });
    assert.equal(built.status, 0, `cc could not build the interposer: ${built.stderr}`);
    for (const fail of ['', 'fullfsync', 'fullfsync,barrier,fsync']) {
      const name = `traced-${fail.replace(/[^a-z]+/g, '-') || 'plain'}`;
      const changes = [['eof', 1], ['eof', 2], ['close', 1], ['open', 2]];
      prepare(name, (dir) => {
        fs.writeFileSync(path.join(dir, 'project', 'new.txt'), bytesOf(200 * 1024, 2)); fs.writeFileSync(path.join(dir, 'project', 'same.txt'), bytesOf(200 * 1024, 2)); fs.writeFileSync(path.join(dir, 'project', 'other.txt'), 'other\n');
        for (const [at, nth] of changes) fs.writeFileSync(path.join(dir, 'project', `changed-${at}-${nth}.txt`), `${at} ${nth}\n`.repeat(30000));
      });
      const changed = changes.flatMap(([at, nth]) => [{ s: 'changeAt', file: `<root>/${name}/project/changed-${at}-${nth}.txt`, at, nth }, inspect(name, `changed-${at}-${nth}.txt`)]);
      const traces = {};
      // One traced server at a time.
      for (const arm of arms) {
        const out = path.join(scratch, `${name}-${arm.name}.trace`);
        const env = { DYLD_INSERT_LIBRARIES: library, LEDGER_TRACE_OUT: out, LEDGER_TRACE_FILTER: `${arm.root}/${name}/`, ...(fail ? { LEDGER_TRACE_FAIL: fail } : {}) };
        const traced = startArm(arm.name, `traced ${name}`, env);
        let answer;
        try {
          const entry = { hash: sha(Buffer.from('other\n')), mode: '100644' };
          answer = rooted(await traced.request(placed({ op: 'objects', steps: [{ s: 'reset' }, inspect(name, 'new.txt'), inspect(name, 'same.txt'), { s: 'sync', root: `<root>/${name}/ledger` }, inspect(name, 'other.txt'), { s: 'sync', root: `<root>/${name}/ledger` },
            { s: 'copy', root: `<root>/${name}/ledger`, entry, target: `<root>/${name}/out/durable.txt`, mode: 0o640 }, { s: 'copy', root: `<root>/${name}/ledger`, entry, target: `<root>/${name}/out/disposable.txt`, mode: 0o600, durable: false },
            ...changed, { s: 'changeAt', off: true }] }, arm.root)), arm.root);
        } finally { await traced.close(); }
        traces[arm.name] = { answer, calls: callsOf(fs.readFileSync(out, 'utf8'), `${arm.root}/${name}`) };
        fs.rmSync(out, { force: true });
      }
      const { js, rust } = traces;
      assert.deepEqual(rust.answer, js.answer, `${where()} ${name}: the answers differ\n  JavaScript: ${raw(js.answer)}\n  Rust:       ${raw(rust.answer)}`);
      assert.ok(js.calls.some((line) => (fail.split(',').includes('fsync') ? /^fsync #.*\.pending-<uuid> = -1 / : /^link .*\.pending-<uuid> /).test(line)), `${where()} ${name}: the JavaScript's installs were not traced: ${raw(js.calls)}`);
      assert.deepEqual(rust.calls, js.calls, `${where()} ${name}: the system calls differ\n  JavaScript: ${raw(js.calls)}\n  Rust:       ${raw(rust.calls)}`);
    }
  });

  for (const point of ['content-object-link:before', 'content-object-link:after', 'directory-sync:before']) {
    test(`a crash at ${point} leaves the JavaScript's disk, and the next run recovers the same`, async () => {
      const name = `crash-${point.replace(/[^a-z]+/g, '-')}`;
      prepare(name, (dir) => { fs.writeFileSync(path.join(dir, 'project', 'new.txt'), 'crash bytes\n'); fs.writeFileSync(path.join(dir, 'project', 'next.txt'), 'after the crash\n'); });
      const markers = Object.fromEntries(arms.map((arm) => [arm.name, path.join(scratch, `${name}-${arm.name}.marker`)]));
      const crashed = {};
      for (const arm of arms) {
        const env = { LEDGER_DUAL_RUN_CRASH: JSON.stringify({ point, nth: 1, action: 'kill', marker: markers[arm.name] }), LEDGER_DUAL_RUN_LEDGER_PROCESS: '1' };
        const victim = startArm(arm.name, `crash at ${point}`, env, { jsArgs: ['--require', path.join(here, '..', 'ledger-dual-run', 'ledger-preload.cjs')] });
        const outcome = await victim.request(placed({ op: 'objects', steps: [{ s: 'reset' }, inspect(name, 'new.txt'), { s: 'sync', root: `<root>/${name}/ledger` }] }, arm.root)).then((answer) => ({ answer }), (error) => ({ error }));
        let timer;
        const exit = await Promise.race([victim.exited, new Promise((resolve) => { timer = setTimeout(() => resolve('still running'), STEP_MS); })]);
        clearTimeout(timer);
        if (exit === 'still running') await victim.close();
        crashed[arm.name] = { exit, answered: outcome.answer ?? null, marker: fs.existsSync(markers[arm.name]) ? JSON.parse(fs.readFileSync(markers[arm.name], 'utf8')).point : null };
      }
      for (const arm of arms) {
        assert.equal(crashed[arm.name].marker, point, `${where()} ${arm.name} did not reach ${point}: ${raw(crashed[arm.name])}`);
        assert.equal(crashed[arm.name].exit?.signal, 'SIGKILL', `${where()} ${arm.name} was not killed at ${point}: ${raw(crashed[arm.name])}`);
      }
      sameDisk(name, `after the crash at ${point}`);
      onBoth(name, (dir) => fs.mkdirSync(path.join(dir, 'view')));
      await both({ op: 'objects', steps: [{ s: 'reset' }, inspect(name, 'new.txt'), inspect(name, 'next.txt'), { s: 'sync', root: `<root>/${name}/ledger` },
        { s: 'materializer', as: name, root: `<root>/${name}/ledger`, view: `<root>/${name}/view` }, { s: 'materialize', m: name, file: 'new.txt', entry: { hash: sha(Buffer.from('crash bytes\n')), mode: '100644' }, mode: 0o644 }] }, `the run after the crash at ${point}`);
      sameDisk(name, `recovered after the crash at ${point}`);
    });
  }

  test('extended: seeded files of random shapes and sizes, installed and copied the same', { skip: !extended && 'the extended run only' }, async () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      const name = `seeded-${seed}`;
      const files = [];
      let state = seed;
      const next = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state; };
      for (let index = 0; index < 24; index += 1) {
        const length = [0, 1, 4095, 4096, 128 * 1024 - 1, 128 * 1024, 128 * 1024 + 1, 700 * 1024][next() % 8];
        files.push({ file: `d${next() % 3}/f${index}.${next() % 2 ? 'bin' : 'txt'}`, bytes: bytesOf(length, next() % 4, { text: next() % 2 === 0 }) });
      }
      prepare(name, (dir) => { fs.mkdirSync(path.join(dir, 'view')); for (const { file, bytes } of files) { fs.mkdirSync(path.dirname(path.join(dir, 'project', file)), { recursive: true }); fs.writeFileSync(path.join(dir, 'project', file), bytes); } });
      await both({ op: 'objects', steps: [{ s: 'reset' }, { s: 'concurrent', steps: files.map(({ file }) => inspect(name, file)) }, { s: 'sync', root: `<root>/${name}/ledger` },
        { s: 'materializer', as: name, root: `<root>/${name}/ledger`, view: `<root>/${name}/view` },
        { s: 'concurrent', steps: files.map(({ file, bytes }) => ({ s: 'materialize', m: name, file, entry: { hash: sha(bytes), mode: '100644' }, mode: 0o644 })) }] }, `seeded ${seed}`);
      sameDisk(name, `seeded ${seed}`);
    }
  });
});

/**
 * The calls a traced server made under the scenario's directory, in order,
 * comparable across arms: descriptors named by their paths, a temporary's
 * UUID masked, the directory written `<dir>`, the lengths of the writes kept.
 */
function callsOf(text, dir) {
  const names = new Map();
  const out = [];
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const fd = /^fd (\d+) (.*)$/.exec(line);
    if (fd) { names.set(fd[1], fd[2]); continue; }
    out.push(line.replace(/#(\d+)/, (_, number) => `#${names.get(number) ?? number}`).split(dir).join('<dir>').replace(UUID, '<uuid>'));
  }
  return out;
}
