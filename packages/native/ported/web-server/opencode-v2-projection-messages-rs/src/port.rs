//! The Rust port of `opencode/v2/projection/messages.js` (14 of 20 functions) over any JS value.
//! Kept in JS: `toV1AssistantInfo`, `toV1CompactionRecords`, `projectMessagePage` and
//! `projectSingleMessage` (they hand the caller's `errorOptions.isContextOverflow` callback to
//! `toV1Error`) and the async `fillMessagePage`; `toV1AssistantParts` uses `tools.js` and the cursor
//! part ids of `ids.js`, ported alongside; the two error classes stay JS. `userTextSegments` is `ids.js`'s, as
//! in `opencode-v2-projection-ids-rs`; `toV1PathInfo` is Node's POSIX path over UTF-16 units;
//! `<`/`>` against a number use JS `ToNumber`. `turnSummaryDiffs` returns a `Map`, which the
//! binary wire cannot carry back, and stays in JS.

#![forbid(unsafe_code)]

use std::collections::HashSet;

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

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn non_empty_string(value: &Value) -> bool {
    js::string_units(value).is_some_and(|u| !u.is_empty())
}

fn is_number(value: &Value) -> bool {
    js::as_number(value).is_some()
}

fn finite(value: &Value) -> Option<f64> {
    js::as_number(value).filter(|n| n.is_finite())
}

fn same(value: &Value) -> Value {
    js::as_number(value).map_or_else(|| value.clone(), js::number)
}

fn read_member(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        let shown = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {shown} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
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
        _ if marker(value) == Some("$bigint") => value["$bigint"].as_str().unwrap_or_default().into(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    s.encode_utf16().collect()
}

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

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JS `Number(text)`.
fn string_number(text: &str) -> f64 {
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |acc, c| c.to_digit(radix).map(|d| acc * f64::from(radix) + f64::from(d)))
                .unwrap_or(f64::NAN);
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let (mantissa, exponent) = body.split_once(['e', 'E']).unwrap_or((body, "0"));
    let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if (int.is_empty() && frac.is_empty()) || !digits(int) || !digits(frac) || exponent.is_empty() || !digits(exponent) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(value)` for an array element joined by `Array.prototype.join`.
fn join_text(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => String::new(),
        _ if js::is_undefined(value) => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(join_text).collect::<Option<Vec<_>>>()?.join(","),
        Value::Number(_) | Value::Object(_) => js::number_to_string(js::as_number(value)?),
    })
}

/// `ToPrimitive(value)` for `<`/`>`: text, or a number.
enum Primitive {
    Text(Vec<u16>),
    Number(f64),
}

fn to_primitive(value: &Value) -> Primitive {
    if let Some(units) = js::string_units(value) {
        return Primitive::Text(units);
    }
    match value {
        Value::Array(_) => Primitive::Text(join_text(value).unwrap_or_default().encode_utf16().collect()),
        Value::Object(_) if js::as_number(value).is_none() && !js::is_undefined(value) => Primitive::Text("[object Object]".encode_utf16().collect()),
        Value::Null => Primitive::Number(0.0),
        Value::Bool(flag) => Primitive::Number(f64::from(u8::from(*flag))),
        _ => Primitive::Number(js::as_number(value).unwrap_or(f64::NAN)),
    }
}

fn primitive_number(p: Primitive) -> f64 {
    match p {
        Primitive::Number(n) => n,
        Primitive::Text(units) => string_number(&String::from_utf16_lossy(&units)),
    }
}

/// JS `ToNumber(value)` (a relational operand against a number).
fn to_number(value: &Value) -> f64 {
    primitive_number(to_primitive(value))
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

/// `userTextSegments` from `ids.js` (as in `opencode-v2-projection-ids-rs`).
fn user_text_segments(message_id: Value, text_value: Value, metadata: Value) -> Value {
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
    let Some(ds) = ds.filter(|d| !d.is_empty()) else { return whole() };
    if total != Some(value.len() as f64) {
        return whole();
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
    Value::Array(segments)
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

/// Port of `compactionPartId` (`messages.js:146`).
pub fn compaction_part_id(message_id: Value) -> Result<Value, String> {
    Ok(join(&[&message_id], &[":compaction"]))
}

/// Port of `compactionSummaryTextPartId` (`messages.js:154`).
pub fn compaction_summary_text_part_id(message_id: Value) -> Result<Value, String> {
    Ok(join(&[&message_id], &[":summary:text:0"]))
}

/// Port of `toV1Tokens` (`messages.js:162`).
pub fn to_v1_tokens(tokens: Value) -> Result<Value, String> {
    let usage = if is_record(&tokens) { tokens } else { json!({}) };
    let cache = Some(field(&usage, "cache")).filter(is_record).unwrap_or_else(|| json!({}));
    let n = |v: &Value, k: &str| finite(&field(v, k)).unwrap_or(0.0);
    let (input, output, reasoning, read, write) = (
        n(&usage, "input"),
        n(&usage, "output"),
        n(&usage, "reasoning"),
        n(&cache, "read"),
        n(&cache, "write"),
    );
    let total = input + output + reasoning + read + write;
    Ok(
        json!({ "total": js::number(total), "input": js::number(input), "output": js::number(output), "reasoning": js::number(reasoning), "cache": { "read": js::number(read), "write": js::number(write) } }),
    )
}

/// Port of `toV1PathInfo` (`messages.js:191`).
pub fn to_v1_path_info(directory: Value, subpath: Value) -> Result<Value, String> {
    let (cwd, root) = path_info(&directory, &subpath);
    Ok(json!({ "cwd": js::utf16_string(&cwd), "root": js::utf16_string(&root) }))
}

fn selection_of(metadata: &Value) -> Option<Map<String, Value>> {
    let devryan = field(metadata, "devryan");
    if !is_record(metadata) || !is_record(&devryan) || !(is_number(&field(&devryan, "v")) && js::as_number(&field(&devryan, "v")) == Some(1.0)) {
        return None;
    }
    let mut selection = Map::new();
    for key in ["agent", "providerID", "modelID"] {
        Some(field(&devryan, key)).filter(non_empty_string).map(|v| selection.insert(key.into(), v));
    }
    let variant = field(&devryan, "variant");
    if js::string_units(&variant).is_some() || variant.is_null() {
        selection.insert("variant".into(), variant);
    }
    if field(&devryan, "planMode") == Value::Bool(true) {
        selection.insert("planMode".into(), true.into());
    }
    Some(selection)
}

/// Port of `readDevryanPromptSelection` (`messages.js:211`).
pub fn read_devryan_prompt_selection(metadata: Value) -> Result<Value, String> {
    Ok(selection_of(&metadata).map_or(Value::Null, Value::Object))
}

/// Port of `toV1UserMetadata` (`messages.js:231`).
pub fn to_v1_user_metadata(metadata: Value) -> Result<Value, String> {
    if !is_record(&metadata) {
        return Ok(json!({}));
    }
    let mut rest: Map<String, Value> = match marker(&metadata) {
        Some("$bytes") => metadata["$bytes"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, b)| (i.to_string(), b.clone()))
            .collect(),
        Some(_) => Map::new(),
        None => plain(&metadata)
            .into_iter()
            .flatten()
            .filter(|(k, _)| *k != "devryan")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    };
    if selection_of(&metadata).is_some_and(|s| s.get("planMode") == Some(&Value::Bool(true))) {
        rest.insert("devryanPlanMode".into(), true.into());
    }
    Ok(Value::Object(rest))
}

/// Port of `toV1UserParts` (`messages.js:273`).
pub fn to_v1_user_parts(message: Value, session_id: Value) -> Result<Value, String> {
    let message_id = js::utf16_string(&text(&read_member(&message, "id")?));
    let segments = user_text_segments(message_id.clone(), field(&message, "text"), field(&message, "metadata"));
    let mut parts: Vec<Value> = segments
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let mut part = json!({ "id": s["id"], "sessionID": session_id, "messageID": message_id, "type": "text", "text": s["text"] });
            if s["kind"].as_str() != Some("text") {
                part["synthetic"] = true.into();
            }
            part
        })
        .collect();
    for (index, file) in field(&message, "files").as_array().into_iter().flatten().enumerate() {
        let data = field(file, "data");
        let Some(data) = js::string_units(&data).filter(|_| is_record(file)) else {
            continue;
        };
        let mime = Some(field(file, "mime"))
            .filter(|m| js::string_units(m).is_some())
            .unwrap_or_else(|| "application/octet-stream".into());
        let url = ["data:".encode_utf16().collect(), text(&mime), ";base64,".encode_utf16().collect(), data].concat();
        let mut part = json!({ "id": join(&[&message_id, &json!(index)], &[":file:"]), "sessionID": session_id, "messageID": message_id, "type": "file", "mime": mime, "url": js::utf16_string(&url) });
        if let Some(n) = Some(field(file, "name")).filter(non_empty_string) {
            part["filename"] = n;
        }
        parts.push(part);
    }
    for (index, agent) in field(&message, "agents").as_array().into_iter().flatten().enumerate() {
        let name = field(agent, "name");
        if !is_record(agent) || js::string_units(&name).is_none() {
            continue;
        }
        let mut part =
            json!({ "id": join(&[&message_id, &json!(index)], &[":agent:"]), "sessionID": session_id, "messageID": message_id, "type": "agent", "name": name });
        let mention = field(agent, "mention");
        let (mtext, start, end) = (field(&mention, "text"), field(&mention, "start"), field(&mention, "end"));
        if is_record(&mention) && js::string_units(&mtext).is_some() && finite(&start).is_some() && finite(&end).is_some() {
            part["source"] = json!({ "value": mtext, "start": same(&start), "end": same(&end) });
        }
        parts.push(part);
    }
    Ok(Value::Array(parts))
}

fn native_status(message: &Value) -> bool {
    let devryan = field(&field(message, "metadata"), "devryan");
    is_record(message)
        && field(message, "type").as_str() == Some("synthetic")
        && is_number(&field(&devryan, "v"))
        && js::as_number(&field(&devryan, "v")) == Some(1.0)
        && field(&devryan, "origin").as_str() == Some("interview")
        && field(&devryan, "statusOnly") == Value::Bool(true)
}

/// Port of `buildUserIndex` (`messages.js:644`).
pub fn build_user_index(messages: Value) -> Result<Value, String> {
    let Value::Array(messages) = messages else { return Ok(json!([])) };
    let mut seen: HashSet<Vec<u16>> = HashSet::new();
    let mut entries: Vec<(f64, Value)> = Vec::new();
    for message in &messages {
        if !is_record(message) || !matches!(field(message, "type").as_str(), Some("user" | "synthetic")) || native_status(message) {
            continue;
        }
        let time = field(message, "time");
        let created = if is_record(&time) { field(&time, "created") } else { js::undefined() };
        let id = field(message, "id");
        let (Some(units), Some(at)) = (js::string_units(&id).filter(|u| !u.is_empty()), finite(&created)) else {
            continue;
        };
        if seen.insert(units) {
            entries.push((at, json!({ "deliveredAt": js::number(at), "userID": id })));
        }
    }
    entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(entries.into_iter().map(|(_, e)| e).collect())
}

/// Port of `addUserIndexEntry` (`messages.js:666`).
pub fn add_user_index_entry(index: Value, entry: Value) -> Result<Value, String> {
    let mut next: Vec<Value> = index.as_array().map_or_else(Vec::new, |b| b.iter().map(same).collect());
    let (user_id, delivered) = (field(&entry, "userID"), field(&entry, "deliveredAt"));
    let Some(at) = finite(&delivered).filter(|_| is_record(&entry) && non_empty_string(&user_id)) else {
        return Ok(Value::Array(next));
    };
    for existing in &next {
        if js::string_units(&read_member(existing, "userID")?) == js::string_units(&user_id) {
            return Ok(Value::Array(next));
        }
    }
    let mut position = next.len();
    while position > 0 && to_number(&read_member(&next[position - 1], "deliveredAt")?) > at {
        position -= 1;
    }
    next.insert(position, json!({ "deliveredAt": js::number(at), "userID": user_id }));
    Ok(Value::Array(next))
}

/// Port of `findIndexedParentID` (`messages.js:684`).
pub fn find_indexed_parent_id(index: Value, created_at: Value) -> Result<Value, String> {
    let (Value::Array(index), Some(at)) = (&index, finite(&created_at)) else {
        return Ok(js::undefined());
    };
    let (mut low, mut high) = (0, index.len());
    while low < high {
        let middle = (low + high) / 2;
        if to_number(&read_member(&index[middle], "deliveredAt")?) <= at {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if low == 0 {
        Ok(js::undefined())
    } else {
        read_member(&index[low - 1], "userID")
    }
}

/// Port of `encodeMessageCursor` (`messages.js:956`).
pub fn encode_message_cursor(cursor: Value) -> Result<Value, String> {
    Ok(if non_empty_string(&cursor) {
        join(&[&json!(""), &cursor], &["v2:"])
    } else {
        js::undefined()
    })
}

/// Port of `decodeMessageCursor` (`messages.js:967`).
pub fn decode_message_cursor(before: Value) -> Result<Value, String> {
    if nullish(&before) || before.as_str() == Some("") {
        return Ok(js::undefined());
    }
    let prefix: Vec<u16> = "v2:".encode_utf16().collect();
    let Some(cursor) = js::string_units(&before).and_then(|u| u.strip_prefix(prefix.as_slice()).map(<[u16]>::to_vec)) else {
        return Ok(Value::Null);
    };
    Ok(if cursor.is_empty() { Value::Null } else { js::utf16_string(&cursor) })
}

/// Port of `isDroppedMessageType` (`messages.js:1103`).
pub fn is_dropped_message_type(message: Value) -> Result<Value, String> {
    let dropped = matches!(
        field(&message, "type").as_str(),
        Some("system" | "idle" | "agent-switched" | "model-switched" | "location-switched")
    );
    Ok((is_record(&message) && dropped).into())
}

fn cursor_part_id(metadata: &Value, item: &Value) -> Option<Value> {
    let cursor = field(&field(metadata, "devryan"), "cursor");
    if !is_record(metadata)
        || !is_record(&field(metadata, "devryan"))
        || !is_record(&cursor)
        || field(&cursor, "source").as_str() != Some("cursor-acp")
        || !is_record(item)
    {
        return None;
    }
    let native = field(item, "native");
    let state = if !nullish(&native) {
        native
    } else if field(item, "type").as_str() == Some("tool") {
        field(item, "providerState")
    } else {
        field(item, "state")
    };
    let sc = field(&field(&state, "devryan"), "cursor");
    let id = field(&sc, "partID");
    let ok =
        is_record(&state) && is_record(&field(&state, "devryan")) && is_record(&sc) && js::string_units(&id).is_some_and(|u| !u.is_empty() && u.len() <= 256);
    ok.then_some(id)
}

fn cursor_assistant(message: &Value) -> bool {
    let (model, metadata) = (field(message, "model"), field(message, "metadata"));
    let cursor = field(&field(&metadata, "devryan"), "cursor");
    is_record(message)
        && is_record(&model)
        && field(&model, "providerID").as_str() == Some("cursor-acp")
        && is_record(&metadata)
        && is_record(&field(&metadata, "devryan"))
        && is_record(&cursor)
        && field(&cursor, "source").as_str() == Some("cursor-acp")
}

fn part_time(start: Value, end: Option<Value>) -> Value {
    end.map_or_else(|| json!({ "start": start }), |e| json!({ "start": start, "end": e }))
}

/// Port of `toV1AssistantParts` (`messages.js:425`).
pub fn to_v1_assistant_parts(message: Value, context: Value) -> Result<Value, String> {
    let message_id = js::utf16_string(&text(&read_member(&message, "id")?));
    if nullish(&context) {
        let shown = if context.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property 'sessionID' of '{shown}' as it is {shown}.")); // recorded-literal: V8 TypeError text
    }
    let session_id = field(&context, "sessionID");
    let time = field(&message, "time");
    let completed = finite(&field(&time, "completed")).filter(|_| is_record(&time)).map(js::number);
    let snapshot = field(&message, "snapshot");
    let snap = |k: &str| Some(field(&snapshot, k)).filter(|v| is_record(&snapshot) && non_empty_string(v));
    let cursor = cursor_assistant(&message);
    let base = |id: Value, kind: &str| json!({ "id": id, "sessionID": session_id, "messageID": message_id, "type": kind });
    let mut parts = Vec::new();
    if !cursor {
        let mut start = base(join(&[&message_id], &[":step-start"]), "step-start");
        if let Some(v) = snap("start") {
            start["snapshot"] = v;
        }
        parts.push(start);
    }
    let content = field(&message, "content").as_array().cloned().unwrap_or_default();
    let metadata = if cursor { field(&message, "metadata") } else { js::undefined() };
    let (mut texts, mut reasonings) = (0usize, 0usize);
    let tool_context = json!({ "messageID": message_id, "sessionID": session_id });
    let created = field(&context, "created");
    for item in &content {
        let kind = field(item, "type");
        if !is_record(item) {
            continue;
        }
        let state = || {
            let n = field(item, "native");
            if nullish(&n) { field(item, "state") } else { n }
        };
        let words = || Some(field(item, "text")).filter(|t| js::string_units(t).is_some()).unwrap_or_else(|| "".into());
        match kind.as_str() {
            Some("text") => {
                let id = cursor_part_id(&metadata, item).unwrap_or_else(|| join(&[&message_id, &json!(texts)], &[":text:"]));
                texts += 1;
                let mut part = base(id, "text");
                part["text"] = words();
                part["time"] = part_time(created.clone(), completed.clone());
                if let Some(p) = tools::provider_state(&state()) {
                    part["metadata"] = json!({ "providerState": p });
                }
                parts.push(part);
            }
            Some("reasoning") => {
                let id = cursor_part_id(&metadata, item).unwrap_or_else(|| join(&[&message_id, &json!(reasonings)], &[":reasoning:"]));
                reasonings += 1;
                let time = Some(field(item, "time")).filter(is_record).unwrap_or_else(|| json!({}));
                let start = finite(&field(&time, "created")).map_or_else(|| created.clone(), js::number);
                let end = finite(&field(&time, "completed")).map(js::number).or_else(|| completed.clone());
                let mut part = base(id, "reasoning");
                part["text"] = words();
                part["time"] = part_time(start, end);
                if let Some(p) = tools::provider_state(&state()) {
                    part["metadata"] = p;
                }
                parts.push(part);
            }
            Some("tool") if non_empty_string(&field(item, "id")) => {
                let id = cursor_part_id(&metadata, item).unwrap_or_else(|| join(&[&message_id, &field(item, "id")], &[":tool:"]));
                let mut tool = tools::to_v1_tool_part(item.clone(), tool_context.clone())?;
                if !tool.is_null() {
                    tool["id"] = id;
                    parts.push(tool);
                }
            }
            _ => {}
        }
    }
    let finish = field(&message, "finish");
    if !cursor && (completed.is_some() || js::string_units(&finish).is_some()) {
        let mut end = base(join(&[&message_id], &[":step-finish"]), "step-finish");
        end["reason"] = if js::string_units(&finish).is_some() { finish } else { "stop".into() };
        end["cost"] = finite(&field(&message, "cost")).map_or_else(|| json!(0), js::number);
        end["tokens"] = to_v1_tokens(field(&message, "tokens"))?;
        if let Some(v) = snap("end") {
            end["snapshot"] = v;
        }
        parts.push(end);
    }
    Ok(Value::Array(parts))
}

/// `tools.js`'s `toV1ToolPart` and `projectProviderState`, as ported in `opencode-v2-projection-tools-rs`.
mod tools {
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

    /// `toV1ToolInput` from `tools.js`.
    fn to_v1_tool_input(name: Value, input: Value) -> Result<Value, String> {
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

    fn first_file_diff(metadata: &Value) -> Option<Value> {
        match field(metadata, "files") {
            Value::Array(files) => files.first().filter(|f| is_record(f)).cloned(),
            _ => None,
        }
    }

    fn file_diff_tool(name: &Value) -> bool {
        matches!(v1_name(name).as_str(), Some("edit" | "write"))
    }

    /// `toV1ToolMetadata` from `tools.js`.
    fn to_v1_tool_metadata(name: Value, metadata: Value) -> Result<Value, String> {
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

    /// `toV1ToolState` from `tools.js`.
    fn to_v1_tool_state(tool: Value, context: Value) -> Result<Value, String> {
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

    pub(super) fn provider_state(state: &Value) -> Option<Value> {
        (is_record(state) && is_record(&field(state, "devryan"))).then(|| json!({ "devryan": field(state, "devryan") }))
    }

    /// `toV1ToolPart` from `tools.js`.
    pub(super) fn to_v1_tool_part(tool: Value, context: Value) -> Result<Value, String> {
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
}
