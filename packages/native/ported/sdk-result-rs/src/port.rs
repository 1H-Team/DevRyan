//! The Rust port of `sdk-result.ts`, with `getSdkErrorMessage` of `@/lib/opencode/sdk-error`
//! inlined. The thrown `Error` crosses as its message; its `status` property does not cross.
//! No `Error` instance or shared reference crosses JSON, so the `instanceof Error` branch and the
//! `seen` cycle guard never apply.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn falsy(v: &Value) -> bool {
    matches!(v, Value::Null | Value::Bool(false))
        || js::is_undefined(v)
        || js::string_units(v).is_some_and(|u| u.is_empty())
        || js::as_number(v).is_some_and(|n| n == 0.0 || n.is_nan())
}

/// `typeof v === "object"` for a value that is not `null`.
fn object(v: &Value) -> bool {
    v.is_array() || (v.is_object() && js::string_units(v).is_none() && js::as_number(v).is_none() && !js::is_undefined(v))
}

fn field(v: &Value, key: &str) -> Value {
    v.as_object()
        .filter(|_| object(v))
        .and_then(|o| o.get(key))
        .cloned()
        .unwrap_or_else(js::undefined)
}

/// `String(v)`.
fn text(v: &Value) -> String {
    if let Some(n) = js::as_number(v) {
        return js::number_to_string(n);
    }
    if let Some(u) = js::string_units(v) {
        return String::from_utf16_lossy(&u);
    }
    match v {
        Value::Array(items) => items
            .iter()
            .map(|i| if i.is_null() || js::is_undefined(i) { String::new() } else { text(i) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(o) if o.contains_key("$set") => "[object Set]".into(),
        Value::Object(_) if js::is_undefined(v) => "undefined".into(),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

fn quote(u: &[u16]) -> String {
    let body: String = char::decode_utf16(u.iter().copied())
        .map(|c| match c {
            Ok(c) => serde_json::to_string(&c.to_string()).map(|s| s[1..s.len() - 1].to_string()).unwrap_or_default(),
            Err(e) => format!("\\u{:04x}", e.unpaired_surrogate()),
        })
        .collect();
    format!("\"{body}\"")
}

/// `JSON.stringify(v)`.
fn json(v: &Value) -> Option<String> {
    if js::is_undefined(v) {
        return None;
    }
    if let Some(n) = js::as_number(v) {
        return Some(if n.is_finite() { js::number_to_string(n) } else { "null".into() });
    }
    if let Some(u) = js::string_units(v) {
        return Some(quote(&u));
    }
    Some(match v {
        Value::Array(a) => format!("[{}]", a.iter().map(|x| json(x).unwrap_or_else(|| "null".into())).collect::<Vec<_>>().join(",")),
        Value::Object(o) if o.len() == 1 && o.contains_key("$set") => "{}".into(),
        Value::Object(o) => {
            let members = o
                .iter()
                .filter_map(|(k, x)| json(x).map(|j| format!("{}:{j}", quote(&k.encode_utf16().collect::<Vec<_>>()))));
            format!("{{{}}}", members.collect::<Vec<_>>().join(","))
        }
        other => other.to_string(),
    })
}

fn present(v: &Value) -> Option<String> {
    js::string_units(v)
        .map(|u| String::from_utf16_lossy(&u))
        .filter(|t| !t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').is_empty())
}

/// `readSdkErrorMessage(error, seen)`.
fn read_message(error: &Value) -> String {
    if falsy(error) || !object(error) {
        return text(error);
    }
    let nested = field(error, "error");
    if let Some(message) = present(&field(error, "message")).or_else(|| present(&nested)) {
        return message;
    }
    if !falsy(&nested) && object(&nested) {
        let message = read_message(&nested);
        if message != "Unknown error" {
            return message;
        }
    }
    json(error).filter(|s| !s.is_empty()).unwrap_or_else(|| "Unknown error".into())
}

/// Port of `unwrapSdkResult` (`sdk-result.ts:3`).
pub fn unwrap_sdk_result(result: serde_json::Value, name: String) -> Result<serde_json::Value, String> {
    if result.is_null() || js::is_undefined(&result) {
        let kind = if result.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading 'error')"));
    }
    let error = field(&result, "error");
    if !falsy(&error) {
        let status = field(&field(&result, "response"), "status");
        let status = if js::is_undefined(&status) {
            String::new()
        } else {
            format!(" ({})", text(&status))
        };
        return Err(format!("{name} failed{status}: {}", read_message(&error)));
    }
    let data = field(&result, "data");
    if js::is_undefined(&data) {
        return Err(format!("{name} returned no data"));
    }
    Ok(data)
}
