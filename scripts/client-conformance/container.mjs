// Container of recorded cases (design file 29 §3.2): one NDJSON file per test
// file and module family.
//   line 1   {"format":"devryan-client-conformance","version":3,...header}
//   line 2   {"values":{"<hash>":<tree>,...}}   the content-addressed value table
//   line 3+  {"case":{...}}                      one line per case, in file order
// A value slot inside a case is the string "=<hash>", the 16 hex digits of the
// SHA-256 of the value's canonical text (codec.mjs). Slots sit only in a
// case's value parts (entry.state, steps, end.state, context); naming members
// are plain strings. The table holds exactly the values the cases refer to, in
// order of first reference, so equal recordings give equal bytes. Within one
// case line, every slot belongs to one identity scope (codec.mjs): an `id` n
// in two slots of the line is the same object; numbers do not carry from one
// case line to the next. Bytes are deterministic: LF line ends, members in the
// order written, no wall times, host names, absolute paths or tool versions.
//
// Slices (version 4). A value's subtrees and strings whose canonical text is
// SLICE_MIN bytes or more are stored once, as table entries of their own, and
// the tree that held one holds {"$dr":"slice","hash":"<hash>"} in its place
// (never as the direct value of an `escape` node, whose members are the
// object's own, and never as a whole slot). The hash of a tree is that of its
// text with its slices in place, so equal subtrees are stored once however
// many steps carry them: a state passed to a thousand calls of one case costs
// what changed between them. Inside a case line a subtree an earlier slot
// already showed has the same identity numbers, so it has the same text. The
// table order is that of first reference, each value followed by the slices
// it holds, depth first. `resolve(slot)` gives the whole tree, slices
// expanded: no reader of a tree ever sees a slice, and every call gives a
// tree of its own (no object is shared between two places or two calls). An
// own member named `__proto__` is kept as a member. "slice" is no codec tag.
import { hashText, stringifyTree } from './codec.mjs';

export const FORMAT = 'devryan-client-conformance';
export const FORMAT_VERSION = 4;
/** The size from which a subtree or string is stored as a slice of its own. */
export const SLICE_MIN = 1024;
const SLICE = 'slice';
const isSlice = (node) => node !== null && typeof node === 'object' && !Array.isArray(node) && node.$dr === SLICE && typeof node.hash === 'string' && Object.keys(node).length === 2;
/** Sets an own member, `__proto__` included (an assignment of `__proto__` would set the prototype instead). */
const setMember = (object, key, value) => {
  if (key === '__proto__') Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
  else object[key] = value;
};

/**
 * Splits a tree into slices: returns the root's canonical text with every
 * subtree and string of SLICE_MIN bytes or more (the root itself excepted)
 * replaced by a slice node; `put(hash, text)` receives each slice, innermost
 * first.
 */
export function sliceTree(tree, put) {
  const visit = (node, sliceable) => {
    let out = node;
    if (Array.isArray(node)) out = node.map((item) => visit(item, true));
    else if (node !== null && typeof node === 'object') {
      out = {};
      const escaped = node.$dr === 'escape';
      for (const key of Object.keys(node)) {
        const value = node[key];
        // An escape's value is the object itself: its members are sliceable, the object is not.
        if (escaped && key === 'value' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const inner = {};
          for (const member of Object.keys(value)) setMember(inner, member, visit(value[member], true));
          setMember(out, key, inner);
        } else setMember(out, key, visit(value, true));
      }
    } else if (typeof node !== 'string') return node;
    if (!sliceable) return out;
    const text = stringifyTree(out);
    if (text.length < SLICE_MIN) return out;
    const hash = hashText(text);
    put(hash, text);
    return { $dr: SLICE, hash };
  };
  return stringifyTree(visit(tree, false));
}

/** The slice hashes a stored tree holds, in member order (never inside an escape's own value object). */
function slicesOf(tree) {
  const found = [];
  const walk = (node, escapedValue) => {
    if (Array.isArray(node)) { for (const item of node) walk(item, false); return; }
    if (node === null || typeof node !== 'object') return;
    if (!escapedValue && isSlice(node)) { found.push(node.hash); return; }
    for (const key of Object.keys(node)) walk(node[key], !escapedValue && node.$dr === 'escape' && key === 'value');
  };
  walk(tree, false);
  return found;
}

/**
 * Expands the slices of a stored tree through `lookup(hash) -> tree`. Every
 * object of the result is new: two places that hold one slice get two copies,
 * so a reader that changes one never changes the other.
 */
function expand(tree, lookup) {
  const walk = (node, escapedValue) => {
    if (Array.isArray(node)) return node.map((item) => walk(item, false));
    if (node === null || typeof node !== 'object') return node;
    if (!escapedValue && isSlice(node)) return walk(lookup(node.hash), false);
    const out = {};
    for (const key of Object.keys(node)) setMember(out, key, walk(node[key], !escapedValue && node.$dr === 'escape' && key === 'value'));
    return out;
  };
  return walk(tree, false);
}
export const VALUE_REF = /^=[0-9a-f]{16}$/;
// `recording` is the recorder's semantics version (bumped by hand when what a recording says changes);
// `modulesDigest` is a digest of the sources of the family's module and its port modules.
export const HEADER_KEYS = Object.freeze(['format', 'version', 'codec', 'recording', 'portMap', 'modulesDigest', 'testFile', 'testFileDigest', 'family']);
/** The members of a case that hold value slots, in written order. */
export const VALUE_PARTS = Object.freeze(['entry', 'steps', 'end', 'context']);

/** Visits every value reference ("=<hash>") in `item`, depth first in member order. */
export function forEachSlot(item, visit) {
  const walk = (value) => {
    if (typeof value === 'string') { if (VALUE_REF.test(value)) visit(value.slice(1)); return; }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    for (const key of Object.keys(value)) walk(value[key]);
  };
  walk(item);
}

/** Visits the value references of one case: its value parts only. */
export function forEachValueRef(record, visit) {
  for (const key of Object.keys(record)) if (VALUE_PARTS.includes(key)) forEachSlot(record[key], visit);
}

/**
 * A file-name stem for a repository-relative path that is unique by
 * construction: `/` becomes `~`; every other byte outside [A-Za-z0-9._-]
 * (`~` and `%` included) becomes %XX. Different paths never give the same stem.
 */
export function pathStem(relativePath) {
  let out = '';
  for (const byte of Buffer.from(relativePath, 'utf8')) {
    const char = String.fromCharCode(byte);
    if (char === '/') out += '~';
    else if (/[A-Za-z0-9._-]/.test(char)) out += char;
    else out += `%${byte < 16 ? '0' : ''}${byte.toString(16).toUpperCase()}`;
  }
  return out;
}

/**
 * A writer: `ref(text)` stores canonical text and returns its slot string;
 * `addCase` appends a case; `toText()` gives the file. `table` may hold
 * values stored elsewhere (a recorder's raw table) keyed by hash.
 */
export function createContainerWriter(header, { table = new Map() } = {}) {
  for (const key of Object.keys(header)) if (!HEADER_KEYS.includes(key)) throw new TypeError(`client-conformance container: unknown header member ${key}`);
  const cases = [];
  const put = (hash, text) => {
    if (table.has(hash) && table.get(hash) !== text) throw new Error(`client-conformance container: hash collision at ${hash}`);
    table.set(hash, text);
  };
  const ref = (fullText) => {
    const text = sliceTree(JSON.parse(fullText), put);
    const hash = hashText(text);
    if (table.has(hash) && table.get(hash) !== text) throw new Error(`client-conformance container: hash collision at ${hash}`);
    table.set(hash, text);
    return `=${hash}`;
  };
  return {
    ref,
    refTree: (tree) => ref(stringifyTree(tree)),
    addCase(record) { cases.push(record); },
    get cases() { return cases; },
    toText() {
      const ordered = [];
      const seen = new Set();
      const take = (hash) => {
        if (seen.has(hash)) return;
        if (!table.has(hash)) throw new Error(`client-conformance container: refers to unknown value ${hash}`);
        seen.add(hash);
        ordered.push(hash);
        const text = table.get(hash);
        if (text.includes('"$dr":"slice"')) for (const inner of slicesOf(JSON.parse(text))) take(inner);
      };
      for (const record of cases) forEachValueRef(record, take);
      const head = { format: FORMAT, version: FORMAT_VERSION };
      for (const key of HEADER_KEYS) if (key in header) head[key] = header[key];
      const lines = [JSON.stringify(head), `{"values":{${ordered.map((hash) => `${JSON.stringify(hash)}:${table.get(hash)}`).join(',')}}}`];
      for (const record of cases) lines.push(JSON.stringify({ case: record }));
      return `${lines.join('\n')}\n`;
    },
  };
}

/**
 * Reads a container strictly: every line must be canonical JSON (written back
 * byte-equal), every value must match its hash, and the table must hold
 * exactly the referenced values in order of first reference. `resolve(slot)`
 * gives the tree of a value slot. Throws on anything else.
 */
/** A reader error that names the check it failed (format, header, value-table). */
export class ContainerError extends Error {
  constructor(check, message) { super(`client-conformance container: ${message}`); this.check = check; }
}

export function readContainer(text) {
  if (typeof text !== 'string' || !text.endsWith('\n') || text.includes('\r')) throw new ContainerError('format', 'not LF-terminated NDJSON');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2) throw new ContainerError('header', 'header and value table are required');
  const parse = (line, index) => {
    const parsed = JSON.parse(line);
    if (JSON.stringify(parsed) !== line) throw new ContainerError('format', `line ${index + 1} is not canonical JSON`);
    return parsed;
  };
  const header = parse(lines[0], 0);
  if (header.format !== FORMAT || header.version !== FORMAT_VERSION) throw new ContainerError('header', `unsupported format ${header.format}@${header.version}`);
  for (const key of Object.keys(header)) if (!HEADER_KEYS.includes(key)) throw new ContainerError('header', `unknown header member ${key}`);
  const valuesLine = parse(lines[1], 1);
  if (!valuesLine || typeof valuesLine.values !== 'object' || Array.isArray(valuesLine.values) || Object.keys(valuesLine).length !== 1) throw new ContainerError('value-table', 'line 2 is not the value table');
  const values = new Map(Object.entries(valuesLine.values));
  for (const [hash, tree] of values) {
    if (hashText(stringifyTree(tree)) !== hash) throw new ContainerError('value-table', `value ${hash} does not match its content`);
  }
  const order = [];
  const seen = new Set();
  const take = (hash, where) => {
    if (!values.has(hash)) throw new ContainerError('value-table', `${where} refers to missing value ${hash}`);
    if (seen.has(hash)) return;
    seen.add(hash);
    order.push(hash);
    for (const inner of slicesOf(values.get(hash))) take(inner, `value ${hash}`);
  };
  const cases = lines.slice(2).map((line, index) => {
    const parsed = parse(line, index + 2);
    if (!parsed || typeof parsed.case !== 'object' || Object.keys(parsed).length !== 1) throw new ContainerError('format', `line ${index + 3} is not a case`);
    forEachValueRef(parsed.case, (hash) => take(hash, `line ${index + 3}`));
    return parsed.case;
  });
  // A slice is stored only when it reaches SLICE_MIN bytes, and never as a whole slot: anything else is not this writer's.
  for (const [hash, tree] of values) {
    for (const inner of slicesOf(tree)) if (stringifyTree(values.get(inner)).length < SLICE_MIN) throw new ContainerError('value-table', `slice ${inner} in ${hash} is smaller than a slice`);
  }
  const tableOrder = [...values.keys()];
  if (tableOrder.length !== order.length || tableOrder.some((hash, index) => hash !== order[index])) {
    throw new ContainerError('value-table', 'the value table is not exactly the referenced values in order of first reference');
  }
  const resolve = (slot) => {
    if (typeof slot !== 'string' || !VALUE_REF.test(slot)) throw new TypeError(`client-conformance container: ${String(slot)} is not a value slot`);
    return expand(values.get(slot.slice(1)), (hash) => values.get(hash));
  };
  return { header, values, cases, resolve, lines };
}
