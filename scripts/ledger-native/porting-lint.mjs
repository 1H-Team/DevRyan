// The porting rule's silent mistakes, refused by a search over the native
// ledger's ported modules (every Rust file of the ledger-native crate except
// the job layer itself: js.rs, host.rs, agen.rs and emitter.rs): each
// changes JavaScript's job order without any test of the layer seeing it, so
// the verify runs this search, and a reviewer can run it alone:
//
//   node --test scripts/ledger-native/porting-lint.mjs
//
// 1. A JavaScript async function ported as a plain Rust `async fn` (and
//    awaited): its own promise and the jobs of its resolution vanish. An
//    `async fn` is refused unless the comment line right above it says
//    `// port: inline await`: a helper that is one JavaScript `await`, or
//    the body of a coroutine, never a JavaScript function.
// 2. An `async` block that is neither the body of `async_fn(…)`,
//    `agen::async_gen(|co| …)` or `Coroutine::new(…)` nor awaited where it
//    stands (`async { … }.await`).
// 3. A Rust future that is not a JavaScript await: `std::future::ready`
//    (`await x` with no suspension), `poll_fn`, `join!`, `select!`, the
//    `futures` crate, a hand-written `impl Future`.
// 4. `impl Drop` in a ported module: a destructor is not `finally` (a task
//    whose await never settles is dropped, and its destructors run, when the
//    last reference to that promise goes, where JavaScript never runs the
//    `finally`); a port writes its `finally` blocks explicitly.
// 5. An async generator hand-rolled on the coroutine (`Coroutine::new`,
//    `suspend()`): its request queue and awaits are the specification's
//    steps, which `agen::async_gen` implements once.
// 6. A `yield` or `yield*` whose outcome is not passed on with `?`
//    (`co.yield_(v).await?`, `co.delegate(it).await?`): a received return
//    or throw dropped is a `finally` skipped or a return swallowed. Where
//    the JavaScript catches it (`try { yield } catch`), the line above says
//    `// port: yield outcome handled`. The same for `co.ret(v)`, whose
//    outcome is the body's `Err` (`return Err(co.ret(v).await)`): any other
//    use drops the return.
// 6b. `co.ret(Resolution::Value(undefined))`: JavaScript's `return;` takes
//    no job (`return Err(Abrupt::Return(undefined))`, or `Ok(())` at the end
//    of the body), its `return undefined;` one. The rare explicit
//    `return undefined;` is marked `// port: return undefined`.
// 7. A Rust `for` loop over an awaited collection (`for x in f().await? {…}`)
//    standing in for `for await`: the body would run after every item was
//    produced, not between them. A JavaScript `for (const x of await f())`
//    is marked `// port: for-of over an awaited value` on the line above.
//    So is one over a binding the same function awaited into, iterated as a
//    Rust collection (`let rows = collect(…).await?; for row in rows {…}`,
//    `&rows`, `rows.iter()`): the marker goes on the line above the `for`.
// 8. A generator pumped by hand (`g.next(v).await` with an argument; the
//    `for await` loop's own `next()` takes none): no AsyncIteratorClose on an
//    early exit. A JavaScript `await it.next(v)` is marked
//    `// port: manual next` on the line above.
// 9. A Rust stream (`poll_next`, `StreamExt`, `async-stream`, `std::async_iter`)
//    standing in for an async iterator.
// 10. A blocking file-system call made directly (`ledger_io::…`, `std::fs::…`,
//    or a `use` of them): an `await fs.promises.x()` ported as the system
//    call itself settles nothing in a unit of its own (rule 1 of the `node`
//    module: the continuation would run inside the starting checkpoint) and
//    blocks the loop. Ports call `node::fs`. A JavaScript `fs.xSync(…)` is
//    the inline call: it is marked `// port: sync call` on the line above
//    (or uses `node::fs::*_sync`).
// 11. I/O settled outside the facade (`host::blocking(…)`, `host::submit(…)`,
//    `host::open_source(…)`): only `node::{fs, stream, zlib, child, net}`
//    check rule 1 (their guard panics on a completion in its starting
//    checkpoint) and give Node's error objects. A child process is
//    signalled or reaped only through `node::child` (`ledger_io::fs::sys`
//    is refused by rule 10 like every other `ledger_io` call).
// 12. A read cut of the port's own (rule 3: the execution receipt's byte
//    stream hands each file read to the host as one message): a
//    `create_read_stream` whose `high_water_mark` is not written as a
//    number (the JavaScript's literal `128 * 1024`, or
//    `ReadStreamOptions::DEFAULT` for `createReadStream(file)`; a test that
//    takes it from its input marks `// port: read cut given by the caller`), and, in an
//    async generator's body, a `FileHandle` read loop or a re-cut of bytes
//    (`.chunks(`, `.chunks_exact(`) standing in for the read stream, unless
//    marked `// port: handle read loop`.
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
const LAYER = new Set(['js.rs', 'host.rs', 'agen.rs', 'emitter.rs']);
/** The layer's directories: Node's library on the loop (`node::{fs, stream, zlib}`), the only callers of `ledger-io`'s blocking functions. */
const LAYER_DIRECTORIES = new Set(['node']);
const INLINE_MARKER = '// port: inline await';
const YIELD_MARKER = '// port: yield outcome handled';
const FOR_OF_MARKER = '// port: for-of over an awaited value';
const NEXT_MARKER = '// port: manual next';
const UNDEFINED_MARKER = '// port: return undefined';
const SYNC_MARKER = '// port: sync call';
const READ_LOOP_MARKER = '// port: handle read loop';
const CUT_MARKER = '// port: read cut given by the caller';

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

/** The offset of the parenthesis closing the one at `open`, in code-only text. */
function closingParen(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === '(') depth += 1;
    else if (code[index] === ')' && --depth === 0) return index;
  }
  return -1;
}

/** The findings of one ported source: `{ line, rule, text }`. */
export function lintPortedSource(text) {
  const code = codeOnly(text);
  const lines = text.split('\n');
  const findings = [];
  const found = (offset, rule) => findings.push({ line: lineOf(text, offset), rule, text: lines[lineOf(text, offset) - 1].trim() });
  /** Whether the statement holding `offset` has `marker` on the line above it. */
  const marked = (offset, marker) => lines[lineOf(text, offset) - 2]?.trim().startsWith(marker);
  for (const match of code.matchAll(/\basync\s+fn\b/g)) {
    const line = lineOf(text, match.index);
    if (lines[line - 2]?.trim().startsWith(INLINE_MARKER)) continue;
    found(match.index, 'an async fn is a JavaScript function ported without its promise (use js::async_fn, or mark one JavaScript await with `// port: inline await`)');
  }
  for (const match of code.matchAll(/\basync\s+(?:move\s+)?\{/g)) {
    const before = code.slice(0, match.index).replace(/\s+$/, '');
    if (/(?:\basync_fn(?:::<[^\n{};]*>)?|\bCoroutine::new)\($/.test(before)) continue;
    // A generator's body: `agen::async_gen(move |co| async move { … })`.
    if (/\basync_gen(?:::<[^\n{};]*>)?\(\s*(?:move\s+)?\|[^|]*\|$/.test(before)) continue;
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
  const iteration = [
    [/\bCoroutine::new\b|\bsuspend\s*\(\s*\)/g, 'an async generator hand-rolled on the coroutine (use agen::async_gen)'],
    [/\bpoll_next\b|\bStreamExt\b|\basync_stream\b|\bstd::async_iter\b|\bfutures_core\b|\btokio_stream\b/g, 'a Rust stream standing in for an async iterator'],
  ];
  for (const [pattern, rule] of iteration) for (const match of code.matchAll(pattern)) found(match.index, rule);
  for (const match of code.matchAll(/\.(?:yield_|delegate)\s*\(/g)) {
    const end = closingParen(code, match.index + match[0].length - 1);
    if (end !== -1 && /^\s*\.await\s*\?/.test(code.slice(end + 1))) continue;
    if (marked(match.index, YIELD_MARKER)) continue;
    found(match.index, 'a yield whose received return or throw is not passed on with `?`');
  }
  // Bindings an awaited expression initialises: `let rows = … .await …;`.
  const awaited = new Set();
  for (const match of code.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]*)?=(?=([^;]*);)/g)) if (/\.await\b/.test(match[2])) awaited.add(match[1]);
  for (const match of code.matchAll(/\bfor\b[^{;]*?\bin\b([^{;]*)\{/g)) {
    const over = match[1].trim().replace(/^&\s*(?:mut\s+)?/, '');
    // The binding itself (or its `iter()`, `into_iter()`, `drain(..)`): a
    // Rust collection made from awaited items (a JavaScript value is a `W`,
    // which a Rust `for` cannot iterate as it is).
    const binding = /^([A-Za-z_]\w*)\s*(?:\.\s*(?:iter|into_iter|drain)\s*\([^)]*\)[^{]*)?$/.exec(over)?.[1];
    if (!/\.await\b/.test(match[1]) && !(binding && awaited.has(binding))) continue;
    if (marked(match.index, FOR_OF_MARKER)) continue;
    found(match.index, 'a Rust for loop over an awaited collection standing in for for await');
  }
  for (const match of code.matchAll(/\.ret\s*\(/g)) {
    const before = code.slice(0, match.index);
    if (!/\bErr\s*\(\s*[\w.]*$/.test(before)) found(match.index, 'a return whose outcome is not the body\'s Err (`return Err(co.ret(v).await)`)');
    const open = match.index + match[0].length - 1;
    const end = closingParen(code, open);
    if (end !== -1 && /^\s*Resolution::Value\s*\(\s*\w+::Undefined\s*\)\s*$/.test(code.slice(open + 1, end)) && !marked(match.index, UNDEFINED_MARKER)) {
      found(match.index, 'co.ret of undefined: JavaScript\'s `return;` takes no job (`Err(Abrupt::Return(undefined))`); mark an explicit `return undefined;`');
    }
  }
  // Rule 10: blocking file-system calls, outside the facade.
  for (const match of code.matchAll(/\bledger_io::|\bstd::fs\b|\buse\s+std::\{[^}]*\bfs\b/g)) {
    if (marked(match.index, SYNC_MARKER)) continue;
    found(match.index, 'a blocking file-system call made directly (an `await fs.promises.x()` is `node::fs::x(…).await`; an `fs.xSync` is marked `// port: sync call`)');
  }
  // Rule 11: I/O settled outside the facade.
  for (const match of code.matchAll(/\bhost::(?:blocking|submit|open_source)\s*(?:::<[^\n;]*>)?\s*\(|\buse\s+crate::host::\{[^}]*\b(?:blocking|submit|open_source)\b/g)) {
    found(match.index, 'I/O settled outside node::{fs, stream, zlib} (which check rule 1 and give Node\'s errors)');
  }
  // Rule 12: a read cut of the port's own.
  for (const match of code.matchAll(/\bcreate_read_stream\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const args = code.slice(open + 1, closingParen(code, open));
    if (/ReadStreamOptions::DEFAULT\b/.test(args) || marked(match.index, CUT_MARKER)) continue;
    const hwm = /high_water_mark\s*:\s*([^,}]+)/.exec(args)?.[1]?.trim();
    if (hwm && /^[0-9_]+(?:\s*\*\s*[0-9_]+)*$/.test(hwm)) continue;
    found(match.index, 'a read stream whose high_water_mark is not the JavaScript\'s number (the receipt\'s cut reaches the host)');
  }
  for (const match of code.matchAll(/\basync_gen(?:::<[^\n{};]*>)?\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const end = closingParen(code, open);
    if (end === -1) continue;
    for (const inner of code.slice(open, end).matchAll(/\.(?:read|chunks|chunks_exact)\s*\(/g)) {
      const at = open + inner.index;
      if (marked(at, READ_LOOP_MARKER)) continue;
      found(at, 'file bytes cut by the port in a generator (a FileHandle read loop or .chunks) instead of the read stream; mark a JavaScript read loop `// port: handle read loop`');
    }
  }
  for (const match of code.matchAll(/\.next\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const end = closingParen(code, open);
    if (end === -1 || !code.slice(open + 1, end).trim()) continue;
    if (!/^\s*\.await\b/.test(code.slice(end + 1)) || marked(match.index, NEXT_MARKER)) continue;
    found(match.index, 'a generator pumped by hand (await of next(v)) instead of for await');
  }
  return findings.sort((left, right) => left.line - right.line);
}

/** The ported modules: every Rust file of the crate but the job layer. */
export function portedModules(root = crate) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!(directory === root && LAYER_DIRECTORIES.has(entry.name))) walk(full); }
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
    // Rule 2 accepts a coroutine's body; rule 5 now refuses the coroutine.
    ['a coroutine body (the async block accepted, the hand-rolled coroutine refused)', 'Coroutine::new(async move { body().await })', 1],
    ['an async generator\'s body', 'let rows = agen::async_gen(move |co: Co<W, W>| async move { co.yield_(v).await?; Ok(()) });', 0],
    ['join! of two awaits', 'let (a, b) = futures::join!(a, b);', 2],
    ['words in strings and comments', '// async fn, impl Drop for, ready(\nlet text = "async move { ready( }";', 0],
    ['a generator body hand-rolled on a coroutine', 'let body = Coroutine::new(async move { js::suspend().await; });', 2],
    ['a yield whose outcome is dropped', 'let _ = co.yield_(Resolution::Value(v)).await;', 1],
    ['a yield passed on with ?', 'co.yield_(Resolution::Value(v)).await?;\nlet inner = co.delegate(rows()).await?;', 0],
    ['a yield whose throw the JavaScript catches, marked', `${YIELD_MARKER} (try { yield } catch)\nlet outcome = co.yield_(Resolution::Value(v)).await;`, 0],
    ['a Rust loop over awaited rows for for await', 'for row in collect(rows()).await? {\n    report(row);\n}', 1],
    ['a for-of over an awaited array, marked', `${FOR_OF_MARKER}\nfor row in rows.await? {}`, 0],
    ['a plain for loop', 'for (index, chunk) in chunks.iter().enumerate() { co.yield_(v).await?; }', 0],
    ['a generator pumped by hand', 'loop {\n    let step = rows.next(W::Undefined).await?;\n    if step.done { break; }\n}', 1],
    ['the for await loop\'s own next and a marked manual next', `while let Some(row) = rows.next().await? {}\n${NEXT_MARKER}\nlet step = it.next(W::Undefined).await?;`, 0],
    ['a Rust stream', 'while let Some(x) = stream.poll_next(cx) {}\nuse futures_util::StreamExt;', 2],
    // The review's wrong ports that compiled silently (O2b-review.md, section 4).
    ['W1: a collection awaited into a binding, then a plain loop', 'let rows: Vec<W> = collect(entries(store, prefix)).await?;\nfor row in rows {\n    check(&row)?;\n}', 1],
    ['W1, over a reference or an iterator of the binding', 'let rows = collect(it).await?;\nfor row in &rows {}\nfor (i, row) in rows.iter().enumerate() {}', 2],
    ['a for-of over an awaited binding, marked', `let listing = list_directory(root).await?;\n${FOR_OF_MARKER}\nfor entry in listing {}`, 0],
    ['a loop over the items of an awaited JavaScript value (a method of the value)', 'let direct = list_direct_prefix(&snapshot).await?;\nfor row in direct.items() {}', 0],
    ['W2: a generator body as an async function collecting into an array', 'async_fn(async move { let mut rows = Vec::new(); let found = indexed().await?;\nfor r in found { rows.push(r); } Ok(Resolution::Value(W::Array(rows))) })', 1],
    ['W6: a return whose outcome is dropped', 'let _ = co.ret(Resolution::Value(W::Null)).await;\nco.ret(v).await;', 2],
    ['a return passed on as the body\'s Err', 'return Err(co.ret(Resolution::Value(value)).await);\nSome(co) => Err(co.ret(value).await),', 0],
    ['W8: a bare return; ported as return undefined', 'return Err(co.ret(Resolution::Value(W::Undefined)).await);', 1],
    ['an explicit return undefined, marked; a bare return', `${UNDEFINED_MARKER}\nreturn Err(co.ret(Resolution::Value(W::Undefined)).await);\nreturn Err(Abrupt::Return(W::Undefined));`, 0],
    // The `node` module's wrong shapes (rules 10 to 12), next to the right ones.
    ['await fs.promises.lstat(p) ported as the system call', 'async_fn(async move { let stat = ledger_io::fs::lstat(&p).map_err(|e| e.message)?; Ok(Resolution::Value(stat.size)) })', 1],
    ['a use of the blocking functions, and std::fs', 'use ledger_io::fs::{lstat, read_file};\nlet bytes = std::fs::read(&p)?;\nuse std::{fs, io};', 3],
    ['an fs.lstatSync, marked, and the facade', `${SYNC_MARKER} (fs.lstatSync)\nlet stat = ledger_io::fs::lstat(&p);\nlet stat = node::fs::lstat(&p, true).await?;\nlet same = node::fs::lstat_sync(&p, true)?;`, 0],
    ['I/O settled outside the facade', 'let stat = host::blocking(move || lstat_of(&p)).await?;\nhost::submit::<u8>(work, deliver);\nuse crate::host::{self, blocking};', 3],
    ['a long-lived source of units outside the node module (a reader thread of a port\'s own)', 'let poster = host::open_source(move |chunk: Vec<u8>| push(chunk));\nuse crate::host::{open_source, Poster};', 2],
    ['a child process signalled or reaped by pid (no API but the system calls)', 'ledger_io::fs::sys::kill(pid, 9);\nlet status = ledger_io::fs::sys::reap(pid);', 2],
    ['a read stream with a cut of the port\'s own', 'let s = create_read_stream(&file, ReadStreamOptions { high_water_mark: size });\nlet t = node::stream::create_read_stream(&file, ReadStreamOptions { high_water_mark: 64 * 1024 + extra });', 2],
    ['the receipt\'s read stream and the default one', 'let s = create_read_stream(&file, ReadStreamOptions { high_water_mark: 128 * 1024 });\nlet t = create_read_stream(&file, ReadStreamOptions::DEFAULT);', 0],
    ['a generator yielding a FileHandle read loop, and re-cut bytes', 'agen::async_gen(move |co: Co<W, W>| async move {\n    loop { let got = handle.read(131072, None).await?; co.yield_(Resolution::Value(W::Bytes(got.bytes))).await?; }\n    for piece in whole.chunks(131072) { co.yield_(Resolution::Value(piece)).await?; }\n})', 2],
    ['a JavaScript read loop in a generator, marked; a read loop in an async function', `agen::async_gen(move |co: Co<W, W>| async move {\n    ${READ_LOOP_MARKER}\n    let got = handle.read(16, Some(0)).await?;\n    Ok(())\n})\nasync_fn(async move { let got = input.read(65536, None).await?; Ok(Resolution::Value(got)) })`, 0],
  ];
  for (const [name, source, expected] of cases) {
    test(`${name}: ${expected ? `refused (${expected})` : 'accepted'}`, () => {
      assert.equal(lintPortedSource(source).length, expected, JSON.stringify(lintPortedSource(source)));
    });
  }
});

// Rule 1's guard inside the `node` module itself: `node::submit` (mod.rs)
// is the module's only way to the pool, so no completion of the facade or
// the read stream can go around its epoch check.
describe('the node module reaches the pool only through its guarded submit', () => {
  test('host::submit, host::blocking and host::open_source appear in src/node only in node::submit and node::source (mod.rs)', () => {
    const dir = path.join(crate, 'node');
    const found = [];
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.rs'))) {
      const code = readFileSync(path.join(dir, name), 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
      const uses = [...code.matchAll(/\bhost::(?:blocking|submit|open_source)\b/g)].length;
      const allowed = name === 'mod.rs' ? 2 : 0;
      if (uses !== allowed) found.push(`${name}: ${uses} (expected ${allowed})`);
    }
    assert.deepEqual(found, []);
  });
});
