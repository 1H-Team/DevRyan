//! The Rust port of `security/forwarded-request.js`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// Port of `hasForwardingHeaders` (`security/forwarded-request.js:5`): any `forwarded`,
/// `x-forwarded-*` or `cf-*` header name, case-insensitively (`Object.keys`: a string's or an
/// array's index keys never match).
pub fn has_forwarding_headers(req: Value) -> Result<Value, String> {
    let headers = req.as_object().and_then(|o| o.get("headers")).filter(|h| truthy(h));
    let names: Vec<String> = match headers {
        Some(Value::Object(o)) if !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))) => o.keys().cloned().collect(),
        _ => Vec::new(),
    };
    Ok(Value::Bool(names.iter().any(|name| {
        let header = name.to_lowercase();
        header == "forwarded" || header.starts_with("x-forwarded-") || header.starts_with("cf-")
    })))
}
