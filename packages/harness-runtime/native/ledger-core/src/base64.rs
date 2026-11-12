//! Node's `Buffer` base64: `buffer.toString('base64')` and the lenient
//! decoding of `Buffer.from(text, 'base64')`.
//!
//! Node's decoder was established by testing Node 26.13 and Electron's
//! Node 24.22 (`tests/generate-base64.mjs` checks it on every run):
//! - Both alphabets are accepted, mixed freely (`+` and `-` are 62, `/` and
//!   `_` are 63).
//! - Every code unit is looked up by its low byte only. A unit whose low
//!   byte is not in either alphabet (whitespace, punctuation, `é`, U+0100) is
//!   skipped; a unit whose low byte is `=` (`=` itself, but also U+D83D, the
//!   lead surrogate of most emoji) ends the decoding; and one whose low byte
//!   is a base64 letter (U+0141 for `A`) decodes as that letter.
//! - Sextets are consumed in groups of four; a group cut short keeps the
//!   whole bytes it completed, and one sextet alone yields nothing.
//! - The output is at most `decodedSize` bytes, where trailing `=`
//!   (compared as whole units, at most two) are first dropped from the
//!   length: `size / 4 * 3 + (size % 4 + 1) / 2`, and 0 for fewer than two
//!   units.
#![forbid(unsafe_code)]

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const EQUALS: u8 = b'=';

/// The sextet of a low byte, in either alphabet.
fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// `buffer.toString('base64')`: the standard alphabet, padded with `=`.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let word = (u32::from(group[0]) << 16)
            | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
            | u32::from(*group.get(2).unwrap_or(&0));
        for (slot, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if slot <= group.len() {
                out.push(ALPHABET[((word >> shift) & 0x3f) as usize] as char);
            } else {
                out.push(EQUALS as char);
            }
        }
    }
    out
}

/// The output bound of Node's decoder for this text (`base64_decoded_size`).
fn decoded_size(units: &[u16]) -> usize {
    let mut size = units.len();
    if size < 2 {
        return 0;
    }
    let equals = u16::from(EQUALS);
    if units[size - 1] == equals {
        size -= 1;
        if units[size - 1] == equals {
            size -= 1;
        }
    }
    if size > 1 {
        size / 4 * 3 + (size % 4).div_ceil(2)
    } else {
        0
    }
}

/// `Buffer.from(text, 'base64')` for a JavaScript string's code units.
pub fn decode(units: &[u16]) -> Vec<u8> {
    let bound = decoded_size(units);
    let mut out = Vec::with_capacity(bound);
    let mut at = 0;
    'groups: while at < units.len() && out.len() < bound {
        let mut previous = 0u8;
        for slot in 0..4 {
            let current = loop {
                let low = units[at] as u8;
                at += 1;
                if let Some(value) = sextet(low) {
                    break value;
                }
                if low == EQUALS || at >= units.len() {
                    break 'groups;
                }
            };
            match slot {
                1 => out.push((previous << 2) | (current >> 4)),
                2 => out.push((previous << 4) | (current >> 2)),
                3 => out.push((previous << 6) | current),
                _ => {}
            }
            if at >= units.len() || out.len() >= bound {
                break 'groups;
            }
            previous = current;
        }
    }
    out
}

/// `Buffer.from(text, 'base64')` for Rust text.
pub fn decode_str(text: &str) -> Vec<u8> {
    decode(&text.encode_utf16().collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn encoding_pads() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"a"), "YQ==");
        assert_eq!(encode(b"ab"), "YWI=");
        assert_eq!(encode(b"abc"), "YWJj");
        assert_eq!(encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }

    #[test]
    fn decoding_is_as_lenient_as_node() {
        // Each pair was observed in Node 26.13 and Electron's Node 24.22.
        for (text, expected) in [
            ("YQ==", "61"),
            ("YQ", "61"),
            ("Y", ""),
            ("YQ==YQ==", "61"),
            ("Y Q = =", "61"),
            ("YW Jj", "616263"),
            ("-_-_", "fbffbf"),
            ("YQ!!", "61"),
            ("!YQ", "61"),
            ("====", ""),
            ("YWI=x", "6162"),
            ("Zm9v\u{e9}YmFy", "666f6f626172"),
            ("Zm9v\u{100}YmFy", "666f6f626172"),
            ("a=b", ""),
            ("abc=d", "69b7"),
            ("Zm9v=YmFy", "666f6f"),
            ("Zm\u{1f600}9v", "66"),
            ("\u{141}\u{141}\u{141}\u{141}", "000000"),
        ] {
            assert_eq!(hex(&decode_str(text)), expected, "{text:?}");
        }
    }
}
