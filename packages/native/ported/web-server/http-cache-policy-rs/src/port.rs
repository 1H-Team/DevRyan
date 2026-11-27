//! The Rust port of `http-cache-policy.js`: `shouldDisableHttpCache` (the header writer and the
//! middleware act on `req`/`res` and stay in JavaScript). Strings compare as UTF-16 units, so a
//! URL with a lone surrogate still matches its prefix.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Port of `shouldDisableHttpCache` (`http-cache-policy.js:5`).
pub fn should_disable_http_cache(original_url: Value) -> Result<Value, String> {
    let Some(url) = js::string_units(&original_url) else {
        return Ok(Value::Bool(false));
    };
    Ok(Value::Bool(
        url == units("/health") || url.starts_with(&units("/health?")) || url.starts_with(&units("/api/")),
    ))
}
