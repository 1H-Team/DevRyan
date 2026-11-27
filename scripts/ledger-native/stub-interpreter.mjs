// The stub methods of the native ledger's conformance tests: a small
// program interpreter over the product's execution context and I/O pool,
// with host callbacks, observers, streams and errors. Its Rust twin (the
// `stub` module of the ledger-native crate, built only with the test-hooks
// feature) interprets the same programs; the tests compare what both make
// of them.
//
// A program is an array of ops ({ op, ... }); nested ops are `body`. Values
// in ops are templates: plain JSON, with `{ $stub: ... }` for an Error
// (`error`), a local function (`fn`), a stream (`stream`), nested arrays
// (`deep`), a register (`reg`), every register (`regs`) or an input
// function (`fnarg`).
import {
  checkExecutionAdmission, executionCleanup, executionDiagnostic, executionPhase, executionProgress, executionProgressMeter,
  executionRemainingMs, executionReporting, executionSignal, executionStep, quietExecutionPhase, timedExecutionStep,
  waitForExecutionQueue, withExecutionMeter, withExecutionSlotWait, withoutExecutionDeadline,
} from '../../packages/harness-runtime/lib/execution-admission.js';
import { withExecutionIO } from '../../packages/harness-runtime/lib/execution-io-pool.js';
import { encodeWireError } from '../../packages/harness-runtime/lib/session-mutation-wire.js';

const ERROR_FIELDS = ['code', 'status', 'committed', 'rollbackFailed', 'retryable', 'reason'];

/** State shared by every program of one process: gates, named meters, observers, the event log. */
export function createStubGlobal({ observers = {}, events = null, epoch = 0 } = {}) {
  return { gates: new Map(), meters: new Map(), observers, events, epoch };
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function gate(global, name) {
  let entry = global.gates.get(name);
  if (!entry) {
    let resolve, reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    promise.catch(() => {});
    entry = { promise, resolve, reject };
    global.gates.set(name, entry);
  }
  return entry;
}

/** `encodeWireError(error)` without its stacks, the way a caught error is kept. */
export function summarize(error) {
  const strip = (encoded) => {
    const { stack: _stack, ...rest } = encoded;
    if (Array.isArray(rest.errors)) rest.errors = rest.errors.map(strip);
    if (rest.cause !== undefined) rest.cause = strip(rest.cause);
    return rest;
  };
  return strip(encodeWireError(error));
}

function makeError(spec, env) {
  const message = value(spec.message, env);
  const options = Object.hasOwn(spec, 'cause') ? { cause: value(spec.cause, env) } : undefined;
  const error = Array.isArray(spec.errors) ? new AggregateError(spec.errors.map((entry) => value(entry, env)), message, options)
    : new Error(message, options);
  if (typeof spec.name === 'string') Object.defineProperty(error, 'name', { value: spec.name, configurable: true });
  for (const field of ERROR_FIELDS) if (plain(spec.fields) && Object.hasOwn(spec.fields, field)) error[field] = value(spec.fields[field], env);
  return error;
}

function makeStream(spec, env) {
  const name = spec.name;
  const chunks = (spec.chunks ?? []).map((chunk) => value(chunk, env));
  const failing = Object.hasOwn(spec, 'fail');
  const failure = failing ? value(spec.fail, env) : undefined;
  return (async function* () {
    let state = 'return';
    try {
      for (let index = 0; index < chunks.length; index++) {
        if (spec.wait !== undefined) await env.fns[spec.wait](name, index);
        yield chunks[index];
      }
      if (failing) { state = 'error'; throw failure; }
      state = 'done';
    } catch (cause) { state = 'error'; throw cause; }
    finally { env.global.observers.onDiagnostic?.({ stream: name, closed: state }); }
  })();
}

/** A template's value. */
export function value(template, env) {
  if (Array.isArray(template)) return template.map((item) => value(item, env));
  if (!plain(template)) return template;
  switch (template.$stub) {
    case undefined: return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, value(item, env)]));
    case 'error': return makeError(template, env);
    case 'fn': return () => 'local';
    case 'stream': return makeStream(template, env);
    case 'deep': { let out = value(template.leaf, env); for (let level = 0; level < template.depth; level++) out = [out]; return out; }
    case 'reg': return env.regs[template.name];
    case 'regs': return { ...env.regs };
    case 'fnarg': return env.fns[template.index];
    default: throw new TypeError(`unknown stub value ${template.$stub}`);
  }
}

const classify = (ms) => (Number.isNaN(ms) ? 'nan' : ms === Infinity ? 'infinite' : ms > 0 ? 'positive' : 'zero');
const body = (op, env) => async () => (await run(op.body ?? [], env)).value;
const store = (env, op, result) => { if (op.as !== undefined) env.regs[op.as] = result; };

/** Runs a program: `{ returned, value }`. */
export async function run(program, env) {
  for (const op of program) {
    switch (op.op) {
      case 'return': return { returned: true, value: value(op.value, env) };
      case 'throw': throw value(op.value, env);
      case 'try':
        try { const result = await body(op, env)(); store(env, op, { ok: result }); } catch (cause) { store(env, op, { caught: summarize(cause) }); }
        break;
      case 'call': store(env, op, await env.fns[op.fn](...value(op.args ?? [], env))); break;
      case 'start': {
        const entry = gate(env.global, op.gate);
        env.fns[op.fn](...value(op.args ?? [], env)).then(entry.resolve, entry.reject);
        break;
      }
      case 'await': store(env, op, await gate(env.global, op.gate).promise); break;
      case 'open': gate(env.global, op.gate).resolve(value(op.value, env)); break;
      case 'fail': gate(env.global, op.gate).reject(value(op.value, env)); break;
      case 'emit': {
        const observer = env.global.observers[op.observer];
        const answer = observer ? observer(value(op.payload, env)) : undefined;
        if (op.as !== undefined) store(env, op, answer === undefined ? 'absent' : await answer);
        else answer?.catch?.(() => {});
        break;
      }
      case 'observe': env.global.observers[op.observer]?.(value(op.payload, env)); break;
      case 'phase': store(env, op, await executionPhase(op.name, body(op, env))); break;
      case 'quiet': store(env, op, await quietExecutionPhase(op.name, body(op, env), ...(op.slowMs === undefined ? [] : [op.slowMs]))); break;
      // `plain`: the action returns that value itself, not a promise.
      case 'timed': store(env, op, await timedExecutionStep(op.name, Object.hasOwn(op, 'plain') ? () => value(op.plain, env) : body(op, env))); break;
      case 'step': executionStep(op.name, op.elapsedMs, ...(Object.hasOwn(op, 'count') ? [op.count] : [])); break;
      case 'progress': executionProgress(); break;
      case 'check': checkExecutionAdmission(); break;
      case 'slotWait': store(env, op, await withExecutionSlotWait(body(op, env))); break;
      case 'io': store(env, op, await withExecutionIO(op.root, body(op, env))); break;
      case 'meter': store(env, op, await withExecutionMeter(body(op, env))); break;
      case 'noDeadline': store(env, op, await withoutExecutionDeadline(body(op, env))); break;
      case 'cleanup': store(env, op, await executionCleanup(body(op, env), {
        ...(op.timeoutMs === undefined ? {} : { timeoutMs: op.timeoutMs }), ...(op.capMs === undefined ? {} : { capMs: op.capMs }) })); break;
      case 'queue': store(env, op, await waitForExecutionQueue(gate(env.global, op.gate).promise, op.follow === undefined ? undefined : env.global.meters.get(op.follow))); break;
      case 'nameMeter': env.global.meters.set(op.as, executionProgressMeter()); break;
      case 'diagnostic': executionDiagnostic(value(op.record, env)); break;
      case 'remaining': { const ms = executionRemainingMs(); store(env, op, op.exact ? ms : classify(ms)); break; }
      case 'reporting': store(env, op, executionReporting()); break;
      case 'signal': { const signal = executionSignal(); store(env, op, signal ? (signal.aborted ? 'aborted' : 'live') : 'none'); break; }
      case 'meterState': {
        const meter = executionProgressMeter();
        store(env, op, meter ? { waiters: meter.waiters, following: Boolean(meter.following), ...(op.exact ? { progress: meter.progress - env.global.epoch } : {}) } : null);
        break;
      }
      case 'background': { const started = body(op, env)(); if (!op.unhandled) started.catch(() => {}); break; }
      case 'unhandled': Promise.reject(value(op.value, env)); break;
      case 'block': { const until = Date.now() + op.ms; while (Date.now() < until) { /* The event loop is blocked. */ } break; }
      case 'sleep': await new Promise((resolve) => setTimeout(resolve, op.ms)); break;
      case 'log': env.global.events?.push({ t: Date.now() - env.global.epoch, task: env.task, log: value(op.value, env) }); break;
      default: throw new TypeError(`unknown stub op ${op.op}`);
    }
  }
  return { returned: false, value: undefined };
}

/** The stub methods, beside the product's: `stubRun({ program, fns })` and `stubEcho(...args)`. */
export function stubMethods(global) {
  return {
    stubRun: async (spec) => (await run(spec?.program ?? [], { fns: spec?.fns ?? [], regs: {}, global, task: undefined })).value,
    stubEcho: (...args) => args,
  };
}
