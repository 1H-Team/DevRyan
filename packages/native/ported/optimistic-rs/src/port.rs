//! The Rust port of `mergeOptimisticPage` (`optimistic.ts`), after the client engine's
//! `families/optimistic.rs`, with the `message-order.ts` helpers it calls. `applyOptimisticAdd`
//! and `applyOptimisticRemove` stay in TypeScript: they only mutate their draft, which recording
//! does not capture. Ids compare with `===` / SameValueZero (objects never equal).

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// `value[key]` (raw, `undefined` as `None`), failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

fn raw(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or_else(js::undefined)
}

/// The SameValueZero key of a value (`None` for objects: equal to nothing).
fn key(value: Option<&Value>) -> Option<String> {
    match value {
        None => Some("u".to_string()),
        Some(v) if js::is_undefined(v) => Some("u".to_string()),
        Some(Value::String(s)) => Some(format!("s{s}")),
        Some(v) => match js::as_number(v) {
            Some(n) if n.is_nan() => Some("NaN".to_string()),
            Some(n) => Some(format!("n{}", js::number_to_string(n))),
            None if matches!(v, Value::Object(_) | Value::Array(_)) => js::string_units(v).map(|u| format!("s{}", String::from_utf16_lossy(&u))),
            None => Some(v.to_string()),
        },
    }
}

/// `===` (NaN is never equal; SameValueZero makes it equal for `Map`/`Set`).
fn strict(a: Option<&Value>, b: Option<&Value>) -> bool {
    matches!((key(a), key(b)), (Some(x), Some(y)) if x == y && x != "NaN")
}

/// `[...value]` / `for...of`.
fn iterate(value: Option<&Value>, name: &str) -> Result<Vec<Value>, String> {
    match value {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        _ => Err(format!("{name} is not iterable")),
    }
}

/// `parts.filter((part) => !!part?.id)`.
fn renderable(parts: Option<&Value>, name: &str) -> Result<Vec<Value>, String> {
    let Some(Value::Array(items)) = parts else {
        get(&raw(parts), "filter")?;
        return Err(format!("{name}.filter is not a function"));
    };
    let truthy = |v: &Value| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    };
    Ok(items.iter().filter(|p| !nullish(p) && p.get("id").is_some_and(truthy)).cloned().collect())
}

fn created_at(message: &Value) -> Result<f64, String> {
    let created = get(message, "time")?
        .and_then(|t| t.get("created"))
        .filter(|v| v.is_number() || v.get("$num").is_some());
    Ok(created.and_then(js::as_number).filter(|n| n.is_finite()).unwrap_or(0.0))
}

/// `compareMessagesChronologically`; ids by `<` on strings (other ids compare equal, as `<` on
/// two non-numeric values that are not both strings is false both ways).
fn compare(left: &Value, right: &Value) -> Result<f64, String> {
    let delta = created_at(left)? - created_at(right)?;
    if delta != 0.0 {
        return Ok(delta);
    }
    let units = |v: Option<&Value>| v.and_then(js::string_units);
    Ok(match (units(get(left, "id")?), units(get(right, "id")?)) {
        (Some(a), Some(b)) if a < b => -1.0,
        (Some(a), Some(b)) if a > b => 1.0,
        _ => 0.0,
    })
}

fn find_index(session: &[Value], id: Option<&Value>) -> Result<Option<usize>, String> {
    for (index, message) in session.iter().enumerate() {
        if strict(get(message, "id")?, id) {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

fn merge_parts(parts: Option<&Value>, want: Option<&Value>) -> Result<Value, String> {
    let Some(parts) = parts.filter(|p| !p.is_null() && p.as_bool() != Some(false)) else {
        return renderable(want, "parts").map(Value::Array);
    };
    let mut next = iterate(Some(parts), "parts")?;
    let mut ids: Vec<Option<String>> = Vec::new();
    for part in &next {
        ids.push(key(get(part, "id")?));
    }
    let mut changed = false;
    for part in iterate(want, "want")? {
        let id = key(get(&part, "id")?);
        if id.is_some() && ids.contains(&id) {
            continue;
        }
        ids.push(id);
        next.push(part);
        changed = true;
    }
    Ok(if changed { Value::Array(next) } else { parts.clone() })
}

/// Port of `mergeOptimisticPage` (`optimistic.ts:54`).
pub fn merge_optimistic_page(page: Value, items: Value) -> Result<Value, String> {
    let length = match &items {
        Value::Array(list) => Some(list.len() as f64),
        Value::String(text) => Some(text.encode_utf16().count() as f64),
        other => get(other, "length")?.and_then(js::as_number),
    };
    if length == Some(0.0) {
        // `{ ...page }`: own enumerable keys, array and string indexes included.
        let mut copy: Map<String, Value> = match &page {
            Value::Array(list) => list.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
            Value::String(text) => text.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), js::utf16_string(&[u]))).collect(),
            Value::Object(map) if js::string_units(&page).is_none() && js::as_number(&page).is_none() && !js::is_undefined(&page) => map.clone(),
            _ => Map::new(),
        };
        copy.insert("confirmed".to_string(), json!([]));
        return Ok(Value::Object(copy));
    }
    let mut session = iterate(get(&page, "session")?, "page.session")?;
    let page_part = get(&page, "part")?;
    let Some(Value::Array(entries)) = page_part else {
        get(&raw(page_part), "map")?;
        return Err("page.part.map is not a function".to_string());
    };
    let mut part: Vec<(Option<String>, Value)> = Vec::new();
    let set = |part: &mut Vec<(Option<String>, Value)>, id: Option<String>, value: Value| match part.iter_mut().find(|(k, _)| k.is_some() && *k == id) {
        Some(slot) => slot.1 = value,
        None => part.push((id, value)),
    };
    for entry in entries {
        let id = key(get(entry, "id")?);
        let parts = renderable(get(entry, "part")?, "parts")?;
        set(&mut part, id, Value::Array(parts));
    }
    let mut confirmed = Vec::new();
    for item in iterate(Some(&items), "items")? {
        let message = raw(get(&item, "message")?);
        let id = get(&message, "id")?;
        if find_index(&session, id)?.is_some() {
            confirmed.push(raw(id));
            continue;
        }
        let (mut low, mut high) = (0, session.len());
        while low < high {
            let middle = (low + high) >> 1;
            if compare(&session[middle], &message)? <= 0.0 {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        let message_key = key(id);
        session.insert(low, message.clone());
        let current = part.iter().find(|(k, _)| k.is_some() && *k == message_key).map(|(_, v)| v.clone());
        let merged = merge_parts(current.as_ref(), get(&item, "parts")?)?;
        set(&mut part, message_key, merged);
    }
    let mut pages = Vec::new();
    for message in &session {
        let id = get(message, "id")?;
        let found = key(id).and_then(|k| part.iter().find(|(p, _)| p.as_deref() == Some(k.as_str())).map(|(_, v)| v.clone()));
        if let Some(parts) = found.filter(|v| !v.is_null() && v.as_bool() != Some(false)) {
            pages.push(json!({ "id": raw(id), "part": parts }));
        }
    }
    let mut out = Map::new();
    out.insert("cursor".to_string(), raw(page.get("cursor")));
    out.insert("complete".to_string(), raw(page.get("complete")));
    out.insert("session".to_string(), Value::Array(session));
    out.insert("part".to_string(), Value::Array(pages));
    out.insert("confirmed".to_string(), Value::Array(confirmed));
    Ok(Value::Object(out))
}
