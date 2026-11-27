//! The binary under a process file-size limit and with a client that leaves mid-response (BH7 fix round 1, B1),
//! against the expectation the JavaScript candidate adapter is held to as well (`tests/process-limits.json`, read by
//! `scripts/backend-conformance/process-limits.test.mjs`): a save past the limit answers 500 with Node's EFBIG text,
//! leaves no temporary file and the process alive, and the next save works; a GET whose client closes while the
//! answer is still being written costs nothing but that connection.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const FILE: &str = "sessions-directories.json";

fn expected() -> serde_json::Value {
    serde_json::from_str(include_str!("process-limits.json")).expect("the expectation file")
}

struct Arm {
    child: Child,
    port: u16,
    seq: u64,
}

impl Arm {
    fn start(root: &Path, home: &Path, blocks: u64) -> Arm {
        let binary = env!("CARGO_BIN_EXE_devryan-route-session-folders");
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("ulimit -f {blocks} && exec \"$0\" \"$@\""))
            .arg(binary)
            .args(["--listen", "127.0.0.1:0", "--control", "127.0.0.1:0", "--data-root"])
            .arg(root)
            .arg("--home")
            .arg(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the binary starts");
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout"))
            .read_line(&mut line)
            .expect("the ready line");
        let ready: serde_json::Value = serde_json::from_str(&line).expect("a ready record");
        let port = ready["ready"]["listen"].as_u64().expect("a port") as u16;
        Arm { child, port, seq: 0 }
    }

    fn send(&mut self, method: &str, body: &[u8]) -> TcpStream {
        self.seq += 1;
        let envelope = base64(format!("{{\"v\":1,\"seq\":{}}}", self.seq).as_bytes());
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect");
        stream.set_read_timeout(Some(Duration::from_secs(60))).expect("timeout");
        let head = format!(
            "{method} /api/session-folders HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-DevRyan-Harness-Envelope: {envelope}\r\nX-DevRyan-Harness-Seq: {}\r\n\r\n",
            body.len(),
            self.seq
        );
        stream.write_all(head.as_bytes()).expect("head");
        stream.write_all(body).expect("body");
        stream
    }

    /// The status and body of one exchange.
    fn exchange(&mut self, method: &str, body: &[u8]) -> (u16, Vec<u8>) {
        let mut stream = self.send(method, body);
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).expect("the answer");
        let split = answer.windows(4).position(|window| window == b"\r\n\r\n").expect("a head");
        let status = std::str::from_utf8(&answer[9..12]).expect("status").parse().expect("a status");
        (status, answer[split + 4..].to_vec())
    }

    fn alive(&mut self) -> bool {
        self.child.try_wait().expect("try_wait").is_none()
    }
}

impl Drop for Arm {
    fn drop(&mut self) {
        // The command stops when its stdin ends; past a deadline it is killed.
        drop(self.child.stdin.take());
        let until = Instant::now() + Duration::from_secs(10);
        while self.alive() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        if self.alive() {
            eprintln!("process_limits: the binary (pid {}) did not stop in 10 s; killed", self.child.id());
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = chunk.iter().enumerate().fold(0u32, |sum, (at, byte)| sum | u32::from(*byte) << (16 - 8 * at));
        for at in 0..4 {
            out.push(if at <= chunk.len() {
                char::from(ALPHABET[(value >> (18 - 6 * at) & 63) as usize])
            } else {
                '='
            });
        }
    }
    out
}

fn pad(bytes: u64, unit: char) -> Vec<u8> {
    format!("{{\"pad\":\"{}\"}}", unit.to_string().repeat(bytes as usize)).into_bytes()
}

fn pretty(bytes: u64, unit: char) -> Vec<u8> {
    format!("{{\n  \"pad\": \"{}\"\n}}", unit.to_string().repeat(bytes as usize)).into_bytes()
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch() -> Scratch {
    let dir = std::env::temp_dir().join(format!(
        "devryan-process-limits-{}-{}",
        std::process::id(),
        devryan_route_common::fsjs::random_uuid()
    ));
    std::fs::create_dir_all(dir.join("data")).expect("data root");
    std::fs::create_dir_all(dir.join("home")).expect("home");
    Scratch(dir)
}

fn leftovers(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .expect("the data root")
        .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".tmp-"))
        .collect();
    names.sort();
    names
}

#[test]
fn a_save_past_the_file_size_limit_fails_as_node_fails_it() {
    let want = expected();
    let number = |key: &str| want[key].as_u64().expect(key);
    let text = |key: &str| want[key].as_str().expect(key).as_bytes().to_vec();
    let dir = scratch();
    let root = dir.0.join("data");
    let mut arm = Arm::start(&root, &dir.0.join("home"), number("ulimitBlocks"));
    assert_eq!(arm.exchange("POST", &pad(number("smallPad"), 'a')), (200, text("saved")));
    assert_eq!(std::fs::read(root.join(FILE)).expect("the file"), pretty(number("smallPad"), 'a'));
    assert_eq!(arm.exchange("POST", &pad(number("largePad"), 'b')), (500, text("tooLarge")));
    assert!(arm.alive(), "the process survives the limit");
    assert_eq!(std::fs::read(root.join(FILE)).expect("the file"), pretty(number("smallPad"), 'a'));
    assert_eq!(leftovers(&root), Vec::<String>::new(), "the temporary file is removed");
    assert_eq!(arm.exchange("POST", &pad(number("smallPad"), 'c')), (200, text("saved")));
    assert_eq!(arm.exchange("GET", b""), (200, pad(number("smallPad"), 'c')));
}

#[test]
fn a_client_that_leaves_mid_response_costs_only_its_connection() {
    let want = expected();
    let size = want["disconnectPad"].as_u64().expect("disconnectPad");
    let dir = scratch();
    let root = dir.0.join("data");
    std::fs::write(root.join(FILE), pretty(size, 'd')).expect("the large file");
    let mut arm = Arm::start(&root, &dir.0.join("home"), 1 << 30);
    for _ in 0..3 {
        let mut stream = arm.send("GET", b"");
        let mut first = [0u8; 64];
        let read = stream.read(&mut first).expect("the answer starts");
        assert!(read > 0 && first.starts_with(b"HTTP/1.1 200"));
        drop(stream);
    }
    assert!(arm.alive(), "the process survives the closed connections");
    let (status, body) = arm.exchange("GET", b"");
    assert_eq!((status, body.len()), (200, pad(size, 'd').len()));
    assert_eq!(
        arm.exchange("POST", &pad(10, 'e')),
        (200, expected()["saved"].as_str().expect("saved").as_bytes().to_vec())
    );
}
