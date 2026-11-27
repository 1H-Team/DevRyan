//! The Rust port of `objective-progress.js` of `@devryan/harness-runtime`. `RegExp.test` reads its
//! argument as `String(v)`, so a one-element array holding a hash passes the hash test, as in JS.

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
    let falsy = num(v).is_some_and(|n| n == 0.0 || n.is_nan()) || js::string_units(v).is_some_and(|u| u.is_empty());
    !(falsy || matches!(v, Value::Null | Value::Bool(false)) || js::is_undefined(v))
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`, as `isRecord` reads it.
fn record(v: &Value) -> bool {
    plain(v).is_some() || marked(v, "$set")
}

/// `v[key]` for the named fields this unit reads (none is an index or `length`).
fn prop(v: &Value, key: &str) -> Value {
    plain(v).and_then(|o| o.get(key).cloned()).unwrap_or_else(js::undefined)
}

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

/// JS `String(v)`.
fn to_text(v: &Value) -> String {
    match (num(v), js::string_units(v).map(|u| String::from_utf16_lossy(&u)), v) {
        (Some(n), ..) => js::number_to_string(n),
        (_, Some(t), _) => t,
        (_, _, Value::Array(items)) => items
            .iter()
            .map(|i| if nullish(i) { String::new() } else { to_text(i) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(v) => "undefined".into(),
        (_, _, Value::Object(_)) => "[object Object]".into(),
        _ => v.to_string(),
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

/// `{ ...v }`.
fn spread(v: &Value) -> Map<String, Value> {
    if let Some(u) = js::string_units(v) {
        return u.iter().enumerate().map(|(i, c)| (i.to_string(), js::utf16_string(&[*c]))).collect();
    }
    match v {
        Value::Array(items) => items.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        _ => plain(v).cloned().unwrap_or_default(),
    }
}

// ---- the unit ----

const REASONS: [&str; 2] = ["tool_input_invalid", "binary_read_blocked"];
const KINDS: [&str; 4] = ["tool-evidence", "child-completed", "artifact-changed", "required-check"];

/// `/^[a-f0-9]{64}$/.test(v)`.
fn hash(v: &Value) -> bool {
    let t = to_text(v);
    t.len() == 64 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `Object.entries(counts).some(([kind, count]) => !KINDS.has(kind) || !Number.isSafeInteger(count) || count < 0)`.
fn bad_counts(counts: &Value) -> bool {
    keys(counts).iter().any(|k| {
        !KINDS.contains(&k.as_str())
            || num(&prop(counts, k))
                .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
                .is_none_or(|n| n < 0.0)
    })
}

/// Port of `validateBuilderTodoGuard` (`objective-progress.js:5`).
pub fn validate_builder_todo_guard(value: Value) -> Result<Value, String> {
    if js::is_undefined(&value) {
        return Ok(value);
    }
    let field = |k: &str| if nullish(&value) { js::undefined() } else { prop(&value, k) };
    let counts = field("progressCounts");
    let invalid = !truthy(&value)
        || !["taskSetHash", "progressHash"].iter().all(|k| field(k).is_string() && hash(&field(k)))
        || num(&field("stagnantCount"))
            .filter(|n| n.fract() == 0.0)
            .is_none_or(|n| !(0.0..=2.0).contains(&n))
        || !truthy(&counts)
        || !record(&counts)
        || bad_counts(&counts);
    if invalid {
        Err("TypeError: Invalid Builder TODO continuation guard".into())
    } else {
        Ok(js::undefined())
    }
}

fn bad_rejection(entry: &Value) -> bool {
    let ids = prop(entry, "callIDs");
    !truthy(entry)
        || !hash(&prop(entry, "fingerprint"))
        || !prop(entry, "reason").as_str().is_some_and(|s| REASONS.contains(&s))
        || num(&prop(entry, "count"))
            .filter(|n| n.fract() == 0.0)
            .is_none_or(|n| !(1.0..=3.0).contains(&n))
        || ids
            .as_array()
            .is_none_or(|ids| ids.len() > 8 || ids.iter().any(|id| js::string_units(id).is_none_or(|u| u.is_empty() || u.len() > 256)))
        || !num(&prop(entry, "lastObservedAt")).is_some_and(f64::is_finite)
}

fn rejections(value: &Value) -> Result<Vec<Value>, String> {
    let value = if js::is_undefined(value) { Value::Array(Vec::new()) } else { value.clone() };
    match value {
        Value::Array(items) if items.len() <= 32 && !items.iter().any(bad_rejection) => Ok(items),
        _ => Err("TypeError: Invalid objective rejection receipts".into()),
    }
}

/// Port of `validateObjectiveRejections` (`objective-progress.js:15`).
pub fn validate_objective_rejections(value: Value) -> Result<Value, String> {
    rejections(&value).map(Value::Array)
}

/// Port of `applyObjectiveRejection` (`objective-progress.js:23`).
pub fn apply_objective_rejection(previous: Value, input: Value) -> Result<Value, String> {
    let mut receipts = rejections(&previous)?;
    let field = |k: &str| if nullish(&input) { js::undefined() } else { prop(&input, k) };
    let (fingerprint, reason, call, at) = (field("fingerprint"), field("reason"), field("callID"), field("at"));
    if !hash(&fingerprint)
        || !reason.as_str().is_some_and(|s| REASONS.contains(&s))
        || js::string_units(&call).is_none_or(|u| u.is_empty() || u.len() > 256)
        || !num(&at).is_some_and(f64::is_finite)
    {
        return Err("TypeError: Invalid pre-execution rejection".into());
    }
    let found = receipts
        .iter()
        .position(|e| eq(&prop(e, "fingerprint"), &fingerprint) && eq(&prop(e, "reason"), &reason));
    let (count, mut ids) = found.map_or((js::number(0.0), vec![]), |i| {
        (
            prop(&receipts[i], "count"),
            prop(&receipts[i], "callIDs").as_array().cloned().unwrap_or_default(),
        )
    });
    let count_n = num(&count).unwrap_or(f64::NAN);
    if found.is_some() && ids.iter().any(|id| eq(id, &call)) {
        return Ok(json!({ "receipts": receipts, "state": if count_n >= 3.0 { "blocked" } else { "duplicate" }, "count": count }));
    }
    if found.is_none() && receipts.len() >= 32 {
        return Ok(json!({ "receipts": receipts, "state": "tracking-capacity", "count": null }));
    }
    let next = (count_n + 1.0).min(3.0);
    ids.push(call);
    let tail = ids.len().saturating_sub(8);
    let receipt = json!({ "fingerprint": fingerprint, "reason": reason, "count": js::number(next), "callIDs": ids[tail..], "lastObservedAt": at });
    match found {
        Some(i) => receipts[i] = receipt,
        None => receipts.push(receipt),
    }
    let state = if next == 3.0 {
        "blocked"
    } else if next == 2.0 {
        "corrective-replan"
    } else {
        "correct-input"
    };
    Ok(json!({ "receipts": receipts, "state": state, "count": js::number(next) }))
}

fn bad_progress(value: &Value) -> bool {
    let seen = prop(value, "seen");
    let counts = prop(value, "counts");
    !truthy(value)
        || !num(&prop(value, "lastUsefulAt")).is_some_and(f64::is_finite)
        || seen.as_array().is_none_or(|s| s.len() > 128 || s.iter().any(|k| !hash(k)))
        || !truthy(&counts)
        || bad_counts(&counts)
}

/// Port of `validateObjectiveProgress` (`objective-progress.js:44`).
pub fn validate_objective_progress(value: Value) -> Result<Value, String> {
    if !js::is_undefined(&value) && bad_progress(&value) {
        return Err("TypeError: Invalid objective progress".into());
    }
    Ok(js::undefined())
}

/// Port of `applyObjectiveProgress` (`objective-progress.js:51`).
pub fn apply_objective_progress(previous: Value, arg1: Value) -> Result<Value, String> {
    if nullish(&arg1) {
        let (shown, kind) = if arg1.is_null() {
            ("object null", "null")
        } else {
            ("undefined", "undefined")
        };
        return Err(format!("TypeError: Cannot destructure property 'kind' of '{shown}' as it is {kind}."));
    }
    let (kind, fingerprint, at) = (prop(&arg1, "kind"), prop(&arg1, "fingerprint"), prop(&arg1, "at"));
    validate_objective_progress(previous.clone())?;
    if !kind.as_str().is_some_and(|s| KINDS.contains(&s)) || !hash(&fingerprint) || !num(&at).is_some_and(f64::is_finite) {
        return Err("TypeError: Invalid authoritative progress observation".into());
    }
    let have = !nullish(&previous);
    let seen = if have {
        prop(&previous, "seen").as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    if seen
        .iter()
        .any(|k| eq(k, &fingerprint) || (num(k).is_some_and(f64::is_nan) && num(&fingerprint).is_some_and(f64::is_nan)))
    {
        return Ok(previous);
    }
    let counts = if have { prop(&previous, "counts") } else { js::undefined() };
    let mut next = if nullish(&counts) { Map::new() } else { spread(&counts) };
    let key = kind.as_str().unwrap_or_default().to_string();
    let before = if have { num(&prop(&counts, &key)).unwrap_or(0.0) } else { 0.0 };
    next.insert(key, js::number((before + 1.0).min(9_007_199_254_740_991.0)));
    let mut seen = seen;
    seen.push(fingerprint);
    let tail = seen.len().saturating_sub(128);
    Ok(json!({ "lastUsefulAt": at, "counts": next, "seen": seen[tail..] }))
}

/// Port of `projectObjectiveProgress` (`objective-progress.js:60`).
pub fn project_objective_progress(value: Value) -> Result<Value, String> {
    let last = if nullish(&value) { Value::Null } else { prop(&value, "lastUsefulAt") };
    let counts = if truthy(&value) { spread(&prop(&value, "counts")) } else { Map::new() };
    let relevance = "structural-evidence; semantic task progress requires outcome grading";
    Ok(json!({ "policy": "report-only", "lastUsefulAt": if nullish(&last) { Value::Null } else { last }, "counts": counts, "relevance": relevance }))
}
