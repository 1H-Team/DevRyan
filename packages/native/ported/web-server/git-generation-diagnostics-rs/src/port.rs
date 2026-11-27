//! The Rust port of `git/generation-diagnostics.js`: values pass through as given (`undefined`
//! fields stay as keys).

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

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

fn field(value: &Value, key: &str) -> Value {
    value
        .as_object()
        .filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
        .and_then(|o| o.get(key))
        .cloned()
        .unwrap_or_else(js::undefined)
}

fn object(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<Map<_, _>>())
}

fn or_null(value: Value) -> Value {
    if truthy(&value) { value } else { Value::Null }
}

/// Port of `buildGitGenerationTimingRecord` (`git/generation-diagnostics.js:2`).
pub fn build_git_generation_timing_record(req: Value, payload: Value) -> Result<Value, String> {
    let principal = if nullish(&req) { js::undefined() } else { field(&req, "principal") };
    let id = if nullish(&principal) { js::undefined() } else { field(&principal, "id") };
    let actor = if truthy(&id) {
        object(vec![
            ("id", id),
            ("role", or_null(field(&principal, "role"))),
            ("scope", or_null(field(&principal, "scope"))),
        ])
    } else {
        Value::Null
    };
    if nullish(&payload) {
        let kind = if payload.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading 'event')")); // recorded-literal: V8 TypeError text
    }
    let p = |k: &str| field(&payload, k);
    let stage = |phase: &str, key: &str| object(vec![("phase", Value::String(phase.into())), ("durationMs", p(key))]);
    let scope = if p("stagedOnly") == Value::Bool(true) {
        "staged-only"
    } else {
        "staged-and-unstaged"
    };
    Ok(object(vec![
        ("type", Value::String("timing".into())),
        ("actor", actor),
        ("mark", p("event")),
        (
            "payload",
            object(vec![
                ("durationMs", p("totalMs")),
                (
                    "stages",
                    Value::Array(vec![
                        stage("context", "contextMs"),
                        stage("model", "modelMs"),
                        stage("provider", "providerMs"),
                        stage("parsing", "parseMs"),
                    ]),
                ),
                ("count", p("selectedFileCount")),
                ("scope", Value::String(scope.into())),
                ("outcome", p("outcome")),
                ("model", p("model")),
                ("state", p("catalogState")),
                ("retry", Value::Bool(p("retried") == Value::Bool(true))),
                ("source", p("source")),
                ("reason", p("providerOutcome")),
                ("attempt", p("attempt")),
                ("statusCode", p("statusCode")),
            ]),
        ),
    ]))
}
