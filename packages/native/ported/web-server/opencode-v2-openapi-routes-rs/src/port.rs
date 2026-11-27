//! The Rust port of `opencode/v2/openapi-routes.js` (1 of 3): `openCodeV2RouteKey`.
//! `extractOpenCodeV2Operations` and `renderOpenCodeV2RoutesModule` throw a product `TypeError`
//! the bindings cannot reproduce (they throw plain `Error`), and stay in JS.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// `String(value)` as UTF-16 units.
fn text(value: &Value) -> Vec<u16> {
    if let Some(u) = js::string_units(value) {
        return u;
    }
    let single = value.as_object().filter(|o| o.len() == 1).and_then(|o| o.keys().next()).map(String::as_str);
    let s = match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => {
            return items
                .iter()
                .map(|v| if v.is_null() || js::is_undefined(v) { Vec::new() } else { text(v) })
                .collect::<Vec<_>>()
                .join(&[0x2c][..]);
        }
        _ if js::is_undefined(value) => "undefined".to_string(),
        _ if single == Some("$map") => "[object Map]".into(),
        _ if single == Some("$set") => "[object Set]".into(),
        _ if single == Some("$bigint") => value["$bigint"].as_str().unwrap_or_default().to_string(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    s.encode_utf16().collect()
}

/// Port of `openCodeV2RouteKey` (`openapi-routes.js:73`).
pub fn open_code_v2_route_key(method: Value, template: Value) -> Result<Value, String> {
    Ok(js::utf16_string(&[text(&method), vec![0x20], text(&template)].concat()))
}
