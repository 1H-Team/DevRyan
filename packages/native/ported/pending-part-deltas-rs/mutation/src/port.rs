//! The Rust port of the test wrapper `mutation-ts/pending-part-deltas-mutation.ts`: the
//! store-mutating exports of `pending-part-deltas.ts` on a `Map` built from the given entries,
//! returning the store's entries with the result. Map order is insertion order; a `set` of an
//! existing key keeps its place. The overflow prune sorts as V8 does (`js::sort`).

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

type R<T> = Result<T, String>;

// ---- part-delta ----

type Units = Vec<u16>;

const MIN_FULL_FRAME_DUPLICATE_LENGTH: usize = 32;
const MAX_JAMMED_DUPLICATE_SCAN_LENGTH: usize = 2_048;

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

/// `value.lastIndexOf(unit, from)`.
fn last_unit(hay: &[u16], unit: u16, from: usize) -> Option<usize> {
    hay.get(..=from.min(hay.len().checked_sub(1)?))?.iter().rposition(|x| *x == unit)
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

fn output_delta(existing: Units, delta: &[u16]) -> Units {
    if delta.is_empty() || full_frame_replay(&existing, delta) {
        existing
    } else {
        [existing.as_slice(), delta].concat()
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

// ---- the unit ----

const PENDING_TTL: f64 = 30_000.0;
const MAX_PENDING: usize = 500;
const HINT_TTL: f64 = 300_000.0;
const MAX_HINTS: usize = 500;

type Store = Vec<(Value, Value)>;

/// `new Map(entries)`.
fn store_of(entries: &Value) -> R<Store> {
    if nullish(entries) {
        return Ok(Vec::new());
    }
    let list: Vec<Value> = match entries {
        Value::Array(items) => items.clone(),
        _ if units(entries).is_some() => units(entries).unwrap_or_default().iter().map(|c| js::utf16_string(&[*c])).collect(),
        _ if set_items(entries).is_some() => set_items(entries).cloned().unwrap_or_default(),
        _ if num(entries).is_some() || entries.is_boolean() => {
            let kind = if entries.is_boolean() { "boolean" } else { "number" };
            return Err(format!(
                "{kind} {} is not iterable (cannot read property Symbol(Symbol.iterator))",
                key_of(entries)
            ));
        }
        _ => return Err("object is not iterable (cannot read property Symbol(Symbol.iterator))".into()), // recorded-literal: the V8 TypeError text
    };
    let mut store = Vec::with_capacity(list.len());
    for entry in &list {
        if !matches!(entry, Value::Array(_)) && plain(entry).is_none() && set_items(entry).is_none() {
            return Err(format!("Iterator value {} is not an entry object", key_of(entry)));
        }
        set(&mut store, prop(entry, "0"), prop(entry, "1"));
    }
    Ok(store)
}

fn map_of(store: Store) -> Value {
    Value::Array(store.into_iter().map(|(k, v)| Value::Array(vec![k, v])).collect())
}

fn number_of(v: &Value) -> f64 {
    match primitive(v) {
        Prim::Num(n) => n,
        Prim::Text(u) => to_number(&u),
    }
}

/// `prunePendingPartDeltas` / `prunePartTypeHints`.
fn prune(store: &mut Store, now: f64, ttl: f64, max: usize) -> R<()> {
    let mut kept = Vec::with_capacity(store.len());
    for (key, value) in store.drain(..) {
        let age = now - number_of(&get(&value, "updatedAt")?);
        if age <= ttl || age.is_nan() {
            kept.push((key, value));
        }
    }
    *store = kept;
    if store.len() <= max {
        return Ok(());
    }
    let overflow = store.len() - max;
    let mut order: Vec<(Value, f64)> = Vec::with_capacity(store.len());
    for (key, value) in store.iter() {
        order.push((key.clone(), number_of(&get(value, "updatedAt")?)));
    }
    js::sort(&mut order, |l, r| l.1 - r.1);
    let doomed: Vec<Value> = order.into_iter().take(overflow).map(|(k, _)| k).collect();
    store.retain(|(k, _)| !doomed.iter().any(|d| eq(d, k, true)));
    Ok(())
}

fn guarded(directory: &str) -> bool {
    directory.is_empty() || directory == "global"
}

fn join(items: &[&Value]) -> Value {
    let mut out: Vec<u16> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(0);
        }
        if !nullish(item) {
            out.extend(units(item).unwrap_or_else(|| key_of(item).encode_utf16().collect()));
        }
    }
    js::utf16_string(&out)
}

/// `key.startsWith(prefix)`.
fn starts_with(key: &Value, prefix: &Value) -> R<bool> {
    let Some(k) = units(key) else {
        return Err(if nullish(key) {
            read_error(key, Some("startsWith".into()))
        } else {
            "key.startsWith is not a function".into()
        }); // recorded-literal: the V8 TypeError text
    };
    Ok(units(prefix).is_some_and(|p| k.starts_with(&p)))
}

fn find(store: &Store, key: &Value) -> Option<usize> {
    store.iter().position(|(k, _)| eq(k, key, true))
}

fn set(store: &mut Store, key: Value, value: Value) {
    match find(store, &key) {
        Some(at) => store[at].1 = value,
        None => store.push((key, value)),
    }
}

fn answer(result: Value, store: Store) -> Value {
    serde_json::json!({ "result": result, "store": map_of(store) })
}

/// Port of `recordPartTypeHintReturningStore` (`pending-part-deltas-mutation.ts:21`).
pub fn record_part_type_hint_returning_store(
    store: serde_json::Value,
    directory: String,
    event: serde_json::Value,
    now: f64,
) -> Result<serde_json::Value, String> {
    let mut entries = store_of(&store)?;
    if guarded(&directory) || !is_str(&get(&event, "type")?, "message.part.updated") {
        return Ok(map_of(entries));
    }
    let part = get(&get(&event, "properties")?, "part")?;
    let (id, kind) = (opt(&part, "id"), if nullish(&part) { undef() } else { prop(&part, "type") });
    if units(&id).is_none_or(|u| u.is_empty()) || units(&kind).is_none_or(|u| u.is_empty()) {
        return Ok(map_of(entries));
    }
    prune(&mut entries, now, HINT_TTL, MAX_HINTS)?;
    let key = join(&[&Value::String(directory), &id]);
    set(&mut entries, key, serde_json::json!({ "type": kind, "updatedAt": js::number(now) }));
    Ok(map_of(entries))
}

/// Port of `getPartTypeHintReturningStore` (`pending-part-deltas-mutation.ts:26`).
pub fn get_part_type_hint_returning_store(store: serde_json::Value, directory: String, part_id: String, now: f64) -> Result<serde_json::Value, String> {
    let mut entries = store_of(&store)?;
    let key = join(&[&Value::String(directory), &Value::String(part_id)]);
    let Some(at) = find(&entries, &key).filter(|at| truthy(&entries[*at].1)) else {
        return Ok(answer(undef(), entries));
    };
    let hint = entries[at].1.clone();
    if now - number_of(&prop(&hint, "updatedAt")) > HINT_TTL {
        entries.remove(at);
        return Ok(answer(undef(), entries));
    }
    Ok(answer(prop(&hint, "type"), entries))
}

fn clear_directory(store: &Value, directory: &str) -> R<(f64, Store)> {
    let entries = store_of(store)?;
    if guarded(directory) {
        return Ok((0.0, entries));
    }
    let prefix = join(&[&Value::String(directory.into()), &Value::String(String::new())]);
    let mut kept = Vec::with_capacity(entries.len());
    let mut count = 0.0;
    for (key, value) in entries {
        if starts_with(&key, &prefix)? {
            count += 1.0;
        } else {
            kept.push((key, value));
        }
    }
    Ok((count, kept))
}

/// Port of `clearPartTypeHintsReturningStore` (`pending-part-deltas-mutation.ts:31`).
pub fn clear_part_type_hints_returning_store(store: serde_json::Value, directory: String) -> Result<serde_json::Value, String> {
    Ok(map_of(clear_directory(&store, &directory)?.1))
}

/// `appendPendingDelta(field, existing, incoming)`.
fn append_pending(field: &Value, existing: &Value, incoming: &Value) -> Value {
    let incoming_units = units(incoming).unwrap_or_default();
    let existing_units = units(existing);
    if is_str(field, "text") {
        return out(&text_delta(existing_units.unwrap_or_default(), &incoming_units));
    }
    if is_str(field, "output") {
        return out(&output_delta(existing_units.unwrap_or_default(), &incoming_units));
    }
    if truthy(existing) {
        return out(&[existing_units.unwrap_or_default(), incoming_units].concat());
    }
    incoming.clone()
}

/// Port of `addPendingPartDeltaReturningStore` (`pending-part-deltas-mutation.ts:36`).
pub fn add_pending_part_delta_returning_store(
    store: serde_json::Value,
    directory: String,
    pending: serde_json::Value,
    now: f64,
) -> Result<serde_json::Value, String> {
    let mut entries = store_of(&store)?;
    if guarded(&directory) {
        return Ok(map_of(entries));
    }
    prune(&mut entries, now, PENDING_TTL, MAX_PENDING)?;
    let field = get(&pending, "field")?;
    let key = join(&[&Value::String(directory), &prop(&pending, "messageID"), &prop(&pending, "partID"), &field]);
    let existing = find(&entries, &key).map_or_else(undef, |at| opt(&entries[at].1, "delta"));
    let mut next = spread(&pending);
    insert(&mut next, "delta".into(), append_pending(&field, &existing, &prop(&pending, "delta")));
    insert(&mut next, "updatedAt".into(), js::number(now));
    set(&mut entries, key, Value::Object(next));
    prune(&mut entries, now, PENDING_TTL, MAX_PENDING)?;
    Ok(map_of(entries))
}

/// Port of `consumePendingPartDeltasReturningStore` (`pending-part-deltas-mutation.ts:41`).
pub fn consume_pending_part_deltas_returning_store(
    store: serde_json::Value,
    directory: String,
    message_id: String,
    part_id: String,
    now: f64,
) -> Result<serde_json::Value, String> {
    let mut entries = store_of(&store)?;
    prune(&mut entries, now, PENDING_TTL, MAX_PENDING)?;
    let empty = Value::String(String::new());
    let prefix = join(&[&Value::String(directory), &Value::String(message_id), &Value::String(part_id), &empty]);
    let mut taken = Vec::new();
    let mut kept = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        if starts_with(&key, &prefix)? {
            taken.push(value);
        } else {
            kept.push((key, value));
        }
    }
    let entries = kept;
    let mut keyed = Vec::with_capacity(taken.len());
    for value in taken {
        let at = number_of(&get(&value, "updatedAt")?);
        keyed.push((value, at));
    }
    js::sort(&mut keyed, |l, r| l.1 - r.1);
    Ok(answer(Value::Array(keyed.into_iter().map(|(v, _)| v).collect()), entries))
}

/// `messageIDs instanceof Set ? messageIDs : new Set(messageIDs)`, as its members.
fn id_set(ids: &Value) -> R<Vec<Value>> {
    if let Some(items) = set_items(ids) {
        return Ok(items.clone());
    }
    match ids {
        Value::Array(items) => Ok(items.clone()),
        _ if nullish(ids) => Ok(Vec::new()),
        _ if units(ids).is_some() => Ok(units(ids).unwrap_or_default().iter().map(|c| js::utf16_string(&[*c])).collect()),
        _ => Err("object is not iterable (cannot read property Symbol(Symbol.iterator))".into()), // recorded-literal: the V8 TypeError text
    }
}

/// Port of `hasPendingPartDeltasForMessageList` (`pending-part-deltas-mutation.ts:46`).
pub fn has_pending_part_deltas_for_message_list(store: serde_json::Value, directory: String, message_i_ds: serde_json::Value) -> Result<bool, String> {
    let entries = store_of(&store)?;
    if guarded(&directory) || entries.is_empty() {
        return Ok(false);
    }
    let ids = id_set(&message_i_ds)?;
    if ids.is_empty() {
        return Ok(false);
    }
    let dir: Vec<u16> = directory.encode_utf16().collect();
    for (key, _) in &entries {
        let Some(key) = units(key) else {
            return Err(if nullish(key) {
                read_error(key, Some("split".into()))
            } else {
                "key.split is not a function".into()
            }); // recorded-literal: the V8 TypeError text
        };
        let mut parts = key.split(|c| *c == 0);
        let first = parts.next().unwrap_or_default();
        let second = parts.next().map(js::utf16_string).unwrap_or_else(undef);
        if first == dir.as_slice() && ids.iter().any(|id| eq(id, &second, true)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Port of `clearPendingPartDeltasForDirectoryReturningStore` (`pending-part-deltas-mutation.ts:50`).
pub fn clear_pending_part_deltas_for_directory_returning_store(store: serde_json::Value, directory: String) -> Result<serde_json::Value, String> {
    let (count, entries) = clear_directory(&store, &directory)?;
    Ok(answer(js::number(count), entries))
}

/// Port of `clearPendingPartDeltasForMessagesReturningStore` (`pending-part-deltas-mutation.ts:55`).
pub fn clear_pending_part_deltas_for_messages_returning_store(
    store: serde_json::Value,
    directory: String,
    message_i_ds: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut entries = store_of(&store)?;
    if guarded(&directory) || entries.is_empty() {
        return Ok(answer(js::number(0.0), entries));
    }
    let ids = id_set(&message_i_ds)?;
    if ids.is_empty() {
        return Ok(answer(js::number(0.0), entries));
    }
    let prefix = join(&[&Value::String(directory), &Value::String(String::new())]);
    let mut kept = Vec::with_capacity(entries.len());
    let mut count = 0.0;
    for (key, value) in entries.drain(..) {
        let message = get(&value, "messageID")?;
        if ids.iter().any(|id| eq(id, &message, true)) && starts_with(&key, &prefix)? {
            count += 1.0;
        } else {
            kept.push((key, value));
        }
    }
    Ok(answer(js::number(count), kept))
}
