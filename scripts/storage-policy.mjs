import { createHash } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, readdirSync, readFileSync, readSync, statfsSync } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
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

export function recognized(relative, kind, entry = {}) {
  if (kind === 'remove' || kind === 'strip') return recognizedCacheTarget(relative, kind, entry.targets);
  if (kind === 'qa-app') return packagePattern.test(relative.replace(/\/app\/mac-arm64\/DevRyan QA\.app$/, ''))
    && relative.endsWith('/app/mac-arm64/DevRyan QA.app');
  return kind === 'cargo-cache' && buildPaths.includes(relative);
}


// ---------------------------------------------------------------------------
// `.cache` retention policy: registry, citations, heavy-payload detection.
// ---------------------------------------------------------------------------

export const day = 86400000;
export const defaultMaxBytes = 50 * 2 ** 30;
export const minFreeBytes = 20 * 2 ** 30;
export const minimumAgeMs = { scratch: day, 'run-evidence': 3 * day, session: 14 * day, unowned: 14 * day };
export const keptFailuresPerFamily = 5;
export const keptRebuildables = 2;

// Class meanings: scratch = delete whole after 24 h; run-evidence = strip heavy subtrees after 3 days, keep light
// files; session = strip heavy subtrees after 14 days; unowned = delete after 14 days (strip when cited);
// report-only classes are sized and listed but never selected.
const reg = (klass, owner) => ({ class: klass, owner });
const exactFamilies = {
  qa: reg('run-evidence', 'scripts/qa/*.mjs QA runners (packaged-electron-* packages: scripts/qa/package-electron.mjs)'),
  'v2-validation': reg('run-evidence', 'scripts/verify-opencode-v2-*.mjs, scripts/opencode-v2-native/*'),
  perf: reg('run-evidence', 'scripts/perf/*.mjs benchmarks'),
  livetest: reg('run-evidence', 'live-journey runs (docs/QA.md)'),
  'opencode-upgrade': reg('run-evidence', 'OpenCode upgrade verification runs'),
  'v2-spike': reg('run-evidence', 'reviewed v2 spike inputs (packages/web/runtime/reviewed-inputs)'),
  'browser-upgrade': reg('run-evidence', 'packages/electron/tests/browser-inspection/upgrade-*.mjs'),
  'browser-inspect': reg('run-evidence', 'packages/electron/tests/browser-inspection/run.mjs'),
  'test-fixtures': reg('scratch', 'disposable test fixtures (scripts/qa/*, scripts/verify-*.mjs, tests)'),
  wf: reg('scratch', 'workflow scratch (agent workflow tmp)'),
  'storage-tests': reg('scratch', 'scripts/storage.test.mjs fixtures'),
  sessions: reg('session', 'agent session logs (.cache/sessions/<date>-<task>/)'),
  worktrees: reg('worktrees', 'agent worktrees (git worktree)'),
  storage: reg('report-only', 'scripts/storage.mjs manifests and cleanup reports'),
  eslint: reg('tool-cache', 'ESLint caches (packages/*/package.json)'),
  typecheck: reg('tool-cache', 'TypeScript build info (packages/*/tsconfig.json)'),
  'plugin-upgrades': reg('build-input', 'dependency snapshots and evidence'),
  'session-execution': reg('build-input', 'scripts/build-session-execution.mjs'),
  'windows-native': reg('build-input', 'scripts/build-native-runtime.mjs, scripts/build-windows-git.mjs'),
};
export const reportOnlyClasses = new Set(['report-only', 'tool-cache', 'build-input', 'worktrees']);
const unitScratch = [/^journal-reader-/, /^compaction-journal-/];

export function familyRegistry(name) {
  if (exactFamilies[name]) return exactFamilies[name];
  if (/^release-/.test(name)) return reg('run-evidence', 'release procedure runs (docs/RELEASE*.md)');
  return reg('unowned', 'unowned: no registered producer');
}

// Classify one candidate unit: `.cache/<family>` for unowned entries, `.cache/<family>/<child>` otherwise.
export function classifyUnit(family, child) {
  const base = familyRegistry(family);
  if (child === undefined) return base;
  if (reportOnlyClasses.has(base.class) || base.class === 'unowned') return null;
  if (child === 'tmp') return reg('scratch', `${family}/tmp scratch`);
  if (family === 'v2-validation' && unitScratch.some(pattern => pattern.test(child))) return reg('scratch', base.owner);
  return base;
}
export const unitDepth = klass => (klass === 'unowned' ? 1 : 2);
export const rebuildablePattern = /^native-artifact(-|$)/;

// Exact paths code reads as inputs or docs cite as artifact roots; never selected, even though they are heavy.
export const protectedInputs = [
  'v2-spike/homes/g2-01-seam-smoke/cache/opencode/bin/rg',
  'v2-validation/native-artifact', 'v2-validation/native-artifact-claude-floor-A', 'v2-validation/native-artifact-claude-final-B',
  'v2-validation/quota-fixtures', 'perf/ledger-fixtures', 'perf/ledger-bench', 'perf/multi-session',
  'browser-upgrade/current', 'test-fixtures/verified-runtime', 'test-fixtures/foreign',
].map(item => `.cache/${item}`);

const heavyDirectories = new Set(['node_modules', '.bun', 'runtime-bundles', 'Cache', 'Code Cache', 'GPUCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'component_crx_cache']);
const heavySuffixes = ['/.cache/bun', '/install/cache'];
const binaryExtensions = new Set(['.dmg', '.asar', '.node', '.dylib', '.so', '.dll', '.exe', '.wasm', '.pak', '.msi', '.msix', '.appx', '.nupkg', '.pdb']);
export const lightExtensions = new Set(['.json', '.jsonl', '.ndjson', '.log', '.txt', '.md', '.png', '.sha256', '.err']);
const textExtensions = new Set([...lightExtensions, '.mjs', '.js', '.cjs', '.ts', '.patch', '.out', '.csv', '.html', '.css', '.map',
  '.yml', '.yaml', '.toml', '.xml', '.svg', '.jpg', '.jpeg', '.webp', '.gif', '.db', '.sqlite', '.db-wal', '.db-shm', '.wal', '.npm']);
const executableMagic = new Set(['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'feedface', 'cefaedfe', '7f454c46']);

export const isHeavyDirectory = (relative, names) => {
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  return heavyDirectories.has(name) || name.endsWith('.app') || heavySuffixes.some(suffix => relative.endsWith(suffix)) || names.includes('CACHEDIR.TAG');
};

function isExecutableFile(file, size, extension) {
  if (size < 256 * 1024 || textExtensions.has(extension)) return false;
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const buffer = Buffer.alloc(4);
    readSync(descriptor, buffer, 0, 4, 0);
    const magic = buffer.toString('hex');
    return executableMagic.has(magic) || magic.startsWith('4d5a');
  } catch { return false; } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

// Every `.cache/...` path mentioned by tracked or non-ignored files, plus direct QA/perf configuration JSON.
// Matches are paths only, never the surrounding text.
export async function cacheCitations(root, sourceFiles = []) {
  const exact = new Map();
  const prefixes = [];
  const add = (raw, source) => {
    let value = raw.replace(/[.,:;'"`)\]}>]+$/, '');
    const glob = value.endsWith('*');
    value = value.replace(/\*+$/, '').replace(/\/+$/, '');
    if (!/^\.cache\/[^/]/.test(value) || value.split('/').some(part => part === '..')) return;
    if (glob) prefixes.push(value);
    else if (!exact.has(value)) exact.set(value, source);
  };
  const textFile = /\.(md|mjs|cjs|js|jsx|ts|tsx|json|ya?ml|sh|toml|txt)$/;
  const excluded = [':!bun.lock', ':!**/package-lock.json', ':!**/*.lock', ':!**/pnpm-lock.yaml'];
  try {
    const { stdout } = await run('git', ['grep', '-z', '-I', '--untracked', '-o', '-E', String.raw`\.cache/[A-Za-z0-9_@+=%~.,:/*-]+`, '--', '.', ...excluded],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    for (const line of stdout.split('\n')) {
      const split = line.indexOf('\0');
      if (split > 0) add(line.slice(split + 1), line.slice(0, split));
      else if (line) throw new Error('Cache citation scan produced unparseable output; refusing to prune');
    }
  } catch (error) { if (error.code !== 1) throw new Error('Cache citation scan failed; refusing to prune'); }
  for (const dir of ['.cache/qa', '.cache/perf']) {
    let names = [];
    try { names = readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of names) {
      if (!entry.isFile() || !textFile.test(entry.name)) continue;
      const file = path.join(root, dir, entry.name);
      if (lstatSync(file).size > 8 * 1024 * 1024) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/\.cache\/[A-Za-z0-9_@+=%~.,:/*-]+/g)) add(match[0], `${dir}/${entry.name}`);
    }
  }
  const ancestors = new Set();
  for (const item of [...exact.keys(), ...prefixes]) {
    const parts = item.split('/');
    for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join('/'));
  }
  return { exact, prefixes, ancestors };
}

// Protection model. `fullyProtected`: never touched (cited files, cited heavy directories, code-read inputs).
// `containsProtected`: something protected lives inside, so heavy directories must be entered, not removed whole.
// `blocksRemoval`: the unit may not be deleted wholesale (cited itself or contains a cited/protected path).
export function makeProtection(citations, inputs = protectedInputs) {
  const cited = relative => citations.exact.has(relative) || citations.prefixes.some(prefix => relative.startsWith(prefix));
  return {
    cited,
    fullyProtected: (relative, directory) => inputs.some(input => within(input, relative))
      || (cited(relative) && !directory),
    heavyCited: relative => cited(relative),
    containsProtected: relative => citations.ancestors.has(relative) || inputs.some(input => input.startsWith(`${relative}/`)),
    blocksRemoval: relative => cited(relative) || citations.ancestors.has(relative)
      || inputs.some(input => within(input, relative) || within(relative, input)),
  };
}

// Synchronous, symlink-safe walk of one unit. Records identity (for the apply-time recheck), allocated bytes,
// the newest modification time, and the heavy subtrees/binaries that a strip would remove.
export function scanUnit(root, relative, protection, { detectHeavy = true } = {}) {
  const digest = createHash('sha256');
  const inodes = new Set();
  const result = { bytes: 0, latestMtimeMs: 0, files: 0, targets: [], protectedBytes: 0 };
  const account = (stat, name) => {
    const key = `${stat.dev}:${stat.ino}`;
    let counted = 0;
    if (!inodes.has(key)) { counted = stat.blocks * 512; result.bytes += counted; inodes.add(key); }
    result.latestMtimeMs = Math.max(result.latestMtimeMs, stat.mtimeMs);
    result.files++;
    digest.update(`${name}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\n`);
    return counted;
  };
  const sizeOnly = (file, name) => {
    let stat;
    try { stat = lstatSync(file); } catch { return 0; }
    let total = account(stat, name);
    if (stat.isDirectory()) {
      let names = [];
      try { names = readdirSync(file).sort(); } catch { return total; }
      for (const child of names) total += sizeOnly(path.join(file, child), `${name}/${child}`);
    }
    return total;
  };
  const target = (name, bytes) => result.targets.push({ path: name, bytes });
  // Inside a heavy directory that holds protected paths: strip everything except the protected chain.
  const stripAround = (file, name) => {
    let names = [];
    try { names = readdirSync(file).sort(); } catch { return; }
    for (const child of names) {
      const childFile = path.join(file, child), childName = `${name}/${child}`;
      let stat;
      try { stat = lstatSync(childFile); } catch { continue; }
      const directory = stat.isDirectory();
      if (protection.fullyProtected(childName, directory) || (directory && protection.heavyCited(childName))) { sizeOnly(childFile, childName); continue; }
      if (directory && protection.containsProtected(childName)) { account(stat, childName); stripAround(childFile, childName); continue; }
      target(childName, sizeOnly(childFile, childName));
    }
  };
  const visit = (file, name) => {
    let stat;
    try { stat = lstatSync(file); } catch { return; }
    if (!stat.isDirectory()) {
      const counted = account(stat, name);
      if (!detectHeavy || stat.isSymbolicLink() || !stat.isFile()) return;
      const extension = path.extname(name).toLowerCase();
      if ((binaryExtensions.has(extension) || isExecutableFile(file, stat.size, extension))
        && !protection.fullyProtected(name, false)) target(name, counted);
      return;
    }
    let names;
    try { names = readdirSync(file).sort(); } catch { account(stat, name); return; }
    if (detectHeavy && isHeavyDirectory(name, names)) {
      if (protection.fullyProtected(name, true) || protection.heavyCited(name)) { sizeOnly(file, name); return; }
      if (protection.containsProtected(name)) { account(stat, name); stripAround(file, name); return; }
      target(name, sizeOnly(file, name));
      return;
    }
    account(stat, name);
    for (const child of names) visit(path.join(file, child), `${name}/${child}`);
  };
  visit(path.join(root, relative), relative);
  result.fingerprint = digest.digest('hex');
  result.targetBytes = result.targets.reduce((sum, item) => sum + item.bytes, 0);
  return result;
}

export function readRunMeta(directory) {
  const read = name => {
    try {
      const file = path.join(directory, name);
      if (lstatSync(file).size > 1024 * 1024) return null;
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch { return null; }
  };
  const runJson = read('run.json'), retention = read(retentionName), result = read('result.json');
  const completed = [runJson?.completedAt, retention?.completedAt].map(Date.parse).find(Number.isFinite);
  const failedWords = /^(fail|failed|failure|error|errored|blocked)$/i;
  const outcome = [result?.outcome, result?.status, result?.result].find(item => typeof item === 'string');
  const failed = runJson?.status === 'failed'
    || (!runJson && (retention?.payloadState === 'failed' || (outcome !== undefined && failedWords.test(outcome))
      || result?.ok === false || result?.passed === false));
  return { pinned: runJson?.pinned === true || retention?.pinned === true,
    status: runJson?.status ?? null, failed, completedMs: completed ?? null };
}

export function recognizedCacheTarget(relative, kind, targets) {
  const parts = relative.split('/');
  if (parts[0] !== '.cache' || parts.length < 2 || parts.length > 3 || parts.some(part => !part || part === '.' || part === '..')) return false;
  if (packagePattern.test(relative)) return false;
  const klass = classifyUnit(parts[1], parts[2]);
  if (!klass || reportOnlyClasses.has(klass.class) || parts.length !== unitDepth(klass.class) + 1) return false;
  if (kind === 'remove') return !protectedInputs.some(input => within(input, relative) || within(relative, input));
  if (!Array.isArray(targets) || !targets.length || protectedInputs.some(input => within(input, relative))) return false;
  return targets.every(item => typeof item === 'string' && within(relative, item)
    && !item.split('/').some(part => !part || part === '.' || part === '..')
    && !protectedInputs.some(input => within(item, input) || within(input, item)))
    && targets.every((a, i) => targets.every((b, j) => i === j || !within(a, b)));
}

export function diskStatus(root) {
  try { const stat = statfsSync(root); return { freeBytes: stat.bavail * stat.bsize }; }
  catch { return { freeBytes: null }; }
}

export function parseSize(value) {
  const match = /^(\d+(?:\.\d+)?)([GT])$/i.exec(String(value));
  if (!match) throw new Error('--max-size must look like 50G');
  return Math.round(Number(match[1]) * 2 ** (match[2].toUpperCase() === 'T' ? 40 : 30));
}

// Batched `git check-ignore` so thousands of candidates cost one process.
export function ignoredPaths(root, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(new Set(output.split('\0').filter(Boolean))));
    child.stdin.end(paths.map(item => `${item}\0`).join(''));
  });
}

export async function worktreeDetails(root) {
  const options = { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], options);
  const details = [];
  for (const block of stdout.split('\n\n').filter(Boolean)) {
    const lines = block.split('\n');
    const tree = lines.find(line => line.startsWith('worktree '))?.slice(9);
    if (!tree || tree === root) continue;
    const branch = lines.find(line => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null;
    const prunable = lines.some(line => line.startsWith('prunable'));
    let clean = false;
    if (!prunable) {
      try { clean = (await run('git', ['-C', tree, 'status', '--porcelain'], options)).stdout.trim() === ''; } catch { clean = false; }
    }
    details.push({ path: tree, branch, clean, prunable,
      advice: prunable ? 'git worktree prune'
        : clean && branch ? `git worktree remove ${JSON.stringify(tree)}` : null,
      note: prunable ? 'Registered but missing on disk'
        : !clean ? 'Uncommitted or untracked changes: keep' : !branch ? 'Detached HEAD: keep until the commit is on a branch' : 'Clean; HEAD is on a branch' });
  }
  return details;
}

export function measureCacheBytes(root, timeout = 60000) {
  const result = spawnSync('du', ['-sk', path.join(root, '.cache')], { encoding: 'utf8', timeout });
  const kilobytes = Number.parseInt(result.stdout ?? '', 10);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

// Warn only; never throws and never changes an exit status.
export function cacheBudgetWarning(root, { maxBytes = defaultMaxBytes, freeFloor = minFreeBytes, measure = measureCacheBytes, disk = diskStatus } = {}) {
  try {
    const messages = [];
    const bytes = measure(root);
    if (bytes !== null && bytes > maxBytes) messages.push(`.cache is ${(bytes / 2 ** 30).toFixed(1)} GiB, over the ${(maxBytes / 2 ** 30).toFixed(0)} GiB budget`);
    const { freeBytes } = disk(root);
    if (freeBytes !== null && freeBytes < freeFloor) messages.push(`only ${(freeBytes / 2 ** 30).toFixed(1)} GiB free disk (below ${(freeFloor / 2 ** 30).toFixed(0)} GiB)`);
    return messages.length ? `Warning: ${messages.join('; ')}. Run \`bun run cache:report\`, then \`bun run cache:prune\` (docs/STORAGE_CLEANUP.md).` : null;
  } catch { return null; }
}

export function warnIfCacheOverBudget(root, options) {
  const message = cacheBudgetWarning(root, options);
  if (message) console.warn(message);
  return message;
}
