//! The process around the protocol: a reader thread splits stdin into
//! lines (256 MiB at most each) and posts each to the event loop
//! (`host::EventLoop`) as a unit of its own, the loop handles them in order
//! with Node's rules, and a writer thread drains the unbounded queue of
//! outgoing lines to stdout. A watchdog thread ends the process when its
//! parent is gone. A panic ends the process (70), as an uncaught error ends
//! the worker thread it replaces.
#![forbid(unsafe_code)]

use std::io::{BufRead, Write};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use crate::codec::{MAX_LINE_BYTES, decode_line};
use crate::host::{self, EventLoop, Inbox, Input, RealClock, Unit};
use crate::proto::{InitFailure, Writer, start};
use crate::runtime::Factory;

/// Exit status for a corrupt stream, a refused `init`, a failed write or a
/// panic.
pub const EXIT_CORRUPT: i32 = 70;
/// How often the watchdog checks that the parent is still there.
const PARENT_CHECK_MS: u64 = 250;
/// The outgoing queue size past which one diagnostic is written.
const QUEUE_WARNING_BYTES: usize = 64 * 1024 * 1024;

/// Set by the reader thread when stdin ends: from then on nothing more
/// runs (the worker it replaces is terminated, not drained).
static CLOSED: AtomicBool = AtomicBool::new(false);

/// Set by the first `exit`, on whatever thread: from then on the loop thread
/// runs nothing more (it parks at its next check) while the exit flushes.
static EXITING: AtomicBool = AtomicBool::new(false);

/// Bytes handed to the writer thread and not yet written.
static QUEUED: AtomicUsize = AtomicUsize::new(0);
/// How long an exit waits for lines already emitted to reach stdout.
const EXIT_FLUSH_MS: u64 = 2_000;

/// Ends the process: no unwinding and no further work. Lines emitted before
/// get up to 2 s to reach stdout (as the JavaScript's pipe writes, which
/// Node starts at once, do); a host that stops reading cannot hold it.
fn exit(code: i32) -> ! {
    if EXITING.swap(true, Ordering::AcqRel) {
        // Another thread is already ending the process with its own code.
        park_forever();
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(exit_flush_ms());
    while QUEUED.load(Ordering::Acquire) > 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    std::process::exit(code)
}

/// The flush window of an exit; a test-hooks build may widen it
/// (`LEDGER_NATIVE_TEST_EXIT_FLUSH_MS`), so a test of the flush does not
/// depend on how fast a loaded machine reads 8 MiB.
fn exit_flush_ms() -> u64 {
    #[cfg(feature = "test-hooks")]
    if let Some(ms) = std::env::var("LEDGER_NATIVE_TEST_EXIT_FLUSH_MS")
        .ok()
        .and_then(|text| text.parse().ok())
    {
        return ms;
    }
    EXIT_FLUSH_MS
}

fn park_forever() -> ! {
    loop {
        std::thread::park();
    }
}

/// The loop's check before each unit, timer, immediate and job: nothing
/// more runs once an exit has begun (S2: an exit from the watchdog or a
/// pool thread's panic stops the loop before the flush window), and stdin's
/// end ends the process.
fn halt() {
    if EXITING.load(Ordering::Acquire) {
        park_forever();
    }
    if CLOSED.load(Ordering::Acquire) {
        exit(0);
    }
}

fn line_limit() -> usize {
    #[cfg(feature = "test-hooks")]
    if let Some(limit) = std::env::var("LEDGER_NATIVE_TEST_MAX_LINE")
        .ok()
        .and_then(|text| text.parse().ok())
    {
        return limit;
    }
    MAX_LINE_BYTES
}

/// Reads stdin into lines; empty lines are skipped, as the worker skips them.
fn read_lines(inbox: Arc<Inbox>) {
    let send = |input: Input| inbox.post(Unit::Input(input));
    let limit = line_limit();
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut line = Vec::new();
    loop {
        let (consumed, found) = match reader.fill_buf() {
            // A last line without its newline is never complete.
            Ok([]) => {
                CLOSED.store(true, Ordering::Release);
                eprintln!("devryan-ledger: stdin closed");
                send(Input::Eof);
                return;
            }
            Ok(buffer) => match buffer.iter().position(|byte| *byte == b'\n') {
                Some(at) => {
                    line.extend_from_slice(&buffer[..at]);
                    (at + 1, true)
                }
                None => {
                    line.extend_from_slice(buffer);
                    (buffer.len(), false)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                send(Input::Corrupt(format!("stdin failed: {error}")));
                return;
            }
        };
        reader.consume(consumed);
        if line.len() > limit {
            send(Input::Corrupt(format!("a line longer than {limit} bytes")));
            return;
        }
        if found && !line.is_empty() {
            send(Input::Line(std::mem::take(&mut line)));
        }
    }
}

/// The writer thread and the queue in front of it.
fn writer() -> Writer {
    let (send, receive) = std::sync::mpsc::channel::<Vec<u8>>();
    let warned = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        let stdout = std::io::stdout();
        for line in receive {
            let length = line.len();
            let mut out = stdout.lock();
            if out.write_all(&line).and_then(|()| out.flush()).is_err() {
                eprintln!("devryan-ledger: stdout failed");
                std::process::exit(EXIT_CORRUPT);
            }
            QUEUED.fetch_sub(length, Ordering::AcqRel);
        }
    });
    Rc::new(move |line: Vec<u8>| {
        let total = QUEUED.fetch_add(line.len(), Ordering::AcqRel) + line.len();
        if total > QUEUE_WARNING_BYTES && !warned.swap(true, Ordering::Relaxed) {
            eprintln!(
                "devryan-ledger: more than 64 MiB of messages wait for the host to read them"
            );
        }
        let _ = send.send(line);
    })
}

/// The factory this build serves: the product's methods, none ported, and
/// with `test-hooks` the stub methods of the conformance suite beside them.
fn factory() -> Factory {
    #[cfg(feature = "test-hooks")]
    return crate::stub::factory();
    #[cfg(not(feature = "test-hooks"))]
    crate::runtime::unported_factory()
}

/// Ends the process when its parent is gone: the parent changed (a
/// subreaper is not pid 1) or is init (the parent died before this process
/// first read it).
fn watch_parent() {
    let parent = std::os::unix::process::parent_id();
    std::thread::spawn(move || {
        loop {
            let now = std::os::unix::process::parent_id();
            if now != parent || now == 1 {
                exit(0);
            }
            std::thread::sleep(std::time::Duration::from_millis(PARENT_CHECK_MS));
        }
    });
}

/// A panic is a broken invariant of the process, not an error of one call:
/// it ends the process, as an uncaught error ends the worker thread (the
/// host then fails every call in flight with `worker_exit`). Lines already
/// emitted get their flush.
fn end_on_panic() {
    std::panic::set_hook(Box::new(|info| {
        eprintln!("devryan-ledger: {info}");
        exit(EXIT_CORRUPT);
    }));
}

/// The stack of the loop thread: the main thread's size is the platform's
/// (8 MiB on macOS, `ulimit -s` on Linux), so the loop gets a thread whose
/// stack it knows. Only the pages used are committed.
pub const LOOP_STACK: usize = 64 << 20;

/// The part of [`LOOP_STACK`] nested async function starts may use; past
/// it a start fails with JavaScript's `RangeError` (`js::async_fn`), leaving
/// 8 MiB for the frames of the deepest call. Measured with this budget:
/// 37,835 nested starts of a small async function on the debug build and
/// 159,566 on the release build, where Node gives a `RangeError` between
/// 5,000 and 10,000 and the ledger's own recursions go a directory tree
/// deep.
pub const LOOP_STACK_BUDGET: usize = LOOP_STACK - (8 << 20);

/// The process's main loop; never returns. The loop runs on a thread of
/// its own (see [`LOOP_STACK`]); the main thread waits for it.
pub fn run() -> ! {
    end_on_panic();
    ledger_io::fs::raise_open_file_limit();
    let spawned = std::thread::Builder::new()
        .name("ledger-loop".into())
        .stack_size(LOOP_STACK)
        .spawn(run_loop);
    match spawned {
        // The loop never returns: it ends the process itself.
        Ok(thread) => {
            let _ = thread.join();
            exit(EXIT_CORRUPT)
        }
        Err(error) => {
            eprintln!("devryan-ledger: no loop thread: {error}");
            exit(EXIT_CORRUPT)
        }
    }
}

fn run_loop() {
    crate::js::set_stack_budget(LOOP_STACK_BUDGET);
    let event_loop = EventLoop::new(
        Box::new(RealClock::new()),
        Box::new(|name| std::env::var(name).ok()),
        Box::new(halt),
    );
    host::install(event_loop.clone());
    let inbox = event_loop.inbox();
    std::thread::spawn(move || read_lines(inbox));
    watch_parent();
    let out = writer();
    let mut process = None;
    let mut factory = Some(factory());
    let mut input = move |input: Input| {
        let line = match input {
            Input::Line(line) => line,
            Input::Eof => exit(0),
            Input::Corrupt(reason) => {
                eprintln!("devryan-ledger: {reason}");
                exit(EXIT_CORRUPT);
            }
        };
        let message = match decode_line(&line) {
            Ok(message) => message,
            Err(corrupt) => {
                eprintln!("devryan-ledger: a corrupt line: {}", corrupt.0);
                exit(EXIT_CORRUPT);
            }
        };
        match &process {
            Some(process) => crate::proto::Process::handle(process, message),
            None => match start(&message, factory.take().expect("one init"), out.clone()) {
                Ok(started) => process = Some(started),
                Err(InitFailure::Protocol(reason) | InitFailure::Runtime(reason)) => {
                    eprintln!("devryan-ledger: init refused: {reason}");
                    exit(EXIT_CORRUPT);
                }
            },
        }
    };
    event_loop.run(&mut input)
}
