// The native ledger's Git runner and change store (ledger-native/src/git.rs,
// store.rs, durability.rs) against the product's JavaScript
// (lib/session-changes-git.js, session-changes-store.js): both arms run the
// same requests against copies of the same starting repositories, in
// directories of the same shape, each arm's server started with the same
// environment and a `git` shim first on PATH that logs every Git command it
// starts. Arms: Electron's Node running the product's modules (the
// reference) and the Rust (`ledger-native-probe store`).
//
// Compared, request by request: every result and every error field by field
// (`name`, `message`, `code`, `status`, `command`, `failure`, `errno`,
// `syscall`, `committed`, `rollbackFailed`, `errors`; a JSON `SyntaxError`'s
// message is V8's own and is left out), and the Git processes each arm
// started (arguments, as a multiset, and in order where one process starts
// after another: not where a request runs steps concurrently, and not for
// `hash-object`, which the index path starts while `update-index` runs). The JavaScript's persistent `cat-file` readers are left out
// of its census: the Rust reads those objects in-process and starts a
// `cat-file` only when its object database asks Git, which the named cases
// that need it count. After every store scenario: the refs, every object by
// id and content (`cat-file --batch-all-objects`; zlib bytes may differ),
// `git fsck --strict --full` on both arms, every file under the store's
// directory outside `objects/` (Git's index files by name only), and each
// arm's store read back by the other arm (`records()` of a fresh store).
//
// The gate runs the named cases on every switch setting for sha1 and on four
// for sha256, the large tree (sha1) on two, and one seeded script per
// setting so run; the extended run (LEDGER_NATIVE_ODB_EXTENDED=1) every case
// on every setting of both formats and 12 scripts per setting and format. Every wait has a deadline and names what it waited
// for; a server that stops answering fails the rest at once. Only processes
// the arms started are signalled; the scratch is removed on success and
// failure (kept with --keep-artifacts).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXTENDED_VARIABLE, LEDGER_PROBE_VARIABLE, buildLedgerBinaries } from '../build-ledger-native.mjs';
import { keepArtifactsRequested, scratchParent } from '../qa/run-root.mjs';
import { referenceRuntime } from './reference-runtime.mjs';
import { EXIT_CODES, FAKE_GITS, SETTINGS, STDERR_CLASSES, SWITCHES, generateScript } from './store-spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reference = referenceRuntime();
const extended = process.env[EXTENDED_VARIABLE] === '1';
const SCRIPTS_PER_SETTING = extended ? 12 : 1;
/** The settings sha256 runs in the gate (sha1 runs every one); the extended run gives sha256 every one too. */
const SHA256_GATE = new Set(['default', 'index', 'paged', 'no-reader']);
const settingsFor = (format) => (extended || format === 'sha1' ? SETTINGS : SETTINGS.filter((setting) => SHA256_GATE.has(setting.name)));
const STEP_MS = 60_000;
const GIT_MS = 30_000;

let probe = process.env[LEDGER_PROBE_VARIABLE];
let dispose = () => {};
let scratch, realGit, cleanEnv, basePath;
/** The installed Git: its version and how it answers a gitlink whose commit is absent (`submodule` since 2.51, `missing` before). */
const installed = { version: '?', gitlink: '?' };
const arms = [];
/** Where a failure happened: the platform and the installed Git, for every failing comparison. */
const where = () => `[${process.platform} ${process.arch}, ${installed.version}, gitlink answer '${installed.gitlink}']`;
const raw = (value) => { const text = JSON.stringify(value); return text.length > 6000 ? `${text.slice(0, 6000)}…` : text; };

/** A clean environment for Git: no inherited GIT_*, a private HOME, no system or global configuration. */
function gitEnvironment(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(GIT_|XDG_|LC_|LANG)/.test(key)) env[key] = value;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
}

/** Runs the real Git (setup and checks), within its deadline. */
function gitSync(args, { cwd = scratch, input, allowFail = false } = {}) {
  const result = spawnSync(realGit, args, { cwd, env: cleanEnv, input, timeout: GIT_MS, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} exited ${result.status ?? result.signal}: ${result.stderr.toString().slice(-2000)}`);
  return result;
}
const gitText = (args, options) => gitSync(args, options).stdout.toString().trim();

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
  child.on('exit', (code, signal) => { for (const entry of waiting.splice(0)) entry.reject(new Error(`${name} exited (${code ?? signal}) while answering: ${stderr}`)); });
  return {
    name,
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
      child.once('exit', () => resolve());
      child.stdin.end();
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }),
  };
}

// `hash-object --stdin-paths` is logged with how many paths it was given (the
// index path's batches of 128).
const SHIM = (real) => `#!/bin/sh
case "$*" in
  *hash-object*--stdin-paths*)
    input=$(cat)
    if [ -n "$LEDGER_STORE_GIT_LOG" ]; then printf '%s <%s paths>\\n' "$*" "$(printf '%s\\n' "$input" | wc -l | tr -d ' ')" >> "$LEDGER_STORE_GIT_LOG"; fi
    printf '%s\\n' "$input" | exec '${real}' "$@" ;;
esac
if [ -n "$LEDGER_STORE_GIT_LOG" ]; then printf '%s\\n' "$*" >> "$LEDGER_STORE_GIT_LOG"; fi
exec '${real}' "$@"
`;

before(() => {
  if (!probe) { const built = buildLedgerBinaries(); probe = built.binaries.probe; dispose = built.dispose; }
  assert.ok(fs.existsSync(probe), `${probe} does not exist`);
  const parent = scratchParent('ledger-native');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'store-')));
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  cleanEnv = gitEnvironment(home);
  realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { env: cleanEnv, encoding: 'utf8' }).stdout.trim();
  assert.ok(realGit && !realGit.includes("'"), `git not found (${realGit})`);
  const bin = path.join(scratch, 'bin'), fake = path.join(scratch, 'fake');
  fs.mkdirSync(bin); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(bin, 'git'), SHIM(realGit), { mode: 0o755 });
  for (const [name, body] of Object.entries(FAKE_GITS)) {
    fs.mkdirSync(path.join(fake, name));
    fs.writeFileSync(path.join(fake, name, 'git'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  for (const name of ['js', 'rust']) fs.mkdirSync(path.join(scratch, name));
  // The servers inherit a Git environment the runner must scrub.
  // The installed Git's answer for a gitlink whose commit is absent, probed once (S4).
  installed.version = spawnSync(realGit, ['--version'], { env: cleanEnv, encoding: 'utf8' }).stdout.trim();
  {
    const probeDir = path.join(scratch, 'gitlink-probe');
    gitSync(['init', '--bare', '--quiet', probeDir]);
    const tree = gitText(['--git-dir', probeDir, 'mktree', '--missing'], { input: `160000 commit ${'ab'.repeat(20)}\tsub\n` });
    const answer = gitText(['--git-dir', probeDir, 'cat-file', '--batch-check'], { input: `${tree}:sub\n` });
    installed.gitlink = answer.endsWith(' submodule') ? 'submodule' : answer.endsWith(' missing') ? 'missing' : answer;
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
  process.stdout.write(`# store differential on ${where()}\n`);
  basePath = `${bin}:${cleanEnv.PATH ?? '/usr/bin:/bin'}`;
  const base = { ...cleanEnv, PATH: basePath, LANG: 'en_US.UTF-8', GIT_DIR: '/nonexistent-git-dir', GIT_WORK_TREE: '/nonexistent-work-tree', GIT_INDEX_FILE: '/nonexistent-index' };
  for (const name of SWITCHES) delete base[name];
  arms.push({ name: 'js', root: path.join(scratch, 'js'), log: path.join(scratch, 'js.log'),
    server: server('Electron\'s Node', reference.command, ['--no-warnings', path.join(here, 'store-js-arm.mjs')], { ...base, ...reference.env, LEDGER_STORE_GIT_LOG: path.join(scratch, 'js.log') }) });
  arms.push({ name: 'rust', root: path.join(scratch, 'rust'), log: path.join(scratch, 'rust.log'),
    server: server('the Rust', probe, ['store'], { ...base, LEDGER_STORE_GIT_LOG: path.join(scratch, 'rust.log') }) });
  for (const arm of arms) fs.writeFileSync(arm.log, '');
});

after(async () => {
  for (const arm of arms) await arm.server.close();
  // A case's grandchild (its pid in a file of the scratch) is the run's own.
  if (scratch) {
    for (const file of walk(scratch).filter((entry) => entry.endsWith('.pid'))) {
      const pid = Number(fs.readFileSync(path.join(scratch, file), 'utf8'));
      if (Number.isInteger(pid) && pid > 1) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    const failed = process.exitCode !== undefined && process.exitCode !== 0;
    if (!(failed && keepArtifactsRequested())) fs.rmSync(scratch, { recursive: true, force: true });
  }
  dispose();
});

/** Every file under `dir`, relative. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...walk(dir, relative)); else out.push(relative);
  }
  return out.sort();
}

/** `value` with `<root>` and `<fake>` put in for the arm. */
function placed(value, arm) {
  if (typeof value === 'string') return value.split('<root>').join(arm.root).split('<fake>').join(path.join(scratch, 'fake'));
  if (Array.isArray(value)) return value.map((item) => placed(item, arm));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, placed(item, arm)]));
  return value;
}
/** The arm's directories replaced by `<root>`/`<fake>` in every string. */
function rooted(value, arm) {
  if (typeof value === 'string') return value.split(arm.root).join('<root>').split(path.join(scratch, 'fake')).join('<fake>');
  if (Array.isArray(value)) return value.map((item) => rooted(item, arm));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rooted(item, arm)]));
  return value;
}

/** The Git commands an arm started since `from` (bytes of its log), its persistent readers left out. */
function census(arm, from, { readers }) {
  const text = fs.readFileSync(arm.log, 'utf8').slice(from);
  const lines = text.split('\n').filter(Boolean).map((line) => rooted(line, arm));
  const reader = (line) => / cat-file --batch(-check)?$/.test(line);
  return { commands: readers ? lines.filter((line) => !reader(line)) : lines, handedBack: readers ? lines.filter(reader) : [] };
}

/** Sends one request to both arms at once: each arm's answer and census, normalized (persistent readers only in reads and store scenarios). */
async function both(request, { readers = ['read', 'store'].includes(request.op) } = {}) {
  const results = await Promise.all(arms.map(async (arm) => {
    assert.ok(!arm.stuck, `${arm.name} did not answer before; its later requests are not run`);
    const from = fs.statSync(arm.log).size;
    let answer;
    try { answer = await arm.server.request(placed(request, arm)); } catch (error) { arm.stuck = true; throw error; }
    return { answer: rooted(answer, arm), census: census(arm, from, { readers }) };
  }));
  const [js, rust] = results;
  assert.ok(!rust.answer.timeout, `the Rust: ${rust.answer.timeout}`);
  return { js, rust };
}

const sorted = (items) => [...items].sort();
/** A runner request. */
const call = (op, args, extra = {}) => ({ op, cwd: '<root>', args, ...extra });
/** A switch setting by name. */
const settingOf = (name) => SETTINGS.find((entry) => entry.name === name) ?? assert.fail(`no setting ${name}`);

/** Both arms gave the same answer and started the same Git commands. */
function same({ js, rust }, label, { unordered = false, handedBack } = {}) {
  assert.deepEqual(rust.answer, js.answer, `${where()} ${label}: the answers differ\n  JavaScript: ${raw(js.answer)}\n  Rust:       ${raw(rust.answer)}`);
  assert.deepEqual(sorted(rust.census.commands), sorted(js.census.commands), `${where()} ${label}: the Git commands differ\n  JavaScript: ${raw(js.census.commands)}\n  Rust:       ${raw(rust.census.commands)}`);
  // Order: exact, but for `hash-object`, which starts while `update-index`
  // reads its input (the shim logs when each process runs: arrival's).
  const ordered = (commands) => commands.filter((command) => !/ hash-object /.test(command));
  if (!unordered) assert.deepEqual(ordered(rust.census.commands), ordered(js.census.commands), `${where()} ${label}: the Git commands' order differs`);
  if (handedBack !== undefined) assert.equal(rust.census.handedBack.length, handedBack, `${where()} ${label}: the Rust asked Git ${rust.census.handedBack.length} times (${rust.census.handedBack.join('; ')})`);
}

/** Makes the same directory on both arms: `build(dir)` once in a template, copied. */
function prepare(name, build) {
  const template = path.join(scratch, 'template', name);
  fs.mkdirSync(template, { recursive: true });
  build(template);
  for (const arm of arms) {
    assert.ok(!fs.existsSync(path.join(arm.root, name)), `the scenario directory ${name} is used twice`);
    fs.cpSync(template, path.join(arm.root, name), { recursive: true });
  }
  fs.rmSync(template, { recursive: true, force: true });
}

const blobOf = (gitDir, text) => gitText(['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], { input: text });
/** A tree from `{name: blob id | {mode, oid} | nested object}`. */
function treeOf(gitDir, entries) {
  const lines = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry === 'string') lines.push(`100644 blob ${entry}\t${name}`);
    else if (entry.mode) lines.push(`${entry.mode} ${entry.mode === '160000' ? 'commit' : 'blob'} ${entry.oid}\t${name}`);
    else lines.push(`040000 tree ${treeOf(gitDir, entry)}\t${name}`);
  }
  return gitText(['--git-dir', gitDir, 'mktree', '--missing'], { input: `${lines.join('\n')}\n` });
}

/** A ledger-shaped repository: `git/` (bare) with records under a few prefixes, its state ref set. */
function ledger(dir, format, { records = {}, packed = false, gitlink = false } = {}) {
  const gitDir = path.join(dir, 'git');
  gitSync(['init', '--bare', '--quiet', `--object-format=${format}`, gitDir]);
  if (!Object.keys(records).length) return gitDir;
  // Every blob in one `hash-object --stdin-paths`.
  const entries = Object.entries(records), staged = path.join(dir, 'staged-blobs');
  fs.mkdirSync(staged);
  entries.forEach(([, data], index) => fs.writeFileSync(path.join(staged, String(index)), data));
  const oids = gitText(['--git-dir', gitDir, 'hash-object', '-w', '--stdin-paths'], { input: `${entries.map((_, index) => path.join(staged, String(index))).join('\n')}\n` }).split('\n');
  fs.rmSync(staged, { recursive: true, force: true });
  const nested = {};
  entries.forEach(([key], index) => {
    const parts = key.split('/');
    let node = nested;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = oids[index];
  });
  if (gitlink) nested.sub = { mode: '160000', oid: format === 'sha256' ? 'ab'.repeat(32) : 'ab'.repeat(20) };
  const tree = treeOf(gitDir, nested);
  gitSync(['--git-dir', gitDir, 'update-ref', 'refs/devryan/state', tree]);
  if (packed) gitSync(['--git-dir', gitDir, 'repack', '-a', '-d', '-q']);
  return gitDir;
}

/** What a scenario left on one arm's disk, comparable across arms. */
function diskOf(arm, name) {
  const dir = path.join(arm.root, name), gitDir = path.join(dir, 'git');
  const refs = gitText(['--git-dir', gitDir, 'for-each-ref', '--format=%(refname) %(objectname)']);
  const objects = gitSync(['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch']).stdout;
  const fsck = gitSync(['--git-dir', gitDir, 'fsck', '--strict', '--full', '--no-dangling'], { allowFail: true });
  const files = walk(dir).filter((file) => !file.startsWith(`git${path.sep}objects${path.sep}`)).map((file) => {
    const shown = file.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
    const stat = fs.lstatSync(path.join(dir, file));
    // Git's index files hold stat data of their own writer: by name only.
    if (/metadata-index$|(^|\/)index$/.test(file)) return `${shown} ${(stat.mode & 0o777).toString(8)}`;
    return `${shown} ${(stat.mode & 0o777).toString(8)} ${fs.readFileSync(path.join(dir, file)).toString('base64')}`;
  });
  return { refs, objects: objects.toString('base64'), fsck: { status: fsck.status, out: fsck.stdout.toString() + fsck.stderr.toString() }, files };
}

/** The scenario's disk is the same on both arms, Git accepts both, and each arm reads the other's store. */
async function sameDisk(name, label) {
  const [js, rust] = arms.map((arm) => diskOf(arm, name));
  assert.equal(rust.fsck.status, 0, `${where()} ${label}: git fsck refuses what the Rust wrote: ${rust.fsck.out}`);
  assert.equal(js.fsck.status, 0, `${where()} ${label}: git fsck refuses what the JavaScript wrote: ${js.fsck.out}`);
  assert.equal(rust.refs, js.refs, `${where()} ${label}: the refs differ`);
  assert.equal(rust.objects, js.objects, `${where()} ${label}: the objects differ (by id and content)`);
  assert.deepEqual(rust.files, js.files, `${where()} ${label}: the files differ`);
  // Cross-read: each arm reads the other arm's ledger.
  const read = (arm, other) => arm.server.request({ op: 'store', id: `${name}:cross:${arm.name}`, steps: [
    { s: 'open', as: 'x', cwd: path.join(other.root, name), gitDir: path.join(other.root, name, 'git') },
    { s: 'records', st: 'x' },
  ] }).then((answer) => rooted(rooted(answer, other), arm));
  const [jsReadsRust, rustReadsJs] = await Promise.all([read(arms[0], arms[1]), read(arms[1], arms[0])]);
  assert.deepEqual(jsReadsRust, rustReadsJs, `${where()} ${label}: the cross-reads differ\n  JavaScript reads the Rust's: ${raw(jsReadsRust)}\n  Rust reads the JavaScript's: ${raw(rustReadsJs)}`);
}

const env = (set) => both({ op: 'env', set }, { readers: false });
const clearSwitches = () => env(Object.fromEntries(SWITCHES.map((name) => [name, null])));

// --- The runner -----------------------------------------------------------

describe('the Git runner', () => {
  const formats = ['sha1', 'sha256'];
  let repos;
  before(() => {
    repos = {};
    for (const format of formats) {
      const name = `runner-${format}`;
      prepare(name, (dir) => ledger(dir, format, { records: { 'a/x.json': '{"x":1}', 'a/y.json': '[1,2]', 'b/z.json': '"z"', 'big/blob.json': JSON.stringify('q'.repeat(600_000)) }, gitlink: true }));
      repos[format] = name;
    }
  });
  const gitDirOf = (format) => `<root>/${repos[format]}/git`;

  for (const format of formats) {
    test(`git(): stdout, limits, statuses, classes and the scrubbed environment (${format})`, async () => {
      const gitDir = gitDirOf(format);
      const tree = (await both(call('git', ['--git-dir', gitDir, 'rev-parse', 'refs/devryan/state']))).js.answer;
      assert.ok(tree.ok?.$bytes, `rev-parse gave ${JSON.stringify(tree)}`);
      const cases = [
        ['rev-parse', ['--git-dir', gitDir, 'rev-parse', '--show-object-format']],
        ['ls-tree', ['--git-dir', gitDir, 'ls-tree', '-r', '-l', '-z', 'refs/devryan/state']],
        ['cat-file input', ['--git-dir', gitDir, 'cat-file', '--batch'], { options: { input: 'refs/devryan/state:a/x.json\nrefs/devryan/state:none\n' } }],
        ['a limit exceeded', ['--git-dir', gitDir, 'cat-file', '-p', 'refs/devryan/state:big/blob.json'], { options: { limit: 1000 } }],
        ['a limit kept', ['--git-dir', gitDir, 'cat-file', '-p', 'refs/devryan/state:big/blob.json'], { options: { limit: 8 * 1024 * 1024 } }],
        ['a limit equal to the output', ['--git-dir', gitDir, 'cat-file', '-p', 'refs/devryan/state:a/x.json'], { options: { limit: 7 } }],
        ['a limit one under the output', ['--git-dir', gitDir, 'cat-file', '-p', 'refs/devryan/state:a/x.json'], { options: { limit: 6 } }],
        ['global options before a failing command', ['-C', '<root>', '-c', 'a.b=c', '--namespace', 'n', '--work-tree', '<root>', '--git-dir', gitDir, 'nosuchcommand']],
        ['not a repository', ['--git-dir', '<root>/none', 'rev-parse', 'HEAD']],
        ['a bad name', ['--git-dir', gitDir, 'cat-file', '-p', 'f'.repeat(format === 'sha1' ? 40 : 64)]],
        ['exit 1 refused', ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', 'refs/none']],
        ['exit 1 accepted', ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', 'refs/none'], { options: { acceptExitCodes: [1] } }],
        ['an unknown subcommand', ['--git-dir', gitDir, 'nosuchcommand']],
        ['global options before the command', ['-c', 'a.b=c', '--git-dir', gitDir, '-C', '<root>', 'rev-parse', '--is-bare-repository']],
        ['an odd command word', ['--git-dir', gitDir, 'Rev-Parse']],
        ['no command word', ['--version', '--git-dir']],
      ];
      for (const [label, args, extra] of cases) same(await both(call('git', args, extra)), `${format} ${label}`);
    });
  }

  test('git(): a lock, an abort before the call and by a timer, a timeout, a killed Git', async () => {
    const gitDir = gitDirOf('sha1');
    const tree = gitText(['--git-dir', path.join(arms[0].root, repos.sha1, 'git'), 'rev-parse', 'refs/devryan/state']);
    for (const arm of arms) fs.writeFileSync(path.join(arm.root, repos.sha1, 'git', 'refs', 'devryan', 'state.lock'), '');
    same(await both(call('git', ['--git-dir', gitDir, 'update-ref', 'refs/devryan/state', tree, tree])), 'a locked ref');
    for (const arm of arms) fs.rmSync(path.join(arm.root, repos.sha1, 'git', 'refs', 'devryan', 'state.lock'));
    same(await both(call('git', ['--git-dir', gitDir, 'rev-parse', 'HEAD'], { abort: 'before' })), 'aborted before the call: no process');
    const fake = (name) => [['PATH', `<fake>/${name}:/usr/bin:/bin`]];
    // The abort kills the child at once: both arms answer long before its 30 s
    // sleep or the default 30 s timeout would end it (a bound, not a time).
    const started = Date.now();
    same(await both(call('git', ['status'], { options: { env: fake('sleep') }, abort: { ms: 100 } })), 'aborted by a timer');
    assert.ok(Date.now() - started < 15_000, `an aborted call took ${Date.now() - started} ms: its child was not killed at the abort`);
    same(await both(call('git', ['status'], { options: { env: fake('sleep'), timeoutMs: 150 } })), 'timed out');
    // A child that would end in 2 s: only the given timeout ends it first.
    same(await both(call('git', ['status'], { options: { env: fake('sleep-2'), timeoutMs: 150 } })), 'timed out before the child would end');
    same(await both(call('git', ['status'], { options: { env: fake('sleep'), timeoutMs: 150 }, abort: { ms: 60_000 } })), 'timed out, signal never aborted');
    same(await both(call('git', ['status'], { options: { env: fake('kill-self') } })), 'killed by a signal');
    same(await both(call('git', ['status'], { options: { env: fake('disk-full') } })), 'disk full');
    same(await both(call('git', ['status'], { options: { env: fake('quota') } })), 'quota exceeded');
    same(await both(call('git', ['status'], { options: { env: fake('not-git') } })), 'not a git repository');
    same(await both(call('git', ['status'], { options: { env: fake('not-git'), acceptExitCodes: [128] } })), 'not a git repository, its status accepted');
    same(await both(call('git', ['status'], { options: { env: fake('stderr-split') } })), 'a character split across stderr chunks');
    same(await both(call('git', ['status'], { options: { env: fake('stderr-long') } })), 'a class in the tail of a long stderr');
    same(await both(call('git', ['status'], { options: { env: fake('stderr-head') } })), 'a class in the head of a long stderr');
    same(await both(call('git', ['status', 'x y'], { options: { env: [...fake('env'), ['GIT_INDEX_FILE', 'given'], ['GIT_EXTRA', 'kept'], ['GIT_OPTIONAL_LOCKS', null]] } })), 'the environment: scrubbed, then the caller\'s');
    same(await both(call('git', ['status'], { options: { env: [...fake('env'), ['GIT_EXTRA', 'kept']] } })), 'the environment: GIT_OPTIONAL_LOCKS set');
    same(await both(call('git', ['status'], { options: { env: fake('exit-1'), acceptExitCodes: [1] } })), 'output with an accepted status');
    same(await both(call('git', ['status'], { options: { env: fake('big-out'), limit: 4 * 1024 * 1024 } })), '3 MB of stdout under the limit');
    same(await both(call('git', ['status'], { options: { env: fake('big-out') } })), '3 MB of stdout over the default limit');
    same(await both(call('git', ['status'], { options: { env: fake('cat'), input: 'é\ud800x' } })), 'a string input with a lone surrogate');
    same(await both(call('git', ['status'], { options: { env: fake('cat'), inputRows: ['a\n', 'b\n', 'c'] } })), 'a generator input');
    same(await both(call('git', ['status'], { options: { env: fake('stdin-then-fail'), inputBytes: 300_000 } })), 'input read, then a failure');
  });

  test('git(): the failure classes, as failureClass reads stderr', async () => {
    const fake = [['PATH', '<fake>/stderr:/usr/bin:/bin']];
    for (const text of STDERR_CLASSES) {
      same(await both(call('git', ['update-ref', 'x'], { options: { env: [...fake, ['STDERR_TEXT', text], ['EXIT_CODE', '1']] } })), `stderr ${JSON.stringify(text)}`);
    }
    for (const code of EXIT_CODES) {
      same(await both(call('git', ['ls-tree'], { options: { env: [...fake, ['STDERR_TEXT', 'fatal: x'], ['EXIT_CODE', String(code)]] } })), `exit ${code}`);
    }
  });

  test('git(): a child that goes away with input waiting (EPIPE swallowed; ECANCELED raw, F1)', async () => {
    // The child exits at once without reading 1 MiB: EPIPE, swallowed; under
    // load Node can give ECANCELED or ENOTCONN (arrival's), which git() throws raw.
    const fake = (name) => [['PATH', `<fake>/${name}:/usr/bin:/bin`]];
    const looseCodes = new Set(['ECANCELED', 'ENOTCONN']);
    const { js, rust } = await both(call('git', ['status'], { options: { env: fake('exit-0-unread'), inputBytes: 1024 * 1024 } }));
    for (const [arm, answer] of [['js', js.answer], ['rust', rust.answer]]) {
      assert.ok(answer.ok !== undefined || looseCodes.has(answer.error?.$error?.code), `${arm}: ${JSON.stringify(answer)}`);
    }
    // F1, deterministic: a grandchild holds the stdin without reading.
    const pids = arms.map((arm) => path.join(arm.root, 'grandchild.pid'));
    const answers = await Promise.all(arms.map((arm, index) => arm.server.request(placed(call('git', ['status'], { options: { env: [...fake('grandchild-stdin'), ['PIDFILE', pids[index]]], inputBytes: 1024 * 1024 } }), arm))));
    for (const pid of pids) { try { process.kill(Number(fs.readFileSync(pid, 'utf8')), 'SIGKILL'); } catch { /* gone */ } fs.rmSync(pid, { force: true }); }
    assert.deepEqual(answers[1], answers[0], 'F1: the arms differ');
    assert.equal(answers[0].error?.$error?.code, 'ECANCELED', `F1: ${JSON.stringify(answers[0])}`);
    // The same with a child that fails: git() awaits writing before done, so the raw ECANCELED hides the failure.
    const failing = await Promise.all(arms.map((arm, index) => arm.server.request(placed(call('git', ['status'], { options: { env: [...fake('grandchild-stdin-fail'), ['PIDFILE', pids[index]]], inputBytes: 1024 * 1024 } }), arm))));
    for (const pid of pids) { try { process.kill(Number(fs.readFileSync(pid, 'utf8')), 'SIGKILL'); } catch { /* gone */ } fs.rmSync(pid, { force: true }); }
    assert.deepEqual(failing[1], failing[0], 'F1 with a failing child: the arms differ');
    assert.equal(failing[0].error?.$error?.code, 'ECANCELED', `F1 with a failing child: ${JSON.stringify(failing[0])}`);
  });

  test('gitTokens(): delimiters, a tail, a break, a token too large, split characters', async () => {
    const gitDir = gitDirOf('sha256');
    const fake = (name) => [['PATH', `<fake>/${name}:/usr/bin:/bin`]];
    same(await both(call('tokens', ['--git-dir', gitDir, 'ls-tree', '-r', '-l', '-z', 'refs/devryan/state'])), 'ls-tree tokens');
    same(await both(call('tokens', ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname) %(objectname)'], { options: { delimiter: 10 } })), 'newline tokens');
    same(await both(call('tokens', ['--git-dir', gitDir, 'ls-tree', '-r', '-z', 'refs/devryan/state'], { breakAt: 1 })), 'a consumer leaving at the first token');
    same(await both(call('tokens', ['status'], { options: { env: fake('no-delimiter') } })), 'a token over 1 MiB');
    same(await both(call('tokens', ['status'], { options: { env: fake('split-utf8') } })), 'a character split across chunks');
    same(await both(call('tokens', ['status'], { options: { env: fake('tokens-slow') } })), 'tokens over chunks, a tail');
    same(await both(call('tokens', ['status'], { options: { env: fake('tokens-slow') }, breakAt: 2 })), 'a break after a chunk boundary');
    same(await both(call('tokens', ['--git-dir', '<root>/none', 'ls-tree', 'HEAD'])), 'tokens of a failing Git');
    const aborted = Date.now();
    same(await both(call('tokens', ['status'], { options: { env: fake('sleep') }, abort: { ms: 100 } })), 'tokens aborted');
    assert.ok(Date.now() - aborted < 15_000, `aborted tokens took ${Date.now() - aborted} ms: the child was not killed at the abort`);
  });

  test('gitRecords(): batches by count and bytes, every refusal', async () => {
    const gitDir = gitDirOf('sha1');
    const rows = (await both(call('tokens', ['--git-dir', gitDir, 'ls-tree', '-r', '-l', '-z', 'refs/devryan/state']))).js.answer.ok
      .map((row) => { const [meta, key] = row.split('\t'); const fields = meta.trim().split(/\s+/); return { key, oid: fields[2], size: Number(fields[3]) }; });
    const blobs = rows.filter((row) => Number.isInteger(row.size) && row.key !== 'big/blob.json');
    same(await both(call('records', ['--git-dir', gitDir], { rows: blobs })), 'records of an array');
    same(await both(call('records', ['--git-dir', gitDir], { rows: blobs, rowsGen: true })), 'records of a generator');
    const many = Array.from({ length: 4097 }, (_, index) => blobs[index % blobs.length]);
    same(await both(call('records', ['--git-dir', gitDir], { rows: many })), 'more than 4,096 rows: two reads');
    same(await both(call('records', ['--git-dir', gitDir], { rows: many.slice(0, 4096) })), '4,096 rows: one read');
    const heavy = Array.from({ length: 9 }, () => ({ key: 'h', oid: blobs[0].oid, size: 500 * 1024 }));
    same(await both(call('records', ['--git-dir', gitDir], { rows: heavy })), 'more than 4 MiB: two reads (the sizes are the rows\')');
    for (const [label, bad] of [['a size not an integer', { ...blobs[0], size: 1.5 }], ['a size too large', { ...blobs[0], size: 512 * 1024 + 1 }], ['a negative size', { ...blobs[0], size: -1 }],
      ['a tree', { key: 't', oid: gitText(['--git-dir', path.join(arms[0].root, repos.sha1, 'git'), 'rev-parse', 'refs/devryan/state']), size: 10 }],
      ['a missing object', { key: 'm', oid: 'e'.repeat(40), size: 10 }], ['a blob that is not JSON', rows.find((row) => row.key === 'big/blob.json') && { key: 'n', oid: blobOf(path.join(arms[0].root, repos.sha1, 'git'), 'not json'), size: 8 }]]) {
      for (const arm of arms) blobOf(path.join(arm.root, repos.sha1, 'git'), 'not json');
      same(await both(call('records', ['--git-dir', gitDir], { rows: [blobs[0], bad] })), `records: ${label}`);
    }
  });

  test('the persistent reader: names, kinds, absences, the submodule defect, ask-Git hand-backs', async () => {
    for (const format of formats) {
      const gitDir = gitDirOf(format), real = path.join(arms[0].root, repos[format], 'git');
      const tree = gitText(['--git-dir', real, 'rev-parse', 'refs/devryan/state']);
      const blob = gitText(['--git-dir', real, 'rev-parse', `${tree}:a/x.json`]);
      const absent = 'e'.repeat(format === 'sha1' ? 40 : 64);
      const reads = [
        { name: blob }, { name: blob, check: true }, { name: tree }, { name: `${tree}:a` , check: true }, { name: `${tree}:a/x.json` },
        { name: absent }, { name: `${tree}:none` }, { name: `${tree}:a/x.json/deeper` }, { name: '' }, { name: 'a\nb' }, { name: 5 },
      ];
      same(await both(call('read', ['--git-dir', gitDir], { reads })), `${format}: reads of every kind`, { handedBack: 0 });
      // A gitlink is Git's to answer (S4): on Git 2.51 and later `<id> submodule`
      // closes the reader and every request still pending on it fails
      // (session-changes-git.js:221-226); before, `<name> missing` is null.
      const linked = await both(call('read', ['--git-dir', gitDir], { reads: [{ name: `${tree}:a`, check: true }, { name: `${tree}:sub`, check: true }, { name: `${tree}:b`, check: true }] }));
      same(linked, `${format}: a gitlink between two reads`, { handedBack: 1 });
      const gitlinkOutcome = linked.js.answer.ok?.[1];
      if (installed.gitlink === 'submodule') assert.equal(gitlinkOutcome?.error?.$error?.code, 'invalid_change_record', `${where()} the installed Git prints <id> submodule: the reader closes (${raw(linked.js.answer)})`);
      else assert.deepEqual(gitlinkOutcome, { ok: null }, `${where()} the installed Git prints <name> missing: null (${raw(linked.js.answer)})`);
      same(await both(call('read', ['--git-dir', gitDir], { reads: [{ name: `${tree}:sub` }] })), `${format}: a gitlink through --batch`, { handedBack: 1 });
      same(await both(call('read', ['--git-dir', gitDir], { reads: [{ name: blob }], abort: 'before' })), `${format}: an aborted read throws at once`, { handedBack: 0 });
      same(await both(call('read', ['--git-dir', gitDir], { reads: [{ name: `${tree}:./a`, check: true }, { name: blob }] })), `${format}: a name the database leaves to Git`, { handedBack: 1 });
    }
    // A corrupt loose object: the database asks Git, Git dies, every pending request fails.
    prepare('reader-corrupt', (dir) => ledger(dir, 'sha1', { records: { 'a/x.json': '{"x":1}', 'a/y.json': '{"y":2}' } }));
    const real = path.join(arms[0].root, 'reader-corrupt', 'git');
    const tree = gitText(['--git-dir', real, 'rev-parse', 'refs/devryan/state']);
    const [x, y] = ['a/x.json', 'a/y.json'].map((key) => gitText(['--git-dir', real, 'rev-parse', `${tree}:${key}`]));
    for (const arm of arms) {
      const file = path.join(arm.root, 'reader-corrupt', 'git', 'objects', x.slice(0, 2), x.slice(2));
      fs.chmodSync(file, 0o644); fs.writeFileSync(file, Buffer.from('not zlib at all'));
    }
    same(await both(call('read', ['--git-dir', '<root>/reader-corrupt/git'], { reads: [{ name: y }, { name: x }, { name: y }] })), 'a corrupt object fails the reader', { handedBack: 1 });
    // A lost object reads as absent.
    for (const arm of arms) fs.rmSync(path.join(arm.root, 'reader-corrupt', 'git', 'objects', y.slice(0, 2), y.slice(2)));
    same(await both(call('read', ['--git-dir', '<root>/reader-corrupt/git'], { reads: [{ name: y }, { name: `${tree}:a/y.json` }] })), 'a lost object is absent', { handedBack: 0 });
    // Not a repository: the reader's Git fails at once.
    same(await both(call('read', ['--git-dir', '<root>/none'], { reads: [{ name: y }] })), 'a reader of no repository', { handedBack: 1 });
  });
});

// --- The store ---------------------------------------------------------------

/** Runs one scenario on both arms: the steps' outcomes, the Git commands, then the disk. */
async function scenario(name, format, steps, { build, setting = SETTINGS[0], label = name, unordered, handedBack, disk = true } = {}) {
  prepare(name, (dir) => (build ? build(dir, format) : ledger(dir, format)));
  await clearSwitches();
  if (Object.keys(setting.env).length) await env(setting.env);
  const readers = setting.env.DEVRYAN_LEDGER_PERSISTENT_READER !== '0';
  const opened = [{ s: 'open', as: 'a', cwd: `<root>/${name}`, gitDir: `<root>/${name}/git`, options: setting.options }, ...steps];
  const result = await both({ op: 'store', id: name, steps: opened }, { readers });
  same(result, `${label} (${format}, ${setting.name})`, { unordered: unordered ?? steps.some((step) => step.s === 'concurrent'), handedBack });
  if (disk) await sameDisk(name, `${label} (${format}, ${setting.name})`);
  await clearSwitches();
  return result.js.answer;
}

/** The steps with a scenario directory renamed in every string. */
const placedName = (steps, from, to) => JSON.parse(JSON.stringify(steps).split(`<root>/${from}/`).join(`<root>/${to}/`).split(`<root>/${from}"`).join(`<root>/${to}"`));

describe('the store', () => {
  for (const format of ['sha1', 'sha256']) {
    test(`named scenarios: open, read, stage, commit, lists, leases, identities (${format})`, async () => {
      const base = (dir, objectFormat) => ledger(dir, objectFormat, { records: { 'runs/a/1.json': '{"n":1}', 'runs/b.json': '[1]', 'runs-x/c.json': '"c"', 'ops/x.json': '{"a":[1,2]}', 'lists/l/0000000000.json': '[1,2,3]', 'runs/plain': '7' } });
      for (const setting of settingsFor(format)) {
        const steps = [
          { s: 'get', st: 'a', key: 'runs/b.json' }, { s: 'get', st: 'a', key: 'runs/none.json' }, { s: 'get', st: 'a', key: 'bad key' },
          { s: 'set', st: 'a', key: 'runs/b.json', value: [1] }, { s: 'state', st: 'a' },
          { s: 'set', st: 'a', key: 'runs/new.json', value: { z: 1, 1: 'one', a: -0 } }, { s: 'remove', st: 'a', key: 'runs/none.json' }, { s: 'remove', st: 'a', key: 'runs-x/c.json' },
          { s: 'entries', st: 'a', prefix: 'runs' }, { s: 'entries', st: 'a', prefix: 'runs-x' }, { s: 'list', st: 'a', prefix: 'lists/l' }, { s: 'list', st: 'a', prefix: 'ops' },
          { s: 'staged', st: 'a', prefix: 'runs' }, { s: 'prefixIdentity', st: 'a', prefix: 'runs' },
          { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }, { s: 'commit', st: 'a' },
          { s: 'set', st: 'a', key: 'runs/new.json', value: { z: 1, 1: 'one', a: 0 } }, { s: 'state', st: 'a' },
          { s: 'prefixIdentity', st: 'a', prefix: 'runs' }, { s: 'committedIdentity', st: 'a', prefix: 'runs/a' }, { s: 'committedIdentity', st: 'a', prefix: 'runs/b.json' }, { s: 'committedIdentity', st: 'a', prefix: 'runs/plain' },
          { s: 'prefixIdentities', st: 'a', prefixes: ['runs', 'ops', 'none', 'runs/a', 'runs'] },
          { s: 'setList', st: 'a', prefix: 'lists/m', values: Array.from({ length: 300 }, (_, index) => ({ index, text: 'x'.repeat(index % 7) })) },
          { s: 'setList', st: 'a', prefix: 'lists/l', values: [4, 5], collect: true, firstPage: 2 },
          { s: 'writeList', st: 'a', values: Array.from({ length: 200 }, (_, index) => index), as: 'w' },
          { s: 'setListObjects', st: 'a', prefix: 'lists/w', from: 'w' }, { s: 'setListObjects', st: 'a', prefix: 'lists/w', oids: ['xyz'] },
          { s: 'list', st: 'a', prefix: 'lists/w' }, { s: 'commit', st: 'a' }, { s: 'list', st: 'a', prefix: 'lists/m', take: 5 },
          { s: 'committedRows', st: 'a', prefix: 'lists' }, { s: 'readRows', st: 'a', prefix: 'runs' },
          { s: 'pin', st: 'a', token: '00000000-0000-4000-8000-000000000001' }, { s: 'pin', st: 'a', token: 'bad' },
          { s: 'release', st: 'a', token: '00000000-0000-4000-8000-000000000001' }, { s: 'release', st: 'a', token: 'bad' },
          { s: 'importPrefix', st: 'a', source: '@a', prefix: 'runs', destination: 'copy' }, { s: 'importPrefix', st: 'a', source: 'nothex', prefix: 'runs' },
          { s: 'staged', st: 'a', prefix: 'copy' }, { s: 'entries', st: 'a', prefix: 'copy' }, { s: 'commit', st: 'a' },
          { s: 'stage', st: 'a', fail: true, steps: [{ s: 'set', st: 'a', key: 'runs/s.json', value: 1 }] }, { s: 'state', st: 'a' },
          { s: 'stage', st: 'a', steps: [{ s: 'set', st: 'a', key: 'runs/s.json', value: 1 }] }, { s: 'state', st: 'a' },
          { s: 'open', as: 'b', cwd: `<root>/named-${format}-${setting.name}`, gitDir: `<root>/named-${format}-${setting.name}/git` }, { s: 'entries', st: 'b', prefix: 'runs' },
          { s: 'open', as: 's', cwd: `<root>/named-${format}-${setting.name}`, gitDir: `<root>/named-${format}-${setting.name}/git`, options: { at: '@tree', of: 'b' } }, { s: 'commit', st: 's' }, { s: 'records', st: 's' },
          { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }, { s: 'records', st: 'a' },
        ];
        await scenario(`named-${format}-${setting.name}`, format, steps, { build: base, setting, label: 'named scenario' });
      }
    });
  }

  test('open: refusals, an empty ledger, a lease ref, the loose ref shortcut and its defects', async () => {
    const cwd = '<root>/open', gitDir = '<root>/open/git';
    const steps = [
      { s: 'open', as: 'x', cwd, gitDir, options: { listingLimitBytes: 0 } }, { s: 'open', as: 'x', cwd, gitDir, options: { listingLimitBytes: 1.5 } },
      { s: 'open', as: 'x', cwd, gitDir, options: { at: 'abc' } }, { s: 'open', as: 'x', cwd, gitDir, options: { ref: 'refs/heads/main' } },
      { s: 'open', as: 'x', cwd, gitDir, options: { ref: 'refs/devryan/leases/00000000-0000-4000-8000-000000000000' } }, { s: 'state', st: 'x' },
      { s: 'set', st: 'a', key: 'k/a.json', value: 1 }, { s: 'commit', st: 'a' }, { s: 'pin', st: 'a', token: '00000000-0000-4000-8000-000000000000' },
      { s: 'open', as: 'x', cwd, gitDir, options: { ref: 'refs/devryan/leases/00000000-0000-4000-8000-000000000000' } }, { s: 'state', st: 'x' }, { s: 'entries', st: 'x', prefix: 'k' },
    ];
    for (const format of ['sha1', 'sha256']) await scenario(`open-${format}`, format, placedName(steps, 'open', `open-${format}`), { label: 'open' });
    // A loose ref with leading whitespace (trim accepts what Git refuses) and a ref path that is a directory (EISDIR).
    for (const [label, edit] of [['a loose ref with a leading space', (gitDirPath, tree) => fs.writeFileSync(path.join(gitDirPath, 'refs', 'devryan', 'state'), ` ${tree}\n`)],
      ['a ref path that is a directory', (gitDirPath) => { const ref = path.join(gitDirPath, 'refs', 'devryan', 'state'); fs.rmSync(ref, { force: true }); fs.mkdirSync(ref); }]]) {
      const refName = `open-ref-${label.replace(/[^a-z]+/g, '-')}`;
      prepare(refName, (dir) => {
        const made = ledger(dir, 'sha1', { records: { 'k/a.json': '1' } });
        edit(made, gitText(['--git-dir', made, 'rev-parse', 'refs/devryan/state']));
      });
      for (const setting of [SETTINGS[0], settingOf('no-reader')]) {
        await clearSwitches(); await env(setting.env);
        same(await both({ op: 'store', id: `${refName}-${setting.name}`, steps: [{ s: 'open', as: 'a', cwd: `<root>/${refName}`, gitDir: `<root>/${refName}/git` }, { s: 'entries', st: 'a', prefix: 'k' }] }, { readers: setting.env.DEVRYAN_LEDGER_PERSISTENT_READER !== '0' }), `${label} (${setting.name})`);
      }
      await clearSwitches();
    }
  });

  test('commit: guards (the compare-and-swap undone, its rollback failing), a failed sync, an aborted call, a locked ref', async () => {
    for (const setting of [SETTINGS[0], settingOf('index'), settingOf('kept-index')]) {
      const steps = (name) => [
        { s: 'set', st: 'a', key: 'k/a.json', value: 1 }, { s: 'commit', st: 'a', guard: { failAt: 1 } }, { s: 'state', st: 'a' },
        { s: 'commit', st: 'a', guard: { failAt: 2, async: true } }, { s: 'state', st: 'a' },
        { s: 'commit', st: 'a', guard: { failAt: 3 } }, { s: 'state', st: 'a' }, { s: 'commit', st: 'a', guard: { failAt: 4 } }, { s: 'state', st: 'a' },
        { s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'commit', st: 'a', guard: { failAt: 3, async: true } }, { s: 'state', st: 'a' },
        { s: 'open', as: 'f', cwd: `<root>/${name}`, gitDir: `<root>/${name}/git`, options: { sync: 'fail' } }, { s: 'set', st: 'f', key: 'k/c.json', value: 3 }, { s: 'commit', st: 'f' }, { s: 'state', st: 'f' },
        { s: 'commit', st: 'a', guard: { abortAt: 3, failAt: 3 } }, { s: 'state', st: 'a' },
      ];
      await scenario(`guards-${setting.name}`, 'sha1', steps(`guards-${setting.name}`), { setting, label: 'guards' });
      // The guard aborts the call after the compare-and-swap: the rollback's Git cannot start (AggregateError).
      await scenario(`guards-abort-${setting.name}`, 'sha1', [{ s: 'set', st: 'a', key: 'k/a.json', value: 1 }, { s: 'commit', st: 'a', guard: { abortAt: 2, failAt: 2 } }, { s: 'state', st: 'a' }, { s: 'get', st: 'a', key: 'k/a.json' }], { setting, label: 'a rollback that cannot run' });
      // Aborted before a step: every Git start throws the reason.
      await scenario(`aborted-${setting.name}`, 'sha1', [{ s: 'set', st: 'a', key: 'k/a.json', value: 1 }, { s: 'abort' }, { s: 'commit', st: 'a' }, { s: 'get', st: 'a', key: 'k/x.json' }, { s: 'entries', st: 'a', prefix: 'k' }, { s: 'state', st: 'a' }], { setting, label: 'aborted' });
    }
    // Paged: the direct walk's reads see the abort, so Git answers, and its start throws.
    await scenario('aborted-paged', 'sha1', [{ s: 'set', st: 'a', key: 'k/a.json', value: 1 }, { s: 'commit', st: 'a' }, { s: 'entries', st: 'a', prefix: 'k' }, { s: 'abort' }, { s: 'entries', st: 'a', prefix: 'k' }, { s: 'committedRows', st: 'a', prefix: 'k' }], { setting: settingOf('paged'), label: 'aborted, paged' });
    // A locked ref: update-ref fails (failure lock); nothing is committed.
    prepare('locked', (dir) => { const made = ledger(dir, 'sha1', { records: { 'k/a.json': '1' } }); fs.writeFileSync(path.join(made, 'refs', 'devryan', 'state.lock'), ''); });
    same(await both({ op: 'store', id: 'locked', steps: [{ s: 'open', as: 'a', cwd: '<root>/locked', gitDir: '<root>/locked/git' }, { s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }] }), 'a locked ref');
    // A pending object directory is synced before the commit.
    await scenario('sync', 'sha1', [{ s: 'markPending', directory: '<root>/sync/objects' }, { s: 'set', st: 'a', key: 'k/a.json', value: 1 }, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }], {
      build: (dir, format) => { fs.mkdirSync(path.join(dir, 'objects')); return ledger(dir, format); }, label: 'a pending object directory' });
  });

  test('lost and corrupt objects, malformed trees, a gitlink in a ledger (each switch)', async () => {
    const build = (dir, format) => ledger(dir, format, { records: { 'runs/a/1.json': '{"n":1}', 'runs/a/2.json': '{"n":2}', 'runs/b.json': '[1]', 'top.json': '0' }, gitlink: true });
    const steps = [
      { s: 'entries', st: 'a', prefix: 'runs' }, { s: 'committedRows', st: 'a', prefix: 'runs/a' }, { s: 'get', st: 'a', key: 'runs/b.json' },
      { s: 'committedIdentity', st: 'a', prefix: 'sub' }, { s: 'prefixIdentities', st: 'a', prefixes: ['runs', 'sub'] }, { s: 'get', st: 'a', key: 'sub' },
      { s: 'set', st: 'a', key: 'runs/a/3.json', value: 3 }, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' },
    ];
    for (const setting of SETTINGS) await scenario(`gitlink-${setting.name}`, 'sha1', steps, { build, setting, label: 'a gitlink in the ledger', disk: false });
    for (const [label, damage] of [['a lost subtree', 'lose'], ['a corrupt subtree', 'corrupt']]) {
      for (const setting of SETTINGS) {
        const name = `${damage}-${setting.name}`;
        prepare(name, (dir) => {
          const made = build(dir, 'sha1');
          const subtree = gitText(['--git-dir', made, 'rev-parse', 'refs/devryan/state:runs/a']);
          const file = path.join(made, 'objects', subtree.slice(0, 2), subtree.slice(2));
          if (damage === 'lose') fs.rmSync(file); else { fs.chmodSync(file, 0o644); fs.writeFileSync(file, 'garbage'); }
        });
        await clearSwitches(); await env(setting.env);
        const readers = setting.env.DEVRYAN_LEDGER_PERSISTENT_READER !== '0';
        same(await both({ op: 'store', id: name, steps: [{ s: 'open', as: 'a', cwd: `<root>/${name}`, gitDir: `<root>/${name}/git`, options: setting.options }, ...steps.slice(0, 3), { s: 'entries', st: 'a', prefix: 'runs/a' }, { s: 'set', st: 'a', key: 'runs/a/3.json', value: 3 }, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }] }, { readers }), `${label} (${setting.name})`);
        await clearSwitches();
      }
    }
  });

  test('a large tree and unusual names Git wrote, whole and paged', async () => {
    const records = {};
    for (let index = 0; index < 1500; index++) records[`big/${String(index % 37)}/k${index}.json`] = JSON.stringify({ index });
    records['odd/a name.json'] = '1';
    records['odd/é-ü.json'] = '2';
    records['odd/tab\tname.json'] = '3';
    records['odd/zz.json'] = '4';
    const build = (dir, format) => ledger(dir, format, { records, packed: true });
    const steps = [
      { s: 'entries', st: 'a', prefix: 'odd' }, { s: 'committedRows', st: 'a', prefix: 'big/7' }, { s: 'list', st: 'a', prefix: 'odd' },
      { s: 'get', st: 'a', key: 'big/3/k3.json' }, { s: 'prefixIdentities', st: 'a', prefixes: ['big', 'odd', 'big/36'] },
      { s: 'set', st: 'a', key: 'odd/zz.json', value: 5 }, { s: 'remove', st: 'a', key: 'big/0/k0.json' },
      { s: 'setList', st: 'a', prefix: 'lists/huge', values: Array.from({ length: 2000 }, (_, index) => ({ index, text: 't'.repeat(index % 300) })) },
      { s: 'commit', st: 'a' }, { s: 'entries', st: 'a', prefix: 'odd' }, { s: 'committedRows', st: 'a', prefix: 'lists/huge' }, { s: 'state', st: 'a' },
      // More than 256 rows a read batch, more than 256 and 128 prefixes an identity batch.
      { s: 'entries', st: 'a', prefix: 'big' }, { s: 'readRows', st: 'a', prefix: 'big' },
      { s: 'prefixIdentities', st: 'a', prefixes: Array.from({ length: 300 }, (_, index) => (index % 3 ? `big/${index % 40}` : `none/${index}`)) },
    ];
    for (const format of extended ? ['sha1', 'sha256'] : ['sha1']) {
      // The gate: sha1, Git's whole listing and the paged direct walk; the extended run every setting of both formats.
      const settings = extended ? SETTINGS : [SETTINGS[0], settingOf('paged')];
      for (const setting of settings) await scenario(`large-${format}-${setting.name}`, format, steps, { build, setting, label: 'a large tree' });
    }
  });

  test('two whole listings stay cached: a store and an older snapshot read in turn', async () => {
    const build = (dir, format) => ledger(dir, format, { records: { 'k/a.json': '1' } });
    const steps = [
      { s: 'open', as: 'old', cwd: '<root>/two-listings', gitDir: '<root>/two-listings/git', options: { at: '@tree', of: 'a' } },
      { s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'commit', st: 'a' },
      { s: 'entries', st: 'a', prefix: 'k' }, { s: 'entries', st: 'old', prefix: 'k' }, { s: 'entries', st: 'a', prefix: 'k' }, { s: 'entries', st: 'old', prefix: 'k' },
    ];
    await scenario('two-listings', 'sha1', steps, { build, label: 'two listings cached' });
  });

  test('the D25 deviation: staged keys in code-unit order, where localeCompare orders them otherwise', async () => {
    const steps = [{ s: 'set', st: 'a', key: 'k/b.json', value: 1 }, { s: 'set', st: 'a', key: 'k/B.json', value: 2 }, { s: 'set', st: 'a', key: 'k/_.json', value: 3 }, { s: 'set', st: 'a', key: 'k/a.json', value: 4 }, { s: 'staged', st: 'a', prefix: 'k' }];
    prepare('d25', (dir) => ledger(dir, 'sha1'));
    const { js, rust } = await both({ op: 'store', id: 'd25', steps: [{ s: 'open', as: 'a', cwd: '<root>/d25', gitDir: '<root>/d25/git' }, ...steps] });
    const order = (answer) => answer.ok.at(-1).ok.$map.map(([name]) => name);
    assert.deepEqual(order(js.answer), ['k/_.json', 'k/a.json', 'k/b.json', 'k/B.json'], 'the JavaScript: localeCompare (en-US)');
    assert.deepEqual(order(rust.answer), ['k/B.json', 'k/_.json', 'k/a.json', 'k/b.json'], 'the Rust: code-unit order');
  });

  for (const format of ['sha1', 'sha256']) {
    test(`seeded operation scripts on every switch setting (${format})`, async () => {
      let index = 0;
      for (const setting of settingsFor(format)) {
        for (let count = 0; count < SCRIPTS_PER_SETTING; count++) {
          const seed = 1000 * (format === 'sha1' ? 1 : 2) + 100 * SETTINGS.indexOf(setting) + count;
          await scenario(`script-${format}-${index++}`, format, generateScript(seed), { setting, label: `script ${seed}` });
        }
      }
    });
  }
});

// --- Fix round 1: the reader's deadline, environment, packs and listings ---

/** The blob ids of `keys` in the scenario's ledger (the same on both arms). */
const blobIds = (name, keys) => {
  const gitDir = path.join(arms[0].root, name, 'git');
  const tree = gitText(['--git-dir', gitDir, 'rev-parse', 'refs/devryan/state']);
  return keys.map((key) => gitText(['--git-dir', gitDir, 'rev-parse', `${tree}:${key}`]));
};
const loosePath = (arm, name, oid) => path.join(arm.root, name, 'git', 'objects', oid.slice(0, 2), oid.slice(2));
/** A fake Git directory of the scratch (`<scratch>/fake/<name>/git`). */
const fakeDir = (name) => path.join(scratch, 'fake', name);

describe('the reader: its deadline, environment, packs and listings (L3b fix round 1)', () => {
  test('S1: a hand-back whose Git hangs fails at the reader\'s deadline (capture_timeout), every pending read with it', async () => {
    prepare('hang', (dir) => ledger(dir, 'sha1', { records: { 'a/x.json': '{"x":1}', 'a/y.json': '{"y":2}' } }));
    const [x] = blobIds('hang', ['a/x.json']);
    // A corrupt loose blob: the Rust's database asks Git; the JavaScript's reader is that Git.
    for (const arm of arms) { const file = loosePath(arm, 'hang', x); fs.chmodSync(file, 0o644); fs.writeFileSync(file, 'not zlib at all'); }
    fs.mkdirSync(fakeDir('hang'), { recursive: true });
    fs.writeFileSync(path.join(fakeDir('hang'), 'git'), '#!/bin/sh\nexec sleep 120\n', { mode: 0o755 });
    await env({ PATH: `${fakeDir('hang')}:/usr/bin:/bin` });
    try {
      // The clock runs 31 s ahead after 300 ms: the watchdog's next tick fails the reads.
      const result = await both({ op: 'store', id: 'hang', steps: [
        { s: 'open', as: 'a', cwd: '<root>/hang', gitDir: '<root>/hang/git' },
        { s: 'concurrent', steps: [{ s: 'get', st: 'a', key: 'a/x.json' }, { s: 'get', st: 'a', key: 'a/y.json' }, { s: 'skew', ms: 31_000, after: 300 }] },
        { s: 'skew', ms: 0 },
      ] });
      same(result, 'a hand-back that hangs', { unordered: true });
      const gets = result.js.answer.ok[1].ok.slice(0, 2);
      for (const outcome of gets) assert.deepEqual(outcome, { error: { $error: { name: 'Error', message: 'capture_timeout', code: 'capture_timeout', status: 503 } } }, `${where()} ${raw(result.js.answer)}`);
    } finally { await env({ PATH: basePath }); }
    // The killed hand-back is reaped and nothing is left: the reader's life test settles the census.
  });

  test('S1: FIFOs at loose objects: both reads fail at the deadline and another store commits meanwhile (no pool taken)', async () => {
    for (const name of ['fifo', 'fifo-other']) prepare(name, (dir) => ledger(dir, 'sha1', { records: { 'a/x.json': '{"x":1}', 'a/y.json': '{"y":2}' } }));
    const [x, y] = blobIds('fifo', ['a/x.json', 'a/y.json']);
    for (const arm of arms) for (const oid of [x, y]) { const file = loosePath(arm, 'fifo', oid); fs.rmSync(file); assert.equal(spawnSync('mkfifo', [file]).status, 0, 'mkfifo'); }
    try {
      const result = await both({ op: 'store', id: 'fifo', steps: [
        { s: 'open', as: 'a', cwd: '<root>/fifo', gitDir: '<root>/fifo/git' },
        { s: 'open', as: 'b', cwd: '<root>/fifo-other', gitDir: '<root>/fifo-other/git' }, { s: 'set', st: 'b', key: 'a/z.json', value: 3 },
        { s: 'concurrent', steps: [{ s: 'get', st: 'a', key: 'a/x.json' }, { s: 'get', st: 'a', key: 'a/y.json' }, { s: 'commit', st: 'b' }, { s: 'skew', ms: 31_000, after: 1_500 }] },
        { s: 'skew', ms: 0 }, { s: 'state', st: 'b' },
      ] });
      same(result, 'FIFOs at loose objects', { unordered: true });
      const [first, second, commit] = result.js.answer.ok[3].ok;
      for (const outcome of [first, second]) assert.equal(outcome.error?.$error?.code, 'capture_timeout', `${where()} ${raw(result.js.answer)}`);
      assert.deepEqual(commit, { ok: { value: { $undefined: true }, guardCalls: [] } }, `${where()} the other store's commit: ${raw(result.rust.answer)}`);
    } finally {
      for (const arm of arms) for (const oid of [x, y]) fs.rmSync(loosePath(arm, 'fifo', oid), { force: true });
    }
    await sameDisk('fifo-other', 'the store that committed beside the FIFOs');
  });

  test('S2: a fake Git printing random bytes (NUL included) and statuses never ends the Rust; without the reader every answer is equal', async () => {
    const out = path.join(scratch, 'fuzz-out.bin'), code = path.join(scratch, 'fuzz-code');
    fs.mkdirSync(fakeDir('fuzz'), { recursive: true });
    fs.writeFileSync(path.join(fakeDir('fuzz'), 'git'), `#!/bin/sh\ncat '${out}'\nexit "$(cat '${code}')"\n`, { mode: 0o755 });
    const { random } = await import('./store-spec.mjs');
    const rng = random(4242);
    const PIECES = [' ', '\n', '\0', '\t', 'blob', 'tree', 'commit', 'submodule', 'missing', '100644', '040000', '0', '7', '-', '9007199254740993', '1e3', '-0', '"x"', '{"a":1}', 'a/x.json', 'é', 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', '0'.repeat(40)];
    const payload = () => { let text = ''; for (let index = rng.int(18); index > 0; index--) text += rng.chance(0.2) ? String.fromCharCode(1 + rng.int(255)) : rng.pick(PIECES); return Buffer.from(text, 'latin1'); };
    const rounds = extended ? 240 : 30;
    for (const setting of [settingOf('no-reader'), settingOf('paged')]) {
      const name = `fuzz-${setting.name}`;
      prepare(name, (dir) => ledger(dir, 'sha1', { records: { 'a/x.json': '1' } }));
      await clearSwitches(); await env({ ...setting.env, PATH: `${fakeDir('fuzz')}:/usr/bin:/bin` });
      try {
        for (let round = 0; round < rounds; round++) {
          fs.writeFileSync(out, payload());
          fs.writeFileSync(code, String(rng.pick([0, 0, 0, 1, 128])));
          const steps = [{ s: 'open', as: 'a', cwd: `<root>/${name}`, gitDir: `<root>/${name}/git`, options: setting.options }, { s: 'get', st: 'a', key: 'a/x.json' }, { s: 'entries', st: 'a', prefix: 'a' },
            { s: 'records', st: 'a' }, { s: 'prefixIdentities', st: 'a', prefixes: ['a', 'b'] }, { s: 'committedIdentity', st: 'a', prefix: 'a' }, { s: 'set', st: 'a', key: 'a/n.json', value: 1 }, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }];
          const result = await both({ op: 'store', id: `${name}-${round}`, steps }, { readers: false });
          const records = await both(call('records', ['--git-dir', `<root>/${name}/git`], { rows: [{ key: 'k', oid: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', size: 3 }] }), { readers: false });
          const label = `${name} round ${round} (payload ${fs.readFileSync(out).toString('base64')})`;
          // With the reader the JavaScript's reader is the fake and the Rust's reads are in-process: only the Rust's survival is compared.
          if (setting.env.DEVRYAN_LEDGER_PERSISTENT_READER === '0') { same(result, label, { unordered: true }); same(records, `${label}: records`); }
        }
      } finally { await env({ PATH: basePath }); await clearSwitches(); }
    }
  });

  test('S3: GIT_REPLACE_REF_BASE and GIT_NO_REPLACE_OBJECTS in the environment: the reader gives what Git gives', async () => {
    // Only `refs/other-replace/` (no `refs/replace/`, whose refs alone make the database ask Git), or both.
    const builder = (withReplaceRef) => (dir) => {
      const made = ledger(dir, 'sha1', { records: { 'a/x.json': '{"x":1}', 'a/y.json': '{"y":2}' } });
      const tree = gitText(['--git-dir', made, 'rev-parse', 'refs/devryan/state']);
      const blob = gitText(['--git-dir', made, 'rev-parse', `${tree}:a/x.json`]);
      gitSync(['--git-dir', made, 'update-ref', `refs/other-replace/${blob}`, blobOf(made, '{"replaced":true}')]);
      if (withReplaceRef) gitSync(['--git-dir', made, 'update-ref', `refs/replace/${blob}`, blobOf(made, '{"plain":true}')]);
      return made;
    };
    const cases = [
      ['GIT_REPLACE_REF_BASE names another namespace', { GIT_REPLACE_REF_BASE: 'refs/other-replace/' }, false],
      ['GIT_REPLACE_REF_BASE with refs/replace refs too', { GIT_REPLACE_REF_BASE: 'refs/other-replace/' }, true],
      ['GIT_NO_REPLACE_OBJECTS turns replacement off', { GIT_NO_REPLACE_OBJECTS: '1' }, true],
      ['both', { GIT_REPLACE_REF_BASE: 'refs/other-replace/', GIT_NO_REPLACE_OBJECTS: '1' }, true],
      ['GIT_NAMESPACE (replace refs are not namespaced)', { GIT_NAMESPACE: 'n' }, true],
    ];
    for (const [label, variables, withReplaceRef] of cases) {
      for (const setting of [SETTINGS[0], settingOf('paged')]) {
        const name = `replace-${label.replace(/[^a-zA-Z]+/g, '-')}-${setting.name}`;
        prepare(name, builder(withReplaceRef));
        await clearSwitches(); await env({ ...setting.env, ...variables });
        try {
          const steps = [{ s: 'open', as: 'a', cwd: `<root>/${name}`, gitDir: `<root>/${name}/git`, options: setting.options }, { s: 'get', st: 'a', key: 'a/x.json' }, { s: 'entries', st: 'a', prefix: 'a' }, { s: 'committedIdentity', st: 'a', prefix: 'a' }];
          same(await both({ op: 'store', id: name, steps }), `${label} (${setting.name})`);
        } finally { await env(Object.fromEntries(Object.keys(variables).map((key) => [key, null]))); await clearSwitches(); }
      }
    }
  });

  test('S5: a pack a repack deleted is read while the reader lives, and the commit fails as the JavaScript\'s does', async () => {
    prepare('deleted-pack', (dir) => ledger(dir, 'sha1', { records: { 'a/x.json': '{"x":1}', 'a/y.json': '{"y":2}' }, packed: true }));
    same(await both({ op: 'store', id: 'deleted-pack', steps: [{ s: 'open', as: 'a', cwd: '<root>/deleted-pack', gitDir: '<root>/deleted-pack/git' }, { s: 'get', st: 'a', key: 'a/x.json' }] }), 'the first read');
    for (const arm of arms) {
      const gitDir = path.join(arm.root, 'deleted-pack', 'git');
      gitSync(['--git-dir', gitDir, 'update-ref', 'refs/devryan/state', gitText(['--git-dir', gitDir, 'mktree'], { input: '' })]);
      gitSync(['--git-dir', gitDir, 'repack', '-a', '-d', '-q']);
      gitSync(['--git-dir', gitDir, 'prune-packed']);
    }
    const result = await both({ op: 'store', id: 'deleted-pack', steps: [{ s: 'open', as: 'c', cwd: '<root>/deleted-pack', gitDir: '<root>/deleted-pack/git' }, { s: 'get', st: 'c', key: 'a/q.json' },
      { s: 'get', st: 'a', key: 'a/y.json' }, { s: 'entries', st: 'a', prefix: 'a' }, { s: 'set', st: 'a', key: 'a/z.json', value: 3 }, { s: 'commit', st: 'a' }] });
    same(result, 'reads of a deleted pack, then a commit');
    assert.deepEqual(result.js.answer.ok[2], { ok: { y: 2 } }, `${where()} the deleted pack is still read: ${raw(result.js.answer)}`);
    assert.equal(result.js.answer.ok[5].error?.$error?.command, 'update-ref', `${where()} ${raw(result.js.answer)}`);
    // The reader's life ends (idle): its packs and descriptors go with it.
    const before = await arms[1].server.request({ op: 'census' });
    const settled = await arms[1].server.request({ op: 'census', settle: true });
    assert.equal(settled.timeout, undefined, `${where()} ${raw(settled)}`);
    assert.ok(settled.fds < before.fds, `${where()} the reader's packs were not let go: ${raw({ before, settled })}`);
  });

  test('M2: paged listings of a repository the database leaves to Git start what the JavaScript starts', async () => {
    const build = (dir) => {
      const made = ledger(dir, 'sha1', { records: { 'runs/a/1.json': '1', 'runs/a/2.json': '2', 'runs/b.json': '3' } });
      // An unrelated replace ref: every read of the database asks Git.
      gitSync(['--git-dir', made, 'update-ref', `refs/replace/${blobOf(made, 'a')}`, blobOf(made, 'b')]);
      return made;
    };
    for (const setting of [settingOf('paged'), settingOf('paged-git')]) {
      await scenario(`m2-${setting.name}`, 'sha1', [{ s: 'entries', st: 'a', prefix: 'runs' }, { s: 'committedRows', st: 'a', prefix: 'runs/a' }, { s: 'importPrefix', st: 'a', source: '@a', prefix: 'runs', destination: 'copy' }, { s: 'commit', st: 'a' }],
        { build, setting, label: 'paged listings asked of Git' });
    }
  });

  test('M1: records() binds its snapshot at the call: a generator made before a commit lists the tree it was made on', async () => {
    const answer = await scenario('records-across', 'sha1', [{ s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'recordsAcross', st: 'a', then: { s: 'commit', st: 'a' } }, { s: 'records', st: 'a' }],
      { build: (dir, format) => ledger(dir, format, { records: { 'k/a.json': '1' } }), label: 'records across a commit' });
    assert.equal(answer.ok[2].ok.rows.length, 1, `${where()} the generator listed the new tree: ${raw(answer)}`);
  });

  test('the index path hashes new values 128 at a time; a direct commit drops the kept index\'s record', async () => {
    const values = Array.from({ length: 130 }, (_, index) => ({ s: 'set', st: 'a', key: `many/k${index}.json`, value: index }));
    await scenario('hash-batches', 'sha1', [...values, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }], { setting: settingOf('index'), label: 'hash-object batches' });
    await scenario('kept-then-direct', 'sha1', [{ s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'commit', st: 'a' }, { s: 'env', set: { DEVRYAN_LEDGER_DIRECT_TREES: null } },
      { s: 'set', st: 'a', key: 'k/c.json', value: 3 }, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }], { build: (dir, format) => ledger(dir, format, { records: { 'k/a.json': '1' } }), setting: settingOf('kept-index'), label: 'a kept index, then a direct commit' });
  });

  test('refusals of the direct tree and of the values: a file over a directory and back, a record too large, an id in capitals', async () => {
    // A directory named like a key (`runs/a.json/`), which only Git can write: a blob over it is refused.
    const build = (dir, format) => ledger(dir, format, { records: { 'runs/a.json/1.json': '1', 'runs/plain': '7' } });
    for (const setting of [SETTINGS[0], settingOf('index')]) {
      await scenario(`refusals-${setting.name}`, 'sha1', [
        { s: 'set', st: 'a', key: 'runs/a.json', value: 1 }, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' },
        { s: 'open', as: 'b', cwd: `<root>/refusals-${setting.name}`, gitDir: `<root>/refusals-${setting.name}/git` }, { s: 'set', st: 'b', key: 'runs/plain/x.json', value: 2 }, { s: 'commit', st: 'b' }, { s: 'state', st: 'b' },
        { s: 'open', as: 'c', cwd: `<root>/refusals-${setting.name}`, gitDir: `<root>/refusals-${setting.name}/git` }, { s: 'set', st: 'c', key: 'runs/big.json', value: 'x'.repeat(600 * 1024) },
        { s: 'setListObjects', st: 'c', prefix: 'lists/u', oids: ['AB'.repeat(20)] }, { s: 'state', st: 'c' },
      ], { build, setting, label: 'refusals' });
    }
  });

  test('an emptied root is Git\'s empty tree; a paged listing of a prefix with a gitlink lists it with size `-`', async () => {
    for (const setting of [SETTINGS[0], settingOf('index')]) {
      await scenario(`emptied-${setting.name}`, 'sha1', [{ s: 'remove', st: 'a', key: 'k/a.json' }, { s: 'commit', st: 'a' }, { s: 'state', st: 'a' }, { s: 'records', st: 'a' }],
        { build: (dir, format) => ledger(dir, format, { records: { 'k/a.json': '1' } }), setting, label: 'an emptied root' });
    }
    const linked = (dir, format) => {
      const gitDir = ledger(dir, format);
      const tree = treeOf(gitDir, { m: { 'a.json': blobOf(gitDir, '1'), sub: { mode: '160000', oid: 'ab'.repeat(20) } } });
      gitSync(['--git-dir', gitDir, 'update-ref', 'refs/devryan/state', tree]);
      return gitDir;
    };
    for (const setting of [settingOf('paged'), settingOf('paged-git'), SETTINGS[0]]) {
      await scenario(`gitlink-rows-${setting.name}`, 'sha1', [{ s: 'committedRows', st: 'a', prefix: 'm' }, { s: 'entries', st: 'a', prefix: 'm' }], { build: linked, setting, label: 'a gitlink row', disk: false });
    }
  });

  test('M3: a record nested deeper than 512 levels: the JavaScript reads it, the Rust refuses it (ledger_record_too_deep, a deviation)', async () => {
    const deep = `${'['.repeat(600)}${']'.repeat(600)}`, shallow = `${'['.repeat(500)}${']'.repeat(500)}`;
    prepare('deep', (dir) => ledger(dir, 'sha1', { records: { 'k/deep.json': deep, 'k/shallow.json': shallow } }));
    const { js, rust } = await both({ op: 'store', id: 'deep', steps: [{ s: 'open', as: 'a', cwd: '<root>/deep', gitDir: '<root>/deep/git' }, { s: 'get', st: 'a', key: 'k/shallow.json' }, { s: 'get', st: 'a', key: 'k/deep.json' }] });
    assert.deepEqual(rust.answer.ok[1], js.answer.ok[1], `${where()} 500 levels: ${raw({ js: js.answer.ok[1], rust: rust.answer.ok[1] })}`.slice(0, 2000));
    assert.ok(Array.isArray(js.answer.ok[2].ok), `${where()} the JavaScript reads 600 levels: ${raw(js.answer.ok[2]).slice(0, 300)}`);
    assert.deepEqual(rust.answer.ok[2], { error: { $error: { name: 'Error', message: 'ledger_record_too_deep', code: 'ledger_record_too_deep', status: 503 } } }, `${where()} the Rust: ${raw(rust.answer.ok[2]).slice(0, 300)}`);
  });

  test('values are read 256 at a time: a listing left after its first row reads one batch (every read handed to Git)', async () => {
    const records = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`big/k${String(index).padStart(3, '0')}.json`, String(index)]));
    prepare('batches', (dir) => ledger(dir, 'sha1', { records }));
    await clearSwitches(); await env({ GIT_REPLACE_REF_BASE: 'refs/other-replace/' });
    try {
      same(await both({ op: 'store', id: 'batches', steps: [{ s: 'open', as: 'a', cwd: '<root>/batches', gitDir: '<root>/batches/git' }, { s: 'entries', st: 'a', prefix: 'big', take: 1 }] }), 'one batch of values', { handedBack: 256 });
    } finally { await env({ GIT_REPLACE_REF_BASE: null }); }
  });

  test('the reader\'s life: idle readers close, and the census comes back to its baseline', async () => {
    prepare('life', (dir) => ledger(dir, 'sha1', { records: { 'a/x.json': '1' } }));
    const baseline = await arms[1].server.request({ op: 'census', settle: true });
    const tree = gitText(['--git-dir', path.join(arms[0].root, 'life', 'git'), 'rev-parse', 'refs/devryan/state']);
    same(await both(call('read', ['--git-dir', '<root>/life/git'], { reads: [{ name: `${tree}:a/x.json`, idleMs: 100 }, { name: `${tree}:a`, check: true, idleMs: 100 }] })), 'reads with a short idle time', { handedBack: 0 });
    const live = await arms[1].server.request({ op: 'census' });
    assert.equal(live.readers, 2, `${where()} ${raw(live)}`);
    const settled = await arms[1].server.request({ op: 'census', settle: true });
    assert.deepEqual(settled, baseline, `${where()} the census after the readers' idle close: ${raw({ baseline, settled })}`);
    // Everything of the block (the hang's killed hand-back, the FIFOs' Gits, every reader) is gone.
    assert.deepEqual({ readers: settled.readers, children: settled.children, threads: settled.threads, timeout: settled.timeout }, { readers: 0, children: 0, threads: 0, timeout: undefined }, `${where()} ${raw(settled)}`);
  });
});

// --- Durability: the object directory's sync, on every platform (a counting
// shim with injected faults) and as system calls (macOS, interposed) --------

describe('durability: the object directory\'s sync (L3b fix round 1)', () => {
  const pendingLedger = (dir, format) => { fs.mkdirSync(path.join(dir, 'objects')); return ledger(dir, format, { records: { 'k/a.json': '1' } }); };
  const log = (name) => `<root>/${name}/objects`;
  for (const setting of [SETTINGS[0], settingOf('index')]) {
    test(`one sync per commit with something pending, of <root>/objects, logged on both arms (${setting.name})`, async () => {
      const name = `durable-once-${setting.name}`;
      const answer = await scenario(name, 'sha1', [{ s: 'syncShim', faults: [] }, { s: 'markPending', directory: log(name) }, { s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'commit', st: 'a' },
        { s: 'set', st: 'a', key: 'k/c.json', value: 3 }, { s: 'commit', st: 'a' }, { s: 'syncLog' }, { s: 'syncShim', off: true }], { build: pendingLedger, setting, label: 'one sync per pending commit' });
      assert.deepEqual(answer.ok.at(-2), { ok: [`open ${log(name)}`, `sync ${log(name)} ok`, `close ${log(name)} ok`] }, `${where()} ${raw(answer)}`);
    });

    test(`a failed sync leaves the directory pending: the next commit syncs again (${setting.name})`, async () => {
      const name = `durable-retry-${setting.name}`;
      const answer = await scenario(name, 'sha1', [{ s: 'syncShim', faults: ['sync'] }, { s: 'markPending', directory: log(name) }, { s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'commit', st: 'a' },
        { s: 'state', st: 'a' }, { s: 'commit', st: 'a' }, { s: 'syncLog' }, { s: 'syncShim', off: true }], { build: pendingLedger, setting, label: 'a failed sync retried' });
      assert.equal(answer.ok[4].error?.$error?.syscall, 'fsync', `${where()} ${raw(answer)}`);
      assert.equal(answer.ok.at(-2).ok.filter((line) => line.startsWith('sync ')).length, 2, `${where()} ${raw(answer)}`);
    });

    test(`a sync and a close that both fail: the close's error, as the JavaScript's finally gives it (${setting.name})`, async () => {
      const name = `durable-close-${setting.name}`;
      const answer = await scenario(name, 'sha1', [{ s: 'syncShim', faults: ['sync', 'close'] }, { s: 'markPending', directory: log(name) }, { s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'commit', st: 'a' },
        { s: 'syncLog' }, { s: 'syncShim', off: true }], { build: pendingLedger, setting, label: 'sync and close failing' });
      assert.equal(answer.ok[4].error?.$error?.syscall, 'close', `${where()} ${raw(answer)}`);
    });

    test(`a commit waits for the sync in flight, and syncs itself when that one failed (${setting.name})`, async () => {
      const name = `durable-wait-${setting.name}`;
      const answer = await scenario(name, 'sha1', [{ s: 'syncShim', faults: ['sync'] }, { s: 'markPending', directory: log(name) },
        { s: 'open', as: 'b', cwd: `<root>/${name}`, gitDir: `<root>/${name}/git` }, { s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'set', st: 'b', key: 'k/c.json', value: 3 },
        { s: 'concurrent', steps: [{ s: 'commit', st: 'a' }, { s: 'commit', st: 'b' }] }, { s: 'syncLog' }, { s: 'syncShim', off: true }], { build: pendingLedger, setting, label: 'a sync in flight waited for' });
      assert.equal(answer.ok.at(-2).ok.filter((line) => line.startsWith('sync ')).length, 2, `${where()} ${raw(answer)}`);
    });
  }

  test('system calls per installed object and per commit are the JavaScript\'s (macOS, interposed; F_FULLFSYNC refused and every sync refused too)', { skip: process.platform !== 'darwin' && 'DYLD interposition exists only on macOS; the counting shim above covers the sync on every platform' }, async () => {
    const interposerSource = path.join(here, 'trace-interpose.c');
    const library = path.join(scratch, 'trace-interpose.dylib');
    const built = spawnSync('cc', ['-O1', '-dynamiclib', '-o', library, interposerSource], { encoding: 'utf8' });
    assert.equal(built.status, 0, `cc could not build the interposer: ${built.stderr}`);
    const steps = (name) => [{ s: 'open', as: 'a', cwd: `<root>/${name}`, gitDir: `<root>/${name}/git` }, { s: 'markPending', directory: `<root>/${name}/objects` },
      { s: 'set', st: 'a', key: 'k/b.json', value: 2 }, { s: 'set', st: 'a', key: 'n/d/e.json', value: { e: 1 } }, { s: 'commit', st: 'a' },
      { s: 'env', set: { DEVRYAN_LEDGER_DIRECT_TREES: '0' } }, { s: 'markPending', directory: `<root>/${name}/objects` }, { s: 'set', st: 'a', key: 'k/c.json', value: 3 }, { s: 'commit', st: 'a' },
      { s: 'env', set: { DEVRYAN_LEDGER_DIRECT_TREES: null } }, { s: 'state', st: 'a' }];
    for (const fail of ['', 'fullfsync', 'fullfsync,barrier,fsync']) {
      const name = `traced-${fail.replace(/[^a-z]+/g, '-') || 'plain'}`;
      prepare(name, (dir, format = 'sha1') => { fs.mkdirSync(path.join(dir, 'objects')); return ledger(dir, format, { records: { 'k/a.json': '1' } }); });
      const traces = {};
      // One traced server at a time (the arms' own servers stay idle).
      for (const arm of arms) {
        const out = path.join(scratch, `${name}-${arm.name}.trace`);
        const base = { ...cleanEnv, PATH: basePath, LANG: 'en_US.UTF-8', DYLD_INSERT_LIBRARIES: library, LEDGER_TRACE_OUT: out, LEDGER_TRACE_FILTER: `${arm.root}/${name}/`, ...(fail ? { LEDGER_TRACE_FAIL: fail } : {}) };
        const traced = arm.name === 'js'
          ? server('traced Electron\'s Node', reference.command, ['--no-warnings', path.join(here, 'store-js-arm.mjs')], { ...base, ...reference.env })
          : server('the traced Rust', probe, ['store'], base);
        let answer;
        try { answer = rooted(await traced.request(placed({ op: 'store', id: name, steps: steps(name) }, arm)), arm); } finally { await traced.close(); }
        traces[arm.name] = { answer, calls: mutationCalls(fs.readFileSync(out, 'utf8'), `${arm.root}/${name}`) };
        fs.rmSync(out, { force: true });
      }
      const { js, rust } = traces;
      assert.deepEqual(rust.answer, js.answer, `${where()} ${name}: the answers differ\n  JavaScript: ${raw(js.answer)}\n  Rust:       ${raw(rust.answer)}`);
      assert.ok(js.calls.syncs.length >= 2 || fail.includes('fsync'), `${where()} ${name}: the JavaScript synced ${raw(js.calls.syncs)}`);
      assert.ok(js.calls.objects.length >= 4 && js.calls.objects.every((object) => object.calls.length === 5) || fail.includes('fsync'), `${where()} ${name}: the JavaScript's installs were not traced: ${raw(js.calls.objects)}`);
      assert.deepEqual(rust.calls.syncs, js.calls.syncs, `${where()} ${name}: the directory syncs differ\n  JavaScript: ${raw(js.calls.syncs)}\n  Rust:       ${raw(rust.calls.syncs)}`);
      assert.deepEqual(rust.calls.objects, js.calls.objects, `${where()} ${name}: the calls per installed object differ\n  JavaScript: ${raw(js.calls.objects)}\n  Rust:       ${raw(rust.calls.objects)}`);
      assert.deepEqual(rust.calls.order, js.calls.order, `${where()} ${name}: a sync is not where the JavaScript makes it (before the commit's first object)\n  JavaScript: ${raw(js.calls.order)}\n  Rust:       ${raw(rust.calls.order)}`);
    }
  });
});

/**
 * The calls that change the disk, from one traced server: the object
 * directory's syncs (open, fcntl, fsync, close of `<dir>/objects`, in order),
 * each loose object's install (its temporary's open, write, close, link,
 * unlink; the compressed length left out, as zlib's output may differ), as a
 * sorted list per target, and where each sync stands among the installs.
 */
function mutationCalls(text, dir) {
  const objectsDir = `${dir}/objects`;
  const names = new Map(), readOnly = new Set();
  const syncs = [], groups = new Map(), order = [];
  let current = [];
  const tmpOf = new Map();
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const fd = /^fd (\d+) (.*)$/.exec(line);
    if (fd) { names.set(fd[1], fd[2]); continue; }
    const shown = line.replace(/#(\d+)/, (_, number) => `#${names.get(number) ?? number}`).split(dir).join('<dir>');
    const opened = /^open (\S+) flags=0x([0-9a-f]+) /.exec(line);
    if (opened) {
      const flags = parseInt(opened[2], 16);
      if (opened[1] === objectsDir) { current = [shown]; syncs.push(current); order.push('sync'); continue; }
      if ((flags & 3) === 0) { readOnly.add(opened[1]); continue; }
      const tmp = /tmp_obj_[^/]+$/.test(opened[1]) ? opened[1] : null;
      if (tmp) { groups.set(tmp, [shown.replace(/tmp_obj_[^ ]+/, 'tmp_obj_<id>')]); order.push('object'); }
      continue;
    }
    const target = /#(\S+)/.exec(shown)?.[1]?.replace('<dir>', dir);
    if (/^(fcntl|fsync|close) /.test(line) && target === objectsDir) { current.push(shown); continue; }
    if (/^(write|close) /.test(line) && groups.has(target)) { groups.get(target).push(shown.replace(/tmp_obj_[^ ]+/, 'tmp_obj_<id>').replace(/len=\d+ = \d+/, 'len=<n> = <n>')); continue; }
    const linked = /^link (\S+) (\S+) /.exec(line);
    if (linked && groups.has(linked[1])) { groups.get(linked[1]).push(shown.replace(/tmp_obj_[^ ]+/, 'tmp_obj_<id>')); tmpOf.set(linked[1], linked[2]); continue; }
    const unlinked = /^unlink (\S+) /.exec(line);
    if (unlinked && groups.has(unlinked[1])) groups.get(unlinked[1]).push(shown.replace(/tmp_obj_[^ ]+/, 'tmp_obj_<id>'));
  }
  const objects = [...groups].map(([tmp, calls]) => ({ target: (tmpOf.get(tmp) ?? '?').split(dir).join('<dir>'), calls })).sort((a, b) => a.target.localeCompare(b.target));
  // Where the syncs stand: each before the objects of its commit (runs of 'object' collapsed).
  return { syncs, objects, order: order.filter((entry, index) => entry === 'sync' || order[index - 1] !== 'object') };
}
