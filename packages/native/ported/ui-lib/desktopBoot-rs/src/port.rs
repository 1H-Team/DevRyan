//! The Rust port of `desktopBoot.ts`: the view resolver and the two loading gates, over any JS
//! value. The two readers of `window.__DEVRYAN_DESKTOP_BOOT_OUTCOME__` stay in TS. The gates
//! return the operand JS returns (`state.isInitialized` as given; `isTauriShell && ...`).

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
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
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

fn view(pairs: &[(&str, Value)]) -> Value {
    Value::Object(pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect::<Map<_, _>>())
}

fn text(value: &str) -> Value {
    Value::String(value.into())
}

/// Port of `resolveDesktopBootView` (`desktopBoot.ts:156`).
pub fn resolve_desktop_boot_view(input: Value) -> Result<Value, String> {
    if !truthy(&get(&input, "isDesktopShell")?) {
        return Ok(Value::Null);
    }
    let outcome = field(&input, "bootOutcome");
    if !truthy(&outcome) {
        return Ok(Value::Null);
    }
    let status = field(&outcome, "status");
    let target = field(&outcome, "target");
    let (status, target_name) = (status.as_str(), target.as_str());
    let host = || field(&outcome, "hostId");
    let url = || field(&outcome, "url");
    if status == Some("ok") {
        match target_name {
            Some("local") => return Ok(view(&[("screen", text("main"))])),
            Some("remote") => return Ok(view(&[("screen", text("main")), ("hostId", host()), ("url", url())])),
            _ => {}
        }
    }
    if target.is_null() && status == Some("not-configured") {
        return Ok(view(&[("screen", text("chooser"))]));
    }
    if target_name == Some("local") && status == Some("unreachable") {
        return Ok(view(&[("screen", text("recovery")), ("variant", text("local-unavailable"))]));
    }
    if target_name == Some("remote") {
        let recovery = |variant: &str, with_url: bool| {
            let mut pairs = vec![("screen", text("recovery")), ("variant", text(variant)), ("hostId", host())];
            if with_url {
                pairs.push(("url", url()));
            }
            view(&pairs)
        };
        match status {
            Some("unreachable") => return Ok(recovery("remote-unreachable", true)),
            Some("wrong-service") => return Ok(recovery("remote-wrong-service", true)),
            Some("missing") => return Ok(recovery("remote-missing", false)),
            _ => {}
        }
    }
    Ok(Value::Null)
}

/// Port of `canDismissInitialLoading` (`desktopBoot.ts:235`).
pub fn can_dismiss_initial_loading(state: Value) -> Result<Value, String> {
    if !truthy(&get(&state, "isDesktopShell")?) {
        return Ok(field(&state, "isInitialized"));
    }
    if !truthy(&field(&state, "bootOutcomeKnown")) {
        return Ok(Value::Bool(false));
    }
    if field(&state, "bootViewIsMain") == Value::Bool(false) {
        return Ok(Value::Bool(true));
    }
    Ok(field(&state, "isInitialized"))
}

/// Port of `shouldRestartDesktopBootFlow` (`desktopBoot.ts:257`).
pub fn should_restart_desktop_boot_flow(input: Value) -> Result<Value, String> {
    let tauri = get(&input, "isTauriShell")?;
    if !truthy(&tauri) {
        return Ok(tauri);
    }
    Ok(Value::Bool(!truthy(&field(&input, "isDesktopLocalOriginActive"))))
}
