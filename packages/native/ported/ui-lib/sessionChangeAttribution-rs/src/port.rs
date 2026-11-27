//! The Rust port of `sessionChangeAttribution.ts`, with `normalizeToolStatus` (`@/lib/toolStatus`)
//! and `messagesBefore` (`@/sync/message-order`) alongside, over any JS value. The two patch
//! regexes are matched by hand with their backtracking (lazy `(.+?)`, `.` stopping at line
//! terminators); the absolute-path check lowercases both sides but slices the raw path by the
//! directory's own UTF-16 length, as the JS does.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::js;

const FILE_MUTATION_TOOLS: [&str; 8] = [
    "apply_patch",
    "create",
    "edit",
    "file_write",
    "multiedit",
    "str_replace",
    "str_replace_based_edit_tool",
    "write",
];
const UNATTRIBUTED_MUTATION_TOOLS: [&str; 4] = ["bash", "cmd", "powershell", "terminal"];
const TOOL_NAME_ALIASES: [(&str, &str); 21] = [
    ("applypatch", "apply_patch"),
    ("apply_patch_tool", "apply_patch"),
    ("patch", "apply_patch"),
    ("file_patch", "apply_patch"),
    ("patch_file", "apply_patch"),
    ("apply_diff", "apply_patch"),
    ("edit_file", "edit"),
    ("file_edit", "edit"),
    ("write_file", "write"),
    ("create_file", "create"),
    ("oc_write", "write"),
    ("oc_edit", "edit"),
    ("oc_bash", "bash"),
    ("shell_command", "bash"),
    ("terminal_command", "bash"),
    ("run_command", "bash"),
    ("execute_command", "bash"),
    ("exec_command", "bash"),
    ("command", "bash"),
    ("shell", "bash"),
    ("sh", "bash"),
];
const PATH_KEYS: [&str; 9] = [
    "filePath",
    "file_path",
    "targetFile",
    "target_file",
    "relativePath",
    "movePath",
    "path",
    "file",
    "filename",
];
const PATCH_KEYS: [&str; 4] = ["patch", "patchText", "diff", "changes"];

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `value.key`, failing as V8 does on `null` and `undefined`.
fn get(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
}

/// JS `===` between values received from JS (objects are never the same reference).
fn strict_eq(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b)) {
        (Some(x), Some(y)) => return x == y,
        (Some(_), None) | (None, Some(_)) => return false,
        _ => {}
    }
    match (a, b) {
        (Value::Null, Value::Null) | (Value::Bool(_), Value::Bool(_)) | (Value::String(_), Value::String(_)) => a == b,
        _ if js::is_undefined(a) && js::is_undefined(b) => true,
        _ => match (js::string_units(a), js::string_units(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
    }
}

fn marker(value: &Value) -> Option<&str> {
    let o = value.as_object().filter(|o| o.len() == 1)?;
    ["$undefined", "$num", "$utf16", "$map", "$set", "$bytes", "$function"]
        .into_iter()
        .find(|k| o.contains_key(*k))
}

/// `isRecord`: `typeof value === 'object'`, not `null`, not an array (a `Map` counts).
fn record(value: &Value) -> bool {
    value.is_object() && !matches!(marker(value), Some("$undefined" | "$num" | "$utf16" | "$function"))
}

/// `value.key` of a non-nullish value: own properties of plain objects, else `undefined`.
fn field(value: &Value, key: &str) -> Value {
    match value {
        Value::Object(o) if marker(value).is_none() => o.get(key).cloned().unwrap_or_else(js::undefined),
        _ => js::undefined(),
    }
}

/// `String(key)` for a property read.
fn key_text(key: &Value) -> String {
    match key {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        _ if js::is_undefined(key) => "undefined".into(),
        _ => js::as_number(key).map(js::number_to_string).unwrap_or_else(|| "[object Object]".into()),
    }
}

/// `value[key] ?? []` iterated with `for...of`.
fn iterate_or_empty(value: Value, name: &str) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        ref v if nullish(v) => Ok(Vec::new()),
        Value::Object(o) if o.len() == 1 && o.get("$set").is_some_and(Value::is_array) => Ok(o["$set"].as_array().cloned().unwrap_or_default()),
        Value::Bool(flag) => Err(format!("boolean {flag} {name}")), // recorded-literal: V8 TypeError text
        ref v if js::as_number(v).is_some() => Err(format!("number {} {name}", js::number_to_string(js::as_number(v).unwrap_or(f64::NAN)))),
        _ => Err(format!("object {name}")), // recorded-literal: V8 TypeError text
    }
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn space(c: char) -> bool {
    js_space(c)
}

/// `\s+ (prefix)? (.+?) \s* $` over `rest`, with the regex's backtracking: the capture.
fn lazy_capture(rest: &[char], prefixes: &[&str]) -> Option<String> {
    let run = rest.iter().take_while(|c| space(**c)).count();
    for k in (1..=run).rev() {
        for prefix in prefixes {
            let after = &rest[k..];
            let p: Vec<char> = prefix.chars().collect();
            if !after.starts_with(&p) {
                continue;
            }
            let body = &after[p.len()..];
            for m in 1..=body.len() {
                if is_line_terminator(body[m - 1]) {
                    break;
                }
                if body[m..].iter().all(|c| space(*c)) {
                    return Some(body[..m].iter().collect());
                }
            }
        }
    }
    None
}

/// `collectPatchPaths`.
fn patch_paths(value: &Value, target: &mut Vec<Value>) {
    let Some(text) = value.as_str() else { return };
    for line in text.split('\n') {
        let chars: Vec<char> = line.chars().collect();
        let apply = ["*** Add File:", "*** Delete File:", "*** Update File:", "*** Move to File:"]
            .iter()
            .find_map(|head| line.strip_prefix(head).map(|_| head.chars().count()))
            .and_then(|n| lazy_capture(&chars[n..], &[""]));
        if let Some(path) = apply.filter(|p| !p.is_empty()) {
            target.push(Value::String(path));
            continue;
        }
        let unified = (line.starts_with("+++") || line.starts_with("---"))
            .then(|| lazy_capture(&chars[3..], &["a/", "b/", ""]))
            .flatten();
        if let Some(path) = unified.filter(|p| !p.is_empty() && p != "/dev/null") {
            target.push(Value::String(path));
        }
    }
}

fn record_paths(record: &Value, target: &mut Vec<Value>) {
    target.extend(PATH_KEYS.iter().map(|k| field(record, k)));
}

/// `collectToolPathCandidates`.
fn tool_path_candidates(part: &Value) -> Vec<Value> {
    let state = field(part, "state");
    let state = if record(&state) { state } else { json!({}) };
    let pick = |key: &str| {
        let own = field(&state, key);
        if record(&own) {
            return own;
        }
        let outer = field(part, key);
        if record(&outer) { outer } else { json!({}) }
    };
    let (input, metadata) = (pick("input"), pick("metadata"));
    let mut candidates = Vec::new();
    record_paths(&input, &mut candidates);
    record_paths(&metadata, &mut candidates);
    for container in [&input, &metadata] {
        for key in PATCH_KEYS {
            patch_paths(&field(container, key), &mut candidates);
        }
    }
    if let Value::Array(files) = field(&metadata, "files") {
        files.iter().filter(|f| record(f)).for_each(|f| record_paths(f, &mut candidates));
    }
    let filediff = field(&metadata, "filediff");
    if record(&filediff) {
        record_paths(&filediff, &mut candidates);
    }
    if let Value::Array(results) = field(&metadata, "results") {
        for result in results.iter().filter(|r| record(r)) {
            let diff = field(result, "filediff");
            if record(&diff) {
                record_paths(&diff, &mut candidates);
            }
        }
    }
    candidates
}

/// `normalizeToolName`.
fn tool_name(value: &Value) -> String {
    let Some(text) = value.as_str() else { return String::new() };
    let trimmed = text.trim_matches(js_space);
    if trimmed.is_empty() {
        return String::new();
    }
    let mut name = match trimmed.rfind(':') {
        Some(at) if at + 1 < trimmed.len() && trimmed[at + 1..].bytes().all(|b| b.is_ascii_digit()) => &trimmed[..at],
        _ => trimmed,
    };
    if name.contains('.') {
        name = name.split('.').rfind(|s| !s.is_empty()).unwrap_or(name);
    }
    let chars: Vec<char> = name.chars().collect();
    let mut split = String::with_capacity(name.len() + 4);
    let mut i = 0;
    while i < chars.len() {
        split.push(chars[i]);
        if (chars[i].is_ascii_lowercase() || chars[i].is_ascii_digit()) && chars.get(i + 1).is_some_and(char::is_ascii_uppercase) {
            split.push('_');
            split.push(chars[i + 1]);
            i += 1;
        }
        i += 1;
    }
    let mut joined = String::with_capacity(split.len());
    let mut in_run = false;
    for c in split.chars() {
        if c == '-' || space(c) {
            if !in_run {
                joined.push('_');
            }
            in_run = true;
        } else {
            joined.push(c);
            in_run = false;
        }
    }
    let lower = joined.to_lowercase();
    let stripped = ["_tool_call", "tool_call", "_toolcall", "toolcall"]
        .iter()
        .find_map(|s| lower.strip_suffix(s))
        .unwrap_or(&lower)
        .to_string();
    TOOL_NAME_ALIASES
        .iter()
        .find(|(k, _)| *k == stripped)
        .map_or(stripped, |(_, v)| (*v).to_string())
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `normalizeCandidatePath`.
fn candidate_path(value: &Value, directory: &Value) -> Result<Option<String>, String> {
    let Some(text) = value.as_str() else { return Ok(None) };
    let slashed = text.trim_matches(js_space).replace('\\', "/");
    let mut raw = String::with_capacity(slashed.len());
    for c in slashed.chars() {
        if !(c == '/' && raw.ends_with('/')) {
            raw.push(c);
        }
    }
    if raw.is_empty() {
        return Ok(None);
    }
    let Some(directory) = directory.as_str() else {
        return Err("value.trim is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let base = directory.trim_matches(js_space).replace('\\', "/");
    let base = base.trim_end_matches('/');
    let base = if base.is_empty() { "/" } else { base };
    let bytes = raw.as_bytes();
    let absolute = raw.starts_with('/') || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/');
    let mut relative = raw.clone();
    if absolute {
        let (lower_raw, lower_base) = (raw.to_lowercase(), base.to_lowercase());
        if lower_raw == lower_base || !lower_raw.starts_with(&format!("{lower_base}/")) {
            return Ok(None);
        }
        let raw_units = units(&raw);
        let cut = (units(base).len() + 1).min(raw_units.len());
        relative = String::from_utf16_lossy(&raw_units[cut..]);
    }
    let relative = relative.strip_prefix("./").unwrap_or(&relative).trim_end_matches('/');
    if relative.is_empty() || relative == "." || relative.starts_with("../") || relative.contains("/../") {
        return Ok(None);
    }
    Ok(Some(relative.to_string()))
}

/// `isSuccessfulToolPart` (after the `type` check): `normalizeToolStatus(state?.status)`.
fn successful(part: &Value) -> bool {
    let state = field(part, "state");
    let status = if nullish(&state) { js::undefined() } else { field(&state, "status") };
    let Some(status) = status.as_str() else { return false };
    let normalized: String = status.to_lowercase().chars().filter(|c| !space(*c) && *c != '_' && *c != '-').collect();
    matches!(normalized.as_str(), "complete" | "completed" | "done")
}

/// `getVisibleMessages`.
fn visible_messages(state: &Value, session_id: &Value) -> Result<Value, String> {
    let messages = get(&get(state, "message")?, &key_text(session_id))?;
    let messages = if nullish(&messages) { json!([]) } else { messages };
    let sessions = get(state, "session")?;
    let Value::Array(list) = &sessions else {
        get(&sessions, "find")?;
        return Err("state.session.find is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let mut session = js::undefined();
    for entry in list {
        if strict_eq(&get(entry, "id")?, session_id) {
            session = entry.clone();
            break;
        }
    }
    let revert = if nullish(&session) { js::undefined() } else { field(&session, "revert") };
    let marker = if nullish(&revert) { js::undefined() } else { field(&revert, "messageID") };
    if marker.as_str().is_none_or(str::is_empty) {
        return Ok(messages);
    }
    let Value::Array(items) = &messages else {
        get(&messages, "findIndex")?;
        return Err("messages.findIndex is not a function".into()); // recorded-literal: V8 TypeError text
    };
    for (index, message) in items.iter().enumerate() {
        if strict_eq(&get(message, "id")?, &marker) {
            return Ok(Value::Array(items[..index].to_vec()));
        }
    }
    Ok(messages)
}

fn empty() -> Value {
    json!({ "paths": [], "hasUnattributedMutations": false })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// Port of `projectSessionChangeAttribution` (`sessionChangeAttribution.ts:208`).
pub fn project_session_change_attribution(state: Value, session_id: Value, directory: Value) -> Result<Value, String> {
    if !truthy(&session_id) || !truthy(&directory) {
        return Ok(empty());
    }
    let mut paths = BTreeSet::new();
    let mut unattributed = false;
    let visible = visible_messages(&state, &session_id)?;
    for message in iterate_or_empty(visible, "is not iterable (cannot read property Symbol(Symbol.iterator))").map_err(|_| {
        "getVisibleMessages is not a function or its return value is not iterable".to_string() // recorded-literal: V8 TypeError text
    })? {
        if get(&message, "role")?.as_str() != Some("assistant") {
            continue;
        }
        let parts = get(&get(&state, "part")?, &key_text(&field(&message, "id")))?;
        for part in iterate_or_empty(parts, "is not iterable (cannot read property Symbol(Symbol.iterator))")? {
            if get(&part, "type")?.as_str() != Some("tool") || !successful(&part) {
                continue;
            }
            let tool = tool_name(&field(&part, "tool"));
            if UNATTRIBUTED_MUTATION_TOOLS.contains(&tool.as_str()) {
                unattributed = true;
                continue;
            }
            if !FILE_MUTATION_TOOLS.contains(&tool.as_str()) {
                continue;
            }
            let mut attributed = false;
            for candidate in tool_path_candidates(&part) {
                if let Some(path) = candidate_path(&candidate, &directory)? {
                    paths.insert(units(&path));
                    attributed = true;
                }
            }
            unattributed |= !attributed;
        }
    }
    if paths.is_empty() && !unattributed {
        return Ok(empty());
    }
    let paths: Vec<Value> = paths.into_iter().map(|u| js::utf16_string(&u)).collect();
    Ok(json!({ "paths": paths, "hasUnattributedMutations": unattributed }))
}

/// `value.length`.
fn length(value: &Value) -> Result<Value, String> {
    if let Some(u) = js::string_units(value) {
        return Ok(js::number(u.len() as f64));
    }
    match value {
        Value::Array(items) => Ok(js::number(items.len() as f64)),
        _ => get(value, "length"),
    }
}

/// Port of `areSessionChangeAttributionsEqual` (`sessionChangeAttribution.ts:248`).
pub fn are_session_change_attributions_equal(left: Value, right: Value) -> Result<bool, String> {
    if !truthy(&left) {
        let none = strict_eq(&length(&get(&right, "paths")?)?, &js::number(0.0));
        return Ok(none && !truthy(&field(&right, "hasUnattributedMutations")));
    }
    if !strict_eq(&field(&left, "hasUnattributedMutations"), &get(&right, "hasUnattributedMutations")?) {
        return Ok(false);
    }
    let left_paths = get(&left, "paths")?;
    let left_length = length(&left_paths)?;
    let right_paths = get(&right, "paths")?;
    if !strict_eq(&left_length, &length(&right_paths)?) {
        return Ok(false);
    }
    let Value::Array(items) = &left_paths else {
        get(&left_paths, "every")?;
        return Err("left.paths.every is not a function".into()); // recorded-literal: V8 TypeError text
    };
    Ok(items.iter().enumerate().all(|(i, p)| {
        let other = match &right_paths {
            Value::Array(r) => r.get(i).cloned().unwrap_or_else(js::undefined),
            v => js::string_units(v)
                .and_then(|u| u.get(i).map(|x| js::utf16_string(&[*x])))
                .unwrap_or_else(|| field(v, &i.to_string())),
        };
        strict_eq(p, &other)
    }))
}
