//! The Rust port of `terminal/project-environment.js` (2 of 3; `loadProjectPublicEnvironment`
//! reads files through the caller's file API and stays in JS). Lines, quotes and comments are
//! handled over UTF-16 units with JS `trim` white space; `String(source)` is written out; a
//! `__proto__` key is a valid identifier whose assignment defines nothing, as in JS.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

const PREFIXES: [&str; 7] = ["VITE_", "NEXT_PUBLIC_", "PUBLIC_", "REACT_APP_", "GATSBY_", "NUXT_PUBLIC_", "EXPO_PUBLIC_"];
const PUBLIC_KEYS: [&str; 3] = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"];
#[rustfmt::skip]
const CREDENTIALS: [&str; 11] = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SERVICE_ROLE_KEY", "SECRET_KEY", "PRIVATE_KEY", "CLIENT_SECRET", "SESSION_SECRET", "JWT_SECRET", "DATABASE_URL", "DIRECT_URL", "PASSWORD"];
const VENDORS: [&str; 8] = ["OPENAI", "ANTHROPIC", "GITHUB", "GITLAB", "STRIPE", "AWS", "CLOUDFLARE", "VERCEL"];
const VENDOR_SECRETS: [&str; 5] = ["API_KEY", "ACCESS_TOKEN", "AUTH_TOKEN", "SECRET", "SECRET_KEY"];

fn space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim(u: &[u16]) -> &[u16] {
    let start = u.iter().position(|c| !space(*c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !space(*c)).map_or(start, |i| i + 1);
    &u[start..end]
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// `String(value)` as UTF-16 units.
fn text(value: &Value) -> Vec<u16> {
    if let Some(u) = js::string_units(value) {
        return u;
    }
    let single = value.as_object().filter(|o| o.len() == 1).and_then(|o| o.keys().next()).map(String::as_str);
    match value {
        Value::Null => units("null"),
        Value::Bool(b) => units(&b.to_string()),
        Value::Array(items) => items
            .iter()
            .map(|v| if v.is_null() || js::is_undefined(v) { Vec::new() } else { text(v) })
            .collect::<Vec<_>>()
            .join(&[0x2c][..]),
        _ if js::is_undefined(value) => units("undefined"),
        _ if single == Some("$map") => units("[object Map]"),
        _ if single == Some("$set") => units("[object Set]"),
        _ if single == Some("$bigint") => units(value["$bigint"].as_str().unwrap_or_default()),
        _ => js::as_number(value).map_or_else(|| units("[object Object]"), |n| units(&js::number_to_string(n))),
    }
}

fn truthy(value: &Value) -> bool {
    if let Some(u) = js::string_units(value) {
        return !u.is_empty();
    }
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ if js::is_undefined(value) => false,
        _ if value.get("$bigint").is_some_and(|b| b.as_str() == Some("0")) && value.as_object().is_some_and(|o| o.len() == 1) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

fn identifier(key: &[u16]) -> bool {
    key.first()
        .is_some_and(|c| u8::try_from(*c).is_ok_and(|b| b.is_ascii_alphabetic() || b == b'_'))
        && key.iter().all(|c| u8::try_from(*c).is_ok_and(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

fn quoted(raw: &[u16], quote: u16) -> Option<Vec<u16>> {
    let (backslash, mut value, mut escaped) = (u16::from(b'\\'), Vec::new(), false);
    for (index, &c) in raw.iter().enumerate().skip(1) {
        if escaped {
            let mapped = match (quote == u16::from(b'"'), u8::try_from(c).ok()) {
                (true, Some(b'n')) => Some(0x0a),
                (true, Some(b'r')) => Some(0x0d),
                (true, Some(b't')) => Some(0x09),
                (true, Some(b'"' | b'\\')) => Some(c),
                (false, _) if c == quote || c == backslash => Some(c),
                _ => None,
            };
            value.extend(mapped.map_or_else(|| vec![backslash, c], |m| vec![m]));
            escaped = false;
        } else if c == backslash {
            escaped = true;
        } else if c == quote {
            let rest = trim(&raw[index + 1..]);
            return (rest.is_empty() || rest[0] == u16::from(b'#')).then_some(value);
        } else {
            value.push(c);
        }
    }
    None
}

/// Port of `parseProjectEnvironment` (`project-environment.js:73`).
pub fn parse_project_environment(source: Value) -> Result<Value, String> {
    let mut all = if truthy(&source) { text(&source) } else { Vec::new() };
    if all.first() == Some(&0xfeff) {
        all.remove(0);
    }
    let mut environment = Map::new();
    for raw_line in all.split(|u| *u == 0x0a) {
        let raw_line = raw_line.strip_suffix(&[0x0d]).unwrap_or(raw_line);
        let mut line = trim(raw_line);
        if line.is_empty() || line[0] == u16::from(b'#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix(units("export").as_slice()).filter(|r| r.first().is_some_and(|c| space(*c))) {
            line = &rest[rest.iter().position(|c| !space(*c)).unwrap_or(rest.len())..];
        }
        let Some(separator) = line.iter().position(|u| *u == u16::from(b'=')).filter(|i| *i >= 1) else {
            continue;
        };
        let key = trim(&line[..separator]);
        if !identifier(key) {
            continue;
        }
        let raw = trim(&line[separator + 1..]);
        let value = match raw.first().copied() {
            Some(q) if b"\"'`".iter().any(|b| u16::from(*b) == q) => match quoted(raw, q) {
                Some(v) => v,
                None => continue,
            },
            _ => trim(&raw[..raw.iter().position(|u| *u == u16::from(b'#')).unwrap_or(raw.len())]).to_vec(),
        };
        let key = String::from_utf16_lossy(key);
        if key != "__proto__" {
            environment.insert(key, js::utf16_string(&value));
        }
    }
    Ok(Value::Object(environment))
}

/// Port of `isBrowserPublicProjectEnvironmentKey` (`project-environment.js:105`).
pub fn is_browser_public_project_environment_key(key: Value) -> Result<Value, String> {
    let Some(units) = js::string_units(&key).filter(|u| identifier(u)) else {
        return Ok(false.into());
    };
    let key = String::from_utf16_lossy(&units);
    let bounded = |word: &str| key == word || key.ends_with(&format!("_{word}"));
    let vendor = VENDORS.iter().any(|v| VENDOR_SECRETS.iter().any(|s| bounded(&format!("{v}_{s}"))));
    if CREDENTIALS.iter().any(|w| bounded(w)) || vendor {
        return Ok(false.into());
    }
    Ok((PUBLIC_KEYS.contains(&key.as_str()) || PREFIXES.iter().any(|p| key.starts_with(p))).into())
}
