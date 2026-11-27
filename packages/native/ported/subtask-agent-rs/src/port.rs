//! The Rust port of `subtask-agent.ts`. `resolveLatestUserChoiceFromMessages` (takes a callback)
//! and `createLatestUserChoiceSelector` (returns a closure over its own state) stay in TypeScript.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// `value[key]`, failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if value.is_null() || js::is_undefined(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

/// JS `String.prototype.trim` (strips U+FEFF, keeps U+0085).
fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// Port of `resolveUserMessageVariant` (`subtask-agent.ts:37`).
pub fn resolve_user_message_variant(message: Value) -> Result<Value, String> {
    let model = get(&message, "model")?.filter(|m| !m.is_null());
    let variant = match model.and_then(|m| m.get("variant")).filter(|v| !js::is_undefined(v)) {
        Some(variant) => Some(variant),
        None => get(&message, "variant")?,
    };
    Ok(match variant {
        Some(Value::Null) => Value::Null,
        Some(Value::String(text)) if text.is_empty() => Value::Null,
        Some(Value::String(text)) if !trim(text).is_empty() => Value::String(text.clone()),
        Some(v) if js::string_units(v).is_some_and(|u| !u.is_empty()) => v.clone(),
        _ => js::undefined(),
    })
}

/// Port of `resolveSubtaskAgentFromMessages` (`subtask-agent.ts:45`).
pub fn resolve_subtask_agent_from_messages(messages: Value) -> Result<Option<String>, String> {
    let items = match messages {
        Value::Array(items) => items,
        Value::String(_) => return Ok(None),
        _ => return Err("messages is not iterable".to_string()),
    };
    for message in &items {
        if get(message, "role")?.and_then(Value::as_str) != Some("user") {
            continue;
        }
        for key in ["agent", "mode"] {
            let name = message.get(key).and_then(Value::as_str).map(trim).unwrap_or_default();
            if !name.is_empty() {
                return Ok(Some(name.to_string()));
            }
        }
    }
    Ok(None)
}
