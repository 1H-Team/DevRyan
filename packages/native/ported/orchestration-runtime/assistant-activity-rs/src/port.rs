//! The Rust port of `assistant-activity.js` of `@devryan/orchestration-runtime`:
//! `isManagedAssistantActivityPart` (the registry factory returns closures and calls subscriber
//! callbacks, so it stays in JS).

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

// ---- JS values over JSON ----

fn text(v: &Value) -> Option<String> {
    js::string_units(v).map(|u| String::from_utf16_lossy(&u))
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    let index = || key.parse::<usize>().ok().filter(|i| i.to_string() == key);
    let found = match (v, js::string_units(v)) {
        (_, Some(u)) if key == "length" => Some(js::number(u.len() as f64)),
        (_, Some(u)) => index().and_then(|i| u.get(i)).map(|c| js::utf16_string(&[*c])),
        (Value::Array(items), _) if key == "length" => Some(js::number(items.len() as f64)),
        (Value::Array(items), _) => index().and_then(|i| items.get(i).cloned()),
        _ => plain(v).and_then(|o| o.get(key).cloned()),
    };
    found.unwrap_or_else(js::undefined)
}

/// `typeof v === "string" && v.trim() ? v.trim() : ""` (JS white space).
fn trimmed(v: &Value) -> String {
    text(v)
        .map(|t| t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string())
        .unwrap_or_default()
}

// ---- the unit ----

/// Port of `isManagedAssistantActivityPart` (`assistant-activity.js:2`).
pub fn is_managed_assistant_activity_part(part: serde_json::Value) -> Result<serde_json::Value, String> {
    let field = |k: &str| if nullish(&part) { js::undefined() } else { prop(&part, k) };
    let kind = field("type");
    let is = |t: &str| kind.as_str() == Some(t);
    let text_ok = (is("text") || is("reasoning")) && !trimmed(&field("text")).is_empty();
    let tool_ok = is("tool") && js::string_units(&field("callID")).is_some_and(|u| !u.is_empty());
    Ok(Value::Bool(text_ok || tool_ok))
}
