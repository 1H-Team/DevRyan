//! The Rust port of `startup/readiness.ts`'s pure snapshot functions, over any JS value. The
//! performance-mark writer, the async recovery and health pollers, the health parser (over
//! `@devryan/shared-runtime`) and the warmups stay in TS. `{ ...snapshot, [phase]: ... }` keeps
//! JS key order (array-index keys first; a replaced key keeps its place).

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

const PHASES: [&str; 10] = [
    "health",
    "providers",
    "agents",
    "initialization",
    "globalSync",
    "directorySync",
    "sessionList",
    "eventStream",
    "responseStyle",
    "worktree",
];

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// JS truthiness of a value received from JS.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
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

/// A plain JS object (not an array, nor a marker for a string, number, `undefined`, `Map` or `Set`).
fn is_plain(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        !(o.len() == 1
            && ["$undefined", "$num", "$utf16", "$map", "$set", "$bytes", "$function"]
                .iter()
                .any(|k| o.contains_key(*k)))
    })
}

/// `value.key` of a non-nullish value: own properties of plain objects, else `undefined`.
fn field(value: &Value, key: &str) -> Value {
    if !is_plain(value) {
        return js::undefined();
    }
    value.get(key).cloned().unwrap_or_else(js::undefined)
}

/// `value.key`, failing as V8 does on `null` and `undefined`.
fn get(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
}

/// `value?.key`.
fn opt(value: &Value, key: &str) -> Value {
    if nullish(value) { js::undefined() } else { field(value, key) }
}

/// Whether `key` is a JS array index (canonical decimal below 2^32 - 1).
fn index_key(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// `Object.entries(value)` of a non-nullish value, in JS order (array-index keys first).
fn entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::String(text) => text.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), js::utf16_string(&[u]))).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::Object(map) if is_plain(value) => {
            let mut indexes: Vec<(u32, &String)> = map.keys().filter_map(|k| index_key(k).map(|n| (n, k))).collect();
            indexes.sort_unstable();
            let mut keys: Vec<&String> = indexes.into_iter().map(|(_, k)| k).collect();
            keys.extend(map.keys().filter(|k| index_key(k).is_none()));
            keys.into_iter().map(|k| (k.clone(), map[k].clone())).collect()
        }
        _ => Vec::new(),
    }
}

/// JS `String(value)` as UTF-16 code units (`element` for an array member: `null`/`undefined`
/// print empty).
fn js_string(value: &Value, element: bool) -> Vec<u16> {
    if let Some(units) = js::string_units(value) {
        return units;
    }
    let single = |key: &str| value.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(key));
    let text = match value {
        _ if js::is_undefined(value) => {
            if element {
                String::new()
            } else {
                "undefined".into()
            }
        }
        Value::Null => {
            if element {
                String::new()
            } else {
                "null".into()
            }
        }
        Value::Bool(flag) => flag.to_string(),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(|v| String::from_utf16_lossy(&js_string(v, true))).collect();
            parts.join(",")
        }
        _ if single("$map") => "[object Map]".into(),
        _ if single("$set") => "[object Set]".into(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    text.encode_utf16().collect()
}

/// Keys in JS order: array indexes ascending, then insertion order.
fn js_order(map: Map<String, Value>) -> Map<String, Value> {
    let mut indexed: Vec<(u32, String, Value)> = Vec::new();
    let mut rest = Map::new();
    for (key, value) in map {
        match index_key(&key) {
            Some(n) => indexed.push((n, key, value)),
            None => {
                rest.insert(key, value);
            }
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

/// `clonePhase`.
fn clone_phase(phase: &Value) -> Result<Value, String> {
    let status = get(phase, "status")?;
    let error = field(phase, "error");
    Ok(json!({ "status": status, "error": if nullish(&error) { Value::Null } else { error } }))
}

fn with_phase(snapshot: &Value, phase: &Value, next: &Value) -> Result<Value, String> {
    let mut map: Map<String, Value> = if nullish(snapshot) {
        Map::new()
    } else {
        entries(snapshot).into_iter().collect()
    };
    let key = String::from_utf16_lossy(&js_string(phase, false));
    let cloned = clone_phase(next)?;
    map.insert(key, cloned);
    Ok(Value::Object(js_order(map)))
}

fn describe_failure(error: &Value) -> Result<String, String> {
    if nullish(error) {
        return Ok("DevRyan could not connect to OpenCode.".into());
    }
    let Some(text) = error.as_str() else {
        return Err("openCodeError?.trim is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let detail = text.trim_matches(js_space);
    Ok(if detail.is_empty() {
        "DevRyan could not connect to OpenCode.".into()
    } else {
        format!("DevRyan could not connect to OpenCode: {detail}")
    })
}

/// Port of `createStartupReadinessSnapshot` (`startup/readiness.ts:80`).
pub fn create_startup_readiness_snapshot(status: Value) -> Result<Value, String> {
    let status = if js::is_undefined(&status) { Value::String("idle".into()) } else { status };
    Ok(Value::Object(
        PHASES.iter().map(|p| ((*p).to_string(), json!({ "status": status, "error": null }))).collect(),
    ))
}

/// Port of `withStartupReadinessPhase` (`startup/readiness.ts:87`).
pub fn with_startup_readiness_phase(snapshot: Value, phase: Value, next: Value) -> Result<Value, String> {
    with_phase(&snapshot, &phase, &next)
}

/// Port of `withStartupBootstrapReadiness` (`startup/readiness.ts:103`).
pub fn with_startup_bootstrap_readiness(snapshot: Value, readiness: Value) -> Result<Value, String> {
    let boot = truthy(&get(&readiness, "desktopBootReady")?);
    let flag = |k: &str| truthy(&field(&readiness, k));
    let health_ready = boot && flag("isConnected") && !(flag("retriesExhausted") && flag("openCodeError"));
    let health = if health_ready {
        json!({ "status": "ready" })
    } else if boot && flag("retriesExhausted") {
        json!({ "status": "error", "error": describe_failure(&field(&readiness, "openCodeError"))? })
    } else {
        json!({ "status": "loading" })
    };
    let next = with_phase(&snapshot, &Value::String("health".into()), &health)?;
    let next = with_phase(&next, &Value::String("providers".into()), &field(&readiness, "providers"))?;
    let next = with_phase(&next, &Value::String("agents".into()), &field(&readiness, "agents"))?;
    let initialization = if flag("isInitialized") {
        json!({ "status": "ready" })
    } else {
        let init = field(&readiness, "initialization");
        if get(&init, "status")?.as_str() == Some("error") {
            init
        } else {
            json!({ "status": "loading" })
        }
    };
    with_phase(&next, &Value::String("initialization".into()), &initialization)
}

/// Port of `summarizeStartupReadiness` (`startup/readiness.ts:125`).
pub fn summarize_startup_readiness(snapshot: Value, options: Value) -> Result<Value, String> {
    if matches!(opt(&options, "route").as_str(), Some("desktop-chooser" | "desktop-recovery")) {
        return Ok(json!({ "ready": true }));
    }
    for phase in PHASES {
        let item = get(&snapshot, phase)?;
        let status = get(&item, "status")?;
        if status.as_str() == Some("error") {
            let error = field(&item, "error");
            let error = if truthy(&error) { error } else { Value::String("Startup failed.".into()) };
            return Ok(json!({ "ready": false, "phase": phase, "status": status, "error": error }));
        }
        if status.as_str() != Some("ready") {
            return Ok(json!({ "ready": false, "phase": phase, "status": status }));
        }
    }
    Ok(json!({ "ready": true }))
}

/// Port of `shouldShowStartupReadinessScreen` (`startup/readiness.ts:151`).
pub fn should_show_startup_readiness_screen(summary: Value, has_completed_startup: Value) -> Result<bool, String> {
    if truthy(&has_completed_startup) {
        return Ok(false);
    }
    Ok(!truthy(&get(&summary, "ready")?))
}

/// Port of `shouldRestartOpenCodeForStartupRecovery` (`startup/readiness.ts:156`).
pub fn should_restart_open_code_for_startup_recovery(health: Value) -> Result<bool, String> {
    if !truthy(&health) {
        return Ok(false);
    }
    let no = Value::Bool(false);
    if field(&health, "openCodeRunning") == no || field(&health, "isOpenCodeReady") == no {
        return Ok(true);
    }
    Ok(field(&health, "lastOpenCodeError")
        .as_str()
        .is_some_and(|e| !e.trim_matches(js_space).is_empty()))
}
