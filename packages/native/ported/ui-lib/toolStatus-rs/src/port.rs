//! The Rust port of `toolStatus.ts`, after the lifecycle check in `session-working-rs` (the
//! engine's `families/tool_status.rs`). Statuses are handled as UTF-16 code units so lone
//! surrogates survive, as in JS.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

const ACTIVE_TOOL_STATUSES: [&str; 6] = ["pending", "running", "started", "inprogress", "processing", "executing"];
const FINAL_TOOL_STATUSES: [&str; 10] = [
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

/// JS `\s` (and `trim`): white space and line terminators, U+FEFF included, U+0085 not.
fn js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// JS `toLowerCase` over code units: well-formed runs as `str::to_lowercase` (final sigma
/// included), lone surrogates kept.
fn to_lower(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut run = String::new();
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok(c) => run.push(c),
            Err(lone) => {
                out.extend(run.to_lowercase().encode_utf16());
                run.clear();
                out.push(lone.unpaired_surrogate());
            }
        }
    }
    out.extend(run.to_lowercase().encode_utf16());
    out
}

/// `normalizeToolStatus` as code units.
fn normalize(status: &Value) -> Option<Vec<u16>> {
    let units = js::string_units(status)?;
    let normalized: Vec<u16> = to_lower(&units)
        .into_iter()
        .filter(|&u| !js_space(u) && u != u16::from(b'_') && u != u16::from(b'-'))
        .collect();
    (!normalized.is_empty()).then_some(normalized)
}

fn is_in(status: Option<&[u16]>, set: &[&str]) -> bool {
    status.and_then(|s| String::from_utf16(s).ok()).is_some_and(|s| set.contains(&s.as_str()))
}

/// `value?.[key]` (absent for primitives and markers).
fn opt<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|v| v.as_object()).and_then(|o| o.get(key)).filter(|v| !js::is_undefined(v))
}

/// `readTimestamp`: a finite number.
fn timestamp(value: Option<&Value>) -> Option<f64> {
    value
        .filter(|v| v.is_number() || v.get("$num").is_some())
        .and_then(js::as_number)
        .filter(|n| n.is_finite())
}

fn or_undefined(value: Option<Value>) -> Value {
    value.unwrap_or_else(js::undefined)
}

/// Port of `normalizeToolStatus` (`toolStatus.ts:28`).
pub fn normalize_tool_status(status: Value) -> Result<Value, String> {
    Ok(or_undefined(normalize(&status).map(|u| js::utf16_string(&u))))
}

/// Port of `isFinalToolStatus` (`toolStatus.ts:37`).
pub fn is_final_tool_status(status: Value) -> Result<bool, String> {
    Ok(is_in(normalize(&status).as_deref(), &FINAL_TOOL_STATUSES))
}

/// Port of `getToolLifecycleState` (`toolStatus.ts:54`).
pub fn get_tool_lifecycle_state(state: Value) -> Result<Value, String> {
    let state = Some(&state);
    let status = opt(state, "status").and_then(normalize);
    let time = opt(state, "time");
    let start = timestamp(opt(time, "start"));
    let raw_end = timestamp(opt(time, "end"));
    let invalid_range = matches!((start, raw_end), (Some(s), Some(e)) if e < s);
    let has_ended = raw_end.is_some() && !invalid_range;
    let end = raw_end.filter(|_| has_ended);
    let active = is_in(status.as_deref(), &ACTIVE_TOOL_STATUSES);
    let fin = is_in(status.as_deref(), &FINAL_TOOL_STATUSES);
    let unknown_non_final = status.is_none() || (!active && !fin);
    let mut out = Map::new();
    out.insert("status".into(), or_undefined(status.map(|u| js::utf16_string(&u))));
    out.insert("start".into(), or_undefined(start.map(js::number)));
    out.insert("end".into(), or_undefined(end.map(js::number)));
    out.insert("hasStarted".into(), Value::Bool(start.is_some()));
    out.insert("hasEnded".into(), Value::Bool(has_ended));
    out.insert("isStatusActive".into(), Value::Bool(active));
    out.insert("isStatusFinal".into(), Value::Bool(fin));
    out.insert("isInFlight".into(), Value::Bool(!has_ended && (active || unknown_non_final)));
    out.insert("isFinalized".into(), Value::Bool(!invalid_range && (has_ended || fin)));
    Ok(Value::Object(out))
}
