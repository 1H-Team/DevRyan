//! The Rust port of `opencode/v2/projection/ids.js` (all 18 exports), over any JS value: template
//! literals print with `String()` (lone surrogates kept), lengths and slices are UTF-16 units, a
//! `Map` passes `isRecord` with no own fields.

#![forbid(unsafe_code)]

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::js;

fn is_record(value: &Value) -> bool {
    value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn non_empty_string(value: &Value) -> bool {
    js::string_units(value).is_some_and(|u| !u.is_empty())
}

fn is_number(value: &Value) -> bool {
    value.is_number() || value.get("$num").is_some_and(|_| js::as_number(value).is_some())
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
            let parts: Vec<Vec<u16>> = items.iter().map(|v| if nullish(v) { Vec::new() } else { text(v) }).collect();
            return parts.join(&[u16::from(b',')][..]);
        }
        _ if value.get("$map").is_some() && value.as_object().is_some_and(|o| o.len() == 1) => "[object Map]".into(),
        _ if value.get("$set").is_some() && value.as_object().is_some_and(|o| o.len() == 1) => "[object Set]".into(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    s.encode_utf16().collect()
}

/// `${a}${sep}${b}`…
fn join(parts: &[&Value], seps: &[&str]) -> Value {
    let mut out = text(parts[0]);
    for (i, sep) in seps.iter().enumerate() {
        out.extend(sep.encode_utf16());
        if let Some(p) = parts.get(i + 1) {
            out.extend(text(p));
        }
    }
    js::utf16_string(&out)
}

fn cursor_part_id(metadata: &Value, item: &Value) -> Option<Value> {
    let devryan = field(metadata, "devryan");
    let cursor = field(&devryan, "cursor");
    if !is_record(metadata) || !is_record(&devryan) || !is_record(&cursor) || field(&cursor, "source").as_str() != Some("cursor-acp") || !is_record(item) {
        return None;
    }
    let native = field(item, "native");
    let state = if nullish(&native) {
        if field(item, "type").as_str() == Some("tool") {
            field(item, "providerState")
        } else {
            field(item, "state")
        }
    } else {
        native
    };
    let sd = field(&state, "devryan");
    let sc = field(&sd, "cursor");
    if !is_record(&state) || !is_record(&sd) || !is_record(&sc) {
        return None;
    }
    let id = field(&sc, "partID");
    js::string_units(&id).filter(|u| !u.is_empty() && u.len() <= 256).map(|_| id)
}

fn descriptors(metadata: &Value) -> Option<Vec<Value>> {
    if !is_record(metadata) {
        return None;
    }
    let devryan = field(metadata, "devryan");
    if !is_record(&devryan) || js::as_number(&field(&devryan, "v")).filter(|_| is_number(&field(&devryan, "v"))) != Some(1.0) {
        return None;
    }
    let Value::Array(parts) = field(&devryan, "parts") else { return None };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in &parts {
        if !is_record(entry) {
            return None;
        }
        let kind = field(entry, "kind");
        if !matches!(kind.as_str(), Some("text" | "synthetic" | "attachment")) {
            return None;
        }
        let length = field(entry, "length");
        let n = js::as_number(&length).filter(|_| is_number(&length))?;
        if !(n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0) || n < 0.0 {
            return None;
        }
        let id = field(entry, "id");
        let mut d = Map::new();
        d.insert("kind".into(), kind);
        d.insert("length".into(), length);
        if !js::is_undefined(&id) {
            let units = js::string_units(&id).filter(|u| !u.is_empty())?;
            if !seen.insert(units) {
                return None;
            }
            d.insert("id".into(), id);
        }
        out.push(Value::Object(d));
    }
    Some(out)
}

fn num(value: &Value) -> Option<f64> {
    js::as_number(value).filter(|n| is_number(value) && n.is_finite())
}

fn clamp(created: &Value, previous: &Value) -> Value {
    match (num(previous), num(created)) {
        (None, Some(_)) => created.clone(),
        (None, None) => js::undefined(),
        (Some(p), None) => js::number(p + 1.0),
        (Some(p), Some(c)) => {
            if c > p {
                created.clone()
            } else {
                js::number(p + 1.0)
            }
        }
    }
}

/// Port of `assistantTextPartId`.
pub fn assistant_text_part_id(message_id: Value, ordinal: Value) -> Result<Value, String> {
    Ok(join(&[&message_id, &ordinal], &[":text:"]))
}

/// Port of `assistantReasoningPartId`.
pub fn assistant_reasoning_part_id(message_id: Value, ordinal: Value) -> Result<Value, String> {
    Ok(join(&[&message_id, &ordinal], &[":reasoning:"]))
}

/// Port of `assistantToolPartId`.
pub fn assistant_tool_part_id(message_id: Value, call_id: Value) -> Result<Value, String> {
    Ok(join(&[&message_id, &call_id], &[":tool:"]))
}

/// Port of `stepStartPartId`.
pub fn step_start_part_id(message_id: Value) -> Result<Value, String> {
    Ok(join(&[&message_id], &[":step-start"]))
}

/// Port of `stepFinishPartId`.
pub fn step_finish_part_id(message_id: Value) -> Result<Value, String> {
    Ok(join(&[&message_id], &[":step-finish"]))
}

/// Port of `userTextPartId`.
pub fn user_text_part_id(message_id: Value, index: Value) -> Result<Value, String> {
    Ok(join(&[&message_id, &index], &[":text:"]))
}

/// Port of `userFilePartId`.
pub fn user_file_part_id(message_id: Value, index: Value) -> Result<Value, String> {
    Ok(join(&[&message_id, &index], &[":file:"]))
}

/// Port of `userAgentPartId`.
pub fn user_agent_part_id(message_id: Value, index: Value) -> Result<Value, String> {
    Ok(join(&[&message_id, &index], &[":agent:"]))
}

/// Port of `toolAttachmentPartId`.
pub fn tool_attachment_part_id(message_id: Value, call_id: Value, index: Value) -> Result<Value, String> {
    Ok(join(&[&message_id, &call_id, &index], &[":tool:", ":file:"]))
}

/// Port of `compactionSummaryMessageId`.
pub fn compaction_summary_message_id(message_id: Value) -> Result<Value, String> {
    Ok(join(&[&message_id], &[":summary"]))
}

/// Port of `assistantContentPartId`.
pub fn assistant_content_part_id(message_id: Value, item: Value, ordinal: Value) -> Result<Value, String> {
    if !is_record(&item) {
        return Ok(Value::Null);
    }
    Ok(match field(&item, "type").as_str() {
        Some("text") => join(&[&message_id, &ordinal], &[":text:"]),
        Some("reasoning") => join(&[&message_id, &ordinal], &[":reasoning:"]),
        Some("tool") if non_empty_string(&field(&item, "id")) => join(&[&message_id, &field(&item, "id")], &[":tool:"]),
        _ => Value::Null,
    })
}

/// Port of `assistantContentPartIds`.
pub fn assistant_content_part_ids(message_id: Value, content: Value, metadata: Value) -> Result<Value, String> {
    let Value::Array(items) = content else { return Ok(json!([])) };
    let (mut text_n, mut reasoning_n) = (0u64, 0u64);
    let out: Vec<Value> = items
        .iter()
        .map(|item| {
            if !is_record(item) {
                return Value::Null;
            }
            match field(item, "type").as_str() {
                Some("text") => {
                    let n = text_n;
                    text_n += 1;
                    cursor_part_id(&metadata, item).unwrap_or_else(|| join(&[&message_id, &json!(n)], &[":text:"]))
                }
                Some("reasoning") => {
                    let n = reasoning_n;
                    reasoning_n += 1;
                    cursor_part_id(&metadata, item).unwrap_or_else(|| join(&[&message_id, &json!(n)], &[":reasoning:"]))
                }
                Some("tool") if non_empty_string(&field(item, "id")) => {
                    cursor_part_id(&metadata, item).unwrap_or_else(|| join(&[&message_id, &field(item, "id")], &[":tool:"]))
                }
                _ => Value::Null,
            }
        })
        .collect();
    Ok(Value::Array(out))
}

/// Port of `readDevryanPartDescriptors`.
pub fn read_devryan_part_descriptors(metadata: Value) -> Result<Value, String> {
    Ok(descriptors(&metadata).map_or(Value::Null, Value::Array))
}

/// Port of `userTextSegments`.
pub fn user_text_segments(message_id: Value, text_value: Value, metadata: Value) -> Result<Value, String> {
    let value = js::string_units(&text_value).unwrap_or_default();
    let ds = descriptors(&metadata);
    let total: Option<f64> = ds.as_ref().map(|d| d.iter().map(|x| js::as_number(&x["length"]).unwrap_or(0.0)).sum());
    let whole = || {
        if value.is_empty() {
            json!([])
        } else {
            json!([{ "id": join(&[&message_id, &json!(0)], &[":text:"]), "kind": "text", "text": js::utf16_string(&value) }])
        }
    };
    let Some(ds) = ds.filter(|d| !d.is_empty()) else { return Ok(whole()) };
    if total != Some(value.len() as f64) {
        return Ok(whole());
    }
    let mut offset = 0usize;
    let mut segments = Vec::new();
    for (index, d) in ds.iter().enumerate() {
        let length = js::as_number(&d["length"]).unwrap_or(0.0) as usize;
        let end = offset + length;
        if length > 0 {
            let id = d.get("id").cloned().unwrap_or_else(|| join(&[&message_id, &json!(index)], &[":text:"]));
            segments.push(json!({ "id": id, "kind": d["kind"], "text": js::utf16_string(&value[offset..end.min(value.len())]) }));
        }
        offset = end;
    }
    Ok(Value::Array(segments))
}

/// Port of `userSegmentPartId`.
pub fn user_segment_part_id(message_id: Value, metadata: Value, index: Value) -> Result<Value, String> {
    let key = String::from_utf16_lossy(&text(&index));
    let picked = descriptors(&metadata).and_then(|d| {
        let i: usize = key.parse().ok().filter(|i: &usize| i.to_string() == key)?;
        d.get(i).and_then(|x| x.get("id")).cloned()
    });
    Ok(picked.filter(|v| !nullish(v)).unwrap_or_else(|| join(&[&message_id, &index], &[":text:"])))
}

/// Port of `clampIncreasingTime`.
pub fn clamp_increasing_time(created: Value, previous: Value) -> Result<Value, String> {
    Ok(clamp(&created, &previous))
}

/// Port of `clampIncreasingTimes`.
pub fn clamp_increasing_times(times: Value, previous: Value) -> Result<Value, String> {
    let Value::Array(items) = times else { return Ok(json!([])) };
    let mut last = previous;
    let out: Vec<Value> = items
        .iter()
        .map(|created| {
            let c = clamp(created, &last);
            if !js::is_undefined(&c) {
                last = c.clone();
            }
            c
        })
        .collect();
    Ok(Value::Array(out))
}

/// Port of `isCursorAssistant`.
pub fn is_cursor_assistant(message: Value) -> Result<Value, String> {
    let model = field(&message, "model");
    let meta = field(&message, "metadata");
    let devryan = field(&meta, "devryan");
    let cursor = field(&devryan, "cursor");
    Ok(Value::Bool(
        is_record(&message)
            && is_record(&model)
            && field(&model, "providerID").as_str() == Some("cursor-acp")
            && is_record(&meta)
            && is_record(&devryan)
            && is_record(&cursor)
            && field(&cursor, "source").as_str() == Some("cursor-acp"),
    ))
}
