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
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
const detached = process.platform !== 'win32';

/** Package runners spawn their own workers; leave CPU headroom by default. */
export function testConcurrency(environment = process.env) {
  const value = environment.DEVRYAN_TEST_CONCURRENCY;
  if (value === undefined || value === '') return Math.max(1, Math.min(2, os.availableParallelism()));
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('DEVRYAN_TEST_CONCURRENCY must be a positive integer');
  return Number(value);
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
 * Run `units` ({ name, command, args, cwd?, env?, resource? }) with at most `concurrency`
 * at once, serializing units that share an exclusive resource (such as a port).
 * Resolves to { passed, wallMs, results } where
 * results hold { name, status: 'passed'|'failed'|'not-run', code, signal, durationMs }.
 */
export async function runTestUnits(units, { concurrency = testConcurrency(), label = 'tests', failFast = false, cwd = process.cwd(),
  env = process.env, log = (line) => process.stdout.write(`${line}\n`), write = (text) => process.stdout.write(text), heartbeatMs = 60_000, cleanup = () => {} } = {}) {
  const names = new Set();
  for (const unit of units) {
    if (!unit?.name || !unit.command || !Array.isArray(unit.args)) throw new TypeError('Test units need name, command and args');
    if (names.has(unit.name)) throw new Error(`Duplicate test unit: ${unit.name}`);
    names.add(unit.name);
  }
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
    const finish = (code, signal, error) => {
      if (!running.has(index)) return;
      running.delete(index);
      result.durationMs = performance.now() - unitStarted;
      result.code = code; result.signal = signal;
      result.status = code === 0 && !error ? 'passed' : 'failed';
      if (captured) {
        const output = readFileSync(logFile, 'utf8');
        const title = `${unit.name}: ${result.status} in ${formatDuration(result.durationMs)}`;
        const fold = group && result.status === 'passed';
        log(fold ? `::group::${title}` : `\n===== ${title}`);
        log(`$ ${[unit.command, ...unit.args].join(' ')}${unit.cwd ? `  (in ${path.relative(cwd, unit.cwd) || '.'})` : ''}`);
        if (output) write(output.endsWith('\n') ? output : `${output}\n`);
        if (error) log(`${unit.name} could not start: ${error.message}`);
        log(fold ? '::endgroup::' : `===== end ${unit.name}`);
        rmSync(logFile, { force: true });
      } else if (error) log(`${unit.name} could not start: ${error.message}`);
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

  const worker = async () => {
    while (!stopping && pending.length) {
      const available = pending.findIndex(index => !units[index].resource || !resources.has(units[index].resource));
      if (available === -1) { await new Promise(resolve => waiters.add(resolve)); continue; }
      const [index] = pending.splice(available, 1), resource = units[index].resource;
      if (resource) resources.add(resource);
      try { await launch(index); } finally { if (resource) resources.delete(resource); wake(); }
    }
  };
  try {
    await Promise.all(Array.from({ length: slots }, worker));
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
