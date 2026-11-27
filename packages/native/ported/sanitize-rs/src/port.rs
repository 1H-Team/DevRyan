//! The Rust port of `sanitize.ts`, after the client engine's `families/sanitize.rs`: the same
//! walk (falsy entries kept, an entry copied only when a string body is dropped, the original
//! returned when nothing changed), over JSON values.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

const DIFF_CONTENT_FIELDS: [&str; 5] = ["patch", "before", "after", "from", "to"];

/// `stripDiffSummary`: patch bodies dropped from `summary.diffs`.
fn strip_diff_summary(target: Value) -> Result<Value, String> {
    if target.is_null() || js::is_undefined(&target) {
        let kind = if target.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading 'summary')"));
    }
    let Some(Value::Object(summary)) = target.get("summary") else {
        return Ok(target);
    };
    let Some(Value::Array(diffs)) = summary.get("diffs") else { return Ok(target) };
    let mut changed = false;
    let stripped: Vec<Value> = diffs
        .iter()
        .map(|entry| {
            let Value::Object(fields) = entry else { return entry.clone() };
            let mut next = fields.clone();
            for field in DIFF_CONTENT_FIELDS {
                // `typeof entry[field] === "string"`, lone-surrogate strings included.
                if fields.get(field).and_then(js::string_units).is_some() {
                    next.shift_remove(field);
                    changed = true;
                }
            }
            Value::Object(next)
        })
        .collect();
    if !changed {
        return Ok(target);
    }
    let mut summary = summary.clone();
    summary.insert("diffs".to_string(), Value::Array(stripped));
    let mut result = target.as_object().cloned().unwrap_or_default();
    result.insert("summary".to_string(), Value::Object(summary));
    Ok(Value::Object(result))
}

/// Port of `stripSessionDiffSnapshots` (`sanitize.ts:68`).
pub fn strip_session_diff_snapshots(session: Value) -> Result<Value, String> {
    strip_diff_summary(session)
}

/// Port of `stripMessageDiffSnapshots` (`sanitize.ts:73`).
pub fn strip_message_diff_snapshots(message: Value) -> Result<Value, String> {
    strip_diff_summary(message)
}
