//! The Rust port of `xai-tool-catalog.js` of `@devryan/orchestration-runtime` (its pure exports;
//! `createXaiToolCatalogCache` returns closures and stays in JS). `stableJson` sorts keys by UTF-16
//! code units where JS uses `localeCompare`: only the equality of two encodings is read, which
//! agrees unless two distinct keys collate as equal.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

// ---- JS values over JSON ----

/// A one-key object `{ tag: ... }`: how the bridge marks numbers, strings, `undefined` and `Set`s.
fn marked(v: &Value, tag: &str) -> bool {
    v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(tag))
}

/// `typeof v === "number"`.
fn num(v: &Value) -> Option<f64> {
    (v.is_number() || marked(v, "$num")).then(|| js::as_number(v)).flatten()
}

fn text(v: &Value) -> Option<String> {
    js::string_units(v).map(|u| String::from_utf16_lossy(&u))
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    let index = || key.parse::<usize>().ok().filter(|i| i.to_string() == key);
    let found = match (v, js::string_units(v)) {
        (_, Some(u)) if key == "length" => Some(js::number(u.len() as f64)),
        (_, Some(u)) => index().and_then(|i| u.get(i)).map(|c| js::utf16_string(&[*c])),
        (Value::Array(items), _) if key == "length" => Some(js::number(items.len() as f64)),
        (Value::Array(items), _) => index().and_then(|i| items.get(i).cloned()),
        _ => plain(v).and_then(|o| o.get(key).cloned()),
    };
    found.unwrap_or_else(js::undefined)
}

fn quote(u: &[u16], out: &mut String) {
    out.push('"');
    for c in char::decode_utf16(u.iter().copied()) {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
}

/// `JSON.stringify(v)` (`None` for `undefined`).
fn stringify(v: &Value) -> Option<String> {
    let mut out = String::new();
    write_json(v, &mut out).then_some(out)
}

fn write_json(v: &Value, out: &mut String) -> bool {
    if js::is_undefined(v) {
        return false;
    }
    if let Some(n) = num(v) {
        out.push_str(&if n.is_finite() { js::number_to_string(n) } else { "null".into() });
    } else if let Some(u) = js::string_units(v) {
        quote(&u, out);
    } else if marked(v, "$set") {
        out.push_str("{}");
    } else {
        match v {
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if !write_json(item, out) {
                        out.push_str("null");
                    }
                }
                out.push(']');
            }
            Value::Object(o) => {
                out.push('{');
                let mut first = true;
                for (k, item) in o {
                    let mut member = String::new();
                    quote(&k.encode_utf16().collect::<Vec<_>>(), &mut member);
                    member.push(':');
                    if write_json(item, &mut member) {
                        if !first {
                            out.push(',');
                        }
                        out.push_str(&member);
                        first = false;
                    }
                }
                out.push('}');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    true
}

// ---- the unit ----

const XAI: [&str; 3] = ["xai", "grok", "xai-oauth"];

fn trim(v: &Value) -> String {
    text(v)
        .map(|t| t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string())
        .unwrap_or_default()
}

fn opt(v: &Value, key: &str) -> Value {
    if nullish(v) { js::undefined() } else { prop(v, key) }
}

/// `sortJsonValue(value)`: object keys sorted (by UTF-16 code units).
fn sorted(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        _ if plain(v).is_none() => v.clone(),
        _ => {
            let mut entries: Vec<(&String, &Value)> = plain(v).map(|o| o.iter().collect()).unwrap_or_default();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            Value::Object(entries.into_iter().map(|(k, x)| (k.clone(), sorted(x))).collect())
        }
    }
}

fn stable_json(v: &Value) -> String {
    stringify(&sorted(v)).unwrap_or_default()
}

fn description(v: &Value) -> String {
    let mut out = String::new();
    for word in trim(v)
        .split(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
        .filter(|w| !w.is_empty())
    {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn equivalent(left: &Value, right: &Value) -> bool {
    let parameters = stable_json(&opt(left, "parameters"));
    description(&opt(left, "description")) == description(&opt(right, "description"))
        && !parameters.is_empty()
        && parameters == stable_json(&opt(right, "parameters"))
}

/// Port of `deriveXaiDuplicateToolOverrides` (`xai-tool-catalog.js:56`).
pub fn derive_xai_duplicate_tool_overrides(catalog: serde_json::Value) -> Result<serde_json::Value, String> {
    let Value::Array(tools) = catalog else { return Ok(Value::Null) };
    let mut by_id: Vec<(String, Value)> = Vec::new();
    for tool in tools {
        let id = trim(&opt(&tool, "id"));
        if !id.is_empty() && !by_id.iter().any(|(k, _)| *k == id) {
            by_id.push((id, tool));
        }
    }
    let mut overrides = Map::new();
    for (id, tool) in &by_id {
        let segments: Vec<&str> = id.split("__").collect();
        let canonical_id = segments.get(2..).map(|s| s.join("__")).unwrap_or_default();
        if !id.starts_with("mcp__") || segments.len() < 3 || canonical_id.is_empty() {
            continue;
        }
        if let Some((_, canonical)) = by_id.iter().find(|(k, _)| *k == canonical_id)
            && equivalent(canonical, tool)
        {
            overrides.insert(id.clone(), Value::Bool(false));
        }
    }
    Ok(if overrides.is_empty() { Value::Null } else { Value::Object(overrides) })
}

/// Port of `haveEquivalentToolSchemas` (`xai-tool-catalog.js:50`).
pub fn have_equivalent_tool_schemas(left: serde_json::Value, right: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(Value::Bool(equivalent(&left, &right)))
}

/// Port of `isXaiProviderID` (`xai-tool-catalog.js:13`).
pub fn is_xai_provider_id(value: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(Value::Bool(XAI.contains(&trim(&value).to_lowercase().as_str())))
}

/// Port of `listXaiModelIds` (`xai-tool-catalog.js:76`).
pub fn list_xai_model_ids(provider_payload: serde_json::Value) -> Result<serde_json::Value, String> {
    let providers = opt(&provider_payload, "providers");
    let mut ids: Vec<Value> = Vec::new();
    for provider in providers.as_array().cloned().unwrap_or_default() {
        if !XAI.contains(&trim(&opt(&provider, "id")).to_lowercase().as_str()) {
            continue;
        }
        let models = opt(&provider, "models");
        for (key, model) in plain(&models).cloned().unwrap_or_default() {
            let id = Some(trim(&opt(&model, "id")))
                .filter(|i| !i.is_empty())
                .unwrap_or_else(|| key.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string());
            if !id.is_empty() && !ids.iter().any(|x| x.as_str() == Some(id.as_str())) {
                ids.push(Value::String(id));
            }
        }
    }
    Ok(Value::Array(ids))
}
