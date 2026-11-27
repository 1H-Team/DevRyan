//! The Rust port of `opencode/v2/projection/errors.js` (3 of 5). `v1ErrorNameForV2Type` and
//! `toV1Error` call the caller's optional `isContextOverflow` callback and stay in JS. A `Map`,
//! `Set` or `Date` is a record whose fields read `undefined`; spread copies keep JS key order.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

const MARKERS: [&str; 5] = ["$utf16", "$num", "$undefined", "$function", "$bigint"];

fn marker(value: &Value) -> Option<&str> {
    value
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.keys().next())
        .map(String::as_str)
        .filter(|k| k.starts_with('$'))
}

fn is_record(value: &Value) -> bool {
    value.is_object() && !marker(value).is_some_and(|m| MARKERS.contains(&m))
}

fn field(value: &Value, key: &str) -> Value {
    match value {
        Value::Object(o) if marker(value).is_none() => o.get(key).cloned().unwrap_or_else(js::undefined),
        _ => js::undefined(),
    }
}

fn non_empty_string(value: &Value) -> bool {
    js::string_units(value).is_some_and(|u| !u.is_empty())
}

fn is_http_status(value: &Value) -> bool {
    js::as_number(value).is_some_and(|n| n.fract() == 0.0 && (100.0..=599.0).contains(&n))
}

fn retry_after(value: &Value) -> Option<Value> {
    js::as_number(value).filter(|n| n.is_finite() && *n >= 0.0).map(js::number)
}

fn js_order(map: Map<String, Value>) -> Value {
    let index = |k: &str| k.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == k);
    let (mut indexed, rest): (Vec<_>, Vec<_>) = map.into_iter().partition(|(k, _)| index(k).is_some());
    indexed.sort_by_key(|(k, _)| index(k));
    Value::Object(indexed.into_iter().chain(rest).collect())
}

/// Port of `toV1InterruptError` (`errors.js:150`).
pub fn to_v1_interrupt_error(reason: Value, source: Value) -> Result<Value, String> {
    let data = if non_empty_string(&reason) {
        json!({ "message": "Aborted", "reason": reason, "v2Type": "aborted" })
    } else {
        json!({ "message": "Aborted", "v2Type": "aborted" })
    };
    with_abort_source(json!({ "name": "MessageAbortedError", "data": data }), source)
}

/// Port of `withAbortSource` (`errors.js:167`).
pub fn with_abort_source(error: Value, source: Value) -> Result<Value, String> {
    let data = field(&error, "data");
    let copy = non_empty_string(&source) && is_record(&error) && field(&error, "name").as_str() == Some("MessageAbortedError") && is_record(&data);
    let (Some(outer), Some(inner), true) = (error.as_object(), data.as_object(), copy) else {
        return Ok(js::as_number(&error).map_or(error, js::number));
    };
    let mut inner = match marker(&data) {
        None => inner.clone(),
        Some(_) => inner
            .get("$bytes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, b)| (i.to_string(), b.clone()))
            .collect(),
    };
    inner.insert("source".into(), source);
    let mut outer = outer.clone();
    outer.insert("data".into(), js_order(inner));
    Ok(js_order(outer))
}

/// Port of `toV2Error` (`errors.js:180`).
pub fn to_v2_error(error: Value) -> Result<Value, String> {
    if !is_record(&error) {
        return Ok(js::undefined());
    }
    let name = Some(field(&error, "name"))
        .filter(|n| js::string_units(n).is_some())
        .unwrap_or_else(|| "UnknownError".into());
    let data = Some(field(&error, "data")).filter(is_record).unwrap_or_else(|| json!({}));
    let by_name = match name.as_str() {
        Some("ProviderAuthError") => "provider.auth",
        Some("ContentFilterError") => "provider.content-filter",
        Some("ContextOverflowError") => "provider.invalid-request",
        Some("StructuredOutputError" | "MessageOutputLengthError") => "provider.invalid-output",
        Some("MessageAbortedError") => "aborted",
        Some("APIError") => "provider.error",
        _ => "unknown",
    };
    let v2_type = field(&data, "v2Type");
    let r#type = if non_empty_string(&v2_type) { v2_type } else { by_name.into() };
    let message = field(&data, "message");
    let message = match (js::string_units(&message), name.as_str()) {
        (Some(_), _) => message,
        (None, Some("MessageOutputLengthError")) => "The model exceeded its output limit".into(),
        _ => name,
    };
    let mut result = Map::from_iter([("type".into(), r#type), ("message".into(), message)]);
    let status = field(&data, "statusCode");
    if is_http_status(&status) {
        result.insert("status".into(), js::as_number(&status).map_or(status, js::number));
    }
    if let Some(after) = retry_after(&field(&data, "retryAfterMs")) {
        result.insert("retryAfterMs".into(), after);
    }
    Ok(Value::Object(result))
}
