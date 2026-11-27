//! The Rust port of `opencode/diff-summary.js`. "The same reference back" is the same printed
//! value: each function returns its input unchanged unless it stripped something. A `Map`
//! passes `isRecord` but has no own `info`/`summary`/`diffs`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

const DIFF_CONTENT_FIELDS: [&str; 5] = ["patch", "before", "after", "from", "to"];

/// `isRecord`: `typeof object`, not `null`, not an array.
fn record(value: &Value) -> bool {
    value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn with(value: &Value, key: &str, next: Value) -> Value {
    let mut map = plain(value).cloned().unwrap_or_default();
    map.insert(key.into(), next);
    Value::Object(map)
}

/// `stripDiffEntryContent`: `Some` when a body was removed.
fn strip_entry(entry: &Value) -> Option<Value> {
    if !record(entry) {
        return None;
    }
    let map = plain(entry)?;
    if !DIFF_CONTENT_FIELDS.iter().any(|f| map.get(*f).is_some_and(|v| js::string_units(v).is_some())) {
        return None;
    }
    let mut copy = map.clone();
    for f in DIFF_CONTENT_FIELDS {
        if map.get(f).is_some_and(|v| js::string_units(v).is_some()) {
            copy.shift_remove(f);
        }
    }
    Some(Value::Object(copy))
}

/// `stripSummaryContent`: `Some` when anything changed.
fn strip_summary(summary: &Value) -> Option<Value> {
    if !record(summary) {
        return None;
    }
    let Value::Array(diffs) = field(summary, "diffs") else { return None };
    let mut changed = false;
    let next: Vec<Value> = diffs
        .iter()
        .map(|d| match strip_entry(d) {
            Some(s) => {
                changed = true;
                s
            }
            None => d.clone(),
        })
        .collect();
    changed.then(|| with(summary, "diffs", Value::Array(next)))
}

fn strip_message(record_value: &Value) -> Option<Value> {
    if !record(record_value) {
        return None;
    }
    let info = field(record_value, "info");
    if !record(&info) {
        return None;
    }
    let summary = strip_summary(&field(&info, "summary"))?;
    Some(with(record_value, "info", with(&info, "summary", summary)))
}

fn strip_session(session: &Value) -> Option<Value> {
    if !record(session) {
        return None;
    }
    let summary = strip_summary(&field(session, "summary"))?;
    Some(with(session, "summary", summary))
}

/// Port of `stripMessageDiffSummary` (`opencode/diff-summary.js:26`).
pub fn strip_message_diff_summary(record_value: Value) -> Result<Value, String> {
    if !record(&record_value) {
        return Ok(record_value);
    }
    let info = field(&record_value, "info");
    if !record(&info) || js::is_undefined(&field(&info, "summary")) {
        return Ok(record_value);
    }
    let mut stripped = plain(&info).cloned().unwrap_or_default();
    stripped.shift_remove("summary");
    Ok(with(&record_value, "info", Value::Object(stripped)))
}

/// Port of `stripMessageDiffContent` (`opencode/diff-summary.js:58`).
pub fn strip_message_diff_content(record_value: Value) -> Result<Value, String> {
    Ok(strip_message(&record_value).unwrap_or(record_value))
}

/// Port of `stripSessionDiffContent` (`opencode/diff-summary.js:66`).
pub fn strip_session_diff_content(session: Value) -> Result<Value, String> {
    Ok(strip_session(&session).unwrap_or(session))
}

/// Port of `stripEventDiffContent` (`opencode/diff-summary.js:81`).
pub fn strip_event_diff_content(payload: Value) -> Result<Value, String> {
    if !record(&payload) {
        return Ok(payload);
    }
    let properties = field(&payload, "properties");
    if !record(&properties) {
        return Ok(payload);
    }
    let next = match field(&payload, "type").as_str() {
        Some("message.updated") => strip_message(&properties),
        Some("session.updated") => strip_session(&field(&properties, "info")).map(|info| with(&properties, "info", info)),
        _ => None,
    };
    Ok(next.map_or(payload.clone(), |p| with(&payload, "properties", p)))
}
