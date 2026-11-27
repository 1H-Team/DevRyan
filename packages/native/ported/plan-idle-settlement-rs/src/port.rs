//! The Rust port of `plan-idle-settlement.ts`, with what it uses of `revert-transactions`,
//! `message-order`, `session-working` and `@/lib/toolStatus` inlined (helpers after the
//! `materialization-rs` port). Values that are not arrays keep JS semantics: a string iterates
//! by code point, `length` and indexes go through `ToNumber`/`ToString`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

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

// ---- JS comparison ----

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

// ---- session-working, toolStatus ----

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

// ---- the unit ----

fn to_num(v: &Value) -> f64 {
    match primitive(v) {
        Prim::Num(n) => n,
        Prim::Text(u) => to_number(&u),
    }
}

/// `(x?.length ?? 0) > 0`.
fn has_items(x: &Value) -> bool {
    let length = opt(x, "length");
    !nullish(&length) && less(&Prim::Num(0.0), &primitive(&length))
}

/// `for (const item of value ?? [])`.
fn iterate(value: &Value) -> R<Vec<Value>> {
    if nullish(value) {
        return Ok(Vec::new());
    }
    if let Some(set) = set_items(value) {
        return Ok(set.clone());
    }
    if let Some(u) = units(value) {
        return Ok(char::decode_utf16(u.iter().copied())
            .map(|c| match c {
                Ok(c) => Value::String(c.to_string()),
                Err(e) => js::utf16_string(&[e.unpaired_surrogate()]),
            })
            .collect());
    }
    match value {
        Value::Array(items) => Ok(items.clone()),
        _ => Err("(parts ?? []) is not iterable".into()), // recorded-literal: the V8 TypeError text
    }
}

fn trimmed_text(v: &Value) -> bool {
    lossy(v).is_some_and(|t| !t.trim_matches(js_space).is_empty())
}

fn final_summary(message: &Value, parts: &Value) -> R<bool> {
    let finish = lossy(&prop(message, "finish")).map(|f| f.trim_matches(js_space).to_lowercase());
    if !turn_complete(message) || finish.as_deref() == Some("tool-calls") {
        return Ok(false);
    }
    let parts = iterate(parts)?;
    for part in &parts {
        if is_str(&get(part, "type")?, "tool") && lifecycle(&prop(part, "state")).0 {
            return Ok(false);
        }
    }
    for part in &parts {
        let kind = get(part, "type")?;
        if (is_str(&kind, "text") || is_str(&kind, "reasoning")) && (trimmed_text(&prop(part, "text")) || trimmed_text(&prop(part, "output"))) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn effective_revert_id(state: &Value, session_id: &Value) -> R<Value> {
    let transaction = opt(&prop(state, "revert_transaction"), &key_of(session_id));
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
            if eq(&get(candidate, "id")?, session_id, false) {
                session = candidate.clone();
                break;
            }
        }
    }
    Ok(opt(&opt(&session, "revert"), "messageID"))
}

/// `filterMessagesForRevert(messages, revertID)`.
fn filter_for_revert(messages: Value, revert: &Value) -> R<Value> {
    if !truthy(revert) {
        return Ok(messages);
    }
    let Value::Array(list) = &messages else {
        return Err("messages.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for (index, message) in list.iter().enumerate() {
        if eq(&get(message, "id")?, revert, false) {
            return Ok(Value::Array(list[..index].to_vec()));
        }
    }
    Ok(messages)
}

/// Port of `isSessionTurnSettledForCompletion` (`plan-idle-settlement.ts:10`).
pub fn is_session_turn_settled_for_completion(arg0: serde_json::Value) -> Result<bool, String> {
    if nullish(&arg0) {
        let (shown, kind) = if arg0.is_null() {
            ("object null", "null")
        } else {
            ("undefined", "undefined")
        };
        return Err(format!("Cannot destructure property 'sessionID' of '{shown}' as it is {kind}."));
    }
    let (session_id, state, completed) = (prop(&arg0, "sessionID"), prop(&arg0, "state"), prop(&arg0, "completedMessageId"));
    let status = get_by(&get(&state, "session_status")?, &session_id)?;
    if !is_str(&opt(&status, "type"), "idle") {
        return Ok(false);
    }
    if has_items(&get_by(&get(&state, "permission")?, &session_id)?) || has_items(&get_by(&get(&state, "question")?, &session_id)?) {
        return Ok(false);
    }
    let raw = get_by(&get(&state, "message")?, &session_id)?;
    if !truthy(&raw) || eq(&prop(&raw, "length"), &js::number(0.0), false) {
        return Ok(false);
    }
    let revert = effective_revert_id(&state, &session_id)?;
    let messages = filter_for_revert(raw, &revert)?;
    let last = to_num(&prop(&messages, "length")) - 1.0;
    let trailing = prop(&messages, &js::number_to_string(last));
    if !truthy(&trailing) || !eq(&prop(&trailing, "id"), &completed, false) || !is_str(&prop(&trailing, "role"), "assistant") {
        return Ok(false);
    }
    if truthy(&prop(&trailing, "error")) {
        return Ok(false);
    }
    let parts = get_by(&get(&state, "part")?, &completed)?;
    final_summary(&trailing, &parts)
}
