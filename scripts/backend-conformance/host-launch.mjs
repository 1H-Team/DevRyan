// Starting a group host from the harness (BH1; the scenario driver, BH2,
// builds on this): the tap setup written into the run, the host process with
// the tap preloaded, its ready line, its control port and its records. Every
// wait here is bounded: a host that never gets ready, a control call that
// never answers and a host that does not stop are failures, not hangs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT, SERVER_REQUIRE_BASE } from './edge.mjs';
import { TAP_SETUP_VARIABLE } from './tap.mjs';
import { onceFinished } from './child-finish.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TAP_MODULE = path.join(HERE, 'tap.mjs');
export const GROUP_HOST = path.join(HERE, 'group-host.mjs');
export const LIMITS = Object.freeze({ readyMs: 120_000, controlMs: 30_000, stopMs: 15_000 });

// Hosts still running when this process exits (a failed or interrupted test, a
// driver that threw) are killed. A host also stops by itself when this process
// dies by a signal it cannot handle: its stdin is a pipe from here, and it
// exits when the pipe closes (group-host.mjs).
const running = new Set();
process.once('exit', () => { for (const child of running) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });

/**
 * Stops every host this process started that is still running (a test that
 * failed before its own stop, or one that expected a refusal and got a host),
 * so the process can exit instead of waiting on their pipes. Bounded.
 */
export async function stopAllHosts({ stopMs = LIMITS.stopMs } = {}) {
  await Promise.all([...running].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stopMs);
    child.once('exit', () => { clearTimeout(killer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(killer); resolve(); }
  })));
}

/** The tap setup for a group table entry (tap.mjs header). */
export function tapSetupFor(name, group, { outDir }) {
  return {
    v: 1, outDir, group: name, servers: 'tagged', expressFrom: SERVER_REQUIRE_BASE,
    groupFiles: group.files.map((file) => path.join(REPOSITORY_ROOT, file)),
    declaredBackground: group.declaredBackground.map((entry) => ({ file: path.join(REPOSITORY_ROOT, entry.file), line: entry.line ?? null, reason: entry.reason })),
  };
}

/**
 * Starts a group host for `name` (from `table`, a module path inside this
 * folder, or the default table) inside `run` (run-scratch.mjs), on a fresh
 * data root `<label>/data` (or `dataRoot`). `stubs` maps stub names to the
 * loopback URLs of harness stubs (handed to the group table's dependencies);
 * `processGroup` makes the host lead a process group of its own; `home` is
 * the HOME the host takes once its isolation check passed (group-host.mjs). Resolves `{ ready, dataRoot, tapFile, control(path, init, options), stop(), exit }`
 * once the host printed its ready line; rejects with its stderr when it exits
 * first or is not ready within `limits.readyMs`.
 */
export async function startGroupHost({ run, name, group, label, table = null, env = process.env, dataRoot = null, home = null, variants = [], stubs = {}, processGroup = false, coverage = false, limits = LIMITS }) {
  const outDir = run.makeDirectory(`${label}/tap`);
  const data = dataRoot ?? run.makeDirectory(`${label}/data`);
  const setupFile = run.writeFile(`${label}/tap-setup.json`, `${JSON.stringify(tapSetupFor(name, group, { outDir }), null, 2)}\n`);
  const stubList = Object.entries(stubs).map(([stub, url]) => `${stub}=${url}`);
  const args = [`--import=${pathToFileURL(TAP_MODULE).href}`, GROUP_HOST, `--group=${name}`, `--data-root=${data}`, ...(table ? [`--table=${table}`] : []), ...(variants.length ? [`--variants=${variants.join(',')}`] : []), ...(stubList.length ? [`--stubs=${stubList.join(',')}`] : []), ...(home ? [`--home=${home}`] : []), ...(coverage ? ['--coverage=block'] : [])];
  // processGroup: the host leads a process group of its own (the scenario driver freezes and kills it by group).
  const child = spawn(process.execPath, args, { cwd: REPOSITORY_ROOT, env: { ...env, [TAP_SETUP_VARIABLE]: setupFile }, stdio: ['pipe', 'pipe', 'pipe'], detached: processGroup });
  // stdin stays open: it closes when this process dies, which stops the host.
  child.stdin.on('error', () => {});
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  running.add(child);
  // Settled when the host is gone and its stderr has been read to the end (child-finish.mjs).
  const exit = new Promise((resolve) => {
    child.once('exit', () => { running.delete(child); });
    onceFinished(child, (code, signal) => resolve({ code, signal, stderr }));
  });
  let timer;
  // Product modules log to stdout (the host serves the product's own code): a line that is not the
  // ready record is kept as output, never taken for it. A host that fails to start is killed.
  const output = [];
  const ready = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`group host was not ready within ${limits.readyMs} ms:\n${stderr}`), { code: null, signal: 'SIGKILL', stderr })), limits.readyMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let parsed = null;
        if (line.startsWith('{"ready":')) { try { parsed = JSON.parse(line).ready; } catch { parsed = null; } }
        if (parsed && typeof parsed === 'object') { resolve(parsed); continue; }
        if (output.length < 200) output.push(line);
      }
    });
    exit.then(({ code, signal }) => reject(Object.assign(new Error(`group host exited (${code ?? signal}) before it was ready:\n${stderr}`), { code, signal, stderr })));
  }).catch((error) => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    error.pid = child.pid;
    throw error;
  }).finally(() => clearTimeout(timer));
  // The listener above keeps draining later stdout (product log lines), so the pipe never fills.
  /** A control call, bounded by `timeoutMs` (default LIMITS.controlMs); it rejects when the host does not answer in time. */
  const control = async (route, init = {}, { timeoutMs = limits.controlMs } = {}) => {
    const response = await fetch(`http://127.0.0.1:${ready.control}${route}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: await response.json() };
  };
  return {
    ready, child, dataRoot: data, tapFile: ready.tap, exit, control,
    /** What the host printed on stdout besides its ready line (the first 200 lines). */
    output: () => [...output],
    url: (route, variant = null) => `http://127.0.0.1:${variant ? ready.variants[variant] : ready.listen}${route}`,
    /** Waits for exchange `seq` to go quiescent, at most `timeoutMs`; the answer says whether it did. */
    quiescent: (seq, timeoutMs = limits.controlMs) => control(`/quiescent?seq=${seq}&timeoutMs=${timeoutMs}`, {}, { timeoutMs: timeoutMs + 5_000 }),
    /** Stops the host through its control port and waits for it to exit; kills it after `limits.stopMs`. */
    async stop() {
      if (child.exitCode === null && child.signalCode === null) await control('/stop', { method: 'POST' }, { timeoutMs: limits.stopMs }).catch(() => child.kill('SIGTERM'));
      const killer = setTimeout(() => child.kill('SIGKILL'), limits.stopMs);
      try { return await exit; } finally { clearTimeout(killer); }
    },
  };
}

/** Reads a tap record file strictly: every line one JSON object, the file newline-terminated. */
export function readTapRecords(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.length && !text.endsWith('\n')) throw new Error(`${file}: the last record is not terminated`);
  return text.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`${file}:${index + 1}: not a JSON record`); }
  });
}
