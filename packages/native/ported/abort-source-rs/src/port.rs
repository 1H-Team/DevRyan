//! The Rust port of `abort-source.ts`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

/// The header `@devryan/orchestration-runtime` exports as `ABORT_SOURCE_HEADER`.
const ABORT_SOURCE_HEADER: &str = "X-DevRyan-Abort-Source"; // recorded-literal: constant of @devryan/orchestration-runtime

/// Port of `abortSourceHeaders` (`abort-source.ts:11`).
pub fn abort_source_headers(source: Option<Value>) -> Result<Option<Value>, String> {
    let truthy = |v: &Value| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    };
    Ok(source.filter(truthy).map(|source| json!({ "headers": { ABORT_SOURCE_HEADER: source } })))
}
