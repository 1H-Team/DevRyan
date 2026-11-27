//! The Rust port of `lib/provider-error-details.js` of `@devryan/shared-runtime`. `JSON.parse` is
//! serde_json's, after two rewrites that keep JS's tolerances where serde refuses: a surrogate
//! escape (`\\ud800`) becomes `\\ufffd` and a number beyond f64 becomes `0`; neither can make a
//! string equal a known code, and no number is read. serde runs on a thread with a 64 MiB stack,
//! as V8's reader has no nesting limit.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

#[rustfmt::skip]
const CODES: [&str; 22] = ["subscription_sharing_user_not_eligible", "subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable", "subscription_sharing_unsupported_capability", "subscription_sharing_route_not_supported", "subscription_sharing_invalid_user", "subscription_sharing_user_unavailable", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context", "invalid_api_key", "invalid_authentication", "authentication_error", "insufficient_quota", "quota_exceeded", "usage_limit_exceeded", "rate_limit_exceeded", "too_many_requests", "unsupported_parameter", "unsupported_value", "unsupported_capability", "model_not_found", "invalid_request_error"];
#[rustfmt::skip]
const PARAMS: [&str; 16] = ["tools", "tools.type", "tool_choice", "parallel_tool_calls", "reasoning.effort", "reasoning.summary", "temperature", "top_p", "max_output_tokens", "stream", "model", "input", "store", "text.verbosity", "include", "service_tier"];
#[rustfmt::skip]
const TYPES: [&str; 17] = ["provider.auth", "provider.error", "provider.rate-limit", "provider.quota", "provider.transport", "provider.internal", "provider.invalid-output", "provider.invalid-request", "provider.unsupported-operation", "provider.no-route", "provider.unknown", "provider.timeout", "provider.content-filter", "aborted", "permission.rejected", "tool.execution", "unknown"];

fn member(value: &Value, set: &[&str]) -> bool {
    value.as_str().is_some_and(|t| set.contains(&t))
}

/// The JSON text with surrogate escapes replaced and numbers beyond f64 written as `0`.
fn tolerant(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let (mut out, mut i, mut in_string) = (String::with_capacity(text.len()), 0, false);
    while i < chars.len() {
        let c = chars[i];
        if in_string && c == '\\' && chars.get(i + 1) == Some(&'u') {
            let hex: String = chars.iter().skip(i + 2).take(4).collect();
            let surrogate = hex.len() == 4 && u16::from_str_radix(&hex, 16).is_ok_and(|v| (0xd800..=0xdfff).contains(&v)) && !hex.starts_with('+');
            out.push_str(if surrogate { "\\ufffd" } else { "\\u" });
            out.push_str(if surrogate { "" } else { &hex });
            i += 2 + hex.chars().count();
        } else if in_string && c == '\\' {
            out.extend(chars.get(i..i + 2).unwrap_or(&chars[i..]));
            i += 2;
        } else if c == '"' {
            in_string = !in_string;
            out.push(c);
            i += 1;
        } else if !in_string && (c == '-' || c.is_ascii_digit()) {
            let run: String = chars[i..]
                .iter()
                .take_while(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
                .collect();
            i += run.len();
            out.push_str(if run.parse::<f64>().is_ok_and(f64::is_infinite) { "0" } else { &run });
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn parse(text: String) -> Option<Value> {
    let read = move || {
        let text = tolerant(&text);
        let mut reader = serde_json::Deserializer::from_str(&text);
        reader.disable_recursion_limit();
        let value = <Value as serde::Deserialize>::deserialize(&mut reader).ok()?;
        reader.end().ok().map(|()| value)
    };
    std::thread::Builder::new().stack_size(64 << 20).spawn(read).ok()?.join().ok().flatten()
}

/// Port of `isSafeProviderCode` (`provider-error-details.js:28`).
pub fn is_safe_provider_code(value: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(Value::Bool(member(&value, &CODES)))
}

/// Port of `isSafeProviderParam` (`provider-error-details.js:29`).
pub fn is_safe_provider_param(value: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(Value::Bool(member(&value, &PARAMS)))
}

/// Port of `isSafeErrorType` (`provider-error-details.js:30`).
pub fn is_safe_error_type(value: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(Value::Bool(member(&value, &TYPES)))
}

/// Port of `providerErrorDetails` (`provider-error-details.js:33`).
pub fn provider_error_details(body: serde_json::Value) -> Result<serde_json::Value, String> {
    let empty = || Value::Object(Map::new());
    let Some(units) = js::string_units(&body) else { return Ok(empty()) };
    if units.len() > 65536 {
        return Ok(empty());
    }
    let Some(event) = parse(String::from_utf16_lossy(&units)) else {
        return Ok(empty());
    };
    let Some(event) = event.as_object() else { return Ok(empty()) };
    let none = Map::new();
    let nested = match event.get("error").and_then(Value::as_object) {
        Some(error) => error,
        None => event
            .get("response")
            .and_then(Value::as_object)
            .and_then(|r| r.get("error"))
            .and_then(Value::as_object)
            .unwrap_or(&none),
    };
    let pick = |key: &str| {
        event
            .get(key)
            .filter(|v| !v.is_null())
            .or_else(|| nested.get(key))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let (code, param) = (pick("code"), pick("param"));
    let mut out = Map::new();
    if member(&code, &CODES) {
        out.insert("providerCode".into(), code);
    }
    if member(&param, &PARAMS) {
        out.insert("providerParam".into(), param);
    }
    Ok(Value::Object(out))
}
