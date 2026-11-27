#!/usr/bin/env node
// Planted bugs in the native ledger's child processes (ledger-native/src/node
// child.rs and net.rs, and what they need of stream.rs): each is one small
// change to the Rust in a copy of the workspace, run against what the verify
// runs for the module: the crates' library tests (`cargo test -p ledger-native
// -p ledger-io --lib`) and all of child-differential.mjs, against the mutated
// probe. The
// unchanged copy must pass first. Each bug is reported with what caught it;
// `named` is the test the bug is planted for, which must be among those
// that fail. Outside the gate: it rebuilds the probe once per bug. A bug that
// hangs is caught by the tests' own deadlines.
//
//   node scripts/ledger-native/child-planted.mjs [--only='<name>;<name>']
//
// Exit status 0 when every bug was caught by its named test, 1 otherwise; a
// JSON summary is the last line.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { LEDGER_PROBE_VARIABLE, workspaceCopy } from '../build-ledger-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const DIFFERENTIAL = 'scripts/ledger-native/child-differential.mjs';
const NET = 'ledger-native/src/node/net.rs';
const CHILD = 'ledger-native/src/node/child.rs';
const PROC = 'ledger-io/src/process.rs';
const FS = 'ledger-io/src/fs.rs';

/**
 * `{ name, file, find, replace, extra, extra2, named }`: `named` is a pattern
 * of the failing test's name that must catch it. The first twelve are the
 * builder's; `R…` are the O2e review's plants that escaped the gate (fix
 * round 1 added the case each names); `F…` are the fix round's own.
 */
export const BUGS = Object.freeze([
  { name: 'wrong event order within a source: an output\'s chunks delivered two by two in reverse', file: NET,
    find: `        ReadEvent::Data(bytes) => {
            if !stream.destroyed.get() && !stream::push(stream, Some(bytes)) {
                read_stop(&handle);
            }
        }`,
    replace: `        ReadEvent::Data(bytes) => {
            let held = handle.held.borrow_mut().take();
            match held {
                None => *handle.held.borrow_mut() = Some(bytes),
                Some(first) => {
                    if !stream.destroyed.get() {
                        stream::push(stream, Some(bytes));
                        stream::push(stream, Some(first));
                    }
                }
            }
        }`,
    extra: { file: NET, find: '    closed: Cell<bool>,\n    /// The frame the handle was made in', replace: '    closed: Cell<bool>,\n    held: RefCell<Option<Vec<u8>>>,\n    /// The frame the handle was made in' },
    extra2: { file: NET, find: '            closed: Cell::new(false),\n            frame: js::current_frame(),', replace: '            closed: Cell::new(false),\n            held: RefCell::new(None),\n            frame: js::current_frame(),' },
    named: /outcome: (300 KB|1 MiB through cat|tokens)/ },
  { name: 'close before exit (maybeClose before the exit event)', file: CHILD,
    find: `        let status = child.status();
        emit(child, "exit", &status);
    }
    let later = child.clone();
    js::next_tick(move || flush_stdio(&later));
    maybe_close(child);`,
    replace: `        maybe_close(child);
        let status = child.status();
        emit(child, "exit", &status);
        let later = child.clone();
        js::next_tick(move || flush_stdio(&later));
        return;
    }
    let later = child.clone();
    js::next_tick(move || flush_stdio(&later));
    maybe_close(child);`,
    named: /close_comes_after_the_exit_when_the_outputs_closed_first|outcome: both outputs closed early/ },
  { name: 'output after end: the last chunk held back and pushed after the end', file: NET,
    find: '                let data = matches!(event, ReadEvent::Data(_));\n                if !gate.deliver(data, || poster.post(event)) {',
    replace: `                let event = match event {
                    ReadEvent::Data(bytes) => match held.replace(bytes) {
                        Some(before) => ReadEvent::Data(before),
                        None => continue,
                    },
                    ReadEvent::Eof => {
                        poster.post(ReadEvent::Eof);
                        if let Some(last) = held.take() {
                            poster.post(ReadEvent::Data(last));
                        }
                        return;
                    }
                    other => other,
                };
                let data = matches!(event, ReadEvent::Data(_));
                if !gate.deliver(data, || poster.post(event)) {`,
    extra: { file: NET, find: '            let mut buffer = vec![0u8; READ_SIZE];\n', replace: '            let mut buffer = vec![0u8; READ_SIZE];\n            let mut held: Option<Vec<u8>> = None;\n' },
    extra2: { file: NET, find: `        ReadEvent::Data(_) | ReadEvent::Eof | ReadEvent::Error(_) if handle.is_closing() => {}`, replace: `        ReadEvent::Data(bytes) if stream.ended.get() => { stream::emit(stream, "data", &W::Bytes(Rc::new(bytes))); return; }
        ReadEvent::Data(_) | ReadEvent::Eof | ReadEvent::Error(_) if handle.is_closing() => {}` },
    named: /outcome:|programs/ },
  { name: 'a settle in the starting checkpoint: a handle\'s close completed inside the code that closed it', file: NET,
    find: `        let handle = self.clone();
        super::submit(
            move || sys::close(fd),
            move |()| {
                let callback = handle.closing.borrow_mut().take();
                handle.closed.set(true);
                if let Some(callback) = callback {
                    js::with_frame(handle.frame.clone(), callback);
                }
            },
        );`,
    replace: `        sys::close(fd);
        let callback = self.closing.borrow_mut().take();
        self.closed.set(true);
        if let Some(callback) = callback {
            js::with_frame(self.frame.clone(), callback);
        }`,
    named: /outcome: (pipeline of a generator that throws|1 MiB into a child)|programs/ },
  { name: 'a lost last chunk: the reader drops what it read before the end', file: NET,
    find: '                let data = matches!(event, ReadEvent::Data(_));\n                if !gate.deliver(data, || poster.post(event)) {',
    replace: `                let event = match event {
                    ReadEvent::Data(bytes) => match held.replace(bytes) {
                        Some(before) => ReadEvent::Data(before),
                        None => continue,
                    },
                    other => other,
                };
                let data = matches!(event, ReadEvent::Data(_));
                if !gate.deliver(data, || poster.post(event)) {`,
    extra: { file: NET, find: '            let mut buffer = vec![0u8; READ_SIZE];\n', replace: '            let mut buffer = vec![0u8; READ_SIZE];\n            let mut held: Option<Vec<u8>> = None;\n' },
    named: /outcome:|for_await_reads_stdout/ },
  { name: 'a leaked descriptor: a socket\'s descriptor never closed', file: NET,
    find: '            move || sys::close(fd),', replace: '            move || drop(fd),',
    named: /outcome:/ },
  { name: 'a child left running after kill (the signal never sent)', file: CHILD,
    find: '        match sys::kill(pid, signal.number()) {', replace: '        match sys::kill(pid, if signal.number() == 0 { 0 } else { libc_sigcont() }) {',
    extra: { file: CHILD, find: '/// Children spawned and not yet reaped, for the tests\' census.', replace: 'fn libc_sigcont() -> i32 {\n    lprocess::signal_number("SIGCONT").expect("SIGCONT")\n}\n\n/// Children spawned and not yet reaped, for the tests\' census.' },
    named: /outcome: (a timer kills|kill at spawn|break after|past the byte limit)|kill_signals_a_live_child/ },
  { name: 'a reaped pid signalled (kill after the reap reaches kill(2))', file: CHILD,
    find: `        let Some(pid) = self.0.handle.get() else {
            return Ok(false);
        };`,
    replace: `        let Some(pid) = self.0.handle.get().or(self.0.pid.get()) else {
            return Ok(false);
        };`,
    named: /kill_signals_a_live_child_and_is_a_no_op_once_it_is_reaped/ },
  { name: 'close on exit alone (the outputs not counted by maybeClose)', file: CHILD,
    find: '            child.0.closes_needed.set(child.0.closes_needed.get() + 1);', replace: '            child.0.closes_needed.set(child.0.closes_needed.get());',
    named: /outcome: a grandchild holds stdout|outcome:|programs|a_child_s_events/ },
  { name: 'exit before the stdin is destroyed', file: CHILD,
    find: `    let stdin = inner.stdin.borrow().clone();
    if let Some(stdin) = stdin {
        stdin.destroy(None);
    }
    inner.handle.set(None);`,
    replace: `    let stdin = inner.stdin.borrow().clone();
    let later_stdin = stdin.clone();
    js::queue_microtask(move || if let Some(stdin) = later_stdin { stdin.destroy(None) });
    let _ = stdin;
    inner.handle.set(None);`,
    named: /outcome:|programs/ },
  { name: 'a reaping waiter (the exit reaped off the loop thread: pid reuse open)', file: CHILD,
    find: '        move || match sys::wait_exited(pid) {', replace: '        move || match sys::wait_exited(pid).and_then(|()| sys::reap(pid).map(|_| ())) {',
    named: /the_exit_is_seen_without_reaping_until_the_loop_reaps/ },
  { name: 'writes always as units (a write that goes at once completes in a later unit)', file: NET,
    find: '        Ok(written) if written == chunk.len() => onwrite(stream, None),\n', replace: '',
    named: /named programs/ },
  // The review's escapes (O2e-review.md, "Planted bugs").
  { name: 'R04 the PATH searched in reverse order', file: PROC,
    find: 'for entry in path.split(\':\') {', replace: 'for entry in path.rsplit(\':\') {',
    named: /outcome: PATH searched in order/ },
  { name: 'R05 an EACCES on PATH not remembered (ENOENT reported)', file: PROC,
    find: '    if seen_eacces {\n        return Err(libc::EACCES);\n    }\n    Err(last)', replace: '    let _ = (seen_eacces, last);\n    Err(libc::ENOENT)',
    named: /outcome: PATH whose only entry has a directory named like the program/ },
  { name: 'R06 an empty PATH entry skipped (not the working directory)', file: PROC,
    find: '            file.to_owned()\n        } else {', replace: '            continue;\n        } else {',
    named: /outcome: PATH with an empty first entry/ },
  { name: 'R08 the default search path wrong (an environment without PATH)', file: PROC,
    find: 'const DEFAULT_PATH: &str = "/usr/bin:/bin";', replace: 'const DEFAULT_PATH: &str = "/nonexistent-o2e-review";',
    named: /outcome: no PATH in the environment/ },
  { name: 'R14 the stdin counted by maybeClose (close waits for the stdin\'s close)', file: CHILD,
    find: '        if at > 0 {\n            child.0.closes_needed', replace: '        if at < 3 {\n            child.0.closes_needed',
    named: /close_does_not_wait_for_the_stdin_s_close/ },
  { name: 'R16 a reader parked at its gate lingers 20 s after its stop (a leaked thread)', file: NET,
    find: '                if !gate.wait_ready() {\n                    poster.post(ReadEvent::Stopped);\n                    return;\n                }',
    replace: '                if !gate.wait_ready() {\n                    poster.post(ReadEvent::Stopped);\n                    std::thread::sleep(std::time::Duration::from_secs(20));\n                    return;\n                }',
    named: /outcome: more than the high-water mark to an unread stdout/ },
  { name: 'R20 the callbacks of writes buffered together dropped (the writev path)', file: NET,
    find: '            for cb in callbacks.into_iter().flatten() {\n                cb(error.clone());\n            }', replace: '            let _ = (callbacks, error);',
    named: /outcome: three large writes with callbacks/ },
  { name: 'R23a POSIX_SPAWN_CLOEXEC_DEFAULT dropped (the Linux shape on macOS)', file: FS,
    find: '                    | libc::POSIX_SPAWN_SETSIGMASK\n                    | libc::POSIX_SPAWN_CLOEXEC_DEFAULT;', replace: '                    | libc::POSIX_SPAWN_SETSIGMASK;',
    named: /outcome: the child gets its three descriptors/ },
  { name: 'R28 an EPIPE of a write swallowed (reported as written)', file: NET,
    find: '        Err(errno) => onwrite(stream, Some(errno_exception(errno, "write"))),\n        Ok(written) if written == chunk.len()', replace: '        Err(_) => onwrite(stream, None),\n        Ok(written) if written == chunk.len()',
    extra: { file: NET, find: '                    Err(errno) => {\n                        attempt(Some(WriteEvent::Failed(errno)));\n                        return;\n                    }\n                }\n            }\n        },', replace: '                    Err(_) => {\n                        attempt(Some(WriteEvent::Written));\n                        return;\n                    }\n                }\n            }\n        },' },
    named: /outcome: (1 MiB into a child|a child that closes its stdin|a timer kills a child that never reads)/ },
  { name: 'R29 a premature close of the stdin reported as finished (the pipeline fulfils)', file: NET,
    find: '                    (!ended).then(premature_close)', replace: '                    let _ = ended;\n                    None',
    named: /outcome: a generator row that waits for the exit/ },
  { name: 'R30 the stdin left blocking (an inline write blocks the loop)', file: CHILD,
    find: '        if at == 0 {\n            let _ = sys::set_nonblocking(*parent);\n        }', replace: '        let _ = at == 0;',
    named: /outcome: a timer kills a child that never reads its 1 MiB input/ },
  { name: 'R31 a reader keeps reading after readStop (backpressure gate ignored)', file: NET,
    find: 'fn read_stop(handle: &Handle) {\n    handle.reading.set(false);\n    if let Some(gate) = &handle.gate {\n        gate.change(|state| state.reading = false);\n    }\n}', replace: 'fn read_stop(handle: &Handle) {\n    let _ = handle;\n}',
    named: /outcome: an output nobody reads stops being read at the high-water mark/ },
  { name: 'R33 an EMFILE at spawn handled like ENOENT (the pairs made so far set up as stdio)', file: CHILD,
    find: '            if ["EMFILE", "ENFILE"].contains(&ledger_io::fs::error_name(errno).as_str()) {', replace: '            if false && ["EMFILE", "ENFILE"].contains(&ledger_io::fs::error_name(errno).as_str()) {',
    named: /outcome: at the descriptor limit, the second socket pair fails/ },
  // Two the review saw hang the differential (every case waiting out its
  // deadline): caught by the unit tests, and the differential now fails
  // after one deadline.
  { name: 'R25 an output\'s end never ends its writable side (never destroyed)', file: NET,
    find: '    let socket = socket_of(stream);\n    if writable(stream) {\n        let later = stream.clone();', replace: '    let socket = socket_of(stream);\n    if false && writable(stream) {\n        let later = stream.clone();',
    named: /a_missing_program_errors_on_a_tick_and_closes_after_its_outputs|a_child_s_events_keep_node_s_order_per_source/ },
  { name: 'R32 the parent keeps the child\'s ends of the socket pairs (a descriptor leak, EOF never seen)', file: CHILD,
    find: '    // The child\'s ends are the child\'s now (or nobody\'s).\n    for (_, end) in pairs.iter().flatten() {\n        sys::close(*end);\n    }', replace: '    // planted: the child\'s ends kept open in the parent',
    named: /a_child_s_events_keep_node_s_order_per_source/ },
  // Fix round 1's own.
  { name: 'F01 the reader\'s hold removed: it reads again before the loop took its last read (S1)', file: NET,
    find: '        state.in_flight = data;', replace: '        state.in_flight = data && false;',
    named: /outcome: a consumer that takes each chunk slowly|a_reader_reads_no_further_while_the_loop_has_not_taken_its_last_read/ },
  { name: 'F02 each chunk keeps the reader\'s whole 64 KiB buffer (S2)', file: NET,
    find: '                    Ok(read) => ReadEvent::Data(buffer[..read].to_vec()),', replace: '                    Ok(read) => ReadEvent::Data({\n                        let mut whole = buffer.clone();\n                        whole.truncate(read);\n                        whole\n                    }),',
    named: /the_chunks_a_reader_delivers_hold_only_their_own_bytes/ },
  { name: 'F03 the 64 KiB socket buffers not asked for (macOS keeps 8 KiB: reads an eighth of Node\'s)', file: FS,
    find: '            for option in [libc::SO_SNDBUF, libc::SO_RCVBUF] {', replace: '            for option in [libc::SO_SNDBUF, libc::SO_RCVBUF].into_iter().filter(|_| false) {',
    named: /outcome: (a consumer that takes each chunk slowly|the child's stdio sockets have Node's buffer sizes)/ },
  { name: 'F04 end-of-stream at the stdin\'s close ignores its errored (a cancelled write becomes a premature close, S3)', file: NET,
    find: '                    if let Some(errored) = inner.errored.borrow().clone() {\n                        return Some(errored);\n                    }', replace: '',
    named: /outcome: a child that exits while a grandchild holds its stdin|named programs/ },
  { name: 'F05 the exit waiter does not let a ready writer\'s attempt go first', file: NET,
    find: '            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);', replace: '            let deadline = std::time::Instant::now();',
    named: /the_exit_waits_for_the_writer_s_next_attempt_when_its_socket_is_ready/ },
  { name: 'F06 an empty cwd passed to the spawn (ENOENT where Node starts the child here, S4)', file: CHILD,
    find: '    let cwd = options.cwd.as_deref().filter(|cwd| !cwd.is_empty());', replace: '    let cwd = options.cwd.as_deref();',
    named: /outcome: an empty working directory is none/ },
  { name: 'F07 the environment in insertion order, not JavaScript\'s key order (S4)', file: CHILD,
    find: '        match index(&key) {', replace: '        match index(&key).filter(|_| false) {',
    named: /outcome: the environment in JavaScript's key order|env_pairs_keep_javascript_s_key_order/ },
  { name: 'F08 SIGEMT named (Node reports exit code 0 for it, S4)', file: FS,
    find: '        out.push((libc::SIGINFO, "SIGINFO"));', replace: '        out.extend([(libc::SIGINFO, "SIGINFO"), (libc::SIGEMT, "SIGEMT")]);',
    named: /outcome: death by a signal Node does not name|signals_are_named_as_node_names_them/ },
  { name: 'F09 an error nobody listens to swallowed (the worker would go on, F2)', file: CHILD,
    find: '    if let Err(error) = child.0.emitter.emit(event, value) {', replace: '    if let Err(error) = child.0.emitter.emit(event, value).map(|_| ()).or(Ok::<(), W>(())) {',
    named: /an error nobody listens to|F2/ },
  // L3b follow-up: a write's immediate failure (EPIPE) settles in the turn that wrote, as Node's.
  { name: 'L01 a write that fails at once reported a turn later (not on ticks of the writing turn)', file: NET,
    find: '        Err(errno) => onwrite(stream, Some(errno_exception(errno, "write"))),',
    replace: '        Err(errno) => {\n            let later = stream.clone();\n            let _ = crate::host::set_timeout(1.0, move || onwrite(&later, Some(errno_exception(errno, "write"))));\n        }',
    named: /a write failing EPIPE at once/ },
]);

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  return { ok: result.status === 0 && !result.error, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}` };
}

/** The names of the tests a run reports failed. */
function failures(output) {
  return [...output.matchAll(/(?:^|\n)\s*✖ ([^\n]+?)(?: \(\d[^)]*\))?(?=\n)/g), ...output.matchAll(/test (\S+) \.\.\. FAILED/g)].map((match) => match[1].trim());
}

function withBug(copy, bug, build, check) {
  const edits = [{ file: bug.file, find: bug.find, replace: bug.replace }, ...(bug.extra ? [bug.extra] : []), ...(bug.extra2 ? [bug.extra2] : [])];
  const originals = new Map();
  try {
    for (const edit of edits) {
      const file = path.join(copy.workspace, edit.file);
      const original = originals.get(file) ?? readFileSync(file, 'utf8');
      originals.set(file, original);
      const text = readFileSync(file, 'utf8');
      const count = text.split(edit.find).length - 1;
      if (count !== 1) throw new Error(`planted bug "${bug.name}": its text occurs ${count} times in ${edit.file}`);
      writeFileSync(file, text.replace(edit.find, edit.replace));
    }
    const built = build();
    if (!built.ok) throw new Error(`planted bug "${bug.name}" does not build:\n${built.output.slice(-3000)}`);
    return check();
  } finally {
    for (const [file, original] of originals) writeFileSync(file, original);
  }
}

export function main(argv = process.argv.slice(2)) {
  const only = argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(';');
  const bugs = only ? BUGS.filter((bug) => only.some((name) => bug.name.includes(name))) : BUGS;
  const copy = workspaceCopy();
  const probe = path.join(copy.scratch, 'target', 'debug', 'ledger-native-probe');
  let failed = true;
  const rows = [];
  try {
    const build = () => run(copy.cargo, ['build', '--locked', '--offline', '--package', 'ledger-native', '--features', 'test-hooks', '--bin', 'ledger-native-probe'], { cwd: copy.workspace, env: copy.env });
    const unit = () => run(copy.cargo, ['test', '--locked', '--offline', '--package', 'ledger-native', '--package', 'ledger-io', '--lib', '--all-features'], { cwd: copy.workspace, env: copy.env, timeout: 600_000, killSignal: 'SIGKILL' });
    const differential = () => run(process.execPath, ['--import=./scripts/test-isolation-preload.mjs', '--test', DIFFERENTIAL],
      { cwd: root, env: { ...process.env, [LEDGER_PROBE_VARIABLE]: probe, LEDGER_NATIVE_ODB_EXTENDED: '' }, timeout: 1_200_000, killSignal: 'SIGKILL' });
    if (!build().ok) throw new Error('the unchanged probe does not build');
    if (!unit().ok) throw new Error('the unchanged cargo tests fail');
    if (!differential().ok) throw new Error('the unchanged child-differential fails');
    for (const bug of bugs) {
      const row = withBug(copy, bug, build, () => {
        const u = unit(), started = Date.now(), d = differential();
        const failing = [...failures(u.output), ...failures(d.output)];
        const named = failing.filter((name) => bug.named.test(name));
        return { name: bug.name, caught: !u.ok || !d.ok, byNamed: named.length > 0, seconds: Math.round((Date.now() - started) / 1000), by: (named.length ? named : failing).slice(0, 3).join('; ').slice(0, 300) };
      });
      rows.push(row);
      console.log(`${row.byNamed ? 'caught  ' : row.caught ? 'OTHER   ' : 'SURVIVED'} ${row.name} (differential ${row.seconds} s)${row.by ? `: ${row.by}` : ''}`);
    }
    failed = false;
    console.log(JSON.stringify({ planted: rows.length, caughtByNamed: rows.filter((row) => row.byNamed).length, caught: rows.filter((row) => row.caught).length, survived: rows.filter((row) => !row.caught).map((row) => row.name) }));
    return rows.every((row) => row.byNamed) ? 0 : 1;
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
