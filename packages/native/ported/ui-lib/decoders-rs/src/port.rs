//! The Rust port of `decoders/` (`guards.ts`, `assistantMessageError.ts`, `messageInfo.ts`,
//! `managedTaskToolPart.ts`), with `normalizeAbortSource` of `@devryan/orchestration-runtime`
//! alongside. `oneOf` returns a closure, and `readTrimmedString`/`readNonEmptyString` take rest
//! parameters the bindings do not collect: those stay in TS (used inside the port). A `Map`, `Set` or typed array is a
//! record (`typeof` object, not an array). `JSON.parse` is a JS-exact parser here: lone
//! surrogate escapes, `1e400` as Infinity, duplicate keys (last value, first place), array-index
//! keys first. The part cache is a `WeakMap`: identity does not cross JSON, but its refusal of
//! primitive keys does.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

const ABORT_SOURCES: [&str; 10] = [
    "stop_button",
    "double_escape",
    "steered_send",
    "session_removal",
    "revert",
    "redo",
    "abort_guard",
    "provider_retry",
    "stall_watchdog",
    "status_row",
];

/// JS `trim` white space and line terminators, as UTF-16 code units.
fn js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

fn marker(value: &Value) -> Option<&str> {
    let o = value.as_object().filter(|o| o.len() == 1)?;
    ["$undefined", "$num", "$utf16", "$map", "$set", "$bytes", "$function"]
        .into_iter()
        .find(|k| o.contains_key(*k))
}

/// `isRecord`: `typeof value === 'object'`, not `null`, not an array.
fn record(value: &Value) -> bool {
    value.is_object() && !matches!(marker(value), Some("$undefined" | "$num" | "$utf16" | "$function"))
}

/// `value[key]` of a record (a `Map`, `Set` or typed array has no such own property).
fn field(value: &Value, key: &str) -> Value {
    match value {
        Value::Object(o) if marker(value).is_none() => o.get(key).cloned().unwrap_or_else(js::undefined),
        _ => js::undefined(),
    }
}

fn is_string(value: &Value) -> bool {
    js::string_units(value).is_some()
}

fn number(value: &Value) -> Option<f64> {
    if value.is_number() || marker(value) == Some("$num") {
        js::as_number(value)
    } else {
        None
    }
}

/// `typeof value === 'string' && value.trim() ? value.trim() : None`.
fn trimmed(value: &Value) -> Option<Value> {
    let units = js::string_units(value)?;
    let start = units.iter().position(|&u| !js_space(u))?;
    let end = units.iter().rposition(|&u| !js_space(u)).map_or(start, |i| i + 1);
    Some(js::utf16_string(&units[start..end]))
}

fn non_empty(value: &Value) -> bool {
    js::string_units(value).is_some_and(|u| !u.is_empty())
}

/// .
fn first_trimmed(candidates: &[Value]) -> Value {
    candidates.iter().find_map(trimmed).unwrap_or_else(|| Value::String(String::new()))
}

fn string_or(value: Value, otherwise: Value) -> Value {
    if is_string(&value) { value } else { otherwise }
}

fn timestamp(value: &Value) -> bool {
    number(value).is_some_and(|n| n.is_finite() && n >= 0.0)
}

fn decode_error(error: &Value) -> Value {
    if !record(error) {
        return js::undefined();
    }
    let name = string_or(field(error, "name"), js::undefined());
    let message = string_or(field(error, "message"), js::undefined());
    let data = field(error, "data");
    let data_message = if record(&data) {
        string_or(field(&data, "message"), js::undefined())
    } else {
        js::undefined()
    };
    let detail = [&data_message, &message, &name]
        .into_iter()
        .find(|v| non_empty(v))
        .cloned()
        .unwrap_or_else(js::undefined);
    let mut out = Map::new();
    out.insert("name".into(), name.clone());
    out.insert("message".into(), message);
    out.insert("dataMessage".into(), data_message);
    out.insert("detail".into(), detail);
    if name.as_str() == Some("MessageAbortedError") && record(&data) {
        let source = field(&data, "source");
        if let Some(source) = source.as_str().filter(|s| ABORT_SOURCES.contains(s)) {
            out.insert("abortSource".into(), Value::String(source.into()));
        }
    }
    Value::Object(out)
}

/// JSON text, parsed as `JSON.parse` does; `None` where it throws.
struct Json<'a> {
    text: &'a [u16],
    at: usize,
}

impl Json<'_> {
    fn space(&mut self) {
        while self.text.get(self.at).is_some_and(|&u| matches!(u, 0x20 | 0x09 | 0x0a | 0x0d)) {
            self.at += 1;
        }
    }

    fn eat(&mut self, unit: u8) -> Option<()> {
        (self.text.get(self.at) == Some(&u16::from(unit))).then(|| self.at += 1)
    }

    fn word(&mut self, word: &str, value: Value) -> Option<Value> {
        word.bytes().try_for_each(|b| self.eat(b))?;
        Some(value)
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.text.get(self.at).is_some_and(|&u| (0x30..=0x39).contains(&u)) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.at;
        let _ = self.eat(b'-');
        if self.eat(b'0').is_none() && self.digits() == 0 {
            return None;
        }
        if self.eat(b'.').is_some() && self.digits() == 0 {
            return None;
        }
        if self.eat(b'e').or_else(|| self.eat(b'E')).is_some() {
            let _ = self.eat(b'+').or_else(|| self.eat(b'-'));
            if self.digits() == 0 {
                return None;
            }
        }
        let text = String::from_utf16(&self.text[start..self.at]).ok()?;
        Some(js::number(text.parse::<f64>().ok()?))
    }

    fn string(&mut self) -> Option<Vec<u16>> {
        self.eat(b'"')?;
        let mut out = Vec::new();
        loop {
            let unit = *self.text.get(self.at)?;
            self.at += 1;
            match unit {
                0x22 => return Some(out),
                0x00..=0x1f => return None,
                0x5c => {
                    let escape = *self.text.get(self.at)?;
                    self.at += 1;
                    out.push(match escape {
                        0x22 | 0x5c | 0x2f => escape,
                        0x62 => 0x08,
                        0x66 => 0x0c,
                        0x6e => 0x0a,
                        0x72 => 0x0d,
                        0x74 => 0x09,
                        0x75 => {
                            let hex = String::from_utf16(self.text.get(self.at..self.at + 4)?).ok()?;
                            self.at += 4;
                            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                                return None;
                            }
                            u16::from_str_radix(&hex, 16).ok()?
                        }
                        _ => return None,
                    });
                }
                _ => out.push(unit),
            }
        }
    }

    fn value(&mut self) -> Option<Value> {
        self.space();
        let value = match *self.text.get(self.at)? {
            0x7b => {
                self.at += 1;
                let mut map = Map::new();
                self.space();
                if self.eat(b'}').is_none() {
                    loop {
                        self.space();
                        let key = String::from_utf16_lossy(&self.string()?);
                        self.space();
                        self.eat(b':')?;
                        let item = self.value()?;
                        map.insert(key, item);
                        self.space();
                        if self.eat(b',').is_none() {
                            self.eat(b'}')?;
                            break;
                        }
                    }
                }
                Value::Object(js_order(map))
            }
            0x5b => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.eat(b']').is_none() {
                    loop {
                        items.push(self.value()?);
                        self.space();
                        if self.eat(b',').is_none() {
                            self.eat(b']')?;
                            break;
                        }
                    }
                }
                Value::Array(items)
            }
            0x22 => js::utf16_string(&self.string()?),
            0x74 => self.word("true", Value::Bool(true))?,
            0x66 => self.word("false", Value::Bool(false))?,
            0x6e => self.word("null", Value::Null)?,
            _ => self.number()?,
        };
        self.space();
        Some(value)
    }
}

fn index_key(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// An object's keys in JS order: array indexes ascending, then insertion order.
fn js_order(map: Map<String, Value>) -> Map<String, Value> {
    let mut indexed: Vec<(u32, String, Value)> = Vec::new();
    let mut rest = Map::new();
    for (key, value) in map {
        match index_key(&key) {
            Some(n) => indexed.push((n, key, value)),
            None => {
                rest.insert(key, value);
            }
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

fn parse_output(output: Value) -> Value {
    if record(&output) {
        return output;
    }
    if trimmed(&output).is_none() {
        return Value::Null;
    }
    let units = js::string_units(&output).unwrap_or_default();
    let mut parser = Json { text: &units, at: 0 };
    match parser.value() {
        Some(parsed) if parser.at == units.len() && record(&parsed) => parsed,
        _ => Value::Null,
    }
}

fn record_or_null(value: Value) -> Value {
    if record(&value) { value } else { Value::Null }
}

fn decode_part_state(state: &Value) -> Value {
    let rec = if record(state) { state.clone() } else { Value::Object(Map::new()) };
    let input = field(&rec, "input");
    let input = if record(&input) { input } else { Value::Object(Map::new()) };
    let output = parse_output(field(&rec, "output"));
    let present = !output.is_null();
    let follow_up = if present {
        record_or_null(field(&output, "followUpTask"))
    } else {
        Value::Null
    };
    let mut out = Map::new();
    out.insert("action".into(), first_trimmed(&[field(&input, "action")]));
    out.insert("status".into(), first_trimmed(&[field(&rec, "status")]));
    out.insert("agent".into(), first_trimmed(&[field(&input, "agent")]));
    out.insert("label".into(), first_trimmed(&[field(&input, "label")]));
    out.insert("inputTaskId".into(), first_trimmed(&[field(&input, "task_id")]));
    let task = if present { record_or_null(field(&output, "task")) } else { Value::Null };
    out.insert("output".into(), output);
    out.insert("outputTask".into(), task);
    let follow = if follow_up.is_null() {
        Value::Null
    } else {
        record_or_null(field(&follow_up, "task"))
    };
    out.insert("followUpTask".into(), follow);
    out.insert("error".into(), field(&rec, "error"));
    Value::Object(out)
}

fn message_text(info: &Value, key: &str) -> Value {
    let value = if record(info) { field(info, key) } else { js::undefined() };
    if trimmed(&value).is_some() { value } else { Value::Null }
}

fn info_field(info: &Value, key: &str) -> Value {
    if record(info) { field(info, key) } else { js::undefined() }
}

/// Port of `decodeAssistantMessageError` (`decoders/assistantMessageError.ts:20`).
pub fn decode_assistant_message_error(error: Value) -> Result<Value, String> {
    Ok(decode_error(&error))
}

/// Port of `readAssistantMessageError` (`decoders/assistantMessageError.ts:33`).
pub fn read_assistant_message_error(info: Value) -> Result<Value, String> {
    Ok(if record(&info) {
        decode_error(&field(&info, "error"))
    } else {
        js::undefined()
    })
}

/// Port of `isRecord` (`decoders/guards.ts:6`).
pub fn is_record(value: Value) -> Result<bool, String> {
    Ok(record(&value))
}

/// Port of `readString` (`decoders/guards.ts:26`).
pub fn read_string(value: Value) -> Result<Value, String> {
    Ok(string_or(value, js::undefined()))
}

/// Port of `isNullableString` (`decoders/guards.ts:28`).
pub fn is_nullable_string(value: Value) -> Result<bool, String> {
    Ok(value.is_null() || is_string(&value))
}

/// Port of `isOptionalNullableString` (`decoders/guards.ts:29`).
pub fn is_optional_nullable_string(value: Value) -> Result<bool, String> {
    Ok(js::is_undefined(&value) || value.is_null() || is_string(&value))
}

/// Port of `isTimestamp` (`decoders/guards.ts:32`).
pub fn is_timestamp(value: Value) -> Result<bool, String> {
    Ok(timestamp(&value))
}

/// Port of `isNullableTimestamp` (`decoders/guards.ts:35`).
pub fn is_nullable_timestamp(value: Value) -> Result<bool, String> {
    Ok(value.is_null() || timestamp(&value))
}

/// Port of `isOptionalNullableTimestamp` (`decoders/guards.ts:36`).
pub fn is_optional_nullable_timestamp(value: Value) -> Result<bool, String> {
    Ok(js::is_undefined(&value) || value.is_null() || timestamp(&value))
}

/// Port of `isCount` (`decoders/guards.ts:39`): a safe integer, `-0` included.
pub fn is_count(value: Value) -> Result<bool, String> {
    Ok(number(&value).is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && n >= 0.0))
}

/// Port of `decodeManagedTaskToolPart` (`decoders/managedTaskToolPart.ts:63`).
pub fn decode_managed_task_tool_part(part: Value) -> Result<Value, String> {
    if part.is_null() || js::is_undefined(&part) {
        let kind = if part.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading 'state')")); // recorded-literal: V8 TypeError text
    }
    let view = decode_part_state(&field(&part, "state"));
    if !(part.is_object() || part.is_array()) || matches!(marker(&part), Some("$undefined" | "$num" | "$utf16")) {
        return Err("Invalid value used as weak map key".into()); // recorded-literal: V8 TypeError text
    }
    Ok(view)
}

/// Port of `readMessageRole` (`decoders/messageInfo.ts:14`).
pub fn read_message_role(info: Value) -> Result<Value, String> {
    let client = info_field(&info, "clientRole");
    if is_string(&client) {
        return Ok(client);
    }
    Ok(string_or(info_field(&info, "role"), Value::Null))
}

/// Port of `readMessageId` (`decoders/messageInfo.ts:21`).
pub fn read_message_id(info: Value) -> Result<Value, String> {
    Ok(message_text(&info, "id"))
}

/// Port of `readMessageParentId` (`decoders/messageInfo.ts:22`).
pub fn read_message_parent_id(info: Value) -> Result<Value, String> {
    Ok(message_text(&info, "parentID"))
}

/// Port of `readMessageSessionId` (`decoders/messageInfo.ts:23`).
pub fn read_message_session_id(info: Value) -> Result<Value, String> {
    Ok(message_text(&info, "sessionID"))
}

/// Port of `readMessageClientRole` (`decoders/messageInfo.ts:24`).
pub fn read_message_client_role(info: Value) -> Result<Value, String> {
    Ok(string_or(info_field(&info, "clientRole"), Value::Null))
}

/// Port of `readMessageCreatedAt` (`decoders/messageInfo.ts:30`).
pub fn read_message_created_at(info: Value) -> Result<Value, String> {
    let time = info_field(&info, "time");
    let created = if record(&time) { field(&time, "created") } else { js::undefined() };
    Ok(number(&created).filter(|n| n.is_finite()).map_or(Value::Null, js::number))
}
