//! The Rust port of `opencode/model-default-thinking.js`. "The same reference back" is the
//! same printed value.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

/// `typeof value === 'object' && value !== null` (arrays and `Map`s included).
fn typeof_object(value: &Value) -> bool {
    (value.is_object() || value.is_array()) && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

/// `record`: an object that is not an array.
fn record(value: &Value) -> bool {
    value.is_object() && typeof_object(value)
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

fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `level(value)`.
fn level(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|s| s.trim_matches(js_space))
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
}

const OPENAI_LIKE: [&str; 5] = [
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/azure",
    "@ai-sdk/github-copilot",
    "@ai-sdk/amazon-bedrock/mantle",
];
const ANTHROPIC_LIKE: [&str; 2] = ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"];
const GOOGLE_LIKE: [&str; 2] = ["@ai-sdk/google", "@ai-sdk/google-vertex"];
const ROUTER_LIKE: [&str; 2] = ["@openrouter/ai-sdk-provider", "@llmgateway/ai-sdk-provider"];

/// `apiId.match(/gpt-(\d+)\.(\d+)/)`: the two numbers of the first match.
fn gpt_version(api_id: &str) -> Option<(f64, f64)> {
    let b = api_id.as_bytes();
    let mut at = 0;
    while let Some(found) = api_id[at..].find("gpt-") {
        let start = at + found + 4;
        let major_end = start + b[start..].iter().take_while(|c| c.is_ascii_digit()).count();
        if major_end > start && b.get(major_end) == Some(&b'.') {
            let minor_end = major_end + 1 + b[major_end + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
            if minor_end > major_end + 1 {
                return Some((api_id[start..major_end].parse().ok()?, api_id[major_end + 1..minor_end].parse().ok()?));
            }
        }
        at = at + found + 1;
    }
    None
}

fn resolve(provider: &Value, model: &Value) -> Value {
    if !record(model) {
        return js::undefined();
    }
    let variants = field(model, "variants");
    let keys: Vec<String> = if record(&variants) {
        entries(&variants).into_iter().map(|(k, _)| k).collect()
    } else {
        Vec::new()
    };
    let supported = |value: &Value| match level(value) {
        Some(n) if keys.iter().any(|k| level(&Value::String(k.clone())).as_deref() == Some(n.as_str())) => Value::String(n),
        _ => js::undefined(),
    };
    let explicit = field(model, "defaultThinkingLevel");
    if !js::is_undefined(&explicit) {
        return supported(&explicit);
    }
    let options = field(model, "options");
    let options = if record(&options) { options } else { Value::Object(Map::new()) };
    let api = field(model, "api");
    let npm = opt(&api, "npm");
    let api_id = opt(&api, "id").as_str().unwrap_or("").to_string();
    let npm_is = |list: &[&str]| npm.as_str().is_some_and(|n| list.contains(&n));
    let configured = if npm_is(&OPENAI_LIKE) {
        field(&options, "reasoningEffort")
    } else if npm_is(&ANTHROPIC_LIKE) {
        field(&options, "effort")
    } else if npm_is(&GOOGLE_LIKE) {
        opt(&field(&options, "thinkingConfig"), "thinkingLevel")
    } else if npm_is(&ROUTER_LIKE) {
        opt(&field(&options, "reasoning"), "effort")
    } else {
        js::undefined()
    };
    if !js::is_undefined(&configured) {
        return supported(&configured);
    }
    if npm.as_str() == Some("@ai-sdk/azure") && truthy(&opt(&opt(provider, "options"), "useCompletionUrls")) {
        let (major, minor) = gpt_version(&api_id).unwrap_or((f64::NAN, f64::NAN));
        if major > 5.0 || (major == 5.0 && minor >= 5.0) {
            return js::undefined();
        }
        return supported(&Value::String("medium".into()));
    }
    if npm_is(&OPENAI_LIKE) && api_id.contains("gpt-5") && !api_id.contains("gpt-5-chat") && !api_id.contains("gpt-5-pro") {
        return supported(&Value::String("medium".into()));
    }
    let google_or_router = npm_is(&GOOGLE_LIKE) || npm_is(&ROUTER_LIKE);
    if google_or_router && truthy(&opt(&field(model, "capabilities"), "reasoning")) && api_id.contains("gemini-3") {
        return supported(&Value::String("high".into()));
    }
    js::undefined()
}

/// Port of `resolveModelDefaultThinking` (`opencode/model-default-thinking.js:7`).
pub fn resolve_model_default_thinking(provider: Value, model: Value) -> Result<Value, String> {
    Ok(resolve(&provider, &model))
}

/// Port of `annotateModelDefaultThinking` (`opencode/model-default-thinking.js:49`).
pub fn annotate_model_default_thinking(payload: Value) -> Result<Value, String> {
    let Value::Array(providers) = opt(&payload, "providers") else {
        return Ok(payload);
    };
    let mut changed = false;
    let next: Vec<Value> = providers
        .iter()
        .map(|provider| {
            let models = opt(provider, "models");
            if !record(&models) {
                return provider.clone();
            }
            let mut provider_changed = false;
            let rebuilt: Map<String, Value> = entries(&models)
                .into_iter()
                .map(|(id, model)| {
                    let level = resolve(provider, &model);
                    if !truthy(&level) || field(&model, "defaultThinkingLevel") == level {
                        return (id, model);
                    }
                    provider_changed = true;
                    let mut copy = spread(&model);
                    copy.insert("defaultThinkingLevel".into(), level);
                    (id, Value::Object(copy))
                })
                .collect();
            if !provider_changed {
                return provider.clone();
            }
            changed = true;
            let mut copy = spread(provider);
            copy.insert("models".into(), Value::Object(rebuilt));
            Value::Object(copy)
        })
        .collect();
    if !changed {
        return Ok(payload);
    }
    let mut copy = spread(&payload);
    copy.insert("providers".into(), Value::Array(next));
    Ok(Value::Object(copy))
}
