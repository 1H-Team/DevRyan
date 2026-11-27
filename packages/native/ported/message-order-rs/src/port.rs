//! The Rust port of `message-order.ts`, after the client engine's `families/message_order.rs`:
//! ids compare with JS `<` (UTF-16 order for strings, numbers otherwise), the sort is V8's
//! (`js::sort`), and a comparison that throws fails the whole call.

#![forbid(unsafe_code)]

use std::cell::RefCell;

use serde_json::Value;

use crate::js;

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

/// A primitive operand of `<`.
enum Prim {
    Text(Vec<u16>),
    Num(f64),
}

fn primitive(value: Option<&Value>) -> Prim {
    let Some(value) = value.filter(|v| !js::is_undefined(v)) else {
        return Prim::Num(f64::NAN);
    };
    if let Some(n) = js::as_number(value) {
        return Prim::Num(n);
    }
    match value {
        Value::Null => Prim::Num(0.0),
        Value::Bool(flag) => Prim::Num(f64::from(u8::from(*flag))),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .map(|v| match primitive(Some(v)) {
                    _ if nullish(v) => String::new(),
                    Prim::Text(units) => String::from_utf16_lossy(&units),
                    Prim::Num(n) if v.is_boolean() => (n == 1.0).to_string(),
                    Prim::Num(n) => js::number_to_string(n),
                })
                .collect();
            Prim::Text(parts.join(",").encode_utf16().collect())
        }
        v => Prim::Text(js::string_units(v).unwrap_or_else(|| "[object Object]".encode_utf16().collect())),
    }
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
fn to_number(units: &[u16]) -> f64 {
    let text = String::from_utf16_lossy(units);
    let t = text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    let radix = |p: &str, r| t.strip_prefix(p).map(|d| radix_value(d, r));
    if t.is_empty() {
        return 0.0;
    }
    if let Some(n) = radix("0x", 16)
        .or_else(|| radix("0X", 16))
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0O", 8))
        .or_else(|| radix("0b", 2))
        .or_else(|| radix("0B", 2))
    {
        return n;
    }
    match t.trim_start_matches(['+', '-']) {
        "Infinity" => return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY }, // recorded-literal: JS ToNumber keyword
        body if body.is_empty() || body.contains(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))) => return f64::NAN,
        _ => {}
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

fn less(a: &Prim, b: &Prim) -> bool {
    let num = |p: &Prim| match p {
        Prim::Num(n) => *n,
        Prim::Text(units) => to_number(units),
    };
    match (a, b) {
        (Prim::Text(x), Prim::Text(y)) => x < y,
        _ => num(a) < num(b),
    }
}

fn created_at(message: &Value) -> Result<f64, String> {
    let created = get(message, "time")?
        .and_then(|t| t.get("created"))
        .filter(|v| v.is_number() || v.get("$num").is_some());
    Ok(created.and_then(js::as_number).filter(|n| n.is_finite()).unwrap_or(0.0))
}

/// Port of `compareMessagesChronologically` (`message-order.ts:16`).
pub fn compare_messages_chronologically(left: Value, right: Value) -> Result<f64, String> {
    let delta = created_at(&left)? - created_at(&right)?;
    if delta != 0.0 {
        return Ok(delta);
    }
    let (a, b) = (primitive(get(&left, "id")?), primitive(get(&right, "id")?));
    Ok(if less(&a, &b) {
        -1.0
    } else if less(&b, &a) {
        1.0
    } else {
        0.0
    })
}

/// `[...messages]`.
fn spread(messages: &Value) -> Result<Vec<Value>, String> {
    match messages {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        _ => Err("messages is not iterable".to_string()), // recorded-literal: the V8 TypeError text
    }
}

/// Port of `sortMessagesChronologically` (`message-order.ts:24`).
pub fn sort_messages_chronologically(messages: Value) -> Result<Vec<Value>, String> {
    let mut items = spread(&messages)?;
    let failure = RefCell::new(None);
    js::sort(&mut items, |a, b| match compare_messages_chronologically(a.clone(), b.clone()) {
        Ok(order) => order,
        Err(e) => {
            failure.borrow_mut().get_or_insert(e);
            0.0
        }
    });
    failure.into_inner().map_or(Ok(items), Err)
}

/// Port of `insertMessageChronologically` (`message-order.ts:28`).
pub fn insert_message_chronologically(messages: Value, message: Value) -> Result<Vec<Value>, String> {
    get(&messages, "length")?;
    let indexed = spread(&messages).unwrap_or_default();
    let (mut low, mut high) = (0, indexed.len());
    while low < high {
        let middle = (low + high) >> 1;
        if compare_messages_chronologically(indexed[middle].clone(), message.clone())? <= 0.0 {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    let mut next = spread(&messages)?;
    next.insert(low.min(next.len()), message);
    Ok(next)
}

/// Port of `findMessageIndex` (`message-order.ts:44`).
pub fn find_message_index(messages: Value, message_id: String) -> Result<f64, String> {
    get(&messages, "findIndex")?;
    let Value::Array(items) = &messages else {
        return Err("messages.findIndex is not a function".to_string()); // recorded-literal: the V8 TypeError text
    };
    for (index, message) in items.iter().enumerate() {
        if get(message, "id")?.and_then(Value::as_str) == Some(message_id.as_str()) {
            return Ok(index as f64);
        }
    }
    Ok(-1.0)
}

/// Port of `messagesBefore` (`message-order.ts:53`).
pub fn messages_before(messages: Value, marker_id: String) -> Result<Value, String> {
    let index = find_message_index(messages.clone(), marker_id)?;
    let items = messages.as_array().cloned().unwrap_or_default();
    Ok(if index < 0.0 {
        messages
    } else {
        Value::Array(items[..index as usize].to_vec())
    })
}

/// Port of `messagesFrom` (`message-order.ts:62`).
pub fn messages_from(messages: Value, marker_id: String) -> Result<Value, String> {
    let index = find_message_index(messages.clone(), marker_id)?;
    let items = messages.as_array().cloned().unwrap_or_default();
    Ok(Value::Array(if index < 0.0 { Vec::new() } else { items[index as usize..].to_vec() }))
}
