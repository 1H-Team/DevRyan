//! The Rust port of `git/branch-name.js`: `buildBranchNamePrompt` (`normalizeBranchSlug` needs
//! Unicode NFKD normalization and stays in JavaScript). `prompt.slice(0, 4000)` cuts UTF-16
//! units; an array prompt slices elements and prints them joined.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// `String(value)` for an element joined by `Array.prototype.join`.
fn join_text(value: &Value) -> Vec<u16> {
    if let Some(units) = js::string_units(value) {
        return units;
    }
    let text = match value {
        Value::Null => String::new(),
        _ if js::is_undefined(value) => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => {
            return items.iter().map(join_text).collect::<Vec<_>>().join(&[u16::from(b',')][..]);
        }
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    text.encode_utf16().collect()
}

/// Port of `buildBranchNamePrompt` (`git/branch-name.js:48`).
pub fn build_branch_name_prompt(prompt: Value) -> Result<Value, String> {
    let body: Vec<u16> = match &prompt {
        Value::Array(items) => join_text(&Value::Array(items.iter().take(4_000).cloned().collect())),
        _ => match js::string_units(&prompt) {
            Some(units) => units[..units.len().min(4_000)].to_vec(),
            None if prompt.is_null() => return Err("Cannot read properties of null (reading 'slice')".into()), // recorded-literal: V8 TypeError text
            None if js::is_undefined(&prompt) => return Err("Cannot read properties of undefined (reading 'slice')".into()), // recorded-literal: V8 TypeError text
            None => return Err("prompt.slice is not a function".into()), // recorded-literal: V8 TypeError text
        },
    };
    let mut out: Vec<u16> = "Name the git branch for this task request.\n\n<request>\n".encode_utf16().collect();
    out.extend(body);
    out.extend("\n</request>".encode_utf16());
    Ok(js::utf16_string(&out))
}
