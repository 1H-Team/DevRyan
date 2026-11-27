//! The Rust port of `opencode/openai-model-availability.js`: `annotateOpenAIModelAvailability`
//! (the async credential read stays in JavaScript). Spreads keep JS key order; a string model
//! spreads its indexes.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

/// `typeof value === 'object' && value !== null` (arrays and `Map`s included).
fn typeof_object(value: &Value) -> bool {
    (value.is_object() || value.is_array()) && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn opt(value: &Value, key: &str) -> Value {
    if value.is_null() || js::is_undefined(value) {
        js::undefined()
    } else {
        field(value, key)
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// `Object.entries(value)` of an object, a string or an array (JSON key order is JS order).
fn entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        _ if js::string_units(value).is_some() => js::string_units(value)
            .unwrap_or_default()
            .iter()
            .enumerate()
            .map(|(i, u)| (i.to_string(), js::utf16_string(&[*u])))
            .collect(),
        _ => plain(value)
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default(),
    }
}

/// `{ ...value }`.
fn spread(value: &Value) -> Map<String, Value> {
    entries(value).into_iter().collect()
}

/// Port of `annotateOpenAIModelAvailability` (`opencode/openai-model-availability.js:24`).
pub fn annotate_open_ai_model_availability(payload: Value, auth_entry: Value, options: Value) -> Result<Value, String> {
    if !truthy(&payload) || !typeof_object(&payload) {
        return Ok(payload);
    }
    let Value::Array(providers) = field(&payload, "providers") else {
        return Ok(payload);
    };
    let auth_type = match opt(&auth_entry, "type").as_str() {
        Some("api" | "key") => Some("api"),
        Some("oauth") => Some("oauth"),
        _ => None,
    };
    if auth_type.is_none() {
        if options.is_null() {
            return Err("Cannot read properties of null (reading 'unavailable')".into()); // recorded-literal: V8 TypeError text
        }
        if !truthy(&opt(&options, "unavailable")) {
            return Ok(payload);
        }
    }
    let auth_value = auth_type.map_or_else(js::undefined, |a| Value::String(a.into()));
    let method = opt(&auth_entry, "methodID");
    let next: Vec<Value> = providers
        .iter()
        .map(|provider| {
            if opt(provider, "id").as_str() != Some("openai") {
                return provider.clone();
            }
            let mut copy = spread(provider);
            copy.insert("authType".into(), auth_value.clone());
            if auth_type == Some("api") || matches!(method.as_str(), Some("chatgpt-token-sharing" | "chatgpt-browser")) {
                return Value::Object(copy);
            }
            let models = field(provider, "models");
            let models = if truthy(&models) && typeof_object(&models) {
                models
            } else {
                Value::Object(Map::new())
            };
            let reason = if auth_type.is_some() {
                "reauthorization_required"
            } else {
                "account_models_unavailable"
            };
            let marked: Map<String, Value> = entries(&models)
                .into_iter()
                .map(|(id, model)| {
                    let mut m = spread(&model);
                    m.insert("available".into(), Value::Bool(false));
                    m.insert("unavailableReason".into(), Value::String(reason.into()));
                    (id, Value::Object(m))
                })
                .collect();
            copy.insert("accountModelsStatus".into(), Value::String("unavailable".into()));
            copy.insert("models".into(), Value::Object(marked));
            Value::Object(copy)
        })
        .collect();
    let mut out = spread(&payload);
    out.insert("providers".into(), Value::Array(next));
    Ok(Value::Object(out))
}
