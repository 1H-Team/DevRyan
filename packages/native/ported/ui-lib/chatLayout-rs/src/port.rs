//! The Rust port of `chatLayout.ts` (`applyChatWidth` writes to a DOM element and stays in TS).

#![forbid(unsafe_code)]

const DEFAULT_CHAT_WIDTH: f64 = 640.0;
const MIN_CHAT_WIDTH: f64 = 640.0;
const MAX_CHAT_WIDTH: f64 = 1408.0;
const CHAT_WIDTH_STEP: f64 = 16.0;

/// Port of `clampChatWidth` (`chatLayout.ts:7`): clamp, then snap to the 16 px grid (halves up).
pub fn clamp_chat_width(value: f64) -> Result<f64, String> {
    if !value.is_finite() {
        return Ok(DEFAULT_CHAT_WIDTH);
    }
    let clamped = value.clamp(MIN_CHAT_WIDTH, MAX_CHAT_WIDTH);
    Ok(MIN_CHAT_WIDTH + ((clamped - MIN_CHAT_WIDTH) / CHAT_WIDTH_STEP).round() * CHAT_WIDTH_STEP)
}
