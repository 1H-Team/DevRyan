//! The Rust port of `opencode/v2/projection/tools.js` (all 10 exports) over any JS value. "Returns
//! the same reference" is returning the value unchanged; `{...x}` copies keep the key order; a
//! `Map`, `Set` or `Date` is a record without own fields. Template literals print with `String()`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

const MARKERS: [&str; 5] = ["$utf16", "$num", "$undefined", "$function", "$bigint"];

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

fn has_own(value: &Value, key: &str) -> bool {
    plain(value).is_some_and(|o| o.contains_key(key))
}

fn has_key(value: &Value, key: &str) -> bool {
    has_own(value, key) && !js::is_undefined(&field(value, key))
}

fn non_empty_string(value: &Value) -> bool {
    js::string_units(value).is_some_and(|u| !u.is_empty())
}

fn finite(value: &Value) -> Option<f64> {
    js::as_number(value).filter(|n| n.is_finite())
}

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// The value handed back unchanged (a number marker crosses back as a number).
fn same(value: Value) -> Value {
    js::as_number(&value).map_or(value, js::number)
}

/// `a === b` for values that crossed the bindings: two objects are never the same reference.
fn strict_equal(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), _, _) => x == y,
        (None, None, Some(x), Some(y)) => x == y,
        (None, None, None, None) => (js::is_undefined(a) && js::is_undefined(b)) || (!a.is_object() && !a.is_array() && a == b),
        _ => false,
    }
}

/// `String(value)` as UTF-16 units.
fn text(value: &Value) -> Vec<u16> {
    if let Some(units) = js::string_units(value) {
        return units;
    }
    let s = match value {
        Value::Null => "null".to_string(),
        _ if js::is_undefined(value) => "undefined".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => {
            return items
                .iter()
                .map(|v| if nullish(v) { Vec::new() } else { text(v) })
                .collect::<Vec<_>>()
                .join(&[0x2c][..]);
        }
        _ if marker(value) == Some("$map") => "[object Map]".into(),
        _ if marker(value) == Some("$set") => "[object Set]".into(),
        _ if marker(value) == Some("$bigint") => field_str(value, "$bigint"),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    s.encode_utf16().collect()
}

fn field_str(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn template(parts: &[&Value], seps: &[&str]) -> Value {
    let mut out = text(parts[0]);
    for (part, sep) in parts[1..].iter().zip(seps) {
        out.extend(sep.encode_utf16());
        out.extend(text(part));
    }
    js::utf16_string(&out)
}

fn v1_name(name: &Value) -> Value {
    match name.as_str() {
        Some("shell") => "bash".into(),
        Some("subagent") => "task".into(),
        Some("patch") => "apply_patch".into(),
        _ => same(name.clone()),
    }
}

fn aliases(name: &Value) -> &'static [(&'static str, &'static str)] {
    match v1_name(name).as_str() {
        Some("read" | "edit" | "write") => &[("path", "filePath")],
        Some("task") => &[("agent", "subagent_type")],
        Some("skill") => &[("id", "name")],
        _ => &[],
    }
}

fn reviewed_skill_id(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| s.strip_prefix("devryan-"))
        .is_some_and(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn copy(value: &Value) -> Map<String, Value> {
    plain(value).cloned().unwrap_or_default()
}

/// Port of `toV1ToolName` (`tools.js:70`).
pub fn to_v1_tool_name(name: Value) -> Result<Value, String> {
    Ok(v1_name(&name))
}

/// Port of `toV2ToolName` (`tools.js:77`).
pub fn to_v2_tool_name(name: Value) -> Result<Value, String> {
    Ok(match name.as_str() {
        Some("bash") => "shell".into(),
        Some("task") => "subagent".into(),
        Some("apply_patch") => "patch".into(),
        _ => same(name),
    })
}

/// Port of `toV1ToolInput` (`tools.js:86`).
pub fn to_v1_tool_input(name: Value, input: Value) -> Result<Value, String> {
    if !is_record(&input) {
        return Ok(same(input));
    }
    let mut projected: Option<Map<String, Value>> = None;
    for (v2, v1) in aliases(&name) {
        if !has_key(&input, v2) || has_key(&input, v1) || (*v1 == "name" && reviewed_skill_id(&field(&input, v2))) {
            continue;
        }
        projected.get_or_insert_with(|| copy(&input)).insert((*v1).into(), field(&input, v2));
    }
    Ok(projected.map_or(input, Value::Object))
}

/// Port of `toV2ToolInput` (`tools.js:108`).
pub fn to_v2_tool_input(name: Value, input: Value) -> Result<Value, String> {
    if !is_record(&input) {
        return Ok(same(input));
    }
    let mut projected: Option<Map<String, Value>> = None;
    for (v2, v1) in aliases(&name) {
        if !has_own(&input, v1) {
            continue;
        }
        let out = projected.get_or_insert_with(|| copy(&input));
        if !has_key(&input, v2) && !js::is_undefined(&field(&input, v1)) {
            out.insert((*v2).into(), field(&input, v1));
        }
        out.shift_remove(*v1);
    }
    Ok(projected.map_or(input, Value::Object))
}

fn first_file_diff(metadata: &Value) -> Option<Value> {
    match field(metadata, "files") {
        Value::Array(files) => files.first().filter(|f| is_record(f)).cloned(),
        _ => None,
    }
}

fn file_diff_tool(name: &Value) -> bool {
    matches!(v1_name(name).as_str(), Some("edit" | "write"))
}

/// Port of `toV1ToolMetadata` (`tools.js:135`).
pub fn to_v1_tool_metadata(name: Value, metadata: Value) -> Result<Value, String> {
    if !is_record(&metadata) {
        return Ok(same(metadata));
    }
    if v1_name(&name).as_str() == Some("task") {
        if !non_empty_string(&field(&metadata, "sessionID")) || has_key(&metadata, "sessionId") {
            return Ok(metadata);
        }
        let mut out = copy(&metadata);
        out.insert("sessionId".into(), field(&metadata, "sessionID"));
        return Ok(Value::Object(out));
    }
    let Some(file) = first_file_diff(&metadata).filter(|_| file_diff_tool(&name)) else {
        return Ok(metadata);
    };
    let mut out: Option<Map<String, Value>> = None;
    if js::string_units(&field(&file, "patch")).is_some() && !has_key(&metadata, "diff") {
        out.get_or_insert_with(|| copy(&metadata)).insert("diff".into(), field(&file, "patch"));
    }
    if !has_key(&metadata, "filediff") {
        let diff = json!({ "file": field(&file, "file"), "additions": field(&file, "additions"), "deletions": field(&file, "deletions") });
        out.get_or_insert_with(|| copy(&metadata)).insert("filediff".into(), diff);
    }
    Ok(out.map_or(metadata, Value::Object))
}

/// Port of `toV2ToolMetadata` (`tools.js:166`).
pub fn to_v2_tool_metadata(name: Value, metadata: Value) -> Result<Value, String> {
    if !is_record(&metadata) {
        return Ok(same(metadata));
    }
    let removed: &[&str] = if v1_name(&name).as_str() == Some("task") {
        if !has_own(&metadata, "sessionId") || !strict_equal(&field(&metadata, "sessionId"), &field(&metadata, "sessionID")) {
            return Ok(metadata);
        }
        &["sessionId"]
    } else {
        if !file_diff_tool(&name) || first_file_diff(&metadata).is_none() || (!has_own(&metadata, "diff") && !has_own(&metadata, "filediff")) {
            return Ok(metadata);
        }
        &["diff", "filediff"]
    };
    let mut out = copy(&metadata);
    removed.iter().for_each(|k| drop(out.shift_remove(*k)));
    Ok(Value::Object(out))
}

fn title_of(input: &Value) -> Value {
    if !is_record(input) {
        return js::undefined();
    }
    ["description", "command", "filePath", "path"]
        .iter()
        .map(|k| field(input, k))
        .find(non_empty_string)
        .unwrap_or_else(js::undefined)
}

/// Port of `synthesizeToolTitle` (`tools.js:186`).
pub fn synthesize_tool_title(input: Value) -> Result<Value, String> {
    Ok(title_of(&input))
}

fn or_undefined(value: Option<f64>) -> Value {
    value.map_or_else(js::undefined, js::number)
}

fn content_text(content: &Value) -> Value {
    let Value::Array(items) = content else { return "".into() };
    let texts: Vec<Vec<u16>> = items
        .iter()
        .filter(|i| is_record(i) && field(i, "type").as_str() == Some("text"))
        .filter_map(|i| js::string_units(&field(i, "text")))
        .collect();
    js::utf16_string(&texts.join(&[0x0a][..]))
}

fn context_field(context: &Value, key: &str) -> Result<Value, String> {
    if nullish(context) {
        let shown = if context.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {shown} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(context, key))
}

fn content_attachments(content: &Value, call_id: &Value, context: &Value) -> Result<Vec<Value>, String> {
    let mut attachments = Vec::new();
    for item in content.as_array().into_iter().flatten() {
        if !is_record(item) || field(item, "type").as_str() != Some("file") || js::string_units(&field(item, "uri")).is_none() {
            continue;
        }
        let message_id = context_field(context, "messageID")?;
        let index = js::number(attachments.len() as f64);
        let mime = Some(field(item, "mime"))
            .filter(|m| js::string_units(m).is_some())
            .unwrap_or_else(|| "application/octet-stream".into());
        let mut attachment = Map::new();
        attachment.insert("id".into(), template(&[&message_id, call_id, &index], &[":tool:", ":file:"]));
        attachment.insert("sessionID".into(), field(context, "sessionID"));
        attachment.extend([
            ("messageID".into(), message_id),
            ("type".into(), "file".into()),
            ("mime".into(), mime),
            ("url".into(), field(item, "uri")),
        ]);
        if non_empty_string(&field(item, "name")) {
            attachment.insert("filename".into(), field(item, "name"));
        }
        attachments.push(Value::Object(attachment));
    }
    Ok(attachments)
}

fn with(mut base: Value, key: &str, value: Value) -> Value {
    if let Value::Object(o) = &mut base {
        o.insert(key.into(), value);
    }
    base
}

/// Port of `toV1ToolState` (`tools.js:260`).
pub fn to_v1_tool_state(tool: Value, context: Value) -> Result<Value, String> {
    let state = field(&tool, "state");
    if !is_record(&tool) || !is_record(&state) {
        return Ok(Value::Null);
    }
    let name = Some(field(&tool, "name"))
        .filter(|n| js::string_units(n).is_some())
        .unwrap_or_else(|| "".into());
    let call_id = Some(field(&tool, "id")).filter(|n| js::string_units(n).is_some()).unwrap_or_else(|| "".into());
    let time = field(&tool, "time");
    let start = finite(&field(&time, "ran")).or_else(|| finite(&field(&time, "created")));
    let (start, end) = (or_undefined(start), finite(&field(&time, "completed")));
    let status = field(&state, "status");
    if status.as_str() == Some("streaming") {
        let raw = Some(field(&state, "input"))
            .filter(|r| js::string_units(r).is_some())
            .unwrap_or_else(|| "".into());
        return Ok(json!({ "status": "pending", "input": {}, "raw": raw }));
    }
    let raw_input = Some(field(&state, "input")).filter(is_record).unwrap_or_else(|| json!({}));
    let metadata = Some(field(&state, "metadata"))
        .filter(is_record)
        .map(|m| to_v1_tool_metadata(name.clone(), m))
        .transpose()?;
    let mut input = to_v1_tool_input(name.clone(), raw_input.clone())?;
    let skill_name = metadata
        .as_ref()
        .map(|m| field(m, "name"))
        .filter(|n| v1_name(&name).as_str() == Some("skill") && non_empty_string(n));
    if let Some(skill) = skill_name.as_ref().filter(|_| !has_key(&raw_input, "name")) {
        input = with(Value::Object(copy(&input)), "name", skill.clone());
    }
    let title = skill_name.clone().unwrap_or_else(|| title_of(&input));
    let metadata_or_empty = metadata.clone().unwrap_or_else(|| json!({}));
    let until = end.map_or_else(|| start.clone(), js::number);
    Ok(match status.as_str() {
        Some("running") => {
            let running = json!({ "status": "running", "input": input, "metadata": metadata_or_empty, "time": { "start": start } });
            if js::is_undefined(&title) { running } else { with(running, "title", title) }
        }
        Some("completed") => {
            let title = if js::is_undefined(&title) { "".into() } else { title };
            let completed = json!({ "status": "completed", "input": input, "output": content_text(&field(&state, "content")), "title": title, "metadata": metadata_or_empty, "time": { "start": start, "end": until } });
            let attachments = content_attachments(&field(&state, "content"), &call_id, &context)?;
            if attachments.is_empty() {
                completed
            } else {
                with(completed, "attachments", Value::Array(attachments))
            }
        }
        Some("error") => {
            let error = field(&state, "error");
            let message = match (
                is_record(&error),
                js::string_units(&field(&error, "message")).is_some(),
                js::string_units(&error).is_some(),
            ) {
                (true, true, _) => field(&error, "message"),
                (_, _, true) => error,
                _ => "".into(),
            };
            let failed = json!({ "status": "error", "input": input, "error": message, "time": { "start": start, "end": until } });
            metadata.map_or(failed.clone(), |m| with(failed, "metadata", m))
        }
        _ => Value::Null,
    })
}

fn provider_state(state: &Value) -> Option<Value> {
    (is_record(state) && is_record(&field(state, "devryan"))).then(|| json!({ "devryan": field(state, "devryan") }))
}

/// Port of `projectProviderState` (`tools.js:324`).
pub fn project_provider_state(state: Value) -> Result<Value, String> {
    Ok(provider_state(&state).unwrap_or_else(js::undefined))
}

/// Port of `toV1ToolPart` (`tools.js:328`).
pub fn to_v1_tool_part(tool: Value, context: Value) -> Result<Value, String> {
    let (id, name) = (field(&tool, "id"), field(&tool, "name"));
    if !is_record(&tool) || !non_empty_string(&id) || js::string_units(&name).is_none() {
        return Ok(Value::Null);
    }
    let state = to_v1_tool_state(tool.clone(), context.clone())?;
    if state.is_null() {
        return Ok(Value::Null);
    }
    let native = field(&tool, "native");
    let provider = provider_state(&if nullish(&native) { field(&tool, "providerState") } else { native });
    let metadata = match provider {
        Some(p) => json!({ "opencodeTool": name, "providerState": p }),
        None => json!({ "opencodeTool": name }),
    };
    let message_id = context_field(&context, "messageID")?;
    Ok(json!({
        "id": template(&[&message_id, &id], &[":tool:"]),
        "sessionID": field(&context, "sessionID"),
        "messageID": message_id,
        "type": "tool",
        "callID": id,
        "tool": v1_name(&name),
        "state": state,
        "metadata": metadata,
    }))
}
