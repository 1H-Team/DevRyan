//! The Rust port of `modelIdentifier.ts`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

/// Port of `parseModelIdentifier` (`modelIdentifier.ts:6`): split at the first `/`, which must
/// have text on both sides.
pub fn parse_model_identifier(value: Option<String>) -> Result<Option<Value>, String> {
    let Some(value) = value else { return Ok(None) };
    match value.find('/') {
        Some(index) if index > 0 && index + 1 < value.len() => Ok(Some(json!({
            "providerId": &value[..index],
            "modelId": &value[index + 1..],
        }))),
        _ => Ok(None),
    }
}
