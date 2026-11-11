#!/usr/bin/env node
// Test isolation guard: no test process may read or write the developer's real
// home, DevRyan, OpenCode or Git configuration.
//
// Two jobs:
// 1. Build the environment of a test process (`createTestIsolation`): one
//    private root per run under the OS temp dir holds HOME, the XDG folders and
//    a private Git configuration; every inherited variable that selects a
//    location, endpoint or credential is removed, so each root resolves to its
//    default inside the private HOME. Runners pass this environment to every
//    process they spawn; the root is removed when the run ends.
// 2. Inside a test process (`scripts/test-isolation-preload.mjs` as a Bun
//    preload or Node `--import`, and the web Vitest setup), check isolation
//    before any test (the cheap check lives in scripts/test-isolation-check.mjs).
//    A Node process started without the environment builds it in-process
//    (`isolateCurrentProcess`) before any product module loads: Node's
//    os.homedir() reads HOME on every call. Bun reads HOME once at startup
//    (changing process.env.HOME later changes nothing, for os.homedir() and
//    os.userInfo().homedir alike) and its preload cannot see the original
//    command line to run it again, so a bare `bun test` is refused instead.
//
// As a command, `node scripts/test-isolation-guard.mjs <command> [args...]`
// runs the command in a fresh private environment (or the current one when it
// is already isolated) and removes the root afterwards. Package `test` scripts
// use it, so `bun run --cwd packages/<name> test` is isolated on its own.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cloneFile, createRunRoot, scratchParent } from './qa/run-root.mjs';
import {
  ISOLATION_MARKER, ISOLATION_ROOT_VARIABLE, XDG, assertTestIsolation, inside, isStrippedVariable, isolationProblems, readIsolationMarker,
} from './test-isolation-check.mjs';

export {
  ISOLATION_MARKER, ISOLATION_ROOT_VARIABLE, NAMED_SELECTORS, REFUSAL_HEADLINE, XDG, assertTestIsolation, isStrippedVariable,
  isolationProblems, readIsolationMarker, realDataRoots, refusalMessage, singleFileCommands,
} from './test-isolation-check.mjs';

export const ISOLATION_PRELOAD = fileURLToPath(new URL('./test-isolation-preload.mjs', import.meta.url));
/**
 * `node` arguments that load the in-process check, before `--test`. One
 * argument (`--import=<url>`), so runners that split flags from files keep it.
 * node:test hands it on to every test file's process.
 */
export const NODE_ISOLATION_ARGS = Object.freeze([`--import=${pathToFileURL(ISOLATION_PRELOAD).href}`]);
/** A package `test` script that runs `bun test` inside a private environment. */
export const GUARDED_BUN_TEST = 'node ../../scripts/test-isolation-guard.mjs bun test';

const GIT_IDENTITY = '[user]\n\tname = DevRyan Tests\n\temail = tests@devryan.invalid\n[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n';

/**
 * DEVRYAN_*, OPENCHAMBER_* and OPENCODE_* names product code reads that the
 * guard deliberately passes through: behaviour switches, limits and timeouts,
 * not locations, endpoints or credentials. CI sets none of them, so a
 * developer can still set one on purpose for a run. Every other such name in
 * product code must be stripped (`isStrippedVariable`);
 * scripts/test-suite-contract.test.mjs fails on a name in neither list.
 */
export const PASSED_THROUGH = Object.freeze(Object.fromEntries([
  ...`ADAPTIVE_DELEGATION ALLOW_DEV_SHUTDOWN ALLOW_UNAUTHENTICATED_LAN ANTHROPIC_RECOVERY_MODE BACKGROUND_COMPACTION CANCELLED_RECEIPTS
  CAPABILITY_TOOL_SCHEMA CHILD_VIEW_PREWARM CODEX_CONTEXT_PIN COMPACTION_ANCHOR COMPRESS_API CONFINED_RECEIPT_AUTHORITY CONTROL_LEDGER_ONLY
  DAEMON_READY_TIMEOUT_MS DEFERRED_LEASE_CLEANUP DESKTOP_NOTIFY DEV_FORCE_NPX_ELECTRON DEV_MODE DEV_RESTART_DELAY_MS DEV_SHUTDOWN
  DIRECT_CONTROL_RECEIPTS DIRECT_LEDGER_ONLY DISABLE_PWA_DEV DUPLICATE_IDENTITY DUPLICATE_OUTPUTS ELECTRON_DEV EVENT_DRIVEN_CHILD_WAIT
  EXECUTION_BOUNDARY EXECUTION_BROWSER_SCOPE EXECUTION_CANCEL_EVENT EXECUTION_IDLE_MS EXECUTION_IDLE_WATCHDOG EXECUTION_IO_CAP
  EXECUTION_SUMMARY_MIN_MS EXECUTION_WORKER FS_EXEC_TIMEOUT_MS FS_WATCH GITHUB_SCOPES GIT_READ_CACHE_TTL_MS HEALTH_RESTART_FAILURES
  IGNORED_WRITE_THROUGH LAZY_BASE_RUNS LEDGER_ANCESTOR_MEMO LEDGER_ANCESTRY_COMPACTION LEDGER_BASELINE_REFS LEDGER_COMPLEXITY_GUARD
  LEDGER_DIRECT_TREES LEDGER_FAST_INGEST LEDGER_INCREMENTAL_FILE_INDEX LEDGER_PACK LEDGER_PATH_WINNERS LEDGER_PERSISTENT_INDEX
  LEDGER_PERSISTENT_READER LEDGER_PREWARM LEDGER_RESTAMP_BATCH LEDGER_RUST LEDGER_SNAPSHOT_REUSE LEDGER_SYNC_WALKS LEDGER_WORKER
  MANAGED_RESULT_CONTRACT_VERSION MANAGED_RESULT_MODE MANAGED_STOPPED_HANDOFF MANAGED_WAIT_ANY MCP_ELICITATION
  MESSAGE_STREAM_REPLAY_BYTE_BUDGET NATIVE_IMPORT_MUTATING NATIVE_IMPORT_OPERATION OPENCODE_GENERATION OPEN_CURSOR_LOCAL_TOOLS
  OPEN_CURSOR_MCP_BRIDGE ORCHESTRATION_ACCOUNT_DEFAULTS ORCHESTRATION_UNACKNOWLEDGED_EXPIRY PERSISTENT_OBJECT_VERIFY PLAN_READ_ADVISORY
  PREPARED_BASELINE_REUSE PREVIEW_SMOKE_PHASE PRIMARY_RECOVERY_MODE PROVIDER_PROGRESS_TIMEOUT_MS QA_OPENCODE_VERSION
  RATE_LIMIT_MAX_ATTEMPTS RATE_LIMIT_NO_IP_MAX_ATTEMPTS READ_ONLY_SHELL_LIVE RECOVERY_ADVISORY_PLUGIN REFUSE_DELEGATED_BACKGROUND
  REQUIRED_CHECK_RUNNER_POLICIES RUNTIME RUNTIME_MODE SAVED_APPROVALS SERVED_FRESHNESS SKIP_API_COMPRESSION SKIP_INSTALL_PREPARE
  SKIP_OPENCODE_START STALL_AWARE_DEADLINES STOP_ENDS_BACKGROUND_RUNS SUPERVISED_RESTART SYSTEM_CACHE_PRESERVE TASK_AGENT_VALIDATION
  TASK_AUTO_CONTINUE TASK_CONTEXT_PROJECTION TUNNEL_MODE TUNNEL_PROVIDER VIEW_CLONE VIEW_FAST_MATERIALIZE VIEW_REUSE
  VIEW_SHARED_STANDBY VIEW_STAT_REUSE WORKER_BROWSERS WORKER_GROUP_SIGNALS WORKER_LSP_DOWNLOAD XAI_TOOLS_SESSION_FREEZE`
    .split(/\s+/).filter(Boolean).map((name) => [`DEVRYAN_${name}`, 'behaviour switch, limit or timeout']),
  ...['OPENCODE_EXPERIMENTAL', 'OPENCODE_EXPERIMENTAL_NATIVE_LLM', 'OPENCODE_EXPERIMENTAL_PLAN_MODE', 'OPENCODE_EXPERIMENTAL_WEBSOCKETS', 'OPENCODE_SKIP_START']
    .map((name) => [name, 'behaviour switch']),
  ['DEVRYAN_TEST_UPDATE_BRIDGE', 'fixture hook the Electron update tests set for their own children'],
  ['DEVRYAN_TEST_UPDATE_INSTALLER', 'fixture hook the Electron update tests set for their own children'],
  ['DEVRYAN_VITEST_EXCLUDE', 'CI lane test control'],
  ['DEVRYAN_TEST_ISOLATION_ROOT', 'the guard itself'],
]));

/**
 * Bun's runtime transpiler cache is a pure cache (transpiled sources keyed by
 * content hash, no user data). Under a fresh HOME every run would rebuild it,
 * so it stays where it already is; nothing else under the real home is used.
 */
function transpilerCache(environment, realHome) {
  if (environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== undefined) return environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  const candidates = [
    process.platform === 'darwin' ? path.join(realHome, 'Library', 'Caches', 'bun', '@t@') : null,
    environment.XDG_CACHE_HOME ? path.join(environment.XDG_CACHE_HOME, 'bun', '@t@') : null,
    path.join(realHome, '.cache', 'bun', '@t@'),
    environment.BUN_INSTALL ? path.join(environment.BUN_INSTALL, 'install', 'cache', '@t@') : null,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * OpenCode's ripgrep resolution (`@opencode/core/ripgrep`) takes `rg` from PATH,
 * else `<XDG cache>/opencode/bin/rg`, else downloads it from GitHub. Tests that
 * build its layer used to find the copy cached in the real home; a private home
 * instead gets a copy (a clone where the file system can; OpenCode does not
 * accept a link there) of the ripgrep the installed Cursor SDK ships, found the
 * way packages/cursor-sdk-runtime/ripgrep-path.js finds it, so no test
 * downloads it. Nothing is copied when that package is not installed.
 */
function installedRipgrep() {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const packageName = `sdk-${process.platform}-${process.arch}`;
  // Bun keeps optional platform packages in its central store.
  const candidates = [fileURLToPath(new URL(`../node_modules/.bun/node_modules/@cursor/${packageName}/bin/${binary}`, import.meta.url))];
  try {
    candidates.push(path.join(path.dirname(createRequire(new URL('../packages/cursor-sdk-runtime/package.json', import.meta.url))
      .resolve(`@cursor/${packageName}/package.json`)), 'bin', binary));
  } catch { /* not resolvable from the package: the store path above is the usual one */ }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** The private environment for a test process whose HOME is `home` inside `root`. */
export function isolatedEnvironment({ root, home, realHome }, environment = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(environment)) if (!isStrippedVariable(key)) env[key] = value;
  const cache = transpilerCache(environment, realHome);
  Object.assign(env, {
    [ISOLATION_ROOT_VARIABLE]: root, HOME: home,
    ...Object.fromEntries(Object.entries(XDG).map(([key, relative]) => [key, path.join(home, relative)])),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    ...(cache ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache } : {}),
  });
  if (process.platform === 'win32') env.USERPROFILE = home;
  return env;
}

/**
 * One private root per run: `<os tmp>/devryan-test/run-*` with `home/` (HOME,
 * XDG folders, `.gitconfig`, OpenCode's ripgrep) and the marker the in-process
 * check reads. An already isolated `environment` is reused as is (`owned:
 * false`), so a runner started by another runner shares its root.
 * `cleanup(status)` removes an owned root (kept with --keep-artifacts or
 * DEVRYAN_KEEP_ARTIFACTS=1); an exit hook removes it if nothing else did.
 */
export function createTestIsolation({ environment = process.env, parent = scratchParent('test') } = {}) {
  const existing = readIsolationMarker(environment);
  if (existing && isolationProblems({ env: environment, home: environment.HOME }).length === 0) {
    return { root: existing.root, env: { ...environment }, owned: false, cleanup: () => {} };
  }
  const realHomes = [...new Set([environment.HOME, os.homedir(), os.userInfo().homedir].filter((home) => typeof home === 'string' && path.isAbsolute(home)))];
  const run = createRunRoot({ parent, owner: 'test-isolation', signals: 'exit', env: environment });
  const root = run.dir;
  const home = path.join(root, 'home');
  for (const relative of Object.values(XDG)) mkdirSync(path.join(home, relative), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, '.gitconfig'), GIT_IDENTITY, { mode: 0o600 });
  const ripgrep = installedRipgrep();
  if (ripgrep) {
    mkdirSync(path.join(home, XDG.XDG_CACHE_HOME, 'opencode', 'bin'), { recursive: true, mode: 0o700 });
    const target = path.join(home, XDG.XDG_CACHE_HOME, 'opencode', 'bin', path.basename(ripgrep));
    cloneFile(ripgrep, target);
    chmodSync(target, 0o755);
  }
  writeFileSync(path.join(root, ISOLATION_MARKER), `${JSON.stringify({ schemaVersion: 1, root, realHomes }, null, 2)}\n`, { mode: 0o600 });
  const env = isolatedEnvironment({ root, home, realHome: realHomes[0] ?? home }, environment);
  let finished = false;
  return {
    root, env, owned: true,
    cleanup: (status = 'passed') => {
      if (finished) return;
      finished = true;
      run.finish(status);
    },
  };
}

/**
 * Isolate this Node process in place: build the private environment and make
 * it this process's `process.env`, before any product module is loaded (the
 * Node `--import` preload and the web Vitest global setup call it first).
 * Node's os.homedir() reads HOME on every call, so every later lookup and every
 * child process sees the private home. Never call it under Bun. The root is
 * removed on exit, or on SIGINT/SIGTERM before the signal takes its course.
 */
export function isolateCurrentProcess() {
  if (process.versions.bun) throw new Error('isolateCurrentProcess cannot move a Bun process: Bun reads HOME only at startup');
  const isolation = createTestIsolation({ environment: { ...process.env } });
  for (const key of Object.keys(process.env)) if (!(key in isolation.env)) delete process.env[key];
  Object.assign(process.env, isolation.env);
  const handlers = {};
  for (const signal of ['SIGINT', 'SIGTERM']) {
    handlers[signal] = () => {
      isolation.cleanup('interrupted');
      // Alone, take the default action again; another handler (a runner's) decides itself.
      if (process.listenerCount(signal) === 1) { process.off(signal, handlers[signal]); process.kill(process.pid, signal); }
    };
    process.on(signal, handlers[signal]);
  }
  process.once('exit', (code) => isolation.cleanup(code === 0 ? 'passed' : 'failed'));
  return isolation;
}

/**
 * What the canary tests check: the home directory and every DevRyan and
 * OpenCode root, each from the product resolver that owns it.
 */
export async function isolationCanary({ env = process.env } = {}) {
  const marker = assertTestIsolation({ env });
  const home = os.homedir();
  const [{ resolveDevRyanDataRoot }, { resolveRuntimeBundleRoot }, { OPENCODE_CONFIG_DIR }, { getOpenCodeDataPath }] = await Promise.all([
    import('../packages/shared-runtime/lib/data-root.js'),
    import('../packages/web/server/lib/opencode/runtime-host/runtime-bundle-root.js'),
    import('../packages/web/server/lib/opencode/shared.js'),
    import('../packages/web/server/lib/git/service.js'),
  ]);
  const xdg = (key, fallback) => env[key] || path.join(home, fallback);
  // Git as a test that commits sees it: the identity comes from the private global config.
  const git = spawnSync('git', ['config', '--get', 'user.email'], { cwd: marker.root, env, encoding: 'utf8' });
  return {
    root: marker.root,
    gitIdentity: git.status === 0 ? git.stdout.trim() : null,
    realHomes: marker.realHomes,
    roots: {
      home,
      devryanData: resolveDevRyanDataRoot({ env, home }),
      runtimeBundles: resolveRuntimeBundleRoot(env, home),
      // Captured when packages/web/server/lib/opencode/shared.js loads.
      opencodeConfig: OPENCODE_CONFIG_DIR,
      opencodeData: getOpenCodeDataPath(),
      // OpenCode's state and cache folders and electron-log's folder have no
      // importable resolver (they are computed inside the bundled OpenCode host
      // and by Electron's app.getPath): derived as those do, from XDG and HOME.
      opencodeState: path.join(xdg('XDG_STATE_HOME', '.local/state'), 'opencode'),
      opencodeCache: path.join(xdg('XDG_CACHE_HOME', '.cache'), 'opencode'),
      devryanLogs: path.join(home, 'Library', 'Logs', 'DevRyan'),
      gitGlobalConfig: env.GIT_CONFIG_GLOBAL,
    },
  };
}

/** Problems with a canary report: roots outside the private root or under a real home. */
export function canaryProblems(report) {
  const problems = [];
  for (const [name, value] of Object.entries(report.roots)) {
    if (typeof value !== 'string') { problems.push(`${name} did not resolve`); continue; }
    if (!inside(value, report.root)) problems.push(`${name} ${value} is outside ${report.root}`);
    for (const real of report.realHomes) if (inside(value, real) && !inside(report.root, real)) problems.push(`${name} ${value} is under the real home`);
  }
  return problems;
}

/**
 * Run `callback(env)`, which spawns test processes synchronously, inside an
 * isolated environment (scripts/test-ui.mjs, scripts/test-electron.mjs) and
 * returns its status (130/143 for a child stopped by SIGINT/SIGTERM). An
 * interrupt reaches the children through the process group while this process
 * is blocked in the synchronous spawn, and Node runs a signal listener only
 * after the spawn returns. So the interrupt is read from the children's status,
 * the root is removed at once, and the listeners stay until the queued signal
 * has been delivered (they keep it from killing this process before it reports).
 */
export function withTestIsolationSync(callback, { environment = process.env } = {}) {
  const isolation = createTestIsolation({ environment });
  let interrupted = null;
  const onSignal = (signal) => { interrupted ??= signal; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let status = 1;
  try {
    status = callback(isolation.env);
  } finally {
    if (status === 130) interrupted ??= 'SIGINT';
    if (status === 143) interrupted ??= 'SIGTERM';
    isolation.cleanup(interrupted ? 'interrupted' : status === 0 ? 'passed' : 'failed');
    setTimeout(() => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }, 50).unref();
  }
  return interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : status;
}

/** A synchronous spawn's status as a shell reports it: 128 + signal for a signalled child. */
export function spawnStatus(result) {
  if (result.status !== null) return result.status;
  return result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1;
}

/** Run `command` in an isolated environment; resolves to its exit code. */
export async function runIsolated(command, args, { environment = process.env, cwd = process.cwd() } = {}) {
  const isolation = createTestIsolation({ environment });
  const child = spawn(command, args, { cwd, env: isolation.env, stdio: 'inherit' });
  const forward = (signal) => { try { child.kill(signal); } catch { /* gone */ } };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  const code = await new Promise((resolve) => {
    child.once('error', (error) => { process.stderr.write(`${command} could not start: ${error.message}\n`); resolve(1); });
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
  });
  process.off('SIGINT', forward);
  process.off('SIGTERM', forward);
  isolation.cleanup(code === 0 ? 'passed' : code === 130 || code === 143 ? 'interrupted' : 'failed');
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write('Usage: node scripts/test-isolation-guard.mjs <command> [args...]\n');
    process.exitCode = 2;
  } else {
    process.exitCode = await runIsolated(command, args);
  }
}
