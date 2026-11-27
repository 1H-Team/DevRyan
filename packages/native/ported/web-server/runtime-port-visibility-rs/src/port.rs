//! The Rust port of `runtime-port-visibility.js`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// Port of `getPublicRuntimePort` (`runtime-port-visibility.js:1`): `null` when startup was
/// skipped or the runtime is managed elsewhere (`{ ... } = {}` defaults: a `null` options
/// object throws).
pub fn get_public_runtime_port(runtime_port: Value, options: Value) -> Result<Value, String> {
    if options.is_null() {
        return Err("Cannot read properties of null (reading 'startupSkipped')".into()); // recorded-literal: V8 TypeError text
    }
    let flag = |key: &str| options.as_object().and_then(|o| o.get(key)).is_some_and(truthy);
    Ok(if flag("startupSkipped") || flag("externallyManaged") {
        Value::Null
    } else {
        runtime_port
    })
}
