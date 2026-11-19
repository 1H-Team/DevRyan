// The porting rule's silent mistakes, refused by a search over the native
// ledger's ported modules (every Rust file of the ledger-native crate except
// the job layer itself, js.rs and host.rs): each changes JavaScript's job
// order without any test of the layer seeing it, so the verify runs this
// search, and a reviewer can run it alone:
//
//   node --test scripts/ledger-native/porting-lint.mjs
//
// 1. A JavaScript async function ported as a plain Rust `async fn` (and
//    awaited): its own promise and the jobs of its resolution vanish. An
//    `async fn` is refused unless the comment line right above it says
//    `// port: inline await`: a helper that is one JavaScript `await`, or
//    the body of a coroutine, never a JavaScript function.
// 2. An `async` block that is neither the body of `async_fn(…)` or
//    `Coroutine::new(…)` nor awaited where it stands (`async { … }.await`).
// 3. A Rust future that is not a JavaScript await: `std::future::ready`
//    (`await x` with no suspension), `poll_fn`, `join!`, `select!`, the
//    `futures` crate, a hand-written `impl Future`.
// 4. `impl Drop` in a ported module: a destructor is not `finally` (a task
//    whose await never settles is dropped, and its destructors run, when the
//    last reference to that promise goes, where JavaScript never runs the
//    `finally`); a port writes its `finally` blocks explicitly.
//
// The fourth silent mistake, an await that never settles held in a cycle
// with its own task, is no text pattern: the job differential's census
// counts such tasks (DOCUMENTATION.md, "Porting rule").
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const crate = path.resolve(here, '../../packages/harness-runtime/native/ledger/ledger-native/src');
/** The job layer: it implements the futures the rule forbids elsewhere. */
const LAYER = new Set(['js.rs', 'host.rs']);
const INLINE_MARKER = '// port: inline await';

/** The text with comments, strings and character literals blanked (newlines and offsets kept). */
export function codeOnly(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let index = from; index < to; index++) if (out[index] !== '\n') out[index] = ' '; };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index, index + 3);
    if (rest.startsWith('//')) {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      blank(index, stop); index = stop;
    } else if (rest.startsWith('/*')) {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop); index = stop;
    } else if (/^r#*"/.test(text.slice(index, index + 8)) && !/\w/.test(text[index - 1] ?? '')) {
      const hashes = /^r(#*)"/.exec(text.slice(index))[1];
      const close = `"${hashes}`;
      const end = text.indexOf(close, index + hashes.length + 2);
      const stop = end === -1 ? text.length : end + close.length;
      blank(index, stop); index = stop;
    } else if (text[index] === '"') {
      let stop = index + 1;
      while (stop < text.length && text[stop] !== '"') stop += text[stop] === '\\' ? 2 : 1;
      blank(index, stop + 1); index = stop + 1;
    } else if (text[index] === '\'' && (text[index + 2] === '\'' || (text[index + 1] === '\\' && /^'\\[^']{1,7}'/.test(text.slice(index, index + 10))))) {
      const stop = text.indexOf('\'', index + 2) + 1;
      blank(index, stop); index = stop;
    } else {
      index += 1;
    }
  }
  return out.join('');
}

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

/** The offset of the brace closing the one at `open`, in code-only text. */
function closing(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === '{') depth += 1;
    else if (code[index] === '}' && --depth === 0) return index;
  }
  return -1;
}

/** The findings of one ported source: `{ line, rule, text }`. */
export function lintPortedSource(text) {
  const code = codeOnly(text);
  const lines = text.split('\n');
  const findings = [];
  const found = (offset, rule) => findings.push({ line: lineOf(text, offset), rule, text: lines[lineOf(text, offset) - 1].trim() });
  for (const match of code.matchAll(/\basync\s+fn\b/g)) {
    const line = lineOf(text, match.index);
    if (lines[line - 2]?.trim().startsWith(INLINE_MARKER)) continue;
    found(match.index, 'an async fn is a JavaScript function ported without its promise (use js::async_fn, or mark one JavaScript await with `// port: inline await`)');
  }
  for (const match of code.matchAll(/\basync\s+(?:move\s+)?\{/g)) {
    const before = code.slice(0, match.index).replace(/\s+$/, '');
    if (/(?:\basync_fn(?:::<[^\n{};]*>)?|\bCoroutine::new)\($/.test(before)) continue;
    const end = closing(code, match.index + match[0].length - 1);
    if (end !== -1 && /^\s*\.await\b/.test(code.slice(end + 1))) continue;
    found(match.index, 'an async block that is neither an async function\'s body nor awaited where it stands');
  }
  const futures = [
    [/\bready\s*\(/g, 'std::future::ready: `await x` without its job'],
    [/\bstd::future::/g, 'a std future that is not a JavaScript await'],
    [/\bfutures::/g, 'the futures crate'],
    [/\bpoll_fn\b/g, 'poll_fn: a hand-made future'],
    [/\b(?:join|select|try_join)!/g, 'two awaits at once'],
    [/\bimpl(?:<[^>]*>)?\s+(?:std::future::)?(?:Into)?Future\s+for\b/g, 'a hand-written future'],
    [/\bimpl(?:<[^>]*>)?\s+Drop\s+for\b/g, 'impl Drop in a ported module: a destructor is not `finally`'],
  ];
  for (const [pattern, rule] of futures) for (const match of code.matchAll(pattern)) found(match.index, rule);
  return findings.sort((left, right) => left.line - right.line);
}

/** The ported modules: every Rust file of the crate but the job layer. */
export function portedModules(root = crate) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.rs') && !(directory === root && LAYER.has(entry.name))) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

describe('the porting rule\'s silent mistakes are refused in the ported modules', () => {
  test('no ported module has one', () => {
    const files = portedModules();
    assert.ok(files.length >= 10, `only ${files.length} ported modules found under ${crate}`);
    const findings = files.flatMap((file) => lintPortedSource(readFileSync(file, 'utf8'))
      .map((finding) => `${path.relative(crate, file)}:${finding.line}: ${finding.rule}\n    ${finding.text}`));
    assert.deepEqual(findings, []);
  });

  // Each mistake the review found silent, planted, is refused; each
  // correct form next to it is not.
  const cases = [
    ['a helper ported as an async fn', 'async fn helper(x: W) -> Result<W, W> { js::value(x).await }', 1],
    ['the same helper marked as one inline await', `${INLINE_MARKER} (one await)\nasync fn helper(x: W) -> Result<W, W> { js::value(x).await }`, 0],
    ['ready(x).await for await x', 'let x = std::future::ready(v).await;', 2],
    ['a Drop guard as finally', 'struct Guard;\nimpl Drop for Guard { fn drop(&mut self) {} }', 1],
    ['an async block awaited later', 'let later = async move { p.await };\nlater.await;', 1],
    ['an async block awaited where it stands', 'let now = async { p.await? }\n    .await;', 0],
    ['an async function\'s body', 'let promise = async_fn::<(), W>(async move { Ok(Resolution::Value(())) });', 0],
    ['a coroutine body', 'Coroutine::new(async move { body().await })', 0],
    ['join! of two awaits', 'let (a, b) = futures::join!(a, b);', 2],
    ['words in strings and comments', '// async fn, impl Drop for, ready(\nlet text = "async move { ready( }";', 0],
  ];
  for (const [name, source, expected] of cases) {
    test(`${name}: ${expected ? `refused (${expected})` : 'accepted'}`, () => {
      assert.equal(lintPortedSource(source).length, expected, JSON.stringify(lintPortedSource(source)));
    });
  }
});
