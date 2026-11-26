//! A child process's stdio sockets (design file 32, package O2e, in the
//! reduced form of file 33): Node 24.22's `net.Socket` over a libuv pipe
//! handle, as `child_process` makes them (`createSocket(pipe, readable)`):
//! a `Duplex` that does not allow half-open, `emitClose: false` (its
//! `close` comes from the handle's close), `autoDestroy`. The readable side
//! is [`super::stream`]'s `Readable` core; the writable side is Node's
//! `Writable` (`lib/internal/streams/writable.js`), ported here function by
//! function for the paths a socket reaches (`write`, `writeOrBuffer`,
//! `doWrite`, `onwrite`, `onwriteError`, `afterWrite`, `errorBuffer`,
//! `clearBuffer`, `end`, `needFinish`, `onFinish`, `prefinish`,
//! `finishMaybe`, `finish`); the glue is `net.js` and
//! `stream_base_commons.js` (`_read` → `readStart`, `onStreamRead`,
//! `_writeGeneric`, `afterWriteDispatched`, `onWriteComplete`, `_final` →
//! `shutdown`, `_destroy` → `closeSocketHandle`). `pipeline` into a child's
//! stdin is [`pipeline`].
//!
//! The handle, by threads (the design's section 3.3):
//! - **Reads:** one reader thread per readable socket, a blocking `read(2)`
//!   of up to 64 KiB at a time into one buffer of its own, each result
//!   copied out at its exact length and delivered as a unit of its own on
//!   the loop (`onStreamRead`). Gated twice: by `readStart`/`readStop`, so
//!   past the high-water mark nothing more is read; and by the loop taking
//!   each delivery: the thread reads again only once the loop has run the
//!   unit of its last read, so while the loop is busy at most one read
//!   waits in the inbox and the child blocks on a full socket, as under
//!   Node, where libuv reads only while the loop polls.
//! - **Writes:** tried inline on the loop thread, as `uv_try_write` is: a
//!   write that goes whole completes synchronously (Node calls the write's
//!   callback at once and `afterWrite` on a tick); only the rest goes to a
//!   writer thread that waits for the socket to be writable, and its
//!   completion is a unit. A completion posted after the handle began to
//!   close is `ECANCELED` (libuv cancels a write still queued at
//!   `uv_close`); the decision and the post are one step under the
//!   writer's lock. When the child exits while a write waits, the exit
//!   waiter lets the writer make its next attempt first if the socket is
//!   ready (the child's end is gone): libuv runs a poll batch's socket
//!   events before its signal events, so the failed write (`EPIPE`) is
//!   seen before the exit, as under Node.
//! - **Shutdown and close** run on the pool (`node::submit`), each
//!   completing in a unit. A descriptor is closed only once no thread is
//!   using it: a blocked reader is woken by `shutdown(SHUT_RDWR)` and its
//!   last unit closes it (libuv's `uv_close` of a handle).
//!
//! The rules: rule 1 (no completion settles in the checkpoint that started
//! it) is `node::source`'s and `node::submit`'s guard; rule 2 (one source's
//! events in Node's order) is the ported functions' order: `data` in read
//! order, `end`, `finish`, `close`; `error`, then `close`.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use ledger_core::js::JsStr;
use ledger_io::fs::sys;

use super::stream::{self, Inner};
use crate::agen::{self, AsyncGen, AsyncIterator, IntoAsyncIterator};
use crate::emitter::Listener;
use crate::js::{self, Frame, Promise, Resolution, Resolvers};
use crate::value::{JsError, W};

/// A socket's `highWaterMark`, read and write (Node 24's default, 64 KiB).
pub const HIGH_WATER_MARK: usize = 64 * 1024;

/// How much one read takes (libuv's 64 KiB `onread` buffer).
const READ_SIZE: usize = 64 * 1024;

/// The helper threads (readers, writers, exit waiters) alive now, for the
/// tests' census around every case.
static LIVE_THREADS: AtomicUsize = AtomicUsize::new(0);

/// How many helper threads of child processes are alive.
pub fn live_threads() -> usize {
    LIVE_THREADS.load(Ordering::SeqCst)
}

/// Starts a helper thread counted by [`live_threads`]; a panic in it is
/// carried to the loop by `post_panic` (so no source is left open).
pub(crate) fn helper_thread(
    name: &str,
    body: impl FnOnce() + Send + 'static,
    post_panic: impl FnOnce(String) + Send + 'static,
) {
    LIVE_THREADS.fetch_add(1, Ordering::SeqCst);
    let started = std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
            if let Err(panic) = outcome {
                let message = panic
                    .downcast_ref::<&str>()
                    .map(|text| (*text).to_owned())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| String::from("a panic without a message"));
                post_panic(message);
            }
            LIVE_THREADS.fetch_sub(1, Ordering::SeqCst);
        });
    if started.is_err() {
        LIVE_THREADS.fetch_sub(1, Ordering::SeqCst);
        panic!("a child process's helper thread could not be started");
    }
}

/// `new ErrnoException(-errno, syscall)`: `<syscall> <code>`, with `errno`
/// (negative), `code` and `syscall`.
pub fn errno_exception(errno: i32, syscall: &str) -> W {
    let code = ledger_io::fs::error_name(errno);
    let mut error = JsError::new("Error", &format!("{syscall} {code}"));
    error.set_field("errno", W::Number(f64::from(-errno)));
    error.set_field("code", W::String(JsStr::from(code.as_str())));
    error.set_field("syscall", W::String(JsStr::from(syscall)));
    W::Error(Rc::new(error))
}

/// One of Node's own stream errors (`ERR_STREAM_PREMATURE_CLOSE`, …).
fn node_error(name: &str, code: &str, message: &str) -> W {
    let mut error = JsError::new(name, message);
    error.set_field("code", W::String(JsStr::from(code)));
    W::Error(Rc::new(error))
}

pub(crate) fn premature_close() -> W {
    node_error("Error", "ERR_STREAM_PREMATURE_CLOSE", "Premature close")
}

// --- The handle ---------------------------------------------------------

/// What a reader thread reports (`onStreamRead`'s `nread`).
enum ReadEvent {
    Data(Vec<u8>),
    Eof,
    Error(i32),
    /// It stopped because the handle is closing (its last unit).
    Stopped,
    Panicked(String),
}

/// What a writer thread reports (`onWriteComplete`'s status).
enum WriteEvent {
    Written,
    Failed(i32),
    /// Cancelled by the handle's close (libuv's `UV_ECANCELED`).
    Cancelled,
    Panicked(String),
}

/// What a reader thread's gate holds.
#[derive(Default)]
struct GateState {
    /// `readStart` (on) and `readStop` (off).
    reading: bool,
    /// The handle is closing: the thread stops.
    stop: bool,
    /// A read the thread delivered that the loop has not taken yet.
    in_flight: bool,
}

/// The gate a reader thread waits on: `readStart`/`readStop`, the loop's
/// taking of its last delivery, and the stop of a closing handle.
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

impl Gate {
    fn change(&self, change: impl FnOnce(&mut GateState)) {
        let mut state = self.state.lock().expect("gate");
        change(&mut state);
        self.changed.notify_all();
    }

    /// Waits until the thread may read: reading is on and the loop has
    /// taken its last delivery (`true`); `false` once a stop is asked.
    fn wait_ready(&self) -> bool {
        let mut state = self.state.lock().expect("gate");
        loop {
            if state.stop {
                return false;
            }
            if state.reading && !state.in_flight {
                return true;
            }
            state = self.changed.wait(state).expect("gate");
        }
    }

    /// Posts one delivery unless a stop came meanwhile (`false`: nothing
    /// posted); data stays in flight until the loop takes it.
    fn deliver(&self, data: bool, post: impl FnOnce()) -> bool {
        let mut state = self.state.lock().expect("gate");
        if state.stop {
            return false;
        }
        state.in_flight = data;
        post();
        true
    }
}

/// A writer thread's stop: set by the handle's close.
#[derive(Default)]
struct Stop(Mutex<bool>);

impl Stop {
    fn set(&self) {
        *self.0.lock().expect("stop") = true;
    }

    fn stopped(&self) -> bool {
        *self.0.lock().expect("stop")
    }
}

/// What a child's exit waiter sees of its stdin: whether a write waits on
/// a writer thread (and its descriptor, open while it waits), and how many
/// attempts that writer has made.
#[derive(Default)]
pub(crate) struct WriterWatch {
    state: Mutex<WatchState>,
    changed: Condvar,
}

#[derive(Default)]
struct WatchState {
    waiting: Option<i32>,
    attempts: u64,
}

impl WriterWatch {
    /// The exit waiter, before it posts the exit: when a write waits and its
    /// socket is ready (the child's end is gone, or there is room), the
    /// writer's next attempt is let through first (within a second), so its
    /// completion, if it is one, comes before the exit. `post` runs under
    /// the watch's lock (the writer cannot post in between).
    pub(crate) fn before_exit(&self, post: impl FnOnce()) {
        let mut state = self.state.lock().expect("writer watch");
        if let Some(fd) = state.waiting
            && sys::poll_writable(fd, 0).unwrap_or(true)
        {
            let seen = state.attempts;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
            while state.waiting.is_some() && state.attempts == seen {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    break;
                }
                state = self
                    .changed
                    .wait_timeout(state, left)
                    .expect("writer watch")
                    .0;
            }
        }
        post();
    }

    fn begin(&self, fd: i32) {
        self.state.lock().expect("writer watch").waiting = Some(fd);
    }

    /// One attempt of the writer: `finished` (its completion, posted here
    /// under the lock) or `None` (bytes went, more to write).
    fn attempt(&self, finished: Option<impl FnOnce()>) {
        let mut state = self.state.lock().expect("writer watch");
        if let Some(post) = finished {
            post();
            state.waiting = None;
        }
        state.attempts += 1;
        self.changed.notify_all();
    }
}

/// A libuv pipe handle: one end of a socket pair, owned by the loop thread.
pub(crate) struct Handle {
    fd: Cell<Option<i32>>,
    /// `handle.reading` (the flag `Socket.prototype._read` checks).
    reading: Cell<bool>,
    /// The reader thread's gate and source, while it runs.
    gate: Option<Arc<Gate>>,
    /// The exit waiter's view of this handle's writer (a child's stdin).
    watch: Option<Arc<WriterWatch>>,
    reader: RefCell<Option<super::Source<ReadEvent>>>,
    /// Threads and pool jobs using the descriptor now (the reader, a writer,
    /// a shutdown); the close waits for them.
    in_use: Cell<usize>,
    /// The writer thread's stop flag, while one runs.
    writer_stop: RefCell<Option<Arc<Stop>>>,
    /// `handle.close(cb)` asked for, waiting for `in_use` to reach 0.
    closing: RefCell<Option<Box<dyn FnOnce()>>>,
    closed: Cell<bool>,
    /// The frame the handle was made in (its close callback runs there).
    frame: Frame,
}

impl Handle {
    fn new(fd: i32, readable: bool, watch: Option<Arc<WriterWatch>>) -> Rc<Handle> {
        Rc::new(Handle {
            fd: Cell::new(Some(fd)),
            reading: Cell::new(false),
            gate: readable.then(|| Arc::new(Gate::default())),
            watch,
            reader: RefCell::new(None),
            in_use: Cell::new(0),
            writer_stop: RefCell::new(None),
            closing: RefCell::new(None),
            closed: Cell::new(false),
            frame: js::current_frame(),
        })
    }

    fn release(self: &Rc<Handle>) {
        let left = self.in_use.get() - 1;
        self.in_use.set(left);
        if left == 0 {
            self.finish_close_now();
        }
    }

    /// A pending close, once nothing uses the descriptor.
    fn finish_close_now(self: &Rc<Handle>) {
        if self.in_use.get() != 0 || self.closing.borrow().is_none() {
            return;
        }
        self.close_on_pool();
    }

    /// `close(2)` on the pool; the close callback runs in its unit (libuv's
    /// close callbacks run in a later phase, never inside the code that
    /// closed the handle).
    fn close_on_pool(self: &Rc<Handle>) {
        let Some(fd) = self.fd.take() else {
            return;
        };
        let handle = self.clone();
        super::submit(
            move || sys::close(fd),
            move |()| {
                let callback = handle.closing.borrow_mut().take();
                handle.closed.set(true);
                if let Some(callback) = callback {
                    js::with_frame(handle.frame.clone(), callback);
                }
            },
        );
    }

    /// `uv_close(handle, cb)`: the reader is stopped (woken by a shutdown if
    /// it is blocked), a write in flight is cancelled; the descriptor is
    /// closed when they are done, or on the pool when nothing used it, and
    /// `cb` runs in a later unit either way.
    fn close(self: &Rc<Handle>, callback: impl FnOnce() + 'static) {
        assert!(
            self.closing.borrow().is_none() && !self.closed.get(),
            "a socket handle closed twice"
        );
        *self.closing.borrow_mut() = Some(Box::new(callback));
        self.reading.set(false);
        let fd = self.fd.get().expect("an open handle");
        let busy = self.in_use.get() > 0;
        if let Some(gate) = &self.gate {
            gate.change(|state| state.stop = true);
        }
        if let Some(stop) = self.writer_stop.borrow().as_ref() {
            stop.set();
        }
        if busy {
            // Wakes a reader blocked in read(2) and a writer in poll(2).
            let _ = sys::shutdown(fd, true, true);
            return;
        }
        self.close_on_pool();
    }

    fn is_closing(&self) -> bool {
        self.closing.borrow().is_some() || self.closed.get()
    }
}

// --- The socket state --------------------------------------------------

/// A write's callback (`cb(err)`); `None` is Node's `nop`.
type WriteCallback = Option<Box<dyn FnOnce(Option<W>)>>;

/// The writable side's state (`WritableState`, byte mode, `decodeStrings`
/// off, `emitClose` off, `autoDestroy` on) and the socket's handle.
pub(crate) struct SocketState {
    pub(crate) handle: Rc<Handle>,
    /// `options.readable`: `false` for stdin.
    pub(crate) readable: bool,
    length: Cell<usize>,
    writing: Cell<bool>,
    sync: Cell<bool>,
    expect_write_cb: Cell<bool>,
    writelen: Cell<usize>,
    writecb: RefCell<WriteCallback>,
    buffered: RefCell<VecDeque<(Rc<Vec<u8>>, WriteCallback)>>,
    need_drain: Cell<bool>,
    ending: Cell<bool>,
    ended: Cell<bool>,
    finished: Cell<bool>,
    prefinished: Cell<bool>,
    final_called: Cell<bool>,
    pending_cb: Cell<usize>,
    after_write_pending: Cell<bool>,
    w_errored: Cell<bool>,
}

impl SocketState {
    fn new(handle: Rc<Handle>, readable: bool) -> SocketState {
        SocketState {
            handle,
            readable,
            length: Cell::new(0),
            writing: Cell::new(false),
            sync: Cell::new(true),
            expect_write_cb: Cell::new(false),
            writelen: Cell::new(0),
            writecb: RefCell::new(None),
            buffered: RefCell::new(VecDeque::new()),
            need_drain: Cell::new(false),
            ending: Cell::new(false),
            ended: Cell::new(false),
            finished: Cell::new(false),
            prefinished: Cell::new(false),
            final_called: Cell::new(false),
            pending_cb: Cell::new(0),
            after_write_pending: Cell::new(false),
            w_errored: Cell::new(false),
        }
    }

    /// `isWritable(stream)`: the writable side is neither ended nor
    /// finished nor errored (the shared `destroyed` is checked by the caller).
    pub(crate) fn writable_alive(&self) -> bool {
        !self.ending.get() && !self.ended.get() && !self.w_errored.get()
    }
}

fn socket_of(stream: &Inner) -> &SocketState {
    stream.socket.as_ref().expect("a socket stream")
}

// --- The readable side's glue ------------------------------------------

/// `Socket.prototype._read(n)`: `tryReadStart` when the handle is not
/// reading (`readStart`).
pub(crate) fn read_start(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    let handle = &socket.handle;
    if handle.is_closing() || handle.reading.get() {
        return;
    }
    handle.reading.set(true);
    if let Some(reader) = handle.reader.borrow().as_ref() {
        reader.restarted();
    }
    if let Some(gate) = &handle.gate {
        gate.change(|state| state.reading = true);
    }
}

/// `handle.readStop()`.
fn read_stop(handle: &Handle) {
    handle.reading.set(false);
    if let Some(gate) = &handle.gate {
        gate.change(|state| state.reading = false);
    }
}

/// `onStreamRead` for one unit of the reader thread.
fn on_stream_read(stream: &Rc<Inner>, event: ReadEvent) {
    let socket = socket_of(stream);
    let handle = socket.handle.clone();
    let terminal = !matches!(event, ReadEvent::Data(_));
    match event {
        ReadEvent::Panicked(message) => panic!("a socket's reader thread panicked: {message}"),
        // Read after the destroy began (the handle is closing): dropped.
        ReadEvent::Data(_) | ReadEvent::Eof | ReadEvent::Error(_) if handle.is_closing() => {}
        ReadEvent::Data(bytes) => {
            if !stream.destroyed.get() && !stream::push(stream, Some(bytes)) {
                read_stop(&handle);
            }
        }
        ReadEvent::Eof => {
            if !stream.end_emitted.get() {
                stream::push(stream, None);
                stream::read(stream, Some(0));
            }
        }
        ReadEvent::Error(errno) => stream::destroy(stream, Some(errno_exception(errno, "read"))),
        ReadEvent::Stopped => {}
    }
    // The loop has taken the read (after a `readStop` it asked for): the
    // thread may read again.
    if !terminal && let Some(gate) = &handle.gate {
        gate.change(|state| state.in_flight = false);
    }
    if terminal {
        if let Some(reader) = handle.reader.borrow_mut().take() {
            reader.close();
        }
        handle.release();
    }
}

/// The reader thread: waits on the gate (reading on, its last read taken),
/// reads into its own buffer, posts each result copied at its exact length;
/// its last unit is the end, an error, or `Stopped` once the handle is
/// closing.
fn start_reader(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    let handle = &socket.handle;
    let gate = handle.gate.clone().expect("a readable handle");
    let fd = handle.fd.get().expect("an open handle");
    let target = stream.clone();
    let source = super::source(move |event: ReadEvent| on_stream_read(&target, event));
    let poster = source.poster();
    let on_panic = poster.clone();
    handle.in_use.set(handle.in_use.get() + 1);
    *handle.reader.borrow_mut() = Some(source);
    helper_thread(
        "child-reader",
        move || {
            let mut buffer = vec![0u8; READ_SIZE];
            loop {
                if !gate.wait_ready() {
                    poster.post(ReadEvent::Stopped);
                    return;
                }
                let event = match sys::read_into(fd, &mut buffer) {
                    Ok(0) => ReadEvent::Eof,
                    Ok(read) => ReadEvent::Data(buffer[..read].to_vec()),
                    Err(errno) => ReadEvent::Error(errno),
                };
                let data = matches!(event, ReadEvent::Data(_));
                if !gate.deliver(data, || poster.post(event)) {
                    poster.post(ReadEvent::Stopped);
                    return;
                }
                if !data {
                    return;
                }
            }
        },
        move |message| on_panic.post(ReadEvent::Panicked(message)),
    );
}

/// After a socket's `end`: `endReadableNT`'s `Duplex` branch. With the
/// writable side still writable and half-open not allowed, it ends on the
/// next tick (`endWritableNT`); otherwise `autoDestroy` destroys the
/// socket once the writable side has finished.
pub(crate) fn after_end(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    if writable(stream) {
        let later = stream.clone();
        js::next_tick(move || {
            if writable(&later) && !socket_of(&later).ending.get() {
                end(&later);
            }
        });
    } else if socket.finished.get() {
        stream::destroy(stream, None);
    }
}

/// `stream.writable`.
fn writable(stream: &Inner) -> bool {
    let socket = socket_of(stream);
    !stream.destroyed.get()
        && !socket.w_errored.get()
        && stream.errored.borrow().is_none()
        && !socket.ending.get()
        && !socket.ended.get()
}

/// `Socket.prototype._destroy`: `closeSocketHandle` (its `close` event
/// comes from the handle's close, with whether it was destroyed with an
/// error); the destroy's own callback runs at once (the caller's).
pub(crate) fn destroy_handle(stream: &Rc<Inner>, had_error: bool) {
    let socket = socket_of(stream);
    let handle = &socket.handle;
    if handle.is_closing() {
        return;
    }
    let target = stream.clone();
    handle.close(move || stream::emit_socket_close(&target, had_error));
}

// --- The writable side (writable.js) -----------------------------------

/// `Writable.prototype.write(chunk, cb)` (`_write`): `false` once the
/// buffered bytes reach the high-water mark.
fn write(stream: &Rc<Inner>, chunk: Rc<Vec<u8>>, cb: WriteCallback) -> bool {
    let socket = socket_of(stream);
    let error = if socket.ending.get() {
        Some(node_error(
            "Error",
            "ERR_STREAM_WRITE_AFTER_END",
            "write after end",
        ))
    } else if stream.destroyed.get() {
        Some(node_error(
            "Error",
            "ERR_STREAM_DESTROYED",
            "Cannot call write after a stream was destroyed",
        ))
    } else {
        None
    };
    if let Some(error) = error {
        if let Some(cb) = cb {
            let error = error.clone();
            js::next_tick(move || cb(Some(error)));
        }
        stream::error_or_destroy(stream, error);
        return false;
    }
    socket.pending_cb.set(socket.pending_cb.get() + 1);
    write_or_buffer(stream, chunk, cb)
}

/// `writeOrBuffer`.
fn write_or_buffer(stream: &Rc<Inner>, chunk: Rc<Vec<u8>>, cb: WriteCallback) -> bool {
    let socket = socket_of(stream);
    socket.length.set(socket.length.get() + chunk.len());
    if socket.writing.get() || socket.w_errored.get() || stream.errored.borrow().is_some() {
        socket.buffered.borrow_mut().push_back((chunk, cb));
    } else {
        do_write(stream, chunk, cb);
    }
    let fits = socket.length.get() < HIGH_WATER_MARK || socket.length.get() == 0;
    if !fits {
        socket.need_drain.set(true);
    }
    fits && !stream.destroyed.get() && !socket.w_errored.get()
}

/// `doWrite`: `_write` with `onwrite` as its callback, `sync` set around it.
fn do_write(stream: &Rc<Inner>, chunk: Rc<Vec<u8>>, cb: WriteCallback) {
    let socket = socket_of(stream);
    socket.writelen.set(chunk.len());
    *socket.writecb.borrow_mut() = cb;
    socket.writing.set(true);
    socket.sync.set(true);
    socket.expect_write_cb.set(true);
    if stream.destroyed.get() {
        onwrite(
            stream,
            Some(node_error(
                "Error",
                "ERR_STREAM_DESTROYED",
                "Cannot call write after a stream was destroyed",
            )),
        );
    } else {
        write_generic(stream, chunk);
    }
    socket.sync.set(false);
}

/// `Socket.prototype._writeGeneric` → `writeGeneric` → `afterWriteDispatched`:
/// tried at once (`uv_try_write`); written whole or failed, the callback runs
/// now; otherwise the rest goes to a writer thread and completes as a unit.
fn write_generic(stream: &Rc<Inner>, chunk: Rc<Vec<u8>>) {
    let socket = socket_of(stream);
    let handle = socket.handle.clone();
    let Some(fd) = handle.fd.get().filter(|_| !handle.is_closing()) else {
        onwrite(
            stream,
            Some(node_error("Error", "ERR_SOCKET_CLOSED", "Socket is closed")),
        );
        return;
    };
    match sys::write(fd, &chunk) {
        Err(errno) => onwrite(stream, Some(errno_exception(errno, "write"))),
        Ok(written) if written == chunk.len() => onwrite(stream, None),
        Ok(written) => start_writer(stream, &handle, fd, chunk, written),
    }
}

/// The rest of a write, on a thread that waits for the socket to be
/// writable; its completion is one unit (`onWriteComplete`).
fn start_writer(stream: &Rc<Inner>, handle: &Rc<Handle>, fd: i32, chunk: Rc<Vec<u8>>, from: usize) {
    let rest: Vec<u8> = chunk[from..].to_vec();
    let stop = Arc::new(Stop::default());
    let watch = handle.watch.clone();
    if let Some(watch) = &watch {
        watch.begin(fd);
    }
    *handle.writer_stop.borrow_mut() = Some(stop.clone());
    handle.in_use.set(handle.in_use.get() + 1);
    let target = stream.clone();
    let source_slot: Rc<RefCell<Option<super::Source<WriteEvent>>>> = Rc::default();
    let slot = source_slot.clone();
    let source = super::source(move |event: WriteEvent| {
        if let Some(source) = slot.borrow_mut().take() {
            source.close();
        }
        on_write_complete(&target, event);
    });
    let poster = source.poster();
    let on_panic = poster.clone();
    *source_slot.borrow_mut() = Some(source);
    helper_thread(
        "child-writer",
        move || {
            // The completion: `ECANCELED` once the handle began to close (the
            // check and the post one step under the stop's lock).
            let finish = |event: WriteEvent| {
                let stopped = stop.0.lock().expect("stop");
                poster.post(if *stopped {
                    WriteEvent::Cancelled
                } else {
                    event
                });
            };
            let attempt = |event: Option<WriteEvent>| match &watch {
                Some(watch) => watch.attempt(event.map(|event| || finish(event))),
                None => {
                    if let Some(event) = event {
                        finish(event);
                    }
                }
            };
            let mut at = 0;
            loop {
                if stop.stopped() {
                    attempt(Some(WriteEvent::Cancelled));
                    return;
                }
                match sys::poll_writable(fd, 100) {
                    Ok(false) => continue,
                    Ok(true) => {}
                    Err(errno) => {
                        attempt(Some(WriteEvent::Failed(errno)));
                        return;
                    }
                }
                if stop.stopped() {
                    attempt(Some(WriteEvent::Cancelled));
                    return;
                }
                match sys::write(fd, &rest[at..]) {
                    Ok(written) => {
                        at += written;
                        if at == rest.len() {
                            attempt(Some(WriteEvent::Written));
                            return;
                        }
                        attempt(None);
                    }
                    Err(errno) => {
                        attempt(Some(WriteEvent::Failed(errno)));
                        return;
                    }
                }
            }
        },
        move |message| on_panic.post(WriteEvent::Panicked(message)),
    );
}

/// `onWriteComplete(status)`.
fn on_write_complete(stream: &Rc<Inner>, event: WriteEvent) {
    let socket = socket_of(stream);
    let handle = socket.handle.clone();
    handle.writer_stop.borrow_mut().take();
    let outcome = match event {
        WriteEvent::Panicked(message) => panic!("a socket's writer thread panicked: {message}"),
        WriteEvent::Written if stream.destroyed.get() => None,
        WriteEvent::Written => None,
        WriteEvent::Failed(errno) => Some(errno_exception(errno, "write")),
        WriteEvent::Cancelled => Some(errno_exception(libc_ecanceled(), "write")),
    };
    onwrite(stream, outcome);
    handle.release();
}

/// `ECANCELED` on this platform.
fn libc_ecanceled() -> i32 {
    ledger_io::fs::system_errors()
        .into_iter()
        .find(|(_, name, _)| *name == "ECANCELED")
        .map_or(89, |(errno, _, _)| errno)
}

/// `onwrite(stream, er)`.
fn onwrite(stream: &Rc<Inner>, error: Option<W>) {
    let socket = socket_of(stream);
    assert!(
        socket.expect_write_cb.get(),
        "a write's callback called twice (ERR_MULTIPLE_CALLBACK)"
    );
    let sync = socket.sync.get();
    let cb = socket.writecb.borrow_mut().take();
    socket.writing.set(false);
    socket.expect_write_cb.set(false);
    socket
        .length
        .set(socket.length.get() - socket.writelen.get());
    socket.writelen.set(0);
    if let Some(error) = error {
        if !socket.w_errored.get() {
            socket.w_errored.set(true);
        }
        if stream.errored.borrow().is_none() {
            *stream.errored.borrow_mut() = Some(error.clone());
        }
        if sync {
            let later = stream.clone();
            js::next_tick(move || onwrite_error(&later, error, cb));
        } else {
            onwrite_error(stream, error, cb);
        }
        return;
    }
    if !socket.buffered.borrow().is_empty() {
        clear_buffer(stream);
    }
    if sync {
        let need_drain = socket.need_drain.get() && socket.length.get() == 0;
        // Node's `(state[kState] & kDestroyed !== 0)` is `& true`, the object
        // mode bit, which a socket never has: only drain or a callback ticks.
        let need_tick = need_drain || cb.is_some();
        if cb.is_none() && (socket.after_write_pending.get() || !need_tick) {
            socket.pending_cb.set(socket.pending_cb.get() - 1);
            if socket.ending.get() {
                finish_maybe(stream, true);
            }
        } else if need_tick {
            socket.after_write_pending.set(true);
            let later = stream.clone();
            js::next_tick(move || after_write(&later, cb));
        } else {
            socket.pending_cb.set(socket.pending_cb.get() - 1);
            if socket.ending.get() {
                finish_maybe(stream, true);
            }
        }
    } else {
        after_write(stream, cb);
    }
}

/// `onwriteError`.
fn onwrite_error(stream: &Rc<Inner>, error: W, cb: WriteCallback) {
    let socket = socket_of(stream);
    socket.pending_cb.set(socket.pending_cb.get() - 1);
    if let Some(cb) = cb {
        cb(Some(error.clone()));
    }
    error_buffer(stream);
    stream::error_or_destroy(stream, error);
}

/// `afterWrite(stream, state, 1, cb)`.
fn after_write(stream: &Rc<Inner>, cb: WriteCallback) {
    let socket = socket_of(stream);
    socket.after_write_pending.set(false);
    let need_drain = !socket.ending.get()
        && socket.need_drain.get()
        && !stream.destroyed.get()
        && socket.length.get() == 0;
    if need_drain {
        socket.need_drain.set(false);
        stream::emit(stream, "drain", &W::Undefined);
    }
    socket.pending_cb.set(socket.pending_cb.get() - 1);
    if let Some(cb) = cb {
        cb(None);
    }
    if stream.destroyed.get() {
        error_buffer(stream);
    }
    if socket.ending.get() {
        finish_maybe(stream, true);
    }
}

/// `errorBuffer`: the buffered writes' callbacks get the error.
fn error_buffer(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    if socket.writing.get() {
        return;
    }
    let buffered: Vec<(Rc<Vec<u8>>, WriteCallback)> =
        socket.buffered.borrow_mut().drain(..).collect();
    for (chunk, cb) in buffered {
        socket.length.set(socket.length.get() - chunk.len());
        let error = stream.errored.borrow().clone().unwrap_or_else(|| {
            node_error(
                "Error",
                "ERR_STREAM_DESTROYED",
                "Cannot call write after a stream was destroyed",
            )
        });
        if let Some(cb) = cb {
            cb(Some(error));
        }
    }
}

/// `clearBuffer`: what was buffered behind a write, as one `writev`
/// (`Socket.prototype._writev`: the chunks' bytes in order).
fn clear_buffer(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    if stream.destroyed.get() || socket.buffered.borrow().is_empty() {
        return;
    }
    let buffered: Vec<(Rc<Vec<u8>>, WriteCallback)> =
        socket.buffered.borrow_mut().drain(..).collect();
    if buffered.len() == 1 {
        let (chunk, cb) = buffered.into_iter().next().expect("one buffered write");
        do_write(stream, chunk, cb);
        return;
    }
    socket
        .pending_cb
        .set(socket.pending_cb.get() - (buffered.len() - 1));
    let mut bytes = Vec::new();
    let mut callbacks = Vec::new();
    for (chunk, cb) in buffered {
        bytes.extend_from_slice(&chunk);
        callbacks.push(cb);
    }
    let all_noop = callbacks.iter().all(Option::is_none);
    let cb: WriteCallback = if all_noop {
        None
    } else {
        Some(Box::new(move |error: Option<W>| {
            for cb in callbacks.into_iter().flatten() {
                cb(error.clone());
            }
        }))
    };
    do_write(stream, Rc::new(bytes), cb);
}

/// `Writable.prototype.end()`.
fn end(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    if !socket.ending.get() && !socket.w_errored.get() {
        socket.ending.set(true);
        finish_maybe(stream, true);
        socket.ended.set(true);
    }
}

/// `needFinish(state)`.
fn need_finish(stream: &Inner) -> bool {
    let socket = socket_of(stream);
    socket.ending.get()
        && !stream.destroyed.get()
        && !socket.finished.get()
        && !socket.writing.get()
        && !stream.error_emitted.get()
        && !stream.close_emitted.get()
        && !socket.w_errored.get()
        && stream.errored.borrow().is_none()
        && socket.buffered.borrow().is_empty()
        && socket.length.get() == 0
}

/// `onFinish(stream, state, err)`: `_final`'s callback.
fn on_finish(stream: &Rc<Inner>, error: Option<W>) {
    let socket = socket_of(stream);
    assert!(
        !socket.prefinished.get(),
        "a socket's _final called back twice (ERR_MULTIPLE_CALLBACK)"
    );
    socket.pending_cb.set(socket.pending_cb.get() - 1);
    if let Some(error) = error {
        stream::error_or_destroy(stream, error);
    } else if need_finish(stream) {
        socket.prefinished.set(true);
        socket.pending_cb.set(socket.pending_cb.get() + 1);
        let later = stream.clone();
        js::next_tick(move || finish(&later));
    }
}

/// `prefinish(stream, state)`: `_final` (`Socket.prototype._final`).
fn prefinish(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    if socket.prefinished.get() || socket.final_called.get() {
        return;
    }
    if stream.destroyed.get() {
        socket.final_called.set(true);
        socket.prefinished.set(true);
        return;
    }
    socket.final_called.set(true);
    socket.sync.set(true);
    socket.pending_cb.set(socket.pending_cb.get() + 1);
    socket_final(stream);
    socket.sync.set(false);
}

/// `Socket.prototype._final(cb)`: `shutdown` on the handle (libuv performs
/// it once the writes are out; here on the pool), whose completion calls
/// back (`afterShutdown`, which ignores the status).
fn socket_final(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    let handle = socket.handle.clone();
    let Some(fd) = handle.fd.get().filter(|_| !handle.is_closing()) else {
        on_finish(stream, None);
        return;
    };
    handle.in_use.set(handle.in_use.get() + 1);
    let target = stream.clone();
    super::submit(
        move || {
            let _ = sys::shutdown(fd, false, true);
        },
        move |()| {
            let handle = socket_of(&target).handle.clone();
            // A shutdown cancelled by the close: libuv calls back too.
            on_finish(&target, None);
            handle.release();
        },
    );
}

/// `finishMaybe(stream, state, sync)`.
fn finish_maybe(stream: &Rc<Inner>, sync: bool) {
    let socket = socket_of(stream);
    if !need_finish(stream) {
        return;
    }
    prefinish(stream);
    if socket.pending_cb.get() == 0 {
        if sync {
            socket.pending_cb.set(socket.pending_cb.get() + 1);
            let later = stream.clone();
            js::next_tick(move || {
                if need_finish(&later) {
                    finish(&later);
                } else {
                    let socket = socket_of(&later);
                    socket.pending_cb.set(socket.pending_cb.get() - 1);
                }
            });
        } else if need_finish(stream) {
            socket.pending_cb.set(socket.pending_cb.get() + 1);
            finish(stream);
        }
    }
}

/// `finish(stream, state)`: `'finish'`, then `autoDestroy` once the readable
/// side has ended too (or there is none).
fn finish(stream: &Rc<Inner>) {
    let socket = socket_of(stream);
    socket.pending_cb.set(socket.pending_cb.get() - 1);
    socket.finished.set(true);
    stream::emit(stream, "finish", &W::Undefined);
    if !socket.readable || stream.end_emitted.get() {
        stream::destroy(stream, None);
    }
}

// --- The public socket -------------------------------------------------

/// A child process's stdio stream (`child.stdin`, `child.stdout`,
/// `child.stderr`): a `net.Socket`. Clones are the same socket.
#[derive(Clone)]
pub struct Socket(pub(crate) Rc<Inner>);

/// `createSocket(pipe, readable)` over the parent's end `fd` of a socket
/// pair; a readable one starts reading at once (its constructor's
/// `read(0)`), on a reader thread of its own. `watch` is the exit waiter's
/// view of a stdin's writer.
pub(crate) fn create_socket(fd: i32, readable: bool, watch: Option<Arc<WriterWatch>>) -> Socket {
    let handle = Handle::new(fd, readable, watch);
    let state = SocketState::new(handle, readable);
    let inner = stream::new_inner("", HIGH_WATER_MARK, Some(state));
    if !readable {
        // `Duplex` with `readable: false`.
        inner.ended.set(true);
        inner.end_emitted.set(true);
    }
    if readable {
        start_reader(&inner);
        stream::read(&inner, Some(0));
    }
    Socket(inner)
}

impl Socket {
    /// `socket.on(event, listener)` for `'data'` (which starts the flow, as
    /// `Readable.prototype.on('data')` resumes it), `'end'`, `'finish'`,
    /// `'drain'`, `'error'` and `'close'` (its value is whether the socket
    /// was destroyed with an error). Listeners run in the frame of the code
    /// that emits: a read's, the frame the socket was made in (the `spawn`).
    pub fn on(&self, event: &str, listener: &Listener<W, W>) {
        assert!(
            matches!(
                event,
                "data" | "end" | "finish" | "drain" | "error" | "close"
            ),
            "a socket event that is not ported: {event}"
        );
        if event == "data" {
            assert!(
                self.0.mode.replace(stream::Mode::Listeners) != stream::Mode::Iterator,
                "a socket consumed by for await and by listeners is not ported"
            );
        }
        self.0.emitter.on(event, listener);
        if event == "data" && socket_of(&self.0).readable {
            self.0.data_listening.set(true);
            if self.0.flowing.get() != Some(false) {
                stream::resume(&self.0);
            }
        }
    }

    /// `socket.removeListener(event, listener)`.
    pub fn remove_listener(&self, event: &str, listener: &Listener<W, W>) {
        self.0.emitter.remove_listener(event, listener);
    }

    /// `socket[Symbol.asyncIterator]()`: Node 24.22's iterator over the
    /// readable side (`for await (const chunk of child.stdout)` is
    /// `agen::for_await(&child.stdout)`); it ends at the socket's `end`.
    pub fn iter(&self) -> AsyncGen<W, W> {
        assert!(
            socket_of(&self.0).readable,
            "for await over a child's stdin"
        );
        assert!(
            self.0.mode.replace(stream::Mode::Iterator) != stream::Mode::Listeners,
            "a socket consumed by for await and by listeners is not ported"
        );
        stream::iterator(self.0.clone())
    }

    /// `socket.write(chunk, cb)`: `false` once the bytes buffered reach the
    /// high-water mark (wait for `'drain'`). `cb` gets the write's error, or
    /// `None` (on a tick when the write went at once, as Node's).
    pub fn write(&self, chunk: &[u8], cb: Option<Box<dyn FnOnce(Option<W>)>>) -> bool {
        write(&self.0, Rc::new(chunk.to_vec()), cb)
    }

    /// `socket.end()`.
    pub fn end(&self) {
        end(&self.0);
    }

    /// `socket.destroy(err)`.
    pub fn destroy(&self, error: Option<W>) {
        stream::destroy(&self.0, error);
    }

    /// `socket.destroyed`.
    pub fn destroyed(&self) -> bool {
        self.0.destroyed.get()
    }

    /// `socket.readable` (`false` for stdin and after the end).
    pub fn readable(&self) -> bool {
        stream::readable_alive(&self.0)
    }

    /// `socket.writableNeedDrain`.
    pub fn writable_need_drain(&self) -> bool {
        let socket = socket_of(&self.0);
        !self.0.destroyed.get() && !socket.ending.get() && socket.need_drain.get()
    }

    /// Whether the socket's handle has closed (its `close` event is due or
    /// emitted) and its descriptor is gone.
    pub fn handle_closed(&self) -> bool {
        socket_of(&self.0).handle.closed.get()
    }

    /// `stream.resume()` (`flushStdio`).
    pub(crate) fn resume(&self) {
        stream::resume(&self.0);
    }
}

impl IntoAsyncIterator<W, W> for &Socket {
    fn into_async_iterator(self) -> Rc<dyn AsyncIterator<W, W>> {
        self.iter().into_async_iterator()
    }
}

// --- pipeline into a child's stdin --------------------------------------

/// What `pipeline(source, child.stdin)` reads at the ledger's sites:
/// `Readable.from([input])` (a string or a `Buffer`), `Readable.from([])`, or
/// an async generator of strings (`update-index --index-info`'s rows).
pub enum PipeInput {
    Bytes(Rc<Vec<u8>>),
    Empty,
    Generator(AsyncGen<W, W>),
}

/// `await pipeline(source, child.stdin)` (`stream/promises`): the source's
/// chunks written in order, each `false` from `write` waited out until
/// `'drain'`, then `end()`; it fulfils once the stdin has finished (its
/// bytes are out and its shutdown done), on a tick after that, never in the
/// checkpoint that started it. It rejects with the first error: the
/// stdin's (a failed write, `EPIPE` when the child closed its end), the
/// generator's throw, or `ERR_STREAM_PREMATURE_CLOSE` when the stdin closes
/// before it finished (the child exited, and its exit destroyed the stdin).
/// On an error the stdin is destroyed with it (and the generator closed).
/// Node's job and tick counts inside are not reproduced (file 33).
pub fn pipeline(input: PipeInput, to: &Socket) -> Promise<(), W> {
    let stdin = to.clone();
    let watch = Rc::new(PipeWatch::default());
    {
        let watch_error = watch.clone();
        let on_error = Listener::new(move |error: &W| {
            watch_error.settle(Some(error.clone()));
            Ok(())
        });
        stdin.on("error", &on_error);
        let watch_finish = watch.clone();
        stdin.on(
            "finish",
            &Listener::new(move |_: &W| {
                watch_finish.settle(None);
                Ok(())
            }),
        );
        // `eos`'s `onclose` (`getEosOnCloseError`): the stream's `errored`
        // first (a write cancelled by the close: `ECANCELED`); else a stdin
        // ended with nothing left to write counts as finished
        // (`isWritableFinished(stream, false)`), else it closed before it
        // finished.
        let (watch_close, socket) = (watch.clone(), Rc::downgrade(&stdin.0));
        stdin.on(
            "close",
            &Listener::new(move |_: &W| {
                let outcome = socket.upgrade().and_then(|inner| {
                    if let Some(errored) = inner.errored.borrow().clone() {
                        return Some(errored);
                    }
                    let state = socket_of(&inner);
                    let ended =
                        state.finished.get() || (state.ended.get() && state.length.get() == 0);
                    (!ended).then(premature_close)
                });
                watch_close.settle(outcome);
                Ok(())
            }),
        );
        let watch_drain = watch.clone();
        stdin.on(
            "drain",
            &Listener::new(move |_: &W| {
                watch_drain.wake();
                Ok(())
            }),
        );
    }
    let pumped = {
        let (stdin, watch) = (stdin.clone(), watch.clone());
        js::async_fn::<(), W>(async move {
            if stdin.writable_need_drain() {
                watch.wait().await?;
            }
            match input {
                PipeInput::Empty => {}
                PipeInput::Bytes(bytes) => {
                    if !stdin.write(&bytes, None) {
                        watch.wait().await?;
                    }
                }
                PipeInput::Generator(rows) => {
                    let rows = agen::for_await(rows);
                    while let Some(row) = rows.next().await? {
                        let bytes = match &row {
                            W::Bytes(bytes) => bytes.as_ref().clone(),
                            other => crate::value::to_js_string(other)
                                .to_string_lossy()
                                .into_bytes(),
                        };
                        if !stdin.write(&bytes, None)
                            && let Err(error) = watch.wait().await
                        {
                            return Err(rows.close_throw(error).await);
                        }
                    }
                }
            }
            stdin.end();
            watch.wait().await?;
            Ok(Resolution::Value(()))
        })
    };
    let (promise, resolvers) = Promise::<(), W>::with_resolvers();
    pumped.react(move |outcome| {
        let outcome = match outcome {
            // A finished pump still takes the stdin's first error.
            Ok(()) => match watch.error() {
                Some(error) => Err(error),
                None => Ok(()),
            },
            Err(error) => Err(watch
                .error()
                .filter(|first| !is_premature(first))
                .unwrap_or(error)),
        };
        if let Err(error) = &outcome
            && !stdin.destroyed()
        {
            stdin.destroy(Some(error.clone()));
        }
        // `process.nextTick(callback, error)`.
        js::next_tick(move || match outcome {
            Ok(()) => resolvers.fulfill(()),
            Err(error) => resolvers.reject(error),
        });
    });
    promise
}

fn is_premature(error: &W) -> bool {
    super::code_of(error) == "ERR_STREAM_PREMATURE_CLOSE"
}

/// The stdin's end-of-stream state as `pipeline` watches it (`eos(dst)`, the
/// `'drain'` listener): the first error kept (a premature close replaced by a
/// real error), one waiter at a time (`wait()` of `pumpToNode`).
#[derive(Default)]
struct PipeWatch {
    done: Cell<bool>,
    error: RefCell<Option<W>>,
    waiter: RefCell<Option<Resolvers<(), W>>>,
}

impl PipeWatch {
    fn settle(&self, error: Option<W>) {
        if let Some(error) = error {
            let replace = match &*self.error.borrow() {
                None => true,
                Some(first) => is_premature(first) && !is_premature(&error),
            };
            if replace && !(self.done.get() && self.error.borrow().is_none()) {
                *self.error.borrow_mut() = Some(error);
            }
        }
        self.done.set(true);
        self.wake();
    }

    fn error(&self) -> Option<W> {
        self.error.borrow().clone()
    }

    fn wake(&self) {
        let waiter = self.waiter.borrow_mut().take();
        if let Some(waiter) = waiter {
            match self.error() {
                Some(error) => waiter.reject(error),
                None => waiter.fulfill(()),
            }
        }
    }

    fn wait(&self) -> Promise<(), W> {
        if let Some(error) = self.error() {
            return Promise::reject(error);
        }
        let (promise, resolvers) = Promise::with_resolvers();
        if self.done.get() {
            resolvers.fulfill(());
        } else {
            *self.waiter.borrow_mut() = Some(resolvers);
        }
        promise
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// A stdin whose child is gone (its socket ready, the peer closed):
    /// the exit waiter lets the writer's next attempt post first, so a
    /// failed write is seen before the exit, as libuv runs a poll batch's
    /// socket events before its signals.
    #[test]
    fn the_exit_waits_for_the_writer_s_next_attempt_when_its_socket_is_ready() {
        let (parent, child) = sys::socketpair().expect("socketpair");
        sys::close(child);
        let watch = Arc::new(WriterWatch::default());
        watch.begin(parent);
        let order = Arc::new(Mutex::new(Vec::new()));
        let writer = {
            let (watch, order) = (watch.clone(), order.clone());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                watch.attempt(Some(|| order.lock().expect("order").push("write EPIPE")));
            })
        };
        watch.before_exit(|| order.lock().expect("order").push("exit"));
        writer.join().expect("writer");
        assert_eq!(*order.lock().expect("order"), ["write EPIPE", "exit"]);
        sys::close(parent);
    }

    /// A stdin whose peer is alive and full (a grandchild holds it without
    /// reading): nothing is ready, the exit goes at once, and the waiting
    /// write is the one the exit's destroy cancels.
    #[test]
    fn the_exit_goes_at_once_when_the_waiting_write_s_socket_is_not_ready() {
        let (parent, child) = sys::socketpair().expect("socketpair");
        sys::set_nonblocking(parent).expect("non-blocking");
        let filler = vec![0u8; 65536];
        while sys::write(parent, &filler).expect("fill") > 0 {}
        let watch = WriterWatch::default();
        watch.begin(parent);
        let started = std::time::Instant::now();
        let mut posted = false;
        watch.before_exit(|| posted = true);
        assert!(posted);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "the exit waited for a writer that cannot write"
        );
        sys::close(parent);
        sys::close(child);
    }
}
