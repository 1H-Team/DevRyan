//! The Rust port of the limit and pagination helpers of `message-fetch.ts`.
//! `normalizeFetchedMessageRecords` and `unwrapMessageRecordsResult` stay in TypeScript (they
//! call the part-delta normalizers, ported in `part-delta-rs`). Comparisons follow JS `<` on
//! numbers (`ToNumber` of the other operand).

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

/// `DEFAULT_MESSAGE_LIMIT` of `@/stores/types/sessionTypes`.
const DEFAULT_MESSAGE_LIMIT: f64 = 200.0;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// `value[key]`, failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

/// A JS number (`typeof value === "number"`).
fn number(value: Option<&Value>) -> Option<f64> {
    value.filter(|v| v.is_number() || v.get("$num").is_some()).and_then(js::as_number)
}

/// The value of `digits` in `radix`, as JS reads `0x`/`0o`/`0b` literals (no sign, any length).
fn radix_value(digits: &str, radix: u32) -> f64 {
    let mut n = 0.0;
    for c in digits.chars() {
        let Some(d) = c.to_digit(radix) else { return f64::NAN };
        n = n * f64::from(radix) + f64::from(d);
    }
    if digits.is_empty() { f64::NAN } else { n }
}

/// JS `ToNumber` of a string.
fn string_number(text: &str) -> f64 {
    let t = text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return radix_value(digits, radix);
        }
    }
    match t.trim_start_matches(['+', '-']) {
        "Infinity" => {
            if t.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }
        } // recorded-literal: JS ToNumber keyword
        body if body.is_empty() || body.contains(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))) => f64::NAN,
        _ => t.parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// JS `ToNumber`.
fn to_number(value: Option<&Value>) -> f64 {
    let Some(value) = value.filter(|v| !js::is_undefined(v)) else {
        return f64::NAN;
    };
    if let Some(n) = js::as_number(value) {
        return n;
    }
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::String(text) => string_number(text),
        Value::Array(items) if items.is_empty() => 0.0,
        // `ToNumber(String([x]))`: `String(true)` is "true", so a boolean element is NaN.
        Value::Array(items) if items.len() == 1 => match &items[0] {
            Value::Bool(_) => f64::NAN,
            v if nullish(v) => 0.0,
            v => to_number(Some(v)),
        },
        _ => f64::NAN,
    }
}

fn fetch_limit(limit: Option<&Value>) -> Option<f64> {
    number(limit).filter(|n| n.is_finite() && *n > 0.0).map(f64::floor)
}

/// Port of `hasMessageRecordInfo` (`message-fetch.ts:16`).
pub fn has_message_record_info(record: Value) -> Result<bool, String> {
    let id = record.get("info").filter(|v| !nullish(v)).and_then(|info| info.get("id"));
    Ok(id.and_then(js::string_units).is_some_and(|units| !units.is_empty()))
}

/// Port of `normalizeMessageFetchLimit` (`message-fetch.ts:20`).
pub fn normalize_message_fetch_limit(limit: Value, fallback: Value) -> Result<Value, String> {
    let fallback = if js::is_undefined(&fallback) {
        js::number(DEFAULT_MESSAGE_LIMIT)
    } else {
        fallback
    };
    Ok(fetch_limit(Some(&limit)).map_or(fallback, js::number))
}

fn page_limit(limit: Option<&Value>) -> f64 {
    DEFAULT_MESSAGE_LIMIT.max(fetch_limit(limit).unwrap_or(DEFAULT_MESSAGE_LIMIT))
}

/// Port of `normalizeSessionMessagePageLimit` (`message-fetch.ts:27`).
pub fn normalize_session_message_page_limit(limit: Value) -> Result<f64, String> {
    Ok(page_limit(Some(&limit)))
}

/// Port of `resolveRetainedMessageLimit` (`message-fetch.ts:31`).
pub fn resolve_retained_message_limit(input: Value) -> Result<f64, String> {
    let requested = get(&input, "requestedLimit")?;
    let count = number(get(&input, "materializedCount")?).filter(|n| n.is_finite()).map_or(0.0, f64::floor);
    Ok(page_limit(requested).max(count))
}

/// Port of `resolveMessagePagePagination` (`message-fetch.ts:41`).
pub fn resolve_message_page_pagination(input: Value) -> Result<Value, String> {
    let requested = fetch_limit(get(&input, "requestedLimit")?).unwrap_or(DEFAULT_MESSAGE_LIMIT);
    let truthy = |v: &&Value| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    };
    let cursor = input.get("cursor").filter(truthy);
    let complete = cursor.is_none() || to_number(input.get("returnedCount")) < requested;
    let cursor = if complete {
        js::undefined()
    } else {
        cursor.cloned().unwrap_or_else(js::undefined)
    };
    Ok(json!({ "cursor": cursor, "complete": complete }))
}
