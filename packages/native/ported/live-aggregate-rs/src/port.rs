//! The Rust port of `live-aggregate.ts`, after the client engine's `families/live_aggregate.rs`,
//! with `getSessionSummaryDiffTotals` of `@/lib/sessionDiffStats` ported alongside. Ids key maps
//! by SameValueZero; the result record orders integer-like keys first, as a JS object does.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(|v| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    })
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

fn number(value: Option<&Value>) -> Option<f64> {
    value.filter(|v| v.is_number() || v.get("$num").is_some()).and_then(js::as_number)
}

/// `for...of` over a value.
fn iterate(value: Option<&Value>, name: &str) -> Result<Vec<Value>, String> {
    match value {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Some(Value::Object(map)) if map.len() == 1 && map.get("$set").is_some_and(Value::is_array) => Ok(map["$set"].as_array().cloned().unwrap_or_default()),
        _ => Err(format!("{name} is not iterable")),
    }
}

/// JS `String(value)` as `Array.prototype.join` prints an element.
fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) if js::is_undefined(v) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => items.iter().map(|v| text(Some(v))).collect::<Vec<_>>().join(","),
        Some(v) => match (js::as_number(v), js::string_units(v)) {
            (Some(n), _) => js::number_to_string(n),
            (None, Some(units)) => String::from_utf16_lossy(&units),
            _ => "[object Object]".to_string(),
        },
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

/// `parseSessionDiffCount`.
fn diff_count(value: Option<&Value>) -> f64 {
    let parsed = match value {
        Some(Value::String(s)) => {
            let t = s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
            let body = t.trim_start_matches(['+', '-']);
            let prefixed = [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)]
                .into_iter()
                .find_map(|(p, r)| t.strip_prefix(p).map(|d| radix_value(d, r)));
            if t.is_empty() {
                0.0
            } else if let Some(n) = prefixed {
                n
            } else if body.is_empty() || body.contains(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))) {
                f64::NAN
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        other => number(other).unwrap_or(f64::NAN),
    };
    if parsed.is_finite() { parsed.max(0.0) + 0.0 } else { 0.0 }
}

/// `getSessionSummaryDiffTotals(session.summary)`.
fn diff_totals(session: &Value) -> Result<(f64, f64), String> {
    let summary = get(session, "summary")?.filter(|s| truthy(Some(s)));
    let Some(summary) = summary else { return Ok((0.0, 0.0)) };
    if opt(Some(summary), "additions").is_some() || opt(Some(summary), "deletions").is_some() {
        return Ok((diff_count(opt(Some(summary), "additions")), diff_count(opt(Some(summary), "deletions"))));
    }
    let diffs = opt(Some(summary), "diffs").filter(|d| !d.is_null());
    let (mut additions, mut deletions) = (0.0, 0.0);
    for diff in diffs.map_or(Ok(Vec::new()), |d| iterate(Some(d), "(summary.diffs ?? [])"))? {
        additions += diff_count(get(&diff, "additions")?);
        deletions += diff_count(get(&diff, "deletions")?);
    }
    Ok((additions, deletions))
}

fn updated_at(session: &Value) -> Result<f64, String> {
    let time = get(session, "time")?;
    let finite = |key| number(opt(time, key)).filter(|n| n.is_finite());
    Ok(finite("updated").or_else(|| finite("created")).unwrap_or(0.0))
}

fn signature(session: &Value) -> Result<String, String> {
    let directory = get(session, "directory")?.filter(|v| !v.is_null()).cloned();
    let parent = session.get("parentID").filter(|v| !nullish(v)).cloned();
    let (additions, deletions) = diff_totals(session)?;
    let time = session.get("time");
    let or_zero = |key| opt(time, key).filter(|v| !v.is_null()).cloned().unwrap_or(Value::from(0));
    let fields = [
        session.get("id").cloned(),
        Some(session.get("title").filter(|v| !nullish(v)).cloned().unwrap_or(Value::from(""))),
        Some(or_zero("created")),
        Some(or_zero("updated")),
        Some(or_zero("archived")),
        Some(directory.unwrap_or(Value::from(""))),
        Some(parent.unwrap_or(Value::from(""))),
        Some(
            opt(opt(Some(session), "share"), "url")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::from("")),
        ),
        Some(js::number(additions)),
        Some(js::number(deletions)),
    ];
    Ok(fields.iter().map(|f| text(f.as_ref())).collect::<Vec<_>>().join("|"))
}

/// The SameValueZero key of a value (`None` for objects: equal to nothing).
fn key(value: Option<&Value>) -> Option<String> {
    match value.filter(|v| !js::is_undefined(v)) {
        None => Some("u".to_string()),
        Some(Value::String(s)) => Some(format!("s{s}")),
        Some(v) => match js::as_number(v) {
            Some(n) if n.is_nan() => Some("NaN".to_string()),
            Some(n) => Some(format!("n{}", js::number_to_string(n))),
            None if matches!(v, Value::Object(_) | Value::Array(_)) => js::string_units(v).map(|u| format!("s{}", String::from_utf16_lossy(&u))),
            None => Some(v.to_string()),
        },
    }
}

/// `left === right` for whole arguments (two received objects are never the same).
fn same_reference(left: &Value, right: &Value) -> bool {
    !matches!(left, Value::Object(_) | Value::Array(_)) && key(Some(left)) == key(Some(right)) && key(Some(left)).as_deref() != Some("NaN")
}

/// `value.length` (`None` for `undefined`; a non-number length reads as NaN here).
fn length(value: &Value) -> Result<Option<f64>, String> {
    Ok(match value {
        Value::Array(items) => Some(items.len() as f64),
        Value::String(text) => Some(text.encode_utf16().count() as f64),
        other => get(other, "length")?.map(|v| number(Some(v)).unwrap_or(f64::NAN)),
    })
}

/// `value[index]` for arrays and strings.
fn at(value: &Value, index: usize) -> Value {
    match value {
        Value::Array(items) => items.get(index).cloned(),
        Value::String(text) => text.encode_utf16().nth(index).map(|u| js::utf16_string(&[u])),
        other => other.get(index.to_string()).cloned(),
    }
    .unwrap_or_else(js::undefined)
}

/// Port of `areSessionListsEquivalent` (`live-aggregate.ts:100`).
pub fn are_session_lists_equivalent(left: Value, right: Value) -> Result<bool, String> {
    if same_reference(&left, &right) {
        return Ok(true);
    }
    let count = length(&left)?;
    match (count, length(&right)?) {
        (None, None) => {}
        (Some(a), Some(b)) if a == b => {}
        _ => return Ok(false),
    }
    for index in 0..count.map_or(0.0, |n| n.max(0.0).ceil()) as usize {
        if signature(&at(&left, index))? != signature(&at(&right, index))? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `Object.keys(value)`.
fn keys(value: &Value) -> Result<Vec<String>, String> {
    if nullish(value) {
        return Err("Cannot convert undefined or null to object".to_string()); // recorded-literal: the V8 TypeError text
    }
    Ok(match value {
        Value::Array(items) => (0..items.len()).map(|i| i.to_string()).collect(),
        Value::String(text) => (0..text.encode_utf16().count()).map(|i| i.to_string()).collect(),
        Value::Object(map) if js::string_units(value).is_none() && js::as_number(value).is_none() => map.keys().cloned().collect(),
        _ => Vec::new(),
    })
}

fn status_equivalent(left: Option<&Value>, right: Option<&Value>) -> bool {
    let message = |s: Option<&Value>| opt(s, "message").and_then(Value::as_str).map(str::to_string);
    let field = |s: Option<&Value>, k| number(opt(s, k));
    key(opt(left, "type")) == key(opt(right, "type"))
        && key(opt(left, "type")).as_deref() != Some("NaN")
        && message(left) == message(right)
        && ["attempt", "next"].iter().all(|k| match (field(left, k), field(right, k)) {
            (Some(a), Some(b)) => a == b,
            (None, None) => true,
            _ => false,
        })
}

/// Port of `areStatusMapsEquivalent` (`live-aggregate.ts:117`).
pub fn are_status_maps_equivalent(left: Value, right: Value) -> Result<bool, String> {
    if same_reference(&left, &right) {
        return Ok(true);
    }
    let (left_keys, right_keys) = (keys(&left)?, keys(&right)?);
    if left_keys.len() != right_keys.len() {
        return Ok(false);
    }
    for k in &left_keys {
        let is_object = (right.is_object() && js::string_units(&right).is_none() && js::as_number(&right).is_none()) || right.is_array();
        if !is_object {
            return Err(format!("Cannot use 'in' operator to search for '{k}' in {}", text(Some(&right))));
        }
        if !right_keys.contains(k) && !(right.is_array() && k == "length") {
            return Ok(false);
        }
        let index = |v: &Value| match v {
            Value::Array(items) => k.parse::<usize>().ok().and_then(|i| items.get(i).cloned()),
            other => other.get(k.as_str()).cloned(),
        };
        if !status_equivalent(index(&left).as_ref(), index(&right).as_ref()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `state.session.find((candidate) => candidate.id === id)`.
fn find_session(state: &Value, id: Option<&Value>) -> Result<Option<Value>, String> {
    let sessions = get(state, "session")?.cloned().unwrap_or_else(js::undefined);
    get(&sessions, "find")?;
    let Value::Array(sessions) = sessions else {
        return Err("state.session.find is not a function".to_string());
    }; // recorded-literal: the V8 TypeError text
    for candidate in sessions {
        let candidate_key = key(get(&candidate, "id")?);
        if candidate_key.is_some() && candidate_key == key(id) && candidate_key.as_deref() != Some("NaN") {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// Port of `aggregateLiveSessions` (`live-aggregate.ts:145`).
pub fn aggregate_live_sessions(states: Value) -> Result<Vec<Value>, String> {
    let mut by_id: Vec<(Option<String>, Value)> = Vec::new();
    for state in iterate(Some(&states), "states")? {
        let sessions = get(&state, "session")?.cloned();
        for session in iterate(sessions.as_ref(), "state.session")? {
            if !truthy(opt(Some(&session), "id")) {
                continue;
            }
            let id = key(session.get("id"));
            match by_id.iter_mut().find(|(k, _)| k.is_some() && *k == id) {
                Some(slot) => {
                    if updated_at(&session)? >= updated_at(&slot.1)? {
                        slot.1 = session;
                    }
                }
                None => by_id.push((id, session)),
            }
        }
    }
    let mut sessions: Vec<(f64, Value)> = Vec::with_capacity(by_id.len());
    for (_, session) in by_id {
        sessions.push((updated_at(&session)?, session));
    }
    js::sort(&mut sessions, |left, right| right.0 - left.0);
    Ok(sessions.into_iter().map(|(_, s)| s).collect())
}

/// `getStatusCandidate`: the status and its session's update time (-1 without a session).
fn candidate(state: &Value, session_id: &str) -> Result<Option<(Value, f64)>, String> {
    let status = opt(get(state, "session_status")?, session_id).filter(|s| truthy(Some(s))).cloned();
    let Some(status) = status else { return Ok(None) };
    let session = find_session(state, Some(&Value::String(session_id.to_string())))?;
    let updated = match session.filter(|s| truthy(Some(s))) {
        Some(session) => updated_at(&session)?,
        None => -1.0,
    };
    Ok(Some((status, updated)))
}

fn priority(status: &Value) -> u8 {
    match opt(Some(status), "type").and_then(Value::as_str) {
        Some("retry") => 4,
        Some("busy") => 3,
        Some("idle") => 1,
        _ => 0,
    }
}

fn replaces(current: Option<&(Value, f64)>, next: &(Value, f64)) -> bool {
    match current {
        None => true,
        Some(current) if next.1 != current.1 => next.1 > current.1,
        Some(current) => priority(&next.0) >= priority(&current.0),
    }
}

/// Port of `aggregateLiveSessionStatuses` (`live-aggregate.ts:165`).
pub fn aggregate_live_session_statuses(states: Value) -> Result<Value, String> {
    let mut candidates: Vec<(String, (Value, f64))> = Vec::new();
    for state in iterate(Some(&states), "states")? {
        let table = get(&state, "session_status")?
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Object(Map::new()));
        for session_id in keys(&table)? {
            let Some(next) = candidate(&state, &session_id)? else { continue };
            match candidates.iter_mut().find(|(k, _)| *k == session_id) {
                Some(slot) if replaces(Some(&slot.1), &next) => slot.1 = next,
                Some(_) => {}
                None => candidates.push((session_id, next)),
            }
        }
    }
    // A JS object lists array-index keys first, in numeric order.
    let index = |k: &str| k.parse::<u32>().ok().filter(|n| n.to_string() == k && *n != u32::MAX);
    let (mut indexed, named): (Vec<_>, Vec<_>) = candidates.into_iter().partition(|(k, _)| index(k).is_some());
    indexed.sort_by_key(|(k, _)| index(k));
    Ok(Value::Object(indexed.into_iter().chain(named).map(|(k, (status, _))| (k, status)).collect()))
}

/// Port of `findLiveSession` (`live-aggregate.ts:190`).
pub fn find_live_session(states: Value, session_id: Option<String>) -> Result<Value, String> {
    let Some(session_id) = session_id.filter(|s| !s.is_empty()) else {
        return Ok(js::undefined());
    };
    let id = Value::String(session_id);
    let mut found: Option<Value> = None;
    for state in iterate(Some(&states), "states")? {
        let Some(session) = find_session(&state, Some(&id))?.filter(|s| truthy(Some(s))) else {
            continue;
        };
        let better = match &found {
            None => true,
            Some(current) => updated_at(&session)? >= updated_at(current)?,
        };
        if better {
            found = Some(session);
        }
    }
    Ok(found.unwrap_or_else(js::undefined))
}

/// Port of `findLiveSessionStatus` (`live-aggregate.ts:209`).
pub fn find_live_session_status(states: Value, session_id: Option<String>) -> Result<Value, String> {
    let Some(session_id) = session_id.filter(|s| !s.is_empty()) else {
        return Ok(js::undefined());
    };
    let mut found: Option<(Value, f64)> = None;
    for state in iterate(Some(&states), "states")? {
        let Some(next) = candidate(&state, &session_id)? else { continue };
        if replaces(found.as_ref(), &next) {
            found = Some(next);
        }
    }
    Ok(found.map_or_else(js::undefined, |(status, _)| status))
}
