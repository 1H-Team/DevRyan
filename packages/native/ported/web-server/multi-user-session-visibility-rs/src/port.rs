//! The Rust port of `multi-user/session-visibility.js`: `normalizeSessionPageLimit` (the page
//! walker is async over callbacks; the ownership pick sorts with `localeCompare`). `Number(value)`
//! is the full JS conversion.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

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

/// `String(value)` as `Array.prototype.join` prints an element (and `ToPrimitive` an array).
fn join_text(value: &Value) -> String {
    if let Some(units) = js::string_units(value) {
        return String::from_utf16_lossy(&units);
    }
    match value {
        Value::Null => String::new(),
        _ if js::is_undefined(value) => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items.iter().map(join_text).collect::<Vec<_>>().join(","),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    }
}

/// JS `ToNumber(value)` (an object is NaN, an array its joined text).
fn to_num(value: &Value) -> f64 {
    if let Some(n) = js::as_number(value) {
        return n;
    }
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::String(s) => string_number(s),
        Value::Array(_) => string_number(&join_text(value)),
        _ => f64::NAN,
    }
}

/// Port of `normalizeSessionPageLimit` (`multi-user/session-visibility.js:13`): 100 unless
/// finite, else truncated into 1..=1000.
pub fn normalize_session_page_limit(value: Value) -> Result<Value, String> {
    let parsed = if js::is_undefined(&value) { f64::NAN } else { to_num(&value) };
    if !parsed.is_finite() {
        return Ok(Value::from(100));
    }
    Ok(js::number(parsed.trunc().clamp(1.0, 1000.0)))
}
