//! The Rust port of `projectDisplayName.ts`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn basename(project_path: &str, root_fallback: Option<String>) -> String {
    let fallback = || root_fallback.unwrap_or_else(|| "Root".into());
    let normalized = project_path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    normalized.split('/').rfind(|s| !s.is_empty()).map_or_else(fallback, str::to_string)
}

/// Port of `getExactProjectBasename` (`projectDisplayName.ts:6`).
pub fn get_exact_project_basename(project_path: String, root_fallback: Option<String>) -> Result<String, String> {
    Ok(basename(&project_path, root_fallback))
}

/// Port of `resolveProjectDisplayName` (`projectDisplayName.ts:13`).
pub fn resolve_project_display_name(project: Value, root_fallback: Option<String>) -> Result<String, String> {
    if project.is_null() || js::is_undefined(&project) {
        let kind = if project.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading 'label')"));
    }
    let field = |key: &str| project.as_object().and_then(|o| o.get(key)).filter(|v| !js::is_undefined(v));
    if let Some(Value::String(label)) = field("label")
        && label.chars().any(|c| !js_space(c))
    {
        return Ok(label.clone());
    }
    match field("path") {
        Some(Value::String(path)) => Ok(basename(path, root_fallback)),
        None => Err("Cannot read properties of undefined (reading 'replaceAll')".into()), // recorded-literal: V8 TypeError text
        Some(Value::Null) => Err("Cannot read properties of null (reading 'replaceAll')".into()), // recorded-literal: V8 TypeError text
        Some(_) => Err("projectPath.replaceAll is not a function".into()),                // recorded-literal: V8 TypeError text
    }
}
