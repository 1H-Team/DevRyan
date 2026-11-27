//! The Rust port of `projectResolution.ts`, over any JS value (for-of, `.entries()`, `.find()`
//! and property reads fail as V8 does). Path lengths compare in UTF-16 code units.

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

fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

fn kind(value: &Value) -> Option<&'static str> {
    if value.is_null() {
        Some("null")
    } else if js::is_undefined(value) {
        Some("undefined")
    } else {
        None
    }
}

fn set_items(value: &Value) -> Option<&Vec<Value>> {
    value.as_object().filter(|o| o.len() == 1).and_then(|o| o.get("$set")).and_then(Value::as_array)
}

/// `value[key]` (absent for primitives), failing on `null`/`undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if let Some(kind) = kind(value) {
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(value.as_object().and_then(|o| o.get(key)).filter(|v| !js::is_undefined(v)))
}

/// The elements `for (const x of value)` visits; a string's characters are strings.
fn iterate(value: &Value, name: &str) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(o) if o.len() == 1 && o.contains_key("$utf16") => Ok(Vec::new()),
        _ => set_items(value).cloned().ok_or_else(|| format!("{name} is not iterable")), // recorded-literal: V8 TypeError text
    }
}

fn normalize(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim_matches(js_space);
    if trimmed.is_empty() {
        return None;
    }
    let replaced = trimmed.replace('\\', "/");
    if replaced == "/" || len16(&replaced) <= 1 {
        return Some(replaced);
    }
    Some(replaced.trim_end_matches('/').to_string())
}

fn inside(nd: &str, path: &str) -> bool {
    nd == path || nd.strip_prefix(path).is_some_and(|rest| rest.starts_with('/'))
}

fn for_directory(projects: &Value, directory: &Value) -> Result<Value, String> {
    let Some(nd) = normalize(Some(directory)).filter(|s| !s.is_empty()) else {
        return Ok(Value::Null);
    };
    let mut best: Option<(Value, usize)> = None;
    for project in iterate(projects, "projects")? {
        let Some(pp) = normalize(get(&project, "path")?).filter(|s| !s.is_empty()) else {
            continue;
        };
        if !inside(&nd, &pp) {
            continue;
        }
        if best.as_ref().is_none_or(|(_, len)| len16(&pp) > *len) {
            best = Some((project, len16(&pp)));
        }
    }
    Ok(best.map_or(Value::Null, |(p, _)| p))
}

/// The `[key, value]` pairs of `value.entries()` (Map, array or Set).
fn entries(value: &Value) -> Result<Vec<(Value, Value)>, String> {
    if let Some(kind) = kind(value) {
        return Err(format!("Cannot read properties of {kind} (reading 'entries')")); // recorded-literal: V8 TypeError text
    }
    if let Some(pairs) = value.as_object().filter(|o| o.len() == 1).and_then(|o| o.get("$map")).and_then(Value::as_array) {
        return Ok(pairs
            .iter()
            .map(|pair| (pair.get(0).cloned().unwrap_or(Value::Null), pair.get(1).cloned().unwrap_or(Value::Null)))
            .collect());
    }
    if let Value::Array(items) = value {
        return Ok(items.iter().enumerate().map(|(i, v)| (Value::from(i), v.clone())).collect());
    }
    if let Some(items) = set_items(value) {
        return Ok(items.iter().map(|v| (v.clone(), v.clone())).collect());
    }
    Err("availableWorktreesByProject.entries is not a function".into()) // recorded-literal: V8 TypeError text
}

fn from_worktree(projects: &Value, worktrees_by_project: &Value, directory: &Value) -> Result<Value, String> {
    let Some(nd) = normalize(Some(directory)).filter(|s| !s.is_empty()) else {
        return Ok(Value::Null);
    };
    let mut matched: Option<(Value, Option<String>)> = None;
    let mut best_len = -1.0;
    for (project_path, worktrees) in entries(worktrees_by_project)? {
        for worktree in iterate(&worktrees, "worktrees")? {
            let Some(wp) = normalize(get(&worktree, "path")?).filter(|s| !s.is_empty()) else {
                continue;
            };
            if !inside(&nd, &wp) {
                continue;
            }
            let len = len16(&wp) as f64;
            if len > best_len {
                best_len = len;
                matched = Some((worktree, normalize(Some(&project_path))));
            }
        }
    }
    let Some((worktree, project_path)) = matched else { return Ok(Value::Null) };
    let candidates = [normalize(get(&worktree, "projectDirectory")?), project_path];
    for candidate in candidates.into_iter().flatten().filter(|c| !c.is_empty()) {
        let Value::Array(list) = projects else {
            get(projects, "find")?;
            return Err("projects.find is not a function".into()); // recorded-literal: V8 TypeError text
        };
        for project in list {
            if normalize(get(project, "path")?).as_deref() == Some(candidate.as_str()) {
                return Ok(project.clone());
            }
        }
        let nested = for_directory(projects, &Value::String(candidate))?;
        if !nested.is_null() {
            return Ok(nested);
        }
    }
    Ok(Value::Null)
}

/// Port of `normalizeProjectPath` (`projectResolution.ts:4`).
pub fn normalize_project_path(value: Value) -> Result<Value, String> {
    Ok(normalize(Some(&value)).map_or(Value::Null, Value::String))
}

/// Port of `resolveProjectForDirectory` (`projectResolution.ts:14`).
pub fn resolve_project_for_directory(projects: Value, directory: Value) -> Result<Value, String> {
    for_directory(&projects, &directory)
}

/// Port of `resolveProjectFromWorktreeDirectory` (`projectResolution.ts:29`).
pub fn resolve_project_from_worktree_directory(projects: Value, available_worktrees_by_project: Value, directory: Value) -> Result<Value, String> {
    from_worktree(&projects, &available_worktrees_by_project, &directory)
}

/// Port of `resolveProjectForSessionDirectory` (`projectResolution.ts:63`).
pub fn resolve_project_for_session_directory(projects: Value, available_worktrees_by_project: Value, directory: Value) -> Result<Value, String> {
    let direct = for_directory(&projects, &directory)?;
    if !direct.is_null() {
        return Ok(direct);
    }
    from_worktree(&projects, &available_worktrees_by_project, &directory)
}
