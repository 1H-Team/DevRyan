//! The Rust port of `github/sourceRepo.ts`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

/// JS `String.prototype.trim` white space and line terminators, as UTF-16 code units.
fn js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// `typeof value === 'string' ? value.trim() : ''`, in UTF-16 code units.
fn trimmed(value: Option<&Value>) -> Vec<u16> {
    let Some(units) = value.and_then(js::string_units) else { return Vec::new() };
    let start = units.iter().position(|&u| !js_space(u)).unwrap_or(units.len());
    let end = units.iter().rposition(|&u| !js_space(u)).map_or(start, |i| i + 1);
    units[start..end].to_vec()
}

/// Port of `resolveGitHubSourceRepo` (`github/sourceRepo.ts:3`).
pub fn resolve_git_hub_source_repo(repo: Option<Value>) -> Result<Option<Value>, String> {
    let field = |key: &str| repo.as_ref().and_then(|r| r.as_object()).and_then(|o| o.get(key));
    let owner = trimmed(field("owner"));
    let name = trimmed(field("repo"));
    if owner.is_empty() || name.is_empty() {
        return Ok(None);
    }
    Ok(Some(json!({ "owner": js::utf16_string(&owner), "repo": js::utf16_string(&name) })))
}
