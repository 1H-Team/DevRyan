//! The Rust port of `lib/model-selection-availability.js` of `@devryan/shared-runtime`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

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

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> Result<Value, String> {
    if nullish(v) {
        let kind = if v.is_null() { "null" } else { "undefined" };
        return Err(format!("TypeError: Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(prop(v, key))
}

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

/// JS `String(v)`.
fn to_text(v: &Value) -> String {
    match (num(v), text(v), v) {
        (Some(n), ..) => js::number_to_string(n),
        (_, Some(t), _) => t,
        (_, _, Value::Array(items)) => items
            .iter()
            .map(|i| if nullish(i) { String::new() } else { to_text(i) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(v) => "undefined".into(),
        (_, _, Value::Object(_)) => "[object Object]".into(),
        _ => v.to_string(),
    }
}

// ---- the unit ----

/// `a ?? b ?? c` of three fields of a record.
fn first_of(v: &Value, keys: [&str; 3]) -> Value {
    keys.iter().map(|k| prop(v, k)).find(|x| !nullish(x)).unwrap_or_else(|| prop(v, keys[2]))
}

fn status(status: &str, reason: Value) -> Value {
    json!({ "status": status, "reason": reason })
}

/// Port of `inspectModelSelection` (`model-selection-availability.js:6`).
pub fn inspect_model_selection(selection: Value, catalog: Value, arg2: Value) -> Result<Value, String> {
    let options = if js::is_undefined(&arg2) { Value::Object(Map::new()) } else { arg2 };
    if options.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'variantsComplete')".into()); // recorded-literal: the V8 TypeError text
    }
    let complete = prop(&options, "variantsComplete");
    let complete = js::is_undefined(&complete) || truthy(&complete);
    let providers = prop(&catalog, "providers");
    if !record(&catalog) || prop(&catalog, "catalogIncomplete") == Value::Bool(true) || !providers.is_array() {
        return Ok(status("unknown", json!("catalog_unavailable")));
    }
    let mut provider = None;
    for row in providers.as_array().into_iter().flatten() {
        if record(row) && eq(&first_of(row, ["id", "providerID", "providerId"]), &get(&selection, "providerID")?) {
            provider = Some(row.clone());
            break;
        }
    }
    let Some(provider) = provider else {
        return Ok(status("unavailable", json!("provider_missing")));
    };
    let models = prop(&provider, "models");
    let model = match &models {
        Value::Array(rows) => {
            let mut found = js::undefined();
            for row in rows {
                if record(row) && eq(&first_of(row, ["id", "modelID", "modelId"]), &get(&selection, "modelID")?) {
                    found = row.clone();
                    break;
                }
            }
            found
        }
        _ if record(&models) => prop(&models, &to_text(&get(&selection, "modelID")?)),
        _ => return Ok(status("unknown", json!("catalog_unavailable"))),
    };
    if !record(&model) || prop(&model, "available") == Value::Bool(false) {
        return Ok(status("unavailable", json!("model_missing")));
    }
    let variant = get(&selection, "variant")?;
    if nullish(&variant) || variant.as_str().is_some_and(|v| v.is_empty() || v == "default") {
        return Ok(status("available", Value::Null));
    }
    let variants = prop(&model, "variants");
    let present = match &variants {
        Value::Array(rows) => rows.iter().any(|r| {
            if js::string_units(r).is_some() {
                eq(r, &variant)
            } else {
                record(r) && eq(&prop(r, "id"), &variant)
            }
        }),
        _ => plain(&variants).is_some_and(|o| o.contains_key(&to_text(&variant))),
    };
    Ok(if present {
        status("available", Value::Null)
    } else if complete {
        status("unavailable", json!("variant_missing"))
    } else {
        status("unknown", json!("catalog_unavailable"))
    })
}
