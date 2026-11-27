//! The Rust port of `sessionLineage.ts`.

#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};

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

/// `normalizeSessionID`: a trimmed, non-empty string, else `null`.
fn normalize(value: &str) -> Option<String> {
    Some(value.trim_matches(js_space)).filter(|s| !s.is_empty()).map(str::to_string)
}

fn normalize_value(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(normalize)
}

/// The elements `for (const session of sessions)` visits (a string's characters have no `id`).
fn iterate(sessions: &Value) -> Result<&[Value], String> {
    match sessions {
        Value::Array(items) => Ok(items),
        Value::String(_) => Ok(&[]),
        Value::Object(o) if o.contains_key("$utf16") => Ok(&[]),
        Value::Object(o) if o.len() == 1 && o.contains_key("$set") => o["$set"].as_array().map(Vec::as_slice).ok_or_else(|| "sessions is not iterable".into()),
        _ => Err("sessions is not iterable".into()), // recorded-literal: V8 TypeError text
    }
}

/// `buildSessionParentIndex`.
fn parent_index(sessions: &Value) -> Result<HashMap<String, Option<String>>, String> {
    let mut parents = HashMap::new();
    for session in iterate(sessions)? {
        let field = |key: &str| session.as_object().and_then(|o| o.get(key)).filter(|v| !js::is_undefined(v));
        if let Some(id) = normalize_value(field("id")) {
            parents.insert(id, normalize_value(field("parentID")));
        }
    }
    Ok(parents)
}

/// Port of `resolveSessionLineage` (`sessionLineage.ts:30`).
pub fn resolve_session_lineage(session_id: Value, sessions: Value) -> Result<Vec<String>, String> {
    let Some(start) = normalize_value(Some(&session_id)) else {
        return Ok(Vec::new());
    };
    let parents = parent_index(&sessions)?;
    let mut lineage = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(start);
    while let Some(id) = current.take().filter(|id| !seen.contains(id)) {
        current = parents.get(&id).cloned().flatten();
        seen.insert(id.clone());
        lineage.push(id);
    }
    Ok(lineage)
}

/// Port of `resolveRootSessionID` (`sessionLineage.ts:55`): a cycle falls back to the start.
pub fn resolve_root_session_id(session_id: Value, sessions: Value) -> Result<Option<String>, String> {
    let Some(start) = normalize_value(Some(&session_id)) else {
        return Ok(None);
    };
    let parents = parent_index(&sessions)?;
    let mut seen = HashSet::new();
    let mut current = start.clone();
    while seen.insert(current.clone()) {
        match parents.get(&current).cloned().flatten() {
            None => return Ok(Some(current)),
            Some(parent) => current = parent,
        }
    }
    Ok(Some(start))
}
