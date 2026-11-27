//! The Rust port of `model-availability.js` of `@devryan/orchestration-runtime`, with
//! `inspectModelSelection` of `@devryan/shared-runtime/lib/model-selection-availability.js` inlined.
//! Identifiers are cut at 180 UTF-16 units, as JS slices.

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
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ if js::is_undefined(v) => false,
        _ => num(v).map_or_else(|| js::string_units(v).is_none_or(|u| !u.is_empty()), |n| n != 0.0 && !n.is_nan()),
    }
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

/// `typeof v === "string" && v.trim() ? v.trim() : ""` (JS white space).
fn trimmed(v: &Value) -> String {
    text(v)
        .map(|t| t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string())
        .unwrap_or_default()
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

/// `Object.keys(v)` of a value that is not nullish.
fn keys(v: &Value) -> Vec<String> {
    let n = js::string_units(v).map(|u| u.len()).or_else(|| v.as_array().map(Vec::len));
    match n {
        Some(n) => (0..n).map(|i| i.to_string()).collect(),
        None => plain(v).map(|o| o.keys().cloned().collect()).unwrap_or_default(),
    }
}

// ---- the unit ----

fn opt(v: &Value, key: &str) -> Value {
    if nullish(v) { js::undefined() } else { prop(v, key) }
}

/// `a ?? b ?? c` of three fields.
fn first_of(v: &Value, keys: [&str; 3]) -> Value {
    keys.iter().map(|k| opt(v, k)).find(|x| !nullish(x)).unwrap_or_else(|| opt(v, keys[2]))
}

/// `identifier(input)`: the cut, control-stripped, trimmed string, or `null`.
fn identifier(v: &Value) -> Value {
    let Some(u) = js::string_units(v) else { return Value::Null };
    let kept: Vec<u16> = u.iter().take(180).copied().filter(|c| *c > 0x1f && *c != 0x7f).collect();
    Value::String(trimmed(&js::utf16_string(&kept)))
}

fn supported(v: &Value) -> Value {
    let mut out: Vec<Value> = Vec::new();
    for id in v
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| js::string_units(r).is_some())
        .map(identifier)
        .filter(truthy)
    {
        if !out.iter().any(|x| eq(x, &id)) {
            out.push(id);
        }
    }
    Value::Array(out.into_iter().take(16).collect())
}

fn status(status: &str, reason: Value) -> Value {
    json!({ "status": status, "reason": reason })
}

/// `inspectModelSelection(selection, catalog)` with `variantsComplete` true.
fn inspect(provider_id: &Value, model_id: &Value, variant: &Value, catalog: &Value) -> Value {
    let providers = prop(catalog, "providers");
    if !record(catalog) || prop(catalog, "catalogIncomplete") == Value::Bool(true) || !providers.is_array() {
        return status("unknown", json!("catalog_unavailable"));
    }
    let id_keys = ["id", "providerID", "providerId"];
    let Some(provider) = providers
        .as_array()
        .and_then(|p| p.iter().find(|r| record(r) && eq(&first_of(r, id_keys), provider_id)))
    else {
        return status("unavailable", json!("provider_missing"));
    };
    let models = prop(provider, "models");
    let model = match &models {
        Value::Array(rows) => rows
            .iter()
            .find(|r| record(r) && eq(&first_of(r, ["id", "modelID", "modelId"]), model_id))
            .cloned()
            .unwrap_or_else(js::undefined),
        _ if record(&models) => prop(&models, &to_text(model_id)),
        _ => return status("unknown", json!("catalog_unavailable")),
    };
    if !record(&model) || prop(&model, "available") == Value::Bool(false) {
        return status("unavailable", json!("model_missing"));
    }
    if nullish(variant) || variant.as_str().is_some_and(|v| v.is_empty() || v == "default") {
        return status("available", Value::Null);
    }
    let variants = prop(&model, "variants");
    let present = match &variants {
        Value::Array(rows) => rows.iter().any(|r| {
            if js::string_units(r).is_some() {
                eq(r, variant)
            } else {
                record(r) && eq(&prop(r, "id"), variant)
            }
        }),
        _ => plain(&variants).is_some_and(|o| o.contains_key(&to_text(variant))),
    };
    if present {
        status("available", Value::Null)
    } else {
        status("unavailable", json!("variant_missing"))
    }
}

fn trimmed_string(v: &Value) -> Option<Value> {
    Some(trimmed(v)).filter(|t| !t.is_empty()).map(Value::String)
}

fn inspect_in_catalog(payload: &Value, provider_id: &Value, model_id: &Value, variant: &Value) -> Result<Value, String> {
    let (Some(provider), Some(model)) = (trimmed_string(provider_id), trimmed_string(model_id)) else {
        return Ok(status("unavailable", json!("model_missing")));
    };
    let catalog = if truthy(payload) && record(payload) && plain(payload).is_some_and(|o| o.contains_key("data")) {
        prop(payload, "data")
    } else {
        payload.clone()
    };
    let result = inspect(&provider, &model, variant, &catalog);
    if prop(&result, "reason") != json!("variant_missing") {
        return Ok(result);
    }
    let rows = get(&catalog, "providers")?;
    let row = rows
        .as_array()
        .and_then(|r| r.iter().find(|r| eq(&first_of(r, ["id", "providerID", "providerId"]), &provider)))
        .cloned()
        .unwrap_or_else(js::undefined);
    let models = get(&row, "models")?;
    let entry = match &models {
        Value::Array(m) => m
            .iter()
            .find(|r| eq(&first_of(r, ["id", "modelID", "modelId"]), &model))
            .cloned()
            .unwrap_or_else(js::undefined),
        _ => get(&models, model.as_str().unwrap_or_default())?,
    };
    let variants = get(&entry, "variants")?;
    let names: Vec<Value> = match &variants {
        Value::Array(v) => v.iter().map(|r| if js::string_units(r).is_some() { r.clone() } else { opt(r, "id") }).collect(),
        _ => keys(&if nullish(&variants) { Value::Object(Map::new()) } else { variants })
            .into_iter()
            .map(Value::String)
            .collect(),
    };
    let mut out = plain(&result).cloned().unwrap_or_default();
    out.insert("supportedVariants".into(), supported(&Value::Array(names)));
    let name = identifier(&prop(&entry, "name"));
    if truthy(&name) {
        out.insert("modelName".into(), name);
    }
    Ok(Value::Object(out))
}

/// Port of `inspectManagedModelInCatalog` (`model-availability.js:7`).
pub fn inspect_managed_model_in_catalog(payload: Value, provider_id: Value, model_id: Value, variant: Value) -> Result<Value, String> {
    inspect_in_catalog(&payload, &provider_id, &model_id, &variant)
}

/// Port of `isManagedModelAvailableInCatalog` (`model-availability.js:24`).
pub fn is_managed_model_available_in_catalog(payload: Value, provider_id: Value, model_id: Value, variant: Value) -> Result<Value, String> {
    let result = inspect_in_catalog(&payload, &provider_id, &model_id, &variant)?;
    let status = prop(&result, "status");
    Ok(if status == json!("unknown") {
        Value::Null
    } else {
        Value::Bool(status == json!("available"))
    })
}

/// Port of `projectManagedModelValidationFailure` (`model-availability.js:30`).
pub fn project_managed_model_validation_failure(value: Value) -> Result<Value, String> {
    let code = opt(&value, "code");
    let details = opt(&value, "details");
    let reason = opt(&details, "reason");
    let codes = ["managed_agent_model_unavailable", "managed_agent_model_availability_unknown"];
    let reasons = [
        "provider_missing",
        "model_missing",
        "variant_missing",
        "selection_unavailable",
        "catalog_unavailable",
    ];
    if !code.as_str().is_some_and(|c| codes.contains(&c)) || !reason.as_str().is_some_and(|r| reasons.contains(&r)) {
        return Ok(Value::Null);
    }
    let field = |k: &str| identifier(&prop(&details, k));
    let mut out = Map::new();
    out.insert("reason".into(), reason.clone());
    for key in ["providerId", "modelId", "variant", "agent", "modelName"] {
        if !matches!(key, "agent" | "modelName") || truthy(&field(key)) {
            out.insert(key.into(), field(key));
        }
    }
    let listed = prop(&details, "supportedVariants");
    if listed.is_array() {
        out.insert("supportedVariants".into(), supported(&listed));
    }
    let details = Value::Object(out);
    let show = |k: &str| to_text(&prop(&details, k));
    let model = if nullish(&prop(&details, "modelName")) {
        format!("{}/{}", show("providerId"), show("modelId"))
    } else {
        show("modelName")
    };
    let message = if reason == json!("variant_missing") {
        let agent = if nullish(&prop(&details, "agent")) {
            "Managed agent".to_string()
        } else {
            show("agent")
        };
        let variants = prop(&details, "supportedVariants");
        let choose = match variants.as_array() {
            Some(v) if !v.is_empty() => v.iter().map(to_text).collect::<Vec<_>>().join(", "),
            _ => "a supported variant".into(),
        };
        format!(
            "{agent} cannot start: {} is unsupported for {model}. Choose {choose} or Provider default in Agents settings.",
            show("variant")
        )
    } else {
        let variant = prop(&details, "variant");
        let suffix = if truthy(&variant) {
            format!(" ({})", to_text(&variant))
        } else {
            String::new()
        };
        format!("Managed selection could not be verified: {}/{}{suffix}.", show("providerId"), show("modelId"))
    };
    Ok(json!({ "code": code, "details": details, "message": message }))
}
