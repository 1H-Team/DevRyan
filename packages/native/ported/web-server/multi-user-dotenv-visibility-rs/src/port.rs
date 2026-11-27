//! The Rust port of `multi-user/dotenv-visibility.js` (3 of 4; the middleware works on
//! `req`/`res`). Over UTF-16 units: JS `trim`, `decodeURIComponent` (strict UTF-8; a malformed
//! escape leaves the whole string undecoded, as the `catch` does), `\` -> `/`, NULs removed,
//! trailing slashes dropped, then the lowercased basename is `.env` or starts with `.env.`.
//! Filtering keeps JS semantics: a `Map`/`Set`/`Date` is an object with no entries (`{}`).

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn space(u: u16) -> bool {
    matches!(u, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim(u: &[u16]) -> &[u16] {
    let start = u.iter().position(|c| !space(*c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !space(*c)).map_or(start, |i| i + 1);
    &u[start..end]
}

fn hex(u: u16) -> Option<u8> {
    char::from_u32(u32::from(u)).and_then(|c| c.to_digit(16)).and_then(|d| u8::try_from(d).ok())
}

/// `decodeURIComponent`; `None` where it throws `URIError`.
fn decode(s: &[u16]) -> Option<Vec<u16>> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    let byte_at = |i: usize| -> Option<u8> {
        (s.get(i) == Some(&u16::from(b'%'))).then_some(())?;
        Some(hex(*s.get(i + 1)?)? * 16 + hex(*s.get(i + 2)?)?)
    };
    while i < s.len() {
        if s[i] != u16::from(b'%') {
            out.push(s[i]);
            i += 1;
            continue;
        }
        let first = byte_at(i)?;
        let n = match first {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        let mut bytes = vec![first];
        for k in 1..n {
            bytes.push(byte_at(i + 3 * k).filter(|b| b & 0xc0 == 0x80)?);
        }
        out.extend(std::str::from_utf8(&bytes).ok()?.encode_utf16());
        i += 3 * n;
    }
    Some(out)
}

fn protected(value: &Value) -> bool {
    let Some(units) = js::string_units(value) else { return false };
    if trim(&units).is_empty() {
        return false;
    }
    let raw = trim(&units).to_vec();
    let decoded = decode(&raw).unwrap_or(raw);
    let mut path: Vec<u16> = decoded
        .iter()
        .filter(|u| **u != 0)
        .map(|u| if *u == u16::from(b'\\') { u16::from(b'/') } else { *u })
        .collect();
    while path.last() == Some(&u16::from(b'/')) {
        path.pop();
    }
    let base_start = path.iter().rposition(|u| *u == u16::from(b'/')).map_or(0, |i| i + 1);
    let base = String::from_utf16_lossy(&path[base_start..]).to_lowercase();
    base == ".env" || base.starts_with(".env.")
}

fn is_typeof_object(value: &Value) -> bool {
    (value.is_object() || value.is_array()) && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn marker(value: &Value) -> Option<&str> {
    value
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.keys().next())
        .map(String::as_str)
        .filter(|k| k.starts_with('$'))
}

fn get(value: &Value, key: &str) -> Value {
    if marker(value).is_some() {
        return js::undefined();
    }
    value.as_object().and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn referenced(value: &Value) -> bool {
    if !is_typeof_object(value) || value.is_array() {
        return false;
    }
    let path = get(value, "path");
    let opt = |v: &Value, k: &str| if v.is_null() || js::is_undefined(v) { js::undefined() } else { get(v, k) };
    let candidates = [
        path.clone(),
        get(value, "file"),
        get(value, "filePath"),
        get(value, "name"),
        get(value, "absolute"),
        get(value, "uri"),
        get(value, "oldPath"),
        get(value, "newPath"),
        get(value, "oldFileName"),
        get(value, "newFileName"),
        opt(&path, "text"),
        opt(&get(value, "location"), "uri"),
    ];
    candidates.iter().any(protected)
}

fn filter(value: &Value) -> Value {
    if let Value::Array(items) = value {
        return Value::Array(items.iter().filter(|e| !protected(e) && !referenced(e)).map(filter).collect());
    }
    if !is_typeof_object(value) || value.is_null() {
        return value.clone();
    }
    let entries: Vec<(String, Value)> = match marker(value) {
        Some("$bytes") => value["$bytes"]
            .as_array()
            .map(|b| b.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect())
            .unwrap_or_default(),
        Some(_) => Vec::new(),
        None => value
            .as_object()
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default(),
    };
    let mut out = Map::new();
    for (k, v) in entries {
        if protected(&Value::String(k.clone())) {
            continue;
        }
        out.insert(k, filter(&v));
    }
    Value::Object(out)
}

/// Port of `isProtectedDotenvPath` (`multi-user/dotenv-visibility.js:39`).
pub fn is_protected_dotenv_path(value: Value) -> Result<Value, String> {
    Ok(Value::Bool(protected(&value)))
}

/// Port of `shouldHideProtectedDotenv` (`multi-user/dotenv-visibility.js:46`).
pub fn should_hide_protected_dotenv(principal: Value) -> Result<Value, String> {
    let read = |k: &str| {
        if principal.is_null() || js::is_undefined(&principal) {
            js::undefined()
        } else {
            get(&principal, k)
        }
    };
    Ok(Value::Bool(
        read("scope").as_str() == Some("managed") && matches!(read("role").as_str(), Some("developer" | "senior_developer")),
    ))
}

/// Port of `filterProtectedDotenvReferences` (`multi-user/dotenv-visibility.js:71`).
pub fn filter_protected_dotenv_references(value: Value) -> Result<Value, String> {
    Ok(filter(&value))
}
