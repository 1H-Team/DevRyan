//! The Rust port of `lib/helper-model-selection.js` of `@devryan/shared-runtime`.

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

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn truthy(v: &Value) -> bool {
    let falsy = num(v).is_some_and(|n| n == 0.0 || n.is_nan()) || js::string_units(v).is_some_and(|u| u.is_empty());
    !(falsy || matches!(v, Value::Null | Value::Bool(false)) || js::is_undefined(v))
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`, as `isRecord` reads it.
fn record(v: &Value) -> bool {
    plain(v).is_some() || marked(v, "$set")
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

/// `Object.keys(v)` of a value that is not nullish.
fn keys(v: &Value) -> Vec<String> {
    let n = js::string_units(v).map(|u| u.len()).or_else(|| v.as_array().map(Vec::len));
    match n {
        Some(n) => (0..n).map(|i| i.to_string()).collect(),
        None => plain(v).map(|o| o.keys().cloned().collect()).unwrap_or_default(),
    }
}

// ---- the unit ----

/// A string of 1 to 256 UTF-16 units with no control character or space.
fn valid(v: &Value) -> bool {
    js::string_units(v).is_some_and(|u| !u.is_empty() && u.len() <= 256 && !u.iter().any(|c| *c <= 0x20 || *c == 0x7f))
}

/// Port of `parseHelperModelSelection` (`helper-model-selection.js:7`).
pub fn parse_helper_model_selection(value: Value) -> Result<Value, String> {
    let allowed = ["providerID", "modelID", "variant", "revision"];
    if !truthy(&value) || !record(&value) || keys(&value).iter().any(|k| !allowed.contains(&k.as_str())) {
        return Ok(js::undefined());
    }
    let variant = prop(&value, "variant");
    if !["providerID", "modelID", "revision"].iter().all(|k| valid(&prop(&value, k))) || (!js::is_undefined(&variant) && !valid(&variant)) {
        return Ok(js::undefined());
    }
    let mut out = Map::new();
    for key in ["providerID", "modelID", "variant", "revision"] {
        if key != "variant" || !js::is_undefined(&variant) {
            out.insert(key.into(), prop(&value, key));
        }
    }
    Ok(Value::Object(out))
}
