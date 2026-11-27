//! The Rust port of `fileOpenLimits.ts`.

#![forbid(unsafe_code)]

/// Port of `countLinesWithLimit` (`fileOpenLimits.ts:3`): one more than the `\n` count, stopping
/// at the first count above `limit` (a NaN limit never stops it).
pub fn count_lines_with_limit(content: String, limit: f64) -> Result<f64, String> {
    let mut lines = 1.0;
    for byte in content.bytes() {
        if byte == b'\n' {
            lines += 1.0;
            if lines > limit {
                return Ok(lines);
            }
        }
    }
    Ok(lines)
}
