//! The Rust port of `permissions/editModeColors.ts`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

/// Port of `getEditModeColors` (`permissions/editModeColors.ts:10`): `full` and `allow` share
/// one colour set.
pub fn get_edit_mode_colors(mode: Option<Value>) -> Result<Option<Value>, String> {
    if !matches!(mode.as_ref().and_then(Value::as_str), Some("full" | "allow")) {
        return Ok(None);
    }
    Ok(Some(json!({
        "text": "var(--status-info)",
        "border": "color-mix(in srgb, var(--status-info) 25%, transparent)",
        "background": "color-mix(in srgb, var(--status-info) 4%, transparent)",
        "borderWidth": 1.5,
    })))
}
