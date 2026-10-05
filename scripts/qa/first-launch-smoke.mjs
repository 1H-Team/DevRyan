// Packaged first-launch smokes: launch a QA-packaged DevRyan on a private HOME
// holding an owner-shaped v1 tree (optionally pre-staged by the actual v2.0.0
// setup importer) and grade the first native-bundle provisioning.
// Usage: docs/QA.md "Packaged first-launch smokes".
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { createProjectIdFromPath } from '../../packages/web/server/lib/projects/project-id.js';
import { captureQaSourceIdentity, validateQaScreenshotFilename } from './artifact-evidence.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from './cdp.mjs';
import { createQaIsolatedRuntimeEnvironment, qaPlatformEnvironment } from './launch-environment.mjs';
import { loadQaPackagedArtifact } from './packaged-artifact.mjs';
import { reservePort, startOwnedProcess } from './process.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => child.startsWith(`${parent.replace(/\/$/, '')}${path.sep}`);
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

export const FIRST_LAUNCH_SCENARIOS = Object.freeze(['owner-shaped', 'v200-half-seed', 'v200-selected']);
export const DEFAULT_V200_ARTIFACTS = '/Applications/DevRyan.app/Contents/Resources/revert-runtime/darwin-arm64';
export const PLAN_COUNTS = Object.freeze([300, 200, 108]);
export const PROJECT_RECORD_COUNT = 8;
export const INITIAL_THEME_ID = 'aura-dark';
export const CHANGED_THEME_ID = 'catppuccin-dark';
const USAGE = 'Usage: node scripts/qa/first-launch-smoke.mjs --package-evidence <abs path> --scenario owner-shaped|v200-half-seed|v200-selected '
  + '[--v200-source <abs v2.0.0 checkout>] [--v200-artifacts <abs dir>] [--timeout-ms 180000] [--shell-exports] [--keep-runtime]';
const usageError = message => Object.assign(new Error(`${message}\n${USAGE}`), { code: 'qa_first_launch_usage' });

export function parseFirstLaunchArgs(argv) {
  const flags = { '--package-evidence': 'packageEvidence', '--scenario': 'scenario', '--v200-source': 'v200Source',
    '--v200-artifacts': 'v200Artifacts', '--timeout-ms': 'timeoutMs' };
  const switches = { '--keep-runtime': 'keepRuntime', '--shell-exports': 'shellExports' };
  const options = { v200Artifacts: DEFAULT_V200_ARTIFACTS, timeoutMs: 180000, keepRuntime: false, shellExports: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (switches[flag]) {
      if (seen.has(switches[flag])) throw usageError(`Duplicate ${flag}`);
      seen.add(switches[flag]); options[switches[flag]] = true; continue;
    }
    const key = flags[flag];
    if (!key) throw usageError(`Unknown argument: ${flag}`);
    if (seen.has(key)) throw usageError(`Duplicate ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw usageError(`${flag} requires a value`);
    seen.add(key); options[key] = value; index += 1;
  }
  if (!options.packageEvidence) throw usageError('--package-evidence is required');
  if (!FIRST_LAUNCH_SCENARIOS.includes(options.scenario)) throw usageError('--scenario must be owner-shaped, v200-half-seed or v200-selected');
  for (const key of ['packageEvidence', 'v200Source', 'v200Artifacts']) {
    if (options[key] !== undefined && !path.isAbsolute(options[key])) throw usageError(`${key} must be an absolute path`);
  }
  if (typeof options.timeoutMs === 'string') {
    if (!/^\d+$/.test(options.timeoutMs)) throw usageError('--timeout-ms must be an integer');
    options.timeoutMs = Number(options.timeoutMs);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10000 || options.timeoutMs > 900000) throw usageError('--timeout-ms must be 10000–900000');
  const v200 = options.scenario.startsWith('v200-');
  if (v200 && !options.v200Source) throw usageError(`--v200-source is required for ${options.scenario}`);
  if (!v200 && (seen.has('v200Source') || seen.has('v200Artifacts'))) throw usageError('--v200-source/--v200-artifacts apply only to v200 scenarios');
  return options;
}

/** Private runtime layout required by packaged-host-policy.mjs. */
export function firstLaunchLayout(runtimeRoot) {
  const home = path.join(runtimeRoot, 'home');
  return { runtimeRoot, home, data: path.join(home, '.config/openchamber'), profile: path.join(runtimeRoot, 'profile'),
    workspace: path.join(runtimeRoot, 'workspace'), credentials: path.join(runtimeRoot, 'credentials.env.json'),
    controlRoot: path.join(home, '.local/state/devryan/runtime-bundles'), freshSource: path.join(home, '.local/state/devryan/fresh-native-source'),
    projects: path.join(home, '.config/openchamber/projects'), shellConfig: path.join(home, '.config/qa-zsh') };
}

/** --shell-exports: v1-era rc exports the packaged app must drop from its login shell. */
export const SHELL_EXPORTS = Object.freeze({ OPENCODE_BINARY: '/opt/homebrew/bin/opencode', OPENCODE_HOST: 'http://127.0.0.1:4096',
  OPENCODE_SKIP_START: 'true', DEVRYAN_RUNTIME_BUNDLE_ROOT: '/nonexistent' });
const SHELL_RC_FILES = Object.freeze(['.zshenv', '.zprofile', '.zshrc']);

/** Pure: the private ZDOTDIR rc files (packaged-host-policy.mjs sets ZDOTDIR) carrying the exports. */
export function buildShellExportRcFiles(exports = SHELL_EXPORTS) {
  const body = Object.entries(exports).map(([name, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !/^[A-Za-z0-9_./:-]+$/.test(value)) throw new Error(`Unsafe shell export: ${name}`);
    return `export ${name}=${value}\n`;
  }).join('');
  return new Map(SHELL_RC_FILES.map(name => [name, `# devryan first-launch smoke --shell-exports\n${body}`]));
}

export async function writeShellExportRcFiles(shellConfig, files = buildShellExportRcFiles()) {
  await mkdir(shellConfig, { recursive: true, mode: 0o700 });
  for (const [name, text] of files) await writeFile(path.join(shellConfig, name), text, { flag: 'wx', mode: 0o600 });
  return [...files.keys()];
}

/** Pure: names logged by main's (and the server's) `[shell-env] ... ignored login-shell variables ...: A, B` lines. */
export function gradeShellExportLog(text, exports = SHELL_EXPORTS) {
  const lines = [...String(text).matchAll(/\[shell-env\][^\n]*?ignored login-shell variables[^\n:]*:\s*([^\n]*)/g)].map(match => match[1]);
  const logged = [...new Set(lines.flatMap(line => line.split(',').map(name => name.trim()).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))))].sort();
  return { logged, missing: Object.keys(exports).filter(name => !logged.includes(name)).sort(),
    valuesLogged: lines.some(line => Object.values(exports).some(value => line.includes(value))) };
}

// Finder metadata bytes: not JSON, exactly what broke v2.0.0's projects import.
const DS_STORE = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('Bud1'), Buffer.alloc(24, 0)]);
const APPLE_DOUBLE = Buffer.concat([Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]), Buffer.from('Mac OS X        '), Buffer.alloc(8, 0)]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const FIXTURE_KEYS = Object.freeze(['qa-fixture-not-a-real-key-alpha', 'qa-fixture-not-a-real-key-beta']);
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Pure: the owner-shaped legacy v1 tree, as files relative to the private HOME.
 * `variant: 'selected'` omits v1 plans, their nested folder and every .DS_Store
 * (the shape v2.0.0 could import). Credentials are obviously fake fixtures. */
export function buildLegacyOwnerTree({ variant = 'owner-shaped', projectPaths, themeId = INITIAL_THEME_ID } = {}) {
  if (!['owner-shaped', 'selected'].includes(variant)) throw new Error('Legacy tree variant must be owner-shaped or selected');
  if (!Array.isArray(projectPaths) || projectPaths.length !== PROJECT_RECORD_COUNT || projectPaths.some(value => !path.isAbsolute(value))) {
    throw new Error(`Legacy tree requires ${PROJECT_RECORD_COUNT} absolute project paths`);
  }
  const withPlans = variant === 'owner-shaped';
  const files = new Map();
  const add = (relative, bytes) => {
    if (files.has(relative)) throw new Error(`Duplicate legacy tree file: ${relative}`);
    files.set(relative, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  };
  const projects = projectPaths.map((projectPath, index) => ({ id: createProjectIdFromPath(projectPath), path: projectPath,
    label: `QA project ${index + 1}`, addedAt: 1759000000000 + index }));
  add('.config/openchamber/settings.json', json({ themeId, lightThemeId: 'aura-light', darkThemeId: themeId, useSystemTheme: false,
    fontSize: 14, messageStreamTransport: 'sse', projects, activeProjectId: projects[0].id, lastDirectory: projectPaths[0],
    desktopWindowState: { width: 1280, height: 800, maximized: false } }));
  const projectsRoot = '.config/openchamber/projects';
  for (const [index, project] of projects.entries()) {
    add(`${projectsRoot}/${project.id}.json`, json({ version: 2, label: project.label, scheduledTasks: [], lastOpenedAt: 1759100000000 + index }));
  }
  let planFiles = 0, nestedFiles = 0, dsStoreFiles = 0;
  if (withPlans) {
    add(`${projectsRoot}/.DS_Store`, DS_STORE); dsStoreFiles += 1;
    for (const [index, count] of PLAN_COUNTS.entries()) {
      const plans = `${projectsRoot}/${projects[index].id}/plans`;
      for (let plan = 1; plan <= count; plan += 1) {
        add(`${plans}/plan-${String(plan).padStart(4, '0')}.md`, `# QA plan ${index + 1}.${plan}\n\n- [ ] Synthetic v1 plan body ${plan} for project ${index + 1}.\n`);
        planFiles += 1;
      }
      if (index === 0) { add(`${plans}/.DS_Store`, DS_STORE); dsStoreFiles += 1; }
    }
    // One nested folder below plans/: never a top-level project record.
    const archive = `${projectsRoot}/${projects[2].id}/plans/archive`;
    for (const name of ['old-0001.md', 'old-0002.md']) { add(`${archive}/${name}`, `# Archived QA plan ${name}\n`); nestedFiles += 1; }
  }
  add('.config/opencode/opencode.json', json({ $schema: 'https://opencode.ai/config.json' }));
  for (const name of ['qa-reviewer', 'qa-planner']) {
    add(`.config/opencode/agents/${name}.md`, `---\ndescription: Synthetic ${name} agent for first-launch QA\nmode: subagent\n---\n\nReview synthetic fixtures only.\n`);
  }
  add('.config/opencode/skills/qa-fixture-skill/SKILL.md', '---\nname: qa-fixture-skill\ndescription: Synthetic first-launch QA skill\n---\n\nFixture body.\n');
  if (withPlans) {
    add('.config/opencode/agents/.DS_Store', DS_STORE);
    add('.config/opencode/skills/.DS_Store', DS_STORE);
    dsStoreFiles += 2;
  }
  add('.agents/skills/qa-shared-skill/SKILL.md', '---\nname: qa-shared-skill\ndescription: Synthetic shared QA skill\n---\n\nFixture body.\n');
  add('.agents/skills/qa-shared-skill/._SKILL.md', APPLE_DOUBLE);
  for (const project of projects.slice(0, 2)) add(`.config/openchamber/project-icons/${project.id}.png`, PNG);
  // Unknown fixture integrations: nothing is sent to a real provider.
  add('.local/share/opencode/auth.json', json({ 'qa-fixture-alpha': { type: 'api', key: FIXTURE_KEYS[0] },
    'qa-fixture-beta': { type: 'api', key: FIXTURE_KEYS[1] } }));
  return { variant, files, projectIDs: projects.map(project => project.id),
    expectedRecords: projects.map(project => `${project.id}.json`).sort(),
    facts: { variant, themeId, projectRecords: projects.length, planFiles, nestedFiles, dsStoreFiles, appleDoubleFiles: 1,
      projectIcons: 2, fileCount: files.size, fixtureCredentials: 'auth.json with two fake qa-fixture api keys (contents never recorded)' } };
}

export async function writeLegacyOwnerTree(home, tree) {
  for (const [relative, bytes] of [...tree.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.join(home, relative);
    if (!inside(home, file)) throw new Error('Legacy tree file escaped the private home');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  }
}

/** The desktop settings file is live app state: the smoke writes its port (and the
 * half-seed theme change) and the app persists window state there by design. */
export const LEGACY_TREE_APP_WRITTEN = Object.freeze(['.config/openchamber/settings.json']);

/** Every v1 file the smoke created below the private HOME (project records, plans,
 * opencode config, shared skills, icons, auth.json), hashed in place. A missing or
 * replaced file is recorded, never skipped. Contents never leave this process. */
export async function hashLegacySourceTree(home, relativeFiles) {
  const entries = [];
  for (const file of [...new Set(relativeFiles)].filter(name => !LEGACY_TREE_APP_WRITTEN.includes(name)).sort()) {
    const absolute = path.join(home, file);
    if (!inside(home, absolute)) throw new Error('Legacy tree file escaped the private home');
    let info = null;
    try { info = await lstat(absolute); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    entries.push(!info ? { file, type: 'missing' } : info.isFile() ? { file, sha256: digest(await readFile(absolute)) } : { file, type: 'non-file' });
  }
  return { count: entries.length, sha256: digest(JSON.stringify(entries)), entries };
}

/** Counts only: which created files are still byte-identical, changed or gone. */
export function compareLegacySourceTree(before, after) {
  const current = new Map(after.entries.map(entry => [entry.file, entry]));
  let unchanged = 0, changed = 0, missing = 0;
  for (const entry of before.entries) {
    const now = current.get(entry.file);
    if (!now || now.type === 'missing') missing += 1;
    else if (now.sha256 && now.sha256 === entry.sha256) unchanged += 1;
    else changed += 1;
  }
  return { files: before.entries.length, unchanged, changed, missing, unchangedTree: before.sha256 === after.sha256 && changed + missing === 0 };
}

/** Minimal child environment for the v2.0.0 importer: platform inputs plus the
 * private HOME/XDG roots. No inherited OPENCODE_*, DEVRYAN_*, OPENCHAMBER_*. */
export function createV200PrepareEnvironment({ home }, baseEnvironment = process.env) {
  const env = { ...qaPlatformEnvironment(baseEnvironment), HOME: home, LANG: baseEnvironment.LANG || 'en_US.UTF-8',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache') };
  for (const key of Object.keys(env)) if (/^(OPENCODE_|DEVRYAN_|OPENCHAMBER_|ELECTRON_)/.test(key)) delete env[key];
  return env;
}

/** electron-log records: one header line plus util.inspect continuation lines. */
const logRecords = text => {
  const records = [];
  for (const line of String(text).split('\n')) {
    if (/^\[\d{4}-\d{2}-\d{2}/.test(line) || !records.length) records.push(line);
    else records[records.length - 1] += `\n${line}`;
  }
  return records;
};
const field = (record, name) => record.match(new RegExp(`\\b${name}['"]?\\s*:\\s*['"]([^'"\\n]*)['"]`))?.[1] ?? null;

/** Pure: startup failures from main.log or captured stdout/stderr. */
export function parseStartupFailures(text) {
  return logRecords(text).flatMap(record => {
    const kind = /\[electron\] startup failed/.test(record) ? 'startup' : /\[electron\] deferred OpenCode startup failed/.test(record) ? 'deferred-runtime' : null;
    if (!kind) return [];
    const code = field(record, 'code');
    return [{ kind, code: code && /^[A-Za-z0-9_.-]{1,128}$/.test(code) ? code : null, relativePath: field(record, 'relativePath') }];
  });
}

/** Pure: the importer's skipped-entry warning (never source bytes). */
export function parseSeedSkipSummary(text) {
  const match = String(text).match(/\[native-setup\] seed skipped (\d+) setup entries \(([^)]*)\)(?::\s*([^\n]*))?/);
  if (!match) return null;
  const reasons = Object.fromEntries(match[2].split(',').map(part => part.trim().split('=')).filter(([key, value]) => key && /^\d+$/.test(value ?? ''))
    .map(([key, value]) => [key, Number(value)]));
  return { count: Number(match[1]), reasons, sample: (match[3] ?? '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 5) };
}

const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Pure: the Providers page offer (BundledRuntimeUpdate.tsx parseStatus) for a
 * GET /api/runtime/bundle response, with the reason it is or is not shown. */
export function classifyBundledRuntimeOffer(response) {
  const status = response?.status, body = response?.body;
  if (status !== 200) return { offered: false, restartRequired: false, reason: `http_${status ?? 'unavailable'}${typeof body?.code === 'string' ? `:${body.code}` : ''}` };
  if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.state !== 'string'
    || !sha(body.selectedManifestSha256) || body.availableManifestSha256 !== undefined && !sha(body.availableManifestSha256)) {
    return { offered: false, restartRequired: false, reason: 'status_invalid' };
  }
  const restartRequired = body.restartRequired === true;
  const offered = body.state === 'upgrade_available' && typeof body.availableManifestSha256 === 'string' && body.availableManifestSha256 !== body.selectedManifestSha256;
  const reason = offered ? 'candidate_manifest_differs_from_selected'
    : typeof body.updateReason === 'string' ? `candidate_unavailable:${body.updateReason}`
      : body.availableManifestSha256 === body.selectedManifestSha256 ? 'candidate_manifest_matches_selected' : `state_${body.state}`;
  return { offered, restartRequired, reason, state: body.state, revision: body.revision, bundleID: body.bundleID ?? null,
    selectedManifestSha256: body.selectedManifestSha256, availableManifestSha256: body.availableManifestSha256 ?? null };
}

/** Pure: PIDs whose command line contains a needle. Command lines are matched,
 * never retained (they may carry credentials). */
export function findProcessesMatching(psOutput, needles, excludedPids = []) {
  const excluded = new Set(excludedPids);
  return String(psOutput).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || excluded.has(Number(match[1]))) return [];
    const matched = needles.filter(({ value }) => value && match[2].includes(value)).map(({ label }) => label);
    return matched.length ? [{ pid: Number(match[1]), matched }] : [];
  });
}

/** Package evidence may live in this checkout or its main worktree. */
export function resolvePackageRepositoryRoot(evidencePath, candidates) {
  const root = candidates.find(candidate => candidate && inside(candidate, evidencePath));
  if (!root) throw Object.assign(new Error('Package evidence must be inside this DevRyan checkout or its main worktree'), { code: 'qa_first_launch_package_outside_repository' });
  return root;
}

const mainWorktreeRoot = () => {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repository, encoding: 'utf8' }).trim();
    return path.basename(common) === '.git' ? path.dirname(common) : null;
  } catch { return null; }
};

const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
async function readSelection(controlRoot) {
  const file = path.join(controlRoot, 'selection.json');
  if (!await exists(file)) return null;
  const bytes = await readFile(file), selection = JSON.parse(bytes.toString('utf8'));
  const bundleRoot = path.join(controlRoot, 'bundles', String(selection.selectedBundleID));
  let descriptor = null;
  try { descriptor = await readJSON(path.join(bundleRoot, 'descriptor.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { selectionSha256: digest(bytes), revision: selection.revision, bundleID: selection.selectedBundleID,
    previousBundleID: selection.previousBundleID ?? null, reconciliationRequired: selection.reconciliationRequired === true, bundleRoot,
    artifactManifestSha256: descriptor?.launch?.artifactManifestSha256 ?? null,
    webDataDirectory: descriptor?.launch?.webDataDirectory ?? null, webConfigDirectory: descriptor?.launch?.webConfigDirectory ?? null };
}

async function findLogs(directories, name) {
  const found = [];
  const visit = async (directory, depth) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) await visit(file, depth + 1);
      else if (entry.isFile() && entry.name === name) found.push(file);
    }
  };
  for (const directory of directories) await visit(directory, 0);
  return found.sort();
}

async function packageIdentity(root, evidencePath) {
  const packaged = await loadQaPackagedArtifact({ root, evidencePath });
  const manifest = path.join(packaged.evidence.appPath, 'Contents/Resources/revert-runtime/darwin-arm64/native-bundle.json');
  let nativeManifestSha256 = null;
  try { nativeManifestSha256 = digest(await readFile(manifest)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { packaged, identity: { evidencePath: packaged.evidencePath, archiveSha256: packaged.evidence.archiveSha256,
    sourceSha256: packaged.evidence.source?.sha256 ?? null, packagedWebArtifactSha256: packaged.evidence.packagedWebArtifact?.sha256 ?? null,
    electronVersion: packaged.evidence.electronVersion ?? null, nativeArtifactManifestSha256: nativeManifestSha256,
    nativeArtifacts: packaged.evidence.nativeArtifacts.length } };
}

const V200_CHILD = `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const [bundleModule, ownersModule, requestText] = process.argv.slice(1);
const request = JSON.parse(requestText);
let result;
try {
  const { provisionDefaultNativeBundle } = await import(bundleModule);
  const { captureNativeSetupOwners } = await import(ownersModule);
  const dataDirectory = path.join(request.home, '.config', 'openchamber');
  const controlRoot = await provisionDefaultNativeBundle({ env: process.env, home: request.home, cwd: request.workspace,
    artifactDirectory: request.artifactDirectory, captureLogicalSetup: () => captureNativeSetupOwners(dataDirectory) });
  result = { ok: true, controlRoot };
} catch (error) {
  result = { ok: false, code: typeof error?.code === 'string' ? error.code : null,
    relativePath: typeof error?.relativePath === 'string' ? error.relativePath : null, message: String(error?.message ?? error).slice(0, 400) };
}
writeFileSync(request.resultPath, JSON.stringify(result), { mode: 0o600 });
process.exit(0);
`;

async function runV200Preparation({ layout, v200Source, artifactDirectory, output, timeoutMs }) {
  const runtimeHost = path.join(v200Source, 'packages/web/server/lib/opencode/runtime-host');
  const modules = ['native-default-bundle.js', 'native-setup-local-owners.js'].map(name => path.join(runtimeHost, name));
  for (const file of [...modules, path.join(v200Source, 'packages/web/package.json')]) {
    if (!(await lstat(file)).isFile()) throw Object.assign(new Error(`v2.0.0 source is incomplete: ${file}`), { code: 'qa_first_launch_v200_source_invalid' });
  }
  const manifestSha256 = digest(await readFile(path.join(artifactDirectory, 'native-bundle.json')));
  const resultPath = path.join(output, 'v200-prepare-result.json');
  const started = performance.now();
  const child = startOwnedProcess(process.execPath, ['--input-type=module', '-e', V200_CHILD, ...modules.map(file => pathToFileURL(file).href),
    JSON.stringify({ home: layout.home, workspace: layout.workspace, artifactDirectory, resultPath })],
  { cwd: path.join(v200Source, 'packages/web'), env: createV200PrepareEnvironment({ home: layout.home }) });
  const exited = await new Promise(resolve => {
    if (child.child.exitCode !== null || child.child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  const cleanupErrors = [];
  try { await child.stop(); } catch (error) { cleanupErrors.push(error.message); }
  let result = null;
  try { result = await readJSON(resultPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { exited, exit: { code: child.child.exitCode, signal: child.child.signalCode }, elapsedMs: Math.round(performance.now() - started),
    result, artifactDirectory, artifactManifestSha256: manifestSha256, log: child.getLog(), cleanupErrors,
    ownedProcesses: child.getCleanupEvidence().observedProcesses.length };
}

const PAGE_STATE = `(() => ({ href: location.href, protocol: location.protocol, origin: location.origin, readyState: document.readyState,
  rootChildren: document.getElementById('root')?.childElementCount ?? 0, h1: document.querySelector('h1')?.textContent?.trim().slice(0, 200) ?? null,
  alert: document.querySelector('.error-content,[role="alert"]')?.textContent?.trim().slice(0, 600) ?? null, title: document.title }))()`;
const loopback = origin => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin ?? '');

export async function runFirstLaunchSmoke(options) {
  const startedAt = new Date(), started = performance.now();
  const outputRoot = path.join(repository, '.cache/qa');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(path.join(outputRoot, `first-launch-${options.scenario}-`));
  await chmod(output, 0o700);
  const runtimeRoot = path.join(output, 'runtime');
  const layout = firstLaunchLayout(runtimeRoot);
  const logsOut = path.join(output, 'logs');
  await mkdir(logsOut, { mode: 0o700 });
  // Credential patterns, fixture keys and private paths are redacted; codes and
  // hashes stay readable (no high-entropy pass), so failures remain diagnosable.
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME, knownSecrets: FIXTURE_KEYS,
    pathMappings: [{ path: runtimeRoot, placeholder: '<QA_RUNTIME>' }, { path: repository, placeholder: '<REPOSITORY>' }] });
  const sanitize = text => sanitizer.sanitizeText(String(text), { highEntropy: false });
  const evidence = { schemaVersion: 1, kind: 'packaged-first-launch-smoke', scenario: options.scenario, output, runtimeRoot,
    startedAt: startedAt.toISOString(), verdict: 'failed', checks: [], screenshots: [], logs: [], errors: [], timings: {} };
  const check = (name, passed, detail = {}) => { evidence.checks.push({ name, outcome: passed ? 'passed' : 'failed', ...detail }); return passed; };
  const mark = name => { evidence.timings[name] = Math.round(performance.now() - started); };
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
  let app, cdp, packaged, packageRoot, debugPort, port, legacyTreeBefore = null;
  const processLogs = [];
  try {
    // Identity first: a stale or changed package never launches.
    packageRoot = resolvePackageRepositoryRoot(await realpath(options.packageEvidence), [repository, mainWorktreeRoot()].filter(Boolean));
    const before = await packageIdentity(packageRoot, options.packageEvidence);
    packaged = before.packaged;
    evidence.package = { before: before.identity };
    const source = await captureQaSourceIdentity(repository);
    await writeFile(path.join(output, 'source-identity.json'), `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
    evidence.sourceIdentity = { sha256: source.sha256, files: source.entries.length, file: 'source-identity.json',
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim()) };

    // 1. Private runtime root exactly as packaged-host-policy.mjs requires.
    await mkdir(runtimeRoot, { mode: 0o700 });
    for (const directory of [layout.home, layout.profile, layout.workspace]) await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(layout.home, '.devryan-qa-home'), 'owned packaged first-launch smoke\n', { mode: 0o600 });
    await writeFile(layout.credentials, '{}\n', { mode: 0o600 });
    if (path.resolve(layout.home) === path.resolve(process.env.HOME ?? '/') || !inside(output, layout.home)) throw new Error('Private home is not isolated');

    // 2. Owner-shaped legacy tree.
    const projectPaths = Array.from({ length: PROJECT_RECORD_COUNT }, (_, index) => path.join(layout.workspace, `project-${index + 1}`));
    for (const directory of projectPaths) await mkdir(directory, { mode: 0o700 });
    const tree = buildLegacyOwnerTree({ variant: options.scenario === 'v200-selected' ? 'selected' : 'owner-shaped', projectPaths });
    await writeLegacyOwnerTree(layout.home, tree);
    legacyTreeBefore = await hashLegacySourceTree(layout.home, tree.files.keys());
    evidence.prepared = { tree: tree.facts, expectedRecords: tree.expectedRecords,
      legacyTreeBefore: { count: legacyTreeBefore.count, excluded: LEGACY_TREE_APP_WRITTEN.length } };
    mark('treeBuiltMs');

    // 3. Optional v2.0.0 pre-state from the actual v2.0.0 importer.
    if (options.scenario.startsWith('v200-')) {
      const v200Source = await realpath(options.v200Source), artifactDirectory = await realpath(options.v200Artifacts);
      const prepared = await runV200Preparation({ layout, v200Source, artifactDirectory, output, timeoutMs: options.timeoutMs });
      await writeFile(path.join(logsOut, 'v200-prepare.log'), sanitize(prepared.log), { mode: 0o600 });
      evidence.logs.push('logs/v200-prepare.log');
      let v200Revision = null;
      try { v200Revision = execFileSync('git', ['describe', '--tags', '--always'], { cwd: v200Source, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
      const facts = { v200Source, v200Revision, artifactDirectory, artifactManifestSha256: prepared.artifactManifestSha256,
        exited: prepared.exited, exit: prepared.exit, elapsedMs: prepared.elapsedMs, cleanupErrors: prepared.cleanupErrors.map(sanitize),
        result: prepared.result && { ...prepared.result, message: prepared.result.message ? sanitize(prepared.result.message) : undefined } };
      evidence.prepared.v200 = facts;
      mark('v200PreparedMs');
      if (!prepared.exited || prepared.cleanupErrors.length) throw Object.assign(new Error('v2.0.0 preparation did not finish cleanly'), { code: 'qa_first_launch_prerequisite_failed' });
      if (options.scenario === 'v200-half-seed') {
        const stamped = await exists(path.join(layout.freshSource, '.devryan-fresh-source.json'));
        const marker = await exists(path.join(layout.freshSource, 'web-data/native-setup-seed.json'));
        const selection = await exists(path.join(layout.controlRoot, 'selection.json'));
        Object.assign(facts, { freshSourceStamped: stamped, seedMarkerPresent: marker, selectionPresent: selection });
        const ok = check('v2.0.0 half seed fails with native_setup_json_invalid and leaves a stamped, unpinned fresh source',
          prepared.result?.ok === false && prepared.result.code === 'native_setup_json_invalid' && stamped && !marker && !selection,
          { code: prepared.result?.code ?? null, stamped, marker, selection });
        if (!ok) throw Object.assign(new Error('v2.0.0 half-seed prerequisite not reproduced'), { code: 'qa_first_launch_prerequisite_failed' });
        const settingsFile = path.join(layout.data, 'settings.json');
        const settings = await readJSON(settingsFile);
        await writeFile(settingsFile, `${JSON.stringify({ ...settings, themeId: CHANGED_THEME_ID, darkThemeId: CHANGED_THEME_ID }, null, 2)}\n`, { mode: 0o600 });
        facts.settingsChange = { field: 'themeId', from: settings.themeId, to: CHANGED_THEME_ID,
          reason: 'an identical retry of the half seed must now fail with native_setup_seed_changed' };
      } else {
        const selection = await readSelection(layout.controlRoot);
        const ok = check('v2.0.0 selects its default bundle from the plan-free tree', prepared.result?.ok === true && Boolean(selection?.bundleID),
          { code: prepared.result?.code ?? null });
        if (!ok) throw Object.assign(new Error('v2.0.0 selection prerequisite not reproduced'), { code: 'qa_first_launch_prerequisite_failed' });
        facts.selection = { revision: selection.revision, bundleID: selection.bundleID, selectionSha256: selection.selectionSha256,
          artifactManifestSha256: selection.artifactManifestSha256, freshSourceRemoved: !await exists(layout.freshSource) };
      }
    }

    // 4. Launch the packaged executable with run.mjs's isolated env, minus the fixture flags.
    debugPort = await reservePort(); port = await reservePort();
    const dataSettings = path.join(layout.data, 'settings.json');
    await writeFile(dataSettings, `${JSON.stringify({ ...await readJSON(dataSettings), desktopLocalPort: port })}\n`, { mode: 0o600 });
    if (options.scenario === 'v200-selected') {
      // A selected bundle relocates desktop settings into its web-data. Apply the
      // packaged QA policy there too, or main would auto-register the background
      // service (launchd) and start Bots against the user's Docker.
      const selection = await readSelection(layout.controlRoot);
      const bundleSettings = path.join(selection.webDataDirectory, 'settings.json');
      const current = await exists(bundleSettings) ? await readJSON(bundleSettings) : {};
      const overlay = { productionBotsRuntimeMode: 'disabled', desktopLanAccessEnabled: false, desktopLocalPort: port };
      await writeFile(bundleSettings, `${JSON.stringify({ ...current, ...overlay })}\n`, { mode: 0o600 });
      evidence.prepared.qaOverlay = { file: 'selected bundle web-data/settings.json', keys: Object.keys(overlay),
        note: 'web-data is not covered by bundle verification; overlay mirrors packaged-host-policy for the relocated settings' };
    }
    const env = createQaIsolatedRuntimeEnvironment({ runtime: 'electron', runtimeRoot, home: layout.home, data: layout.data,
      profile: layout.profile, distDirectory: packaged.artifactDirectory, port });
    if (options.shellExports) {
      // Only the packaged app's real login-shell probe may see these: never the launch environment.
      const inLaunch = Object.keys(SHELL_EXPORTS).filter(name => name in env);
      if (inLaunch.length) throw new Error(`Shell-export names are in the launch environment: ${inLaunch.join(', ')}`);
      evidence.prepared.shellExports = { names: Object.keys(SHELL_EXPORTS).sort(), files: await writeShellExportRcFiles(layout.shellConfig),
        directory: 'home/.config/qa-zsh (ZDOTDIR)' };
    }
    const flags = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${layout.profile}`];
    evidence.launch = { binary: packaged.binary, flags: flags.map(flag => flag.replace(runtimeRoot, '<QA_RUNTIME>')), debugPort, port,
      environmentKeys: Object.keys(env).sort(), legacyFixtureFlags: ['OPENCODE_HOST', 'OPENCODE_SKIP_START', 'OPENCHAMBER_SKIP_OPENCODE_START'].filter(key => key in env) };
    const launchedAt = performance.now();
    mark('launchMs');
    app = startOwnedProcess(packaged.binary, flags, { cwd: layout.workspace, env });
    processLogs.push(app);

    // 5. Poll for the first decisive outcome.
    const deadline = launchedAt + options.timeoutMs;
    let outcome = null, last = null;
    const mainLogs = async () => findLogs([path.join(runtimeRoot, 'logs'), path.join(layout.home, 'Library/Logs')], 'main.log');
    const readLogs = async () => (await Promise.all((await mainLogs()).map(file => readFile(file, 'utf8').catch(() => '')))).join('\n');
    while (!outcome) {
      if (interrupted) { outcome = { result: 'FAIL', reason: 'interrupted' }; break; }
      if (performance.now() > deadline) {
        outcome = { result: 'FAIL', reason: last?.health?.ok ? 'runtime_not_ready' : 'timeout', lastObserved: last }; break;
      }
      const failures = [...parseStartupFailures(await readLogs()), ...parseStartupFailures(app.getLog())];
      if (failures.length) { outcome = { result: 'FAIL', reason: 'startup_failure_logged', failure: failures[0], failures: failures.length }; break; }
      try { app.check(); } catch {
        outcome = { result: 'FAIL', reason: 'app_exited', exit: { code: app.child.exitCode, signal: app.child.signalCode } }; break;
      }
      if (!cdp) {
        try {
          const target = await discoverPageTarget(debugPort, 1000);
          cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
          await cdp.send('Page.enable');
          evidence.timings.cdpConnectedAfterLaunchMs = Math.round(performance.now() - launchedAt);
        } catch { cdp?.close(); cdp = null; }
      }
      if (cdp) {
        let page = null;
        try { page = await evaluate(cdp, PAGE_STATE); } catch (error) { if (/closed/.test(error.message)) { cdp.close(); cdp = null; } }
        if (page) {
          last = { protocol: page.protocol, origin: page.protocol === 'data:' ? 'data:' : page.origin, readyState: page.readyState,
            rootChildren: page.rootChildren, h1: page.h1 ? sanitize(page.h1) : null };
          if (page.protocol === 'data:' && (/startup needs attention/i.test(page.h1 ?? '') || page.alert)) {
            outcome = { result: 'FAIL', reason: 'startup_error_page', page: { h1: sanitize(page.h1 ?? ''), message: sanitize(page.alert ?? '') } };
            break;
          }
          if (loopback(page.origin) && /runtime recovery is required/i.test(page.h1 ?? '')) {
            outcome = { result: 'FAIL', reason: 'runtime_recovery_page', page: { h1: sanitize(page.h1) } }; break;
          }
          if (loopback(page.origin) && page.readyState === 'complete' && page.rootChildren > 0) {
            const health = await fetch(`${page.origin}/api/health`, { signal: AbortSignal.timeout(3000) })
              .then(async response => ({ status: response.status, body: await response.json().catch(() => null) })).catch(() => null);
            const selected = await exists(path.join(layout.controlRoot, 'selection.json'));
            last.health = health && { status: health.status, ok: health.body?.status === 'ok', isOpenCodeReady: health.body?.isOpenCodeReady ?? null,
              executionRuntime: health.body?.executionRuntime ?? null,
              lastOpenCodeError: health.body?.lastOpenCodeError ? sanitize(JSON.stringify(health.body.lastOpenCodeError)).slice(0, 400) : null };
            last.selectionPresent = selected;
            // A loaded shell is not a first launch: the bundled native runtime must be ready too.
            if (health?.status === 200 && health.body?.status === 'ok' && health.body.isOpenCodeReady === true && selected) {
              outcome = { result: 'PASS', reason: 'app_loaded_runtime_ready_selection_present', origin: page.origin, health: last.health };
              break;
            }
          }
        }
      }
      await delay(500);
    }
    evidence.outcome = outcome;
    evidence.timings.outcomeAfterLaunchMs = Math.round(performance.now() - launchedAt);
    const mainLogText = await readLogs();
    const logText = mainLogText + '\n' + app.getLog();
    if (options.shellExports) {
      const graded = gradeShellExportLog(mainLogText);
      evidence.shellExports = graded;
      check('main.log records every login-shell export as dropped, by name only', !graded.missing.length && !graded.valuesLogged,
        { missing: graded.missing, valuesLogged: graded.valuesLogged });
    }
    evidence.skippedEntries = parseSeedSkipSummary(logText);
    if (outcome.failure) outcome.failure.relativePath = outcome.failure.relativePath && sanitize(outcome.failure.relativePath);
    if (cdp) {
      const name = validateQaScreenshotFilename(outcome.result === 'PASS' ? 'first-launch-loaded.png' : 'first-launch-failure.png');
      try {
        await delay(outcome.result === 'PASS' ? 1500 : 250);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(output, name), Buffer.from(data, 'base64'), { mode: 0o600 });
        evidence.screenshots.push(name);
      } catch (error) { evidence.errors.push(`screenshot: ${sanitize(error.message)}`); }
    } else evidence.screenshots.push(null);
    if (cdp && (outcome.result === 'PASS' || loopback(last?.origin))) {
      // The Providers page offer reads GET /api/runtime/bundle from the renderer (same origin and principal).
      try {
        const bundle = await evaluate(cdp, `fetch('/api/runtime/bundle').then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
        evidence.updateOffer = { ...classifyBundledRuntimeOffer(bundle), packageNativeManifestSha256: evidence.package.before.nativeArtifactManifestSha256 };
      } catch (error) { evidence.updateOffer = { offered: false, reason: `request_failed:${sanitize(error.message)}` }; }
    }
    try { evidence.packagedHost = JSON.parse(await readFile(path.join(runtimeRoot, 'packaged-host.json'), 'utf8')); }
    catch (error) { evidence.packagedHost = { unavailable: error.code ?? 'unreadable' }; }
  } catch (error) {
    evidence.errors.push(sanitize(error.message));
    if (error.code === 'qa_first_launch_prerequisite_failed') evidence.verdict = 'prerequisite-failed';
  } finally {
    cdp?.close();
    // 6. Teardown: SIGTERM the app, SIGKILL after the grace period, then the
    // owned-tree cleanup (descendants) and a command-line sweep for the root.
    if (app) {
      const teardownStarted = performance.now();
      const teardown = evidence.teardown = { signals: [] };
      const exited = () => app.child.exitCode !== null || app.child.signalCode !== null;
      const waitExit = ms => new Promise(resolve => {
        if (exited()) { resolve(true); return; }
        const timer = setTimeout(() => resolve(exited()), ms);
        app.child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!exited()) { app.child.kill('SIGTERM'); teardown.signals.push('SIGTERM'); }
      if (!await waitExit(20000)) { app.child.kill('SIGKILL'); teardown.signals.push('SIGKILL'); await waitExit(5000); }
      teardown.exit = { code: app.child.exitCode, signal: app.child.signalCode };
      try { const cleanup = await app.stop(); teardown.ownedTree = { observed: cleanup.observedProcesses.length, signals: cleanup.signals.length, remaining: cleanup.remainingProcessIds }; }
      catch (error) { teardown.ownedTreeError = sanitize(error.message); }
      const sweep = async () => {
        const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,command='], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 });
        return findProcessesMatching(stdout, [{ label: 'private-root', value: runtimeRoot }, { label: 'packaged-app', value: packaged?.evidence.appPath }], [process.pid]);
      };
      try {
        let survivors = await sweep();
        teardown.survivors = survivors;
        if (survivors.length) {
          // Only the private root proves ownership; a packaged-app match is recorded, never signalled.
          for (const { pid, matched } of survivors) {
            if (!matched.includes('private-root')) continue;
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          }
          await delay(1000);
          teardown.survivorsAfterKill = await sweep();
        }
      } catch (error) { teardown.sweepError = sanitize(error.message); }
      teardown.clean = !teardown.ownedTreeError && !teardown.sweepError && teardown.survivors?.length === 0;
      check('no process with the private root (or the packaged app) survives teardown', teardown.clean,
        { survivors: teardown.survivors?.length ?? null });
      evidence.timings.teardownMs = Math.round(performance.now() - teardownStarted);
    }
    for (const owned of processLogs) {
      await writeFile(path.join(logsOut, 'app-stdout-stderr.log'), sanitize(owned.getLog()), { mode: 0o600 });
      evidence.logs.push('logs/app-stdout-stderr.log');
    }
    try {
      for (const [index, file] of (await findLogs([path.join(runtimeRoot, 'logs'), path.join(layout.home, 'Library/Logs')], 'main.log')).entries()) {
        const name = `main-${index + 1}.log`;
        await writeFile(path.join(logsOut, name), sanitize(await readFile(file, 'utf8')), { mode: 0o600 });
        evidence.logs.push(`logs/${name}`);
        (evidence.mainLogSources ??= []).push(path.relative(runtimeRoot, file));
      }
    } catch (error) { evidence.errors.push(`logs: ${sanitize(error.message)}`); }

    // Scenario checks against quiescent files (after the app has exited).
    try { await gradeScenario({ options, layout, evidence, check, legacyTreeBefore }); } catch (error) { evidence.errors.push(`grading: ${sanitize(error.message)}`); }
    if (packaged) {
      try {
        const after = await packageIdentity(packageRoot, options.packageEvidence);
        evidence.package.after = after.identity;
        check('package identity unchanged by the run', JSON.stringify(after.identity) === JSON.stringify(evidence.package.before));
      } catch (error) { check('package identity unchanged by the run', false, { error: sanitize(error.message) }); }
    }
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
    if (evidence.verdict !== 'prerequisite-failed') {
      evidence.verdict = evidence.outcome?.result === 'PASS' && !evidence.errors.length && evidence.checks.every(row => row.outcome === 'passed') ? 'passed' : 'failed';
    }
    // Remove the bulky private runtime only after a passing, fully cleaned run.
    evidence.runtimeRetained = options.keepRuntime || evidence.verdict !== 'passed' || evidence.teardown?.clean === false;
    if (!evidence.runtimeRetained) {
      try { await rm(runtimeRoot, { recursive: true, force: true }); } catch (error) { evidence.errors.push(`cleanup: ${sanitize(error.message)}`); evidence.runtimeRetained = true; }
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.timings.totalMs = Math.round(performance.now() - started);
    await writeFile(path.join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  return evidence;
}

async function gradeScenario({ options, layout, evidence, check, legacyTreeBefore }) {
  const { scenario } = options;
  const selection = await readSelection(layout.controlRoot);
  evidence.selection = selection && { revision: selection.revision, bundleID: selection.bundleID, selectionSha256: selection.selectionSha256,
    artifactManifestSha256: selection.artifactManifestSha256, reconciliationRequired: selection.reconciliationRequired };
  evidence.postState = { selectionPresent: Boolean(selection), freshSourcePresent: await exists(layout.freshSource),
    freshSourceStamped: await exists(path.join(layout.freshSource, '.devryan-fresh-source.json')),
    seedMarkerPresent: await exists(path.join(layout.freshSource, 'web-data/native-setup-seed.json')) };
  const legacyTree = legacyTreeBefore
    ? compareLegacySourceTree(legacyTreeBefore, await hashLegacySourceTree(layout.home, legacyTreeBefore.entries.map(entry => entry.file)))
    : null;
  check('v1 source tree unchanged (every created file, including project records, plans and auth.json)', legacyTree?.unchangedTree === true,
    { files: legacyTree?.files ?? null, unchanged: legacyTree?.unchanged ?? null, changed: legacyTree?.changed ?? null,
      missing: legacyTree?.missing ?? null, excluded: LEGACY_TREE_APP_WRITTEN.length });
  if (evidence.outcome?.result !== 'PASS') return;
  const records = selection?.webConfigDirectory
    ? (await readdir(path.join(selection.webConfigDirectory, 'projects'), { withFileTypes: true }).catch(() => []))
      .map(entry => (entry.isFile() ? entry.name : `${entry.name}/`)).sort()
    : [];
  evidence.bundleProjects = records;
  if (scenario === 'v200-selected') {
    const prepared = evidence.prepared?.v200?.selection;
    check('v2.0.0 selection kept (same bundleID and revision; no re-provision)',
      Boolean(prepared) && selection?.bundleID === prepared.bundleID && selection?.revision === prepared.revision,
      { prepared: prepared && { bundleID: prepared.bundleID, revision: prepared.revision }, current: selection && { bundleID: selection.bundleID, revision: selection.revision } });
    check('bundled-runtime update offer recorded through GET /api/runtime/bundle', typeof evidence.updateOffer?.offered === 'boolean',
      { offered: evidence.updateOffer?.offered ?? null, reason: evidence.updateOffer?.reason ?? null });
    return;
  }
  const expected = evidence.prepared?.expectedRecords ?? [];
  check(`bundle web-config/projects holds exactly the ${PROJECT_RECORD_COUNT} project records`, JSON.stringify(records) === JSON.stringify(expected),
    { count: records.length, unexpected: records.filter(name => !expected.includes(name)) });
  check('fresh-native-source removed after selection', !await exists(layout.freshSource));
  if (scenario === 'v200-half-seed') {
    const settings = selection?.webDataDirectory ? await readJSON(path.join(selection.webDataDirectory, 'settings.json')).catch(() => null) : null;
    check('post-failure settings change reached the bundle (reseeded, not an identical retry)', settings?.themeId === CHANGED_THEME_ID,
      { bundleThemeId: settings?.themeId ?? null });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseFirstLaunchArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exit(2); }
  runFirstLaunchSmoke(options).then(evidence => {
    console.log(JSON.stringify({ output: evidence.output, verdict: evidence.verdict, outcome: evidence.outcome?.result ?? null,
      reason: evidence.outcome?.reason ?? null, failure: evidence.outcome?.failure ?? null, errors: evidence.errors }, null, 2));
    process.exitCode = evidence.verdict === 'passed' ? 0 : 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
