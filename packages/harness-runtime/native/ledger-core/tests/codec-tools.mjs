// Helpers shared by the codec generators (trees, keys, text).
// tests/support/mod.rs reproduces fnv64, testObjectId and seededBytes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LIB_DIR = fileURLToPath(new URL('../../../lib/', import.meta.url));

const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, MASK = (1n << 64n) - 1n;

/** FNV-1a, 64 bits, over bytes, as 16 hex digits: a test fingerprint, not a hash the ledger uses. */
export function fnv64(...parts) {
  let hash = FNV_OFFSET;
  for (const part of parts) for (const byte of part) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK;
  return hash.toString(16).padStart(16, '0');
}

/**
 * A stand-in object id of `width` hex digits for (type, content): FNV-1a of
 * a salt byte, the header and the content, for salts 0, 1, ... joined. The
 * commit vectors use it instead of SHA-1 or SHA-256, which the crate does
 * not implement; commitTreeChanges takes whatever ids its store returns.
 */
export function testObjectId(type, content, width) {
  const header = Buffer.from(`${type} ${content.length}\0`);
  let id = '';
  for (let salt = 0; id.length < width; salt += 1) id += fnv64([salt], header, content);
  return id.slice(0, width);
}

/** `length` bytes drawn from mulberry32 `next` (`Math.floor(next() * 256)`). */
export function seededBytes(next, length) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(next() * 256);
  return bytes;
}

/**
 * The source text of the declaration `const <name> = ...;` in a library file,
 * up to its terminating semicolon at nesting depth 0 (strings, template
 * literals and comments skipped). The generators evaluate closures of
 * the ledger runtime that it does not export (formatOneRows, runsFor,
 * saveRuns, the markers), so the vectors are what today's code does.
 */
export function declarationSource(file, name) {
  const text = readFileSync(new URL(file, `file://${LIB_DIR}`), 'utf8');
  const start = text.indexOf(`const ${name} = `);
  if (start < 0 || text.indexOf(`const ${name} = `, start + 1) >= 0) throw new Error(`${file} must declare ${name} exactly once`);
  let depth = 0;
  for (let at = start + `const ${name} = `.length; at < text.length; at += 1) {
    const char = text[at];
    if (char === '/' && text[at + 1] === '/') { at = text.indexOf('\n', at); continue; }
    if (char === '/' && text[at + 1] === '*') { at = text.indexOf('*/', at) + 1; continue; }
    if (char === '\'' || char === '"' || char === '`') {
      for (at += 1; text[at] !== char; at += 1) if (text[at] === '\\') at += 1;
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ';' && depth === 0) return text.slice(start + 'const '.length + name.length + 3, at);
  }
  throw new Error(`${file}: no end to ${name}`);
}

/**
 * Evaluates declarations of a library file as functions of `scope` (names
 * the source refers to). Returns { name: value } for every name in `names`,
 * each declared in order so later ones can use earlier ones.
 */
export function evaluateDeclarations(file, names, scope) {
  const params = Object.keys(scope);
  const body = `${names.map((name) => `const ${name} = ${declarationSource(file, name)};`).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function(...params, body)(...params.map((param) => scope[param]));
}

/** JSON text of a value, with each run's latin1 `text` as base64 (key order kept). */
export const runsJson = (runs) => JSON.stringify(runs.map((run) => ('text' in run ? Object.fromEntries(Object.entries(run).map(([key, value]) => [key, key === 'text' ? Buffer.from(value, 'latin1').toString('base64') : value])) : run)));
