//! The Rust port of `mobileKeyboardMode.ts`: `normalizeMobileKeyboardMode`. The rest reads
//! `navigator`, browser storage or `document` and stays in TS. Quirk kept: the `= 'native'`
//! default also applies to an explicit `undefined` fallback, so the overload promising
//! `undefined` returns `'native'`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// Port of `normalizeMobileKeyboardMode` (`mobileKeyboardMode.ts:31`).
pub fn normalize_mobile_keyboard_mode(value: Value, fallback: Value) -> Result<Value, String> {
    if matches!(value.as_str(), Some("native" | "resize-content")) {
        return Ok(value);
    }
    Ok(if js::is_undefined(&fallback) {
        Value::String("native".into())
    } else {
        fallback
    })
}
