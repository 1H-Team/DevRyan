//! The Rust port of `opencode/v2/projection/sessions.js` (14 of 17 exports) over any JS value.
//! Kept in JS: `toV1SessionList` (the caller's `slugOf` callback) and `sortSessionPage` /
//! `pageV1Sessions` (ICU `localeCompare`). `toV1PathInfo` (from `messages.js`) is Node's POSIX
//! `dirname`/`join`/`normalize` over UTF-16 units. A `Map`, `Set` or `Date` is a record without
//! own fields; values returned unchanged are the input as given.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

const MARKERS: [&str; 5] = ["$utf16", "$num", "$undefined", "$function", "$bigint"];
const SLASH: u16 = 0x2f;
const DOT: u16 = 0x2e;

fn marker(value: &Value) -> Option<&str> {
    value
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.keys().next())
        .map(String::as_str)
        .filter(|k| k.starts_with('$'))
}

fn is_record(value: &Value) -> bool {
    value.is_object() && !marker(value).is_some_and(|m| MARKERS.contains(&m))
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|_| marker(value).is_none())
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn non_empty(value: &Value) -> bool {
    js::string_units(value).is_some_and(|u| !u.is_empty())
}

fn is_string(value: &Value) -> bool {
    js::string_units(value).is_some()
}

fn finite(value: &Value) -> Option<f64> {
    js::as_number(value).filter(|n| n.is_finite())
}

fn finite_or(value: &Value, fallback: Value) -> Value {
    finite(value).map_or(fallback, js::number)
}

fn timestamp(value: &Value) -> Option<Value> {
    finite(value).filter(|n| *n >= 0.0).map(js::number)
}

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn read_field(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        let shown = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {shown} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
}

/// `Object.keys(value)`: a record's own keys; a typed array its indexes; a `Map`, `Set` or `Date` none.
fn own_keys(value: &Value) -> usize {
    match marker(value) {
        Some("$bytes") => value["$bytes"].as_array().map_or(0, Vec::len),
        Some(_) => 0,
        None => value.as_object().map_or(0, Map::len),
    }
}

/// `{ ...value }` without `removed`.
fn rest(value: &Value, removed: &[&str]) -> Map<String, Value> {
    match marker(value) {
        Some("$bytes") => value["$bytes"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, b)| (i.to_string(), b.clone()))
            .collect(),
        Some(_) => Map::new(),
        None => value
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(k, _)| !removed.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    }
}

fn owned_entry(metadata: &Value, key: &Value, session_id: &Value) -> Value {
    let Some(id) = js::string_units(session_id).filter(|u| !u.is_empty()) else {
        return js::undefined();
    };
    let devryan = field(metadata, "devryan");
    if !is_record(metadata) || !is_record(&devryan) {
        return js::undefined();
    }
    // `devryan[key]` with the key's `String()`; only string keys reach plain own fields.
    let key = js::as_number(key).map(js::number_to_string).or_else(|| key.as_str().map(String::from));
    let entry = key.map_or_else(js::undefined, |k| field(&devryan, &k));
    if !is_record(&entry) || js::string_units(&field(&entry, "sessionID")) != Some(id) {
        return js::undefined();
    }
    entry
}

/// Port of `readOwnedDevryanEntry` (`sessions.js:65`).
pub fn read_owned_devryan_entry(metadata: Value, key: Value, session_id: Value) -> Result<Value, String> {
    Ok(owned_entry(&metadata, &key, &session_id))
}

fn archive_override(metadata: &Value, session_id: &Value) -> Option<Value> {
    let entry = owned_entry(metadata, &"archive".into(), session_id);
    let at = field(&entry, "at");
    if js::is_undefined(&entry) {
        return None;
    }
    if at.is_null() {
        return Some(json!({ "at": null }));
    }
    finite(&at).map(|n| json!({ "at": js::number(n) }))
}

/// Port of `readArchiveOverride` (`sessions.js:81`).
pub fn read_archive_override(metadata: Value, session_id: Value) -> Result<Value, String> {
    Ok(archive_override(&metadata, &session_id).unwrap_or_else(js::undefined))
}

/// Port of `isArchiveOverrideArchived` (`sessions.js:93`).
pub fn is_archive_override_archived(r#override: Value) -> Result<Value, String> {
    Ok(finite(&read_field(&r#override, "at")?).is_some_and(|n| n > 0.0).into())
}

fn session_todo(metadata: &Value, session_id: &Value) -> Value {
    let entry = owned_entry(metadata, &"todo".into(), session_id);
    let Value::Array(items) = field(&entry, "items") else { return Value::Null };
    let todo = |i: &&Value| is_record(i) && is_string(&field(i, "content")) && is_string(&field(i, "status"));
    json!({ "items": items.iter().filter(todo).cloned().collect::<Vec<_>>(), "rev": finite_or(&field(&entry, "rev"), 0.into()) })
}

/// Port of `readSessionTodo` (`sessions.js:107`).
pub fn read_session_todo(metadata: Value, session_id: Value) -> Result<Value, String> {
    Ok(session_todo(&metadata, &session_id))
}

/// Port of `toV1SessionTodos` (`sessions.js:119`).
pub fn to_v1_session_todos(session: Value) -> Result<Value, String> {
    if !is_record(&session) {
        return Ok(json!([]));
    }
    let todo = session_todo(&field(&session, "metadata"), &field(&session, "id"));
    Ok(if todo.is_null() { json!([]) } else { todo["items"].clone() })
}

fn strip(metadata: &Value) -> Option<Value> {
    if !is_record(metadata) {
        return None;
    }
    if plain(metadata).is_none_or(|o| !o.contains_key("devryan")) {
        return (own_keys(metadata) > 0).then(|| metadata.clone());
    }
    let rest = rest(metadata, &["devryan"]);
    (!rest.is_empty()).then_some(Value::Object(rest))
}

/// Port of `stripDevryanMetadata` (`sessions.js:129`).
pub fn strip_devryan_metadata(metadata: Value) -> Result<Value, String> {
    Ok(strip(&metadata).unwrap_or_else(js::undefined))
}

fn v1_tool_name(name: Value) -> Value {
    match name.as_str() {
        Some("shell") => "bash".into(),
        Some("subagent") => "task".into(),
        Some("patch") => "apply_patch".into(),
        _ => name,
    }
}

fn permission_ruleset(rules: &Value) -> Option<Value> {
    let rules = rules.as_array()?;
    let valid = |r: &&Value| is_record(r) && ["action", "resource", "effect"].iter().all(|k| is_string(&field(r, k)));
    let rule = |r: &Value| json!({ "permission": v1_tool_name(field(r, "action")), "pattern": field(r, "resource"), "action": field(r, "effect") });
    Some(rules.iter().filter(valid).map(rule).collect())
}

/// Port of `toV1PermissionRuleset` (`sessions.js:148`).
pub fn to_v1_permission_ruleset(rules: Value) -> Result<Value, String> {
    Ok(permission_ruleset(&rules).unwrap_or_else(js::undefined))
}

fn revert_of(revert: &Value) -> Option<Value> {
    let message_id = field(revert, "messageID");
    if !is_record(revert) || !non_empty(&message_id) {
        return None;
    }
    let mut out = Map::from_iter([("messageID".into(), message_id)]);
    for key in ["partID", "snapshot"] {
        Some(field(revert, key)).filter(non_empty).map(|v| out.insert(key.into(), v));
    }
    if let Value::Array(files) = field(revert, "files") {
        out.insert(
            "files".into(),
            files.iter().filter(|f| is_record(f)).map(|f| Value::Object(rest(f, &["patch"]))).collect(),
        );
    }
    Some(Value::Object(out))
}

/// Port of `toV1Revert` (`sessions.js:164`).
pub fn to_v1_revert(revert: Value) -> Result<Value, String> {
    Ok(revert_of(&revert).unwrap_or_else(js::undefined))
}

fn tokens_of(tokens: &Value) -> Option<Value> {
    let cache = Some(field(tokens, "cache")).filter(is_record).unwrap_or_else(|| json!({}));
    let count = |v: &Value, k: &str| finite_or(&field(v, k), 0.into());
    is_record(tokens).then(|| {
        json!({ "input": count(tokens, "input"), "output": count(tokens, "output"), "reasoning": count(tokens, "reasoning"),
            "cache": { "read": count(&cache, "read"), "write": count(&cache, "write") } })
    })
}

fn model_of(model: &Value) -> Option<Value> {
    let (id, provider, variant) = (field(model, "id"), field(model, "providerID"), field(model, "variant"));
    if !is_record(model) || !is_string(&id) || !is_string(&provider) {
        return None;
    }
    Some(if is_string(&variant) {
        json!({ "id": id, "providerID": provider, "variant": variant })
    } else {
        json!({ "id": id, "providerID": provider })
    })
}

fn fork_of(fork: &Value) -> Option<Value> {
    let (session_id, boundary) = (field(fork, "sessionID"), field(fork, "boundary"));
    if !is_record(fork) || !non_empty(&session_id) || !is_record(&boundary) {
        return None;
    }
    let (kind, message_id) = (field(&boundary, "type"), field(&boundary, "messageID"));
    (matches!(kind.as_str(), Some("before" | "through")) && non_empty(&message_id))
        .then(|| json!({ "sessionID": session_id, "boundary": { "type": kind, "messageID": message_id } }))
}

/// Port of `toV1Fork` (`sessions.js:203`).
pub fn to_v1_fork(fork: Value) -> Result<Value, String> {
    Ok(fork_of(&fork).unwrap_or_else(js::undefined))
}

fn directory_of(session: &Value) -> Option<Value> {
    let location = field(session, "location");
    Some(field(&location, "directory")).filter(|d| is_record(session) && is_record(&location) && non_empty(d))
}

/// Port of `sessionDirectory` (`sessions.js:216`).
pub fn session_directory(session: Value) -> Result<Value, String> {
    Ok(directory_of(&session).unwrap_or_else(js::undefined))
}

/// Port of `toV1Session` (`sessions.js:237`).
pub fn to_v1_session(info: Value, options: Value) -> Result<Value, String> {
    let id = field(&info, "id");
    if !is_record(&info) || !non_empty(&id) {
        return Ok(js::undefined());
    }
    let time = Some(field(&info, "time")).filter(is_record).unwrap_or_else(|| json!({}));
    let created = finite_or(&field(&time, "created"), 0.into());
    let metadata = field(&info, "metadata");
    let archived = archive_override(&metadata, &id).map_or_else(|| field(&time, "archived"), |o| o["at"].clone());
    let mut times = Map::from_iter([
        ("created".into(), created.clone()),
        ("updated".into(), finite_or(&field(&time, "updated"), created)),
    ]);
    finite(&archived).map(|n| times.insert("archived".into(), js::number(n)));
    for key in ["busy", "idle", "viewed"] {
        timestamp(&field(&time, key)).map(|t| times.insert(key.into(), t));
    }
    let slug = if js::is_undefined(&options) {
        js::undefined()
    } else {
        read_field(&options, "slug")?
    };
    let text_or_empty = |key: &str| Some(field(&info, key)).filter(is_string).unwrap_or_else(|| "".into());
    let mut session = Map::new();
    session.extend([
        ("id".into(), id.clone()),
        ("slug".into(), if non_empty(&slug) { slug } else { id.clone() }),
        ("projectID".into(), text_or_empty("projectID")),
        ("directory".into(), directory_of(&info).unwrap_or_else(|| "".into())),
        ("title".into(), text_or_empty("title")),
        ("version".into(), "2".into()),
        ("time".into(), Value::Object(times)),
    ]);
    Some(field(&info, "subpath")).filter(non_empty).map(|p| session.insert("path".into(), p));
    let outcome = field(&info, "outcome");
    if matches!(outcome.as_str(), Some("succeeded" | "failed" | "interrupted")) {
        session.insert("outcome".into(), outcome);
    }
    Some(field(&info, "parentID")).filter(non_empty).map(|p| session.insert("parentID".into(), p));
    fork_of(&field(&info, "fork")).map(|f| session.insert("fork".into(), f));
    Some(field(&info, "agent")).filter(non_empty).map(|a| session.insert("agent".into(), a));
    model_of(&field(&info, "model")).map(|m| session.insert("model".into(), m));
    finite(&field(&info, "cost")).map(|c| session.insert("cost".into(), js::number(c)));
    tokens_of(&field(&info, "tokens")).map(|t| session.insert("tokens".into(), t));
    strip(&metadata).map(|m| session.insert("metadata".into(), m));
    permission_ruleset(&field(&info, "permissions")).map(|p| session.insert("permission".into(), p));
    revert_of(&field(&info, "revert")).map(|r| session.insert("revert".into(), r));
    Ok(Value::Object(session))
}

/// Port of `toV1SessionFromCreated` (`sessions.js:288`).
pub fn to_v1_session_from_created(data: Value, created: Value) -> Result<Value, String> {
    let session_id = field(&data, "sessionID");
    if !is_record(&data) || !non_empty(&session_id) {
        return Ok(js::undefined());
    }
    let mut info = rest(&data, &["sessionID", "slug", "version"]);
    info.insert("id".into(), session_id);
    let time = finite(&created).map_or_else(|| json!({}), |n| json!({ "created": js::number(n), "updated": js::number(n) }));
    info.insert("time".into(), time);
    let slug = Some(field(&data, "slug")).filter(is_string).unwrap_or_else(js::undefined);
    to_v1_session(Value::Object(info), json!({ "slug": slug }))
}

/// Port of `isV1SessionArchived` (`sessions.js:320`).
pub fn is_v1_session_archived(session: Value) -> Result<Value, String> {
    let time = field(&session, "time");
    Ok((is_record(&session) && is_record(&time) && finite(&field(&time, "archived")).is_some()).into())
}

fn normalize(p: &[u16]) -> Vec<u16> {
    if p.is_empty() {
        return vec![DOT];
    }
    let (absolute, trailing) = (p[0] == SLASH, p.last() == Some(&SLASH));
    let mut stack: Vec<&[u16]> = Vec::new();
    for seg in p.split(|u| *u == SLASH) {
        match seg {
            [] | [DOT] => {}
            [DOT, DOT] if stack.last().is_some_and(|l| *l != [DOT, DOT]) => drop(stack.pop()),
            [DOT, DOT] if absolute => {}
            s => stack.push(s),
        }
    }
    let mut out = stack.join(&[SLASH][..]);
    if out.is_empty() && !absolute {
        out = vec![DOT];
    }
    if trailing && !out.is_empty() {
        out.push(SLASH);
    }
    if absolute { [&[SLASH][..], &out].concat() } else { out }
}

fn dirname(p: &[u16]) -> Vec<u16> {
    if p.is_empty() {
        return vec![DOT];
    }
    let root = p[0] == SLASH;
    let mut matched_slash = true;
    let mut end = None;
    for i in (1..p.len()).rev() {
        if p[i] == SLASH {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => vec![if root { SLASH } else { DOT }],
        Some(1) if root => vec![SLASH, SLASH],
        Some(e) => p[..e].to_vec(),
    }
}

/// `toV1PathInfo(directory, subpath)` from `messages.js`.
fn path_info(directory: &Value, subpath: &Value) -> (Vec<u16>, Vec<u16>) {
    let cwd = js::string_units(directory).unwrap_or_default();
    let mut root = cwd.clone();
    if let Some(sub) = js::string_units(subpath).filter(|s| !cwd.is_empty() && !s.is_empty() && s[0] != SLASH) {
        let segments: Vec<&[u16]> = sub.split(|u| *u == SLASH).filter(|s| !s.is_empty() && *s != [DOT]).collect();
        if !segments.is_empty() && !segments.contains(&&[DOT, DOT][..]) {
            let candidate = segments.iter().fold(cwd.clone(), |c, _| dirname(&c));
            if normalize(&[&candidate[..], &[SLASH], &sub].concat()) == normalize(&cwd) {
                root = candidate;
            }
        }
    }
    (cwd, root)
}

/// Port of `sessionMessageContext` (`sessions.js:364`).
pub fn session_message_context(info: Value) -> Result<Value, String> {
    let id = field(&info, "id");
    if !is_record(&info) || !non_empty(&id) {
        return Ok(js::undefined());
    }
    let (cwd, root) = path_info(&directory_of(&info).unwrap_or_else(js::undefined), &field(&info, "subpath"));
    let mut context = Map::from_iter([
        ("sessionID".into(), id),
        ("directory".into(), js::utf16_string(&root)),
        ("cwd".into(), js::utf16_string(&cwd)),
    ]);
    Some(field(&info, "agent")).filter(non_empty).map(|a| context.insert("agent".into(), a));
    model_of(&field(&info, "model")).map(|m| context.insert("model".into(), m));
    Ok(Value::Object(context))
}
