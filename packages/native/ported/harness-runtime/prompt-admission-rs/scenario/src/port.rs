//! The Rust port of the test wrapper `scenario-js/prompt-admission-scenario.js`: step sequences on
//! one `createPromptAdmissionController` controller of `prompt-admission.js`. Holds keep their
//! insertion order (the controller's `Map` keyed by a fresh `Symbol` per hold).

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

fn text(v: &Value) -> Option<String> {
    js::string_units(v).map(|u| String::from_utf16_lossy(&u))
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
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

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> Result<Value, String> {
    if nullish(v) {
        let kind = if v.is_null() { "null" } else { "undefined" };
        return Err(format!("TypeError: Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(prop(v, key))
}

/// `typeof v === "string" && v.trim() ? v.trim() : ""` (JS white space).
fn trimmed(v: &Value) -> String {
    text(v)
        .map(|t| t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string())
        .unwrap_or_default()
}

// ---- the unit ----

/// `normalizeBlock(name, value)`.
fn block(name: &str, value: &Value) -> Result<Value, String> {
    let value = if js::is_undefined(value) { Value::Object(Map::new()) } else { value.clone() };
    let pick = |key: &str, default: &str| Ok::<_, String>(Some(trimmed(&get(&value, key)?)).filter(|t| !t.is_empty()).unwrap_or_else(|| default.into()));
    let code = pick("code", "HARNESS_NOT_ACCEPTING_PROMPTS")?;
    let error = pick("error", "DevRyan is temporarily not accepting prompts")?;
    let retry = num(&prop(&value, "retryAfterSeconds"))
        .filter(|n| n.is_finite())
        .map_or(1.0, |n| n.floor().max(1.0));
    Ok(json!({ "name": name, "code": code, "error": error, "retryAfterSeconds": js::number(retry) }))
}

/// Port of `runPromptAdmission` (`prompt-admission-scenario.js:10`).
pub fn run_prompt_admission(steps: Value) -> Result<Value, String> {
    let Value::Array(steps) = steps else {
        get(&steps, "map")?;
        return Err("TypeError: steps.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let (mut ready, mut draining) = (false, false);
    let mut holds: Vec<(usize, Value)> = Vec::new();
    let mut released: Vec<bool> = Vec::new();
    let mut out = Vec::new();
    for step in &steps {
        let op = get(step, "op")?;
        let result = match op.as_str() {
            Some("acquire") => {
                let name = Some(trimmed(&prop(step, "name"))).filter(|n| !n.is_empty()).unwrap_or_else(|| "unnamed".into());
                holds.push((released.len(), block(&name, &prop(step, "block"))?));
                released.push(false);
                js::number((released.len() - 1) as f64)
            }
            Some("release") => {
                let hold = prop(step, "hold");
                let index = num(&hold)
                    .filter(|n| n.fract() == 0.0 && *n >= 0.0 && (*n as usize) < released.len())
                    .map(|n| n as usize);
                let index = match (index, js::string_units(&hold).map(|u| String::from_utf16_lossy(&u))) {
                    (Some(i), _) => i,
                    (None, Some(t)) if t.parse::<usize>().is_ok_and(|i| i.to_string() == t && i < released.len()) => t.parse().unwrap_or_default(),
                    _ => return Err("TypeError: releases[step.hold] is not a function".into()), // recorded-literal: the V8 TypeError text
                };
                let first = !released[index];
                released[index] = true;
                let before = holds.len();
                if first {
                    holds.retain(|(id, _)| *id != index);
                }
                Value::Bool(first && holds.len() < before)
            }
            Some("markReady") => {
                ready = true;
                js::undefined()
            }
            Some("beginDrain") => {
                draining = true;
                js::undefined()
            }
            Some("isReady") => Value::Bool(ready),
            _ => {
                let current = if !ready {
                    json!({ "name": "initializing", "code": "HARNESS_INITIALIZING", "error": "DevRyan harness is still initializing", "retryAfterSeconds": 1 })
                } else if draining {
                    json!({ "name": "draining", "code": "HARNESS_DRAINING", "error": "DevRyan is shutting down", "retryAfterSeconds": 1 })
                } else {
                    holds.first().map_or(Value::Null, |(_, b)| b.clone())
                };
                if op.as_str() == Some("isAccepting") {
                    Value::Bool(current.is_null())
                } else {
                    current
                }
            }
        };
        out.push(result);
    }
    Ok(Value::Array(out))
}
