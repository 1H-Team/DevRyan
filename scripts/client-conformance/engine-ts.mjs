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
/** The globals whose reads by engine code are recorded inputs (recorder.mjs READ_GLOBALS). */
const GLOBAL_READS = Object.freeze(['fetch', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'document', 'window', 'navigator']);
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
  // Port names outlive a case (a port the module keeps in its state is still that port in the next case), as the recorder's do.
  const unit = { open: false, family: null, namespace: null, entries: new RealMap(), between: [], portObjects: [], cases: 0, names: new RealWeakMap(), portFunctions: new RealMap(), portStubs: new RealMap() };
  let kase = null; // the open case
  let current = null; // the step whose input is being delivered or quiesced
  let activity = 0;
  let jobOrigin = null; // the case whose job (setImmediate, queueMicrotask) is running
  const timerHandles = new RealWeakMap(); // a Timeout handle -> { owner case, id }
  const engineWrapped = new RealWeakMap(); // a wrapper the engine made around a test's object (an injected port in it) -> the object

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
  const describeItem = (item) => (item ? `${item.kind} ${item.kind === 'port' || item.kind === 'new' || item.kind === 'read' ? item.port : item.source}${item.kind === 'read' ? `.${String(item.key)}` : ''}` : 'nothing');
  function take(kind, name, key) {
    const step = current;
    const items = step.env;
    const matches = (item) => item.kind === kind && (kind === 'port' || kind === 'new' ? item.port === name : kind === 'read' ? item.port === name && item.key === key : item.source === name);
    const unordered = (kind === 'port' || kind === 'new') && unit.unordered.has(name);
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
  function bindSlot(slot, live, bind = current.bind, at = current?.n ?? null) {
    for (const request of bind) {
      if (request.slot !== slot) continue;
      const found = atPath(live, request.path);
      if (found === null || (typeof found !== 'object' && typeof found !== 'function')) { kase.bindFailures.push({ step: at, slot, path: request.path, n: request.n, name: request.name }); continue; }
      // A name binds what a step handed the test as engine code (`<entry>#<n>`), which later steps call by that name.
      if (request.name !== undefined) { if (!kase.names.has(request.name)) kase.names.set(request.name, found); continue; }
      if (!kase.bound.has(request.n)) kase.bound.set(request.n, found);
    }
  }

  // ------------------------------------------------------------- rebuilding inputs
  const stubs = new RealWeakMap(); // stub function -> { name, port }
  function functionStub(name, port) {
    // A function the recording names as a port (one a port answered, a global the engine read) is a port function:
    // its members, `new` and calls are the port's (C0f). One with no port is the test's own function.
    if (port !== null && port !== undefined) return portFunctionStub(port, name);
    const info = { name, port };
    const stub = { [name]: function (...args) {
      if (info.port === null) return halt('unanswered', `the engine called a function the test handed it (${name || 'anonymous'}) that no port declares, so the recording has no answer`);
      return callPort(info.port, args, { isNew: new.target !== undefined });
    } }[name];
    if (stub.name !== name) defineProperty(stub, 'name', { value: name, configurable: true });
    stubs.set(stub, info);
    return stub;
  }
  // Whether a port wraps its answers (the recorder's `wrapAnswers`): the port the name derives from is listed so.
  function wrapsAnswers(name) {
    const text = String(name);
    const module = text.startsWith('module:') ? text.indexOf('#') : -1;
    const from = module >= 0 ? module + 1 : 0;
    const cut = text.slice(from).search(/[.#]/);
    const root = cut < 0 ? text : text.slice(0, from + cut);
    return (unit.family.wrapAnswers ?? []).includes(root);
  }
  // Whether the open step's env still holds a call of port `name` (a member the engine is about to call).
  const envHolds = (name) => {
    if (!current) return false;
    for (let at = current.envNext; at < current.env.length; at += 1) {
      if (current.used.has(at)) continue;
      const item = current.env[at];
      if ((item.kind === 'port' || item.kind === 'new') && item.port === name) return true;
    }
    return false;
  };
  const FUNCTION_OWN = new RealSet(['name', 'length', 'prototype', 'call', 'apply', 'bind', 'toString', 'constructor', 'caller', 'arguments']);
  /**
   * A port function (package C0f): a call is a port call, `new` a `new` effect, and a member read is a port function
   * of its own (`<port>.<member>`, as the recorder names a port function's methods) when the step calls it next.
   * One per port name for the unit (a module port's export) or the case (a port's answer, a global).
   */
  function portFunctionStub(port, functionName = '') {
    const cache = unit.open && kase ? kase.portFunctions : unit.portFunctions;
    const known = unit.portFunctions.get(port) ?? cache.get(port);
    if (known) return known;
    const info = { name: functionName, port };
    const base = { [functionName]: function (...args) { return callPort(info.port, args, { isNew: new.target !== undefined }); } }[functionName];
    if (base.name !== functionName) defineProperty(base, 'name', { value: functionName, configurable: true });
    const members = new RealMap();
    const stub = new RealProxy(base, {
      get(target, key, receiver) {
        if (typeof key === 'string' && !FUNCTION_OWN.has(key) && envHolds(`${port}.${key}`)) {
          if (!members.has(key)) members.set(key, portFunctionStub(`${port}.${key}`, key));
          return members.get(key);
        }
        return reflectGet(target, key, receiver);
      },
    });
    stubs.set(stub, info);
    unit.names.set(stub, port);
    cache.set(port, stub);
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
        // A port object the recording names: a module port's is the one the module holds; any other is a stub of its
        // own, whose identity is the recording's (an id node binds it), so two objects of one name stay two (C0f).
        case 'port': return { value: unit.portStubs.get(node.name) ?? portObjectStub(node.name, { fresh: true }), complete: true };
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
  function callPort(name, args, { isNew = false } = {}) {
    // While the module loads no case is open: a port it reads then (the storage principal, a stored cache) answers as
    // the real module does, and the read is noted (reported, not compared: replay-compare.mjs NOT_COMPARED).
    if (!unit.open && portReal.has(name)) { noteOutside(`port ${name} while the module loaded (answered by the module itself)`); return apply(portReal.get(name), undefined, args); }
    if (!current || !kase) { noteOutside(`port ${name}`); throw new ReplayHalt(`port ${name} used while no step is open`); }
    if (kase.halt) throw new ReplayHalt('the case has halted');
    kase.portCalls += 1;
    const list = [];
    for (let index = 0; index < args.length; index += 1) list[index] = args[index];
    const kind = isNew ? 'new' : 'port';
    const record = effect({ kind, port: name, call: kase.portCalls, args: snap(list) });
    bindSlot(`effects.${current.effects.length - 1}.args`, list);
    const item = take(kind, name);
    // What the test did inside this call (a subscriber calling back into the store) is delivered before it answers.
    if (current.nested.length && item.call !== undefined) deliverNested(item.call);
    if (hasOwn(item, 'throws')) {
      const error = rebuild(item.throws);
      record.throws = snap(error);
      throw error;
    }
    // A promise answer settles later, by an input of its own (`settle`, naming this call by its number).
    // The promise may be named (an id node) when the case reaches it again elsewhere: it is bound to that number.
    const promiseNode = (node) => node !== null && typeof node === 'object' && !isArray(node) && node.$dr === 'promise' && objectKeys(node).length === 1;
    const namedPromise = item.answer !== null && typeof item.answer === 'object' && !isArray(item.answer) && item.answer.$dr === 'id' && promiseNode(item.answer.value) ? item.answer.n : null;
    if (promiseNode(item.answer) || namedPromise !== null) {
      let settle = null;
      // The port's own promise, and for a port that wraps its answers the one the module holds a microtask later, as the
      // recorder's (recording 8): the same promises, so the module's continuation comes at the same place in its drain.
      const raw = new RealPromise((resolve, reject) => { settle = { resolve, reject, opens: null }; });
      const promise = wrapsAnswers(name) ? apply(RealPromise.prototype.then, raw, [(value) => value, (reason) => { throw reason; }]) : raw;
      // The engine's own first reaction opens the settle input's step (see deliverSettle), before the module's run.
      const opening = () => { if (settle.opens) { openMember(settle.opens); activity += 1; } };
      apply(RealPromise.prototype.then, promise, [opening, opening]);
      // Keyed by the recording's name of the call (env), which the `settle` input names; else by the engine's own count.
      kase.deferred.set(item.call ?? record.call, settle);
      if (namedPromise !== null && !kase.bound.has(namedPromise)) kase.bound.set(namedPromise, promise);
      // An immediate answer (recording 8, C0f): its settle step came in this group, and it settles as many microtask
      // generations after the call as the recording counted, by a chain of no-op jobs started here, as the recorder's.
      const immediate = kase.immediates.get(item.call ?? record.call);
      if (immediate) {
        kase.immediates.delete(item.call ?? record.call);
        const give = () => {
          // Never before an input the test made before it (a call, a callback) was delivered: then right after it. An
          // answer before it keeps its own place, which its own call's generations give.
          const before = immediate.group?.[immediate.groupIndex - 1];
          if (before && !before.opened && before.given.kind !== 'settle') { before.thenDeliver = immediate; return; }
          if (kase.deferred.get(item.call ?? record.call) === settle) deliverSettle(immediate, immediate.given);
        };
        // Generation 0: the port's promise had settled when the call returned; else it settles inside that marker.
        if (immediate.given.immediate === 0) give();
        else {
          let ticks = 0;
          const tick = () => { ticks += 1; if (ticks < immediate.given.immediate) realQueueMicrotask(tick); else give(); };
          realQueueMicrotask(tick);
        }
      }
      record.answer = snap(promise);
      return promise;
    }
    const answer = rebuild(item.answer);
    record.answer = snap(answer);
    return answer;
  }
  /**
   * A port object the recording answered (a storage a port gave the engine, say): its data reads are answered by
   * the step's next `read` of that member, its methods are port calls `<port>.<member>`. A member the step neither
   * reads nor calls next has no recorded answer.
   */
  function portObjectStub(name, { fresh = false } = {}) {
    // A module port's object (an API client) is the unit's, made when its module loads; any other is the case's.
    const cache = unit.open && kase ? kase.portStubs : unit.portStubs;
    const known = unit.portStubs.get(name) ?? (fresh ? undefined : cache.get(name));
    if (known) return known;
    const methods = new RealMap();
    const stub = new RealProxy({}, {
      get(object, key) {
        // A symbol-keyed method (an async iterator's Symbol.asyncIterator) is a port call `<port>.Symbol(...)`, as the
        // recorder names it, when the step calls it next; any other symbol read is the runtime's own (C0f).
        if (typeof key === 'symbol') {
          const memberName = `${name}.${String(key)}`;
          if (!envHolds(memberName)) return undefined;
          if (!methods.has(key)) methods.set(key, function (...args) { return callPort(memberName, args); });
          return methods.get(key);
        }
        // What the runtime reads on its own (an await's thenable check, conversions) is no read of the module's.
        if (key === 'then') return undefined;
        if (!current || !kase) { noteOutside(`read ${name}.${key}`); return undefined; }
        const items = current.env;
        let found = null;
        for (let at = current.envNext; at < items.length; at += 1) {
          if (current.used.has(at)) continue;
          const item = items[at];
          if ((item.kind === 'read' && item.port === name && item.key === key) || (item.kind === 'port' && item.port === `${name}.${key}`)) { found = item; break; }
        }
        if (found && found.kind === 'port') {
          if (!methods.has(key)) methods.set(key, { [key]: function (...args) { return callPort(`${name}.${key}`, args); } }[key]);
          return methods.get(key);
        }
        const item = take('read', name, key);
        const value = rebuild(item.value);
        effect({ kind: 'read', port: name, key: snap(key), value: snap(value) });
        return value;
      },
      // A write of a member (a socket's onmessage) is an effect; a function written is the engine's own, named where it
      // first shows (bind), so a later callback input calls that very function (C0f).
      set(object, key, value) {
        if (!current || !kase) { noteOutside(`write ${name}.${String(key)}`); return true; }
        effect({ kind: 'set', port: name, key: snap(key), value: snap(value) });
        bindSlot(`effects.${current.effects.length - 1}.value`, value);
        return true;
      },
    });
    unit.names.set(stub, name);
    if (!fresh || !unit.open || !kase) cache.set(name, stub);
    return stub;
  }
  const valueOf = (tree) => decode(tree);
  function readGlobal(name) {
    if (!current || !kase) { noteOutside(`a read of the global ${name}`); return undefined; }
    if (kase.halt) throw new ReplayHalt('the case has halted');
    const item = take('read', 'globalThis', name);
    const value = rebuild(item.value);
    effect({ kind: 'read', port: 'globalThis', key: snap(name), value: snap(value) });
    bindSlot(`effects.${current.effects.length - 1}.value`, value);
    return value;
  }
  function readClock(source) {
    // A clock read while no step is open is answered with the recorder's nominal epoch, and noted where it belongs.
    if (!current || !kase) { noteOutside(`clock ${source}`); activity += 1; return source === 'performance.now' ? OUTSIDE_PERFORMANCE : OUTSIDE_NOW; }
    if (kase.halt) throw new ReplayHalt('the case has halted');
    const item = take('clock', source);
    const value = valueOf(item.value);
    effect({ kind: 'clock', source, value: snap(value) });
    return value;
  }
  // What a module draws while it loads (a port module's client id) is no step's: it gets a fixed stand-in, is noted, and
  // a data port export that holds it is answered from the recording instead (`load.portData`, package C0f).
  const LOAD_DRAWS = { 'Math.random': 0, 'crypto.randomUUID': '00000000-0000-4000-8000-000000000000' };
  function draw(source, check) {
    if (!unit.open && !kase && hasOwn(LOAD_DRAWS, source)) { noteOutside(`draw ${source} while the module loaded (a stand-in)`); return LOAD_DRAWS[source]; }
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
    // Timers never run on their own: a firing is an input (`timer`, the case's own id, numbered as the recorder numbers
    // a family's timers: 1, 2, ... per case) delivered at the recorded point. A handle is an object of class Timeout
    // with no own data, as Bun's is, so a state that holds one encodes alike.
    class Timeout { unref() { return this; } ref() { return this; } hasRef() { return true; } refresh() { return this; } }
    defineProperty(Timeout.prototype, RealSymbol.toPrimitive, { value() { return timerHandles.get(this)?.id ?? 0; }, configurable: true, writable: true });
    const setTimer = (repeat) => function setTimer(callback, delay, ...rest) {
      const handle = new Timeout();
      if (!current || !kase) { noteOutside(repeat ? 'setInterval' : 'setTimeout'); return handle; }
      kase.timerCount += 1;
      const id = kase.timerCount;
      const timer = { callback, args: rest, repeat, cleared: false, fired: 0, delay, step: current.n };
      kase.timers.set(id, timer);
      timerHandles.set(handle, { owner: kase, id });
      // The step's j-th timer is the recording's timer the bind names: a `timer` input names it so.
      const index = current.timerSets ?? 0;
      current.timerSets = index + 1;
      const named = current.bind.find((request) => request.timer !== undefined && request.index === index);
      if (named && !kase.timerNames.has(named.timer)) kase.timerNames.set(named.timer, timer);
      effect({ kind: 'timer.set', id, delay: snap(delay), repeat });
      return handle;
    };
    const clearTimer = function clearTimer(handle) {
      if (handle === undefined || handle === null) return;
      if (!current || !kase) { noteOutside('clearTimeout'); return; }
      const known = typeof handle === 'object' ? timerHandles.get(handle) : undefined;
      // A handle that is no timer of this case (the test's, one rebuilt from the recording) is named by itself.
      if (!known) { effect({ kind: 'timer.clear', id: null, handle: snap(handle) }); return; }
      if (known.owner !== kase) { effect({ kind: 'timer.clear', id: null, handle: snap(handle), earlier: true }); return; }
      known.owner.timers.get(known.id).cleared = true;
      effect({ kind: 'timer.clear', id: known.id });
    };
    for (const [name, value] of [['setTimeout', setTimer(false)], ['setInterval', setTimer(true)], ['clearTimeout', clearTimer], ['clearInterval', clearTimer]]) {
      defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
    }
    // The transports and the DOM objects (protocol 4, package C0f): what the engine reads of the global itself is the
    // step's next `read` of the port `globalThis` (undefined, a port function such as the test's WebSocket fake, a port
    // object such as its window), so whether a global is there is an input, as the test decided it.
    for (const name of GLOBAL_READS) {
      defineProperty(globalThis, name, { get() { return readGlobal(name); }, set() { noteOutside(`a write of the global ${name}`); }, configurable: true, enumerable: false });
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
    const ownState = family.moduleState ? family.module : null;
    const files = [...new RealSet([...ports.keys(), ...planted.keys(), ...(ownState ? [ownState] : [])])];
    if (files.length === 0) return;
    const filter = new RegExp(`^(?:${files.map(escapeRegExp).join('|')})(?:\\?.*)?$`);
    const hook = {
      portExport(name, value) {
        if (typeof value === 'function') { portReal.set(name, value); return functionStubFor(name, value.name); }
        // An object with behaviour (an API client, an event bus) is a port object, as the recorder wraps it (C0f): its
        // reads and calls answer from the step; data (a client id the module drew as it loaded) is the value the
        // recording's module exported (`load.portData`), never what this engine's load made of it.
        if (portLikeValue(value) || answerLikeValue(value)) return portObjectStub(name);
        unit.portObjects.push(name);
        if (unit.load?.portData && hasOwn(unit.load.portData, name)) return decode(unit.load.portData[name]);
        return value;
      },
      // The family module's own load registers how its module-state bindings are read and seeded.
      moduleState(read, seed) { unit.moduleRead = read; unit.moduleSeed = seed; },
    };
    globalThis[HOOK] = hook;
    Bun.plugin({
      name: 'devryan-client-conformance-replay',
      setup(build) {
        build.onLoad({ filter }, (args) => {
          const [file, query = ''] = args.path.split('?');
          const source = () => (planted.has(file) ? planted.get(file) : readFileSync(file, 'utf8'));
          if (file === ownState && !query.includes(REAL_QUERY)) { const text = source(); return { contents: text + moduleStateSource(family, text), loader: loaderOf(file) }; }
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
  const portReal = new RealMap(); // a module port's name -> the real export (what the module reads while it loads)
  const functionStubFor = (name, functionName) => portFunctionStub(name, functionName);
  // The recorder's rule for an answer with behaviour (its portLike), on a live value.
  const DATA_PROTOTYPES = [RealMap, RealSet, RealDate, RegExp, RealError, ArrayBuffer, getPrototypeOf(RealUint8Array), RealPromise, RealWeakMap, WeakSet].map((constructor) => constructor.prototype);
  // The recorder's answerLike: behaviour at the top or in an own member (a namespace of methods).
  function answerLikeValue(value) {
    if (portLikeValue(value)) return true;
    if (value === null || typeof value !== 'object' || isPromise(value)) return false;
    return ownKeys(value).some((key) => { const descriptor = getOwnPropertyDescriptor(value, key); return Boolean(descriptor && hasOwn(descriptor, 'value') && (typeof descriptor.value === 'function' || portLikeValue(descriptor.value))); });
  }
  function portLikeValue(value) {
    if (value === null || typeof value !== 'object' || isArray(value)) return false;
    for (const prototype of DATA_PROTOTYPES) if (apply(isPrototypeOf, prototype, [value])) return false;
    const prototype = getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return true;
    return ownKeys(value).some((key) => { const descriptor = getOwnPropertyDescriptor(value, key); return Boolean(descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'); });
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
    const { family, plants = [], load = null } = message;
    unit.family = family;
    unit.load = load;
    unit.unordered = new RealSet(family.unordered ?? []);
    installPlatform();
    installLoader(family, plants);
    const namespace = await import(family.module);
    unit.namespace = namespace;
    for (const name of objectKeys(namespace)) if (typeof namespace[name] === 'function') unit.entries.set(name, (family.entries ?? []).find((entry) => entry.export === name) ?? { export: name });
    // The engine's own listener, subscribed first as the recorder's is: every notification is an effect of the open step.
    if (family.store) {
      const store = namespace[family.store];
      if (store === null || store === undefined || typeof store.subscribe !== 'function') throw new Error(`the store ${family.store} of ${family.name} has no subscribe`);
      store.subscribe((state, previous) => {
        if (unit.seeding) return;
        activity += 1;
        if (!current || !kase) { noteOutside('notify'); return; }
        current.effects.push({ kind: 'notify', state: snap(state), previous: snap(previous) });
        // What the store notified with may be named again later (an object a later input holds): bound where it first shows.
        bindSlot(`effects.${current.effects.length - 1}.state`, state);
        bindSlot(`effects.${current.effects.length - 1}.previous`, previous);
      });
    }
    unit.open = true;
    // What module load did (a clock read, say) is reported, not charged to a case: no case was open (replay-compare.mjs NOT_COMPARED).
    return { exports: [...unit.entries.keys()], portObjects: unit.portObjects, load: takeBetween() };
  }

  // What the unit noted while no case was open since the previous case ended (charged to that case by the replayer).
  const takeBetween = () => unit.between.splice(0);
  function openCase() {
    if (kase) throw new Error('a case is open: end it first');
    unit.cases += 1;
    kase = { ordinal: unit.cases, codec: createCodecContext({ names: unit.names, unwrap: (item) => engineWrapped.get(item), unifyWrapped: true }), bound: new RealMap(), names: new RealMap(), symbols: new RealMap(), steps: [], portCalls: 0, halt: null, outside: [], bindFailures: [], strings: [], jobs: 0, ended: false,
      nextN: 1, timers: new RealMap(), timerNames: new RealMap(), timerCount: 0, deferred: new RealMap(), immediates: new RealMap(), portStubs: new RealMap(), portFunctions: new RealMap(), group: [], slots: {} };
    return { between: takeBetween() };
  }
  /** Seeds the state the case starts from (engine.mjs `seed`): before its first step, and then takes the entry state. */
  function seed(message) {
    if (!kase) throw new Error('no case is open');
    if (!stateful()) throw new Error(`${unit.family.name} has no state to seed`);
    if (kase.steps.length || kase.slots.entry !== undefined) throw new Error('a case is seeded before its first step');
    for (const text of message.strings ?? []) kase.strings.push(text);
    try { seedState(expandStrings(message.state, kase.strings)); } catch (error) {
      kase.halt = { step: null, check: 'rebuild', detail: `the recorded entry state could not be seeded: ${String(error?.message ?? error)}` };
      return { seeded: false };
    }
    takeEntry(message.bind ?? []);
    return { seeded: true };
  }
  // The appended source that registers the family module's state bindings: read all, assign the `let` ones.
  function moduleStateSource(family, text) {
    const bindings = family.moduleState.bindings;
    const kindOf = (name) => new RegExp(`^(?:export\\s+)?(const|let|var)\\s+${name}\\b`, 'm').exec(text)?.[1] ?? null;
    const missing = bindings.filter((name) => kindOf(name) === null);
    if (missing.length) throw new Error(`${family.name}: no top-level declaration of ${missing.join(', ')} in its module`);
    unit.letBindings = bindings.filter((name) => kindOf(name) !== 'const');
    const read = `() => ({ ${bindings.map((name) => `${JSONStringify(name)}: ${name}`).join(', ')} })`;
    const assign = `(values) => { ${unit.letBindings.map((name) => `if (Object.prototype.hasOwnProperty.call(values, ${JSONStringify(name)})) ${name} = values[${JSONStringify(name)}];`).join(' ')} }`;
    return `\n;globalThis[Symbol.for(${JSONStringify(HOOK.description)})].moduleState(${read}, ${assign});\n`;
  }

  // ------------------------------------------------------------- stateful families (C0e)
  // A stateful family's state is `{ store?: getState(), module?: { binding: value } }`, read as the recorder reads it.
  const stateful = () => Boolean(unit.family && (unit.family.store || unit.family.moduleState));
  function familyState() {
    const out = {};
    if (unit.family.store) {
      const store = unit.namespace[unit.family.store];
      out.store = store !== null && store !== undefined && typeof store.getState === 'function' ? store.getState() : undefined;
    }
    if (unit.family.moduleState) {
      if (!unit.moduleRead) throw new Error(`the module state of ${unit.family.name} was never registered`);
      out.module = unit.moduleRead();
    }
    return out;
  }
  // The root and its `module` member are fresh objects at every read: no identity of the family's.
  const freshPath = (where) => where.length === 0 || (where.length === 1 && where[0] === 'module');
  const statePaths = () => identityPaths(familyState()).filter(([where]) => !freshPath(where));
  /** After a step's synchronous part: its state and change set, taken as the recorder takes them. */
  function takeState(record, before) {
    const state = familyState();
    record.slots.state = snap(state);
    bindSlot('state', state);
    const changes = changedPaths(before, state).filter((where) => !freshPath(where));
    record.slots.stateChanges = snap(changes);
  }
  // The case's entry state, as the engine has it when the case's first input comes (after a seed, if any).
  function takeEntry(bind = []) {
    if (!stateful() || kase.slots.entry !== undefined) return;
    const state = familyState();
    kase.slots.entry = snap(state);
    bindSlot('entry', state, bind, null);
  }
  /**
   * Seeds the unit's state from a recorded state tree (a case alone, or a case in file order whose recorded entry
   * is not where the case before it ended). What the module holds in `const` bindings (its Maps and Sets) is
   * brought in place to the recorded content, its `let` bindings are assigned, and the store's state replaced,
   * its actions kept as the module made them. No notification of the seeding is an effect.
   */
  function seedState(recorded) {
    let tree = recorded;
    const live = familyState();
    const isId = (node) => node !== null && typeof node === 'object' && !isArray(node) && node.$dr === 'id';
    const members = (node) => (node !== null && typeof node === 'object' && !isArray(node) && node.$dr === undefined ? node : null);
    const given = members(tree.module);
    // A `const` binding's container is brought in place: its node is bound to the live one (a node the tree names
    // once only, with no id, gets a number of its own, below any the recording uses).
    const moduleTree = given ? { ...given } : null;
    if (moduleTree && live.module) {
      let fresh = 0;
      for (const name of objectKeys(moduleTree)) {
        if ((unit.letBindings ?? []).includes(name)) continue;
        const value = live.module[name];
        if (value === null || typeof value !== 'object') continue;
        if (!isId(moduleTree[name])) moduleTree[name] = { $dr: 'id', n: (fresh -= 1), value: moduleTree[name] };
        kase.bound.set(moduleTree[name].n, value);
      }
      tree = { ...tree, module: moduleTree };
    }
    const storeTree = tree.store;
    const liveStore = live.store;
    // The store's actions (and its action groups' actions, one level down) are the live ones the module made.
    const prebind = (node, live, depth) => {
      const fields = isId(node) ? members(node.value) : members(node);
      if (!fields || live === null || typeof live !== 'object') return;
      for (const key of objectKeys(fields)) {
        if (typeof live[key] === 'function') { if (isId(fields[key])) kase.bound.set(fields[key].n, live[key]); continue; }
        if (depth > 0) prebind(fields[key], live[key], depth - 1);
      }
    };
    const keepLive = (made, live, depth) => {
      if (made === null || typeof made !== 'object' || live === null || typeof live !== 'object') return;
      for (const key of objectKeys(made)) {
        if (typeof made[key] === 'function' && typeof live[key] === 'function') made[key] = live[key];
        else if (depth > 0) keepLive(made[key], live[key], depth - 1);
      }
    };
    if (liveStore) prebind(storeTree, liveStore, 1);
    const rebuilt = rebuild(tree);
    unit.seeding = true;
    try {
      if (moduleTree && unit.moduleSeed) unit.moduleSeed(rebuilt.module);
      if (unit.family.store && rebuilt.store !== null && typeof rebuilt.store === 'object') {
        keepLive(rebuilt.store, liveStore, 1);
        unit.namespace[unit.family.store].setState(rebuilt.store, true);
      }
    } finally { unit.seeding = false; }
  }

  // ------------------------------------------------------------- what a step's entry names
  const STORE_API = new RealSet(['getState', 'setState', 'subscribe', 'getInitialState', 'destroy']);
  const splitName = (segment) => { const at = segment.indexOf('#'); return at < 0 ? { key: segment, number: null } : { key: segment.slice(0, at), number: segment.slice(at + 1) }; };
  /**
   * The function a step's entry names, with its receiver: an export of the family's module; the store export's
   * `setState`, `subscribe` or an action (`<store>.<action>`, read from getState()); or engine code a step handed
   * the test (`<entry>#<n>`, bound by name), and members read from it (`.<member>`, `.<member>#<n>` naming what
   * the read gave, the last one the method or getter). Null when nothing it names is there.
   */
  function resolveEntry(label, kind) {
    const segments = String(label).split('.');
    let holder;
    let rest;
    for (let length = segments.length; length >= 1; length -= 1) {
      const prefix = segments.slice(0, length).join('.');
      if (kase.names.has(prefix)) { holder = kase.names.get(prefix); rest = segments.slice(length); break; }
    }
    if (rest === undefined) {
      const root = splitName(segments[0]);
      if (root.number !== null || !hasOwn(unit.namespace, root.key)) return null;
      holder = unit.namespace[root.key];
      rest = segments.slice(1);
      // A store's action (`<store>.<action>`, `<store>.<group>.<action>`) is read from its state, as the test reads it.
      if (root.key === unit.family.store && rest.length >= 1 && !STORE_API.has(rest[0])) holder = holder.getState();
    }
    if (rest.length === 0) return typeof holder === 'function' || kind === 'get' ? { target: holder, receiver: undefined } : null;
    for (let index = 0; index < rest.length - 1; index += 1) {
      const { key, number } = splitName(rest[index]);
      if (holder === null || (typeof holder !== 'object' && typeof holder !== 'function')) return null;
      const value = holder[key];
      if (number !== null) {
        const name = segments.slice(0, segments.length - rest.length + index + 1).join('.');
        if (!kase.names.has(name)) kase.names.set(name, value);
      }
      holder = value;
    }
    const last = splitName(rest[rest.length - 1]);
    if (holder === null || (typeof holder !== 'object' && typeof holder !== 'function')) return null;
    if (last.number !== null) { const value = holder[last.key]; kase.names.set(String(label), value); return typeof value === 'function' ? { target: value, receiver: undefined } : null; }
    if (kind === 'get') {
      for (let at = holder; at !== null; at = getPrototypeOf(at)) {
        const descriptor = getOwnPropertyDescriptor(at, last.key);
        if (descriptor) return typeof descriptor.get === 'function' ? { target: descriptor.get, receiver: holder } : null;
      }
      return null;
    }
    const method = holder[last.key];
    return typeof method === 'function' ? { target: method, receiver: holder } : null;
  }
  // The ports a step's arguments carry: an injected item names an entry and, for engine code it handed out, a member.
  function injectedFor(label) {
    const segments = String(label).split('.');
    const root = splitName(segments[0]).key;
    const last = segments.length > 1 ? splitName(segments[segments.length - 1]).key : null;
    return (unit.family.injected ?? []).filter((item) => (item.member === undefined ? item.entry === label : item.entry === root && item.member === last && segments.length > 1));
  }

  /** A step's record from its message: the input as the engine echoes it, the env, the bind plan, nested inputs. */
  function makeRecord(message, reserved = undefined) {
    for (const text of message.strings ?? []) kase.strings.push(text);
    const given = message.input;
    const input = { ...given, args: given.args === undefined ? undefined : expandStrings(given.args, kase.strings), value: given.value === undefined ? undefined : expandStrings(given.value, kase.strings), target: given.target === undefined ? undefined : expandStrings(given.target, kase.strings) };
    const echo = { kind: input.kind, entry: input.entry, now: input.now };
    for (const key of ['id', 'port', 'call', 'outcome']) if (hasOwn(input, key) && input[key] !== undefined) echo[key] = input[key];
    // Step numbers follow the recording's order: a step's nested inputs (`during`) come right after it, so their numbers
    // are kept for them when the step arrives, which may be before it is delivered (a held group, recording 8).
    const countNested = (step) => (step.during ?? []).reduce((sum, group) => sum + 1 + countNested(group.step), 0);
    const n = reserved ?? kase.nextN;
    if (reserved === undefined) kase.nextN += 1 + countNested(message);
    const record = { n, input: echo, given: input, effects: [], env: expandStrings(message.env ?? [], kase.strings), envNext: 0, used: new RealSet(), bind: message.bind ?? [], slots: {}, nested: message.during ?? [], parent: null, nextNested: n + 1 };
    kase.steps.push(record);
    return record;
  }

  async function step(message) {
    if (!kase) throw new Error('no case is open');
    // The engine numbers the steps of a case itself: the replayer sends them in order and names none.
    if (kase.halt) return { halted: kase.halt, skipped: true };
    takeEntry(message.step.entryBind ?? []);
    // The test ended before this input (it came late): the case's end state, and its pending timers, are those the test ended with.
    if (message.step.late && stateful() && kase.slots.end === undefined) kase.slots.end = snap(familyState());
    if (message.step.late) kase.pendingAtEnd ??= pendingTimers();
    const record = makeRecord(message.step);
    // Inputs that arrived together (protocol 4, package C0f): a step sent with `hold` waits for the next; the group is
    // delivered at once, in order, with no job run between its inputs, and then run to quiescence. Each input opens
    // when it is delivered (a call, a callback, a timer: its synchronous part; a settle: when the first reaction of its
    // promise runs), and the input opened before it forwards to it: what lands there afterwards is the later input's.
    kase.group.push(record);
    if (message.step.hold) return { halted: kase.halt, held: true };
    const group = kase.group.splice(0);
    group.forEach((member, index) => { member.groupIndex = index; member.group = group; });
    // An immediate answer whose call is made in the group, and that did not arrive together with the member before it,
    // is delivered by its call (callPort), as many generations after the call as recorded.
    for (const member of group) if (member.given.kind === 'settle' && member.given.immediate !== undefined && !kase.deferred.has(member.given.call)) { member.immediateMember = true; kase.immediates.set(member.given.call, member); }
    // The first member is delivered now; every later one once the member before it has opened: right after it when it
    // arrived together with it, else once the engine ran out (scheduleNext, from openMember).
    deliverMember(group[0]);
    return finishStep(record);
  }
  /** Delivers a member of a group (an immediate answer is its call's to deliver). */
  function deliverMember(member) {
    const input = member.given;
    if (kase.halt || member.immediateMember) return;
    member.delivered = true;
    if (input.kind === 'settle') { deliverSettle(member, input); return; }
    // A synchronous input opens before its synchronous part (where the recorder's marker chain starts); one that came
    // together with it is delivered right after that part.
    member.syncing = true;
    openMember(member);
    if (input.kind === 'timer') deliverTimer(member, input);
    else if (input.kind === 'callback') deliverCallback(member);
    else deliverCall(member);
    member.syncing = false;
    const next = member.nextNow;
    member.nextNow = null;
    if (next?.deliverNow) next.deliverNow(); else if (next) deliverMember(next);
  }
  /** Once `member` opened: the next member of its group, at the generation the recording placed it at. */
  function scheduleNext(member) {
    const group = member.group;
    if (!group || member.scheduled) return;
    member.scheduled = true;
    member.opened = true;
    // An immediate answer whose generations came before this member opened is delivered right after it.
    if (member.thenDeliver) {
      const waiting = member.thenDeliver;
      member.thenDeliver = null;
      const deliver = () => { if (kase.deferred.get(waiting.given.call)) deliverSettle(waiting, waiting.given); };
      if (member.syncing) member.nextNow = { deliverNow: deliver }; else deliver();
    }
    const next = group[member.groupIndex + 1];
    if (!next || kase.halt) return;
    // An immediate answer is placed by its call; the member after it waits for it to open.
    if (next.immediateMember) return;
    if (next.given.together === true) { if (member.syncing) member.nextNow = next; else deliverMember(next); return; }
    // Any other input came once the inputs before it had run out.
    quiesce().then(() => deliverMember(next));
  }
  /** A member of a group opens: the member opened before it in the group forwards to it, and it is where effects go. */
  function openMember(member) {
    const opened = member.group?.opened ?? null;
    if (opened && opened !== member && opened.groupIndex < member.groupIndex) opened.forward = member;
    if (!opened || opened.groupIndex <= member.groupIndex) { if (member.group) member.group.opened = member; current = member; }
    scheduleNext(member);
  }
  /**
   * Inputs the test made inside a port call of the open step (`during`: a subscriber's or a stub's call back into
   * the family): delivered synchronously inside that very call, before it answers, each a step of its own.
   */
  function deliverNested(call) {
    const outer = current;
    for (const group of outer.nested) {
      if (group.call !== call) continue;
      const record = makeRecord(group.step, outer.nextNested);
      outer.nextNested += 1 + (group.step.during ?? []).reduce(function count(sum, inner) { return sum + 1 + (inner.step.during ?? []).reduce(count, 0); }, 0);
      record.parent = outer;
      current = record;
      // A callback the port invokes inside its own call (a subscription that answers at once, package C0f) is one too.
      try { if (record.given.kind === 'callback') deliverCallback(record); else deliverCall(record); } finally { current = outer; }
    }
  }
  /**
   * The test calls a function the engine handed a port (a scheduler's job, a listener): `target` names which, by the
   * identity the recording gives it where the engine handed it out; it is called with the test's arguments.
   */
  function deliverCallback(record) {
    const input = record.given;
    let target;
    let args;
    try {
      target = rebuild(input.target);
      args = rebuild(input.args ?? []);
      if (typeof target !== 'function' || stubs.has(target)) throw new RebuildError('the callback the test called is no function this engine handed a port');
      if (!isArray(args)) throw new RebuildError('the arguments are not a list');
    } catch (error) {
      kase.halt ??= { step: record.n, check: 'rebuild', detail: String(error?.message ?? error) };
      return;
    }
    record.slots.args = snap(args);
    record.slots.target = snap(target);
    const beforeState = stateful() ? statePaths() : null;
    let result;
    let threw = false;
    try { result = apply(target, undefined, args); } catch (error) { threw = true; result = error; }
    record.returnedAt = record.effects.length;
    if (beforeState) takeState(record, beforeState);
    if (threw) { record.slots.throws = snap(result); bindSlot('throws', result); } else { record.slots.returns = snap(result); bindSlot('returns', result); }
  }
  /** The synchronous part of a call, `new` or `get` step: rebuild the arguments, call, take what it returned. */
  function deliverCall(record) {
    const input = record.given;
    const n = record.n;
    const unplaced = (detail) => { kase.halt ??= { step: n, check: 'unplaced', detail }; };
    if (!['call', 'new', 'get'].includes(input.kind)) { unplaced(`an input of kind ${input.kind} is none this engine delivers`); return; }
    const resolved = resolveEntry(input.entry, input.kind);
    if (!resolved) { unplaced(`${input.kind} ${input.entry} names nothing ${unit.family.name} has (an entry, its store, or engine code a step handed out)`); return; }
    const spec = unit.entries.get(input.entry) ?? { export: input.entry };
    let args;
    let finalArgs;
    try {
      args = rebuild(input.args ?? []);
      if (!isArray(args)) throw new RebuildError('the arguments are not a list');
      finalArgs = [...args];
      for (const item of injectedFor(input.entry)) {
        const holder = item.key === undefined ? null : args[item.arg];
        const value = item.key === undefined ? args[item.arg] : holder !== null && typeof holder === 'object' ? getOwnPropertyDescriptor(holder, item.key)?.value : undefined;
        // An object handed in (an SDK) is a port object, as the recorder wraps it: the module gets the port, the
        // arguments as the test passed them keep the test's object (package C0f).
        if (!item.onlyFunction && value !== null && typeof value === 'object' && !stubs.has(value)) {
          const port = portObjectStub(item.name);
          if (item.key === undefined) { finalArgs[item.arg] = port; continue; }
          const inner = finalArgs[item.arg];
          const wrapped = new RealProxy(inner, { get: (object, key, receiver) => (key === item.key ? port : reflectGet(object, key, receiver)) });
          // The codec writes the wrapper as what it wraps, identity included, as the recorder's codec does (unifyWrapped).
          engineWrapped.set(wrapped, engineWrapped.get(inner) ?? inner);
          finalArgs[item.arg] = wrapped;
          continue;
        }
        const info = typeof value === 'function' ? stubs.get(value) : undefined;
        if (!info) continue;
        // A per-step port (a store's subscriber) is named by the step that hands it in.
        const portName = item.perStep ? `${item.name}@${n}` : item.name;
        if (item.key !== undefined) { info.port = portName; kase.codec.names.delete(value); continue; }
        // A function handed in whole is wrapped as the recorder wraps it: the module gets the port (named, an object
        // of its own), the arguments as the test passed them keep the test's function.
        const port = { [value.name]: function (...portArgs) { return callPort(portName, portArgs); } }[value.name];
        kase.codec.names.set(port, portName);
        finalArgs[item.arg] = port;
      }
    } catch (error) {
      kase.halt ??= { step: n, check: 'rebuild', detail: String(error?.message ?? error) };
      return;
    }
    record.slots.args = snap(args);
    const draft = spec.draft;
    const before = draft !== undefined ? identityPaths(args[draft]) : null;
    const beforeState = stateful() ? statePaths() : null;
    let result;
    let threw = false;
    try {
      result = input.kind === 'new' ? construct(resolved.target, finalArgs) : apply(resolved.target, resolved.receiver, finalArgs);
    } catch (error) { threw = true; result = error; }
    // The effects made before the entry returned or threw; the rest come from the jobs it started.
    record.returnedAt = record.effects.length;
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
    if (beforeState) takeState(record, beforeState);
    if (!threw && isPromise(result)) {
      // The promise settles in the step whose input made it settle (a timer firing, an answer settling), as the
      // recorder places it; one an input made inside a port call settles in that input's own step while its outer
      // step is still the open one (the recorder's chain of that input).
      // A nested input's own promise settles in the outer step once the nested call returned (recording 8, C0f).
      const target = () => (current && current === record ? record : current);
      apply(RealPromise.prototype.then, result, [
        (value) => { activity += 1; const into = target(); if (into) { into.effects.push({ kind: 'settled', step: n, outcome: 'fulfilled', value: snap(value) }); bindSlot(`effects.${into.effects.length - 1}.value`, value, into.bind, into.n); } else noteOutside('settled'); },
        (reason) => { activity += 1; const into = target(); if (into) { into.effects.push({ kind: 'settled', step: n, outcome: 'rejected', value: snap(reason) }); bindSlot(`effects.${into.effects.length - 1}.value`, reason, into.bind, into.n); } else noteOutside('settled'); },
      ]);
    }
  }
  async function finishStep(record) {
    let quiet = await quiesce();
    // A group is done when every member has been delivered (one comes once the engine ran out, which another wait
    // for quiescence may see first) and the engine is quiet again; a member whose call never came stays undelivered.
    const waiting = () => (record.group ?? []).filter((member) => !member.delivered).length;
    for (let left = waiting(), stalls = 0; quiet && left > 0 && stalls < QUIET_ROUNDS && !kase.halt; ) {
      quiet = await quiesce();
      const now = waiting();
      stalls = now < left ? 0 : stalls + 1;
      left = now;
    }
    current = null;
    if (!quiet) kase.halt ??= { step: record.n, check: 'quiescence', detail: `the step was still running after ${MAX_ROUNDS} rounds of the event loop` };
    return { halted: kase.halt };
  }
  /** A timer the case set fires: only one it set and has not cleared (an interval any number of times, a timeout once). */
  function deliverTimer(record, input) {
    const timer = kase.timerNames.get(input.id);
    if (!timer || timer.cleared || (!timer.repeat && timer.fired > 0)) {
      kase.halt = { step: record.n, check: 'fired-unknown-timer', detail: `timer ${input.id} fired, but this case ${!timer ? 'never set it' : timer.cleared ? 'cleared it' : 'already ran it'}` };
      return;
    }
    timer.fired += 1;
    const beforeState = stateful() ? statePaths() : null;
    try { apply(timer.callback, undefined, timer.args); } catch (error) { if (!(error instanceof ReplayHalt)) kase.outside.push({ what: `uncaught ${describeError(error)} (a timer callback)` }); }
    record.returnedAt = record.effects.length;
    if (beforeState) takeState(record, beforeState);
  }
  /**
   * A port's promise answer settles: the call it answered is named by the engine's own numbering of the case's port
   * calls. The input opens when the first reaction of that promise runs (the engine's own, registered before the
   * module's), which is where the recorder opens it: its continuation's first effects are its own.
   */
  function deliverSettle(record, input) {
    const settle = kase.deferred.get(input.call);
    if (!settle || input.port === undefined) {
      kase.halt = { step: record.n, check: 'settled-unknown-call', detail: `port call ${input.call} (${input.port}) settled, but this case made no such call with a promise answer` };
      return;
    }
    kase.deferred.delete(input.call);
    record.delivered = true;
    let value;
    const before = current;
    current = record;
    try { value = rebuild(input.value); } catch (error) {
      current = null;
      kase.halt = { step: record.n, check: 'rebuild', detail: String(error?.message ?? error) };
      return;
    }
    record.slots.value = snap(value);
    // The input opens at the first reaction of its promise (openMember), not here: until then, effects are not its own.
    current = before;
    settle.opens = record;
    if (input.outcome === 'rejected') settle.reject(value); else settle.resolve(value);
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

  /**
   * The case's timers still pending (set, not cleared, and for a timeout not fired), in the order they were set: the
   * recording's name of each (its bind), the delay it was set with and the engine's count of the step that set it.
   */
  function pendingTimers() {
    const names = new RealMap();
    for (const [name, timer] of kase.timerNames) names.set(timer, name);
    const out = [];
    for (const timer of kase.timers.values()) {
      if (timer.cleared || (!timer.repeat && timer.fired > 0)) continue;
      out.push({ timer: names.get(timer) ?? null, delay: snap(timer.delay), repeat: timer.repeat, step: timer.step });
    }
    return out;
  }
  async function endCase() {
    if (!kase) throw new Error('no case is open');
    await settleJobs(kase);
    kase.pendingAtEnd ??= pendingTimers();
    if (stateful() && !kase.halt) {
      takeEntry();
      if (kase.slots.end === undefined) kase.slots.end = snap(familyState());
    }
    const slots = [];
    const put = (value) => { slots.push(value.taken); return slots.length - 1; };
    // The case's value parts in the recorder's order: entry state, the steps, end state (one identity scope).
    const entrySlot = kase.slots.entry !== undefined ? put(kase.slots.entry) : undefined;
    kase.steps.sort((left, right) => left.n - right.n);
    const shapes = kase.steps.map((record) => {
      const shape = { n: record.n, input: { ...record.input, args: record.slots.args === undefined ? undefined : put(record.slots.args), value: record.slots.value === undefined ? undefined : put(record.slots.value), target: record.slots.target === undefined ? undefined : put(record.slots.target) } };
      shape.effects = record.effects.map((item) => {
        const out = {};
        for (const key of objectKeys(item)) out[key] = item[key] instanceof Taken ? { slot: put(item[key]) } : item[key];
        return out;
      });
      if (record.returnedAt !== undefined) shape.returnedAt = record.returnedAt;
      for (const key of ['returns', 'throws', 'after', 'changes', 'state', 'stateChanges']) if (record.slots[key] !== undefined) shape[key] = put(record.slots[key]);
      return shape;
    });
    const endSlot = kase.slots.end !== undefined ? put(kase.slots.end) : undefined;
    const pendingShapes = kase.pendingAtEnd.map((item) => ({ ...item, delay: put(item.delay) }));
    const trees = emitSlots(slots);
    const tree = (index) => (index === undefined ? undefined : trees[index]);
    const steps = shapes.map((shape) => {
      const out = { n: shape.n, input: {} };
      for (const key of objectKeys(shape.input)) {
        if (key === 'args' || key === 'value' || key === 'target') { if (shape.input[key] !== undefined) out.input[key] = tree(shape.input[key]); } else if (shape.input[key] !== undefined) out.input[key] = shape.input[key];
      }
      out.effects = shape.effects.map((item) => {
        const effectOut = {};
        for (const key of objectKeys(item)) effectOut[key] = item[key] !== null && typeof item[key] === 'object' && !isArray(item[key]) && objectKeys(item[key]).length === 1 && hasOwn(item[key], 'slot') ? tree(item[key].slot) : item[key];
        return effectOut;
      });
      if (shape.returnedAt !== undefined) out.returnedAt = shape.returnedAt;
      for (const key of ['returns', 'throws', 'after', 'changes', 'state', 'stateChanges']) if (shape[key] !== undefined) out[key] = tree(shape[key]);
      return out;
    });
    // Long strings are sent once each (a streamed text grows step by step and every step's arguments and
    // results hold it): `{"$dr":"slice","s":k}` stands for strings[k] (engine.mjs).
    const strings = [];
    const states = { entry: entrySlot === undefined ? undefined : tree(entrySlot), end: endSlot === undefined ? undefined : tree(endSlot) };
    const pending = pendingShapes.map((item) => ({ ...item, delay: tree(item.delay) }));
    const replayed = { steps: shareStrings(steps, strings), ...(states.entry !== undefined ? { entry: shareStrings(states.entry, strings) } : {}), ...(states.end !== undefined ? { end: shareStrings(states.end, strings) } : {}), pending, strings, halt: kase.halt, outside: kase.outside, bindFailures: kase.bindFailures, flags: [...kase.codec.flags] };
    kase.ended = true;
    kase = null;
    return { replayed };
  }

  const handlers = { open, case: openCase, seed, step, end: endCase, close: () => ({ between: takeBetween() }) };
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
