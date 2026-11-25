#!/usr/bin/env node
// Planted bugs in the native ledger's `node` module (the `fs.promises`
// facade, the read stream, `zlib.deflate`, and what they need of the job
// layer and `ledger-io`): each is one small change to the Rust in a copy of
// the workspace, and each must be caught by the named tests beside it: the
// module's unit tests (`cargo test -p ledger-native --lib node::`) or tests
// of fs-differential.mjs (selected by name), run against the mutated probe.
// The unchanged copy must pass the same tests first. Outside the gate: it
// rebuilds the probe once per bug. A bug that hangs is caught by the tests'
// own deadlines (a step that does not answer, a descriptor not closed).
//
//   node scripts/ledger-native/fs-planted.mjs [--only='<name>;<name>']
//   node scripts/ledger-native/fs-planted.mjs --gate [--only=…]
//     every bug here and the review's (REVIEWED) against the whole of what
//     the verify runs for the module: `cargo test --workspace --all-features`
//     and all of fs-differential.mjs; a survivor then against the extended
//     run of fs-differential.mjs. Each bug is reported as caught by the
//     verify, by the extended run only, or surviving both.
//
// Like the build script it is started without the isolation preload (it needs
// the owner's Rust toolchain); every test it runs gets the preload.
//
// Exit status 0 when every bug was caught, 1 otherwise; a JSON summary is the last line.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { LEDGER_PROBE_VARIABLE, workspaceCopy } from '../build-ledger-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const DIFFERENTIAL = 'scripts/ledger-native/fs-differential.mjs';
const NODE = 'ledger-native/src/node';
const IO = 'ledger-io/src';
const RULE1 = 'rule 1: |named programs|random I/O programs';
const OUTCOMES = (name) => `^outcome: ${name}`;
const INLINE = '\nfn inline<T, F: FnOnce() -> T, D: FnOnce(T)>(work: F, deliver: D) {\n    deliver(work());\n}\n';

/** name, file under the workspace, the text replaced (exactly once), its replacement, `append`ed text, the tests that must catch it (a name pattern of fs-differential.mjs; `unit` for the module's cargo tests). */
export const PLANTED = Object.freeze([
  // Rule 1.
  { name: 'a completion settled inline, its guard removed', file: `${NODE}/mod.rs`, find: '    crate::host::submit(work, move |value: T| {\n        settled_in_a_later_checkpoint(started);', replace: '    inline(work, move |value: T| {\n        let _ = started;', append: INLINE, tests: RULE1, unit: true },
  { name: 'a completion settled inline (the guard ends the process)', file: `${NODE}/mod.rs`, find: '    crate::host::submit(work, move |value: T| {', replace: '    inline(work, move |value: T| {', append: INLINE, tests: RULE1, unit: true },
  { name: 'the loop delivers blocking work inline', file: 'ledger-native/src/host.rs', find: '        let id = self.next_blocking.get() + 1;\n        self.next_blocking.set(id);\n        let frame = js::current_frame();', replace: '        if std::env::var_os("PATH").is_some() {\n            return deliver(work());\n        }\n        let id = self.next_blocking.get() + 1;\n        self.next_blocking.set(id);\n        let frame = js::current_frame();', tests: RULE1, unit: true },
  { name: 'zlib.deflate settled in its starting checkpoint', file: `${NODE}/zlib.rs`, find: '    io_with(\n        move || Ok(ledger_io::git::odb::zlib_deflate(&raw)),\n        |bytes| Ok(Rc::new(bytes)),\n    )', replace: '    Promise::resolve(crate::js::Resolution::Value(Rc::new(ledger_io::git::odb::zlib_deflate(&raw))))', tests: 'named programs' },
  { name: 'a read stream\'s open settled inline', file: `${NODE}/stream.rs`, find: '    super::submit(\n        move || lio::open_raw(&path, lio::constants::O_RDONLY, 0o666),', replace: '    super::tests_inline(\n        move || lio::open_raw(&path, lio::constants::O_RDONLY, 0o666),', append: '', extra: { file: `${NODE}/mod.rs`, append: '\npub(crate) fn tests_inline<T, F: FnOnce() -> T, D: FnOnce(T)>(work: F, deliver: D) {\n    deliver(work());\n}\n' }, tests: 'named programs' },
  { name: 'the checkpoint epoch never advances', file: 'ledger-native/src/js.rs', find: '        self.epoch.set(self.epoch.get() + 1);', replace: '', tests: RULE1, unit: true },
  // Results and errors (outcomes).
  { name: 'readFile stops after its first read', file: `${NODE}/fs.rs`, find: '        if got == 0 || total == size || (got != length && !chunked && !no_size) {', replace: '        if true {', tests: OUTCOMES('readFile: empty') },
  { name: 'readFile utf8 not decoded as Node decodes ill-formed bytes', file: `${NODE}/fs.rs`, find: 'closing(fd, read_whole(fd, true)).map(|bytes| JsStr::from_utf8_lossy(&bytes))', replace: 'closing(fd, read_whole(fd, true)).map(|bytes| JsStr::from(String::from_utf8(bytes).unwrap_or_default().as_str()))', tests: OUTCOMES('readFile: empty') },
  { name: 'a libuv errno reported positive', file: `${NODE}/mod.rs`, find: '    if libuv {\n        if let Some(errno) = error.errno {\n            made.set_field("errno", W::Number(f64::from(errno)));', replace: '    if libuv {\n        if let Some(errno) = error.errno {\n            made.set_field("errno", W::Number(f64::from(-errno)));', tests: OUTCOMES('access') },
  { name: 'the wrong syscall in readlink\'s error', file: `${IO}/fs.rs`, find: 'let length = check(result, "readlink", Some(path))? as usize;', replace: 'let length = check(result, "readLink", Some(path))? as usize;', tests: OUTCOMES('readlink and realpath') },
  { name: 'a listing\'s every failure as ENOENT', file: `${IO}/fs.rs`, find: '        Error::os(\n            error.raw_os_error().unwrap_or(libc::EIO),\n            "scandir",\n            Some(dir),\n        )\n    };\n    let mut raw = Vec::new();\n    for entry in std::fs::read_dir(dir).map_err(map)? {\n        let entry = entry.map_err(map)?;\n        let kind = match', replace: '        let _ = error;\n        Error::os(libc::ENOENT, "scandir", Some(dir))\n    };\n    let mut raw = Vec::new();\n    for entry in std::fs::read_dir(dir).map_err(map)? {\n        let entry = entry.map_err(map)?;\n        let kind = match', tests: OUTCOMES('readdir') },
  { name: 'readdir\'s symbolic links as files', file: `${IO}/fs.rs`, find: '            Ok(kind) if kind.is_symlink() => DirentKind::SymbolicLink,', replace: '            Ok(kind) if kind.is_symlink() => DirentKind::File,', tests: OUTCOMES('readdir') },
  { name: 'readdir not in libuv\'s order', file: `${IO}/fs.rs`, find: '    raw.sort_by(|left, right| left.0.cmp(&right.0));\n    Ok(raw\n        .into_iter()\n        .map(|(name, kind)|', replace: '    raw.sort_by(|left, right| right.0.cmp(&left.0));\n    Ok(raw\n        .into_iter()\n        .map(|(name, kind)|', tests: OUTCOMES('readdir') },
  { name: 'a recursive mkdir resolves to the last directory made', file: `${IO}/fs.rs`, find: '                    first.get_or_insert_with(|| next.clone());', replace: '                    first = Some(next.clone());', tests: OUTCOMES('mkdir: plain') },
  { name: 'rm without force accepts a missing path', file: `${IO}/atomic.rs`, find: '        Err(error) if force && error.is_not_found() => {}', replace: '        Err(error) if error.is_not_found() => {}', tests: OUTCOMES('rm: a file') },
  { name: 'rm without recursive removes a directory', file: `${IO}/atomic.rs`, find: '        Ok(stat) if stat.is_directory() && !recursive => {', replace: '        Ok(stat) if stat.is_directory() && !recursive && force && !force => {', tests: OUTCOMES('rm: a file') },
  { name: 'utimes takes a Date\'s milliseconds as seconds', file: `${NODE}/fs.rs`, find: '            Time::Date(ms) => Ok(ms / 1000.0),', replace: '            Time::Date(ms) => Ok(ms),', tests: OUTCOMES('utimes') },
  { name: 'copyFile drops COPYFILE_EXCL', file: `${NODE}/fs.rs`, find: '        io(move || lio::copyfile(&src, &dest, mode))', replace: '        io(move || lio::copyfile(&src, &dest, mode & !1))', tests: OUTCOMES('copyFile') },
  { name: '\'wx\' opened as \'w\'', file: `${IO}/fs.rs`, find: '        "wx" | "xw" => O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,', replace: '        "wx" | "xw" => O_TRUNC | O_CREAT | O_WRONLY,', tests: OUTCOMES('writeFile') },
  { name: 'a stat\'s mtimeMs without its nanoseconds', file: `${NODE}/fs.rs`, find: '        time.0 as f64 * 1e3 + time.1 as f64 / 1e6', replace: '        time.0 as f64 * 1e3', tests: OUTCOMES('lstat and stat') },
  { name: 'a bigint stat\'s *Ns without its nanoseconds', file: `${NODE}/fs.rs`, find: '        time.0 as i128 * 1_000_000_000 + time.1 as i128', replace: '        time.0 as i128 * 1_000_000_000', tests: OUTCOMES('lstat and stat') },
  // Writes acknowledged before they are on disk.
  { name: 'writeFile acknowledged before its bytes are written', file: `${NODE}/fs.rs`, find: '            closing(fd, write_whole(fd, &bytes))', replace: '            let _later = std::thread::spawn(move || {\n                std::thread::sleep(std::time::Duration::from_millis(200));\n                let _ = closing(fd, write_whole(fd, &bytes));\n            });\n            Ok(())', tests: OUTCOMES('writeFile') },
  { name: 'a handle\'s write acknowledged without writing', file: `${NODE}/fs.rs`, find: 'Answer::Io(io(move || lio::write_at(fd, &bytes, position)))', replace: 'Answer::Io(io(move || Ok(bytes.len() + position.map_or(0, |_| 0))))', tests: OUTCOMES('open and a FileHandle: wx') },
  // Handles.
  { name: 'a second close reaches the descriptor', file: `${NODE}/fs.rs`, find: '        if state.fd.get() == -1 {\n            return fulfilled(());', replace: '        if state.fd.get() == -2 {\n            return fulfilled(());', tests: OUTCOMES('open and a FileHandle: read'), unit: true },
  { name: 'an operation on a closed handle reaches the descriptor', file: `${NODE}/fs.rs`, find: '        if fd == -1 {\n            return rejected(closed_handle(syscall));\n        }', replace: '        if fd == -2 {\n            return rejected(closed_handle(syscall));\n        }', tests: OUTCOMES('open and a FileHandle: read'), unit: true },
  // Rule 3.
  { name: 'the read stream reads 64 KiB whatever its high-water mark', file: `${NODE}/stream.rs`, find: '        move || lio::read(fd, n, None),', replace: '        move || lio::read(fd, n.min(65536), None),', tests: 'rule 3: ', unit: true },
  { name: 'the read stream\'s reads one byte short', file: `${NODE}/stream.rs`, find: '        move || lio::read(fd, n, None),', replace: '        move || lio::read(fd, n - 1, None),', tests: 'rule 3: ', unit: true },
  // Rule 2.
  { name: 'data delivered after end (a value held for a timer)', file: `${NODE}/stream.rs`, find: '        emit(stream, "data", &W::Bytes(chunk));', replace: '        let later = stream.clone();\n        let _ = crate::host::set_timeout(1.0, move || emit(&later, "data", &W::Bytes(chunk)));', tests: 'named programs|random I/O programs' },
  { name: 'close before end', file: `${NODE}/stream.rs`, find: '        stream.end_emitted.set(true);\n        emit(stream, "end", &W::Undefined);', replace: '        stream.end_emitted.set(true);\n        emit(stream, "close", &W::Undefined);\n        emit(stream, "end", &W::Undefined);', tests: 'named programs' },
  { name: 'an error swallowed (neither emitted nor thrown at for await)', file: `${NODE}/stream.rs`, find: '            if !later.eos_attached.get() || later.emitter.listener_count("error") > 0 {\n                emit(&later, "error", &error);\n            }\n            eos_on_error(&later, error);', replace: '            let _ = error;', tests: 'a missing file|a directory' },
  { name: 'for await ends before the stream closed', file: `${NODE}/stream.rs`, find: 'fn eos_on_end(stream: &Rc<Inner>) {\n    stream.eos_readable_finished.set(true);', replace: 'fn eos_on_end(stream: &Rc<Inner>) {\n    stream.eos_readable_finished.set(true);\n    eos_callback(stream, None);', tests: 'ends after its close', unit: true },
  { name: 'a handle left open after break', file: `${NODE}/stream.rs`, find: '    destroy(stream, if finished { None } else { Some(abort_error()) });', replace: '    let _ = (finished, abort_error);', tests: 'for await left at once' },
  { name: 'the descriptor closed while its read is in flight', file: `${NODE}/stream.rs`, find: 'fn start_destroy(stream: &Rc<Inner>, error: Option<W>) {\n    if stream.performing_io.get() {', replace: 'fn start_destroy(stream: &Rc<Inner>, error: Option<W>) {\n    if stream.performing_io.get() && stream.performing_io.get() != stream.performing_io.get() {', tests: 'left while a read is in flight', unit: true },
]);

/**
 * The independent review's 25 plants (O2fd review, `review-plants.mjs`),
 * adapted to the code after its fixes where the text moved (6 to 8: the
 * handle methods' `Answer`). `--gate` runs them, and the bugs above, against
 * the whole of what the verify runs for this module.
 */
export const REVIEWED = Object.freeze([
  { name: 'R1 ENOTDIR reported as ENOENT', file: `${NODE}/mod.rs`, find: '    let mut made = JsError::new(name, &error.message);', replace: '    let mut made = JsError::new(name, &error.message);\n    let error = &{ let mut e = error.clone(); if e.code == "ENOTDIR" { e.code = String::from("ENOENT"); } e };' },
  { name: 'R2 syscall dropped from every error', file: `${NODE}/mod.rs`, find: '    if let Some(syscall) = error.syscall {', replace: '    if let Some(syscall) = error.syscall.filter(|_| false) {' },
  { name: 'R3 dest dropped from two-path errors', file: `${NODE}/mod.rs`, find: '    if let Some(dest) = &error.dest {', replace: '    if let Some(dest) = error.dest.as_ref().filter(|_| false) {' },
  { name: 'R4 access swallows EACCES', file: `${NODE}/fs.rs`, find: '    checked!([("path", &path)], || io(move || lio::access(&path, mode)))', replace: '    checked!([("path", &path)], || io(move || lio::access(&path, mode).or_else(|e| if e.code == "EACCES" { Ok(()) } else { Err(e) })))' },
  { name: 'R5 FileHandle.read one byte short', file: `${NODE}/fs.rs`, find: '                move || lio::read(fd, length, position),', replace: '                move || lio::read(fd, length.saturating_sub(1).max(1), position),' },
  { name: 'R6 small FileHandle reads answered inline', file: `${NODE}/fs.rs`, find: '            if length == 0 {\n                return Answer::Now(ReadResult {', replace: '            if length > 0 && length <= 16 {\n                return match lio::read(fd, length, position) { Ok(b) => Answer::Now(ReadResult { bytes_read: b.len(), bytes: Rc::new(b) }), Err(e) => Answer::Io(rejected(super::error_value(&e))) };\n            }\n            if length == 0 {\n                return Answer::Now(ReadResult {' },
  { name: 'R7 FileHandle.stat answered inline', file: `${NODE}/fs.rs`, find: '            Answer::Io(io(move || lio::fstat(fd).map(|raw| Stats { raw, bigint })))', replace: '            match lio::fstat(fd) { Ok(raw) => Answer::Now(Stats { raw, bigint }), Err(e) => Answer::Io(rejected(super::error_value(&e))) }' },
  { name: 'R8 FileHandle.close (no op in flight) answered inline', file: `${NODE}/fs.rs`, find: '            not_inline(io(move || lio::close(raw)))\n        } else {', replace: '            match lio::close(raw) { Ok(()) => fulfilled(()), Err(e) => rejected(super::error_value(&e)) }\n        } else {' },
  { name: 'R9 a stream buffers chunks in reverse (push_front)', file: `${NODE}/stream.rs`, find: '        stream.buffer.borrow_mut().push_back(chunk);', replace: '        stream.buffer.borrow_mut().push_front(chunk);' },
  { name: 'R10 close not emitted after a clean end', file: `${NODE}/stream.rs`, find: '        later.close_emitted.set(true);\n        emit(&later, "close", &W::Undefined);', replace: '        later.close_emitted.set(true);\n        if later.errored.borrow().is_some() { emit(&later, "close", &W::Undefined); }' },
  { name: 'R11 readFile (bytes) leaks its descriptor', file: `${NODE}/fs.rs`, find: '                closing(fd, read_whole(fd, false))', replace: '                read_whole(fd, false)' },
  { name: 'R12 writeFile leaks its descriptor when the write fails', file: `${NODE}/fs.rs`, find: '            closing(fd, write_whole(fd, &bytes))\n        })\n    })\n}', replace: '            write_whole(fd, &bytes).and_then(|()| lio::close(fd))\n        })\n    })\n}' },
  { name: 'R13 open\'s default mode 0o664', file: `${NODE}/fs.rs`, find: '    let mode = mode.unwrap_or(0o666);', replace: '    let mode = mode.unwrap_or(0o664);' },
  { name: 'R14 mkdir\'s default mode 0o775', file: `${NODE}/fs.rs`, find: '            recursive: false,\n            mode: 0o777,', replace: '            recursive: false,\n            mode: 0o775,' },
  { name: 'R15 bytesRead not counted', file: `${NODE}/stream.rs`, find: '                        .set(done.bytes_read.get() + bytes.len() as u64);', replace: '                        .set(done.bytes_read.get());' },
  { name: 'R16 FileHandle close not deferred behind an op in flight', file: `${NODE}/fs.rs`, find: '        let promise = if state.refs.get() == 0 {', replace: '        let promise = if state.refs.get() < 1000 {' },
  { name: 'R17 wrong syscall on a closed handle\'s stat', file: `${NODE}/fs.rs`, find: '        self.call("fstat", move |fd| {', replace: '        self.call("stat", move |fd| {' },
  { name: 'R18 rm force also ignores ENOTDIR', file: `${IO}/atomic.rs`, find: '        Err(error) if force && error.is_not_found() => {}', replace: '        Err(error) if force && (error.is_not_found() || error.code == "ENOTDIR") => {}' },
  { name: 'R19 statfs bavail reports bfree', file: `${IO}/fs.rs`, find: '        bavail: raw.f_bavail as i64,', replace: '        bavail: raw.f_bfree as i64,' },
  { name: 'R20 lstatSync follows symbolic links', file: `${NODE}/fs.rs`, find: '    lio::lstat(path)\n        .map(|raw| Stats { raw, bigint })\n        .map_err(|error| super::error_value(&error))', replace: '    lio::stat(path)\n        .map(|raw| Stats { raw, bigint })\n        .map_err(|error| super::error_value(&error))' },
  { name: 'R21 readdirSync(withFileTypes) drops the last entry', file: `${NODE}/fs.rs`, find: '    lio::readdir_entries(path)\n        .map(|entries| {\n            entries\n                .into_iter()', replace: '    lio::readdir_entries(path)\n        .map(|mut entries| {\n            entries.pop();\n            entries\n                .into_iter()' },
  { name: 'R22 readFile of an unknown size stops at a short read', file: `${NODE}/fs.rs`, find: '        if got == 0 || total == size || (got != length && !chunked && !no_size) {', replace: '        if got == 0 || total == size || (got != length && !chunked) {' },
  { name: 'R23 a stream error mid-read reported as the end', file: `${NODE}/stream.rs`, find: '                    Outcome::Failed(error) => return Err(Abrupt::Throw(error)),', replace: '                    Outcome::Failed(_) => return Err(Abrupt::Return(W::Undefined)),' },
  { name: 'R24 copyFile ignores COPYFILE_FICLONE_FORCE', file: `${NODE}/fs.rs`, find: '        io(move || lio::copyfile(&src, &dest, mode))', replace: '        io(move || lio::copyfile(&src, &dest, mode & !4))' },
  { name: 'R25 mkdir recursive loses its return value', file: `${NODE}/fs.rs`, find: '                lio::mkdir_recursive_first(&path, options.mode)', replace: '                lio::mkdir_recursive_first(&path, options.mode).map(|first| first.filter(|f| !f.ends_with(\'b\')))' },
]);

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  return { ok: result.status === 0, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function main(argv = process.argv.slice(2)) {
  const only = argv.find((arg) => arg.startsWith('--only='))?.slice(7).split(';');
  if (argv.includes('--gate')) return gate([...PLANTED, ...REVIEWED].filter((bug) => !only || only.includes(bug.name)));
  const planted = PLANTED.filter((bug) => !only || only.includes(bug.name));
  const copy = workspaceCopy();
  const probe = path.join(copy.scratch, 'target', 'debug', 'ledger-native-probe');
  let failed = true;
  const rows = [];
  try {
    const build = () => run(copy.cargo, ['build', '--locked', '--offline', '--package', 'ledger-native', '--features', 'test-hooks', '--bin', 'ledger-native-probe'], { cwd: copy.workspace, env: copy.env });
    const unit = () => run(copy.cargo, ['test', '--locked', '--offline', '--package', 'ledger-native', '--lib', '--', 'node::'], { cwd: copy.workspace, env: copy.env });
    const differential = (pattern) => run(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', '--test', `--test-name-pattern=${pattern}`, DIFFERENTIAL],
      { cwd: root, env: { ...process.env, [LEDGER_PROBE_VARIABLE]: probe }, timeout: 900_000, killSignal: 'SIGKILL' });
    // The unchanged copy passes everything the bugs are checked against.
    const base = build();
    if (!base.ok) throw new Error(`the unchanged probe does not build:\n${base.output.slice(-3000)}`);
    const baseline = unit();
    if (!baseline.ok) throw new Error(`the unchanged unit tests fail:\n${baseline.output.slice(-4000)}`);
    for (const pattern of new Set(planted.map((bug) => bug.tests).filter(Boolean))) {
      const result = differential(pattern);
      if (!result.ok) throw new Error(`the unchanged differential tests fail (${pattern}):\n${result.output.slice(-4000)}`);
    }
    for (const bug of planted) {
      const edits = [{ file: bug.file, find: bug.find, replace: bug.replace, append: bug.append }, ...(bug.extra ? [bug.extra] : [])];
      const originals = new Map();
      try {
        for (const edit of edits) {
          const file = path.join(copy.workspace, edit.file);
          const original = originals.get(file) ?? readFileSync(file, 'utf8');
          originals.set(file, original);
          let text = readFileSync(file, 'utf8');
          if (edit.find !== undefined) {
            const count = text.split(edit.find).length - 1;
            if (count !== 1) throw new Error(`planted bug "${bug.name}": its text occurs ${count} times in ${edit.file}`);
            text = text.replace(edit.find, edit.replace);
          }
          if (edit.append) text += edit.append;
          writeFileSync(file, text);
        }
        const built = build();
        if (!built.ok) throw new Error(`planted bug "${bug.name}" does not build:\n${built.output.slice(-3000)}`);
        const unitCaught = bug.unit ? !unit().ok : null;
        const outcome = bug.tests ? differential(bug.tests) : null;
        const differentialCaught = outcome ? !outcome.ok : null;
        const caught = unitCaught === true || differentialCaught === true;
        const why = outcome && !outcome.ok ? (/(?:not ok \d+ - |✖ )([^\n]+)/.exec(outcome.output)?.[1] ?? '') : '';
        rows.push({ name: bug.name, unit: unitCaught, differential: differentialCaught, caught, by: why });
        console.log(`${caught ? 'caught  ' : 'SURVIVED'} ${bug.name}: ${bug.unit ? `unit tests ${unitCaught ? 'failed' : 'passed'}, ` : ''}differential (${bug.tests}) ${differentialCaught ? `failed: ${why}` : 'passed'}`);
      } finally {
        for (const [file, original] of originals) writeFileSync(file, original);
      }
    }
    failed = rows.some((row) => !row.caught);
    console.log(JSON.stringify({ planted: rows.length, caught: rows.filter((row) => row.caught).length, byUnit: rows.filter((row) => row.unit).length, byDifferential: rows.filter((row) => row.differential).length }));
    return failed ? 1 : 0;
  } finally {
    copy.dispose(failed);
  }
}

/** Applies `bug` to the copy, runs `check`, restores the files; `check`'s result, or null when the bug does not build. */
function withBug(copy, bug, build, check) {
  const edits = [{ file: bug.file, find: bug.find, replace: bug.replace, append: bug.append }, ...(bug.extra ? [bug.extra] : [])];
  const originals = new Map();
  try {
    for (const edit of edits) {
      const file = path.join(copy.workspace, edit.file);
      const original = originals.get(file) ?? readFileSync(file, 'utf8');
      originals.set(file, original);
      let text = readFileSync(file, 'utf8');
      if (edit.find !== undefined) {
        const count = text.split(edit.find).length - 1;
        if (count !== 1) throw new Error(`planted bug "${bug.name}": its text occurs ${count} times in ${edit.file}`);
        text = text.replace(edit.find, edit.replace);
      }
      if (edit.append) text += edit.append;
      writeFileSync(file, text);
    }
    const built = build();
    if (!built.ok) throw new Error(`planted bug "${bug.name}" does not build:\n${built.output.slice(-3000)}`);
    return check();
  } finally {
    for (const [file, original] of originals) writeFileSync(file, original);
  }
}

function gate(bugs) {
  const copy = workspaceCopy();
  const probe = path.join(copy.scratch, 'target', 'debug', 'ledger-native-probe');
  let failed = true;
  const rows = [];
  try {
    const build = () => run(copy.cargo, ['build', '--locked', '--offline', '--package', 'ledger-native', '--features', 'test-hooks', '--bin', 'ledger-native-probe'], { cwd: copy.workspace, env: copy.env });
    const unit = () => run(copy.cargo, ['test', '--locked', '--offline', '--workspace', '--all-features'], { cwd: copy.workspace, env: copy.env, timeout: 1_800_000, killSignal: 'SIGKILL' });
    const differential = (extended) => run(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', '--test', DIFFERENTIAL],
      { cwd: root, env: { ...process.env, [LEDGER_PROBE_VARIABLE]: probe, ...(extended ? { LEDGER_NATIVE_ODB_EXTENDED: '1' } : { LEDGER_NATIVE_ODB_EXTENDED: '' }) }, timeout: 1_800_000, killSignal: 'SIGKILL' });
    const why = (result) => (/(?:not ok \d+ - |✖ )([^\n]+)/.exec(result.output)?.[1] ?? /test (\S+) \.\.\. FAILED/.exec(result.output)?.[1] ?? `exit ${result.status}`).slice(0, 160);
    if (!build().ok) throw new Error('the unchanged probe does not build');
    if (!unit().ok) throw new Error('the unchanged cargo tests fail');
    if (!differential(false).ok) throw new Error('the unchanged fs-differential fails');
    for (const bug of bugs) {
      const row = withBug(copy, bug, build, () => {
        const u = unit();
        const d = u.ok ? differential(false) : null;
        const verify = !u.ok || !d.ok;
        const e = verify ? null : differential(true);
        return { name: bug.name, verify, extendedOnly: e ? !e.ok : false, by: !u.ok ? `cargo test: ${why(u)}` : !d.ok ? `fs-differential: ${why(d)}` : e && !e.ok ? `extended: ${why(e)}` : '' };
      });
      rows.push(row);
      console.log(`${row.verify ? 'verify  ' : row.extendedOnly ? 'extended' : 'SURVIVED'} ${row.name}${row.by ? `: ${row.by}` : ''}`);
    }
    failed = false;
    console.log(JSON.stringify({ planted: rows.length, verify: rows.filter((row) => row.verify).length, extendedOnly: rows.filter((row) => row.extendedOnly).length, survived: rows.filter((row) => !row.verify && !row.extendedOnly).map((row) => row.name) }));
    return rows.every((row) => row.verify || row.extendedOnly) ? 0 : 1;
  } finally {
    copy.dispose(failed);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
