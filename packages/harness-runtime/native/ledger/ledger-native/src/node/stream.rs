//! `fs.createReadStream(path, { highWaterMark })` as the ledger's worker
//! consumes it (design file 32, package O2d, reduced by file 33): Node
//! 24.22's `ReadStream` (`lib/internal/fs/streams.js`) over the part of
//! `Readable` (`lib/internal/streams/readable.js`, `destroy.js`,
//! `end-of-stream.js`) that `for await` and the `data`, `end`, `error` and
//! `close` listeners reach, ported function by function with the same names:
//! `read`, `howMuchToRead`, `push`, `addChunk`, `onEofChunk`,
//! `emitReadable`, `flow`, `maybeReadMore`, `endReadable`, `resume`,
//! `destroy`, and the async iterator `createAsyncIterator`, an async
//! generator on `agen`.
//!
//! The rules it keeps (`node` module):
//! - **Rule 1.** The `open(2)`, each `read(2)` and the final `close(2)` run
//!   on the pool through `node::submit`, whose guard panics on a callback
//!   in the checkpoint that made the request; the callbacks run in units of
//!   their own, in the async context frame the request was made in (a libuv
//!   request's callback does).
//! - **Rule 2.** One stream's events keep Node's order: `open`, `ready`,
//!   the values in read order, then `end` (or `error`), then `close`; a
//!   `for await` over it ends after `close` (its end-of-stream callback
//!   waits for it), and nothing is delivered after `close`.
//! - **Rule 3.** The read cut is Node's: `_read(highWaterMark)` reads that
//!   many bytes at the descriptor's offset (a short read only at the end of
//!   a regular file), one read in flight at most, and the next is asked for
//!   while fewer than `highWaterMark` bytes are buffered. `for await` takes
//!   everything buffered (Node 24.22's `read()` in paused mode), which for a
//!   regular file that does not change is exactly one read.
//!
//! An early exit from `for await` (`break`, `return`, a throw, the host's
//! `stream-return`) runs the iterator's `finally`, which destroys the
//! stream with an `AbortError` (Node's `destroyer`); a read in flight is
//! waited for, then the descriptor is closed, then `close` is emitted.
//!
//! Not built (a port that needs them is refused: there is no API): object
//! mode, encodings (`setEncoding`), `unshift`, `pause`/`resume` by hand,
//! `pipe`, `start`/`end`, a stream over a `FileHandle` or an `fd`,
//! `readable` listeners of a port's own, and one stream consumed both by
//! `for await` and by listeners (it panics). Writable streams, `pipeline`
//! and `finished` are only reached through a child process's stdin (the
//! next package).
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use ledger_core::js::JsStr;
use ledger_io::fs as lio;

use super::{IoError, error_value};
use crate::agen::{self, Abrupt, AsyncGen, AsyncIterator, Co, IntoAsyncIterator};
use crate::emitter::{Emitter, Listener};
use crate::js::{self, Promise, Resolution, Resolvers};
use crate::value::{JsError, W};

/// `createReadStream`'s default `highWaterMark`.
pub const DEFAULT_HIGH_WATER_MARK: usize = 64 * 1024;

/// `createReadStream(path, options)`'s options the sites pass: only
/// `highWaterMark` (64 KiB by default; `session-mutations.js`'s receipt byte
/// stream passes 128 KiB, and its cut reaches the host).
#[derive(Clone, Copy, Debug)]
pub struct ReadStreamOptions {
    pub high_water_mark: usize,
}

impl ReadStreamOptions {
    /// `createReadStream(path)`: `{ highWaterMark: 64 * 1024 }`.
    pub const DEFAULT: ReadStreamOptions = ReadStreamOptions {
        high_water_mark: DEFAULT_HIGH_WATER_MARK,
    };
}

/// What the async iterator's end-of-stream callback has said: `undefined`
/// (nothing yet), `null` (the stream finished), or an error.
#[derive(Clone)]
enum Outcome {
    Pending,
    Finished,
    Failed(W),
}

/// How a stream is consumed: `for await` or listeners, never both.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    None,
    Iterator,
    Listeners,
}

type IoDone = Box<dyn FnOnce(Option<W>)>;

struct Inner {
    path: String,
    // ReadStream
    fd: Cell<Option<i32>>,
    bytes_read: Cell<u64>,
    performing_io: Cell<bool>,
    io_done: RefCell<Vec<IoDone>>,
    // ReadableState (byte mode, no decoder, autoDestroy and emitClose on)
    high_water_mark: usize,
    buffer: RefCell<VecDeque<Rc<Vec<u8>>>>,
    length: Cell<usize>,
    constructed: Cell<bool>,
    reading: Cell<bool>,
    sync: Cell<bool>,
    ended: Cell<bool>,
    end_scheduled: Cell<bool>,
    end_emitted: Cell<bool>,
    need_readable: Cell<bool>,
    emitted_readable: Cell<bool>,
    eof_readable_pending: Cell<bool>,
    reading_more: Cell<bool>,
    readable_listening: Cell<bool>,
    data_listening: Cell<bool>,
    /// `null` (never set), `true` or `false`.
    flowing: Cell<Option<bool>>,
    resume_scheduled: Cell<bool>,
    destroyed: Cell<bool>,
    errored: RefCell<Option<W>>,
    error_emitted: Cell<bool>,
    closed: Cell<bool>,
    close_emitted: Cell<bool>,
    /// `once(kDestroy, …)` of a destroy made before the open finished.
    on_destroy_after_construct: RefCell<Vec<IoDone>>,
    emitter: Emitter<W, W>,
    mode: Cell<Mode>,
    // createAsyncIterator's `callback` and its end-of-stream state
    callback: RefCell<Option<Resolvers<(), W>>>,
    outcome: RefCell<Outcome>,
    eos_attached: Cell<bool>,
    eos_readable_finished: Cell<bool>,
    eos_called: Cell<bool>,
}

/// A file read stream (`fs.ReadStream`). Clones are the same stream.
#[derive(Clone)]
pub struct ReadStream(Rc<Inner>);

/// `fs.createReadStream(path, { highWaterMark })`: the open is asked for on
/// the next tick, as `ReadStream`'s `_construct` is.
pub fn create_read_stream(path: &str, options: ReadStreamOptions) -> ReadStream {
    assert!(
        options.high_water_mark > 0,
        "a read stream with highWaterMark 0 is not ported"
    );
    let inner = Rc::new(Inner {
        path: path.to_owned(),
        fd: Cell::new(None),
        bytes_read: Cell::new(0),
        performing_io: Cell::new(false),
        io_done: RefCell::new(Vec::new()),
        high_water_mark: options.high_water_mark,
        buffer: RefCell::new(VecDeque::new()),
        length: Cell::new(0),
        constructed: Cell::new(false),
        reading: Cell::new(false),
        sync: Cell::new(true),
        ended: Cell::new(false),
        end_scheduled: Cell::new(false),
        end_emitted: Cell::new(false),
        need_readable: Cell::new(false),
        emitted_readable: Cell::new(false),
        eof_readable_pending: Cell::new(false),
        reading_more: Cell::new(false),
        readable_listening: Cell::new(false),
        data_listening: Cell::new(false),
        flowing: Cell::new(None),
        resume_scheduled: Cell::new(false),
        destroyed: Cell::new(false),
        errored: RefCell::new(None),
        error_emitted: Cell::new(false),
        closed: Cell::new(false),
        close_emitted: Cell::new(false),
        on_destroy_after_construct: RefCell::new(Vec::new()),
        emitter: Emitter::new(|error: &W| error.clone()),
        mode: Cell::new(Mode::None),
        callback: RefCell::new(None),
        outcome: RefCell::new(Outcome::Pending),
        eos_attached: Cell::new(false),
        eos_readable_finished: Cell::new(false),
        eos_called: Cell::new(false),
    });
    let stream = inner.clone();
    // destroyImpl.construct: `process.nextTick(constructNT, stream)`.
    js::next_tick(move || construct(&stream));
    ReadStream(inner)
}

/// An `AbortError` (`destroyer`'s error for a stream left before its end).
fn abort_error() -> W {
    let mut error = JsError::new("AbortError", "The operation was aborted");
    error.set_field("code", W::String(JsStr::from("ABORT_ERR")));
    W::Error(Rc::new(error))
}

/// `constructNT`: `_construct` opens the file (`fs.open(path, 'r', 0o666)`);
/// its callback queues `onConstruct` on a tick.
fn construct(stream: &Rc<Inner>) {
    let path = stream.path.clone();
    let made = stream.clone();
    super::submit(
        move || lio::open_raw(&path, lio::constants::O_RDONLY, 0o666),
        move |opened: Result<i32, IoError>| match opened {
            Err(error) => {
                let error = error_value(&error);
                let made = made.clone();
                js::next_tick(move || on_construct(&made, Some(error)));
            }
            Ok(fd) => {
                made.fd.set(Some(fd));
                // `callback()` queues onConstruct; then 'open' and 'ready'.
                let later = made.clone();
                js::next_tick(move || on_construct(&later, None));
                emit(&made, "open", &W::Number(f64::from(fd)));
                emit(&made, "ready", &W::Undefined);
            }
        },
    );
}

/// `onConstruct(err)`.
fn on_construct(stream: &Rc<Inner>, error: Option<W>) {
    stream.constructed.set(true);
    if stream.destroyed.get() {
        // `stream.emit(kDestroy, err)`.
        let waiting = std::mem::take(&mut *stream.on_destroy_after_construct.borrow_mut());
        for waiter in waiting {
            waiter(error.clone());
        }
    } else if let Some(error) = error {
        error_or_destroy(stream, error);
    } else if stream.need_readable.get() {
        // `stream.emit(kConstruct)` → `ReadableState[kOnConstructed]`.
        maybe_read_more(stream);
    }
}

/// `stream.emit(event, value)`: an `error` nobody listens to is an uncaught
/// exception in Node (the worker dies), so here it ends the process.
fn emit(stream: &Rc<Inner>, event: &str, value: &W) {
    if let Err(error) = stream.emitter.emit(event, value) {
        let text = match &error {
            W::Error(made) => made.message.to_string_lossy(),
            _ => String::from("a thrown value"),
        };
        panic!(
            "a read stream's '{event}' listener threw, or an 'error' nobody listened to: {text}"
        );
    }
}

/// `errorOrDestroy(stream, err)` with `autoDestroy`: `destroy(err)`.
fn error_or_destroy(stream: &Rc<Inner>, error: W) {
    if stream.destroyed.get() {
        return;
    }
    destroy(stream, Some(error));
}

/// `howMuchToRead(n, state)`; `None` is `NaN` (`read()`).
fn how_much_to_read(stream: &Inner, n: Option<usize>) -> usize {
    let length = stream.length.get();
    if n == Some(0) || (length == 0 && stream.ended.get()) {
        return 0;
    }
    match n {
        None => {
            if stream.flowing.get() == Some(true) && length > 0 {
                stream
                    .buffer
                    .borrow()
                    .front()
                    .map_or(0, |chunk| chunk.len())
            } else {
                length
            }
        }
        Some(n) if n <= length => n,
        Some(_) => {
            if stream.ended.get() {
                length
            } else {
                0
            }
        }
    }
}

/// `fromList(n, state)`: the first `n` buffered bytes as one chunk (the
/// first chunk itself when it is exactly `n`).
fn from_list(stream: &Inner, n: usize) -> Rc<Vec<u8>> {
    let mut buffer = stream.buffer.borrow_mut();
    if buffer.front().is_some_and(|first| first.len() == n) {
        return buffer.pop_front().expect("a buffered chunk");
    }
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        let Some(first) = buffer.pop_front() else {
            break;
        };
        let want = n - out.len();
        if first.len() <= want {
            out.extend_from_slice(&first);
        } else {
            out.extend_from_slice(&first[..want]);
            buffer.push_front(Rc::new(first[want..].to_vec()));
        }
    }
    Rc::new(out)
}

/// `Readable.prototype.read(n)`; `None` is `read()`.
fn read(stream: &Rc<Inner>, n_orig: Option<usize>) -> Option<Rc<Vec<u8>>> {
    let hwm = stream.high_water_mark;
    if n_orig != Some(0) {
        stream.emitted_readable.set(false);
        stream.eof_readable_pending.set(false);
    }
    let length = stream.length.get();
    if n_orig == Some(0) && stream.need_readable.get() && (length >= hwm || stream.ended.get()) {
        if length == 0 && stream.ended.get() {
            end_readable(stream);
        } else {
            emit_readable(stream);
        }
        return None;
    }
    let mut n = how_much_to_read(stream, n_orig);
    if n == 0 && stream.ended.get() {
        if stream.length.get() == 0 {
            end_readable(stream);
        }
        return None;
    }
    let mut do_read = stream.need_readable.get();
    let length = stream.length.get();
    if length == 0 || length - n < hwm {
        do_read = true;
    }
    let blocked = stream.reading.get()
        || stream.ended.get()
        || stream.destroyed.get()
        || stream.errored.borrow().is_some()
        || !stream.constructed.get();
    if !blocked && do_read {
        stream.reading.set(true);
        stream.sync.set(true);
        if stream.length.get() == 0 {
            stream.need_readable.set(true);
        }
        start_read(stream, hwm);
        stream.sync.set(false);
        if !stream.reading.get() {
            n = how_much_to_read(stream, n_orig);
        }
    }
    let taken = if n > 0 {
        Some(from_list(stream, n))
    } else {
        None
    };
    match &taken {
        None => {
            if stream.length.get() <= hwm {
                stream.need_readable.set(true);
            }
            n = 0;
        }
        Some(_) => stream.length.set(stream.length.get() - n),
    }
    if stream.length.get() == 0 {
        if !stream.ended.get() {
            stream.need_readable.set(true);
        }
        if n_orig != Some(n) && stream.ended.get() {
            end_readable(stream);
        }
    }
    if let Some(chunk) = &taken
        && !stream.error_emitted.get()
        && !stream.close_emitted.get()
    {
        emit(stream, "data", &W::Bytes(chunk.clone()));
    }
    taken
}

/// `ReadStream.prototype._read(n)`: one `read(fd, n)` at the descriptor's
/// offset; its callback pushes the bytes, or `null` at the end.
fn start_read(stream: &Rc<Inner>, n: usize) {
    let fd = stream
        .fd
        .get()
        .expect("a constructed read stream has its descriptor");
    stream.performing_io.set(true);
    let done = stream.clone();
    super::submit(
        move || lio::read(fd, n, None),
        move |result: Result<Vec<u8>, IoError>| {
            done.performing_io.set(false);
            if done.destroyed.get() {
                // `this.emit(kIoDone, er)`.
                let error = result.err().map(|error| error_value(&error));
                let waiting = std::mem::take(&mut *done.io_done.borrow_mut());
                for waiter in waiting {
                    waiter(error.clone());
                }
                return;
            }
            match result {
                Err(error) => error_or_destroy(&done, error_value(&error)),
                Ok(bytes) if !bytes.is_empty() => {
                    done.bytes_read
                        .set(done.bytes_read.get() + bytes.len() as u64);
                    push(&done, Some(bytes));
                }
                Ok(_) => push(&done, None),
            }
        },
    );
}

/// `readableAddChunkPushByteMode(stream, state, chunk)`.
fn push(stream: &Rc<Inner>, chunk: Option<Vec<u8>>) {
    let Some(chunk) = chunk else {
        stream.reading.set(false);
        on_eof_chunk(stream);
        return;
    };
    if chunk.is_empty() {
        stream.reading.set(false);
        maybe_read_more(stream);
        return;
    }
    assert!(!stream.ended.get(), "a read stream pushed after its end");
    if stream.destroyed.get() || stream.errored.borrow().is_some() {
        return;
    }
    stream.reading.set(false);
    add_chunk(stream, Rc::new(chunk));
}

/// `addChunk(stream, state, chunk, false)`.
fn add_chunk(stream: &Rc<Inner>, chunk: Rc<Vec<u8>>) {
    if stream.flowing.get() == Some(true)
        && !stream.sync.get()
        && stream.data_listening.get()
        && stream.length.get() == 0
    {
        emit(stream, "data", &W::Bytes(chunk));
    } else {
        stream.length.set(stream.length.get() + chunk.len());
        stream.buffer.borrow_mut().push_back(chunk);
        if stream.need_readable.get() {
            emit_readable(stream);
        }
    }
    maybe_read_more(stream);
}

/// `onEofChunk(stream, state)`.
fn on_eof_chunk(stream: &Rc<Inner>) {
    if stream.ended.get() {
        return;
    }
    stream.ended.set(true);
    if stream.sync.get() {
        if stream.flowing.get() == Some(true)
            || stream.need_readable.get()
            || stream.readable_listening.get()
        {
            emit_readable(stream);
        } else {
            stream.eof_readable_pending.set(true);
        }
    } else {
        stream.need_readable.set(false);
        stream.emitted_readable.set(true);
        emit_readable_now(stream);
    }
}

/// `emitReadable(stream)`: `emitReadable_` on the next tick, once.
fn emit_readable(stream: &Rc<Inner>) {
    stream.need_readable.set(false);
    if !stream.emitted_readable.get() {
        stream.emitted_readable.set(true);
        let later = stream.clone();
        js::next_tick(move || emit_readable_now(&later));
    }
}

/// `emitReadable_(stream)`: `'readable'` (the async iterator's `next`
/// callback is its one listener), then `flow`.
fn emit_readable_now(stream: &Rc<Inner>) {
    if !stream.destroyed.get()
        && stream.errored.borrow().is_none()
        && (stream.length.get() > 0 || stream.ended.get())
    {
        // `stream.emit('readable')`: the iterator's `next` with this === stream.
        if stream.readable_listening.get() {
            let waiting = stream.callback.borrow_mut().take();
            if let Some(resolvers) = waiting {
                resolvers.fulfill(());
            }
        }
        stream.emitted_readable.set(false);
    }
    if stream.flowing.get() != Some(true)
        && !stream.ended.get()
        && stream.length.get() <= stream.high_water_mark
    {
        stream.need_readable.set(true);
    }
    flow(stream);
}

/// `flow(stream)`: in flowing mode, read until nothing is buffered.
fn flow(stream: &Rc<Inner>) {
    while stream.flowing.get() == Some(true) && read(stream, None).is_some() {}
}

/// `maybeReadMore(stream, state)`: `maybeReadMore_` on the next tick.
fn maybe_read_more(stream: &Rc<Inner>) {
    if !stream.reading_more.get() && !stream.reading.get() && stream.constructed.get() {
        stream.reading_more.set(true);
        let later = stream.clone();
        js::next_tick(move || maybe_read_more_now(&later));
    }
}

/// `maybeReadMore_(stream, state)`: `read(0)` while below the high-water
/// mark (or flowing with nothing buffered) and no read is in flight.
fn maybe_read_more_now(stream: &Rc<Inner>) {
    while !stream.reading.get()
        && !stream.ended.get()
        && (stream.length.get() < stream.high_water_mark
            || (stream.flowing.get() == Some(true) && stream.length.get() == 0))
    {
        let length = stream.length.get();
        read(stream, Some(0));
        if length == stream.length.get() {
            break;
        }
    }
    stream.reading_more.set(false);
}

/// `endReadable(stream)`: `endReadableNT` on the next tick, once.
fn end_readable(stream: &Rc<Inner>) {
    if !stream.end_emitted.get() && !stream.end_scheduled.get() {
        stream.ended.set(true);
        stream.end_scheduled.set(true);
        let later = stream.clone();
        js::next_tick(move || end_readable_now(&later));
    }
}

/// `endReadableNT`: `'end'`, then `autoDestroy`'s `destroy()`.
fn end_readable_now(stream: &Rc<Inner>) {
    stream.end_scheduled.set(false);
    if stream.errored.borrow().is_none()
        && !stream.close_emitted.get()
        && !stream.end_emitted.get()
        && stream.length.get() == 0
    {
        stream.end_emitted.set(true);
        emit(stream, "end", &W::Undefined);
        eos_on_end(stream);
        destroy(stream, None);
    }
}

/// `Readable.prototype.resume()` and `resume_` on the next tick.
fn resume(stream: &Rc<Inner>) {
    if stream.flowing.get() == Some(true) {
        return;
    }
    stream.flowing.set(Some(!stream.readable_listening.get()));
    if !stream.resume_scheduled.get() {
        stream.resume_scheduled.set(true);
        let later = stream.clone();
        js::next_tick(move || {
            if !later.reading.get() {
                read(&later, Some(0));
            }
            later.resume_scheduled.set(false);
            flow(&later);
            if later.flowing.get() == Some(true) && !later.reading.get() {
                read(&later, Some(0));
            }
        });
    }
}

/// `destroyImpl.destroy(err)`.
fn destroy(stream: &Rc<Inner>, error: Option<W>) {
    if stream.destroyed.get() {
        return;
    }
    if let Some(error) = &error
        && stream.errored.borrow().is_none()
    {
        *stream.errored.borrow_mut() = Some(error.clone());
    }
    stream.destroyed.set(true);
    if !stream.constructed.get() {
        let later = stream.clone();
        stream
            .on_destroy_after_construct
            .borrow_mut()
            .push(Box::new(move |construct_error: Option<W>| {
                start_destroy(&later, construct_error.or(error));
            }));
    } else {
        start_destroy(stream, error);
    }
}

/// `_destroy(self, err, cb)` → `ReadStream.prototype._destroy`: a read in
/// flight is waited for (`kIoDone`), then the descriptor is closed.
fn start_destroy(stream: &Rc<Inner>, error: Option<W>) {
    if stream.performing_io.get() {
        let later = stream.clone();
        stream
            .io_done
            .borrow_mut()
            .push(Box::new(move |io_error: Option<W>| {
                close(&later, error.or(io_error));
            }));
    } else {
        close(stream, error);
    }
}

/// `close(stream, err, cb)`: `fs.close(fd)` on the pool, then `onDestroy`.
///
/// Never while a `read(2)` of this stream is being performed (`_destroy`
/// waits for `kIoDone`): a descriptor closed under a read in flight frees its
/// number, another `open` can get it, and the read then consumes the other
/// file's bytes. No output shows that, so it is asserted here, in every
/// build.
fn close(stream: &Rc<Inner>, error: Option<W>) {
    assert!(
        !stream.performing_io.get(),
        "a read stream's descriptor closed while its read is in flight (node::stream, kIoDone)"
    );
    let Some(fd) = stream.fd.take() else {
        on_destroy(stream, error);
        return;
    };
    let later = stream.clone();
    super::submit(
        move || lio::close(fd),
        move |closed: Result<(), IoError>| {
            let close_error = closed.err().map(|error| error_value(&error));
            on_destroy(&later, close_error.or(error));
        },
    );
}

/// `onDestroy(err)`: `'error'` (when there is one) and `'close'` on the
/// next tick (`emitErrorCloseNT`, `emitCloseNT`).
fn on_destroy(stream: &Rc<Inner>, error: Option<W>) {
    if let Some(error) = &error
        && stream.errored.borrow().is_none()
    {
        *stream.errored.borrow_mut() = Some(error.clone());
    }
    stream.closed.set(true);
    let later = stream.clone();
    js::next_tick(move || {
        if let Some(error) = error
            && !later.error_emitted.get()
        {
            later.error_emitted.set(true);
            // The async iterator's end-of-stream listener is an `error`
            // listener of its own: with it, an error is never uncaught.
            if !later.eos_attached.get() || later.emitter.listener_count("error") > 0 {
                emit(&later, "error", &error);
            }
            eos_on_error(&later, error);
        }
        later.close_emitted.set(true);
        emit(&later, "close", &W::Undefined);
        eos_on_close(&later);
    });
}

// The async iterator's end-of-stream callback (`eos(stream, { writable:
// false }, cb)` with `willEmitClose`): an error calls it with the error; the
// end does not (the close will come); the close calls it, with a premature
// close error when the stream did not end.

fn eos_callback(stream: &Rc<Inner>, error: Option<W>) {
    if !stream.eos_attached.get() || stream.eos_called.replace(true) {
        return;
    }
    // `error = err ? aggregateTwoErrors(error, err) : null; callback(); callback = nop;`
    let next = match error {
        Some(error) => match &*stream.outcome.borrow() {
            Outcome::Failed(existing) => Outcome::Failed(existing.clone()),
            _ => Outcome::Failed(error),
        },
        None => Outcome::Finished,
    };
    *stream.outcome.borrow_mut() = next;
    let waiting = stream.callback.borrow_mut().take();
    if let Some(resolvers) = waiting {
        resolvers.fulfill(());
    }
}

fn eos_on_end(stream: &Rc<Inner>) {
    stream.eos_readable_finished.set(true);
}

fn eos_on_error(stream: &Rc<Inner>, error: W) {
    eos_callback(stream, Some(error));
}

fn eos_on_close(stream: &Rc<Inner>) {
    if stream.eos_readable_finished.get() {
        eos_callback(stream, None);
    } else {
        let mut error = JsError::new("Error", "Premature close");
        error.set_field("code", W::String(JsStr::from("ERR_STREAM_PREMATURE_CLOSE")));
        eos_callback(stream, Some(W::Error(Rc::new(error))));
    }
}

/// `stream.on('readable', next)` of `createAsyncIterator`.
fn attach_iterator(stream: &Rc<Inner>) {
    if !stream.end_emitted.get() && !stream.readable_listening.get() {
        stream.readable_listening.set(true);
        stream.need_readable.set(true);
        stream.flowing.set(Some(false));
        stream.emitted_readable.set(false);
        if stream.length.get() > 0 {
            emit_readable(stream);
        } else {
            if stream.eof_readable_pending.replace(false) {
                emit_readable(stream);
            }
            if !stream.reading.get() {
                let later = stream.clone();
                js::next_tick(move || {
                    read(&later, Some(0));
                });
            }
        }
    }
    stream.eos_attached.set(true);
    if stream.close_emitted.get() {
        // `eos` on a stream already closed: its result on the next tick.
        let later = stream.clone();
        js::next_tick(move || eos_on_close(&later));
    }
}

/// `await new Promise(next)`: the iterator waits for `'readable'` or the
/// end-of-stream callback.
fn wait(stream: &Rc<Inner>) -> Promise<(), W> {
    let (promise, resolvers) = Promise::with_resolvers();
    *stream.callback.borrow_mut() = Some(resolvers);
    promise
}

/// `createAsyncIterator(stream)`'s `finally`: `destroyer(stream, null)`,
/// which destroys a stream that has not finished with an `AbortError`.
fn iterator_finally(stream: &Rc<Inner>) {
    if stream.destroyed.get() {
        return;
    }
    let finished = stream.end_emitted.get() || stream.error_emitted.get();
    destroy(stream, if finished { None } else { Some(abort_error()) });
}

/// `async function* createAsyncIterator(stream)` of Node 24.22.
fn iterator(stream: Rc<Inner>) -> AsyncGen<W, W> {
    agen::async_gen(move |co: Co<W, W>| async move {
        attach_iterator(&stream);
        let body: Result<(), Abrupt<W, W>> = async {
            loop {
                let chunk = if stream.destroyed.get() {
                    None
                } else {
                    read(&stream, None)
                };
                if let Some(chunk) = chunk {
                    co.yield_(Resolution::Value(W::Bytes(chunk))).await?;
                    continue;
                }
                let outcome = stream.outcome.borrow().clone();
                match outcome {
                    Outcome::Failed(error) => return Err(Abrupt::Throw(error)),
                    // `return;`: no value, no job.
                    Outcome::Finished => return Err(Abrupt::Return(W::Undefined)),
                    Outcome::Pending => wait(&stream).await?,
                }
            }
        }
        .await;
        // `catch (err) { error = aggregateTwoErrors(error, err); throw error; }`
        if let Err(Abrupt::Throw(error)) = &body
            && matches!(*stream.outcome.borrow(), Outcome::Pending)
        {
            *stream.outcome.borrow_mut() = Outcome::Failed(error.clone());
        }
        // `finally`
        iterator_finally(&stream);
        match body {
            Err(Abrupt::Return(value)) if value.is_undefined() => Ok(()),
            other => other,
        }
    })
}

impl ReadStream {
    /// `stream[Symbol.asyncIterator]()`: Node 24.22's async generator over
    /// the stream, yielding `Buffer`s (`W::Bytes`, which keep the caller's
    /// frame after a `yield`). `for await (const chunk of stream)` is
    /// `agen::for_await(stream)`.
    pub fn iter(&self) -> AsyncGen<W, W> {
        assert!(
            self.0.mode.replace(Mode::Iterator) != Mode::Listeners,
            "a read stream consumed by for await and by listeners is not ported"
        );
        iterator(self.0.clone())
    }

    /// `stream.on(event, listener)` for `'data'` (which starts the flow, as
    /// Node's `on('data')` resumes the stream), `'end'`, `'error'`,
    /// `'close'`, `'open'` and `'ready'`. Listeners run in the frame of the
    /// callback that emits (a read's, which is the frame its request was
    /// made in).
    pub fn on(&self, event: &str, listener: &Listener<W, W>) {
        assert!(
            matches!(event, "data" | "end" | "error" | "close" | "open" | "ready"),
            "a read stream event that is not ported: {event}"
        );
        assert!(
            self.0.mode.replace(Mode::Listeners) != Mode::Iterator,
            "a read stream consumed by for await and by listeners is not ported"
        );
        self.0.emitter.on(event, listener);
        if event == "data" {
            self.0.data_listening.set(true);
            if self.0.flowing.get() != Some(false) {
                resume(&self.0);
            }
        }
    }

    /// `stream.destroy(err)`.
    pub fn destroy(&self, error: Option<W>) {
        destroy(&self.0, error);
    }

    /// `stream.destroyed`.
    pub fn destroyed(&self) -> bool {
        self.0.destroyed.get()
    }

    /// `stream.closed`: the descriptor is closed (and `'close'` is queued
    /// or emitted).
    pub fn closed(&self) -> bool {
        self.0.closed.get()
    }

    /// `stream.bytesRead`.
    pub fn bytes_read(&self) -> u64 {
        self.0.bytes_read.get()
    }

    /// Whether a `read(2)` is in flight (`kIsPerformingIO`; tests wait for
    /// it to settle before they change the file under the stream).
    pub fn performing_io(&self) -> bool {
        self.0.performing_io.get()
    }

    /// `stream.path`.
    pub fn path(&self) -> &str {
        &self.0.path
    }
}

impl IntoAsyncIterator<W, W> for ReadStream {
    fn into_async_iterator(self) -> Rc<dyn AsyncIterator<W, W>> {
        self.iter().into_async_iterator()
    }
}

impl IntoAsyncIterator<W, W> for &ReadStream {
    fn into_async_iterator(self) -> Rc<dyn AsyncIterator<W, W>> {
        self.iter().into_async_iterator()
    }
}
