//! The Rust port of `projectId.ts` (Node has `btoa`, so the base64url branch is the one taken).

#![forbid(unsafe_code)]

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `btoa` of the bytes with `+` -> `-`, `/` -> `_` and no `=` padding.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], chunk.get(1).copied().unwrap_or(0), chunk.get(2).copied().unwrap_or(0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

/// Port of `createProjectIdFromPath` (`projectId.ts:1`): `path_` + base64url of the UTF-8 of the
/// normalized path.
pub fn create_project_id_from_path(project_path: String) -> Result<String, String> {
    let slashed = project_path.replace('\\', "/");
    let normalized = slashed.trim_end_matches('/').trim_matches(js_space);
    if normalized.is_empty() {
        return Ok(String::new());
    }
    Ok(format!("path_{}", base64url(normalized.as_bytes())))
}
