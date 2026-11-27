//! The Rust port of `todo-completion.ts`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

/// The value as a JS object (`typeof v === "object" && v !== null`): plain objects and arrays,
/// not the markers for `undefined`, special numbers or lone-surrogate strings.
fn object(value: &Value) -> Option<Option<&Map<String, Value>>> {
    match value {
        Value::Array(_) => Some(None),
        Value::Object(map) if map.len() == 1 && map.keys().all(|k| k.starts_with('$')) => None,
        Value::Object(map) => Some(Some(map)),
        _ => None,
    }
}

/// `value.trim().toLowerCase()` for strings (JS `trim` strips U+FEFF but not U+0085).
fn normalized(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let trimmed = text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    Some(trimmed.to_lowercase())
}

/// Port of `hasIncompleteTodos` (`todo-completion.ts:7`).
pub fn has_incomplete_todos(todos: Value) -> Result<bool, String> {
    let Value::Array(todos) = &todos else { return Ok(false) };
    Ok(todos.iter().any(|todo| {
        let status = object(todo).flatten().and_then(|m| normalized(m.get("status")));
        status.is_some_and(|s| matches!(s.replace(' ', "_").as_str(), "pending" | "in_progress"))
    }))
}

/// Port of `mayAutoContinueOpenTodos` (`todo-completion.ts:34`).
pub fn may_auto_continue_open_todos(message: Value, todos: Value) -> Result<bool, String> {
    if !has_incomplete_todos(todos)? {
        return Ok(false);
    }
    let Some(map) = object(&message) else { return Ok(false) };
    let field = |key: &str| map.and_then(|m| normalized(m.get(key))).unwrap_or_default();
    let direct = field("agent");
    let name = if direct.is_empty() { field("mode") } else { direct };
    Ok(matches!(name.as_str(), "build" | "builder"))
}
