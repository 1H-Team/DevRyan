//! The Rust port of `git/commit-message-context.js`: `validateCommitMessageSelectedFiles` (the
//! context collector is async over Git callbacks). Paths are UTF-16 units: `\` becomes `/`, one
//! leading `./` (with its extra slashes) is dropped, then the path is trimmed; refusals are product
//! `Error`s (their `code`/`statusCode` do not cross the bindings).

#![forbid(unsafe_code)]

use std::collections::HashSet;

use serde_json::Value;

use crate::js;

fn space(u: u16) -> bool {
    matches!(u, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn normalize(units: &[u16]) -> Vec<u16> {
    let slash = u16::from(b'/');
    let mut path: Vec<u16> = units.iter().map(|u| if *u == u16::from(b'\\') { slash } else { *u }).collect();
    if path.len() >= 2 && path[0] == u16::from(b'.') && path[1] == slash {
        let extra = path[1..].iter().take_while(|u| **u == slash).count();
        path.drain(..1 + extra);
    }
    let start = path.iter().position(|u| !space(*u)).unwrap_or(path.len());
    let end = path.iter().rposition(|u| !space(*u)).map_or(start, |i| i + 1);
    path[start..end].to_vec()
}

fn invalid(path: &[u16]) -> bool {
    let text = String::from_utf16_lossy(path);
    let b = text.as_bytes();
    path.is_empty()
        || path.len() > 1024
        || text == ".."
        || text.starts_with("../")
        || text.starts_with('/')
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/')
        || text.split('/').any(|s| s == "..")
        || path.contains(&0)
}

/// Port of `validateCommitMessageSelectedFiles` (`git/commit-message-context.js:19`).
pub fn validate_commit_message_selected_files(selected_files: Value) -> Result<Value, String> {
    let list = match &selected_files {
        Value::Array(items) if !items.is_empty() => items,
        _ => return Err("At least one selected file is required".into()),
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in list {
        let Some(units) = js::string_units(value) else {
            return Err("Selected file paths must be strings".into());
        };
        let path = normalize(&units);
        if invalid(&path) {
            return Err("Selected file path is invalid".into());
        }
        if seen.insert(path.clone()) {
            out.push(js::utf16_string(&path));
            if out.len() > 200 {
                return Err("At most 200 files can be used to generate a commit message".into());
            }
        }
    }
    Ok(Value::Array(out))
}
