//! How the server splits Markdown front matter before `yaml.parse`.
//!
//! - `split` is `content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)`
//!   (`lib/opencode/shared.js`, `packaged-agent-sync.js`,
//!   `runtime-agent-overlays.js`, `lib/skills-catalog/scan.js`): the YAML
//!   source and the body after the closing line.
//! - `split_skill` is `content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)`
//!   (`lib/opencode/harness-skill-discovery.js`): the YAML source only.

fn at(text: &[u16], index: usize) -> Option<u16> {
    text.get(index).copied()
}

fn opening(text: &[u16]) -> Option<usize> {
    if !text.starts_with(&[0x2d, 0x2d, 0x2d]) {
        return None;
    }
    match (at(text, 3), at(text, 4)) {
        (Some(0x0a), _) => Some(4),
        (Some(0x0d), Some(0x0a)) => Some(5),
        _ => None,
    }
}

/// `\r?\n---` at `i`: the index after the dashes.
fn closing_dashes(text: &[u16], i: usize) -> Option<usize> {
    let after_newline = match (at(text, i), at(text, i + 1)) {
        (Some(0x0a), _) => i + 1,
        (Some(0x0d), Some(0x0a)) => i + 2,
        _ => return None,
    };
    let dashes = text.get(after_newline..after_newline + 3)?;
    (dashes == [0x2d, 0x2d, 0x2d]).then_some(after_newline + 3)
}

/// `\r?\n` at `j`: the index after it.
fn line_break(text: &[u16], j: usize) -> Option<usize> {
    match (at(text, j), at(text, j + 1)) {
        (Some(0x0a), _) => Some(j + 1),
        (Some(0x0d), Some(0x0a)) => Some(j + 2),
        _ => None,
    }
}

/// The server's agent, command and skill split: `(frontmatter, body)` from
/// `match[1]` and `match[2]`, or `None` where the expression does not match.
pub fn split(text: &[u16]) -> Option<(Vec<u16>, Vec<u16>)> {
    let start = opening(text)?;
    for i in start..text.len() {
        if let Some(after) = closing_dashes(text, i).and_then(|j| line_break(text, j)) {
            return Some((text[start..i].to_vec(), text[after..].to_vec()));
        }
    }
    None
}

/// The harness skill discovery's split: `match[1]`, or `None`.
pub fn split_skill(text: &[u16]) -> Option<Vec<u16>> {
    let start = opening(text)?;
    for i in start..text.len() {
        if let Some(j) = closing_dashes(text, i)
            && (j == text.len() || line_break(text, j).is_some())
        {
            return Some(text[start..i].to_vec());
        }
    }
    None
}
