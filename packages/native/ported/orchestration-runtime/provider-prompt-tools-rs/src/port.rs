//! The Rust port of `provider-prompt-tools.js` of `@devryan/orchestration-runtime`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

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

fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

// ---- the unit ----

fn normalize(value: &Value) -> String {
    units(value)
        .map(|u| String::from_utf16_lossy(&u).trim_matches(js_space).to_lowercase())
        .unwrap_or_default()
}

/// Port of `resolveProviderPromptTools` (`provider-prompt-tools.js:44`).
pub fn resolve_provider_prompt_tools(
    provider_id: serde_json::Value,
    agent: serde_json::Value,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let provider = normalize(&provider_id);
    let copilot = provider == "github-copilot" || provider == "copilot";
    let orchestrator = normalize(&agent) == "orchestrator";
    let options = if js::is_undefined(&options) { Value::Object(Map::new()) } else { options };
    if get(&options, "readOnly")? == Value::Bool(true) {
        let mut out = Map::new();
        if orchestrator {
            out.insert("task".into(), Value::Bool(false));
        }
        for (key, on) in [
            ("*", false),
            ("read", true),
            ("glob", true),
            ("grep", true),
            ("webfetch", true),
            ("devryan_plan_read", true),
        ] {
            out.insert(key.into(), Value::Bool(on));
        }
        return Ok(Value::Object(out));
    }
    Ok(match (copilot, orchestrator) {
        (true, true) => json!({ "resend_*": false, "mcp__resend__*": false, "task": false }),
        (true, false) => json!({ "resend_*": false, "mcp__resend__*": false }),
        (false, true) => json!({ "task": false }),
        (false, false) => js::undefined(),
    })
}
