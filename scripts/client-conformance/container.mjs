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
import { hashText, stringifyTree } from './codec.mjs';

export const FORMAT = 'devryan-client-conformance';
export const FORMAT_VERSION = 3;
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
  const ref = (text) => {
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
      for (const record of cases) {
        forEachValueRef(record, (hash) => {
          if (seen.has(hash)) return;
          if (!table.has(hash)) throw new Error(`client-conformance container: case refers to unknown value ${hash}`);
          seen.add(hash);
          ordered.push(hash);
        });
      }
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
  const cases = lines.slice(2).map((line, index) => {
    const parsed = parse(line, index + 2);
    if (!parsed || typeof parsed.case !== 'object' || Object.keys(parsed).length !== 1) throw new ContainerError('format', `line ${index + 3} is not a case`);
    forEachValueRef(parsed.case, (hash) => {
      if (!values.has(hash)) throw new ContainerError('value-table', `line ${index + 3} refers to missing value ${hash}`);
      if (!seen.has(hash)) { seen.add(hash); order.push(hash); }
    });
    return parsed.case;
  });
  const tableOrder = [...values.keys()];
  if (tableOrder.length !== order.length || tableOrder.some((hash, index) => hash !== order[index])) {
    throw new ContainerError('value-table', 'the value table is not exactly the referenced values in order of first reference');
  }
  const resolve = (slot) => {
    if (typeof slot !== 'string' || !VALUE_REF.test(slot)) throw new TypeError(`client-conformance container: ${String(slot)} is not a value slot`);
    return values.get(slot.slice(1));
  };
  return { header, values, cases, resolve, lines };
}
