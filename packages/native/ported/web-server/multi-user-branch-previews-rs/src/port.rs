//! The Rust port of `multi-user/branch-previews.js` (1 of 3). `normalizeBranchPreviewUrl`
//! parses a WHATWG `URL`; `createBranchPreviewService` is a closure over Supabase, the vault,
//! `fetch` and crypto. Both stay in JS.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

fn truthy(value: &Value) -> bool {
    if let Some(units) = js::string_units(value) {
        return !units.is_empty();
    }
    if let Some(n) = js::as_number(value) {
        return n != 0.0 && !n.is_nan();
    }
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Object(o) if o.len() == 1 => o.get("$bigint").map_or(!js::is_undefined(value), |b| b.as_str() != Some("0")),
        _ => true,
    }
}

fn field(row: &Value, key: &str) -> Value {
    let plain = row.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))));
    plain
        .and_then(|o| o.get(key))
        .map_or_else(js::undefined, |v| js::as_number(v).map_or_else(|| v.clone(), js::number))
}

fn or_null(value: Value) -> Value {
    if truthy(&value) { value } else { Value::Null }
}

/// Port of `publicBranchPreview` (`branch-previews.js:53`): only the four non-secret fields.
pub fn public_branch_preview(row: Value) -> Result<Value, String> {
    if !truthy(&row) {
        return Ok(Value::Null);
    }
    Ok(json!({
        "previewUrl": field(&row, "preview_url"),
        "serviceTokenConfigured": truthy(&field(&row, "service_token_vault_ref")),
        "createdAt": or_null(field(&row, "created_at")),
        "updatedAt": or_null(field(&row, "updated_at")),
    }))
}
