//! The Rust port of `provider-capabilities.js` of `@devryan/orchestration-runtime`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

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

fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

// ---- the unit ----

/// `typeof value === "string" ? value.trim().toLowerCase() : ""`.
fn normalize(value: &Value) -> String {
    units(value)
        .map(|u| String::from_utf16_lossy(&u).trim_matches(js_space).to_lowercase())
        .unwrap_or_default()
}

/// Port of `supportsManagedReadOnlyProvider` (`provider-capabilities.js:16`).
pub fn supports_managed_read_only_provider(provider_id: serde_json::Value, arg1: serde_json::Value) -> Result<bool, String> {
    let options = if js::is_undefined(&arg1) { Value::Object(Map::new()) } else { arg1 };
    if nullish(&options) {
        return Err("TypeError: Cannot read properties of null (reading 'cursorReadOnly')".into()); // recorded-literal: the V8 TypeError text
    }
    let cursor = prop(&options, "cursorReadOnly");
    let id = normalize(&provider_id);
    Ok(!id.is_empty() && (id != "cursor-acp" || cursor == Value::Bool(true)))
}

/// Port of `supportsManagedReadOnlyAgent` (`provider-capabilities.js:25`).
pub fn supports_managed_read_only_agent(agent: serde_json::Value) -> Result<bool, String> {
    let id = normalize(&agent);
    Ok(!id.is_empty() && id != "designer")
}
