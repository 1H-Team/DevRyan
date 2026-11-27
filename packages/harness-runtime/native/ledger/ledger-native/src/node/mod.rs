//! What the ledger's worker calls of Node's own library on top of the event
//! loop (design file 32, packages O2f, O2d and O2e, in the reduced form of
//! file 33): `fs.promises` and its `FileHandle` ([`fs`]), the file read
//! stream ([`stream`]), the promisified `zlib.deflate` ([`zlib`]), and
//! `child_process.spawn` ([`child`]) with its stdio sockets and `pipeline`
//! into its stdin ([`net`]). Part of the job layer (it is the only
//! ledger-native code that calls `ledger-io`'s blocking functions and system
//! calls; the porting lint refuses them in ported modules).
//!
//! The rules (`packages/harness-runtime/DOCUMENTATION.md`, "Node's library
//! on the loop"):
//!
//! 1. A completion never settles in the checkpoint that started it. Every
//!    call that does I/O runs its system calls on the pool and settles in a
//!    unit of its own. The guard is in three places a call cannot go around:
//!    [`submit`] (the module's only way to the pool, which `io` and the read
//!    stream use) records the checkpoint epoch where the work starts and
//!    panics, in every build, if it finds the same epoch where it is
//!    delivered; every `fs.promises` call and every `FileHandle` method
//!    panics if its promise is already settled when it returns, and a
//!    method's completion checks the epoch again. A call Node answers
//!    without I/O (a read or write of no bytes, a closed handle, a `close`
//!    of a handle already closed or closing) settles as Node's does, without
//!    a unit, on its own explicit path.
//! 2. The events of one source keep their order: a stream's values in order,
//!    then `end` or `error`, then `close`.
//! 3. The file read stream reads `highWaterMark` bytes a time, a short read
//!    at the end, as Node's `ReadStream` does: the execution receipt's byte
//!    stream hands each read to the host as one message.
//!
//! What is free (file 33): how many jobs and loop round trips Node spends
//! inside a call (a composite call such as `readFile` is one unit here, four
//! round trips in Node 24.22), and the order between independent
//! completions.
//!
//! Threading: the work closures run on the pool's threads and only compute
//! (system calls and copies); they hold no promise, task, job or `W`. Only
//! the loop thread makes, settles or awaits a promise.
#![forbid(unsafe_code)]

use std::rc::Rc;

use ledger_core::js::JsStr;

use crate::js::{self, Promise};
use crate::value::{JsError, W};

pub mod child;
pub mod fs;
pub mod net;
pub mod odb;
pub mod stream;
pub mod zlib;

/// What `ledger-io` reports a failed call as.
pub type IoError = ledger_io::fs::Error;

/// Node's error object for a failed file-system call: a libuv error
/// (`UVException`: `errno`, `code`, `syscall`, `path`, `dest`, the message
/// `<code>: <text>, <syscall> '<path>' -> '<dest>'`), or one of Node's own
/// (`ERR_FS_EISDIR` is a `SystemError` with a positive `errno`;
/// `ERR_FS_FILE_TOO_LARGE` a `RangeError`; `ERR_INVALID_ARG_VALUE` a
/// `TypeError`).
pub fn error_value(error: &IoError) -> W {
    let name = match error.code.as_str() {
        "ERR_FS_EISDIR" => "SystemError",
        "ERR_FS_FILE_TOO_LARGE" | "ERR_OUT_OF_RANGE" => "RangeError",
        "ERR_INVALID_ARG_VALUE" | "ERR_INVALID_ARG_TYPE" => "TypeError",
        _ => "Error",
    };
    let mut made = JsError::new(name, &error.message);
    let libuv = error.errno.is_some_and(|errno| errno < 0);
    if libuv {
        if let Some(errno) = error.errno {
            made.set_field("errno", W::Number(f64::from(errno)));
        }
        made.set_field("code", W::String(JsStr::from(error.code.as_str())));
    } else {
        made.set_field("code", W::String(JsStr::from(error.code.as_str())));
        if let Some(errno) = error.errno {
            made.set_field("errno", W::Number(f64::from(errno)));
        }
    }
    if let Some(syscall) = error.syscall {
        made.set_field("syscall", W::String(JsStr::from(syscall)));
    }
    if let Some(path) = &error.path {
        made.set_field("path", W::String(JsStr::from(path.as_str())));
    }
    if let Some(dest) = &error.dest {
        made.set_field("dest", W::String(JsStr::from(dest.as_str())));
    }
    W::Error(Rc::new(made))
}

/// The `code` of a rejection (`cause.code`), or `""`.
pub fn code_of(reason: &W) -> String {
    match reason {
        W::Error(error) => match error.field("code") {
            Some(W::String(code)) => code.to_string_lossy(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

/// Starts one piece of I/O: `work` runs on the pool, and the promise settles
/// with its result (a failure as Node's error object) in a unit of its own.
/// Panics if it would settle in the checkpoint that started it (rule 1).
pub(crate) fn io<T, F>(work: F) -> Promise<T, W>
where
    T: Clone + Send + 'static,
    F: FnOnce() -> Result<T, IoError> + Send + 'static,
{
    io_with(work, Ok)
}

/// [`io`] whose result is finished on the loop thread before it settles
/// (`finish` makes what cannot cross threads, such as a `FileHandle` from
/// its descriptor, or turns a result into Node's own error).
pub(crate) fn io_with<R, T, F, G>(work: F, finish: G) -> Promise<T, W>
where
    R: Send + 'static,
    T: Clone + 'static,
    F: FnOnce() -> Result<R, IoError> + Send + 'static,
    G: FnOnce(R) -> Result<T, W> + 'static,
{
    let (promise, resolvers) = Promise::with_resolvers();
    submit(work, move |result: Result<R, IoError>| {
        match result.map_err(|error| error_value(&error)).and_then(finish) {
            Ok(value) => resolvers.fulfill(value),
            Err(reason) => resolvers.reject(reason),
        }
    });
    promise
}

/// The module's one way to the pool (`host::submit`), with rule 1's guard:
/// the epoch is recorded where the work is submitted and checked where
/// `deliver` runs, so every completion of the module (`io`, the read
/// stream's open, reads and close, a handle's deferred close) panics if it
/// runs in the checkpoint that started it. The porting lint refuses
/// `host::submit` anywhere else in `node/`.
pub(crate) fn submit<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    deliver: impl FnOnce(T) + 'static,
) {
    let started = js::checkpoint_epoch();
    crate::host::submit(work, move |value: T| {
        settled_in_a_later_checkpoint(started);
        deliver(value);
    });
}

/// A long-lived source of units (a child's output reader, its exit waiter,
/// a write in flight): `host::open_source` with rule 1's guard, the
/// module's one way to it (the porting lint refuses `host::open_source`
/// elsewhere in `node/`). The epoch is recorded where the source opens and
/// again where its reading is started anew (`readStart`); every delivery
/// panics, in every build, if it runs in that checkpoint.
pub(crate) struct Source<T> {
    poster: crate::host::Poster,
    started: Rc<std::cell::Cell<u64>>,
    _value: std::marker::PhantomData<T>,
}

impl<T: Send + 'static> Source<T> {
    /// Where the source's thread posts.
    pub(crate) fn poster(&self) -> SourcePoster<T> {
        SourcePoster {
            poster: self.poster.clone(),
            _value: std::marker::PhantomData,
        }
    }

    /// The source's work starts anew here (`readStart`).
    pub(crate) fn restarted(&self) {
        self.started.set(js::checkpoint_epoch());
    }

    /// Closes it: nothing more is delivered.
    pub(crate) fn close(self) {
        crate::host::close_source(self.poster.id());
    }
}

/// A source's poster, typed (it is `Send`).
pub(crate) struct SourcePoster<T> {
    poster: crate::host::Poster,
    _value: std::marker::PhantomData<fn(T)>,
}

impl<T> Clone for SourcePoster<T> {
    fn clone(&self) -> Self {
        SourcePoster {
            poster: self.poster.clone(),
            _value: std::marker::PhantomData,
        }
    }
}

impl<T: Send + 'static> SourcePoster<T> {
    pub(crate) fn post(&self, value: T) {
        self.poster.post(value);
    }
}

/// Opens a [`Source`] whose deliveries run `deliver` in units of their own,
/// in the frame current here.
pub(crate) fn source<T: Send + 'static>(mut deliver: impl FnMut(T) + 'static) -> Source<T> {
    let started = Rc::new(std::cell::Cell::new(js::checkpoint_epoch()));
    let checked = started.clone();
    let poster = crate::host::open_source(move |value: T| {
        settled_in_a_later_checkpoint(checked.get());
        deliver(value);
    });
    Source {
        poster,
        started,
        _value: std::marker::PhantomData,
    }
}

/// Rule 1's guard (design file 32, section 6, rule 3): an I/O completion
/// that settles in the checkpoint that started it is an order Node never
/// gives, so it ends the process, in every build.
pub(crate) fn settled_in_a_later_checkpoint(started: u64) {
    assert!(
        js::checkpoint_epoch() != started,
        "an I/O completion settled in the checkpoint that started it (node::io, rule 1)"
    );
}

/// A promise already rejected with `reason`, as an async function that
/// throws before its first await gives (Node's validation and closed-handle
/// errors: no I/O, settled in the starting checkpoint as Node settles them).
pub(crate) fn rejected<T: Clone + 'static>(reason: W) -> Promise<T, W> {
    Promise::reject(reason)
}

/// A promise already fulfilled with `value` (a call Node answers without I/O).
pub(crate) fn fulfilled<T: Clone + 'static>(value: T) -> Promise<T, W> {
    Promise::resolve(js::Resolution::Value(value))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::fs::{self as nfs, Flags};
    use super::stream::{ReadStreamOptions, create_read_stream};
    use crate::agen;
    use crate::host::testing::test_loop;
    use crate::js::{self, Resolution, async_fn};
    use crate::value::W;

    /// A directory of this test's own under the OS temp dir, removed on drop.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let dir = std::env::temp_dir()
                .join(format!("ledger-native-node-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("scratch");
            Scratch(dir)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
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
                "the file calls did not answer within 30 s"
            );
            if event_loop.has_immediates() {
                event_loop.check_phase();
            } else {
                event_loop.poll_phase(Some(100), &mut |_| {});
            }
        }
    }

    #[test]
    fn a_completion_settles_in_a_unit_of_its_own_never_in_its_checkpoint() {
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("unit");
        let path = scratch.path(".");
        let started = js::checkpoint_epoch();
        let promise = nfs::lstat(&path, false);
        let five = Rc::new(RefCell::new(Vec::new()));
        {
            let mut chain: js::Promise<W, W> =
                js::Promise::resolve(Resolution::Value(W::Undefined));
            for _ in 0..5 {
                chain = chain.then_ok(|_| Ok(Resolution::Value(W::Undefined)));
            }
            let five = five.clone();
            let _ = chain.then_ok(move |_| {
                five.borrow_mut().push(js::checkpoint_epoch());
                Ok(Resolution::Value(W::Undefined))
            });
        }
        event_loop.checkpoint();
        assert!(
            !promise.is_settled(),
            "settled in the checkpoint that started it"
        );
        assert_eq!(*five.borrow(), vec![started]);
        drive(&event_loop, &|| promise.is_settled());
        assert!(js::checkpoint_epoch() > started);
    }

    #[test]
    #[should_panic(expected = "settled in the checkpoint that started it")]
    fn the_guard_ends_the_process_on_a_settlement_in_its_starting_checkpoint() {
        let (_event_loop, _time) = test_loop();
        super::settled_in_a_later_checkpoint(js::checkpoint_epoch());
    }

    #[test]
    fn a_read_stream_reads_the_cut_then_closes_before_for_await_ends() {
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("stream");
        let file = scratch.path("f");
        std::fs::write(&file, vec![7u8; 300_000]).expect("file");
        let seen: Rc<RefCell<Vec<usize>>> = Rc::default();
        let closed_at_end = Rc::new(RefCell::new(None));
        let promise = {
            let (seen, closed_at_end) = (seen.clone(), closed_at_end.clone());
            async_fn::<W, W>(async move {
                let stream = create_read_stream(
                    &file,
                    ReadStreamOptions {
                        high_water_mark: 128 * 1024,
                    },
                );
                let chunks = agen::for_await(&stream);
                while let Some(chunk) = chunks.next().await? {
                    if let W::Bytes(bytes) = chunk {
                        seen.borrow_mut().push(bytes.len());
                    }
                }
                *closed_at_end.borrow_mut() = Some(stream.closed());
                Ok(Resolution::Value(W::Undefined))
            })
        };
        drive(&event_loop, &|| promise.is_settled());
        assert_eq!(*seen.borrow(), vec![131_072, 131_072, 37_856]);
        assert_eq!(*closed_at_end.borrow(), Some(true));
    }

    #[test]
    fn a_closed_handle_refuses_with_ebadf_and_a_second_close_resolves() {
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("handle");
        let file = scratch.path("f");
        std::fs::write(&file, b"abc").expect("file");
        let outcome: Rc<RefCell<Vec<String>>> = Rc::default();
        let promise = {
            let outcome = outcome.clone();
            async_fn::<W, W>(async move {
                let handle = nfs::open(&file, Flags::Str("r"), None).await?;
                let read = handle.read(2, Some(1)).await?;
                outcome
                    .borrow_mut()
                    .push(String::from_utf8_lossy(&read.bytes).into_owned());
                handle.close().await?;
                handle.close().await?;
                match handle.read(1, None).await {
                    Ok(_) => outcome.borrow_mut().push(String::from("read")),
                    Err(reason) => outcome.borrow_mut().push(super::code_of(&reason)),
                }
                Ok(Resolution::Value(W::Undefined))
            })
        };
        drive(&event_loop, &|| promise.is_settled());
        assert_eq!(
            *outcome.borrow(),
            vec!["bc".to_string(), "EBADF".to_string()]
        );
    }

    /// An open handle on a fresh file of `bytes`, the loop driven until it is.
    fn opened(
        event_loop: &crate::host::EventLoop,
        file: &str,
        flags: &'static str,
    ) -> nfs::FileHandle {
        let promise = nfs::open(file, Flags::Str(flags), None);
        drive(event_loop, &|| promise.is_settled());
        let handle: Rc<RefCell<Option<nfs::FileHandle>>> = Rc::default();
        {
            let handle = handle.clone();
            let _ = promise.then_ok(move |opened| {
                *handle.borrow_mut() = Some(opened);
                Ok(Resolution::Value(()))
            });
        }
        event_loop.checkpoint();
        handle.borrow().clone().expect("the handle")
    }

    /// Rule 1 for one call: started, then its starting checkpoint ends, and
    /// it has not settled; then it settles in a later checkpoint.
    fn not_in_its_checkpoint<T: Clone + 'static>(
        event_loop: &crate::host::EventLoop,
        what: &str,
        start: impl FnOnce() -> js::Promise<T, W>,
    ) {
        let started = js::checkpoint_epoch();
        let promise = start();
        // A failing call's rejection is handled here.
        promise.clone().react(|_| {});
        event_loop.checkpoint();
        assert!(
            !promise.is_settled(),
            "{what} settled in the checkpoint that started it"
        );
        assert_eq!(
            js::checkpoint_epoch(),
            started + 1,
            "{what}: one checkpoint"
        );
        drive(event_loop, &|| promise.is_settled());
    }

    #[test]
    fn every_file_handle_method_settles_after_its_starting_checkpoint() {
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("methods");
        let file = scratch.path("f");
        std::fs::write(&file, b"abcdefghij").expect("file");
        let handle = opened(&event_loop, &file, "r+");
        let bytes = Rc::new(b"xy".to_vec());
        not_in_its_checkpoint(&event_loop, "read", || handle.read(4, Some(0)));
        not_in_its_checkpoint(&event_loop, "read at the offset", || handle.read(16, None));
        not_in_its_checkpoint(&event_loop, "write", || handle.write(&bytes, 0, 2, Some(1)));
        not_in_its_checkpoint(&event_loop, "writeFile", || {
            handle.write_file(&nfs::Data::Bytes(bytes.clone()))
        });
        not_in_its_checkpoint(&event_loop, "stat", || handle.stat(false));
        not_in_its_checkpoint(&event_loop, "chmod", || handle.chmod(0o600));
        not_in_its_checkpoint(&event_loop, "sync", || handle.sync());
        not_in_its_checkpoint(&event_loop, "close", || handle.close());
        let dir_handle = opened(&event_loop, &scratch.path("."), "r");
        not_in_its_checkpoint(&event_loop, "a failing read", || dir_handle.read(4, None));
        not_in_its_checkpoint(&event_loop, "close", || dir_handle.close());
        let link = scratch.path("l");
        not_in_its_checkpoint(&event_loop, "symlink of bytes", || {
            nfs::symlink_bytes(b"t\xff\xfe", &link, None)
        });
        not_in_its_checkpoint(&event_loop, "readlink as bytes", || {
            nfs::readlink_bytes(&link)
        });
        not_in_its_checkpoint(&event_loop, "open", || {
            nfs::open(&file, Flags::Str("r"), None)
        });
    }

    /// Node: read in flight, close (deferred), a second read still allowed,
    /// close again: read, read2-ok, close (the reviewer's probe, O2fd).
    #[test]
    fn review_deferred_close_waits_for_reads_and_admits_new_ones() {
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("deferred");
        let path = scratch.path("f");
        std::fs::write(&path, vec![1u8; 4096]).expect("file");
        let log: Rc<RefCell<Vec<String>>> = Rc::default();
        let push =
            |log: &Rc<RefCell<Vec<String>>>, what: &str| log.borrow_mut().push(what.to_owned());
        let done = {
            let log = log.clone();
            async_fn::<W, W>(async move {
                let h = nfs::open(&path, Flags::Str("r"), None).await?;
                {
                    let log = log.clone();
                    let _ = h.read(10, Some(0)).then_ok(move |_| {
                        push(&log, "read");
                        Ok(Resolution::Value(()))
                    });
                }
                let c = h.close();
                {
                    let log = log.clone();
                    let _ = c.then_ok(move |_| {
                        push(&log, "close");
                        Ok(Resolution::Value(()))
                    });
                }
                {
                    let (log2, log3) = (log.clone(), log.clone());
                    let _ = h.read(1, Some(0)).then(
                        move |_| {
                            push(&log2, "read2-ok");
                            Ok(Resolution::Value(()))
                        },
                        move |e| {
                            push(&log3, &format!("read2-{}", super::code_of(&e)));
                            Ok(Resolution::Value(()))
                        },
                    );
                }
                let _ = h.close();
                Ok(Resolution::Value(W::Undefined))
            })
        };
        drive(&event_loop, &|| {
            done.is_settled() && log.borrow().len() == 3
        });
        // The two reads run on the pool's threads at once: which completes
        // first is arrival's, in Node too (libuv's pool). What is Node's is
        // that the second read is admitted and the close waits for both.
        let mut seen = log.borrow().clone();
        assert_eq!(seen.pop().as_deref(), Some("close"), "{seen:?}");
        seen.sort();
        assert_eq!(seen, vec!["read", "read2-ok"]);
    }

    /// Node 24.22: `a = h.close(); b = h.close(); b.then(B);
    /// queueMicrotask(M); a.then(A)` gives b, micro, a: a close of a handle
    /// whose close is under way resolves at once.
    #[test]
    fn review_two_concurrent_closes_order_as_node() {
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("twoclose");
        let path = scratch.path("f");
        std::fs::write(&path, b"abc").expect("file");
        let log: Rc<RefCell<Vec<&'static str>>> = Rc::default();
        let h = opened(&event_loop, &path, "r");
        let a = h.close();
        let b = h.close();
        {
            let log = log.clone();
            let _ = b.then_ok(move |_| {
                log.borrow_mut().push("b");
                Ok(Resolution::Value(()))
            });
        }
        {
            let log = log.clone();
            js::queue_microtask(move || log.borrow_mut().push("micro"));
        }
        {
            let log = log.clone();
            let _ = a.then_ok(move |_| {
                log.borrow_mut().push("a");
                Ok(Resolution::Value(()))
            });
        }
        drive(&event_loop, &|| log.borrow().len() == 3);
        assert_eq!(*log.borrow(), vec!["b", "micro", "a"]);
    }

    /// A `for await` left while its `read(2)` is blocked (a fifo whose
    /// writer holds it open): the descriptor is closed only after that read
    /// returns (the close asserts it). (The descriptor count is not checked
    /// here: the other tests of this binary open files on other threads.)
    #[test]
    fn a_read_stream_never_closes_its_descriptor_under_a_read_in_flight() {
        use std::io::Write;
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("fifo");
        let fifo = scratch.path("p");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("mkfifo");
        assert!(made.success(), "mkfifo failed");
        let (release, released) = std::sync::mpsc::channel::<()>();
        let writer = {
            let fifo = fifo.clone();
            std::thread::spawn(move || {
                let mut pipe = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&fifo)
                    .expect("the fifo's writer");
                pipe.write_all(&[5u8; 100]).expect("first bytes");
                // Held open, writing nothing, until the stream has been left.
                let _ = released.recv_timeout(std::time::Duration::from_secs(30));
                let _ = pipe.write_all(&[6u8; 10]);
            })
        };
        let stream = create_read_stream(
            &fifo,
            ReadStreamOptions {
                high_water_mark: 128 * 1024,
            },
        );
        // `for await`'s iterator, its first `next()`, then `return()`.
        let iterator = stream.iter();
        let first = iterator.next(W::Undefined);
        drive(&event_loop, &|| first.is_settled());
        assert!(
            stream.performing_io(),
            "the second read is blocked on the fifo"
        );
        let left = iterator.return_(Resolution::Value(W::Undefined));
        // Left at once: the destroy waits for the blocked read.
        for _ in 0..5 {
            event_loop.checkpoint();
            if event_loop.has_immediates() {
                event_loop.check_phase();
            }
        }
        assert!(
            stream.destroyed() && !stream.closed(),
            "closed under its read"
        );
        release.send(()).expect("the writer waits");
        drive(&event_loop, &|| left.is_settled() && stream.closed());
        writer.join().expect("the writer");
        assert!(
            stream.closed() && stream.bytes_read() == 100,
            "the blocked read was discarded, then the descriptor closed"
        );
    }

    /// `readFileHandle` of a file of unknown size (a fifo): 64 KiB reads
    /// until a read of nothing, a short read is not the end (Node 24.22's
    /// `kReadFileUnknownBufferLength` loop). The writer pauses between its
    /// two writes, so the first read is short.
    #[test]
    fn read_file_of_unknown_size_reads_until_a_read_of_nothing() {
        use std::io::Write;
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("fifofile");
        let fifo = scratch.path("p");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("mkfifo");
        assert!(made.success(), "mkfifo failed");
        let writer = {
            let fifo = fifo.clone();
            std::thread::spawn(move || {
                let mut pipe = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&fifo)
                    .expect("the fifo's writer");
                pipe.write_all(b"0123456789").expect("first bytes");
                std::thread::sleep(std::time::Duration::from_millis(300));
                pipe.write_all(b"abcdefghij").expect("last bytes");
            })
        };
        let promise = nfs::read_file(&fifo);
        drive(&event_loop, &|| promise.is_settled());
        writer.join().expect("the writer");
        let read: Rc<RefCell<Vec<u8>>> = Rc::default();
        {
            let read = read.clone();
            let _ = promise.then_ok(move |bytes| {
                *read.borrow_mut() = bytes.as_ref().clone();
                Ok(Resolution::Value(()))
            });
        }
        event_loop.checkpoint();
        assert_eq!(read.borrow().as_slice(), b"0123456789abcdefghij");
    }

    #[test]
    #[should_panic(expected = "a pool job panicked: planted")]
    fn a_panicking_pool_job_fails_loudly_on_the_loop() {
        let (event_loop, _time) = test_loop();
        let promise = super::io::<(), _>(|| panic!("planted"));
        drive(&event_loop, &|| promise.is_settled());
    }

    #[test]
    fn utimes_refuses_a_time_that_is_not_finite_as_node_24() {
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("utimes");
        let file = scratch.path("f");
        std::fs::write(&file, b"x").expect("file");
        for (value, shown) in [
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            let promise = nfs::utimes(&file, nfs::Time::Seconds(value), nfs::Time::Seconds(1.0));
            let reason: Rc<RefCell<Option<W>>> = Rc::default();
            {
                let reason = reason.clone();
                let _ = promise.catch(move |error| {
                    *reason.borrow_mut() = Some(error);
                    Ok(Resolution::Value(()))
                });
            }
            event_loop.checkpoint();
            let Some(W::Error(error)) = reason.borrow().clone() else {
                panic!("{shown}: not refused")
            };
            assert_eq!(
                super::code_of(&W::Error(error.clone())),
                "ERR_INVALID_ARG_TYPE"
            );
            assert!(
                error
                    .message
                    .to_string_lossy()
                    .ends_with(&format!("Received type number ({shown})"))
            );
        }
    }

    /// Linux only (APFS refuses such names with EILSEQ): a name that is not
    /// UTF-8 is listed as Node lists it, each ill-formed byte as U+FFFD.
    #[cfg(target_os = "linux")]
    #[test]
    fn readdir_lists_a_name_that_is_not_utf8_as_node_does() {
        use std::os::unix::ffi::OsStrExt;
        let (event_loop, _time) = test_loop();
        let scratch = Scratch::new("rawname");
        let raw = scratch.0.join(std::ffi::OsStr::from_bytes(b"a\xff"));
        std::fs::write(&raw, b"x").expect("a non-UTF-8 name");
        let names = nfs::readdir(&scratch.path("."));
        drive(&event_loop, &|| names.is_settled());
        let seen: Rc<RefCell<Vec<String>>> = Rc::default();
        {
            let seen = seen.clone();
            let _ = names.then_ok(move |names| {
                *seen.borrow_mut() = names;
                Ok(Resolution::Value(()))
            });
        }
        event_loop.checkpoint();
        assert_eq!(*seen.borrow(), vec!["a\u{fffd}".to_string()]);
        let synced = nfs::readdir_with_file_types_sync(&scratch.path(".")).expect("listed");
        assert_eq!(synced[0].name, "a\u{fffd}");
    }
}
