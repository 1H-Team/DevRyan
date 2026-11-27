//! The Rust port of `session-working.ts`, after the client engine's
//! `families/session_working.rs`, with `getToolLifecycleState` of `@/lib/toolStatus` (the
//! engine's `families/tool_status.rs`) ported alongside. JS `trim` and `\s` strip U+FEFF and the
//! line separators but not U+0085.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(value) && js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// `value[key]` (`undefined` as `Null`-free `None`), failing as V8 does on `null` and `undefined`.
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

fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

fn str_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// A string member, lone surrogates included (as U+FFFD: never whitespace, never a keyword).
fn text_of(value: Option<&Value>) -> Option<String> {
    value.and_then(js::string_units).map(|u| String::from_utf16_lossy(&u))
}

fn not_assistant(message: &Value) -> bool {
    !truthy(message) || str_of(message.get("role")) != Some("assistant")
}

fn finish(message: &Value) -> Option<String> {
    text_of(message.get("finish")).map(|f| trim(&f).to_lowercase())
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.filter(|v| v.is_number() || v.get("$num").is_some()).and_then(js::as_number)
}

/// `getToolLifecycleState(state).isInFlight`.
fn in_flight(state: Option<&Value>) -> bool {
    let status = text_of(opt(state, "status")).map(|s| {
        let lower = s.to_lowercase();
        trim(&lower).chars().filter(|c| !js_space(*c) && *c != '_' && *c != '-').collect::<String>()
    });
    let time = opt(state, "time");
    let start = number(opt(time, "start")).filter(|n| n.is_finite());
    let end = number(opt(time, "end")).filter(|n| n.is_finite());
    let has_ended = end.is_some_and(|e| start.is_none_or(|s| e >= s));
    let active = ["pending", "running", "started", "inprogress", "processing", "executing"];
    let fin = [
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
    let known_final = status.as_deref().filter(|s| !s.is_empty()).is_some_and(|s| fin.contains(&s));
    let known_active = status.as_deref().filter(|s| !s.is_empty()).is_some_and(|s| active.contains(&s));
    !has_ended && (known_active || !known_final)
}

/// `parts ?? []`, as `for...of` walks it.
fn parts_of(parts: &Value) -> Result<Vec<Value>, String> {
    match parts {
        v if nullish(v) => Ok(Vec::new()),
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        _ => Err("(parts ?? []) is not iterable".to_string()),
    }
}

fn message_of(message: Option<Value>) -> Value {
    message.unwrap_or_else(js::undefined)
}

/// Port of `hasTerminalAssistantFinish` (`session-working.ts:4`).
pub fn has_terminal_assistant_finish(message: Option<Value>) -> Result<bool, String> {
    let message = message_of(message);
    Ok(!not_assistant(&message) && finish(&message).is_some_and(|f| !f.is_empty() && f != "tool-calls"))
}

/// Port of `hasToolCallAssistantFinish` (`session-working.ts:12`).
pub fn has_tool_call_assistant_finish(message: Option<Value>) -> Result<bool, String> {
    let message = message_of(message);
    Ok(!not_assistant(&message) && finish(&message).as_deref() == Some("tool-calls"))
}

/// Port of `isTerminalAssistantMessage` (`session-working.ts:18`).
pub fn is_terminal_assistant_message(message: Option<Value>) -> Result<bool, String> {
    let message = message_of(message);
    if not_assistant(&message) {
        return Ok(false);
    }
    let completed = number(opt(message.get("time"), "completed")).is_some_and(|c| c.is_finite() && c > 0.0);
    Ok(completed || has_terminal_assistant_finish(Some(message))?)
}

/// Port of `isAssistantTurnComplete` (`session-working.ts:27`).
pub fn is_assistant_turn_complete(message: Option<Value>) -> Result<bool, String> {
    let message = message_of(message);
    if not_assistant(&message) || message.get("streaming") == Some(&Value::Bool(true)) {
        return Ok(false);
    }
    match text_of(message.get("status")).map(|s| trim(&s).to_lowercase()).as_deref() {
        Some("running" | "pending" | "streaming") => return Ok(false),
        Some("complete" | "completed" | "done") => return Ok(true),
        _ => {}
    }
    is_terminal_assistant_message(Some(message))
}

/// Port of `isIncompleteAssistantMessage` (`session-working.ts:42`).
pub fn is_incomplete_assistant_message(message: Option<Value>) -> Result<bool, String> {
    let message = message_of(message);
    Ok(!not_assistant(&message) && !is_assistant_turn_complete(Some(message))?)
}

/// Port of `hasInFlightToolParts` (`session-working.ts:50`).
pub fn has_in_flight_tool_parts(parts: Value) -> Result<bool, String> {
    for part in parts_of(&parts)? {
        if str_of(get(&part, "type")?) == Some("tool") && in_flight(get(&part, "state")?) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Port of `hasVisibleAssistantSummary` (`session-working.ts:62`).
pub fn has_visible_assistant_summary(parts: Value) -> Result<bool, String> {
    for part in parts_of(&parts)? {
        if !matches!(str_of(get(&part, "type")?), Some("text" | "reasoning")) {
            continue;
        }
        for key in ["text", "output"] {
            if text_of(get(&part, key)?).is_some_and(|t| !trim(&t).is_empty()) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Port of `isFinalAssistantSummaryMessage` (`session-working.ts:76`).
pub fn is_final_assistant_summary_message(message: Option<Value>, parts: Value) -> Result<bool, String> {
    if !is_assistant_turn_complete(message.clone())? || has_tool_call_assistant_finish(message)? || has_in_flight_tool_parts(parts.clone())? {
        return Ok(false);
    }
    has_visible_assistant_summary(parts)
}

/// Port of `isLiveAssistantMessage` (`session-working.ts:87`).
pub fn is_live_assistant_message(message: Option<Value>, parts: Value) -> Result<bool, String> {
    if not_assistant(&message_of(message.clone())) {
        return Ok(false);
    }
    if is_incomplete_assistant_message(message.clone())? {
        return Ok(true);
    }
    Ok(has_tool_call_assistant_finish(message)? && has_in_flight_tool_parts(parts)?)
}

/// `messages[index]` / `.length` for arrays and strings.
fn index(list: &Value, at: f64) -> Value {
    let item = match list {
        Value::Array(items) if at >= 0.0 => items.get(at as usize).cloned(),
        Value::String(text) if at >= 0.0 => text.encode_utf16().nth(at as usize).map(|u| js::utf16_string(&[u])),
        _ => None,
    };
    item.unwrap_or_else(js::undefined)
}

fn length(value: &Value) -> Result<f64, String> {
    Ok(match get(value, "length")? {
        _ if value.is_array() => value.as_array().map_or(0, Vec::len) as f64,
        _ if value.is_string() => value.as_str().map_or(0, |s| s.encode_utf16().count()) as f64,
        found => number(found).unwrap_or(f64::NAN),
    })
}

/// `a === b` for an id (objects are never the same here).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a.filter(|v| !js::is_undefined(v)), b.filter(|v| !js::is_undefined(v))) {
        (None, None) => true,
        (Some(x), Some(y)) => !matches!(x, Value::Object(_) | Value::Array(_)) && x == y,
        _ => false,
    }
}

/// Port of `isSessionWorkingFromState` (`session-working.ts:97`).
pub fn is_session_working_from_state(arg0: Value) -> Result<bool, String> {
    if nullish(&arg0) {
        let shown = if arg0.is_null() { "object null" } else { "undefined" };
        let kind = if arg0.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property 'status' of '{shown}' as it is {kind}."));
    }
    let field = |key: &str| arg0.get(key).cloned().unwrap_or_else(js::undefined);
    let (status, permissions, messages) = (field("status"), field("permissions"), field("messages"));
    let (live_id, live_parts) = (field("liveStreamingMessageId"), field("liveParts"));
    if length(&permissions)? > 0.0 {
        return Ok(false);
    }
    let authoritative = !js::is_undefined(&status);
    let status_working = authoritative && str_of(get(&status, "type")?) != Some("idle");
    let count = length(&messages)?;
    let last = index(&messages, count - 1.0);
    let parts_belong_to_last = !truthy(&live_id) || same(opt(Some(&last), "id"), Some(&live_id));
    let mut tracked = false;
    if truthy(&live_id) {
        let mut at = count - 1.0;
        while at >= 0.0 {
            let message = index(&messages, at);
            at -= 1.0;
            if str_of(get(&message, "role")?) == Some("user") {
                break;
            }
            if same(get(&message, "id")?, Some(&live_id)) {
                tracked = is_live_assistant_message(Some(message), live_parts.clone())?;
                break;
            }
        }
    }
    if authoritative {
        return Ok(status_working);
    }
    let parts = if parts_belong_to_last { live_parts } else { js::undefined() };
    Ok(tracked || is_live_assistant_message(Some(last), parts)?)
}
