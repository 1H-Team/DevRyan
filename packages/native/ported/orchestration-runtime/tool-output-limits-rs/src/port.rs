//! The Rust port of `tool-output-limits.js` of `@devryan/orchestration-runtime` (all but
//! `fitManagedToolOutput`, which takes a callback). Its errors are `Error`s named by their code;
//! the `code`/`statusCode` properties do not cross. Byte counts are the UTF-8 length of
//! `JSON.stringify` (an `undefined` value counts 0, as `TextEncoder` encodes it as "").

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

// ---- JS values over JSON ----

/// A one-key object `{ tag: ... }`: how the bridge marks numbers, strings, `undefined` and `Set`s.
fn marked(v: &Value, tag: &str) -> bool {
    v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(tag))
}

/// `typeof v === "number"`.
fn num(v: &Value) -> Option<f64> {
    (v.is_number() || marked(v, "$num")).then(|| js::as_number(v)).flatten()
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ if js::is_undefined(v) => false,
        _ => num(v).map_or_else(|| js::string_units(v).is_none_or(|u| !u.is_empty()), |n| n != 0.0 && !n.is_nan()),
    }
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`, as `isRecord` reads it.
fn record(v: &Value) -> bool {
    plain(v).is_some() || marked(v, "$set")
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    let index = || key.parse::<usize>().ok().filter(|i| i.to_string() == key);
    let found = match (v, js::string_units(v)) {
        (_, Some(u)) if key == "length" => Some(js::number(u.len() as f64)),
        (_, Some(u)) => index().and_then(|i| u.get(i)).map(|c| js::utf16_string(&[*c])),
        (Value::Array(items), _) if key == "length" => Some(js::number(items.len() as f64)),
        (Value::Array(items), _) => index().and_then(|i| items.get(i).cloned()),
        _ => plain(v).and_then(|o| o.get(key).cloned()),
    };
    found.unwrap_or_else(js::undefined)
}

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

/// `Object.keys(v)` of a value that is not nullish.
fn keys(v: &Value) -> Vec<String> {
    let n = js::string_units(v).map(|u| u.len()).or_else(|| v.as_array().map(Vec::len));
    match n {
        Some(n) => (0..n).map(|i| i.to_string()).collect(),
        None => plain(v).map(|o| o.keys().cloned().collect()).unwrap_or_default(),
    }
}

fn quote(u: &[u16], out: &mut String) {
    out.push('"');
    for c in char::decode_utf16(u.iter().copied()) {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
}

/// `JSON.stringify(v)` (`None` for `undefined`).
fn stringify(v: &Value) -> Option<String> {
    let mut out = String::new();
    write_json(v, &mut out).then_some(out)
}

fn write_json(v: &Value, out: &mut String) -> bool {
    if js::is_undefined(v) {
        return false;
    }
    if let Some(n) = num(v) {
        out.push_str(&if n.is_finite() { js::number_to_string(n) } else { "null".into() });
    } else if let Some(u) = js::string_units(v) {
        quote(&u, out);
    } else if marked(v, "$set") {
        out.push_str("{}");
    } else {
        match v {
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if !write_json(item, out) {
                        out.push_str("null");
                    }
                }
                out.push(']');
            }
            Value::Object(o) => {
                out.push('{');
                let mut first = true;
                for (k, item) in o {
                    let mut member = String::new();
                    quote(&k.encode_utf16().collect::<Vec<_>>(), &mut member);
                    member.push(':');
                    if write_json(item, &mut member) {
                        if !first {
                            out.push(',');
                        }
                        out.push_str(&member);
                        first = false;
                    }
                }
                out.push('}');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    true
}

// ---- the unit ----

const MAX: f64 = 49_152.0;

fn safe_integer(v: &Value) -> Option<f64> {
    num(v).filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

fn limits_of(value: &Value) -> Result<Map<String, Value>, String> {
    let value = if js::is_undefined(value) { Value::Object(Map::new()) } else { value.clone() };
    let invalid = || "native_tool_output_limits_invalid".to_string();
    if !truthy(&value) || !record(&value) || keys(&value).iter().any(|k| k != "max_bytes" && k != "max_lines") {
        return Err(invalid());
    }
    let mut limits = Map::new();
    limits.insert("max_bytes".into(), json!(51_200));
    limits.insert("max_lines".into(), json!(1_000));
    for (k, v) in plain(&value).cloned().unwrap_or_default() {
        limits.insert(k, v);
    }
    if limits.values().any(|l| safe_integer(l).is_none_or(|n| n <= 0.0)) {
        return Err(invalid());
    }
    Ok(limits)
}

/// Port of `nativeToolOutputLimits` (`tool-output-limits.js:14`).
pub fn native_tool_output_limits(value: serde_json::Value) -> Result<serde_json::Value, String> {
    limits_of(&value).map(Value::Object)
}

/// Port of `managedToolOutputBudget` (`tool-output-limits.js:22`).
pub fn managed_tool_output_budget(limits: serde_json::Value) -> Result<serde_json::Value, String> {
    let limits = if js::is_undefined(&limits) {
        json!({ "max_bytes": 51_200, "max_lines": 1_000 })
    } else {
        limits
    };
    let max = num(&limits_of(&limits)?["max_bytes"]).unwrap_or(f64::NAN);
    let bytes = MAX.min(max - 2_048.0);
    if bytes < 1_024.0 {
        return Err("managed_tool_output_capacity_unavailable".into());
    }
    Ok(js::number(bytes))
}

fn has_own(v: &Value, key: &str) -> Result<bool, String> {
    if nullish(v) {
        return Err("TypeError: Cannot convert undefined or null to object".into()); // recorded-literal: the V8 TypeError text
    }
    Ok(keys(v).iter().any(|k| k == key))
}

/// `compactManagedTaskToolResult(value)` and whether it returned a new value.
fn compact(value: &Value) -> Result<(Value, bool), String> {
    if !truthy(value) || !record(value) || marked(value, "$set") {
        return Ok((value.clone(), false));
    }
    let mut result = plain(value).cloned().unwrap_or_default();
    let mut changed = false;
    let task = prop(value, "task");
    let envelope = prop(value, "resultEnvelope");
    let task_id = if nullish(&task) { js::undefined() } else { prop(&task, "taskId") };
    if truthy(&task_id) && eq(&task_id, &if nullish(&envelope) { js::undefined() } else { prop(&envelope, "taskId") }) {
        let mut next: Option<Map<String, Value>> = None;
        for field in ["failureReason", "recoverablePreview", "canonicalRefs"] {
            if !has_own(&task, field)? || !has_own(&envelope, field)? || stringify(&prop(&task, field)) != stringify(&prop(&envelope, field)) {
                continue;
            }
            next.get_or_insert_with(|| plain(&task).cloned().unwrap_or_default()).shift_remove(field);
        }
        if let Some(next) = next {
            result.insert("task".into(), Value::Object(next));
            changed = true;
        }
    }
    for field in ["tasks", "results"] {
        if let Value::Array(items) = prop(value, field) {
            let mut any = false;
            let mut next = Vec::with_capacity(items.len());
            for item in &items {
                let (v, c) = compact(item)?;
                any |= c;
                next.push(v);
            }
            if any {
                result.insert(field.into(), Value::Array(next));
                changed = true;
            }
        }
    }
    let follow = prop(value, "followUpTask");
    if truthy(&follow) {
        let (v, c) = compact(&follow)?;
        if c {
            result.insert("followUpTask".into(), v);
            changed = true;
        }
    }
    Ok(if changed { (Value::Object(result), true) } else { (value.clone(), false) })
}

/// Port of `compactManagedTaskToolResult` (`tool-output-limits.js:29`).
pub fn compact_managed_task_tool_result(value: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(compact(&value)?.0)
}

/// Port of `assertManagedToolOutputSize` (`tool-output-limits.js:52`).
pub fn assert_managed_tool_output_size(value: serde_json::Value, max_bytes: serde_json::Value) -> Result<serde_json::Value, String> {
    let max = if js::is_undefined(&max_bytes) { Some(MAX) } else { safe_integer(&max_bytes) };
    let Some(max) = max.filter(|m| (1_024.0..=MAX).contains(m)) else {
        return Err("managed_tool_output_capacity_invalid".into());
    };
    if stringify(&value).map_or(0, |s| s.len()) as f64 > max {
        return Err("managed_tool_output_metadata_too_large".into());
    }
    Ok(value)
}
