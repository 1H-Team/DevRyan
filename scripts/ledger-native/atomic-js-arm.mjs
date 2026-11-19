#!/usr/bin/env node
// The JavaScript arm of the shared atomic-file specification: runs one
// scenario (JSON on stdin) against packages/harness-runtime/lib/atomic-file.js
// through a recording file system and prints one JSON result on stdout. The
// Rust arm is the native ledger's test-only probe, which reads and writes the
// same shapes; the specification beside this file describes them.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { cleanupStaleAtomicFiles, withCrossProcessFileLock, writeFileAtomic } from '../../packages/harness-runtime/lib/atomic-file.js';

const errorCode = (error) => (error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNCODED');

/** The scenario-relative spelling of a path the module passed to the file system. */
export const relativeTo = (root) => (file) => {
  if (typeof file !== 'string') return file;
  if (file === root) return '.';
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
};

/** The root's paths inside a message, spelled as `relativeTo` spells them. */
export const maskRoot = (root) => (text) => (root ? text.replaceAll(`${root}/`, '').replaceAll(root, '.') : text);

/** What Node put on an error: code, errno, syscall, path, dest and message (paths under `root` relative). */
export function failureOf(error, root = '') {
  if (!error || typeof error !== 'object') return { code: 'UNCODED', message: String(error) };
  const rel = root ? relativeTo(root) : (file) => file;
  const record = { code: errorCode(error) };
  if (error.errno !== undefined) record.errno = error.errno;
  if (error.syscall !== undefined) record.syscall = error.syscall;
  if (error.path !== undefined) record.path = rel(error.path);
  if (error.dest !== undefined) record.dest = rel(error.dest);
  record.message = maskRoot(root)(String(error.message));
  return record;
}

const faultError = (code) => Object.assign(new Error(`injected ${code}`), { code });

function matcher(rel) {
  return (rule, op, args) => rule.op === op && (rule.path === undefined || rel(args[0]) === rule.path);
}

/** A node:fs/promises facade that records every call the module makes, injects faults and runs observations. */
function recordingFs({ root, trace, observations, faults, alter }) {
  const rel = relativeTo(root);
  const matches = matcher(rel);
  const counts = new Map();
  const altered = new Map();
  // `alter`: the call's argument `arg` becomes a directory or a file with `content` just before the call.
  const change = (op, args) => {
    for (const [key, rule] of alter.entries()) {
      if (!matches(rule, op, args)) continue;
      const seen = (altered.get(key) ?? 0) + 1;
      altered.set(key, seen);
      if (rule.nth !== undefined && rule.nth !== seen) continue;
      const target = args[rule.arg ?? 0];
      if (rule.directory) { fsSync.rmSync(target, { force: true }); fsSync.mkdirSync(target); } else if (rule.content !== undefined) fsSync.writeFileSync(target, rule.content.replaceAll('<pid>', String(process.pid)));
    }
  };
  const before = async (op, args) => {
    for (const rule of faults) {
      if (!matches(rule, op, args)) continue;
      const key = faults.indexOf(rule);
      const seen = (counts.get(key) ?? 0) + 1;
      counts.set(key, seen);
      if (rule.nth === undefined || rule.nth === seen) return faultError(rule.code);
    }
    return null;
  };
  const observe = async (op, args, rules) => {
    for (const rule of rules) {
      if (rule.op !== op) continue;
      const record = { op };
      for (const index of rule.read ?? []) {
        try { record[`read${index}`] = await fs.readFile(args[index], 'utf8'); } catch (error) { record[`read${index}`] = { error: errorCode(error) }; }
      }
      for (const index of rule.exists ?? []) {
        try { await fs.lstat(args[index]); record[`exists${index}`] = true; } catch { record[`exists${index}`] = false; }
      }
      observations.push(record);
    }
  };
  const recorded = (op, shape, call) => async (...args) => {
    const shaped = shape(args);
    const entry = { op, args: shaped.map(rel) };
    trace.push(entry);
    await observe(op, shaped, observations.rules);
    change(op, shaped);
    const injected = await before(op, shaped);
    if (injected) { entry.error = injected.code; entry.injected = true; throw injected; }
    try {
      const value = await call(...args);
      return value;
    } catch (error) {
      entry.error = errorCode(error);
      entry.failure = failureOf(error, root);
      throw error;
    }
  };
  const handleOps = (file, handle) => {
    const wrap = (op, shape, call) => recorded(op, (args) => [file, ...shape(args)], call);
    return {
      writeFile: wrap('handle.writeFile', (args) => [Buffer.from(args[0], typeof args[0] === 'string' ? args[1] ?? 'utf8' : undefined).toString('utf8')], (data, encoding) => handle.writeFile(data, encoding)),
      sync: wrap('handle.sync', () => [], () => handle.sync()),
      close: wrap('handle.close', () => [], () => handle.close()),
    };
  };
  return {
    mkdir: recorded('mkdir', (args) => [args[0], { recursive: args[1]?.recursive === true, mode: args[1]?.mode }], (...args) => fs.mkdir(...args)),
    readdir: recorded('readdir', (args) => [args[0], { withFileTypes: args[1]?.withFileTypes === true }], (...args) => fs.readdir(...args)),
    stat: recorded('stat', (args) => [args[0]], (...args) => fs.stat(...args)),
    rm: recorded('rm', (args) => [args[0], { force: args[1]?.force === true }], (...args) => fs.rm(...args)),
    open: recorded('open', (args) => (args[1] === 'wx' ? [args[0], args[1], args[2]] : args.slice(0, 2)), async (file, ...rest) => handleOps(file, await fs.open(file, ...rest))),
    rename: recorded('rename', (args) => [args[0], args[1]], (...args) => fs.rename(...args)),
    chmod: recorded('chmod', (args) => [args[0], args[1]], (...args) => fs.chmod(...args)),
    link: recorded('link', (args) => [args[0], args[1]], (...args) => fs.link(...args)),
    unlink: recorded('unlink', (args) => [args[0]], (...args) => fs.unlink(...args)),
    readFile: recorded('readFile', (args) => [args[0], args[1]], (...args) => fs.readFile(...args)),
  };
}

const realIsProcessAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

async function runCallback(steps, { root, clock, outputs }) {
  let value;
  for (const step of steps ?? []) {
    if (step.inspect !== undefined) {
      const file = path.join(root, step.inspect);
      const record = { inspect: step.inspect };
      try { record.content = await fs.readFile(file, 'utf8'); record.mode = (await fs.stat(file)).mode & 0o777; } catch (error) { record.error = errorCode(error); }
      outputs.push(record);
    } else if (step.write !== undefined) {
      await fs.writeFile(path.join(root, step.write), step.content.replaceAll('<pid>', String(process.pid)));
    } else if (step.recordElapsed) {
      outputs.push({ elapsed: clock.value - clock.base });
    } else if (step.throw !== undefined) {
      throw faultError(step.throw);
    } else if (step.return !== undefined) {
      value = step.return;
    }
  }
  return value;
}

async function runOperation(run, { root, clock }) {
  const trace = [];
  const observations = [];
  observations.rules = run.observe ?? [];
  const progress = [];
  const callbackOutputs = [];
  const fsApi = recordingFs({ root, trace, observations, faults: run.faults ?? [], alter: run.alter ?? [] });
  const options = run.options ?? {};
  const now = () => {
    if (run.now === 'clock') { trace.push({ op: 'now', value: clock.value - clock.base }); return clock.value; }
    trace.push({ op: 'now' });
    return Date.now();
  };
  const wait = async (milliseconds) => {
    trace.push({ op: 'wait', ms: milliseconds });
    if (run.wait === 'clock') clock.value += milliseconds;
    else await new Promise((resolve) => setTimeout(resolve, milliseconds));
  };
  const isProcessAlive = (pid) => {
    const result = run.isAlive === 'real' || run.isAlive === undefined ? realIsProcessAlive(pid) : run.isAlive === true;
    trace.push({ op: 'isAlive', pid, result });
    return result;
  };
  const randomToken = () => {
    trace.push({ op: 'randomToken' });
    return options.randomToken ?? crypto.randomUUID().replaceAll('-', '');
  };
  const randomId = () => {
    trace.push({ op: 'randomId' });
    return options.randomId ?? crypto.randomUUID().replaceAll('-', '');
  };
  let signalChecks = 0;
  const signal = run.signal ? {
    throwIfAborted() {
      signalChecks += 1;
      const aborted = signalChecks > run.signal.abortAfter;
      trace.push({ op: 'signal', aborted });
      if (aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
    },
  } : undefined;
  const target = path.join(root, run.path);
  let outcome;
  try {
    let value;
    if (run.op === 'writeFileAtomic') {
      value = await writeFileAtomic(target, run.data, {
        fs: fsApi, now, randomId, mode: options.mode, directoryMode: options.directoryMode, staleTmpAgeMs: options.staleTmpAgeMs,
        onProgress: ({ phase, state }) => progress.push(`${phase}:${state}`),
      });
    } else if (run.op === 'lock') {
      value = await withCrossProcessFileLock(target, () => runCallback(run.callback, { root, clock, outputs: callbackOutputs }), {
        fs: fsApi, now, wait, isProcessAlive, randomToken, signal,
        timeoutMs: options.timeoutMs, retryMs: options.retryMs, malformedStaleMs: options.malformedStaleMs,
      });
    } else if (run.op === 'cleanup') {
      value = await cleanupStaleAtomicFiles(target, { fs: fsApi, now, staleAfterMs: options.staleAfterMs });
    } else {
      throw new Error(`unknown operation ${run.op}`);
    }
    outcome = value === undefined ? { ok: true } : { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error: errorCode(error), failure: failureOf(error, root) };
  }
  return { ...outcome, trace, progress, observations: [...observations], callback: callbackOutputs, after: snapshotTree(root) };
}

async function setup(steps, root) {
  for (const step of steps) {
    const file = step.write ?? step.mkdir ?? step.utimes ?? step.chmod ?? step.symlink;
    const target = path.join(root, file);
    if (step.write !== undefined) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, step.hex !== undefined ? Buffer.from(step.hex, 'hex') : step.content.replaceAll('<pid>', String(process.pid)));
    } else if (step.symlink !== undefined) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(step.target, target);
    } else if (step.mkdir !== undefined) {
      await fs.mkdir(target, { recursive: true });
    } else if (step.utimes !== undefined) {
      await fs.utimes(target, step.atime, step.mtime);
    } else if (step.chmod !== undefined) {
      await fs.chmod(target, step.mode);
    }
  }
}

/** Every entry under `root`: path, type, permission bits and, for files, the text. */
export function snapshotTree(root) {
  const entries = [];
  const walk = (relative) => {
    const names = fsSync.readdirSync(path.join(root, relative)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      const file = relative ? `${relative}/${name}` : name;
      const stat = fsSync.lstatSync(path.join(root, file));
      if (stat.isDirectory()) { entries.push({ path: file, type: 'dir', mode: stat.mode & 0o777 }); walk(file); } else if (stat.isFile()) {
        entries.push({ path: file, type: 'file', mode: stat.mode & 0o777, content: fsSync.readFileSync(path.join(root, file), 'utf8') });
      } else entries.push({ path: file, type: 'other' });
    }
  };
  walk('');
  return entries;
}

export async function runScenario(scenario, root) {
  const clock = { value: 0, base: 0 };
  const runs = [];
  for (const step of scenario.steps) {
    if (step.setup) await setup(step.setup, root);
    else if (step.clock) {
      if (step.clock.set !== undefined) { clock.value = step.clock.set; clock.base = step.clock.set; }
      if (step.clock.setToMtime !== undefined) { clock.value = (await fs.stat(path.join(root, step.clock.setToMtime))).mtimeMs; clock.base = clock.value; }
      if (step.clock.advance !== undefined) clock.value += step.clock.advance;
    } else if (step.run) runs.push(await runOperation(step.run, { root, clock }));
  }
  return { pid: process.pid, runs, final: snapshotTree(root) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const input = JSON.parse(fsSync.readFileSync(0, 'utf8'));
  const result = await runScenario(input.scenario, input.root);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
