//! The Rust port of `sessionDiffStats.ts`, after `getSessionSummaryDiffTotals` in
//! `live-aggregate-rs`, over any JS value. `Number(text)` is the full JS conversion here
//! (`"0x1f"` is 31). The generic `T` exports cross as JSON (`--as-json T`): "the same `target`
//! back" is the same printed value.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// JS truthiness of a value received from JS.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JS `Number(text)`.
fn string_number(text: &str) -> f64 {
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |acc, c| c.to_digit(radix).map(|d| acc * f64::from(radix) + f64::from(d)))
                .unwrap_or(f64::NAN);
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let (mantissa, exponent) = body.split_once(['e', 'E']).unwrap_or((body, "0"));
    let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if (int.is_empty() && frac.is_empty()) || !digits(int) || !digits(frac) || exponent.is_empty() || !digits(exponent) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `value[key]`, failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(own(value, key))
}

/// An own property of an object (absent for primitives and markers).
fn own<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|o| o.get(key)).filter(|v| !js::is_undefined(v))
}

/// `for...of` over a value.
fn iterate(value: &Value, name: &str) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(map) if map.len() == 1 && map.get("$set").is_some_and(Value::is_array) => Ok(map["$set"].as_array().cloned().unwrap_or_default()),
        _ => Err(format!("{name} is not iterable")), // recorded-literal: V8 TypeError text
    }
}

/// `parseSessionDiffCount`.
fn diff_count(value: Option<&Value>) -> f64 {
    let parsed = match value {
        Some(Value::String(text)) => string_number(text),
        Some(v @ (Value::Number(_) | Value::Object(_))) if js::string_units(v).is_none() => js::as_number(v).unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if parsed.is_finite() { parsed.max(0.0) + 0.0 } else { 0.0 }
}

fn totals(additions: f64, deletions: f64) -> Value {
    json!({ "additions": js::number(additions), "deletions": js::number(deletions) })
}

/// The sums over `diffs ?? []`.
fn sum_diffs(diffs: Option<&Value>, name: &str) -> Result<(f64, f64), String> {
    let (mut additions, mut deletions) = (0.0, 0.0);
    if let Some(diffs) = diffs.filter(|d| !d.is_null()) {
        for diff in iterate(diffs, name)? {
            additions += diff_count(get(&diff, "additions")?);
            deletions += diff_count(get(&diff, "deletions")?);
        }
    }
    Ok((additions, deletions))
}

fn scoped(summary: &Value) -> Result<(f64, f64), String> {
    let diffs = if nullish(summary) { None } else { own(summary, "diffs") };
    sum_diffs(diffs, "(summary?.diffs ?? [])")
}

/// Port of `parseSessionDiffCount` (`sessionDiffStats.ts:27`).
pub fn parse_session_diff_count(value: Value) -> Result<f64, String> {
    Ok(diff_count(Some(&value)))
}

/// Port of `getSessionSummaryDiffTotals` (`sessionDiffStats.ts:38`).
pub fn get_session_summary_diff_totals(summary: Value) -> Result<Value, String> {
    if !truthy(&summary) {
        return Ok(totals(0.0, 0.0));
    }
    let (additions, deletions) = (own(&summary, "additions"), own(&summary, "deletions"));
    if additions.is_some() || deletions.is_some() {
        return Ok(totals(diff_count(additions), diff_count(deletions)));
    }
    let (additions, deletions) = sum_diffs(own(&summary, "diffs"), "(summary.diffs ?? [])")?;
    Ok(totals(additions, deletions))
}

/// Port of `resolveSessionDiffStats` (`sessionDiffStats.ts:60`).
pub fn resolve_session_diff_stats(summary: Value) -> Result<Value, String> {
    let (additions, deletions) = scoped(&summary)?;
    Ok(if additions == 0.0 && deletions == 0.0 {
        Value::Null
    } else {
        totals(additions, deletions)
    })
}

/// Port of `resolveTouchedFileWorkingTreeDiffStats` (`sessionDiffStats.ts:69`).
pub fn resolve_touched_file_working_tree_diff_stats(touched_files: Value, diff_stats: Value) -> Result<Value, String> {
    let (mut additions, mut deletions) = (0.0, 0.0);
    for file in iterate(&touched_files, "touchedFiles")? {
        let Value::String(file) = &file else {
            get(&file, "replace")?;
            return Err("value.replace is not a function".into()); // recorded-literal: V8 TypeError text
        };
        let slashed = file.replace('\\', "/");
        let key = slashed.strip_prefix("./").unwrap_or(&slashed);
        let stats = match &diff_stats {
            Value::Array(items) => key.parse::<usize>().ok().filter(|i| i.to_string() == key).and_then(|i| items.get(i)),
            other if nullish(other) => None,
            other => own(other, key),
        };
        let field = |name: &str| stats.filter(|s| !nullish(s)).and_then(|s| own(s, name));
        additions += diff_count(field("insertions"));
        deletions += diff_count(field("deletions"));
    }
    Ok(if additions == 0.0 && deletions == 0.0 {
        Value::Null
    } else {
        totals(additions, deletions)
    })
}

/// Port of `getScopedMessageDiffTotals` (`sessionDiffStats.ts:86`).
pub fn get_scoped_message_diff_totals(summary: Value) -> Result<Value, String> {
    let (additions, deletions) = scoped(&summary)?;
    Ok(totals(additions, deletions))
}

/// `Object.keys({ ...value })` of a truthy value: a string spreads its indexes.
fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(o) if js::string_units(value).is_none() && js::as_number(value).is_none() && !o.contains_key("$set") && !o.contains_key("$map") => {
            o.clone()
        }
        Value::String(text) => text.chars().enumerate().map(|(i, c)| (i.to_string(), Value::String(c.to_string()))).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        _ => Map::new(),
    }
}

/// Port of `stripUntrustedSessionDiffSummary` (`sessionDiffStats.ts:100`).
pub fn strip_untrusted_session_diff_summary(target: Value) -> Result<Value, String> {
    let summary = get(&target, "summary")?;
    let Some(summary) = summary.filter(|s| truthy(s)) else { return Ok(target) };
    let mut next = spread(summary);
    let before = next.len();
    for key in ["additions", "deletions", "files", "diffs"] {
        next.shift_remove(key);
    }
    if next.len() == before {
        return Ok(target);
    }
    let Value::Object(mut out) = target else { return Ok(target) };
    if next.is_empty() {
        out.shift_remove("summary");
    } else {
        out.insert("summary".into(), Value::Object(next));
    }
    Ok(Value::Object(out))
}

/// Port of `normalizeChatOwnedDiffSummary` (`sessionDiffStats.ts:126`): `messages` is unused.
pub fn normalize_chat_owned_diff_summary(target: Value, messages: Value) -> Result<Value, String> {
    let _ = messages;
    strip_untrusted_session_diff_summary(target)
}
