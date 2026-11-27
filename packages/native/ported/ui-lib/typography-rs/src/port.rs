//! The Rust port of `typography.ts` (`getTypographyVariable`; the rest is constant data).

#![forbid(unsafe_code)]

/// Port of `getTypographyVariable` (`typography.ts:21`): `-` before each ASCII capital, then
/// JS `toLowerCase`.
pub fn get_typography_variable(key: String) -> Result<String, String> {
    let mut dashed = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            dashed.push('-');
        }
        dashed.push(c);
    }
    Ok(format!("--text-{}", dashed.to_lowercase()))
}
