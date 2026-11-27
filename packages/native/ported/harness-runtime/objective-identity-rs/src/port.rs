//! The Rust port of `objective-identity.js` of `@devryan/harness-runtime`, with
//! `isNativeStatusRecord` of `@devryan/shared-runtime/lib/native-message-status.js` inlined.

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

fn truthy(v: &Value) -> bool {
    let falsy = num(v).is_some_and(|n| n == 0.0 || n.is_nan()) || js::string_units(v).is_some_and(|u| u.is_empty());
    !(falsy || matches!(v, Value::Null | Value::Bool(false)) || js::is_undefined(v))
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`, as `isRecord` reads it.
fn record(v: &Value) -> bool {
    plain(v).is_some() || marked(v, "$set")
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

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> Result<Value, String> {
    if nullish(v) {
        let kind = if v.is_null() { "null" } else { "undefined" };
        return Err(format!("TypeError: Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(prop(v, key))
}

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

// ---- the unit ----

/// `v?.a?.b?...`.
fn at(v: &Value, path: &[&str]) -> Value {
    path.iter()
        .fold(v.clone(), |acc, key| if nullish(&acc) { js::undefined() } else { prop(&acc, key) })
}

fn is(v: &Value, s: &str) -> bool {
    eq(v, &json!(s))
}

fn compaction_part(part: &Value) -> bool {
    is(&at(part, &["type"]), "compaction")
        || (is(&at(part, &["type"]), "text")
            && at(part, &["synthetic"]) == Value::Bool(true)
            && at(part, &["metadata", "compaction_continue"]) == Value::Bool(true))
}

fn compaction(record: &Value) -> bool {
    is(&at(record, &["info", "role"]), "user") && prop(record, "parts").as_array().is_some_and(|p| p.iter().any(compaction_part))
}

/// Port of `isNativeCompactionRecord` (`objective-identity.js:4`).
pub fn is_native_compaction_record(record: Value) -> Result<Value, String> {
    Ok(Value::Bool(compaction(&record)))
}

fn current_user(record: &Value) -> Result<Value, String> {
    for key in ["activeUserID", "recoveryID", "continuationID"] {
        let v = get(record, key)?;
        if !nullish(&v) {
            return Ok(v);
        }
    }
    Ok(prop(record, "anchorID"))
}

/// Port of `currentObjectiveUser` (`objective-identity.js:8`).
pub fn current_objective_user(record: Value) -> Result<Value, String> {
    current_user(&record)
}

/// `part.text?.startsWith(prefix)`, failing as V8 does on a text without `startsWith`.
fn text_starts(part: &Value, prefix: &str) -> Result<bool, String> {
    let t = prop(part, "text");
    match text(&t) {
        Some(s) => Ok(s.starts_with(prefix)),
        None if nullish(&t) => Ok(false),
        None => Err("TypeError: part.text?.startsWith is not a function".into()), // recorded-literal: the V8 TypeError text
    }
}

fn synthetic_text(part: &Value) -> bool {
    is(&at(part, &["type"]), "text") && prop(part, "synthetic") == Value::Bool(true)
}

/// Port of `isManagedMaintenancePrompt` (`objective-identity.js:10`).
pub fn is_managed_maintenance_prompt(body: Value) -> Result<Value, String> {
    let Some(parts) = at(&body, &["parts"]).as_array().cloned() else {
        return Ok(Value::Bool(false));
    };
    for part in parts.iter().filter(|p| synthetic_text(p)) {
        if text_starts(part, "[devryan-plan-action:v1] ")? || text_starts(part, "[openchamber-plan-action:v1] ")? {
            return Ok(Value::Bool(false));
        }
    }
    let marker = |t: &str| {
        let recovery = t
            .strip_prefix("[devryan-provider-recovery:v1:")
            .and_then(|r| r.find(']').filter(|i| *i > 0).map(|i| &r[..i]))
            .is_some_and(|body| !body.contains(['\r', '\n']));
        recovery || t.starts_with("[devryan-open-todo-continuation:v1]\n") || t.starts_with("[devryan-managed-result-ready:v1]\n")
    };
    let maintenance = parts.iter().any(compaction_part) || parts.iter().any(|p| synthetic_text(p) && text(&prop(p, "text")).is_some_and(|t| marker(&t)));
    Ok(Value::Bool(maintenance))
}

fn status_record(v: &Value) -> bool {
    record(v)
        && is(&at(v, &["info", "role"]), "user")
        && is(&at(v, &["nativeStatus", "source"]), "native-sequence")
        && is(&at(v, &["nativeStatus", "kind"]), "status-only")
}

/// Port of `observesNativeContinuation` (`objective-identity.js:21`).
pub fn observes_native_continuation(record: Value, observation: Value, user_message_id: Value) -> Result<Value, String> {
    let session = at(&observation, &["session"]);
    if !truthy(&at(&observation, &["complete"])) || !eq(&at(&session, &["id"]), &get(&record, "sessionID")?) {
        return Ok(Value::Bool(false));
    }
    let messages = prop(&observation, "messages");
    if !eq(&get(&session, "directory")?, &prop(&record, "directory"))
        || truthy(&prop(&session, "parentID"))
        || truthy(&at(&session, &["time", "archived"]))
        || !messages.is_array()
    {
        return Ok(Value::Bool(false));
    }
    let mut users = Vec::new();
    for m in messages.as_array().into_iter().flatten() {
        if is(&at(&get(m, "info")?, &["role"]), "user") && !status_record(m) {
            users.push(m.clone());
        }
    }
    let id = |m: &Value| at(m, &["info", "id"]);
    let current = current_user(&record)?;
    let Some(previous) = users.iter().position(|m| eq(&id(m), &current)) else {
        return Ok(Value::Bool(false));
    };
    let anchor = prop(&record, "anchorID");
    if !users.iter().any(|m| eq(&id(m), &anchor)) || !eq(&users.last().map_or_else(js::undefined, id), &user_message_id) || previous + 1 == users.len() {
        return Ok(Value::Bool(false));
    }
    Ok(Value::Bool(users[previous + 1..].iter().all(compaction)))
}
