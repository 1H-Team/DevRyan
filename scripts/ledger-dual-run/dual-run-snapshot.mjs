// What a run leaves on disk, read without the ledger's own code: every file
// under the stage (type, mode, bytes or digest, link target) and, for each
// ledger root, its Git repository read through Git itself (refs, and every
// object with its type and content whatever its packing) plus the result of
// `git fsck --strict`.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const KEEP_BYTES = 1024 * 1024;
const digest = (data) => createHash('sha256').update(data).digest('hex');
// Every Git command the harness runs itself reads no configuration, hooks or
// templates of the machine's owner: no system or global file, and HOME and the
// XDG folders pointed at nothing.
export const isolatedGitEnvironment = (base = process.env) => {
  const env = {};
  for (const [name, value] of Object.entries(base)) if (!/^GIT_/.test(name) && !/^XDG_CONFIG_HOME$/.test(name)) env[name] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', HOME: '/var/empty', XDG_CONFIG_HOME: '/var/empty' };
};
const gitEnv = isolatedGitEnvironment();
export const runGit = (args, { env = {}, input } = {}) => new Promise((resolve) => {
  const child = execFile('git', args, { env: { ...gitEnv, ...env }, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr: stderr.toString() });
  });
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
});

/**
 * Every entry under `root` (relative POSIX paths), skipping the subtrees named
 * in `skip` (relative paths) and reading no bytes of the files `listOnly`
 * accepts (loose Git objects and packs, compared through Git).
 */
export async function walkFiles(root, { skip = new Set(), listOnly = () => false } = {}) {
  const entries = new Map();
  const visit = async (relative) => {
    const absolute = relative ? path.join(root, relative) : root;
    let stat;
    try { stat = await fs.lstat(absolute); } catch { return; }
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) { entries.set(relative, { type: 'symlink', mode, target: await fs.readlink(absolute) }); return; }
    if (stat.isDirectory()) {
      if (relative) entries.set(relative, { type: 'dir', mode });
      if (skip.has(relative)) return;
      for (const name of (await fs.readdir(absolute)).sort()) await visit(relative ? `${relative}/${name}` : name);
      return;
    }
    if (!stat.isFile()) { entries.set(relative, { type: 'other', mode }); return; }
    if (listOnly(relative)) { entries.set(relative, { type: 'file', mode, size: stat.size, listed: true }); return; }
    const data = await fs.readFile(absolute);
    entries.set(relative, { type: 'file', mode, size: data.length, sha256: digest(data), ...(data.length <= KEEP_BYTES ? { data } : {}) });
  };
  await visit('');
  return entries;
}

/** Ledger roots under a storage directory: directories holding `git/` (a bare repository). */
export async function ledgerRoots(storage) {
  const names = await fs.readdir(storage).catch(() => []);
  const roots = [];
  for (const name of names.sort()) {
    const stat = await fs.stat(path.join(storage, name, 'git', 'HEAD')).catch(() => null);
    if (stat) roots.push(name);
  }
  return roots;
}

/** Every object of a repository, read by Git: Map<id, { type, data }>, its refs, loose/packed split and fsck. */
export async function readRepository(gitDir) {
  const format = (await runGit(['--git-dir', gitDir, 'rev-parse', '--show-object-format'])).stdout.toString().trim() || 'sha1';
  const refsOut = await runGit(['--git-dir', gitDir, 'for-each-ref', '--format=%(refname) %(objectname) %(objecttype)']);
  const refs = refsOut.stdout.toString().split('\n').filter(Boolean).map((line) => { const [name, id, type] = line.split(' '); return { name, id, type }; });
  const head = await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => null);
  const batch = await runGit(['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--unordered', '--batch']);
  const objects = new Map();
  const out = batch.stdout;
  for (let offset = 0; offset < out.length;) {
    const newline = out.indexOf(0x0a, offset);
    const [id, type, size] = out.subarray(offset, newline).toString().split(' ');
    const length = Number(size);
    objects.set(id, { type, data: Buffer.from(out.subarray(newline + 1, newline + 1 + length)) });
    offset = newline + 1 + length + 1;
  }
  const loose = new Set();
  const objectsDir = path.join(gitDir, 'objects');
  for (const fan of await fs.readdir(objectsDir).catch(() => [])) {
    if (!/^[0-9a-f]{2}$/.test(fan)) continue;
    for (const rest of await fs.readdir(path.join(objectsDir, fan))) if (/^[0-9a-f]+$/.test(rest)) loose.add(fan + rest);
  }
  const packs = (await fs.readdir(path.join(objectsDir, 'pack')).catch(() => [])).filter((name) => name.endsWith('.pack')).length;
  const fsck = await runGit(['--git-dir', gitDir, 'fsck', '--strict', '--no-progress', '--no-dangling', '--full']);
  return { format, refs, head, objects, loose, packs, fsck: { code: fsck.code, output: (fsck.stdout.toString() + fsck.stderr).trim() } };
}

/** Index entries (mode, object, stage, path) of a Git index file, read by Git. */
export async function readIndexFile(gitDir, indexFile) {
  const listed = await runGit(['--git-dir', gitDir, 'ls-files', '--stage', '-z'], { env: { GIT_INDEX_FILE: indexFile } });
  if (listed.code !== 0) return { error: listed.stderr.trim() };
  return { entries: listed.stdout.toString().split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, id, stage] = line.slice(0, tab).split(' ');
    return { mode, id, stage, path: line.slice(tab + 1) };
  }) };
}

/**
 * A stage after a run: `files` (everything but the private home and temp
 * folders, and the object stores of the ledgers' Git repositories, which are
 * read through Git), and `ledgers` keyed by ledger root name.
 */
export async function captureSnapshot(stage, { storage = 'ledger' } = {}) {
  const storageDir = path.join(stage, storage);
  const roots = await ledgerRoots(storageDir);
  // Loose objects and packs are read through Git; everything else under the
  // objects folder (info/alternates, a leftover tmp_obj_*) is a file like any other.
  const objectFile = new RegExp(`^${escape(storage)}/[^/]+/git/objects/(?:[0-9a-f]{2}/[0-9a-f]{38,62}|pack/pack-[0-9a-f]+\\.(?:pack|idx|rev|bitmap))$`);
  const files = await walkFiles(stage, { skip: new Set(['home', 'tmp']), listOnly: (relative) => objectFile.test(relative) });
  const ledgers = {};
  for (const root of roots) ledgers[root] = await readRepository(path.join(storageDir, root, 'git'));
  return { stage, storage, files, ledgers };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One stat observation of a stage (synchronous, bigint lstat, as the ledger
 * stamps files): `stamps` maps `dev:ino:size:mtimeNs:ctimeNs:mode` to the
 * stage-relative path, `inodes` maps `dev:ino` to it. The private home and
 * temp folders and the ledgers' Git object stores are not observed.
 */
export function observeStage(stage, storage = 'ledger') {
  const stamps = new Map(), inodes = new Map();
  const gitObjects = new RegExp(`^${escape(storage)}/[^/]+/git/objects$`);
  const visit = (relative) => {
    const absolute = relative ? path.join(stage, relative) : stage;
    let stat;
    try { stat = lstatSync(absolute, { bigint: true }); } catch { return; }
    if (relative) {
      stamps.set([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':'), relative);
      inodes.set(`${stat.dev}:${stat.ino}`, relative);
    }
    if (!stat.isDirectory() || gitObjects.test(relative) || ['home', 'tmp'].includes(relative)) return;
    let names = [];
    try { names = readdirSync(absolute); } catch { return; }
    for (const name of names) visit(relative ? `${relative}/${name}` : name);
  };
  visit('');
  return { stamps, inodes };
}

/** Parsed Git tree entries in stored order. */
export function parseTree(data, format = 'sha1') {
  const width = format === 'sha256' ? 32 : 20;
  const entries = [];
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(0x20, offset), nul = data.indexOf(0, space);
    const mode = data.subarray(offset, space).toString();
    const name = data.subarray(space + 1, nul).toString('latin1');
    const id = data.subarray(nul + 1, nul + 1 + width).toString('hex');
    entries.push({ mode, name, id });
    offset = nul + 1 + width;
  }
  return entries;
}

/** Git's own order of tree entries: bytewise on the name, a subtree compared as `name/`. */
export const gitTreeOrder = (left, right) => {
  const key = (entry) => Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'latin1');
  return Buffer.compare(key(left), key(right));
};

export const gitVersion = () => execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
