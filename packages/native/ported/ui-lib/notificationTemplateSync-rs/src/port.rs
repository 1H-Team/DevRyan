//! The Rust port of `notificationTemplateSync.ts` (`--as-json T`). `current !== baseline` is JS
//! strict inequality; two objects that crossed as JSON are never one reference, so an object
//! `current` always differs from an object `baseline` (as in the recording).

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// JS `===` between values received from JS (objects are never the same reference).
fn strict_eq(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b)) {
        (Some(x), Some(y)) => return x == y,
        (Some(_), None) | (None, Some(_)) => return false,
        _ => {}
    }
    match (a, b) {
        (Value::Null, Value::Null) | (Value::Bool(_), Value::Bool(_)) | (Value::String(_), Value::String(_)) => a == b,
        _ if js::is_undefined(a) && js::is_undefined(b) => true,
        _ => match (js::string_units(a), js::string_units(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
    }
}

/// Port of `resolveNotificationTemplatesFromSettingsSnapshot` (`notificationTemplateSync.ts:1`).
pub fn resolve_notification_templates_from_settings_snapshot(arg0: Value) -> Result<Value, String> {
    if arg0.is_null() || js::is_undefined(&arg0) {
        let kind = if arg0.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property 'baseline' of '{kind}' as it is {kind}.")); // recorded-literal: V8 TypeError text
    }
    let field = |k: &str| match &arg0 {
        Value::Object(o) if js::string_units(&arg0).is_none() && js::as_number(&arg0).is_none() => o.get(k).cloned().unwrap_or_else(js::undefined),
        _ => js::undefined(),
    };
    let (baseline, current, incoming) = (field("baseline"), field("current"), field("incoming"));
    if !js::is_undefined(&baseline) && !strict_eq(&current, &baseline) {
        return Ok(current);
    }
    Ok(incoming)
}
