//! Byte-transparent pass-through. Each client connection gets its own
//! upstream connection, opened when the client connects and closed when it
//! closes, and each direction is a plain copy loop: whatever arrives is written
//! on, unchanged, as soon as it arrives. Nothing is parsed to forward, so
//! nothing can be added, removed, rewritten, merged or reordered: request and
//! response heads, bodies (fixed, chunked or close-delimited), interim
//! responses, pipelined requests, upgrades and WebSocket frames all pass as the
//! bytes they are. A half-close is passed on as a half-close, a reset as a
//! reset, and a refused upstream connection as a reset of the client's.
//!
//! A connection holds two descriptors, one per socket: both directions and the
//! stop list share each socket (`Arc<TcpStream>`; reads, writes and shutdowns
//! all work on `&TcpStream`), and the socket closes when the last of them lets
//! go, as it did when each held its own duplicate descriptor.

use std::io::{self, ErrorKind, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::sys;

const BUFFER: usize = 64 * 1024;

/// One socket, shared by both directions and the stop list.
type Shared = Arc<TcpStream>;

pub struct Proxy {
    pub upstream: SocketAddr,
    stopping: AtomicBool,
    active: AtomicU64,
    connections: Mutex<Vec<(u64, Shared, Shared)>>,
    next: AtomicU64,
    pub accepted: AtomicU64,
}

impl Proxy {
    pub fn new(upstream: SocketAddr) -> Arc<Self> {
        Arc::new(Self {
            upstream,
            stopping: AtomicBool::new(false),
            active: AtomicU64::new(0),
            connections: Mutex::new(Vec::new()),
            next: AtomicU64::new(1),
            accepted: AtomicU64::new(0),
        })
    }

    /// Accepts until `stop` is called. Each connection runs on its own threads.
    pub fn serve(self: &Arc<Self>, listener: TcpListener) {
        // Non-blocking accept with a short poll so `stop` is noticed promptly.
        if listener.set_nonblocking(true).is_err() {
            return;
        }
        let mut reported: Option<Instant> = None;
        while !self.stopping.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((client, _)) => {
                    self.accepted.fetch_add(1, Ordering::SeqCst);
                    self.active.fetch_add(1, Ordering::SeqCst);
                    let proxy = Arc::clone(self);
                    let _ = client.set_nonblocking(false);
                    let spawned = thread::Builder::new().name("front-conn".into()).spawn(move || {
                        proxy.handle(client);
                        proxy.active.fetch_sub(1, Ordering::SeqCst);
                    });
                    if spawned.is_err() {
                        self.active.fetch_sub(1, Ordering::SeqCst);
                        eprintln!("{}", serde_json::json!({ "event": "connection-thread-failed" }));
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(2)),
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => {
                    // Out of descriptors (EMFILE) or similar: the connection waits in
                    // the backlog. Say so, at most once a second.
                    if reported.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                        eprintln!("{}", serde_json::json!({ "event": "accept-failed", "error": error.to_string() }));
                        reported = Some(Instant::now());
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }

    /// Stops accepting and closes every open connection.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(connections) = self.connections.lock() {
            for (_, client, upstream) in connections.iter() {
                let _ = client.shutdown(Shutdown::Both);
                let _ = upstream.shutdown(Shutdown::Both);
            }
        }
    }

    /// Waits until every connection has ended, up to `timeout`; false if some are still open.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while self.active.load(Ordering::SeqCst) > 0 {
            if Instant::now() > deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        true
    }

    fn handle(self: &Arc<Self>, client: TcpStream) {
        let upstream = match TcpStream::connect(self.upstream) {
            Ok(upstream) => upstream,
            Err(_) => {
                // What a client sees when the server refuses it: a reset, no bytes.
                sys::reset(&client);
                return;
            }
        };
        let _ = client.set_nodelay(true);
        let _ = upstream.set_nodelay(true);
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (client, upstream) = (Arc::new(client), Arc::new(upstream));
        if let Ok(mut connections) = self.connections.lock() {
            connections.push((id, Arc::clone(&client), Arc::clone(&upstream)));
        }
        // `stop` sets the flag before it walks the list: a connection it missed sees the flag here.
        if self.stopping.load(Ordering::SeqCst) {
            let _ = client.shutdown(Shutdown::Both);
            let _ = upstream.shutdown(Shutdown::Both);
        }
        let (client_read, upstream_write) = (Arc::clone(&client), Arc::clone(&upstream));
        let outbound = thread::Builder::new()
            .name("front-c2u".into())
            .spawn(move || pump(&client_read, &upstream_write));
        pump(&upstream, &client);
        if let Ok(handle) = outbound {
            let _ = handle.join();
        }
        if let Ok(mut connections) = self.connections.lock() {
            connections.retain(|(other, _, _)| *other != id);
        }
    }
}

/// Copies `from` to `to` until `from` ends. An orderly end becomes a
/// half-close of `to`; a reset becomes a reset of `to`.
fn pump(from: &TcpStream, to: &TcpStream) {
    let (mut from, mut to) = (from, to);
    let mut buffer = vec![0u8; BUFFER];
    let outcome: io::Result<()> = loop {
        match from.read(&mut buffer) {
            Ok(0) => break Ok(()),
            Ok(count) => {
                if let Err(error) = to.write_all(&buffer[..count]) {
                    break Err(error);
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => break Err(error),
        }
    };
    match outcome {
        Ok(()) => {
            let _ = to.shutdown(Shutdown::Write);
        }
        Err(error) if error.kind() == ErrorKind::ConnectionReset => {
            // The last close of `to` then sends a reset (no FIN first); waking
            // the other direction's reader lets that close happen.
            sys::reset(to);
            let _ = to.shutdown(Shutdown::Read);
            let _ = from.shutdown(Shutdown::Both);
        }
        Err(_) => {
            // The other side cannot take more: stop both directions.
            let _ = to.shutdown(Shutdown::Both);
            let _ = from.shutdown(Shutdown::Both);
        }
    }
}
