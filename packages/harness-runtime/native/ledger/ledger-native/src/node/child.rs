//! `child_process.spawn(file, args, { cwd, env, stdio })` as the ledger's
//! worker calls it (design file 32, package O2e, in the reduced form of file
//! 33): Node 24.22's `ChildProcess` (`lib/internal/child_process.js`) ported
//! by identity: `spawn` (its run-time errors on a tick, the others thrown),
//! `onexit`, `maybeClose`, `flushStdio`, `kill`, the `spawn` event on a
//! tick; the stdio sockets are [`super::net`]'s.
//!
//! The process, by threads: an exit waiter blocks in
//! `waitid(P_PID, pid, WEXITED | WNOWAIT)`, which sees the exit **without
//! reaping**, and posts one unit; only the loop thread reaps
//! (`waitpid(pid, WNOHANG)`), inside that unit, right before `onexit`. Until
//! then the pid is the child or its zombie, so a `kill` from the loop (an
//! abort listener, a timer, a `finally`) cannot reach another process;
//! after the reap the handle is gone and `kill` is Node's no-op (`false`).
//! There is no API that signals a pid or reaps elsewhere.
//!
//! The events, in Node's order per source: `spawn` (on a tick of the
//! checkpoint that spawned) or `error` (a run-time spawn error, on a tick
//! too); `exit` (a unit: the waiter's); `close` at the last of the exit and
//! every piped output's `close` (`maybeClose`). On a run-time spawn error
//! the piped outputs are still sockets, whose peers are closed: they read
//! their end, and `close` waits for them, as in Node.
//!
//! Built: `stdio` `'pipe'` and `'ignore'` per stream; `kill(signal)` with
//! the signals Node names; `pid`, `exitCode`, `signalCode`, `killed`. Not
//! built (no site uses them): `shell`, `detached`, `uid`/`gid`, `timeout`,
//! `killSignal`, `signal`, `windowsHide` and the other Windows options,
//! `serialization` and IPC, `'inherit'` and stream or descriptor stdio,
//! `ref`/`unref` (the process does not exit when its loop is idle),
//! `exec`, `execFile` and the sync forms.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ledger_core::js::JsStr;
use ledger_io::fs::sys;
use ledger_io::process as lprocess;

use super::net::{self, Socket};
use crate::emitter::{Emitter, Listener};
use crate::js;
use crate::value::W;

/// What one stdio stream of the child is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stdio {
    /// `'pipe'`: a socket pair, the parent's end a [`Socket`].
    Pipe,
    /// `'ignore'`: `/dev/null`.
    Ignore,
}

/// `spawn(file, args, { cwd, env, stdio })`: `env` in the object's key
/// order (an `undefined` value left out by the caller, as Node leaves it
/// out of `envPairs`; build it with [`env_pairs`] from the object's
/// entries). An empty `cwd` is no `cwd`, as in Node (the child starts in
/// this process's directory).
pub struct Spawn {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub stdio: [Stdio; 3],
}

/// A signal `kill` sends (the names Node takes; `Zero` is `kill(0)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Kill,
    Term,
    Int,
    Hup,
    Zero,
}

impl Signal {
    fn number(self) -> i32 {
        let name = match self {
            Signal::Kill => "SIGKILL",
            Signal::Term => "SIGTERM",
            Signal::Int => "SIGINT",
            Signal::Hup => "SIGHUP",
            Signal::Zero => return 0,
        };
        lprocess::signal_number(name).expect("a signal every platform has")
    }
}

/// `envPairs` of `normalizeSpawnArguments` from an object built entry by
/// entry (`{...base, KEY: value, ...}`, `Object.fromEntries`): a key given
/// again keeps its first place and takes the last value, the keys come in
/// JavaScript's own order (array-index keys, `0` to `2**32 - 2`, first in
/// ascending order, then the others in insertion order), and a key whose
/// value is `undefined` (`None`) is left out.
pub fn env_pairs(
    entries: impl IntoIterator<Item = (String, Option<String>)>,
) -> Vec<(String, String)> {
    let mut object: Vec<(String, Option<String>)> = Vec::new();
    for (key, value) in entries {
        match object.iter_mut().find(|(known, _)| *known == key) {
            Some(entry) => entry.1 = value,
            None => object.push((key, value)),
        }
    }
    let index = |key: &str| -> Option<u32> {
        let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
        if !canonical || !key.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        key.parse::<u32>().ok().filter(|value| *value != u32::MAX)
    };
    let mut indexed: Vec<(u32, String, Option<String>)> = Vec::new();
    let mut named: Vec<(String, Option<String>)> = Vec::new();
    for (key, value) in object {
        match index(&key) {
            Some(at) => indexed.push((at, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(at, _, _)| *at);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect()
}

/// Children spawned and not yet reaped, for the tests' census.
static LIVE_CHILDREN: AtomicUsize = AtomicUsize::new(0);

/// How many children of this process are spawned and not yet reaped.
pub fn live_children() -> usize {
    LIVE_CHILDREN.load(Ordering::SeqCst)
}

struct Inner {
    emitter: Emitter<W, W>,
    /// `_handle`: the pid while the child is not reaped.
    handle: Cell<Option<i32>>,
    pid: Cell<Option<i32>>,
    exit_code: Cell<Option<f64>>,
    signal_code: RefCell<Option<String>>,
    killed: Cell<bool>,
    closes_needed: Cell<u32>,
    closes_got: Cell<u32>,
    spawnfile: String,
    spawnargs: Vec<String>,
    stdin: RefCell<Option<Socket>>,
    stdout: RefCell<Option<Socket>>,
    stderr: RefCell<Option<Socket>>,
    /// How many `kill(2)` calls this child made (tests: none after the reap).
    signals_sent: Cell<u32>,
}

/// A child process (`ChildProcess`). Clones are the same child.
#[derive(Clone)]
pub struct ChildProcess(Rc<Inner>);

/// What the exit waiter posts.
enum WaitEvent {
    Exited,
    Failed(i32),
    Panicked(String),
}

/// The run-time spawn errors Node emits (on a tick) instead of throwing.
fn is_run_time(errno: i32) -> bool {
    ["EACCES", "EAGAIN", "EMFILE", "ENFILE", "ENOENT"]
        .contains(&ledger_io::fs::error_name(errno).as_str())
}

/// `child_process.spawn(file, args, options)`. A spawn error Node throws
/// (any but `EACCES`, `EAGAIN`, `EMFILE`, `ENFILE`, `ENOENT`) is `Err`, an
/// `ErrnoException(err, 'spawn')`; the others give a child whose `error`
/// comes on a tick.
pub fn spawn(options: Spawn) -> Result<ChildProcess, W> {
    for text in std::iter::once(&options.file)
        .chain(&options.args)
        .chain(options.cwd.iter())
        .chain(options.env.iter().flat_map(|(key, value)| [key, value]))
    {
        assert!(
            !text.contains('\0'),
            "a NUL byte in a spawn argument is not ported (Node's ERR_INVALID_ARG_VALUE)"
        );
    }
    sys_reset_sigchld();
    let mut argv = vec![options.file.clone()];
    argv.extend(options.args.iter().cloned());
    let env: Vec<String> = options
        .env
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect();
    let child = ChildProcess(Rc::new(Inner {
        emitter: Emitter::new(|value: &W| value.clone()),
        handle: Cell::new(None),
        pid: Cell::new(None),
        exit_code: Cell::new(None),
        signal_code: RefCell::new(None),
        killed: Cell::new(false),
        closes_needed: Cell::new(1),
        closes_got: Cell::new(0),
        spawnfile: options.file.clone(),
        spawnargs: argv.clone(),
        stdin: RefCell::new(None),
        stdout: RefCell::new(None),
        stderr: RefCell::new(None),
        signals_sent: Cell::new(0),
    }));
    // An empty `cwd` is none (`ProcessWrap` sets only a non-empty one).
    let cwd = options.cwd.as_deref().filter(|cwd| !cwd.is_empty());
    // uv_spawn: the socket pairs first (an EMFILE here is the spawn's error).
    let mut pairs: [Option<(i32, i32)>; 3] = [None, None, None];
    let mut made_error = None;
    for (at, kind) in options.stdio.iter().enumerate() {
        if *kind != Stdio::Pipe {
            continue;
        }
        match sys::socketpair().and_then(|(parent, child_end)| {
            let lifted = sys::dup_above_stdio(child_end);
            sys::close(child_end);
            Ok((parent, lifted?))
        }) {
            Ok(pair) => pairs[at] = Some(pair),
            Err(errno) => {
                made_error = Some(errno);
                break;
            }
        }
    }
    let watch = pairs[0].map(|_| Arc::new(net::WriterWatch::default()));
    let spawned = match made_error {
        Some(errno) => Err(errno),
        None => lprocess::spawn(&lprocess::Spawn {
            file: &options.file,
            argv: &argv,
            env: &env,
            cwd,
            stdio: [
                pairs[0].map(|(_, end)| end),
                pairs[1].map(|(_, end)| end),
                pairs[2].map(|(_, end)| end),
            ],
        }),
    };
    // The child's ends are the child's now (or nobody's).
    for (_, end) in pairs.iter().flatten() {
        sys::close(*end);
    }
    match spawned {
        Err(errno) if !is_run_time(errno) => {
            for (parent, _) in pairs.iter().flatten() {
                sys::close(*parent);
            }
            return Err(net::errno_exception(errno, "spawn"));
        }
        Err(errno) => {
            let later = child.clone();
            js::next_tick(move || on_exit(&later, f64::from(-errno), None));
            if ["EMFILE", "ENFILE"].contains(&ledger_io::fs::error_name(errno).as_str()) {
                // EMFILE or ENFILE (of a socket pair or of the spawn itself):
                // Node returns before it sets up any stdio.
                for (parent, _) in pairs.iter().flatten() {
                    sys::close(*parent);
                }
                return Ok(child);
            }
        }
        Ok(pid) => {
            LIVE_CHILDREN.fetch_add(1, Ordering::SeqCst);
            child.0.handle.set(Some(pid));
            child.0.pid.set(Some(pid));
            let later = child.clone();
            js::next_tick(move || {
                let _ = later.0.emitter.emit("spawn", &W::Undefined);
            });
            start_waiter(&child, pid, watch.clone());
        }
    }
    for (at, pair) in pairs.iter().enumerate() {
        let Some((parent, _)) = pair else { continue };
        if at == 0 {
            let _ = sys::set_nonblocking(*parent);
        }
        let socket =
            net::create_socket(*parent, at > 0, if at == 0 { watch.clone() } else { None });
        if at > 0 {
            child.0.closes_needed.set(child.0.closes_needed.get() + 1);
            let owner = Rc::downgrade(&child.0);
            socket.on(
                "close",
                &Listener::new(move |_: &W| {
                    if let Some(owner) = owner.upgrade() {
                        maybe_close(&ChildProcess(owner));
                    }
                    Ok(())
                }),
            );
        }
        let slot = match at {
            0 => &child.0.stdin,
            1 => &child.0.stdout,
            _ => &child.0.stderr,
        };
        *slot.borrow_mut() = Some(socket);
    }
    Ok(child)
}

/// `SIGCHLD` at its default, once per process (the design's Q5).
fn sys_reset_sigchld() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(sys::reset_sigchld);
}

/// The exit waiter: `waitid(WNOWAIT)` on its own thread, one unit; the reap
/// and `onexit` run on the loop. With a write to the stdin waiting, the
/// writer's next attempt goes first when its socket is ready
/// ([`net::WriterWatch::before_exit`]).
fn start_waiter(child: &ChildProcess, pid: i32, watch: Option<Arc<net::WriterWatch>>) {
    let slot: Rc<RefCell<Option<super::Source<WaitEvent>>>> = Rc::default();
    let owned = slot.clone();
    let target = child.clone();
    let source = super::source(move |event: WaitEvent| {
        if let Some(source) = owned.borrow_mut().take() {
            source.close();
        }
        match event {
            WaitEvent::Panicked(message) => panic!("a child's exit waiter panicked: {message}"),
            WaitEvent::Failed(errno) => panic!(
                "waitid for child {pid} failed ({}): a reap outside the loop thread",
                ledger_io::fs::error_name(errno)
            ),
            WaitEvent::Exited => {}
        }
        let reaped = match sys::reap(pid) {
            Ok(Some(status)) => status,
            other => panic!("child {pid} had exited but was not reaped here: {other:?}"),
        };
        LIVE_CHILDREN.fetch_sub(1, Ordering::SeqCst);
        let (exit_status, term_signal) = reaped;
        // `signo_string`: a signal Node does not name is "", which `onexit`
        // takes for none, so the child reports `exitCode` (0, libuv's
        // `exit_status` of a signalled child) and no `signalCode`.
        let signal = lprocess::signal_name(term_signal).map(str::to_owned);
        on_exit(&target, f64::from(exit_status), signal);
    });
    let poster = source.poster();
    let on_panic = poster.clone();
    *slot.borrow_mut() = Some(source);
    net::helper_thread(
        "child-waiter",
        move || match sys::wait_exited(pid) {
            Ok(()) => match &watch {
                Some(watch) => watch.before_exit(|| poster.post(WaitEvent::Exited)),
                None => poster.post(WaitEvent::Exited),
            },
            Err(errno) => poster.post(WaitEvent::Failed(errno)),
        },
        move |message| on_panic.post(WaitEvent::Panicked(message)),
    );
}

/// `this._handle.onexit(exitCode, signalCode)`.
fn on_exit(child: &ChildProcess, exit_code: f64, signal_code: Option<String>) {
    let inner = &child.0;
    match signal_code {
        Some(signal) => *inner.signal_code.borrow_mut() = Some(signal),
        None => inner.exit_code.set(Some(exit_code)),
    }
    let stdin = inner.stdin.borrow().clone();
    if let Some(stdin) = stdin {
        stdin.destroy(None);
    }
    inner.handle.set(None);
    if exit_code < 0.0 {
        let errno = (-exit_code) as i32;
        let error = net::errno_exception(errno, &format!("spawn {}", inner.spawnfile));
        let error = with_spawn_fields(error, &inner.spawnfile, &inner.spawnargs[1..]);
        emit(child, "error", &error);
    } else {
        let status = child.status();
        emit(child, "exit", &status);
    }
    let later = child.clone();
    js::next_tick(move || flush_stdio(&later));
    maybe_close(child);
}

/// `err.path = this.spawnfile; err.spawnargs = args.slice(1)`.
fn with_spawn_fields(error: W, file: &str, args: &[String]) -> W {
    let W::Error(made) = error else { return error };
    let mut made = (*made).clone();
    made.set_field("path", W::String(JsStr::from(file)));
    made.set_field(
        "spawnargs",
        W::Array(
            args.iter()
                .map(|arg| W::String(JsStr::from(arg.as_str())))
                .collect(),
        ),
    );
    W::Error(Rc::new(made))
}

/// `this.emit(event, value)`: a throw out of a listener, or an `error` with
/// none, is an uncaught exception in Node (the worker dies); here it ends
/// the process.
fn emit(child: &ChildProcess, event: &str, value: &W) {
    if let Err(error) = child.0.emitter.emit(event, value) {
        let text = match &error {
            W::Error(made) => made.message.to_string_lossy(),
            _ => String::from("a thrown value"),
        };
        panic!(
            "a child process's '{event}' listener threw, or an 'error' nobody listened to: {text}"
        );
    }
}

/// `flushStdio(subprocess)`: an output nobody reads is resumed, so it ends
/// and closes.
fn flush_stdio(child: &ChildProcess) {
    for slot in [&child.0.stdin, &child.0.stdout, &child.0.stderr] {
        let socket = slot.borrow().clone();
        if let Some(socket) = socket
            && socket.readable()
        {
            socket.resume();
        }
    }
}

/// `maybeClose(subprocess)`.
fn maybe_close(child: &ChildProcess) {
    let inner = &child.0;
    inner.closes_got.set(inner.closes_got.get() + 1);
    if inner.closes_got.get() == inner.closes_needed.get() {
        let status = child.status();
        emit(child, "close", &status);
        // Nothing is emitted after `close` (a `kill` then is a no-op): the
        // listeners, which may hold the child (a cycle JavaScript's
        // collector frees), are let go.
        inner.emitter.remove_all_listeners(None);
    }
}

impl ChildProcess {
    /// `child.on(event, listener)`: `'spawn'` (`undefined`), `'error'` (the
    /// error), `'exit'` and `'close'` (`[exitCode, signalCode]`, each a
    /// number or string, else `null`). Listeners run in the frame of the
    /// `spawn` call (a tick's or a unit's, as Node's handle callbacks).
    pub fn on(&self, event: &str, listener: &Listener<W, W>) {
        assert!(
            matches!(event, "spawn" | "error" | "exit" | "close"),
            "a child process event that is not ported: {event}"
        );
        self.0.emitter.on(event, listener);
    }

    /// `child.removeListener(event, listener)`.
    pub fn remove_listener(&self, event: &str, listener: &Listener<W, W>) {
        self.0.emitter.remove_listener(event, listener);
    }

    /// `child.kill(signal)`: `true` when the signal was sent (also to a
    /// child that has exited and is not reaped yet, as in Node); `false`
    /// once it is reaped (no system call then). `EINVAL`/`ENOSYS` throw;
    /// another failure (`EPERM`) is an `error` event.
    pub fn kill(&self, signal: Signal) -> Result<bool, W> {
        let Some(pid) = self.0.handle.get() else {
            return Ok(false);
        };
        self.0.signals_sent.set(self.0.signals_sent.get() + 1);
        match sys::kill(pid, signal.number()) {
            Ok(()) => {
                self.0.killed.set(true);
                Ok(true)
            }
            Err(errno) => match ledger_io::fs::error_name(errno).as_str() {
                "ESRCH" => Ok(false),
                "EINVAL" | "ENOSYS" => Err(net::errno_exception(errno, "kill")),
                _ => {
                    emit(self, "error", &net::errno_exception(errno, "kill"));
                    Ok(false)
                }
            },
        }
    }

    /// `child.pid` (`None` when the spawn failed).
    pub fn pid(&self) -> Option<i32> {
        self.0.pid.get()
    }

    /// `child.exitCode`.
    pub fn exit_code(&self) -> Option<f64> {
        self.0.exit_code.get()
    }

    /// `child.signalCode`.
    pub fn signal_code(&self) -> Option<String> {
        self.0.signal_code.borrow().clone()
    }

    /// `child.killed`.
    pub fn killed(&self) -> bool {
        self.0.killed.get()
    }

    /// `child.stdin` (`None` for `'ignore'`, or after `EMFILE`).
    pub fn stdin(&self) -> Option<Socket> {
        self.0.stdin.borrow().clone()
    }

    /// `child.stdout`.
    pub fn stdout(&self) -> Option<Socket> {
        self.0.stdout.borrow().clone()
    }

    /// `child.stderr`.
    pub fn stderr(&self) -> Option<Socket> {
        self.0.stderr.borrow().clone()
    }

    /// How many `kill(2)` calls this child made (tests).
    pub fn signals_sent(&self) -> u32 {
        self.0.signals_sent.get()
    }

    /// `[exitCode, signalCode]` as `exit` and `close` give them.
    fn status(&self) -> W {
        let code = self.0.exit_code.get().map_or(W::Null, W::Number);
        let signal = self
            .0
            .signal_code
            .borrow()
            .as_ref()
            .map_or(W::Null, |name| W::String(JsStr::from(name.as_str())));
        W::Array(vec![code, signal])
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;
    use crate::agen;
    use crate::host::testing::test_loop;
    use crate::js::{Resolution, async_fn};

    type Log = Rc<RefCell<Vec<String>>>;

    fn env() -> Vec<(String, String)> {
        vec![(
            String::from("PATH"),
            std::env::var("PATH").unwrap_or_default(),
        )]
    }

    fn sh(script: &str) -> Spawn {
        Spawn {
            file: String::from("sh"),
            args: vec![String::from("-c"), script.to_owned()],
            cwd: None,
            env: env(),
            stdio: [Stdio::Pipe, Stdio::Pipe, Stdio::Pipe],
        }
    }

    /// Runs the loop (immediates, then units) until `done`, within 30 s.
    fn drive(event_loop: &crate::host::EventLoop, done: &dyn Fn() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            event_loop.checkpoint();
            if done() {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the child did not finish within 30 s"
            );
            if event_loop.has_immediates() {
                event_loop.check_phase();
            } else {
                event_loop.poll_phase(Some(100), &mut |_| {});
            }
        }
    }

    fn shown(value: &W) -> String {
        match value {
            W::Array(items) => items.iter().map(shown).collect::<Vec<_>>().join(","),
            W::Null => String::from("null"),
            W::Undefined => String::new(),
            W::Bool(flag) => flag.to_string(),
            W::Number(number) => number.to_string(),
            W::String(text) => text.to_string_lossy(),
            W::Error(error) => super::super::code_of(&W::Error(error.clone())),
            W::Bytes(bytes) => String::from_utf8_lossy(bytes).into_owned(),
            _ => String::from("?"),
        }
    }

    fn watch(child: &ChildProcess, log: &Log) {
        for event in ["spawn", "error", "exit", "close"] {
            let log = log.clone();
            child.on(
                event,
                &Listener::new(move |value: &W| {
                    log.borrow_mut().push(format!("{event}:{}", shown(value)));
                    Ok(())
                }),
            );
        }
        for (name, socket) in [
            ("in", child.stdin()),
            ("out", child.stdout()),
            ("err", child.stderr()),
        ] {
            let Some(socket) = socket else { continue };
            for event in ["data", "end", "finish", "error", "close"] {
                if event == "data" && name == "in" {
                    continue;
                }
                let log = log.clone();
                socket.on(
                    event,
                    &Listener::new(move |value: &W| {
                        log.borrow_mut()
                            .push(format!("{name}-{event}:{}", shown(value)));
                        Ok(())
                    }),
                );
            }
        }
    }

    fn of(log: &Log, prefix: &str) -> Vec<String> {
        log.borrow()
            .iter()
            .filter(|entry| entry.starts_with(prefix))
            .cloned()
            .collect()
    }

    #[test]
    fn a_child_s_events_keep_node_s_order_per_source() {
        let (event_loop, _time) = test_loop();
        let log: Log = Rc::default();
        let child = spawn(sh("printf abc; printf de >&2; exit 3")).expect("spawned");
        watch(&child, &log);
        let started = js::checkpoint_epoch();
        event_loop.checkpoint();
        assert_eq!(
            *log.borrow(),
            vec!["spawn:"],
            "spawn comes on a tick of the spawning checkpoint"
        );
        assert_eq!(js::checkpoint_epoch(), started + 1);
        drive(&event_loop, &|| {
            log.borrow().iter().any(|entry| entry.starts_with("close:"))
                && child.stdin().is_some_and(|s| s.handle_closed())
        });
        assert_eq!(
            of(&log, "out-"),
            vec!["out-data:abc", "out-end:", "out-finish:", "out-close:false"]
        );
        assert_eq!(
            of(&log, "err-"),
            vec!["err-data:de", "err-end:", "err-finish:", "err-close:false"]
        );
        assert_eq!(of(&log, "in-"), vec!["in-close:false"]);
        let at = |entry: &str| {
            log.borrow()
                .iter()
                .position(|seen| seen == entry)
                .expect(entry)
        };
        // `close` is emitted inside the last output's `close` (maybeClose is
        // that socket's first listener), so it precedes that socket's own
        // listeners, as in Node; the other output's close precedes it.
        assert!(at("exit:3,null") < at("close:3,null"));
        assert!(at("out-close:false").min(at("err-close:false")) < at("close:3,null"));
    }

    /// Both outputs closed (handles and all) before the child exits: the
    /// child's `close` still waits for the exit, and comes after it.
    #[test]
    fn close_comes_after_the_exit_when_the_outputs_closed_first() {
        let (event_loop, _time) = test_loop();
        let log: Log = Rc::default();
        let child = spawn(sh("exec >&- 2>&-; read line; exit 0")).expect("spawned");
        watch(&child, &log);
        drive(&event_loop, &|| {
            log.borrow().contains(&String::from("out-close:false"))
                && log.borrow().contains(&String::from("err-close:false"))
        });
        assert!(
            !log.borrow().iter().any(|entry| entry.starts_with("close:")),
            "closed before the exit: {:?}",
            log.borrow()
        );
        child.stdin().expect("stdin").end();
        drive(&event_loop, &|| {
            log.borrow().iter().any(|entry| entry.starts_with("close:"))
        });
        let at = |entry: &str| {
            log.borrow()
                .iter()
                .position(|seen| seen == entry)
                .expect(entry)
        };
        assert!(at("exit:0,null") < at("close:0,null"), "{:?}", log.borrow());
    }

    /// The stdin is not counted by maybeClose (`_closesNeeded` counts the
    /// readable stdio only): with both outputs closed before the exit, the
    /// child's `close` comes inside the exit's unit, before the stdin's own
    /// `close`, which the exit's destroy only started.
    #[test]
    fn close_does_not_wait_for_the_stdin_s_close() {
        let (event_loop, _time) = test_loop();
        let log: Log = Rc::default();
        let child = spawn(sh("exec >&- 2>&-; read line; exit 0")).expect("spawned");
        // Whether the stdin's handle had closed when the child's close came
        // (a close emitted from the stdin's own close would see it closed).
        let stdin_closed_at_close: Rc<Cell<Option<bool>>> = Rc::default();
        {
            let (seen, me) = (stdin_closed_at_close.clone(), child.clone());
            child.on(
                "close",
                &Listener::new(move |_: &W| {
                    seen.set(Some(me.stdin().is_some_and(|stdin| stdin.handle_closed())));
                    Ok(())
                }),
            );
        }
        watch(&child, &log);
        drive(&event_loop, &|| {
            log.borrow().contains(&String::from("out-close:false"))
                && log.borrow().contains(&String::from("err-close:false"))
        });
        assert_eq!(child.kill(Signal::Kill).ok(), Some(true));
        drive(&event_loop, &|| {
            child.stdin().is_some_and(|stdin| stdin.handle_closed())
                && log.borrow().iter().any(|entry| entry.starts_with("close:"))
        });
        let at = |entry: &str| {
            log.borrow()
                .iter()
                .position(|seen| seen == entry)
                .expect(entry)
        };
        assert!(
            at("close:null,SIGKILL") < at("in-close:false"),
            "{:?}",
            log.borrow()
        );
        assert_eq!(
            stdin_closed_at_close.get(),
            Some(false),
            "the child's close waited for the stdin's handle to close"
        );
    }

    #[test]
    fn a_missing_program_errors_on_a_tick_and_closes_after_its_outputs() {
        let (event_loop, _time) = test_loop();
        let log: Log = Rc::default();
        let mut options = sh("exit 0");
        options.file = String::from("devryan-o2e-definitely-missing");
        let child = spawn(options).expect("a run-time error is not thrown");
        assert_eq!(child.pid(), None);
        watch(&child, &log);
        event_loop.checkpoint();
        assert_eq!(*log.borrow(), vec!["error:ENOENT"]);
        drive(&event_loop, &|| {
            log.borrow().iter().any(|entry| entry.starts_with("close:"))
        });
        assert_eq!(
            of(&log, "out-"),
            vec!["out-end:", "out-finish:", "out-close:false"]
        );
        let at = |entry: &str| {
            log.borrow()
                .iter()
                .position(|seen| seen == entry)
                .expect(entry)
        };
        assert!(at("error:ENOENT") < at("close:-2,null"));
        assert!(at("out-close:false").min(at("err-close:false")) < at("close:-2,null"));
    }

    #[test]
    fn kill_signals_a_live_child_and_is_a_no_op_once_it_is_reaped() {
        let (event_loop, _time) = test_loop();
        let log: Log = Rc::default();
        let child = spawn(sh("read line")).expect("spawned");
        watch(&child, &log);
        assert_eq!(child.kill(Signal::Kill).ok(), Some(true));
        assert!(child.killed());
        drive(&event_loop, &|| {
            log.borrow().iter().any(|entry| entry.starts_with("close:"))
        });
        assert!(log.borrow().contains(&String::from("exit:null,SIGKILL")));
        let sent = child.signals_sent();
        assert_eq!(child.kill(Signal::Kill).ok(), Some(false));
        assert_eq!(child.signals_sent(), sent, "no kill(2) after the reap");
    }

    #[test]
    fn the_exit_is_seen_without_reaping_until_the_loop_reaps() {
        let (event_loop, _time) = test_loop();
        let log: Log = Rc::default();
        let child = spawn(sh("exit 0")).expect("spawned");
        watch(&child, &log);
        let pid = child.pid().expect("a pid");
        // The waiter has seen the exit (its unit is queued) and the child is
        // still a zombie: its pid cannot be reused yet.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !sys::exited_unreaped(pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "the child did not exit"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(
            sys::exited_unreaped(pid),
            "a waiter reaped the child off the loop thread"
        );
        assert_eq!(
            child.kill(Signal::Zero).ok(),
            Some(true),
            "the zombie is still ours"
        );
        drive(&event_loop, &|| {
            log.borrow().iter().any(|entry| entry.starts_with("exit:"))
        });
        assert!(!sys::exited_unreaped(pid));
        drive(&event_loop, &|| {
            log.borrow().iter().any(|entry| entry.starts_with("close:"))
        });
    }

    /// S1 of the O2e review: while the loop does not take a reader's last
    /// read (it is busy), the reader reads no further, so the child blocks
    /// on a full socket, as under Node, where libuv reads only while the
    /// loop polls. A reader that kept reading would let the child write its
    /// whole megabyte into the inbox and reach its `: > done`.
    #[test]
    fn a_reader_reads_no_further_while_the_loop_has_not_taken_its_last_read() {
        let (event_loop, _time) = test_loop();
        let dir = std::env::temp_dir().join(format!("devryan-o2e-hold-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch");
        let done = dir.join("done");
        let mut options = sh("head -c 1000000 /dev/zero; : > done");
        options.cwd = Some(dir.to_string_lossy().into_owned());
        let child = spawn(options).expect("spawned");
        let taken = Rc::new(Cell::new(0usize));
        {
            let taken = taken.clone();
            child.stdout().expect("stdout").on(
                "data",
                &Listener::new(move |chunk: &W| {
                    if let W::Bytes(bytes) = chunk {
                        taken.set(taken.get() + bytes.len());
                    }
                    Ok(())
                }),
            );
        }
        child
            .stderr()
            .expect("stderr")
            .on("data", &Listener::new(|_: &W| Ok(())));
        // The loop is busy: no unit runs for 300 ms.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let early = done.exists();
        let closed = Rc::new(Cell::new(false));
        {
            let closed = closed.clone();
            child.on(
                "close",
                &Listener::new(move |_: &W| {
                    closed.set(true);
                    Ok(())
                }),
            );
        }
        drive(&event_loop, &|| closed.get());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            !early,
            "the child finished its output while the loop took nothing"
        );
        assert_eq!(taken.get(), 1_000_000);
    }

    /// S2 of the O2e review: each chunk holds only its own bytes (Node gives
    /// each read's backing store `nread` bytes), so what `git()` collects
    /// until `Buffer.concat` is its bytes, not 64 KiB per read. Bound: the
    /// chunks' capacities add up to exactly their lengths, both for many
    /// small reads (a data listener) and for 16 MiB collected by `for await`.
    #[test]
    fn the_chunks_a_reader_delivers_hold_only_their_own_bytes() {
        let (event_loop, _time) = test_loop();
        let small = spawn(sh(
            "i=0; while [ $i -lt 300 ]; do echo line-$i; i=$((i+1)); done",
        ))
        .expect("spawned");
        let kept: Rc<RefCell<Vec<Rc<Vec<u8>>>>> = Rc::default();
        {
            let kept = kept.clone();
            small.stdout().expect("stdout").on(
                "data",
                &Listener::new(move |chunk: &W| {
                    if let W::Bytes(bytes) = chunk {
                        kept.borrow_mut().push(bytes.clone());
                    }
                    Ok(())
                }),
            );
        }
        let big = spawn(sh("head -c 16777216 /dev/zero")).expect("spawned");
        let collected: Rc<RefCell<Vec<Rc<Vec<u8>>>>> = Rc::default();
        let read = {
            let (collected, stdout) = (collected.clone(), big.stdout().expect("stdout"));
            async_fn::<W, W>(async move {
                let chunks = agen::for_await(&stdout);
                while let Some(chunk) = chunks.next().await? {
                    if let W::Bytes(bytes) = chunk {
                        collected.borrow_mut().push(bytes);
                    }
                }
                Ok(Resolution::Value(W::Undefined))
            })
        };
        let closes = Rc::new(Cell::new(0));
        for child in [&small, &big] {
            let closes = closes.clone();
            child.on(
                "close",
                &Listener::new(move |_: &W| {
                    closes.set(closes.get() + 1);
                    Ok(())
                }),
            );
        }
        drive(&event_loop, &|| read.is_settled() && closes.get() == 2);
        for (name, chunks, bytes) in [
            ("many small reads", &kept, 300 * 8),
            ("16 MiB by for await", &collected, 16 << 20),
        ] {
            let chunks = chunks.borrow();
            let length: usize = chunks.iter().map(|chunk| chunk.len()).sum();
            let capacity: usize = chunks.iter().map(|chunk| chunk.capacity()).sum();
            assert!(length >= bytes, "{name}: {length} bytes read");
            assert_eq!(
                capacity,
                length,
                "{name}: {} chunks keep {capacity} bytes for {length}",
                chunks.len()
            );
        }
    }

    #[test]
    fn env_pairs_keep_javascript_s_key_order() {
        let entry = |key: &str, value: Option<&str>| (key.to_owned(), value.map(str::to_owned));
        let pairs = env_pairs([
            entry("ZZ", Some("1")),
            entry("7", Some("seven")),
            entry("GIT_DIR", Some("x")),
            entry("10", Some("ten")),
            entry("01", Some("lead")),
            entry("4294967295", Some("big")),
            entry("4294967294", Some("index")),
            entry("GIT_DIR", None),
            entry("ZZ", Some("2")),
        ]);
        let shown: Vec<String> = pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        assert_eq!(
            shown,
            [
                "7=seven",
                "10=ten",
                "4294967294=index",
                "ZZ=2",
                "01=lead",
                "4294967295=big"
            ]
        );
    }

    #[test]
    fn for_await_reads_stdout_and_ends_at_its_end_and_pipeline_feeds_stdin() {
        let (event_loop, _time) = test_loop();
        let child = spawn(sh("cat; printf done >&2")).expect("spawned");
        let stdin = child.stdin().expect("stdin");
        let writing = net::pipeline(
            net::PipeInput::Bytes(Rc::new(b"hello\n".repeat(30_000))),
            &stdin,
        );
        let out: Rc<RefCell<Vec<u8>>> = Rc::default();
        let read = {
            let (out, stdout) = (out.clone(), child.stdout().expect("stdout"));
            async_fn::<W, W>(async move {
                let chunks = agen::for_await(&stdout);
                while let Some(chunk) = chunks.next().await? {
                    if let W::Bytes(bytes) = chunk {
                        out.borrow_mut().extend_from_slice(&bytes);
                    }
                }
                writing.await?;
                Ok(Resolution::Value(W::Undefined))
            })
        };
        let stderr = child.stderr().expect("stderr");
        stderr.on("data", &Listener::new(|_: &W| Ok(())));
        let closed = Rc::new(Cell::new(false));
        {
            let closed = closed.clone();
            child.on(
                "close",
                &Listener::new(move |_: &W| {
                    closed.set(true);
                    Ok(())
                }),
            );
        }
        drive(&event_loop, &|| read.is_settled() && closed.get());
        assert_eq!(out.borrow().len(), 180_000);
    }
}
