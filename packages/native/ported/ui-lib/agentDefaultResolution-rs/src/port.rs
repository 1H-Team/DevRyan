//! The Rust port of `agentDefaultResolution.ts`, with `isProviderModelAvailable` of
//! `providers/modelAvailability.ts` and `resolveProviderModelVariant` (plus `findProviderModel`
//! and `findVariantKey`) of `providers/variantControls.ts` ported alongside, over any JS value.
//! `===` is JS strict equality: a missing `providerId` matches a provider with no `id`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// JS truthiness of a value received from JS.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// A plain JS object (not an array, nor a marker for a string, number, `undefined`, `Map` or `Set`).
fn is_plain(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        !(o.len() == 1
            && ["$undefined", "$num", "$utf16", "$map", "$set", "$bytes", "$function"]
                .iter()
                .any(|k| o.contains_key(*k)))
    })
}

/// `value.key` of a non-nullish value: own properties of plain objects, else `undefined`.
fn field(value: &Value, key: &str) -> Value {
    if !is_plain(value) {
        return js::undefined();
    }
    value.get(key).cloned().unwrap_or_else(js::undefined)
}

/// `value.key`, failing as V8 does on `null` and `undefined`.
fn get(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
}

/// `value?.key`.
fn opt(value: &Value, key: &str) -> Value {
    if nullish(value) { js::undefined() } else { field(value, key) }
}

/// Whether `key` is a JS array index (canonical decimal below 2^32 - 1).
fn index_key(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// `Object.entries(value)` of a non-nullish value, in JS order (array-index keys first).
fn entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::String(text) => text.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), js::utf16_string(&[u]))).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::Object(map) if is_plain(value) => {
            let mut indexes: Vec<(u32, &String)> = map.keys().filter_map(|k| index_key(k).map(|n| (n, k))).collect();
            indexes.sort_unstable();
            let mut keys: Vec<&String> = indexes.into_iter().map(|(_, k)| k).collect();
            keys.extend(map.keys().filter(|k| index_key(k).is_none()));
            keys.into_iter().map(|k| (k.clone(), map[k].clone())).collect()
        }
        _ => Vec::new(),
    }
}

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

/// `list.find(predicate)` where `list` is the expression `name`.
fn find(list: &Value, name: &str, mut predicate: impl FnMut(&Value) -> Result<bool, String>) -> Result<Value, String> {
    let Value::Array(items) = list else {
        if nullish(list) {
            let kind = if list.is_null() { "null" } else { "undefined" };
            return Err(format!("Cannot read properties of {kind} (reading 'find')")); // recorded-literal: V8 TypeError text
        }
        return Err(format!("{name}.find is not a function")); // recorded-literal: V8 TypeError text
    };
    for item in items {
        if predicate(item)? {
            return Ok(item.clone());
        }
    }
    Ok(js::undefined())
}

/// `clean(value)`: a trimmed string, else `''`.
fn clean(value: &Value) -> String {
    value.as_str().map(|s| s.trim_matches(js_space).to_string()).unwrap_or_default()
}

fn or_null(text: String) -> Value {
    if text.is_empty() { Value::Null } else { Value::String(text) }
}

fn is_array_longer(value: &Value, limit: usize) -> bool {
    value.as_array().is_some_and(|a| a.len() > limit)
}

fn find_override(selections: &Value, agent_name: &Value) -> Value {
    let wanted = clean(agent_name).to_lowercase();
    let selections = if nullish(selections) { Value::Object(Map::new()) } else { selections.clone() };
    entries(&selections)
        .into_iter()
        .find(|(name, _)| name.trim_matches(js_space).to_lowercase() == wanted)
        .map(|(_, v)| v)
        .filter(|v| !nullish(v))
        .unwrap_or(Value::Null)
}

fn single_model(agent: &Value) -> bool {
    let model = opt(agent, "model");
    if !truthy(&opt(&model, "providerID")) || !truthy(&field(&model, "modelID")) {
        return false;
    }
    if clean(&field(agent, "name")).to_lowercase() == "council" {
        return false;
    }
    if is_array_longer(&field(agent, "councillors"), 0) {
        return false;
    }
    !is_array_longer(&field(agent, "modelRefs"), 1)
}

/// `isProviderModelAvailable`.
fn available(model: &Value) -> bool {
    !truthy(model) || !(is_plain(model) || model.is_array()) || field(model, "available") != Value::Bool(false)
}

/// `findVariantKey(variants, variant)`.
fn variant_key(variants: &Value, variant: &Value) -> Option<String> {
    let wanted = variant.as_str().map(|v| v.trim_matches(js_space).to_lowercase()).unwrap_or_default();
    if !truthy(variants) || wanted.is_empty() {
        return None;
    }
    let keys: Vec<String> = entries(variants).into_iter().map(|(k, _)| k).collect();
    if let Some(exact) = keys.iter().find(|k| Some(k.as_str()) == variant.as_str()) {
        return Some(exact.clone());
    }
    keys.into_iter().find(|k| k.trim_matches(js_space).to_lowercase() == wanted)
}

/// `resolveProviderModelVariant(provider, modelId, variant) ?? null`.
fn resolve_variant(provider: &Value, model_id: &Value, variant: &Value) -> Result<Value, String> {
    let cleaned = variant.as_str().map(|v| v.trim_matches(js_space)).filter(|v| !v.is_empty()).map(str::to_string);
    let fallback = || Ok(cleaned.clone().map_or(Value::Null, Value::String));
    if !truthy(provider) || !truthy(model_id) {
        return fallback();
    }
    let models = field(provider, "models");
    if !models.is_array() {
        return fallback();
    }
    let model = find(&models, "provider.models", |m| Ok(strict_eq(&get(m, "id")?, model_id)))?;
    if !truthy(&model) {
        return fallback();
    }
    let cleaned_value = cleaned.clone().map_or_else(js::undefined, Value::String);
    match variant_key(&field(&model, "variants"), &cleaned_value) {
        Some(key) => Ok(Value::String(key)),
        None => fallback(),
    }
}

/// `provider?.models?.find(predicate)`.
fn find_model(provider: &Value, predicate: impl FnMut(&Value) -> Result<bool, String>) -> Result<Value, String> {
    let models = opt(provider, "models");
    if nullish(&models) {
        return Ok(js::undefined());
    }
    if !models.is_array() {
        return Err("provider?.models?.find is not a function".into()); // recorded-literal: V8 TypeError text
    }
    find(&models, "provider.models", predicate)
}

/// `{ ...value }` of a truthy value, as an ordered map.
fn spread(value: &Value) -> Map<String, Value> {
    entries(value).into_iter().collect()
}

/// Port of `findAgentDefaultOverride` (`agentDefaultResolution.ts:33`).
pub fn find_agent_default_override(selections: Value, agent_name: Value) -> Result<Value, String> {
    Ok(find_override(&selections, &agent_name))
}

/// Port of `isSingleModelAgentDefault` (`agentDefaultResolution.ts:42`).
pub fn is_single_model_agent_default(agent: Value) -> Result<bool, String> {
    Ok(single_model(&agent))
}

/// Port of `resolveAgentDefaultSelection` (`agentDefaultResolution.ts:49`).
pub fn resolve_agent_default_selection(arg0: Value) -> Result<Value, String> {
    if nullish(&arg0) {
        let kind = if arg0.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property 'agentName' of '{kind}' as it is {kind}.")); // recorded-literal: V8 TypeError text
    }
    let wanted = clean(&field(&arg0, "agentName")).to_lowercase();
    let agent = find(&field(&arg0, "agents"), "agents", |e| Ok(clean(&get(e, "name")?).to_lowercase() == wanted))?;
    if !truthy(&agent) {
        return Ok(Value::Null);
    }
    let model = opt(&agent, "model");
    let host_provider = clean(&opt(&model, "providerID"));
    let host_model = clean(&opt(&model, "modelID"));
    if host_provider.is_empty() || host_model.is_empty() {
        return Ok(Value::Null);
    }
    let single = single_model(&agent);
    let personal = if single {
        find_override(&field(&arg0, "personalSelections"), &field(&agent, "name"))
    } else {
        Value::Null
    };
    let mut candidate = if truthy(&personal) {
        let mut c = spread(&personal);
        c.insert("variant".into(), or_null(clean(&field(&personal, "variant"))));
        c.insert("source".into(), Value::String("personal".into()));
        c
    } else {
        let mut c = Map::new();
        c.insert("providerId".into(), Value::String(host_provider));
        c.insert("modelId".into(), Value::String(host_model));
        c.insert("variant".into(), or_null(clean(&field(&agent, "variant"))));
        let source = if single { "inherited" } else { "host-managed" };
        c.insert("source".into(), Value::String(source.into()));
        c
    };
    let member = |c: &Map<String, Value>, key: &str| c.get(key).cloned().unwrap_or_else(js::undefined);
    let provider_id = member(&candidate, "providerId");
    let model_id = member(&candidate, "modelId");
    let variant = member(&candidate, "variant");
    let provider = find(&field(&arg0, "providers"), "providers", |e| Ok(strict_eq(&get(e, "id")?, &provider_id)))?;
    let candidate_model = find_model(&provider, |m| Ok(strict_eq(&get(m, "id")?, &model_id)))?;
    if opt(&candidate_model, "unavailableReason").as_str() == Some("auth_type_unsupported") {
        let fallback = find_model(&provider, |m| Ok(available(m)))?;
        if truthy(&fallback) {
            let fallback_id = field(&fallback, "id");
            let mut out = Map::new();
            out.insert("providerId".into(), provider_id);
            out.insert("variant".into(), resolve_variant(&provider, &fallback_id, &variant)?);
            out.insert("modelId".into(), fallback_id);
            out.insert("source".into(), Value::String("availability-fallback".into()));
            out.insert("agentName".into(), field(&agent, "name"));
            let order = ["providerId", "modelId", "variant", "source", "agentName"];
            return Ok(Value::Object(order.iter().map(|k| ((*k).to_string(), out[*k].clone())).collect()));
        }
    }
    candidate.insert("variant".into(), resolve_variant(&provider, &model_id, &variant)?);
    candidate.insert("agentName".into(), field(&agent, "name"));
    Ok(Value::Object(candidate))
}
