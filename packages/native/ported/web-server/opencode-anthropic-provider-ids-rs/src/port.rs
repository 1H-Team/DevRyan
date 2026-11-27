//! The Rust port of `opencode/anthropic-provider-ids.js`.

#![forbid(unsafe_code)]

use serde_json::Value;

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Port of `isAnthropicProviderId` (`opencode/anthropic-provider-ids.js:7`).
pub fn is_anthropic_provider_id(provider_id: Value) -> Result<Value, String> {
    let id = provider_id.as_str().map(|s| s.trim_matches(js_space).to_lowercase()).unwrap_or_default();
    Ok(Value::Bool(
        ["anthropic", "claude", "anthropic-oauth", "opencode-with-claude"].contains(&id.as_str()),
    ))
}
