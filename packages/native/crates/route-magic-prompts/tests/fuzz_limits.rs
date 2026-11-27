//! The request decoding holds its limits and never panics (fix round 1 of BH6, item 1): a bounded,
//! deterministic fuzz over the request decoding (types, charsets, every encoding, with the compressed bodies
//! the JavaScript made for tests/bodies.tsv mutated: bits flipped, cut short, bytes added, members repeated),
//! the router and the group's answers, with a counting allocator measuring what each decode holds at its peak.
//! Its own test binary with one test, so no other test's allocations are counted.

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use devryan_route_magic_prompts::answer::base64_decode;
use devryan_route_magic_prompts::body::{self, Body};
use devryan_route_magic_prompts::group::{self, Exchange};
use devryan_route_magic_prompts::http::Headers;
use devryan_route_magic_prompts::order::Ticket;
use devryan_route_magic_prompts::runtime::Runtime;

// ------------------------------------------------------------------ what each case holds

struct Counting;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call is passed to the system allocator unchanged; the counters only observe sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's contract for `alloc` is the system allocator's.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            let now = CURRENT.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: the pointer came from `alloc` above with this layout.
        unsafe { System.dealloc(pointer, layout) };
        CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        // SAFETY: the caller's contract for `realloc` is the system allocator's.
        let moved = unsafe { System.realloc(pointer, layout, size) };
        if !moved.is_null() {
            if size >= layout.size() {
                let now = CURRENT.fetch_add(size - layout.size(), Ordering::Relaxed) + size - layout.size();
                // A move holds both blocks for a moment.
                PEAK.fetch_max(now + layout.size(), Ordering::Relaxed);
            } else {
                CURRENT.fetch_sub(layout.size() - size, Ordering::Relaxed);
            }
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Runs `work` and returns its result with the most it held above what was held before (bytes).
fn held<T>(work: impl FnOnce() -> T) -> (T, usize) {
    let before = CURRENT.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let result = work();
    (result, PEAK.load(Ordering::Relaxed).saturating_sub(before))
}

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

fn headers(pairs: &[(String, Vec<u8>)]) -> Headers {
    Headers::from_raw(pairs)
}

const TYPES: &[&str] = &[
    "application/json",
    "application/json; charset=utf-8",
    "application/json; charset=utf-16",
    "application/json; charset=utf-32be",
    "application/json; charset=utf-7",
    "application/json; charset=latin1",
    "application/x-www-form-urlencoded",
    "application/x-www-form-urlencoded; charset=iso-8859-1",
    "text/plain",
    "application/merge-patch+json",
    "Application/JSON; Charset=\"UTF-8\"",
    "application/json;",
    "",
];
const ENCODINGS: &[&str] = &["", "identity", "gzip", "GZIP", "deflate", "br", "compress", "gzip, gzip"];
const PATHS: &[&str] = &[
    "/api/magic-prompts/x",
    "/api/preview/x",
    "/api/Magic-Prompts/x",
    "/API/MAGIC-PROMPTS/x",
    "/elsewhere",
    "/api/behavior/x",
];

/// The most a decode may hold, beyond its limit: the input buffer, the inflate output's slack and growth, the
/// window, the parsed value.
fn allowance(encoding: &str, limit: usize, input: usize) -> usize {
    let base = 4 * (limit + input) + 2 * 1024 * 1024;
    if encoding.eq_ignore_ascii_case("br") { base + 40 * 1024 * 1024 } else { base }
}

#[test]
fn request_decoding_never_panics_and_holds_its_limit() {
    let mut draw = Draw(0x00b6_f1c5_0001);
    // Seeds: every compressed and plain body the JavaScript decoded for the vectors.
    let seeds: Vec<(String, Vec<u8>)> = rows("bodies.tsv")
        .into_iter()
        .map(|row| {
            let encoding = if row[2] == "-" {
                String::new()
            } else {
                String::from_utf8_lossy(&base64_decode(row[2].as_bytes())).into_owned()
            };
            (encoding, base64_decode(row[3].as_bytes()))
        })
        .collect();
    let mut cases = 0;
    let started = Instant::now();
    for _ in 0..6000 {
        let (seed_encoding, seed) = draw.pick(&seeds).clone();
        let body = match draw.below(4) {
            0 => seed.clone(),
            1 | 2 => draw.mutate(&seed),
            _ => {
                let length = draw.below(300);
                draw.bytes(length)
            }
        };
        let encoding = if draw.below(3) == 0 {
            (*draw.pick(ENCODINGS)).to_owned()
        } else {
            seed_encoding
        };
        let content_type = *draw.pick(TYPES);
        let path = *draw.pick(PATHS);
        let mut raw: Vec<(String, Vec<u8>)> = vec![("Host".to_owned(), b"h".to_vec())];
        if !content_type.is_empty() {
            raw.push(("Content-Type".to_owned(), content_type.as_bytes().to_vec()));
        }
        if !encoding.is_empty() {
            raw.push(("Content-Encoding".to_owned(), encoding.as_bytes().to_vec()));
        }
        raw.push(("Content-Length".to_owned(), body.len().to_string().into_bytes()));
        let headers = headers(&raw);
        let limit = body::shared_json_limit(path).unwrap_or(50 * 1024 * 1024).min(64 * 1024);
        let (decoded, peak) = held(|| body::decode(&headers, &body, path));
        assert!(
            peak <= allowance(&encoding, limit, body.len()),
            "decoding {} bytes ({encoding}, {content_type}, {path}) held {peak} bytes",
            body.len()
        );
        // The group answers whatever the decoding left (a refusal is the edge's page).
        let runtime = Runtime::new("/nonexistent-devryan-fuzz-root");
        for method in ["GET", "HEAD", "PUT", "DELETE"] {
            let exchange = Exchange {
                method,
                target: "/api/magic-prompts/%zz",
                headers: &headers,
            };
            let copy = match &decoded {
                Ok(Body::Unparsed) => Ok(Body::Unparsed),
                Ok(Body::Json(text)) => Ok(Body::Json(text.clone())),
                Ok(Body::Form(_)) => Ok(Body::Unparsed),
                Err(refusal) => Err(body::Refusal {
                    status: refusal.status,
                    message: refusal.message.clone(),
                }),
            };
            let answer = group::handle(&runtime, &exchange, copy, Ok(()), &Ticket::alone());
            assert!(answer.status >= 200);
        }
        cases += 1;
    }
    // Bombs: tiny inputs that inflate far past the limit stop at it.
    {
        let encoding = "deflate";
        let zeros = vec![0u8; 4 * 1024 * 1024];
        let mut stored = vec![0x78, 0x01];
        for (index, block) in zeros.chunks(65_535).enumerate() {
            stored.push(u8::from(index + 1 == zeros.len().div_ceil(65_535)));
            stored.extend_from_slice(&(block.len() as u16).to_le_bytes());
            stored.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
            stored.extend_from_slice(block);
        }
        stored.extend_from_slice(&devryan_route_magic_prompts::inflate::adler32(&zeros).to_be_bytes());
        let input = stored;
        let raw = vec![
            ("Content-Type".to_owned(), b"application/json".to_vec()),
            ("Content-Encoding".to_owned(), encoding.as_bytes().to_vec()),
            ("Content-Length".to_owned(), input.len().to_string().into_bytes()),
        ];
        let (decoded, peak) = held(|| body::decode(&headers(&raw), &input, "/api/preview/x"));
        assert_eq!(decoded.err().map(|refusal| refusal.status), Some(413));
        assert!(peak < 3 * 1024 * 1024, "a 4 MiB inflate against a 16 KiB limit held {peak} bytes");
    }
    assert!(cases == 6000 && started.elapsed() < Duration::from_secs(600));
}
