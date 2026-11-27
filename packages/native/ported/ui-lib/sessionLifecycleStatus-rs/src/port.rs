//! The Rust port of `sessionLifecycleStatus.ts`, over any JS value: reads fail on `null` and
//! `undefined` as V8 does, `questionCount > 0` uses JS `ToNumber`, and the inputs' values are
//! returned as given.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// JS truthiness of a value received from JS.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
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

fn field(value: &Value, key: &str) -> Value {
    value.as_object().and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

/// Port of `deriveSessionLifecycleStatus` (`sessionLifecycleStatus.ts:67`).
pub fn derive_session_lifecycle_status(inputs: Value) -> Result<Value, String> {
    if nullish(&inputs) {
        let kind = if inputs.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading 'sdkSessionStatusError')")); // recorded-literal: V8 TypeError text
    }
    let error = field(&inputs, "sdkSessionStatusError");
    if truthy(&error) {
        return Ok(json!({ "kind": "error", "message": error }));
    }
    let questions = field(&inputs, "questionCount");
    if to_number(&questions) > 0.0 {
        return Ok(json!({ "kind": "awaiting-question", "questionCount": questions }));
    }
    let activity = field(&inputs, "assistantActivity");
    let active = activity
        .as_str()
        .is_some_and(|a| ["streaming", "tooling", "cooldown", "permission"].contains(&a));
    match field(&inputs, "planIndicatorState").as_str() {
        Some("implementing") => return Ok(json!({ "kind": "plan-executing" })),
        Some("proposed") => return Ok(json!({ "kind": "plan-proposed" })),
        _ => {}
    }
    let kind = if active { "streaming" } else { "idle" };
    Ok(json!({ "kind": kind, "planModeOn": field(&inputs, "planModeOn") }))
}
