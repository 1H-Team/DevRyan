//! The Rust port of `subtaskParentMaterialization.ts`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// `value[key]`, failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

fn opt<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.filter(|v| !nullish(v)).and_then(|v| v.get(key)).filter(|v| !js::is_undefined(v))
}

/// `value || null`.
fn or_null(value: Option<&Value>) -> Value {
    let truthy = |v: &&Value| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    };
    value.filter(truthy).cloned().unwrap_or(Value::Null)
}

/// Port of `getTerminalSessionIdForParentMaterialization` (`subtaskParentMaterialization.ts:10`).
pub fn get_terminal_session_id_for_parent_materialization(event: Value) -> Result<Value, String> {
    let properties = event.get("properties").filter(|v| !js::is_undefined(v));
    match get(&event, "type")?.and_then(Value::as_str) {
        Some("session.idle" | "session.error") => Ok(or_null(opt(properties, "sessionID"))),
        Some("session.status") if opt(opt(properties, "status"), "type").and_then(Value::as_str) == Some("idle") => Ok(or_null(opt(properties, "sessionID"))),
        _ => Ok(Value::Null),
    }
}

/// Port of `resolveParentSessionIdForTerminalChild` (`subtaskParentMaterialization.ts:28`).
pub fn resolve_parent_session_id_for_terminal_child(state: Value, child_session_id: String) -> Result<Value, String> {
    let sessions = get(&state, "session")?.cloned().unwrap_or_else(js::undefined);
    get(&sessions, "find")?;
    let Value::Array(sessions) = sessions else {
        return Err("state.session.find is not a function".to_string()); // recorded-literal: the V8 TypeError text
    };
    for session in &sessions {
        if get(session, "id")?.and_then(Value::as_str) == Some(child_session_id.as_str()) {
            return Ok(session.get("parentID").filter(|p| !nullish(p)).cloned().unwrap_or(Value::Null));
        }
    }
    Ok(Value::Null)
}
