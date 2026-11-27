//! The Rust port of `harness-policies.js` of `@devryan/orchestration-runtime`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

type R<T> = Result<T, String>;

fn undef() -> Value {
    js::undefined()
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

fn marker<'a>(v: &'a Value, tag: &str) -> Option<&'a Value> {
    match v {
        Value::Object(o) if o.len() == 1 => o.get(tag),
        _ => None,
    }
}

/// `typeof v === "string"`, as UTF-16 code units.
fn units(v: &Value) -> Option<Vec<u16>> {
    if v.is_string() || marker(v, "$utf16").is_some() {
        js::string_units(v)
    } else {
        None
    }
}

/// A plain object (not a marker of `undefined`, a number, a string or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    match v {
        Value::Object(o) if !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))) => Some(o),
        _ => None,
    }
}

fn is_str(v: &Value, text: &str) -> bool {
    units(v).is_some_and(|u| u == text.encode_utf16().collect::<Vec<_>>())
}

fn read_error(base: &Value, key: Option<String>) -> String {
    let kind = if base.is_null() { "null" } else { "undefined" };
    match key {
        Some(key) => format!("TypeError: Cannot read properties of {kind} (reading '{key}')"),
        None => format!("TypeError: Cannot read properties of {kind}"),
    }
}

fn index_key(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse::<u32>().ok().filter(|n| canonical && *n != u32::MAX)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    if let Some(u) = units(v) {
        return match key {
            "length" => js::number(u.len() as f64),
            _ => index_key(key).and_then(|i| u.get(i as usize)).map_or_else(undef, |c| js::utf16_string(&[*c])),
        };
    }
    match v {
        Value::Array(items) if key == "length" => js::number(items.len() as f64),
        Value::Array(items) => index_key(key).and_then(|i| items.get(i as usize)).cloned().unwrap_or_else(undef),
        _ => plain(v).and_then(|o| o.get(key)).cloned().unwrap_or_else(undef),
    }
}

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> R<Value> {
    if nullish(v) { Err(read_error(v, Some(key.into()))) } else { Ok(prop(v, key)) }
}

// ---- the unit ----

const POLICIES: [(&str, &str, bool); 6] = [
    ("readOverlap", "DEVRYAN_MANAGED_READ_OVERLAP", false),
    ("waitAny", "DEVRYAN_MANAGED_WAIT_ANY", true),
    ("compactResults", "DEVRYAN_COMPACT_MANAGED_RESULTS", true),
    ("contextProjection", "DEVRYAN_TASK_CONTEXT_PROJECTION", false),
    ("duplicateOutputs", "DEVRYAN_DUPLICATE_OUTPUTS", false),
    ("adaptiveDelegation", "DEVRYAN_ADAPTIVE_DELEGATION", false),
];

fn resolve(environment: &Value) -> R<Map<String, Value>> {
    let environment = if js::is_undefined(environment) {
        Value::Object(Map::new())
    } else {
        environment.clone()
    };
    let mut out = Map::new();
    for (key, name, default_on) in POLICIES {
        let value = get(&environment, name)?;
        let on = if default_on { !is_str(&value, "0") } else { is_str(&value, "1") };
        out.insert(key.into(), Value::Bool(on));
    }
    Ok(out)
}

/// Port of `resolveHarnessPolicies` (`harness-policies.js:16`).
pub fn resolve_harness_policies(environment: serde_json::Value) -> Result<serde_json::Value, String> {
    resolve(&environment).map(Value::Object)
}

/// Port of `resolveNativeHarnessPolicies` (`harness-policies.js:30`).
pub fn resolve_native_harness_policies(environment: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut out = resolve(&environment)?;
    out.insert("readOverlap".into(), Value::Bool(true));
    Ok(Value::Object(out))
}
