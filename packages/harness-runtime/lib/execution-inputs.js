import fs from 'node:fs/promises';
import path from 'node:path';

// Dependency inputs are linked read-only into views and never ingested: these
// names anywhere, plus (in Git projects) every directory Git ignores that holds
// no tracked path. An ignored standalone file such as `.env` is still ingested.
export const DEPENDENCY_INPUT_NAMES = Object.freeze(new Set(['node_modules', '.venv', '__pycache__']));

// Ignored output folders (build output, test reports, logs, tool caches such as
// a Vite cacheDir under `.artifacts/`) are written through to the project on
// macOS: denying them left agents unable to run the project's own tooling. Git
// does not track them and the ledger never ingests, publishes or reverts them.
// Installed dependencies stay read-only, and hidden folders are writable only
// when they are known output locations: an ignored `.husky/_`, `.opencode/` or
// `.claude/` holds host-executed hooks or agent policy. Any component of the
// input path (and of its resolved location) must pass.
// Kill switch: DEVRYAN_IGNORED_WRITE_THROUGH=0.
const READ_ONLY_IGNORED_NAMES = new Set([...DEPENDENCY_INPUT_NAMES,
  'venv', 'env', 'site-packages', 'vendor', 'bower_components', 'jspm_packages', 'Pods', 'Carthage']);
const HIDDEN_OUTPUT_NAMES = new Set(['.artifacts', '.build', '.cache', '.next', '.nuxt', '.output', '.svelte-kit',
  '.turbo', '.parcel-cache', '.vite', '.angular', '.expo', '.docusaurus', '.nyc_output', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.tmp', '.temp', '.wrangler', '.vercel-output']);
// Bounds the generated profile; projects with more ignored output folders keep
// the remainder read-only.
export const MAX_WRITABLE_INPUTS = 256;

const writableComponents = (relative) => {
  const parts = relative.split(/[\\/]/);
  return parts.length > 0 && parts.every((part) => part && part !== '.' && part !== '..'
    && !READ_ONLY_IGNORED_NAMES.has(part) && !part.startsWith('.git')
    && (!part.startsWith('.') || HIDDEN_OUTPUT_NAMES.has(part)));
};

export const writeThroughEnabled = () => process.env.DEVRYAN_IGNORED_WRITE_THROUGH !== '0';

const strictlyInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const overlaps = (a, b) => a === b || strictlyInside(a, b) || strictlyInside(b, a);

/** Resolved project directories a confined call may write through its view's
 * input links. `protectedDirectories` (the ledger root) are never granted, nor
 * is anything whose resolved location leaves the project or lands on a
 * read-only name. */
export async function writableInputDirectories({ inputs, projectDirectory, protectedDirectories = [] }) {
  if (!writeThroughEnabled() || !Array.isArray(inputs) || !inputs.length || !path.isAbsolute(projectDirectory ?? '')) return [];
  let project;
  try { project = await fs.realpath(projectDirectory); } catch { return []; }
  const guarded = [];
  for (const directory of protectedDirectories) {
    if (!directory) continue;
    guarded.push(path.resolve(directory));
    guarded.push(await fs.realpath(directory).catch(() => path.resolve(directory)));
  }
  const granted = [];
  for (const file of inputs) {
    if (granted.length >= MAX_WRITABLE_INPUTS) break;
    if (typeof file !== 'string' || path.isAbsolute(file) || !writableComponents(file)) continue;
    let resolved;
    try { resolved = await fs.realpath(path.join(project, file)); }
    catch (cause) { if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(cause.code)) continue; throw cause; }
    if (!strictlyInside(project, resolved) || !writableComponents(path.relative(project, resolved))) continue;
    if (!(await fs.stat(resolved).catch(() => null))?.isDirectory()) continue;
    if (guarded.some((directory) => overlaps(directory, resolved))) continue;
    if (!granted.includes(resolved)) granted.push(resolved);
  }
  return granted;
}
