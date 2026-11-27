//! The Rust port of `opencode/v2/projection/status.js` (6 of 8; `filterStatusesByDirectory`
//! calls a callback; `reconcileActiveStatuses` tests `previous instanceof Map` and was not
//! bridged). `activeSessionIDs` returns a `Set` (crosses as `{"$set": [...]}`); `retryBySession`
//! is a `Map` (`{"$map": ...}`): anything else with no `get` throws.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

/// `isRecord`: `typeof object`, not `null`, not an array (a `Map` counts, with no own fields).
fn is_record(value: &Value) -> bool {
    value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn is_number(value: &Value) -> bool {
    value.is_number() || value.get("$num").is_some_and(|_| js::as_number(value).is_some())
}

fn retry_status(retry: &Value) -> Value {
    let attempt = field(retry, "attempt");
    let at = field(retry, "at");
    let safe = is_number(&attempt) && js::as_number(&attempt).is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0);
    if !is_record(retry) || !safe || !(is_number(&at) && js::as_number(&at).is_some_and(f64::is_finite)) {
        return Value::Null;
    }
    let error = field(retry, "error");
    let message = if is_record(&error) && js::string_units(&field(&error, "message")).is_some() {
        field(&error, "message")
    } else {
        json!("")
    };
    json!({ "type": "retry", "attempt": attempt, "message": message, "next": at })
}

/// Strict `===` for primitives received from JS (objects never equal).
fn strict_eq(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (js::as_number(a), js::as_number(b)) {
        return x == y;
    }
    if let (Some(x), Some(y)) = (js::string_units(a), js::string_units(b)) {
        return x == y;
    }
    match (a, b) {
        (Value::Null, Value::Null) | (Value::Bool(_), Value::Bool(_)) => a == b,
        _ => js::is_undefined(a) && js::is_undefined(b),
    }
}

fn type_or_idle(value: &Value) -> Value {
    let t = if nullish(value) { js::undefined() } else { field(value, "type") };
    if nullish(&t) { json!("idle") } else { t }
}

fn active_ids(body: &Value) -> Vec<String> {
    let data = field(body, "data");
    let data = if is_record(body) && is_record(&data) { data } else { json!({}) };
    plain(&data)
        .map(|o| o.iter().filter(|(k, v)| !k.is_empty() && is_record(v)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default()
}

/// Port of `toV1RetryStatus` (`opencode/v2/projection/status.js:49`).
pub fn to_v1_retry_status(retry: Value) -> Result<Value, String> {
    Ok(retry_status(&retry))
}

/// Port of `statusForEvent` (`opencode/v2/projection/status.js:62`).
pub fn status_for_event(r#type: Value, data: Value) -> Result<Value, String> {
    Ok(match r#type.as_str() {
        Some("session.execution.started") => json!({ "type": "busy" }),
        Some("session.retry.scheduled") => {
            let r = retry_status(&data);
            if r.is_null() { json!({ "type": "busy" }) } else { r }
        }
        Some("session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted") => json!({ "type": "idle" }),
        _ => js::undefined(),
    })
}

/// Port of `isSameStatus` (`opencode/v2/projection/status.js:74`).
pub fn is_same_status(left: Value, right: Value) -> Result<bool, String> {
    let (lt, rt) = (type_or_idle(&left), type_or_idle(&right));
    if !strict_eq(&lt, &rt) {
        return Ok(false);
    }
    if lt.as_str() != Some("retry") {
        return Ok(true);
    }
    Ok(["attempt", "message", "next"].iter().all(|k| strict_eq(&field(&left, k), &field(&right, k))))
}

/// Port of `retryStatusFromMessages` (`opencode/v2/projection/status.js:89`).
pub fn retry_status_from_messages(messages: Value) -> Result<Value, String> {
    let Value::Array(items) = messages else { return Ok(Value::Null) };
    for message in items.iter().rev() {
        if !is_record(message) {
            continue;
        }
        match field(message, "type").as_str() {
            Some("idle") => return Ok(Value::Null),
            Some("assistant") => return Ok(retry_status(&field(message, "retry"))),
            _ => {}
        }
    }
    Ok(Value::Null)
}

/// Port of `activeSessionIDs` (`opencode/v2/projection/status.js:106`).
pub fn active_session_i_ds(body: Value) -> Result<Value, String> {
    Ok(json!({ "$set": active_ids(&body) }))
}

/// Port of `statusesFromActive` (`opencode/v2/projection/status.js:118`).
pub fn statuses_from_active(body: Value, options: Value) -> Result<Value, String> {
    let mut statuses = Map::new();
    for id in active_ids(&body) {
        if options.is_null() {
            return Err("Cannot read properties of null (reading 'retryBySession')".into()); // recorded-literal: V8 TypeError text
        }
        let by_session = if js::is_undefined(&options) {
            js::undefined()
        } else {
            field(&options, "retryBySession")
        };
        let retry = if nullish(&by_session) {
            js::undefined()
        } else {
            let pairs = by_session
                .as_object()
                .filter(|o| o.len() == 1)
                .and_then(|o| o.get("$map"))
                .and_then(Value::as_array);
            let Some(pairs) = pairs else {
                return Err("options.retryBySession?.get is not a function".into()); // recorded-literal: V8 TypeError text
            };
            pairs
                .iter()
                .find(|p| p.get(0).and_then(Value::as_str) == Some(id.as_str()))
                .and_then(|p| p.get(1))
                .cloned()
                .unwrap_or_else(js::undefined)
        };
        let keep = is_record(&retry) && field(&retry, "type").as_str() == Some("retry");
        statuses.insert(id, if keep { retry } else { json!({ "type": "busy" }) });
    }
    Ok(Value::Object(statuses))
}
