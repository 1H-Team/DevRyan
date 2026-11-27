//! The Rust port of `reconnect-recovery.ts`, its pure exports, with `isCompactionSummaryInfo` of
//! `compaction-summary.ts` inlined. Kept in TypeScript: `getReconnectCandidateSessionIds`
//! (materialization), the two `merge*SessionStatuses` (the abort guard's module state) and
//! `shouldRecoverStaleActiveSession` (`Date.now()`). `captureSessionStatusBaseline` (returns a `Map` the
//! bindings cannot carry back). A received baseline `Map` arrives as `{"$map": [[id, status], ...]}`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

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

fn non_empty(v: &Value) -> Option<String> {
    let text = String::from_utf16_lossy(&units(v)?);
    let t = text.trim_matches(js_space);
    (!t.is_empty()).then(|| t.to_string())
}

/// `(x?.length ?? 0) > 0`.
fn has_items(x: &Value) -> bool {
    let length = opt(x, "length");
    !nullish(&length) && less(&Prim::Num(0.0), &primitive(&length))
}

/// `value.at(-1)` (`name` names the value in V8's error).
fn last(value: &Value, name: &str) -> R<Value> {
    if let Some(u) = units(value) {
        return Ok(u.last().map_or_else(undef, |c| js::utf16_string(&[*c])));
    }
    match value {
        Value::Array(items) => Ok(items.last().cloned().unwrap_or_else(undef)),
        _ => Err(format!("{name}.at is not a function")),
    }
}

/// `getIncompleteRootAssistantSnapshot(input)`: (assistant, anchorUserMessageID, parts).
fn snapshot(input: &Value) -> R<Option<(Value, String, Value)>> {
    let state = get(input, "state")?;
    let sid = prop(input, "sessionID");
    if !is_str(&opt(&get_by(&get(&state, "session_status")?, &sid)?, "type"), "busy") {
        return Ok(None);
    }
    let sessions = get(&state, "session")?;
    let Value::Array(list) = &sessions else {
        get(&sessions, "find")?;
        return Err("input.state.session.find is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut session = undef();
    for candidate in list {
        if eq(&get(candidate, "id")?, &sid, false) {
            session = candidate.clone();
            break;
        }
    }
    if !truthy(&session) || truthy(&prop(&session, "parentID")) {
        return Ok(None);
    }
    if has_items(&get_by(&get(&state, "permission")?, &sid)?) || has_items(&get_by(&get(&state, "question")?, &sid)?) {
        return Ok(None);
    }
    let messages = get_by(&get(&state, "message")?, &sid)?;
    let messages = if nullish(&messages) { Value::Array(Vec::new()) } else { messages };
    let assistant = last(&messages, "messages")?;
    if !truthy(&assistant) || !is_str(&prop(&assistant, "role"), "assistant") || truthy(&prop(&assistant, "error")) {
        return Ok(None);
    }
    if num(&opt(&prop(&assistant, "time"), "completed")).is_some() {
        return Ok(None);
    }
    if units(&prop(&assistant, "finish")).is_some_and(|u| !u.is_empty()) {
        return Ok(None);
    }
    let Some(anchor) = non_empty(&prop(&assistant, "parentID")) else {
        return Ok(None);
    };
    let parts = get_by(&get(&state, "part")?, &prop(&assistant, "id"))?;
    let parts = if nullish(&parts) { Value::Array(Vec::new()) } else { parts };
    Ok(Some((assistant, anchor, parts)))
}

fn empty_plain_object(v: &Value) -> bool {
    plain(v).is_some_and(Map::is_empty) || set_items(v).is_some()
}

fn result(v: Option<Value>) -> Value {
    v.unwrap_or(Value::Null)
}

fn pending_tool_input(input: &Value) -> R<Option<Value>> {
    let Some((assistant, anchor, parts)) = snapshot(input)? else {
        return Ok(None);
    };
    let trailing = last(&parts, "snapshot.parts")?;
    if !truthy(&trailing) || !is_str(&prop(&trailing, "type"), "tool") {
        return Ok(None);
    }
    let state = prop(&trailing, "state");
    if !is_str(&opt(&state, "status"), "pending") || !empty_plain_object(&prop(&state, "input")) || !is_str(&prop(&state, "raw"), "") {
        return Ok(None);
    }
    let (Some(part), Some(call), Some(tool)) = (
        non_empty(&prop(&trailing, "id")),
        non_empty(&prop(&trailing, "callID")),
        non_empty(&prop(&trailing, "tool")),
    ) else {
        return Ok(None);
    };
    if tool.to_lowercase() == "devryan_task" {
        return Ok(None);
    }
    Ok(Some(json!({
        "kind": "tool-input", "sessionID": prop(input, "sessionID"), "assistantMessageID": prop(&assistant, "id"),
        "anchorUserMessageID": anchor, "partID": part, "callID": call, "tool": tool,
    })))
}

fn compaction_summary(info: &Value) -> bool {
    plain(info).is_some_and(|o| {
        o.get("summary") == Some(&Value::Bool(true))
            || o.get("mode").is_some_and(|m| is_str(m, "compaction"))
            || o.get("agent").is_some_and(|a| is_str(a, "compaction"))
    })
}

fn inference(input: &Value) -> R<Option<Value>> {
    let Some((assistant, anchor, parts)) = snapshot(input)? else {
        return Ok(None);
    };
    let length = prop(&parts, "length");
    if !eq(&length, &js::number(2.0), false) || compaction_summary(&assistant) {
        return Ok(None);
    }
    if !parts.is_array() && units(&parts).is_none() {
        return Err("object is not iterable (cannot read property Symbol(Symbol.iterator))".into()); // recorded-literal: the V8 TypeError text
    }
    let (step, trailing) = (prop(&parts, "0"), prop(&parts, "1"));
    if !is_str(&get(&step, "type")?, "step-start") {
        return Ok(None);
    }
    let kind = get(&trailing, "type")?;
    if !is_str(&kind, "reasoning") && !is_str(&kind, "text") {
        return Ok(None);
    }
    let text = prop(&trailing, "text");
    if units(&text).is_none() || non_empty(&text).is_some() {
        return Ok(None);
    }
    let (Some(step_id), Some(part)) = (non_empty(&prop(&step, "id")), non_empty(&prop(&trailing, "id"))) else {
        return Ok(None);
    };
    Ok(Some(json!({
        "kind": "inference", "sessionID": prop(input, "sessionID"), "assistantMessageID": prop(&assistant, "id"),
        "anchorUserMessageID": anchor, "stepStartPartID": step_id, "partID": part, "partType": kind,
    })))
}

/// Port of `getActiveSessionRecoveryCooldownMs` (`reconnect-recovery.ts:16`).
pub fn get_active_session_recovery_cooldown_ms(failure_count: serde_json::Value) -> Result<f64, String> {
    let count = if js::is_undefined(&failure_count) { Some(0.0) } else { num(&failure_count) };
    let n = count.filter(|c| c.is_finite()).map_or(0.0, |c| c.floor().max(0.0));
    Ok((15_000.0 * 2f64.powf(n)).min(60_000.0))
}

/// Port of `getActiveSessionRecoveryActivityAt` (`reconnect-recovery.ts:26`).
pub fn get_active_session_recovery_activity_at(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let status = get(&input, "status")?;
    let (at_status, at_output, now) = (prop(&input, "lastStatusEventAt"), prop(&input, "lastOutputEventAt"), prop(&input, "now"));
    if is_str(&opt(&status, "type"), "retry") {
        let values: Vec<f64> = [&at_status, &at_output].iter().filter_map(|v| num(v)).collect();
        if values.is_empty() {
            return Ok(now);
        }
        let max = values.iter().fold(f64::NEG_INFINITY, |a, b| {
            if a.is_nan() || b.is_nan() {
                f64::NAN
            } else if *b > a || (*b == a && b.is_sign_positive()) {
                *b
            } else {
                a
            }
        });
        return Ok(js::number(max));
    }
    Ok([at_output, at_status, now]
        .into_iter()
        .find(|v| !nullish(v))
        .unwrap_or_else(|| prop(&input, "now")))
}

/// Port of `getPendingToolInputStallFingerprint` (`reconnect-recovery.ts:140`).
pub fn get_pending_tool_input_stall_fingerprint(input: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(result(pending_tool_input(&input)?))
}

/// Port of `getProviderInferenceStallFingerprint` (`reconnect-recovery.ts:173`).
pub fn get_provider_inference_stall_fingerprint(input: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(result(inference(&input)?))
}

/// Port of `getProviderStallFingerprint` (`reconnect-recovery.ts:203`).
pub fn get_provider_stall_fingerprint(input: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(found) = pending_tool_input(&input)? {
        return Ok(found);
    }
    Ok(result(inference(&input)?))
}

/// Port of `getLongRunningToolFingerprint` (`reconnect-recovery.ts:234`).
pub fn get_long_running_tool_fingerprint(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let Some((assistant, anchor, parts)) = snapshot(&input)? else {
        return Ok(Value::Null);
    };
    let trailing = last(&parts, "snapshot.parts")?;
    if !truthy(&trailing) || !is_str(&prop(&trailing, "type"), "tool") {
        return Ok(Value::Null);
    }
    let status = units(&opt(&prop(&trailing, "state"), "status")).map_or_else(String::new, |u| {
        let lower = String::from_utf16_lossy(&u).trim_matches(js_space).to_lowercase();
        lower.chars().filter(|c| !js_space(*c) && *c != '_' && *c != '-').collect()
    });
    if !["running", "started", "inprogress", "processing", "executing"].contains(&status.as_str()) {
        return Ok(Value::Null);
    }
    let (Some(part), Some(call), Some(tool)) = (
        non_empty(&prop(&trailing, "id")),
        non_empty(&prop(&trailing, "callID")),
        non_empty(&prop(&trailing, "tool")),
    ) else {
        return Ok(Value::Null);
    };
    if !matches!(tool.to_lowercase().replace('-', "_").as_str(), "bash" | "shell") {
        return Ok(Value::Null);
    }
    Ok(json!({
        "kind": "long-running-tool", "sessionID": prop(&input, "sessionID"), "assistantMessageID": prop(&assistant, "id"),
        "anchorUserMessageID": anchor, "partID": part, "callID": call, "tool": tool,
    }))
}

/// `left === right` for whole arguments (two received objects are never the same).
fn same_argument(left: &Value, right: &Value) -> bool {
    eq(left, right, false)
}

fn same_fields(left: &Value, right: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|k| eq(&prop(left, k), &prop(right, k), false))
}

fn long_running_same(left: &Value, right: &Value) -> bool {
    if same_argument(left, right) {
        return true;
    }
    truthy(left)
        && truthy(right)
        && same_fields(
            left,
            right,
            &["sessionID", "assistantMessageID", "anchorUserMessageID", "partID", "callID", "tool"],
        )
}

fn provider_same(left: &Value, right: &Value) -> bool {
    if same_argument(left, right) {
        return true;
    }
    if !truthy(left) || !truthy(right) || !same_fields(left, right, &["kind", "sessionID", "assistantMessageID", "anchorUserMessageID", "partID"]) {
        return false;
    }
    let both = |kind: &str| is_str(&prop(left, "kind"), kind) && is_str(&prop(right, "kind"), kind);
    if both("tool-input") {
        return same_fields(left, right, &["callID", "tool"]);
    }
    both("inference") && same_fields(left, right, &["stepStartPartID", "partType"])
}

/// Port of `haveSameLongRunningToolFingerprint` (`reconnect-recovery.ts:267`).
pub fn have_same_long_running_tool_fingerprint(left: serde_json::Value, right: serde_json::Value) -> Result<bool, String> {
    Ok(long_running_same(&left, &right))
}

/// Port of `shouldConfirmLongRunningTool` (`reconnect-recovery.ts:281`).
pub fn should_confirm_long_running_tool(input: serde_json::Value) -> Result<bool, String> {
    let threshold = get(&input, "thresholdMs")?;
    let threshold = if nullish(&threshold) { js::number(600_000.0) } else { threshold };
    if truthy(&prop(&input, "managedChildActive")) {
        return Ok(false);
    }
    let (silent, limit) = (primitive(&prop(&input, "silentForMs")), primitive(&threshold));
    let at_least = match (&silent, &limit) {
        (Prim::Text(_), Prim::Text(_)) => !less(&silent, &limit),
        _ => {
            let n = |p: &Prim| match p {
                Prim::Num(n) => *n,
                Prim::Text(u) => to_number(u),
            };
            n(&silent) >= n(&limit)
        }
    };
    let after = prop(&input, "after");
    Ok(at_least && truthy(&after) && long_running_same(&prop(&input, "before"), &after))
}

/// Port of `haveSameProviderStallFingerprint` (`reconnect-recovery.ts:295`).
pub fn have_same_provider_stall_fingerprint(left: serde_json::Value, right: serde_json::Value) -> Result<bool, String> {
    Ok(provider_same(&left, &right))
}

/// Port of `haveSamePendingToolInputStallFingerprint` (`reconnect-recovery.ts:318`).
pub fn have_same_pending_tool_input_stall_fingerprint(left: serde_json::Value, right: serde_json::Value) -> Result<bool, String> {
    Ok(provider_same(&left, &right))
}

/// `for (const item of value)`.
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

fn equivalent_status(left: &Value, right: &Value) -> bool {
    if same_argument(left, right) {
        return true;
    }
    if !truthy(left) || !truthy(right) || !eq(&prop(left, "type"), &prop(right, "type"), false) {
        return false;
    }
    if !is_str(&prop(left, "type"), "retry") || !is_str(&prop(right, "type"), "retry") {
        return true;
    }
    same_fields(left, right, &["attempt", "message", "next"])
}

/// Port of `filterUnchangedSessionStatusCandidates` (`reconnect-recovery.ts:410`).
pub fn filter_unchanged_session_status_candidates(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let current = get(&input, "current")?;
    let ids = iterate(&get(&input, "candidateSessionIds")?, "input.candidateSessionIds")?;
    let baseline = prop(&input, "baseline");
    let mut eligible: Vec<Value> = Vec::new();
    for id in ids {
        let entries: Vec<(Value, Value)> = match (marker(&baseline, "$map").and_then(Value::as_array), set_items(&baseline)) {
            (Some(entries), _) => entries.iter().map(|e| (prop(e, "0"), prop(e, "1"))).collect(),
            (None, Some(_)) => return Err("input.baseline.get is not a function".into()), // recorded-literal: the V8 TypeError text
            _ if nullish(&baseline) => return Err(read_error(&baseline, Some("has".into()))),
            _ => return Err("input.baseline.has is not a function".into()), // recorded-literal: the V8 TypeError text
        };
        let Some((_, stored)) = entries.iter().find(|(k, _)| eq(k, &id, true)) else {
            continue;
        };
        if !equivalent_status(&get_by(&current, &id)?, stored) {
            continue;
        }
        if !eligible.iter().any(|e| eq(e, &id, true)) {
            eligible.push(id);
        }
    }
    Ok(Value::Array(eligible))
}

/// Port of `toAuthoritativeSessionStatus` (`reconnect-recovery.ts:424`).
pub fn to_authoritative_session_status(status: serde_json::Value) -> Result<serde_json::Value, String> {
    let Some(map) = plain(&status).filter(|m| m.contains_key("type")) else {
        return Ok(undef());
    };
    let kind = &map["type"];
    if is_str(kind, "idle") || is_str(kind, "busy") {
        return Ok(json!({ "type": kind }));
    }
    let field = |k: &str| map.get(k);
    let attempt = field("attempt")
        .and_then(num)
        .filter(|a| a.fract() == 0.0 && a.abs() <= 9_007_199_254_740_991.0 && *a >= 0.0);
    let next = field("next").and_then(num).filter(|n| n.is_finite() && *n >= 0.0);
    let message = field("message").filter(|m| units(m).is_some());
    if is_str(kind, "retry")
        && let (Some(_), Some(message), Some(_)) = (attempt, message, next)
    {
        return Ok(json!({ "type": "retry", "attempt": map["attempt"], "message": message, "next": map["next"] }));
    }
    Ok(undef())
}
