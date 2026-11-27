//! The Rust port of `session-user-activity.ts` (its four pure exports), with the lookups of
//! `revert-transactions` and `message-order` it calls inlined. The two `update*` exports mutate
//! their draft and are proven by the wrapper crate in `mutation/`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

type R<T> = Result<T, String>;

fn undef() -> Value {
    js::undefined()
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

fn marker<'a>(v: &'a Value, tag: &str) -> Option<&'a Value> {
    match v {
        Value::Object(o) if o.len() == 1 => o.get(tag),
        _ => None,
    }
}

fn set_items(v: &Value) -> Option<&Vec<Value>> {
    marker(v, "$set").and_then(Value::as_array)
}

/// `typeof v === "number"`.
fn num(v: &Value) -> Option<f64> {
    if v.is_number() || marker(v, "$num").is_some() {
        js::as_number(v)
    } else {
        None
    }
}

/// `typeof v === "string"`, as UTF-16 code units.
fn units(v: &Value) -> Option<Vec<u16>> {
    if v.is_string() || marker(v, "$utf16").is_some() {
        js::string_units(v)
    } else {
        None
    }
}

/// A plain object (not a marker of `undefined`, a number, a string or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    match v {
        Value::Object(o) if !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))) => Some(o),
        _ => None,
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(_) => num(v).is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ if js::is_undefined(v) => false,
        _ if marker(v, "$num").is_some() => num(v).is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ if marker(v, "$utf16").is_some() => units(v).is_some_and(|u| !u.is_empty()),
        _ => true,
    }
}

/// `===` (`same_zero`: SameValueZero, as `Map` and `Set` keys compare). Objects equal nothing.
fn eq(a: &Value, b: &Value, same_zero: bool) -> bool {
    if let (Some(x), Some(y)) = (num(a), num(b)) {
        return x == y || (same_zero && x.is_nan() && y.is_nan());
    }
    if let (Some(x), Some(y)) = (units(a), units(b)) {
        return x == y;
    }
    match (a, b) {
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => js::is_undefined(a) && js::is_undefined(b),
    }
}

fn is_str(v: &Value, text: &str) -> bool {
    units(v).is_some_and(|u| u == text.encode_utf16().collect::<Vec<_>>())
}

/// JS `ToString` of a property key.
fn key_of(v: &Value) -> String {
    if let Some(n) = num(v) {
        return js::number_to_string(n);
    }
    if let Some(u) = units(v) {
        return String::from_utf16_lossy(&u);
    }
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|i| if nullish(i) { String::new() } else { key_of(i) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(v) => "undefined".into(),
        _ if set_items(v).is_some() => "[object Set]".into(),
        _ => "[object Object]".into(),
    }
}

fn read_error(base: &Value, key: Option<String>) -> String {
    let kind = if base.is_null() { "null" } else { "undefined" };
    match key {
        Some(key) => format!("Cannot read properties of {kind} (reading '{key}')"),
        None => format!("Cannot read properties of {kind}"),
    }
}

fn index_key(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse::<u32>().ok().filter(|n| canonical && *n != u32::MAX)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    if let Some(u) = units(v) {
        return match key {
            "length" => js::number(u.len() as f64),
            _ => index_key(key).and_then(|i| u.get(i as usize)).map_or_else(undef, |c| js::utf16_string(&[*c])),
        };
    }
    match v {
        Value::Array(items) if key == "length" => js::number(items.len() as f64),
        Value::Array(items) => index_key(key).and_then(|i| items.get(i as usize)).cloned().unwrap_or_else(undef),
        _ => plain(v).and_then(|o| o.get(key)).cloned().unwrap_or_else(undef),
    }
}

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> R<Value> {
    if nullish(v) { Err(read_error(v, Some(key.into()))) } else { Ok(prop(v, key)) }
}

/// `v?.key`.
fn opt(v: &Value, key: &str) -> Value {
    if nullish(v) { undef() } else { prop(v, key) }
}

fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JS `Number(text)`.
fn to_number(u: &[u16]) -> f64 {
    let text = String::from_utf16_lossy(u);
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            let mut n = 0.0;
            for c in digits.chars() {
                let Some(d) = c.to_digit(radix) else { return f64::NAN };
                n = n * f64::from(radix) + f64::from(d);
            }
            return if digits.is_empty() { f64::NAN } else { n };
        }
    }
    match t.strip_prefix(['+', '-']).unwrap_or(t) {
        "Infinity" => return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY }, // recorded-literal: JS ToNumber keyword
        body if body.is_empty() || !body.starts_with(|c: char| c.is_ascii_digit() || c == '.') => return f64::NAN,
        body if body.contains(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))) => return f64::NAN,
        _ => {}
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

// ---- the unit ----

fn finite(value: &Value) -> Option<f64> {
    if let Some(n) = num(value) {
        return n.is_finite().then_some(n);
    }
    let u = units(value)?;
    if String::from_utf16_lossy(&u).trim_matches(js_space).is_empty() {
        return None;
    }
    Some(to_number(&u)).filter(|n| n.is_finite())
}

fn root(session: &Value) -> bool {
    !truthy(&opt(session, "parentID"))
}

fn created_at(message: &Value) -> R<Option<f64>> {
    Ok(finite(&opt(&get(message, "time")?, "created")))
}

/// `state.session?.find((candidate) => candidate.id === sessionID)`.
fn find_session(state: &Value, session_id: &Value) -> R<Value> {
    let sessions = prop(state, "session");
    if nullish(&sessions) {
        return Ok(undef());
    }
    let Value::Array(list) = &sessions else {
        return Err("state.session?.find is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for candidate in list {
        if eq(&get(candidate, "id")?, session_id, false) {
            return Ok(candidate.clone());
        }
    }
    Ok(undef())
}

/// `getEffectiveSessionRevertMessageID(state, sessionID, session)`.
fn effective(state: &Value, session_id: &Value, session: &Value) -> R<Value> {
    let transaction = opt(&get(state, "revert_transaction")?, &key_of(session_id));
    if truthy(&transaction) && !is_str(&prop(&transaction, "status"), "failed") {
        return Ok(prop(&transaction, "messageID"));
    }
    let session = if nullish(session) {
        find_session(state, session_id)?
    } else {
        session.clone()
    };
    Ok(opt(&opt(&session, "revert"), "messageID"))
}

/// `messagesBefore(messages, marker)`: `None` when it returns `messages` itself.
fn before(messages: &Value, marker: &Value) -> R<Option<Vec<Value>>> {
    let Value::Array(list) = messages else {
        return Err("messages.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for (index, message) in list.iter().enumerate() {
        if eq(&get(message, "id")?, marker, false) {
            return Ok(Some(list[..index].to_vec()));
        }
    }
    Ok(None)
}

/// `isMessageHiddenByRevert(state, sessionID, messageID)`.
fn hidden(state: &Value, session_id: &Value, message_id: &Value) -> R<bool> {
    if !truthy(session_id) {
        return Ok(false);
    }
    let revert = effective(state, session_id, &undef())?;
    if !truthy(&revert) {
        return Ok(false);
    }
    let transaction = opt(&prop(state, "revert_transaction"), &key_of(session_id));
    let ids = opt(&transaction, "hiddenMessageIDs");
    if !is_str(&opt(&transaction, "status"), "failed") && !nullish(&ids) {
        let Some(set) = set_items(&ids) else {
            return Err("transaction?.hiddenMessageIDs?.has is not a function".into()); // recorded-literal: the V8 TypeError text
        };
        if set.iter().any(|id| eq(id, message_id, true)) {
            return Ok(true);
        }
    }
    let messages = opt(&prop(state, "message"), &key_of(session_id));
    if !truthy(&messages) {
        return Ok(false);
    }
    let Some(visible) = before(&messages, &revert)? else { return Ok(false) };
    for message in &visible {
        if eq(&get(message, "id")?, message_id, false) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `for (const message of visibleMessages)`.
fn iterate(value: &Value) -> R<Vec<Value>> {
    if let Some(set) = set_items(value) {
        return Ok(set.clone());
    }
    if let Some(u) = units(value) {
        let chars = char::decode_utf16(u.iter().copied());
        return Ok(chars
            .map(|c| c.map_or_else(|e| js::utf16_string(&[e.unpaired_surrogate()]), |c| Value::String(c.into())))
            .collect());
    }
    match value {
        Value::Array(items) => Ok(items.clone()),
        _ => Err("visibleMessages is not iterable".into()), // recorded-literal: the V8 TypeError text
    }
}

fn max(a: f64, b: f64) -> f64 {
    if a > b || (a == b && a.is_sign_positive()) { a } else { b }
}

/// Port of `toFiniteTimestamp` (`session-user-activity.ts:12`).
pub fn to_finite_timestamp(value: serde_json::Value) -> Result<Option<f64>, String> {
    Ok(finite(&value))
}

/// Port of `isRootSession` (`session-user-activity.ts:21`).
pub fn is_root_session(session: Option<serde_json::Value>) -> Result<bool, String> {
    Ok(root(&session.unwrap_or_else(undef)))
}

/// Port of `getMessageCreatedAt` (`session-user-activity.ts:32`).
pub fn get_message_created_at(message: serde_json::Value) -> Result<Option<f64>, String> {
    created_at(&message)
}

/// Port of `getLastVisibleUserMessageAt` (`session-user-activity.ts:36`).
pub fn get_last_visible_user_message_at(
    session: Option<serde_json::Value>,
    messages: serde_json::Value,
    state: Option<serde_json::Value>,
) -> Result<Option<f64>, String> {
    let session = session.unwrap_or_else(undef);
    let state = state.unwrap_or_else(undef);
    if !root(&session) || !truthy(&messages) {
        return Ok(None);
    }
    let revert = if truthy(&state) {
        let id = opt(&session, "id");
        effective(&state, &if nullish(&id) { Value::String(String::new()) } else { id }, &session)?
    } else {
        opt(&opt(&session, "revert"), "messageID")
    };
    let visible = match truthy(&revert).then(|| before(&messages, &revert)).transpose()?.flatten() {
        Some(list) => list,
        None => iterate(&messages)?,
    };
    let mut latest: Option<f64> = None;
    for message in &visible {
        let shown = !truthy(&state) || !hidden(&state, &get(message, "sessionID")?, &prop(message, "id"))?;
        if !is_str(&get(message, "role")?, "user") || !shown {
            continue;
        }
        let Some(created) = created_at(message)? else { continue };
        latest = Some(latest.map_or(created, |l| max(l, created)));
    }
    Ok(latest)
}
