//! The Rust port of `opencode/runtime-host/native-compaction-policy.js`. A `Map` passes the
//! object test with no own fields; `-0` is a non-negative safe integer.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn is_object(value: &Value) -> bool {
    value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn opt(value: &Value, key: &str) -> Value {
    if value.is_null() || js::is_undefined(value) {
        js::undefined()
    } else {
        field(value, key)
    }
}

fn safe_int(value: &Value) -> Option<f64> {
    js::as_number(value)
        .filter(|_| value.is_number() || value.get("$num").is_some())
        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

/// Port of `nativeCompactionReserve` (`opencode/runtime-host/native-compaction-policy.js:2`).
pub fn native_compaction_reserve(location: Value) -> Result<Value, String> {
    let native_cfg = opt(&opt(&location, "configuration"), "compaction");
    let legacy_cfg = opt(&opt(&opt(&location, "compatibility"), "legacy"), "compaction");
    let native = if is_object(&native_cfg) {
        field(&native_cfg, "buffer")
    } else {
        js::undefined()
    };
    let legacy = if is_object(&legacy_cfg) {
        field(&legacy_cfg, "reserved")
    } else {
        js::undefined()
    };
    let value = if js::is_undefined(&native) { legacy } else { native };
    Ok(match safe_int(&value) {
        Some(n) if n >= 0.0 => value,
        _ => js::undefined(),
    })
}
