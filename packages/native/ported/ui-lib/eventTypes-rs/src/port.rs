//! The Rust port of `eventTypes.ts`.

#![forbid(unsafe_code)]

/// Port of `canonicalEventType` (`eventTypes.ts:11`): `openchamber:*` becomes `devryan:*`.
pub fn canonical_event_type(r#type: String) -> Result<String, String> {
    Ok(match r#type.strip_prefix("openchamber:") {
        Some(rest) => format!("devryan:{rest}"),
        None => r#type,
    })
}
