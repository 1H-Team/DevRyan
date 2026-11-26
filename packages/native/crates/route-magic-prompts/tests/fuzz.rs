//! No input can panic the candidate (fix round 1 of BH6, item 1). A bounded, deterministic fuzz (one seed per
//! test, a fixed number of cases) over what request bytes and data-file bytes reach besides the request
//! decoding (tests/fuzz_limits.rs): request heads and their framing (Content-Length, chunked coding with sizes
//! near 2^64, fed in random pieces), JSON bodies (where the byte path must also agree with decoding then
//! parsing), and data files of every shape the runtime reads. One more test starts the candidate itself and
//! sends it the requests that killed it before (a chunk size near 2^64) and others: it must still answer.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use devryan_route_magic_prompts::answer::base64_decode;
use devryan_route_magic_prompts::http::{self, BodyDecoder};
use devryan_route_magic_prompts::json;
use devryan_route_magic_prompts::order::Ticket;
use devryan_route_magic_prompts::runtime::Runtime;

// ------------------------------------------------------------------ the draws

struct Draw(u64);

impl Draw {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn pick<'a, T>(&mut self, list: &'a [T]) -> &'a T {
        &list[self.below(list.len())]
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
    /// One mutation of `data`: flips, cuts, insertions, repeats.
    fn mutate(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = data.to_vec();
        for _ in 0..1 + self.below(3) {
            match self.below(8) {
                0 if !out.is_empty() => {
                    let at = self.below(out.len());
                    out[at] ^= 1 << self.below(8);
                }
                1 if !out.is_empty() => {
                    let at = self.below(out.len());
                    out[at] = self.next() as u8;
                }
                2 => {
                    let at = self.below(out.len() + 1);
                    out.truncate(at);
                }
                3 => {
                    let at = self.below(out.len() + 1);
                    let count = 1 + self.below(8);
                    let more = self.bytes(count);
                    out.splice(at..at, more);
                }
                4 => out.extend_from_slice(data),
                5 => out.extend_from_slice(&[0; 3]),
                6 => out.extend_from_slice(self.pick(&[&b"junk"[..], &[0x1f], &[0x1f, 0x8b], &[0x1f, 0x00], &[0x00, 0x41]])),
                _ if out.len() > 2 => {
                    let at = self.below(out.len() - 1);
                    out.remove(at);
                }
                _ => {}
            }
        }
        out
    }
}

fn rows(name: &str) -> Vec<Vec<String>> {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name);
    let text = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
    text.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.split('\t').map(str::to_owned).collect())
        .collect()
}

#[test]
fn json_paths_agree_and_never_panic() {
    let mut draw = Draw(0x00b6_f1c5_0002);
    let seeds: Vec<&[u8]> = vec![
        br#"{"text":"a"}"#,
        br#"{"text":"a","text":"b"}"#,
        br#"{"text":"a","text":1}"#,
        br#"{"a":{"text":"nested"},"text":"\ud800\u00e9\/x"}"#,
        br#"[{"text":"in array"}]"#,
        br#"{"text":"\u00zz"}"#,
        br#"{"text":"escaped key","pad":[1,-0.5e2,true,false,null,{"x":[]}]}"#,
        "{\"text\":\"é 中 😀 \u{7f}\"}".as_bytes(),
        b"{\"text\":\"\xff\xfe \xc3( bad\"}",
        b"  {\"text\" : \"spaced\" }  ",
        b"{\"text\":\"x\"} trailing",
        b"{\"__proto__\":{\"text\":\"p\"},\"text\":\"own\"}",
    ];
    for _ in 0..20_000 {
        let seed = *draw.pick(&seeds);
        let bytes = if draw.below(5) == 0 { seed.to_vec() } else { draw.mutate(seed) };
        let by_bytes = json::text_of_utf8(&bytes);
        let units = devryan_route_magic_prompts::text::utf8_units(&bytes);
        let by_value = json::parse(&units).map(|(graph, value)| match value {
            devryan_config_text::value::Val::Ref(id) => match graph.node(id) {
                devryan_config_text::value::Node::Object(object) => match object.get(&devryan_config_text::js::units("text")) {
                    Some(devryan_config_text::value::Val::String(text)) => Some(text.clone()),
                    _ => None,
                },
                devryan_config_text::value::Node::Array(_) => None,
            },
            _ => None,
        });
        assert_eq!(by_bytes.is_ok(), by_value.is_ok(), "{:?}", String::from_utf8_lossy(&bytes));
        if let (Ok(a), Ok(b)) = (&by_bytes, &by_value) {
            assert_eq!(a, b, "{:?}", String::from_utf8_lossy(&bytes));
        }
    }
    // Depth: a million levels, without recursion.
    let deep = format!("{}{}", "[".repeat(1_000_000), "]".repeat(1_000_000));
    assert!(json::text_of_utf8(deep.as_bytes()).is_ok());
}

#[test]
fn heads_and_framing_never_panic() {
    let mut draw = Draw(0x00b6_f1c5_0003);
    let sizes = [
        "fffffffffffffffe",
        "ffffffffffffffff",
        "10000000000000000",
        "0fffffffffffffffe",
        "7fffffffffffffff",
        "c",
        "C",
        "0",
        "",
        "g",
        "c ",
        "c;a=b",
        "1;",
    ];
    let framings = [
        "Transfer-Encoding: chunked\r\n",
        "Transfer-Encoding: gzip, chunked\r\n",
        "Transfer-Encoding: chunked, gzip\r\n",
        "Content-Length: 12\r\n",
        "Content-Length: 18446744073709551615\r\n",
        "Content-Length: 18446744073709551616\r\n",
        "Content-Length: 99999999999999999999999\r\n",
        "Content-Length: 12\r\nContent-Length: 12\r\n",
        "Content-Length: 12\r\nTransfer-Encoding: chunked\r\n",
        "",
    ];
    for _ in 0..20_000 {
        let mut wire = format!("PUT /api/magic-prompts/a HTTP/1.1\r\nHost: x\r\n{}\r\n", draw.pick(&framings)).into_bytes();
        for _ in 0..draw.below(3) {
            wire.extend_from_slice(format!("{}\r\n{{\"text\":\"x\"}}\r\n", draw.pick(&sizes)).as_bytes());
        }
        if draw.below(2) == 0 {
            wire.extend_from_slice(b"0\r\n\r\n");
        }
        let wire = if draw.below(3) == 0 { draw.mutate(&wire) } else { wire };
        // Whole, and in random pieces through the incremental decoder.
        let _ = http::parse_request(&wire);
        if let Ok(Some((head, length))) = http::parse_head(&wire) {
            let mut decoder = BodyDecoder::new(head.framing);
            let mut rest = &wire[length.min(wire.len())..];
            let mut total = 0usize;
            while !rest.is_empty() {
                let piece = 1 + draw.below(rest.len());
                match decoder.feed(&rest[..piece], &mut |bytes| total += bytes.len()) {
                    Ok(used) if used < piece => break,
                    Ok(_) => rest = &rest[piece..],
                    Err(_) => break,
                }
            }
            assert!(total <= wire.len());
        }
        let count = draw.below(200);
        let _ = http::parse_head(&draw.bytes(count));
    }
    // An incomplete head is refused once it passes Node's header limit, however it arrives.
    let long = format!("GET /x HTTP/1.1\r\nX: {}", "y".repeat(20_000));
    assert_eq!(http::parse_head(long.as_bytes()).unwrap_err(), http::ReadError::TooLarge);
}

#[test]
fn data_files_never_panic() {
    let mut draw = Draw(0x00b6_f1c5_0004);
    let dir = std::env::temp_dir().join(format!("devryan-route-fuzz-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a scratch folder");
    let seeds: Vec<Vec<u8>> = rows("runtime.tsv")
        .into_iter()
        .filter(|row| row[0] != "-")
        .map(|row| base64_decode(row[0].as_bytes()))
        .collect();
    let runtime = Runtime::new(dir.to_str().expect("a UTF-8 temp path"));
    let file = dir.join("magic-prompts.json");
    for index in 0..3000 {
        let seed = draw.pick(&seeds).clone();
        let bytes = if index % 4 == 0 { seed } else { draw.mutate(&seed) };
        std::fs::write(&file, &bytes).expect("the data file");
        let _ = runtime.read_prompt_state();
        let id: Vec<u16> = devryan_config_text::js::units(draw.pick(&["a", "git.pr.generate.visible", "__proto__", " x ", "Bad"]));
        let text: Vec<u16> = (0..draw.below(40)).map(|_| draw.next() as u16).collect();
        let _ = runtime.set_override(&Ticket::alone(), &id, &text);
        let _ = runtime.reset_override(&Ticket::alone(), &id);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------------ the candidate itself

struct Child(std::process::Child, PathBuf);

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

fn exchange(port: u16, bytes: &[u8], wait: Duration) -> Vec<u8> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("the candidate's listen port");
    let _ = stream.set_read_timeout(Some(wait));
    let _ = stream.write_all(bytes);
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
    answer
}

#[test]
fn the_requests_that_killed_it_are_answered_as_node_answers_them() {
    let root = std::env::temp_dir().join(format!("devryan-route-fuzz-child-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a data root");
    let child = Command::new(env!("CARGO_BIN_EXE_devryan-route-magic-prompts"))
        .args([
            "--listen",
            "127.0.0.1:0",
            "--control",
            "127.0.0.1:0",
            "--data-root",
            root.to_str().expect("UTF-8"),
            "--home",
            root.to_str().expect("UTF-8"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the candidate starts");
    let mut child = Child(child, root);
    let mut line = String::new();
    let mut stdout = child.0.stdout.take().expect("its stdout");
    let mut byte = [0u8; 1];
    while stdout.read(&mut byte).map(|count| count == 1).unwrap_or(false) && byte[0] != b'\n' {
        line.push(char::from(byte[0]));
    }
    let ready: serde_json::Value = serde_json::from_str(&line).expect("the ready line");
    let port = ready["ready"]["listen"].as_u64().expect("a listen port") as u16;
    let head = "PUT /api/magic-prompts/a HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
    // The review's killing requests: Node accepts the size and waits for the chunk (no answer); so must the candidate.
    for size in ["fffffffffffffffe", "ffffffffffffffff"] {
        let answer = exchange(
            port,
            format!("{head}{size}\r\n{{\"text\":\"x\"}}......................\r\n0\r\n\r\n").as_bytes(),
            Duration::from_millis(300),
        );
        assert!(answer.is_empty(), "{size}: {}", String::from_utf8_lossy(&answer));
        assert!(child.0.try_wait().expect("its state").is_none(), "{size}: the candidate exited");
    }
    // A size that does not fit in 64 bits, and other framing Node refuses: 400.
    for wire in [
        format!("{head}10000000000000000\r\nx\r\n0\r\n\r\n"),
        format!("{head}c \r\n{{\"text\":\"x\"}}\r\n0\r\n\r\n"),
        "PUT /api/magic-prompts/a HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx".to_owned(),
    ] {
        let answer = exchange(port, wire.as_bytes(), Duration::from_secs(10));
        assert!(answer.starts_with(b"HTTP/1.1 400 Bad Request\r\n"), "{}", String::from_utf8_lossy(&answer));
    }
    // Random bytes on many connections, then a request that must be answered.
    let mut draw = Draw(0x00b6_f1c5_0005);
    for _ in 0..200 {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("the listen port");
        let _ = stream.write_all(&draw.mutate(head.as_bytes()));
        let count = draw.below(64);
        let _ = stream.write_all(&draw.bytes(count));
    }
    let answer = exchange(
        port,
        b"GET /api/magic-prompts HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        Duration::from_secs(10),
    );
    assert!(
        answer.starts_with(b"HTTP/1.1 400 Bad Request\r\n") || answer.starts_with(b"HTTP/1.1 200"),
        "{}",
        String::from_utf8_lossy(&answer)
    );
    assert!(child.0.try_wait().expect("its state").is_none(), "the candidate exited");
}
