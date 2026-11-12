//! Reading the JavaScript-semantics vectors. Deliberately independent of the
//! crate: its own strict base64 and WTF-8 decoders, so a defect in the code
//! under test cannot also corrupt the inputs it is checked on.
#![allow(dead_code)]

use std::path::PathBuf;

/// The tracked vectors file `name` beside this crate's tests, then the
/// same-named file in `LEDGER_CORE_EXTENDED_DIR` when that is set and holds
/// one (written by `tests/run-extended.mjs` or a generator's `--extended`).
/// A directory that lacks the file fails: an extended run never silently
/// checks less than it was given.
pub fn vector_files(name: &str) -> Vec<(String, String)> {
    let tracked = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(name);
    let mut files = vec![(
        tracked.display().to_string(),
        std::fs::read_to_string(&tracked)
            .unwrap_or_else(|error| panic!("{}: {error}", tracked.display())),
    )];
    if let Some(directory) = std::env::var_os("LEDGER_CORE_EXTENDED_DIR") {
        let extended = PathBuf::from(directory).join(name);
        files.push((
            extended.display().to_string(),
            std::fs::read_to_string(&extended).unwrap_or_else(|error| {
                panic!(
                    "LEDGER_CORE_EXTENDED_DIR is set but {} cannot be read: {error}",
                    extended.display()
                )
            }),
        ));
    }
    files
}

/// The data lines of a vectors file, split at tabs, after checking its
/// closing `end <rows>` row (`vectorDocument` in vector-tools.mjs), so a
/// truncated or extended-by-hand file fails.
pub fn rows(text: &str) -> std::vec::IntoIter<Vec<&str>> {
    let mut rows: Vec<Vec<&str>> = text
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.split('\t').collect())
        .collect();
    let end = rows.pop().expect("a vectors file has rows");
    assert_eq!(
        end.first(),
        Some(&"end"),
        "the vectors file lacks its closing end row (truncated?)"
    );
    let count: usize = end[1].parse().expect("end row count");
    assert_eq!(
        count,
        rows.len(),
        "the end row counts {count} rows, the file has {}",
        rows.len()
    );
    rows.into_iter()
}

/// Strict standard base64 with padding.
pub fn base64(text: &str) -> Vec<u8> {
    let value = |byte: u8| -> u32 {
        (match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("not base64: {byte:#x}"),
        }) as u32
    };
    let bytes = text.as_bytes();
    assert!(
        bytes.len().is_multiple_of(4),
        "base64 length {}",
        bytes.len()
    );
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for group in bytes.chunks(4) {
        let pad = group.iter().filter(|byte| **byte == b'=').count();
        let mut word = 0u32;
        for &byte in &group[..4 - pad] {
            word = (word << 6) | value(byte);
        }
        word <<= 6 * pad as u32;
        out.extend_from_slice(&word.to_be_bytes()[1..4 - pad]);
    }
    out
}

/// WTF-8 bytes (UTF-8 that may encode surrogates) as UTF-16 code units.
pub fn wtf8_units(bytes: &[u8]) -> Vec<u16> {
    let mut units = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let lead = bytes[at];
        let (length, initial) = match lead {
            0x00..=0x7f => (1, u32::from(lead)),
            0xc0..=0xdf => (2, u32::from(lead & 0x1f)),
            0xe0..=0xef => (3, u32::from(lead & 0x0f)),
            0xf0..=0xf7 => (4, u32::from(lead & 0x07)),
            _ => panic!("not WTF-8 at {at}"),
        };
        let mut code = initial;
        for byte in &bytes[at + 1..at + length] {
            assert_eq!(byte & 0xc0, 0x80, "not WTF-8 at {at}");
            code = (code << 6) | u32::from(byte & 0x3f);
        }
        at += length;
        if code >= 0x10000 {
            code -= 0x10000;
            units.push(0xd800 + (code >> 10) as u16);
            units.push(0xdc00 + (code & 0x3ff) as u16);
        } else {
            units.push(code as u16);
        }
    }
    units
}

pub fn hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "odd hex length");
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex"))
        .collect()
}

/// Four hex digits per code unit.
pub fn hex_units(text: &str) -> Vec<u16> {
    assert!(text.len().is_multiple_of(4), "unit hex length");
    (0..text.len())
        .step_by(4)
        .map(|index| u16::from_str_radix(&text[index..index + 4], 16).expect("hex"))
        .collect()
}

/// mulberry32 exactly as `vector-tools.mjs` (`random(seed)`), including the
/// division by 2^32 in double precision.
pub struct Random(u32);

impl Random {
    pub fn new(seed: u32) -> Self {
        Random(seed)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let state = self.0;
        let mut value = (state ^ (state >> 15)).wrapping_mul(1 | state);
        value = (value.wrapping_add((value ^ (value >> 7)).wrapping_mul(61 | value))) ^ value;
        f64::from(value ^ (value >> 14)) / 4294967296.0
    }

    /// `Math.floor(next() * n)`.
    pub fn int(&mut self, n: u32) -> u32 {
        (self.next() * f64::from(n)).floor() as u32
    }
}

/// Collects failures and reports the first few with the total.
pub struct Failures {
    pub cases: usize,
    pub messages: Vec<String>,
}

impl Failures {
    pub fn new() -> Self {
        Failures {
            cases: 0,
            messages: Vec::new(),
        }
    }

    pub fn check(&mut self, ok: bool, message: impl FnOnce() -> String) {
        self.cases += 1;
        if !ok {
            self.messages.push(message());
        }
    }

    pub fn assert_clean(&self, what: &str, minimum: usize) {
        assert!(self.cases >= minimum, "only {} {what}", self.cases);
        let shown: Vec<&String> = self.messages.iter().take(20).collect();
        assert!(
            self.messages.is_empty(),
            "{} of {} {what} differ from Node:\n{}",
            self.messages.len(),
            self.cases,
            shown
                .iter()
                .map(|line| line.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        );
        eprintln!("{} {what}: all match Node", self.cases);
    }
}

impl Random {
    pub fn chance(&mut self, p: f64) -> bool {
        self.next() < p
    }

    pub fn pick<'a, T>(&mut self, list: &'a [T]) -> &'a T {
        &list[self.int(list.len() as u32) as usize]
    }
}

/// FNV-1a, 64 bits, as 16 hex digits (`fnv64` in codec-tools.mjs): a test
/// fingerprint, not a hash the ledger uses.
pub fn fnv64(parts: &[&[u8]]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for part in parts {
        for byte in *part {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

/// `testObjectId(type, content, width)` of codec-tools.mjs.
pub fn test_object_id(kind: &str, content: &[u8], width: usize) -> String {
    let header = format!("{kind} {}\0", content.len());
    let mut id = String::new();
    let mut salt = 0u8;
    while id.len() < width {
        id.push_str(&fnv64(&[&[salt], header.as_bytes(), content]));
        salt += 1;
    }
    id.truncate(width);
    id
}

/// `seededBytes(next, length)` of codec-tools.mjs.
pub fn seeded_bytes(random: &mut Random, length: usize) -> Vec<u8> {
    (0..length).map(|_| random.int(256) as u8).collect()
}

/// One entry of a seeded tree: mode, name bytes, id (hex).
#[derive(Clone, Debug, PartialEq)]
pub struct SeededEntry {
    pub mode: &'static str,
    pub name: Vec<u8>,
    pub oid: String,
}

/// `treeEntries(seed, width)` of generate-trees.mjs, draw for draw.
pub fn tree_entries(seed: u32, width: usize) -> Vec<SeededEntry> {
    const STEMS: [&str; 9] = ["a", "ab", "foo", "foo.c", "x-y", "a.b", "A", "_", "z"];
    const AROUND: [u8; 11] = [
        0x2d, 0x2e, 0x30, 0x01, 0x20, 0x2b, 0x5f, 0x7e, 0x7f, 0x80, 0xff,
    ];
    const SMALL: [u8; 7] = [0x61, 0x62, 0x2d, 0x2e, 0x30, 0x41, 0x5f];
    const MODES: [&str; 5] = ["40000", "100644", "100755", "120000", "160000"];
    let mut d = Random::new(seed);
    let count = if d.chance(0.05) {
        20 + d.int(40)
    } else {
        1 + d.int(12)
    } as usize;
    let mut entries: Vec<SeededEntry> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut attempt = 0;
    while entries.len() < count && attempt < count * 4 {
        attempt += 1;
        let style = d.int(6);
        let mut name = Vec::new();
        match style {
            0 => {
                for _ in 0..1 + d.int(4) {
                    name.push(*d.pick(&SMALL));
                }
            }
            1 | 4 => {
                name.extend_from_slice(d.pick(&STEMS).as_bytes());
                if style == 4 || d.chance(0.5) {
                    name.push(*d.pick(&AROUND));
                }
                if style == 4 && d.chance(0.5) {
                    name.extend_from_slice(d.pick(&STEMS).as_bytes());
                }
            }
            2 => {
                for _ in 0..1 + d.int(8) {
                    let byte = 1 + d.int(254) as u8;
                    name.push(if byte >= 0x2f { byte + 1 } else { byte });
                }
            }
            3 => {
                for _ in 0..100 + d.int(156) {
                    name.push(0x61 + d.int(26) as u8);
                }
            }
            _ => {
                for _ in 0..1 + d.int(6) {
                    name.push(0x80 + d.int(128) as u8);
                }
            }
        }
        let roll = d.int(20);
        let mode = MODES[match roll {
            0..7 => 0,
            7..15 => 1,
            15..17 => 2,
            17..19 => 3,
            _ => 4,
        }];
        let oid: String = (0..width / 2)
            .map(|_| format!("{:02x}", d.int(256)))
            .collect();
        if !seen.insert(name.clone()) {
            continue;
        }
        entries.push(SeededEntry { mode, name, oid });
    }
    for index in (1..entries.len()).rev() {
        let other = d.int(index as u32 + 1) as usize;
        entries.swap(index, other);
    }
    entries
}

/// One seeded run of `ancestryRuns(seed)` (generate-text.mjs): id index,
/// start, text length, and its ranges as (id index, start, length), with
/// the index of the earlier piece whose list it shares, if any.
#[derive(Clone, Debug)]
pub struct SeededRun {
    pub id: u32,
    pub start: i64,
    pub length: usize,
    pub replaces: Vec<(u32, i64, i64)>,
}

/// `ancestryRuns(seed)` of generate-text.mjs, draw for draw.
pub fn ancestry_runs(seed: u32) -> Vec<SeededRun> {
    let mut d = Random::new(seed);
    let mut runs = Vec::new();
    let ids = 2 + d.int(12);
    for index in 0..ids {
        let mut start = 0i64;
        let mut previous: Option<Vec<(u32, i64, i64)>> = None;
        for _ in 0..1 + d.int(4) {
            let length = 1 + d.int(20) as usize;
            let replaces = match &previous {
                Some(previous) if d.chance(0.3) => previous.clone(),
                _ => {
                    let mut replaces = Vec::new();
                    let count = if index == 0 {
                        0
                    } else {
                        let bound = if d.chance(0.2) { 60 } else { 8 };
                        d.int(bound)
                    };
                    for _ in 0..count {
                        let id = d.int(index);
                        let start = i64::from(d.int(30));
                        let length = i64::from(d.int(15));
                        replaces.push((id, start, length));
                    }
                    if d.chance(0.004) {
                        let id = index + d.int(2);
                        replaces.push((id, 0, 1 + i64::from(d.int(5))));
                    }
                    if d.chance(0.002) {
                        replaces.push((0, -1, 1));
                    }
                    replaces
                }
            };
            runs.push(SeededRun {
                id: index,
                start,
                length,
                replaces: replaces.clone(),
            });
            previous = Some(replaces);
            start += length as i64;
        }
    }
    for index in (1..runs.len()).rev() {
        if !d.chance(0.3) {
            continue;
        }
        let other = d.int(index as u32 + 1) as usize;
        runs.swap(index, other);
    }
    runs
}
