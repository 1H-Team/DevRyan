//! Bounded, seeded fuzzing of this group's request path and data file (one seed, fixed counts; seconds in a debug
//! build): no input may panic, and a counting allocator holds each request to a bound of its body.
//!
//! - 6 000 mutated request bodies (JSON documents, forms, other types, charsets, compressed) decoded as the
//!   product's decoding gives them to the group, then answered by the group on a scratch data root (GET and
//!   POST), each under a memory bound: 20 times the larger of the body (for a GET, of the data file), plus 3 times
//!   the 4 MiB document limit, plus 2 MiB (a value is 32 bytes, so a body of empty arrays costs 16 times its size;
//!   the indented document is cut off past the limit);
//! - 4 000 mutated data files read by GET (no panic; the answer is 200 or 500);
//! - deep nesting (1 000 000 levels) parsed, written and dropped without recursion;
//! - 40 000 mutated JSON texts through the one-pass path and through parse then stringify (with and without a
//!   gap): both refuse the same texts, and where the one-pass path writes, it writes the same bytes; with a drawn
//!   stop or depth limit, the same depth, the same verdict on the stop, and under it the same bytes.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use devryan_route_common::body;
use devryan_route_common::http::Headers;
use devryan_route_common::order::Ticket;
use devryan_route_common::server::{Exchange, Group};
use devryan_route_common::value;
use devryan_route_session_folders::group::{DocumentReader, SessionFolders};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call is forwarded to the system allocator unchanged; only counters are updated around it.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        PEAK.fetch_max(live, Ordering::Relaxed);
        // SAFETY: the caller's layout is passed on as given.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        // SAFETY: the pointer came from System.alloc with this layout.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The tests of this file one at a time: the allocator's counters are the process's, so another test's
/// allocations would count against a bound.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn alone() -> std::sync::MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The peak memory a closure held above what was live when it started.
fn held<T>(work: impl FnOnce() -> T) -> (T, usize) {
    let base = LIVE.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let out = work();
    (out, PEAK.load(Ordering::Relaxed).saturating_sub(base))
}

struct Draw(u64);
impl Draw {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn pick<'a, T>(&mut self, list: &'a [T]) -> &'a T {
        &list[self.below(list.len())]
    }
}

const SEEDS: &[&str] = &[
    r#"{"version":1,"foldersMap":{"/p":[{"id":"f","name":"F","sessionIds":["s"],"createdAt":1,"parentId":null}]},"collapsedFolderIds":[],"updatedAt":2}"#,
    r#"{"2":1,"1":2,"a":[1.0,-0,1e400,"𐀀\ud800"],"a":{"__proto__":null},"\u0000":"\/"}"#,
    r#"[[[[[[[[]]]]]]]]"#,
    "a=1&a=2&b[c][d]=e&f[]=1&f[3]=2&__proto__=x&%E9=%zz&k[999]=v",
    "",
    "{}",
    "\u{feff}{\"x\":\"\u{1f600}\"}",
    // Members V8 reorders or merges: index keys after names and out of order, repeated keys (plain, escaped,
    // decoded-equal), nested, and long objects (past the 16 members a key table takes over).
    r#"{"b":[1,2,{"9":1,"x":2,"8":[3,4],"x":{"y":[5]}}],"0":"z","\u0062":{"c":1},"01":2,"4294967294":[],"4294967295":0,"b":[6]}"#,
    r#"{"k0":0,"k1":1,"k2":2,"k3":3,"k4":4,"k5":5,"k6":6,"k7":7,"k8":8,"k9":9,"k10":10,"k11":11,"k12":12,"k13":13,"k14":14,"k15":15,"k16":16,"k3":[3,3],"7":7,"k\u0031":"one","\ud800":1,"\udc00":2}"#,
];

fn mutate(draw: &mut Draw, seed: &[u8]) -> Vec<u8> {
    let mut bytes = seed.to_vec();
    for _ in 0..1 + draw.below(6) {
        let at = if bytes.is_empty() { 0 } else { draw.below(bytes.len()) };
        match draw.below(7) {
            0 if !bytes.is_empty() => bytes[at] ^= 1 << draw.below(8),
            1 if !bytes.is_empty() => {
                bytes.remove(at);
            }
            2 => bytes.insert(at, *draw.pick(b"{}[]\",:\\u0123456789eE-+.tfn \x00\xff\xc3\xed\xa0\x80&=%[]")),
            3 => bytes.truncate(at),
            4 if !bytes.is_empty() => {
                let piece = bytes[at..].iter().take(draw.below(16)).copied().collect::<Vec<u8>>();
                bytes.splice(at..at, piece);
            }
            5 => bytes.extend_from_slice(draw.pick(&[&b"[".repeat(300)[..], &b"{\"a\":".repeat(300)[..], b"\\ud83d", b"1e999"])),
            _ => {}
        }
    }
    bytes
}

/// A scratch data root under the OS temp dir, removed when dropped (a failing test unwinds through it too).
struct Scratch(String);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn scratch(name: &str) -> Scratch {
    let dir = std::env::temp_dir().join(format!("devryan-route-session-folders-fuzz-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Scratch(dir.to_str().unwrap().to_owned())
}

fn compress(draw: &mut Draw, bytes: &[u8]) -> (Vec<u8>, Option<&'static str>) {
    // A stored deflate stream (zlib framing, no compression) keeps the test free of a compressor; bit flips then
    // reach the inflater's checks.
    if draw.below(4) != 0 || bytes.len() > 60_000 {
        return (bytes.to_vec(), None);
    }
    let mut out = vec![0x78, 0x01, 0x01];
    let length = bytes.len() as u16;
    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(&(!length).to_le_bytes());
    out.extend_from_slice(bytes);
    let (mut a, mut b) = (1u32, 0u32);
    for byte in bytes {
        a = (a + u32::from(*byte)) % 65521;
        b = (b + a) % 65521;
    }
    out.extend_from_slice(&((b << 16) | a).to_be_bytes());
    if draw.below(3) == 0 && !out.is_empty() {
        let at = draw.below(out.len());
        out[at] ^= 0x10;
    }
    (out, Some("deflate"))
}

#[test]
fn requests_never_panic_and_stay_bounded() {
    let _alone = alone();
    let root = scratch("requests");
    let group = SessionFolders::new(&root.0);
    let mut draw = Draw(0x005e_edb7);
    let types = [
        "application/json",
        "application/json; charset=utf-16",
        "application/x-www-form-urlencoded",
        "text/plain",
        "application/merge-patch+json",
    ];
    let paths = ["/api/session-folders", "/API/SESSION-FOLDERS", "/api/Session-Folders", "/api/session-folders/"];
    for round in 0..6_000 {
        let seed = draw.pick(SEEDS).as_bytes();
        let mut bytes = mutate(&mut draw, seed);
        let kind = *draw.pick(&types);
        if kind.ends_with("utf-16") {
            bytes = bytes.iter().flat_map(|byte| [*byte, 0]).collect();
        }
        let (bytes, encoding) = compress(&mut draw, &bytes);
        let length = bytes.len().to_string();
        let mut pairs = vec![("content-type", kind), ("content-length", length.as_str())];
        if let Some(encoding) = encoding {
            pairs.push(("content-encoding", encoding));
        }
        let headers = Headers::from_pairs(&pairs);
        let path = *draw.pick(&paths);
        let method = if round % 5 == 0 { "GET" } else { "POST" };
        let ((), peak) = held(|| {
            let decoded = body::decode_with::<DocumentReader>(&headers, &bytes, path);
            let exchange = Exchange {
                method,
                target: path,
                headers: &headers,
            };
            let answer = group.handle(&exchange, decoded, Ok(()), &Ticket::alone());
            assert!([200, 304, 400, 404, 413, 415, 500].contains(&answer.status), "status {}", answer.status);
        });
        // A GET holds the data file an earlier POST wrote (up to 4 MiB: indentation makes a small deep body a large file).
        let file = std::fs::metadata(format!("{}/sessions-directories.json", root.0)).map_or(0, |meta| meta.len() as usize);
        let bound = 20 * bytes.len().max(seed.len() * 2).max(if method == "GET" { file } else { 0 }) + 3 * 4 * 1024 * 1024 + 2 * 1024 * 1024;
        assert!(
            peak <= bound,
            "round {round}: {peak} bytes held for a {}-byte body ({method} {path} {kind} {encoding:?}, file {file}): {:?}",
            bytes.len(),
            String::from_utf8_lossy(&bytes)
        );
    }
}

#[test]
fn data_files_never_panic() {
    let _alone = alone();
    let root = scratch("files");
    let group = SessionFolders::new(&root.0);
    let file = format!("{}/sessions-directories.json", root.0);
    let mut draw = Draw(0x000f_11e5);
    let headers = Headers::from_pairs(&[]);
    for _ in 0..4_000 {
        let seed = *draw.pick(SEEDS);
        let bytes = mutate(&mut draw, seed.as_bytes());
        std::fs::write(&file, &bytes).unwrap();
        let exchange = Exchange {
            method: "GET",
            target: "/api/session-folders",
            headers: &headers,
        };
        let answer = group.handle(&exchange, Ok(body::Body::Unparsed), Ok(()), &Ticket::alone());
        assert_eq!(answer.status, 200);
    }
}

#[test]
fn deep_values_need_no_stack() {
    let _alone = alone();
    let depth = 1_000_000;
    let text = format!("{}0{}", "{\"a\":".repeat(depth), "}".repeat(depth));
    let parsed = value::parse(text.as_bytes(), false).unwrap();
    assert_eq!(parsed.depth, depth);
    let value = parsed.value.unwrap();
    assert_eq!(value::stringify(&value, 0, usize::MAX), text.as_bytes());
    // Indented, the output passes the stop at once and the writer stops there.
    assert!(value::stringify(&value, 2, 1024).len() < 4096);
    drop(value);
    let limited = value::parse_limited(text.as_bytes(), false, Some(value::DEPTH_LIMIT)).unwrap();
    assert!(limited.value.is_none() && limited.object);
}

#[test]
fn the_one_pass_path_writes_what_parse_then_stringify_writes() {
    let _alone = alone();
    let mut draw = Draw(0x0001_9a55);
    let mut compared = 0;
    for _ in 0..40_000 {
        let seed = *draw.pick(SEEDS);
        let bytes = mutate(&mut draw, seed.as_bytes());
        let slow = value::parse(&bytes, false);
        for gap in [0, 2] {
            // Most runs write everything; others stop at a drawn size or depth (the caller's 4 MiB and V8's stack).
            let (stop, depth_limit) = match draw.below(3) {
                0 => (usize::MAX, usize::MAX),
                1 => (draw.below(bytes.len() * 3 + 2), usize::MAX),
                _ => (usize::MAX, 1 + draw.below(8)),
            };
            if (stop, depth_limit) != (usize::MAX, usize::MAX) {
                if let (Ok(Some(fast)), Ok(tree)) = (value::transcode(&bytes, gap, stop, depth_limit), slow.as_ref()) {
                    let whole = value::stringify(tree.value.as_ref().expect("a value"), gap, usize::MAX);
                    assert_eq!(
                        fast.depth,
                        value::depth_of(tree.value.as_ref().expect("a value")),
                        "{:?}",
                        String::from_utf8_lossy(&bytes)
                    );
                    assert_eq!(fast.over, whole.len() > stop, "stop {stop}: {:?}", String::from_utf8_lossy(&bytes));
                    if !fast.over && fast.depth <= depth_limit {
                        assert_eq!(fast.out, whole, "stop {stop}: {:?}", String::from_utf8_lossy(&bytes));
                    }
                    compared += 1;
                }
                continue;
            }
            match value::transcode(&bytes, gap, usize::MAX, usize::MAX) {
                Err(_) => assert!(
                    slow.is_err(),
                    "the one-pass path refused what JSON.parse takes: {:?}",
                    String::from_utf8_lossy(&bytes)
                ),
                // None: the one-pass path cannot say (it stops early), and the caller parses.
                Ok(None) => {}
                Ok(Some(fast)) => {
                    let tree = slow
                        .as_ref()
                        .unwrap_or_else(|_| panic!("JSON.parse refused what the one-pass path wrote: {:?}", String::from_utf8_lossy(&bytes)))
                        .value
                        .as_ref()
                        .expect("a value");
                    assert_eq!(fast.out, value::stringify(tree, gap, usize::MAX), "{:?}", String::from_utf8_lossy(&bytes));
                    compared += 1;
                }
            }
        }
    }
    assert!(compared > 1_000, "{compared} documents compared");
}
