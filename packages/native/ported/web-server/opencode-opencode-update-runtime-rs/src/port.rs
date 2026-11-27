//! The Rust port of `opencode/opencode-update-runtime.js`. `$` (no `m` flag) is the end of the
//! string; `?.match` on a non-string throws.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// Port of `openCodeBaseVersion` (`opencode/opencode-update-runtime.js:1`): `X.Y.Z` of
/// `X.Y.Z-devryan.N`, else the value as given.
pub fn open_code_base_version(value: Value) -> Result<Value, String> {
    if value.is_null() || js::is_undefined(&value) {
        return Ok(value);
    }
    let Some(text) = value.as_str() else {
        if js::string_units(&value).is_some() {
            return Ok(value);
        }
        return Err("value?.match is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let Some((base, rest)) = text.split_once("-devryan.") else { return Ok(value) };
    let parts: Vec<&str> = base.split('.').collect();
    if parts.len() == 3 && parts.iter().all(|p| digits(p)) && digits(rest) {
        return Ok(Value::String(base.into()));
    }
    Ok(value)
}
