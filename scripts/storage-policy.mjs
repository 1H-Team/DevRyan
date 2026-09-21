import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const run = promisify(execFile);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const within = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
export const retentionName = 'storage-retention.json';
export const packagePattern = /^\.cache\/qa\/packaged-electron-[A-Za-z0-9]+$/;
export const buildPaths = ['packages/desktop/src-tauri/target/release', 'packages/desktop/src-tauri/target/debug/incremental'];

export async function optionalJson(file) {
  try {
    const content = await readFile(file, 'utf8');
    try { return JSON.parse(content); }
    catch { throw new Error('Invalid JSON storage metadata'); }
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Check each ancestor without following directory aliases, even inside the repo.
export async function confined(root, relative, missing = false) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid repository-relative path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink ancestor is protected'); }
    catch (error) { if (missing && error.code === 'ENOENT') continue; throw error; }
  }
  return current;
}

export async function treeIdentity(directory) {
  const digest = createHash('sha256');
  const inodes = new Set();
  let allocatedBytes = 0, latestMtimeMs = 0, files = 0;
  const visit = async (file, relative) => {
    const stat = await lstat(file);
    const key = `${stat.dev}:${stat.ino}`;
    if (!inodes.has(key)) { allocatedBytes += stat.blocks * 512; inodes.add(key); }
    latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
    files++;
    let link = null;
    if (stat.isSymbolicLink()) {
      link = await readlink(file);
      if (!within(directory, await realpath(file))) throw new Error('Payload contains an escaping symlink');
    } else if (!stat.isDirectory() && !stat.isFile()) throw new Error('Payload contains a special file');
    digest.update(JSON.stringify([relative, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, link]));
    if (stat.isDirectory()) for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), `${relative}/${name}`);
  };
  await visit(directory, '.');
  return { fingerprint: digest.digest('hex'), allocatedBytes, latestMtimeMs, files };
}

export async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export async function processUsage(root) {
  try {
    // Never expose process arguments, environment values or external filenames.
    const { stdout, stderr } = await run('lsof', ['-nP', '-Fpn'], { maxBuffer: 64 * 1024 * 1024 });
    if (stderr.trim()) return { known: false, paths: [] };
    const paths = [];
    let pid;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      if (line.startsWith(`n${root}/`)) paths.push({ pid, path: line.slice(1) });
    }
    return { known: true, paths };
  } catch { return { known: false, paths: [] }; }
}

export function activityReasons(root, relative, usage) {
  if (!usage.known) return ['Process visibility unavailable'];
  const target = path.join(root, relative);
  return usage.paths.some(entry => within(target, entry.path)) ? ['In use by a process'] : [];
}

export const activityScope = entry => entry.kind === 'cargo-cache' ? 'packages/desktop'
  : entry.path.replace(/\/app\/mac-arm64\/DevRyan QA\.app$/, '');

export async function gitState(root) {
  const options = { cwd: root, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const { stdout } = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], options);
  const { stdout: worktrees } = await run('git', ['worktree', 'list', '--porcelain'], options);
  return { protectedFiles: stdout.split('\0').filter(Boolean),
    worktrees: worktrees.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9)).filter(p => p !== root) };
}

// Read only repository docs/source and direct QA/performance configuration JSON.
// Record matching package paths, never the surrounding potentially private values.
export async function packageReferences(root, sourceFiles) {
  const references = new Map();
  const files = sourceFiles.filter(p => /^(docs|scripts)\//.test(p) && /\.(md|mjs|json)$/.test(p));
  for (const dir of ['.cache/qa', '.cache/perf']) {
    try {
      await confined(root, dir);
      for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) files.push(`${dir}/${entry.name}`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const relative of files) {
    const file = await confined(root, relative);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
      if (relative.endsWith('.json')) throw new Error('Configuration reference scan is incomplete');
      continue;
    }
    const content = await readFile(file, 'utf8');
    for (const line of content.split('\n')) {
      for (const match of line.matchAll(/\.cache\/qa\/packaged-electron-[A-Za-z0-9]+/g)) {
        const items = references.get(match[0]) ?? [];
        items.push({ source: relative, required: relative.startsWith('.cache/') || /\bbaseline\b|nativeSourceApp/i.test(line) });
        references.set(match[0], items);
      }
    }
  }
  return references;
}

export function recognized(relative, kind) {
  if (kind === 'qa-app') return packagePattern.test(relative.replace(/\/app\/mac-arm64\/DevRyan QA\.app$/, ''))
    && relative.endsWith('/app/mac-arm64/DevRyan QA.app');
  return kind === 'cargo-cache' && buildPaths.includes(relative);
}
