// The vector rows' encoding, shared by the generator and the contract test.
//
// A value is JSON with tags for what JSON cannot hold: {"$":"undefined"},
// {"$":"NaN"}, {"$":"Infinity"}, {"$":"-Infinity"}, {"$":"-0"}, and an object
// that has its own "$" key as {"$":"object","entries":[[key, value], ...]}.
// Object keys keep their enumeration order; strings are JSON strings, so lone
// surrogates are \udxxx escapes, and a string of at least 64 code units made
// of at most 8 runs of one repeated unit is {"$":"runs","runs":[[unit, count], ...]}.
// An array made by `repeated(value, count)` is {"$":"repeat","value":v,"count":n}.
// Inputs may also be {"$":"base","name":n,"ops":[...]}: a copy of the file's base value n with the ops applied in order
// (["set", path, value], ["delete", path], ["push", path, value]; a path is
// an array of keys and array indices). A result that is the call's own
// argument i (a validator returning its input) is {"$":"arg","index":i}.
//
// One line per row: {"base": name, "value": v} defines a base;
// {"fn": name, "args": [...], "ok": v} or {"fn", "args", "throw": {"name",
// "message", "code"?}} is a call and the JavaScript's outcome; a row with
// "refuse": true is one the Rust must refuse (an input outside the port).

const REPEATS = new WeakMap();

/** `count` copies of `value` in one array, written once in a row. */
export function repeated(value, count) {
  const array = Array(count).fill(value);
  REPEATS.set(array, { value, count });
  return array;
}

/** A long string as its runs of one code unit, or null when that is not shorter. */
function runsOf(text) {
  if (text.length < 64) return null;
  const runs = [];
  for (let index = 0; index < text.length; index += 1) {
    const last = runs.at(-1);
    if (last && last[0] === text[index]) last[1] += 1;
    else if (runs.push([text[index], 1]) > 8) return null;
  }
  return runs;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The tagged form of a JavaScript value. */
export function encode(value) {
  if (value === undefined) return { $: 'undefined' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $: 'NaN' };
    if (value === Infinity) return { $: 'Infinity' };
    if (value === -Infinity) return { $: '-Infinity' };
    if (Object.is(value, -0)) return { $: '-0' };
    return value;
  }
  if (typeof value === 'string') {
    const runs = runsOf(value);
    return runs ? { $: 'runs', runs } : value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (REPEATS.has(value)) {
      const { value: item, count } = REPEATS.get(value);
      return { $: 'repeat', value: encode(item), count };
    }
    if (Object.keys(value).length !== value.length) throw new TypeError('vector arrays have no holes or named properties');
    return value.map(encode);
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.includes('$')) return { $: 'object', entries: keys.map(key => [key, encode(value[key])]) };
    return Object.fromEntries(keys.map(key => [key, encode(value[key])]));
  }
  throw new TypeError(`vector values are plain data, not ${Object.prototype.toString.call(value)}`);
}

/** The value of a path inside `root` (its parent and last key). */
function locate(root, path) {
  let parent = root;
  for (const key of path.slice(0, -1)) parent = parent[key];
  return [parent, path.at(-1)];
}

/** Applies a base's ops to a deep copy, as the Rust test does. */
export function applyOps(base, ops) {
  const value = structuredClone(base);
  for (const [op, path, item] of ops) {
    const [parent, key] = locate(value, path);
    if (op === 'set') parent[key] = structuredClone(item);
    else if (op === 'delete') delete parent[key];
    else if (op === 'push') parent[key].push(structuredClone(item));
    else throw new TypeError(`unknown op ${op}`);
  }
  return value;
}

/** A thrown value as a row's `throw` field. */
export function encodeThrow(error) {
  if (!(error instanceof Error)) throw new TypeError(`a vector call threw a non-error: ${String(error)}`);
  return { name: error.name, message: error.message, ...(Object.hasOwn(error, 'code') ? { code: encode(error.code) } : {}) };
}
