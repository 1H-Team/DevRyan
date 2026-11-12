// Parent side of a dual run: starts arms (dual-run-arm.mjs), records a scenario through
// the product host, and replays a recording against an implementation.
//
// A recording is the list of steps the scenario took (calls, the groups they
// were issued in, waits, file-system actions of the agent, restarts) plus every
// seam message of every call, so a replay can post the same `call` messages,
// answer the same callbacks, and be compared message by message.
//
// Besides the messages, the parent makes two observations of its own in every
// run, which the comparer checks the stored values against:
// - the timeline: for each group of calls issued together, the wall-clock
//   window from just before the first was posted to just after the last
//   returned; consecutive windows are at least one millisecond apart, so every
//   time a ledger stores falls inside exactly one window or one gap;
// - stat observations: a bigint lstat of every entry of the stage before the
//   first call, after every group of calls and every file action, and at the
//   end, so every stored file stamp can be traced to the file and the moment
//   it describes.
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeValue, encodeValue } from './dual-run-codec.mjs';
import { createIdentityMap } from './dual-run-identity.mjs';
import { observeStage } from './dual-run-snapshot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(here, '../..');
export const PRODUCT_LIB = path.join(REPOSITORY_ROOT, 'packages/harness-runtime/lib');
export const CRASH_PRELOAD = path.join(here, 'ledger-preload.cjs');

/** Seed of the identifier protocol (dual-run-ids.cjs); null for the ledger's own random identifiers. */
export const DEFAULT_ID_SEED = 'ledger-dual-run';

/** Ledger options every scenario passes unless it says otherwise: background maintenance can never start on its own. */
export const QUIET_MAINTENANCE = Object.freeze({ looseObjects: 1_000_000_000, packs: 1_000_000_000, commits: 1_000_000_000 });

/** The private environment of an arm and its ledger: HOME, XDG folders, Git configuration and TMPDIR inside the stage. */
export function armEnvironment(stage, extra = {}) {
  const home = path.join(stage, 'home');
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(DEVRYAN|OPENCHAMBER|OPENCODE|LEDGER_DUAL_RUN)_/.test(name) || /^GIT_/.test(name) || /^XDG_/.test(name)) continue;
    if (['HOME', 'TMPDIR', 'NODE_OPTIONS', 'SSH_AUTH_SOCK'].includes(name)) continue;
    env[name] = value;
  }
  return { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: path.join(stage, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0',
    // Electron's Node and Node both run the ledger on its worker thread.
    DEVRYAN_LEDGER_WORKER: '1', ...extra };
}

/** Environment that puts the git shim (dual-run-git-shim.mjs) first on an arm's PATH, logging to `log`. */
export function shimEnvironment({ bin, log, crash }) {
  if (!bin) return {};
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, ...(log ? { LEDGER_DUAL_RUN_GIT_LOG: log } : {}),
    ...(crash ? { LEDGER_DUAL_RUN_GIT_CRASH: [crash.phase, crash.nth, crash.action ?? 'kill', crash.marker, crash.armFile, crash.ref ?? 'refs/devryan/state'].join(' ') } : {}) };
}

export async function prepareStageHome(stage) {
  const home = path.join(stage, 'home');
  for (const folder of ['.config', '.local/share', '.local/state', '.cache']) await fs.mkdir(path.join(home, folder), { recursive: true, mode: 0o700 });
  // No hooks, templates or signing from anywhere but here.
  await fs.writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Dual Run\n\temail = dual-run@example.invalid\n[core]\n\thooksPath = /dev/null\n[init]\n\ttemplateDir =\n[commit]\n\tgpgsign = false\n');
  await fs.mkdir(path.join(stage, 'tmp'), { recursive: true, mode: 0o700 });
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** Returns once the wall clock has moved past the millisecond it reads now: windows never share a millisecond. */
export async function tick() { const now = Date.now(); while (Date.now() <= now) await wait(1); }

/** One arm process. `crash` arms a crash point (ledger-preload.cjs) in the ledger it runs. */
export class Arm {
  static async start({ stage, mode, libDir = PRODUCT_LIB, implementation = { kind: 'worker' }, options, workerData, crash, audit, ids, env, idLog }) {
    const crashEnv = { ...(crash ? { LEDGER_DUAL_RUN_CRASH: JSON.stringify(crash) } : {}), ...(audit ? { LEDGER_DUAL_RUN_AUDIT: audit } : {}),
      ...(ids ? { LEDGER_DUAL_RUN_IDS: ids } : {}), ...(idLog ? { LEDGER_DUAL_RUN_ID_LOG: idLog } : {}) };
    // A worker-thread ledger inherits the arm's flags, so the arm itself preloads the crash points.
    const instrumented = Boolean(crash || audit || ids);
    const execArgv = instrumented && (mode === 'record' || implementation.kind === 'worker') ? ['--require', CRASH_PRELOAD] : [];
    const child = fork(path.join(here, 'dual-run-arm.mjs'), [], { cwd: stage, env: armEnvironment(stage, { ...crashEnv, ...env }), execArgv,
      serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const arm = new Arm(child);
    const ready = await arm.request({ op: 'init', mode, libDir, implementation, options, workerData, instrumented }, 'ready');
    arm.pid = ready.pid; arm.ledgerPid = ready.ledgerPid;
    return arm;
  }

  constructor(child) {
    this.child = child;
    this.waiters = [];
    this.exited = new Promise((resolve) => child.once('exit', (code, signal) => { this.exitStatus = { code, signal }; resolve(this.exitStatus); }));
    child.on('message', (message) => {
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index === -1) return;
      const [waiter] = this.waiters.splice(index, 1);
      waiter.resolve(message);
    });
    this.exited.then(() => { for (const waiter of this.waiters.splice(0)) waiter.reject(Object.assign(new Error('arm exited'), { code: 'arm_exited', status: this.exitStatus })); });
  }

  request(command, reply, match = () => true) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ match: (message) => message.op === 'error' || (message.op === reply && match(message)), resolve: (message) => {
        if (message.op === 'error') reject(Object.assign(new Error(`arm: ${message.error?.message ?? message.error}`), { detail: message }));
        else resolve(message);
      }, reject });
      this.child.send(command);
    });
  }

  call(label, method, args, how = {}) { return this.request({ op: 'call', label, method, args, how }, 'done', (message) => message.label === label); }
  /** A live call to a replay arm's implementation (no recording): contention between implementations. */
  invoke(label, method, args) { return this.request({ op: 'invoke', label, method, args }, 'done', (message) => message.label === label); }
  /** Calls the recording issued together, posted by the arm in one turn of its event loop, as the host posted them. */
  replayGroup(calls) {
    const replies = calls.map(({ label }) => new Promise((resolve, reject) => {
      this.waiters.push({ match: (message) => message.op === 'done' && message.label === label, resolve, reject });
    }));
    this.child.send({ op: 'replay-group', calls });
    return replies;
  }
  log() { return this.request({ op: 'log' }, 'log'); }
  stopLedger() { return this.request({ op: 'stop-ledger' }, 'stopped'); }
  async close() {
    if (this.exitStatus) return this.exitStatus;
    try { await this.request({ op: 'close' }, 'closed'); } catch { /* exited meanwhile */ }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 30_000);
    const status = await this.exited;
    clearTimeout(timer);
    return status;
  }
  kill() { if (!this.exitStatus) this.child.kill('SIGKILL'); return this.exited; }
}

// ---------------------------------------------------------------- traces
/** Seam messages of one call (one arm generation), in the order they crossed. */
export function traceOf(entries, callID) {
  const callbacks = new Set(), streams = new Set();
  const trace = [];
  for (const entry of entries) {
    const message = entry.message;
    const type = message?.type;
    let mine = false;
    if (['call', 'result', 'report', 'progress', 'abort'].includes(type)) mine = message.id === callID;
    else if (type === 'callback') {
      mine = message.target?.call === callID || (message.target?.cause !== undefined && message.target.cause === callID);
      if (mine) callbacks.add(message.id);
    } else if (type === 'callback-result') mine = callbacks.has(message.id);
    else if (type === 'observe') mine = message.cause === callID;
    else if (type === 'pull' || type === 'chunk' || type === 'stream-return') mine = streams.has(message.stream);
    if (type === 'result' && mine && !message.failed) for (const id of streamMarkers(decodeValue(message.value))) streams.add(id);
    if (mine) trace.push({ dir: entry.dir, message });
  }
  return trace;
}
const streamMarkers = (value, found = []) => {
  if (Array.isArray(value)) { for (const item of value) streamMarkers(item, found); return found; }
  if (value && typeof value === 'object') {
    if (typeof value.__devryanStream === 'number') { found.push(value.__devryanStream); return found; }
    for (const entry of Object.values(value)) streamMarkers(entry, found);
  }
  return found;
};
/** Messages tied to no call: ready, exits, observers and observer callbacks without a cause, and the host's answers to those callbacks. */
export function untied(entries) {
  const callbacks = new Set();
  // Logged messages are encoded (dual-run-codec.mjs): an absent cause and a cause of `undefined` both mean none.
  return entries.filter(({ dir, message: logged }) => {
    const message = logged && typeof logged === 'object' ? decodeValue(logged) : logged;
    if (dir === 'exit' || message?.type === 'ready') return true;
    if (message?.type === 'observe' && message.cause === undefined) return true;
    if (message?.type === 'callback' && message.target?.observer !== undefined && message.target.cause === undefined) { callbacks.add(message.id); return true; }
    return message?.type === 'callback-result' && callbacks.has(message.id);
  });
}

/**
 * How the host side of a call behaved, from its trace, so a replay does the
 * same: when the host posted `abort` (after how many of the call's own
 * ledger-to-host messages), and per result stream how many chunks it pulled
 * and whether it stopped early (`stream-return`).
 */
export function hostConduct(trace) {
  let seen = 0, abortAfter = null;
  const streams = new Map();
  for (const { dir, message } of trace) {
    if (dir === 'w2h' && !['chunk', 'progress', 'result'].includes(message.type)) seen += 1;
    if (dir === 'h2w' && message.type === 'abort' && abortAfter === null) abortAfter = Math.max(0, seen);
    if (dir === 'h2w' && message.type === 'pull') { const row = streams.get(message.stream) ?? { pulls: 0, returned: false }; row.pulls += 1; streams.set(message.stream, row); }
    if (dir === 'h2w' && message.type === 'stream-return') { const row = streams.get(message.stream) ?? { pulls: 0, returned: false }; row.returned = true; streams.set(message.stream, row); }
  }
  return { abortAfter, streams: [...streams.values()] };
}

// ---------------------------------------------------------------- recording
/**
 * Runs `scenario.script(context)` against the product host on `stage` and
 * returns the recording. The context's calls return decoded values; file
 * actions are performed and recorded with the paths the scenario used.
 * `shim` ({ bin, log }) puts the git shim on the arm's PATH.
 */
export async function recordScenario({ stage, scenario, crash, audit, ids = DEFAULT_ID_SEED, env, options: overrides, shim, idLog }) {
  const scenarioOptions = typeof scenario.options === 'function' ? scenario.options(stage) : scenario.options;
  const options = { directory: path.join(stage, scenario.storage ?? 'ledger'), maintenance: QUIET_MAINTENANCE, ...scenarioOptions, ...overrides };
  const storage = path.relative(stage, options.directory);
  const recording = { version: 2, scenario: scenario.name, stage, options: encodeValue(options), steps: [], generations: [], census: {}, timeline: [], observations: [] };
  let arm = null, generation = -1, entries = [], group = null;
  const pendingLabels = new Map();
  const observe = () => { recording.observations.push(observeStage(stage, storage)); };
  const startArm = async (startOptions = options) => {
    generation += 1;
    entries = [];
    // Each arm generation draws its own identifiers (a reopened ledger must not reuse a token).
    arm = await Arm.start({ stage, mode: 'record', options: startOptions, crash, audit, ids: ids && `${ids}:${generation}`, idLog, env: { ...shimEnvironment(shim ?? {}), ...env } });
    recording.generations.push({ options: encodeValue(startOptions), workerData: null, pid: arm.pid, entries, untied: [] });
    recording.steps.push({ op: 'start', generation, options: encodeValue(startOptions) });
  };
  const flush = async () => {
    const { entries: fresh, census, observed, workerData } = await arm.log();
    entries.push(...fresh);
    Object.assign(recording.census, census);
    const current = recording.generations[generation];
    current.workerData ??= workerData ?? null;
    current.observed ??= { diagnostics: [], changes: [], materialized: [], lockTimings: [] };
    for (const key of Object.keys(current.observed)) current.observed[key].push(...(observed?.[key] ?? []));
  };
  const issue = (label, method, args, how = {}) => {
    if (pendingLabels.has(label) || recording.steps.some((step) => step.op === 'call' && step.label === label)) throw new Error(`duplicate call label ${label}`);
    const encoded = encodeValue(args);
    armCrash(crash, label);
    if (!group) { group = { labels: [], start: Date.now(), end: null }; recording.timeline.push(group); }
    group.labels.push(label);
    recording.steps.push({ op: 'call', label, method, generation });
    const issuedAt = Date.now();
    const promise = arm.call(label, method, encoded, how).then((reply) => {
      recording.calls[label] = { generation, seamID: reply.seamID, method, ok: reply.ok, value: reply.value ?? null, error: reply.error ?? null, issuedAt };
      return reply;
    });
    pendingLabels.set(label, promise);
    return promise;
  };
  const waitFor = async (labels) => {
    recording.steps.push({ op: 'await', labels });
    const replies = [];
    for (const label of labels) { replies.push(await pendingLabels.get(label)); pendingLabels.delete(label); }
    if (group && !pendingLabels.size) { group.end = Date.now(); group = null; }
    await flush();
    observe();
    await tick();
    return replies.map((reply) => (reply.ok ? decodeValue(reply.value) : Object.assign(new Error(reply.error?.message ?? 'failed'), reply.error, { failedCall: true })));
  };
  recording.calls = {};
  const single = async (label, method, args, how) => {
    issue(label, method, args, how);
    const [value] = await waitFor([label]);
    return value;
  };
  const context = {
    stage, project: path.join(stage, 'project'), storage: options.directory,
    /** One call, awaited. Rejects with the call's error fields when it failed. */
    async call(label, method, ...args) {
      const value = await single(label, method, args);
      if (value instanceof Error && value.failedCall) throw value;
      return value;
    },
    /** Like call, but resolves `{ ok, value | error }`. */
    async attempt(label, method, ...args) {
      const value = await single(label, method, args);
      return value instanceof Error && value.failedCall ? { ok: false, error: value } : { ok: true, value };
    },
    /**
     * A call made inside an execution admission (cancellable, metered, with a
     * deadline `deadlineMs` from now), optionally aborted by its caller right
     * after it was posted, and optionally reading only `chunks` chunks of each
     * result stream before stopping it. Resolves `{ ok, value | error }`.
     */
    async admitted(label, method, args, { deadlineMs = 600_000, abort = false, chunks } = {}) {
      const value = await single(label, method, args, { admission: { deadlineMs, abort }, chunks });
      return value instanceof Error && value.failedCall ? { ok: false, error: value } : { ok: true, value };
    },
    /** Calls issued together, then awaited together: `[[label, method, ...args], ...]`. */
    async parallel(calls) {
      for (const [label, method, ...args] of calls) issue(label, method, args);
      return waitFor(calls.map(([label]) => label));
    },
    fs: {
      write: (file, data, extra = {}) => fileStep({ action: 'write', path: file, data: Buffer.from(data), ...extra }),
      append: (file, data) => fileStep({ action: 'append', path: file, data: Buffer.from(data) }),
      rm: (file) => fileStep({ action: 'rm', path: file }),
      rename: (from, to) => fileStep({ action: 'rename', path: from, to }),
      symlink: (target, file) => fileStep({ action: 'symlink', path: file, target }),
      chmod: (file, mode) => fileStep({ action: 'chmod', path: file, mode }),
      mkdir: (file) => fileStep({ action: 'mkdir', path: file }),
      read: (file) => fs.readFile(file),
    },
    /** A receipt the confined process would have written beside its view. */
    terminate: (lease, { cancelled = false } = {}) => fileStep({ action: 'write', path: path.join(path.dirname(lease.viewDirectory), 'termination.json'),
      data: Buffer.from(JSON.stringify({ terminated: true, confined: true, exitCode: cancelled ? 143 : 0, cancelled })), flag: 'wx', mode: 0o600 }),
    /** Ends this arm (and its ledger) and starts a new one on the same stage: a reopened ledger in a new process. */
    async restart(startOptions) {
      if (pendingLabels.size) throw new Error('restart with calls pending');
      await flush();
      await arm.close();
      recording.steps.push({ op: 'restart' });
      await startArm(startOptions ? { ...options, ...startOptions } : options);
    },
  };
  const fileStep = async (step) => {
    recording.steps.push({ op: 'fs', ...step, data: step.data ? step.data.toString('base64') : undefined });
    await applyFileStep(step);
    observe();
  };
  try {
    observe();
    await startArm();
    await scenario.script(context);
    if (pendingLabels.size) await waitFor([...pendingLabels.keys()]);
    issue('$drain', 'drain', []);
    await waitFor(['$drain']);
    await flush();
  } finally {
    await arm?.close();
  }
  observe();
  for (const record of recording.generations) record.untied = untied(record.entries);
  return recording;
}

// A crash point counts only once its call starts: the parent creates the
// point's arm file just before posting that call (crash.label).
function armCrash(crash, label) {
  if (crash?.armFile && crash.label === label) writeFileSync(crash.armFile, `${label}\n`);
}

export async function applyFileStep(step) {
  switch (step.action) {
    case 'write': await fs.mkdir(path.dirname(step.path), { recursive: true }); await fs.writeFile(step.path, step.data, { flag: step.flag ?? 'w', ...(step.mode ? { mode: step.mode } : {}) }); return;
    case 'append': await fs.appendFile(step.path, step.data); return;
    case 'rm': await fs.rm(step.path, { recursive: true, force: true }); return;
    case 'rename': await fs.mkdir(path.dirname(step.to), { recursive: true }); await fs.rename(step.path, step.to); return;
    case 'symlink': await fs.symlink(step.target, step.path); return;
    case 'chmod': await fs.chmod(step.path, step.mode); return;
    case 'mkdir': await fs.mkdir(step.path, { recursive: true }); return;
    default: throw new Error(`unknown file step ${step.action}`);
  }
}

// ---------------------------------------------------------------- replay
/**
 * Replays `recording` on `stage` (a fresh twin at the recording's path)
 * against `implementation` from `libDir`. Identifiers the ledger chose (lease
 * tokens, transaction IDs, view paths) are learned from each result as it
 * returns and substituted into later inputs and file actions; so are times
 * and digests a later input passes back as the ledger returned them.
 * `crash` stops the ledger at a named point (the JavaScript preload) and
 * `shim.crash` at a git shim point; the replay then ends there.
 */
export async function replayRecording({ stage, recording, libDir = PRODUCT_LIB, implementation = { kind: 'worker' }, crash, audit, ids = DEFAULT_ID_SEED, env, stopAfterCrash = true, shim, idLog }) {
  const identities = createIdentityMap();
  // Values a later input passes back as an earlier result returned them, that
  // are no identifiers: times and digests. Used for inputs only, never to
  // excuse a difference.
  const passBack = createIdentityMap({ opaque: true });
  const storage = path.relative(recording.stage, decodeValue(recording.options).directory);
  const run = { implementation, libDir, generations: [], calls: {}, crashed: null, identities, timeline: [], observations: [] };
  let arm = null, generation = -1, entries = [], group = null;
  const pending = new Map();
  const observe = () => { run.observations.push(observeStage(stage, storage)); };
  const crashLabel = crash?.label ?? shim?.crash?.label;
  const startArm = async () => {
    generation += 1;
    entries = [];
    const workerData = decodeValue(recording.generations[generation].workerData);
    arm = await Arm.start({ stage, mode: 'replay', libDir, implementation, workerData, crash, audit, ids: ids && `${ids}:${generation}`, idLog,
      env: { ...shimEnvironment(shim ?? {}), ...env } });
    run.generations.push({ entries, pid: arm.pid, ledgerPid: arm.ledgerPid, untied: [] });
  };
  const flush = async () => { if (!arm || arm.exitStatus) return; const { entries: fresh } = await arm.log(); entries.push(...fresh); };
  try {
    observe();
    // Consecutive calls (a group the scenario issued together) are posted together.
    const batch = [];
    const flushBatch = () => {
      if (!batch.length) return;
      for (const { label } of batch) { armCrash(crash, label); armCrash(shim?.crash, label); }
      const calls = batch.splice(0);
      group = { labels: calls.map(({ label }) => label), start: Date.now(), end: null };
      run.timeline.push(group);
      const replies = arm.replayGroup(calls.map(({ label, message, answers, conduct, deadlineOffset }) => ({ label, message, answers, conduct, deadlineOffset })));
      calls.forEach(({ label, seamID }, index) => pending.set(label, replies[index].then((reply) => {
        run.calls[label] = { generation, seamID: reply.seamID, exited: reply.exited };
        if (reply.exited) run.crashed ??= { label };
        return reply;
      }, (error) => { run.calls[label] = { generation, seamID, exited: true }; run.crashed ??= { label, error: error.message }; })));
    };
    for (const step of recording.steps) {
      if (run.crashed && stopAfterCrash) break;
      if (step.op !== 'call') flushBatch();
      switch (step.op) {
        case 'start': if (!arm) await startArm(); break;
        case 'restart': await flush(); await arm.close(); arm = null; await startArm(); break;
        case 'call': {
          const recorded = recording.calls[step.label];
          const recordedEntries = recording.generations[recorded.generation].entries;
          const trace = traceOf(recordedEntries, recorded.seamID);
          const callMessage = trace.find(({ dir, message }) => dir === 'h2w' && message.type === 'call');
          if (!callMessage) throw new Error(`recording has no call message for ${step.label}`);
          // Answers to the call's own input functions; observer callbacks are answered as the host answers them.
          const callbacks = new Set(trace.filter(({ dir, message }) => dir === 'w2h' && message.type === 'callback' && message.target?.observer === undefined).map(({ message }) => message.id));
          const answers = trace.filter(({ dir, message }) => dir === 'h2w' && message.type === 'callback-result' && callbacks.has(message.id))
            .map(({ message }) => { const { id: _id, type: _type, ...answer } = message; return passBack.substitute(identities.substitute(answer)); });
          const message = passBack.substitute(identities.substitute(callMessage.message));
          // A deadline is a time: re-based on this run's own clock, the same distance from posting as in the recording.
          const deadline = callMessage.message.context?.deadline;
          const deadlineOffset = Number.isFinite(deadline) && Number.isFinite(recorded.issuedAt) ? deadline - recorded.issuedAt : null;
          batch.push({ label: step.label, message, answers, seamID: recorded.seamID, conduct: hostConduct(trace), deadlineOffset });
          continue;
        }
        case 'await': {
          for (const label of step.labels) { await pending.get(label); pending.delete(label); }
          if (group && !pending.size) { group.end = Date.now(); group = null; }
          await flush();
          for (const label of step.labels) learnFromResult(recording, run, label, identities, passBack);
          observe();
          await tick();
          break;
        }
        case 'fs': {
          const data = step.data ? Buffer.from(step.data, 'base64') : undefined;
          await applyFileStep({ ...step, path: identities.substituteText(step.path), to: step.to ? identities.substituteText(step.to) : undefined, data });
          observe();
          break;
        }
        default: throw new Error(`unknown step ${step.op}`);
      }
    }
    flushBatch();
    for (const reply of pending.values()) await reply;
    if (group) { group.end = Date.now(); group = null; }
    if (!run.crashed) await flush();
  } finally {
    if (arm) {
      if (run.crashed) await arm.kill(); else await arm.close();
    }
  }
  if (!run.crashed) observe();
  run.crashLabel = crashLabel ?? null;
  for (const record of run.generations) record.untied = untied(record.entries);
  return run;
}

/** The w2h result message of a call in a run (recording or replay). */
export function resultMessage(entries, seamID) {
  return entries.find((entry) => entry.dir === 'w2h' && entry.message?.type === 'result' && entry.message.id === seamID)?.message ?? null;
}

function learnFromResult(recording, run, label, identities, passBack) {
  const recorded = recording.calls[label];
  const replayed = run.calls[label];
  if (!recorded || !replayed || !run.generations[replayed.generation]) return;
  const a = resultMessage(recording.generations[recorded.generation].entries, recorded.seamID);
  const b = resultMessage(run.generations[replayed.generation].entries, replayed.seamID);
  if (a && b && !a.failed && !b.failed) {
    const valueA = decodeValue(a.value ?? null), valueB = decodeValue(b.value ?? null);
    identities.align(valueA, valueB);
    passBack.alignOpaque(identities.substitute(valueA), valueB);
  }
}

export async function writeRecording(file, recording) { await fs.writeFile(file, `${JSON.stringify(recording)}\n`); }
export async function readRecording(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
