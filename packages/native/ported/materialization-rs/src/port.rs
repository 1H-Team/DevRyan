//! The Rust port of `materialization.ts`, after the client engine's `families/materialization.rs`,
//! with what it imports from `revert-transactions`, `message-order`, `session-working`,
//! `tool-output`, `@/lib/toolStatus`, `@/lib/sessionDiffStats` and `nativeCursorText` inlined.
//!
//! Over JSON values, object identity is gone, but every `!==` the source tests is between a
//! value and what a helper returned: the helpers here say which value they returned (`Pick`,
//! `None` for "the same array"), and a part that came from `existing` keeps its index there, so
//! `leftPart.id !== rightPart.id` holds for the same object even when its id is an object.
//! Object keys keep JS order: integer-like keys first, ascending.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

type R<T> = Result<T, String>;

// ---- JS values over JSON ----

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

/// `value !== null && typeof value === "object" && !Array.isArray(value)`.
fn record(v: &Value) -> bool {
    plain(v).is_some() || set_items(v).is_some()
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

fn items<'a>(v: &'a Value, what: &str) -> R<&'a Vec<Value>> {
    match v {
        Value::Array(items) => Ok(items),
        _ if nullish(v) => Err(read_error(v, Some(what.rsplit('.').next().unwrap_or(what).into()))),
        _ => Err(format!("{what} is not a function")),
    }
}

/// `skipPartTypes.has(value)`.
fn skip_has(skip: &Value, value: &Value) -> R<bool> {
    match set_items(skip) {
        Some(set) => Ok(set.iter().any(|x| eq(x, value, true))),
        None => Err("skipPartTypes.has is not a function".into()), // recorded-literal: the V8 TypeError text
    }
}

// ---- message-order, revert-transactions ----

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

/// The value of `digits` in `radix`, as JS reads `0x`/`0o`/`0b` literals (no sign, any length).
fn radix_value(digits: &str, radix: u32) -> f64 {
    let mut n = 0.0;
    for c in digits.chars() {
        let Some(d) = c.to_digit(radix) else { return f64::NAN };
        n = n * f64::from(radix) + f64::from(d);
    }
    if digits.is_empty() { f64::NAN } else { n }
}

/// JS `ToNumber` of a string.
fn to_number(u: &[u16]) -> f64 {
    let text = String::from_utf16_lossy(u);
    let t = text.trim_matches(js_space);
    let radix = |p: &str, r| t.strip_prefix(p).map(|d| radix_value(d, r));
    if t.is_empty() {
        return 0.0;
    }
    if let Some(n) = radix("0x", 16)
        .or_else(|| radix("0X", 16))
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0O", 8))
    {
        return n;
    }
    if let Some(n) = radix("0b", 2).or_else(|| radix("0B", 2)) {
        return n;
    }
    match t.trim_start_matches(['+', '-']) {
        "Infinity" => return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY }, // recorded-literal: JS ToNumber keyword
        body if body.is_empty() || body.contains(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))) => return f64::NAN,
        _ => {}
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
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

fn compare_messages(left: &Value, right: &Value) -> f64 {
    let created = |m: &Value| num(&opt(&prop(m, "time"), "created")).filter(|n| n.is_finite()).unwrap_or(0.0);
    let delta = created(left) - created(right);
    if delta != 0.0 {
        return delta;
    }
    let (a, b) = (primitive(&prop(left, "id")), primitive(&prop(right, "id")));
    if less(&a, &b) {
        -1.0
    } else if less(&b, &a) {
        1.0
    } else {
        0.0
    }
}

/// `findMessageIndex(messages, id)`.
fn find_index(messages: &Value, id: &Value) -> R<Option<usize>> {
    for (index, message) in items(messages, "messages.findIndex")?.iter().enumerate() {
        if eq(&get(message, "id")?, id, false) {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

/// `filterMessagesForRevert(messages, revertID)`: `None` when it returns `messages` itself.
fn filter_for_revert(messages: &Value, revert: &Value) -> R<Option<Value>> {
    if !truthy(revert) {
        return Ok(None);
    }
    Ok(find_index(messages, revert)?.map(|i| Value::Array(messages.as_array().map(|m| m[..i].to_vec()).unwrap_or_default())))
}

fn effective_revert_id(state: &Value, session_id: &str) -> R<Value> {
    let transactions = get(state, "revert_transaction")?;
    let transaction = opt(&transactions, session_id);
    if truthy(&transaction) && !is_str(&prop(&transaction, "status"), "failed") {
        return Ok(prop(&transaction, "messageID"));
    }
    let sessions = prop(state, "session");
    let mut session = undef();
    if !nullish(&sessions) {
        let Value::Array(list) = &sessions else {
            return Err("state.session?.find is not a function".into()); // recorded-literal: the V8 TypeError text
        };
        for candidate in list {
            if is_str(&get(candidate, "id")?, session_id) {
                session = candidate.clone();
                break;
            }
        }
    }
    Ok(opt(&opt(&session, "revert"), "messageID"))
}

// ---- session-working, toolStatus, nativeCursorText ----

fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn lossy(v: &Value) -> Option<String> {
    units(v).map(|u| String::from_utf16_lossy(&u))
}

fn turn_complete(message: &Value) -> bool {
    if !truthy(message) || !is_str(&prop(message, "role"), "assistant") || prop(message, "streaming") == Value::Bool(true) {
        return false;
    }
    match lossy(&prop(message, "status")).map(|s| s.trim_matches(js_space).to_lowercase()).as_deref() {
        Some("running" | "pending" | "streaming") => return false,
        Some("complete" | "completed" | "done") => return true,
        _ => {}
    }
    let completed = num(&opt(&prop(message, "time"), "completed")).is_some_and(|c| c.is_finite() && c > 0.0);
    let finish = lossy(&prop(message, "finish")).map(|f| f.trim_matches(js_space).to_lowercase());
    completed || finish.is_some_and(|f| !f.is_empty() && f != "tool-calls")
}

/// `getToolLifecycleState(state)`: `(isInFlight, isFinalized)`.
fn lifecycle(state: &Value) -> (bool, bool) {
    let status = lossy(&opt(state, "status"))
        .map(|s| {
            s.to_lowercase()
                .trim_matches(js_space)
                .chars()
                .filter(|c| !js_space(*c) && *c != '_' && *c != '-')
                .collect::<String>()
        })
        .filter(|s| !s.is_empty());
    let time = opt(state, "time");
    let start = num(&opt(&time, "start")).filter(|n| n.is_finite());
    let end = num(&opt(&time, "end")).filter(|n| n.is_finite());
    let invalid = matches!((start, end), (Some(s), Some(e)) if e < s);
    let ended = end.is_some() && !invalid;
    let active = status
        .as_deref()
        .is_some_and(|s| ["pending", "running", "started", "inprogress", "processing", "executing"].contains(&s));
    let finals = [
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
    ];
    let fin = status.as_deref().is_some_and(|s| finals.contains(&s));
    let unknown = status.is_none() || (!active && !fin);
    (!ended && (active || unknown), !invalid && (ended || fin))
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

// ---- materialization ----

/// Which value a merge returned: one of its arguments, or a new one.
enum Pick {
    Next,
    Existing,
    New(Value),
}

fn completed_tool(part: &Value) -> bool {
    is_str(&opt(part, "type"), "tool") && is_str(&opt(&prop(part, "state"), "status"), "completed")
}

fn output_omitted(part: &Value) -> bool {
    let state = opt(part, "state");
    completed_tool(part) && plain(&state).is_some_and(|s| s.contains_key("outputOmitted")) && prop(&state, "outputOmitted") == Value::Bool(true)
}

/// `keepFullToolOutput(existing, next)`.
fn keep_full_tool_output(existing: &Value, next: &Value) -> Pick {
    if !output_omitted(next) || !completed_tool(existing) || output_omitted(existing) || !eq(&prop(existing, "id"), &prop(next, "id"), false) {
        return Pick::Next;
    }
    let mut state = spread(&prop(next, "state"));
    state.shift_remove("outputOmitted");
    state.shift_remove("outputBytes");
    let old = prop(existing, "state");
    insert(&mut state, "output".into(), prop(&old, "output"));
    insert(&mut state, "metadata".into(), prop(&old, "metadata"));
    let mut restored = spread(next);
    insert(&mut restored, "state".into(), Value::Object(state));
    let restored = Value::Object(restored);
    if stringify(&restored) == stringify(existing) {
        Pick::Existing
    } else {
        Pick::New(restored)
    }
}

fn part_end_time(part: &Value) -> Option<f64> {
    num(&opt(&opt(&prop(part, "state"), "time"), "end")).or_else(|| num(&opt(&prop(part, "time"), "end")))
}

const STREAMING_PART_FIELDS: [&str; 2] = ["text", "output"];

fn has_live_streaming_field(part: &Value) -> bool {
    part_end_time(part).is_none() && STREAMING_PART_FIELDS.iter().any(|f| units(&prop(part, f)).is_some_and(|u| !u.is_empty()))
}

fn merge_part(existing: &Value, next: &Value) -> R<Pick> {
    let kept = keep_full_tool_output(existing, next);
    if !matches!(kept, Pick::Next) {
        return Ok(kept);
    }
    if native_cursor(next)? || !truthy(existing) || part_end_time(next).is_some() {
        return Ok(Pick::Next);
    }
    if is_str(&prop(existing, "type"), "tool")
        && is_str(&prop(next, "type"), "tool")
        && lifecycle(&prop(existing, "state")).1
        && lifecycle(&prop(next, "state")).0
    {
        return Ok(Pick::Existing);
    }
    let mut merged: Option<Map<String, Value>> = None;
    for field in STREAMING_PART_FIELDS {
        let old = prop(existing, field);
        let Some(old_units) = units(&old).filter(|u| !u.is_empty()) else { continue };
        if let Some(new_units) = units(&prop(next, field))
            && (new_units.len() >= old_units.len() || (!new_units.is_empty() && !old_units.starts_with(&new_units)))
        {
            continue;
        }
        insert(merged.get_or_insert_with(|| spread(next)), field.into(), old);
    }
    Ok(merged.map_or(Pick::Next, |m| Pick::New(Value::Object(m))))
}

/// A part of the merged list, with its index in `existing` when it is that same object.
type Tracked = (Value, Option<usize>);

fn merge_parts(existing: &Value, next_parts: Vec<Value>, skip: &Value, preserve_live: bool) -> R<Vec<Tracked>> {
    let fresh = |parts: Vec<Value>| parts.into_iter().map(|p| (p, None)).collect();
    if !truthy(existing) || num(&prop(existing, "length")) == Some(0.0) || !preserve_live {
        return Ok(fresh(next_parts));
    }
    let old = items(existing, "existing.map")?;
    let mut by_id: Vec<(Value, usize)> = Vec::new();
    for (index, part) in old.iter().enumerate() {
        let id = get(part, "id")?;
        match by_id.iter_mut().find(|(k, _)| eq(k, &id, true)) {
            Some(slot) => slot.1 = index,
            None => by_id.push((id, index)),
        }
    }
    let mut merged = Vec::with_capacity(next_parts.len());
    for part in &next_parts {
        let id = prop(part, "id");
        let known = by_id.iter().find(|(k, _)| eq(k, &id, true)).map(|(_, i)| *i);
        let found = known.map_or_else(undef, |i| old[i].clone());
        merged.push(match merge_part(&found, part)? {
            Pick::Next => (part.clone(), None),
            Pick::Existing => (found, known),
            Pick::New(value) => (value, None),
        });
    }
    let snapshot_ids: Vec<Value> = next_parts.iter().map(|p| prop(p, "id")).collect();
    for (index, part) in old.iter().enumerate() {
        let id = opt(part, "id");
        if truthy(&id)
            && !snapshot_ids.iter().any(|s| eq(s, &id, true))
            && !skip_has(skip, &prop(part, "type"))?
            && !native_cursor(part)?
            && has_live_streaming_field(part)
        {
            merged.push((part.clone(), Some(index)));
        }
    }
    Ok(merged)
}

fn equivalent_part_snapshots(left: &Value, right: &[Tracked]) -> R<bool> {
    if !truthy(left) {
        return Ok(right.is_empty());
    }
    let left = items(left, "left")?;
    if left.len() != right.len() {
        return Ok(false);
    }
    for (index, (l, (r, origin))) in left.iter().zip(right).enumerate() {
        if !truthy(l) || !truthy(r) {
            return Ok(false);
        }
        let same = *origin == Some(index);
        let id = prop(l, "id");
        let same_id = if same {
            !(num(&id).is_some() || units(&id).is_some() || id.is_boolean() || nullish(&id)) || eq(&id, &id, false)
        } else {
            eq(&id, &prop(r, "id"), false)
        };
        if !same_id || (!same && stringify(l) != stringify(r)) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `mergeMaterializedMessages(existing, next)`: `None` when it returns `existing` itself.
fn merge_messages(existing: &Value, next: &[Value]) -> R<Option<Vec<Value>>> {
    if num(&prop(existing, "length")) == Some(0.0) {
        return Ok(Some(next.to_vec()));
    }
    if next.is_empty() {
        return Ok(None);
    }
    let mut merged: Vec<(Value, Value)> = Vec::new();
    for item in items(existing, "existing.map")? {
        let id = get(item, "id")?;
        match merged.iter_mut().find(|(k, _)| eq(k, &id, true)) {
            Some(slot) => slot.1 = item.clone(),
            None => merged.push((id, item.clone())),
        }
    }
    let mut changed = false;
    for message in next {
        let id = prop(message, "id");
        let Some(slot) = merged.iter_mut().find(|(k, _)| eq(k, &id, true)) else {
            merged.push((id, message.clone()));
            changed = true;
            continue;
        };
        let current = &slot.1;
        let keep =
            is_str(&prop(current, "role"), "assistant") && is_str(&prop(message, "role"), "assistant") && turn_complete(current) && !turn_complete(message);
        if keep || stringify(current) == stringify(message) {
            continue;
        }
        slot.1 = message.clone();
        changed = true;
    }
    if !changed {
        return Ok(None);
    }
    let mut values: Vec<Value> = merged.into_iter().map(|(_, v)| v).collect();
    js::sort(&mut values, compare_messages);
    Ok(Some(values))
}

/// `stripUntrustedSessionDiffSummary(target)`: `None` when it returns `target` itself.
fn strip_diff_summary(target: &Value) -> R<Option<Value>> {
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
    let mut copy = spread(target);
    if next.is_empty() {
        copy.shift_remove("summary");
    } else {
        insert(&mut copy, "summary".into(), Value::Object(next));
    }
    Ok(Some(Value::Object(copy)))
}

/// `state.message[sessionID] ?? []`, and whether it was the `[]`.
fn session_messages(state: &Value, session_id: &str) -> R<Value> {
    let found = get(&get(state, "message")?, session_id)?;
    Ok(if nullish(&found) { Value::Array(Vec::new()) } else { found })
}

/// Port of `materializeSessionSnapshots` (`materialization.ts:205`).
pub fn materialize_session_snapshots(
    state: serde_json::Value,
    session_id: String,
    records: serde_json::Value,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let options = if js::is_undefined(&options) { Value::Object(Map::new()) } else { options };
    let given_skip = get(&options, "skipPartTypes")?;
    let skip = if nullish(&given_skip) {
        serde_json::json!({ "$set": [] })
    } else {
        given_skip
    };
    let given_revert = get(&options, "revertMessageID")?;
    let revert = if nullish(&given_revert) {
        effective_revert_id(&state, &session_id)?
    } else {
        given_revert
    };
    let mut ordered: Vec<Value> = items(&records, "records.filter")?
        .iter()
        .filter(|r| truthy(&opt(&opt(r, "info"), "id")))
        .cloned()
        .collect();
    js::sort(&mut ordered, |a, b| compare_messages(&prop(a, "info"), &prop(b, "info")));
    let marker = if truthy(&revert) {
        ordered.iter().position(|r| eq(&prop(&prop(r, "info"), "id"), &revert, false))
    } else {
        None
    };
    let snapshots: Vec<Value> = match marker {
        None => ordered,
        Some(end) => {
            let visible: Vec<Value> = ordered[..end].iter().map(|r| prop(&prop(r, "info"), "id")).collect();
            ordered
                .into_iter()
                .enumerate()
                .filter(|(i, r)| *i < end || visible.iter().any(|v| eq(v, &prop(&prop(r, "info"), "id"), true)))
                .map(|(_, r)| r)
                .collect()
        }
    };
    let next_messages: Vec<Value> = snapshots.iter().map(|r| prop(r, "info")).collect();
    let raw = session_messages(&state, &session_id)?;
    let current = filter_for_revert(&raw, &revert)?;
    let current_is_raw = current.is_none();
    let current = current.unwrap_or_else(|| raw.clone());
    let merged = merge_messages(&current, &next_messages)?;
    let messages_changed = merged.is_some() || !current_is_raw;
    let messages = merged.map_or_else(|| current.clone(), Value::Array);

    let state_sessions = prop(&state, "session");
    let mut next_sessions = None;
    if truthy(&state_sessions) {
        let Value::Array(list) = &state_sessions else {
            return Err("state.session.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
        };
        let mut found = None;
        for (index, session) in list.iter().enumerate() {
            if is_str(&get(session, "id")?, &session_id) {
                found = Some(index);
                break;
            }
        }
        if let Some(index) = found
            && let Some(session) = strip_diff_summary(&list[index])?
        {
            let mut copy = list.clone();
            copy[index] = session;
            next_sessions = Some(Value::Array(copy));
        }
    }

    let state_part = prop(&state, "part");
    let mut parts = spread(&state_part);
    let mut parts_changed = false;
    let prepend = is_str(&prop(&options, "mode"), "prepend");
    if truthy(&revert)
        && let Some(start) = find_index(&raw, &revert)?
    {
        for message in &raw.as_array().cloned().unwrap_or_default()[start..] {
            let key = key_of(&get(message, "id")?);
            if parts.shift_remove(&key).is_some() {
                parts_changed = true;
            }
        }
    }
    for snapshot in &snapshots {
        let info = prop(snapshot, "info");
        let message_id = prop(&info, "id");
        let key = key_of(&message_id);
        if prepend && parts.get(&key).is_some_and(truthy) {
            continue;
        }
        let user = is_str(&prop(&info, "role"), "user");
        let record_parts = prop(snapshot, "parts");
        let parts_is_array = record_parts.is_array();
        if user && !parts_is_array {
            continue;
        }
        let existing = parts.get(&key).cloned().unwrap_or_else(undef);
        if !nullish(&existing) {
            let Value::Array(list) = &existing else {
                return Err("existing?.some is not a function".into()); // recorded-literal: the V8 TypeError text
            };
            let mut native = false;
            for part in list {
                if native_cursor(part)? {
                    native = true;
                    break;
                }
            }
            if native
                && !turn_complete(&info)
                && let Some(previous) = find_index(&current, &message_id)?
                && turn_complete(&current.as_array().map_or_else(undef, |m| m[previous].clone()))
            {
                continue;
            }
        }
        let source = if nullish(&record_parts) { Value::Array(Vec::new()) } else { record_parts };
        let mut renderable = Vec::new();
        for part in items(&source, "parts.filter")? {
            if truthy(&opt(part, "id")) && !skip_has(&skip, &prop(part, "type"))? {
                renderable.push(part.clone());
            }
        }
        let next_parts = merge_parts(&existing, renderable, &skip, is_str(&prop(&info, "role"), "assistant"))?;
        let known_empty_user_parts = user && parts_is_array && js::is_undefined(&existing) && next_parts.is_empty();
        if equivalent_part_snapshots(&existing, &next_parts)? && !known_empty_user_parts {
            continue;
        }
        if next_parts.is_empty() && !user {
            parts.shift_remove(&key);
        } else {
            insert(&mut parts, key, Value::Array(next_parts.into_iter().map(|(p, _)| p).collect()));
        }
        parts_changed = true;
    }

    let state_message = prop(&state, "message");
    let message_member = if messages_changed {
        let mut copy = spread(&state_message);
        insert(&mut copy, session_id, messages.clone());
        Value::Object(copy)
    } else {
        state_message
    };
    let sessions_changed = next_sessions.is_some();
    let mut out = Map::new();
    out.insert("session".into(), next_sessions.unwrap_or(state_sessions));
    out.insert("message".into(), message_member);
    out.insert("part".into(), if parts_changed { Value::Object(parts) } else { state_part });
    out.insert("messages".into(), messages);
    out.insert("sessionsChanged".into(), Value::Bool(sessions_changed));
    out.insert("messagesChanged".into(), Value::Bool(messages_changed));
    out.insert("partsChanged".into(), Value::Bool(parts_changed));
    Ok(Value::Object(out))
}

/// Port of `getSessionMaterializationStatus` (`materialization.ts:298`).
pub fn get_session_materialization_status(state: serde_json::Value, session_id: String) -> Result<serde_json::Value, String> {
    let raw = session_messages(&state, &session_id)?;
    let revert = effective_revert_id(&state, &session_id)?;
    let messages = filter_for_revert(&raw, &revert)?.unwrap_or(raw);
    let holder = prop(&state, "message");
    let own = match (&holder, units(&holder)) {
        (_, Some(u)) => session_id == "length" || index_key(&session_id).is_some_and(|i| (i as usize) < u.len()),
        (Value::Array(list), _) => session_id == "length" || index_key(&session_id).is_some_and(|i| (i as usize) < list.len()),
        _ => plain(&holder).is_some_and(|o| o.contains_key(&session_id)),
    };
    let status = |has: bool, renderable: bool, missing: Vec<Value>| serde_json::json!({ "hasMessages": has, "renderable": renderable, "missingPartMessageIDs": missing });
    if !own {
        return Ok(status(false, false, Vec::new()));
    }
    let list = match &messages {
        Value::Array(list) => list.clone(),
        _ if units(&messages).is_some() => Vec::new(),
        _ => return Err("messages is not iterable".into()), // recorded-literal: the V8 TypeError text
    };
    let mut missing = Vec::new();
    for message in &list {
        if !is_str(&get(message, "role")?, "assistant") {
            continue;
        }
        let id = prop(message, "id");
        let parts = get_by(&prop(&state, "part"), &id)?;
        if !truthy(&parts) || num(&prop(&parts, "length")) == Some(0.0) {
            missing.push(id);
        }
    }
    Ok(status(true, missing.is_empty(), missing))
}
