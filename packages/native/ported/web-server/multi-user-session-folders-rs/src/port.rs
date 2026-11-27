//! The Rust port of `multi-user/session-folders.js`. Every refusal is a product `Error` whose
//! message must match (the `statusCode` 400/413 property does not cross the bindings). Checks run
//! in the source's order; `Number()` is the full JS conversion (`null` and `""` are 0); the size
//! check uses `JSON.stringify` written out.

#![forbid(unsafe_code)]

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::js;

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
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

/// `String(value)` as `Array.prototype.join` prints an element (and `ToPrimitive` an array).
fn join_text(value: &Value) -> String {
    if let Some(units) = js::string_units(value) {
        return String::from_utf16_lossy(&units);
    }
    match value {
        Value::Null => String::new(),
        _ if js::is_undefined(value) => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items.iter().map(join_text).collect::<Vec<_>>().join(","),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    }
}

/// JS `ToNumber(value)` (an object is NaN, an array its joined text).
fn to_num(value: &Value) -> f64 {
    if let Some(n) = js::as_number(value) {
        return n;
    }
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::String(s) => string_number(s),
        Value::Array(_) => string_number(&join_text(value)),
        _ => f64::NAN,
    }
}

fn quote(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

fn single<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().filter(|o| o.len() == 1).and_then(|o| o.get(key))
}

/// `JSON.stringify(value)`; `None` for `undefined`.
fn stringify(value: &Value) -> Result<Option<String>, String> {
    if js::is_undefined(value) {
        return Ok(None);
    }
    if let Some(units) = js::string_units(value) {
        return Ok(Some(quote(&units)));
    }
    if let Some(n) = js::as_number(value) {
        return Ok(Some(if n.is_finite() { js::number_to_string(n) } else { "null".into() }));
    }
    if single(value, "$bigint").is_some() {
        return Err("Do not know how to serialize a BigInt".into()); // recorded-literal: V8 TypeError text
    }
    Ok(Some(match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(stringify(item)?.unwrap_or_else(|| "null".into()));
            }
            format!("[{}]", parts.join(","))
        }
        Value::Object(o) => {
            if let Some(date) = single(value, "$date") {
                return Ok(Some(match date.as_str() {
                    Some("Invalid") | None => "null".into(),
                    Some(iso) => quote(&iso.encode_utf16().collect::<Vec<_>>()),
                }));
            }
            if single(value, "$map").is_some() || single(value, "$set").is_some() {
                return Ok(Some("{}".into()));
            }
            let pairs: Vec<(String, Value)> = match single(value, "$bytes").and_then(Value::as_array) {
                Some(bytes) => bytes.iter().enumerate().map(|(i, b)| (i.to_string(), b.clone())).collect(),
                None => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            };
            let mut parts = Vec::new();
            for (k, v) in pairs {
                if let Some(text) = stringify(&v)? {
                    parts.push(format!("{}:{text}", quote(&k.encode_utf16().collect::<Vec<_>>())));
                }
            }
            format!("{{{}}}", parts.join(","))
        }
        _ => return Ok(None),
    }))
}

fn utf8_len(units: &[u16]) -> usize {
    char::decode_utf16(units.iter().copied()).map(|c| c.map_or(3, char::len_utf8)).sum()
}

fn typeof_object(value: &Value) -> bool {
    (value.is_object() || value.is_array()) && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn object_not_array(value: &Value) -> bool {
    truthy(value) && typeof_object(value) && !value.is_array()
}

fn required(value: &Value, label: &str, max: usize) -> Result<Value, String> {
    match js::string_units(value) {
        Some(units) if units.len() <= max && units.iter().any(|u| !char::from_u32(u32::from(*u)).is_some_and(js_space)) => Ok(value.clone()),
        _ => Err(format!("{label} must be a non-empty string no longer than {max} characters")),
    }
}

/// `Number(value)`, finite and non-negative, or the refusal.
fn non_negative(value: &Value, message: &str) -> Result<Value, String> {
    let n = if js::is_undefined(value) { f64::NAN } else { to_num(value) };
    if !n.is_finite() || n < 0.0 {
        return Err(message.into());
    }
    Ok(js::number(n))
}

/// Port of `emptySessionFolders` (`multi-user/session-folders.js:7`).
pub fn empty_session_folders() -> Result<Value, String> {
    Ok(json!({ "version": 1, "foldersMap": {}, "collapsedFolderIds": [], "updatedAt": 0 }))
}

/// Port of `normalizeSessionFoldersPayload` (`multi-user/session-folders.js:23`).
pub fn normalize_session_folders_payload(value: Value) -> Result<Value, String> {
    if !object_not_array(&value) {
        return Err("Session folders payload must be an object".into());
    }
    let serialized = stringify(&value)?.unwrap_or_default();
    if utf8_len(&serialized.encode_utf16().collect::<Vec<_>>()) > 4 * 1024 * 1024 {
        return Err("Session folders payload is too large".into());
    }
    if js::as_number(&field(&value, "version")).filter(|_| field(&value, "version").is_number() || field(&value, "version").get("$num").is_some()) != Some(1.0)
    {
        return Err("Unsupported session folders version".into());
    }
    let folders_map = field(&value, "foldersMap");
    if !object_not_array(&folders_map) {
        return Err("foldersMap must be an object".into());
    }
    let Value::Array(collapsed) = field(&value, "collapsedFolderIds") else {
        return Err("collapsedFolderIds must be an array".into());
    };
    let scopes: Vec<(String, Value)> = plain(&folders_map)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    if scopes.len() > 200 {
        return Err("Too many session folder scopes".into());
    }
    let mut out_map = Map::new();
    for (scope, folders) in scopes {
        required(&Value::String(scope.clone()), "Session folder scope", 1_024)?;
        let Value::Array(list) = folders.clone() else {
            return Err("Each session folder scope must contain a bounded folder array".into());
        };
        if list.len() > 1_000 {
            return Err("Each session folder scope must contain a bounded folder array".into());
        }
        let mut normalized_list = Vec::with_capacity(list.len());
        for folder in &list {
            if !object_not_array(folder) {
                return Err("Each session folder must be an object".into());
            }
            let Value::Array(ids) = field(folder, "sessionIds") else {
                return Err("Each session folder must contain a bounded sessionIds array".into());
            };
            if ids.len() > 10_000 {
                return Err("Each session folder must contain a bounded sessionIds array".into());
            }
            let created = non_negative(&field(folder, "createdAt"), "Session folder createdAt must be a non-negative number")?;
            let mut normalized = Map::new();
            normalized.insert("id".into(), required(&field(folder, "id"), "Session folder id", 256)?);
            normalized.insert("name".into(), required(&field(folder, "name"), "Session folder name", 512)?);
            let mut session_ids = Vec::with_capacity(ids.len());
            for id in &ids {
                session_ids.push(required(id, "Session id", 512)?);
            }
            normalized.insert("sessionIds".into(), Value::Array(session_ids));
            normalized.insert("createdAt".into(), created);
            let parent = field(folder, "parentId");
            if parent.is_null() {
                normalized.insert("parentId".into(), Value::Null);
            } else if !js::is_undefined(&parent) {
                normalized.insert("parentId".into(), required(&parent, "Session folder parent id", 256)?);
            }
            normalized_list.push(Value::Object(normalized));
        }
        out_map.insert(scope, Value::Array(normalized_list));
    }
    if collapsed.len() > 10_000 {
        return Err("Too many collapsed session folders".into());
    }
    let updated = non_negative(&field(&value, "updatedAt"), "Session folders updatedAt must be a non-negative number")?;
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for id in &collapsed {
        let v = required(id, "Collapsed session folder id", 256)?;
        if seen.insert(js::string_units(&v).unwrap_or_default()) {
            ids.push(v);
        }
    }
    Ok(json!({ "version": 1, "foldersMap": out_map, "collapsedFolderIds": ids, "updatedAt": updated }))
}
