#!/usr/bin/env node
// The JavaScript arm of the native ledger's Git runner and store
// differential test: the product's own runner and store
// (packages/harness-runtime/lib), driven by one request per line, one answer
// line each, on Node's real loop. Its Rust twin is `ledger-native-probe
// store` (ledger-native/src/store_program.rs); both print values the same
// way (`show`).
//
//   {op: 'git' | 'tokens' | 'records' | 'read', cwd, args, options, abort?, …}
//   {op: 'store', id, steps: […], abort?}   steps against scenario `id`'s stores
//   {op: 'env', set: {NAME: value | null}}
//   {op: 'census', settle}   the Rust's census (here: nothing to count)
//
// `Date.now()` runs `skew` ms ahead once a `skew` step set it (the reader's
// watchdog reads it), so a test reaches the reader's 30 s deadline at once.
//
// Every request runs inside `runInRemoteExecutionContext` with a signal
// (cancellable), aborted before the call, by a timer, or by a step.
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { git, gitRecords, gitTokens, readGitObject } from '../../packages/harness-runtime/lib/session-changes-git.js';
import { openChangeStore } from '../../packages/harness-runtime/lib/session-changes-store.js';
import { runInRemoteExecutionContext } from '../../packages/harness-runtime/lib/execution-admission.js';
import { markObjectDirectoryPending } from '../../packages/harness-runtime/lib/object-durability.js';

const errorWith = (code, message) => Object.assign(new Error(message), { code });

// The sync shim (durability tests, on every platform): while a `syncShim`
// step has it on, the object directory's handle (`fs.open(<root>/objects,
// 'r')`) logs its open, sync and close, and the faults given fail them with
// EIO after the real call, as the Rust arm's seam does.
const realOpen = fsp.open;
let syncShim = null;
const injected = (op) => Object.assign(new Error(`EIO: i/o error, ${op === 'sync' ? 'fsync' : 'close'}`), { errno: -5, code: 'EIO', syscall: op === 'sync' ? 'fsync' : 'close' });
function shimmedOpen(file, flags, mode) {
  const opened = realOpen.call(fsp, file, flags, mode);
  const shim = syncShim;
  if (!shim || flags !== 'r' || path.basename(String(file)) !== 'objects') return opened;
  return opened.then((handle) => {
    shim.log.push(`open ${file}`);
    const fault = (op) => { const at = shim.faults.indexOf(op); if (at < 0) return false; shim.faults.splice(at, 1); return true; };
    const [sync, close] = [handle.sync.bind(handle), handle.close.bind(handle)];
    handle.sync = () => sync().then(() => { const failed = fault('sync'); shim.log.push(`sync ${file} ${failed ? 'EIO' : 'ok'}`); if (failed) throw injected('sync'); });
    handle.close = () => close().then(() => { const failed = fault('close'); shim.log.push(`close ${file} ${failed ? 'EIO' : 'ok'}`); if (failed) throw injected('close'); });
    return handle;
  });
}

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

/** A value as both arms print it. */
export function show(value) {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $num: 'NaN' };
    if (!Number.isFinite(value)) return { $num: value > 0 ? 'Infinity' : '-Infinity' };
    if (Object.is(value, -0)) return { $num: '-0' };
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (value instanceof Map) return { $map: [...value].map(([key, entry]) => [key, show(entry)]) };
  if (value instanceof Error) {
    const out = { name: value.name, message: value.name === 'SyntaxError' ? '<json>' : value.message };
    for (const key of ['code', 'status', 'command', 'failure', 'errno', 'syscall', 'committed', 'rollbackFailed']) if (value[key] !== undefined) out[key] = show(value[key]);
    if (Array.isArray(value.errors)) out.errors = value.errors.map(show);
    return { $error: out };
  }
  if (Array.isArray(value)) return value.map(show);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, show(entry)]));
  return value;
}
const outcome = (settled) => (settled.status === 'fulfilled' ? { ok: show(settled.value) } : { error: show(settled.reason) });

const setEnv = (set) => {
  for (const [key, value] of Object.entries(set ?? {})) {
    if (value === null) delete process.env[key]; else process.env[key] = String(value);
  }
};

function gitOptions(given = {}) {
  const options = {};
  if (given.env) options.env = Object.fromEntries(given.env.map(([key, value]) => [key, value === null ? undefined : value]));
  if (typeof given.input === 'string') options.input = given.input;
  if (given.inputRows) options.input = (async function* () { for (const row of given.inputRows) yield row; })();
  if (given.inputBytes !== undefined) options.input = Buffer.alloc(given.inputBytes, 0x61);
  if (given.timeoutMs !== undefined) options.timeoutMs = given.timeoutMs;
  if (given.acceptExitCodes) options.acceptExitCodes = given.acceptExitCodes;
  if (given.limit !== undefined) options.limit = given.limit;
  if (given.delimiter !== undefined) options.delimiter = given.delimiter;
  return options;
}
const valuesGen = (rows) => (async function* () { for (const row of rows) yield row; })();

async function drain(source, take) {
  const out = [];
  for await (const row of source) {
    out.push(row);
    if (take !== undefined && out.length >= take) break;
  }
  return out;
}

function runner(request) {
  const { cwd, args } = request, options = gitOptions(request.options);
  switch (request.op) {
    case 'git': return git(cwd, args, options);
    case 'tokens': return drain(gitTokens(cwd, args, options), request.breakAt);
    case 'records': return drain(gitRecords(cwd, args, request.rowsGen ? valuesGen(request.rows) : request.rows, options));
    case 'read': {
      const items = request.reads.map((read) => {
        try { return readGitObject(cwd, args, read.name, { check: Boolean(read.check), ...(read.idleMs === undefined ? {} : { idleMs: read.idleMs }) }); }
        catch (error) { return Promise.resolve({ thrown: show(error) }); }
      });
      return Promise.allSettled(items).then((outcomes) => outcomes.map(outcome));
    }
    default: return Promise.reject(errorWith('unknown_op', request.op));
  }
}

function guardOf(spec, controller, calls) {
  if (spec === undefined) return undefined;
  let count = 0;
  return () => {
    count += 1;
    calls.push(count);
    if (spec.abortAt === count) controller.abort(errorWith('call_aborted', 'aborted by the guard'));
    if (spec.failAt === count) {
      const revoked = errorWith('guard_revoked', 'the guard was revoked');
      if (spec.async) return Promise.reject(revoked);
      throw revoked;
    }
    return spec.async ? Promise.resolve(undefined) : undefined;
  };
}

const scenarios = new Map();
const stateOf = (store) => ({ tree: store.tree, exists: store.exists, pendingCount: store.pendingCount });
const storeOf = (scenario, name) => {
  const store = scenario.stores.get(name);
  if (!store) throw errorWith('no_store', String(name));
  return store;
};
const valuesOf = (step) => (step.valuesGen ? valuesGen(step.values ?? []) : step.values ?? []);

/** One step: its value (a promise for an async call) or what it throws at once. */
function step(scenario, controller, spec) {
  if (spec.s === 'open') {
    const given = spec.options ?? {};
    const options = {};
    if (given.ref !== undefined) options.ref = given.ref;
    if (given.listingLimitBytes !== undefined) options.listingLimitBytes = given.listingLimitBytes;
    if (given.persistentIndex) options.persistentIndex = true;
    if (given.at === '@tree') options.at = storeOf(scenario, given.of).tree;
    else if (given.at !== undefined) options.at = given.at;
    if (given.sync === 'fail') options.syncObjects = () => Promise.reject(errorWith('sync_failed', 'the sync failed'));
    return openChangeStore(spec.cwd, spec.gitDir, options).then((store) => { scenario.stores.set(spec.as, store); return stateOf(store); });
  }
  if (spec.s === 'env') { setEnv(spec.set); return undefined; }
  if (spec.s === 'syncShim') {
    if (spec.off) { syncShim = null; fsp.open = realOpen; return undefined; }
    syncShim = { faults: [...(spec.faults ?? [])], log: [] };
    fsp.open = shimmedOpen;
    return undefined;
  }
  if (spec.s === 'syncLog') return syncShim ? [...syncShim.log] : null;
  if (spec.s === 'skew') return new Promise((resolve) => setTimeout(() => { skew = spec.ms; resolve(undefined); }, spec.after ?? 0));
  // `readGitObject` as a step (with `skew` beside it in a `concurrent` step).
  if (spec.s === 'read') return readGitObject(spec.cwd, spec.args, spec.name, { check: Boolean(spec.check) });
  if (spec.s === 'abort') { controller.abort(errorWith('call_aborted', 'aborted by the scenario')); return undefined; }
  if (spec.s === 'markPending') { markObjectDirectoryPending(spec.directory); return undefined; }
  if (spec.s === 'concurrent') {
    const started = spec.steps.map((inner) => { try { return Promise.resolve(step(scenario, controller, inner)); } catch (error) { return Promise.reject(error); } });
    return Promise.allSettled(started).then((outcomes) => outcomes.map(outcome));
  }
  const store = storeOf(scenario, spec.st);
  switch (spec.s) {
    case 'state': return stateOf(store);
    case 'get': return store.get(spec.key);
    case 'set': return store.set(spec.key, spec.value);
    case 'remove': return store.remove(spec.key);
    case 'entries': return drain(store.entries(spec.prefix), spec.take);
    case 'list': return drain(store.list(spec.prefix), spec.take);
    case 'records': return drain(store.records(), spec.take);
    // `records()` created before a step runs, read after it (its default snapshot is bound at the call).
    case 'recordsAcross': { const rows = store.records(); return Promise.resolve(step(scenario, controller, spec.then)).then((inner) => drain(rows).then((read) => ({ inner, rows: read }))); }
    case 'committedRows': return drain(store.committedRows(spec.prefix), spec.take);
    case 'readRows': return (async () => { const rows = await drain(store.committedRows(spec.prefix)); return drain(store.readRows(rows)); })();
    case 'setList': {
      const collected = [];
      const options = { absent: Boolean(spec.absent), firstPage: spec.firstPage ?? 0, ...(spec.collect ? { collect: (data, rows) => collected.push([data, rows]) } : {}) };
      return store.setList(spec.prefix, valuesOf(spec), options).then((bytes) => ({ bytes, collected }));
    }
    case 'writeList': return store.writeList(valuesOf(spec)).then((value) => { scenario.registers.set(spec.as, value.objects); return value; });
    case 'setListObjects': return store.setListObjects(spec.prefix, typeof spec.from === 'string' ? scenario.registers.get(spec.from) ?? [] : spec.oids ?? [], { firstPage: spec.firstPage ?? 0 });
    case 'commit': {
      const calls = [];
      const guard = guardOf(spec.guard, controller, calls);
      return store.commit(guard ? { assertCurrent: guard } : {}).then((value) => ({ value, guardCalls: calls }), (error) => {
        if (!(error instanceof Error)) throw error;
        throw Object.assign(error, { guardCalls: calls });
      });
    }
    case 'pin': return store.pin(spec.token);
    case 'release': return store.release(spec.token);
    case 'importPrefix': {
      const source = typeof spec.source === 'string' && spec.source.startsWith('@') ? storeOf(scenario, spec.source.slice(1)).tree : spec.source;
      return spec.destination === undefined ? store.importPrefix(source, spec.prefix) : store.importPrefix(source, spec.prefix, spec.destination);
    }
    case 'prefixIdentity': return store.prefixIdentity(spec.prefix);
    case 'committedIdentity': return store.committedIdentity(spec.prefix);
    case 'prefixIdentities': return store.prefixIdentities(spec.prefixes);
    case 'staged': return store.staged(spec.prefix);
    case 'stage': return store.stage(() => {
      for (const inner of spec.steps) step(scenario, controller, inner);
      if (spec.fail) throw errorWith('stage_failed', 'the staged action failed');
      return 'staged';
    });
    case 'leaseRef': return store.leaseRef(spec.token);
    default: throw errorWith('unknown_step', spec.s);
  }
}

async function handle(request) {
  const controller = new AbortController();
  if (request.abort === 'before') controller.abort(errorWith('call_aborted', 'aborted before the call'));
  else if (request.abort !== undefined) setTimeout(() => controller.abort(errorWith('call_aborted', 'aborted by a timer')), request.abort.ms);
  const action = () => {
    if (request.op !== 'store') return runner(request);
    let scenario = scenarios.get(request.id);
    if (!scenario) { scenario = { stores: new Map(), registers: new Map() }; scenarios.set(request.id, scenario); }
    return (async () => {
      const outcomes = [];
      for (const item of request.steps) {
        try { outcomes.push({ ok: show(await step(scenario, controller, item)) }); }
        catch (error) { outcomes.push({ error: show(error) }); }
      }
      return outcomes;
    })();
  };
  const settled = await runInRemoteExecutionContext({ cancellable: true }, action, { signal: controller.signal });
  return settled.failed ? { error: show(settled.failure) } : { ok: show(settled.result) };
}

// Lines split on '\n' only (readline would split on U+2028 and U+2029 too).
let pending = '';
let queue = Promise.resolve();
const serve = (line) => {
  if (!line) return;
  queue = queue.then(async () => {
    let request;
    try { request = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ corrupt: true })}\n`); return; }
    if (request.op === 'env') { setEnv(request.set); process.stdout.write(`${JSON.stringify({ ok: true })}\n`); return; }
    if (request.op === 'census') { process.stdout.write(`${JSON.stringify({})}\n`); return; }
    const answer = await handle(request);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let at;
  while ((at = pending.indexOf('\n')) !== -1) { serve(pending.slice(0, at)); pending = pending.slice(at + 1); }
});
process.stdin.on('end', () => { void queue.then(() => process.exit(0)); });
