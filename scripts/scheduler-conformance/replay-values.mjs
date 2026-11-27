// Values of the scheduler replayer (replay.mjs, package O0c of design file
// 30): the decoder that turns a recorded codec tree into the live value a
// candidate gets, the identity bindings across a case's events, and the
// comparisons of trees. Runtime-neutral (the self-test runs it under Node).
import { decode, emitSlots, stringifyTree } from '../client-conformance/codec.mjs';

export const TAG = '$dr';
const LEAF_TAGS = new Set(['undefined', 'number', 'bigint', 'date', 'regexp', 'bytes', 'typed', 'arraybuffer', 'dataview', 'url', 'searchparams', 'headers', 'response', 'request', 'symbol', 'promise', 'weak', 'opaque', 'unencodable']);

/**
 * A value's tree with identity numbers taken out (`id` -> its content, `ref` -> a bare marker, an unregistered
 * symbol's ordinal dropped, its description kept): what one value alone is. A symbol's ordinal is its identity in
 * the scope it was emitted in, like an object's number, so it is compared where identity is: at the end of the case,
 * in one scope (a value emitted alone numbers its first symbol 1 whatever the case's scope numbered it).
 */
export function shape(tree) {
  if (Array.isArray(tree)) return tree.map(shape);
  if (tree === null || typeof tree !== 'object') return tree;
  if (tree[TAG] === 'id') return shape(tree.value);
  if (tree[TAG] === 'ref') return { [TAG]: 'ref' };
  if (tree[TAG] === 'symbol' && Object.hasOwn(tree, 'n')) return Object.hasOwn(tree, 'description') ? { [TAG]: 'symbol', description: tree.description } : { [TAG]: 'symbol' };
  const out = {};
  for (const key of Object.keys(tree)) out[key] = shape(tree[key]);
  return out;
}
export const shapeText = (tree) => stringifyTree(shape(tree));

/** The first path at which two trees differ, for a report. */
export function treeDifference(left, right, where = '') {
  if (JSON.stringify(left) === JSON.stringify(right)) return null;
  if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const found = treeDifference(left[key], right[key], `${where}.${key}`);
      if (found) return found;
    }
  }
  return `${where || '(value)'}: ${JSON.stringify(right)?.slice(0, 200)} where the recording has ${JSON.stringify(left)?.slice(0, 200)}`;
}

/** Unplaceable: a value the replay has no stand-in for (the case is unrecordable for that named reason). */
export class Unplaceable extends Error {
  constructor(reason) { super(reason); this.name = 'Unplaceable'; this.reason = reason; }
}

/** The member path from `value` to `target` (recorder.mjs `pathTo`): own enumerable data members, array items, any depth. */
export function pathTo(value, target, rawOf) {
  const seen = new Set();
  const isSignal = (item) => item !== null && typeof item === 'object' && Object.prototype.isPrototypeOf.call(AbortSignal.prototype, item);
  const walk = (item, trail) => {
    if (item === target) return trail;
    if (item === null || typeof item !== 'object' || seen.has(item) || rawOf.get(item) !== undefined || isSignal(item)) return null;
    seen.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) continue;
      const found = walk(descriptor.value, [...trail, Array.isArray(item) && /^\d+$/.test(key) ? Number(key) : key]);
      if (found) return found;
    }
    return null;
  };
  return walk(value, []);
}

/** A snapshot's content alone, signal states left out (recorder.mjs `contentText`). */
export function contentText(snap) {
  const strip = (tree) => {
    if (Array.isArray(tree)) return tree.map(strip);
    if (tree && typeof tree === 'object') {
      if (tree[TAG] === 'abortsignal') return { [TAG]: 'abortsignal' };
      const out = {};
      for (const key of Object.keys(tree)) out[key] = strip(tree[key]);
      return out;
    }
    return tree;
  };
  return stringifyTree(strip(emitSlots([snap])[0]));
}

/**
 * Binds the identity numbers of a recorded tree to the live objects of the
 * value it describes, walking both together (an object the recording
 * numbers is the object the candidate handed over there).
 */
export function bindFrom(tree, value, bindings) {
  if (tree === null || typeof tree !== 'object' || value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (Array.isArray(tree)) {
    if (!Array.isArray(value)) return;
    let index = 0;
    for (const item of tree) {
      if (item && typeof item === 'object' && !Array.isArray(item) && item[TAG] === 'hole') { index += item.n; continue; }
      bindFrom(item, value[index], bindings);
      index += 1;
    }
    return;
  }
  const kind = tree[TAG];
  if (kind === undefined) { for (const key of Object.keys(tree)) bindFrom(tree[key], safeGet(value, key), bindings); return; }
  switch (kind) {
    case 'id': if (!bindings.has(tree.n)) bindings.set(tree.n, value); bindFrom(tree.value, value, bindings); return;
    case 'escape': case 'nullproto': for (const key of Object.keys(tree.value)) bindFrom(tree.value[key], safeGet(value, key), bindings); return;
    case 'symkeys': bindFrom(tree.value, value, bindings); return;
    case 'array': bindFrom(tree.items, value, bindings); return;
    case 'class': for (const key of Object.keys(tree.value)) bindFrom(tree.value[key], safeGet(value, key), bindings); if (tree.cause !== undefined) bindFrom(tree.cause, safeGet(value, 'cause'), bindings); return;
    case 'map': if (value instanceof Map) { const entries = [...value]; tree.entries.forEach(([key, item], index) => { bindFrom(key, entries[index]?.[0], bindings); bindFrom(item, entries[index]?.[1], bindings); }); } return;
    case 'set': if (value instanceof Set) { const items = [...value]; tree.values.forEach((item, index) => bindFrom(item, items[index], bindings)); } return;
    case 'abortsignal': return;
    default: return;
  }
}
const safeGet = (object, key) => { const descriptor = Object.getOwnPropertyDescriptor(object, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; };

/**
 * Decodes a recorded tree into a live value for the candidate. The codec's
 * own decoder makes every leaf (dates, symbols, typed arrays, ...); this one
 * walks the structure so it can: reuse the live object an identity number
 * already stands for (an object seen in an earlier event of the case is that
 * object again); make a stand-in for a port or function the trace names, by
 * where it is (`materialize(leaf, path)`); place the host's own signal where
 * the recording lists one (`signalAt(path)`); and give an error whose class is
 * an export of the copy (ManagedOrchestrationError) the copy's prototype, so
 * `instanceof` holds in the candidate as it did in the recording.
 */
export function decodeValue(tree, { codec, bindings, copyClass = () => null, signalAt = () => null, materialize }) {
  const local = new Map();
  const shell = (item) => decode(item, codec);
  const visit = (item, at) => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return fillArray(item, [], at);
    const kind = item[TAG];
    if (kind === undefined) return fillObject(item, {}, at);
    switch (kind) {
      case 'id': {
        if (bindings.has(item.n)) { const live = bindings.get(item.n); bindFrom(item.value, live, bindings); local.set(item.n, live); return live; }
        const container = containerFor(item.value);
        if (container !== undefined) { bindings.set(item.n, container); local.set(item.n, container); fillInto(item.value, container, at); return container; }
        const made = visit(item.value, at);
        if (made !== null && (typeof made === 'object' || typeof made === 'function')) { bindings.set(item.n, made); local.set(item.n, made); }
        return made;
      }
      case 'ref': {
        const live = local.get(item.n) ?? bindings.get(item.n);
        if (live === undefined) throw new Unplaceable(`identity ${item.n} referred to before it was seen`);
        return live;
      }
      case 'port': case 'function': return materialize(item, at);
      case 'abortsignal': {
        // A signal the recording lists here is the host's own: a controller it holds (aborted ones need none).
        const placed = signalAt(at, () => {
          if (item.aborted) return { signal: AbortSignal.abort(visit(item.reason, at)), controller: null };
          const controller = new AbortController();
          return { signal: controller.signal, controller };
        });
        if (placed) return placed.signal;
        return shell(item);
      }
      default: {
        if (LEAF_TAGS.has(kind)) return shell(item);
        const container = containerFor(item);
        if (container === undefined) return shell(item);
        return fillInto(item, container, at);
      }
    }
  };
  // An empty live container for a structural node (so an identity can be bound before its content is filled), or undefined for a leaf.
  const containerFor = (item) => {
    if (item === null || typeof item !== 'object') return undefined;
    if (Array.isArray(item)) return [];
    switch (item[TAG]) {
      case undefined: case 'escape': return {};
      case 'nullproto': return Object.create(null);
      case 'symkeys': return containerFor(item.value);
      case 'array': return item.className !== undefined ? shell({ [TAG]: 'array', items: [], className: item.className }) : [];
      case 'map': return shell({ [TAG]: 'map', entries: [], ...(item.className !== undefined ? { className: item.className } : {}) });
      case 'set': return shell({ [TAG]: 'set', values: [], ...(item.className !== undefined ? { className: item.className } : {}) });
      case 'class': {
        const made = shell({ [TAG]: 'class', name: item.name, ...(item.error ? { error: item.error } : {}), ...(item.primitive !== undefined ? { primitive: item.primitive } : {}), value: {} });
        const prototype = item.error ? copyClass(item.name) : null;
        if (prototype) Object.setPrototypeOf(made, prototype);
        return made;
      }
      default: return undefined;
    }
  };
  const fillInto = (item, target, at) => {
    if (Array.isArray(item)) return fillArray(item, target, at);
    switch (item[TAG]) {
      case undefined: return fillObject(item, target, at);
      case 'escape': case 'nullproto': return fillObject(item.value, target, at);
      case 'symkeys': {
        fillInto(item.value, target, at);
        for (const [key, entry] of item.symbols) member(target, visit(key, at), entry, at);
        return target;
      }
      case 'array': fillArray(item.items, target, at); if (item.props) fillObject(item.props, target, at); return target;
      case 'map': for (const [key, entry] of item.entries) target.set(visit(key, at), visit(entry, at)); return target;
      case 'set': for (const entry of item.values) target.add(visit(entry, at)); return target;
      case 'class': {
        fillObject(item.value, target, at);
        if (item.cause !== undefined) Object.defineProperty(target, 'cause', { value: visit(item.cause, at), writable: true, configurable: true, enumerable: false });
        if (item.errors !== undefined) Object.defineProperty(target, 'errors', { value: visit(item.errors, at), writable: true, configurable: true, enumerable: false });
        return target;
      }
      default: return target;
    }
  };
  const member = (target, key, entry, at) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry[TAG] === 'accessor') {
      const descriptor = { enumerable: true, configurable: true };
      if (entry.get) descriptor.get = function recordedGetter() { throw new TypeError('scheduler replay: a recorded accessor'); };
      if (entry.set) descriptor.set = function recordedSetter() {};
      if (!entry.get && !entry.set) descriptor.get = undefined;
      Object.defineProperty(target, key, descriptor);
      return;
    }
    Object.defineProperty(target, key, { value: visit(entry, typeof key === 'string' ? [...at, key] : at), enumerable: true, writable: true, configurable: true });
  };
  const fillObject = (item, target, at) => { for (const key of Reflect.ownKeys(item)) member(target, key, item[key], at); return target; };
  const fillArray = (items, target, at) => {
    let index = 0;
    for (const entry of items) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry[TAG] === 'hole') { index += entry.n; target.length = index; continue; }
      Object.defineProperty(target, String(index), { value: visit(entry, [...at, index]), enumerable: true, writable: true, configurable: true });
      index += 1;
    }
    target.length = index;
    return target;
  };
  return visit(tree, []);
}
