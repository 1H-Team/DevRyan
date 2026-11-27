//! The Rust port of `opencode/tool-output-trim.js`. "The same reference back" is the same
//! printed value; `outputBytes` is `Buffer.byteLength` (a lone surrogate counts 3 bytes).

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

const OMITTABLE: [&str; 6] = ["read", "list", "ls", "webfetch", "websearch", "codesearch"];

/// `isRecord`: `typeof object`, not `null`, not an array (a `Map` counts, with no own keys).
fn record(value: &Value) -> bool {
    value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn utf8_len(units: &[u16]) -> usize {
    char::decode_utf16(units.iter().copied()).map(|c| c.map_or(3, char::len_utf8)).sum()
}

/// Port of `readToolOutputMode` (`opencode/tool-output-trim.js:30`).
pub fn read_tool_output_mode(query: Value) -> Result<Value, String> {
    let value = if query.is_null() || js::is_undefined(&query) {
        js::undefined()
    } else {
        field(&query, "toolOutput")
    };
    if js::is_undefined(&value) {
        return Ok(Value::String("full".into()));
    }
    if value.as_str() == Some("omit") {
        return Ok(value);
    }
    Err("toolOutput must be omit".into())
}

fn omit(part: &Value) -> Option<Value> {
    if !record(part) || field(part, "type").as_str() != Some("tool") || !field(part, "tool").as_str().is_some_and(|t| OMITTABLE.contains(&t)) {
        return None;
    }
    let state = field(part, "state");
    if !record(&state) || field(&state, "status").as_str() != Some("completed") {
        return None;
    }
    let output = js::string_units(&field(&state, "output"))?;
    if field(&state, "outputOmitted") == Value::Bool(true) || output.is_empty() {
        return None;
    }
    let mut next_state = plain(&state).cloned().unwrap_or_default();
    next_state.insert("output".into(), Value::String(String::new()));
    next_state.insert("outputOmitted".into(), Value::Bool(true));
    next_state.insert("outputBytes".into(), js::number(utf8_len(&output) as f64));
    let mut next = plain(part).cloned().unwrap_or_default();
    next.insert("state".into(), Value::Object(next_state));
    Some(Value::Object(next))
}

/// Port of `omitToolPartOutput` (`opencode/tool-output-trim.js:43`).
pub fn omit_tool_part_output(part: Value) -> Result<Value, String> {
    Ok(omit(&part).unwrap_or(part))
}

/// Port of `omitMessageToolOutput` (`opencode/tool-output-trim.js:55`).
pub fn omit_message_tool_output(record_value: Value) -> Result<Value, String> {
    if !record(&record_value) {
        return Ok(record_value);
    }
    let Value::Array(parts) = field(&record_value, "parts") else {
        return Ok(record_value);
    };
    let mut changed = false;
    let next: Vec<Value> = parts
        .into_iter()
        .map(|p| match omit(&p) {
            Some(n) => {
                changed = true;
                n
            }
            None => p,
        })
        .collect();
    if !changed {
        return Ok(record_value);
    }
    let mut out: Map<String, Value> = plain(&record_value).cloned().unwrap_or_default();
    out.insert("parts".into(), Value::Array(next));
    Ok(Value::Object(out))
}
