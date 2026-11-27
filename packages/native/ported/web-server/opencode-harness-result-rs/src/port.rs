//! The Rust port of `opencode/harness-result.js` (all 5). Text is trimmed with JS white space;
//! a `Map`, `Set` or `Date` payload is a plain object to `isPlainObject` and spreads nothing.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

fn marker(v: &Value) -> Option<&str> {
    v.as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.keys().next())
        .map(String::as_str)
        .filter(|k| k.starts_with('$'))
}

fn plain_object(v: &Value) -> bool {
    v.is_object() && !matches!(marker(v), Some("$utf16" | "$num" | "$undefined" | "$bigint" | "$function"))
}

fn own(v: &Value) -> Map<String, Value> {
    match (v, marker(v)) {
        (Value::Object(o), None) => o.clone(),
        (Value::Object(o), Some("$bytes")) => o["$bytes"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, b)| (i.to_string(), b.clone()))
            .collect(),
        _ => Map::new(),
    }
}

fn field(v: &Value, key: &str) -> Value {
    own(v).get(key).cloned().unwrap_or_else(js::undefined)
}

fn read(options: &Value, key: &str) -> Result<Value, String> {
    if options.is_null() {
        return Err(format!("Cannot read properties of null (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(options, key))
}

fn text(v: &Value, fallback: &str) -> Value {
    let space = |c: &u16| matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
    let Some(u) = js::string_units(v) else { return fallback.into() };
    let start = u.iter().position(|c| !space(c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !space(c)).map_or(start, |i| i + 1);
    if start == end { fallback.into() } else { js::utf16_string(&u[start..end]) }
}

fn list(v: &Value) -> Value {
    v.as_array().map_or_else(
        || json!([]),
        |items| items.iter().filter(|e| !e.is_null() && !js::is_undefined(e)).cloned().collect(),
    )
}

fn result(status: &Value, options: &Value) -> Result<Value, String> {
    let status = if matches!(status.as_str(), Some("success" | "warning" | "error")) {
        status.clone()
    } else {
        "error".into()
    };
    let (summary, next, artifacts, recovery) = (
        read(options, "summary")?,
        read(options, "nextActions")?,
        read(options, "artifacts")?,
        read(options, "recovery")?,
    );
    let recovery = if plain_object(&recovery) {
        json!({
            "rootCauseHint": text(&field(&recovery, "rootCauseHint"), "No root cause hint was provided"),
            "safeRetry": text(&field(&recovery, "safeRetry"), "Retry the operation after checking the reported condition"),
            "stopCondition": text(&field(&recovery, "stopCondition"), "Stop retrying if the same condition persists"),
            "retryable": field(&recovery, "retryable") != Value::Bool(false),
        })
    } else {
        Value::Null
    };
    Ok(
        json!({ "status": status, "summary": text(&summary, "Operation completed"), "nextActions": list(&next), "artifacts": list(&artifacts), "recovery": recovery }),
    )
}

/// Port of `createHarnessResult` (`harness-result.js:29`).
pub fn create_harness_result(status: Value, options: Value) -> Result<Value, String> {
    result(&status, &options)
}

/// Port of `createHarnessSuccess` (`harness-result.js:39`).
pub fn create_harness_success(options: Value) -> Result<Value, String> {
    result(&"success".into(), &options)
}

/// Port of `createHarnessWarning` (`harness-result.js:43`).
pub fn create_harness_warning(options: Value) -> Result<Value, String> {
    result(&"warning".into(), &options)
}

/// Port of `createHarnessError` (`harness-result.js:47`).
pub fn create_harness_error(options: Value) -> Result<Value, String> {
    result(&"error".into(), &options)
}

fn index_key(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

/// Port of `withHarnessResult` (`harness-result.js:55`).
pub fn with_harness_result(payload: Value, harness_input: Value) -> Result<Value, String> {
    let harness = if plain_object(&harness_input) {
        result(&field(&harness_input, "status"), &harness_input)?
    } else {
        result(&"error".into(), &json!({ "summary": "Harness metadata was unavailable" }))?
    };
    let mut out = if plain_object(&payload) {
        own(&payload)
    } else {
        Map::from_iter([("data".into(), js::as_number(&payload).map_or(payload, js::number))])
    };
    for key in ["status", "summary", "nextActions", "artifacts", "recovery"] {
        if !out.contains_key(key) {
            out.insert(key.into(), harness[key].clone());
        }
    }
    out.insert("harness".into(), harness);
    let (mut indexed, rest): (Vec<_>, Vec<_>) = out.into_iter().partition(|(k, _)| index_key(k).is_some());
    indexed.sort_by_key(|(k, _)| index_key(k));
    Ok(Value::Object(indexed.into_iter().chain(rest).collect()))
}
