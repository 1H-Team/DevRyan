//! Shared test support: a scripted upstream server, an in-process front, and
//! the HTTP request and WebSocket framing the scripted peers speak (`ws`).
//! The front itself parses none of this; only the tests' peers do.
pub mod ws;

use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use devryan_front::http;
use devryan_front::proxy::Proxy;

pub type Handler = Arc<dyn Fn(TcpStream) + Send + Sync>;

/// A loopback server that runs `handler` on each connection.
pub struct Upstream {
    pub address: SocketAddr,
    stop: Arc<AtomicBool>,
}

impl Upstream {
    pub fn start(handler: Handler) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let handler = Arc::clone(&handler);
                        thread::spawn(move || handler(stream));
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
                    Err(_) => break,
                }
            }
        });
        Self { address, stop }
    }
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// The front, in process, in front of `upstream`.
pub struct Front {
    pub address: SocketAddr,
    pub proxy: Arc<Proxy>,
}

impl Front {
    pub fn start(upstream: SocketAddr) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = Proxy::new(upstream);
        let serving = Arc::clone(&proxy);
        thread::spawn(move || serving.serve(listener));
        Self { address, proxy }
    }
}

impl Drop for Front {
    fn drop(&mut self) {
        self.proxy.stop();
    }
}

/// A parsed request head: what the scripted upstreams look at.
#[derive(Clone, Debug, Default)]
pub struct RequestHead {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
}

/// `Ok(None)` while the head is incomplete; `Ok(Some((length, head)))` once it is.
fn parse_request_head(buffer: &[u8]) -> Result<Option<(usize, RequestHead)>, String> {
    let mut headers = [httparse::EMPTY_HEADER; 256];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(buffer) {
        Ok(httparse::Status::Partial) => Ok(None),
        Ok(httparse::Status::Complete(length)) => Ok(Some((
            length,
            RequestHead {
                method: request.method.unwrap_or_default().to_string(),
                target: request.path.unwrap_or_default().to_string(),
                headers: request
                    .headers
                    .iter()
                    .map(|header| (header.name.to_string(), String::from_utf8_lossy(header.value).into_owned()))
                    .collect(),
            },
        ))),
        Err(error) => Err(format!("request head: {error}")),
    }
}

/// True when any `name` header lists `token` among its comma-separated values.
pub fn has_token(headers: &[(String, String)], name: &str, token: &str) -> bool {
    headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .any(|(_, value)| value.split(',').any(|part| part.trim().eq_ignore_ascii_case(token)))
}

/// RFC 9112 section 6.3 for a request: chunked, a length, or no body.
fn request_body(head: &RequestHead) -> http::BodyKind {
    let chunked = head
        .headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("transfer-encoding"))
        .flat_map(|(_, value)| value.split(','))
        .map(str::trim)
        .next_back()
        .is_some_and(|coding| coding.eq_ignore_ascii_case("chunked"));
    if chunked {
        return http::BodyKind::Chunked;
    }
    match http::header(&head.headers, "content-length").and_then(|value| value.trim().parse().ok()) {
        Some(0) | None => http::BodyKind::None,
        Some(length) => http::BodyKind::Fixed(length),
    }
}

/// Reads one request head (and its fixed or chunked body) from `stream`,
/// keeping `pending` bytes for the next call. `None` at end of stream.
pub fn read_request(stream: &mut impl Read, pending: &mut Vec<u8>) -> Option<(RequestHead, Vec<u8>)> {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        if let Ok(Some((length, head))) = parse_request_head(pending) {
            pending.drain(..length);
            let body = match request_body(&head) {
                http::BodyKind::Fixed(n) => {
                    while (pending.len() as u64) < n {
                        let count = stream.read(&mut buffer).ok()?;
                        if count == 0 {
                            return None;
                        }
                        pending.extend_from_slice(&buffer[..count]);
                    }
                    pending.drain(..n as usize).collect()
                }
                http::BodyKind::Chunked => {
                    let mut decoder = http::ChunkDecoder::default();
                    let mut out = Vec::new();
                    loop {
                        let used = decoder.feed(pending, &mut out).ok()?;
                        pending.drain(..used);
                        if decoder.done() {
                            break;
                        }
                        let count = stream.read(&mut buffer).ok()?;
                        if count == 0 {
                            return None;
                        }
                        pending.extend_from_slice(&buffer[..count]);
                    }
                    out
                }
                _ => Vec::new(),
            };
            return Some((head, body));
        }
        let count = stream.read(&mut buffer).ok()?;
        if count == 0 {
            return None;
        }
        pending.extend_from_slice(&buffer[..count]);
    }
}

/// Everything until end of stream (or a reset), read in `chunk`-sized pieces with `pause` between.
pub fn read_all(stream: &mut TcpStream, chunk: usize, pause: Duration) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buffer = vec![0u8; chunk];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return out,
            Ok(n) => {
                out.extend_from_slice(&buffer[..n]);
                if !pause.is_zero() {
                    thread::sleep(pause);
                }
            }
        }
    }
}

/// Reads one byte at a time until `out` ends with `marker` (or the stream
/// ends), so nothing after the marker is consumed and results do not depend on timing.
pub fn read_until(stream: &mut impl Read, out: &mut Vec<u8>, marker: &[u8]) {
    let mut buffer = [0u8; 1];
    while !out.ends_with(marker) {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => out.extend_from_slice(&buffer[..n]),
        }
    }
}

/// Reads until at least `count` bytes are in `out`.
pub fn read_exact_into(stream: &mut impl Read, out: &mut Vec<u8>, count: usize) {
    let mut buffer = [0u8; 4096];
    while out.len() < count {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => out.extend_from_slice(&buffer[..n]),
        }
    }
}

pub fn write_slowly(stream: &mut TcpStream, bytes: &[u8], piece: usize, pause: Duration) {
    for part in bytes.chunks(piece) {
        stream.write_all(part).unwrap();
        thread::sleep(pause);
    }
}

pub fn close_write(stream: &TcpStream) {
    let _ = stream.shutdown(Shutdown::Write);
}

/// Bytes an upstream handler received, collected per connection for comparison.
#[derive(Clone, Default)]
pub struct Received(pub Arc<Mutex<Vec<Vec<u8>>>>);

impl Received {
    pub fn push(&self, bytes: Vec<u8>) {
        self.0.lock().unwrap().push(bytes);
    }
    pub fn take(&self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.0.lock().unwrap())
    }
}

/// A stream that keeps a copy of every byte read from it.
pub struct Logged {
    pub stream: TcpStream,
    pub log: Vec<u8>,
}

impl Logged {
    pub fn new(stream: TcpStream) -> Self {
        Self { stream, log: Vec::new() }
    }
}

impl Read for Logged {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.stream.read(buffer)?;
        self.log.extend_from_slice(&buffer[..count]);
        Ok(count)
    }
}

impl Write for Logged {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.stream.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

impl Received {
    /// Waits (up to 10 s) until `count` connections have pushed, then takes them.
    pub fn take_when(&self, count: usize) -> Vec<Vec<u8>> {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while self.0.lock().unwrap().len() < count && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        self.take()
    }
}
