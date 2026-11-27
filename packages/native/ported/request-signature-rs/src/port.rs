//! The Rust port of `request-signature.ts`.
//!
//! Ids sort in UTF-16 code unit order (what `<` compares), ids that are not strings read as
//! `undefined` and go last, and values outside the TypeScript type fail as the JS engine does.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// Port of `requestSignature` (`request-signature.ts:3`).
pub fn request_signature(items: Value) -> Result<String, String> {
    let list = match &items {
        Value::Array(list) if !list.is_empty() => list,
        Value::Array(_) | Value::Null | Value::Bool(false) => return Ok(String::new()),
        Value::String(text) if text.is_empty() => return Ok(String::new()),
        Value::Number(n) if n.as_f64() == Some(0.0) => return Ok(String::new()),
        _ if js::is_undefined(&items) || js::as_number(&items).is_some_and(|n| n.is_nan() || n == 0.0) => {
            return Ok(String::new());
        }
        _ => return Err("items.map is not a function".to_string()),
    };
    let mut ids: Vec<Vec<u16>> = Vec::with_capacity(list.len());
    let mut missing = 0;
    for item in list {
        if item.is_null() || js::is_undefined(item) {
            let kind = if item.is_null() { "null" } else { "undefined" };
            return Err(format!("Cannot read properties of {kind} (reading 'id')"));
        }
        match item.get("id").and_then(js::string_units) {
            Some(units) => ids.push(units),
            None => missing += 1,
        }
    }
    ids.sort();
    let parts: Vec<String> = ids.iter().map(|units| String::from_utf16_lossy(units)).collect();
    Ok(parts
        .into_iter()
        .chain(std::iter::repeat_n(String::new(), missing))
        .collect::<Vec<_>>()
        .join("|"))
}
