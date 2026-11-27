//! The Rust port of `event-stream/event-dialect.js`: `applyEventDialect` (`resolveEventDialect`
//! parses `req.url` with the WHATWG URL parser and stays in JavaScript). UTF-16 units.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// Port of `applyEventDialect` (`event-stream/event-dialect.js:28`).
pub fn apply_event_dialect(json: Value, dialect: Value) -> Result<Value, String> {
    let Some(units) = js::string_units(&json) else { return Ok(json) };
    let legacy: Vec<u16> = "{\"type\":\"openchamber:".encode_utf16().collect();
    let devryan: Vec<u16> = "{\"type\":\"devryan:".encode_utf16().collect();
    let (from, to) = if dialect.as_str() == Some("devryan") {
        (legacy, devryan)
    } else {
        (devryan, legacy)
    };
    let Some(rest) = units.strip_prefix(from.as_slice()) else { return Ok(json) };
    let mut out = to;
    out.extend_from_slice(rest);
    Ok(js::utf16_string(&out))
}
