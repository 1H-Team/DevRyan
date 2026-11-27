//! The Rust port of `lib/event-types.js` of `@devryan/shared-runtime`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// Port of `canonicalDevRyanEventType` (`event-types.js:2`).
pub fn canonical_dev_ryan_event_type(r#type: Value) -> Result<Value, String> {
    let renamed = js::string_units(&r#type)
        .filter(|u| u.starts_with(&"openchamber:".encode_utf16().collect::<Vec<_>>()))
        .map(|u| js::utf16_string(&["devryan:".encode_utf16().collect::<Vec<_>>(), u[12..].to_vec()].concat()));
    Ok(renamed.unwrap_or(r#type))
}
