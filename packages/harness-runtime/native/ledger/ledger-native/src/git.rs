//! The ledger's Git runner, `lib/session-changes-git.js` ported (plan
//! package L3b) on the job layer: one JavaScript async function is one
//! `async_fn`, one async generator one `agen::async_gen`, one `await` one
//! `.await`, and every child, socket and pipeline goes through `node::child`
//! and `node::net`. Nothing in the product calls it yet.
//!
//! - [`start`]: the one place a Git process starts: the abort listener, the
//!   `timeoutMs` timer (SIGKILL), stderr's 1 KiB head and tail (classified,
//!   never reported), `done` (the `close` classified into `capture_*`
//!   codes with `command` and `failure`), `writing` (the stdin pipeline,
//!   `EPIPE` and `ERR_STREAM_PREMATURE_CLOSE` swallowed, nothing else: the
//!   O2e F1 defect is kept, a raw `ECANCELED` or `ENOTCONN` rejects it).
//! - [`git`], [`git_tokens`], [`git_records`]: stdout collected under a
//!   limit, split into tokens, and `cat-file --batch` records in bounded
//!   batches; each `finally` kills the child and waits for `done` and
//!   `writing`.
//! - [`read_git_object`]: the persistent object reader's answers, read from
//!   the ledger repository in-process (`node::odb`, research file 28
//!   section 5) instead of a long-lived `cat-file` process, with the
//!   reader's own queue: answers settle in request order per reader (as
//!   `cat-file` answers in order), and an answer that closes the JavaScript
//!   reader (a gitlink's `<id> submodule`, the defect of
//!   `session-changes-git.js:221-226`; a malformed header; a `cat-file`
//!   that died) rejects every request still pending on that reader. A name
//!   the database cannot answer exactly ("ask Git") is handed to a Git
//!   process for that one name (`cat-file --batch[-check]`, stderr ignored,
//!   as the reader's), parsed as the reader parses.
//! - [`create_owned_git_runner`], [`persistent_git_readers`],
//!   [`change_error`], [`git_failure`].
//!
//! The reader keeps the JavaScript reader's life: its 15 s idle close, its
//! watchdog (each second, the oldest pending read older than 30 s by
//! `Date.now()` closes it with `capture_timeout` 503, killing its hand-backs
//! and failing every pending read), and its other closes; its database
//! (packs kept open as Git keeps them) lives exactly as long.
//!
//! Not ported: `gitToFile` (a descriptor as stdout; only
//! `session-changes.js` calls it, outside the worker) and the reader's
//! `ref`/`unref` (the native process does not exit when its loop is idle).
//!
//! The JavaScript reads the execution context (`executionSignal()`,
//! `executionProgress()`) from an `AsyncLocalStorage`; here it is passed as
//! `ctx`, read where the JavaScript reads it (in `start`, before the spawn,
//! and in the `close` listener, which runs in the spawn's frame).
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use ledger_core::js::JsStr;

use crate::agen::{self, Abrupt, AsyncGen, Co};
use crate::ctx::{Ctx, execution_progress, execution_signal, type_error};
use crate::emitter::Listener;
use crate::host;
use crate::js::{self, Promise, Resolution, Resolvers, async_fn};
use crate::node::child::{self, ChildProcess, Signal, Spawn, Stdio};
use crate::node::net::{self, PipeInput};
use crate::node::{code_of, odb};
use crate::value::{Obj, W, status_error, string_to_number, to_js_string};
use crate::{Ret, WPromise};

/// `changeError(code, status = 409)`: `Object.assign(new Error(code), { code, status })`.
pub fn change_error(code: &str, status: f64) -> W {
    W::Error(Rc::new(status_error(code, status)))
}

/// `gitFailure(cause)`: the failed subcommand and failure class of an error.
pub fn git_failure(cause: &W) -> W {
    let mut out = Obj::new();
    if let W::String(command) = cause.get("command") {
        out.put("command", W::String(command));
    }
    if let W::String(failure) = cause.get("failure") {
        out.put("failure", W::String(failure));
    }
    W::Object(out)
}

/// The variables `gitEnvironment` sets to `undefined` (dropped by `spawn`),
/// in its literal's order.
const SCRUBBED: [&str; 6] = [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

/// `gitEnvironment(base, env)`: `{ ...base, GIT_DIR: undefined, …,
/// GIT_OPTIONAL_LOCKS: '0', ...env }`, as `spawn`'s `envPairs`.
fn git_environment(
    base: &[(String, String)],
    env: &[(String, Option<String>)],
) -> Vec<(String, String)> {
    let mut entries: Vec<(String, Option<String>)> = base
        .iter()
        .map(|(key, value)| (key.clone(), Some(value.clone())))
        .collect();
    entries.extend(SCRUBBED.iter().map(|key| ((*key).to_owned(), None)));
    entries.push((String::from("GIT_OPTIONAL_LOCKS"), Some(String::from("0"))));
    entries.extend(env.iter().cloned());
    child::env_pairs(entries)
}

/// `process.env` as an object's entries (the environment's own order).
fn process_env() -> Vec<(String, String)> {
    host::process_env()
}

const GLOBAL_OPTIONS_WITH_VALUE: [&str; 5] =
    ["--git-dir", "--work-tree", "--namespace", "-C", "-c"];

/// `gitCommand(args)`: the first word after the global options and their
/// values, if it is a plain command name (`/^[a-z][a-z-]{0,31}$/`).
fn git_command(args: &[String]) -> String {
    let mut index = 0;
    while index < args.len() {
        if GLOBAL_OPTIONS_WITH_VALUE.contains(&args[index].as_str()) {
            index += 2;
            continue;
        }
        if args[index].starts_with('-') {
            index += 1;
            continue;
        }
        let word = args[index].as_bytes();
        let plain = !word.is_empty()
            && word.len() <= 32
            && word[0].is_ascii_lowercase()
            && word[1..]
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || *byte == b'-');
        return if plain {
            args[index].clone()
        } else {
            String::from("unknown")
        };
    }
    String::from("unknown")
}

// --- The failure classes: JavaScript's /…/i over UTF-16 code units ------
//
// Non-unicode `/i` folds by `toUpperCase`, and never folds a code unit
// above 127 onto one below it, so for these ASCII patterns only ASCII
// letters fold.

fn fold(unit: u16) -> u16 {
    if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
        unit + 32
    } else {
        unit
    }
}

/// Whether `needle` (ASCII, lowercase) occurs at `at` in `hay`, folded.
fn at_folded(hay: &[u16], at: usize, needle: &str) -> bool {
    let needle = needle.as_bytes();
    at + needle.len() <= hay.len()
        && needle
            .iter()
            .enumerate()
            .all(|(offset, byte)| fold(hay[at + offset]) == u16::from(*byte))
}

/// Every position where `needle` occurs, folded.
fn positions<'a>(hay: &'a [u16], needle: &'a str) -> impl Iterator<Item = usize> + 'a {
    (0..hay.len()).filter(move |at| at_folded(hay, *at, needle))
}

fn contains_folded(hay: &[u16], needle: &str) -> bool {
    positions(hay, needle).next().is_some()
}

/// `.` without the `s` flag: anything but a line terminator.
fn line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// `<start> .* <tail>`: `start` then, on the same line, one of `tails`.
fn on_one_line(hay: &[u16], start: &str, tails: &[&str]) -> bool {
    positions(hay, start).any(|at| {
        let from = at + start.len();
        let mut index = from;
        loop {
            if tails.iter().any(|tail| at_folded(hay, index, tail)) {
                return true;
            }
            if index >= hay.len() || line_terminator(hay[index]) {
                return false;
            }
            index += 1;
        }
    })
}

/// `LOCK_FAILURE`: `/\.lock'?: File exists|Unable to create '[^']*\.lock'|cannot lock ref|unable to lock/i`.
fn lock_failure(hay: &[u16]) -> bool {
    let quote = u16::from(b'\'');
    contains_folded(hay, ".lock: file exists")
        || contains_folded(hay, ".lock': file exists")
        || positions(hay, "unable to create '").any(|at| {
            let from = at + "unable to create '".len();
            hay[from..]
                .iter()
                .position(|unit| *unit == quote)
                .is_some_and(|length| length >= 5 && at_folded(hay, from + length - 5, ".lock"))
        })
        || contains_folded(hay, "cannot lock ref")
        || contains_folded(hay, "unable to lock")
}

/// `CORRUPT_FAILURE`.
fn corrupt_failure(hay: &[u16]) -> bool {
    const PLAIN: [&str; 12] = [
        "bad object",
        "missing blob",
        "missing tree",
        "missing commit",
        "missing object",
        "is corrupt",
        "corrupt object",
        "corrupt loose object",
        "bad packed object",
        "inflate: data stream error",
        "did not receive expected object",
        "\0never",
    ];
    let hex = |unit: u16| {
        let folded = fold(unit);
        (u16::from(b'0')..=u16::from(b'9')).contains(&folded)
            || (u16::from(b'a')..=u16::from(b'f')).contains(&folded)
    };
    PLAIN.iter().any(|needle| contains_folded(hay, needle))
        || positions(hay, "unable to read ").any(|at| {
            let from = at + "unable to read ".len();
            hay[from..].iter().take_while(|unit| hex(**unit)).count() >= 7
        })
        || on_one_line(hay, "object file ", &[" is empty"])
        || on_one_line(hay, "packfile ", &[" cannot", " does not"])
}

/// `failureClass({ timedOut, diskFull, notRepository, stderr, code, signal })`.
fn failure_class(
    timed_out: bool,
    disk_full: bool,
    not_repository: bool,
    stderr: &[u16],
    code: &W,
    signal: &W,
) -> String {
    if timed_out {
        return String::from("timeout");
    }
    if disk_full {
        return String::from("no_space");
    }
    if not_repository {
        return String::from("not_git");
    }
    if lock_failure(stderr) {
        return String::from("lock");
    }
    if corrupt_failure(stderr) {
        return String::from("corrupt");
    }
    if !matches!(signal, W::Null | W::Undefined) && crate::value::truthy(signal) {
        return String::from("signal");
    }
    match code {
        W::Number(code)
            if code.fract() == 0.0
                && code.abs() <= 9_007_199_254_740_991.0
                && *code >= 0.0
                && *code < 256.0 =>
        {
            format!("exit_{}", *code as i64)
        }
        _ => String::from("exit_unknown"),
    }
}

// --- start --------------------------------------------------------------

/// What `pipeline(…, child.stdin)` reads: `Readable.from([input])` for a
/// string or a `Buffer`, the caller's async iterable, or `Readable.from([])`.
#[derive(Clone, Default)]
pub enum Input {
    #[default]
    None,
    Text(JsStr),
    Bytes(Rc<Vec<u8>>),
    Rows(AsyncGen<W, W>),
}

/// `createOwnedGitRunner`'s check: `assertAllowed(cwd, args, { env })`.
pub type AssertAllowed = Rc<dyn Fn(&str, &[String], &[(String, Option<String>)]) -> Result<(), W>>;

pub(crate) struct Owned {
    binary: String,
    environment: Vec<(String, String)>,
    arguments_prefix: Vec<String>,
    assert_allowed: Option<AssertAllowed>,
}

/// The options of `git`, `gitTokens` and `start`. `None` is `undefined`.
#[derive(Clone, Default)]
pub struct GitOptions {
    /// `env`: the object's entries in order (`None` is `undefined`).
    pub env: Vec<(String, Option<String>)>,
    pub input: Input,
    /// `timeoutMs` (30,000 when `undefined`).
    pub timeout_ms: Option<f64>,
    pub accept_exit_codes: Vec<f64>,
    /// `limit` of `git` (1 MiB when `undefined`).
    pub limit: Option<f64>,
    /// `delimiter` of `gitTokens` (0 when `undefined`).
    pub delimiter: Option<u8>,
    pub(crate) owned: Option<Rc<Owned>>,
}

/// What `start` returns: `{ child, done, writing }`.
pub struct Started {
    pub child: ChildProcess,
    pub done: WPromise,
    pub writing: WPromise,
}

/// `start(cwd, args, options)`: not an async function; what it throws is
/// thrown to its caller at once.
pub fn start(ctx: &Ctx, cwd: &str, args: &[String], options: &GitOptions) -> Result<Started, W> {
    let signal = execution_signal(ctx);
    if let Some(signal) = &signal {
        signal.throw_if_aborted()?;
    }
    let owned = options.owned.clone();
    if let Some(owned) = &owned
        && let Some(assert_allowed) = &owned.assert_allowed
    {
        assert_allowed(cwd, args, &options.env)?;
    }
    let mut argv = owned
        .as_ref()
        .map(|owned| owned.arguments_prefix.clone())
        .unwrap_or_default();
    argv.extend(args.iter().cloned());
    let base = owned
        .as_ref()
        .map_or_else(process_env, |owned| owned.environment.clone());
    let child = child::spawn(Spawn {
        file: owned
            .as_ref()
            .map_or_else(|| String::from("git"), |owned| owned.binary.clone()),
        args: argv.clone(),
        cwd: Some(cwd.to_owned()),
        env: git_environment(&base, &options.env),
        stdio: [Stdio::Pipe, Stdio::Pipe, Stdio::Pipe],
    })?;
    let abort_id = signal.as_ref().map(|signal| {
        let child = child.clone();
        signal.add_listener(move |_| {
            let _ = child.kill(Signal::Kill);
        })
    });
    let timed_out = Rc::new(Cell::new(false));
    let disk_full = Rc::new(Cell::new(false));
    let not_repository = Rc::new(Cell::new(false));
    let stderr_tail = Rc::new(RefCell::new(JsStr::new()));
    let stderr_head = Rc::new(RefCell::new(JsStr::new()));
    let timer = {
        let (timed_out, child) = (timed_out.clone(), child.clone());
        host::set_timeout(options.timeout_ms.unwrap_or(30_000.0), move || {
            timed_out.set(true);
            let _ = child.kill(Signal::Kill);
        })
    };
    // `child.stderr.on(…)`: at the descriptor limit Node sets up no stdio,
    // and this throws before an `error` listener exists (O2e's F2, kept).
    let Some(stderr) = child.stderr() else {
        return Err(type_error(
            "Cannot read properties of undefined (reading 'on')",
        ));
    };
    {
        let (tail, head) = (stderr_tail.clone(), stderr_head.clone());
        let (disk_full, not_repository) = (disk_full.clone(), not_repository.clone());
        stderr.on(
            "data",
            &Listener::new(move |chunk: &W| {
                let text = match chunk {
                    W::Bytes(bytes) => JsStr::from_utf8_lossy(bytes),
                    other => to_js_string(other),
                };
                let mut joined = tail.borrow().clone();
                joined.push_units(text.units());
                let units = joined.units();
                let keep = units.len().saturating_sub(1024);
                *tail.borrow_mut() = JsStr::from_units(units[keep..].to_vec());
                if head.borrow().len() < 1024 {
                    let mut joined = head.borrow().clone();
                    joined.push_units(text.units());
                    let units = joined.units();
                    *head.borrow_mut() = JsStr::from_units(units[..units.len().min(1024)].to_vec());
                }
                let tail = tail.borrow();
                if contains_folded(tail.units(), "no space left on device")
                    || contains_folded(tail.units(), "disk quota exceeded")
                {
                    disk_full.set(true);
                }
                if contains_folded(tail.units(), "not a git repository") {
                    not_repository.set(true);
                }
                Ok(())
            }),
        );
    }
    let (settled, resolvers): (WPromise, Resolvers<W, W>) = Promise::with_resolvers();
    {
        let reject = resolvers.clone();
        child.on(
            "error",
            &Listener::new(move |error: &W| {
                reject.reject(error.clone());
                Ok(())
            }),
        );
    }
    {
        let command = git_command(&argv_for_command(owned.as_deref(), args));
        let (signal, ctx) = (signal.clone(), ctx.clone());
        let accept = options.accept_exit_codes.clone();
        let (timed_out, disk_full, not_repository) =
            (timed_out.clone(), disk_full.clone(), not_repository.clone());
        let (head, tail) = (stderr_head.clone(), stderr_tail.clone());
        child.on(
            "close",
            &Listener::new(move |status: &W| {
                let (code, exit_signal) = match status {
                    W::Array(items) => (
                        items.first().cloned().unwrap_or(W::Null),
                        items.get(1).cloned().unwrap_or(W::Null),
                    ),
                    _ => (W::Null, W::Null),
                };
                let failed = |error_code: &str, status: f64| {
                    let mut stderr = head.borrow().clone();
                    stderr.push_str("\n");
                    stderr.push_units(tail.borrow().units());
                    let mut error = status_error(error_code, status);
                    error.set_field("command", W::string(&command));
                    let failure = failure_class(
                        timed_out.get(),
                        disk_full.get(),
                        not_repository.get(),
                        stderr.units(),
                        &code,
                        &exit_signal,
                    );
                    error.set_field("failure", W::string(&failure));
                    W::Error(Rc::new(error))
                };
                let refused = !matches!(code, W::Number(number) if number == 0.0)
                    && !accept
                        .iter()
                        .any(|accepted| matches!(code, W::Number(number) if number == *accepted));
                if let Some(signal) = signal.as_ref().filter(|signal| signal.aborted()) {
                    resolvers.reject(signal.reason());
                } else if timed_out.get() {
                    resolvers.reject(failed("capture_timeout", 503.0));
                } else if disk_full.get() {
                    resolvers.reject(failed("storage_unavailable", 503.0));
                } else if refused && not_repository.get() {
                    resolvers.reject(failed("capture_not_git", 409.0));
                } else if refused {
                    resolvers.reject(failed("capture_git_failed", 503.0));
                } else {
                    execution_progress(&ctx);
                    resolvers.fulfill(W::Undefined);
                }
                Ok(())
            }),
        );
    }
    let done = {
        let signal = signal.clone();
        settled.finally(move || {
            host::clear_timeout(&timer);
            if let (Some(signal), Some(id)) = (&signal, abort_id) {
                signal.remove_listener(id);
            }
            Ok(Resolution::Value(W::Undefined))
        })
    };
    // `void done.catch(() => {})`: attached at once.
    done.clone().react(|_| {});
    let source = match &options.input {
        Input::Text(text) => PipeInput::Bytes(Rc::new(text.to_utf8())),
        Input::Bytes(bytes) => PipeInput::Bytes(bytes.clone()),
        Input::Rows(rows) => PipeInput::Generator(rows.clone()),
        Input::None => PipeInput::Empty,
    };
    let stdin = child.stdin().expect("stdio is set up once stderr is");
    let writing = net::pipeline(source, &stdin).then(
        |()| Ok(Resolution::Value(W::Undefined)),
        |error| {
            let code = code_of(&error);
            if code != "EPIPE" && code != "ERR_STREAM_PREMATURE_CLOSE" {
                return Err(error);
            }
            Ok(Resolution::Value(W::Undefined))
        },
    );
    {
        // `void writing.catch(() => child.kill('SIGKILL'))`.
        let child = child.clone();
        writing.clone().react(move |outcome| {
            if outcome.is_err() {
                let _ = child.kill(Signal::Kill);
            }
        });
    }
    Ok(Started {
        child,
        done,
        writing,
    })
}

/// `owned ? [...owned.argumentsPrefix, ...args] : args`.
fn argv_for_command(owned: Option<&Owned>, args: &[String]) -> Vec<String> {
    match owned {
        Some(owned) => owned
            .arguments_prefix
            .iter()
            .chain(args.iter())
            .cloned()
            .collect(),
        None => args.to_vec(),
    }
}

/// `git(cwd, args, options)`: stdout's bytes (`Buffer.concat(chunks)`).
pub fn git(ctx: &Ctx, cwd: &str, args: &[String], options: &GitOptions) -> WPromise {
    let started = start(ctx, cwd, args, options);
    let limit = options.limit.unwrap_or(1024.0 * 1024.0);
    async_fn(async move {
        let process = started?;
        let stdout = process
            .child
            .stdout()
            .expect("stdio is set up once stderr is");
        let body: Result<Vec<u8>, W> = async {
            let mut chunks: Vec<u8> = Vec::new();
            let mut bytes = 0.0f64;
            let reading = agen::for_await(&stdout);
            while let Some(chunk) = reading.next().await? {
                let chunk = match chunk {
                    W::Bytes(bytes) => bytes,
                    _ => Rc::new(Vec::new()),
                };
                bytes += chunk.len() as f64;
                if bytes > limit {
                    return Err(reading
                        .close_throw(change_error("change_record_too_large", 503.0))
                        .await);
                }
                chunks.extend_from_slice(&chunk);
            }
            process.writing.clone().await?;
            process.done.clone().await?;
            Ok(chunks)
        }
        .await;
        // `finally`
        let _ = process.child.kill(Signal::Kill);
        Promise::all_settled(vec![
            Resolution::Promise(process.done.clone()),
            Resolution::Promise(process.writing.clone()),
        ])
        .await?;
        Ok(Resolution::Value(W::Bytes(Rc::new(body?))))
    })
}

/// `gitTokens(cwd, args, options)`: stdout split on `delimiter` (0 when
/// undefined), each token decoded as UTF-8 (`toString()`); the last one
/// without its delimiter too.
pub fn git_tokens(ctx: &Ctx, cwd: &str, args: &[String], options: &GitOptions) -> AsyncGen<W, W> {
    let (ctx, cwd, args, options) = (ctx.clone(), cwd.to_owned(), args.to_vec(), options.clone());
    agen::async_gen(move |co: Co<W, W>| async move {
        let process = start(&ctx, &cwd, &args, &options)?;
        let delimiter = options.delimiter.unwrap_or(0);
        let stdout = process
            .child
            .stdout()
            .expect("stdio is set up once stderr is");
        let body: Result<(), Abrupt<W, W>> = async {
            let mut tail: Vec<u8> = Vec::new();
            let reading = agen::for_await(&stdout);
            while let Some(chunk) = reading.next().await? {
                let step: Result<(), Abrupt<W, W>> = async {
                    let chunk = match &chunk {
                        W::Bytes(bytes) => bytes.as_ref().clone(),
                        _ => Vec::new(),
                    };
                    let data = if tail.is_empty() {
                        chunk
                    } else {
                        let mut joined = std::mem::take(&mut tail);
                        joined.extend_from_slice(&chunk);
                        joined
                    };
                    let mut offset = 0;
                    while let Some(end) = data[offset..].iter().position(|byte| *byte == delimiter)
                    {
                        let token = JsStr::from_utf8_lossy(&data[offset..offset + end]);
                        co.yield_(Resolution::Value(W::String(token))).await?;
                        offset += end + 1;
                    }
                    tail = data[offset..].to_vec();
                    if tail.len() > 1024 * 1024 {
                        return Err(Abrupt::Throw(change_error("invalid_change_record", 503.0)));
                    }
                    Ok(())
                }
                .await;
                if let Err(abrupt) = step {
                    return Err(reading.exit(abrupt).await);
                }
            }
            if !tail.is_empty() {
                co.yield_(Resolution::Value(W::String(JsStr::from_utf8_lossy(&tail))))
                    .await?;
            }
            process.writing.clone().await?;
            process.done.clone().await?;
            Ok(())
        }
        .await;
        // `finally`
        let _ = process.child.kill(Signal::Kill);
        Promise::all_settled(vec![
            Resolution::Promise(process.done.clone()),
            Resolution::Promise(process.writing.clone()),
        ])
        .await?;
        body
    })
}

/// A row `gitRecords` reads: `{ key, oid, size }` (any value, read as the
/// JavaScript reads its properties).
fn row_field(row: &W, key: &str) -> W {
    row.get(key)
}

fn is_safe_integer(value: &W) -> bool {
    matches!(value, W::Number(number) if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
}

/// `JSON.parse(text)` of a stored record, as a seam value. A record nested
/// deeper than `ledger_core::js::MAX_DEPTH` (512) containers, which V8 reads,
/// is refused with `ledger_record_too_deep` (503), the bound's own code, so
/// a caller can tell it from a record that is not JSON (a `SyntaxError`).
pub fn json_parse(text: &JsStr) -> Result<W, W> {
    match ledger_core::js::parse(text.units()) {
        Ok(value) => Ok(from_core(&value)),
        Err(error) if error.kind == ledger_core::js::ParseErrorKind::TooDeep => {
            Err(change_error("ledger_record_too_deep", 503.0))
        }
        Err(_) => Err(crate::ctx::js_error(
            "SyntaxError",
            "Unexpected token in JSON",
        )),
    }
}

/// A `ledger_core` JSON value as a seam value.
pub fn from_core(value: &ledger_core::js::Value) -> W {
    use ledger_core::js::Value;
    match value {
        Value::Undefined => W::Undefined,
        Value::Null => W::Null,
        Value::Bool(flag) => W::Bool(*flag),
        Value::Number(number) => W::Number(*number),
        Value::String(text) => W::String(text.clone()),
        Value::Array(items) => W::Array(items.iter().map(from_core).collect()),
        Value::Object(object) => {
            let mut out = Obj::new();
            for (key, value) in object.iter() {
                out.set(key, from_core(value));
            }
            W::Object(out)
        }
    }
}

/// `gitRecords(cwd, args, rows, options)`: the rows' blobs read with
/// `cat-file --batch` in batches of at most 4,096 rows and 4 MiB, each row
/// `{ key, oid, value: JSON.parse(blob) }`.
/// What `gitRecords` iterates (`for await`): an array or an async iterable.
pub enum Rows {
    Array(Vec<W>),
    Gen(AsyncGen<W, W>),
}

pub fn git_records(
    ctx: &Ctx,
    cwd: &str,
    args: &[String],
    rows: Rows,
    options: &GitOptions,
) -> AsyncGen<W, W> {
    let (ctx, cwd, args, options) = (ctx.clone(), cwd.to_owned(), args.to_vec(), options.clone());
    agen::async_gen(move |co: Co<W, W>| async move {
        let read = {
            let (ctx, cwd, args, options) =
                (ctx.clone(), cwd.clone(), args.clone(), options.clone());
            move |entries: Vec<W>| -> WPromise {
                let (ctx, cwd, args, options) =
                    (ctx.clone(), cwd.clone(), args.clone(), options.clone());
                async_fn(async move {
                    let mut command = args.clone();
                    command.extend(["cat-file", "--batch"].map(String::from));
                    let mut input = entries
                        .iter()
                        .map(|entry| to_js_string(&row_field(entry, "oid")).to_string_lossy())
                        .collect::<Vec<String>>()
                        .join("\n");
                    input.push('\n');
                    let mut reading = options.clone();
                    reading.input = Input::Text(JsStr::from(input.as_str()));
                    reading.limit = Some(8.0 * 1024.0 * 1024.0 + 16.0 * 1024.0);
                    let data = match git(&ctx, &cwd, &command, &reading).await? {
                        W::Bytes(bytes) => bytes,
                        _ => Rc::new(Vec::new()),
                    };
                    let mut offset = 0usize;
                    let mut records = Vec::new();
                    for entry in &entries {
                        let end = data[offset.min(data.len())..]
                            .iter()
                            .position(|byte| *byte == 10)
                            .map(|at| at + offset);
                        let header_end = end.unwrap_or(data.len().saturating_sub(1));
                        let header =
                            JsStr::from_utf8_lossy(&data[offset.min(header_end)..header_end])
                                .to_string_lossy();
                        let header: Vec<&str> = header.split(' ').collect();
                        let size = header.get(2).map_or(f64::NAN, |text| {
                            string_to_number(&JsStr::from(*text).into_units())
                        });
                        let valid = end.is_some()
                            && header.get(1) == Some(&"blob")
                            && is_safe_integer(&W::Number(size))
                            && size >= 0.0
                            && end.is_some_and(|end| (end + 1) as f64 + size < data.len() as f64);
                        if !valid {
                            return Err(change_error("invalid_change_record", 503.0));
                        }
                        let end = end.expect("checked");
                        let next = end + 1 + size as usize + 1;
                        let value = json_parse(&JsStr::from_utf8_lossy(&data[end + 1..next - 1]))?;
                        offset = next;
                        records.push(W::object(vec![
                            ("key", row_field(entry, "key")),
                            ("oid", row_field(entry, "oid")),
                            ("value", value),
                        ]));
                    }
                    Ok(Resolution::Value(W::Array(records)))
                })
            }
        };
        let mut batch: Vec<W> = Vec::new();
        let mut bytes = 0.0f64;
        let source = match rows {
            Rows::Array(items) => agen::for_await(agen::from_sync(agen::array(
                items.into_iter().map(Resolution::Value).collect(),
            ))),
            Rows::Gen(rows) => agen::for_await(rows),
        };
        while let Some(row) = source.next().await? {
            let step: Result<(), Abrupt<W, W>> = async {
                let size = row_field(&row, "size");
                let number = match size {
                    W::Number(number) => number,
                    _ => f64::NAN,
                };
                if !is_safe_integer(&size) || number < 0.0 || number > 512.0 * 1024.0 {
                    return Err(Abrupt::Throw(change_error("invalid_change_record", 503.0)));
                }
                if !batch.is_empty()
                    && (batch.len() >= 4096 || bytes + number > 4.0 * 1024.0 * 1024.0)
                {
                    let records = read(std::mem::take(&mut batch)).await?;
                    co.delegate(agen::from_sync(agen::array(items_of(records))))
                        .await?;
                    bytes = 0.0;
                }
                batch.push(row.clone());
                bytes += number;
                Ok(())
            }
            .await;
            if let Err(abrupt) = step {
                return Err(source.exit(abrupt).await);
            }
        }
        if !batch.is_empty() {
            let records = read(batch).await?;
            co.delegate(agen::from_sync(agen::array(items_of(records))))
                .await?;
        }
        Ok(())
    })
}

/// The items of an array value, for `yield*` over it.
fn items_of(value: W) -> Vec<Resolution<W, W>> {
    match value {
        W::Array(items) => items.into_iter().map(Resolution::Value).collect(),
        _ => Vec::new(),
    }
}

// --- createOwnedGitRunner -----------------------------------------------

/// `createOwnedGitRunner({ binary, environment, argumentsPrefix, assertAllowed })`:
/// a runner whose calls start `binary` with `argumentsPrefix` and exactly
/// `environment` (plus `gitEnvironment`'s overrides). In JavaScript the
/// handle is a frozen object looked up in a `WeakMap`, so a forged one
/// throws `owned_git_runner_invalid`; here the handle cannot be forged.
#[derive(Clone)]
pub struct OwnedGitRunner(Rc<Owned>);

pub fn create_owned_git_runner(
    binary: &str,
    environment: Vec<(String, String)>,
    arguments_prefix: Vec<String>,
    assert_allowed: Option<AssertAllowed>,
) -> OwnedGitRunner {
    OwnedGitRunner(Rc::new(Owned {
        binary: binary.to_owned(),
        environment,
        arguments_prefix,
        assert_allowed,
    }))
}

impl OwnedGitRunner {
    fn options(&self, options: &GitOptions) -> GitOptions {
        let mut options = options.clone();
        options.owned = Some(self.0.clone());
        options
    }

    pub fn git(&self, ctx: &Ctx, cwd: &str, args: &[String], options: &GitOptions) -> WPromise {
        git(ctx, cwd, args, &self.options(options))
    }

    pub fn git_tokens(
        &self,
        ctx: &Ctx,
        cwd: &str,
        args: &[String],
        options: &GitOptions,
    ) -> AsyncGen<W, W> {
        git_tokens(ctx, cwd, args, &self.options(options))
    }

    pub fn git_records(&self, ctx: &Ctx, cwd: &str, args: &[String], rows: Rows) -> AsyncGen<W, W> {
        git_records(ctx, cwd, args, rows, &self.options(&GitOptions::default()))
    }
}

// --- The persistent object reader ---------------------------------------

/// `persistentGitReaders()`: on unless `DEVRYAN_LEDGER_PERSISTENT_READER=0`
/// (Windows has none; the native ledger never runs there).
pub fn persistent_git_readers() -> bool {
    host::env("DEVRYAN_LEDGER_PERSISTENT_READER").as_deref() != Some("0")
}

/// `READER_IDLE_MS`: an idle reader closes after this long.
pub const READER_IDLE_MS: f64 = 15_000.0;
/// `READER_TIMEOUT_MS`: the watchdog fails a reader whose oldest pending
/// read is older than this (`Date.now()`, checked each second).
pub const READER_TIMEOUT_MS: f64 = 30_000.0;

/// How one request of a reader was answered, in the reader's terms.
#[derive(Clone)]
enum Answered {
    /// `<name> missing` / `ambiguous`: `null`.
    Null,
    /// `{ oid, type, size[, data] }`.
    Object(W),
    /// The reader closes (every pending request rejects) with this error,
    /// or with `capture_git_failed` (503) when `None`.
    Close(Option<W>),
}

/// A name waiting for its hand-back, and where its answer goes.
type Queued = (Vec<u8>, Resolvers<Answered, W>);

struct Request {
    /// `Date.now()` when it was queued (the watchdog's clock).
    started: f64,
    resolvers: Resolvers<W, W>,
    answer: RefCell<Option<Answered>>,
}

/// One persistent reader: the JavaScript's `cat-file` process and its
/// bookkeeping, with the process's part done by [`odb::ObjectReader`] (the
/// database on a thread of its own, for the reader's life) and, for a name
/// the database leaves to Git, a `cat-file` of that one name.
struct Reader {
    key: String,
    cwd: String,
    args: Vec<String>,
    check: bool,
    /// The environment the JavaScript's reader process gets at its start
    /// (`gitEnvironment(process.env)`): every hand-back starts with it.
    env: Vec<(String, String)>,
    database: Option<odb::ObjectReader>,
    closed: Cell<bool>,
    pending: RefCell<VecDeque<Rc<Request>>>,
    idle: RefCell<Option<host::Timeout>>,
    watchdog: RefCell<Option<host::Timeout>>,
    /// The hand-back running: the reader's process, killed at its close.
    children: RefCell<Vec<ChildProcess>>,
    /// Names waiting for their hand-back: one process at a time, in request
    /// order, as the JavaScript's one `cat-file` reads its names.
    queued: RefCell<VecDeque<Queued>>,
}

thread_local! {
    /// `readers`: one per `JSON.stringify([cwd, args, check])`.
    static READERS: RefCell<HashMap<String, Rc<Reader>>> = RefCell::new(HashMap::new());
}

/// `JSON.stringify([cwd, args, check])`.
fn reader_key(cwd: &str, args: &[String], check: bool) -> String {
    let mut out = Vec::new();
    out.push(b'[');
    ledger_core::js::write_json_string(&mut out, JsStr::from(cwd).units());
    out.extend_from_slice(b",[");
    for (index, arg) in args.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        ledger_core::js::write_json_string(&mut out, JsStr::from(arg.as_str()).units());
    }
    out.extend_from_slice(if check { b"],true]" } else { b"],false]" });
    String::from_utf8_lossy(&out).into_owned()
}

/// `openReader(cwd, args, check)`: the live reader of the key, or a new one
/// with its watchdog (`setInterval(…, 1000)`, unreferenced).
fn open_reader(cwd: &str, args: &[String], check: bool) -> Rc<Reader> {
    let key = reader_key(cwd, args, check);
    if let Some(existing) = READERS.with(|readers| readers.borrow().get(&key).cloned())
        && !existing.closed.get()
    {
        return existing;
    }
    let env = git_environment(&process_env(), &[]);
    // Git looks objects up through another replace namespace: every name
    // goes to Git (the in-process database knows `refs/replace/` only).
    let ask_all = env.iter().any(|(name, _)| name == "GIT_REPLACE_REF_BASE");
    // The database is the repository `--git-dir` names (resolved against
    // `cwd`), when the arguments are exactly that; otherwise every name
    // asks Git.
    let database = match args {
        [flag, dir] if flag == "--git-dir" => {
            Some(odb::ObjectReader::new(&odb::resolve(cwd, dir), ask_all))
        }
        _ => None,
    };
    made_reader(key, cwd, args, check, env, database)
}

/// A new reader in the map, its watchdog started.
fn made_reader(
    key: String,
    cwd: &str,
    args: &[String],
    check: bool,
    env: Vec<(String, String)>,
    database: Option<odb::ObjectReader>,
) -> Rc<Reader> {
    let reader = Rc::new(Reader {
        key: key.clone(),
        cwd: cwd.to_owned(),
        args: args.to_vec(),
        check,
        env,
        database,
        closed: Cell::new(false),
        pending: RefCell::new(VecDeque::new()),
        idle: RefCell::new(None),
        watchdog: RefCell::new(None),
        children: RefCell::new(Vec::new()),
        queued: RefCell::new(VecDeque::new()),
    });
    READERS.with(|readers| readers.borrow_mut().insert(key, reader.clone()));
    let watched = Rc::downgrade(&reader);
    let watchdog = host::set_interval(1_000.0, move || {
        let Some(reader) = watched.upgrade() else {
            return;
        };
        let started = reader
            .pending
            .borrow()
            .front()
            .map(|request| request.started);
        if let Some(started) = started
            && host::now() - started > READER_TIMEOUT_MS
        {
            close_reader(&reader, Some(change_error("capture_timeout", 503.0)));
        }
    });
    watchdog.unref();
    *reader.watchdog.borrow_mut() = Some(watchdog);
    reader
}

/// The reader's `close(error)`: out of the map, its timers cleared, its
/// processes killed (`child.kill('SIGKILL')`; here every hand-back running,
/// and the database's thread let go), every pending request rejected with
/// the one error (or `capture_git_failed`).
fn close_reader(reader: &Rc<Reader>, error: Option<W>) {
    if reader.closed.replace(true) {
        return;
    }
    READERS.with(|readers| {
        let mut readers = readers.borrow_mut();
        if readers
            .get(&reader.key)
            .is_some_and(|known| Rc::ptr_eq(known, reader))
        {
            readers.remove(&reader.key);
        }
    });
    host::clear_optional(&reader.idle.borrow());
    host::clear_optional(&reader.watchdog.borrow());
    reader.queued.borrow_mut().clear();
    let children: Vec<ChildProcess> = reader.children.borrow_mut().drain(..).collect();
    for child in children {
        let _ = child.kill(Signal::Kill);
    }
    if let Some(database) = &reader.database {
        database.close();
    }
    let error = error.unwrap_or_else(|| change_error("capture_git_failed", 503.0));
    let pending: Vec<Rc<Request>> = reader.pending.borrow_mut().drain(..).collect();
    for request in pending {
        request.resolvers.reject(error.clone());
    }
}

/// The reader's `settle()`: answers in request order, from the head.
fn settle_reader(reader: &Rc<Reader>) {
    loop {
        let Some(head) = reader.pending.borrow().front().cloned() else {
            return;
        };
        let Some(answered) = head.answer.borrow_mut().take() else {
            return;
        };
        match answered {
            Answered::Close(error) => {
                close_reader(reader, error);
                return;
            }
            Answered::Null => {
                reader.pending.borrow_mut().pop_front();
                head.resolvers.fulfill(W::Null);
            }
            Answered::Object(object) => {
                reader.pending.borrow_mut().pop_front();
                head.resolvers.fulfill(object);
            }
        }
    }
}

/// `{ oid, type, size[, data] }` as the reader resolves it.
fn found_object(oid: &str, kind: &str, size: f64, data: Option<Rc<Vec<u8>>>) -> W {
    let mut fields = vec![
        ("oid", W::string(oid)),
        ("type", W::string(kind)),
        ("size", W::Number(size)),
    ];
    if let Some(data) = data {
        fields.push(("data", W::Bytes(data)));
    }
    W::object(fields)
}

/// One answer of the reader's parser (`settle`) over a `cat-file` output.
fn parse_answer(buffer: &[u8], check: bool, closed: bool) -> Answered {
    let Some(end) = buffer.iter().position(|byte| *byte == 10) else {
        // No header before the process closed: `close()`.
        return Answered::Close(if closed {
            None
        } else {
            Some(change_error("invalid_change_record", 503.0))
        });
    };
    let header = JsStr::from_utf8_lossy(&buffer[..end]).to_string_lossy();
    if header.ends_with(" missing") || header.ends_with(" ambiguous") {
        return Answered::Null;
    }
    let parts: Vec<&str> = header.split(' ').collect();
    let (oid, kind) = (
        parts.first().copied().unwrap_or(""),
        parts.get(1).copied().unwrap_or(""),
    );
    let size = parts.get(2).map_or(f64::NAN, |text| {
        string_to_number(&JsStr::from(*text).into_units())
    });
    if oid.is_empty() || kind.is_empty() || !is_safe_integer(&W::Number(size)) || size < 0.0 {
        return Answered::Close(Some(change_error("invalid_change_record", 503.0)));
    }
    if check {
        return Answered::Object(found_object(oid, kind, size, None));
    }
    if (buffer.len() as f64) < (end + 1) as f64 + size + 1.0 {
        return Answered::Close(None);
    }
    let data = buffer[end + 1..end + 1 + size as usize].to_vec();
    Answered::Object(found_object(oid, kind, size, Some(Rc::new(data))))
}

/// "Ask Git": the one name read by a `cat-file` process of the reader's
/// kind (`stdio: ['pipe', 'pipe', 'ignore']`, the reader's environment),
/// parsed as the reader parses its output; the process dying first is the
/// reader's `close()`. The process is the reader's: one at a time, in
/// request order; its close kills it, and the watchdog's deadline covers it.
fn ask_git(reader: &Rc<Reader>, name: &[u8]) -> Promise<Answered, W> {
    let (promise, resolvers) = Promise::with_resolvers();
    if reader.closed.get() {
        return promise;
    }
    reader
        .queued
        .borrow_mut()
        .push_back((name.to_vec(), resolvers));
    if reader.children.borrow().is_empty() {
        hand_back_next(reader);
    }
    promise
}

/// Starts the next queued hand-back, if any and none is running.
fn hand_back_next(reader: &Rc<Reader>) {
    if reader.closed.get() || !reader.children.borrow().is_empty() {
        return;
    }
    let Some((name, resolvers)) = reader.queued.borrow_mut().pop_front() else {
        return;
    };
    let name = name.as_slice();
    let mut args = reader.args.clone();
    args.push(String::from("cat-file"));
    args.push(String::from(if reader.check {
        "--batch-check"
    } else {
        "--batch"
    }));
    let spawned = child::spawn(Spawn {
        file: String::from("git"),
        args,
        cwd: Some(reader.cwd.clone()),
        env: reader.env.clone(),
        stdio: [Stdio::Pipe, Stdio::Pipe, Stdio::Ignore],
    });
    let child = match spawned {
        Ok(child) => child,
        Err(_) => {
            resolvers.fulfill(Answered::Close(None));
            return;
        }
    };
    reader.children.borrow_mut().push(child.clone());
    let buffer = Rc::new(RefCell::new(Vec::new()));
    let failed = Rc::new(Cell::new(false));
    if let Some(stdout) = child.stdout() {
        let buffer = buffer.clone();
        stdout.on(
            "data",
            &Listener::new(move |chunk: &W| {
                if let W::Bytes(bytes) = chunk {
                    buffer.borrow_mut().extend_from_slice(bytes);
                }
                Ok(())
            }),
        );
    }
    {
        let failed = failed.clone();
        child.on(
            "error",
            &Listener::new(move |_| {
                failed.set(true);
                Ok(())
            }),
        );
    }
    {
        let (buffer, failed, check) = (buffer.clone(), failed.clone(), reader.check);
        let resolvers = resolvers.clone();
        let owner = Rc::downgrade(reader);
        // The child is kept until its close, as Node's handle keeps it (the
        // layer lets its listeners go after `close`).
        let kept = RefCell::new(Some(child.clone()));
        child.on(
            "close",
            &Listener::new(move |_| {
                if let Some(child) = kept.borrow_mut().take()
                    && let Some(reader) = owner.upgrade()
                {
                    reader
                        .children
                        .borrow_mut()
                        .retain(|known| !known.same(&child));
                }
                let answer = if failed.get() {
                    Answered::Close(None)
                } else {
                    parse_answer(&buffer.borrow(), check, true)
                };
                resolvers.fulfill(answer);
                if let Some(reader) = owner.upgrade() {
                    hand_back_next(&reader);
                }
                Ok(())
            }),
        );
    }
    if let Some(stdin) = child.stdin() {
        stdin.on("error", &Listener::new(|_| Ok(())));
        let mut line = name.to_vec();
        line.push(b'\n');
        stdin.write(&line, None);
        stdin.end();
    }
}

/// `readGitObject(cwd, args, name, { check, idleMs })`: `null` when absent,
/// else `{ oid, type, size }` and, unless `check`, `data`. Not an async
/// function: an aborted execution throws at once (`Err`). `idle_ms`
/// (`idleMs`, tests) shortens how long an idle reader lives.
pub fn read_git_object(ctx: &Ctx, cwd: &str, args: &[String], name: &W, check: bool) -> Ret {
    read_git_object_with(ctx, cwd, args, name, check, READER_IDLE_MS)
}

/// [`read_git_object`] with `idleMs`.
pub fn read_git_object_with(
    ctx: &Ctx,
    cwd: &str,
    args: &[String],
    name: &W,
    check: bool,
    idle_ms: f64,
) -> Ret {
    if let Some(signal) = execution_signal(ctx) {
        signal.throw_if_aborted()?;
    }
    let text = match name {
        W::String(text) if !text.is_empty() => text.clone(),
        _ => {
            return Ok(Resolution::Promise(Promise::reject(change_error(
                "invalid_change_record",
                409.0,
            ))));
        }
    };
    if text
        .units()
        .iter()
        .any(|unit| matches!(*unit, 0x0a | 0x0d | 0x00))
    {
        return Ok(Resolution::Promise(Promise::reject(change_error(
            "invalid_change_record",
            409.0,
        ))));
    }
    let reader = open_reader(cwd, args, check);
    host::clear_optional(&reader.idle.borrow());
    let (promise, resolvers) = Promise::with_resolvers();
    let request = Rc::new(Request {
        started: host::now(),
        resolvers,
        answer: RefCell::new(None),
    });
    reader.pending.borrow_mut().push_back(request.clone());
    let name = text.to_utf8();
    let looked = match &reader.database {
        Some(database) => database.read_name(&name, check),
        None => js::value(odb::Lookup::Ask("repository_format")),
    };
    {
        let reader = reader.clone();
        let _ = looked.then_ok(move |lookup| {
            let answered = match lookup {
                odb::Lookup::Missing => Promise::resolve(Resolution::Value(Answered::Null)),
                odb::Lookup::Found {
                    oid,
                    kind,
                    size,
                    data,
                } => Promise::resolve(Resolution::Value(Answered::Object(found_object(
                    &oid, kind, size, data,
                )))),
                // `<id> submodule`: no size, so the reader closes (the defect
                // of session-changes-git.js:221-226). Not given while the
                // database asks Git for every gitlink.
                odb::Lookup::Submodule(_) => Promise::resolve(Resolution::Value(Answered::Close(
                    Some(change_error("invalid_change_record", 503.0)),
                ))),
                odb::Lookup::Ask(_) => ask_git(&reader, &name),
            };
            let _ = answered.then_ok(move |answered: Answered| {
                *request.answer.borrow_mut() = Some(answered);
                settle_reader(&reader);
                Ok(Resolution::Value(()))
            });
            Ok(Resolution::Value(()))
        });
    }
    // `.finally(…)`: the idle bookkeeping (each read settling with nothing
    // pending replaces the timer; a timer finding a read pending does
    // nothing).
    let reader = reader.clone();
    Ok(Resolution::Promise(promise.finally(move || {
        if reader.closed.get() || !reader.pending.borrow().is_empty() {
            return Ok(Resolution::Value(W::Undefined));
        }
        host::clear_optional(&reader.idle.borrow());
        let idle = {
            let reader = Rc::downgrade(&reader);
            host::set_timeout(idle_ms, move || {
                if let Some(reader) = reader.upgrade()
                    && reader.pending.borrow().is_empty()
                {
                    close_reader(&reader, None);
                }
            })
        };
        idle.unref();
        *reader.idle.borrow_mut() = Some(idle);
        Ok(Resolution::Value(W::Undefined))
    })))
}

/// The readers alive (tests).
pub fn live_readers() -> usize {
    READERS.with(|readers| readers.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ctx::{Meter, Store};
    use crate::host::testing::test_loop;

    fn drive(event_loop: &crate::host::EventLoop, done: &dyn Fn() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            event_loop.checkpoint();
            if done() && event_loop.blocking_pending() == 0 {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the git call did not finish within 30 s"
            );
            if event_loop.has_immediates() {
                event_loop.check_phase();
            } else {
                event_loop.poll_phase(Some(100), &mut |_| {});
            }
        }
    }

    fn metered() -> (Ctx, Meter) {
        let meter = Meter::new(-1.0);
        let store = Store {
            meter: Some(meter.clone()),
            ..Store::default()
        };
        (Some(Rc::new(store)), meter)
    }

    /// `executionProgress()` runs in the `close` listener on success only.
    fn progress_after(script: &str) -> (f64, bool) {
        let (event_loop, _time) = test_loop();
        let (ctx, meter) = metered();
        let runner = create_owned_git_runner(
            "sh",
            vec![(
                String::from("PATH"),
                std::env::var("PATH").unwrap_or_default(),
            )],
            vec![String::from("-c"), script.to_owned()],
            None,
        );
        let settled = runner.git(&ctx, "/", &[], &GitOptions::default());
        let failed = Rc::new(Cell::new(None));
        {
            let failed = failed.clone();
            let _ = settled.then(
                {
                    let failed = failed.clone();
                    move |_| {
                        failed.set(Some(false));
                        Ok(Resolution::Value(W::Undefined))
                    }
                },
                move |_| {
                    failed.set(Some(true));
                    Ok(Resolution::Value(W::Undefined))
                },
            );
        }
        let watched = failed.clone();
        drive(&event_loop, &|| watched.get().is_some());
        let progress = meter.0.borrow().progress;
        (progress, failed.get().expect("settled"))
    }

    /// A reader of `/x` whose database thread runs `work` (S1's tests).
    fn reader_with(work: odb::LookupWork) {
        let args = [String::from("--git-dir"), String::from("/x")];
        let _ = made_reader(
            reader_key("/", &args, false),
            "/",
            &args,
            false,
            Vec::new(),
            Some(odb::ObjectReader::with_work(work)),
        );
    }

    fn read_into(outcomes: &Rc<RefCell<Vec<String>>>) {
        let args = [String::from("--git-dir"), String::from("/x")];
        let name = W::string(&"ab".repeat(20));
        let read = read_git_object(&None, "/", &args, &name, false).expect("not thrown");
        let (done, failed) = (outcomes.clone(), outcomes.clone());
        let _ = Promise::resolve(read).then(
            move |value| {
                done.borrow_mut()
                    .push(format!("ok:{}", crate::value::truthy(&value)));
                Ok(Resolution::Value(W::Undefined))
            },
            move |error| {
                let status = crate::value::to_number(&error.get("status"));
                failed
                    .borrow_mut()
                    .push(format!("{}:{status}", crate::node::code_of(&error)));
                Ok(Resolution::Value(W::Undefined))
            },
        );
    }

    fn wait_for(what: &str, done: &dyn Fn() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !done() {
            assert!(
                std::time::Instant::now() < deadline,
                "waited 30 s for {what}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// The L3b review's S1: reads blocked in a system call (here the
    /// database's thread waits on a gate) fail at the JavaScript watchdog's
    /// deadline with its error, every pending one with it; they block the
    /// reader's own thread, never the I/O pool, which runs four jobs
    /// meanwhile; the next read has a new reader.
    #[test]
    fn blocked_reads_fail_at_the_readers_deadline_and_never_take_the_pool() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Condvar, Mutex};
        let (event_loop, time) = test_loop();
        // Held by the reader's thread until it ends (its work is dropped then).
        let held = Arc::new(());
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let entered = Arc::new(AtomicUsize::new(0));
        {
            let (gate, entered, held) = (gate.clone(), entered.clone(), held.clone());
            reader_with(Box::new(move |_, _| {
                let _ = &held;
                entered.fetch_add(1, Ordering::SeqCst);
                let (open, changed) = &*gate;
                let mut open = open.lock().expect("gate");
                while !*open {
                    open = changed.wait(open).expect("gate");
                }
                odb::Looked::Missing
            }));
        }
        let outcomes: Rc<RefCell<Vec<String>>> = Rc::default();
        for _ in 0..4 {
            read_into(&outcomes);
        }
        wait_for("the reader's thread to block", &|| {
            entered.load(Ordering::SeqCst) == 1
        });
        let pooled = Rc::new(Cell::new(0));
        for _ in 0..4 {
            let pooled = pooled.clone();
            let _ = crate::node::io(|| Ok(())).then_ok(move |()| {
                pooled.set(pooled.get() + 1);
                Ok(Resolution::Value(()))
            });
        }
        // The reads' own sources stay open: only the pool jobs are waited for.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while pooled.get() < 4 {
            assert!(
                std::time::Instant::now() < deadline,
                "the pool jobs did not run within 30 s"
            );
            event_loop.checkpoint();
            event_loop.poll_phase(Some(20), &mut |_| {});
        }
        assert!(outcomes.borrow().is_empty(), "{:?}", outcomes.borrow());
        let start = time.get();
        crate::host::testing::run_until(&event_loop, &time, start + 29_500);
        assert!(
            outcomes.borrow().is_empty(),
            "failed before 30 s: {:?}",
            outcomes.borrow()
        );
        crate::host::testing::run_until(&event_loop, &time, start + 31_500);
        event_loop.checkpoint();
        assert_eq!(*outcomes.borrow(), vec!["capture_timeout:503"; 4]);
        assert_eq!(live_readers(), 0);
        // The stuck thread goes once its call returns; nothing it answers lands.
        let (open, changed) = &*gate;
        *open.lock().expect("gate") = true;
        changed.notify_all();
        wait_for("the blocked thread to end", &|| {
            Arc::strong_count(&held) == 1
        });
        drive(&event_loop, &|| true);
        assert_eq!(outcomes.borrow().len(), 4);
    }

    /// The reader's life is the JavaScript reader's: 15 s idle after its last
    /// read settles, then closed, its database's thread ended.
    #[test]
    fn an_idle_reader_closes_after_fifteen_seconds_and_its_thread_ends() {
        let (event_loop, time) = test_loop();
        let held = std::sync::Arc::new(());
        {
            let held = held.clone();
            reader_with(Box::new(move |_, _| {
                let _ = &held;
                odb::Looked::Missing
            }));
        }
        let outcomes: Rc<RefCell<Vec<String>>> = Rc::default();
        read_into(&outcomes);
        drive(&event_loop, &|| !outcomes.borrow().is_empty());
        assert_eq!(*outcomes.borrow(), vec!["ok:false"]);
        let start = time.get();
        crate::host::testing::run_until(&event_loop, &time, start + 14_999);
        assert_eq!(live_readers(), 1);
        crate::host::testing::run_until(&event_loop, &time, start + 15_001);
        assert_eq!(live_readers(), 0);
        wait_for("the database thread to end", &|| {
            std::sync::Arc::strong_count(&held) == 1
        });
    }

    #[test]
    fn progress_is_recorded_when_git_succeeds_and_only_then() {
        assert_eq!(progress_after("exit 0"), (1000.0, false));
        assert_eq!(progress_after("exit 3"), (-1.0, true));
    }

    #[test]
    fn the_failure_classes_read_stderr_as_the_javascript_patterns() {
        let class = |text: &str| {
            failure_class(
                false,
                false,
                false,
                JsStr::from(text).units(),
                &W::Number(1.0),
                &W::Null,
            )
        };
        for (text, expected) in [
            ("fatal: Unable to create '/a/b.lock': File exists.", "lock"),
            ("UNABLE TO CREATE 'X.LOCK'", "lock"),
            ("unable to create 'a'b.lock'", "exit_1"),
            ("unable to create 'a.lck'", "exit_1"),
            ("x.lock': File exists", "lock"),
            ("error: unable to read 0123abc", "corrupt"),
            ("error: unable to read 0123ab", "exit_1"),
            ("object file a is empty", "corrupt"),
            ("object file is empty", "exit_1"),
            ("object file a\n is empty", "exit_1"),
            ("packfile p does not match", "corrupt"),
            ("packfile p\u{2028} cannot", "exit_1"),
            ("\u{17f}omething: cannot lock ref", "lock"),
            ("missing \u{212a}lob", "exit_1"),
            ("", "exit_1"),
        ] {
            assert_eq!(class(text), expected, "{text:?}");
        }
        let units = JsStr::from("").units().to_vec();
        assert_eq!(
            failure_class(true, true, true, &units, &W::Null, &W::Null),
            "timeout"
        );
        assert_eq!(
            failure_class(false, true, true, &units, &W::Null, &W::Null),
            "no_space"
        );
        assert_eq!(
            failure_class(false, false, true, &units, &W::Null, &W::Null),
            "not_git"
        );
        assert_eq!(
            failure_class(false, false, false, &units, &W::Null, &W::string("SIGKILL")),
            "signal"
        );
        assert_eq!(
            failure_class(false, false, false, &units, &W::Number(256.0), &W::Null),
            "exit_unknown"
        );
        assert_eq!(
            failure_class(false, false, false, &units, &W::Null, &W::Null),
            "exit_unknown"
        );
    }

    #[test]
    fn the_command_is_the_first_word_after_the_global_options() {
        let command = |args: &[&str]| {
            git_command(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
        };
        assert_eq!(
            command(&["--git-dir", "x", "update-ref", "a"]),
            "update-ref"
        );
        assert_eq!(
            command(&["-c", "a=b", "-C", "d", "--literal-pathspecs", "ls-tree"]),
            "ls-tree"
        );
        assert_eq!(command(&["--git-dir"]), "unknown");
        assert_eq!(command(&["Ls-tree"]), "unknown");
        assert_eq!(command(&["a".repeat(33).as_str()]), "unknown");
        assert_eq!(command(&["a".repeat(32).as_str()]), "a".repeat(32));
    }
}
