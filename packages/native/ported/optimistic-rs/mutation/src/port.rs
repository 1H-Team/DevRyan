//! The Rust port of the test wrapper `mutation-ts/optimistic-mutation.ts`: `applyOptimisticAdd`
//! and `applyOptimisticRemove` of `optimistic.ts`, returning the mutated draft. The
//! `message-order` helpers are inlined; ids compare with full JS `<` and `===`.

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

// ---- the unit ----

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

/// `findMessageIndex(messages, id)`.
fn find_index(messages: &Value, id: &Value) -> R<Option<usize>> {
    let Value::Array(list) = messages else {
        return Err("messages.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for (index, message) in list.iter().enumerate() {
        if eq(&get(message, "id")?, id, false) {
            return Ok(Some(index));
        }
    }
    Ok(None)
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

/// `filterRenderableParts(parts)`.
fn renderable(parts: &Value) -> R<Value> {
    let Value::Array(list) = parts else {
        get(parts, "filter")?;
        return Err("parts.filter is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    Ok(Value::Array(list.iter().filter(|p| truthy(&opt(p, "id"))).cloned().collect()))
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

/// Port of `applyOptimisticAddReturningDraft` (`optimistic-mutation.ts:11`).
pub fn apply_optimistic_add_returning_draft(draft: serde_json::Value, input: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut draft = draft;
    let session_id = get(&input, "sessionID")?;
    let messages = get_by(&get(&draft, "message")?, &session_id)?;
    let message = get(&input, "message")?;
    if truthy(&messages) {
        let id = get(&message, "id")?;
        if find_index(&messages, &id)?.is_none() {
            let inserted = insert_chronologically(messages.as_array().map_or(&[], Vec::as_slice), &message)?;
            put(&mut draft, "message", &session_id, Value::Array(inserted))?;
        }
    } else {
        put(&mut draft, "message", &session_id, Value::Array(vec![message.clone()]))?;
    }
    let part_holder = get(&draft, "part")?;
    let id = get(&message, "id")?;
    let parts = renderable(&get(&input, "parts")?)?;
    if nullish(&part_holder) {
        let kind = if part_holder.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot set properties of {kind} (setting '{}')", key_of(&id)));
    }
    put(&mut draft, "part", &id, parts)?;
    Ok(draft)
}

/// Port of `applyOptimisticRemoveReturningDraft` (`optimistic-mutation.ts:16`).
pub fn apply_optimistic_remove_returning_draft(draft: serde_json::Value, input: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut draft = draft;
    let session_id = get(&input, "sessionID")?;
    let messages = get_by(&get(&draft, "message")?, &session_id)?;
    if truthy(&messages)
        && let Some(index) = find_index(&messages, &get(&input, "messageID")?)?
    {
        let mut list = messages.as_array().cloned().unwrap_or_default();
        list.remove(index);
        put(&mut draft, "message", &session_id, Value::Array(list))?;
    }
    let message_id = get(&input, "messageID")?;
    let part_holder = get(&draft, "part")?;
    if nullish(&part_holder) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    if let Some(Value::Object(map)) = draft.as_object_mut().and_then(|d| d.get_mut("part")).filter(|h| plain(h).is_some()) {
        map.shift_remove(&key_of(&message_id));
    }
    Ok(draft)
}
