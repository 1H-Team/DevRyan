// Bounded concurrent runner for independent test processes.
//
// Each unit is one child process in its own process group. With more than one
// slot, a unit's output goes to a private temp file and is printed whole when
// the unit ends, so concurrent suites never interleave; a heartbeat names the
// units still running. With one slot, output streams live as before.
// Every unit runs (no unit is skipped because another failed) unless
// `failFast` is set; the result is a failure if any unit failed. On SIGINT or
// SIGTERM the runner signals every owned process group, removes its temp dir
// and exits 130/143.
import { spawn } from 'node:child_process';
import { defaultTestConcurrency } from './test-runner-utils.mjs';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
const detached = process.platform !== 'win32';

/** Outer pool capacity; unit `weight` reserves more of it (see runTestUnits). */
export function testConcurrency(environment = process.env) {
  const value = environment.DEVRYAN_TEST_CONCURRENCY;
  if (value === undefined || value === '') return defaultTestConcurrency();
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('DEVRYAN_TEST_CONCURRENCY must be a positive integer');
  return Number(value);
}

// A unit that outlives this wall-clock budget is killed with its process group
// and reported as timed out, so one hung test can never stall a run for hours.
// Units may set `timeoutMs`; DEVRYAN_TEST_UNIT_TIMEOUT_MS overrides the default.
export const DEFAULT_TEST_UNIT_TIMEOUT_MS = 20 * 60_000;
export function testUnitTimeoutMs(unit, environment = process.env) {
  if (Number.isSafeInteger(unit?.timeoutMs) && unit.timeoutMs > 0) return unit.timeoutMs;
  const configured = environment.DEVRYAN_TEST_UNIT_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_TEST_UNIT_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(configured) || !Number.isSafeInteger(Number(configured))) {
    throw new Error('DEVRYAN_TEST_UNIT_TIMEOUT_MS must be a positive integer');
  }
  return Number(configured);
}

export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function killGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already gone */ }
}

/**
 * Run `units` ({ name, command, args, cwd?, env?, resource?, weight?, timeoutMs? }) within a
 * capacity of `concurrency`: a unit reserves `weight` (default 1, at most the
 * capacity) while it runs, so units that start their own workers count for
 * more. Units that share an exclusive resource (such as a port) run one at a time.
 * Resolves to { passed, wallMs, results } where
 * results hold { name, status: 'passed'|'failed'|'not-run', code, signal, durationMs, timedOut }.
 * A unit past its wall-clock budget (testUnitTimeoutMs) is killed and fails.
 */
export async function runTestUnits(units, { concurrency = testConcurrency(), label = 'tests', failFast = false, cwd = process.cwd(),
  env = process.env, log = (line) => process.stdout.write(`${line}\n`), write = (text) => process.stdout.write(text), heartbeatMs = 60_000, cleanup = () => {} } = {}) {
  const names = new Set();
  for (const unit of units) {
    if (!unit?.name || !unit.command || !Array.isArray(unit.args)) throw new TypeError('Test units need name, command and args');
    if (names.has(unit.name)) throw new Error(`Duplicate test unit: ${unit.name}`);
    names.add(unit.name);
  }
  const unitTimeouts = units.map((unit) => testUnitTimeoutMs(unit, env));
  const slots = Math.max(1, Math.min(concurrency, units.length || 1));
  const captured = slots > 1;
  const group = process.env.GITHUB_ACTIONS === 'true';
  const temporary = captured ? mkdtempSync(path.join(os.tmpdir(), 'devryan-test-pool-')) : null;
  const running = new Map();
  const results = units.map((unit) => ({ name: unit.name, status: 'not-run', code: null, signal: null, durationMs: 0 }));
  const started = performance.now();
  const pending = units.map((_, index) => index), resources = new Set(), waiters = new Set();
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  let stopping = false, interrupted = null;

  // `cleanup` is the caller's scratch; an interrupt exits before the caller's own finally runs.
  const cleanupTemporary = () => { if (temporary) rmSync(temporary, { recursive: true, force: true }); };
  const exitInterrupted = (signal) => { cleanupTemporary(); try { cleanup(); } finally { process.exit(SIGNAL_EXIT_CODES[signal]); } };
  const killAll = (signal) => { for (const { child } of running.values()) killGroup(child, signal); };
  const onExit = () => { killAll('SIGKILL'); cleanupTemporary(); };
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    stopping = true;
    wake();
    log(`[${label}] ${signal}: stopping ${running.size} running unit(s)`);
    killAll('SIGTERM');
    setTimeout(() => { killAll('SIGKILL'); exitInterrupted(signal); }, 5000).unref();
  };
  const handlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  process.on('exit', onExit);
  const heartbeat = captured && heartbeatMs > 0 ? setInterval(() => {
    const now = performance.now();
    const active = [...running.values()].map(({ unit, startedAt }) => `${unit.name} ${formatDuration(now - startedAt)}`);
    log(`[${label}] ${formatDuration(now - started)}: ${results.filter((row) => row.status !== 'not-run').length}/${units.length} done; running ${active.join(', ')}`);
  }, heartbeatMs) : null;
  heartbeat?.unref();

  if (captured) log(`[${label}] ${units.length} unit(s), ${slots} at a time`);

  const launch = (index) => new Promise((resolve) => {
    const unit = units[index], result = results[index];
    const logFile = captured ? path.join(temporary, `${index}.log`) : null;
    const descriptor = logFile ? openSync(logFile, 'w') : null;
    const unitStarted = performance.now();
    if (!captured) log(`\n$ ${[unit.command, ...unit.args].join(' ')}`);
    const child = spawn(unit.command, unit.args, { cwd: unit.cwd ?? cwd, env: unit.env ?? env, detached,
      stdio: captured ? ['ignore', descriptor, descriptor] : ['ignore', 'inherit', 'inherit'] });
    if (descriptor !== null) closeSync(descriptor);
    running.set(index, { unit, child, startedAt: unitStarted });
    let timedOut = false, forceKill = null;
    const deadline = setTimeout(() => {
      timedOut = true;
      log(`[${label}] ${unit.name} exceeded ${formatDuration(unitTimeouts[index])}; killing its process group`);
      killGroup(child, 'SIGTERM');
      forceKill = setTimeout(() => killGroup(child, 'SIGKILL'), 5000);
      forceKill.unref();
    }, unitTimeouts[index]);
    deadline.unref();
    const finish = (code, signal, error) => {
      if (!running.has(index)) return;
      running.delete(index);
      clearTimeout(deadline);
      if (forceKill) clearTimeout(forceKill);
      result.timedOut = timedOut;
      result.durationMs = performance.now() - unitStarted;
      result.code = code; result.signal = signal;
      result.status = code === 0 && !error && !timedOut ? 'passed' : 'failed';
      if (captured) {
        const output = readFileSync(logFile, 'utf8');
        const title = `${unit.name}: ${result.status} in ${formatDuration(result.durationMs)}`;
        const fold = group && result.status === 'passed';
        log(fold ? `::group::${title}` : `\n===== ${title}`);
        log(`$ ${[unit.command, ...unit.args].join(' ')}${unit.cwd ? `  (in ${path.relative(cwd, unit.cwd) || '.'})` : ''}`);
        if (output) write(output.endsWith('\n') ? output : `${output}\n`);
        if (error) log(`${unit.name} could not start: ${error.message}`);
        if (timedOut) log(`${unit.name} timed out after ${formatDuration(unitTimeouts[index])}`);
        log(fold ? '::endgroup::' : `===== end ${unit.name}`);
        rmSync(logFile, { force: true });
      } else if (error) log(`${unit.name} could not start: ${error.message}`);
      else if (timedOut) log(`${unit.name} timed out after ${formatDuration(unitTimeouts[index])}`);
      if (result.status === 'failed' && failFast && !stopping) {
        stopping = true;
        log(`[${label}] ${unit.name} failed; stopping (fail-fast)`);
        killAll('SIGTERM');
      }
      resolve();
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('exit', (code, signal) => finish(code, signal));
  });

  const weightOf = (index) => Math.min(slots, Math.max(1, Number.isSafeInteger(units[index].weight) ? units[index].weight : 1));
  let used = 0;
  const fits = (index) => (!units[index].resource || !resources.has(units[index].resource)) && (running.size === 0 || used + weightOf(index) <= slots);
  const schedule = async () => {
    const active = new Set();
    while (true) {
      for (let next = stopping ? -1 : pending.findIndex(fits); next !== -1; next = stopping ? -1 : pending.findIndex(fits)) {
        const [index] = pending.splice(next, 1), resource = units[index].resource, weight = weightOf(index);
        if (resource) resources.add(resource);
        used += weight;
        const run = launch(index).finally(() => { if (resource) resources.delete(resource); used -= weight; active.delete(run); wake(); });
        active.add(run);
      }
      if (active.size === 0) break;
      await new Promise((resolve) => { waiters.add(resolve); });
    }
  };
  try {
    await schedule();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    process.off('exit', onExit);
    cleanupTemporary();
  }
  if (interrupted) exitInterrupted(interrupted);
  const wallMs = performance.now() - started;
  return { passed: results.every((row) => row.status === 'passed'), wallMs, results };
}

/** One summary line per unit, slowest first, plus wall time against the serial sum. */
export function summarizeTestUnits({ results, wallMs }, { label = 'tests', limit = 15, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const ran = results.filter((row) => row.status !== 'not-run');
  const serialMs = ran.reduce((sum, row) => sum + row.durationMs, 0);
  log(`\n[${label}] ${ran.filter((row) => row.status === 'passed').length} passed, ${ran.filter((row) => row.status === 'failed').length} failed, `
    + `${results.length - ran.length} not run; wall ${formatDuration(wallMs)}, serial sum ${formatDuration(serialMs)}`);
  for (const row of [...ran].sort((left, right) => right.durationMs - left.durationMs).slice(0, limit)) {
    log(`  ${formatDuration(row.durationMs).padStart(7)}  ${row.status === 'passed' ? 'ok  ' : 'FAIL'}  ${row.name}`);
  }
  for (const row of results.filter((entry) => entry.status === 'failed')) {
    log(`[${label}] FAILED: ${row.name} (${row.signal ? `signal ${row.signal}` : `exit ${row.code}`})`);
  }
  for (const row of results.filter((entry) => entry.status === 'not-run')) log(`[${label}] NOT RUN: ${row.name}`);
}

/**
 * Persist one run's unit timings as JSON when DEVRYAN_TEST_TIMINGS names a file
 * (CI uploads it; lane balancing and `bun run test:timings` read it). Nothing is
 * written otherwise, so local runs leave no files behind.
 */
export function recordTestTimings({ results, wallMs }, units, { label = 'tests', environment = process.env } = {}) {
  const file = environment.DEVRYAN_TEST_TIMINGS;
  if (!file) return null;
  const byName = new Map(units.map((unit) => [unit.name, unit]));
  const record = {
    schemaVersion: 1,
    label,
    recordedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cores: os.availableParallelism() },
    toolchain: { node: process.versions.node, bun: process.versions.bun ?? null },
    wallMs: Math.round(wallMs),
    units: results.map((row) => ({ name: row.name, suite: byName.get(row.name)?.suite ?? null, status: row.status, ms: Math.round(row.durationMs) })),
  };
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}
