//! The Rust port of `opencode/runtime-host/native-provider-integrations.js`. Lengths are UTF-16
//! units; `Object.keys` of a `Map` is empty.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn is_object(value: &Value) -> bool {
    value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn id_like(text: &str, extra: &[u8], max: usize) -> bool {
    !text.is_empty() && text.len() <= max && text.bytes().all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}

/// Port of `isCatalogProviderIntegration` (`opencode/runtime-host/native-provider-integrations.js:5`).
pub fn is_catalog_provider_integration(value: Value) -> Result<Value, String> {
    let Some(text) = value.as_str() else { return Ok(Value::Bool(false)) };
    let mcp = text
        .strip_prefix("mcp_")
        .is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    Ok(Value::Bool(
        id_like(text, b"_-", 256) && !["openai", "cursor-acp", "claude-agent", "anthropic"].contains(&text) && !mcp,
    ))
}

/// Port of `isProviderFormAnswer` (`opencode/runtime-host/native-provider-integrations.js:8`).
pub fn is_provider_form_answer(value: Value) -> Result<Value, String> {
    if !is_object(&value) {
        return Ok(Value::Bool(false));
    }
    let entries: Vec<(&String, &Value)> = plain(&value).map(|o| o.iter().collect()).unwrap_or_default();
    let ok = (1..=16).contains(&entries.len())
        && entries.iter().all(|(k, item)| {
            id_like(k, b"_.-", 64) && (item.is_boolean() || js::string_units(item).is_some_and(|u| !u.is_empty() && u.len() <= 2048 && !u.contains(&0)))
        });
    Ok(Value::Bool(ok))
}
