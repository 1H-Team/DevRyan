//! The Rust port of `session-selectors.ts` (`subscribeToSessionBranch` stays in TypeScript: it
//! takes a callback). Reference identity does not cross the JSON bridge, so
//! `selectSessionChildren` returns its fresh list where the original keeps `previous` for the same
//! members: the two print the same.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// `value[key]`, failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

/// `a === b` for a member against a string id.
fn is(value: Option<&Value>, id: &str) -> bool {
    value.and_then(Value::as_str) == Some(id)
}

/// Port of `selectSessionById` (`session-selectors.ts:6`).
pub fn select_session_by_id(sessions: Value, session_id: Option<String>) -> Result<Value, String> {
    let Some(id) = session_id.filter(|id| !id.is_empty()) else {
        return Ok(js::undefined());
    };
    get(&sessions, "find")?;
    let Value::Array(sessions) = sessions else {
        return Err("sessions.find is not a function".to_string());
    };
    for session in sessions {
        if is(get(&session, "id")?, &id) {
            return Ok(session);
        }
    }
    Ok(js::undefined())
}

/// Port of `selectSessionDirectoryById` (`session-selectors.ts:14`).
pub fn select_session_directory_by_id(sessions: Value, session_id: Option<String>) -> Result<Value, String> {
    let session = select_session_by_id(sessions, session_id)?;
    Ok(session.get("directory").filter(|d| !nullish(d)).cloned().unwrap_or_else(js::undefined))
}

/// Port of `selectSessionChildren` (`session-selectors.ts:26`).
pub fn select_session_children(sessions: Value, parent_id: Option<String>, previous: Value) -> Result<Vec<Value>, String> {
    let Some(parent) = parent_id.filter(|id| !id.is_empty()) else {
        return Ok(Vec::new());
    };
    let items = match sessions {
        Value::Array(items) => items,
        Value::String(_) => return Ok(Vec::new()),
        _ => return Err("sessions is not iterable".to_string()),
    };
    let mut next = Vec::new();
    for session in items {
        if is(get(&session, "parentID")?, &parent) {
            next.push(session);
        }
    }
    if !next.is_empty() {
        // `previous = EMPTY_SESSION_CHILDREN` replaces only `undefined`; `null` fails on `.length`.
        if previous.is_null() {
            get(&previous, "length")?;
        }
    }
    Ok(next)
}
