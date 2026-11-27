//! The Rust port of `opencode/runtime-host/native-helper-contract.js`: the helper and title-helper
//! constructor validators. Checks run in the source's order, so a non-string `directory` reaches
//! Node's `path.isAbsolute` (a `TypeError`) only when the earlier checks pass. `path.resolve(d) ===
//! d` holds for an absolute path exactly when it is `/` or every segment is a plain name. Byte
//! bounds count UTF-8 (a lone surrogate is 3 bytes). `Object.freeze` is not observable here.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

#[rustfmt::skip]
const HELPER_KEYS: [&str; 13] = ["operationID", "directory", "sessionID", "agent", "providerID", "modelID", "variant", "selectionMode", "selectionRevision", "prompt", "system", "timeoutMs", "maxOutputTokens"];
const TITLE_KEYS: [&str; 6] = ["operationID", "directory", "sessionID", "title", "expectedTitle", "sourceMessageID"];

/// A plain object accepted by `input && typeof input === 'object' && !Array.isArray(input)` whose
/// keys are all allowed (a `Map`, `Set` or `Date` has none; a typed array its indexes).
fn object(value: &Value, allowed: &[&str]) -> Result<Map<String, Value>, String> {
    let o = value.as_object().ok_or(INVALID)?;
    let o = match o.keys().next().filter(|k| o.len() == 1 && k.starts_with('$')).map(String::as_str) {
        Some("$utf16" | "$num" | "$undefined" | "$function" | "$bigint") => return Err(INVALID.into()),
        Some("$bytes") => value["$bytes"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, b)| (i.to_string(), b.clone()))
            .collect(),
        Some(_) => Map::new(),
        None => o.clone(),
    };
    if o.keys().all(|k| allowed.contains(&k.as_str())) {
        Ok(o)
    } else {
        Err(INVALID.into())
    }
}

const INVALID: &str = "native_helper_input_invalid";

fn units(o: &Map<String, Value>, key: &str) -> Option<Vec<u16>> {
    o.get(key).and_then(js::string_units)
}

fn id(v: Option<Vec<u16>>) -> bool {
    v.is_some_and(|u| (1..=256).contains(&u.len()) && !u.iter().any(|c| *c <= 0x20 || *c == 0x7f))
}

/// `value === undefined || ok(value)`.
fn optional(o: &Map<String, Value>, key: &str, ok: impl Fn(&Value) -> bool) -> bool {
    o.get(key).is_none_or(|v| js::is_undefined(v) || ok(v))
}

fn pattern(v: Option<Vec<u16>>, prefix: &str) -> bool {
    let s = v.and_then(|u| String::from_utf16(&u).ok()).unwrap_or_default();
    s.strip_prefix(prefix)
        .is_some_and(|r| (1..=128).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

/// The `operationID` and `directory` checks both validators start with.
fn scope(o: &Map<String, Value>) -> Result<(), String> {
    let directory = o.get("directory").filter(|d| !d.is_null() && !js::is_undefined(d));
    if !optional(o, "operationID", |v| id(js::string_units(v))) || directory.is_none() {
        return Err(INVALID.into());
    }
    let d = directory.and_then(js::string_units).ok_or("The \"path\" argument must be of type string")?; // recorded-literal: Node's ERR_INVALID_ARG_TYPE text
    let plain = d == [0x2f] || d.split(|u| *u == 0x2f).skip(1).all(|s| !s.is_empty() && s != [0x2e] && s != [0x2e, 0x2e]);
    if d.first() == Some(&0x2f) && plain && !d.contains(&0) {
        Ok(())
    } else {
        Err(INVALID.into())
    }
}

fn blank(u: &[u16]) -> bool {
    u.iter()
        .all(|c| matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff))
}

fn utf8_len(u: &[u16]) -> usize {
    char::decode_utf16(u.iter().copied()).map(|c| c.map_or(3, char::len_utf8)).sum()
}

/// `input[key] ?? fallback` when it is a safe integer in `1..=max`.
fn bounded(o: &Map<String, Value>, key: &str, fallback: f64, max: f64) -> Option<Value> {
    let given = o.get(key).filter(|v| !v.is_null() && !js::is_undefined(v));
    let n = given.map_or(Some(fallback), js::as_number)?;
    (n.fract() == 0.0 && (1.0..=max).contains(&n)).then(|| given.cloned().unwrap_or_else(|| js::number(n)))
}

/// Port of `nativeHelperInput` (`native-helper-contract.js:6`).
pub fn native_helper_input(input: Value) -> Result<Value, String> {
    let mut o = object(&input, &HELPER_KEYS)?;
    scope(&o)?;
    let agent = matches!(
        o.get("agent").and_then(Value::as_str),
        Some("devryan-title" | "devryan-commit" | "devryan-pr" | "devryan-branch" | "devryan-notify")
    );
    let prompt = units(&o, "prompt").is_some_and(|p| !blank(&p) && utf8_len(&p) <= 262_144);
    let ok = optional(&o, "sessionID", |v| pattern(js::string_units(v), "ses"))
        && agent
        && id(units(&o, "providerID"))
        && id(units(&o, "modelID"))
        && optional(&o, "variant", |v| id(js::string_units(v)))
        && optional(&o, "selectionMode", |m| matches!(m.as_str(), Some("configured" | "active")))
        && optional(&o, "selectionRevision", |v| id(js::string_units(v)))
        && prompt
        && optional(&o, "system", |s| js::string_units(s).is_some_and(|u| utf8_len(&u) <= 262_144));
    let (Some(timeout), Some(tokens), true) = (
        bounded(&o, "timeoutMs", 60_000.0, 120_000.0),
        bounded(&o, "maxOutputTokens", 2048.0, 16_384.0),
        ok,
    ) else {
        return Err(INVALID.into());
    };
    o.insert("timeoutMs".into(), timeout);
    o.insert("maxOutputTokens".into(), tokens);
    Ok(Value::Object(o))
}

/// Port of `nativeHelperTitleInput` (`native-helper-contract.js:24`).
pub fn native_helper_title_input(input: Value) -> Result<Value, String> {
    let o = object(&input, &TITLE_KEYS)?;
    scope(&o)?;
    let title = units(&o, "title").is_some_and(|t| !blank(&t) && t.len() <= 80 && !t.iter().any(|c| *c <= 0x1f || *c == 0x7f));
    let ok = pattern(units(&o, "sessionID"), "ses")
        && title
        && units(&o, "expectedTitle").is_some_and(|e| e.len() <= 1024)
        && optional(&o, "sourceMessageID", |v| pattern(js::string_units(v), "msg_"));
    if ok { Ok(Value::Object(o)) } else { Err(INVALID.into()) }
}
