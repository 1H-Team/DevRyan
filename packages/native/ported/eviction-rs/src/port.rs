//! The Rust port of `eviction.ts`.

#![forbid(unsafe_code)]

use serde_json::Value;

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Whether any list of a record of lists is non-empty, as `Object.values(x ?? {})` walks it.
fn any_pending(record: Option<&Value>) -> bool {
    let Some(Value::Object(entries)) = record else { return false };
    entries.values().any(|list| match list {
        Value::Array(items) => !items.is_empty(),
        Value::String(text) => !text.is_empty(),
        _ => false,
    })
}

/// Port of `hasPendingBlockingRequests` (`eviction.ts:15`).
pub fn has_pending_blocking_requests(state: Option<Value>) -> Result<bool, String> {
    let Some(state) = state else { return Ok(false) };
    if !truthy(&state) {
        return Ok(false);
    }
    Ok(any_pending(state.get("question")) || any_pending(state.get("permission")))
}

/// Port of `canDisposeDirectory` (`eviction.ts:45`).
pub fn can_dispose_directory(input: Value) -> Result<Value, String> {
    if input.is_null() {
        return Err("Cannot read properties of null (reading 'directory')".to_string());
    }
    let field = |name: &str| input.get(name).is_some_and(truthy);
    let ok =
        field("directory") && field("hasStore") && !field("pinned") && !field("booting") && !field("loadingSessions") && !field("hasPendingBlockingRequests");
    Ok(Value::Bool(ok))
}
