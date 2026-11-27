//! The Rust port of `revert-transactions.ts`, after the client engine's
//! `families/revert_transactions.rs` for the lookups. The committed-resend set is module state, as
//! in the original: one insertion-ordered set per thread. A `ReadonlySet` arrives as the bridge's
//! `{"$set": [...]}` marker; any other non-nullish `hiddenMessageIDs` has no `has` and throws.

#![forbid(unsafe_code)]

use std::cell::RefCell;

use serde_json::Value;

use crate::js;

thread_local! {
    /// `committedRevertResends`.
    static RESENDS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

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

/// `value?.[key]`.
fn opt<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.filter(|v| !nullish(v)).and_then(|v| v.get(key)).filter(|v| !js::is_undefined(v))
}

/// `a === b` (objects never the same here).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => match (js::as_number(x), js::as_number(y)) {
            (Some(m), Some(n)) => m == n,
            (None, None) => !matches!(x, Value::Object(_) | Value::Array(_)) && x == y,
            _ => false,
        },
        _ => false,
    }
}

fn resend_key(session_id: &str, message_id: Option<&str>) -> Option<String> {
    let message_id = message_id.filter(|m| !m.is_empty())?;
    (!session_id.is_empty()).then(|| format!("{session_id}\0{message_id}"))
}

/// Port of `beginCommittedRevertResend` (`revert-transactions.ts:26`).
pub fn begin_committed_revert_resend(session_id: String, message_id: Option<String>) -> Result<(), String> {
    if let Some(key) = resend_key(&session_id, message_id.as_deref()) {
        RESENDS.with(|set| {
            let mut set = set.borrow_mut();
            if !set.contains(&key) {
                set.push(key);
            }
        });
    }
    Ok(())
}

/// Port of `endCommittedRevertResend` (`revert-transactions.ts:31`).
pub fn end_committed_revert_resend(session_id: String, message_id: Option<String>) -> Result<(), String> {
    if let Some(key) = resend_key(&session_id, message_id.as_deref()) {
        RESENDS.with(|set| set.borrow_mut().retain(|k| *k != key));
    }
    Ok(())
}

/// Port of `clearCommittedRevertResendsForSessions` (`revert-transactions.ts:36`).
pub fn clear_committed_revert_resends_for_sessions(session_i_ds: Value) -> Result<(), String> {
    let ids: Vec<Value> = match &session_i_ds {
        Value::Array(items) => items.clone(),
        Value::String(text) => text.chars().map(|c| Value::String(c.to_string())).collect(),
        Value::Object(map) if map.len() == 1 && map.get("$set").is_some_and(Value::is_array) => map["$set"].as_array().cloned().unwrap_or_default(),
        _ => return Err("sessionIDs is not iterable".to_string()),
    };
    for id in ids.iter().filter(|id| truthy(Some(id))) {
        let text = match id {
            Value::String(s) => s.clone(),
            other => js::as_number(other).map_or_else(|| other.to_string(), js::number_to_string),
        };
        let prefix = format!("{text}\0");
        RESENDS.with(|set| set.borrow_mut().retain(|k| !k.starts_with(&prefix)));
    }
    Ok(())
}

/// Port of `isCommittedRevertResendInFlight` (`revert-transactions.ts:48`).
pub fn is_committed_revert_resend_in_flight(session_id: String, message_id: Option<String>) -> Result<bool, String> {
    let key = resend_key(&session_id, message_id.as_deref());
    Ok(key.is_some_and(|key| RESENDS.with(|set| set.borrow().contains(&key))))
}

fn revert_message_id(session: Option<&Value>) -> Value {
    opt(opt(session, "revert"), "messageID").cloned().unwrap_or_else(js::undefined)
}

/// Port of `getSessionRevertMessageID` (`revert-transactions.ts:53`).
pub fn get_session_revert_message_id(session: Option<Value>) -> Result<Value, String> {
    Ok(revert_message_id(session.as_ref()))
}

/// `state.session?.find((candidate) => candidate.id === sessionID)`.
fn find_session<'a>(state: &'a Value, session_id: &str) -> Result<Option<&'a Value>, String> {
    match state.get("session").filter(|v| !nullish(v)) {
        None => Ok(None),
        Some(Value::Array(sessions)) => {
            for candidate in sessions {
                if get(candidate, "id")?.and_then(Value::as_str) == Some(session_id) {
                    return Ok(Some(candidate));
                }
            }
            Ok(None)
        }
        Some(_) => Err("state.session?.find is not a function".to_string()),
    }
}

fn effective(state: &Value, session_id: &str, session: Option<&Value>) -> Result<Value, String> {
    let transaction = opt(get(state, "revert_transaction")?, session_id);
    if truthy(transaction) && opt(transaction, "status").and_then(Value::as_str) != Some("failed") {
        return Ok(opt(transaction, "messageID").cloned().unwrap_or_else(js::undefined));
    }
    let session = match session.filter(|s| !nullish(s)) {
        Some(session) => Some(session),
        None => find_session(state, session_id)?,
    };
    Ok(revert_message_id(session))
}

/// Port of `getEffectiveSessionRevertMessageID` (`revert-transactions.ts:57`).
pub fn get_effective_session_revert_message_id(state: Value, session_id: String, session: Option<Value>) -> Result<Value, String> {
    effective(&state, &session_id, session.as_ref())
}

/// `hidden?.has(messageID)`, `name` being how V8 names the call when `has` is missing.
fn hidden_has(hidden: Option<&Value>, message_id: &str, name: &str) -> Result<bool, String> {
    match hidden.filter(|h| !nullish(h)) {
        None => Ok(false),
        Some(h) => match h.get("$set").filter(|_| h.as_object().is_some_and(|m| m.len() == 1)).and_then(Value::as_array) {
            Some(items) => Ok(items.iter().any(|v| v.as_str() == Some(message_id))),
            None => Err(format!("{name}?.has is not a function")),
        },
    }
}

/// `messagesBefore(messages, marker)`: `None` when the marker is absent (the same array back).
fn before(messages: &Value, marker: &Value) -> Result<Option<Vec<Value>>, String> {
    get(messages, "findIndex")?;
    let Value::Array(items) = messages else {
        return Err("messages.findIndex is not a function".to_string());
    };
    for (index, message) in items.iter().enumerate() {
        if same(get(message, "id")?, Some(marker).filter(|m| !js::is_undefined(m))) {
            return Ok(Some(items[..index].to_vec()));
        }
    }
    Ok(None)
}

/// Port of `isMessageHiddenByRevert` (`revert-transactions.ts:71`).
pub fn is_message_hidden_by_revert(state: Value, session_id: Option<String>, message_id: String) -> Result<bool, String> {
    let Some(session_id) = session_id.filter(|s| !s.is_empty()) else {
        return Ok(false);
    };
    let revert = effective(&state, &session_id, None)?;
    if !truthy(Some(&revert)) {
        return Ok(false);
    }
    let transaction = opt(state.get("revert_transaction"), &session_id);
    if opt(transaction, "status").and_then(Value::as_str) != Some("failed")
        && hidden_has(opt(transaction, "hiddenMessageIDs"), &message_id, "transaction?.hiddenMessageIDs")?
    {
        return Ok(true);
    }
    let Some(messages) = opt(state.get("message"), &session_id).filter(|m| truthy(Some(m))) else {
        return Ok(false);
    };
    let Some(visible) = before(messages, &revert)? else { return Ok(false) };
    for message in &visible {
        if get(message, "id")?.and_then(Value::as_str) == Some(message_id.as_str()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Port of `isMessageHiddenByAnyActiveRevert` (`revert-transactions.ts:90`).
pub fn is_message_hidden_by_any_active_revert(state: Value, message_id: String) -> Result<bool, String> {
    let transactions = get(&state, "revert_transaction")?;
    let entries: Vec<(String, Value)> = match transactions.filter(|t| truthy(Some(t))) {
        None => return Ok(false),
        Some(Value::Object(map)) if js::string_units(transactions.unwrap_or(&Value::Null)).is_none() => {
            map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        }
        Some(Value::Array(items)) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(i, c)| (i.to_string(), Value::String(c.to_string()))).collect(),
        Some(_) => Vec::new(),
    };
    for (session_id, transaction) in &entries {
        if !truthy(Some(transaction)) || transaction.get("status").and_then(Value::as_str) == Some("failed") {
            continue;
        }
        if hidden_has(transaction.get("hiddenMessageIDs"), &message_id, "transaction.hiddenMessageIDs")? {
            let session = find_session(&state, session_id)?;
            let Some(session) = session.filter(|s| truthy(Some(s))) else {
                return Ok(true);
            };
            if same(
                Some(&effective(&state, session_id, Some(session))?).filter(|v| !js::is_undefined(v)),
                opt(Some(transaction), "messageID"),
            ) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Port of `filterMessagesForRevert` (`revert-transactions.ts:111`).
pub fn filter_messages_for_revert(messages: Value, revert_message_id: Option<String>) -> Result<Value, String> {
    let Some(marker) = revert_message_id.filter(|m| !m.is_empty()) else {
        return Ok(messages);
    };
    Ok(before(&messages, &Value::String(marker))?.map_or(messages, Value::Array))
}
