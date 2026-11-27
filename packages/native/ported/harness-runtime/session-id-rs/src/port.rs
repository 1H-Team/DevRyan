//! The Rust port of `session-id.js` of `@devryan/harness-runtime`, with `canonicalDevRyanEventType`
//! of `@devryan/shared-runtime/lib/event-types.js` inlined.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

// ---- JS values over JSON ----

/// A one-key object `{ tag: ... }`: how the bridge marks numbers, strings, `undefined` and `Set`s.
fn marked(v: &Value, tag: &str) -> bool {
    v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(tag))
}

/// `typeof v === "number"`.
fn num(v: &Value) -> Option<f64> {
    (v.is_number() || marked(v, "$num")).then(|| js::as_number(v)).flatten()
}

fn text(v: &Value) -> Option<String> {
    js::string_units(v).map(|u| String::from_utf16_lossy(&u))
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    let index = || key.parse::<usize>().ok().filter(|i| i.to_string() == key);
    let found = match (v, js::string_units(v)) {
        (_, Some(u)) if key == "length" => Some(js::number(u.len() as f64)),
        (_, Some(u)) => index().and_then(|i| u.get(i)).map(|c| js::utf16_string(&[*c])),
        (Value::Array(items), _) if key == "length" => Some(js::number(items.len() as f64)),
        (Value::Array(items), _) => index().and_then(|i| items.get(i).cloned()),
        _ => plain(v).and_then(|o| o.get(key).cloned()),
    };
    found.unwrap_or_else(js::undefined)
}

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

/// `typeof v === "string" && v.trim() ? v.trim() : ""` (JS white space).
fn trimmed(v: &Value) -> String {
    text(v)
        .map(|t| t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string())
        .unwrap_or_default()
}

// ---- the unit ----

/// `v?.a?.b?...`.
fn at(v: &Value, path: &[&str]) -> Value {
    path.iter()
        .fold(v.clone(), |acc, key| if nullish(&acc) { js::undefined() } else { prop(&acc, key) })
}

/// `canonicalDevRyanEventType(type)` compared with `devryan:<name>`.
fn event_is(kind: &Value, name: &str) -> bool {
    text(kind).is_some_and(|t| t == format!("devryan:{name}") || t.strip_prefix("openchamber:") == Some(name))
}

fn explicit(record: &Value) -> String {
    let paths: [&[&str]; 4] = [
        &["sessionID"],
        &["payload", "sessionID"],
        &["payload", "properties", "sessionID"],
        &["payload", "properties", "info", "sessionID"],
    ];
    paths.iter().map(|p| trimmed(&at(record, p))).find(|s| !s.is_empty()).unwrap_or_default()
}

fn managed_task(record: &Value) -> Option<Value> {
    let task = at(record, &["payload", "properties", "task"]);
    let devryan = |v: &Value| eq(v, &json!("devryan"));
    if !event_is(&at(record, &["payload", "type"]), "managed-task")
        || !devryan(&at(record, &["payload", "properties", "owner"]))
        || !devryan(&at(&task, &["owner"]))
    {
        return None;
    }
    let (root, own) = (trimmed(&prop(&task, "rootSessionId")), explicit(record));
    (!root.is_empty() && (own.is_empty() || own == root)).then_some(task)
}

/// Port of `resolveRecordSessionID` (`session-id.js:20`).
pub fn resolve_record_session_id(record: Value) -> Result<Value, String> {
    let found = [
        explicit(&record),
        trimmed(&at(&record, &["usageObservation", "sessionID"])),
        trimmed(&at(&record, &["payload", "properties", "part", "sessionID"])),
    ];
    if let Some(id) = found.into_iter().find(|s| !s.is_empty()) {
        return Ok(Value::String(id));
    }
    if let Some(task) = managed_task(&record) {
        return Ok(Value::String(trimmed(&prop(&task, "rootSessionId"))));
    }
    let kind = trimmed(&at(&record, &["payload", "type"]));
    if event_is(&Value::String(kind.clone()), "managed-task-removed") && eq(&at(&record, &["payload", "properties", "owner"]), &json!("devryan")) {
        return Ok(Value::String(trimmed(&at(&record, &["payload", "properties", "rootSessionId"]))));
    }
    Ok(Value::String(if kind.starts_with("session.") {
        trimmed(&at(&record, &["payload", "properties", "info", "id"]))
    } else {
        String::new()
    }))
}

fn relation(session: String, parent: String) -> Value {
    if session.is_empty() || parent.is_empty() {
        Value::Null
    } else {
        json!({ "sessionID": session, "parentID": parent })
    }
}

/// Port of `resolveSessionRelation` (`session-id.js:39`).
pub fn resolve_session_relation(record: Value) -> Result<Value, String> {
    if eq(&at(&record, &["type"]), &json!("lifecycle")) && eq(&prop(&record, "event"), &json!("session_title_generation")) {
        let (session, parent) = (trimmed(&at(&record, &["payload", "helperSessionID"])), trimmed(&prop(&record, "sessionID")));
        if !session.is_empty() && !parent.is_empty() && session != parent {
            return Ok(json!({ "sessionID": session, "parentID": parent }));
        }
    }
    if let Some(task) = managed_task(&record) {
        let (session, parent) = (trimmed(&prop(&task, "childSessionId")), trimmed(&prop(&task, "rootSessionId")));
        return Ok(if !session.is_empty() && session != parent {
            json!({ "sessionID": session, "parentID": parent })
        } else {
            Value::Null
        });
    }
    if !trimmed(&at(&record, &["payload", "type"])).starts_with("session.") {
        return Ok(Value::Null);
    }
    let info = at(&record, &["payload", "properties", "info"]);
    let first = |a: &str, b: &str| {
        [at(&info, &[a]), at(&info, &[b])]
            .into_iter()
            .find(|v| !nullish(v))
            .unwrap_or_else(js::undefined)
    };
    Ok(relation(trimmed(&first("id", "sessionID")), trimmed(&first("parentID", "parentId"))))
}
