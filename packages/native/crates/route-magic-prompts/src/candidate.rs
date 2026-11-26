//! The harness's candidate protocol (design file 31 §5.2; the JavaScript
//! candidate adapter, scripts/backend-conformance/js-candidate.mjs, is the
//! model): started as
//!
//!   devryan-route-magic-prompts --listen 127.0.0.1:0 --control 127.0.0.1:0 --data-root <dir> --home <dir>
//!       [--stub name=URL ...] [--plant <id>]   (--plant: a build with the plants feature only)
//!
//! it prints one line `{"ready":{"listen":port,"control":port}}`. Each request
//! carries `X-DevRyan-Harness-Seq` and `X-DevRyan-Harness-Envelope` (base64
//! JSON, version 1, naming the same exchange): both leave the request before
//! the group sees its headers. The control port answers `GET /quiescent?seq=n`
//! once exchange n has been answered in full (every effect of an exchange is
//! made before its answer is written), and `POST /stop`. The process stops on
//! `POST /stop`, SIGTERM, SIGINT, SIGHUP and the end of its stdin, with code 0.
//! Exit code 64: a refused command line.
//!
//! **The listen port** is served the way Node's one event loop serves it
//! (src/order.rs has the write-order rule this reproduces): one reader thread
//! waits on kqueue (macOS) or epoll (Linux), level-triggered as libuv's
//! watchers are, and takes ready sockets in the order the kernel reports them
//! (the order they became readable). New connections are registered when the
//! reader next waits, as libuv registers its watchers. For each readable
//! socket it reads what has arrived (up to 32 reads of 64 KiB, libuv's
//! `uv__read`), and decides at once what the JavaScript would do at that
//! point: once the head is complete, a request whose body no parser reads goes
//! to its handler then (its place in the order of writes is taken then); a
//! body a parser reads in plain form is collected (never more than its limit:
//! a longer one is counted and dropped, and refused once it has ended, as
//! body-parser drains it before answering), and its handler goes when the body
//! ends; a compressed body is handed to a thread of its own, which inflates it
//! as it arrives and posts its completion back to the reader (a socket pair
//! the reader waits on, as zlib's thread-pool work comes back to Node's loop),
//! and the handler takes its place then. Every handler runs in a thread of its
//! own. A head still incomplete after 60 s, or a request still incomplete
//! after 300 s, is answered 408 (Node's `headersTimeout` and `requestTimeout`,
//! checked every 30 s as Node checks them).
//!
//! Node's HTTP server is otherwise not reproduced: one request per connection
//! (the harness sends `Connection: close`; no keep-alive or pipelining), no
//! `Expect` handling, no `Host` requirement, llhttp's method list not checked.

use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::body::{self, Body, Encoding, Plan, Reader};
use crate::group;
use crate::http::{self, BodyDecoder, Framing, Headers, ReadError, Response};
use crate::order::{Ticket, Turns};
use crate::plant::{self, Plant};
use crate::runtime::Runtime;

const REFUSED: i32 = 64;
const ENVELOPE: &str = "x-devryan-harness-envelope";
const SEQ: &str = "x-devryan-harness-seq";
const QUIESCENT_WAIT: Duration = Duration::from_secs(30);
/// Node's `headersTimeout`, `requestTimeout` and `connectionsCheckingInterval` (http.createServer defaults).
const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// After its answer, a connection's remaining bytes are read and dropped for at most this long.
const DRAIN_LIMIT: Duration = Duration::from_secs(10);
const READ_CHUNK: usize = 64 * 1024;
const READS_PER_WAKE: usize = 32;

struct Options {
    listen: String,
    control: String,
    data_root: String,
}

fn refuse(text: &str) -> ! {
    eprintln!("devryan-route-magic-prompts: {text}");
    std::process::exit(REFUSED);
}

fn options(args: &[String]) -> Options {
    let mut listen = "127.0.0.1:0".to_owned();
    let mut control = "127.0.0.1:0".to_owned();
    let mut data_root = None;
    let mut at = 0;
    while at < args.len() {
        let value = args.get(at + 1).cloned().unwrap_or_else(|| refuse(&format!("{} needs a value", args[at])));
        match args[at].as_str() {
            "--listen" => listen = value,
            "--control" => control = value,
            "--data-root" => data_root = Some(value),
            // The group has no outbound call and no use for HOME; both are accepted as the protocol hands them out.
            "--home" | "--stub" => {}
            "--plant" => plant::choose(&value).unwrap_or_else(|why| refuse(&why)),
            other => refuse(&format!("unknown option {other}")),
        }
        at += 2;
    }
    let data_root = data_root.unwrap_or_else(|| refuse("--data-root is required"));
    if !data_root.starts_with('/') || !std::path::Path::new(&data_root).is_dir() {
        refuse("--data-root must be an existing absolute directory");
    }
    Options { listen, control, data_root }
}

/// Exchanges by sequence number: whether each has been answered in full.
#[derive(Default)]
struct Exchanges {
    finished: Mutex<HashMap<u64, bool>>,
    changed: Condvar,
}

impl Exchanges {
    fn begin(&self, seq: u64) {
        self.finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(seq, false);
    }

    fn finish(&self, seq: u64) {
        self.finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(seq, true);
        self.changed.notify_all();
    }

    /// Waits (bounded) until exchange `seq` is answered: (answered, known).
    fn wait(&self, seq: u64) -> (bool, bool) {
        let deadline = Instant::now() + QUIESCENT_WAIT;
        let mut finished = self.finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            match finished.get(&seq) {
                Some(true) => return (true, true),
                known => {
                    let now = Instant::now();
                    if now >= deadline {
                        return (false, known.is_some());
                    }
                    finished = self
                        .changed
                        .wait_timeout(finished, deadline - now)
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .0;
                }
            }
        }
    }
}

/// `Number(text)` for the sequence header, when it is a non-negative integer.
fn sequence_number(text: &str) -> Option<u64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0);
    }
    trimmed.parse::<u64>().ok()
}

/// js-candidate.mjs's envelope layer: version 1, naming this exchange.
fn check_envelope(envelope: Option<&[u8]>, seq_text: Option<&str>) -> Result<(), String> {
    let seq = seq_text.and_then(sequence_number);
    let shown = seq.map_or_else(|| "NaN".to_owned(), |seq| seq.to_string());
    let failure = || {
        Err(format!(
            "harness: the envelope is missing, not version 1, or names another exchange (seq {shown})"
        ))
    };
    let Some(envelope) = envelope else { return failure() };
    let decoded = crate::answer::base64_decode(envelope);
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&decoded) else {
        return failure();
    };
    let version_ok = value.get("v").and_then(serde_json::Value::as_f64) == Some(1.0);
    let seq_ok = matches!((value.get("seq").and_then(serde_json::Value::as_f64), seq), (Some(given), Some(seq)) if given == seq as f64);
    if version_ok && seq_ok { Ok(()) } else { failure() }
}

// ------------------------------------------------------------------ what every thread shares

struct Shared {
    runtime: Runtime,
    exchanges: Exchanges,
    turns: Arc<Turns>,
    /// Inflate threads that finished, in the order they finished, each waiting for its ticket.
    finished_bodies: Mutex<VecDeque<mpsc::Sender<Ticket>>>,
    /// Written once per finished body: wakes the reader.
    wake: UnixStream,
}

/// A request whose head has been read: the harness's headers taken off, the group's headers made.
struct Started {
    method: String,
    target: String,
    headers: Headers,
    seq: Option<u64>,
    envelope: Result<(), String>,
}

fn start(head: http::Head, shared: &Shared) -> Started {
    let mut raw = head.raw_headers;
    let mut take = |name: &str| {
        let found = raw.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.clone());
        raw.retain(|(key, _)| !key.eq_ignore_ascii_case(name));
        found
    };
    let envelope = take(ENVELOPE);
    let seq_text = take(SEQ).map(|value| String::from_utf8_lossy(&value).into_owned());
    let seq = seq_text.as_deref().and_then(sequence_number);
    if let Some(seq) = seq {
        shared.exchanges.begin(seq);
    }
    Started {
        method: head.method,
        target: head.target,
        headers: Headers::from_raw(&raw),
        seq,
        envelope: check_envelope(envelope.as_deref(), seq_text.as_deref()),
    }
}

/// Answers one started request in its own thread: the body as the parsers leave it, then the group.
fn serve(mut stream: TcpStream, request: Started, body: Result<Body, body::Refusal>, ticket: Ticket, shared: &Shared) {
    let exchange = group::Exchange {
        method: &request.method,
        target: &request.target,
        headers: &request.headers,
    };
    let envelope = request.envelope.clone();
    let response = group::handle(&shared.runtime, &exchange, body, envelope, &ticket);
    drop(ticket);
    let extra: Vec<(String, String)> = match (request.seq, plant::on(Plant::EnvelopeEchoed)) {
        (Some(seq), true) => vec![("X-DevRyan-Harness-Seq".to_owned(), seq.to_string())],
        _ => Vec::new(),
    };
    let _ = stream.set_nonblocking(false);
    let _ = http::write_response(&mut stream, &response, &extra);
    let _ = stream.shutdown(Shutdown::Write);
    if let Some(seq) = request.seq {
        shared.exchanges.finish(seq);
    }
    drain(&mut stream);
}

/// Reads and drops what the client still sends until it closes (bounded), so the close is never a reset.
fn drain(stream: &mut TcpStream) {
    let until = Instant::now() + DRAIN_LIMIT;
    let mut sink = [0u8; 16 * 1024];
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    while Instant::now() < until && matches!(stream.read(&mut sink), Ok(count) if count > 0) {}
}

/// What Node's server answers by itself for a request it cannot read (or that timed out).
fn refuse_request(mut stream: TcpStream, why: &'static [u8]) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.write_all(why);
}

const BAD_REQUEST: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
const TOO_LARGE: &[u8] = b"HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n";
const TIMED_OUT: &[u8] = b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n";

fn refusal_of(error: &ReadError) -> &'static [u8] {
    if *error == ReadError::TooLarge { TOO_LARGE } else { BAD_REQUEST }
}

/// Runs `work` in a thread of its own. When the system cannot make one, the work (and the connection it owns)
/// is dropped: the connection closes unanswered, a ticket it held is released, and the process goes on.
fn spawn(work: impl FnOnce() + Send + 'static) {
    let _ = thread::Builder::new().spawn(work);
}

fn spawn_serve(stream: TcpStream, request: Started, body: Result<Body, body::Refusal>, ticket: Ticket, shared: &Arc<Shared>) {
    let shared = Arc::clone(shared);
    spawn(move || serve(stream, request, body, ticket, &shared));
}

// ------------------------------------------------------------------ compressed bodies

/// A request body read from a blocking socket through its framing (what the inflate thread pulls from).
struct SocketBody {
    stream: TcpStream,
    decoder: BodyDecoder,
    /// Body bytes decoded and not yet handed out.
    ready: Vec<u8>,
    taken: usize,
    /// Socket bytes read with the head and not yet decoded.
    early: Vec<u8>,
    deadline: Instant,
    malformed: bool,
    timed_out: bool,
}

impl Read for SocketBody {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.taken < self.ready.len() {
                let count = out.len().min(self.ready.len() - self.taken);
                out[..count].copy_from_slice(&self.ready[self.taken..self.taken + count]);
                self.taken += count;
                return Ok(count);
            }
            if self.decoder.done() {
                return Ok(0);
            }
            self.ready.clear();
            self.taken = 0;
            let mut input = std::mem::take(&mut self.early);
            if input.is_empty() {
                let left = self.deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    self.timed_out = true;
                    return Err(ErrorKind::TimedOut.into());
                }
                let _ = self.stream.set_read_timeout(Some(left));
                input = vec![0u8; READ_CHUNK];
                match self.stream.read(&mut input) {
                    Ok(0) => return Err(ErrorKind::UnexpectedEof.into()),
                    Ok(count) => input.truncate(count),
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                        self.timed_out = true;
                        return Err(error);
                    }
                    Err(error) => return Err(error),
                }
            }
            let ready = &mut self.ready;
            if self.decoder.feed(&input, &mut |piece| ready.extend_from_slice(piece)).is_err() {
                self.malformed = true;
                return Err(ErrorKind::InvalidData.into());
            }
        }
    }
}

/// Inflates a compressed body as it arrives, then asks the reader for the request's place in the order of
/// writes (as zlib's last thread-pool call reports back to Node's loop) and answers.
fn inflate_then_serve(body: SocketBody, request: Started, encoding: Encoding, limit: usize, reader: Reader, shared: Arc<Shared>) {
    let mut body = body;
    let outcome = body::inflate_content(encoding, &mut body, limit);
    let SocketBody {
        stream, malformed, timed_out, ..
    } = body;
    let Some(content) = body::content_of(outcome) else {
        if malformed {
            refuse_request(stream, BAD_REQUEST);
        } else if timed_out {
            refuse_request(stream, TIMED_OUT);
        }
        return;
    };
    let (send, receive) = mpsc::channel();
    shared.finished_bodies.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push_back(send);
    let _ = (&shared.wake).write(&[1]);
    let Ok(ticket) = receive.recv() else { return };
    let body = body::parse(&reader, content);
    serve(stream, request, body, ticket, &shared);
}

// ------------------------------------------------------------------ the reader

/// The kernel's readiness queue, level-triggered, in the order sockets became readable.
mod poller {
    use std::io;
    use std::os::fd::RawFd;
    use std::time::Duration;

    #[cfg(not(target_os = "linux"))]
    pub struct Poller {
        queue: RawFd,
        changes: Vec<libc::kevent>,
        events: Vec<libc::kevent>,
    }

    #[cfg(not(target_os = "linux"))]
    impl Poller {
        pub fn new() -> io::Result<Self> {
            // SAFETY: kqueue takes no arguments; a negative result is an error, checked.
            let queue = unsafe { libc::kqueue() };
            if queue < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Poller {
                queue,
                changes: Vec::new(),
                // SAFETY: kevent is a plain C struct; all-zero is a valid (empty) value.
                events: vec![unsafe { std::mem::zeroed() }; 256],
            })
        }

        fn change(fd: RawFd, flags: u16) -> libc::kevent {
            libc::kevent {
                ident: fd as libc::uintptr_t,
                filter: libc::EVFILT_READ,
                flags,
                fflags: 0,
                data: 0,
                udata: std::ptr::null_mut(),
            }
        }

        /// Watches `fd` from the next wait on (as libuv's watcher queue).
        pub fn add(&mut self, fd: RawFd) {
            self.changes.push(Self::change(fd, libc::EV_ADD));
        }

        /// Stops watching `fd` now.
        pub fn remove(&mut self, fd: RawFd) {
            self.changes.retain(|change| change.ident != fd as libc::uintptr_t);
            let change = Self::change(fd, libc::EV_DELETE);
            // SAFETY: one valid change, no event buffer; the result (an fd already gone) does not matter.
            unsafe { libc::kevent(self.queue, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) };
        }

        /// Registers the pending watchers and waits; the ready descriptors in the kernel's order.
        pub fn wait(&mut self, timeout: Duration, ready: &mut Vec<RawFd>) {
            let spec = libc::timespec {
                tv_sec: timeout.as_secs().min(i64::MAX as u64) as libc::time_t,
                tv_nsec: libc::c_long::from(timeout.subsec_nanos() as i32),
            };
            // SAFETY: the change and event buffers are valid for their lengths for the call's duration.
            let count = unsafe {
                libc::kevent(
                    self.queue,
                    self.changes.as_ptr(),
                    self.changes.len() as libc::c_int,
                    self.events.as_mut_ptr(),
                    self.events.len() as libc::c_int,
                    &spec,
                )
            };
            self.changes.clear();
            for event in self.events.iter().take(count.max(0) as usize) {
                if event.flags & libc::EV_ERROR == 0 {
                    ready.push(event.ident as RawFd);
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub struct Poller {
        queue: RawFd,
        pending: Vec<RawFd>,
        events: Vec<libc::epoll_event>,
    }

    #[cfg(target_os = "linux")]
    impl Poller {
        pub fn new() -> io::Result<Self> {
            // SAFETY: epoll_create1 takes a flag; a negative result is an error, checked.
            let queue = unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) };
            if queue < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Poller {
                queue,
                pending: Vec::new(),
                events: vec![libc::epoll_event { events: 0, u64: 0 }; 256],
            })
        }

        pub fn add(&mut self, fd: RawFd) {
            self.pending.push(fd);
        }

        pub fn remove(&mut self, fd: RawFd) {
            self.pending.retain(|pending| *pending != fd);
            let mut event = libc::epoll_event { events: 0, u64: 0 };
            // SAFETY: a valid event pointer; the result (an fd never added) does not matter.
            unsafe { libc::epoll_ctl(self.queue, libc::EPOLL_CTL_DEL, fd, &mut event) };
        }

        pub fn wait(&mut self, timeout: Duration, ready: &mut Vec<RawFd>) {
            for fd in self.pending.drain(..) {
                let mut event = libc::epoll_event {
                    events: libc::EPOLLIN as u32,
                    u64: fd as u64,
                };
                // SAFETY: a valid event pointer for the call's duration.
                unsafe { libc::epoll_ctl(self.queue, libc::EPOLL_CTL_ADD, fd, &mut event) };
            }
            let millis = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
            // SAFETY: the event buffer is valid for its length for the call's duration.
            let count = unsafe { libc::epoll_wait(self.queue, self.events.as_mut_ptr(), self.events.len() as libc::c_int, millis) };
            for event in self.events.iter().take(count.max(0) as usize) {
                ready.push(event.u64 as RawFd);
            }
        }
    }
}

/// Where a connection's request is.
enum Phase {
    /// Reading the head.
    Head,
    /// A parser reads the body in plain form: collected up to `limit`, then the handler goes.
    Collect {
        request: Started,
        decoder: BodyDecoder,
        bytes: Vec<u8>,
        limit: usize,
        over: bool,
        reader: Reader,
    },
    /// The handler already went (or the edge refuses at the body's end): the body is read and dropped.
    Discard {
        request: Started,
        decoder: BodyDecoder,
        then: Option<body::Refusal>,
    },
}

struct Connection {
    stream: TcpStream,
    buffer: Vec<u8>,
    phase: Phase,
    accepted: Instant,
    order: u64,
}

fn read_available(stream: &mut TcpStream, buffer: &mut Vec<u8>, chunk: &mut [u8]) -> bool {
    for _ in 0..READS_PER_WAKE {
        match stream.read(chunk) {
            Ok(0) => return true,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                if count < chunk.len() {
                    return false;
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => return false,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(_) => return true,
        }
    }
    false
}

/// Takes the body bytes of `input` into the phase; true when the body has ended.
fn take_body(phase: &mut Phase, input: &[u8]) -> Result<bool, ReadError> {
    match phase {
        Phase::Head => Ok(false),
        Phase::Collect {
            decoder, bytes, limit, over, ..
        } => {
            decoder.feed(input, &mut |piece| {
                if *over {
                    return;
                }
                if bytes.len() + piece.len() > *limit {
                    *over = true;
                    *bytes = Vec::new();
                } else {
                    bytes.extend_from_slice(piece);
                }
            })?;
            Ok(decoder.done())
        }
        Phase::Discard { decoder, .. } => {
            decoder.feed(input, &mut |_| {})?;
            Ok(decoder.done())
        }
    }
}

/// A head that is still arriving is never held beyond this (Node refuses long before: 431 or 400).
const HEAD_BUFFER_LIMIT: usize = 64 * 1024;

/// The listen port's one reader (the module comment says what it reproduces).
struct EventLoop {
    shared: Arc<Shared>,
    poller: poller::Poller,
    connections: HashMap<RawFd, Connection>,
    accepted: u64,
    chunk: Vec<u8>,
}

impl EventLoop {
    /// The reader is done with a connection: it stops watching it before anything else may close it.
    fn leave(&mut self, connection: &Connection) {
        self.poller.remove(connection.stream.as_raw_fd());
    }

    /// A connection was readable: read it and act as the JavaScript would at this point. Returns the
    /// connection when the reader goes on watching it.
    fn readable(&mut self, mut connection: Connection) -> Option<Connection> {
        let ended = read_available(&mut connection.stream, &mut connection.buffer, &mut self.chunk);
        if matches!(connection.phase, Phase::Head) {
            let parsed = match http::parse_head(&connection.buffer) {
                Ok(None) if connection.buffer.len() > HEAD_BUFFER_LIMIT => Err(ReadError::TooLarge),
                other => other,
            };
            let (head, length) = match parsed {
                Ok(Some(found)) => found,
                Ok(None) if ended => {
                    self.leave(&connection);
                    return None;
                }
                Ok(None) => return Some(connection),
                Err(error) => {
                    self.leave(&connection);
                    refuse_request(connection.stream, refusal_of(&error));
                    return None;
                }
            };
            let framing = head.framing;
            let request = start(head, &self.shared);
            let rest = connection.buffer.split_off(length.min(connection.buffer.len()));
            connection.buffer = Vec::new();
            return self.begin(connection, request, framing, rest, ended);
        }
        let input = std::mem::take(&mut connection.buffer);
        self.more_body(connection, &input, ended)
    }

    /// The head is complete: the plan decides when the handler goes.
    fn begin(&mut self, mut connection: Connection, request: Started, framing: Framing, rest: Vec<u8>, ended: bool) -> Option<Connection> {
        let path = group::pathname(&request.target).to_owned();
        let plan = body::plan(&request.headers, &path);
        let decoder = BodyDecoder::new(framing);
        match plan {
            Plan::Unread if !plant::on(Plant::TicketsAtBodyEnd) => {
                // The handlers run now, with the body unread.
                self.leave(&connection);
                let ticket = self.shared.turns.issue();
                spawn_serve(connection.stream, request, Ok(Body::Unparsed), ticket, &self.shared);
                None
            }
            Plan::Unread => {
                connection.phase = Phase::Discard { request, decoder, then: None };
                self.more_body(connection, &rest, ended)
            }
            Plan::Refuse(refusal) => {
                // The edge answers before reading the body.
                self.leave(&connection);
                spawn_serve(connection.stream, request, Err(refusal), Ticket::alone(), &self.shared);
                None
            }
            Plan::Read {
                limit,
                encoding: Encoding::Identity,
                reader,
            } => {
                // raw-body refuses a declared length over the limit at once, then reads the body off.
                let over = matches!(framing, Framing::Length(length) if length > limit as u64);
                connection.phase = Phase::Collect {
                    request,
                    decoder,
                    bytes: Vec::new(),
                    limit,
                    over,
                    reader,
                };
                self.more_body(connection, &rest, ended)
            }
            Plan::Read { limit, encoding, reader } => {
                self.leave(&connection);
                let _ = connection.stream.set_nonblocking(false);
                let body = SocketBody {
                    stream: connection.stream,
                    decoder,
                    ready: Vec::new(),
                    taken: 0,
                    early: rest,
                    deadline: connection.accepted + REQUEST_TIMEOUT,
                    malformed: false,
                    timed_out: false,
                };
                let shared = Arc::clone(&self.shared);
                if plant::on(Plant::CompressedTicketAtBodyEnd) {
                    // The plant takes the place when the raw body has arrived, before inflating it.
                    let mut raw = Vec::new();
                    let mut body = body;
                    if body.read_to_end(&mut raw).is_err() {
                        return None;
                    }
                    let ticket = self.shared.turns.issue();
                    let stream = body.stream;
                    spawn(move || {
                        if let Some(content) = body::content_of(body::inflate_content(encoding, raw.as_slice(), limit)) {
                            serve(stream, request, body::parse(&reader, content), ticket, &shared);
                        }
                    });
                    return None;
                }
                spawn(move || inflate_then_serve(body, request, encoding, limit, reader, shared));
                None
            }
        }
    }

    fn more_body(&mut self, mut connection: Connection, input: &[u8], ended: bool) -> Option<Connection> {
        match take_body(&mut connection.phase, input) {
            Ok(true) => {
                self.body_ended(connection);
                None
            }
            Ok(false) if ended => {
                self.leave(&connection);
                None
            }
            Ok(false) => Some(connection),
            Err(error) => {
                self.leave(&connection);
                refuse_request(connection.stream, refusal_of(&error));
                None
            }
        }
    }

    /// A plain body has ended: its handler goes now.
    fn body_ended(&mut self, connection: Connection) {
        self.leave(&connection);
        let Connection { stream, phase, .. } = connection;
        match phase {
            Phase::Collect {
                request, bytes, over, reader, ..
            } => {
                let ticket = self.shared.turns.issue();
                let body = body::parse(&reader, body::identity_content(bytes, over));
                spawn_serve(stream, request, body, ticket, &self.shared);
            }
            Phase::Discard { request, then, .. } => {
                let ticket = self.shared.turns.issue();
                let body = then.map_or(Ok(Body::Unparsed), Err);
                spawn_serve(stream, request, body, ticket, &self.shared);
            }
            Phase::Head => {}
        }
    }

    /// Node's connection check: 408 for a head or a request that has taken too long.
    fn check_timeouts(&mut self) {
        let now = Instant::now();
        let expired: Vec<RawFd> = self
            .connections
            .iter()
            .filter(|(_, connection)| {
                let age = now.saturating_duration_since(connection.accepted);
                match connection.phase {
                    Phase::Head => age > HEADERS_TIMEOUT,
                    _ => age > REQUEST_TIMEOUT,
                }
            })
            .map(|(fd, _)| *fd)
            .collect();
        for fd in expired {
            if let Some(connection) = self.connections.remove(&fd) {
                self.leave(&connection);
                refuse_request(connection.stream, TIMED_OUT);
            }
        }
    }

    fn accept(&mut self, listen: &TcpListener, fresh: &mut Vec<Connection>) {
        loop {
            match listen.accept() {
                Ok((stream, _)) => {
                    plant::run_deferred();
                    if stream.set_nonblocking(true).is_ok() {
                        self.accepted += 1;
                        fresh.push(Connection {
                            stream,
                            buffer: Vec::new(),
                            phase: Phase::Head,
                            accepted: Instant::now(),
                            order: self.accepted,
                        });
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(_) => return,
            }
        }
    }

    /// `checks_from`: when the connection checks' interval started (before the ready line, as Node's starts with
    /// the server), so a stalled head is answered between 60 and 90 s after it began, as Node answers it.
    fn run(mut self, listen: TcpListener, wake: UnixStream, checks_from: Instant) -> ! {
        let (listen_fd, wake_fd) = (listen.as_raw_fd(), wake.as_raw_fd());
        self.poller.add(wake_fd);
        self.poller.add(listen_fd);
        let mut ready: Vec<RawFd> = Vec::new();
        let mut next_check = checks_from + CHECK_INTERVAL;
        loop {
            ready.clear();
            self.poller.wait(next_check.saturating_duration_since(Instant::now()), &mut ready);
            if plant::on(Plant::AcceptOrder) {
                // The plant takes a wake-up's ready connections in accept order. So that the scenario's two requests
                // are always readable in one wake-up (otherwise that is timing: the review saw 44 in 50), it also lets
                // the reader gather for 2 ms before it takes the list.
                thread::sleep(Duration::from_millis(2));
                let mut more = Vec::new();
                self.poller.wait(Duration::ZERO, &mut more);
                for fd in more {
                    if !ready.contains(&fd) {
                        ready.push(fd);
                    }
                }
                let order = |fd: &RawFd| self.connections.get(fd).map_or(0, |connection| connection.order);
                ready.sort_by_key(order);
            }
            // Connections accepted in this wake-up are watched from the next wait on (libuv's watcher queue).
            let mut fresh = Vec::new();
            for fd in ready.iter().copied() {
                if fd == listen_fd {
                    self.accept(&listen, &mut fresh);
                } else if fd == wake_fd {
                    let mut sink = [0u8; 256];
                    while matches!((&wake).read(&mut sink), Ok(count) if count > 0) {}
                    let waiting: Vec<mpsc::Sender<Ticket>> = self
                        .shared
                        .finished_bodies
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .drain(..)
                        .collect();
                    for reply in waiting {
                        let _ = reply.send(self.shared.turns.issue());
                    }
                } else if let Some(connection) = self.connections.remove(&fd) {
                    // Nothing a request holds can stop the reader: were a step to panic, that connection alone
                    // is dropped (and closed), and the loop goes on.
                    let kept = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.readable(connection)));
                    if let Ok(Some(connection)) = kept {
                        self.connections.insert(fd, connection);
                    }
                }
            }
            for connection in fresh {
                let fd = connection.stream.as_raw_fd();
                self.poller.add(fd);
                self.connections.insert(fd, connection);
            }
            if Instant::now() >= next_check {
                self.check_timeouts();
                next_check += CHECK_INTERVAL;
            }
        }
    }
}

fn json_answer(stream: &mut TcpStream, status: u16, body: &serde_json::Value) {
    let bytes = body.to_string().into_bytes();
    let response = Response {
        status,
        headers: vec![
            ("Content-Type".to_owned(), "application/json".to_owned()),
            ("Content-Length".to_owned(), bytes.len().to_string()),
        ],
        body: bytes,
        head_only: false,
    };
    let _ = http::write_response(stream, &response, &[]);
}

fn control(mut stream: TcpStream, exchanges: &Exchanges) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let Ok(request) = http::read_request(&mut stream, 64 * 1024) else { return };
    let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
    match (request.method.as_str(), path) {
        ("GET", "/quiescent") => {
            let seq = query.split('&').find_map(|pair| pair.strip_prefix("seq=")).and_then(sequence_number);
            let Some(seq) = seq else {
                json_answer(
                    &mut stream,
                    200,
                    &serde_json::json!({ "seq": null, "quiescent": false, "pending": [{ "type": "unknown-exchange", "site": "no exchange NaN" }] }),
                );
                return;
            };
            let (quiescent, known) = exchanges.wait(seq);
            if quiescent {
                json_answer(&mut stream, 200, &serde_json::json!({ "seq": seq, "quiescent": true, "pending": [] }));
            } else if known {
                json_answer(
                    &mut stream,
                    200,
                    &serde_json::json!({ "seq": seq, "quiescent": false, "pending": [{ "type": "exchange", "site": "rust candidate" }] }),
                );
            } else {
                json_answer(
                    &mut stream,
                    200,
                    &serde_json::json!({ "seq": seq, "quiescent": false, "pending": [{ "type": "unknown-exchange", "site": format!("no exchange {seq}") }] }),
                );
            }
        }
        ("POST", "/stop") => {
            json_answer(&mut stream, 200, &serde_json::json!({ "stopping": true }));
            let _ = stream.shutdown(Shutdown::Write);
            std::process::exit(0);
        }
        _ => json_answer(&mut stream, 404, &serde_json::json!({ "error": "no route" })),
    }
}

extern "C" fn stop_on_signal(_signal: libc::c_int) {
    // SAFETY: _exit is async-signal-safe; nothing else runs in the handler.
    unsafe { libc::_exit(0) };
}

fn bind(address: &str) -> TcpListener {
    TcpListener::bind(address).unwrap_or_else(|error| refuse(&format!("cannot listen on {address}: {error}")))
}

/// The command: never returns.
pub fn main() -> ! {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = options(&args);
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: installs a handler that only calls _exit.
        unsafe { libc::signal(signal, stop_on_signal as *const () as libc::sighandler_t) };
    }
    let (wake_read, wake_write) = UnixStream::pair().unwrap_or_else(|error| refuse(&format!("cannot make the reader's wake-up pair: {error}")));
    if wake_read.set_nonblocking(true).is_err() || wake_write.set_nonblocking(true).is_err() {
        refuse("cannot make the wake-up pair non-blocking");
    }
    let shared = Arc::new(Shared {
        runtime: Runtime::new(&options.data_root),
        exchanges: Exchanges::default(),
        turns: Turns::new(),
        finished_bodies: Mutex::new(VecDeque::new()),
        wake: wake_write,
    });
    let listen = bind(&options.listen);
    if listen.set_nonblocking(true).is_err() {
        refuse("cannot make the listen socket non-blocking");
    }
    let control_listener = bind(&options.control);
    let ports = (
        listen.local_addr().map(|address| address.port()).unwrap_or(0),
        control_listener.local_addr().map(|address| address.port()).unwrap_or(0),
    );
    {
        let shared = Arc::clone(&shared);
        thread::spawn(move || {
            for stream in control_listener.incoming().flatten() {
                let shared = Arc::clone(&shared);
                spawn(move || control(stream, &shared.exchanges));
            }
        });
    }
    thread::spawn(|| {
        // The launcher gone (its pipe to stdin ended): stop.
        let mut sink = [0u8; 256];
        while matches!(std::io::stdin().read(&mut sink), Ok(count) if count > 0) {}
        std::process::exit(0);
    });
    let checks_from = Instant::now();
    let poller = poller::Poller::new().unwrap_or_else(|error| refuse(&format!("cannot make the readiness queue: {error}")));
    let reader = EventLoop {
        shared,
        poller,
        connections: HashMap::new(),
        accepted: 0,
        chunk: vec![0u8; READ_CHUNK],
    };
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{}", serde_json::json!({ "ready": { "listen": ports.0, "control": ports.1 } }));
    let _ = stdout.flush();
    reader.run(listen, wake_read, checks_from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes() {
        let encode = |text: &str| crate::answer::base64(text.as_bytes()).into_bytes();
        assert_eq!(check_envelope(Some(&encode("{\"v\":1,\"seq\":3}")), Some("3")), Ok(()));
        assert!(check_envelope(Some(&encode("{\"v\":2,\"seq\":3}")), Some("3")).is_err());
        assert!(check_envelope(Some(&encode("{\"v\":1,\"seq\":4}")), Some("3")).is_err());
        assert_eq!(
            check_envelope(None, None),
            Err("harness: the envelope is missing, not version 1, or names another exchange (seq NaN)".to_owned())
        );
    }
}
