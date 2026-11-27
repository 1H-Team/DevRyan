//! The Rust port of `git/hunk-validation.js`, over UTF-16 units. JS multiline `^` matches at the
//! start and after any line terminator (`\n`, `\r`, U+2028, U+2029); `test` stringifies a
//! non-string `current`, `search` then throws on it.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

const INVALID: &str = "Hunk changed or is unsupported. Refresh and try again.";

fn lt(u: u16) -> bool {
    matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Positions where `^` (multiline) holds.
fn line_starts(s: &[u16]) -> impl Iterator<Item = usize> + '_ {
    (0..=s.len()).filter(move |&i| i == 0 || lt(s[i - 1]))
}

fn count_at_line_start(s: &[u16], lit: &str) -> usize {
    let lit = units(lit);
    line_starts(s).filter(|&i| s[i..].starts_with(&lit)).count()
}

/// `String(value)` for `RegExp.prototype.test`.
fn string_of(value: &Value) -> Vec<u16> {
    if let Some(u) = js::string_units(value) {
        return u;
    }
    let text = match value {
        Value::Null => "null".to_string(),
        _ if js::is_undefined(value) => "undefined".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() || js::is_undefined(v) {
                    String::new()
                } else {
                    String::from_utf16_lossy(&string_of(v))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    units(&text)
}

/// `Buffer.byteLength(text)`: UTF-8 bytes, a lone surrogate counting as U+FFFD (3).
fn utf8_len(s: &[u16]) -> usize {
    char::decode_utf16(s.iter().copied()).map(|c| c.map_or(3, char::len_utf8)).sum()
}

fn invalid() -> Result<Value, String> {
    Err(INVALID.into())
}

/// Port of `currentHunkPatch` (`git/hunk-validation.js:3`).
pub fn current_hunk_patch(current: Value, submitted: Value) -> Result<Value, String> {
    let Some(sub) = js::string_units(&submitted) else { return invalid() };
    if utf8_len(&sub) > 4 * 1024 * 1024 || count_at_line_start(&sub, "diff --git ") != 1 || count_at_line_start(&sub, "@@ ") != 1 {
        return invalid();
    }
    let text = string_of(&current);
    let forbidden = [
        "old mode",
        "new mode",
        "new file mode",
        "deleted file mode",
        "rename from",
        "rename to",
        "copy from",
        "copy to",
        "GIT binary patch",
        "Binary files",
    ];
    if line_starts(&text).any(|i| forbidden.iter().any(|f| text[i..].starts_with(&units(f)))) {
        return invalid();
    }
    let Some(cur) = js::string_units(&current) else {
        if current.is_null() || js::is_undefined(&current) {
            let kind = if current.is_null() { "null" } else { "undefined" };
            return Err(format!("Cannot read properties of {kind} (reading 'search')")); // recorded-literal: V8 TypeError text
        }
        return Err("current.search is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let marker = units("@@ ");
    let starts: Vec<usize> = line_starts(&cur).filter(|&i| cur[i..].starts_with(&marker)).collect();
    let Some(&first) = starts.first() else { return invalid() };
    let header = &cur[..first];
    let mut bounds = starts.clone();
    bounds.push(cur.len());
    let newline = u16::from(b'\n');
    for pair in bounds.windows(2) {
        let body = &cur[pair[0]..pair[1]];
        let mut candidate = header.to_vec();
        candidate.extend_from_slice(body);
        if body.last() != Some(&newline) {
            candidate.push(newline);
        }
        if candidate == sub {
            return Ok(submitted);
        }
    }
    invalid()
}
