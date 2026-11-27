//! The Rust port of `session-recency.ts`, with `readSessionLifecycle`, `sameSessionLifecycle` and
//! `withSessionLifecycle` of `display-session.ts` inlined (after `display-session-rs`). "Returns
//! `incoming` itself" is not observable over JSON: an unchanged record comes back as received.
//! `areSessionRecordsEqual` is `Object.is` at the leaves (`NaN` equals `NaN`, `-0` not `0`), and
//! a `Set` has no own keys, so it equals `{}`.

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

// ---- the unit ----

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .filter(|v| v.is_number() || v.get("$num").is_some())
        .and_then(js::as_number)
        .filter(|n| n.is_finite())
}

fn recency(session: &Value) -> Result<Option<f64>, String> {
    let time = get(session, "time")?;
    Ok(finite(opt(time, "updated")).or_else(|| finite(opt(time, "created"))))
}

fn compare(incoming: &Value, current: &Value) -> Result<i32, String> {
    let (a, b) = (recency(incoming)?, recency(current)?);
    Ok(match (a, b) {
        (Some(a), Some(b)) if a != b => {
            if a < b {
                -1
            } else {
                1
            }
        }
        _ => 0,
    })
}

/// `Math.max` of two defined numbers (`+0` over `-0`).
fn max(a: &Value, b: &Value) -> Value {
    let (x, y) = (js::as_number(a).unwrap_or(f64::NAN), js::as_number(b).unwrap_or(f64::NAN));
    if x > y || (x == y && x.is_sign_positive()) { a.clone() } else { b.clone() }
}

fn max_defined(left: Option<&Value>, right: Option<&Value>) -> Option<Value> {
    match (left, right) {
        (None, r) => r.cloned(),
        (l, None) => l.cloned(),
        (Some(l), Some(r)) => Some(max(l, r)),
    }
}

fn resolve(current: &Value, incoming: &Value) -> Result<Value, String> {
    let (left, right) = (read(current)?, read(incoming)?);
    let mut lifecycle = Map::new();
    if let Some(busy) = max_defined(left.get("busy"), right.get("busy")) {
        lifecycle.insert("busy".into(), busy);
    }
    let number = |side: &Map<String, Value>| side.get("idle").and_then(js::as_number);
    let incoming_wins = number(&right).is_some_and(|r| number(&left).is_none_or(|l| r > l));
    let pair = if incoming_wins { &right } else { &left };
    if let Some(idle) = pair.get("idle") {
        lifecycle.insert("idle".into(), idle.clone());
    }
    let outcome = if left.get("idle").is_none() && right.get("idle").is_none() {
        left.get("outcome").or(right.get("outcome"))
    } else {
        pair.get("outcome")
    };
    if let Some(outcome) = outcome {
        lifecycle.insert("outcome".into(), outcome.clone());
    }
    if let Some(viewed) = max_defined(left.get("viewed"), right.get("viewed")) {
        lifecycle.insert("viewed".into(), viewed);
    }
    if let Some(fork) = left.get("fork").or(right.get("fork")) {
        lifecycle.insert("fork".into(), fork.clone());
    }
    Ok(Value::Object(lifecycle))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(value) && js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

fn merge(current: &Value, incoming: Value) -> Result<Value, String> {
    if !truthy(current) {
        return Ok(incoming);
    }
    let lifecycle = resolve(current, &incoming)?;
    with_lifecycle(incoming, &lifecycle)
}

/// `Object.is` for primitives, then the structural walk.
fn equal(left: &Value, right: &Value) -> bool {
    if let (Some(x), Some(y)) = (js::as_number(left), js::as_number(right)) {
        return (x.is_nan() && y.is_nan()) || (x == y && x.is_sign_positive() == y.is_sign_positive());
    }
    if js::is_undefined(left) || js::is_undefined(right) {
        return js::is_undefined(left) && js::is_undefined(right);
    }
    if let (Some(x), Some(y)) = (js::string_units(left), js::string_units(right)) {
        return x == y;
    }
    if primitive_marker(left) || primitive_marker(right) {
        return false;
    }
    let keys = |v: &Value| match v {
        Value::Object(map) if map.len() == 1 && map.get("$set").is_some_and(Value::is_array) => Some(Map::new()),
        Value::Object(map) => Some(map.clone()),
        _ => None,
    };
    match (left, right) {
        (Value::Array(l), Value::Array(r)) => l.len() == r.len() && l.iter().zip(r).all(|(a, b)| equal(a, b)),
        (Value::Array(_), _) | (_, Value::Array(_)) => false,
        (Value::Object(_), Value::Object(_)) => match (keys(left), keys(right)) {
            (Some(l), Some(r)) => l.len() == r.len() && l.iter().all(|(k, v)| r.get(k).is_some_and(|w| equal(v, w))),
            _ => false,
        },
        _ => left == right,
    }
}

/// Port of `getSessionRecency` (`session-recency.ts:14`).
pub fn get_session_recency(session: serde_json::Value) -> Result<Option<f64>, String> {
    recency(&session)
}

/// Port of `compareSessionRecency` (`session-recency.ts:19`).
pub fn compare_session_recency(incoming: serde_json::Value, current: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(js::number(f64::from(compare(&incoming, &current)?)))
}

/// Port of `isStrictlyOlderSession` (`session-recency.ts:26`).
pub fn is_strictly_older_session(incoming: serde_json::Value, current: serde_json::Value) -> Result<bool, String> {
    Ok(compare(&incoming, &current)? < 0)
}

/// Port of `resolveSessionLifecycle` (`session-recency.ts:46`).
pub fn resolve_session_lifecycle(current: serde_json::Value, incoming: serde_json::Value) -> Result<serde_json::Value, String> {
    resolve(&current, &incoming)
}

/// Port of `mergeSessionLifecycle` (`session-recency.ts:74`).
pub fn merge_session_lifecycle(current: Option<serde_json::Value>, incoming: serde_json::Value) -> Result<serde_json::Value, String> {
    merge(&current.unwrap_or(Value::Null), incoming)
}

/// Port of `retainSessionLifecycle` (`session-recency.ts:86`).
pub fn retain_session_lifecycle(retained: serde_json::Value, rejected: serde_json::Value) -> Result<serde_json::Value, String> {
    let lifecycle = resolve(&retained, &rejected)?;
    with_lifecycle(retained, &lifecycle)
}

/// Port of `hasNewerSessionLifecycle` (`session-recency.ts:92`).
pub fn has_newer_session_lifecycle(current: serde_json::Value, incoming: serde_json::Value) -> Result<bool, String> {
    let before = Value::Object(read(&current)?);
    Ok(!same_lifecycle(&before, &resolve(&current, &incoming)?)?)
}

/// `session.id` as a `Map` key: objects (distinct references here) match nothing.
fn map_key(value: Option<&Value>) -> Option<Value> {
    match value {
        None => Some(js::undefined()),
        Some(v) if primitive_marker(v) || !matches!(v, Value::Object(_) | Value::Array(_)) => Some(v.clone()),
        Some(_) => None,
    }
}

fn same_key(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b)) {
        (Some(x), Some(y)) => x == y || (x.is_nan() && y.is_nan()),
        (None, None) => a == b,
        _ => false,
    }
}

/// `value.length` as `=== 0` and `index < length` see it.
fn length(value: &Value) -> Result<f64, String> {
    Ok(match value {
        Value::Array(items) => items.len() as f64,
        _ if js::string_units(value).is_some() => js::string_units(value).map_or(0, |u| u.len()) as f64,
        _ => get(value, "length")?.map_or(f64::NAN, |l| js::as_number(l).filter(|_| !l.is_boolean()).unwrap_or(f64::NAN)),
    })
}

/// `value[index]`.
fn at(value: &Value, index: usize) -> Value {
    match value {
        Value::Array(items) => items.get(index).cloned(),
        _ => match js::string_units(value) {
            Some(u) => u.get(index).map(|c| js::utf16_string(&[*c])),
            None => value.get(index.to_string()).cloned(),
        },
    }
    .unwrap_or_else(js::undefined)
}

/// Port of `mergeSessionListLifecycle` (`session-recency.ts:102`).
pub fn merge_session_list_lifecycle(current: Value, next: Value) -> Result<Value, String> {
    if length(&current)? == 0.0 || length(&next)? == 0.0 {
        return Ok(next);
    }
    let Value::Array(stored_list) = &current else {
        return Err("current.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut by_id: Vec<(Value, Value)> = Vec::new();
    for session in stored_list {
        let id = get(session, "id")?;
        if let Some(key) = map_key(id) {
            match by_id.iter_mut().find(|(k, _)| same_key(k, &key)) {
                Some(entry) => entry.1 = session.clone(),
                None => by_id.push((key, session.clone())),
            }
        }
    }
    let mut out = next.clone();
    let mut index = 0;
    while (index as f64) < length(&next)? {
        let session = at(&next, index);
        let stored = map_key(get(&session, "id")?).and_then(|key| by_id.iter().find(|(k, _)| same_key(k, &key)).map(|(_, s)| s.clone()));
        if let Some(stored) = stored.filter(truthy) {
            let merged = merge(&stored, session.clone())?;
            if merged != session {
                match &mut out {
                    Value::Array(items) => items[index] = merged,
                    Value::String(text) => return Err(format!("Cannot assign to read only property '{index}' of string '{text}'")),
                    _ => return Err("next.slice is not a function".into()), // recorded-literal: the V8 TypeError text
                }
            }
        }
        index += 1;
    }
    Ok(out)
}

/// Port of `areSessionRecordsEqual` (`session-recency.ts:138`).
pub fn are_session_records_equal(left: serde_json::Value, right: serde_json::Value) -> Result<bool, String> {
    Ok(equal(&left, &right))
}
