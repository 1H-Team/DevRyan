// The TypeScript engine of the client engine conformance harness (package
// C0d): the protocol of engine.mjs, implemented by the product's own modules,
// run by Bun (the UI's test runner) under the test isolation guard. The main
// thread reads requests from stdin and writes responses to stdout; each unit
// is a Worker of its own, so a unit's module graph, and every module-level
// Map, counter or memo in it, starts fresh and dies with the unit.
//
// In a unit's worker, before the family's module loads:
// - a Bun loader plugin replaces each port module of the family with a module
//   that re-exports the real one but answers the listed exports from the
//   recording (`export *` of the real file, loaded under another specifier,
//   plus a local export per port, which wins), and loads a planted copy's
//   source in place of a module the request names (never writing a file);
// - the clock (`Date.now`, `new Date()`, `Date()`, `performance.now`) and the
//   random sources (`Math.random`, `crypto.randomUUID`,
//   `crypto.getRandomValues`) answer from the step's recorded effects, in
//   order; the four timer functions record `timer.set` and `timer.clear`
//   effects and never run a callback (no family this engine replays sets a
//   timer); `fetch`, `WebSocket` and `EventSource` are ports with no recorded
//   answer, so their use halts the case;
// - `setImmediate` and `queueMicrotask` keep the case that scheduled each job
//   (its origin): an error a job throws is caught and charged to that case
//   (its `outside`), never to the unit, and `end` waits (bounded) for the
//   jobs a case scheduled before it answers. Any other uncaught error is
//   charged to the case open when it is thrown, or, between cases, to the case
//   before (`between`). The unit's worker survives either.
// Only the harness's own code here uses the intrinsics it captured before.
import { readFileSync } from 'node:fs';
import { createCodecContext, decode, emitSlots, snapshot } from './codec.mjs';
import { expandStrings, PROTOCOL, protocolLine, shareStrings } from './engine.mjs';

const RealDate = Date;
const RealProxy = Proxy;
const RealPromise = Promise;
const RealMap = Map;
const RealSet = Set;
const RealWeakMap = WeakMap;
const RealUint8Array = Uint8Array;
const RealError = Error;
const RealSymbol = Symbol;
const realSetImmediate = setImmediate;
const realClearImmediate = clearImmediate;
const realQueueMicrotask = queueMicrotask;
const { apply, construct, ownKeys, get: reflectGet, getOwnPropertyDescriptor } = Reflect;
const { defineProperty, getPrototypeOf, create, keys: objectKeys } = Object;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isArray = Array.isArray;
const MapKeys = Map.prototype.keys;
const MapGet = Map.prototype.get;
const MapSet = Map.prototype.set;
const MapClear = Map.prototype.clear;
const MapEntries = Map.prototype.entries;
const SetValues = Set.prototype.values;
const SetAdd = Set.prototype.add;
const SetClear = Set.prototype.clear;
const MapProto = Map.prototype;
const SetProto = Set.prototype;
const isPrototypeOf = Object.prototype.isPrototypeOf;
const TypedArrayProto = getPrototypeOf(RealUint8Array.prototype);
const typedBuffer = getOwnPropertyDescriptor(TypedArrayProto, 'buffer').get;
const typedOffset = getOwnPropertyDescriptor(TypedArrayProto, 'byteOffset').get;
const typedLength = getOwnPropertyDescriptor(TypedArrayProto, 'byteLength').get;
const JSONStringify = JSON.stringify;

const HOOK = Symbol.for('devryan.client-conformance.replay-hook');
const REAL_QUERY = 'devryan-replay-real';
// The clock that code running outside any step reads (module load): the recorder's nominal epoch.
const OUTSIDE_NOW = 1700000000000;
const OUTSIDE_PERFORMANCE = 1000;
// Quiescence: rounds of the event loop (a macrotask, after every microtask) with no engine activity.
const QUIET_ROUNDS = 2;
const MAX_ROUNDS = 10000;

if (Bun.isMainThread) await mainThread();
else workerThread();

// ------------------------------------------------------------------ main thread

async function mainThread() {
  const units = new RealMap(); // unit -> { worker, pending: Set(id), lost }
  const write = (message) => { process.stdout.write(`${protocolLine(message)}\n`); };
  const lose = (unit, entry, error) => {
    entry.lost = error;
    for (const id of entry.pending) write({ id, ok: false, lost: true, error });
    entry.pending.clear();
  };
  for await (const line of console) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch (error) { write({ id: null, ok: false, error: `not JSON: ${error.message}` }); continue; }
    const { id, op, unit } = message;
    if (op === 'hello') { write({ id, ok: true, engine: 'typescript', protocol: PROTOCOL, bun: Bun.version }); continue; }
    if (op === 'stop') {
      for (const [, entry] of units) entry.worker.terminate();
      write({ id, ok: true });
      process.exit(0);
    }
    if (op === 'open') {
      if (units.has(unit)) { write({ id, ok: false, error: `unit ${unit} is already open` }); continue; }
      const worker = new Worker(import.meta.url);
      const entry = { worker, pending: new RealSet([id]), lost: null };
      units.set(unit, entry);
      worker.onmessage = (event) => {
        const answer = event.data;
        entry.pending.delete(answer.id);
        write(answer);
      };
      worker.onerror = (event) => { lose(unit, entry, `the unit's worker failed: ${event?.message ?? String(event)}`); event?.preventDefault?.(); };
      worker.postMessage(message);
      continue;
    }
    const entry = units.get(unit);
    if (!entry) { write({ id, ok: false, error: `unit ${unit} is not open` }); continue; }
    if (op === 'close' && message.force) {
      // The unit did not answer in time (a hung step): stopped at once, not behind its own queue.
      entry.worker.terminate();
      units.delete(unit);
      for (const pendingId of entry.pending) write({ id: pendingId, ok: false, lost: true, error: 'the unit was stopped' });
      write({ id, ok: true, between: [] });
      continue;
    }
    if (entry.lost) { write({ id, ok: false, lost: true, error: entry.lost }); continue; }
    entry.pending.add(id);
    if (op === 'close') {
      const { worker } = entry;
      const previous = worker.onmessage;
      worker.onmessage = (event) => { previous(event); if (event.data.id === id) { worker.terminate(); units.delete(unit); } };
    }
    entry.worker.postMessage(message);
  }
  // The replayer is gone (its end of stdin closed, by a stop or because it was interrupted): nothing is left to answer.
  for (const [, entry] of units) entry.worker.terminate();
  process.exit(0);
}

// ------------------------------------------------------------------ worker

function workerThread() {
  const unit = { open: false, family: null, namespace: null, entries: new RealMap(), between: [], portObjects: [], cases: 0 };
  let kase = null; // the open case
  let current = null; // the step whose input is being delivered or quiesced
  let activity = 0;
  let jobOrigin = null; // the case whose job (setImmediate, queueMicrotask) is running

  class ReplayHalt extends RealError {}
  defineProperty(ReplayHalt.prototype, 'name', { value: 'ReplayHalt', configurable: true, writable: true });

  const halt = (check, detail) => {
    if (kase && !kase.halt) kase.halt = { step: current ? current.n : null, check, detail };
    throw new ReplayHalt(`${check}: ${detail}`);
  };
  // What happens while no step is open is the case's whose job it is, else the open case's, else the unit's (between cases).
  const noteOutside = (what) => {
    const owner = jobOrigin ?? kase;
    if (owner && !owner.ended) owner.outside.push({ what }); else unit.between.push({ what });
  };
  const describeError = (error) => {
    const name = error !== null && typeof error === 'object' ? String(error.name ?? error.constructor?.name ?? 'Error') : typeof error;
    return `${name}: ${String(error?.message ?? error)}`;
  };
  // An error thrown into a job or out of the event loop: a halt is the case's already; anything else is noted where it belongs.
  const uncaught = (error, owner = jobOrigin ?? kase) => {
    if (error instanceof ReplayHalt) return;
    const entry = { what: `uncaught ${describeError(error)}` };
    if (owner && !owner.ended) owner.outside.push(entry); else unit.between.push(entry);
  };
  // A value taken now, written when its case ends (one identity scope per case, as the recorder's).
  class Taken { constructor(taken) { this.taken = taken; } }
  const snap = (value) => new Taken(snapshot(value, kase.codec));

  // ------------------------------------------------------------- the env
  const describeItem = (item) => (item ? `${item.kind} ${item.kind === 'port' ? item.port : item.source}` : 'nothing');
  function take(kind, name) {
    const step = current;
    const items = step.env;
    const matches = (item) => item.kind === kind && (kind === 'port' ? item.port === name : item.source === name);
    const unordered = kind === 'port' && unit.unordered.has(name);
    if (unordered) {
      const index = items.findIndex((item, at) => at >= step.envNext && !step.used.has(at) && matches(item));
      if (index >= 0) { step.used.add(index); return items[index]; }
    }
    while (step.used.has(step.envNext)) step.envNext += 1;
    const next = items[step.envNext];
    if (next && matches(next)) { step.envNext += 1; return next; }
    const later = items.some((item, at) => at > step.envNext && !step.used.has(at) && matches(item));
    return halt(later ? 'effect-order' : 'unanswered', `${kind} ${name}${later ? ' was asked before its turn' : ' has no recorded answer'}; the recording's next effect is ${describeItem(next)}`);
  }
  function effect(record) {
    activity += 1;
    if (!current) { noteOutside(record.kind); return null; }
    current.effects.push(record);
    return record;
  }

  // ------------------------------------------------------------- binding
  function atPath(root, path) {
    let value = root;
    for (const part of path) {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
      if (typeof part === 'string' || typeof part === 'number') {
        const descriptor = getOwnPropertyDescriptor(value, String(part));
        if (!descriptor || !hasOwn(descriptor, 'value')) return undefined;
        value = descriptor.value;
      } else if (hasOwn(part, 'map')) {
        if (!apply(isPrototypeOf, MapProto, [value])) return undefined;
        const entries = [...apply(MapEntries, value, [])];
        if (part.map >= entries.length) return undefined;
        value = entries[part.map][part.part];
      } else if (hasOwn(part, 'set')) {
        if (!apply(isPrototypeOf, SetProto, [value])) return undefined;
        const values = [...apply(SetValues, value, [])];
        if (part.set >= values.length) return undefined;
        value = values[part.set];
      } else if (hasOwn(part, 'own')) {
        const descriptor = getOwnPropertyDescriptor(value, part.own);
        if (!descriptor || !hasOwn(descriptor, 'value')) return undefined;
        value = descriptor.value;
      } else return undefined;
    }
    return value;
  }
  function bindSlot(slot, live) {
    for (const request of current.bind) {
      if (request.slot !== slot) continue;
      const found = atPath(live, request.path);
      if (found === null || (typeof found !== 'object' && typeof found !== 'function')) { kase.bindFailures.push({ step: current.n, slot, path: request.path, n: request.n }); continue; }
      if (!kase.bound.has(request.n)) kase.bound.set(request.n, found);
    }
  }

  // ------------------------------------------------------------- rebuilding inputs
  const stubs = new RealWeakMap(); // stub function -> { name, port }
  function functionStub(name, port) {
    const info = { name, port };
    const stub = { [name]: function (...args) {
      if (info.port === null) return halt('unanswered', `the engine called a function the test handed it (${name || 'anonymous'}) that no port declares, so the recording has no answer`);
      return callPort(info.port, args);
    } }[name];
    if (stub.name !== name) defineProperty(stub, 'name', { value: name, configurable: true });
    stubs.set(stub, info);
    if (port !== null && port !== undefined) kase.codec.names.set(stub, port);
    return stub;
  }
  class RebuildError extends RealError {}
  function rebuild(tree) {
    const local = new RealMap();
    const define = (target, key, value) => defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    const accessorOn = (target, key, node) => {
      const descriptor = { enumerable: true, configurable: true };
      if (node.get) descriptor.get = () => halt('unanswered', `the engine read a recorded accessor (${String(key)})`);
      if (node.set) descriptor.set = () => {};
      defineProperty(target, key, descriptor);
    };
    const isTagged = (node, tag) => node !== null && typeof node === 'object' && !isArray(node) && node.$dr === tag;
    const symbolOf = (node) => {
      if (node.wellKnown !== undefined || node.key !== undefined) return decode(node);
      let symbol = kase.symbols.get(node.n);
      if (!symbol) { symbol = hasOwn(node, 'description') ? RealSymbol(node.description) : RealSymbol(); kase.symbols.set(node.n, symbol); }
      return symbol;
    };
    // A fresh container of the node's kind with nothing in it, or a complete value for kinds that hold no identity.
    const shellOf = (node) => {
      if (isArray(node)) return { value: [] };
      if (node === null || typeof node !== 'object') return { value: node, complete: true };
      if (!hasOwn(node, '$dr')) return { value: {} };
      switch (node.$dr) {
        case 'escape': return { value: {} };
        case 'nullproto': return { value: create(null) };
        case 'symkeys': return shellOf(node.value);
        case 'array': return { value: hasOwn(node, 'className') ? decode({ $dr: 'array', items: [], className: node.className }) : [] };
        case 'map': return { value: hasOwn(node, 'className') ? decode({ $dr: 'map', entries: [], className: node.className }) : new RealMap() };
        case 'set': return { value: hasOwn(node, 'className') ? decode({ $dr: 'set', values: [], className: node.className }) : new RealSet() };
        case 'class': {
          const shell = { $dr: 'class', name: node.name };
          if (node.error) shell.error = node.error;
          if (hasOwn(node, 'primitive')) shell.primitive = node.primitive;
          shell.value = {};
          return { value: decode(shell) };
        }
        case 'function': return { value: functionStub(node.name, hasOwn(node, 'port') ? node.port : null), complete: true };
        case 'symbol': return { value: symbolOf(node), complete: true };
        case 'id': case 'ref': throw new RebuildError('an id or ref where a value was expected');
        default: return { value: decode(node), complete: true };
      }
    };
    const fillMembers = (target, members) => {
      for (const key of objectKeys(members)) {
        const child = members[key];
        if (isTagged(child, 'accessor')) accessorOn(target, key, child); else define(target, key, visit(child));
      }
    };
    const arrayItems = (items) => {
      const out = [];
      let index = 0;
      for (const item of items) {
        if (isTagged(item, 'hole')) { index += item.n; continue; }
        out.push([index, item]);
        index += 1;
      }
      return { entries: out, length: index };
    };
    const fillArray = (target, items) => {
      const { entries, length } = arrayItems(items);
      for (const [index, item] of entries) {
        if (isTagged(item, 'accessor')) accessorOn(target, String(index), item); else define(target, String(index), visit(item));
      }
      target.length = length;
    };
    const fill = (target, node) => {
      if (isArray(node)) { fillArray(target, node); return; }
      if (!hasOwn(node, '$dr')) { fillMembers(target, node); return; }
      switch (node.$dr) {
        case 'escape': case 'nullproto': fillMembers(target, node.value); return;
        case 'symkeys': fill(target, node.value); for (const [key, value] of node.symbols) define(target, visit(key), visit(value)); return;
        case 'array': fillArray(target, node.items); if (node.props) fillMembers(target, node.props); return;
        case 'map': for (const [key, value] of node.entries) apply(MapSet, target, [visit(key), visit(value)]); return;
        case 'set': for (const value of node.values) apply(SetAdd, target, [visit(value)]); return;
        case 'class':
          fillMembers(target, node.value);
          if (hasOwn(node, 'cause')) defineProperty(target, 'cause', { value: visit(node.cause), writable: true, configurable: true, enumerable: false });
          if (hasOwn(node, 'errors')) defineProperty(target, 'errors', { value: visit(node.errors), writable: true, configurable: true, enumerable: false });
          return;
        default: throw new RebuildError(`cannot fill a ${node.$dr}`);
      }
    };
    // An object the case already holds is brought to the content the tree gives it, in place, so its identity is kept.
    const ownData = (target) => ownKeys(target).filter((key) => typeof key === 'string' && getOwnPropertyDescriptor(target, key)?.enumerable);
    const sameKeys = (left, right) => left.length === right.length && left.every((key, index) => key === right[index]);
    const setMember = (target, key, value) => {
      const descriptor = getOwnPropertyDescriptor(target, key);
      if (descriptor && hasOwn(descriptor, 'value') && Object.is(descriptor.value, value) && descriptor.enumerable) return;
      try { define(target, key, value); } catch (error) { throw new RebuildError(`cannot bring ${String(key)} to its recorded value: ${error.message}`); }
    };
    const reconcileMembers = (target, members) => {
      const keys = objectKeys(members);
      const values = keys.map((key) => (isTagged(members[key], 'accessor') ? members[key] : visit(members[key])));
      const now = ownData(target);
      if (!sameKeys(now, keys)) {
        for (const key of now) if (!delete target[key]) throw new RebuildError(`cannot remove ${key} from an object the test changed`);
      }
      keys.forEach((key, index) => { if (isTagged(values[index], 'accessor')) accessorOn(target, key, values[index]); else setMember(target, key, values[index]); });
    };
    const reconcileArray = (target, items) => {
      const { entries, length } = arrayItems(items);
      const values = entries.map(([index, item]) => [index, visit(item)]);
      const present = ownData(target).filter((key) => /^(?:0|[1-9]\d*)$/.test(key));
      const same = target.length === length && present.length === values.length && values.every(([index], at) => present[at] === String(index));
      if (!same) target.length = 0;
      for (const [index, value] of values) setMember(target, String(index), value);
      target.length = length;
    };
    const reconcile = (target, node) => {
      if (isArray(node)) { reconcileArray(target, node); return; }
      if (node === null || typeof node !== 'object') return;
      if (!hasOwn(node, '$dr')) { reconcileMembers(target, node); return; }
      switch (node.$dr) {
        case 'escape': case 'nullproto': reconcileMembers(target, node.value); return;
        case 'symkeys': reconcile(target, node.value); for (const [key, value] of node.symbols) setMember(target, visit(key), visit(value)); return;
        case 'array': reconcileArray(target, node.items); if (node.props) reconcileMembers(target, node.props); return;
        case 'class': reconcileMembers(target, node.value); return;
        case 'map': {
          const wanted = node.entries.map(([key, value]) => [visit(key), visit(value)]);
          const now = [...apply(MapKeys, target, [])];
          if (now.length === wanted.length && wanted.every(([key], index) => Object.is(now[index], key))) {
            for (const [key, value] of wanted) if (!Object.is(apply(MapGet, target, [key]), value)) apply(MapSet, target, [key, value]);
          } else { apply(MapClear, target, []); for (const [key, value] of wanted) apply(MapSet, target, [key, value]); }
          return;
        }
        case 'set': {
          const wanted = node.values.map(visit);
          const now = [...apply(SetValues, target, [])];
          if (!(now.length === wanted.length && wanted.every((value, index) => Object.is(now[index], value)))) { apply(SetClear, target, []); for (const value of wanted) apply(SetAdd, target, [value]); }
          return;
        }
        default: // a function, a port or a platform value keeps what it is
      }
    };
    const visit = (node) => {
      if (node === null || typeof node !== 'object') return node;
      if (isArray(node)) { const made = []; fillArray(made, node); return made; }
      if (!hasOwn(node, '$dr')) { const made = {}; fillMembers(made, node); return made; }
      if (node.$dr === 'id') {
        const known = kase.bound.get(node.n);
        if (known !== undefined) { local.set(node.n, known); reconcile(known, node.value); return known; }
        const shell = shellOf(node.value);
        kase.bound.set(node.n, shell.value);
        local.set(node.n, shell.value);
        if (!shell.complete) fill(shell.value, node.value);
        return shell.value;
      }
      if (node.$dr === 'ref') {
        if (local.has(node.n)) return local.get(node.n);
        throw new RebuildError(`ref ${node.n} before its id`);
      }
      const shell = shellOf(node);
      if (!shell.complete) fill(shell.value, node);
      return shell.value;
    };
    return visit(tree);
  }

  // ------------------------------------------------------------- ports and platform sources
  function callPort(name, args) {
    if (!current || !kase) { noteOutside(`port ${name}`); throw new ReplayHalt(`port ${name} used while no step is open`); }
    if (kase.halt) throw new ReplayHalt('the case has halted');
    kase.portCalls += 1;
    const list = [];
    for (let index = 0; index < args.length; index += 1) list[index] = args[index];
    const record = effect({ kind: 'port', port: name, call: kase.portCalls, args: snap(list) });
    bindSlot(`effects.${current.effects.length - 1}.args`, list);
    const item = take('port', name);
    if (hasOwn(item, 'throws')) {
      const error = rebuild(item.throws);
      record.throws = snap(error);
      throw error;
    }
    const answer = rebuild(item.answer);
    record.answer = snap(answer);
    return answer;
  }
  const valueOf = (tree) => decode(tree);
  function readClock(source) {
    // A clock read while no step is open is answered with the recorder's nominal epoch, and noted where it belongs.
    if (!current || !kase) { noteOutside(`clock ${source}`); activity += 1; return source === 'performance.now' ? OUTSIDE_PERFORMANCE : OUTSIDE_NOW; }
    if (kase.halt) throw new ReplayHalt('the case has halted');
    const item = take('clock', source);
    const value = valueOf(item.value);
    effect({ kind: 'clock', source, value: snap(value) });
    return value;
  }
  function draw(source, check) {
    if (!current || !kase) { noteOutside(`draw ${source}`); throw new ReplayHalt(`draw ${source} while no step is open`); }
    if (kase.halt) throw new ReplayHalt('the case has halted');
    const item = take('draw', source);
    const value = valueOf(item.value);
    if (check) check(value);
    effect({ kind: 'draw', source, value: snap(value) });
    return value;
  }

  function installPlatform() {
    const nowFunction = function now() { return readClock('Date.now'); };
    const ReplayDate = new RealProxy(RealDate, {
      construct(target, args, newTarget) {
        const made = newTarget === ReplayDate ? target : newTarget;
        if (args.length === 0) return construct(target, [readClock('new Date')], made);
        return construct(target, args, made);
      },
      apply() { return new RealDate(readClock('Date()')).toString(); },
      get(target, key, receiver) { return key === 'now' ? nowFunction : reflectGet(target, key, receiver); },
    });
    defineProperty(globalThis, 'Date', { value: ReplayDate, writable: true, configurable: true, enumerable: false });
    defineProperty(performance, 'now', { value: function now() { return readClock('performance.now'); }, writable: true, configurable: true });
    defineProperty(Math, 'random', { value: function random() { return draw('Math.random'); }, writable: true, configurable: true });
    defineProperty(crypto, 'randomUUID', { value: function randomUUID() { return draw('crypto.randomUUID'); }, writable: true, configurable: true });
    defineProperty(crypto, 'getRandomValues', { value: function getRandomValues(array) {
      if (!apply(isPrototypeOf, TypedArrayProto, [array])) throw new TypeError('getRandomValues expects an integer typed array');
      const view = new RealUint8Array(apply(typedBuffer, array, []), apply(typedOffset, array, []), apply(typedLength, array, []));
      const bytes = draw('crypto.getRandomValues', (value) => {
        if (!apply(isPrototypeOf, TypedArrayProto, [value]) || value.length !== view.length) halt('unanswered', `crypto.getRandomValues asked for ${view.length} bytes; the recording drew ${value?.length ?? 'no'} bytes`);
      });
      view.set(bytes);
      return array;
    }, writable: true, configurable: true });
    let timers = 0;
    const setTimer = (repeat) => function setTimer(callback, delay) {
      timers += 1;
      if (current) effect({ kind: 'timer.set', id: timers, delay: snap(delay), repeat }); else noteOutside('timer.set');
      return timers;
    };
    const clearTimer = function clearTimer(id) { if (current) effect({ kind: 'timer.clear', id: typeof id === 'number' ? id : null }); else noteOutside('timer.clear'); };
    for (const [name, value] of [['setTimeout', setTimer(false)], ['setInterval', setTimer(true)], ['clearTimeout', clearTimer], ['clearInterval', clearTimer],
      ['fetch', function fetch(...args) { return callPort('fetch', args); }],
      ['WebSocket', function WebSocket() { return halt('unanswered', 'the engine opened a WebSocket, which the recording does not answer'); }],
      ['EventSource', function EventSource() { return halt('unanswered', 'the engine opened an EventSource, which the recording does not answer'); }]]) {
      defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
    }
    // A rejection the engine leaves unhandled (a halt thrown into one of its promise jobs, say) must not end the
    // unit: it is noted where it belongs (the case's `outside`, so the case differs; replay-compare.mjs `outside`).
    process.on('unhandledRejection', (reason) => { noteOutside(`unhandled rejection: ${String(reason?.message ?? reason)}`); });
    // An error a job or a callback of the platform throws: charged to its case, and the unit's worker lives on.
    process.on('uncaughtException', (error) => { uncaught(error); });
    // Jobs keep the case that scheduled them, so an error one throws is that case's and `end` can wait for them.
    const jobs = new RealMap(); // immediate handle -> its origin case
    const wrapJob = (run) => {
      const origin = jobOrigin ?? kase;
      if (origin) origin.jobs += 1;
      let done = false;
      const finish = () => { if (!done) { done = true; if (origin) origin.jobs -= 1; } };
      return {
        cancel: finish,
        run: () => {
          finish();
          const before = jobOrigin;
          jobOrigin = origin && !origin.ended ? origin : null;
          try { run(); } catch (error) { uncaught(error, origin); } finally { jobOrigin = before; }
        },
      };
    };
    defineProperty(globalThis, 'setImmediate', { value: function setImmediate(callback, ...args) {
      if (typeof callback !== 'function') return realSetImmediate(callback, ...args);
      const job = wrapJob(() => apply(callback, undefined, args));
      const handle = realSetImmediate(() => { jobs.delete(handle); job.run(); });
      jobs.set(handle, job);
      return handle;
    }, writable: true, configurable: true, enumerable: false });
    defineProperty(globalThis, 'clearImmediate', { value: function clearImmediate(handle) {
      const job = jobs.get(handle);
      if (job) { jobs.delete(handle); job.cancel(); }
      return realClearImmediate(handle);
    }, writable: true, configurable: true, enumerable: false });
    defineProperty(globalThis, 'queueMicrotask', { value: function queueMicrotask(callback) {
      if (typeof callback !== 'function') return realQueueMicrotask(callback);
      const job = wrapJob(callback);
      return realQueueMicrotask(() => job.run());
    }, writable: true, configurable: true, enumerable: false });
  }

  // ------------------------------------------------------------- the loader
  const loaderOf = (file) => (/\.tsx$/.test(file) ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : /\.jsx$/.test(file) ? 'jsx' : 'js');
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  function installLoader(family, plants) {
    const ports = new RealMap(); // module -> [{ export, name }]
    for (const port of family.ports) { if (!ports.has(port.module)) ports.set(port.module, []); ports.get(port.module).push(port); }
    const planted = new RealMap(plants.map((plant) => [plant.module, plant.source]));
    const files = [...new RealSet([...ports.keys(), ...planted.keys()])];
    if (files.length === 0) return;
    const filter = new RegExp(`^(?:${files.map(escapeRegExp).join('|')})(?:\\?.*)?$`);
    const hook = { portExport(name, value) {
      if (typeof value === 'function') return functionStubFor(name, value.name);
      unit.portObjects.push(name);
      return value;
    } };
    globalThis[HOOK] = hook;
    Bun.plugin({
      name: 'devryan-client-conformance-replay',
      setup(build) {
        build.onLoad({ filter }, (args) => {
          const [file, query = ''] = args.path.split('?');
          const source = () => (planted.has(file) ? planted.get(file) : readFileSync(file, 'utf8'));
          if (query.includes(REAL_QUERY) || !ports.has(file)) return { contents: source(), loader: loaderOf(file) };
          const real = JSONStringify(`${file}?${REAL_QUERY}`);
          const lines = [`import * as real from ${real};`, `export * from ${real};`];
          for (const port of ports.get(file)) {
            if (!/^[A-Za-z_$][\w$]*$/.test(port.export)) throw new Error(`port export ${port.export} is not an identifier`);
            lines.push(`export const ${port.export} = globalThis[Symbol.for(${JSONStringify(HOOK.description)})].portExport(${JSONStringify(port.name)}, real.${port.export});`);
          }
          return { contents: lines.join('\n'), loader: 'js' };
        });
      },
    });
  }
  // A module port's stub: one per port, made when its module loads; it answers from the open step.
  const portStubs = new RealMap();
  function functionStubFor(name, functionName) {
    if (!portStubs.has(name)) {
      const stub = { [functionName]: function (...args) { return callPort(name, args); } }[functionName];
      portStubs.set(name, stub);
    }
    return portStubs.get(name);
  }

  // ------------------------------------------------------------- the change set (the recorder's own rule)
  function identityPaths(root) {
    const paths = [];
    const visited = new RealSet();
    const walk = (value, where) => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
      paths.push([where, value]);
      if (visited.has(value) || typeof value === 'function') return;
      visited.add(value);
      if (apply(isPrototypeOf, MapProto, [value])) {
        for (const [key, entry] of apply(MapEntries, value, [])) walk(entry, [...where, { map: key }]);
        return;
      }
      for (const key of ownKeys(value)) {
        if (typeof key !== 'string') continue;
        const descriptor = getOwnPropertyDescriptor(value, key);
        if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) continue;
        walk(descriptor.value, [...where, isArray(value) && /^\d+$/.test(key) ? Number(key) : key]);
      }
    };
    walk(root, []);
    return paths;
  }
  function pathKey(where, keys) {
    return where.map((part) => {
      if (part === null || typeof part !== 'object') return JSONStringify(part);
      let id = keys.get(part.map);
      if (id === undefined) { id = keys.size; keys.set(part.map, id); }
      return `{map:${id}}`;
    }).join('/');
  }
  function changedPaths(before, root) {
    const keys = new RealMap();
    const known = new RealMap();
    for (const [where, value] of before) known.set(pathKey(where, keys), value);
    return identityPaths(root).filter(([where, value]) => known.get(pathKey(where, keys)) !== value).map(([where]) => where);
  }

  // ------------------------------------------------------------- requests
  const isPromise = (value) => value !== null && typeof value === 'object' && apply(isPrototypeOf, RealPromise.prototype, [value]);
  async function quiesce() {
    let quiet = 0;
    let rounds = 0;
    while (quiet < QUIET_ROUNDS && rounds < MAX_ROUNDS) {
      const before = activity;
      await new RealPromise((resolve) => { realSetImmediate(resolve); });
      rounds += 1;
      quiet = activity === before ? quiet + 1 : 0;
    }
    return rounds < MAX_ROUNDS;
  }

  async function open(message) {
    const { family, plants = [] } = message;
    unit.family = family;
    unit.unordered = new RealSet(family.unordered ?? []);
    installPlatform();
    installLoader(family, plants);
    const namespace = await import(family.module);
    unit.namespace = namespace;
    for (const name of objectKeys(namespace)) if (typeof namespace[name] === 'function') unit.entries.set(name, (family.entries ?? []).find((entry) => entry.export === name) ?? { export: name });
    unit.open = true;
    // What module load did (a clock read, say) is reported, not charged to a case: no case was open (replay-compare.mjs NOT_COMPARED).
    return { exports: [...unit.entries.keys()], portObjects: unit.portObjects, load: takeBetween() };
  }

  // What the unit noted while no case was open since the previous case ended (charged to that case by the replayer).
  const takeBetween = () => unit.between.splice(0);
  function openCase() {
    if (kase) throw new Error('a case is open: end it first');
    unit.cases += 1;
    kase = { ordinal: unit.cases, codec: createCodecContext(), bound: new RealMap(), symbols: new RealMap(), steps: [], portCalls: 0, halt: null, outside: [], bindFailures: [], strings: [], jobs: 0, ended: false };
    return { between: takeBetween() };
  }

  async function step(message) {
    if (!kase) throw new Error('no case is open');
    // The engine numbers the steps of a case itself: the replayer sends them in order and names none.
    const n = kase.steps.length + 1;
    for (const text of message.step.strings ?? []) kase.strings.push(text);
    const input = { ...message.step.input, args: expandStrings(message.step.input.args, kase.strings) };
    const env = expandStrings(message.step.env ?? [], kase.strings);
    const bind = message.step.bind ?? [];
    if (kase.halt) return { halted: kase.halt, skipped: true };
    const record = { n, input: { kind: input.kind, entry: input.entry, now: input.now }, effects: [], env, envNext: 0, used: new RealSet(), bind, slots: {} };
    kase.steps.push(record);
    const spec = unit.entries.get(input.entry);
    if (input.kind !== 'call' || !spec) {
      kase.halt = { step: n, check: 'unplaced', detail: `${input.kind} ${input.entry} is no call of an entry of ${unit.family.name}` };
      return { halted: kase.halt };
    }
    current = record;
    let args;
    try {
      args = rebuild(input.args);
      if (!isArray(args)) throw new RebuildError('the arguments are not a list');
      for (const item of unit.family.injected ?? []) {
        if (item.entry !== input.entry) continue;
        const holder = item.key === undefined ? null : args[item.arg];
        const value = item.key === undefined ? args[item.arg] : holder !== null && typeof holder === 'object' ? getOwnPropertyDescriptor(holder, item.key)?.value : undefined;
        const info = typeof value === 'function' ? stubs.get(value) : undefined;
        if (info) { info.port = item.name; kase.codec.names.delete(value); }
      }
    } catch (error) {
      current = null;
      kase.halt = { step: n, check: 'rebuild', detail: String(error?.message ?? error) };
      return { halted: kase.halt };
    }
    record.slots.args = snap(args);
    const draft = spec.draft;
    const before = draft !== undefined ? identityPaths(args[draft]) : null;
    const entry = unit.namespace[input.entry];
    let result;
    let threw = false;
    try { result = apply(entry, undefined, args); } catch (error) { threw = true; result = error; }
    const list = [];
    for (let index = 0; index < args.length; index += 1) list[index] = args[index];
    if (threw) { record.slots.throws = snap(result); bindSlot('throws', result); } else { record.slots.returns = snap(result); bindSlot('returns', result); }
    record.slots.after = snap(list);
    bindSlot('after', list);
    if (before) {
      const changes = changedPaths(before, args[draft]);
      record.slots.changes = snap(changes);
      bindSlot('changes', changes);
    }
    if (!threw && isPromise(result)) {
      const settled = record;
      apply(RealPromise.prototype.then, result, [
        (value) => { activity += 1; if (current === settled) settled.effects.push({ kind: 'settled', step: n, outcome: 'fulfilled', value: snap(value) }); else noteOutside('settled'); },
        (reason) => { activity += 1; if (current === settled) settled.effects.push({ kind: 'settled', step: n, outcome: 'rejected', value: snap(reason) }); else noteOutside('settled'); },
      ]);
    }
    const quiet = await quiesce();
    current = null;
    if (!quiet) kase.halt ??= { step: n, check: 'quiescence', detail: `the step was still running after ${MAX_ROUNDS} rounds of the event loop` };
    return { halted: kase.halt };
  }

  // The jobs a case scheduled (setImmediate, queueMicrotask) run before it ends: what they do or throw is the case's.
  async function settleJobs(owner) {
    let rounds = 0;
    while (owner.jobs > 0 && rounds < MAX_ROUNDS) {
      await new RealPromise((resolve) => { realSetImmediate(resolve); });
      rounds += 1;
    }
    if (owner.jobs > 0) owner.outside.push({ what: `${owner.jobs} jobs the case scheduled were still pending after ${MAX_ROUNDS} rounds of the event loop` });
  }

  async function endCase() {
    if (!kase) throw new Error('no case is open');
    await settleJobs(kase);
    const slots = [];
    const put = (value) => { slots.push(value.taken); return slots.length - 1; };
    const shapes = kase.steps.map((record) => {
      const shape = { n: record.n, input: { kind: record.input.kind, entry: record.input.entry, args: record.slots.args === undefined ? undefined : put(record.slots.args), now: record.input.now } };
      shape.effects = record.effects.map((item) => {
        const out = {};
        for (const key of objectKeys(item)) out[key] = item[key] instanceof Taken ? { slot: put(item[key]) } : item[key];
        return out;
      });
      for (const key of ['returns', 'throws', 'after', 'changes']) if (record.slots[key] !== undefined) shape[key] = put(record.slots[key]);
      return shape;
    });
    const trees = emitSlots(slots);
    const tree = (index) => (index === undefined ? undefined : trees[index]);
    const steps = shapes.map((shape) => {
      const out = { n: shape.n, input: { kind: shape.input.kind, entry: shape.input.entry } };
      if (shape.input.args !== undefined) out.input.args = tree(shape.input.args);
      out.input.now = shape.input.now;
      out.effects = shape.effects.map((item) => {
        const effectOut = {};
        for (const key of objectKeys(item)) effectOut[key] = item[key] !== null && typeof item[key] === 'object' && !isArray(item[key]) && objectKeys(item[key]).length === 1 && hasOwn(item[key], 'slot') ? tree(item[key].slot) : item[key];
        return effectOut;
      });
      for (const key of ['returns', 'throws', 'after', 'changes']) if (shape[key] !== undefined) out[key] = tree(shape[key]);
      return out;
    });
    // Long strings are sent once each (a streamed text grows step by step and every step's arguments and
    // results hold it): `{"$dr":"slice","s":k}` stands for strings[k] (engine.mjs).
    const strings = [];
    const replayed = { steps: shareStrings(steps, strings), strings, halt: kase.halt, outside: kase.outside, bindFailures: kase.bindFailures, flags: [...kase.codec.flags] };
    kase.ended = true;
    kase = null;
    return { replayed };
  }

  const handlers = { open, case: openCase, step, end: endCase, close: () => ({ between: takeBetween() }) };
  let queue = RealPromise.resolve();
  self.onmessage = (event) => {
    const message = event.data;
    queue = queue.then(async () => {
      try {
        const handler = handlers[message.op];
        if (!handler) throw new Error(`unknown request ${message.op}`);
        const answer = await handler(message);
        postMessage({ id: message.id, ok: true, ...answer });
      } catch (error) {
        postMessage({ id: message.id, ok: false, error: String(error?.stack ?? error) });
      }
    });
  };
}
