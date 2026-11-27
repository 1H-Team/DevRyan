//! JavaScript string operations on UTF-16 code units, as the policy modules
//! use them.

use devryan_js_layer::js::JsStr;

/// The units of a Rust string literal (always ASCII here).
pub fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// ECMAScript WhiteSpace or LineTerminator: what `trim()` strips and `\s`
/// matches (TAB, VT, FF, SP, NBSP, ZWNBSP, the Zs separators, LF, CR, LS, PS).
pub fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// `string.trim()`.
pub fn trim(text: &[u16]) -> &[u16] {
    let start = text.iter().position(|unit| !is_js_whitespace(*unit)).unwrap_or(text.len());
    let end = text.iter().rposition(|unit| !is_js_whitespace(*unit)).map_or(start, |index| index + 1);
    &text[start..end.max(start)]
}

/// `string.startsWith(prefix)` for an ASCII prefix.
pub fn starts_with(text: &[u16], prefix: &str) -> bool {
    let prefix = units(prefix);
    text.starts_with(&prefix)
}

/// `string.includes(needle)`.
pub fn contains(text: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || text.windows(needle.len()).any(|window| window == needle)
}

/// `new TextEncoder().encode(string).byteLength` (and `Buffer.byteLength`):
/// UTF-8, every lone surrogate as U+FFFD (three bytes).
pub fn utf8_len(text: &[u16]) -> u64 {
    let mut total = 0u64;
    let mut index = 0;
    while index < text.len() {
        let unit = text[index];
        total += match unit {
            0..=0x7f => 1,
            0x80..=0x7ff => 2,
            0xd800..=0xdbff if text.get(index + 1).is_some_and(|low| (0xdc00..=0xdfff).contains(low)) => {
                index += 1;
                4
            }
            _ => 3,
        };
        index += 1;
    }
    total
}

/// `string.split(/[\\/]/)`: the pieces between `/` and `\`.
pub fn split_slashes(text: &[u16]) -> Vec<&[u16]> {
    text.split(|unit| *unit == u16::from(b'/') || *unit == u16::from(b'\\')).collect()
}

/// A projection of `string.toLowerCase()` that is exact wherever the result is
/// only compared with, or matched against, ASCII text: ASCII letters fold,
/// U+0130 becomes `i` + U+0307 and U+212A (KELVIN SIGN) becomes `k` (the only
/// code points whose lower case holds ASCII; the generator checks that against
/// Node on every run), and every other non-ASCII unit stays as it is (its
/// lower case is non-ASCII too, so no ASCII comparison or ASCII-only pattern
/// can tell them apart).
pub fn lower_for_ascii(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    for unit in text {
        match *unit {
            0x41..=0x5a => out.push(unit + 0x20),
            0x130 => out.extend([0x69, 0x307]),
            0x212a => out.push(0x6b),
            other => out.push(other),
        }
    }
    out
}

/// `JsStr` from text.
pub fn js(text: &str) -> JsStr {
    JsStr::from(text)
}

/// Concatenates pieces into one `JsStr` (a template literal).
pub fn concat(parts: &[&[u16]]) -> JsStr {
    let mut out = Vec::new();
    for part in parts {
        out.extend_from_slice(part);
    }
    JsStr::from_units(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_and_lengths() {
        assert_eq!(trim(&units("\u{feff} a b\u{3000}")), units("a b").as_slice());
        assert!(trim(&units(" \n")).is_empty());
        assert_eq!(utf8_len(&[0x61, 0xd800, 0xd83d, 0xde00, 0xe9]), 1 + 3 + 4 + 2);
    }
}
