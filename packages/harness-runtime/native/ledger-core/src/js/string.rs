//! `JsStr`: a JavaScript string, held as UTF-16 code units.
//!
//! JavaScript strings are sequences of 16-bit code units that need not be
//! well-formed UTF-16, so a lone surrogate (`"\uD800"`) is a valid string.
//! Rust's `String` cannot hold one, which is why the ledger's records and keys
//! are modelled with this type. Comparison (`Ord`) is by code unit, exactly as
//! JavaScript's `<` on strings and the default `Array.prototype.sort`.

use std::fmt;

/// A JavaScript string: UTF-16 code units, lone surrogates allowed.
#[derive(Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct JsStr(Vec<u16>);

impl JsStr {
    /// The empty string.
    pub const fn new() -> Self {
        JsStr(Vec::new())
    }

    /// A string of exactly these code units.
    pub fn from_units(units: Vec<u16>) -> Self {
        JsStr(units)
    }

    /// The code units.
    pub fn units(&self) -> &[u16] {
        &self.0
    }

    /// The code units, by value.
    pub fn into_units(self) -> Vec<u16> {
        self.0
    }

    /// `length` in JavaScript: the number of code units.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Appends a Rust string (always well-formed).
    pub fn push_str(&mut self, text: &str) {
        self.0.extend(text.encode_utf16());
    }

    /// Appends code units as they are.
    pub fn push_units(&mut self, units: &[u16]) {
        self.0.extend_from_slice(units);
    }

    /// Decodes bytes as Node's `buffer.toString('utf8')` does: every maximal
    /// ill-formed subsequence becomes one U+FFFD (the WHATWG and Unicode
    /// "maximal subpart" practice), and a byte order mark is kept.
    pub fn from_utf8_lossy(bytes: &[u8]) -> Self {
        let mut units = Vec::with_capacity(bytes.len());
        for chunk in bytes.utf8_chunks() {
            units.extend(chunk.valid().encode_utf16());
            if !chunk.invalid().is_empty() {
                units.push(0xfffd);
            }
        }
        JsStr(units)
    }

    /// Encodes as Node's `Buffer.from(string)` does: UTF-8, with every lone
    /// surrogate written as U+FFFD (`EF BF BD`).
    pub fn to_utf8(&self) -> Vec<u8> {
        self.to_string_lossy().into_bytes()
    }

    /// The string as Rust text, lone surrogates replaced by U+FFFD.
    pub fn to_string_lossy(&self) -> String {
        char::decode_utf16(self.0.iter().copied())
            .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    }

    /// True when the string holds no lone surrogate (`isWellFormed()`).
    pub fn is_well_formed(&self) -> bool {
        char::decode_utf16(self.0.iter().copied()).all(|unit| unit.is_ok())
    }
}

impl From<&str> for JsStr {
    fn from(text: &str) -> Self {
        JsStr(text.encode_utf16().collect())
    }
}

impl From<String> for JsStr {
    fn from(text: String) -> Self {
        JsStr::from(text.as_str())
    }
}

impl PartialEq<str> for JsStr {
    fn eq(&self, other: &str) -> bool {
        self.0.iter().copied().eq(other.encode_utf16())
    }
}

impl PartialEq<&str> for JsStr {
    fn eq(&self, other: &&str) -> bool {
        self == *other
    }
}

impl fmt::Debug for JsStr {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("\"")?;
        for unit in char::decode_utf16(self.0.iter().copied()) {
            match unit {
                Ok(character) => write!(formatter, "{}", character.escape_debug())?,
                Err(error) => write!(formatter, "\\u{{{:x}}}", error.unpaired_surrogate())?,
            }
        }
        formatter.write_str("\"")
    }
}

impl fmt::Display for JsStr {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comparison_is_by_code_unit() {
        // U+FF5E is above the surrogate pair of U+1F600 in code points'
        // order but below it by code unit: JavaScript says "\u{1F600}" < "～".
        let less = |left: &str, right: &str| JsStr::from(left).cmp(&JsStr::from(right)).is_lt();
        assert!(less("\u{1f600}", "\u{ff5e}"));
        assert!(less("B", "a"));
        assert!(less("ab", "abc"));
    }

    #[test]
    fn lone_surrogates_survive_and_encode_lossily() {
        let text = JsStr::from_units(vec![0x61, 0xd800, 0x62, 0xdc00, 0xd83d, 0xde00, 0xd83d]);
        assert!(!text.is_well_formed());
        assert_eq!(
            text.to_utf8(),
            b"a\xef\xbf\xbdb\xef\xbf\xbd\xf0\x9f\x98\x80\xef\xbf\xbd".to_vec()
        );
    }

    #[test]
    fn utf8_decoding_replaces_maximal_subparts_and_keeps_the_bom() {
        let decoded = JsStr::from_utf8_lossy(
            b"\xef\xbb\xbfa\xc0\x80\xed\xa0\x80\xf4\x90\x80\x80\xe2\x82a\xf0\x9f\x98",
        );
        let mut expected = vec![0xfeff, 0x61];
        expected.extend([0xfffd; 9]);
        expected.extend([0xfffd, 0x61, 0xfffd]);
        assert_eq!(decoded.units(), expected.as_slice());
    }
}
