//! The change store's keys and list pages: a port of the pure parts of
//! `packages/harness-runtime/lib/session-changes-store.js` (`validKey`, the
//! id and token checks of `openChangeStore`, `setListObjects`, `leaseRef` and
//! `importPrefix`, page naming and `pagesOf`) and of `key()` in
//! `session-mutations.js`.
//!
//! Keys are JavaScript strings (`JsStr`). Byte sizes are of UTF-8 as
//! `Buffer.byteLength(text)` counts them; JSON is `js::stringify_utf8`, which
//! writes what `JSON.stringify` writes (a JSON text holds no lone surrogate,
//! so its UTF-8 length is exact). Hashing is the caller's (`tree::Digest`).
#![forbid(unsafe_code)]

use crate::js::{JsStr, TooDeep, Value, stringify_utf8};
use crate::tree::Digest;

/// At most this many values per list page.
pub const PAGE_VALUES: usize = 128;
/// At most this many bytes of the values' JSON per page (a single larger
/// value still gets a page of its own).
pub const PAGE_BYTES: usize = 256 * 1024;
/// A staged record (`setData`, `writeList`) larger than this is refused with
/// `change_record_too_large` (503); the same bound refuses listed rows.
pub const RECORD_BYTES: usize = 512 * 1024;

const SLASH: u16 = b'/' as u16;

fn is_key_unit(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | SLASH)
        || unit == u16::from(b'_')
        || unit == u16::from(b'-')
}

/// `validKey(key)`: `/^[a-zA-Z0-9/_-]+\.json$/` and no empty or `..` part
/// (`..` cannot occur: `.` appears only in the suffix).
pub fn valid_key(key: &[u16]) -> bool {
    let suffix: Vec<u16> = ".json".encode_utf16().collect();
    let Some(stem) = key.strip_suffix(suffix.as_slice()) else {
        return false;
    };
    if stem.is_empty() || !stem.iter().all(|unit| is_key_unit(*unit)) {
        return false;
    }
    let dot_dot: Vec<u16> = "..".encode_utf16().collect();
    !key.split(|unit| *unit == SLASH)
        .any(|part| part.is_empty() || part == dot_dot.as_slice())
}

/// `validKey(\`${prefix}/page.json\`)`: the check every prefix argument gets.
pub fn valid_prefix(prefix: &[u16]) -> bool {
    let mut key = prefix.to_vec();
    key.extend("/page.json".encode_utf16());
    valid_key(&key)
}

fn all_lower_hex(text: &[u16]) -> bool {
    text.iter()
        .all(|unit| matches!(*unit, 0x30..=0x39 | 0x61..=0x66))
}

/// `/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/`: a tree id (`at`, a loose ref's value).
pub fn valid_object_id(text: &[u16]) -> bool {
    (text.len() == 40 || text.len() == 64) && all_lower_hex(text)
}

/// `/^[a-f0-9]{40,64}$/`, `importPrefix`'s check of its source tree. JS: it
/// accepts every length from 40 to 64, not only the two id widths.
pub fn valid_import_source(text: &[u16]) -> bool {
    (40..=64).contains(&text.len()) && all_lower_hex(text)
}

/// `setListObjects`' check of each id: `oid.length === oidLength && /^[a-f0-9]+$/`.
pub fn valid_list_object(oid: &[u16], oid_length: usize) -> bool {
    oid.len() == oid_length && !oid.is_empty() && all_lower_hex(oid)
}

/// `/^[a-f0-9-]{36}$/`, a lease token (`leaseRef`).
pub fn valid_lease_token(token: &[u16]) -> bool {
    token.len() == 36
        && token
            .iter()
            .all(|unit| matches!(*unit, 0x30..=0x39 | 0x61..=0x66) || *unit == u16::from(b'-'))
}

/// `leaseRef(token)`: `refs/devryan/leases/<token>`, or `None` where the
/// JavaScript throws `invalid_change_record`.
pub fn lease_ref(token: &[u16]) -> Option<JsStr> {
    if !valid_lease_token(token) {
        return None;
    }
    let mut name = JsStr::from("refs/devryan/leases/");
    name.push_units(token);
    Some(name)
}

/// `openChangeStore`'s check of `ref`: the state ref or a lease ref.
pub fn valid_store_ref(name: &[u16]) -> bool {
    let state: Vec<u16> = "refs/devryan/state".encode_utf16().collect();
    let leases: Vec<u16> = "refs/devryan/leases/".encode_utf16().collect();
    name == state.as_slice()
        || name
            .strip_prefix(leases.as_slice())
            .is_some_and(valid_lease_token)
}

/// `String(index).padStart(10, '0')` for a page index (a safe integer).
pub fn page_number(index: i64) -> JsStr {
    let digits = index.to_string();
    let mut text = "0".repeat(10usize.saturating_sub(digits.len()));
    text.push_str(&digits);
    JsStr::from(text)
}

/// `${prefix}/${String(index).padStart(10, '0')}.json`, a page's key.
pub fn page_name(prefix: &[u16], index: i64) -> JsStr {
    let mut name = JsStr::from_units(prefix.to_vec());
    name.push_str("/");
    name.push_units(page_number(index).units());
    name.push_str(".json");
    name
}

/// The bytes `changeKey(id)` hashes: `Buffer.from(id)`, UTF-8 with lone
/// surrogates as `EF BF BD`.
pub fn change_key_input(id: &JsStr) -> Vec<u8> {
    id.to_utf8()
}

/// `key(kind, id)` of `session-mutations.js`: `${kind}/${sha256(id)}.json`,
/// with the caller's SHA-256.
pub fn entity_key(digest: &mut impl Digest, kind: &str, id: &JsStr) -> JsStr {
    let mut key = JsStr::from(kind);
    key.push_str("/");
    key.push_units(digest.hex(&[&change_key_input(id)]).units());
    key.push_str(".json");
    key
}

/// Whether a record of this many bytes is refused (`Buffer.byteLength(data) > 512 KiB`).
pub fn record_too_large(bytes: usize) -> bool {
    bytes > RECORD_BYTES
}

/// One list page: the values `values[start..end]` and the page's own JSON
/// (`JSON.stringify(page)`), the text `setList` and `writeList` store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub start: usize,
    pub end: usize,
    pub json: Vec<u8>,
}

/// `pagesOf(values)`: the pages and `totals.bytes`, the sum of the values'
/// JSON byte lengths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pages {
    pub pages: Vec<Page>,
    pub bytes: usize,
}

/// Why `pages_of` failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PagingError {
    /// The value at this index has no JSON (`undefined`): the JavaScript
    /// throws a `TypeError` from `Buffer.byteLength(undefined)`.
    NoJson(usize),
    /// The value at this index nests deeper than `js::MAX_DEPTH`; the
    /// JavaScript would page it (callers fail closed).
    TooDeep(usize),
}

/// `pagesOf(values)` of `session-changes-store.js`: a value closes the
/// current page first when that page already holds 128 values, or when its
/// JSON would take the page's value bytes past 256 KiB. Sizes are the UTF-8
/// lengths of `JSON.stringify(value)`; `undefined` inside a page is `null`
/// in the page's JSON, as `JSON.stringify(page)` writes it.
pub fn pages_of(values: &[Value]) -> Result<Pages, PagingError> {
    let mut pages = Vec::new();
    let mut total = 0usize;
    let mut start = 0usize;
    let mut bytes = 0usize;
    let mut json = vec![b'['];
    for (index, value) in values.iter().enumerate() {
        let text = match stringify_utf8(value) {
            Ok(Some(text)) => text,
            Ok(None) => return Err(PagingError::NoJson(index)),
            Err(TooDeep) => return Err(PagingError::TooDeep(index)),
        };
        let size = text.len();
        let length = index - start;
        if length > 0 && (length >= PAGE_VALUES || bytes + size > PAGE_BYTES) {
            json.push(b']');
            pages.push(Page {
                start,
                end: index,
                json: std::mem::replace(&mut json, vec![b'[']),
            });
            start = index;
            bytes = 0;
        }
        if index > start {
            json.push(b',');
        }
        json.extend_from_slice(&text);
        bytes += size;
        total += size;
    }
    if values.len() > start {
        json.push(b']');
        pages.push(Page {
            start,
            end: values.len(),
            json,
        });
    }
    Ok(Pages {
        pages,
        bytes: total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn keys_are_checked_as_the_store_checks_them() {
        for key in [
            "a.json",
            "a/b.json",
            "runs/x_y-z/0000000001.json",
            "a/.json",
        ] {
            assert!(valid_key(&units(key)), "{key}");
        }
        for key in [
            ".json",
            "/a.json",
            "a//b.json",
            "a/b/.json/",
            "a.JSON",
            "a b.json",
            "a.json\n",
            "é.json",
        ] {
            assert!(!valid_key(&units(key)), "{key}");
        }
    }

    #[test]
    fn page_numbers_pad_to_ten_digits() {
        assert_eq!(page_number(0), "0000000000");
        assert_eq!(page_number(12345678901), "12345678901");
        assert_eq!(page_number(-1), "00000000-1");
    }

    #[test]
    fn a_value_too_large_for_a_page_gets_one_of_its_own() {
        let big = Value::string(&"x".repeat(PAGE_BYTES));
        let pages = pages_of(&[Value::Number(1.0), big, Value::Number(2.0)]).unwrap();
        let bounds: Vec<(usize, usize)> = pages
            .pages
            .iter()
            .map(|page| (page.start, page.end))
            .collect();
        assert_eq!(bounds, [(0, 1), (1, 2), (2, 3)]);
        assert_eq!(pages.bytes, PAGE_BYTES + 4);
        assert_eq!(
            pages_of(&[Value::Null, Value::Undefined]),
            Err(PagingError::NoJson(1))
        );
    }
}
