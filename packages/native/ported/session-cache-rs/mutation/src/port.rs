//! The Rust port of the test wrapper `mutation-ts/session-cache-mutation.ts`: `dropSessionCaches`
//! (returns the mutated store) and `pickSessionCacheEvictions` (on a `Set` built from `seen`,
//! returned with the result) of `session-cache.ts`. `delete` keeps the other keys' order.

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

// ---- the unit ----

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

/// `delete store[field][key]`.
fn delete(store: &mut Value, field: &str, key: &str) -> R<()> {
    let holder = prop(store, field);
    if nullish(&holder) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    if let Some(u) = units(&holder) {
        if index_key(key).is_some_and(|i| (i as usize) < u.len()) {
            return Err(format!("Cannot delete property '{key}' of [object String]"));
        }
        return Ok(());
    }
    if let Some(Value::Object(map)) = store.as_object_mut().and_then(|s| s.get_mut(field)) {
        map.shift_remove(key);
    }
    Ok(())
}

/// `for (const item of value ?? [])`.
fn iterate(value: &Value, name: &str) -> R<Vec<Value>> {
    if nullish(value) {
        return Ok(Vec::new());
    }
    if matches!(value, Value::Array(_)) || set_items(value).is_some() || units(value).is_some() {
        return Ok(array_from(value));
    }
    Err(format!("{name} is not iterable"))
}

/// Port of `dropSessionCachesReturningStore` (`session-cache-mutation.ts:17`).
pub fn drop_session_caches_returning_store(store: serde_json::Value, session_i_ds: serde_json::Value) -> Result<serde_json::Value, String> {
    if nullish(&session_i_ds) {
        let shown = if session_i_ds.is_null() { "object null" } else { "undefined" };
        return Err(format!("{shown} is not iterable (cannot read property Symbol(Symbol.iterator))"));
    }
    let stale = unique(array_from(&session_i_ds).into_iter().filter(truthy).collect());
    if stale.is_empty() {
        return Ok(store);
    }
    let mut store = store;
    let mut stale_messages: Vec<Value> = Vec::new();
    for session_id in &stale {
        let messages = opt(&get(&store, "message")?, &key_of(session_id));
        for message in iterate(&messages, "store.message?.[sessionID] ?? []")? {
            let id = opt(&message, "id");
            if truthy(&id) && !has(&stale_messages, &id) {
                stale_messages.push(id);
            }
        }
    }
    let part_keys = keys(&prop(&store, "part"));
    for key in part_keys {
        if has(&stale_messages, &Value::String(key.clone())) {
            delete(&mut store, "part", &key)?;
            continue;
        }
        let parts = prop(&prop(&store, "part"), &key);
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
            delete(&mut store, "part", &key)?;
        }
    }
    for session_id in &stale {
        let key = key_of(session_id);
        for field in ["message", "todo", "session_diff", "session_status", "permission", "question"] {
            delete(&mut store, field, &key)?;
        }
    }
    Ok(store)
}

/// Port of `pickSessionCacheEvictionsReturningSeen` (`session-cache-mutation.ts:22`).
pub fn pick_session_cache_evictions_returning_seen(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let seen_raw = get(&input, "seen")?;
    let mut seen = if nullish(&seen_raw) {
        Vec::new()
    } else {
        unique(iterate(&seen_raw, "input.seen")?)
    };
    let keep_id = prop(&input, "keep");
    let preserve = prop(&input, "preserve");
    let mut keep = vec![keep_id.clone()];
    if !nullish(&preserve) {
        keep.extend(array_from(&preserve));
    }
    let keep = unique(keep);
    seen.retain(|v| !eq(v, &keep_id, true));
    seen.push(keep_id);
    let limit = match primitive(&prop(&input, "limit")) {
        Prim::Num(n) => n,
        Prim::Text(u) => to_number(&u),
    };
    let mut stale: Vec<Value> = Vec::new();
    for id in &seen {
        if (seen.len() - stale.len()) as f64 <= limit {
            break;
        }
        if has(&keep, id) {
            continue;
        }
        stale.push(id.clone());
    }
    seen.retain(|v| !has(&stale, v));
    Ok(serde_json::json!({ "result": stale, "seen": seen }))
}
