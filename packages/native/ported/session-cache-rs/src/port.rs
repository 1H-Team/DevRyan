//! The Rust port of `getProtectedSessionCacheIds` (`session-cache.ts`). `dropSessionCaches` and
//! `pickSessionCacheEvictions` stay in TypeScript: they mutate their arguments, which a port fed a
//! copy cannot do and recording does not capture. The result `Set` crosses as `{"$set": [...]}`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// `Object.entries(value ?? {})`.
fn entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Array(items)) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Some(Value::String(text)) => text.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), js::utf16_string(&[u]))).collect(),
        Some(v @ Value::Object(map)) if js::string_units(v).is_none() && js::as_number(v).is_none() && !js::is_undefined(v) => {
            map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        }
        _ => Vec::new(),
    }
}

fn length(value: &Value) -> Option<f64> {
    match value {
        Value::Array(items) => Some(items.len() as f64),
        Value::String(text) => Some(text.encode_utf16().count() as f64),
        v if nullish(v) => None,
        v => v.get("length").filter(|l| l.is_number() || l.get("$num").is_some()).and_then(js::as_number),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(value) && js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// Port of `getProtectedSessionCacheIds` (`session-cache.ts:21`).
pub fn get_protected_session_cache_ids(store: Value) -> Result<Value, String> {
    if nullish(&store) {
        let kind = if store.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading 'session_status')"));
    }
    let table = |key: &str| store.get(key).filter(|v| !nullish(v));
    let mut ids: Vec<String> = Vec::new();
    let mut add = |id: String| {
        if !ids.contains(&id) {
            ids.push(id);
        }
    };
    for (id, status) in entries(table("session_status")) {
        if truthy(&status) && status.get("type").and_then(Value::as_str) != Some("idle") {
            add(id);
        }
    }
    for key in ["permission", "question"] {
        for (id, list) in entries(table(key)) {
            if length(&list).unwrap_or(0.0) > 0.0 {
                add(id);
            }
        }
    }
    for (id, messages) in entries(table("message")) {
        let last = match &messages {
            Value::Array(items) => items.last().cloned(),
            Value::String(text) => text.encode_utf16().last().map(|u| js::utf16_string(&[u])),
            v if nullish(v) => None,
            v => v.get(js::number_to_string(length(v).unwrap_or(f64::NAN) - 1.0)).cloned(),
        };
        let last = last.filter(|m| !nullish(m));
        let assistant = last.as_ref().and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant");
        let completed = last
            .as_ref()
            .and_then(|m| m.get("time"))
            .filter(|t| !nullish(t))
            .and_then(|t| t.get("completed"));
        if assistant && !completed.is_some_and(|c| c.is_number() || c.get("$num").is_some()) {
            add(id);
        }
    }
    Ok(json!({ "$set": ids }))
}
