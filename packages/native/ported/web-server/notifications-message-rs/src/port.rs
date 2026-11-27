//! The Rust port of `notifications/message.js`: `truncateNotificationText` (the async
//! summarizer stays in JavaScript). Lengths and the cut are UTF-16 units.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// Port of `truncateNotificationText` (`notifications/message.js:42`).
pub fn truncate_notification_text(text: Value, max_length: Value) -> Result<Value, String> {
    let Some(units) = js::string_units(&text) else {
        return Ok(Value::String(String::new()));
    };
    let max = js::as_number(&max_length)
        .filter(|n| (max_length.is_number() || max_length.get("$num").is_some()) && n.is_finite() && *n > 0.0)
        .unwrap_or(250.0);
    if units.len() as f64 <= max {
        return Ok(text);
    }
    let mut out = units[..(max.trunc() as usize).min(units.len())].to_vec();
    out.extend("...".encode_utf16());
    Ok(js::utf16_string(&out))
}
