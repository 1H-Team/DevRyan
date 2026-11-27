//! The Rust port of `opencode/runtime-host/runtime-bundle-root.js`: `resolveRuntimeBundleRoot` (the
//! binding reader calls its callbacks). Node's POSIX `path`; the refusal is a product `Error`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// Node's POSIX `path.normalize`.
fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|l| *l != "..") {
                    stack.pop();
                } else if !absolute {
                    stack.push("..");
                }
            }
            s => stack.push(s),
        }
    }
    let mut out = stack.join("/");
    if out.is_empty() && !absolute {
        out = ".".into();
    }
    if trailing && !stack.is_empty() {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

const REFUSED: &str = "bundle_recovery_owner_required";

/// `absolute(value)`.
fn absolute(value: &Value) -> Result<String, String> {
    match value.as_str() {
        Some(p) if p.starts_with('/') && normalize(p) == p && !p.chars().any(|c| c <= '\u{1f}') => Ok(p.to_string()),
        _ => Err(REFUSED.into()),
    }
}

fn read(environment: &Value, key: &str) -> Result<Value, String> {
    if environment.is_null() || js::is_undefined(environment) {
        let kind = if environment.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(environment
        .as_object()
        .and_then(|o| o.get(key))
        .cloned()
        .filter(|_| js::string_units(environment).is_none())
        .unwrap_or_else(js::undefined))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// Port of `resolveRuntimeBundleRoot` (`opencode/runtime-host/runtime-bundle-root.js:10`).
pub fn resolve_runtime_bundle_root(environment: Value, home: Value) -> Result<Value, String> {
    let explicit = read(&environment, "DEVRYAN_RUNTIME_BUNDLE_ROOT")?;
    if !js::is_undefined(&explicit) {
        return Ok(Value::String(absolute(&explicit)?));
    }
    let xdg = read(&environment, "XDG_STATE_HOME")?;
    let state = if truthy(&xdg) {
        absolute(&xdg)?
    } else {
        let home = absolute(&home)?;
        absolute(&Value::String(normalize(&format!("{home}/.local/state"))))?
    };
    Ok(Value::String(normalize(&format!("{state}/devryan/runtime-bundles"))))
}
