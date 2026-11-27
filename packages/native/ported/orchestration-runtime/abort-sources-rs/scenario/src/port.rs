//! The Rust port of the test wrapper `scenario-js/abort-sources-scenario.js`: `normalizeAbortSource`
//! and a sequence of calls on one `createAbortSourceRegistry` registry of `abort-sources.js`, with
//! the clock the steps set. The registry's `Map` is kept in insertion order.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

// ---- JS values over JSON ----

/// A one-key object `{ tag: ... }`: how the bridge marks numbers, strings, `undefined` and `Set`s.
fn marked(v: &Value, tag: &str) -> bool {
    v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(tag))
}

/// `typeof v === "number"`.
fn num(v: &Value) -> Option<f64> {
    (v.is_number() || marked(v, "$num")).then(|| js::as_number(v)).flatten()
}

fn text(v: &Value) -> Option<String> {
    js::string_units(v).map(|u| String::from_utf16_lossy(&u))
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    let index = || key.parse::<usize>().ok().filter(|i| i.to_string() == key);
    let found = match (v, js::string_units(v)) {
        (_, Some(u)) if key == "length" => Some(js::number(u.len() as f64)),
        (_, Some(u)) => index().and_then(|i| u.get(i)).map(|c| js::utf16_string(&[*c])),
        (Value::Array(items), _) if key == "length" => Some(js::number(items.len() as f64)),
        (Value::Array(items), _) => index().and_then(|i| items.get(i).cloned()),
        _ => plain(v).and_then(|o| o.get(key).cloned()),
    };
    found.unwrap_or_else(js::undefined)
}

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> Result<Value, String> {
    if nullish(v) {
        let kind = if v.is_null() { "null" } else { "undefined" };
        return Err(format!("TypeError: Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(prop(v, key))
}

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

/// JS `Number(v)` for what these units pass (numbers, `undefined`, `null`, booleans, strings).
fn to_number(v: &Value) -> f64 {
    match (num(v), v) {
        (Some(n), _) => n,
        (_, Value::Null) => 0.0,
        (_, Value::Bool(b)) => f64::from(u8::from(*b)),
        (_, Value::String(s)) if s.trim().is_empty() => 0.0,
        (_, Value::String(s)) => s.trim().parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

// ---- the unit ----

const SOURCES: [&str; 10] = [
    "stop_button",
    "double_escape",
    "steered_send",
    "session_removal",
    "revert",
    "redo",
    "abort_guard",
    "provider_retry",
    "stall_watchdog",
    "status_row",
];

fn normalize(value: &Value) -> Value {
    let known = value.as_str().is_some_and(|s| SOURCES.contains(&s));
    if known { value.clone() } else { json!("unknown") }
}

/// Port of `normalizeAbortSourceOf` (`abort-sources-scenario.js:5`).
pub fn normalize_abort_source_of(value: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(normalize(&value))
}

fn session_key(v: &Value) -> String {
    text(v)
        .map(|t| t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string())
        .unwrap_or_default()
}

fn option(options: &Value, key: &str, default: f64) -> Value {
    let v = prop(options, key);
    if js::is_undefined(&v) { js::number(default) } else { v }
}

/// Port of `runAbortSourceRegistry` (`abort-sources-scenario.js:15`).
pub fn run_abort_source_registry(options: serde_json::Value, steps: serde_json::Value) -> Result<serde_json::Value, String> {
    let options = if nullish(&options) { Value::Object(Map::new()) } else { options };
    let (ttl, max) = (option(&options, "ttlMs", 60_000.0), option(&options, "maximumSessions", 5_000.0));
    let ttl = num(&ttl)
        .filter(|t| t.is_finite() && *t > 0.0)
        .ok_or("RangeError: ttlMs must be a positive number")?;
    let max = num(&max)
        .filter(|m| m.fract() == 0.0 && m.abs() <= 9_007_199_254_740_991.0 && *m >= 1.0)
        .ok_or("RangeError: maximumSessions must be a positive safe integer")?;
    let Value::Array(steps) = steps else {
        let what = if nullish(&steps) { get(&steps, "map")? } else { js::undefined() };
        let _ = what;
        return Err("TypeError: steps.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut map: Vec<(String, Value)> = Vec::new();
    let mut out = Vec::with_capacity(steps.len());
    for step in &steps {
        let at = get(step, "at")?;
        let arg = prop(step, "arg");
        let op = prop(step, "op");
        let find = |map: &Vec<(String, Value)>, key: &str| map.iter().position(|(k, _)| k == key);
        let result =
            match op.as_str() {
                Some("record") => {
                    let arg = if js::is_undefined(&arg) { Value::Object(Map::new()) } else { arg };
                    if arg.is_null() {
                        return Err("TypeError: Cannot destructure property 'sessionId' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.".into()); // recorded-literal: the V8 TypeError text
                    }
                    let key = session_key(&prop(&arg, "sessionId"));
                    if key.is_empty() {
                        Value::Null
                    } else {
                        if let Some(i) = find(&map, &key) {
                            map.remove(i);
                        }
                        let source = normalize(&prop(&arg, "source"));
                        if source == json!("unknown") {
                            Value::Null
                        } else {
                            let entry = json!({ "sessionId": key, "source": source, "recordedAt": at });
                            map.push((key, entry.clone()));
                            while map.len() as f64 > max {
                                map.remove(0);
                            }
                            entry
                        }
                    }
                }
                Some("withdraw") => {
                    let key = session_key(&if nullish(&arg) { js::undefined() } else { prop(&arg, "sessionId") });
                    match find(&map, &key) {
                        Some(i) if eq(&prop(&map[i].1, "recordedAt"), &get(&arg, "recordedAt")?) && eq(&prop(&map[i].1, "source"), &prop(&arg, "source")) => {
                            map.remove(i);
                            Value::Bool(true)
                        }
                        _ => Value::Bool(false),
                    }
                }
                Some("read") => match find(&map, &session_key(&arg)) {
                    None => Value::Null,
                    Some(i) if to_number(&at) - to_number(&prop(&map[i].1, "recordedAt")) > ttl => {
                        map.remove(i);
                        Value::Null
                    }
                    Some(i) => prop(&map[i].1, "source"),
                },
                Some("clear") => match find(&map, &session_key(&arg)) {
                    Some(i) => {
                        map.remove(i);
                        Value::Bool(true)
                    }
                    None => Value::Bool(false),
                },
                _ => js::number(map.len() as f64),
            };
        out.push(result);
    }
    Ok(Value::Array(out))
}
