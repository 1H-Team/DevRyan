//! The Rust port of `configSync.ts`: `scopeMatches` (the subscribe/emit pair is a listener set,
//! kept in TS). `scopes.includes` is `Array.prototype.includes` (SameValueZero) for an array but
//! `String.prototype.includes` (a substring test, after `String(scope)`) for a string.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// SameValueZero between values received from JS (objects are never the same reference).
fn same_value_zero(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (js::as_number(a), js::as_number(b)) {
        return x == y || (x.is_nan() && y.is_nan());
    }
    if let (Some(x), Some(y)) = (js::string_units(a), js::string_units(b)) {
        return x == y;
    }
    match (a, b) {
        (Value::Null, Value::Null) | (Value::Bool(_), Value::Bool(_)) => a == b,
        _ => js::is_undefined(a) && js::is_undefined(b),
    }
}

/// JS `String(value)` as UTF-16 code units (`element` for an array member: `null`/`undefined`
/// print empty).
fn js_string(value: &Value, element: bool) -> Vec<u16> {
    if let Some(units) = js::string_units(value) {
        return units;
    }
    let single = |key: &str| value.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(key));
    let text = match value {
        _ if js::is_undefined(value) => {
            if element {
                String::new()
            } else {
                "undefined".into()
            }
        }
        Value::Null => {
            if element {
                String::new()
            } else {
                "null".into()
            }
        }
        Value::Bool(flag) => flag.to_string(),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(|v| String::from_utf16_lossy(&js_string(v, true))).collect();
            parts.join(",")
        }
        _ if single("$map") => "[object Map]".into(),
        _ if single("$set") => "[object Set]".into(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    text.encode_utf16().collect()
}

fn includes(list: &Value, item: &Value) -> Result<bool, String> {
    if let Some(units) = js::string_units(list) {
        let needle = js_string(item, false);
        return Ok(needle.is_empty() || units.windows(needle.len()).any(|w| w == needle.as_slice()));
    }
    match list {
        Value::Array(items) => Ok(items.iter().any(|v| same_value_zero(v, item))),
        Value::Null => Err("Cannot read properties of null (reading 'includes')".into()), // recorded-literal: V8 TypeError text
        _ if js::is_undefined(list) => Err("Cannot read properties of undefined (reading 'includes')".into()), // recorded-literal: V8 TypeError text
        _ => Err("event.scopes.includes is not a function".into()),                       // recorded-literal: V8 TypeError text
    }
}

/// Port of `scopeMatches` (`configSync.ts:57`).
pub fn scope_matches(event: Value, scope: Value) -> Result<bool, String> {
    let scopes = match &event {
        Value::Null => return Err("Cannot read properties of null (reading 'scopes')".into()), // recorded-literal: V8 TypeError text
        _ if js::is_undefined(&event) => return Err("Cannot read properties of undefined (reading 'scopes')".into()), // recorded-literal: V8 TypeError text
        Value::Object(o) if js::string_units(&event).is_none() && js::as_number(&event).is_none() => o.get("scopes").cloned().unwrap_or_else(js::undefined),
        _ => js::undefined(),
    };
    if includes(&scopes, &Value::String("all".into()))? {
        return Ok(true);
    }
    includes(&scopes, &scope)
}
