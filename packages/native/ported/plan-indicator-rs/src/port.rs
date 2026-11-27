//! The Rust port of `plan-indicator.ts`. Message ids compare with `<` (UTF-16 code unit order),
//! and a state outside the rank table has an `undefined` rank, so `nextRank < currentRank` is false.

#![forbid(unsafe_code)]

use std::cmp::Ordering;

use serde_json::{Map, Value};

use crate::js;

/// JavaScript truthiness of an optional value.
fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(|v| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    })
}

fn field<'a>(entry: &'a Value, key: &str) -> Option<&'a Value> {
    entry.get(key).filter(|v| !js::is_undefined(v))
}

/// `compareSourceMessageIds`.
fn compare_ids(left: Option<&Value>, right: Option<&Value>) -> i32 {
    if !truthy(left) || !truthy(right) || left == right {
        return 0;
    }
    let units = |v: Option<&Value>| v.and_then(js::string_units).unwrap_or_default();
    if units(left).cmp(&units(right)) == Ordering::Less { -1 } else { 1 }
}

fn rank(state: Option<&Value>) -> Option<u8> {
    match state?.as_str()? {
        "proposed" => Some(0),
        "implementing" => Some(1),
        "completed" => Some(2),
        _ => None,
    }
}

/// `createPlanIndicatorEntry`.
fn create(state: &str, source: Option<Value>, implementation: Option<Value>) -> Value {
    let mut entry = Map::new();
    entry.insert("state".to_string(), Value::String(state.to_string()));
    entry.insert("sourceMessageId".to_string(), source.unwrap_or_else(js::undefined));
    if let Some(id) = implementation.filter(|v| truthy(Some(v))) {
        entry.insert("implementationMessageId".to_string(), id);
    }
    Value::Object(entry)
}

/// Port of `getPlanIndicatorTone` (`plan-indicator.ts:11`).
pub fn get_plan_indicator_tone(state: String) -> Result<String, String> {
    Ok(if state == "completed" { "success" } else { "warning" }.to_string())
}

/// Port of `resolveEffectivePlanIndicatorState` (`plan-indicator.ts:23`).
pub fn resolve_effective_plan_indicator_state(entry: Option<Value>, latest_plan_mode_user_message_id: Option<String>) -> Result<Value, String> {
    let Some(entry) = entry.filter(|e| truthy(Some(e))) else {
        return Ok(Value::Null);
    };
    let state = field(&entry, "state").cloned().unwrap_or_else(js::undefined);
    if state.as_str() != Some("proposed") {
        return Ok(state);
    }
    let latest = latest_plan_mode_user_message_id.map(Value::String);
    if !truthy(field(&entry, "sourceMessageId")) || !truthy(latest.as_ref()) {
        return Ok(state);
    }
    Ok(if compare_ids(latest.as_ref(), field(&entry, "sourceMessageId")) > 0 {
        Value::Null
    } else {
        state
    })
}

/// Port of `nextPlanIndicatorEntry` (`plan-indicator.ts:56`).
pub fn next_plan_indicator_entry(
    current: Option<Value>,
    next_state: String,
    source_message_id: Option<String>,
    implementation_message_id: Option<String>,
) -> Result<Option<Value>, String> {
    let source = source_message_id.map(Value::String);
    let implementation = implementation_message_id.map(Value::String);
    let Some(current) = current.filter(|c| truthy(Some(c))) else {
        return Ok(Some(create(&next_state, source, implementation)));
    };
    let current_source = field(&current, "sourceMessageId");
    match compare_ids(source.as_ref(), current_source) {
        order if order < 0 => return Ok(Some(current)),
        order if order > 0 => return Ok(Some(create(&next_state, source, implementation))),
        _ => {}
    }
    let current_state = field(&current, "state");
    let next_rank = rank(Some(&Value::String(next_state.clone())));
    if let (Some(next), Some(now)) = (next_rank, rank(current_state))
        && next < now
    {
        return Ok(Some(current));
    }
    let next_implementation = implementation.or_else(|| field(&current, "implementationMessageId").cloned());
    if current_state.and_then(Value::as_str) == Some(next_state.as_str())
        && current_source == source.as_ref()
        && field(&current, "implementationMessageId") == next_implementation.as_ref()
    {
        return Ok(Some(current));
    }
    let merged_source = source.or_else(|| current_source.cloned());
    Ok(Some(create(&next_state, merged_source, next_implementation)))
}
