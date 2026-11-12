//! Byte transparency: for each case a client talks to a scripted upstream
//! directly, then through the front. The bytes the client receives, and the
//! bytes the upstream receives, must be identical in both runs.

mod common;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use common::ws;
use common::*;

/// Runs `client` directly and through the front; asserts byte equality both
/// ways; returns what the client received.
fn transparent(connections: usize, handler: impl Fn(Logged) -> Vec<u8> + Send + Sync + 'static, client: impl Fn(SocketAddr) -> Vec<u8>) -> Vec<u8> {
    let received = Received::default();
    let sink = received.clone();
    let upstream = Upstream::start(Arc::new(move |stream: TcpStream| {
        let log = handler(Logged::new(stream));
        sink.push(log);
    }));
    let direct = client(upstream.address);
    let direct_upstream = received.take_when(connections);
    let front = Front::start(upstream.address);
    let through = client(front.address);
    let through_upstream = received.take_when(connections);
    assert_eq!(direct, through, "client bytes differ through the front");
    assert_eq!(direct_upstream, through_upstream, "upstream bytes differ through the front");
    direct
}

fn connect(address: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    stream
}

fn drain(mut stream: Logged) -> Vec<u8> {
    let mut rest = Vec::new();
    let _ = stream.read_to_end(&mut rest);
    stream.log
}

#[test]
fn fixed_length_bodies_with_keep_alive_and_connection_reuse() {
    let out = transparent(
        1,
        |mut s| {
            let mut pending = Vec::new();
            let mut n = 0;
            while let Some((head, body)) = read_request(&mut s, &mut pending) {
                n += 1;
                let reply = format!("{} {} got {} bytes #{n}", head.method, head.target, body.len());
                write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-Odd:  spaced value \r\nContent-Length: {}\r\n\r\n{reply}",
                    reply.len()
                )
                .unwrap();
            }
            drain(s)
        },
        |address| {
            let mut stream = connect(address);
            stream
                .write_all(b"POST /a HTTP/1.1\r\nHost: x\r\nCookie: a=1\r\nContent-Length: 5\r\n\r\nhello")
                .unwrap();
            let mut out = Vec::new();
            read_until(&mut stream, &mut out, b"#1");
            // Pipelined: two requests in one write.
            stream
                .write_all(b"GET /b HTTP/1.1\r\nHost: x\r\n\r\nGET /c?q=1 HTTP/1.1\r\nhost: x\r\n\r\n")
                .unwrap();
            read_until(&mut stream, &mut out, b"#3");
            close_write(&stream);
            out.extend(read_all(&mut stream, 4096, Duration::ZERO));
            out
        },
    );
    assert!(String::from_utf8_lossy(&out).contains("GET /c?q=1 got 0 bytes #3"));
}

#[test]
fn chunked_bodies_both_ways_with_trailers() {
    transparent(
        1,
        |mut s| {
            let mut pending = Vec::new();
            let (_, body) = read_request(&mut s, &mut pending).unwrap();
            s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Sum\r\n\r\n").unwrap();
            for piece in body.chunks(7) {
                write!(s, "{:x};ext=a\r\n", piece.len()).unwrap();
                s.write_all(piece).unwrap();
                s.write_all(b"\r\n").unwrap();
                thread::sleep(Duration::from_millis(2));
            }
            s.write_all(b"0\r\nX-Sum: 42\r\n\r\n").unwrap();
            drain(s)
        },
        |address| {
            let mut stream = connect(address);
            stream.write_all(b"PUT /up HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            for piece in [&b"abc"[..], b"defghij", b"klmnopqrstuvwxyz"] {
                write!(stream, "{:X}\r\n", piece.len()).unwrap();
                stream.write_all(piece).unwrap();
                stream.write_all(b"\r\n").unwrap();
                thread::sleep(Duration::from_millis(3));
            }
            stream.write_all(b"0\r\n\r\n").unwrap();
            let mut out = Vec::new();
            read_until(&mut stream, &mut out, b"X-Sum: 42\r\n\r\n");
            close_write(&stream);
            out.extend(read_all(&mut stream, 4096, Duration::ZERO));
            out
        },
    );
}

#[test]
fn large_bodies_with_slow_readers_and_writers() {
    let size = 6 * 1024 * 1024;
    let out = transparent(
        1,
        move |mut s| {
            let mut pending = Vec::new();
            let (_, body) = read_request(&mut s, &mut pending).unwrap();
            assert_eq!(body.len(), size);
            let reply: Vec<u8> = (0..size).map(|i| (i * 7 % 251) as u8).collect();
            write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {size}\r\n\r\n").unwrap();
            write_slowly(&mut s.stream, &reply, 256 * 1024, Duration::from_millis(5));
            drain(s)
        },
        move |address| {
            let mut stream = connect(address);
            let body: Vec<u8> = (0..size).map(|i| (i % 253) as u8).collect();
            write!(stream, "POST /big HTTP/1.1\r\nHost: x\r\nContent-Length: {size}\r\n\r\n").unwrap();
            write_slowly(&mut stream, &body, 512 * 1024, Duration::from_millis(5));
            let mut out = Vec::new();
            // A slow reader: small reads with pauses for the first part.
            let mut buffer = [0u8; 8192];
            for _ in 0..40 {
                let n = stream.read(&mut buffer).unwrap();
                out.extend_from_slice(&buffer[..n]);
                thread::sleep(Duration::from_millis(5));
            }
            read_exact_into(&mut stream, &mut out, size + 40);
            close_write(&stream);
            out.extend(read_all(&mut stream, 65536, Duration::ZERO));
            out
        },
    );
    assert!(out.len() > size);
}

#[test]
fn head_204_304_and_interim_responses() {
    let out = transparent(
        1,
        |mut s| {
            let mut pending = Vec::new();
            while let Some((head, _)) = read_request(&mut s, &mut pending) {
                match head.target.as_str() {
                    "/head" => s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1234\r\nETag: \"x\"\r\n\r\n").unwrap(),
                    "/none" => s.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap(),
                    "/cached" => s.write_all(b"HTTP/1.1 304 Not Modified\r\nContent-Length: 99\r\n\r\n").unwrap(),
                    _ => s.write_all(b"HTTP/1.1 103 Early Hints\r\nLink: </a.css>; rel=preload\r\n\r\nHTTP/1.1 102 Processing\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").unwrap(),
                }
            }
            drain(s)
        },
        |address| {
            let mut stream = connect(address);
            let mut out = Vec::new();
            stream.write_all(b"HEAD /head HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            read_until(&mut stream, &mut out, b"\"x\"\r\n\r\n");
            stream.write_all(b"GET /none HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            read_until(&mut stream, &mut out, b"No Content\r\n\r\n");
            stream.write_all(b"GET /cached HTTP/1.1\r\nHost: x\r\nIf-None-Match: \"x\"\r\n\r\n").unwrap();
            read_until(&mut stream, &mut out, b"99\r\n\r\n");
            stream.write_all(b"GET /hints HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            read_until(&mut stream, &mut out, b"ok");
            close_write(&stream);
            out.extend(read_all(&mut stream, 4096, Duration::ZERO));
            out
        },
    );
    assert!(String::from_utf8_lossy(&out).ends_with("ok"));
}

#[test]
fn expect_100_continue() {
    transparent(
        1,
        |mut s| {
            let mut pending = Vec::new();
            let mut buffer = [0u8; 4096];
            while http_head_incomplete(&pending) {
                let n = s.read(&mut buffer).unwrap();
                pending.extend_from_slice(&buffer[..n]);
            }
            s.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").unwrap();
            let (_, body) = read_request(&mut s, &mut pending).unwrap();
            write!(s, "HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n", body.len()).unwrap();
            s.write_all(&body).unwrap();
            drain(s)
        },
        |address| {
            let mut stream = connect(address);
            stream
                .write_all(b"POST /e HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\n")
                .unwrap();
            let mut out = Vec::new();
            read_until(&mut stream, &mut out, b"Continue\r\n\r\n");
            stream.write_all(b"body").unwrap();
            read_until(&mut stream, &mut out, b"body");
            close_write(&stream);
            out.extend(read_all(&mut stream, 4096, Duration::ZERO));
            out
        },
    );
}

fn http_head_incomplete(bytes: &[u8]) -> bool {
    !bytes.windows(4).any(|w| w == b"\r\n\r\n")
}

#[test]
fn websocket_upgrade_with_every_frame_kind() {
    let out = transparent(
        1,
        |mut s| {
            let mut pending = Vec::new();
            let (head, _) = read_request(&mut s, &mut pending).unwrap();
            assert!(has_token(&head.headers, "upgrade", "websocket"));
            s.write_all(
                b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
            )
            .unwrap();
            s.write_all(&ws::encode(true, ws::TEXT, b"{\"type\":\"ready\"}", None)).unwrap();
            let mut reader = ws::FrameReader::default();
            let mut buffer = [0u8; 4096];
            loop {
                let mut frames = reader.feed(&pending).unwrap();
                pending.clear();
                if frames.is_empty() {
                    let n = s.read(&mut buffer).unwrap();
                    if n == 0 {
                        break;
                    }
                    frames = reader.feed(&buffer[..n]).unwrap();
                }
                let mut closed = false;
                for frame in frames {
                    match frame.opcode {
                        ws::TEXT | ws::BINARY => s.write_all(&ws::encode(true, frame.opcode, &frame.payload, None)).unwrap(),
                        ws::PING => s.write_all(&ws::encode(true, ws::PONG, &frame.payload, None)).unwrap(),
                        ws::CLOSE => {
                            s.write_all(&ws::encode(true, ws::CLOSE, &frame.payload, None)).unwrap();
                            closed = true;
                        }
                        _ => {}
                    }
                }
                if closed {
                    s.write_all(&ws::encode(true, ws::PING, b"late", None)).ok();
                    break;
                }
            }
            let _ = s.stream.shutdown(std::net::Shutdown::Write);
            drain(s)
        },
        |address| {
            let mut stream = connect(address);
            stream.write_all(b"GET /ws?events=devryan HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
            let mut out = Vec::new();
            read_until(&mut stream, &mut out, b"{\"type\":\"ready\"}");
            let mask = Some([1, 2, 3, 4]);
            stream.write_all(&ws::encode(true, ws::TEXT, "héllo".as_bytes(), mask)).unwrap();
            stream.write_all(&ws::encode(true, ws::BINARY, &[0, 159, 255, 1], mask)).unwrap();
            stream.write_all(&ws::encode(true, ws::PING, b"p", mask)).unwrap();
            stream.write_all(&ws::encode(true, ws::PONG, b"unsolicited", mask)).unwrap();
            thread::sleep(Duration::from_millis(30));
            stream.write_all(&ws::encode(true, ws::CLOSE, &[0x03, 0xE8, b'b', b'y', b'e'], mask)).unwrap();
            out.extend(read_all(&mut stream, 4096, Duration::ZERO));
            out
        },
    );
    let frames = {
        let start = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let mut reader = ws::FrameReader::default();
        reader.feed(&out[start..]).unwrap()
    };
    let kinds: Vec<u8> = frames.iter().map(|f| f.opcode).collect();
    assert_eq!(kinds, [ws::TEXT, ws::TEXT, ws::BINARY, ws::PONG, ws::CLOSE, ws::PING]);
}

/// A long-lived event stream: the server keeps ids and replays after `Last-Event-ID`.
fn event_server(mut s: Logged) -> Vec<u8> {
    let mut pending = Vec::new();
    let Some((head, _)) = read_request(&mut s, &mut pending) else { return s.log };
    let from: u32 = devryan_front::http::header(&head.headers, "last-event-id")
        .and_then(|v| v.parse().ok())
        .map(|v: u32| v + 1)
        .unwrap_or(1);
    s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\n\r\n")
        .unwrap();
    let mut send = |text: String| -> bool { s.stream.write_all(format!("{:x}\r\n{text}\r\n", text.len()).as_bytes()).is_ok() };
    send(": heartbeat\n\n".to_string());
    for id in from..from + 400 {
        if !send(format!("id: {id}\nevent: tick\ndata: {{\"n\":{id}}}\n\n")) {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    drain(s)
}

#[test]
fn event_stream_with_disconnect_and_last_event_id_reconnect() {
    let out = transparent(2, event_server, |address| {
        let mut first = connect(address);
        first
            .write_all(b"GET /api/global/event HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n")
            .unwrap();
        let mut out = Vec::new();
        read_until(&mut first, &mut out, b"data: {\"n\":5}\n\n\r\n");
        drop(first);
        let mut second = connect(address);
        second
            .write_all(b"GET /api/global/event HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\nLast-Event-ID: 5\r\n\r\n")
            .unwrap();
        let mut more = Vec::new();
        read_until(&mut second, &mut more, b"data: {\"n\":9}\n\n\r\n");
        out.extend(more);
        out
    });
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("id: 6\n"));
}

#[test]
fn upstream_closing_early() {
    let out = transparent(
        1,
        |mut s| {
            let mut pending = Vec::new();
            read_request(&mut s, &mut pending);
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial").unwrap();
            let log = s.log.clone();
            drop(s);
            log
        },
        |address| {
            let mut stream = connect(address);
            stream.write_all(b"GET /early HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            read_all(&mut stream, 4096, Duration::ZERO)
        },
    );
    assert!(out.ends_with(b"partial"));
}

#[test]
fn upstream_refusing_connections() {
    // A port nothing listens on.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let direct = TcpStream::connect(closed);
    assert!(direct.is_err(), "nothing should listen on {closed}");
    let front = Front::start(closed);
    let mut stream = TcpStream::connect(front.address).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let _ = stream.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    let mut buffer = [0u8; 64];
    let result = stream.read(&mut buffer);
    // No bytes reach the client, as with a direct refusal, and the close is a reset.
    match result {
        Ok(0) => {}
        Ok(n) => panic!("the front sent {n} bytes for a refused upstream"),
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset),
    }
}

/// Heads a parser would reject or read two ways reach the upstream unchanged:
/// the front parses nothing, so it cannot disagree with the server about where
/// a message ends. The upstream reads to the client's half-close, then answers.
#[test]
fn malformed_ambiguous_and_oversized_heads_pass_unchanged() {
    let mut huge = b"GET /b HTTP/1.1\r\nHost: x\r\nX-Big: ".to_vec();
    huge.extend(std::iter::repeat_n(b'a', 2 * 1024 * 1024));
    huge.extend(b"\r\n\r\n");
    let cases: Vec<Vec<u8>> = vec![
        // An obsolete folded header.
        b"GET /a HTTP/1.1\r\nHost: x\r\nX-Folded: one\r\n  two\r\n\r\n".to_vec(),
        // A head over 2 MiB.
        huge,
        // Content-Length and Transfer-Encoding together, then a second request hidden in the body.
        b"POST /c HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /hidden HTTP/1.1\r\nHost: x\r\n\r\n".to_vec(),
        // Two Content-Length headers that disagree, and bare LF line ends.
        b"POST /d HTTP/1.1\nHost: x\nContent-Length: 1\nContent-Length: 5\n\nhello".to_vec(),
    ];
    for bytes in cases {
        let request = bytes.clone();
        transparent(
            1,
            |mut s| {
                let mut seen = Vec::new();
                let _ = s.read_to_end(&mut seen);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                s.log
            },
            move |address| {
                let mut stream = connect(address);
                stream.write_all(&request).unwrap();
                close_write(&stream);
                read_all(&mut stream, 4096, Duration::ZERO)
            },
        );
    }
}

/// A misspelt or unknown option, an unknown command, a missing upstream or a
/// fixed listen port is refused before anything starts.
#[test]
fn unknown_options_and_fixed_listen_ports_are_refused() {
    let exe = env!("CARGO_BIN_EXE_devryan-front");
    for args in [
        vec!["serve", "--listen", "127.0.0.1:0", "--upstream", "127.0.0.1:9", "--upstraem", "127.0.0.1:9"],
        vec!["serve", "--listen", "127.0.0.1:0", "--upstream", "127.0.0.1:9", "--verbose"],
        vec!["serve", "--listen", "127.0.0.1:4999", "--upstream", "127.0.0.1:9"],
        vec!["serve", "--listen", "127.0.0.1:0"],
        vec!["forward", "--listen", "127.0.0.1:0"],
    ] {
        let output = std::process::Command::new(exe).args(&args).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    }
}

#[test]
fn only_loopback_binds_are_accepted() {
    let exe = env!("CARGO_BIN_EXE_devryan-front");
    for address in ["0.0.0.0:0", "192.168.0.10:0", "[::]:0"] {
        let output = std::process::Command::new(exe)
            .args(["serve", "--listen", address, "--upstream", "127.0.0.1:9"])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{address}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("not a loopback address"), "{address}");
    }
    let output = std::process::Command::new(exe)
        .args(["serve", "--listen", "127.0.0.1:0", "--upstream", "10.0.0.1:80"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}

/// Three hundred connections held open at once through the real binary,
/// started with a soft limit of 256 open files (macOS's default): the front
/// raises its limit and holds two descriptors per connection, so every one is
/// answered.
#[test]
fn hundreds_of_concurrent_connections_under_a_low_open_file_limit() {
    const CONNECTIONS: usize = 300;
    // This test holds both ends of every connection itself.
    let limit = devryan_front::sys::raise_open_file_limit().unwrap();
    assert!(
        limit >= 4 * CONNECTIONS as u64 + 64,
        "this test needs more open files than the hard limit allows ({limit})"
    );
    let upstream = Upstream::start(Arc::new(|mut stream: TcpStream| {
        let mut buffer = [0u8; 64];
        let Ok(count) = stream.read(&mut buffer) else { return };
        let _ = stream.write_all(&buffer[..count]);
        let mut rest = Vec::new();
        let _ = stream.read_to_end(&mut rest);
    }));
    /// Stops the front even when an assertion fails.
    struct Running(std::process::Child);
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut front = Running(
        std::process::Command::new("/bin/sh")
            .args(["-c", "ulimit -S -n 256 && exec \"$0\" \"$@\"", env!("CARGO_BIN_EXE_devryan-front")])
            .args(["serve", "--listen", "127.0.0.1:0", "--upstream", &upstream.address.to_string()])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(front.0.stdout.take().unwrap()), &mut line).unwrap();
    let ready: serde_json::Value = serde_json::from_str(&line).unwrap();
    let address: SocketAddr = ready["listen"].as_str().unwrap().parse().unwrap();
    let mut clients: Vec<TcpStream> = (0..CONNECTIONS).map(|_| connect(address)).collect();
    for (index, client) in clients.iter_mut().enumerate() {
        client.write_all(format!("hello {index:03}").as_bytes()).unwrap();
    }
    let mut answered = 0;
    for (index, client) in clients.iter_mut().enumerate() {
        let mut buffer = [0u8; 9];
        if client.read_exact(&mut buffer).is_ok() && buffer == *format!("hello {index:03}").as_bytes() {
            answered += 1;
        }
    }
    drop(clients);
    drop(front);
    assert_eq!(answered, CONNECTIONS, "connections answered through the front");
}
