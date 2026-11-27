//! The Rust port of `event-pipeline-connection-state.ts`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

/// `value[key]`, failing as JS does on `null` and `undefined`.
fn read<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if value.is_null() || js::is_undefined(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

/// Port of `resolveEventPipelineConnectionUpdate` (`event-pipeline-connection-state.ts:19`).
pub fn resolve_event_pipeline_connection_update(state: Value, event: Value) -> Result<Option<Value>, String> {
    match read(&event, "type")?.and_then(Value::as_str) {
        Some("transport-switched") => return Ok(None),
        Some("reconnected") => {
            return Ok(Some(json!({ "isConnected": true, "hasEverConnected": true, "connectionPhase": "connected" })));
        }
        _ => {}
    }
    let ever = read(&state, "hasEverConnected")?.is_some_and(|v| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    });
    let reason = read(&event, "reason")?.cloned().unwrap_or_else(js::undefined);
    Ok(Some(json!({
        "isConnected": false,
        "connectionPhase": if ever { "reconnecting" } else { "connecting" },
        "lastDisconnectReason": reason,
    })))
}
