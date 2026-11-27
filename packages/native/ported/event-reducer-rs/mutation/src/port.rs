//! The Rust port of the test wrapper `mutation-ts/event-reducer-mutation.ts` over
//! `event-reducer.ts`: `reduceGlobalEvent`, `applyGlobalProject`, and `applyDirectoryEvent` for the
//! event types without session, message or part bookkeeping (`session.diff`, `todo.updated`,
//! `vcs.branch.updated`, `permission.*`, `question.*`, `lsp.updated`,
//! `server.instance.disposed`, `message.part.removed`, `message.part.delta`, `message.removed`, `message.updated`, `message.part.updated`, `session.deleted`, `session.status`/`.idle`/`.error` with the abort guard empty,
//! unknown types), returning `{ result, draft }`. `Binary.search`
//! and `parseSessionDiffCount` inlined; ids compare with full JS `<`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

mod pinned;

type R<T> = Result<T, String>;

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

/// `v?.key`.
fn opt(v: &Value, key: &str) -> Value {
    if nullish(v) { undef() } else { prop(v, key) }
}

fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JS `Number(text)`.
fn to_number(u: &[u16]) -> f64 {
    let text = String::from_utf16_lossy(u);
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            let mut n = 0.0;
            for c in digits.chars() {
                let Some(d) = c.to_digit(radix) else { return f64::NAN };
                n = n * f64::from(radix) + f64::from(d);
            }
            return if digits.is_empty() { f64::NAN } else { n };
        }
    }
    match t.strip_prefix(['+', '-']).unwrap_or(t) {
        "Infinity" => return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY }, // recorded-literal: JS ToNumber keyword
        body if body.is_empty() || !body.starts_with(|c: char| c.is_ascii_digit() || c == '.') => return f64::NAN,
        body if body.contains(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))) => return f64::NAN,
        _ => {}
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
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

enum Prim {
    Text(Vec<u16>),
    Num(f64),
}

fn primitive(v: &Value) -> Prim {
    if let Some(n) = num(v) {
        return Prim::Num(n);
    }
    if let Some(u) = units(v) {
        return Prim::Text(u);
    }
    match v {
        Value::Null => Prim::Num(0.0),
        Value::Bool(b) => Prim::Num(f64::from(u8::from(*b))),
        _ if js::is_undefined(v) => Prim::Num(f64::NAN),
        _ => Prim::Text(key_of(v).encode_utf16().collect()),
    }
}

/// JS `a < b`.
fn less(a: &Prim, b: &Prim) -> bool {
    let n = |p: &Prim| match p {
        Prim::Num(n) => *n,
        Prim::Text(u) => to_number(u),
    };
    match (a, b) {
        (Prim::Text(x), Prim::Text(y)) => x < y,
        _ => n(a) < n(b),
    }
}
fn kind_of(v: &Value) -> &'static str {
    if num(v).is_some() {
        "number"
    } else if units(v).is_some() {
        "string"
    } else {
        "boolean"
    }
}

/// `holder[key] = value` on the draft's `field` (`holder` read already, so not nullish).
fn put(draft: &mut Value, field: &str, key: &Value, value: Value) -> R<()> {
    let name = key_of(key);
    let Some(holder) = draft.as_object_mut().and_then(|d| d.get_mut(field)) else {
        return Ok(());
    };
    if nullish(holder) {
        let kind = if holder.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot set properties of {kind} (setting '{name}')"));
    }
    if plain(holder).is_some() {
        if let Value::Object(map) = holder {
            insert(map, name, value);
        }
        return Ok(());
    }
    if let Value::Array(items) = holder {
        if let Some(i) = index_key(&name).map(|i| i as usize) {
            items.resize(items.len().max(i + 1), Value::Null);
            items[i] = value;
        }
        return Ok(());
    }
    if set_items(holder).is_some() {
        return Ok(());
    }
    Err(format!("Cannot create property '{name}' on {} '{}'", kind_of(holder), key_of(holder)))
}

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

/// `appendStreamingTextDelta` (`part-delta.ts:295`).
fn append_streaming_text_delta(existing_value: Value, delta: Value) -> Result<Value, String> {
    let existing = text_of(&existing_value).unwrap_or_default();
    Ok(out(&text_delta(existing, &text_of(&delta).unwrap_or_default())))
}

fn output_delta(existing: Units, delta: &[u16]) -> Units {
    if delta.is_empty() || full_frame_replay(&existing, delta) {
        existing
    } else {
        [existing.as_slice(), delta].concat()
    }
}

/// `appendStreamingOutputDelta` (`part-delta.ts:321`).
fn append_streaming_output_delta(existing_value: Value, delta: Value) -> Result<Value, String> {
    let existing = text_of(&existing_value).unwrap_or_default();
    Ok(out(&output_delta(existing, &text_of(&delta).unwrap_or_default())))
}

/// `appendStreamingFieldDelta` (`part-delta.ts:327`).
fn append_streaming_field_delta(field: String, existing_value: Value, delta: Value) -> Result<Value, String> {
    if field == "output" {
        append_streaming_output_delta(existing_value, delta)
    } else {
        append_streaming_text_delta(existing_value, delta)
    }
}

// ---- revert-transactions, nativeCursorText ----

/// `state.session?.find((candidate) => candidate.id === sessionID)`.
fn find_session(state: &Value, session_id: &Value) -> R<Value> {
    let sessions = prop(state, "session");
    if nullish(&sessions) {
        return Ok(undef());
    }
    let Value::Array(list) = &sessions else {
        return Err("state.session?.find is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for candidate in list {
        if eq(&get(candidate, "id")?, session_id, false) {
            return Ok(candidate.clone());
        }
    }
    Ok(undef())
}

/// `getEffectiveSessionRevertMessageID(state, sessionID, session)`.
fn effective(state: &Value, session_id: &Value, session: &Value) -> R<Value> {
    let transaction = opt(&get(state, "revert_transaction")?, &key_of(session_id));
    if truthy(&transaction) && !is_str(&prop(&transaction, "status"), "failed") {
        return Ok(prop(&transaction, "messageID"));
    }
    let session = if nullish(session) {
        find_session(state, session_id)?
    } else {
        session.clone()
    };
    Ok(opt(&opt(&session, "revert"), "messageID"))
}

/// `messagesBefore(messages, marker)`: `None` when it returns `messages` itself.
fn before(messages: &Value, marker: &Value) -> R<Option<Vec<Value>>> {
    let Value::Array(list) = messages else {
        return Err("messages.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for (index, message) in list.iter().enumerate() {
        if eq(&get(message, "id")?, marker, false) {
            return Ok(Some(list[..index].to_vec()));
        }
    }
    Ok(None)
}

/// `isMessageHiddenByRevert(state, sessionID, messageID)`.
fn hidden(state: &Value, session_id: &Value, message_id: &Value) -> R<bool> {
    if !truthy(session_id) {
        return Ok(false);
    }
    let revert = effective(state, session_id, &undef())?;
    if !truthy(&revert) {
        return Ok(false);
    }
    let transaction = opt(&prop(state, "revert_transaction"), &key_of(session_id));
    let ids = opt(&transaction, "hiddenMessageIDs");
    if !is_str(&opt(&transaction, "status"), "failed") && !nullish(&ids) {
        let Some(set) = set_items(&ids) else {
            return Err("transaction?.hiddenMessageIDs?.has is not a function".into()); // recorded-literal: the V8 TypeError text
        };
        if set.iter().any(|id| eq(id, message_id, true)) {
            return Ok(true);
        }
    }
    let messages = opt(&prop(state, "message"), &key_of(session_id));
    if !truthy(&messages) {
        return Ok(false);
    }
    let Some(visible) = before(&messages, &revert)? else { return Ok(false) };
    for message in &visible {
        if eq(&get(message, "id")?, message_id, false) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `isMessageHiddenByAnyActiveRevert(state, messageID)`.
fn hidden_by_any(state: &Value, message_id: &Value) -> R<bool> {
    let transactions = prop(state, "revert_transaction");
    if !truthy(&transactions) {
        return Ok(false);
    }
    for (session_id, transaction) in entries(&transactions) {
        if !truthy(&transaction) || is_str(&prop(&transaction, "status"), "failed") {
            continue;
        }
        let ids = opt(&transaction, "hiddenMessageIDs");
        if nullish(&ids) {
            continue;
        }
        let Some(set) = set_items(&ids) else {
            return Err("transaction.hiddenMessageIDs?.has is not a function".into()); // recorded-literal: the V8 TypeError text
        };
        if set.iter().any(|id| eq(id, message_id, true)) {
            let session = find_session(state, &session_id)?;
            if !truthy(&session) || eq(&effective(state, &session_id, &session)?, &prop(&transaction, "messageID"), false) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `Object.entries(value)` for a value that is not nullish.
fn entries(value: &Value) -> Vec<(Value, Value)> {
    if let Some(u) = units(value) {
        return u
            .iter()
            .enumerate()
            .map(|(i, c)| (Value::String(i.to_string()), js::utf16_string(&[*c])))
            .collect();
    }
    match value {
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (Value::String(i.to_string()), v.clone())).collect(),
        _ => plain(value)
            .map(|o| o.iter().map(|(k, v)| (Value::String(k.clone()), v.clone())).collect())
            .unwrap_or_default(),
    }
}

fn native_cursor(part: &Value) -> R<bool> {
    let kind = get(part, "type")?;
    let text = is_str(&kind, "text");
    let id = prop(part, "id");
    let metadata = prop(part, "metadata");
    if !text && !is_str(&kind, "reasoning") || units(&id).is_none() || !record(&metadata) {
        return Ok(false);
    }
    let state = if text { prop(&metadata, "providerState") } else { metadata };
    let devryan = opt(&state, "devryan");
    let cursor = opt(&devryan, "cursor");
    Ok(record(&state) && record(&devryan) && record(&cursor) && eq(&prop(&cursor, "partID"), &id, false))
}

// ---- session-cache, session-user-activity, sessionDiffStats ----

/// `Array.from(value)` / `[...value]` (`value` not nullish).
fn array_from(value: &Value) -> Vec<Value> {
    if let Some(items) = set_items(value) {
        return items.clone();
    }
    if let Some(u) = units(value) {
        let chars = char::decode_utf16(u.iter().copied());
        return chars
            .map(|c| c.map_or_else(|e| js::utf16_string(&[e.unpaired_surrogate()]), |c| Value::String(c.into())))
            .collect();
    }
    match value {
        Value::Array(items) => items.clone(),
        _ if plain(value).is_some() => {
            let length = match primitive(&prop(value, "length")) {
                Prim::Num(n) => n,
                Prim::Text(u) => to_number(&u),
            };
            let length = if length.is_nan() || length <= 0.0 { 0 } else { length.min(1e6) as usize };
            (0..length).map(|i| prop(value, &i.to_string())).collect()
        }
        _ => Vec::new(),
    }
}

fn unique(values: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for value in values {
        if !out.iter().any(|v| eq(v, &value, true)) {
            out.push(value);
        }
    }
    out
}

fn has(set: &[Value], value: &Value) -> bool {
    set.iter().any(|v| eq(v, value, true))
}

/// `Object.keys(value ?? {})`.
fn keys(value: &Value) -> Vec<String> {
    if let Some(u) = units(value) {
        return (0..u.len()).map(|i| i.to_string()).collect();
    }
    match value {
        Value::Array(items) => (0..items.len()).map(|i| i.to_string()).collect(),
        _ => plain(value).map(|o| o.keys().cloned().collect()).unwrap_or_default(),
    }
}

/// `delete_in store[field][key]`.
fn delete_in(store: &mut Value, field: &str, key: &str) -> R<()> {
    let holder = prop(store, field);
    if nullish(&holder) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    if let Some(u) = units(&holder) {
        if index_key(key).is_some_and(|i| (i as usize) < u.len()) {
            return Err(format!("Cannot delete_in property '{key}' of [object String]"));
        }
        return Ok(());
    }
    if let Some(Value::Object(map)) = store.as_object_mut().and_then(|s| s.get_mut(field)) {
        map.shift_remove(key);
    }
    Ok(())
}

/// `for (const item of value ?? [])`.
fn iterate_or_empty(value: &Value, name: &str) -> R<Vec<Value>> {
    if nullish(value) {
        return Ok(Vec::new());
    }
    if matches!(value, Value::Array(_)) || set_items(value).is_some() || units(value).is_some() {
        return Ok(array_from(value));
    }
    Err(format!("{name} is not iterable"))
}

fn finite(value: &Value) -> Option<f64> {
    if let Some(n) = num(value) {
        return n.is_finite().then_some(n);
    }
    let u = units(value)?;
    if String::from_utf16_lossy(&u).trim_matches(js_space).is_empty() {
        return None;
    }
    Some(to_number(&u)).filter(|n| n.is_finite())
}

fn root(session: &Value) -> bool {
    !truthy(&opt(session, "parentID"))
}

fn created_at(message: &Value) -> R<Option<f64>> {
    Ok(finite(&opt(&get(message, "time")?, "created")))
}

/// `for (const message of visibleMessages)`.
fn iterate_visible(value: &Value) -> R<Vec<Value>> {
    if let Some(set) = set_items(value) {
        return Ok(set.clone());
    }
    if let Some(u) = units(value) {
        let chars = char::decode_utf16(u.iter().copied());
        return Ok(chars
            .map(|c| c.map_or_else(|e| js::utf16_string(&[e.unpaired_surrogate()]), |c| Value::String(c.into())))
            .collect());
    }
    match value {
        Value::Array(items) => Ok(items.clone()),
        _ => Err("visibleMessages is not iterable".into()), // recorded-literal: the V8 TypeError text
    }
}

fn max(a: f64, b: f64) -> f64 {
    if a > b || (a == b && a.is_sign_positive()) { a } else { b }
}

/// `draft.session.find((item) => item.id === sessionID)`.
fn find_in_draft(draft: &Value, session_id: &Value) -> R<Value> {
    let sessions = get(draft, "session")?;
    if nullish(&sessions) {
        return Err(read_error(&sessions, Some("find".into())));
    }
    let Value::Array(list) = &sessions else {
        return Err("draft.session.find is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for item in list {
        if eq(&get(item, "id")?, session_id, false) {
            return Ok(item.clone());
        }
    }
    Ok(undef())
}

/// `getLastVisibleUserMessageAt` (`session-user-activity.ts:36`).
fn get_last_visible_user_message_at(
    session: Option<serde_json::Value>,
    messages: serde_json::Value,
    state: Option<serde_json::Value>,
) -> Result<Option<f64>, String> {
    let session = session.unwrap_or_else(undef);
    let state = state.unwrap_or_else(undef);
    if !root(&session) || !truthy(&messages) {
        return Ok(None);
    }
    let revert = if truthy(&state) {
        let id = opt(&session, "id");
        effective(&state, &if nullish(&id) { Value::String(String::new()) } else { id }, &session)?
    } else {
        opt(&opt(&session, "revert"), "messageID")
    };
    let visible = match truthy(&revert).then(|| before(&messages, &revert)).transpose()?.flatten() {
        Some(list) => list,
        None => iterate_visible(&messages)?,
    };
    let mut latest: Option<f64> = None;
    for message in &visible {
        let shown = !truthy(&state) || !hidden(&state, &get(message, "sessionID")?, &prop(message, "id"))?;
        if !is_str(&get(message, "role")?, "user") || !shown {
            continue;
        }
        let Some(created) = created_at(message)? else { continue };
        latest = Some(latest.map_or(created, |l| max(l, created)));
    }
    Ok(latest)
}

/// `dropSessionCaches(draft, sessionIDs)`.
fn drop_caches(store: &mut Value, ids: &[Value]) -> R<()> {
    let stale = unique(ids.iter().filter(|v| truthy(v)).cloned().collect());
    if stale.is_empty() {
        return Ok(());
    }
    let mut stale_messages: Vec<Value> = Vec::new();
    for session_id in &stale {
        let messages = opt(&get(store, "message")?, &key_of(session_id));
        for message in iterate_or_empty(&messages, "store.message?.[sessionID] ?? []")? {
            let id = opt(&message, "id");
            if truthy(&id) && !has(&stale_messages, &id) {
                stale_messages.push(id);
            }
        }
    }
    for key in keys(&prop(store, "part")) {
        if has(&stale_messages, &Value::String(key.clone())) {
            delete_in(store, "part", &key)?;
            continue;
        }
        let parts = prop(&prop(store, "part"), &key);
        if nullish(&parts) {
            continue;
        }
        let Value::Array(list) = &parts else {
            return Err("parts?.some is not a function".into()); // recorded-literal: the V8 TypeError text
        };
        let hit = list.iter().any(|part| {
            let session = opt(part, "sessionID");
            has(&stale, &if nullish(&session) { Value::String(String::new()) } else { session })
        });
        if hit {
            delete_in(store, "part", &key)?;
        }
    }
    for session_id in &stale {
        let key = key_of(session_id);
        for field in ["message", "todo", "session_diff", "session_status", "permission", "question"] {
            delete_in(store, field, &key)?;
        }
    }
    Ok(())
}

/// `updateSessionUserActivityFromMessages(draft, sessionID)` (its result unused).
fn update_activity(draft: &mut Value, sid: &Value) -> R<bool> {
    let session = find_in_draft(draft, sid)?;
    let messages = get_by(&get(draft, "message")?, sid)?;
    let latest = get_last_visible_user_message_at(Some(session), messages, Some(draft.clone()))?;
    let activity = get(draft, "session_user_activity")?;
    let current = get_by(&activity, sid)?;
    let key = key_of(sid);
    let next = match latest {
        None if js::is_undefined(&current) => None,
        None => {
            let mut next = spread(&activity);
            next.shift_remove(&key);
            Some(next)
        }
        Some(value) if eq(&current, &js::number(value), false) => None,
        Some(value) => {
            let mut next = spread(&activity);
            insert(&mut next, key, js::number(value));
            Some(next)
        }
    };
    let changed = next.is_some();
    if let (Some(next), Value::Object(map)) = (next, draft) {
        insert(map, "session_user_activity".into(), Value::Object(next));
    }
    Ok(changed)
}

/// `stripUntrustedSessionDiffSummary(target)` (`None`: `target` itself back).
fn strip_summary(target: &Value) -> R<Option<Value>> {
    let summary = get(target, "summary")?;
    if !truthy(&summary) {
        return Ok(None);
    }
    let mut next = spread(&summary);
    let before = next.len();
    for key in ["additions", "deletions", "files", "diffs"] {
        next.shift_remove(key);
    }
    if next.len() == before {
        return Ok(None);
    }
    let mut out = spread(target);
    if next.is_empty() {
        out.shift_remove("summary");
    } else {
        insert(&mut out, "summary".into(), Value::Object(next));
    }
    Ok(Some(Value::Object(out)))
}

/// `applyMessageSummaryToSession(draft, sessionID)`.
fn apply_message_summary(draft: &mut Value, sid: &Value) -> R<bool> {
    let messages = get_by(&get(draft, "message")?, sid)?;
    if !truthy(&messages) {
        return Ok(false);
    }
    let sessions = get(draft, "session")?;
    let (found, index) = search(&sessions, sid)?;
    if !found {
        return Ok(false);
    }
    let session = prop(&sessions, &js::number_to_string(index));
    let weak_key = |v: &Value| v.is_array() || record(v);
    if !weak_key(&messages) {
        return Err("Invalid value used as weak map key".into()); // recorded-literal: the V8 TypeError text
    }
    let stripped = strip_summary(&session)?;
    if !weak_key(&session) {
        return Err("Invalid value used as weak map key".into()); // recorded-literal: the V8 TypeError text
    }
    let Some(next) = stripped else { return Ok(false) };
    let mut list = spread_list(&sessions, "draft.session")?;
    if let Some(slot) = at(&mut list, index) {
        *slot = next;
    }
    if let Value::Object(map) = draft {
        insert(map, "session".into(), Value::Array(list));
    }
    Ok(true)
}

/// `message.removed`.
fn message_removed(draft: &mut Value, props: &Value) -> R<Value> {
    let sid = get(props, "sessionID")?;
    let messages = get_by(&get(draft, "message")?, &sid)?;
    let message_id = prop(props, "messageID");
    let mut removed_user = false;
    if truthy(&messages) {
        let mut next = spread_list(&messages, "messages")?;
        if let Some(index) = find_message_index(&Value::Array(next.clone()), &message_id)? {
            removed_user = is_str(&opt(&next[index], "role"), "user");
            next.remove(index);
            put(draft, "message", &sid, Value::Array(next))?;
        }
    }
    let message_id = get(props, "messageID")?;
    if nullish(&prop(draft, "part")) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    if let Some(Value::Object(map)) = draft.as_object_mut().and_then(|d| d.get_mut("part")) {
        map.shift_remove(&key_of(&message_id));
    }
    if removed_user {
        update_activity(draft, &sid)?;
    }
    apply_message_summary(draft, &sid)?;
    Ok(Value::Bool(true))
}

/// `session.deleted`.
fn session_deleted(draft: &mut Value, props: &Value) -> R<Value> {
    let info = get(props, "info")?;
    let id = get(&info, "id")?;
    let sessions = get(draft, "session")?;
    let (found, index) = search(&sessions, &id)?;
    if found && let Value::Array(list) = &sessions {
        let mut list = list.clone();
        if index >= 0.0 && (index as usize) < list.len() {
            list.remove(index as usize);
        }
        if let Value::Object(map) = draft {
            insert(map, "session".into(), Value::Array(list));
        }
    }
    if truthy(&id) {
        drop_caches(draft, std::slice::from_ref(&id))?;
    }
    let activity = get(draft, "session_user_activity")?;
    if nullish(&activity) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    let key = key_of(&id);
    if plain(&activity).is_some_and(|o| o.contains_key(&key)) {
        let mut next = spread(&activity);
        next.shift_remove(&key);
        if let Value::Object(map) = draft {
            insert(map, "session_user_activity".into(), Value::Object(next));
        }
    }
    delete_in(draft, "revert_transaction", &key)?;
    if !truthy(&prop(&info, "parentID")) {
        let total = match primitive(&prop(draft, "sessionTotal")) {
            Prim::Num(n) => n,
            Prim::Text(u) => to_number(&u),
        } - 1.0;
        let total = if total.is_nan() {
            f64::NAN
        } else if total > 0.0 || (total == 0.0 && total.is_sign_positive()) {
            total
        } else {
            0.0
        };
        if let Value::Object(map) = draft {
            insert(map, "sessionTotal".into(), js::number(total));
        }
    }
    Ok(Value::Bool(true))
}

// ---- message.updated ----

fn created(message: &Value) -> R<f64> {
    Ok(num(&opt(&get(message, "time")?, "created")).filter(|n| n.is_finite()).unwrap_or(0.0))
}

/// `compareMessagesChronologically(left, right)`.
fn compare(left: &Value, right: &Value) -> R<f64> {
    let delta = created(left)? - created(right)?;
    if delta != 0.0 {
        return Ok(delta);
    }
    let (a, b) = (primitive(&prop(left, "id")), primitive(&prop(right, "id")));
    Ok(if less(&a, &b) {
        -1.0
    } else if less(&b, &a) {
        1.0
    } else {
        0.0
    })
}

/// `insertMessageChronologically(messages, message)`.
fn insert_chronologically(list: &[Value], message: &Value) -> R<Vec<Value>> {
    let (mut low, mut high) = (0, list.len());
    while low < high {
        let middle = (low + high) / 2;
        if compare(&list[middle], message)? <= 0.0 {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    let mut next = list.to_vec();
    next.insert(low, message.clone());
    Ok(next)
}

/// JS `a >= b` with `b` a number.
fn at_least(a: &Value, b: f64) -> bool {
    let a = match primitive(a) {
        Prim::Num(n) => n,
        Prim::Text(u) => to_number(&u),
    };
    a >= b
}

fn quote(u: &[u16], out: &mut String) {
    out.push('"');
    for c in char::decode_utf16(u.iter().copied()) {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
}

/// `JSON.stringify(v)` (`None` for `undefined`).
fn stringify(v: &Value) -> Option<String> {
    let mut out = String::new();
    write_json(v, &mut out).then_some(out)
}

fn write_json(v: &Value, out: &mut String) -> bool {
    if js::is_undefined(v) {
        return false;
    }
    if let Some(n) = num(v) {
        out.push_str(&if n.is_finite() { js::number_to_string(n) } else { "null".into() });
    } else if let Some(u) = units(v) {
        quote(&u, out);
    } else if set_items(v).is_some() {
        out.push_str("{}");
    } else {
        match v {
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if !write_json(item, out) {
                        out.push_str("null");
                    }
                }
                out.push(']');
            }
            Value::Object(o) => {
                out.push('{');
                let mut first = true;
                for (k, item) in o {
                    let mut member = String::new();
                    quote(&k.encode_utf16().collect::<Vec<_>>(), &mut member);
                    member.push(':');
                    if write_json(item, &mut member) {
                        if !first {
                            out.push(',');
                        }
                        out.push_str(&member);
                        first = false;
                    }
                }
                out.push('}');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    true
}

/// `updateSessionUserActivityFromMessage(draft, message)`.
fn activity_from_message(draft: &mut Value, message: &Value) -> R<bool> {
    if !is_str(&get(message, "role")?, "user") {
        return Ok(false);
    }
    let sid = prop(message, "sessionID");
    let session = find_in_draft(draft, &sid)?;
    if !root(&session) || hidden(draft, &get(message, "sessionID")?, &prop(message, "id"))? {
        return Ok(false);
    }
    let Some(created) = created_at(message)? else { return Ok(false) };
    let activity = get(draft, "session_user_activity")?;
    let current = get_by(&activity, &sid)?;
    if !js::is_undefined(&current) && at_least(&current, created) {
        return Ok(false);
    }
    let mut next = spread(&activity);
    insert(&mut next, key_of(&sid), js::number(created));
    if let Value::Object(map) = draft {
        insert(map, "session_user_activity".into(), Value::Object(next));
    }
    Ok(true)
}

/// `normalizeAssistantTextPart(part)` (`None`: the part itself back).
fn normalize_text_part(part: &Value) -> R<Option<Value>> {
    if native_cursor(part)? {
        return Ok(None);
    }
    let kind = prop(part, "type");
    if !is_str(&kind, "text") && !is_str(&kind, "reasoning") {
        return Ok(None);
    }
    let text = prop(part, "text");
    if units(&text).is_none() {
        return Ok(None);
    }
    let normalized = normalize_assistant_part_text(text.clone(), units(&kind).map(|u| String::from_utf16_lossy(&u)))?;
    if eq(&normalized, &text, false) {
        return Ok(None);
    }
    let mut next = spread(part);
    insert(&mut next, "text".into(), normalized);
    Ok(Some(Value::Object(next)))
}

/// `normalizeAssistantMessagePartsInDraft(draft, messageID)`.
fn normalize_message_parts(draft: &mut Value, message_id: &Value) -> R<bool> {
    let parts = get_by(&get(draft, "part")?, message_id)?;
    if !truthy(&parts) {
        return Ok(false);
    }
    let Value::Array(list) = &parts else {
        return Err("parts.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut changed = false;
    let mut next = Vec::with_capacity(list.len());
    for part in list {
        match normalize_text_part(part)? {
            Some(normalized) => {
                changed = true;
                next.push(normalized);
            }
            None => next.push(part.clone()),
        }
    }
    if !changed {
        return Ok(false);
    }
    put(draft, "part", message_id, Value::Array(next))?;
    Ok(true)
}

/// `getSessionSummaryDiffTotals(summary)`.
fn summary_totals(summary: &Value) -> R<(f64, f64)> {
    if !truthy(summary) {
        return Ok((0.0, 0.0));
    }
    let (additions, deletions) = (prop(summary, "additions"), prop(summary, "deletions"));
    if !js::is_undefined(&additions) || !js::is_undefined(&deletions) {
        return Ok((diff_count(&additions), diff_count(&deletions)));
    }
    let (mut a, mut d) = (0.0, 0.0);
    for diff in iterate_or_empty(&prop(summary, "diffs"), "summary.diffs ?? []")? {
        a += diff_count(&get(&diff, "additions")?);
        d += diff_count(&get(&diff, "deletions")?);
    }
    Ok((a, d))
}

fn unchanged_message(existing: &Value, info: &Value) -> R<bool> {
    let time = |m: &Value, k: &str| opt(&prop(m, "time"), k);
    let parent = |m: &Value| {
        let v = prop(m, "parentID");
        if units(&v).is_some() { v } else { undef() }
    };
    if !eq(&prop(existing, "role"), &prop(info, "role"), false)
        || !eq(&prop(existing, "finish"), &prop(info, "finish"), false)
        || !eq(&time(existing, "completed"), &time(info, "completed"), false)
        || !eq(&parent(existing), &parent(info), false)
        || !eq(&time(existing, "created"), &time(info, "created"), false)
    {
        return Ok(false);
    }
    let (ls, rs) = (prop(existing, "summary"), prop(info, "summary"));
    let (lt, rt) = (summary_totals(&ls)?, summary_totals(&rs)?);
    if truthy(&ls) != truthy(&rs) || lt != rt {
        return Ok(false);
    }
    let (ltok, rtok) = (prop(existing, "tokens"), prop(info, "tokens"));
    Ok(eq(&ltok, &rtok, false) || stringify(&ltok) == stringify(&rtok))
}

/// `message.updated`.
fn message_updated(draft: &mut Value, props: &Value) -> R<Value> {
    let info = get(props, "info")?;
    let sid = get(&info, "sessionID")?;
    let id = prop(&info, "id");
    if hidden(draft, &sid, &id)? {
        if !truthy(&sid) || !truthy(&id) {
            return Ok(Value::Bool(false));
        }
        let messages = get_by(&get(draft, "message")?, &sid)?;
        if !truthy(&messages) {
            return Ok(Value::Bool(false));
        }
        let Some(index) = find_message_index(&messages, &id)? else {
            return Ok(Value::Bool(false));
        };
        let mut next = messages.as_array().cloned().unwrap_or_default();
        next.remove(index);
        put(draft, "message", &sid, Value::Array(next))?;
        update_activity(draft, &sid)?;
        return Ok(Value::Bool(true));
    }
    let activity_changed = activity_from_message(draft, &info)?;
    let messages = get_by(&get(draft, "message")?, &sid)?;
    let assistant = is_str(&prop(&info, "role"), "assistant");
    if !truthy(&messages) {
        put(draft, "message", &sid, Value::Array(vec![info.clone()]))?;
        if assistant {
            normalize_message_parts(draft, &id)?;
        }
        apply_message_summary(draft, &sid)?;
        return Ok(Value::Bool(true));
    }
    let index = find_message_index(&messages, &id)?;
    let list = messages.as_array().cloned().unwrap_or_default();
    let next = match index {
        Some(index) => {
            if unchanged_message(&list[index], &info)? {
                let parts_changed = assistant && normalize_message_parts(draft, &id)?;
                let summary_changed = apply_message_summary(draft, &sid)?;
                return Ok(Value::Bool(summary_changed || activity_changed || parts_changed));
            }
            let mut without = list.clone();
            without.remove(index);
            insert_chronologically(&without, &info)?
        }
        None => insert_chronologically(&list, &info)?,
    };
    put(draft, "message", &sid, Value::Array(next))?;
    if assistant {
        normalize_message_parts(draft, &id)?;
    }
    apply_message_summary(draft, &sid)?;
    Ok(Value::Bool(true))
}

// ---- message.part.updated ----

fn tool_status_final(status: &Value) -> bool {
    let Some(u) = units(status) else { return false };
    let lower = String::from_utf16_lossy(&u).to_lowercase();
    let normalized: String = lower
        .trim_matches(js_space)
        .chars()
        .filter(|c| !js_space(*c) && *c != '_' && *c != '-')
        .collect();
    [
        "completed",
        "complete",
        "error",
        "failed",
        "aborted",
        "timeout",
        "timedout",
        "done",
        "cancelled",
        "canceled",
    ]
    .contains(&normalized.as_str())
}

/// `getPartEndTime` / `getPartStartTime` (`key` is `end` or `start`).
fn part_time(part: &Value, key: &str) -> Option<f64> {
    num(&opt(&opt(&prop(part, "state"), "time"), key)).or_else(|| num(&opt(&prop(part, "time"), key)))
}

/// `shouldPreserveExistingPart(previous, next)`.
fn preserve_existing(previous: &Value, next: &Value) -> bool {
    if !is_str(&prop(previous, "type"), "tool") || !is_str(&prop(next, "type"), "tool") {
        return false;
    }
    let status = |p: &Value| {
        let s = opt(&prop(p, "state"), "status");
        if units(&s).is_some() { s } else { undef() }
    };
    let (ps, ns) = (status(previous), status(next));
    if truthy(&ps) && tool_status_final(&ps) && (!truthy(&ns) || !tool_status_final(&ns)) {
        return true;
    }
    part_time(previous, "end").is_some() && part_time(next, "end").is_none()
}

/// `getUpdatedDeltaFields(previous, next)`.
fn updated_delta_fields(previous: &Value, next: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for field in ["text", "output"] {
        let (Some(p), Some(n)) = (units(&prop(previous, field)), units(&prop(next, field))) else {
            continue;
        };
        if p.is_empty() || n.is_empty() {
            continue;
        }
        if n == p || n.starts_with(&p) || p.starts_with(&n) {
            out.push(Value::String(field.into()));
        }
    }
    out
}

/// `insertProvisionalAssistantMessageForLivePart(draft, part)`.
fn insert_provisional(draft: &mut Value, part: &Value) -> R<()> {
    let text_or_empty = |v: Value| if units(&v).is_some() { v } else { Value::String(String::new()) };
    let message_id = text_or_empty(prop(part, "messageID"));
    let session_id = text_or_empty(prop(part, "sessionID"));
    if !truthy(&message_id) || !truthy(&session_id) {
        return Ok(());
    }
    let messages = get_by(&get(draft, "message")?, &session_id)?;
    if truthy(&messages) && find_message_index(&messages, &message_id)?.is_some() {
        return Ok(());
    }
    let kind = prop(part, "type");
    let create = if is_str(&kind, "reasoning") {
        true
    } else if !is_str(&kind, "text") && !is_str(&kind, "tool") {
        false
    } else {
        let status = opt(&get_by(&get(draft, "session_status")?, &session_id)?, "type");
        is_str(&status, "busy") || is_str(&status, "retry")
    };
    if !create {
        return Ok(());
    }
    let created = part_time(part, "start").unwrap_or_else(pinned::now_ms);
    let provisional = json!({ "id": message_id, "sessionID": session_id, "role": "assistant", "time": { "created": js::number(created) } });
    let messages = get_by(&get(draft, "message")?, &session_id)?;
    let next = if truthy(&messages) {
        insert_chronologically(messages.as_array().map_or(&[], Vec::as_slice), &provisional)?
    } else {
        vec![provisional]
    };
    put(draft, "message", &session_id, Value::Array(next))
}

fn materialization(changed: bool, session_id: &Value, message_id: &Value, part_id: &Value) -> Value {
    json!({ "changed": changed, "materialization": { "type": "incomplete-session-snapshot", "sessionID": session_id, "messageID": message_id, "partID": part_id } })
}

/// `message.part.updated`.
fn part_updated(draft: &mut Value, props: &Value) -> R<Value> {
    let part = get(props, "part")?;
    let kind = get(&part, "type")?;
    if ["patch", "step-start", "step-finish"].iter().any(|t| is_str(&kind, t)) {
        return Ok(Value::Bool(false));
    }
    let (message_id, session_id) = (prop(&part, "messageID"), prop(&part, "sessionID"));
    if hidden(draft, &session_id, &message_id)? || (!truthy(&session_id) && hidden_by_any(draft, &message_id)?) {
        return Ok(Value::Bool(false));
    }
    let messages = if truthy(&session_id) {
        get_by(&get(draft, "message")?, &session_id)?
    } else {
        undef()
    };
    let index = if truthy(&messages) {
        find_message_index(&messages, &message_id)?
    } else {
        None
    };
    let missing = index.is_none();
    let owning = match index {
        Some(i) => prop(&messages, &i.to_string()),
        None => find_message(draft, &session_id, &message_id)?,
    };
    let status = if truthy(&session_id) {
        opt(&get(draft, "session_status")?, &key_of(&session_id))
    } else {
        undef()
    };
    let incoming = if should_normalize(&owning, &status) {
        normalize_text_part(&part)?.unwrap_or_else(|| part.clone())
    } else {
        part.clone()
    };
    if missing {
        insert_provisional(draft, &incoming)?;
    }
    let part_id = prop(&part, "id");
    let done = |draft: &Value| {
        if missing {
            materialization(true, &session_id, &message_id, &part_id)
        } else {
            let _ = draft;
            Value::Bool(true)
        }
    };
    let parts = get_by(&get(draft, "part")?, &message_id)?;
    if !truthy(&parts) {
        put(draft, "part", &message_id, Value::Array(vec![incoming]))?;
        return Ok(done(draft));
    }
    let mut next = spread_list(&parts, "parts")?;
    let found = find_part(&Value::Array(next.clone()), &part_id)?;
    match found {
        Some(i) => {
            let previous = next[i].clone();
            if preserve_existing(&previous, &incoming) {
                return Ok(Value::Bool(false));
            }
            let exact = native_cursor(&incoming)?;
            let dedupe = if exact { Vec::new() } else { updated_delta_fields(&previous, &incoming) };
            let mut merged = incoming.clone();
            if !exact && part_time(&incoming, "end").is_none() {
                for field in ["text", "output"] {
                    let (Some(p), Some(n)) = (units(&prop(&previous, field)), units(&prop(&incoming, field))) else {
                        continue;
                    };
                    if p.is_empty() || n.is_empty() {
                        continue;
                    }
                    if p.len() > n.len() && p.starts_with(&n) {
                        let mut map = spread(&merged);
                        insert(&mut map, field.into(), prop(&previous, field));
                        merged = Value::Object(map);
                    }
                }
            }
            next[i] = if dedupe.is_empty() {
                merged
            } else {
                let mut map = spread(&merged);
                insert(&mut map, "__dedupeNextDeltaFields".into(), Value::Array(dedupe));
                Value::Object(map)
            };
        }
        None => {
            let incoming_kind = prop(&incoming, "type");
            let has_optimistic = !next.is_empty() && !truthy(&prop(&next[0], "sessionID"));
            if has_optimistic && (is_str(&incoming_kind, "text") || is_str(&incoming_kind, "file")) {
                let optimistic = next
                    .iter()
                    .position(|p| eq(&prop(p, "type"), &incoming_kind, false) && !truthy(&prop(p, "sessionID")));
                if let Some(at) = optimistic {
                    next.remove(at);
                }
            }
            next.push(incoming);
        }
    }
    put(draft, "part", &message_id, Value::Array(next))?;
    Ok(done(draft))
}

// ---- display-session, session-recency, sanitize (after their crates) ----

/// `decodeSessionEventInfo`, the session-recency lifecycle merges and `stripSessionDiffSnapshots`,
/// as `display-session-rs`, `session-recency-rs` and `sanitize-rs` port them.
mod recency {
    use serde_json::{Map, Value};

    use crate::js;

    fn nullish(value: &Value) -> bool {
        value.is_null() || js::is_undefined(value)
    }

    /// A bridge marker standing for a primitive (`undefined`, a special number, a string).
    fn primitive_marker(value: &Value) -> bool {
        js::is_undefined(value) || js::as_number(value).is_some() || js::string_units(value).is_some()
    }

    /// `isRecord`.
    fn is_record(value: Option<&Value>) -> bool {
        value.is_some_and(|v| v.is_object() && !primitive_marker(v))
    }

    /// `value[key]`, failing as V8 does on `null` and `undefined`.
    fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
        if nullish(value) {
            let kind = if value.is_null() { "null" } else { "undefined" };
            return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
        }
        Ok(value.get(key).filter(|v| !js::is_undefined(v)))
    }

    fn opt<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
        value.filter(|v| !nullish(v)).and_then(|v| v.get(key)).filter(|v| !js::is_undefined(v))
    }

    fn timestamp(value: Option<&Value>) -> bool {
        value
            .filter(|v| v.is_number() || v.get("$num").is_some())
            .and_then(js::as_number)
            .is_some_and(|n| n.is_finite() && n >= 0.0)
    }

    fn outcome(value: Option<&Value>) -> bool {
        matches!(value.and_then(Value::as_str), Some("succeeded" | "failed" | "interrupted"))
    }

    fn non_empty_string(value: Option<&Value>) -> bool {
        value.and_then(js::string_units).is_some_and(|u| !u.is_empty())
    }

    fn fork(value: Option<&Value>) -> bool {
        let boundary = opt(value, "boundary");
        is_record(value)
            && non_empty_string(opt(value, "sessionID"))
            && is_record(boundary)
            && matches!(opt(boundary, "type").and_then(Value::as_str), Some("before" | "through"))
            && non_empty_string(opt(boundary, "messageID"))
    }

    /// `a === b` (objects never the same here; lone-surrogate string markers compare by value).
    fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
        match (a, b) {
            (None, None) => true,
            (Some(x), Some(y)) => match (js::as_number(x), js::as_number(y)) {
                (Some(m), Some(n)) => m == n,
                (None, None) => x == y && (!matches!(x, Value::Object(_) | Value::Array(_)) || js::string_units(x).is_some()),
                _ => false,
            },
            _ => false,
        }
    }

    fn read(session: &Value) -> Result<Map<String, Value>, String> {
        let time = get(session, "time")?;
        let mut lifecycle = Map::new();
        for key in ["busy", "idle", "viewed"] {
            if let Some(value) = opt(time, key).filter(|v| timestamp(Some(v))) {
                lifecycle.insert(key.to_string(), value.clone());
            }
        }
        for (key, valid) in [("outcome", outcome as fn(Option<&Value>) -> bool), ("fork", fork)] {
            if let Some(value) = session.get(key).filter(|v| valid(Some(v))) {
                lifecycle.insert(key.to_string(), value.clone());
            }
        }
        Ok(lifecycle)
    }

    fn has_invalid(session: &Value) -> Result<bool, String> {
        let defined = |key: &str| session.get(key).filter(|v| !js::is_undefined(v));
        if defined("outcome").is_some_and(|v| !outcome(Some(v))) {
            return Ok(true);
        }
        get(session, "outcome")?;
        if defined("fork").is_some_and(|v| !fork(Some(v))) {
            return Ok(true);
        }
        let time = defined("time");
        if !is_record(time) {
            return Ok(false);
        }
        Ok(["busy", "idle", "viewed"].iter().any(|key| opt(time, key).is_some_and(|v| !timestamp(Some(v)))))
    }

    fn same_fork(left: Option<&Value>, right: Option<&Value>) -> Result<bool, String> {
        if same(left, right) || (left.is_some_and(Value::is_null) && right.is_some_and(Value::is_null)) {
            return Ok(true);
        }
        let (Some(l), Some(r)) = (left, right) else { return Ok(false) };
        if !same(get(l, "sessionID")?, get(r, "sessionID")?) {
            return Ok(false);
        }
        let (lb, rb) = (
            get(l, "boundary")?.cloned().unwrap_or_else(js::undefined),
            get(r, "boundary")?.cloned().unwrap_or_else(js::undefined),
        );
        if !same(get(&lb, "type")?, get(&rb, "type")?) {
            return Ok(false);
        }
        Ok(same(get(&lb, "messageID")?, get(&rb, "messageID")?))
    }

    fn same_lifecycle(left: &Value, right: &Value) -> Result<bool, String> {
        for key in ["busy", "idle", "viewed", "outcome"] {
            if !same(get(left, key)?, get(right, key)?) {
                return Ok(false);
            }
        }
        same_fork(get(left, "fork")?, get(right, "fork")?)
    }

    /// `{ ...value }`.
    fn spread(value: Option<&Value>) -> Map<String, Value> {
        match value {
            Some(Value::Array(items)) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
            Some(Value::String(text)) => text.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), js::utf16_string(&[u]))).collect(),
            Some(Value::Object(map)) if !primitive_marker(value.unwrap_or(&Value::Null)) => map.clone(),
            _ => Map::new(),
        }
    }

    fn apply(target: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
        match value {
            None => {
                target.shift_remove(key);
            }
            Some(value) => {
                target.insert(key.to_string(), value.clone());
            }
        }
    }

    pub(super) fn with_lifecycle(session: Value, lifecycle: &Value) -> Result<Value, String> {
        if !has_invalid(&session)? && same_lifecycle(&Value::Object(read(&session)?), lifecycle)? {
            return Ok(session);
        }
        let mut time = spread(session.get("time"));
        for key in ["busy", "idle", "viewed"] {
            apply(&mut time, key, get(lifecycle, key)?);
        }
        let mut next = spread(Some(&session));
        next.insert("time".to_string(), Value::Object(time));
        for key in ["outcome", "fork"] {
            apply(&mut next, key, get(lifecycle, key)?);
        }
        Ok(Value::Object(next))
    }

    // ---- session-recency ----

    fn finite(value: Option<&Value>) -> Option<f64> {
        value
            .filter(|v| v.is_number() || v.get("$num").is_some())
            .and_then(js::as_number)
            .filter(|n| n.is_finite())
    }

    fn recency(session: &Value) -> Result<Option<f64>, String> {
        let time = get(session, "time")?;
        Ok(finite(opt(time, "updated")).or_else(|| finite(opt(time, "created"))))
    }

    pub(super) fn compare(incoming: &Value, current: &Value) -> Result<i32, String> {
        let (a, b) = (recency(incoming)?, recency(current)?);
        Ok(match (a, b) {
            (Some(a), Some(b)) if a != b => {
                if a < b {
                    -1
                } else {
                    1
                }
            }
            _ => 0,
        })
    }

    /// `Math.max` of two defined numbers (`+0` over `-0`).
    fn max(a: &Value, b: &Value) -> Value {
        let (x, y) = (js::as_number(a).unwrap_or(f64::NAN), js::as_number(b).unwrap_or(f64::NAN));
        if x > y || (x == y && x.is_sign_positive()) { a.clone() } else { b.clone() }
    }

    fn max_defined(left: Option<&Value>, right: Option<&Value>) -> Option<Value> {
        match (left, right) {
            (None, r) => r.cloned(),
            (l, None) => l.cloned(),
            (Some(l), Some(r)) => Some(max(l, r)),
        }
    }

    pub(super) fn resolve(current: &Value, incoming: &Value) -> Result<Value, String> {
        let (left, right) = (read(current)?, read(incoming)?);
        let mut lifecycle = Map::new();
        if let Some(busy) = max_defined(left.get("busy"), right.get("busy")) {
            lifecycle.insert("busy".into(), busy);
        }
        let number = |side: &Map<String, Value>| side.get("idle").and_then(js::as_number);
        let incoming_wins = number(&right).is_some_and(|r| number(&left).is_none_or(|l| r > l));
        let pair = if incoming_wins { &right } else { &left };
        if let Some(idle) = pair.get("idle") {
            lifecycle.insert("idle".into(), idle.clone());
        }
        let outcome = if left.get("idle").is_none() && right.get("idle").is_none() {
            left.get("outcome").or(right.get("outcome"))
        } else {
            pair.get("outcome")
        };
        if let Some(outcome) = outcome {
            lifecycle.insert("outcome".into(), outcome.clone());
        }
        if let Some(viewed) = max_defined(left.get("viewed"), right.get("viewed")) {
            lifecycle.insert("viewed".into(), viewed);
        }
        if let Some(fork) = left.get("fork").or(right.get("fork")) {
            lifecycle.insert("fork".into(), fork.clone());
        }
        Ok(Value::Object(lifecycle))
    }

    fn truthy(value: &Value) -> bool {
        match value {
            Value::Null => false,
            Value::Bool(flag) => *flag,
            Value::String(text) => !text.is_empty(),
            _ => !js::is_undefined(value) && js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
        }
    }

    pub(super) fn merge(current: &Value, incoming: Value) -> Result<Value, String> {
        if !truthy(current) {
            return Ok(incoming);
        }
        let lifecycle = resolve(current, &incoming)?;
        with_lifecycle(incoming, &lifecycle)
    }

    /// `Object.is` for primitives, then the structural walk.
    pub(super) fn equal(left: &Value, right: &Value) -> bool {
        if let (Some(x), Some(y)) = (js::as_number(left), js::as_number(right)) {
            return (x.is_nan() && y.is_nan()) || (x == y && x.is_sign_positive() == y.is_sign_positive());
        }
        if js::is_undefined(left) || js::is_undefined(right) {
            return js::is_undefined(left) && js::is_undefined(right);
        }
        if let (Some(x), Some(y)) = (js::string_units(left), js::string_units(right)) {
            return x == y;
        }
        if primitive_marker(left) || primitive_marker(right) {
            return false;
        }
        let keys = |v: &Value| match v {
            Value::Object(map) if map.len() == 1 && map.get("$set").is_some_and(Value::is_array) => Some(Map::new()),
            Value::Object(map) => Some(map.clone()),
            _ => None,
        };
        match (left, right) {
            (Value::Array(l), Value::Array(r)) => l.len() == r.len() && l.iter().zip(r).all(|(a, b)| equal(a, b)),
            (Value::Array(_), _) | (_, Value::Array(_)) => false,
            (Value::Object(_), Value::Object(_)) => match (keys(left), keys(right)) {
                (Some(l), Some(r)) => l.len() == r.len() && l.iter().all(|(k, v)| r.get(k).is_some_and(|w| equal(v, w))),
                _ => false,
            },
            _ => left == right,
        }
    }

    pub(super) fn decode(value: Value) -> Result<Value, String> {
        let is_session = is_record(Some(&value)) && non_empty_string(value.get("id")) && is_record(value.get("time"));
        if !is_session {
            return Ok(Value::Null);
        }
        if !has_invalid(&value)? {
            return Ok(value);
        }
        let lifecycle = Value::Object(read(&value)?);
        with_lifecycle(value, &lifecycle)
    }

    const DIFF_CONTENT_FIELDS: [&str; 5] = ["patch", "before", "after", "from", "to"];

    /// `stripDiffSummary`: patch bodies dropped from `summary.diffs`.
    pub(super) fn strip_diff_summary(target: Value) -> Result<Value, String> {
        if target.is_null() || js::is_undefined(&target) {
            let kind = if target.is_null() { "null" } else { "undefined" };
            return Err(format!("Cannot read properties of {kind} (reading 'summary')"));
        }
        let Some(Value::Object(summary)) = target.get("summary") else {
            return Ok(target);
        };
        let Some(Value::Array(diffs)) = summary.get("diffs") else { return Ok(target) };
        let mut changed = false;
        let stripped: Vec<Value> = diffs
            .iter()
            .map(|entry| {
                let Value::Object(fields) = entry else { return entry.clone() };
                let mut next = fields.clone();
                for field in DIFF_CONTENT_FIELDS {
                    // `typeof entry[field] === "string"`, lone-surrogate strings included.
                    if fields.get(field).and_then(js::string_units).is_some() {
                        next.shift_remove(field);
                        changed = true;
                    }
                }
                Value::Object(next)
            })
            .collect();
        if !changed {
            return Ok(target);
        }
        let mut summary = summary.clone();
        summary.insert("diffs".to_string(), Value::Array(stripped));
        let mut result = target.as_object().cloned().unwrap_or_default();
        result.insert("summary".to_string(), Value::Object(summary));
        Ok(Value::Object(result))
    }
}

// ---- sessionTitles (after ui-lib/sessionTitles-rs), orchestration-runtime managed title ----

/// What `session.created`/`.updated` use of `@/lib/sessionTitles` (logic as `ui-lib/sessionTitles-rs`
/// ports it) and `isManagedTaskPlaceholderSession` of `@devryan/orchestration-runtime`.
mod titles {
    use serde_json::Value;

    use crate::js;

    const DEFAULT_SESSION_TITLE: &str = "Untitled Session";

    /// JS `\s`.
    fn sp(c: char) -> bool {
        matches!(
            c,
            '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
                | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    }

    /// Whether `s[at..]` starts with the ASCII literal `lit`, ignoring ASCII case.
    fn ci_at(s: &[char], at: usize, lit: &str) -> bool {
        let lit: Vec<char> = lit.chars().collect();
        s.len() >= at + lit.len() && s[at..at + lit.len()].iter().zip(&lit).all(|(a, b)| a.eq_ignore_ascii_case(b))
    }

    fn ws_run(s: &[char], at: usize) -> usize {
        s[at.min(s.len())..].iter().take_while(|c| sp(**c)).count()
    }

    fn trim(s: &str) -> &str {
        s.trim_matches(sp)
    }

    /// `value.replace(/\s+/g, " ").trim()`.
    fn collapse(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        let mut in_run = false;
        for c in value.chars() {
            if sp(c) {
                if !in_run {
                    out.push(' ');
                }
                in_run = true;
            } else {
                out.push(c);
                in_run = false;
            }
        }
        trim(&out).to_string()
    }

    fn cursor_error(title: &str) -> bool {
        let s: Vec<char> = trim(title).chars().collect();
        if !ci_at(&s, 0, "cursor-acp") {
            return false;
        }
        let a = 10 + ws_run(&s, 10);
        if a == 10 || !ci_at(&s, a, "error") {
            return false;
        }
        let b = a + 5 + ws_run(&s, a + 5);
        s.get(b) == Some(&':')
    }

    fn generated(title: &str) -> bool {
        let s: Vec<char> = trim(title).chars().collect();
        if !ci_at(&s, 0, "new session") {
            return false;
        }
        let mut i = 11 + ws_run(&s, 11);
        if s.get(i) != Some(&'-') {
            return false;
        }
        i += 1 + ws_run(&s, i + 1);
        let digits = |i: &mut usize, n: usize| {
            let ok = s.len() >= *i + n && s[*i..*i + n].iter().all(char::is_ascii_digit);
            *i += n;
            ok
        };
        let lit = |i: &mut usize, c: char| {
            let ok = s.get(*i).is_some_and(|x| x.eq_ignore_ascii_case(&c));
            *i += 1;
            ok
        };
        if !(digits(&mut i, 4)
            && lit(&mut i, '-')
            && digits(&mut i, 2)
            && lit(&mut i, '-')
            && digits(&mut i, 2)
            && lit(&mut i, 't')
            && digits(&mut i, 2)
            && lit(&mut i, ':')
            && digits(&mut i, 2)
            && lit(&mut i, ':')
            && digits(&mut i, 2))
        {
            return false;
        }
        if s.get(i) == Some(&'.') {
            let n = s[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
            if n > 0 && s.get(i + 1 + n).is_some_and(|c| c.eq_ignore_ascii_case(&'z')) && i + 2 + n == s.len() {
                return true;
            }
        }
        s.get(i).is_some_and(|c| c.eq_ignore_ascii_case(&'z')) && i + 1 == s.len()
    }

    fn plan_control(title: &str) -> bool {
        let s: Vec<char> = title.chars().filter(|c| !sp(*c)).collect();
        if s.first() != Some(&'<') || s.last() != Some(&'>') {
            return false;
        }
        let prefix = s[1..].iter().take_while(|c| **c == '!' || **c == '-').count();
        let marks = &s[1..1 + prefix];
        let opener = marks.first() == Some(&'!') || marks.starts_with(&['-', '-']);
        let at = 1 + prefix;
        if !opener || !ci_at(&s, at, "plan") {
            return false;
        }
        let dashes = &s[at + 4..s.len() - 1];
        !dashes.is_empty() && dashes.iter().all(|c| *c == '-')
    }

    /// `isPlaceholderSessionTitle(title)` (a string title as its code units, lone surrogates as U+FFFD).
    pub(super) fn placeholder(title: &Value) -> bool {
        let normalized = js::string_units(title).map(|u| collapse(&String::from_utf16_lossy(&u))).unwrap_or_default();
        normalized.is_empty()
            || normalized.to_lowercase() == DEFAULT_SESSION_TITLE.to_lowercase()
            || cursor_error(&normalized)
            || generated(&normalized)
            || plan_control(&normalized)
    }

    /// `formatManagedTaskDisplayName(label)` of `@devryan/orchestration-runtime`.
    fn format_managed(label: &str) -> String {
        let dashes: String = label.trim_matches(sp).chars().map(|c| if c == '-' || c == '_' { ' ' } else { c }).collect();
        let normalized = collapse(&dashes);
        if normalized.is_empty() {
            return String::new();
        }
        let all: Vec<&str> = normalized.split(' ').collect();
        let words: Vec<&str> = all
            .iter()
            .enumerate()
            .filter(|(i, w)| *i == 0 || w.to_lowercase() != all[i - 1].to_lowercase())
            .map(|(_, w)| *w)
            .collect();
        let initialisms = [
            ("api", "API"),
            ("cli", "CLI"),
            ("css", "CSS"),
            ("html", "HTML"),
            ("http", "HTTP"),
            ("json", "JSON"),
            ("mcp", "MCP"),
            ("pdf", "PDF"),
            ("pr", "PR"),
            ("sdk", "SDK"),
            ("sse", "SSE"),
            ("ui", "UI"),
            ("url", "URL"),
            ("ux", "UX"),
        ];
        let internal = [
            "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "per", "the", "to", "via", "vs",
        ];
        let count = words.len();
        let shown: Vec<String> = words
            .iter()
            .enumerate()
            .map(|(index, word)| {
                let lower = word.to_lowercase();
                if let Some((_, upper)) = initialisms.iter().find(|(k, _)| *k == lower) {
                    return (*upper).to_string();
                }
                if index > 0 && index < count - 1 && internal.contains(&lower.as_str()) && *word == lower {
                    return lower;
                }
                if *word != lower {
                    return (*word).to_string();
                }
                let units: Vec<u16> = word.encode_utf16().collect();
                let first = String::from_utf16_lossy(&units[..1.min(units.len())]);
                format!("{}{}", first.to_uppercase(), String::from_utf16_lossy(&units[1.min(units.len())..]))
            })
            .collect();
        shown.join(" ")
    }

    /// `isManagedTaskPlaceholderSession(session)` of `@devryan/orchestration-runtime`.
    pub(super) fn managed_placeholder(session: &Value) -> bool {
        let Some(map) = session
            .as_object()
            .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16"].iter().any(|k| o.contains_key(*k))))
        else {
            return false;
        };
        let text = |k: &str| map.get(k).and_then(js::string_units).map(|u| String::from_utf16_lossy(&u));
        let (Some(parent), Some(agent), Some(title)) = (text("parentID"), text("agent"), text("title")) else {
            return false;
        };
        if trim(&parent).is_empty() || trim(&agent).is_empty() {
            return false;
        }
        let t: Vec<char> = trim(&title).chars().collect();
        if !ci_at(&t, 0, "managed") || !t.get(7).is_some_and(|c| sp(*c)) {
            return false;
        }
        collapse(&title).to_lowercase() == format_managed(&format!("Managed {agent} task")).to_lowercase()
    }
}

// ---- session.created / session.updated ----

/// `mergeSessionPreservingMeaningfulTitle(current, incoming)`.
fn merge_title(current: &Value, incoming: &Value) -> R<Value> {
    if !truthy(current)
        || titles::placeholder(&get(current, "title")?)
        || titles::managed_placeholder(current)
        || (!titles::placeholder(&get(incoming, "title")?) && !titles::managed_placeholder(incoming))
    {
        return Ok(incoming.clone());
    }
    let mut next = spread(incoming);
    insert(&mut next, "title".into(), prop(current, "title"));
    Ok(Value::Object(next))
}

fn retain(retained: Value, rejected: &Value) -> R<Value> {
    let lifecycle = recency::resolve(&retained, rejected)?;
    recency::with_lifecycle(retained, &lifecycle)
}

/// JS `a > b` / `a <= b` of a number and any value (`None` when either side is NaN).
fn cmp_number(a: f64, b: &Value) -> Option<std::cmp::Ordering> {
    let b = match primitive(b) {
        Prim::Num(n) => n,
        Prim::Text(u) => to_number(&u),
    };
    a.partial_cmp(&b)
}

/// `trimSessions(draft)`.
fn trim_sessions(draft: &mut Value) -> R<()> {
    let length = |d: &Value| prop(&prop(d, "session"), "length");
    let limit = prop(draft, "limit");
    let len = num(&length(draft)).unwrap_or(f64::NAN);
    if matches!(cmp_number(len, &limit), Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)) {
        return Ok(());
    }
    let mut protected: Vec<Value> = Vec::new();
    for (field, check) in [("permission", 0u8), ("question", 0), ("session_status", 1)] {
        let holder = prop(draft, field);
        let holder = if nullish(&holder) { Value::Object(Map::new()) } else { holder };
        for (key, value) in entries(&holder) {
            let keep = if check == 0 {
                truthy(&value) && cmp_number(0.0, &prop(&value, "length")) == Some(std::cmp::Ordering::Less)
            } else {
                truthy(&value) && !is_str(&prop(&value, "type"), "idle")
            };
            if keep {
                protected.push(key);
            }
        }
    }
    loop {
        let len = num(&length(draft)).unwrap_or(f64::NAN);
        if cmp_number(len, &limit) != Some(std::cmp::Ordering::Greater) {
            return Ok(());
        }
        let Some(Value::Array(list)) = draft.as_object_mut().and_then(|d| d.get_mut("session")) else {
            return Ok(());
        };
        let id = get(&list[0], "id")?;
        if protected.iter().any(|p| eq(p, &id, true)) {
            return Ok(());
        }
        list.remove(0);
    }
}

fn set_session_at(draft: &mut Value, index: f64, value: Value, remove: bool) -> R<()> {
    let sessions = prop(draft, "session");
    let Value::Array(list) = &sessions else {
        return Err("sessions.splice is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut list = list.clone();
    let i = (index.max(0.0) as usize).min(list.len());
    if remove {
        if i < list.len() {
            list.remove(i);
        }
    } else {
        list.insert(i, value);
    }
    if let Value::Object(map) = draft {
        insert(map, "session".into(), Value::Array(list));
    }
    Ok(())
}

fn replace_session_at(draft: &mut Value, index: f64, value: Value) {
    if let Some(Value::Array(list)) = draft.as_object_mut().and_then(|d| d.get_mut("session"))
        && let Some(slot) = at(list, index)
    {
        *slot = value;
    }
}

/// `Math.max(0, draft.sessionTotal - 1)` / `draft.sessionTotal += 1`.
fn bump_total(draft: &mut Value, up: bool) {
    let total = prop(draft, "sessionTotal");
    let next = if up {
        match primitive(&total) {
            Prim::Num(n) => js::number(n + 1.0),
            Prim::Text(u) => js::utf16_string(&[u, vec![u16::from(b'1')]].concat()),
        }
    } else {
        let n = match primitive(&total) {
            Prim::Num(n) => n,
            Prim::Text(u) => to_number(&u),
        } - 1.0;
        js::number(if n.is_nan() {
            f64::NAN
        } else if n > 0.0 {
            n
        } else {
            0.0
        })
    };
    if let Value::Object(map) = draft {
        insert(map, "sessionTotal".into(), next);
    }
}

fn has_own_key(holder: &Value, key: &Value) -> R<bool> {
    if nullish(holder) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    let key = key_of(key);
    Ok(match holder {
        Value::Array(items) => key == "length" || index_key(&key).is_some_and(|i| (i as usize) < items.len()),
        _ if units(holder).is_some() => key == "length" || index_key(&key).is_some_and(|i| (i as usize) < units(holder).map_or(0, |u| u.len())),
        _ => plain(holder).is_some_and(|o| o.contains_key(&key)),
    })
}

/// `session.created` (`updated` false) and `session.updated`.
fn session_upserted(draft: &mut Value, event: &Value, updated: bool) -> R<Value> {
    let properties = prop(event, "properties");
    let decoded = if recency_record(&properties) {
        recency::decode(prop(&properties, "info"))?
    } else {
        Value::Null
    };
    if !truthy(&decoded) {
        return Ok(Value::Bool(false));
    }
    let incoming = recency::strip_diff_summary(decoded)?;
    let sessions = get(draft, "session")?;
    let id = prop(&incoming, "id");
    let (found, index) = search(&sessions, &id)?;
    let stored = if found { prop(&sessions, &js::number_to_string(index)) } else { undef() };
    if found && recency::compare(&incoming, &stored)? < 0 {
        let kept = retain(merge_title(&incoming, &stored)?, &incoming)?;
        if recency::equal(&stored, &kept) {
            return Ok(Value::Bool(false));
        }
        replace_session_at(draft, index, kept);
        return Ok(Value::Bool(true));
    }
    let messages = get_by(&get(draft, "message")?, &id)?;
    if truthy(&messages) && !(messages.is_array() || record(&messages)) {
        return Err("Invalid value used as weak map key".into()); // recorded-literal: the V8 TypeError text
    }
    let normalized = strip_summary(&incoming)?.unwrap_or_else(|| incoming.clone());
    let titled = merge_title(&stored, &normalized)?;
    let info = recency::merge(&if found { stored.clone() } else { Value::Null }, titled)?;
    let info_id = get(&info, "id")?;
    if updated && truthy(&get(&get(&info, "time")?, "archived")?) {
        let had_activity = has_own_key(&get(draft, "session_user_activity")?, &info_id)?;
        let had_revert = has_own_key(&get(draft, "revert_transaction")?, &info_id)?;
        if found {
            set_session_at(draft, index, Value::Null, true)?;
        }
        let key = key_of(&info_id);
        if had_activity {
            let mut next = spread(&prop(draft, "session_user_activity"));
            next.shift_remove(&key);
            if let Value::Object(map) = draft {
                insert(map, "session_user_activity".into(), Value::Object(next));
            }
        }
        delete_in(draft, "revert_transaction", &key)?;
        if found && !truthy(&prop(&info, "parentID")) {
            bump_total(draft, false);
        }
        return Ok(Value::Bool(found || had_activity || had_revert));
    }
    if found {
        if recency::equal(&stored, &info) {
            if updated {
                return Ok(Value::Bool(update_activity(draft, &info_id)?));
            }
            return Ok(Value::Bool(false));
        }
        replace_session_at(draft, index, info.clone());
    } else {
        set_session_at(draft, index, info.clone(), false)?;
        trim_sessions(draft)?;
        if !updated && !truthy(&prop(&info, "parentID")) {
            bump_total(draft, true);
        }
    }
    if updated {
        update_activity(draft, &info_id)?;
    }
    Ok(Value::Bool(true))
}

/// `isRecord` of `display-session.ts`.
fn recency_record(v: &Value) -> bool {
    plain(v).is_some() || set_items(v).is_some()
}

// ---- the unit ----

/// `[...value]` (`name` as V8 names the value when it is not iterable).
fn spread_list(value: &Value, name: &str) -> R<Vec<Value>> {
    if let Some(items) = set_items(value) {
        return Ok(items.clone());
    }
    if let Some(u) = units(value) {
        let chars = char::decode_utf16(u.iter().copied());
        return Ok(chars
            .map(|c| c.map_or_else(|e| js::utf16_string(&[e.unpaired_surrogate()]), |c| Value::String(c.into())))
            .collect());
    }
    match value {
        Value::Array(items) => Ok(items.clone()),
        _ if num(value).is_some() => Err(format!(
            "number {} is not iterable (cannot read property Symbol(Symbol.iterator))",
            key_of(value)
        )),
        Value::Bool(b) => Err(format!("boolean {b} is not iterable (cannot read property Symbol(Symbol.iterator))")),
        _ if nullish(value) => Err(format!("{name} is not iterable")),
        _ => Err(format!("{name} is not iterable")),
    }
}

/// `Binary.search(array, id, (item) => item.id)` over `array[i]` reads.
fn search(array: &Value, id: &Value) -> R<(bool, f64)> {
    let length = match primitive(&get(array, "length")?) {
        Prim::Num(n) => n,
        Prim::Text(u) => to_number(&u),
    };
    let (mut left, mut right) = (0.0_f64, length - 1.0);
    while left <= right {
        let mid = ((left + right) / 2.0).floor();
        let item = prop(array, &js::number_to_string(mid));
        let mid_id = get(&item, "id")?;
        if eq(&mid_id, id, false) {
            return Ok((true, mid));
        }
        if less(&primitive(&mid_id), &primitive(id)) {
            left = mid + 1.0;
        } else {
            right = mid - 1.0;
        }
    }
    Ok((false, left))
}

/// `parseSessionDiffCount(value)`.
fn diff_count(value: &Value) -> f64 {
    let parsed = if let Some(n) = num(value) {
        if n.is_finite() {
            return n.max(0.0) + 0.0;
        }
        return 0.0;
    } else if let Some(u) = units(value) {
        to_number(&u)
    } else {
        return 0.0;
    };
    if parsed.is_finite() { parsed.max(0.0) + 0.0 } else { 0.0 }
}

fn diffs_equivalent(left: &Value, right: &Value) -> R<bool> {
    if eq(left, right, false) {
        return Ok(true);
    }
    if !truthy(left) {
        return Ok(false);
    }
    let (ll, rl) = (get(left, "length")?, get(right, "length")?);
    if !eq(&ll, &rl, false) {
        return Ok(false);
    }
    let length = num(&ll).unwrap_or(f64::NAN);
    let mut index = 0.0;
    while index < length {
        let key = js::number_to_string(index);
        let (l, r) = (prop(left, &key), prop(right, &key));
        let (lf, rf) = (get(&l, "file")?, get(&r, "file")?);
        if !eq(&lf, &rf, false) || !eq(&get(&l, "status")?, &get(&r, "status")?, false) {
            return Ok(false);
        }
        if diff_count(&prop(&l, "additions")) != diff_count(&prop(&r, "additions")) || diff_count(&prop(&l, "deletions")) != diff_count(&prop(&r, "deletions"))
        {
            return Ok(false);
        }
        index += 1.0;
    }
    Ok(true)
}

fn at(list: &mut [Value], index: f64) -> Option<&mut Value> {
    (index >= 0.0 && index.fract() == 0.0).then_some(index as usize).and_then(|i| list.get_mut(i))
}

/// `permission.asked` / `question.asked`.
fn asked(draft: &mut Value, field: &str, request: &Value) -> R<Value> {
    let session_id = get(request, "sessionID")?;
    let current = get_by(&get(draft, field)?, &session_id)?;
    let current = if nullish(&current) { Value::Array(Vec::new()) } else { current };
    let name = if field == "permission" { "permissions" } else { "questions" };
    let mut next = spread_list(&current, name)?;
    let (found, index) = search(&Value::Array(next.clone()), &prop(request, "id"))?;
    if found {
        if let Some(slot) = at(&mut next, index) {
            *slot = request.clone();
        }
    } else {
        let i = (index.max(0.0) as usize).min(next.len());
        next.insert(i, request.clone());
    }
    put(draft, field, &session_id, Value::Array(next))?;
    Ok(Value::Bool(true))
}

/// `permission.replied` / `question.replied` / `question.rejected`.
fn replied(draft: &mut Value, field: &str, props: &Value) -> R<Value> {
    let session_id = get(props, "sessionID")?;
    let current = get_by(&get(draft, field)?, &session_id)?;
    if !truthy(&current) {
        return Ok(Value::Bool(false));
    }
    let (found, index) = search(&current, &prop(props, "requestID"))?;
    if !found {
        return Ok(Value::Bool(false));
    }
    let name = if field == "permission" { "permissions" } else { "questions" };
    let mut next = spread_list(&current, name)?;
    if index >= 0.0 && (index as usize) < next.len() {
        next.remove(index as usize);
    }
    put(draft, field, &session_id, Value::Array(next))?;
    Ok(Value::Bool(true))
}

/// `areSessionStatusesEqual(left, right)`.
fn statuses_equal(left: &Value, right: &Value) -> bool {
    if eq(left, right, false) {
        return true;
    }
    let kind = prop(right, "type");
    if !truthy(left) || !eq(&prop(left, "type"), &kind, false) {
        return false;
    }
    if is_str(&kind, "idle") || is_str(&kind, "busy") {
        return true;
    }
    is_str(&kind, "retry") && ["attempt", "message", "next"].iter().all(|k| eq(&prop(left, k), &prop(right, k), false))
}

/// The tail of `session.status` / `session.idle` / `session.error`.
fn set_status(draft: &mut Value, session_id: &Value, status: Value) -> R<Value> {
    if statuses_equal(&get_by(&get(draft, "session_status")?, session_id)?, &status) {
        return Ok(Value::Bool(false));
    }
    put(draft, "session_status", session_id, status)?;
    Ok(Value::Bool(true))
}

/// `parts.findIndex((part) => part.id === id)`.
fn find_part(parts: &Value, id: &Value) -> R<Option<usize>> {
    let Value::Array(list) = parts else {
        return Err("parts.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for (index, part) in list.iter().enumerate() {
        if eq(&get(part, "id")?, id, false) {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

/// `message.part.removed`.
fn part_removed(draft: &mut Value, props: &Value) -> R<Value> {
    let message_id = get(props, "messageID")?;
    let parts = get_by(&get(draft, "part")?, &message_id)?;
    if !truthy(&parts) {
        return Ok(Value::Bool(false));
    }
    let Some(index) = find_part(&parts, &prop(props, "partID"))? else {
        return Ok(Value::Bool(false));
    };
    let mut next = parts.as_array().cloned().unwrap_or_default();
    next.remove(index);
    if next.is_empty() {
        if let Some(Value::Object(map)) = draft.as_object_mut().and_then(|d| d.get_mut("part")) {
            map.shift_remove(&key_of(&message_id));
        }
    } else {
        put(draft, "part", &message_id, Value::Array(next))?;
    }
    Ok(Value::Bool(true))
}

/// `value === null || typeof value !== "object"` negated, as `isRecord` reads it.
fn record(v: &Value) -> bool {
    plain(v).is_some() || set_items(v).is_some()
}

/// `findSessionIdForMessage(draft, messageID)`.
fn session_for_message(draft: &Value, message_id: &Value) -> R<Value> {
    let messages = get(draft, "message")?;
    if nullish(&messages) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    for (session_id, list) in entries(&messages) {
        if find_message_index(&list, message_id)?.is_some() {
            return Ok(session_id);
        }
    }
    Ok(undef())
}

/// `findMessageIndex(messages, id)`.
fn find_message_index(messages: &Value, id: &Value) -> R<Option<usize>> {
    let Value::Array(list) = messages else {
        get(messages, "findIndex")?;
        return Err("messages.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for (index, message) in list.iter().enumerate() {
        if eq(&get(message, "id")?, id, false) {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

/// `findMessage(draft, sessionID, messageID)`.
fn find_message(draft: &Value, session_id: &Value, message_id: &Value) -> R<Value> {
    if truthy(session_id) {
        let messages = get_by(&get(draft, "message")?, session_id)?;
        if truthy(&messages)
            && let Some(index) = find_message_index(&messages, message_id)?
        {
            return Ok(prop(&messages, &index.to_string()));
        }
    }
    for (_, messages) in entries(&get(draft, "message")?) {
        if let Some(index) = find_message_index(&messages, message_id)? {
            return Ok(prop(&messages, &index.to_string()));
        }
    }
    Ok(undef())
}

/// `shouldNormalizeAssistantPart(message, status)`.
fn should_normalize(message: &Value, status: &Value) -> bool {
    if !is_str(&opt(message, "role"), "assistant") {
        return false;
    }
    let completed = num(&opt(&prop(message, "time"), "completed")).is_some_and(|c| c.is_finite() && c > 0.0);
    completed || !is_str(&opt(status, "type"), "busy")
}

/// `(value ?? "") + delta` as JS string concatenation.
fn concat(value: &Value, delta: &Value) -> Value {
    let to_units = |v: &Value| units(v).unwrap_or_else(|| key_of(v).encode_utf16().collect());
    let head = if nullish(value) { Vec::new() } else { to_units(value) };
    js::utf16_string(&[head, to_units(delta)].concat())
}

/// `message.part.delta`.
fn part_delta(draft: &mut Value, props: &Value) -> R<Value> {
    let message_id = get(props, "messageID")?;
    let parts = get_by(&get(draft, "part")?, &message_id)?;
    let session_id = session_for_message(draft, &message_id)?;
    if hidden(draft, &session_id, &message_id)? || (!truthy(&session_id) && hidden_by_any(draft, &message_id)?) {
        return Ok(Value::Bool(false));
    }
    let part_id = prop(props, "partID");
    let incomplete = || json!({ "changed": false, "materialization": { "type": "incomplete-session-snapshot", "sessionID": session_id, "messageID": message_id, "partID": part_id } });
    if !truthy(&parts) {
        return Ok(incomplete());
    }
    let Some(index) = find_part(&parts, &part_id)? else { return Ok(incomplete()) };
    let existing = prop(&parts, &index.to_string());
    let field = prop(props, "field");
    let field_key = key_of(&field);
    let existing_value = get(&existing, &field_key)?;
    let dedupe = prop(&existing, "__dedupeNextDeltaFields");
    let dedupe = if nullish(&dedupe) { Value::Array(Vec::new()) } else { dedupe };
    let should_dedupe = match &dedupe {
        Value::Array(items) => items.iter().any(|f| eq(f, &field, true)),
        _ if units(&dedupe).is_some() => units(&field).is_some_and(|f| index_of(&units(&dedupe).unwrap_or_default(), &f, 0).is_some()),
        _ => return Err("dedupeFields.includes is not a function".into()), // recorded-literal: the V8 TypeError text
    };
    let text_field = is_str(&field, "text");
    let sanitize = text_field && {
        let status = if truthy(&session_id) {
            opt(&get(draft, "session_status")?, &key_of(&session_id))
        } else {
            undef()
        };
        should_normalize(&find_message(draft, &session_id, &message_id)?, &status)
    };
    let exact = text_field && native_cursor(&existing)?;
    let delta = prop(props, "delta");
    let appended = if exact {
        concat(&existing_value, &delta)
    } else if should_dedupe {
        append_non_overlapping_delta(existing_value.clone(), delta, Value::Null)?
    } else if text_field || is_str(&field, "output") {
        append_streaming_field_delta(field_key.clone(), existing_value.clone(), delta)?
    } else {
        concat(&existing_value, &delta)
    };
    let next_value = if sanitize && !exact {
        normalize_assistant_part_text(appended, units(&prop(&existing, "type")).map(|u| String::from_utf16_lossy(&u)))?
    } else {
        appended
    };
    let dedupe_len = prop(&dedupe, "length");
    if eq(&existing_value, &next_value, false) && eq(&dedupe_len, &js::number(0.0), false) {
        return Ok(Value::Bool(false));
    }
    let Value::Array(fields) = &dedupe else {
        return Err("dedupeFields.filter is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let kept: Vec<Value> = fields.iter().filter(|f| !eq(f, &field, false)).cloned().collect();
    let mut updated = spread(&existing);
    insert(&mut updated, field_key, next_value);
    insert(&mut updated, "__dedupeNextDeltaFields".into(), Value::Array(kept));
    let mut next = parts.as_array().cloned().unwrap_or_default();
    next[index] = Value::Object(updated);
    put(draft, "part", &message_id, Value::Array(next))?;
    Ok(Value::Bool(true))
}

fn directory_event(draft: &mut Value, event: &Value) -> R<Value> {
    let kind = get(event, "type")?;
    let kind = if units(&kind).is_some() {
        String::from_utf16_lossy(&units(&kind).unwrap_or_default())
    } else {
        String::new()
    };
    let props = prop(event, "properties");
    match kind.as_str() {
        "session.diff" => {
            let session_id = get(&props, "sessionID")?;
            let previous = get_by(&get(draft, "session_diff")?, &session_id)?;
            let diff = prop(&props, "diff");
            let changed = !diffs_equivalent(&previous, &diff)?;
            if changed {
                put(draft, "session_diff", &session_id, diff)?;
            }
            Ok(Value::Bool(changed))
        }
        "todo.updated" => {
            let session_id = get(&props, "sessionID")?;
            let todos = prop(&props, "todos");
            get(draft, "todo")?;
            put(draft, "todo", &session_id, todos)?;
            Ok(Value::Bool(true))
        }
        "vcs.branch.updated" => {
            let branch = get(&props, "branch")?;
            if eq(&opt(&get(draft, "vcs")?, "branch"), &branch, false) {
                return Ok(Value::Bool(false));
            }
            if let Value::Object(map) = draft {
                insert(map, "vcs".into(), json!({ "branch": branch }));
            }
            Ok(Value::Bool(true))
        }
        "session.status" => {
            let session_id = get(&props, "sessionID")?;
            let status = prop(&props, "status");
            get(&status, "type")?;
            set_status(draft, &session_id, status)
        }
        "session.idle" | "session.error" => {
            let session_id = get(&props, "sessionID")?;
            set_status(draft, &session_id, json!({ "type": "idle" }))
        }
        "message.part.removed" => part_removed(draft, &props),
        "message.removed" => message_removed(draft, &props),
        "message.updated" => message_updated(draft, &props),
        "session.created" => session_upserted(draft, event, false),
        "session.updated" => session_upserted(draft, event, true),
        "message.part.updated" => part_updated(draft, &props),
        "session.deleted" => session_deleted(draft, &props),
        "message.part.delta" => part_delta(draft, &props),
        "permission.asked" => asked(draft, "permission", &props),
        "question.asked" => asked(draft, "question", &props),
        "permission.replied" => replied(draft, "permission", &props),
        "question.replied" | "question.rejected" => replied(draft, "question", &props),
        _ => Ok(Value::Bool(false)),
    }
}

/// Port of `reduceGlobalEventOf` (`event-reducer-mutation.ts:22`).
pub fn reduce_global_event_of(event: serde_json::Value) -> Result<serde_json::Value, String> {
    let kind = get(&event, "type")?;
    if is_str(&kind, "global.disposed") || is_str(&kind, "server.connected") {
        return Ok(json!({ "type": "refresh" }));
    }
    if is_str(&kind, "project.updated") {
        return Ok(json!({ "type": "project", "project": prop(&event, "properties") }));
    }
    Ok(Value::Null)
}

/// Port of `applyGlobalProjectOf` (`event-reducer-mutation.ts:26`).
pub fn apply_global_project_of(state: serde_json::Value, project: serde_json::Value) -> Result<serde_json::Value, String> {
    let projects_raw = get(&state, "projects")?;
    let mut projects = spread_list(&projects_raw, "state.projects")?;
    let (found, index) = search(&Value::Array(projects.clone()), &get(&project, "id")?)?;
    if found {
        if let Some(slot) = at(&mut projects, index) {
            let mut merged = spread(slot);
            for (k, v) in spread(&project) {
                insert(&mut merged, k, v);
            }
            *slot = Value::Object(merged);
        }
    } else {
        let i = (index.max(0.0) as usize).min(projects.len());
        projects.insert(i, project);
    }
    let mut next = spread(&state);
    insert(&mut next, "projects".into(), Value::Array(projects));
    Ok(Value::Object(next))
}

/// Port of `applyDirectoryEventReturningDraft` (`event-reducer-mutation.ts:30`).
pub fn apply_directory_event_returning_draft(draft: serde_json::Value, event: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut draft = draft;
    let result = directory_event(&mut draft, &event)?;
    Ok(json!({ "result": result, "draft": draft }))
}
