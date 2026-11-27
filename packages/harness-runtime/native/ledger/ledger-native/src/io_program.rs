//! Test-only (`test-hooks`): the Rust side of the `node` module's
//! differential test (`scripts/ledger-native/fs-differential.mjs`).
//!
//! - [`run_program`] runs one I/O program of `scripts/ledger-native/fs-programs.mjs`
//!   (file calls, read streams consumed by listeners or `for await`, promise
//!   chains, ticks, microtasks, immediates and timers) on the virtual loop
//!   with the real pool, the twin of `scripts/ledger-native/fs-js-arm.mjs`
//!   `programs`. Every entry carries the checkpoint epoch it was logged in
//!   (`#k`), so the test can check rule 1 exactly; entries that descend from
//!   an I/O completion carry the completion's strand (`io:<strand>:`).
//! - [`serve_steps`] answers one file-system step per line (a call, a
//!   handle's method, a read stream's step), the twin of the JavaScript
//!   arm's `steps`, for the outcome comparison.
//!
//! Both are written as a port is: one `async_fn` per async function, one
//! `.await` per JavaScript await, `agen::for_await` with its closes, the
//! facade for every file call.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use ledger_core::base64;
use ledger_core::js::{JsStr, number_to_string};

use crate::agen;
use crate::emitter::Listener;
use crate::host;
use crate::js::{self, Promise, Resolution, Store, async_fn};
use crate::node::fs::{self as nfs, Data, Flags, MkdirOptions, RmOptions, Stats, WriteOptions};
use crate::node::stream::{ReadStream, ReadStreamOptions, create_read_stream};
use crate::node::{code_of, zlib};
use crate::value::{W, to_js_string, to_number};
use crate::virtual_host::VirtualHost;

/// The programs' `AsyncLocalStorage`, which tags every entry with its frame.
static FRAME: Store<String> = Store::new();

fn text(value: &W) -> String {
    to_js_string(value).to_string_lossy()
}

fn list(value: &W) -> Vec<W> {
    match value {
        W::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn number(value: &W) -> f64 {
    to_number(value)
}

/// 32-bit FNV-1a, as `fs-js-arm.mjs` computes it, to name a chunk's bytes.
pub fn fnv(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

struct Run {
    dir: String,
    trace: RefCell<Vec<String>>,
    fns: Vec<W>,
    /// The handles `hopen` opened, by its label.
    handles: RefCell<Vec<(String, nfs::FileHandle)>>,
}

impl Run {
    fn handle(&self, name: &str) -> Option<nfs::FileHandle> {
        self.handles
            .borrow()
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, handle)| handle.clone())
    }
}

/// Where an entry comes from: the pure program (`None`) or the strand of
/// the I/O completion it descends from.
#[derive(Clone, Default)]
struct Ctx {
    strand: Option<Rc<str>>,
}

impl Ctx {
    fn io(label: &str) -> Ctx {
        Ctx {
            strand: Some(Rc::from(label)),
        }
    }
}

fn log(run: &Rc<Run>, ctx: &Ctx, entry: &str) {
    let frame = match FRAME.get() {
        Some(value) => format!("~{value}"),
        None => String::new(),
    };
    let prefix = match &ctx.strand {
        Some(strand) => format!("io:{strand}:"),
        None => String::new(),
    };
    run.trace.borrow_mut().push(format!(
        "{prefix}{entry}@{}{frame}#{}",
        number_to_string(host::now()),
        js::checkpoint_epoch()
    ));
}

fn path_of(run: &Run, name: &str) -> String {
    format!("{}/{name}", run.dir)
}

/// What a file call of a program gives, shown as the JavaScript arm shows
/// it: its result text, or `!<code>` (the promise resolves either way).
fn start_io(run: &Rc<Run>, op: &str, target: &str, label: &str, h: &str) -> Promise<String, W> {
    let path = path_of(run, target);
    let dir = run.dir.clone();
    let shown = |promise: Promise<String, W>| {
        promise.then(
            |value| Ok(Resolution::Value(value)),
            |reason| Ok(Resolution::Value(format!("!{}", code_of(&reason)))),
        )
    };
    let kind = |stats: &Stats| {
        if stats.is_file() {
            format!("f:{}", number_to_string(stats.size()))
        } else if stats.is_directory() {
            String::from("d")
        } else if stats.is_symbolic_link() {
            String::from("l")
        } else {
            String::from("o")
        }
    };
    match op {
        "lstat" => shown(
            nfs::lstat(&path, false).then_ok(move |stats| Ok(Resolution::Value(kind(&stats)))),
        ),
        "stat" => {
            shown(nfs::stat(&path, false).then_ok(move |stats| Ok(Resolution::Value(kind(&stats)))))
        }
        "readFile" => shown(
            nfs::read_file(&path).then_ok(|bytes| Ok(Resolution::Value(bytes.len().to_string()))),
        ),
        "readFileUtf8" => shown(
            nfs::read_file_utf8(&path)
                .then_ok(|text| Ok(Resolution::Value(text.units().len().to_string()))),
        ),
        "readdir" => {
            shown(nfs::readdir(&path).then_ok(|names| Ok(Resolution::Value(names.join(",")))))
        }
        "access" => shown(
            nfs::access(&path, nfs::constants::F_OK)
                .then_ok(|()| Ok(Resolution::Value(String::from("ok")))),
        ),
        "realpath" => shown(nfs::realpath(&path).then_ok(|resolved| {
            Ok(Resolution::Value(
                resolved.rsplit('/').next().unwrap_or_default().to_owned(),
            ))
        })),
        "writeFile" => {
            let file = path_of(run, &format!("w/{label}"));
            shown(
                nfs::write_file(&file, &Data::Text(JsStr::from(label)), WriteOptions::WRITE)
                    .then_ok(|()| Ok(Resolution::Value(String::from("ok")))),
            )
        }
        "mkdir" => {
            let made = path_of(run, &format!("m/{label}/x"));
            // `{ recursive: true }`: the mode is the facade's default.
            let options = MkdirOptions {
                recursive: true,
                ..MkdirOptions::default()
            };
            shown(nfs::mkdir(&made, options).then_ok(move |first| {
                let shown = match first {
                    Some(first) => first
                        .strip_prefix(&format!("{dir}/"))
                        .unwrap_or(&first)
                        .to_owned(),
                    None => String::from("undefined"),
                };
                Ok(Resolution::Value(shown))
            }))
        }
        "rm" => {
            let gone = path_of(run, &format!("w/{label}.gone"));
            let options = RmOptions {
                recursive: false,
                force: true,
            };
            shown(nfs::rm(&gone, options).then_ok(|()| Ok(Resolution::Value(String::from("ok")))))
        }
        "deflate" => {
            let bytes = Rc::new(label.as_bytes().to_vec());
            shown(zlib::deflate(&bytes).then_ok(|_| Ok(Resolution::Value(String::from("ok")))))
        }
        "handle" => shown(read_head(path)),
        // A handle's methods as separate awaited calls (`h` names the
        // `hopen` that opened it).
        "hopen" => {
            let (run, label) = (run.clone(), label.to_owned());
            shown(
                nfs::open(&path, Flags::Str("r"), None).then_ok(move |handle| {
                    run.handles.borrow_mut().push((label, handle));
                    Ok(Resolution::Value(String::from("ok")))
                }),
            )
        }
        "hread" | "hstat" | "hclose" => {
            let Some(handle) = run.handle(h) else {
                return shown(Promise::reject(no_handle()));
            };
            match op {
                "hread" => shown(
                    handle
                        .read(16, Some(0))
                        .then_ok(|read| Ok(Resolution::Value(read.bytes_read.to_string()))),
                ),
                "hstat" => shown(
                    handle
                        .stat(false)
                        .then_ok(move |stats| Ok(Resolution::Value(kind(&stats)))),
                ),
                _ => shown(
                    handle
                        .close()
                        .then_ok(|()| Ok(Resolution::Value(String::from("ok")))),
                ),
            }
        }
        other => panic!("an I/O program op not known: {other}"),
    }
}

/// What a handle op of a program gives when its `hopen` did not open one.
fn no_handle() -> W {
    let mut error = crate::value::JsError::new("Error", "no handle");
    error.set_field("code", W::string("NOHANDLE"));
    W::Error(Rc::new(error))
}

/// `async (p) => { const h = await open(p, 'r'); const { bytesRead } =
/// await h.read(Buffer.alloc(16), 0, 16, 0) … finally { await h.close(); } }`
fn read_head(path: String) -> Promise<String, W> {
    async_fn(async move {
        let handle = nfs::open(&path, Flags::Str("r"), None).await?;
        let head: Result<String, W> = async {
            let read = handle.read(16, Some(0)).await?;
            Ok(read.bytes_read.to_string())
        }
        .await;
        handle.close().await?;
        Ok(Resolution::Value(head?))
    })
}

fn exec(run: &Rc<Run>, ctx: &Ctx, statements: &[W]) {
    for statement in statements {
        step(run, ctx, statement);
    }
}

fn step(run: &Rc<Run>, ctx: &Ctx, statement: &W) {
    let label = text(&statement.get("l"));
    let body = list(&statement.get("body"));
    match text(&statement.get("s")).as_str() {
        "log" => log(run, ctx, &label),
        "chain" => {
            let mut promise: Promise<W, W> = Promise::resolve(Resolution::Value(W::Undefined));
            for _ in 1..(number(&statement.get("n")) as usize).max(1) {
                promise = promise.then_ok(|_| Ok(Resolution::Value(W::Undefined)));
            }
            let (run, ctx) = (run.clone(), ctx.clone());
            let _ = promise.then_ok(move |_| {
                log(&run, &ctx, &label);
                Ok(Resolution::Value(W::Undefined))
            });
        }
        "tick" => {
            let (run, ctx) = (run.clone(), ctx.clone());
            js::next_tick(move || exec(&run, &ctx, &body));
        }
        "micro" => {
            let (run, ctx) = (run.clone(), ctx.clone());
            js::queue_microtask(move || exec(&run, &ctx, &body));
        }
        "immediate" => {
            let (run, ctx) = (run.clone(), ctx.clone());
            let _ = host::set_immediate(move || exec(&run, &ctx, &body));
        }
        "timeout" => {
            let (run, ctx) = (run.clone(), ctx.clone());
            let _ = host::set_timeout(number(&statement.get("ms")), move || {
                exec(&run, &ctx, &body)
            });
        }
        "run" => {
            let value = text(&statement.get("v"));
            FRAME.run(value, || exec(run, ctx, &body));
        }
        "call" => {
            let index = number(&statement.get("f")) as usize;
            let _ = call_fn(run, ctx, index);
        }
        "io" => {
            log(run, ctx, &format!("{label}>"));
            let started = start_io(
                run,
                &text(&statement.get("op")),
                &text(&statement.get("a")),
                &label,
                &text(&statement.get("h")),
            );
            let run = run.clone();
            let _ = started.then_ok(move |result| {
                let ctx = Ctx::io(&label);
                log(&run, &ctx, &format!("{label}={result}"));
                exec(&run, &ctx, &body);
                Ok(Resolution::Value(W::Undefined))
            });
        }
        "stream" => listen(run, ctx, statement, &label),
        other => panic!("an I/O program statement not known: {other}"),
    }
}

/// A read stream consumed by `data`, `end`, `error` and `close` listeners.
fn listen(run: &Rc<Run>, ctx: &Ctx, statement: &W, label: &str) {
    log(run, ctx, &format!("{label}>"));
    let options = ReadStreamOptions {
        high_water_mark: number(&statement.get("hwm")) as usize,
    };
    // port: read cut given by the caller (the program's)
    let stream = create_read_stream(&path_of(run, &text(&statement.get("a"))), options);
    let destroy_at = statement.get("destroyAt");
    let destroy_at = if destroy_at.is_undefined() {
        None
    } else {
        Some(number(&destroy_at) as usize)
    };
    let ctx = Ctx::io(label);
    let index = Rc::new(Cell::new(0usize));
    let on = |event: &str, call: Box<dyn Fn(&W)>| {
        stream.on(
            event,
            &Listener::new(move |value: &W| {
                call(value);
                Ok(())
            }),
        );
    };
    {
        let (run, ctx, label, index) = (run.clone(), ctx.clone(), label.to_owned(), index.clone());
        let weak = Rc::new(RefCell::new(None::<ReadStream>));
        *weak.borrow_mut() = Some(stream.clone());
        on(
            "data",
            Box::new(move |chunk| {
                let at = index.get();
                let length = match chunk {
                    W::Bytes(bytes) => bytes.len(),
                    _ => 0,
                };
                log(&run, &ctx, &format!("{label}.d{at}={length}"));
                index.set(at + 1);
                if destroy_at == Some(at)
                    && let Some(stream) = weak.borrow_mut().take()
                {
                    stream.destroy(None);
                }
            }),
        );
    }
    {
        let (run, ctx, label) = (run.clone(), ctx.clone(), label.to_owned());
        on(
            "end",
            Box::new(move |_| log(&run, &ctx, &format!("{label}.end"))),
        );
    }
    {
        let (run, ctx, label) = (run.clone(), ctx.clone(), label.to_owned());
        on(
            "error",
            Box::new(move |error| log(&run, &ctx, &format!("{label}.err={}", code_of(error)))),
        );
    }
    {
        let (run, ctx, label) = (run.clone(), ctx.clone(), label.to_owned());
        on(
            "close",
            Box::new(move |_| log(&run, &ctx, &format!("{label}.close"))),
        );
    }
}

/// One async function of a program, called (its strand starts pure and
/// becomes the strand of its first I/O completion).
fn call_fn(run: &Rc<Run>, ctx: &Ctx, index: usize) -> Promise<W, W> {
    let body = list(
        &run.fns
            .get(index)
            .map(|function| function.get("body"))
            .unwrap_or_default(),
    );
    let (run, start) = (run.clone(), ctx.clone());
    async_fn(async move {
        let mut ctx = start;
        for statement in body {
            let label = text(&statement.get("l"));
            match text(&statement.get("s")).as_str() {
                "await" => {
                    js::value::<W, W>(W::Undefined).await?;
                }
                "sleep" => {
                    host::sleep::<W>(number(&statement.get("ms"))).await?;
                }
                "awaitIo" => {
                    log(&run, &ctx, &format!("{label}>"));
                    let op = text(&statement.get("op"));
                    let target = text(&statement.get("a"));
                    let h = text(&statement.get("h"));
                    let result = start_io(&run, &op, &target, &label, &h).await?;
                    ctx = Ctx::io(&label);
                    log(&run, &ctx, &format!("{label}={result}"));
                }
                "forAwait" => {
                    log(&run, &ctx, &format!("{label}>"));
                    let options = ReadStreamOptions {
                        high_water_mark: number(&statement.get("hwm")) as usize,
                    };
                    let file = path_of(&run, &text(&statement.get("a")));
                    // port: read cut given by the caller (the program's)
                    let stream = create_read_stream(&file, options);
                    let exit = statement.get("exit");
                    let exit_at = if exit.is_undefined() {
                        None
                    } else {
                        Some((number(&exit.get("at")) as usize, text(&exit.get("kind"))))
                    };
                    let chunks = agen::for_await(stream);
                    let inner = list(&statement.get("body"));
                    let mut at = 0usize;
                    loop {
                        match chunks.next().await {
                            Err(error) => {
                                ctx = Ctx::io(&label);
                                log(
                                    &run,
                                    &ctx,
                                    &format!("{label}.caught={}", shown_error(&error)),
                                );
                                break;
                            }
                            Ok(None) => {
                                ctx = Ctx::io(&label);
                                log(&run, &ctx, &format!("{label}.done"));
                                break;
                            }
                            Ok(Some(chunk)) => {
                                ctx = Ctx::io(&label);
                                let length = match &chunk {
                                    W::Bytes(bytes) => bytes.len(),
                                    _ => 0,
                                };
                                log(&run, &ctx, &format!("{label}.c{at}={length}"));
                                exec(&run, &ctx, &inner);
                                match &exit_at {
                                    Some((when, kind)) if *when == at && kind == "break" => {
                                        chunks.close().await?;
                                        log(&run, &ctx, &format!("{label}.done"));
                                        break;
                                    }
                                    Some((when, _)) if *when == at => {
                                        let thrown = W::string(&format!("X{label}"));
                                        let error = chunks.close_throw(thrown).await;
                                        log(
                                            &run,
                                            &ctx,
                                            &format!("{label}.caught={}", shown_error(&error)),
                                        );
                                        break;
                                    }
                                    _ => {}
                                }
                                at += 1;
                            }
                        }
                    }
                }
                _ => exec(&run, &ctx, std::slice::from_ref(&statement)),
            }
        }
        Ok(Resolution::Value(W::Undefined))
    })
}

/// A caught value as the trace shows it: an error's `code`, else its text.
fn shown_error(error: &W) -> String {
    let code = code_of(error);
    if code.is_empty() { text(error) } else { code }
}

/// Runs one program in `dir` (its files made by the test) on a fresh
/// virtual loop: the main body as a unit, then iterations as the
/// JavaScript arm runs them: immediates first; while I/O is in flight and
/// no immediate is queued, the poll phase waits for it (the clock does not
/// move); otherwise the clock moves to the next timer, up to `until`.
/// Waiting for I/O has a deadline that names what did not answer.
pub fn run_program(program: &W, dir: &str) -> Result<String, String> {
    let virtual_host = VirtualHost::new(1000);
    let run = Rc::new(Run {
        dir: dir.to_owned(),
        trace: RefCell::new(Vec::new()),
        fns: list(&program.get("fns")),
        handles: RefCell::new(Vec::new()),
    });
    {
        let run = run.clone();
        js::on_unhandled_rejection(Rc::new(move |_| {
            run.trace.borrow_mut().push(String::from("U"));
        }));
    }
    let until = 1000 + {
        let given = number(&program.get("until"));
        if given.is_nan() { 50 } else { given as i64 }
    };
    let main = list(&program.get("main"));
    {
        let run = run.clone();
        virtual_host.deliver(move || exec(&run, &Ctx::default(), &main));
    }
    let event_loop = virtual_host.event_loop().clone();
    event_loop.timers_phase();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    for _ in 0..1_000_000 {
        if event_loop.has_immediates() {
            event_loop.check_phase();
            event_loop.timers_phase();
            continue;
        }
        if event_loop.blocking_pending() > 0 {
            if std::time::Instant::now() > deadline {
                return Err(format!(
                    "{} file calls of the program did not answer within 60 s",
                    event_loop.blocking_pending()
                ));
            }
            event_loop.poll_phase(Some(200), &mut |_| {});
            event_loop.check_phase();
            event_loop.timers_phase();
            continue;
        }
        match event_loop.next_expiry() {
            Some(expiry) if expiry <= until => {
                virtual_host.move_to(expiry);
                event_loop.timers_phase();
            }
            _ => break,
        }
    }
    let trace = run.trace.borrow().join(" ");
    Ok(trace)
}

// The step server: one call per line, its outcome per line.

fn shown_stats(stats: &Stats) -> W {
    let kind = if stats.is_file() {
        "file"
    } else if stats.is_directory() {
        "dir"
    } else if stats.is_symbolic_link() {
        "link"
    } else if stats.is_fifo() {
        "fifo"
    } else if stats.is_socket() {
        "socket"
    } else if stats.is_character_device() {
        "char"
    } else if stats.is_block_device() {
        "block"
    } else {
        "other"
    };
    let mut fields: Vec<(&str, W)> = vec![
        ("type", W::string(kind)),
        ("bigint", W::Bool(stats.bigint())),
    ];
    if stats.bigint() {
        let raw = stats.big();
        let big = |value: i128| W::string(&value.to_string());
        for (name, value) in [
            ("dev", raw.dev),
            ("ino", raw.ino),
            ("mode", raw.mode),
            ("nlink", raw.nlink),
            ("uid", raw.uid),
            ("gid", raw.gid),
            ("rdev", raw.rdev),
            ("size", raw.size),
            ("blksize", raw.blksize),
            ("blocks", raw.blocks),
        ] {
            fields.push((name, big(i128::from(value))));
        }
        fields.push(("atimeMs", big(stats.atime_ms_big())));
        fields.push(("mtimeMs", big(stats.mtime_ms_big())));
        fields.push(("ctimeMs", big(stats.ctime_ms_big())));
        fields.push(("atimeNs", big(stats.atime_ns())));
        fields.push(("mtimeNs", big(stats.mtime_ns())));
        fields.push(("ctimeNs", big(stats.ctime_ns())));
    } else {
        for (name, value) in [
            ("dev", stats.dev()),
            ("ino", stats.ino()),
            ("mode", stats.mode()),
            ("nlink", stats.nlink()),
            ("uid", stats.uid()),
            ("gid", stats.gid()),
            ("rdev", stats.rdev()),
            ("size", stats.size()),
            ("blksize", stats.blksize()),
            ("blocks", stats.blocks()),
            ("atimeMs", stats.atime_ms()),
            ("mtimeMs", stats.mtime_ms()),
            ("ctimeMs", stats.ctime_ms()),
        ] {
            fields.push((name, W::Number(value)));
        }
    }
    W::object(fields)
}

fn shown_failure(reason: &W) -> W {
    match reason {
        W::Error(error) => {
            let mut fields: Vec<(&str, W)> = vec![
                ("name", W::String(error.name.clone())),
                ("message", W::String(error.message.clone())),
            ];
            for (name, value) in &error.fields {
                fields.push((name, value.clone()));
            }
            W::object(vec![("err", W::object(fields))])
        }
        other => W::object(vec![(
            "err",
            W::object(vec![("value", W::string(&text(other)))]),
        )]),
    }
}

fn kind_name(kind: nfs::DirentKind) -> &'static str {
    match kind {
        nfs::DirentKind::File => "file",
        nfs::DirentKind::Directory => "dir",
        nfs::DirentKind::SymbolicLink => "link",
        nfs::DirentKind::Fifo => "fifo",
        nfs::DirentKind::Socket => "socket",
        nfs::DirentKind::CharacterDevice => "char",
        nfs::DirentKind::BlockDevice => "block",
        nfs::DirentKind::Unknown => "unknown",
    }
}

fn shown_dirents(entries: &[nfs::Dirent]) -> W {
    W::Array(
        entries
            .iter()
            .map(|entry| {
                W::object(vec![
                    ("name", W::string(&entry.name)),
                    ("type", W::string(kind_name(entry.kind))),
                    ("parentPath", W::string(&entry.parent_path)),
                ])
            })
            .collect(),
    )
}

/// A synchronous call's step (`fs.xSync`): its value, or its throw.
fn sync_step(outcome: Result<W, W>) -> Promise<W, W> {
    match outcome {
        Ok(value) => js::value(W::object(vec![("ok", value)])),
        Err(reason) => Promise::reject(reason),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).expect("hex"))
        .collect()
}

fn bytes_of(step: &W) -> Rc<Vec<u8>> {
    match step.get("b64") {
        W::String(text) => Rc::new(base64::decode(text.units())),
        _ => Rc::new(text(&step.get("text")).into_bytes()),
    }
}

fn data_of(step: &W) -> Data {
    match step.get("b64") {
        W::String(_) => Data::Bytes(bytes_of(step)),
        _ => Data::Text(to_js_string(&step.get("text"))),
    }
}

fn flags_of(value: &W) -> Flags {
    match value {
        W::Number(bits) => Flags::Bits(*bits as i32),
        W::String(text) => Flags::Str(Box::leak(text.to_string_lossy().into_boxed_str())),
        _ => Flags::Str("r"),
    }
}

fn optional_position(value: &W) -> Option<i64> {
    match value {
        W::Number(at) => Some(*at as i64),
        _ => None,
    }
}

fn ok<T: Clone + 'static>(
    promise: Promise<T, W>,
    show: impl FnOnce(T) -> W + 'static,
) -> Promise<W, W> {
    promise.then_ok(move |value| Ok(Resolution::Value(W::object(vec![("ok", show(value))]))))
}

/// An iterator's `next()` promise.
type StepPromise = Promise<agen::Step<W>, W>;

/// A read stream of the steps, by name, with its iterator.
type NamedStream = (String, ReadStream, agen::AsyncGen<W, W>);

struct Steps {
    handles: RefCell<Vec<(String, nfs::FileHandle, String)>>,
    streams: RefCell<Vec<NamedStream>>,
    /// A stream's first `next()`, made with it as `for await` makes it.
    first: RefCell<Vec<(String, StepPromise)>>,
    /// The umask the server started with, once a step changed it.
    umask: Cell<Option<u32>>,
}

impl Steps {
    fn handle(&self, name: &str) -> nfs::FileHandle {
        self.handles
            .borrow()
            .iter()
            .find(|(known, ..)| known == name)
            .map(|(_, handle, _)| handle.clone())
            .unwrap_or_else(|| panic!("no handle {name}"))
    }

    fn handle_path(&self, name: &str) -> String {
        self.handles
            .borrow()
            .iter()
            .find(|(known, ..)| known == name)
            .map(|(.., path)| path.clone())
            .unwrap_or_default()
    }

    fn stream(&self, name: &str) -> (ReadStream, agen::AsyncGen<W, W>) {
        self.streams
            .borrow()
            .iter()
            .find(|(known, ..)| known == name)
            .map(|(_, stream, iterator)| (stream.clone(), iterator.clone()))
            .unwrap_or_else(|| panic!("no stream {name}"))
    }
}

/// Starts one step; its promise gives the line to print.
fn start_step(steps: &Rc<Steps>, step: &W) -> Promise<W, W> {
    let path = text(&step.get("path"));
    let bigint = matches!(step.get("bigint"), W::Bool(true));
    let unit = |_: ()| W::Null;
    // What a write's continuation finds on disk (`fs.lstatSync(file).size`,
    // inline): a write acknowledged before its bytes are there shows here.
    let on_disk = |file: String| {
        move |_| {
            let size = nfs::lstat_sync(&file, false).map_or(-1.0, |stats| stats.size());
            W::object(vec![("sizeAfter", W::Number(size))])
        }
    };
    let started: Promise<W, W> = match text(&step.get("op")).as_str() {
        "access" => {
            let mode = step.get("mode");
            let mode = if mode.is_undefined() {
                nfs::constants::F_OK
            } else {
                number(&mode) as i32
            };
            ok(nfs::access(&path, mode), unit)
        }
        "appendFile" => ok(
            nfs::append_file(
                &path,
                &data_of(step),
                write_options(step, WriteOptions::APPEND),
            ),
            on_disk(path.clone()),
        ),
        "chmod" => ok(nfs::chmod(&path, number(&step.get("mode")) as u32), unit),
        "copyFile" => ok(
            nfs::copy_file(
                &text(&step.get("src")),
                &text(&step.get("dest")),
                number(&step.get("mode")) as u32,
            ),
            on_disk(text(&step.get("dest"))),
        ),
        "link" => ok(
            nfs::link(&text(&step.get("src")), &text(&step.get("dest"))),
            unit,
        ),
        "lstat" => ok(nfs::lstat(&path, bigint), |stats| shown_stats(&stats)),
        "stat" => ok(nfs::stat(&path, bigint), |stats| shown_stats(&stats)),
        "statfs" => ok(nfs::statfs(&path, bigint), |statfs| {
            let raw = statfs.raw;
            let value = |field: i64| {
                if statfs.bigint {
                    W::string(&field.to_string())
                } else {
                    W::Number(field as f64)
                }
            };
            W::object(vec![
                ("type", value(raw.kind)),
                ("bsize", value(raw.bsize)),
                ("blocks", value(raw.blocks)),
                ("bfree", value(raw.bfree)),
                ("bavail", value(raw.bavail)),
                ("files", value(raw.files)),
                ("ffree", value(raw.ffree)),
            ])
        }),
        "mkdir" => {
            let mode = step.get("mode");
            let options = MkdirOptions {
                recursive: matches!(step.get("recursive"), W::Bool(true)),
                // No mode given: the facade's default (Node's 0o777).
                mode: if mode.is_undefined() {
                    MkdirOptions::default().mode
                } else {
                    number(&mode) as u32
                },
            };
            ok(nfs::mkdir(&path, options), |first| match first {
                Some(first) => W::string(&first),
                None => W::Null,
            })
        }
        "readdir" => {
            if matches!(step.get("types"), W::Bool(true)) {
                ok(nfs::readdir_with_file_types(&path), |entries| {
                    shown_dirents(&entries)
                })
            } else {
                ok(nfs::readdir(&path), |names| {
                    W::Array(names.iter().map(|name| W::string(name)).collect())
                })
            }
        }
        "readFile" => {
            if matches!(step.get("utf8"), W::Bool(true)) {
                ok(nfs::read_file_utf8(&path), W::String)
            } else {
                ok(nfs::read_file(&path), |bytes| {
                    W::string(&base64::encode(&bytes))
                })
            }
        }
        "readlink" if matches!(step.get("buffer"), W::Bool(true)) => {
            ok(nfs::readlink_bytes(&path), |bytes| {
                W::object(vec![("hex", W::string(&hex(&bytes)))])
            })
        }
        "readlink" => ok(nfs::readlink(&path), |target| W::string(&target)),
        "lstatSync" => sync_step(nfs::lstat_sync(&path, bigint).map(|stats| shown_stats(&stats))),
        "readdirSync" => sync_step(
            nfs::readdir_with_file_types_sync(&path).map(|entries| shown_dirents(&entries)),
        ),
        "umask" => {
            // `process.umask(mask)`; without a mask, the one the server
            // started with again.
            let mask = step.get("mask");
            // port: sync call (process.umask)
            let old = ledger_io::fs::set_umask(if mask.is_undefined() {
                steps.umask.get().unwrap_or(0o022)
            } else {
                number(&mask) as u32
            });
            if steps.umask.get().is_none() {
                steps.umask.set(Some(old));
            }
            ok(js::value(()), unit)
        }
        "realpath" => ok(nfs::realpath(&path), |resolved| W::string(&resolved)),
        "rename" => ok(
            nfs::rename(&text(&step.get("src")), &text(&step.get("dest"))),
            unit,
        ),
        "rm" => ok(
            nfs::rm(
                &path,
                RmOptions {
                    recursive: matches!(step.get("recursive"), W::Bool(true)),
                    force: matches!(step.get("force"), W::Bool(true)),
                },
            ),
            unit,
        ),
        "rmdir" => ok(nfs::rmdir(&path), unit),
        "symlink" => {
            let kind = step.get("type");
            let kind = if kind.is_undefined() {
                None
            } else {
                Some(text(&kind))
            };
            match step.get("targetHex") {
                W::String(target) => ok(
                    nfs::symlink_bytes(&unhex(&target.to_string_lossy()), &path, kind.as_deref()),
                    unit,
                ),
                _ => ok(
                    nfs::symlink(&text(&step.get("target")), &path, kind.as_deref()),
                    unit,
                ),
            }
        }
        "unlink" => ok(nfs::unlink(&path), unit),
        "utimes" => {
            let time = |value: W| match value.get("date") {
                W::Number(ms) => nfs::Time::Date(ms),
                _ => nfs::Time::Seconds(number(&value.get("seconds"))),
            };
            ok(
                nfs::utimes(&path, time(step.get("atime")), time(step.get("mtime"))),
                unit,
            )
        }
        "writeFile" => ok(
            nfs::write_file(
                &path,
                &data_of(step),
                write_options(step, WriteOptions::WRITE),
            ),
            on_disk(path.clone()),
        ),
        "deflate" => ok(zlib::deflate(&bytes_of(step)), |bytes| {
            W::string(&base64::encode(&bytes))
        }),
        "open" => {
            let mode = step.get("mode");
            let mode = if mode.is_undefined() {
                None
            } else {
                Some(number(&mode) as u32)
            };
            let name = text(&step.get("as"));
            let steps = steps.clone();
            ok(
                nfs::open(&path, flags_of(&step.get("flags")), mode),
                move |handle| {
                    steps.handles.borrow_mut().push((name, handle, path));
                    W::Null
                },
            )
        }
        "h.read" => {
            let handle = steps.handle(&text(&step.get("h")));
            ok(
                handle.read(
                    number(&step.get("length")) as usize,
                    optional_position(&step.get("position")),
                ),
                |read| {
                    W::object(vec![
                        ("bytesRead", W::Number(read.bytes_read as f64)),
                        ("b64", W::string(&base64::encode(&read.bytes))),
                    ])
                },
            )
        }
        "h.write" => {
            let handle = steps.handle(&text(&step.get("h")));
            let file = steps.handle_path(&text(&step.get("h")));
            let bytes = bytes_of(step);
            let offset = number(&step.get("offset"));
            let offset = if offset.is_nan() { 0 } else { offset as usize };
            let length = number(&step.get("length"));
            let length = if length.is_nan() {
                bytes.len() - offset
            } else {
                length as usize
            };
            ok(
                handle.write(
                    &bytes,
                    offset,
                    length,
                    optional_position(&step.get("position")),
                ),
                move |written| {
                    let size = nfs::lstat_sync(&file, false).map_or(-1.0, |stats| stats.size());
                    W::object(vec![
                        ("bytesWritten", W::Number(written as f64)),
                        ("sizeAfter", W::Number(size)),
                    ])
                },
            )
        }
        "h.writeFile" => ok(
            steps
                .handle(&text(&step.get("h")))
                .write_file(&data_of(step)),
            on_disk(steps.handle_path(&text(&step.get("h")))),
        ),
        "h.stat" => ok(steps.handle(&text(&step.get("h"))).stat(bigint), |stats| {
            shown_stats(&stats)
        }),
        "h.chmod" => ok(
            steps
                .handle(&text(&step.get("h")))
                .chmod(number(&step.get("mode")) as u32),
            unit,
        ),
        "h.sync" => ok(steps.handle(&text(&step.get("h"))).sync(), unit),
        "h.close" => ok(steps.handle(&text(&step.get("h"))).close(), unit),
        "rs.create" => {
            // port: read cut given by the caller (the program's)
            let stream = create_read_stream(
                &path,
                ReadStreamOptions {
                    high_water_mark: number(&step.get("hwm")) as usize,
                },
            );
            let iterator = stream.iter();
            // As `for await` does: the iterator and its first `next()` at once.
            let first = iterator.next(W::Undefined);
            let _ = first.catch(|_| {
                Ok(Resolution::Value(agen::Step {
                    value: W::Undefined,
                    done: true,
                }))
            });
            let name = text(&step.get("s"));
            steps.first.borrow_mut().push((name.clone(), first));
            steps.streams.borrow_mut().push((name, stream, iterator));
            ok(js::value(()), unit)
        }
        "rs.next" => {
            let name = text(&step.get("s"));
            let (_, iterator) = steps.stream(&name);
            let first = {
                let mut pending = steps.first.borrow_mut();
                let at = pending.iter().position(|(known, _)| *known == name);
                at.map(|at| pending.remove(at).1)
            };
            let call = first.unwrap_or_else(|| iterator.next(W::Undefined));
            ok(call, |item| {
                let (length, hash) = match &item.value {
                    W::Bytes(bytes) => (bytes.len() as f64, f64::from(fnv(bytes))),
                    _ => (0.0, 0.0),
                };
                if item.done {
                    W::object(vec![("done", W::Bool(true))])
                } else {
                    W::object(vec![
                        ("done", W::Bool(false)),
                        ("length", W::Number(length)),
                        ("fnv", W::Number(hash)),
                    ])
                }
            })
        }
        "rs.return" => {
            let (_, iterator) = steps.stream(&text(&step.get("s")));
            ok(iterator.return_(Resolution::Value(W::Undefined)), |item| {
                W::object(vec![("done", W::Bool(item.done))])
            })
        }
        "rs.state" => {
            let (stream, _) = steps.stream(&text(&step.get("s")));
            ok(js::value(()), move |()| {
                W::object(vec![
                    ("destroyed", W::Bool(stream.destroyed())),
                    ("closed", W::Bool(stream.closed())),
                    ("bytesRead", W::Number(stream.bytes_read() as f64)),
                ])
            })
        }
        "fds" => {
            let count = nfs::open_descriptor_count();
            ok(js::value(()), move |()| W::Number(count as f64))
        }
        other => panic!("a step not known: {other}"),
    };
    started.catch(|reason| Ok(Resolution::Value(shown_failure(&reason))))
}

fn write_options(step: &W, defaults: WriteOptions) -> WriteOptions {
    let mode = step.get("mode");
    let flag = step.get("flag");
    WriteOptions {
        mode: if mode.is_undefined() {
            defaults.mode
        } else {
            number(&mode) as u32
        },
        flag: if flag.is_undefined() {
            defaults.flag
        } else {
            flags_of(&flag)
        },
    }
}

/// Runs the loop until `promise` settles (or, for `rs.idle`, until the
/// stream has no read in flight), with a deadline.
fn settle(virtual_host: &VirtualHost, done: &dyn Fn() -> bool) -> Result<(), String> {
    let event_loop = virtual_host.event_loop().clone();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        event_loop.checkpoint();
        if done() {
            return Ok(());
        }
        if event_loop.has_immediates() {
            event_loop.check_phase();
            continue;
        }
        if std::time::Instant::now() > deadline {
            return Err(String::from(
                "the step's file call did not answer within 30 s",
            ));
        }
        event_loop.poll_phase(Some(200), &mut |_| {});
    }
}

/// `ledger-native-probe fs-steps`: one step per input line (decoded by
/// `decode_line`), one outcome line each (`{ok}` or `{err}`).
pub fn serve_steps(
    lines: impl Iterator<Item = Vec<u8>>,
    mut out: impl FnMut(&W),
    decode: impl Fn(&[u8]) -> Option<W>,
) {
    let virtual_host = VirtualHost::new(1000);
    let steps = Rc::new(Steps {
        handles: RefCell::new(Vec::new()),
        streams: RefCell::new(Vec::new()),
        first: RefCell::new(Vec::new()),
        umask: Cell::new(None),
    });
    for line in lines {
        let Some(step) = decode(&line) else {
            out(&W::object(vec![("corrupt", W::Bool(true))]));
            continue;
        };
        let op = text(&step.get("op"));
        if op == "rs.idle" || op == "rs.waitClosed" {
            // Wait (on the loop) until the stream has no read in flight, or
            // until its descriptor is closed.
            let (stream, _) = steps.stream(&text(&step.get("s")));
            let outcome = if op == "rs.idle" {
                settle(&virtual_host, &|| !stream.performing_io())
            } else {
                settle(&virtual_host, &|| stream.closed())
            };
            out(&match outcome {
                Ok(()) => W::object(vec![("ok", W::Null)]),
                Err(message) => W::object(vec![("timeout", W::string(&message))]),
            });
            continue;
        }
        let slot: Rc<RefCell<Option<W>>> = Rc::new(RefCell::new(None));
        let promise = {
            let slot = slot.clone();
            let mut started = None;
            virtual_host.deliver(|| {
                started = Some(start_step(&steps, &step).then_ok(move |line| {
                    *slot.borrow_mut() = Some(line.clone());
                    Ok(Resolution::Value(line))
                }));
            });
            started.expect("a started step")
        };
        match settle(&virtual_host, &|| promise.is_settled()) {
            Ok(()) => out(&slot.borrow_mut().take().unwrap_or(W::Null)),
            Err(message) => out(&W::object(vec![("timeout", W::string(&message))])),
        }
    }
}
