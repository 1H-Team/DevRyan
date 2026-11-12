// Value codec v3 of the client engine conformance harness (design file 29
// §3.1): any JavaScript value a test hands the engine, or the engine hands
// back, as a JSON tree that a reader in another language can read and write
// back byte for byte. `decode(encode(v))` re-encodes to the same bytes.
//
// A tree is plain JSON except for objects that carry a "$dr" key:
//   {"$dr":"undefined"}                         undefined (member, slot, value)
//   {"$dr":"number","value":"NaN"|"Infinity"|"-Infinity"|"-0"}
//   {"$dr":"bigint","value":"-12"}
//   {"$dr":"hole","n":3}                        3 consecutive holes of a sparse array
//   {"$dr":"array","items":[...],"className":"Stack"?,"props":{..}?}  an array subclass or with own non-index members
//   {"$dr":"escape","value":{...}}              a plain object that has its own "$dr" key
//   {"$dr":"nullproto","value":{...}}           an object without a prototype
//   {"$dr":"symkeys","value":<tree>,"symbols":[[sym, v], ...]}  own enumerable symbol keys
//   {"$dr":"id","n":1,"value":<tree>}           an object that appears more than once in its scope, with its content here
//   {"$dr":"ref","n":1}                         the same object again, later in the same tree (aliasing, cycles)
//   {"$dr":"map","entries":[[k,v],...],"className"?}   insertion order
//   {"$dr":"set","values":[...],"className"?}          insertion order
//   {"$dr":"date","value":<number tree>}
//   {"$dr":"regexp","source":"a+","flags":"gi","lastIndex":<tree>}
//   {"$dr":"bytes","base64":"...","buffer":true?,"className"?,"props"?}   Uint8Array (Buffer marked)
//   {"$dr":"typed","type":"Float64Array","values":[...],"className"?,"props"?}
//   {"$dr":"arraybuffer","base64":"..."}, {"$dr":"dataview","base64":"..."}
//   {"$dr":"url","href":"..."}, {"$dr":"searchparams","entries":[[k, v], ...]}, {"$dr":"headers","entries":[[name, value], ...]}
//   {"$dr":"response","status":503,"statusText":"","url":"","type":"default","redirected":false,"bodyUsed":false,"headers":[[n, v], ...]}
//   {"$dr":"request","method":"GET","url":"...","bodyUsed":false,"headers":[[n, v], ...]}   (bodies are never read)
//   {"$dr":"abortsignal","aborted":true,"reason":<tree>}
//   {"$dr":"symbol","n":1,"description":"x"} | {"$dr":"symbol","key":"k"} | {"$dr":"symbol","wellKnown":"iterator"}
//   {"$dr":"function","name":"f","port":"fetch"?}
//   {"$dr":"accessor","get":true,"set":false}   an own accessor: never invoked
//   {"$dr":"class","name":"Point","value":{own enumerable data members}}      name null: no constructor on the chain
//   {"$dr":"class","name":"Number","primitive":3,"value":{...}}              a boxed Number, String, Boolean or BigInt
//   {"$dr":"class","name":"TypeError","error":{"name":"TypeError","message":"m"},"value":{...},"cause":<tree>?,"errors":<tree>?}
//   {"$dr":"class","name":"DOMException","error":{"name":"AbortError","message":"m","code":20},"value":{...}}
//   {"$dr":"port","name":"sdk"}                 an object the recorder wrapped as a port
//   {"$dr":"promise"}, {"$dr":"weak","type":"WeakMap"}, {"$dr":"opaque","name":"HTMLElement"}  ("Proxy" for a foreign Proxy: flagged)
//   {"$dr":"unencodable","reason":"..."}
//
// Identity. A scope is one tree (`encode`) or an ordered list of trees, the
// slots of one recorded case (`snapshot` each value when it is seen, then
// `emitSlots` them together). In a scope, an object (or unregistered symbol)
// that is reached more than once anywhere is numbered by its first appearance
// in slot order and, inside one slot, depth-first member order. Its first
// appearance in a slot is {"$dr":"id","n":k,"value":<its content when that
// slot was taken>}; a later one in the same slot is {"$dr":"ref","n":k}. So
// every slot decodes alone, and equal n in two slots means the same object
// (with possibly different content, taken at different times). Symbols are
// numbered the same way, independently of objects.
//
// Strings are JSON strings as JSON.stringify writes them (lone surrogates as
// \udXXX); numbers use the JavaScript layout; object members keep the order
// the engine gives them (integer-like keys ascending first, then insertion
// order), so key order is part of the value. Own non-enumerable members other
// than an error's message, cause and errors are not part of a value, as for
// JSON and toEqual. Platform state of platform objects (Map and Set contents,
// a Date's time, an AbortSignal's state, a URL's href, a DOMException's name,
// message and code, a Response's status) is read through the realm's own
// intrinsics captured when this module loads; a user-defined getter is never
// called (an accessor met where a value is needed flags the scope), and a test
// that replaces globalThis.Map later changes nothing here.
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

export const TAG = '$dr';
export const CODEC_VERSION = 3;

// Intrinsics, captured before any test can replace a global.
const ObjectRef = Object;
const { getPrototypeOf, getOwnPropertyDescriptor, defineProperty, create, prototype: ObjectPrototype } = Object;
const { ownKeys, apply, construct } = Reflect;
const ArrayRef = Array;
const { isArray } = Array;
const ArrayPrototype = Array.prototype;
const JSONStringify = JSON.stringify;
const RealMap = Map;
const RealSet = Set;
const RealWeakMap = WeakMap;
const RealWeakSet = WeakSet;
const RealWeakRef = typeof WeakRef === 'function' ? WeakRef : null;
const RealDate = Date;
const RealRegExp = RegExp;
const RealPromise = Promise;
const RealError = Error;
const RealSymbol = Symbol;
const RealArrayBuffer = ArrayBuffer;
const RealDataView = DataView;
const RealUint8Array = Uint8Array;
const RealAbortSignal = typeof AbortSignal === 'function' ? AbortSignal : null;
const RealURL = typeof URL === 'function' ? URL : null;
const RealURLSearchParams = typeof URLSearchParams === 'function' ? URLSearchParams : null;
const RealHeaders = typeof Headers === 'function' ? Headers : null;
const RealResponse = typeof Response === 'function' ? Response : null;
const RealRequest = typeof Request === 'function' ? Request : null;
const RealDOMException = typeof DOMException === 'function' ? DOMException : null;
const BufferRef = typeof Buffer === 'function' ? Buffer : null;
const isProxy = typeof utilTypes?.isProxy === 'function' ? utilTypes.isProxy : () => false;
const MapForEach = Map.prototype.forEach;
const MapSet = Map.prototype.set;
const MapGet = Map.prototype.get;
const MapHas = Map.prototype.has;
const SetForEach = Set.prototype.forEach;
const SetAdd = Set.prototype.add;
const SetHas = Set.prototype.has;
const WeakMapGet = WeakMap.prototype.get;
const WeakMapSet = WeakMap.prototype.set;
const WeakMapHas = WeakMap.prototype.has;
const DateGetTime = Date.prototype.getTime;
const isPrototypeOf = Object.prototype.isPrototypeOf;
const hasOwn = Object.hasOwn;
const SymbolKeyFor = Symbol.keyFor;
const getter = (object, key) => (object ? getOwnPropertyDescriptor(object, key)?.get : undefined);
const symbolDescription = getter(Symbol.prototype, 'description');
const regexpSource = getter(RegExp.prototype, 'source');
const regexpFlags = getter(RegExp.prototype, 'flags');
const typedArrayPrototype = getPrototypeOf(Int8Array.prototype);
const typedArrayTag = getter(typedArrayPrototype, Symbol.toStringTag);
const typedArrayBuffer = getter(typedArrayPrototype, 'buffer');
const typedArrayOffset = getter(typedArrayPrototype, 'byteOffset');
const typedArrayLength = getter(typedArrayPrototype, 'byteLength');
const typedArrayElements = getter(typedArrayPrototype, 'length');
const arrayBufferLength = getter(ArrayBuffer.prototype, 'byteLength');
const dataViewBuffer = getter(DataView.prototype, 'buffer');
const dataViewOffset = getter(DataView.prototype, 'byteOffset');
const dataViewLength = getter(DataView.prototype, 'byteLength');
const abortedGetter = getter(RealAbortSignal?.prototype, 'aborted');
const reasonGetter = getter(RealAbortSignal?.prototype, 'reason');
const urlHref = getter(RealURL?.prototype, 'href');
const searchParamsForEach = RealURLSearchParams?.prototype.forEach;
const headersForEach = RealHeaders?.prototype.forEach;
const domName = getter(RealDOMException?.prototype, 'name');
const domMessage = getter(RealDOMException?.prototype, 'message');
const domCode = getter(RealDOMException?.prototype, 'code');
const RESPONSE_FIELDS = ['status', 'statusText', 'url', 'type', 'redirected', 'bodyUsed'];
const REQUEST_FIELDS = ['method', 'url', 'bodyUsed'];
const responseGetters = RESPONSE_FIELDS.map((key) => [key, getter(RealResponse?.prototype, key)]);
const responseHeaders = getter(RealResponse?.prototype, 'headers');
const requestGetters = REQUEST_FIELDS.map((key) => [key, getter(RealRequest?.prototype, key)]);
const requestHeaders = getter(RealRequest?.prototype, 'headers');
// thisNumberValue and friends: they throw unless the receiver is that boxed primitive.
const BOXES = [['Number', Number, Number.prototype.valueOf], ['String', String, String.prototype.valueOf], ['Boolean', Boolean, Boolean.prototype.valueOf], ['BigInt', BigInt, BigInt.prototype.valueOf]];
const PLATFORM_OPAQUE = ['Node', 'Window', 'EventTarget', 'Event', 'Blob', 'ReadableStream', 'WritableStream', 'MessagePort', 'Worker']
  .map((name) => [name, globalThis[name]]).filter(([, value]) => typeof value === 'function');
const TYPED_ARRAYS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
const TYPED_CONSTRUCTORS = new RealMap(TYPED_ARRAYS.map((name) => [name, globalThis[name]]));
const WELL_KNOWN_SYMBOLS = new RealMap(ownKeys(RealSymbol).filter((key) => typeof RealSymbol[key] === 'symbol').map((key) => [RealSymbol[key], key]));
const WELL_KNOWN_BY_NAME = new RealMap([...WELL_KNOWN_SYMBOLS].map(([symbol, name]) => [name, symbol]));
// Own members of errors that hold the engine's stack or source position
// (JavaScriptCore adds line, column and sourceURL): never part of a value.
const ERROR_POSITION_KEYS = new RealSet(['stack', 'line', 'column', 'sourceURL', 'originalLine', 'originalColumn']);
const MAX_INDEX = 4294967294;

const isIndexKey = (key) => {
  if (typeof key !== 'string' || key === '' || (key.length > 1 && key[0] === '0')) return false;
  for (let index = 0; index < key.length; index += 1) { const code = key.charCodeAt(index); if (code < 48 || code > 57) return false; }
  return key.length < 10 || (key.length === 10 && Number(key) <= MAX_INDEX);
};

/**
 * A codec context: one identity scope (a recorded case). `names` names
 * objects and functions the recorder wrapped as ports; `unwrap` gives what a
 * recorder wrapper stands for; `flags` collects what made a value
 * unrecordable (an accessor, a foreign Proxy, an unencodable value).
 */
export function createCodecContext({ names, unwrap } = {}) {
  return { tokens: new RealWeakMap(), symbolsByOrdinal: new RealMap(), names: names ?? new RealWeakMap(), unwrap: unwrap ?? null, leaves: new RealWeakMap(), flags: new RealSet() };
}

/** How `key` resolves on `object` or its prototype chain, never calling a getter. */
function lookup(object, key) {
  for (let current = object, depth = 0; current !== null && depth < 64; current = getPrototypeOf(current), depth += 1) {
    const descriptor = getOwnPropertyDescriptor(current, key);
    if (descriptor) return hasOwn(descriptor, 'value') ? { value: descriptor.value } : { accessor: true };
  }
  return null;
}

function constructorName(object) {
  const prototype = getPrototypeOf(object);
  if (prototype === null) return null;
  const constructor = lookup(prototype, 'constructor')?.value;
  if (typeof constructor !== 'function') return null;
  const name = getOwnPropertyDescriptor(constructor, 'name');
  return name && hasOwn(name, 'value') && typeof name.value === 'string' ? name.value : '';
}

function functionName(fn) {
  const descriptor = getOwnPropertyDescriptor(fn, 'name');
  return descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : '';
}

const numberTree = (value) => {
  if (value !== value) return { [TAG]: 'number', value: 'NaN' };
  if (value === Infinity) return { [TAG]: 'number', value: 'Infinity' };
  if (value === -Infinity) return { [TAG]: 'number', value: '-Infinity' };
  if (value === 0 && 1 / value < 0) return { [TAG]: 'number', value: '-0' };
  return value;
};

function base64(bytes) {
  if (BufferRef) return BufferRef.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

const defineMember = (target, key, value) => defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

// Snapshot slots: an object node (identity token, how often this snapshot
// reached it, its body) or an unregistered symbol. Everything else is a tree.
class ObjectNode { constructor(token) { this.token = token; this.seen = 1; this.body = null; } }
class SymbolNode { constructor(symbol) { this.symbol = symbol; } }

function tokenOf(context, item) {
  let token = apply(WeakMapGet, context.tokens, [item]);
  if (token === undefined) { token = {}; apply(WeakMapSet, context.tokens, [item, token]); }
  return token;
}

/**
 * Takes a value's content now, keeping object identity open: the result is
 * emitted with `emitSlots`, alone or together with the other slots of its scope.
 */
export function snapshot(value, context = createCodecContext()) {
  const nodes = new RealMap(); // object -> node
  const symbolSlot = (symbol) => {
    const wellKnown = apply(MapGet, WELL_KNOWN_SYMBOLS, [symbol]);
    if (wellKnown !== undefined) return { [TAG]: 'symbol', wellKnown };
    const key = SymbolKeyFor(symbol);
    if (key !== undefined) return { [TAG]: 'symbol', key };
    return new SymbolNode(symbol);
  };
  const flagged = (flag, tree) => { context.flags.add(flag); return { kind: 'leaf', tree }; };
  const build = (item) => {
    if (item === undefined) return { [TAG]: 'undefined' };
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') return numberTree(item);
    if (typeof item === 'bigint') return { [TAG]: 'bigint', value: item.toString() };
    if (typeof item === 'symbol') return symbolSlot(item);
    const existing = apply(MapGet, nodes, [item]);
    if (existing) { existing.seen += 1; return existing; }
    const node = new ObjectNode(tokenOf(context, item));
    apply(MapSet, nodes, [item, node]);
    try {
      node.body = describe(item);
    } catch (error) {
      node.body = flagged('unencodable', { [TAG]: 'unencodable', reason: String(error?.message ?? error) });
    }
    return node;
  };
  const accessorSlot = (descriptor) => {
    context.flags.add('accessor');
    return { [TAG]: 'accessor', get: typeof descriptor.get === 'function', set: typeof descriptor.set === 'function' };
  };
  // A node body names the shape of one object; child slots are built eagerly.
  const members = (object, { skip } = {}) => {
    const entries = [];
    const symbols = [];
    for (const key of ownKeys(object)) {
      if (skip?.(key)) continue;
      const descriptor = getOwnPropertyDescriptor(object, key);
      if (!descriptor) continue;
      if (!hasOwn(descriptor, 'value')) {
        const slot = accessorSlot(descriptor);
        if (typeof key === 'symbol') symbols.push([symbolSlot(key), slot]); else entries.push([key, slot]);
        continue;
      }
      if (!descriptor.enumerable) continue;
      if (typeof key === 'symbol') symbols.push([symbolSlot(key), build(descriptor.value)]);
      else entries.push([key, build(descriptor.value)]);
    }
    return { entries, symbols };
  };
  const noIndex = (key) => key === 'length' || isIndexKey(key);
  // Typed and byte views: a subclass name and own non-index members, as for arrays.
  const viewExtras = (item, type) => {
    const name = constructorName(item);
    return { className: name === type || (type === 'Uint8Array' && name === 'Buffer' && BufferRef?.isBuffer(item)) ? null : name, rest: members(item, { skip: noIndex }) };
  };
  const errorField = (item, key) => {
    const found = lookup(item, key);
    if (!found) return '';
    if (found.accessor) { context.flags.add('accessor'); return ''; }
    return found.value;
  };
  const describe = (item) => {
    const leaf = apply(WeakMapGet, context.leaves, [item]);
    if (leaf !== undefined) {
      if (leaf[TAG] === 'unencodable') context.flags.add('unencodable');
      if (leaf[TAG] === 'opaque' && leaf.name === 'Proxy') context.flags.add('proxy');
      return { kind: 'leaf', tree: leaf };
    }
    const named = apply(WeakMapGet, context.names, [item]);
    if (named !== undefined && typeof item !== 'function') return { kind: 'leaf', tree: { [TAG]: 'port', name: named } };
    const raw = context.unwrap ? context.unwrap(item) : undefined;
    if (raw !== undefined && raw !== item && named === undefined) return describeRaw(raw);
    if (isProxy(item) && named === undefined) return flagged('proxy', { [TAG]: 'opaque', name: 'Proxy' });
    if (typeof item === 'function') {
      const name = functionName(raw ?? item);
      return { kind: 'leaf', tree: named !== undefined ? { [TAG]: 'function', name, port: named } : { [TAG]: 'function', name } };
    }
    return describeObject(item);
  };
  // What a recorder wrapper stands for, described in place of the wrapper (same node, same identity).
  const describeRaw = (raw) => (typeof raw === 'function' ? { kind: 'leaf', tree: { [TAG]: 'function', name: functionName(raw) } } : describeObject(raw));
  const describeObject = (item) => {
    if (isArray(item)) {
      const items = [];
      const length = getOwnPropertyDescriptor(item, 'length').value;
      let next = 0;
      // Own index keys come first, ascending: O(own members), not O(length).
      for (const key of ownKeys(item)) {
        if (!isIndexKey(key)) continue;
        const index = Number(key);
        if (index >= length) continue;
        if (index > next) items.push({ [TAG]: 'hole', n: index - next });
        const descriptor = getOwnPropertyDescriptor(item, key);
        items.push(hasOwn(descriptor, 'value') ? build(descriptor.value) : accessorSlot(descriptor));
        next = index + 1;
      }
      if (length > next) items.push({ [TAG]: 'hole', n: length - next });
      const prototype = getPrototypeOf(item);
      return { kind: 'array', items, rest: members(item, { skip: noIndex }), className: prototype === ArrayPrototype ? null : (constructorName(item) ?? '') };
    }
    const prototype = getPrototypeOf(item);
    if (prototype === ObjectPrototype || prototype === null) return { kind: 'object', nullProto: prototype === null, ...members(item) };
    if (apply(isPrototypeOf, RealMap.prototype, [item])) {
      const entries = [];
      apply(MapForEach, item, [(entry, key) => { entries.push([build(key), build(entry)]); }]);
      return { kind: 'map', entries, className: constructorName(item) };
    }
    if (apply(isPrototypeOf, RealSet.prototype, [item])) {
      const values = [];
      apply(SetForEach, item, [(entry) => { values.push(build(entry)); }]);
      return { kind: 'set', values, className: constructorName(item) };
    }
    if (apply(isPrototypeOf, RealDate.prototype, [item])) return { kind: 'leaf', tree: { [TAG]: 'date', value: numberTree(apply(DateGetTime, item, [])) } };
    if (apply(isPrototypeOf, RealRegExp.prototype, [item])) {
      const lastIndex = getOwnPropertyDescriptor(item, 'lastIndex');
      return { kind: 'regexp', source: apply(regexpSource, item, []), flags: apply(regexpFlags, item, []), lastIndex: lastIndex && hasOwn(lastIndex, 'value') ? build(lastIndex.value) : 0 };
    }
    if (apply(isPrototypeOf, typedArrayPrototype, [item])) {
      const type = apply(typedArrayTag, item, []);
      if (type === 'Uint8Array') {
        const bytes = new RealUint8Array(apply(typedArrayBuffer, item, []), apply(typedArrayOffset, item, []), apply(typedArrayLength, item, []));
        const tree = { [TAG]: 'bytes', base64: base64(bytes) };
        if (BufferRef && BufferRef.isBuffer(item)) tree.buffer = true;
        return { kind: 'view', tree, ...viewExtras(item, type) };
      }
      const length = apply(typedArrayElements, item, []);
      const view = new (apply(MapGet, TYPED_CONSTRUCTORS, [type]))(apply(typedArrayBuffer, item, []), apply(typedArrayOffset, item, []), length);
      const values = [];
      for (let index = 0; index < length; index += 1) {
        const entry = view[index];
        values.push(typeof entry === 'bigint' ? { [TAG]: 'bigint', value: entry.toString() } : numberTree(entry));
      }
      return { kind: 'view', tree: { [TAG]: 'typed', type, values }, ...viewExtras(item, type) };
    }
    if (apply(isPrototypeOf, RealArrayBuffer.prototype, [item])) {
      return { kind: 'leaf', tree: { [TAG]: 'arraybuffer', base64: base64(new RealUint8Array(item, 0, apply(arrayBufferLength, item, []))) } };
    }
    if (apply(isPrototypeOf, RealDataView.prototype, [item])) {
      return { kind: 'leaf', tree: { [TAG]: 'dataview', base64: base64(new RealUint8Array(apply(dataViewBuffer, item, []), apply(dataViewOffset, item, []), apply(dataViewLength, item, []))) } };
    }
    if (apply(isPrototypeOf, RealPromise.prototype, [item])) return { kind: 'leaf', tree: { [TAG]: 'promise' } };
    if (apply(isPrototypeOf, RealWeakMap.prototype, [item])) return { kind: 'leaf', tree: { [TAG]: 'weak', type: 'WeakMap' } };
    if (apply(isPrototypeOf, RealWeakSet.prototype, [item])) return { kind: 'leaf', tree: { [TAG]: 'weak', type: 'WeakSet' } };
    if (RealWeakRef && apply(isPrototypeOf, RealWeakRef.prototype, [item])) return { kind: 'leaf', tree: { [TAG]: 'weak', type: 'WeakRef' } };
    if (abortedGetter && apply(isPrototypeOf, RealAbortSignal.prototype, [item])) {
      return { kind: 'signal', aborted: apply(abortedGetter, item, []), reason: build(apply(reasonGetter, item, [])) };
    }
    if (urlHref && apply(isPrototypeOf, RealURL.prototype, [item])) return { kind: 'leaf', tree: { [TAG]: 'url', href: apply(urlHref, item, []) } };
    if (searchParamsForEach && apply(isPrototypeOf, RealURLSearchParams.prototype, [item])) {
      const entries = [];
      apply(searchParamsForEach, item, [(entry, name) => { entries.push([name, entry]); }]);
      return { kind: 'leaf', tree: { [TAG]: 'searchparams', entries } };
    }
    const headerEntries = (headers) => { const entries = []; apply(headersForEach, headers, [(entry, name) => { entries.push([name, entry]); }]); return entries; };
    if (headersForEach && apply(isPrototypeOf, RealHeaders.prototype, [item])) return { kind: 'leaf', tree: { [TAG]: 'headers', entries: headerEntries(item) } };
    if (responseHeaders && apply(isPrototypeOf, RealResponse.prototype, [item])) {
      const tree = { [TAG]: 'response' };
      for (const [key, get] of responseGetters) tree[key] = apply(get, item, []);
      tree.headers = headerEntries(apply(responseHeaders, item, []));
      return { kind: 'leaf', tree };
    }
    if (requestHeaders && apply(isPrototypeOf, RealRequest.prototype, [item])) {
      const tree = { [TAG]: 'request' };
      for (const [key, get] of requestGetters) tree[key] = apply(get, item, []);
      tree.headers = headerEntries(apply(requestHeaders, item, []));
      return { kind: 'leaf', tree };
    }
    for (const [name, constructor] of PLATFORM_OPAQUE) {
      if (apply(isPrototypeOf, constructor.prototype, [item])) return { kind: 'leaf', tree: { [TAG]: 'opaque', name: constructorName(item) ?? name } };
    }
    const name = constructorName(item);
    if (domName && apply(isPrototypeOf, RealDOMException.prototype, [item])) {
      return {
        kind: 'class', name,
        error: { name: apply(domName, item, []), message: apply(domMessage, item, []), code: apply(domCode, item, []) },
        ...members(item, { skip: (key) => ERROR_POSITION_KEYS.has(key) }),
      };
    }
    if (apply(isPrototypeOf, RealError.prototype, [item])) {
      const errorName = errorField(item, 'name');
      const message = errorField(item, 'message');
      const cause = getOwnPropertyDescriptor(item, 'cause');
      const errors = getOwnPropertyDescriptor(item, 'errors');
      return {
        kind: 'class', name,
        error: { name: typeof errorName === 'string' ? errorName : '', message: typeof message === 'string' ? message : String(message) },
        cause: cause && hasOwn(cause, 'value') ? build(cause.value) : undefined,
        errors: errors && hasOwn(errors, 'value') && !errors.enumerable ? build(errors.value) : undefined,
        ...members(item, { skip: (key) => ERROR_POSITION_KEYS.has(key) || key === 'message' || key === 'cause' }),
      };
    }
    for (const [base, , valueOf] of BOXES) {
      let primitive;
      try { primitive = apply(valueOf, item, []); } catch { continue; }
      const skip = base === 'String' ? (key) => key === 'length' || (isIndexKey(key) && Number(key) < primitive.length) : undefined;
      return { kind: 'class', name, primitive: build(primitive), ...members(item, { skip }) };
    }
    return { kind: 'class', name, ...members(item) };
  };
  return { root: build(value), nodes };
}

/**
 * Emits snapshots of one scope as trees, in order: identity numbered across
 * all of them by first appearance (see the header). Pure: a snapshot can be
 * emitted again, in another scope, with the same result for the same scope.
 */
export function emitSlots(snapshots) {
  const totals = new RealMap(); // token -> sights across the scope
  for (const { nodes } of snapshots) {
    apply(MapForEach, nodes, [(node) => { apply(MapSet, totals, [node.token, (apply(MapGet, totals, [node.token]) ?? 0) + node.seen]); }]);
  }
  const numbers = new RealMap(); // token -> n
  const symbols = new RealMap(); // symbol -> n
  let nextNumber = 0;
  return snapshots.map(({ root }) => {
    const here = new RealSet(); // tokens already written in this slot
    const symbolTree = (slot) => {
      let ordinal = apply(MapGet, symbols, [slot.symbol]);
      if (ordinal === undefined) { ordinal = symbols.size + 1; apply(MapSet, symbols, [slot.symbol, ordinal]); }
      const description = apply(symbolDescription, slot.symbol, []);
      return description === undefined ? { [TAG]: 'symbol', n: ordinal } : { [TAG]: 'symbol', n: ordinal, description };
    };
    const emit = (slot) => {
      if (slot instanceof SymbolNode) return symbolTree(slot);
      if (!(slot instanceof ObjectNode)) return slot;
      if (apply(MapGet, totals, [slot.token]) > 1) {
        let n = apply(MapGet, numbers, [slot.token]);
        if (n === undefined) { nextNumber += 1; n = nextNumber; apply(MapSet, numbers, [slot.token, n]); }
        if (apply(SetHas, here, [slot.token])) return { [TAG]: 'ref', n };
        apply(SetAdd, here, [slot.token]);
        return { [TAG]: 'id', n, value: emitBody(slot.body) };
      }
      return emitBody(slot.body);
    };
    const emitMembers = (entries) => {
      const out = {};
      for (const [key, slot] of entries) defineMember(out, key, emit(slot));
      return out;
    };
    const withSymbols = (tree, list) => (list.length ? { [TAG]: 'symkeys', value: tree, symbols: list.map(([key, slot]) => [emit(key), emit(slot)]) } : tree);
    const emitBody = (body) => {
      switch (body.kind) {
        case 'leaf': return body.tree;
        case 'object': {
          const out = emitMembers(body.entries);
          const tree = body.nullProto ? { [TAG]: 'nullproto', value: out } : hasOwn(out, TAG) ? { [TAG]: 'escape', value: out } : out;
          return withSymbols(tree, body.symbols);
        }
        case 'array': {
          const items = body.items.map(emit);
          if (body.className === null && body.rest.entries.length === 0) return withSymbols(items, body.rest.symbols);
          const tree = { [TAG]: 'array', items };
          if (body.className !== null) tree.className = body.className;
          if (body.rest.entries.length) tree.props = emitMembers(body.rest.entries);
          return withSymbols(tree, body.rest.symbols);
        }
        case 'view': {
          const tree = { ...body.tree };
          if (body.className !== null) tree.className = body.className;
          if (body.rest.entries.length) tree.props = emitMembers(body.rest.entries);
          return withSymbols(tree, body.rest.symbols);
        }
        case 'map': {
          const tree = { [TAG]: 'map', entries: body.entries.map(([key, entry]) => [emit(key), emit(entry)]) };
          if (body.className !== 'Map') tree.className = body.className;
          return tree;
        }
        case 'set': {
          const tree = { [TAG]: 'set', values: body.values.map(emit) };
          if (body.className !== 'Set') tree.className = body.className;
          return tree;
        }
        case 'regexp': return { [TAG]: 'regexp', source: body.source, flags: body.flags, lastIndex: emit(body.lastIndex) };
        case 'signal': return { [TAG]: 'abortsignal', aborted: body.aborted, reason: emit(body.reason) };
        case 'class': {
          const tree = { [TAG]: 'class', name: body.name };
          if (body.error) tree.error = body.error;
          if (body.primitive !== undefined) tree.primitive = emit(body.primitive);
          tree.value = emitMembers(body.entries);
          if (body.cause !== undefined) tree.cause = emit(body.cause);
          if (body.errors !== undefined) tree.errors = emit(body.errors);
          return withSymbols(tree, body.symbols);
        }
        default: throw new TypeError(`client-conformance codec: unknown node ${body.kind}`);
      }
    };
    return emit(root);
  });
}

/** Encodes `value` into a tree: a scope of one slot. */
export function encode(value, context = createCodecContext()) {
  return emitSlots([snapshot(value, context)])[0];
}

/** Canonical bytes of a tree: JSON.stringify keeps member order and escapes lone surrogates. */
export const stringifyTree = (tree) => JSONStringify(tree);
/** Canonical text of a value. */
export const encodeText = (value, context) => stringifyTree(encode(value, context));
/** Content address of canonical text: 16 hex digits of its SHA-256. */
export const hashText = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

// ---------------------------------------------------------------- the reader

// The members each tag may carry, in canonical order; `required` must be there.
const SHAPES = {
  undefined: { keys: [] }, number: { keys: ['value'], required: ['value'] }, bigint: { keys: ['value'], required: ['value'] }, hole: { keys: ['n'], required: ['n'] },
  array: { keys: ['items', 'className', 'props'], required: ['items'] }, escape: { keys: ['value'], required: ['value'] }, nullproto: { keys: ['value'], required: ['value'] },
  symkeys: { keys: ['value', 'symbols'], required: ['value', 'symbols'] }, id: { keys: ['n', 'value'], required: ['n', 'value'] }, ref: { keys: ['n'], required: ['n'] },
  map: { keys: ['entries', 'className'], required: ['entries'] }, set: { keys: ['values', 'className'], required: ['values'] }, date: { keys: ['value'], required: ['value'] },
  regexp: { keys: ['source', 'flags', 'lastIndex'], required: ['source', 'flags', 'lastIndex'] },
  bytes: { keys: ['base64', 'buffer', 'className', 'props'], required: ['base64'] }, typed: { keys: ['type', 'values', 'className', 'props'], required: ['type', 'values'] },
  arraybuffer: { keys: ['base64'], required: ['base64'] }, dataview: { keys: ['base64'], required: ['base64'] }, url: { keys: ['href'], required: ['href'] },
  searchparams: { keys: ['entries'], required: ['entries'] }, headers: { keys: ['entries'], required: ['entries'] },
  response: { keys: ['status', 'statusText', 'url', 'type', 'redirected', 'bodyUsed', 'headers'], required: ['status', 'statusText', 'url', 'type', 'redirected', 'bodyUsed', 'headers'] },
  request: { keys: ['method', 'url', 'bodyUsed', 'headers'], required: ['method', 'url', 'bodyUsed', 'headers'] },
  abortsignal: { keys: ['aborted', 'reason'], required: ['aborted', 'reason'] }, symbol: { keys: ['n', 'description', 'key', 'wellKnown'] },
  function: { keys: ['name', 'port'], required: ['name'] }, accessor: { keys: ['get', 'set'], required: ['get', 'set'] },
  class: { keys: ['name', 'error', 'primitive', 'value', 'cause', 'errors'], required: ['name', 'value'] }, port: { keys: ['name'], required: ['name'] },
  promise: { keys: [] }, weak: { keys: ['type'], required: ['type'] }, opaque: { keys: ['name'], required: ['name'] }, unencodable: { keys: ['reason'], required: ['reason'] },
};
const NUMBER_WORDS = new RealSet(['NaN', 'Infinity', '-Infinity', '-0']);

/** Refuses a tagged node that is not in canonical form (unknown, misplaced or missing members, impossible values). */
function checkShape(item) {
  const kind = item[TAG];
  const shape = SHAPES[kind];
  if (!shape) throw new TypeError(`client-conformance codec: unknown tag ${String(kind)}`);
  const keys = ObjectRef.keys(item).filter((key) => key !== TAG);
  if (ObjectRef.keys(item)[0] !== TAG) throw new TypeError(`client-conformance codec: "${TAG}" must come first in ${kind}`);
  let position = -1;
  for (const key of keys) {
    const at = shape.keys.indexOf(key);
    if (at < 0) throw new TypeError(`client-conformance codec: ${kind} has no member ${key}`);
    if (at < position) throw new TypeError(`client-conformance codec: ${kind} members out of order`);
    position = at;
  }
  for (const key of shape.required ?? []) if (!hasOwn(item, key)) throw new TypeError(`client-conformance codec: ${kind} needs ${key}`);
  const fail = (what) => { throw new TypeError(`client-conformance codec: ${kind} ${what}`); };
  if (kind === 'number' && !apply(SetHas, NUMBER_WORDS, [item.value])) fail(`value ${JSONStringify(item.value)} is written as a plain number`);
  if (kind === 'bigint' && (typeof item.value !== 'string' || !/^(?:0|-?[1-9]\d*)$/.test(item.value))) fail('value is not canonical');
  if ((kind === 'hole' || kind === 'id' || kind === 'ref') && (!Number.isInteger(item.n) || item.n < 1)) fail('n must be a positive integer');
  if (kind === 'escape' && (item.value === null || typeof item.value !== 'object' || isArray(item.value) || !hasOwn(item.value, TAG))) fail('value has no own tag key');
  if ((kind === 'map' && item.className === 'Map') || (kind === 'set' && item.className === 'Set')) fail('className repeats the base class');
  if (hasOwn(item, 'props') && (item.props === null || typeof item.props !== 'object' || ObjectRef.keys(item.props).length === 0)) fail('props is empty');
  if (kind === 'symkeys' && (!isArray(item.symbols) || item.symbols.length === 0)) fail('symbols is empty');
  if (kind === 'array' && !hasOwn(item, 'className') && !hasOwn(item, 'props')) fail('is a plain array');
  if (kind === 'symbol' && [hasOwn(item, 'n'), hasOwn(item, 'key'), hasOwn(item, 'wellKnown')].filter(Boolean).length !== 1) fail('needs exactly one of n, key, wellKnown');
}

const syntheticClasses = new RealMap();
function syntheticClass(name, error) {
  const key = `${error ? 'error' : 'class'}:${name}`;
  if (!syntheticClasses.has(key)) {
    const Base = error ? RealError : ObjectRef;
    const made = { [name]: class extends Base {} }[name];
    syntheticClasses.set(key, made);
  }
  return syntheticClasses.get(key);
}
const CONSTRUCTORLESS = create(null);

function errorPrototype(name, errorName) {
  const native = globalThis[name];
  if (typeof native === 'function' && (native === RealError || apply(isPrototypeOf, RealError.prototype, [native.prototype])) && functionName(native) === name) {
    if (lookup(native.prototype, 'name')?.value === errorName) return native.prototype;
  }
  const made = syntheticClass(name, true);
  if (lookup(made.prototype, 'name')?.value !== errorName) defineProperty(made.prototype, 'name', { value: errorName, writable: true, configurable: true, enumerable: false });
  return made.prototype;
}

/** A function that stands for a recorded one; calling it is a harness error. */
function recordedFunction(name) {
  const made = { [name]: function () { throw new TypeError(`client-conformance: ${name || 'anonymous'} is a recorded function`); } }[name];
  if (functionName(made) !== name) defineProperty(made, 'name', { value: name, configurable: true });
  return made;
}

const BOX_BASES = new RealMap(BOXES.map(([name, constructor]) => [name, constructor]));
function boxed(name, primitive) {
  const baseName = typeof primitive === 'number' ? 'Number' : typeof primitive === 'string' ? 'String' : typeof primitive === 'boolean' ? 'Boolean' : 'BigInt';
  const box = ObjectRef(primitive);
  if (name === baseName) return box;
  const Sub = subclassOf(apply(MapGet, BOX_BASES, [baseName]), name);
  ObjectRef.setPrototypeOf(box, Sub.prototype);
  return box;
}

/**
 * Decodes a tree into a value. Symbols are recreated per context (ordinal n
 * is the same symbol everywhere in one context); functions and ports become
 * stand-ins that `context.names` keeps naming, so re-encoding gives the same
 * bytes. Objects decoded from an `id` n carry identity token n of the
 * context, so the slots of one scope decoded with one context re-emit
 * (`emitSlots`) to the same identity numbers. A tree not in canonical form is
 * refused.
 */
export function decode(tree, context = createCodecContext()) {
  if (!context.idTokens) context.idTokens = new RealMap();
  const ids = new RealMap();
  const scopeToken = (n) => {
    let token = apply(MapGet, context.idTokens, [n]);
    if (!token) { token = {}; apply(MapSet, context.idTokens, [n, token]); }
    return token;
  };
  const visit = (item) => {
    if (item === null || typeof item !== 'object') return item;
    if (isArray(item)) return arrayFrom(item, []);
    if (!hasOwn(item, TAG)) return objectFrom(item, {});
    checkShape(item);
    const kind = item[TAG];
    switch (kind) {
      case 'undefined': return undefined;
      case 'number': return item.value === '-0' ? -0 : Number(item.value);
      case 'bigint': return BigInt(item.value);
      case 'id': {
        if (apply(MapHas, ids, [item.n])) throw new TypeError(`client-conformance codec: id ${item.n} twice in one tree`);
        const placeholder = placeholderFor(item.value);
        if (placeholder !== undefined) apply(MapSet, ids, [item.n, placeholder]);
        const result = fill(item.value, placeholder);
        if (result === null || (typeof result !== 'object' && typeof result !== 'function')) throw new TypeError('client-conformance codec: id of a primitive');
        apply(MapSet, ids, [item.n, result]);
        apply(WeakMapSet, context.tokens, [result, scopeToken(item.n)]);
        return result;
      }
      case 'ref': {
        if (!apply(MapHas, ids, [item.n])) throw new TypeError(`client-conformance codec: ref ${item.n} before its id`);
        return apply(MapGet, ids, [item.n]);
      }
      default: return fill(item, placeholderFor(item));
    }
  };
  const placeholderFor = (item) => {
    if (item === null || typeof item !== 'object') return undefined;
    if (isArray(item)) return [];
    if (hasOwn(item, TAG)) checkShape(item);
    switch (item[TAG]) {
      case undefined: case 'escape': return {};
      case 'nullproto': return create(null);
      case 'array': return hasOwn(item, 'className') ? arrayOfClass(item.className) : [];
      case 'map': return hasOwn(item, 'className') ? classInstance(RealMap, item.className) : new RealMap();
      case 'set': return hasOwn(item, 'className') ? classInstance(RealSet, item.className) : new RealSet();
      case 'class': {
        if (item.error && item.name === 'DOMException' && RealDOMException) return new RealDOMException(item.error.message, item.error.name);
        if (item.error) return create(errorPrototype(item.name, item.error.name));
        if (hasOwn(item, 'primitive')) return boxed(item.name, visit(item.primitive));
        if (item.name === null) return create(CONSTRUCTORLESS);
        return create(syntheticClass(item.name).prototype);
      }
      case 'symkeys': return placeholderFor(item.value);
      default: return undefined;
    }
  };
  const viewMembers = (item, made) => {
    if (hasOwn(item, 'className')) ObjectRef.setPrototypeOf(made, subclassOf(getPrototypeOf(made).constructor, item.className).prototype);
    if (item.props) objectFrom(item.props, made);
    return made;
  };
  const fill = (item, target) => {
    if (isArray(item)) return arrayFrom(item, target);
    if (hasOwn(item, TAG)) checkShape(item);
    switch (item[TAG]) {
      case undefined: return objectFrom(item, target);
      case 'escape': case 'nullproto': return objectFrom(item.value, target);
      case 'symkeys': {
        const result = fill(item.value, target);
        for (const [key, entry] of item.symbols) memberValue(result, visit(key), entry);
        return result;
      }
      case 'array': {
        arrayFrom(item.items, target);
        if (item.props) objectFrom(item.props, target);
        return target;
      }
      case 'map': for (const [key, entry] of item.entries) apply(MapSet, target, [visit(key), visit(entry)]); return target;
      case 'set': for (const entry of item.values) apply(SetAdd, target, [visit(entry)]); return target;
      case 'class': {
        if (item.error && item.name !== 'DOMException') defineProperty(target, 'message', { value: item.error.message, writable: true, configurable: true, enumerable: false });
        objectFrom(item.value, target);
        if (hasOwn(item, 'cause')) defineProperty(target, 'cause', { value: visit(item.cause), writable: true, configurable: true, enumerable: false });
        if (hasOwn(item, 'errors')) defineProperty(target, 'errors', { value: visit(item.errors), writable: true, configurable: true, enumerable: false });
        return target;
      }
      case 'hole': throw new TypeError('client-conformance codec: a hole outside an array');
      case 'date': return new RealDate(visit(item.value));
      case 'regexp': { const made = new RealRegExp(item.source, item.flags); made.lastIndex = visit(item.lastIndex); return made; }
      case 'bytes': { const bytes = BufferRef.from(item.base64, 'base64'); return viewMembers(item, item.buffer ? bytes : new RealUint8Array(bytes)); }
      case 'arraybuffer': { const bytes = new RealUint8Array(BufferRef.from(item.base64, 'base64')); return bytes.buffer; }
      case 'dataview': { const bytes = new RealUint8Array(BufferRef.from(item.base64, 'base64')); return new RealDataView(bytes.buffer); }
      case 'typed': { const Constructor = apply(MapGet, TYPED_CONSTRUCTORS, [item.type]); return viewMembers(item, new Constructor(item.values.map(visit))); }
      case 'url': return new RealURL(item.href);
      case 'searchparams': return new RealURLSearchParams(item.entries);
      case 'headers': return new RealHeaders(item.entries);
      case 'response': case 'request': {
        // A stand-in that re-encodes to this tree; bodies were never recorded.
        const made = create(null);
        apply(WeakMapSet, context.leaves, [made, item]);
        return made;
      }
      case 'abortsignal': return item.aborted ? RealAbortSignal.abort(visit(item.reason)) : new AbortController().signal;
      case 'symbol': {
        if (item.wellKnown !== undefined) return WELL_KNOWN_BY_NAME.get(item.wellKnown);
        if (item.key !== undefined) return RealSymbol.for(item.key);
        let symbol = context.symbolsByOrdinal.get(item.n);
        if (!symbol) {
          symbol = hasOwn(item, 'description') ? RealSymbol(item.description) : RealSymbol();
          context.symbolsByOrdinal.set(item.n, symbol);
        }
        return symbol;
      }
      case 'function': {
        const made = recordedFunction(item.name);
        if (hasOwn(item, 'port')) apply(WeakMapSet, context.names, [made, item.port]);
        return made;
      }
      case 'port': { const made = {}; apply(WeakMapSet, context.names, [made, item.name]); return made; }
      case 'accessor': throw new TypeError('client-conformance codec: an accessor outside an object');
      case 'promise': return new RealPromise(() => {});
      case 'weak': return item.type === 'WeakMap' ? new RealWeakMap() : item.type === 'WeakSet' ? new RealWeakSet() : new RealWeakRef({});
      case 'opaque': case 'unencodable': {
        const made = create(null);
        apply(WeakMapSet, context.leaves, [made, item]);
        return made;
      }
      default: throw new TypeError(`client-conformance codec: unknown tag ${item[TAG]}`);
    }
  };
  const memberValue = (target, key, entry) => {
    if (entry !== null && typeof entry === 'object' && !isArray(entry) && entry[TAG] === 'accessor') {
      checkShape(entry);
      const descriptor = { enumerable: true, configurable: true };
      if (entry.get) descriptor.get = function recordedGetter() { throw new TypeError('client-conformance: a recorded accessor'); };
      if (entry.set) descriptor.set = function recordedSetter() {};
      if (!entry.get && !entry.set) descriptor.get = undefined;
      defineProperty(target, key, descriptor);
      return;
    }
    defineMember(target, key, visit(entry));
  };
  const objectFrom = (item, target) => {
    for (const key of ownKeys(item)) memberValue(target, key, item[key]);
    return target;
  };
  const arrayFrom = (items, target) => {
    let index = 0;
    for (const entry of items) {
      if (entry !== null && typeof entry === 'object' && !isArray(entry) && entry[TAG] === 'hole') { checkShape(entry); index += entry.n; target.length = index; continue; }
      memberValue(target, String(index), entry);
      index += 1;
    }
    target.length = index;
    return target;
  };
  return visit(tree);
}

/** Decodes the slots of one scope with one context, so `emitSlots(values.map(snapshot))` gives the same trees. */
export function decodeSlots(trees, context = createCodecContext()) {
  return trees.map((tree) => decode(tree, context));
}

const subclasses = new RealMap();
function subclassOf(Base, name) {
  const key = `${functionName(Base)}:${name}`;
  if (!subclasses.has(key)) subclasses.set(key, { [name]: class extends Base {} }[name]);
  return subclasses.get(key);
}
function classInstance(Base, name) {
  if (name === null) { const made = new Base(); ObjectRef.setPrototypeOf(made, create(CONSTRUCTORLESS)); return made; }
  return construct(subclassOf(Base, name), []);
}
function arrayOfClass(name) { return classInstance(ArrayRef, name); }

/** Parses canonical text back into a tree (JSON). */
export const parseTree = (text) => JSON.parse(text);
