//! The Rust port of `router/`: `resolveRoutedSessionDirectory` (`routedSessionDirectory.ts`).
//! The other exports read or build `URLSearchParams` and `window.location`/`history` and stay
//! in TS. Map and Set lookups are SameValueZero. Quirk kept: a directory of only slashes other
//! than `/` itself (`"//"`) normalizes to `null`.

#![forbid(unsafe_code)]

use serde_json::Value;

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

/// A plain JS object (not an array, nor a marker for a string, number, `undefined`, `Map` or `Set`).
fn is_plain(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        !(o.len() == 1
            && ["$undefined", "$num", "$utf16", "$map", "$set", "$bytes", "$function"]
                .iter()
                .any(|k| o.contains_key(*k)))
    })
}

/// `value.key` of a non-nullish value: own properties of plain objects, else `undefined`.
fn field(value: &Value, key: &str) -> Value {
    if !is_plain(value) {
        return js::undefined();
    }
    value.get(key).cloned().unwrap_or_else(js::undefined)
}

/// `value.key`, failing as V8 does on `null` and `undefined`.
fn get(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
}

/// `value?.key`.
fn opt(value: &Value, key: &str) -> Value {
    if nullish(value) { js::undefined() } else { field(value, key) }
}

/// SameValueZero between values received from JS (objects are never the same reference).
fn same_value_zero(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (js::as_number(a), js::as_number(b)) {
        return x == y || (x.is_nan() && y.is_nan());
    }
    if let (Some(x), Some(y)) = (js::string_units(a), js::string_units(b)) {
        return x == y;
    }
    match (a, b) {
        (Value::Null, Value::Null) | (Value::Bool(_), Value::Bool(_)) => a == b,
        _ => js::is_undefined(a) && js::is_undefined(b),
    }
}

/// `normalizeDirectory`.
fn normalize(value: &Value) -> Option<String> {
    let trimmed = value.as_str()?.trim_matches(js_space);
    let normalized = trimmed.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    if normalized.is_empty() {
        return (trimmed == "/").then(|| "/".to_string());
    }
    Some(normalized.to_string())
}

fn session_directory(session: &Value) -> Result<Option<String>, String> {
    if let Some(directory) = normalize(&get(session, "directory")?) {
        return Ok(Some(directory));
    }
    Ok(normalize(&opt(&field(session, "project"), "worktree")))
}

/// Port of `resolveRoutedSessionDirectory` (`router/routedSessionDirectory.ts:19`).
pub fn resolve_routed_session_directory(session_id: Value, live_directory: Value, sessions: Value) -> Result<Value, String> {
    if let Some(live) = normalize(&live_directory) {
        return Ok(Value::String(live));
    }
    let Value::Array(items) = &sessions else {
        get(&sessions, "map")?;
        return Err("sessions.map is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let mut by_id: Vec<(Value, Value)> = Vec::new();
    for session in items {
        let id = get(session, "id")?;
        match by_id.iter_mut().find(|(key, _)| same_value_zero(key, &id)) {
            Some(entry) => entry.1 = session.clone(),
            None => by_id.push((id, session.clone())),
        }
    }
    let lookup = |key: &Value| by_id.iter().find(|(k, _)| same_value_zero(k, key)).map(|(_, s)| s.clone());
    let mut visited: Vec<Value> = Vec::new();
    let mut current = lookup(&session_id);
    while let Some(session) = current.take().filter(truthy) {
        let id = get(&session, "id")?;
        if visited.iter().any(|v| same_value_zero(v, &id)) {
            break;
        }
        visited.push(id);
        if let Some(directory) = session_directory(&session)? {
            return Ok(Value::String(directory));
        }
        let parent = field(&session, "parentID");
        current = if truthy(&parent) { lookup(&parent) } else { None };
    }
    Ok(Value::Null)
}
