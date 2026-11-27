//! The Rust port of `agentDisplay.ts`.

#![forbid(unsafe_code)]

/// JS `\s`: Unicode white space plus U+FEFF, without U+0085.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `segment.charAt(0).toUpperCase() + segment.slice(1)`: only a BMP first character is
/// uppercased (a supplementary one is a lone surrogate to `charAt`).
fn capitalize(segment: &str) -> String {
    let mut chars = segment.chars();
    let Some(first) = chars.next() else { return String::new() };
    let mut out = String::with_capacity(segment.len());
    if (first as u32) < 0x10000 {
        out.extend(first.to_uppercase());
    } else {
        out.push(first);
    }
    out.push_str(chars.as_str());
    out
}

/// Port of `formatAgentDisplayName` (`agentDisplay.ts:1`).
pub fn format_agent_display_name(name: String) -> Result<String, String> {
    let parts: Vec<String> = name
        .split(|c: char| c == '-' || c == '_' || js_space(c))
        .filter(|s| !s.is_empty())
        .map(capitalize)
        .collect();
    Ok(parts.join(" "))
}
