//! The Rust port of `opencode/opencode-client/envelope.js` (4 of 6: `readResponseBody` is async
//! over a `Response`, and `isNoContent` compares with a module sentinel by identity, which no JSON
//! argument can be, so `unwrapData` never sees it). Refusals are product `Error`s (their `code` and
//! `statusCode` do not cross the bindings).

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

fn own(value: &Value, key: &str) -> Option<Value> {
    plain(value).and_then(|o| o.get(key)).cloned()
}

/// Port of `unwrapV1Payload` (`opencode/opencode-client/envelope.js:91`).
pub fn unwrap_v1_payload(value: Value) -> Result<Value, String> {
    Ok(if is_record(&value) { own(&value, "data").unwrap_or(value) } else { value })
}

fn unwrap(body: &Value) -> Value {
    if nullish(body) {
        return Value::Null;
    }
    if is_record(body)
        && let Some(data) = own(body, "data")
    {
        return data;
    }
    body.clone()
}

/// Port of `unwrapData` (`opencode/opencode-client/envelope.js:100`).
pub fn unwrap_data(body: Value) -> Result<Value, String> {
    Ok(unwrap(&body))
}

/// Port of `unwrapPage` (`opencode/opencode-client/envelope.js:112`).
pub fn unwrap_page(body: Value) -> Result<Value, String> {
    let data = field(&body, "data");
    let cursor = field(&body, "cursor");
    if !is_record(&body) || !data.is_array() || (!nullish(&cursor) && !is_record(&cursor)) {
        return Err("Invalid OpenCode page envelope".into());
    }
    for value in plain(&cursor).map(|o| o.values().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if !nullish(&value) && !js::string_units(&value).is_some_and(|u| !u.is_empty()) {
            return Err("Invalid OpenCode page cursor".into());
        }
    }
    let pick = |k: &str| {
        let v = field(&cursor, k);
        if js::string_units(&v).is_some_and(|u| !u.is_empty()) {
            v
        } else {
            js::undefined()
        }
    };
    Ok(json!({ "data": data, "next": pick("next"), "previous": pick("previous") }))
}

/// Port of `unwrapList` (`opencode/opencode-client/envelope.js:135`).
pub fn unwrap_list(body: Value) -> Result<Value, String> {
    let data = unwrap(&body);
    Ok(if data.is_array() { data } else { json!([]) })
}
