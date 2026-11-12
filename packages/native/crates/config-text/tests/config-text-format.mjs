// The JavaScript half of the vector interchange format (the crate's
// `vector` module is the Rust half): each operation the server performs with
// jsonc-parser and yaml, run through the installed packages exactly as the
// server calls them, with its result as one text.
//
// Rows are `name<TAB>op<TAB>arg...<TAB>result`; every argument and the result
// is base64 of WTF-8 (UTF-8 that also carries lone surrogates). The packages
// are the copies the server resolves (from packages/web).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(TESTS_DIR, '../../../../..');
// Resolved from the web package, as the server resolves them.
const serverRequire = createRequire(path.join(REPOSITORY_ROOT, 'packages', 'web', 'server', 'index.js'));
export const jsonc = serverRequire('jsonc-parser');
export const YAML = serverRequire('yaml');
const yamlVersion = serverRequire('yaml/package.json').version;
const jsoncVersion = serverRequire('jsonc-parser/package.json').version;

/** The header line naming the package versions (comparison ignores it). */
// The content must not depend on Node, with one exception: the edit rows
// where the formatter needs exactly 200 spaces hold V8's TypeError message
// (`Cannot read properties of undefined (reading 'length')`), so a Node
// release that rewords it changes them although the packages did not change.
export const versionLine = () => `# jsonc-parser ${jsoncVersion}, yaml ${yamlVersion}, Node ${process.version} (the content must not depend on Node, except V8's wording of the 200-space TypeError in the edit rows).`;
export const PACKAGE_VERSIONS = Object.freeze({ jsonc: jsoncVersion, yaml: yamlVersion });

/** The deepest JSONC nesting the crate parses (`jsonc::MAX_DEPTH`). */
export const JSONC_MAX_DEPTH = 512;
/** The deepest YAML collection nesting the crate parses or writes (`yaml::MAX_DEPTH`). */
export const YAML_MAX_DEPTH = 64;

/** WTF-8 bytes of a JavaScript string. */
export function wtf8(text) {
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    const low = text.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Buffer.from(bytes);
}

/** The JavaScript string of WTF-8 bytes. */
export function fromWtf8(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    const count = first < 0x80 ? 0 : first < 0xe0 ? 1 : first < 0xf0 ? 2 : 3;
    let code = count === 0 ? first : first & (count === 1 ? 0x1f : count === 2 ? 0x0f : 0x07);
    for (let k = 1; k <= count; k += 1) code = (code << 6) | (bytes[index + k] & 0x3f);
    index += count + 1;
    out += code >= 0x10000 ? String.fromCharCode(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)) : String.fromCharCode(code);
  }
  return out;
}

export const encodeField = (text) => wtf8(text).toString('base64');
export const decodeField = (field) => fromWtf8(Buffer.from(field, 'base64'));

/**
 * The canonical description of a JavaScript value (`Graph::describe` in the crate):
 * primitives as `u n t f #<String(x)> "<JSON>"`, `-0` as `#-0`, arrays and
 * objects in own-key order, the n-th container seen (pre-order) referred to
 * again as `*n`, and a prototype other than Object.prototype as `^n` (null)
 * or `^<description>`. Anything else (a Map, Set, Date, typed array,
 * function, symbol, bigint, or a hidden property) is `!<kind>`.
 */
export function describe(root) {
  const seen = new Map();
  const go = (value) => {
    if (value === undefined) return 'u';
    if (value === null) return 'n';
    if (typeof value === 'boolean') return value ? 't' : 'f';
    if (typeof value === 'number') return `#${Object.is(value, -0) ? '-0' : String(value)}`;
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value !== 'object') return `!${typeof value}`;
    if (seen.has(value)) return `*${seen.get(value)}`;
    if (value instanceof Map || value instanceof Set || value instanceof Date || ArrayBuffer.isView(value)) return `!${value.constructor.name}`;
    seen.set(value, seen.size);
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length + (Array.isArray(value) ? 1 : 0)) return '!hidden';
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length) return '!array';
      return `[${value.map(go).join(',')}]`;
    }
    const body = `{${keys.map((key) => `${JSON.stringify(key)}:${go(value[key])}`).join(',')}}`;
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype) return body;
    if (proto === null) return `${body}^n`;
    return `${body}^${go(proto)}`;
  };
  return go(root);
}

/** Reads a description back into a JavaScript value (the inverse of describe). */
export function undescribe(text) {
  const containers = [];
  let at = 0;
  const fail = (why) => { throw new Error(`${why} at ${at} in ${text.slice(0, 80)}`); };
  const string = () => {
    let end = at + 1;
    while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    const value = JSON.parse(text.slice(at, end + 1));
    at = end + 1;
    return value;
  };
  const value = () => {
    const ch = text[at];
    if (ch === 'u') { at += 1; return undefined; }
    if (ch === 'n') { at += 1; return null; }
    if (ch === 't') { at += 1; return true; }
    if (ch === 'f') { at += 1; return false; }
    if (ch === '#') {
      let end = at + 1;
      while (end < text.length && !',]}^'.includes(text[end])) end += 1;
      const raw = text.slice(at + 1, end);
      at = end;
      return raw === '-0' ? -0 : Number(raw);
    }
    if (ch === '"') return string();
    if (ch === '*') {
      let end = at + 1;
      while (/[0-9]/.test(text[end] ?? '')) end += 1;
      const target = containers[Number(text.slice(at + 1, end))];
      at = end;
      return target;
    }
    if (ch === '[') {
      const array = [];
      containers.push(array);
      at += 1;
      if (text[at] !== ']') for (;;) { array.push(value()); if (text[at] === ',') at += 1; else break; }
      if (text[at] !== ']') fail('expected ]');
      at += 1;
      return array;
    }
    if (ch === '{') {
      const object = {};
      containers.push(object);
      at += 1;
      if (text[at] !== '}') for (;;) {
        const key = string();
        if (text[at] !== ':') fail('expected :');
        at += 1;
        Object.defineProperty(object, key, { value: value(), writable: true, enumerable: true, configurable: true });
        if (text[at] === ',') at += 1; else break;
      }
      if (text[at] !== '}') fail('expected }');
      at += 1;
      if (text[at] === '^') {
        at += 1;
        if (text[at] === 'n') { at += 1; Object.setPrototypeOf(object, null); } else Object.setPrototypeOf(object, value());
      }
      return object;
    }
    return fail(`unexpected ${ch}`);
  };
  const result = value();
  if (at !== text.length) fail('trailing text');
  return result;
}

/**
 * The deepest container nesting of a value (root container 1), each
 * container counted where a pre-order walk in key order first meets it, as
 * yaml's createNode does (later meetings become aliases).
 */
export function valueDepth(root) {
  const seen = new Set();
  let deepest = 0;
  const pending = [[root, 1]];
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    deepest = Math.max(deepest, depth);
    const keys = Object.keys(value);
    for (let index = keys.length - 1; index >= 0; index -= 1) pending.push([value[keys[index]], depth + 1]);
  }
  return deepest;
}

/** The deepest `{`/`[` nesting jsonc-parser's scanner sees. */
export function jsoncDepth(text) {
  const scanner = jsonc.createScanner(text, false);
  let depth = 0;
  let deepest = 0;
  for (let token = scanner.scan(); token !== 17; token = scanner.scan()) {
    if (token === 1 || token === 3) deepest = Math.max(deepest, ++depth);
    else if (token === 2 || token === 4) depth = Math.max(0, depth - 1);
  }
  return deepest;
}

/** The deepest collection nesting of yaml's CST over every document. */
export function yamlCstDepth(source) {
  let deepest = 0;
  const pending = [];
  for (const token of new YAML.Parser().parse(source)) pending.push([token, 0]);
  while (pending.length) {
    const [token, depth] = pending.pop();
    if (!token || typeof token !== 'object') continue;
    if (token.type === 'document') { pending.push([token.value, depth]); continue; }
    if (token.type === 'block-map' || token.type === 'block-seq' || token.type === 'flow-collection') {
      deepest = Math.max(deepest, depth + 1);
      for (const item of token.items) pending.push([item.key, depth + 1], [item.value, depth + 1]);
    }
  }
  return deepest;
}

const CORE_TAG_COUNT = 11;

/** True where the crate leaves `yaml.parse(source)` to JavaScript (the crate's `yaml` module). */
function yamlDeclines(source, stringWarnings) {
  if (yamlCstDepth(source) > YAML_MAX_DEPTH) return true;
  if (stringWarnings.some((text) => text.startsWith('Keys with collection values will be stringified'))) return true;
  // Both checks below need a directive (`%`) or a tag (`!`) in the source;
  // skipping the second parse elsewhere keeps the contract cheap.
  if (!source.includes('%') && !source.includes('!')) return false;
  const doc = YAML.parseDocument(source);
  // A %YAML 1.1 document is composed with the yaml-1.1 schema (an empty
  // stream's placeholder document is not composed at all).
  if (doc.directives?.yaml?.version === '1.1') return doc.contents !== null;
  // A tag outside the core schema was resolved (the composer adds it to the schema).
  return doc.schema.tags.length > CORE_TAG_COUNT;
}

function yamlParse(source) {
  const original = process.emitWarning;
  const warnings = [];
  process.emitWarning = (warning) => { warnings.push(warning); };
  let outcome;
  try {
    outcome = { value: YAML.parse(source) };
  } catch (error) {
    outcome = { error };
  } finally {
    process.emitWarning = original;
  }
  const strings = warnings.filter((warning) => typeof warning === 'string');
  if (yamlDeclines(source, strings)) return 'unsupported';
  const lines = warnings.map((warning) => `warn\t${warning.code}\t${JSON.stringify(warning.message)}`);
  if ('error' in outcome) {
    const { error } = outcome;
    lines.push(`throw\t${error.name}\t${error.code ?? '-'}\t${JSON.stringify(error.message)}`);
  } else {
    lines.push(`value\t${describe(outcome.value)}`);
  }
  return lines.join('\n');
}

const formatting = (eol) => ({ formattingOptions: { insertSpaces: true, tabSize: 2, eol } });
const serverEol = (source) => (source.includes('\r\n') ? '\r\n' : '\n');

/** Thrown where the crate refuses an edit (hands it back to JavaScript); the row reads `refused`. */
class Refusal extends Error {}

/**
 * The crate refuses a text nested deeper than JSONC_MAX_DEPTH, and a value
 * JSON.stringify meets a cycle in or that nests containers deeper than
 * JSONC_MAX_DEPTH (`Graph::json_stringify`), before modify runs.
 */
function refuseEdit(text, value) {
  if (jsoncDepth(text) > JSONC_MAX_DEPTH) throw new Refusal();
  const active = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (active.includes(node) || active.length >= JSONC_MAX_DEPTH) throw new Refusal();
    active.push(node);
    for (const key of Object.keys(node)) walk(node[key]);
    active.pop();
  };
  walk(value);
}

const modify = (text, keyPath, value, eol) => { refuseEdit(text, value); return jsonc.modify(text, keyPath, value, formatting(eol)); };

/** removeJsoncKeyPaths of the server's opencode JSONC configuration module. */
function removeKeyPaths(source, keyPaths) {
  const eol = serverEol(source);
  return keyPaths.reduce((text, keyPath) => jsonc.applyEdits(text, modify(text, keyPath, undefined, eol)), source);
}

/** applyEdits(source, modify(source, path, value, …)) as the legacy Cursor plugin cleanup and the user-profile provisioning call it. */
const setKeyPath = (source, keyPath, value) => jsonc.applyEdits(source, modify(source, keyPath, value, serverEol(source)));

/** `=text`, `!` and what JavaScript throws, or `refused`. */
const editOutcome = (run) => {
  try { return run(); } catch (error) { return error instanceof Refusal ? 'refused' : `!${String(error)}`; }
};
const editResult = (run) => editOutcome(() => `=${run()}`);

const SKILL_FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/** Runs one operation through the packages and returns its result text. */
export function runOperation(op, args) {
  switch (op) {
    case 'jsonc-parse': {
      const [text] = args;
      if (jsoncDepth(text) > JSONC_MAX_DEPTH) return 'deep';
      const errors = [];
      const value = jsonc.parse(text, errors, { allowTrailingComma: true });
      return `${describe(value)}\n${errors.map((e) => `${e.error}@${e.offset}:${e.length}`).join(',')}`;
    }
    case 'jsonc-strip': return jsonc.stripComments(args[0]);
    case 'jsonc-modify': {
      const [text, pathText, valueText, eol] = args;
      const value = valueText === '' ? undefined : undescribe(valueText);
      return editOutcome(() => modify(text, undescribe(pathText), value, eol).map((e) => `${e.offset}:${e.length}:${JSON.stringify(e.content)}`).join('\n'));
    }
    case 'jsonc-remove': return editResult(() => removeKeyPaths(args[0], undescribe(args[1])));
    case 'jsonc-set': return editResult(() => setKeyPath(args[0], undescribe(args[1]), undescribe(args[2])));
    case 'jsonc-provision': return editResult(() => removeKeyPaths(setKeyPath(args[0], ['plugin'], undescribe(args[1])), undescribe(args[2])));
    case 'yaml-parse': return yamlParse(args[0]);
    case 'yaml-stringify': {
      const value = undescribe(args[0]);
      if (valueDepth(value) > YAML_MAX_DEPTH) return 'unsupported';
      const text = YAML.stringify(value);
      return text === undefined ? 'undefined' : JSON.stringify(text);
    }
    case 'front-split': {
      const match = args[0].match(FRONT_MATTER);
      return match ? `${JSON.stringify(match[1])}\n${JSON.stringify(match[2])}` : 'none';
    }
    case 'front-skill': {
      const match = args[0].match(SKILL_FRONT_MATTER);
      return match ? JSON.stringify(match[1]) : 'none';
    }
    case 'trim': return args[0].trim();
    case 'utf8-decode': return Buffer.from(Array.from(args[0], (ch) => ch.charCodeAt(0) & 0xff)).toString('utf8');
    case 'utf8-encode': return String.fromCharCode(...Buffer.from(args[0], 'utf8'));
    default: throw new Error(`unknown operation ${op}`);
  }
}

/** One vector row for an operation and its arguments. */
export const renderRow = (name, op, args) => [name, op, ...args.map(encodeField), encodeField(runOperation(op, args))].join('\t');
