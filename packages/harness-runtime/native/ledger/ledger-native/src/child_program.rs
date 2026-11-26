//! Test-only (`test-hooks`): the Rust side of the child-process
//! differential test (`scripts/ledger-native/child-differential.mjs`), the
//! twin of `scripts/ledger-native/child-js-arm.mjs`.
//!
//! - [`serve_cases`] runs one outcome case per line (`child-spec.mjs`) to
//!   its end on a loop with the real clock, and prints its record (every
//!   event of every source in arrival order, the output, the final state);
//!   `{op: 'census'}` answers the descriptors, live children, helper threads
//!   and open sources, for the census around every case.
//! - [`run_program`] runs one program of `child-programs.mjs` (children
//!   spawned with listeners on every event, `git()`-shaped calls, file calls,
//!   promise chains, ticks, microtasks, immediates, timers, a frame) on the
//!   virtual loop with real children; every entry carries its checkpoint
//!   epoch (`#k`) and the strand (`io:<strand>:`) of the event it descends
//!   from.
//!
//! Both are written as a port is: one `async_fn` per async function, one
//! `.await` per JavaScript await, `agen::for_await` with its closes, the
//! `node` module for every child, socket and file call.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use ledger_core::js::{JsStr, number_to_string};

use crate::agen::{self, Abrupt, AsyncGen, Co};
use crate::ctx::{Remote, run_in_remote_execution_context};
use crate::emitter::Listener;
use crate::host::{self, EventLoop, RealClock};
use crate::io_program::fnv;
use crate::js::{self, Promise, Resolution, Resolvers, Store, async_fn};
use crate::node::child::{self, ChildProcess, Signal, Spawn, Stdio};
use crate::node::net::{self, PipeInput, Socket};
use crate::node::{code_of, fs as nfs};
use crate::signal::Controller;
use crate::value::{JsError, W, to_js_string, to_number};
use crate::virtual_host::VirtualHost;

fn text(value: &W) -> String {
    to_js_string(value).to_string_lossy()
}

fn list(value: &W) -> Vec<W> {
    match value {
        W::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn strings(value: &W) -> Vec<String> {
    list(value).iter().map(text).collect()
}

/// `Object.fromEntries([[key, value], …])` (or `{key: value}`) as the
/// spawn's environment, in JavaScript's key order (`child::env_pairs`).
fn env_of(value: &W) -> Vec<(String, String)> {
    let entries: Vec<(String, Option<String>)> = match value {
        W::Array(pairs) => pairs
            .iter()
            .map(|pair| {
                let pair = list(pair);
                let at = |index: usize| pair.get(index).map(text).unwrap_or_default();
                (at(0), Some(at(1)))
            })
            .collect(),
        W::Object(entries) => entries
            .iter()
            .map(|(key, value)| (key.to_string_lossy(), Some(text(value))))
            .collect(),
        _ => Vec::new(),
    };
    child::env_pairs(entries)
}

fn signal_of(value: &W) -> Signal {
    match text(value).as_str() {
        "SIGKILL" => Signal::Kill,
        "SIGTERM" => Signal::Term,
        "SIGINT" => Signal::Int,
        "SIGHUP" => Signal::Hup,
        "0" => Signal::Zero,
        other => panic!("a signal the cases do not use: {other}"),
    }
}

fn status(value: &W) -> String {
    let part = |item: W| match item {
        W::Null => String::from("null"),
        W::Number(number) => number_to_string(number),
        other => text(&other),
    };
    match value {
        W::Array(items) if items.len() == 2 => {
            format!("{},{}", part(items[0].clone()), part(items[1].clone()))
        }
        other => text(other),
    }
}

/// `(async function* rows() { … await exited; await null; yield text; … })()`,
/// throwing at `throw_at`, waiting for the child's exit at `wait_exit_at`.
fn rows(
    texts: Vec<String>,
    throw_at: Option<usize>,
    wait_exit_at: Option<usize>,
    exited: Option<Promise<W, W>>,
) -> AsyncGen<W, W> {
    agen::async_gen(move |co: Co<W, W>| async move {
        for (at, row) in texts.into_iter().enumerate() {
            if throw_at == Some(at) {
                let mut error = JsError::new("Error", "the rows failed");
                error.set_field("code", W::string("ROWS_FAILED"));
                return Err(Abrupt::Throw(W::Error(Rc::new(error))));
            }
            if wait_exit_at == Some(at)
                && let Some(exited) = &exited
            {
                exited.clone().await?;
            }
            js::value::<W, W>(W::Null).await?;
            co.yield_(Resolution::Value(W::string(&row))).await?;
        }
        Ok(())
    })
}

/// What a case or a statement feeds the stdin with, as `start()` builds it
/// (`exited`: the child's exit, for a row that waits for it).
fn input_of(input: &W, exited: Option<Promise<W, W>>) -> Option<PipeInput> {
    if let W::String(pipe) = input.get("pipe") {
        return Some(PipeInput::Bytes(Rc::new(
            pipe.to_string_lossy().into_bytes(),
        )));
    }
    let bytes = input.get("pipeBytes");
    if !bytes.is_undefined() {
        return Some(PipeInput::Bytes(Rc::new(vec![
            0x61;
            to_number(&bytes) as usize
        ])));
    }
    let texts = input.get("gen");
    if !texts.is_undefined() {
        let at = |key: &str| {
            let value = input.get(key);
            (!value.is_undefined()).then(|| to_number(&value) as usize)
        };
        return Some(PipeInput::Generator(rows(
            strings(&texts),
            at("throwAt"),
            at("waitExitAt"),
            exited,
        )));
    }
    (text(input) == "empty").then_some(PipeInput::Empty)
}

fn error_shape(error: &W) -> W {
    match error {
        W::Error(made) => {
            let mut fields: Vec<(&str, W)> = vec![
                ("name", W::String(made.name.clone())),
                ("message", W::String(made.message.clone())),
            ];
            for key in ["errno", "code", "syscall", "path", "spawnargs"] {
                if let Some(value) = made.field(key) {
                    fields.push((key, value.clone()));
                }
            }
            W::object(fields)
        }
        other => W::object(vec![("value", W::string(&text(other)))]),
    }
}

// --- Cases -------------------------------------------------------------

struct Case {
    events: RefCell<Vec<W>>,
    out: RefCell<Vec<u8>>,
    err: RefCell<String>,
    error: RefCell<Option<W>>,
    writing: RefCell<Option<String>>,
    writing_error: RefCell<Option<W>>,
    /// The bytes of its `total` the consumer had not taken when it first
    /// saw the watched file.
    ahead: Cell<Option<f64>>,
    /// The descriptors this process held without close-on-exec when the
    /// case started, and right before its spawn (a `descriptors` case).
    started_with: Vec<i32>,
    inheritable: RefCell<Option<Vec<i32>>>,
}

fn numbers(fds: &[i32]) -> W {
    W::Array(fds.iter().map(|fd| W::Number(f64::from(*fd))).collect())
}

impl Case {
    fn event(&self, source: &str, name: &str, value: Option<W>) {
        let mut entry = vec![W::string(source), W::string(name)];
        entry.extend(value);
        self.events.borrow_mut().push(W::Array(entry));
    }
}

/// `fs.existsSync(path)` of a case's watched file.
fn exists(path: &str) -> bool {
    // port: sync call (fs.existsSync)
    std::fs::symlink_metadata(path).is_ok()
}

/// Takes descriptors until `EMFILE`, then gives `free` of them back: the
/// rest, to close after the spawn.
// port: sync call (the descriptors fs.openSync gives, held)
fn hold_descriptors(free: usize) -> Vec<std::fs::File> {
    let mut held = Vec::new();
    loop {
        // port: sync call (fs.openSync)
        match std::fs::File::open("/dev/null") {
            Ok(file) => held.push(file),
            Err(error) if error.raw_os_error() == Some(24) => break,
            Err(error) => panic!("taking descriptors: {error}"),
        }
    }
    for _ in 0..free {
        held.pop();
    }
    held
}

/// `process.kill(pid, 'SIGKILL')` of the grandchild a case started (its pid
/// in the file the child wrote): the case's own, killed once it is over.
fn reap_grandchild(file: &str) {
    // port: sync call (fs.readFileSync)
    let pid = std::fs::read_to_string(file)
        .ok()
        .and_then(|text| text.trim().parse::<i32>().ok());
    if let Some(pid) = pid.filter(|pid| *pid > 1) {
        // port: sync call (process.kill)
        let _ = ledger_io::fs::sys::kill(pid, 9);
    }
}

fn kills(case: &Rc<Case>, child: &ChildProcess, plan: &[W], at: &str) {
    for kill in plan {
        if text(&kill.get("at")) == at {
            let result = child.kill(signal_of(&kill.get("signal"))).expect("kill");
            case.event("kill", at, Some(W::Bool(result)));
        }
    }
}

fn listen(socket: &Socket, event: &str, call: impl Fn(&W) + 'static) {
    socket.on(
        event,
        &Listener::new(move |value: &W| {
            call(value);
            Ok(())
        }),
    );
}

/// When a case is over.
type Finished = Rc<dyn Fn() -> bool>;

/// One case, started on the loop: when it is over, and its child.
fn start_case(c: &W, case: &Rc<Case>) -> Option<(Finished, ChildProcess)> {
    let stdio = list(&c.get("stdio"));
    let stdio_at = |at: usize| match stdio.get(at).map(text).as_deref() {
        Some("ignore") => Stdio::Ignore,
        _ => Stdio::Pipe,
    };
    let cwd = c.get("cwd");
    let free = c.get("free");
    let held = (!free.is_undefined()).then(|| hold_descriptors(to_number(&free) as usize));
    if matches!(c.get("descriptors"), W::Bool(true)) {
        // port: sync call (the arm's own descriptors, read before the spawn)
        *case.inheritable.borrow_mut() = Some(ledger_io::fs::sys::inheritable_descriptors());
    }
    let spawned = child::spawn(Spawn {
        file: text(&c.get("file")),
        args: strings(&c.get("args")),
        cwd: (!cwd.is_undefined()).then(|| text(&cwd)),
        env: env_of(&c.get("env")),
        stdio: [stdio_at(0), stdio_at(1), stdio_at(2)],
    });
    drop(held);
    let child = match spawned {
        Ok(child) => child,
        Err(error) => {
            *case.error.borrow_mut() = Some(W::object(vec![("thrown", error_shape(&error))]));
            return None;
        }
    };
    let plan = list(&c.get("kill"));
    let destroys = list(&c.get("destroy"));
    let (exited, exited_resolve): (Promise<W, W>, Resolvers<W, W>) = Promise::with_resolvers();
    {
        let case = case.clone();
        child.on(
            "spawn",
            &Listener::new(move |_| {
                case.event("child", "spawn", None);
                Ok(())
            }),
        );
    }
    {
        let (case, me, plan) = (case.clone(), child.clone(), plan.clone());
        child.on(
            "exit",
            &Listener::new(move |value: &W| {
                let destroyed = me
                    .stdin()
                    .map_or(W::Null, |stdin| W::Bool(stdin.destroyed()));
                let shown = match destroyed {
                    W::Bool(flag) => flag.to_string(),
                    _ => String::from("null"),
                };
                case.event(
                    "child",
                    "exit",
                    Some(W::string(&format!("{},{shown}", status(value)))),
                );
                kills(&case, &me, &plan, "exit");
                for entry in destroys
                    .iter()
                    .filter(|entry| text(&entry.get("at")) == "exit")
                {
                    let stream = text(&entry.get("stream"));
                    case.event("destroy", &stream, None);
                    let socket = match stream.as_str() {
                        "stdin" => me.stdin(),
                        "stdout" => me.stdout(),
                        _ => me.stderr(),
                    };
                    socket.expect("a socket to destroy").destroy(None);
                }
                exited_resolve.fulfill(W::Undefined);
                Ok(())
            }),
        );
    }
    let closed = Rc::new(Cell::new(false));
    let (done, resolve): (Promise<W, W>, Resolvers<W, W>) = Promise::with_resolvers();
    {
        let (case, resolve) = (case.clone(), resolve.clone());
        child.on(
            "error",
            &Listener::new(move |error: &W| {
                case.event("child", "error", Some(W::string(&code_of(error))));
                *case.error.borrow_mut() = Some(error_shape(error));
                resolve.reject(error.clone());
                Ok(())
            }),
        );
    }
    {
        let (case, me, plan, closed) = (case.clone(), child.clone(), plan.clone(), closed.clone());
        child.on(
            "close",
            &Listener::new(move |value: &W| {
                case.event("child", "close", Some(W::string(&status(value))));
                kills(&case, &me, &plan, "close");
                closed.set(true);
                resolve.fulfill(W::Undefined);
                Ok(())
            }),
        );
    }
    done.clone().react(|_| {});
    let mut sockets: Vec<Socket> = Vec::new();
    for (name, socket) in [
        ("stdin", child.stdin()),
        ("stdout", child.stdout()),
        ("stderr", child.stderr()),
    ] {
        let Some(socket) = socket else { continue };
        sockets.push(socket.clone());
        for kind in ["end", "finish", "error", "close"] {
            if kind == "end" && name == "stdin" {
                continue;
            }
            let case = case.clone();
            listen(&socket, kind, move |value| {
                let shown = match kind {
                    "error" => Some(W::string(&code_of(value))),
                    "close" => Some(value.clone()),
                    _ => None,
                };
                case.event(name, kind, shown);
            });
        }
    }
    if let Some(stderr) = child.stderr()
        && text(&c.get("stderr")) == "data"
    {
        let case = case.clone();
        listen(&stderr, "data", move |chunk| {
            case.event("stderr", "data", None);
            if let W::Bytes(bytes) = chunk {
                case.err
                    .borrow_mut()
                    .push_str(&String::from_utf8_lossy(bytes));
            }
        });
    }
    let stdout_mode = c.get("stdout");
    if let Some(stdout) = child.stdout()
        && text(&stdout_mode) == "data"
    {
        let (case, me, plan) = (case.clone(), child.clone(), plan.clone());
        let first = Cell::new(true);
        listen(&stdout, "data", move |chunk| {
            case.event("stdout", "data", None);
            if let W::Bytes(bytes) = chunk {
                case.out.borrow_mut().extend_from_slice(bytes);
            }
            if first.replace(false) {
                kills(&case, &me, &plan, "data");
            }
        });
    }
    let input = c.get("input");
    let writing_done = Rc::new(Cell::new(true));
    let mut writing: Option<Promise<W, W>> = None;
    if let Some(stdin) = child.stdin() {
        if let Some(source) = input_of(&input, Some(exited)) {
            writing_done.set(false);
            let (case_ok, case_err, flag_ok, flag_err) = (
                case.clone(),
                case.clone(),
                writing_done.clone(),
                writing_done.clone(),
            );
            let settled = net::pipeline(source, &stdin).then(
                move |()| {
                    case_ok.event("writing", "ok", None);
                    *case_ok.writing.borrow_mut() = Some(String::from("ok"));
                    flag_ok.set(true);
                    Ok(Resolution::Value(W::Undefined))
                },
                move |error| {
                    let code = code_of(&error);
                    case_err.event("writing", "err", Some(W::string(&code)));
                    *case_err.writing.borrow_mut() = Some(code);
                    *case_err.writing_error.borrow_mut() = Some(error_shape(&error));
                    flag_err.set(true);
                    Ok(Resolution::Value(W::Undefined))
                },
            );
            writing = Some(settled);
        } else if matches!(input.get("write"), W::Array(_))
            || matches!(input.get("writeBytes"), W::Array(_))
        {
            let chunks: Vec<Vec<u8>> = match input.get("write") {
                W::Array(texts) => texts.iter().map(|chunk| text(chunk).into_bytes()).collect(),
                _ => list(&input.get("writeBytes"))
                    .iter()
                    .map(|size| vec![0x62; to_number(size) as usize])
                    .collect(),
            };
            for chunk in chunks {
                let called = case.clone();
                let returned = stdin.write(
                    &chunk,
                    Some(Box::new(move |error: Option<W>| {
                        let shown =
                            error.map_or_else(|| String::from("ok"), |error| code_of(&error));
                        called.event("wcb", "called", Some(W::string(&shown)));
                    })),
                );
                case.event("wcb", "returned", Some(W::Bool(returned)));
            }
            if matches!(input.get("end"), W::Bool(true)) {
                stdin.end();
            }
        } else if text(&input) == "end" {
            stdin.end();
        }
    }
    kills(case, &child, &plan, "spawn");
    let mut timers = Vec::new();
    for kill in &plan {
        if text(&kill.get("at")) == "timer" {
            let (case, me, signal) = (case.clone(), child.clone(), signal_of(&kill.get("signal")));
            let check = kill.get("check");
            let check = (!check.is_undefined()).then(|| text(&check));
            timers.push(host::set_timeout(to_number(&kill.get("ms")), move || {
                if let Some(check) = &check {
                    case.event("watch", "check", Some(W::Bool(exists(check))));
                }
                let result = me.kill(signal).expect("kill");
                case.event("kill", "timer", Some(W::Bool(result)));
            }));
        }
    }
    let reading = read_case(case, &child, &stdout_mode, &plan, done, writing);
    let finished: Finished = Rc::new(move || {
        let over = closed.get()
            && sockets.iter().all(Socket::handle_closed)
            && writing_done.get()
            && reading.is_settled();
        if over {
            for timer in &timers {
                host::clear_timeout(timer);
            }
        }
        over
    });
    Some((finished, child))
}

/// The case's `for await` over stdout, shaped as `git()`: the loop, then
/// `await writing; await done`, a `finally` that kills and waits for both.
fn read_case(
    case: &Rc<Case>,
    child: &ChildProcess,
    mode: &W,
    plan: &[W],
    done: Promise<W, W>,
    writing: Option<Promise<W, W>>,
) -> Promise<W, W> {
    let iterate = matches!(mode, W::Object(_)) || text(mode) == "forAwait";
    let (case, child, plan) = (case.clone(), child.clone(), plan.to_vec());
    let limit = mode.get("limit");
    let limit = (!limit.is_undefined()).then(|| to_number(&limit) as usize);
    let break_at = mode.get("breakAt");
    let break_at = (!break_at.is_undefined()).then(|| to_number(&break_at) as usize);
    let block_ms = mode.get("blockMs");
    let block_ms = (!block_ms.is_undefined()).then(|| to_number(&block_ms) as u64);
    let watch = mode.get("watch");
    let watch = (!watch.is_undefined()).then(|| text(&watch));
    let total = to_number(&mode.get("total"));
    async_fn::<W, W>(async move {
        let Some(stdout) = child.stdout().filter(|_| iterate) else {
            return Ok(Resolution::Value(W::Undefined));
        };
        let body: Result<(), W> = async {
            let chunks = agen::for_await(&stdout);
            let mut index = 0usize;
            while let Some(chunk) = chunks.next().await? {
                case.event("stdout", "data", None);
                if let W::Bytes(bytes) = &chunk {
                    case.out.borrow_mut().extend_from_slice(bytes);
                }
                if let Some(watch) = &watch
                    && case.ahead.get().is_none()
                    && exists(watch)
                {
                    case.ahead.set(Some(total - case.out.borrow().len() as f64));
                }
                if let Some(ms) = block_ms {
                    // A consumer slower than its child: the loop is busy.
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                }
                if limit.is_some_and(|limit| case.out.borrow().len() > limit) {
                    let mut error = JsError::new("Error", "too large");
                    error.set_field("code", W::string("change_record_too_large"));
                    return Err(chunks.close_throw(W::Error(Rc::new(error))).await);
                }
                // gitTokens' consumer leaving at a yield: straight to its finally.
                if break_at == Some(index) {
                    case.event("loop", "break", None);
                    chunks.close().await?;
                    return Ok(());
                }
                index += 1;
            }
            case.event("loop", "done", None);
            match &writing {
                Some(writing) => writing.clone().await?,
                None => js::value::<W, W>(W::Null).await?,
            };
            done.clone().await?;
            case.event("loop", "resolved", None);
            Ok(())
        }
        .await;
        if let Err(error) = body {
            case.event("loop", "threw", Some(W::string(&code_of(&error))));
        }
        // `finally`
        kills(&case, &child, &plan, "finally");
        let mut waited = vec![Resolution::Promise(done.clone())];
        waited.extend(
            writing
                .iter()
                .map(|writing| Resolution::Promise(writing.clone())),
        );
        Promise::all_settled(waited).await?;
        Ok(Resolution::Value(W::Undefined))
    })
}

fn record_of(case: &Case, child_final: Option<&ChildProcess>) -> W {
    let mut fields: Vec<(&str, W)> = vec![("events", W::Array(case.events.borrow().clone()))];
    if let Some(child) = child_final {
        fields.push((
            "pid",
            W::string(if child.pid().is_some() {
                "number"
            } else {
                "undefined"
            }),
        ));
        let present = |socket: Option<Socket>| if socket.is_some() { "socket" } else { "null" };
        fields.push((
            "stdio",
            W::string(&format!(
                "{},{},{}",
                present(child.stdin()),
                present(child.stdout()),
                present(child.stderr())
            )),
        ));
        if let Some(ahead) = case.ahead.get() {
            fields.push(("ahead", W::Number(ahead)));
        }
        if let Some(error) = case.writing_error.borrow().clone() {
            fields.push(("writingError", error));
        }
        if let Some(error) = case.error.borrow().clone() {
            fields.push(("error", error));
        }
        if let Some(writing) = case.writing.borrow().clone() {
            fields.push(("writing", W::string(&writing)));
        }
        if let Some(inheritable) = case.inheritable.borrow().as_deref() {
            fields.push(("inheritable", numbers(inheritable)));
            fields.push(("startedWith", numbers(&case.started_with)));
        }
        let out = case.out.borrow();
        let mut shown: Vec<(&str, W)> = vec![
            ("length", W::Number(out.len() as f64)),
            ("fnv", W::Number(f64::from(fnv(&out)))),
        ];
        if out.len() <= 200 {
            shown.push((
                "text",
                W::String(JsStr::from(
                    out.iter()
                        .map(|byte| char::from(*byte))
                        .collect::<String>()
                        .as_str(),
                )),
            ));
        }
        fields.push(("out", W::object(shown)));
        fields.push(("err", W::string(&case.err.borrow())));
        let signal = child.signal_code();
        fields.push((
            "final",
            W::object(vec![
                ("exitCode", child.exit_code().map_or(W::Null, W::Number)),
                (
                    "signalCode",
                    signal.map_or(W::Null, |name| W::string(&name)),
                ),
                ("killed", W::Bool(child.killed())),
            ]),
        ));
        fields.push((
            "pidNumber",
            child.pid().map_or(W::Null, |pid| W::Number(f64::from(pid))),
        ));
    }
    W::object(fields)
}

/// `ledger-native-probe child-cases`: one request per line (`{case}` or
/// `{op: 'census'}`), one answer line each.
pub fn serve_cases(
    lines: impl Iterator<Item = Vec<u8>>,
    mut out: impl FnMut(&W),
    decode: impl Fn(&[u8]) -> Option<W>,
) {
    let event_loop = EventLoop::new(
        Box::new(RealClock::new()),
        Box::new(|_| None),
        Box::new(|| {}),
    );
    host::install(event_loop.clone());
    // On macOS one descriptor without close-on-exec stays open the whole
    // run: `POSIX_SPAWN_CLOEXEC_DEFAULT` must keep it from every child (the
    // case that lists a child's descriptors sees it otherwise). Linux has no
    // such flag: there every descriptor is close-on-exec.
    #[cfg(target_os = "macos")]
    let _inheritable = {
        // port: sync call (fs.openSync)
        let file = std::fs::File::open("/dev/null").expect("/dev/null");
        // port: sync call (a descriptor left inheritable)
        ledger_io::fs::sys::set_close_on_exec(std::os::fd::AsRawFd::as_raw_fd(&file), false)
            .expect("F_SETFD");
        file
    };
    // What this process was started with (and, on macOS, the descriptor
    // above): a descriptor case requires the same right before its spawn,
    // so nothing of the port's own is ever inheritable.
    // port: sync call (the arm's own descriptors)
    let started_with = ledger_io::fs::sys::inheritable_descriptors();
    for line in lines {
        let Some(request) = decode(&line) else {
            out(&W::object(vec![("corrupt", W::Bool(true))]));
            continue;
        };
        if text(&request.get("op")) == "census" {
            out(&W::object(vec![
                ("fds", W::Number(nfs::open_descriptor_count() as f64)),
                ("pid", W::Number(f64::from(std::process::id()))),
                ("children", W::Number(child::live_children() as f64)),
                ("threads", W::Number(net::live_threads() as f64)),
                ("sources", W::Number(event_loop.sources_open() as f64)),
            ]));
            continue;
        }
        let case = Rc::new(Case {
            events: RefCell::new(Vec::new()),
            out: RefCell::new(Vec::new()),
            err: RefCell::new(String::new()),
            error: RefCell::new(None),
            writing: RefCell::new(None),
            writing_error: RefCell::new(None),
            ahead: Cell::new(None),
            started_with: started_with.clone(),
            inheritable: RefCell::new(None),
        });
        let c = request.get("case");
        let reap = c.get("reap");
        let watching = !c.get("stdout").get("watch").is_undefined();
        let started: Rc<RefCell<Option<(Finished, ChildProcess)>>> = Rc::default();
        {
            let (started, case) = (started.clone(), case.clone());
            run_unit(&event_loop, move || {
                *started.borrow_mut() = start_case(&c, &case);
            });
        }
        let entry = started.borrow_mut().take();
        let Some((finished, child_final)) = entry else {
            out(&case.error.borrow().clone().unwrap_or(W::Null));
            continue;
        };
        let outcome = drive(&event_loop, &|| finished(), 30_000);
        if !reap.is_undefined() {
            reap_grandchild(&text(&reap));
        }
        match outcome {
            Ok(()) => {
                if watching && case.ahead.get().is_none() {
                    case.ahead.set(Some(0.0));
                }
                out(&record_of(&case, Some(&child_final)));
            }
            Err(why) => {
                // Its own child, stuck: killed, so nothing of the case outlives it.
                let _ = child_final.kill(Signal::Kill);
                let _ = drive(&event_loop, &|| finished(), 5_000);
                out(&W::object(vec![(
                    "timeout",
                    W::string(&format!(
                        "{why}: {}",
                        text(&W::Array(case.events.borrow().clone()))
                    )),
                )]));
            }
        }
    }
}

/// One unit on the loop: `f`, then the checkpoint.
fn run_unit(event_loop: &EventLoop, f: impl FnOnce()) {
    f();
    event_loop.checkpoint();
}

/// Runs the real-clock loop until `done` (and every source and pool job
/// has answered), within `deadline_ms`.
fn drive(event_loop: &EventLoop, done: &dyn Fn() -> bool, deadline_ms: u64) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(deadline_ms);
    loop {
        event_loop.checkpoint();
        if done() && event_loop.blocking_pending() == 0 {
            return Ok(());
        }
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "the case did not finish within {} s ({} sources and pool jobs open)",
                deadline_ms / 1000,
                event_loop.blocking_pending()
            ));
        }
        event_loop.timers_phase();
        event_loop.check_phase();
        let wait = event_loop.poll_timeout().map_or(20, |ms| ms.min(20));
        event_loop.poll_phase(Some(wait), &mut |_| {});
    }
}

// --- Programs ----------------------------------------------------------

/// The programs' `AsyncLocalStorage`, which tags every entry with its frame.
static FRAME: Store<String> = Store::new();

struct Run {
    dir: String,
    trace: RefCell<Vec<String>>,
    fns: Vec<W>,
}

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

/// A file call of a program: its result text, or `!<code>`.
fn start_io(run: &Rc<Run>, op: &str, target: &str, label: &str) -> Promise<String, W> {
    let path = format!("{}/{target}", run.dir);
    let shown = |promise: Promise<String, W>| {
        promise.then(
            |value| Ok(Resolution::Value(value)),
            |reason| Ok(Resolution::Value(format!("!{}", code_of(&reason)))),
        )
    };
    match op {
        "lstat" => shown(nfs::lstat(&path, false).then_ok(|stats| {
            let kind = if stats.is_file() {
                format!("f:{}", number_to_string(stats.size()))
            } else if stats.is_directory() {
                String::from("d")
            } else {
                String::from("o")
            };
            Ok(Resolution::Value(kind))
        })),
        "readFile" => shown(
            nfs::read_file(&path).then_ok(|bytes| Ok(Resolution::Value(bytes.len().to_string()))),
        ),
        "readdir" => {
            shown(nfs::readdir(&path).then_ok(|names| Ok(Resolution::Value(names.join(",")))))
        }
        "writeFile" => {
            let file = format!("{}/w/{label}", run.dir);
            shown(
                nfs::write_file(
                    &file,
                    &nfs::Data::Text(JsStr::from(label)),
                    nfs::WriteOptions::WRITE,
                )
                .then_ok(|()| Ok(Resolution::Value(String::from("ok")))),
            )
        }
        other => panic!("a child program file op not known: {other}"),
    }
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
            for _ in 1..(to_number(&statement.get("n")) as usize).max(1) {
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
            let _ = host::set_timeout(to_number(&statement.get("ms")), move || {
                exec(&run, &ctx, &body)
            });
        }
        "run" => {
            let value = text(&statement.get("v"));
            FRAME.run(value, || exec(run, ctx, &body));
        }
        "call" => {
            let _ = call_fn(run, ctx, to_number(&statement.get("f")) as usize);
        }
        "io" => {
            log(run, ctx, &format!("{label}>"));
            let started = start_io(
                run,
                &text(&statement.get("op")),
                &text(&statement.get("a")),
                &label,
            );
            let run = run.clone();
            let _ = started.then_ok(move |result| {
                let ctx = Ctx::io(&label);
                log(&run, &ctx, &format!("{label}={result}"));
                exec(&run, &ctx, &body);
                Ok(Resolution::Value(W::Undefined))
            });
        }
        "spawn" => spawn_statement(run, ctx, statement),
        other => panic!("a child program statement not known: {other}"),
    }
}

fn spawn_options(statement: &W) -> Spawn {
    Spawn {
        file: text(&statement.get("file")),
        args: strings(&statement.get("args")),
        cwd: None,
        env: env_of(&statement.get("env")),
        stdio: [Stdio::Pipe, Stdio::Pipe, Stdio::Pipe],
    }
}

fn on_child(child: &ChildProcess, event: &str, call: impl Fn(&W) + 'static) {
    child.on(
        event,
        &Listener::new(move |value: &W| {
            call(value);
            Ok(())
        }),
    );
}

/// `spawn` with listeners on every event of every source, each event its
/// own strand (`<l>.spawn`, `<l>.exit`, `<l>.close`, `<l>.<fd>`, …).
fn spawn_statement(run: &Rc<Run>, ctx: &Ctx, statement: &W) {
    let label = text(&statement.get("l"));
    log(run, ctx, &format!("{label}>"));
    let child = child::spawn(spawn_options(statement)).expect("a program's spawn does not throw");
    let strand = {
        let label = label.clone();
        move |name: &str| Ctx::io(&format!("{label}.{name}"))
    };
    let kill_at = text(&statement.get("kill"));
    let kill_here = {
        let (run, child, label, kill_at) =
            (run.clone(), child.clone(), label.clone(), kill_at.clone());
        Rc::new(move |at: &str, inner: &Ctx| {
            if kill_at == at {
                let result = child.kill(Signal::Kill).expect("kill");
                log(&run, inner, &format!("{label}.kill={result}"));
            }
        })
    };
    {
        let (run, label, inner) = (run.clone(), label.clone(), strand("spawn"));
        on_child(&child, "spawn", move |_| {
            log(&run, &inner, &format!("{label}.spawn"))
        });
    }
    {
        let (run, label, inner) = (run.clone(), label.clone(), strand("error"));
        on_child(&child, "error", move |error| {
            log(&run, &inner, &format!("{label}.error={}", code_of(error)))
        });
    }
    {
        let (run, label, inner, me, kill_here) = (
            run.clone(),
            label.clone(),
            strand("exit"),
            child.clone(),
            kill_here.clone(),
        );
        let body = list(&statement.get("onExit"));
        on_child(&child, "exit", move |value| {
            let destroyed = me.stdin().is_some_and(|stdin| stdin.destroyed());
            log(
                &run,
                &inner,
                &format!("{label}.exit={},{destroyed}", status(value)),
            );
            kill_here("exit", &inner);
            exec(&run, &inner, &body);
        });
    }
    {
        let (run, label, inner, kill_here) = (
            run.clone(),
            label.clone(),
            strand("close"),
            kill_here.clone(),
        );
        let body = list(&statement.get("onClose"));
        on_child(&child, "close", move |value| {
            log(&run, &inner, &format!("{label}.close={}", status(value)));
            kill_here("close", &inner);
            exec(&run, &inner, &body);
        });
    }
    let consume = text(&statement.get("consume"));
    for (at, socket) in [
        (0usize, child.stdin()),
        (1, child.stdout()),
        (2, child.stderr()),
    ] {
        let Some(socket) = socket else { continue };
        let inner = strand(&at.to_string());
        if at > 0 && consume == "data" {
            let (run, label, inner, kill_here) =
                (run.clone(), label.clone(), inner.clone(), kill_here.clone());
            let first = Cell::new(true);
            listen(&socket, "data", move |_| {
                log(&run, &inner, &format!("{label}.{at}.d"));
                if at == 1 && first.replace(false) {
                    kill_here("data", &inner);
                }
            });
        }
        if at > 0 {
            // The end listener's body is a strand of its own: the stream's
            // later events (finish, close) are other units, arrival's.
            let (run, label, inner, body_ctx) =
                (run.clone(), label.clone(), inner.clone(), strand("end"));
            let body = if at == 1 {
                list(&statement.get("onEnd"))
            } else {
                Vec::new()
            };
            listen(&socket, "end", move |_| {
                log(&run, &inner, &format!("{label}.{at}.end"));
                exec(&run, &body_ctx, &body);
            });
        }
        {
            let (run, label, inner) = (run.clone(), label.clone(), inner.clone());
            listen(&socket, "finish", move |_| {
                log(&run, &inner, &format!("{label}.{at}.finish"))
            });
        }
        {
            let (run, label, inner) = (run.clone(), label.clone(), inner.clone());
            listen(&socket, "error", move |error| {
                log(
                    &run,
                    &inner,
                    &format!("{label}.{at}.error={}", code_of(error)),
                )
            });
        }
        {
            let (run, label, inner) = (run.clone(), label.clone(), inner.clone());
            listen(&socket, "close", move |had_error| {
                let shown = matches!(had_error, W::Bool(true));
                log(&run, &inner, &format!("{label}.{at}.close={shown}"));
            });
        }
    }
    feed(run, ctx, &child, statement, &label);
    kill_here("spawn", ctx);
}

/// The statement's stdin: left open, ended, written (its callback a
/// strand), or a pipeline (its settlement a strand).
fn feed(run: &Rc<Run>, ctx: &Ctx, child: &ChildProcess, statement: &W, label: &str) {
    let Some(stdin) = child.stdin() else { return };
    let input = statement.get("input");
    if text(&input) == "end" {
        stdin.end();
        return;
    }
    if let W::String(chunk) = input.get("write") {
        let (called, label_cb, inner) = (
            run.clone(),
            label.to_owned(),
            Ctx::io(&format!("{label}.wcb")),
        );
        let returned = stdin.write(
            chunk.to_string_lossy().as_bytes(),
            Some(Box::new(move |error: Option<W>| {
                let shown = error.map_or_else(|| String::from("ok"), |error| code_of(&error));
                log(&called, &inner, &format!("{label_cb}.wcb={shown}"));
            })),
        );
        log(run, ctx, &format!("{label}.wrote={returned}"));
        stdin.end();
        return;
    }
    let Some(source) = input_of(&input, None) else {
        return;
    };
    let (run_ok, run_err) = (run.clone(), run.clone());
    let (label_ok, label_err) = (label.to_owned(), label.to_owned());
    let inner = Ctx::io(&format!("{label}.w"));
    let inner_err = inner.clone();
    let _ = net::pipeline(source, &stdin).then(
        move |()| {
            log(&run_ok, &inner, &format!("{label_ok}.w=ok"));
            Ok(Resolution::Value(()))
        },
        move |error| {
            log(
                &run_err,
                &inner_err,
                &format!("{label_err}.w=!{}", code_of(&error)),
            );
            Ok(Resolution::Value(()))
        },
    );
}

/// `git(cwd, args, options)` of `session-changes-git.js`, in the statement's
/// shape: spawn, `pipeline` into stdin, `for await` over stdout, `await
/// writing`, `await done`, a `finally` that kills and waits for both.
fn git(run: &Rc<Run>, ctx: &Ctx, statement: &W) -> Promise<Ctx, W> {
    let label = text(&statement.get("l"));
    log(run, ctx, &format!("{label}>"));
    let child = child::spawn(spawn_options(statement)).expect("a program's spawn does not throw");
    if let Some(stderr) = child.stderr() {
        listen(&stderr, "data", |_| {});
    }
    let (done, resolve) = Promise::<W, W>::with_resolvers();
    {
        let reject = resolve.clone();
        on_child(&child, "error", move |error| reject.reject(error.clone()));
        on_child(&child, "close", move |value| {
            if let W::Array(items) = value
                && matches!(items.first(), Some(W::Number(code)) if *code == 0.0)
            {
                resolve.fulfill(W::Undefined);
                return;
            }
            let mut error = JsError::new("Error", "failed");
            let shown = match value {
                W::Array(items) => match (items.first(), items.get(1)) {
                    (Some(W::Number(code)), _) => number_to_string(*code),
                    (_, Some(signal)) => text(signal),
                    _ => String::new(),
                },
                _ => String::new(),
            };
            error.set_field("code", W::string(&format!("exit_{shown}")));
            resolve.reject(W::Error(Rc::new(error)));
        });
    }
    done.clone().react(|_| {});
    let stdin = child.stdin().expect("piped stdin");
    let source = input_of(&statement.get("input"), None).unwrap_or(PipeInput::Empty);
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
    writing.clone().react(|_| {});
    let exit = statement.get("exit");
    let exit_at = (!exit.is_undefined())
        .then(|| (to_number(&exit.get("at")) as usize, text(&exit.get("kind"))));
    let (run, inner) = (run.clone(), Ctx::io(&label));
    async_fn(async move {
        let stdout = child.stdout().expect("piped stdout");
        let mut early = false;
        let body: Result<(), W> = async {
            let chunks = agen::for_await(&stdout);
            let mut index = 0usize;
            while let Some(chunk) = chunks.next().await? {
                log(&run, &inner, &format!("{label}.c"));
                let non_empty = matches!(&chunk, W::Bytes(bytes) if !bytes.is_empty());
                if let Some((at, kind)) = &exit_at
                    && non_empty
                    && *at == index
                {
                    early = true;
                    // gitTokens' consumer leaving at a yield: straight to its finally.
                    if kind == "break" {
                        log(&run, &inner, &format!("{label}.broke"));
                        chunks.close().await?;
                        return Ok(());
                    }
                    let mut error = JsError::new("Error", "thrown");
                    error.set_field("code", W::string(&format!("X{label}")));
                    return Err(chunks.close_throw(W::Error(Rc::new(error))).await);
                }
                index += 1;
            }
            log(&run, &inner, &format!("{label}.done"));
            writing.clone().await?;
            log(&run, &inner, &format!("{label}.writing=ok"));
            done.clone().await?;
            log(&run, &inner, &format!("{label}.resolved"));
            Ok(())
        }
        .await;
        if let Err(error) = &body {
            log(&run, &inner, &format!("{label}.caught={}", code_of(error)));
        }
        // `finally`
        let killed = child.kill(Signal::Kill).expect("kill");
        if !early {
            log(&run, &inner, &format!("{label}.kill={killed}"));
        }
        Promise::all_settled(vec![
            Resolution::Promise(done.clone()),
            Resolution::Promise(writing.clone()),
        ])
        .await?;
        log(&run, &inner, &format!("{label}.end"));
        Ok(Resolution::Value(inner))
    })
}

/// The ported `git()` or `gitTokens()` (`crate::git`, plan package L3b),
/// in a cancellable execution context, as the JavaScript arm calls the
/// product's own.
fn ported_git(run: &Rc<Run>, ctx: &Ctx, statement: &W) -> Promise<Ctx, W> {
    let label = text(&statement.get("l"));
    log(run, ctx, &format!("{label}>"));
    let controller = Controller::new();
    let aborted = text(&statement.get("abort")) == "before";
    if aborted {
        let mut error = JsError::new("Error", "aborted");
        error.set_field("code", W::string("call_aborted"));
        controller.abort(W::Error(Rc::new(error)));
    }
    let mut options = crate::git::GitOptions {
        env: env_of(&statement.get("env"))
            .into_iter()
            .map(|(key, value)| (key, Some(value)))
            .collect(),
        ..crate::git::GitOptions::default()
    };
    if let W::String(input) = statement.get("input") {
        options.input = crate::git::Input::Text(input);
    }
    let delimiter = statement.get("delimiter");
    if !delimiter.is_undefined() {
        options.delimiter = Some(to_number(&delimiter) as u8);
    }
    let tokens = text(&statement.get("kind")) == "tokens";
    let break_at = statement.get("breakAt");
    let break_at = (!break_at.is_undefined()).then(|| to_number(&break_at) as usize);
    let (dir, args) = (run.dir.clone(), strings(&statement.get("args")));
    let action: crate::ctx::Action = Box::new(move |execution| {
        if !tokens {
            return Ok(Resolution::Promise(crate::git::git(
                &execution, &dir, &args, &options,
            )));
        }
        let source = crate::git::git_tokens(&execution, &dir, &args, &options);
        Ok(Resolution::Promise(async_fn(async move {
            let mut out = Vec::new();
            let rows = agen::for_await(source);
            while let Some(token) = rows.next().await? {
                out.push(token);
                if break_at.is_some_and(|at| out.len() >= at) {
                    rows.close().await?;
                    break;
                }
            }
            Ok(Resolution::Value(W::Array(out)))
        })))
    });
    let settled = run_in_remote_execution_context(
        &W::object(vec![("cancellable", W::Bool(true))]),
        action,
        Remote {
            signal: Some(controller.signal()),
            on_report: None,
            on_progress: None,
            progress_ms: 250.0,
        },
    );
    let (run, start) = (run.clone(), ctx.clone());
    async_fn(async move {
        let outcome = settled.await?;
        let inner = if aborted { start } else { Ctx::io(&label) };
        let shown = if outcome.failed {
            format!("!{}", code_of(&outcome.value))
        } else {
            match &outcome.value {
                W::Array(items) => format!("ok:{}", items.len()),
                W::Bytes(bytes) => format!("ok:{}", bytes.len()),
                _ => String::from("ok:?"),
            }
        };
        log(&run, &inner, &format!("{label}={shown}"));
        Ok(Resolution::Value(inner))
    })
}

/// The ported `commitTreeChanges` (`crate::store`, plan package L3b) with
/// no I/O, as the JavaScript arm runs the product's: objects in memory,
/// `writeObject` a settled promise of the id, `readTree` the async arrow
/// of `commitDirect` over a settled read (the store's own `read_tree`
/// shape); each commit's tree the next one's base.
fn ported_trees(run: &Rc<Run>, ctx: &Ctx, statement: &W) -> Promise<Ctx, W> {
    use crate::store::{Staged, TreeIo, commit_tree_changes};
    let label = text(&statement.get("l"));
    log(run, ctx, &format!("{label}>"));
    type Objects = std::collections::HashMap<String, (String, Rc<Vec<u8>>)>;
    let objects: Rc<RefCell<Objects>> = Rc::default();
    let written = objects.clone();
    let write_object = Rc::new(move |kind: &str, content: Rc<Vec<u8>>| -> crate::WPromise {
        let oid = crate::node::odb::object_id(kind, &content, 40);
        written
            .borrow_mut()
            .insert(oid.clone(), (kind.to_owned(), content));
        js::value(W::string(&oid))
    });
    // `readObject`: `Promise.resolve(objects.get(oid) ?? null)`.
    let read_tree = crate::store::tree_reader(Rc::new(move |name: &W| -> crate::Ret {
        let found = objects
            .borrow()
            .get(&to_js_string(name).to_string_lossy())
            .cloned();
        Ok(Resolution::Promise(js::value(match found {
            Some((kind, data)) => {
                W::object(vec![("type", W::string(&kind)), ("data", W::Bytes(data))])
            }
            None => W::Null,
        })))
    }));
    let io = TreeIo {
        oid_length: 40,
        read_tree,
        write_object,
    };
    let commits: Vec<Vec<(JsStr, Staged)>> = list(&statement.get("commits"))
        .iter()
        .map(|changes| {
            list(changes)
                .iter()
                .map(|pair| {
                    let pair = list(pair);
                    let key = pair.first().map(to_js_string).unwrap_or_default();
                    let value = match pair.get(1) {
                        Some(W::String(data)) => Staged::Data(data.clone()),
                        _ => Staged::Null,
                    };
                    (key, value)
                })
                .collect()
        })
        .collect();
    let (run, ctx) = (run.clone(), ctx.clone());
    async_fn(async move {
        let mut tree: Option<JsStr> = None;
        let outcome: Result<(), W> = async {
            for changes in commits {
                let next = commit_tree_changes(io.clone(), tree.clone(), changes).await?;
                tree = Some(to_js_string(&next));
            }
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => log(
                &run,
                &ctx,
                &format!(
                    "{label}={}",
                    tree.map(|tree| tree.to_string_lossy()).unwrap_or_default()
                ),
            ),
            Err(error) => log(
                &run,
                &ctx,
                &format!(
                    "{label}=!{}:{}",
                    code_of(&error),
                    number_to_string(to_number(&error.get("status")))
                ),
            ),
        }
        Ok(Resolution::Value(ctx))
    })
}

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
                    host::sleep::<W>(to_number(&statement.get("ms"))).await?;
                }
                "awaitIo" => {
                    log(&run, &ctx, &format!("{label}>"));
                    let result = start_io(
                        &run,
                        &text(&statement.get("op")),
                        &text(&statement.get("a")),
                        &label,
                    )
                    .await?;
                    ctx = Ctx::io(&label);
                    log(&run, &ctx, &format!("{label}={result}"));
                }
                "git" => {
                    ctx = git(&run, &ctx, &statement).await?;
                }
                "pgit" => {
                    ctx = ported_git(&run, &ctx, &statement).await?;
                }
                "ptrees" => {
                    ctx = ported_trees(&run, &ctx, &statement).await?;
                }
                _ => exec(&run, &ctx, std::slice::from_ref(&statement)),
            }
        }
        Ok(Resolution::Value(W::Undefined))
    })
}

/// Runs one program in `dir` on a fresh virtual loop, as the JavaScript arm
/// runs it: the main body as a unit, then iterations: immediates first;
/// while a child, a socket, a pipeline or a file call is open and no
/// immediate is queued, the poll phase waits for it (the clock does not
/// move); otherwise the clock moves to the next timer, up to `until`.
pub fn run_program(program: &W, dir: &str) -> Result<String, String> {
    let virtual_host = VirtualHost::new(1000);
    let run = Rc::new(Run {
        dir: dir.to_owned(),
        trace: RefCell::new(Vec::new()),
        fns: list(&program.get("fns")),
    });
    {
        let run = run.clone();
        js::on_unhandled_rejection(Rc::new(move |_| {
            run.trace.borrow_mut().push(String::from("U"));
        }));
    }
    let until = 1000 + {
        let given = to_number(&program.get("until"));
        if given.is_nan() { 50 } else { given as i64 }
    };
    let main = list(&program.get("main"));
    {
        let run = run.clone();
        virtual_host.deliver(move || exec(&run, &Ctx::default(), &main));
    }
    let event_loop = virtual_host.event_loop().clone();
    event_loop.timers_phase();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    for _ in 0..1_000_000 {
        if event_loop.has_immediates() {
            event_loop.check_phase();
            event_loop.timers_phase();
            continue;
        }
        if event_loop.blocking_pending() > 0 {
            if std::time::Instant::now() > deadline {
                return Err(format!(
                    "{} children, sockets or calls of the program did not finish within 20 s",
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
    // A grandchild the program started (its pid in gc.pid): its own, killed
    // now it is over.
    reap_grandchild(&format!("{dir}/gc.pid"));
    let trace = run.trace.borrow().join(" ");
    Ok(trace)
}

/// `ledger-native-probe child-emfile-uncaught` (under `ulimit -n 256`): a
/// piped spawn at the descriptor limit with no `error` listener. The `error`
/// it emits on a tick has no listener, which ends the process, as the
/// worker dies of the uncaught `EMFILE` (F2 of the O2e review).
pub fn emfile_uncaught() {
    let event_loop = EventLoop::new(
        Box::new(RealClock::new()),
        Box::new(|_| None),
        Box::new(|| {}),
    );
    host::install(event_loop.clone());
    let held = hold_descriptors(1);
    let mut options = Spawn {
        file: String::from("sh"),
        args: vec![String::from("-c"), String::from("exit 0")],
        cwd: None,
        env: Vec::new(),
        stdio: [Stdio::Pipe, Stdio::Pipe, Stdio::Pipe],
    };
    options.env = env_of(&W::Array(vec![W::Array(vec![
        W::string("PATH"),
        W::string(&std::env::var("PATH").unwrap_or_default()),
    ])]));
    let child = child::spawn(options).expect("EMFILE is a run-time error");
    drop(held);
    run_unit(&event_loop, || {});
    let _ = drive(&event_loop, &|| false, 500);
    drop(child);
    println!("survived");
}
