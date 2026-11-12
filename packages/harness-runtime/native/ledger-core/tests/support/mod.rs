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
