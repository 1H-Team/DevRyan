//! The Rust port of `utils.ts`: the three path formatters. The rest reads `navigator` or the
//! desktop shell, or wraps `clsx`/`tailwind-merge`/Fuse.js, and stays in TS. Lengths and
//! `slice` are in UTF-16 code units (a cut may split a surrogate pair, as in JS);
//! `Math.max(16, maxLength)` uses JS `ToNumber`, so a non-numeric `maxLength` is NaN and every
//! comparison with it is false.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JS `Number(text)`.
fn string_number(text: &str) -> f64 {
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |acc, c| c.to_digit(radix).map(|d| acc * f64::from(radix) + f64::from(d)))
                .unwrap_or(f64::NAN);
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let (mantissa, exponent) = body.split_once(['e', 'E']).unwrap_or((body, "0"));
    let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if (int.is_empty() && frac.is_empty()) || !digits(int) || !digits(frac) || exponent.is_empty() || !digits(exponent) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(value)` for an array element joined by `Array.prototype.join`.
fn join_text(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => String::new(),
        _ if js::is_undefined(value) => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(join_text).collect::<Option<Vec<_>>>()?.join(","),
        Value::Number(_) | Value::Object(_) => js::number_to_string(js::as_number(value)?),
    })
}

/// JS `ToNumber(ToPrimitive(value))` (a plain object is NaN).
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::String(text) => string_number(text),
        Value::Array(_) => join_text(value).map_or(f64::NAN, |text| string_number(&text)),
        _ => js::as_number(value).unwrap_or(f64::NAN),
    }
}

const SLASH: u16 = b'/' as u16;

/// JS `Math.max(a, b)` (NaN wins).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

fn ellipsis(prefix: &[u16], file_name: &[u16]) -> Value {
    let mut out = prefix.to_vec();
    out.extend("\u{2026}/".encode_utf16());
    out.extend_from_slice(file_name);
    js::utf16_string(&out)
}

/// Port of `truncatePathMiddle` (`utils.ts:50`).
pub fn truncate_path_middle(value: Value, options: Value) -> Result<Value, String> {
    let source = if nullish(&value) { Value::String(String::new()) } else { value };
    let max_option = if nullish(&options) {
        js::undefined()
    } else {
        options.get("maxLength").cloned().unwrap_or_else(js::undefined)
    };
    let max_length = js_max(16.0, if nullish(&max_option) { 45.0 } else { to_number(&max_option) });
    let Some(units) = js::string_units(&source) else {
        return Err("source.split is not a function".into()); // recorded-literal: V8 TypeError text
    };
    if units.len() as f64 <= max_length {
        return Ok(source);
    }
    let mut segments: Vec<&[u16]> = units.split(|&u| u == SLASH).collect();
    if segments.len() <= 1 {
        return Ok(source);
    }
    let file_name = segments.pop().unwrap_or_default();
    if file_name.is_empty() {
        return Ok(source);
    }
    let budget = js_max(0.0, max_length - (file_name.len() as f64 + 2.0));
    if budget <= 0.0 {
        return Ok(ellipsis(&[], file_name));
    }
    let mut prefix: Vec<u16> = Vec::new();
    for segment in segments.iter().filter(|s| !s.is_empty()) {
        let mut candidate = prefix.clone();
        if !candidate.is_empty() {
            candidate.push(SLASH);
        }
        candidate.extend_from_slice(segment);
        if candidate.len() as f64 > budget {
            break;
        }
        prefix = candidate;
    }
    if prefix.is_empty() {
        let first = segments.first().copied().unwrap_or_default();
        let end = if budget.is_nan() { 0 } else { (budget.trunc() as usize).min(first.len()) };
        prefix = first[..end].to_vec();
    }
    Ok(ellipsis(&prefix, file_name))
}

/// `normalizePath`: trailing slashes off, `/` kept.
fn normalize(value: &str) -> &str {
    if value == "/" { value } else { value.trim_end_matches('/') }
}

/// Port of `formatPathForDisplay` (`utils.ts:100`).
pub fn format_path_for_display(path: Option<String>, home_directory: Option<String>) -> Result<String, String> {
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return Ok(String::new());
    };
    let normalized = normalize(&path);
    if normalized == "/" {
        return Ok("/".into());
    }
    let home = home_directory
        .as_deref()
        .filter(|h| !h.is_empty())
        .map(normalize)
        .filter(|h| !h.is_empty() && *h != "/");
    if let Some(home) = home {
        if normalized == home {
            return Ok("~".into());
        }
        if let Some(relative) = normalized.strip_prefix(home).and_then(|r| r.strip_prefix('/')) {
            return Ok(if relative.is_empty() { "~".into() } else { format!("~/{relative}") });
        }
    }
    Ok(normalized.to_string())
}

/// Port of `formatDirectoryName` (`utils.ts:126`).
pub fn format_directory_name(path: Option<String>, home_directory: Option<String>) -> Result<String, String> {
    let Some(path) = path.filter(|p| !p.is_empty()) else { return Ok("/".into()) };
    let normalized = normalize(&path);
    if normalized.is_empty() || normalized == "/" {
        return Ok("/".into());
    }
    let home = home_directory.as_deref().filter(|h| !h.is_empty()).map(normalize);
    if home.is_some_and(|h| !h.is_empty() && h != "/" && h == normalized) {
        return Ok("~".into());
    }
    let name = normalized.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or(normalized);
    Ok(if name.is_empty() { "/".into() } else { name.to_string() })
}
