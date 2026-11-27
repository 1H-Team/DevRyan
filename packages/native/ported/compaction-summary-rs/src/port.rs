//! The Rust port of `compaction-summary.ts`.

#![forbid(unsafe_code)]

use serde_json::Value;

/// Port of `isCompactionSummaryInfo` (`compaction-summary.ts:3`).
pub fn is_compaction_summary_info(info: Value) -> Result<bool, String> {
    // Markers for `undefined`, special numbers and lone-surrogate strings are not objects.
    let Value::Object(map) = &info else { return Ok(false) };
    if map.len() == 1 && map.keys().all(|k| matches!(k.as_str(), "$undefined" | "$num" | "$utf16" | "$bigint")) {
        return Ok(false);
    }
    Ok(map.get("summary") == Some(&Value::Bool(true))
        || map.get("mode").and_then(Value::as_str) == Some("compaction")
        || map.get("agent").and_then(Value::as_str) == Some("compaction"))
}
