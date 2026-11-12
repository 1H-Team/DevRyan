// The cheap half of the test isolation guard (scripts/test-isolation-guard.mjs):
// what a test process loads before any test to check that it runs in a private
// environment. It imports only node:fs, node:os and node:path, so the common
// case (marker present, paths inside the private root) costs a file read and a
// few path checks. Building an environment lives in the guard.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ISOLATION_ROOT_VARIABLE = 'DEVRYAN_TEST_ISOLATION_ROOT';
export const ISOLATION_MARKER = 'isolation.json';
export const REFUSAL_HEADLINE = 'DevRyan test isolation: refusing to run tests against the real home folder.';
export const XDG = Object.freeze({ XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: '.local/share', XDG_STATE_HOME: '.local/state', XDG_CACHE_HOME: '.cache' });

// Variables that select a location (a path, a database, a binary, a URL, a
// host or port) or carry a credential or a live identity. They are removed from
// a test environment, never re-pointed, so each root resolves to its default
// under the private HOME exactly as in CI, which sets none of them; and a test
// process that still has one outside the private root is refused.
// OPENCHAMBER_* names are the accepted aliases of DEVRYAN_* names.
const SELECTOR_SUFFIX = /^(?:DEVRYAN|OPENCHAMBER|OPENCODE)(?:_\w+)?_(?:DIR|DIRS|ROOT|HOME|PATH|PATHS|CONFIG|CONFIG_CONTENT|FILE|CACHE|OVERLAY|DATA|STATE|LOGS?|PROFILE|BUNDLE|DB|URL|URLS|ORIGIN|PORT|HOST|HOSTNAME|TOKEN|SECRET|PASSWORD|USERNAME|KEY|BINARY|BIN|EXECUTABLE|ARTIFACTS?|TMP|USER_DATA|RESULT|RECEIPT|BASELINE|INSTALL|NODE|DISTRO|ARCHIVE|EXCLUSIONS|SHELL|CWD|VIEW|TICKET|ID|PID|PREFIX|SUBJECT|SOURCES)$/;
export const NAMED_SELECTORS = Object.freeze(new Set([
  // Starts a real Cloudflare tunnel.
  'DEVRYAN_TRY_CF_TUNNEL', 'OPENCHAMBER_TRY_CF_TUNNEL',
  'CLAUDE_CONFIG_DIR', 'MERIDIAN_CONFIG_DIR', 'MERIDIAN_SESSION_DIR', 'CURSOR_TOKEN_FILE', 'CURSOR_REFRESH_TOKEN_FILE',
  'GH_CONFIG_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'USERPROFILE',
  // The developer's SSH agent: a live credential.
  'SSH_AUTH_SOCK',
]));
// Test controls that match the pattern but select nothing of the user's.
const KEPT = new Set([ISOLATION_ROOT_VARIABLE, 'DEVRYAN_KEEP_ARTIFACTS']);
/** True for a variable the guard removes from a test environment. */
export const isStrippedVariable = (key) => !KEPT.has(key)
  && (SELECTOR_SUFFIX.test(key) || NAMED_SELECTORS.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key));

export const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

/** Real DevRyan, OpenCode and Electron folders of a real home (the web write guard protects them). */
export function realDataRoots(home) {
  return [
    ...['devryan', 'openchamber', 'opencode'].map((name) => path.join(home, '.config', name)),
    path.join(home, '.local', 'share', 'opencode'), path.join(home, '.local', 'state', 'opencode'), path.join(home, '.local', 'state', 'devryan'),
    path.join(home, 'Library', 'Logs', 'DevRyan'), path.join(home, 'Library', 'Application Support', 'DevRyan'),
  ];
}

/** The isolation root `environment` names, if it carries a readable marker; else null. */
export function readIsolationMarker(environment = process.env) {
  const root = environment[ISOLATION_ROOT_VARIABLE];
  if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
  try {
    const marker = JSON.parse(readFileSync(path.join(root, ISOLATION_MARKER), 'utf8'));
    if (marker?.schemaVersion !== 1 || !Array.isArray(marker.realHomes) || marker.root !== root) return null;
    return { root, realHomes: marker.realHomes.filter((home) => typeof home === 'string' && path.isAbsolute(home)) };
  } catch {
    return null;
  }
}

/**
 * Why `env` (with home directory `home`) is not an isolated test environment;
 * empty when it is. `selectors: false` checks only the root, the home and the
 * XDG folders (for shared fixtures, whose process may already run tests that
 * point a selector at their own folder).
 */
export function isolationProblems({ env = process.env, home = os.homedir(), selectors = true } = {}) {
  const marker = readIsolationMarker(env);
  if (!marker) {
    return [env[ISOLATION_ROOT_VARIABLE]
      ? `${ISOLATION_ROOT_VARIABLE} does not name a private root created by the guard`
      : `${ISOLATION_ROOT_VARIABLE} is not set`];
  }
  const { root, realHomes } = marker;
  const problems = [];
  const contained = (label, value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) problems.push(`${label} is not set to an absolute path`);
    else if (!inside(path.resolve(value), root)) problems.push(`${label} (${value}) is outside the private root ${root}`);
  };
  contained('the home directory', home);
  if (env.HOME !== home) problems.push(`HOME (${env.HOME}) is not the process home directory (${home}); it changed after the process started`);
  for (const real of realHomes) {
    if (typeof home === 'string' && inside(real, path.resolve(home))) problems.push(`the home directory contains the real home ${real}`);
    if (realDataRoots(real).some((data) => inside(root, data))) problems.push(`the private root lies inside a real DevRyan or OpenCode folder of ${real}`);
  }
  for (const key of Object.keys(XDG)) contained(key, env[key]);
  if (!selectors) return problems;
  contained('GIT_CONFIG_GLOBAL', env.GIT_CONFIG_GLOBAL);
  for (const [key, value] of Object.entries(env)) {
    if (!isStrippedVariable(key) || key === 'USERPROFILE' || typeof value !== 'string' || value === '') continue;
    // A location inside the private root is a test's own fixture; anything else (a
    // real path, a URL, a port, a secret, the SSH agent) is the developer's.
    if (!(path.isAbsolute(value) && inside(path.resolve(value), root))) problems.push(`${key} is set (${path.isAbsolute(value) ? value : 'a value'}) and selects a location, endpoint or credential outside the private root`);
  }
  return problems;
}

// The command that runs one test file isolated, per directory a test run starts in.
const SINGLE_FILE = Object.freeze({
  '.': ['node scripts/test-isolation-guard.mjs bun test ./scripts/<path>.test.ts',
    'node --import=./scripts/test-isolation-preload.mjs --test scripts/<path>.test.mjs   (isolates itself)'],
  'packages/web': ['bunx vitest run <path>.test.js   (isolates itself)', 'node ../../scripts/test-isolation-guard.mjs bun test ./<path>.test.ts   (test:native files)'],
  'packages/ui': ['bun run test src/<path>.test.ts'],
  'packages/electron': ['node ../../scripts/test-isolation-guard.mjs bun test ./<path>.test.mjs   (bun:test files)',
    'node --import=../../scripts/test-isolation-preload.mjs --test <path>.test.mjs   (node:test files, isolates itself)'],
  'packages/desktop': ['node ../../scripts/test-isolation-guard.mjs bun test scripts/devryan-managed-orchestration.test.mjs'],
  ...Object.fromEntries(['shared-runtime', 'harness-runtime', 'orchestration-runtime', 'cursor-sdk-runtime', 'agents-core']
    .map((name) => [`packages/${name}`, ['bun run test ./<path>.test.js']])),
});

/** How to run one file isolated from `cwd` (in the repository root or a package folder). */
export function singleFileCommands(cwd = process.cwd()) {
  // Computed only for a refusal, so the common path loads no URL helpers.
  const repositoryRoot = path.resolve(decodeURIComponent(new URL('..', import.meta.url).pathname));
  const relative = path.relative(repositoryRoot, path.resolve(cwd)).split(path.sep).join('/');
  if (relative.startsWith('..')) return { directory: null, commands: SINGLE_FILE['.'].map((line) => `(from ${repositoryRoot}) ${line}`) };
  const directory = /^packages\/[^/]+/.exec(relative)?.[0] ?? '.';
  const commands = SINGLE_FILE[directory] ?? SINGLE_FILE['.'];
  return { directory, commands: directory === relative || (directory === '.' && relative === '') ? commands : commands.map((line) => `(from ${directory}) ${line}`) };
}

export function refusalMessage(problems, { cwd = process.cwd() } = {}) {
  const { commands } = singleFileCommands(cwd);
  return [
    REFUSAL_HEADLINE,
    ...problems.map((problem) => `  - ${problem}`),
    'Tests must start with the private HOME, XDG folders and Git configuration that scripts/test-isolation-guard.mjs builds.',
    'Bun fixes its home folder when it starts, so a bare `bun test` cannot isolate itself. Run one file with:',
    ...commands.map((line) => `  ${line}`),
    'A package suite: bun run --cwd packages/<name> test; everything: bun run test:full.',
    'A `bun test` started inside a source subfolder reads no bunfig.toml and is not guarded: start it from the package folder.',
    'See docs/TESTING.md, "Test isolation".',
  ].join('\n');
}

/** Throw the refusal when this process is not isolated. */
export function assertTestIsolation({ env = process.env, home = os.homedir(), selectors = true } = {}) {
  const problems = isolationProblems({ env, home, selectors });
  if (problems.length) throw Object.assign(new Error(refusalMessage(problems)), { code: 'EDEVRYANTESTISOLATION' });
  return readIsolationMarker(env);
}
