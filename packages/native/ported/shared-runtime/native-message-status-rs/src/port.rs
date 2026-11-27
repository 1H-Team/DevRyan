//! The Rust port of `lib/native-message-status.js` of `@devryan/shared-runtime`.

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

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`, as `isRecord` reads it.
fn record(v: &Value) -> bool {
    plain(v).is_some() || marked(v, "$set")
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

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

// ---- the unit ----

/// `v?.a?.b?...`.
fn at(v: &Value, path: &[&str]) -> Value {
    path.iter()
        .fold(v.clone(), |acc, key| if nullish(&acc) { js::undefined() } else { prop(&acc, key) })
}

fn is(v: &Value, s: &str) -> bool {
    eq(v, &json!(s))
}

fn status_message(v: &Value) -> bool {
    record(v)
        && is(&prop(v, "type"), "synthetic")
        && eq(&at(v, &["metadata", "devryan", "v"]), &json!(1))
        && is(&at(v, &["metadata", "devryan", "origin"]), "interview")
        && at(v, &["metadata", "devryan", "statusOnly"]) == Value::Bool(true)
}

/// Port of `isNativeStatusMessage` (`native-message-status.js:5`).
pub fn is_native_status_message(value: Value) -> Result<Value, String> {
    Ok(Value::Bool(status_message(&value)))
}

/// Port of `isNativeTurnParent` (`native-message-status.js:10`).
pub fn is_native_turn_parent(value: Value) -> Result<Value, String> {
    let kind = prop(&value, "type");
    Ok(Value::Bool(
        record(&value) && (is(&kind, "user") || is(&kind, "compaction") || (is(&kind, "synthetic") && !status_message(&value))),
    ))
}

/// Port of `isNativeStatusRecord` (`native-message-status.js:14`).
pub fn is_native_status_record(value: Value) -> Result<Value, String> {
    let ok = record(&value)
        && is(&at(&value, &["info", "role"]), "user")
        && is(&at(&value, &["nativeStatus", "source"]), "native-sequence")
        && is(&at(&value, &["nativeStatus", "kind"]), "status-only");
    Ok(Value::Bool(ok))
}
