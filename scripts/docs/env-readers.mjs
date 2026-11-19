// Docs drift check `env-reverse`: every DEVRYAN_*, OPENCHAMBER_* or OPENCODE_*
// variable that production code reads must be named in full in some repository
// document, the other direction of `env-tokens.mjs`.
// - Production code: tracked or untracked, non-ignored source files under
//   `packages/` (JavaScript, TypeScript, C, Rust, Swift, shell), except tests
//   (`*.test.*`, `*.spec.*`, `*.bench.*`, `tests/`, `__tests__/`), fixtures, type
//   declarations, the frozen legacy `packages/desktop`, the docs site, reviewed
//   upstream inputs, and build or development tooling (`packages/*/scripts/`,
//   Vite and Vitest configuration, Cargo `build.rs`). Repository `scripts/` is
//   tooling too. Comments are removed before anything is matched.
// - A read is any of:
//   - an environment object (a name ending in `env`/`Env`/`ENV`/`environment`,
//     or a same-file alias of one, `const e = process.env`) followed by `.X`,
//     `?.X`, `['X']`, `?.['X']` or a template `[`X`]`, at any spacing or line break;
//     destructuring `{ X, Y: y = '1' } = env`; `'X' in env`, `Object.hasOwn(env, 'X')`,
//     `env.get('X')`;
//   - `readDevRyanEnv`/`setDevRyanEnv(…, 'X')`, where a bare suffix means `DEVRYAN_X`;
//   - native `getenv("X")`, `secure_getenv`, `_wgetenv(L"X")`,
//     `GetEnvironmentVariableW(L"X")`, `env::var("X")`, `env!("X")`, `option_env!("X")`;
//   - any of these whose name is a same-file constant (`const N = 'X'; env[N]`,
//     `#define N L"X"`), and, when a file indexes an environment with a computed
//     name (`env[name]`, `environment[map.key]`, `getenv(names[i])`), every
//     string literal in it that is exactly a variable name (a list or map of names);
//   - shell text inside a string literal or a shipped `.sh`/`.ps1` file:
//     `$X`, `${X}`, `$env:X`, `%X%`;
//   - for the product's own prefixes only (DEVRYAN_, OPENCHAMBER_): any string
//     literal that is exactly such a name, unless NOT_ENVIRONMENT_LITERALS lists it.
// - `OPENCHAMBER_<X>` counts as `DEVRYAN_<X>` (accepted alias). A document names a
//   variable by its DEVRYAN_ or OPENCHAMBER_ spelling in full; a family name such
//   as `DEVRYAN_LEDGER_*` documents nothing. Reviewed upstream inputs are not
//   repository documents.
// - Not seen: names assembled at run time (`'DEVRYAN_' + key`), reads through
//   another file's constant unless the literal is a DEVRYAN_/OPENCHAMBER_ name,
//   and non-DEVRYAN/OPENCODE names (`PATH`, provider keys).
// - The baseline (`known-undocumented-env.json`) only shrinks: entries are
//   `{ name, reason }`, and an entry whose variable is now documented or no
//   longer read fails until it is deleted (`--prune` deletes exactly those).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE = /\.(?:[cm]?[jt]sx?|[ch]|rs|swift|sh|bash|ps1)$/;
const SHELL_SOURCE = /\.(?:sh|bash|ps1)$/;
const EXCLUDED = [
  /\.d\.[cm]?ts$/,
  /(?:^|[./-])(?:test|spec|bench)\.[cm]?[jt]sx?$/,
  /\.(?:test|spec|bench)\.[^/]+$/,
  /(?:^|\/)(?:tests?|__tests__|fixtures|node_modules|dist|dist-bundle|target)\//,
  /^packages\/desktop\//,
  /^packages\/docs\//,
  /\/reviewed-inputs\//,
  /^packages\/[^/]+\/scripts\//,
  /(?:^|\/)vite(?:st)?\.config\.[cm]?[jt]s$/,
  /(?:^|\/)build\.rs$/,
];
const REVIEWED_INPUTS = /(?:^|\/)reviewed-inputs\//;

// String literals shaped like a DevRyan variable that are not environment
// variables, mapped to the reason. An entry that no longer occurs fails.
export const NOT_ENVIRONMENT_LITERALS = new Map([
  ['DEVRYAN_AUDIT_OUTBOX_NOT_FLUSHED', 'error code (multi-user audit outbox)'],
  ['DEVRYAN_BINARY_READ_BLOCKED', 'error code (tool input guard plugin)'],
  ['DEVRYAN_BROWSER_COMMAND_ABORTED', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_COMMAND_FAILED', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_COMMAND_TIMEOUT', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_CONFIG_INVALID', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_CONFIG_UNAVAILABLE', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_CONNECTION_FAILED', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_EVAL_ERROR', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_INPUT_INVALID', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_INSPECTION_FAILED', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_LEASE_ACQUIRE_FAILED', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_LEASE_RELEASE_FAILED', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_LEASE_RESPONSE_INVALID', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_LEASE_TOUCH_FAILED', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_BROWSER_TURN_LOOKUP_FAILED', 'error code (browser plugin BROWSER_ERROR_CODES)'],
  ['DEVRYAN_DOCUMENT_OUTPUT_LIMIT', 'error code (document reader plugin)'],
  ['DEVRYAN_IMAGEGEN_MODEL_INCOMPATIBLE', 'error code (image generation hotfix)'],
  ['DEVRYAN_TOOL_INPUT_INVALID', 'error code (tool input guard and orchestration plugins)'],
]);

const PREFIXED = String.raw`(?:DEVRYAN|OPENCHAMBER|OPENCODE)_[A-Z0-9]+(?:_[A-Z0-9]+)*`;
const NAME = new RegExp(`^${PREFIXED}$`);
const OWN_NAME = /^(?:DEVRYAN|OPENCHAMBER)_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
// An identifier ending in one of these (`process.env`, `childEnv`, `Bun.env`, `environment`).
const ENV_OBJECT = String.raw`(?:env|Env|ENV|environment|Environment)(?![\w$])`;
const DOC_TOKEN = /(?<![A-Za-z0-9_])(?:DEVRYAN|OPENCHAMBER|OPENCODE)_[A-Z0-9_]*/g;
const SHELL_READ = new RegExp(String.raw`\$\{?(${PREFIXED})(?![A-Z0-9_])|\$env:(${PREFIXED})(?![A-Z0-9_])|%(${PREFIXED})%`, 'g');

export const ENVIRONMENT_REFERENCE = "docs/ENVIRONMENT.md";
export const canonicalName = (name) => name.replace(/^OPENCHAMBER_/, 'DEVRYAN_');

/** True for a repository path whose reads count as production reads. */
export function isProductionSource(file) {
  return file.startsWith('packages/') && SOURCE.test(file) && !EXCLUDED.some((pattern) => pattern.test(file));
}

const KEY_LITERAL = /^[A-Z][A-Z0-9_]*$/;
const isWordCode = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
const isSpaceCode = (code) => code === 32 || code === 9 || code === 10 || code === 13;
const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/;

/**
 * Splits a C-family source (JavaScript, TypeScript, C, Rust, Swift) into its
 * code with every comment and string content blanked (offsets and line breaks
 * kept; upper-case key literals stay) and its string literals `{ value, index }`. Template literals yield one entry per text part.
 */
export function splitSource(text, { javascript = true, rust = false } = {}) {
  const comments = [];
  const strings = [];
  const blank = (from, to) => { comments.push([from, to]); };
  const stack = []; // open template interpolations: brace depth at entry
  let depth = 0;
  let last = '';
  let i = 0;
  const readQuoted = (quote, start) => {
    let j = start + 1;
    while (j < text.length && text[j] !== quote && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
    strings.push({ value: text.slice(start + 1, j), index: start + 1 });
    return j + 1;
  };
  // Reads template text from `start` (just after the backtick or a closing `}`).
  const readTemplate = (start) => {
    let j = start;
    while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) j += text[j] === '\\' ? 2 : 1;
    strings.push({ value: text.slice(start, j), index: start });
    if (text[j] === '$') { stack.push(depth); depth += 1; return j + 2; }
    return j + 1;
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop); i = stop; continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (c === '"' || (c === "'" && !rust)) { i = readQuoted(c, i); last = 'x'; continue; }
    if (rust && c === "'") {
      const char = /^'(?:\\.[^']*|[^\\'\n])'/.exec(text.slice(i, i + 12));
      if (char) { strings.push({ value: char[0].slice(1, -1), index: i + 1 }); i += char[0].length; last = 'x'; }
      else i += 1; // lifetime
      continue;
    }
    if (rust && c === 'r' && /^r#*"/.test(text.slice(i, i + 8)) && !/[\w$]/.test(text[i - 1] ?? '')) {
      const hashes = /^r(#*)"/.exec(text.slice(i, i + 8))[1];
      const close = `"${hashes}`;
      const start = i + 2 + hashes.length;
      const end = text.indexOf(close, start);
      const stop = end === -1 ? text.length : end;
      strings.push({ value: text.slice(start, stop), index: start });
      i = stop + close.length; last = 'x'; continue;
    }
    if (javascript && c === '`') { i = readTemplate(i + 1); last = 'x'; continue; }
    if (javascript && c === '}' && stack.length && depth - 1 === stack[stack.length - 1]) {
      depth = stack.pop(); i = readTemplate(i + 1); last = 'x'; continue;
    }
    if (javascript && c === '/') {
      const before = text.slice(Math.max(0, i - 12), i).trimEnd();
      if (REGEX_BEFORE.has(last) || REGEX_AFTER_WORD.test(before)) {
        let j = i + 1;
        let inClass = false;
        while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
          if (text[j] === '\\') j += 1;
          else if (text[j] === '[') inClass = true;
          else if (text[j] === ']') inClass = false;
          j += 1;
        }
        i = j + 1; last = 'x'; continue;
      }
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    const charCode = text.charCodeAt(i);
    if (!isSpaceCode(charCode)) last = isWordCode(charCode) ? 'x' : c;
    i += 1;
  }
  // String contents are blanked too, except a literal that could be a variable
  // name or suffix, so `env['X']` stays visible and `'set env.X=1'` prose does not read X.
  const blanks = [...comments, ...strings.filter(({ value }) => !KEY_LITERAL.test(value))
    .map(({ value, index }) => [index, index + value.length])].sort((left, right) => left[0] - right[0]);
  let code = '', at = 0;
  for (const [from, to] of blanks) {
    if (to <= at) continue;
    const start = Math.max(from, at);
    code += text.slice(at, start) + text.slice(start, to).replace(/[^\n]/g, ' ');
    at = to;
  }
  return { code: code + text.slice(at), strings };
}

/** Shell source: `#` comments (and PowerShell `<# #>`) blanked; the whole text is shell. */
function splitShell(text) {
  const code = text.replace(/<#[\s\S]*?#>/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;])#[^\n]*/g, (comment, lead) => lead + ' '.repeat(comment.length - lead.length));
  return { code, strings: [{ value: code, index: 0 }] };
}

// `N = 'X'`, `N: string = 'X'`, `N[] = L"X"`: the value is matched first, then
// the target in the text just before it (cheaper than one pattern from every identifier).
const CONSTANT_VALUE = new RegExp(String.raw`=\s*L?(['"\`])(${PREFIXED})\1`, 'g');
const CONSTANT_TARGET = new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*(?:\[\s*\])?\s*(?::\s*[^=;,\n]+)?$`);

const devRyanName = (name) => (/^(?:DEVRYAN|OPENCHAMBER|OPENCODE)_/.test(name) ? name : `DEVRYAN_${name}`);

/**
 * Variable reads in one source: `[{ name, index }]` (canonical name, offset of
 * the first read), in first-seen order. `file` selects the language.
 */
export function readsInSourceAt(source, file = 'a.js') {
  return analyzeSource(source, file).reads;
}

function analyzeSource(source, file) {
  const literals = new Set();
  const shell = SHELL_SOURCE.test(file);
  const { code, strings } = shell ? splitShell(source) : splitSource(source, {
    javascript: /\.[cm]?[jt]sx?$/.test(file), rust: /\.rs$/.test(file),
  });
  const found = new Map();
  const add = (name, index) => {
    const canonical = canonicalName(name);
    if (NAME.test(canonical) && (!found.has(canonical) || found.get(canonical) > index)) found.set(canonical, index);
  };
  for (const { value, index } of strings) {
    for (const match of value.matchAll(SHELL_READ)) add(match[1] ?? match[2] ?? match[3], index + match.index);
  }
  if (!shell) {
    // Same-file constants and aliases of an environment object.
    const constants = new Map();
    for (const match of code.matchAll(CONSTANT_VALUE)) {
      const target = CONSTANT_TARGET.exec(code.slice(Math.max(0, match.index - 160), match.index));
      if (target) constants.set(target[1], match[2]);
    }
    for (const match of code.matchAll(new RegExp(String.raw`#define\s+(${IDENT})\s+L?"(${PREFIXED})"`, 'g'))) constants.set(match[1], match[2]);
    const aliases = new Set();
    for (let grew = true; grew;) {
      grew = false;
      const object = aliases.size ? String.raw`(?:${ENV_OBJECT}|(?<![\w$])(?:${[...aliases].join('|')})(?![\w$]))` : ENV_OBJECT;
      for (const match of code.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(${IDENT})\s*(?::\s*[^=;\n]+)?=\s*(?:\{\s*\.\.\.\s*)?[\w$.]*${object}\s*[;,)}\n]`, 'g'))) {
        if (!aliases.has(match[1])) { aliases.add(match[1]); grew = true; }
      }
    }
    const object = aliases.size ? String.raw`(?:${ENV_OBJECT}|(?<![\w$])(?:${[...aliases].join('|')})(?![\w$]))` : ENV_OBJECT;
    let computed = false;
    const named = (literal, identifier, index) => {
      if (literal) add(literal, index);
      else if (identifier && constants.has(identifier)) add(constants.get(identifier), index);
      else computed = true;
    };
    for (const match of code.matchAll(new RegExp(String.raw`${object}\s*(?:(?:\?\.|\.)\s*(${PREFIXED})(?![\w$])|(?:\?\.\s*)?\[\s*(?:(['"\`])(${PREFIXED})\2|(${IDENT})(?=\s*\])|[^\]'"\`]))`, 'g'))) {
      if (match[1]) add(match[1], match.index);
      else named(match[3], match[4], match.index);
    }
    for (const match of code.matchAll(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*[\w$.]*${object}(?![\w$.\[(])`, 'g'))) {
      for (const part of match[1].split(',')) {
        const key = /^\s*(?:\.\.\.)?\s*(['"]?)([A-Z][A-Z0-9_]*)\1\s*(?:[:=]|$)/.exec(part);
        if (key) add(key[2], match.index);
      }
    }
    for (const match of code.matchAll(new RegExp(String.raw`(['"\`])(${PREFIXED})\1\s+in\s+[\w$.]*${object}|hasOwn(?:Property)?\s*\(\s*[\w$.]*${object}\s*,\s*(['"\`])(${PREFIXED})\3|${object}\s*\.\s*(?:get|has|hasOwnProperty)\s*\(\s*(['"\`])(${PREFIXED})\5`, 'g'))) {
      add(match[2] ?? match[4] ?? match[6], match.index);
    }
    for (const match of code.matchAll(new RegExp(String.raw`\b(?:read|set|has|delete)DevRyanEnv\s*\([^;]*?,\s*(?:(['"\`])([A-Z][A-Z0-9_]*)\1|(${IDENT}))\s*[,)]`, 'g'))) {
      if (match[2]) add(devRyanName(match[2]), match.index);
      else if (constants.has(match[3])) add(devRyanName(constants.get(match[3])), match.index);
      else computed = true;
    }
    for (const match of code.matchAll(new RegExp(String.raw`(?:\b(?:_?w?getenv|secure_getenv|[GS]etEnvironmentVariable[AW]?)|env::(?:var(?:_os)?|set_var|remove_var)|\b(?:option_)?env!)\s*\(\s*(?:L?"(${PREFIXED})"|(${IDENT})\s*[,)]|[^)"])`, 'g'))) {
      named(match[1], match[2], match.index);
    }
    for (const { value, index } of strings) {
      if (NOT_ENVIRONMENT_LITERALS.has(value)) { literals.add(value); continue; }
      if (OWN_NAME.test(value) || (computed && NAME.test(value))) add(value, index);
    }
  }
  return { literals, reads: [...found].map(([name, index]) => ({ name, index })).sort((left, right) => left.index - right.index) };
}

/** Canonical variable names read in `source`, in first-seen order. */
export function readsInSource(source, file) {
  return readsInSourceAt(source, file).map((read) => read.name);
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;
const mayRead = (source) => /DEVRYAN_|OPENCHAMBER_|OPENCODE_|DevRyanEnv\s*\(/.test(source);

/** Tracked and untracked, non-ignored files under `packages/`. */
export function listPackageFiles(root) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
}

/**
 * Map of canonical name to the sorted `{ file, line }` production reads, with
 * `scanned` (every production source read) and `literals` (allowlisted
 * literals seen) as non-enumerable properties.
 */
export function productionEnvReads(root, { files = listPackageFiles(root) } = {}) {
  const reads = new Map();
  const scanned = [];
  const literals = new Set();
  for (const file of files.filter(isProductionSource).sort()) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) continue;
    scanned.push(file);
    const source = readFileSync(absolute, 'utf8');
    if (!mayRead(source)) continue;
    const analysis = analyzeSource(source, file);
    for (const { name, index } of analysis.reads) {
      if (!reads.has(name)) reads.set(name, []);
      reads.get(name).push({ file, line: lineOf(source, index) });
    }
    for (const literal of analysis.literals) literals.add(literal);
  }
  Object.defineProperty(reads, 'scanned', { value: scanned });
  Object.defineProperty(reads, 'literals', { value: literals });
  return reads;
}

/** Full variable names the documents mention (family names such as `DEVRYAN_LEDGER_*` are not names). */
export function documentedNames(root, docs) {
  const names = new Set();
  for (const doc of docs) {
    if (REVIEWED_INPUTS.test(doc) || doc.includes('node_modules/')) continue;
    for (const token of readFileSync(path.join(root, doc), 'utf8').match(DOC_TOKEN) ?? []) {
      const name = canonicalName(token);
      if (NAME.test(name)) names.add(name);
    }
  }
  return names;
}

/** The document where an undocumented variable most likely belongs: the nearest package DOCUMENTATION.md, else the reference. */
export function likelyHome(root, file) {
  for (let directory = path.posix.dirname(file); directory.startsWith('packages/'); directory = path.posix.dirname(directory)) {
    const candidate = `${directory}/DOCUMENTATION.md`;
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return ENVIRONMENT_REFERENCE;
}

/** Undocumented production reads `{ name, file, line, home }`, sorted by name. */
export function undocumentedEnvReads(root, docs, { reads = productionEnvReads(root) } = {}) {
  const names = documentedNames(root, docs);
  const missing = [];
  for (const [name, sites] of [...reads].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (names.has(name)) continue;
    const [{ file, line }] = sites;
    missing.push({ name, file, line, home: likelyHome(root, file) });
  }
  return missing;
}

/** Allowlisted non-variable literals that no production source contains any more. */
export function staleLiteralAllowlist(reads) {
  return [...NOT_ENVIRONMENT_LITERALS.keys()].filter((literal) => !reads.literals?.has(literal));
}

export function readUndocumentedBaseline(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((entry) => entry && typeof entry === 'object'
    && Object.keys(entry).sort().join(',') === 'name,reason' && typeof entry.name === 'string'
    && typeof entry.reason === 'string' && entry.reason.trim())) {
    throw new Error(`${file}: expected an array of { name, reason } with a nonempty reason`);
  }
  return parsed;
}

/** `{ added, stale, known }`: undocumented reads missing from the baseline, entries that no longer apply, and covered reads. */
export function compareUndocumented(missing, baseline) {
  const listed = new Set(baseline.map((entry) => entry.name));
  const current = new Set(missing.map((entry) => entry.name));
  return {
    added: missing.filter((entry) => !listed.has(entry.name)),
    stale: baseline.filter((entry) => !current.has(entry.name)),
    known: missing.filter((entry) => listed.has(entry.name)),
  };
}

/** Removes stale entries only; never adds one. */
export function pruneUndocumentedBaseline(file, baseline, stale) {
  const remove = new Set(stale.map((entry) => entry.name));
  const kept = baseline.filter((entry) => !remove.has(entry.name)).sort((left, right) => (left.name < right.name ? -1 : 1));
  writeFileSync(file, kept.length ? `[\n${kept.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')}\n]\n` : '[]\n');
}

export const describeUndocumented = ({ name, file, line, home }) => `${name} is read at ${file}:${line} but named in no repository document: `
  + `describe it in ${ENVIRONMENT_REFERENCE} (or the package document that owns it; suggested: ${home})`;
