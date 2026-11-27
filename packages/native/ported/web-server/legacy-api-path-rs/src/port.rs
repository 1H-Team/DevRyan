//! The Rust port of `legacy-api-path.js`: `canonicalApiUrl` (the rewrite middleware mutates
//! `req` and stays in JavaScript). Strings are handled as UTF-16 units.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// Port of `canonicalApiUrl` (`legacy-api-path.js:11`): `/api/openchamber[/?…]` becomes
/// `/api/devryan[/?…]`; anything else comes back unchanged.
pub fn canonical_api_url(url: Value) -> Result<Value, String> {
    let Some(units) = js::string_units(&url) else { return Ok(url) };
    let legacy: Vec<u16> = "/api/openchamber".encode_utf16().collect();
    let Some(rest) = units.strip_prefix(legacy.as_slice()) else { return Ok(url) };
    if rest.first().is_some_and(|&c| c != u16::from(b'/') && c != u16::from(b'?')) {
        return Ok(url);
    }
    let mut out: Vec<u16> = "/api/devryan".encode_utf16().collect();
    out.extend_from_slice(rest);
    Ok(js::utf16_string(&out))
}
