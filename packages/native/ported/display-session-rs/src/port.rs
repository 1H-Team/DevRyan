//! The Rust port of `display-session.ts`. Returning "the same reference" is not observable over
//! JSON, so an unchanged record is returned as received. Fork identity (`left === right`) holds
//! only for absent or `null` forks, as two received objects are never the same reference.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// A bridge marker standing for a primitive (`undefined`, a special number, a string).
fn primitive_marker(value: &Value) -> bool {
    js::is_undefined(value) || js::as_number(value).is_some() || js::string_units(value).is_some()
}

/// `isRecord`.
fn is_record(value: Option<&Value>) -> bool {
    value.is_some_and(|v| v.is_object() && !primitive_marker(v))
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

fn timestamp(value: Option<&Value>) -> bool {
    value
        .filter(|v| v.is_number() || v.get("$num").is_some())
        .and_then(js::as_number)
        .is_some_and(|n| n.is_finite() && n >= 0.0)
}

fn outcome(value: Option<&Value>) -> bool {
    matches!(value.and_then(Value::as_str), Some("succeeded" | "failed" | "interrupted"))
}

fn non_empty_string(value: Option<&Value>) -> bool {
    value.and_then(js::string_units).is_some_and(|u| !u.is_empty())
}

fn fork(value: Option<&Value>) -> bool {
    let boundary = opt(value, "boundary");
    is_record(value)
        && non_empty_string(opt(value, "sessionID"))
        && is_record(boundary)
        && matches!(opt(boundary, "type").and_then(Value::as_str), Some("before" | "through"))
        && non_empty_string(opt(boundary, "messageID"))
}

/// `a === b` (objects never the same here; lone-surrogate string markers compare by value).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => match (js::as_number(x), js::as_number(y)) {
            (Some(m), Some(n)) => m == n,
            (None, None) => x == y && (!matches!(x, Value::Object(_) | Value::Array(_)) || js::string_units(x).is_some()),
            _ => false,
        },
        _ => false,
    }
}

/// Port of `isSessionLifecycleTimestamp` (`display-session.ts:24`).
pub fn is_session_lifecycle_timestamp(value: Value) -> Result<bool, String> {
    Ok(timestamp(Some(&value)))
}

/// Port of `isSessionOutcome` (`display-session.ts:28`).
pub fn is_session_outcome(value: Value) -> Result<bool, String> {
    Ok(outcome(Some(&value)))
}

/// Port of `isSessionFork` (`display-session.ts:32`).
pub fn is_session_fork(value: Value) -> Result<bool, String> {
    Ok(fork(Some(&value)))
}

fn read(session: &Value) -> Result<Map<String, Value>, String> {
    let time = get(session, "time")?;
    let mut lifecycle = Map::new();
    for key in ["busy", "idle", "viewed"] {
        if let Some(value) = opt(time, key).filter(|v| timestamp(Some(v))) {
            lifecycle.insert(key.to_string(), value.clone());
        }
    }
    for (key, valid) in [("outcome", outcome as fn(Option<&Value>) -> bool), ("fork", fork)] {
        if let Some(value) = session.get(key).filter(|v| valid(Some(v))) {
            lifecycle.insert(key.to_string(), value.clone());
        }
    }
    Ok(lifecycle)
}

/// Port of `readSessionLifecycle` (`display-session.ts:51`).
pub fn read_session_lifecycle(session: Value) -> Result<Value, String> {
    read(&session).map(Value::Object)
}

fn has_invalid(session: &Value) -> Result<bool, String> {
    let defined = |key: &str| session.get(key).filter(|v| !js::is_undefined(v));
    if defined("outcome").is_some_and(|v| !outcome(Some(v))) {
        return Ok(true);
    }
    get(session, "outcome")?;
    if defined("fork").is_some_and(|v| !fork(Some(v))) {
        return Ok(true);
    }
    let time = defined("time");
    if !is_record(time) {
        return Ok(false);
    }
    Ok(["busy", "idle", "viewed"].iter().any(|key| opt(time, key).is_some_and(|v| !timestamp(Some(v)))))
}

fn same_fork(left: Option<&Value>, right: Option<&Value>) -> Result<bool, String> {
    if same(left, right) || (left.is_some_and(Value::is_null) && right.is_some_and(Value::is_null)) {
        return Ok(true);
    }
    let (Some(l), Some(r)) = (left, right) else { return Ok(false) };
    if !same(get(l, "sessionID")?, get(r, "sessionID")?) {
        return Ok(false);
    }
    let (lb, rb) = (
        get(l, "boundary")?.cloned().unwrap_or_else(js::undefined),
        get(r, "boundary")?.cloned().unwrap_or_else(js::undefined),
    );
    if !same(get(&lb, "type")?, get(&rb, "type")?) {
        return Ok(false);
    }
    Ok(same(get(&lb, "messageID")?, get(&rb, "messageID")?))
}

fn same_lifecycle(left: &Value, right: &Value) -> Result<bool, String> {
    for key in ["busy", "idle", "viewed", "outcome"] {
        if !same(get(left, key)?, get(right, key)?) {
            return Ok(false);
        }
    }
    same_fork(get(left, "fork")?, get(right, "fork")?)
}

/// Port of `sameSessionLifecycle` (`display-session.ts:87`).
pub fn same_session_lifecycle(left: Value, right: Value) -> Result<bool, String> {
    same_lifecycle(&left, &right)
}

/// `{ ...value }`.
fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Array(items)) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Some(Value::String(text)) => text.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), js::utf16_string(&[u]))).collect(),
        Some(Value::Object(map)) if !primitive_marker(value.unwrap_or(&Value::Null)) => map.clone(),
        _ => Map::new(),
    }
}

fn apply(target: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    match value {
        None => {
            target.shift_remove(key);
        }
        Some(value) => {
            target.insert(key.to_string(), value.clone());
        }
    }
}

fn with_lifecycle(session: Value, lifecycle: &Value) -> Result<Value, String> {
    if !has_invalid(&session)? && same_lifecycle(&Value::Object(read(&session)?), lifecycle)? {
        return Ok(session);
    }
    let mut time = spread(session.get("time"));
    for key in ["busy", "idle", "viewed"] {
        apply(&mut time, key, get(lifecycle, key)?);
    }
    let mut next = spread(Some(&session));
    next.insert("time".to_string(), Value::Object(time));
    for key in ["outcome", "fork"] {
        apply(&mut next, key, get(lifecycle, key)?);
    }
    Ok(Value::Object(next))
}

/// Port of `withSessionLifecycle` (`display-session.ts:99`).
pub fn with_session_lifecycle(session: Value, lifecycle: Value) -> Result<Value, String> {
    with_lifecycle(session, &lifecycle)
}

fn decode(value: Value) -> Result<Value, String> {
    let is_session = is_record(Some(&value)) && non_empty_string(value.get("id")) && is_record(value.get("time"));
    if !is_session {
        return Ok(Value::Null);
    }
    if !has_invalid(&value)? {
        return Ok(value);
    }
    let lifecycle = Value::Object(read(&value)?);
    with_lifecycle(value, &lifecycle)
}

/// Port of `decodeDisplaySession` (`display-session.ts:122`).
pub fn decode_display_session(value: Value) -> Result<Value, String> {
    decode(value)
}

/// Port of `decodeSessionEventInfo` (`display-session.ts:130`).
pub fn decode_session_event_info(properties: Value) -> Result<Value, String> {
    if !is_record(Some(&properties)) {
        return Ok(Value::Null);
    }
    decode(properties.get("info").cloned().unwrap_or_else(js::undefined))
}

/// Port of `decodeDisplaySessionList` (`display-session.ts:135`).
pub fn decode_display_session_list(values: Value) -> Result<Vec<Value>, String> {
    let Value::Array(values) = values else { return Ok(Vec::new()) };
    let mut sessions = Vec::new();
    for value in values {
        let session = decode(value)?;
        if !session.is_null() {
            sessions.push(session);
        }
    }
    Ok(sessions)
}
