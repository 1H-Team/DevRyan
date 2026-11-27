//! The Rust port of `session-assistant-activity.ts`, with the revert filter it calls
//! (`getSessionRevertMessageID` and `filterMessagesForRevert` of `revert-transactions.ts`).
//! String timestamps go through JS `Number(...)`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(|v| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    })
}

/// `value[key]`, failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

fn opt<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.filter(|v| !nullish(v)).and_then(|v| v.get(key)).filter(|v| !js::is_undefined(v))
}

/// JS `Number(text)` for a non-blank string.
fn string_number(text: &str) -> f64 {
    let t = text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    let body = t.trim_start_matches(['+', '-']);
    if body.is_empty() || body.contains(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `toFiniteTimestamp`.
fn timestamp(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    if value.is_number() || value.get("$num").is_some() {
        return js::as_number(value).filter(|n| n.is_finite());
    }
    let text = value.as_str()?;
    let trimmed = text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    (!trimmed.is_empty()).then(|| string_number(text)).filter(|n| n.is_finite())
}

fn response_at(message: &Value) -> Result<Option<f64>, String> {
    let time = get(message, "time")?;
    Ok(["completed", "updated", "created"].iter().find_map(|key| timestamp(opt(time, key))))
}

/// Port of `getAssistantResponseAt` (`session-assistant-activity.ts:14`).
pub fn get_assistant_response_at(message: Value) -> Result<Option<f64>, String> {
    response_at(&message)
}

/// `messagesBefore(messages, marker)` (the same list when the marker is absent).
fn before(messages: &Value, marker: &Value) -> Result<Value, String> {
    get(messages, "findIndex")?;
    let Value::Array(items) = messages else {
        return Err("messages.findIndex is not a function".to_string());
    }; // recorded-literal: the V8 TypeError text
    let marker_key = (js::as_number(marker), marker.as_str());
    for (index, message) in items.iter().enumerate() {
        let id = get(message, "id")?;
        let same = id.is_some_and(|id| match (js::as_number(id), marker_key) {
            (Some(n), (Some(m), _)) => n == m,
            (None, (None, Some(s))) => id.as_str() == Some(s),
            (None, (None, None)) => !matches!(id, Value::Object(_) | Value::Array(_)) && id == marker,
            _ => false,
        });
        if same {
            return Ok(Value::Array(items[..index].to_vec()));
        }
    }
    Ok(messages.clone())
}

/// Port of `getLastVisibleAssistantResponseAt` (`session-assistant-activity.ts:25`).
pub fn get_last_visible_assistant_response_at(session: Option<Value>, messages: Value) -> Result<Option<f64>, String> {
    if !truthy(Some(&messages)) {
        return Ok(None);
    }
    let revert = opt(opt(session.as_ref(), "revert"), "messageID");
    let visible = match revert.filter(|r| truthy(Some(r))) {
        Some(marker) => before(&messages, marker)?,
        None => messages,
    };
    let items = match visible {
        Value::Array(items) => items,
        Value::String(text) => text.chars().map(|c| Value::String(c.to_string())).collect(),
        _ => return Err("visibleMessages is not iterable".to_string()), // recorded-literal: the V8 TypeError text
    };
    let mut latest: Option<f64> = None;
    for message in &items {
        if get(message, "role")?.and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(at) = response_at(message)? {
            // `Math.max` prefers +0 over -0.
            latest = Some(match latest {
                None => at,
                Some(l) if l == at && l == 0.0 => {
                    if l.is_sign_negative() {
                        at
                    } else {
                        l
                    }
                }
                Some(l) => l.max(at),
            });
        }
    }
    Ok(latest)
}
