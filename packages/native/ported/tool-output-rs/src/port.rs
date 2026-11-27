//! The Rust port of `tool-output.ts`, after the client engine's `families/tool_output.rs`, over
//! JSON values: ids compare with `===` (objects never equal), the map from `full` keeps the last
//! part of an id, and the restored part is the existing one when both print the same JSON.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

/// `value[key]`, failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if value.is_null() || js::is_undefined(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

fn opt<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|v| v.get(key)).filter(|v| !js::is_undefined(v))
}

/// `part?.type === "tool" && part.state?.status === "completed"`.
fn completed_tool(part: Option<&Value>) -> bool {
    opt(part, "type").and_then(Value::as_str) == Some("tool") && opt(opt(part, "state"), "status").and_then(Value::as_str) == Some("completed")
}

fn omitted(part: Option<&Value>) -> bool {
    completed_tool(part) && opt(opt(part, "state"), "outputOmitted") == Some(&Value::Bool(true))
}

fn full_output(part: Option<&Value>) -> bool {
    completed_tool(part) && !omitted(part)
}

/// A key `Map` and `===` compare primitives by (`None` for objects, equal to nothing).
fn key(value: Option<&Value>) -> Option<String> {
    match value {
        None => Some("u".to_string()),
        Some(v) if js::is_undefined(v) => Some("u".to_string()),
        Some(v) => match (js::as_number(v), v) {
            (Some(n), _) if n.is_nan() => Some("NaN".to_string()),
            (Some(n), _) => Some(format!("n{}", js::number_to_string(n))),
            (None, Value::Object(_) | Value::Array(_)) => js::string_units(v).map(|u| format!("s{u:?}")),
            (None, Value::String(s)) => Some(format!("s{:?}", s.encode_utf16().collect::<Vec<_>>())),
            (None, other) => Some(other.to_string()),
        },
    }
}

/// The value `JSON.stringify` prints, as JSON: `undefined` members dropped (`null` in arrays).
fn json_form(value: &Value) -> Option<Value> {
    if js::is_undefined(value) {
        return None;
    }
    if let (Some(n), Value::Object(_)) = (js::as_number(value), value) {
        return Some(if n.is_finite() { js::number(0.0) } else { Value::Null });
    }
    Some(match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| json_form(v).unwrap_or(Value::Null)).collect()),
        Value::Object(map) => Value::Object(map.iter().filter_map(|(k, v)| Some((k.clone(), json_form(v)?))).collect()),
        other => other.clone(),
    })
}

/// Port of `isToolOutputOmitted` (`tool-output.ts:16`).
pub fn is_tool_output_omitted(part: Option<Value>) -> Result<bool, String> {
    Ok(omitted(part.as_ref()))
}

/// Port of `getOmittedToolOutputBytes` (`tool-output.ts:23`).
pub fn get_omitted_tool_output_bytes(part: Value) -> Result<Option<f64>, String> {
    let state = get(&part, "state")?.cloned().unwrap_or_else(js::undefined);
    let bytes = get(&state, "outputBytes")?;
    let number = bytes.filter(|b| b.is_number() || b.get("$num").is_some()).and_then(js::as_number);
    Ok(number.filter(|n| n.is_finite() && *n >= 0.0))
}

/// Port of `keepFullToolOutput` (`tool-output.ts:37`).
pub fn keep_full_tool_output(existing: Option<Value>, next: Value) -> Result<Value, String> {
    let Some(existing) = existing.filter(|e| full_output(Some(e))) else {
        return Ok(next);
    };
    if !omitted(Some(&next)) {
        return Ok(next);
    }
    let same_id = match (key(get(&existing, "id")?), key(get(&next, "id")?)) {
        (Some(a), Some(b)) => a == b && a != "NaN",
        _ => false,
    };
    if !same_id {
        return Ok(next);
    }
    let mut state: Map<String, Value> = next.get("state").and_then(Value::as_object).cloned().unwrap_or_default();
    state.shift_remove("outputOmitted");
    state.shift_remove("outputBytes");
    let old = |k: &str| opt(existing.get("state"), k).cloned().unwrap_or_else(js::undefined);
    state.insert("output".to_string(), old("output"));
    state.insert("metadata".to_string(), old("metadata"));
    let mut restored = next.as_object().cloned().unwrap_or_default();
    restored.insert("state".to_string(), Value::Object(state));
    let restored = Value::Object(restored);
    let print = |v: &Value| json_form(v).map(|f| f.to_string());
    Ok(if print(&restored) == print(&existing) { existing } else { restored })
}

/// Port of `mergeLoadedToolOutput` (`tool-output.ts:53`).
pub fn merge_loaded_tool_output(current: Value, full: Value) -> Result<Value, String> {
    let Value::Array(full) = &full else {
        get(&full, "map")?;
        return Err("full.map is not a function".to_string());
    };
    let mut by_id: Vec<(Option<String>, &Value)> = Vec::with_capacity(full.len());
    for part in full {
        let id = key(get(part, "id")?);
        match by_id.iter_mut().find(|(k, _)| k.is_some() && *k == id) {
            Some(slot) => slot.1 = part,
            None => by_id.push((id, part)),
        }
    }
    get(&current, "length")?;
    let Value::Array(items) = &current else { return Ok(current) };
    let mut merged: Option<Vec<Value>> = None;
    for (index, part) in items.iter().enumerate() {
        if !omitted(Some(part)) {
            continue;
        }
        let id = key(part.get("id"));
        let loaded = by_id.iter().find(|(k, _)| k.is_some() && *k == id).map(|(_, p)| *p);
        if !full_output(loaded) {
            continue;
        }
        merged.get_or_insert_with(|| items.clone())[index] = loaded.cloned().unwrap_or(Value::Null);
    }
    Ok(merged.map_or(current, Value::Array))
}
