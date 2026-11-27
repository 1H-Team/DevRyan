//! The Rust port of `opencode/runtime-host/native-observation-contract.js`: its own
//! `parseNativePresentation` (the four re-exports are `shared-runtime`'s). `structuredClone` of a
//! value that passed the checks is a deep copy of plain JSON data, so the value is returned as
//! given. `configurationDigest` is tested with `RegExp#test`, which reads `String(value)`: an
//! array of 64 hex digits passes too, as in JS.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

const KEYS: [&str; 12] = [
    "schema",
    "controllerInstanceID",
    "configurationDigest",
    "sessionID",
    "directory",
    "requestID",
    "assistantMessageID",
    "stepID",
    "attempt",
    "phase",
    "progress",
    "sequence",
];
const INVALID: &str = "native_presentation_invalid";

/// A plain object (a `Map`, `Set`, `Date` or typed array has no own keys here but is an object).
fn object(value: &Value) -> Option<Map<String, Value>> {
    let single = value
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.keys().next())
        .filter(|k| k.starts_with('$'));
    match single.map(String::as_str) {
        Some("$utf16" | "$num" | "$undefined" | "$function" | "$bigint") => None,
        Some("$bytes") => Some(
            value["$bytes"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(i, b)| (i.to_string(), b.clone()))
                .collect(),
        ),
        Some(_) => Some(Map::new()),
        None => value.as_object().cloned(),
    }
}

/// `/^[A-Za-z0-9_.:/-]{1,256}$/` on a string.
fn id(value: Option<&Value>) -> bool {
    value.and_then(js::string_units).is_some_and(|u| {
        (1..=256).contains(&u.len())
            && u.iter()
                .all(|c| u8::try_from(*c).is_ok_and(|b| b.is_ascii_alphanumeric() || b"_.:/-".contains(&b)))
    })
}

/// `String(value)` for the digest test (only text or an array can spell 64 hex digits).
fn text(value: &Value) -> Option<String> {
    if let Some(units) = js::string_units(value) {
        return Some(String::from_utf16_lossy(&units));
    }
    match value {
        Value::Array(items) => items
            .iter()
            .map(|v| if v.is_null() || js::is_undefined(v) { Some(String::new()) } else { text(v) })
            .collect::<Option<Vec<_>>>()
            .map(|p| p.join(",")),
        _ => None,
    }
}

fn safe_int(value: Option<&Value>) -> Option<f64> {
    value.and_then(js::as_number).filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

fn valid(value: &Value) -> bool {
    let Some(o) = object(value) else { return false };
    if o.len() != KEYS.len() || KEYS.iter().any(|k| !o.contains_key(*k)) || js::as_number(&o["schema"]) != Some(1.0) {
        return false;
    }
    if !["controllerInstanceID", "sessionID", "requestID", "assistantMessageID", "stepID"]
        .iter()
        .all(|k| id(o.get(*k)))
    {
        return false;
    }
    let digest = &o["configurationDigest"];
    let digest = if digest.is_null() || js::is_undefined(digest) {
        Some(String::new())
    } else {
        text(digest)
    };
    if !digest.is_some_and(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
        return false;
    }
    let Some(directory) = js::string_units(&o["directory"]) else { return false };
    if directory.first() != Some(&0x2f) || directory.len() > 4096 || directory.iter().any(|u| matches!(u, 0 | 0x0a | 0x0d)) {
        return false;
    }
    let Some(attempt) = object(&o["attempt"]) else { return false };
    if attempt.len() != 2 || !id(attempt.get("traceID")) || !id(attempt.get("spanID")) {
        return false;
    }
    matches!(o["phase"].as_str(), Some("finalizing" | "cleared"))
        && safe_int(o.get("progress")).is_some_and(|n| n >= 0.0)
        && safe_int(o.get("sequence")).is_some_and(|n| n >= 1.0)
}

/// Port of `parseNativePresentation` (`native-observation-contract.js:4`).
pub fn parse_native_presentation(value: Value) -> Result<Value, String> {
    if valid(&value) { Ok(value) } else { Err(INVALID.into()) }
}
