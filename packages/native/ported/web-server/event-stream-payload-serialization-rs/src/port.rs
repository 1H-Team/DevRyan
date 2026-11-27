//! The Rust port of `event-stream/payload-serialization.js`. `JSON.stringify` is written out
//! (NaN and infinities print `null`, `-0` prints `0`, `undefined` members are skipped or `null`
//! in arrays, a `Map`/`Set` prints `{}`, a `Date` its ISO text, lone surrogates `\udXXX`). The
//! module's serialization cache is keyed by object identity: no recorded call can hit it.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

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

fn bytes_of(payload: &Value) -> Result<f64, String> {
    Ok(stringify(payload)?.map_or(0.0, |json| utf8_len(&json.encode_utf16().collect::<Vec<_>>()) as f64))
}

/// Port of `serializeEventPayload` (`event-stream/payload-serialization.js:33`): the JSON text
/// with the connection dialect's leading event type.
pub fn serialize_event_payload(payload: Value, dialect: Value) -> Result<Value, String> {
    let Some(json) = stringify(&payload)? else { return Ok(js::undefined()) };
    let units: Vec<u16> = json.encode_utf16().collect();
    let legacy: Vec<u16> = "{\"type\":\"openchamber:".encode_utf16().collect();
    let devryan: Vec<u16> = "{\"type\":\"devryan:".encode_utf16().collect();
    let (from, to) = if dialect.as_str() == Some("devryan") {
        (legacy, devryan)
    } else {
        (devryan, legacy)
    };
    let Some(rest) = units.strip_prefix(from.as_slice()) else {
        return Ok(js::utf16_string(&units));
    };
    let mut out = to;
    out.extend_from_slice(rest);
    Ok(js::utf16_string(&out))
}

/// Port of `eventPayloadBytes` (`event-stream/payload-serialization.js:36`).
pub fn event_payload_bytes(payload: Value) -> Result<Value, String> {
    Ok(js::number(bytes_of(&payload)?))
}

/// Port of `eventEntryBytes` (`event-stream/payload-serialization.js:39`).
pub fn event_entry_bytes(entry: Value) -> Result<Value, String> {
    let field = |k: &str| {
        if entry.is_null() || js::is_undefined(&entry) || js::string_units(&entry).is_some() {
            return js::undefined();
        }
        entry.as_object().and_then(|o| o.get(k)).cloned().unwrap_or_else(js::undefined)
    };
    let text_bytes = |v: Value| js::string_units(&v).map_or(0.0, |u| utf8_len(&u) as f64);
    Ok(js::number(
        bytes_of(&field("payload"))? + text_bytes(field("directory")) + text_bytes(field("eventId")) + 96.0,
    ))
}
