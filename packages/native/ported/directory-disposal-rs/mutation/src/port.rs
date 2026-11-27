//! The Rust port of the test wrapper `mutation-ts/directory-disposal-mutation.ts`: the
//! collection-mutating exports of `directory-disposal.ts` on `Map`s and `Set`s built from entries
//! (insertion order, SameValueZero keys), returning the entries with the result. `clearTimeout`
//! of a received `retryTimer` has no effect to port (no timer crosses JSON).
//! `createRestartSafeOwnershipCleanup` (callbacks) stays in TypeScript.

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

// ---- the unit ----

type Entries = Vec<(Value, Value)>;

/// The values `for...of` (and so `new Map` / `new Set`) walks.
fn iterate(value: &Value) -> R<Vec<Value>> {
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
        _ => Err("object is not iterable (cannot read property Symbol(Symbol.iterator))".into()), // recorded-literal: the V8 TypeError text
    }
}

fn find(entries: &Entries, key: &Value) -> Option<usize> {
    entries.iter().position(|(k, _)| eq(k, key, true))
}

fn set(entries: &mut Entries, key: Value, value: Value) {
    match find(entries, &key) {
        Some(at) => entries[at].1 = value,
        None => entries.push((key, value)),
    }
}

fn remove(entries: &mut Entries, key: &Value) {
    if let Some(at) = find(entries, key) {
        entries.remove(at);
    }
}

/// `new Map(entries)`.
fn map_of(entries: &Value) -> R<Entries> {
    let mut out = Vec::new();
    if nullish(entries) {
        return Ok(out);
    }
    for entry in iterate(entries)? {
        if !matches!(entry, Value::Array(_)) && plain(&entry).is_none() && set_items(&entry).is_none() {
            return Err(format!("Iterator value {} is not an entry object", key_of(&entry)));
        }
        set(&mut out, prop(&entry, "0"), prop(&entry, "1"));
    }
    Ok(out)
}

/// `new Set(values)`.
fn set_of(values: &Value) -> R<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    if nullish(values) {
        return Ok(out);
    }
    for value in iterate(values)? {
        if !out.iter().any(|v| eq(v, &value, true)) {
            out.push(value);
        }
    }
    Ok(out)
}

fn pairs(entries: Entries) -> Value {
    Value::Array(entries.into_iter().map(|(k, v)| Value::Array(vec![k, v])).collect())
}

/// `Object.keys(value)`.
fn keys(value: &Value) -> R<Vec<Value>> {
    if nullish(value) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    if let Some(u) = units(value) {
        return Ok((0..u.len()).map(|i| Value::String(i.to_string())).collect());
    }
    Ok(match value {
        Value::Array(items) => (0..items.len()).map(|i| Value::String(i.to_string())).collect(),
        _ => plain(value).map(|o| o.keys().map(|k| Value::String(k.clone())).collect()).unwrap_or_default(),
    })
}

/// Port of `releaseDirectoryRoutingIndexReturningIndex` (`directory-disposal-mutation.ts:18`).
pub fn release_directory_routing_index_returning_index(
    index: serde_json::Value,
    directory: String,
    snapshot: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut by_session = map_of(&get(&index, "sessionDirectoryById")?)?;
    let mut by_message = map_of(&get(&index, "messageSessionById")?)?;
    let raw_ids = get(&index, "sessionMessageIdsById")?;
    let Value::Array(raw_ids) = &raw_ids else {
        get(&raw_ids, "map")?;
        return Err("index.sessionMessageIdsById.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut converted = Vec::with_capacity(raw_ids.len());
    for entry in raw_ids {
        let ids = set_of(&get_by(entry, &js::number(1.0))?)?;
        converted.push(Value::Array(vec![get_by(entry, &js::number(0.0))?, serde_json::json!({ "$set": ids })]));
    }
    let mut message_ids = map_of(&Value::Array(converted))?;
    let sessions = get(&snapshot, "session")?;
    let Value::Array(sessions) = &sessions else {
        get(&sessions, "map")?;
        return Err("snapshot.session.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut ids = Vec::new();
    for session in sessions {
        ids.push(get(session, "id")?);
    }
    ids.extend(keys(&get(&snapshot, "message")?)?);
    let mut session_ids = set_of(&Value::Array(ids))?;
    let target = Value::String(directory);
    for (session_id, indexed) in &by_session {
        if eq(indexed, &target, false) && !session_ids.iter().any(|s| eq(s, session_id, true)) {
            session_ids.push(session_id.clone());
        }
    }
    for session_id in &session_ids {
        remove(&mut by_session, session_id);
        if let Some(at) = find(&message_ids, session_id).filter(|at| truthy(&message_ids[*at].1)) {
            for message_id in iterate(&message_ids[at].1)? {
                remove(&mut by_message, &message_id);
            }
        }
        remove(&mut message_ids, session_id);
    }
    for message_id in keys(&get(&snapshot, "part")?)? {
        remove(&mut by_message, &message_id);
    }
    let ids_out = message_ids
        .into_iter()
        .map(|(k, v)| Value::Array(vec![k, Value::Array(set_items(&v).cloned().unwrap_or_default())]));
    Ok(serde_json::json!({
        "result": session_ids,
        "index": {
            "sessionDirectoryById": pairs(by_session),
            "messageSessionById": pairs(by_message),
            "sessionMessageIdsById": Value::Array(ids_out.collect()),
        },
    }))
}

/// Port of `clearDirectoryMaterializationsReturningPending` (`directory-disposal-mutation.ts:35`).
pub fn clear_directory_materializations_returning_pending(entries: serde_json::Value, directory: String) -> Result<serde_json::Value, String> {
    let pending = map_of(&entries)?;
    let target = Value::String(directory);
    let mut kept = Vec::with_capacity(pending.len());
    let mut cleared = 0.0;
    for (key, entry) in pending {
        if !eq(&get(&entry, "directory")?, &target, false) {
            kept.push((key, entry));
            continue;
        }
        cleared += 1.0;
    }
    Ok(serde_json::json!({ "result": js::number(cleared), "pending": pairs(kept) }))
}

/// `clearDirectoryPrefixedEntries(collection, directory, separator)` over the keys.
fn clear_prefixed(keys: &[Value], directory: &str, separator: &Value) -> R<Vec<bool>> {
    let separator = if js::is_undefined(separator) {
        Value::String("\n".into())
    } else {
        separator.clone()
    };
    let mut prefix: Vec<u16> = directory.encode_utf16().collect();
    prefix.extend(units(&separator).unwrap_or_else(|| key_of(&separator).encode_utf16().collect()));
    let mut hits = Vec::with_capacity(keys.len());
    for key in keys {
        let Some(k) = units(key) else {
            return Err(if nullish(key) {
                read_error(key, Some("startsWith".into()))
            } else {
                "key.startsWith is not a function".into()
            }); // recorded-literal: the V8 TypeError text
        };
        hits.push(k.starts_with(&prefix));
    }
    Ok(hits)
}

/// Port of `clearDirectoryPrefixedMapEntriesReturningMap` (`directory-disposal-mutation.ts:41`).
pub fn clear_directory_prefixed_map_entries_returning_map(
    entries: serde_json::Value,
    directory: String,
    separator: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let collection = map_of(&entries)?;
    let hits = clear_prefixed(&collection.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(), &directory, &separator)?;
    let cleared = hits.iter().filter(|h| **h).count() as f64;
    let kept: Entries = collection.into_iter().zip(hits).filter(|(_, h)| !h).map(|(e, _)| e).collect();
    Ok(serde_json::json!({ "result": js::number(cleared), "entries": pairs(kept) }))
}

/// Port of `clearDirectoryPrefixedSetEntriesReturningSet` (`directory-disposal-mutation.ts:47`).
pub fn clear_directory_prefixed_set_entries_returning_set(
    values: serde_json::Value,
    directory: String,
    separator: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let collection = set_of(&values)?;
    let hits = clear_prefixed(&collection, &directory, &separator)?;
    let cleared = hits.iter().filter(|h| **h).count() as f64;
    let kept: Vec<Value> = collection.into_iter().zip(hits).filter(|(_, h)| !h).map(|(v, _)| v).collect();
    Ok(serde_json::json!({ "result": js::number(cleared), "values": kept }))
}
