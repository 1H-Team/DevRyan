//! The Rust port of `ui-auth/session-cookie.js`: `requestUiSessionCookieName`. It reaches
//! `uiSessionCookieName` only with a valid port, so it never throws; `uiSessionCookieName` itself
//! throws a `TypeError`, which the bindings cannot reproduce (they throw plain `Error`), and stays
//! in JavaScript.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

/// Port of `requestUiSessionCookieName` (`ui-auth/session-cookie.js:9`).
pub fn request_ui_session_cookie_name(req: Value) -> Result<Value, String> {
    let socket = field(&req, "socket");
    let port = field(&socket, "localPort");
    let valid =
        (port.is_number() || port.get("$num").is_some()) && js::as_number(&port).is_some_and(|p| p.is_finite() && p.fract() == 0.0 && p > 0.0 && p <= 65535.0);
    Ok(match js::as_number(&port).filter(|_| valid) {
        Some(p) => Value::String(format!("oc_ui_session_{}", js::number_to_string(p))),
        None => Value::Null,
    })
}
