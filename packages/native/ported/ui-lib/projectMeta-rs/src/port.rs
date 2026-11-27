//! The Rust port of `projectMeta.ts`: `getProjectIconImageUrl` (the rest is icon and colour
//! tables). `URLSearchParams` serializes as `application/x-www-form-urlencoded` (UTF-8, space as
//! `+`, lone surrogates as U+FFFD); `encodeURIComponent` throws `URIError` on a lone surrogate.
//! Quirk kept: a NaN `updatedAt` passes the `<= 0` check and prints `v=NaN`.

#![forbid(unsafe_code)]

use serde_json::Value;

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

/// JS `String(value)` as UTF-16 code units (`element` for an array member: `null`/`undefined`
/// print empty).
fn js_string(value: &Value, element: bool) -> Vec<u16> {
    if let Some(units) = js::string_units(value) {
        return units;
    }
    let single = |key: &str| value.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(key));
    let text = match value {
        _ if js::is_undefined(value) => {
            if element {
                String::new()
            } else {
                "undefined".into()
            }
        }
        Value::Null => {
            if element {
                String::new()
            } else {
                "null".into()
            }
        }
        Value::Bool(flag) => flag.to_string(),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(|v| String::from_utf16_lossy(&js_string(v, true))).collect();
            parts.join(",")
        }
        _ if single("$map") => "[object Map]".into(),
        _ if single("$set") => "[object Set]".into(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    text.encode_utf16().collect()
}

fn percent(out: &mut String, bytes: &[u8]) {
    for b in bytes {
        out.push_str(&format!("%{b:02X}"));
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(units: &[u16]) -> Result<String, String> {
    let mut out = String::new();
    for item in char::decode_utf16(units.iter().copied()) {
        let c = item.map_err(|_| "URI malformed".to_string())?; // recorded-literal: V8 URIError text
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            percent(&mut out, c.encode_utf8(&mut buf).as_bytes());
        }
    }
    Ok(out)
}

/// The form-urlencoded serializer of `URLSearchParams`.
fn form_encode(units: &[u16]) -> String {
    let mut out = String::new();
    for c in String::from_utf16_lossy(units).chars() {
        if c.is_ascii_alphanumeric() || "*-._".contains(c) {
            out.push(c);
        } else if c == ' ' {
            out.push('+');
        } else {
            let mut buf = [0u8; 4];
            percent(&mut out, c.encode_utf8(&mut buf).as_bytes());
        }
    }
    out
}

fn trimmed_units(units: &[u16]) -> Vec<u16> {
    let space = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(js_space);
    let Some(start) = units.iter().position(|u| !space(u)) else {
        return Vec::new();
    };
    let end = units.iter().rposition(|u| !space(u)).map_or(start, |i| i + 1);
    units[start..end].to_vec()
}

/// Port of `getProjectIconImageUrl` (`projectMeta.ts:69`).
pub fn get_project_icon_image_url(project: Value, options: Value) -> Result<Option<String>, String> {
    let image = get(&project, "iconImage")?;
    let updated = if truthy(&image) { field(&image, "updatedAt") } else { js::undefined() };
    let stamp = match &updated {
        Value::Number(_) => js::as_number(&updated),
        Value::Object(_) if js::string_units(&updated).is_none() => js::as_number(&updated),
        _ => None,
    };
    let Some(stamp) = stamp.filter(|s| s.is_nan() || *s > 0.0) else {
        return Ok(None);
    };
    let mut query = format!("v={}", form_encode(&js::number_to_string(stamp).encode_utf16().collect::<Vec<_>>()));
    let color = opt(&options, "iconColor");
    if let Some(units) = js::string_units(&color) {
        let trimmed = trimmed_units(&units);
        if !trimmed.is_empty() {
            query.push_str(&format!("&iconColor={}", form_encode(&trimmed)));
        }
    }
    if let Some(theme) = opt(&options, "themeVariant").as_str().filter(|t| *t == "light" || *t == "dark") {
        query.push_str(&format!("&theme={theme}"));
    }
    let id = encode_uri_component(&js_string(&field(&project, "id"), false))?;
    Ok(Some(format!("/api/projects/{id}/icon?{query}")))
}
