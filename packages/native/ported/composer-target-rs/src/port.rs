//! The Rust port of `composer-target.ts`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

/// JS `String(value)`, as a template literal prints it.
fn text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(v) if js::is_undefined(v) => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => {
            let part = |v: &Value| if v.is_null() || js::is_undefined(v) { String::new() } else { text(Some(v)) };
            items.iter().map(part).collect::<Vec<_>>().join(",")
        }
        Some(v) => match (js::as_number(v), js::string_units(v)) {
            (Some(n), _) => js::number_to_string(n),
            (None, Some(units)) => String::from_utf16_lossy(&units),
            _ => "[object Object]".to_string(),
        },
    }
}

/// Port of `resolveComposerTarget` (`composer-target.ts:6`).
pub fn resolve_composer_target(session_id: Option<String>, draft_id: Option<String>) -> Result<Value, String> {
    Ok(match (session_id.filter(|s| !s.is_empty()), draft_id.filter(|s| !s.is_empty())) {
        (Some(id), _) => json!({ "kind": "session", "id": id }),
        (None, Some(id)) => json!({ "kind": "draft", "id": id }),
        _ => json!({ "kind": "none" }),
    })
}

/// Port of `getComposerTargetKey` (`composer-target.ts:16`).
pub fn get_composer_target_key(target: Value) -> Result<String, String> {
    if target.is_null() || js::is_undefined(&target) {
        let kind = if target.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading 'kind')"));
    }
    let kind = target.get("kind");
    if kind.and_then(Value::as_str) == Some("none") {
        return Ok("none".to_string());
    }
    Ok(format!("{}:{}", text(kind), text(target.get("id"))))
}

/// Port of `getSessionComposerTargetKey` (`composer-target.ts:21`).
pub fn get_session_composer_target_key(session_id: String) -> Result<String, String> {
    Ok(format!("session:{session_id}"))
}

/// Port of `getDraftComposerTargetKey` (`composer-target.ts:24`).
pub fn get_draft_composer_target_key(draft_id: String) -> Result<String, String> {
    Ok(format!("draft:{draft_id}"))
}

/// Port of `isPersistableComposerTargetKey` (`composer-target.ts:27`): `/^(?:session|draft):.+/`,
/// where `.` is any code unit but a line terminator.
pub fn is_persistable_composer_target_key(target_key: Option<String>) -> Result<bool, String> {
    let Some(key) = target_key else { return Ok(false) };
    let rest = key.strip_prefix("session:").or_else(|| key.strip_prefix("draft:"));
    Ok(rest
        .and_then(|r| r.chars().next())
        .is_some_and(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')))
}
