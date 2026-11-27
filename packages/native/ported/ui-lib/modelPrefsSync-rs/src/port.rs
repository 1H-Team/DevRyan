//! The Rust port of `modelPrefsSync.ts`, over any JS value: `a === b` (two JSON arguments are
//! never one reference), `.length`, index reads and `.map` as V8 does them, and `>` as the JS
//! abstract relational comparison (two strings compare by UTF-16 code units, else `ToNumber`).

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
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

/// JS `Number(text)`.
fn string_number(text: &str) -> f64 {
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |acc, c| c.to_digit(radix).map(|d| acc * f64::from(radix) + f64::from(d)))
                .unwrap_or(f64::NAN);
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let (mantissa, exponent) = body.split_once(['e', 'E']).unwrap_or((body, "0"));
    let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if (int.is_empty() && frac.is_empty()) || !digits(int) || !digits(frac) || exponent.is_empty() || !digits(exponent) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(value)` for an array element joined by `Array.prototype.join`.
fn join_text(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => String::new(),
        _ if js::is_undefined(value) => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(join_text).collect::<Option<Vec<_>>>()?.join(","),
        Value::Number(_) | Value::Object(_) => js::number_to_string(js::as_number(value)?),
    })
}

/// `ToPrimitive(value)` for `<`/`>`: text, or a number.
enum Primitive {
    Text(Vec<u16>),
    Number(f64),
}

fn to_primitive(value: &Value) -> Primitive {
    if let Some(units) = js::string_units(value) {
        return Primitive::Text(units);
    }
    match value {
        Value::Array(_) => Primitive::Text(join_text(value).unwrap_or_default().encode_utf16().collect()),
        Value::Object(_) if js::as_number(value).is_none() && !js::is_undefined(value) => Primitive::Text("[object Object]".encode_utf16().collect()),
        Value::Null => Primitive::Number(0.0),
        Value::Bool(flag) => Primitive::Number(f64::from(u8::from(*flag))),
        _ => Primitive::Number(js::as_number(value).unwrap_or(f64::NAN)),
    }
}

fn primitive_number(p: Primitive) -> f64 {
    match p {
        Primitive::Number(n) => n,
        Primitive::Text(units) => string_number(&String::from_utf16_lossy(&units)),
    }
}

/// JS `a > b`.
fn greater(a: &Value, b: &Value) -> bool {
    match (to_primitive(a), to_primitive(b)) {
        (Primitive::Text(x), Primitive::Text(y)) => x > y,
        (x, y) => primitive_number(x) > primitive_number(y),
    }
}

/// `value.length`.
fn length(value: &Value) -> Result<Value, String> {
    if let Some(units) = js::string_units(value) {
        return Ok(js::number(units.len() as f64));
    }
    match value {
        Value::Array(items) => Ok(js::number(items.len() as f64)),
        _ => get(value, "length"),
    }
}

/// `value[i]`.
fn index(value: &Value, i: usize) -> Value {
    if let Some(units) = js::string_units(value) {
        return units.get(i).map_or_else(js::undefined, |u| js::utf16_string(&[*u]));
    }
    match value {
        Value::Array(items) => items.get(i).cloned().unwrap_or_else(js::undefined),
        _ => field(value, &i.to_string()),
    }
}

fn refs_equal(a: &Value, b: &Value) -> Result<bool, String> {
    if strict_eq(a, b) {
        return Ok(true);
    }
    let (la, lb) = (length(a)?, length(b)?);
    if !strict_eq(&la, &lb) {
        return Ok(false);
    }
    let mut i = 0usize;
    while greater(&la, &js::number(i as f64)) {
        let (x, y) = (index(a, i), index(b, i));
        if !strict_eq(&opt(&x, "providerID"), &opt(&y, "providerID")) || !strict_eq(&opt(&x, "modelID"), &opt(&y, "modelID")) {
            return Ok(false);
        }
        i += 1;
    }
    Ok(true)
}

/// `refs.map((ref) => ({ providerID: ref.providerID, modelID: ref.modelID }))`.
fn clone_refs(refs: &Value) -> Result<Value, String> {
    let Value::Array(items) = refs else {
        get(refs, "map")?;
        return Err("refs.map is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(json!({ "providerID": get(item, "providerID")?, "modelID": get(item, "modelID")? }));
    }
    Ok(Value::Array(out))
}

fn changed_keys(baseline: &Value, current: &Value) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    for key in ["favoriteModels", "hiddenModels"] {
        if !refs_equal(&get(baseline, key)?, &get(current, key)?)? {
            changed.push(key.to_string());
        }
    }
    Ok(changed)
}

fn resolve_list(baseline: &Value, current: &Value, incoming: &Value, list: &str, stamp: &str) -> Result<(Value, Value), String> {
    if !refs_equal(&get(baseline, list)?, &get(current, list)?)? {
        return Ok((get(current, list)?, get(current, stamp)?));
    }
    let incoming_stamp = get(incoming, stamp)?;
    let current_stamp = get(current, stamp)?;
    let current_list = || get(current, list);
    if greater(&incoming_stamp, &current_stamp) {
        return Ok((get(incoming, list)?, incoming_stamp));
    }
    if greater(&current_stamp, &incoming_stamp) {
        return Ok((current_list()?, current_stamp));
    }
    let zero = js::number(0.0);
    if strict_eq(&incoming_stamp, &zero) && strict_eq(&length(&get(incoming, list)?)?, &zero) && greater(&length(&current_list()?)?, &zero) {
        return Ok((current_list()?, current_stamp));
    }
    if strict_eq(&incoming_stamp, &current_stamp) && greater(&length(&current_list()?)?, &zero) && !refs_equal(&get(incoming, list)?, &current_list()?)? {
        return Ok((current_list()?, current_stamp));
    }
    Ok((get(incoming, list)?, incoming_stamp))
}

/// Port of `modelRefsEqual` (`modelPrefsSync.ts:17`).
pub fn model_refs_equal(a: Value, b: Value) -> Result<bool, String> {
    refs_equal(&a, &b)
}

/// Port of `createModelPrefsBaseline` (`modelPrefsSync.ts:28`).
pub fn create_model_prefs_baseline(snapshot: Value) -> Result<Value, String> {
    let mut out = Map::new();
    out.insert("favoriteModels".into(), clone_refs(&get(&snapshot, "favoriteModels")?)?);
    out.insert("favoriteModelsUpdatedAt".into(), get(&snapshot, "favoriteModelsUpdatedAt")?);
    out.insert("hiddenModels".into(), clone_refs(&get(&snapshot, "hiddenModels")?)?);
    out.insert("hiddenModelsUpdatedAt".into(), get(&snapshot, "hiddenModelsUpdatedAt")?);
    Ok(Value::Object(out))
}

/// Port of `getChangedModelPrefsKeys` (`modelPrefsSync.ts:35`).
pub fn get_changed_model_prefs_keys(baseline: Value, current: Value) -> Result<Vec<String>, String> {
    changed_keys(&baseline, &current)
}

/// Port of `modelPrefsEqual` (`modelPrefsSync.ts:49`).
pub fn model_prefs_equal(a: Value, b: Value) -> Result<bool, String> {
    Ok(changed_keys(&a, &b)?.is_empty())
}

/// Port of `resolveModelPrefsFromSettingsSnapshot` (`modelPrefsSync.ts:54`).
pub fn resolve_model_prefs_from_settings_snapshot(arg0: Value) -> Result<Value, String> {
    if nullish(&arg0) {
        let kind = if arg0.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property 'baseline' of '{kind}' as it is {kind}.")); // recorded-literal: V8 TypeError text
    }
    let (baseline, current, incoming) = (field(&arg0, "baseline"), field(&arg0, "current"), field(&arg0, "incoming"));
    let (favorite, favorite_at) = resolve_list(&baseline, &current, &incoming, "favoriteModels", "favoriteModelsUpdatedAt")?;
    let (hidden, hidden_at) = resolve_list(&baseline, &current, &incoming, "hiddenModels", "hiddenModelsUpdatedAt")?;
    let mut out = Map::new();
    out.insert("favoriteModels".into(), favorite);
    out.insert("favoriteModelsUpdatedAt".into(), favorite_at);
    out.insert("hiddenModels".into(), hidden);
    out.insert("hiddenModelsUpdatedAt".into(), hidden_at);
    Ok(Value::Object(out))
}
