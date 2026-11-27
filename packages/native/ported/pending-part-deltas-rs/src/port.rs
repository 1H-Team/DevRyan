//! The Rust port of `pending-part-deltas.ts` (its four pure exports), with what it uses of
//! `part-delta.ts` inlined (after `part-delta-rs`: text as UTF-16 code units). The store-mutating
//! exports are proven by the wrapper crate in `mutation/`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

type R<T> = Result<T, String>;

// ---- part-delta ----

type Units = Vec<u16>;

const MIN_PARTIAL_DEDUPE_OVERLAP: usize = 5;
const MIN_FULL_FRAME_DUPLICATE_LENGTH: usize = 32;
const MAX_JAMMED_DUPLICATE_SCAN_LENGTH: usize = 2_048;
const MALFORMED: &str = "Skipped malformed tool call \"";
const LOOP_GUARD: &str = "Tool loop guard stopped repeated schema-invalid calls to \"";

fn u(text: &str) -> Units {
    text.encode_utf16().collect()
}

/// A string argument as code units (`None` for `undefined` and `null`).
fn text_of(value: &Value) -> Option<Units> {
    js::string_units(value)
}

fn out(units: &[u16]) -> Value {
    js::utf16_string(units)
}

fn is_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim(units: &[u16]) -> &[u16] {
    let start = units.iter().position(|u| !is_space(*u)).unwrap_or(units.len());
    let end = units.iter().rposition(|u| !is_space(*u)).map_or(start, |i| i + 1);
    &units[start..end.max(start)]
}

fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    (from..=hay.len().checked_sub(needle.len())?).find(|&i| hay[i..].starts_with(needle))
}

fn contains(hay: &[u16], needle: &str) -> bool {
    index_of(hay, &u(needle), 0).is_some()
}

/// `value.lastIndexOf(unit, from)`.
fn last_unit(hay: &[u16], unit: u16, from: usize) -> Option<usize> {
    hay.get(..=from.min(hay.len().checked_sub(1)?))?.iter().rposition(|x| *x == unit)
}

/// `appendNonOverlappingDelta` (`part-delta.ts:21`).
fn append_non_overlapping_delta(existing_value: Value, delta: Value, context: Value) -> Result<Value, String> {
    let _ = context;
    let existing = text_of(&existing_value).unwrap_or_default();
    let delta = text_of(&delta).unwrap_or_default();
    if existing.is_empty() || delta.is_empty() {
        return Ok(out(&[existing.as_slice(), &delta].concat()));
    }
    if existing.ends_with(&delta) {
        return Ok(out(&existing));
    }
    let max_overlap = existing.len().min(delta.len() - 1);
    let overlap = (MIN_PARTIAL_DEDUPE_OVERLAP..=max_overlap)
        .rev()
        .find(|&o| existing.ends_with(&delta[..o]))
        .unwrap_or(0);
    Ok(out(&[existing.as_slice(), &delta[overlap..]].concat()))
}

fn meaningful(units: &[u16]) -> bool {
    trim(units).len() >= MIN_FULL_FRAME_DUPLICATE_LENGTH
}

/// `splitLineRecords`: (content, separator) pairs.
fn split_lines(value: &[u16]) -> Vec<(Units, Units)> {
    let mut records = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let Some(newline) = index_of(value, &[10], start) else {
            records.push((value[start..].to_vec(), Vec::new()));
            break;
        };
        let separator_start = if newline > start && value[newline - 1] == 13 { newline - 1 } else { newline };
        records.push((value[start..separator_start].to_vec(), value[separator_start..=newline].to_vec()));
        start = newline + 1;
    }
    records
}

fn collapse_line_repeats(value: &[u16]) -> Units {
    let records = split_lines(value);
    let mut output = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < records.len() {
        let (content, separator) = &records[index];
        if let Some((next_content, next_separator)) = records.get(index + 1)
            && meaningful(content)
            && trim(content) == trim(next_content)
        {
            output.extend(content);
            output.extend(if next_separator.is_empty() { separator } else { next_separator });
            index += 2;
            continue;
        }
        output.extend(content);
        output.extend(separator);
        index += 1;
    }
    output
}

fn collapse_jammed_repeats(value: &[u16]) -> Units {
    let mut output = value.to_vec();
    if output.len() > MAX_JAMMED_DUPLICATE_SCAN_LENGTH {
        return output;
    }
    let mut changed = true;
    while changed {
        changed = false;
        for start in 0..output.len() {
            let max_length = (output.len() - start) / 2;
            if max_length < MIN_FULL_FRAME_DUPLICATE_LENGTH {
                break;
            }
            let lead = output[start];
            let mut second = last_unit(&output, lead, start + max_length);
            while let Some(second_start) = second.filter(|s| *s >= start + MIN_FULL_FRAME_DUPLICATE_LENGTH) {
                let length = second_start - start;
                if output[start..second_start] == output[second_start..second_start + length] && meaningful(&output[start..second_start]) {
                    output.drain(second_start..second_start + length);
                    changed = true;
                    break;
                }
                second = last_unit(&output, lead, second_start - 1);
            }
            if changed {
                break;
            }
        }
    }
    output
}

fn collapse(value: &[u16]) -> Units {
    if value.len() < MIN_FULL_FRAME_DUPLICATE_LENGTH * 2 {
        return value.to_vec();
    }
    collapse_jammed_repeats(&collapse_line_repeats(value))
}

fn strip_malformed(value: &[u16]) -> Units {
    let (marker, blocked, guard) = (u(MALFORMED), u("Tool \""), u(LOOP_GUARD));
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < value.len() {
        let Some(start) = index_of(value, &marker, cursor) else {
            output.extend(&value[cursor..]);
            break;
        };
        output.extend(&value[cursor..start]);
        let from = start + marker.len();
        let line = index_of(value, &[10], from).map(|n| n + 1);
        let candidates = [
            index_of(value, &marker, from),
            index_of(value, &blocked, from),
            index_of(value, &guard, from),
            line,
        ];
        cursor = candidates.into_iter().flatten().min().unwrap_or(value.len());
    }
    output
}

/// Matches `"[^"]+"<middle>\d+<tail>` at `at` (after the literal head), returning its end.
fn quoted_then_digits(value: &[u16], at: usize, middle: &str, tail: &[&str]) -> Option<usize> {
    let close = at + value.get(at..)?.iter().position(|x| *x == u16::from(b'"'))?;
    if close == at {
        return None;
    }
    let mut at = close;
    for (index, literal) in std::iter::once(middle).chain(tail.iter().copied()).enumerate() {
        let lit = u(literal);
        if !value.get(at..)?.starts_with(&lit) {
            return None;
        }
        at += lit.len();
        if index < tail.len() {
            let digits = value[at..].iter().take_while(|x| (u16::from(b'0')..=u16::from(b'9')).contains(x)).count();
            if digits == 0 {
                return None;
            }
            at += digits;
        }
    }
    Some(at)
}

/// `value.replace(/\s*<head>"[^"]+"<middle>\d+<tail...>/g, "")`.
fn remove_diagnostic(value: &[u16], head: &str, middle: &str, tail: &[&str]) -> Units {
    let head = u(head);
    let mut output = Vec::with_capacity(value.len());
    let (mut copied, mut search) = (0, 0);
    while let Some(found) = index_of(value, &head, search) {
        match quoted_then_digits(value, found + head.len(), middle, tail) {
            Some(end) => {
                let mut begin = found;
                while begin > copied && is_space(value[begin - 1]) {
                    begin -= 1;
                }
                output.extend(&value[copied..begin]);
                copied = end;
                search = end;
            }
            None => search = found + 1,
        }
    }
    output.extend(&value[copied..]);
    output
}

/// `cleanupDiagnosticWhitespace`.
fn cleanup(value: &[u16]) -> Units {
    let mut spaced = Vec::with_capacity(value.len());
    let mut pending = Vec::new();
    for &unit in value {
        match unit {
            0x20 | 0x09 => pending.push(unit),
            10 => {
                pending.clear();
                spaced.push(unit);
            }
            _ => {
                spaced.append(&mut pending);
                spaced.push(unit);
            }
        }
    }
    spaced.append(&mut pending);
    let mut joined: Units = Vec::with_capacity(spaced.len());
    let mut run = 0;
    for &unit in &spaced {
        run = if unit == 10 { run + 1 } else { 0 };
        if run <= 2 {
            joined.push(unit);
        }
    }
    trim(&joined).to_vec()
}

fn strip_internal(value: &[u16]) -> Units {
    if !contains(value, MALFORMED)
        && !contains(value, "has been temporarily blocked after")
        && !contains(value, "Tool loop guard stopped repeated schema-invalid calls")
    {
        return value.to_vec();
    }
    let blocked_tail = [" repeated validation failures. Do not retry this tool. Use a different approach to complete the task."];
    let stripped = remove_diagnostic(&strip_malformed(value), "Tool \"", "\" has been temporarily blocked after ", &blocked_tail);
    let guard_tail = [" attempts (limit ", "). Adjust tool arguments and retry."];
    let stripped = remove_diagnostic(&stripped, LOOP_GUARD, "\" after ", &guard_tail);
    if stripped == value { value.to_vec() } else { cleanup(&stripped) }
}

/// Strips `literal`, then an optional backtick, for the hand-matched cursor patterns.
fn eat<'a>(rest: &'a str, parts: &[&str]) -> Option<&'a str> {
    let mut rest = rest;
    for part in parts {
        rest = match *part {
            "`?" => rest.strip_prefix('`').unwrap_or(rest),
            "'" => rest.strip_prefix('\'').or_else(|| rest.strip_prefix('\u{2019}'))?,
            literal => rest.strip_prefix(literal)?,
        };
    }
    Some(rest)
}

/// `CURSOR_ASSISTANT_TOOL_WORKAROUND_PATTERNS.some((p) => p.test(value.trim()))`.
fn cursor_workaround_line(content: &[u16]) -> bool {
    let line = String::from_utf16_lossy(trim(content));
    let first = [
        "The ",
        "`?",
        "edit",
        "`?",
        " tool is blocked, so I",
        "'",
        "ll use ",
        "`?",
        "Write",
        "`?",
        " and ",
        "`?",
        "StrReplace",
        "`?",
        " to ",
    ];
    let terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let first_match = eat(&line, &first).is_some_and(|rest| rest.ends_with(['.', '!', '?']) && !rest.contains(terminator));
    let second = [
        "Continuing with ",
        "`?",
        "Write",
        "`?",
        " and ",
        "`?",
        "StrReplace",
        "`?",
        " since ",
        "`?",
        "edit",
        "`?",
        " is blocked.",
    ];
    !line.is_empty() && (first_match || eat(&line, &second) == Some(""))
}

fn strip_cursor_lines(value: &[u16]) -> Units {
    if !(contains(value, "edit") && contains(value, "StrReplace")) {
        return value.to_vec();
    }
    let mut changed = false;
    let mut output = Vec::new();
    for (content, separator) in split_lines(value) {
        if cursor_workaround_line(&content) {
            changed = true;
            continue;
        }
        output.extend(content);
        output.extend(separator);
    }
    if changed { cleanup(&output) } else { value.to_vec() }
}

fn visible(value: &[u16]) -> Units {
    strip_cursor_lines(&strip_internal(&collapse(value)))
}

/// `normalizeAssistantVisibleText` (`part-delta.ts:261`).
fn normalize_assistant_visible_text(value: Value) -> Result<Value, String> {
    Ok(out(&visible(&text_of(&value).unwrap_or_default())))
}

/// `normalizeAssistantReasoningText` (`part-delta.ts:267`).
fn normalize_assistant_reasoning_text(value: Value) -> Result<Value, String> {
    Ok(out(&strip_internal(&collapse(&text_of(&value).unwrap_or_default()))))
}

/// `normalizeAssistantPartText` (`part-delta.ts:271`).
fn normalize_assistant_part_text(value: Value, part_type: Option<String>) -> Result<Value, String> {
    if part_type.as_deref() == Some("reasoning") {
        normalize_assistant_reasoning_text(value)
    } else {
        normalize_assistant_visible_text(value)
    }
}

/// `streamingRepeatTailStart`.
fn tail_start(value: &[u16]) -> usize {
    match last_unit(value, 10, value.len()) {
        Some(last) if last > 0 => last_unit(value, 10, last - 1).map_or(0, |i| i + 1),
        _ => 0,
    }
}

fn full_frame_replay(existing: &[u16], delta: &[u16]) -> bool {
    delta.len() >= MIN_FULL_FRAME_DUPLICATE_LENGTH && existing.ends_with(delta)
}

fn text_delta(existing: Units, delta: &[u16]) -> Units {
    if delta.is_empty() || full_frame_replay(&existing, delta) {
        return existing;
    }
    if existing.is_empty() {
        return collapse(delta);
    }
    let combined = [existing.as_slice(), delta].concat();
    if combined.len() <= MAX_JAMMED_DUPLICATE_SCAN_LENGTH {
        return collapse(&combined);
    }
    let start = tail_start(&existing);
    let collapsed = collapse_line_repeats(&combined[start..]);
    if collapsed.len() == combined.len() - start {
        combined
    } else {
        [&existing[..start], collapsed.as_slice()].concat()
    }
}

// ---- JS values ----

fn undef() -> Value {
    js::undefined()
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

fn marker<'a>(v: &'a Value, tag: &str) -> Option<&'a Value> {
    match v {
        Value::Object(o) if o.len() == 1 => o.get(tag),
        _ => None,
    }
}

fn set_items(v: &Value) -> Option<&Vec<Value>> {
    marker(v, "$set").and_then(Value::as_array)
}

/// `typeof v === "number"`.
fn num(v: &Value) -> Option<f64> {
    if v.is_number() || marker(v, "$num").is_some() {
        js::as_number(v)
    } else {
        None
    }
}

/// `typeof v === "string"`, as UTF-16 code units.
fn units(v: &Value) -> Option<Vec<u16>> {
    if v.is_string() || marker(v, "$utf16").is_some() {
        js::string_units(v)
    } else {
        None
    }
}

/// A plain object (not a marker of `undefined`, a number, a string or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    match v {
        Value::Object(o) if !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))) => Some(o),
        _ => None,
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(_) => num(v).is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ if js::is_undefined(v) => false,
        _ if marker(v, "$num").is_some() => num(v).is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ if marker(v, "$utf16").is_some() => units(v).is_some_and(|u| !u.is_empty()),
        _ => true,
    }
}

/// `===` (`same_zero`: SameValueZero, as `Map` and `Set` keys compare). Objects equal nothing.
fn eq(a: &Value, b: &Value, same_zero: bool) -> bool {
    if let (Some(x), Some(y)) = (num(a), num(b)) {
        return x == y || (same_zero && x.is_nan() && y.is_nan());
    }
    if let (Some(x), Some(y)) = (units(a), units(b)) {
        return x == y;
    }
    match (a, b) {
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => js::is_undefined(a) && js::is_undefined(b),
    }
}

fn is_str(v: &Value, text: &str) -> bool {
    units(v).is_some_and(|u| u == text.encode_utf16().collect::<Vec<_>>())
}

/// JS `ToString` of a property key.
fn key_of(v: &Value) -> String {
    if let Some(n) = num(v) {
        return js::number_to_string(n);
    }
    if let Some(u) = units(v) {
        return String::from_utf16_lossy(&u);
    }
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|i| if nullish(i) { String::new() } else { key_of(i) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(v) => "undefined".into(),
        _ if set_items(v).is_some() => "[object Set]".into(),
        _ => "[object Object]".into(),
    }
}

/// The key V8 names in "Cannot read properties of ...": none for an array.
fn reading(v: &Value) -> Option<String> {
    match v {
        Value::Array(_) => None,
        _ if set_items(v).is_some() => Some("#<Set>".into()),
        _ if plain(v).is_some() => Some("#<Object>".into()),
        _ => Some(key_of(v)),
    }
}

fn read_error(base: &Value, key: Option<String>) -> String {
    let kind = if base.is_null() { "null" } else { "undefined" };
    match key {
        Some(key) => format!("Cannot read properties of {kind} (reading '{key}')"),
        None => format!("Cannot read properties of {kind}"),
    }
}

fn index_key(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse::<u32>().ok().filter(|n| canonical && *n != u32::MAX)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    if let Some(u) = units(v) {
        return match key {
            "length" => js::number(u.len() as f64),
            _ => index_key(key).and_then(|i| u.get(i as usize)).map_or_else(undef, |c| js::utf16_string(&[*c])),
        };
    }
    match v {
        Value::Array(items) if key == "length" => js::number(items.len() as f64),
        Value::Array(items) => index_key(key).and_then(|i| items.get(i as usize)).cloned().unwrap_or_else(undef),
        _ => plain(v).and_then(|o| o.get(key)).cloned().unwrap_or_else(undef),
    }
}

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> R<Value> {
    if nullish(v) { Err(read_error(v, Some(key.into()))) } else { Ok(prop(v, key)) }
}

/// `v[key]` for any key value.
fn get_by(v: &Value, key: &Value) -> R<Value> {
    if nullish(v) {
        Err(read_error(v, reading(key)))
    } else {
        Ok(prop(v, &key_of(key)))
    }
}

/// `{ ...v }`.
fn spread(v: &Value) -> Map<String, Value> {
    if let Some(u) = units(v) {
        return u.iter().enumerate().map(|(i, c)| (i.to_string(), js::utf16_string(&[*c]))).collect();
    }
    match v {
        Value::Array(items) => items.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        _ => plain(v).cloned().unwrap_or_default(),
    }
}

/// `object[key] = value`: an integer-like key that is new goes among the integer keys, in order.
fn insert(map: &mut Map<String, Value>, key: String, value: Value) {
    if map.contains_key(&key) {
        map.insert(key, value);
        return;
    }
    let Some(n) = index_key(&key) else {
        map.insert(key, value);
        return;
    };
    let mut entries: Vec<(String, Value)> = std::mem::take(map).into_iter().collect();
    let at = entries.iter().position(|(k, _)| index_key(k).is_none_or(|m| m > n)).unwrap_or(entries.len());
    entries.insert(at, (key, value));
    *map = entries.into_iter().collect();
}

// ---- the unit ----

fn string(v: &Value) -> Option<Vec<u16>> {
    units(v).filter(|u| !u.is_empty())
}

/// Port of `readPendingPartDeltaFromEvent` (`pending-part-deltas.ts:119`).
pub fn read_pending_part_delta_from_event(event: serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    if !is_str(&get(&event, "type")?, "message.part.delta") {
        return Ok(None);
    }
    let props = prop(&event, "properties");
    let mut found = Map::new();
    for key in ["messageID", "partID", "field", "delta"] {
        let Some(text) = string(&get(&props, key)?) else { return Ok(None) };
        found.insert(key.into(), js::utf16_string(&text));
    }
    Ok(Some(Value::Object(found)))
}

/// Port of `buildProvisionalPartFromPendingDeltas` (`pending-part-deltas.ts:292`).
pub fn build_provisional_part_from_pending_deltas(
    message_id: String,
    part_id: String,
    session_id: String,
    pending_deltas: serde_json::Value,
    part_type_hint: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    if eq(&get(&pending_deltas, "length")?, &js::number(0.0), false) {
        return Ok(None);
    }
    let part_type = part_type_hint.unwrap_or_else(|| "text".into());
    if part_type != "text" && part_type != "reasoning" {
        return Ok(None);
    }
    let mut text: Option<Units> = None;
    for pending in &iterate(&pending_deltas, "pendingDeltas")? {
        if !is_str(&get(pending, "field")?, "text") {
            return Ok(None);
        }
        let delta = units(&prop(pending, "delta")).unwrap_or_default();
        text = Some(text_delta(text.unwrap_or_default(), &delta));
    }
    let raw = out(&text.unwrap_or_default());
    let normalized = units(&normalize_assistant_part_text(raw, Some(part_type.clone()))?).unwrap_or_default();
    if normalized.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::json!({
        "id": part_id,
        "messageID": message_id,
        "sessionID": session_id,
        "type": part_type,
        "text": out(&normalized),
        "__provisionalFromDelta": true,
    })))
}

/// `applyPendingPartDeltasToParts`: the parts, and whether a delta applied.
fn apply_to_parts(parts: Value, part_id: &Value, pending_deltas: &Value, options: &Value) -> R<(Value, bool)> {
    if eq(&get(pending_deltas, "length")?, &js::number(0.0), false) {
        return Ok((parts, false));
    }
    let Value::Array(list) = &parts else {
        get(&parts, "findIndex")?;
        return Err("parts.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut index = None;
    for (i, part) in list.iter().enumerate() {
        if eq(&get(part, "id")?, part_id, false) {
            index = Some(i);
            break;
        }
    }
    let Some(index) = index else { return Ok((parts, false)) };
    let previous = list[index].clone();
    let mut next: Option<Map<String, Value>> = None;
    for pending in &iterate(pending_deltas, "pendingDeltas")? {
        let field = key_of(&get(pending, "field")?);
        let existing = match &next {
            Some(map) => map.get(&field).cloned().unwrap_or_else(undef),
            None => prop(&previous, &field),
        };
        let appended = append_non_overlapping_delta(
            if units(&existing).is_some() { existing.clone() } else { undef() },
            prop(pending, "delta"),
            Value::Null,
        )?;
        let value = if get(options, "sanitizeAssistantText")? == Value::Bool(true) && field == "text" {
            let kind = lossy(&prop(&previous, "type"));
            normalize_assistant_part_text(appended, kind)?
        } else {
            appended
        };
        if eq(&existing, &value, false) {
            continue;
        }
        let map = next.get_or_insert_with(|| spread(&previous));
        insert(map, field, value);
    }
    let Some(next) = next else { return Ok((parts, false)) };
    let mut items = list.clone();
    items[index] = Value::Object(next);
    Ok((Value::Array(items), true))
}

/// `for (const item of value)`, `name` being how V8 names the value when it is not iterable.
fn iterate(value: &Value, name: &str) -> R<Vec<Value>> {
    if let Some(items) = set_items(value) {
        return Ok(items.clone());
    }
    if let Some(entries) = marker(value, "$map").and_then(Value::as_array) {
        return Ok(entries.clone());
    }
    if let Some(u) = units(value) {
        let chars = char::decode_utf16(u.iter().copied());
        return Ok(chars
            .map(|c| c.map_or_else(|e| js::utf16_string(&[e.unpaired_surrogate()]), |c| Value::String(c.into())))
            .collect());
    }
    match value {
        Value::Array(items) => Ok(items.clone()),
        _ => Err(format!("{name} is not iterable")),
    }
}

fn lossy(v: &Value) -> Option<String> {
    units(v).map(|u| String::from_utf16_lossy(&u))
}

/// Port of `applyPendingPartDeltasToParts` (`pending-part-deltas.ts:323`).
pub fn apply_pending_part_deltas_to_parts(
    parts: serde_json::Value,
    part_id: String,
    pending_deltas: serde_json::Value,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let options = if js::is_undefined(&options) { Value::Object(Map::new()) } else { options };
    let (parts, applied) = apply_to_parts(parts, &Value::String(part_id), &pending_deltas, &options)?;
    Ok(serde_json::json!({ "parts": parts, "applied": applied }))
}

/// `Object.values(value)`.
fn values(v: &Value) -> R<Vec<Value>> {
    if nullish(v) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    if let Some(u) = units(v) {
        return Ok(u.iter().map(|c| js::utf16_string(&[*c])).collect());
    }
    Ok(match v {
        Value::Array(items) => items.clone(),
        _ => plain(v).map(|o| o.values().cloned().collect()).unwrap_or_default(),
    })
}

fn is_assistant_message(state: &Value, message_id: &Value) -> R<bool> {
    for messages in values(&get(state, "message")?)? {
        let Value::Array(list) = &messages else {
            return Err(if nullish(&messages) {
                read_error(&messages, Some("some".into()))
            } else {
                "messages.some is not a function".into() // recorded-literal: the V8 TypeError text
            });
        };
        for message in list {
            if eq(&get(message, "id")?, message_id, false) && is_str(&prop(message, "role"), "assistant") {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Port of `applyPendingPartDeltasToState` (`pending-part-deltas.ts:377`).
pub fn apply_pending_part_deltas_to_state(
    state: serde_json::Value,
    message_id: String,
    part_id: String,
    pending_deltas: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    let id = Value::String(message_id.clone());
    let all = get(&state, "part")?;
    let parts = get_by(&all, &id)?;
    if !truthy(&parts) {
        return Ok(None);
    }
    let sanitize = is_assistant_message(&state, &id)?;
    let options = serde_json::json!({ "sanitizeAssistantText": sanitize });
    let (parts, applied) = apply_to_parts(parts, &Value::String(part_id), &pending_deltas, &options)?;
    if !applied {
        return Ok(None);
    }
    let mut next = spread(&all);
    insert(&mut next, message_id, parts);
    Ok(Some(serde_json::json!({ "part": next })))
}
