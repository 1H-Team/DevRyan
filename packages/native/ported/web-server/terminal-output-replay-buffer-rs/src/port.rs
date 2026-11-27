//! The Rust port of `terminal/output-replay-buffer.js`: the empty buffer and the replay listing
//! (`appendTerminalOutputReplayChunk` works by mutating its argument, which a recording cannot
//! observe, and stays in JavaScript). `chunk.id > lastSeenId` is the JS relational comparison.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

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

/// `ToPrimitive(value)` for `<`/`>`: text, or a number.
enum Primitive {
    Text(Vec<u16>),
    Number(f64),
}

fn to_primitive(value: &Value) -> Primitive {
    if let Some(units) = js::string_units(value) {
        return Primitive::Text(units);
    }
    match value {
        Value::Array(_) => Primitive::Text(join_text(value).unwrap_or_default().encode_utf16().collect()),
        Value::Object(_) if js::as_number(value).is_none() && !js::is_undefined(value) => Primitive::Text("[object Object]".encode_utf16().collect()),
        Value::Null => Primitive::Number(0.0),
        Value::Bool(flag) => Primitive::Number(f64::from(u8::from(*flag))),
        _ => Primitive::Number(js::as_number(value).unwrap_or(f64::NAN)),
    }
}

fn primitive_number(p: Primitive) -> f64 {
    match p {
        Primitive::Number(n) => n,
        Primitive::Text(units) => string_number(&String::from_utf16_lossy(&units)),
    }
}

/// JS `a > b`.
fn greater(a: &Value, b: &Value) -> bool {
    match (to_primitive(a), to_primitive(b)) {
        (Primitive::Text(x), Primitive::Text(y)) => x > y,
        (x, y) => primitive_number(x) > primitive_number(y),
    }
}

/// Port of `createTerminalOutputReplayBuffer` (`terminal/output-replay-buffer.js:30`).
pub fn create_terminal_output_replay_buffer() -> Result<Value, String> {
    Ok(json!({ "chunks": [], "totalBytes": 0, "nextId": 1 }))
}

/// Port of `listTerminalOutputReplayChunksSince` (`terminal/output-replay-buffer.js:66`).
pub fn list_terminal_output_replay_chunks_since(buffer_state: Value, last_seen_id: Value) -> Result<Value, String> {
    let is_object =
        buffer_state.is_object() && js::string_units(&buffer_state).is_none() && js::as_number(&buffer_state).is_none() && !js::is_undefined(&buffer_state);
    let chunks = buffer_state
        .as_object()
        .and_then(|o| o.get("chunks"))
        .filter(|_| is_object || buffer_state.is_array());
    let Some(Value::Array(chunks)) = chunks else { return Ok(json!([])) };
    let last = if js::is_undefined(&last_seen_id) { json!(0) } else { last_seen_id };
    let mut out = Vec::new();
    for chunk in chunks {
        if nullish(chunk) {
            let kind = if chunk.is_null() { "null" } else { "undefined" };
            return Err(format!("Cannot read properties of {kind} (reading 'id')")); // recorded-literal: V8 TypeError text
        }
        let id = chunk
            .as_object()
            .and_then(|o| o.get("id"))
            .cloned()
            .filter(|_| js::string_units(chunk).is_none())
            .unwrap_or_else(js::undefined);
        if greater(&id, &last) {
            out.push(chunk.clone());
        }
    }
    Ok(Value::Array(out))
}
