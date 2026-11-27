//! The Rust port of `opencode/runtime-host/native-provider-deadlines.js`. Object spread is
//! written out: a string spreads one key per UTF-16 unit, an array (or bytes) its indexes, a
//! `Map`, `Set`, `Date`, number or boolean nothing; the result keeps JS key order (index keys
//! first). `PROVIDER_DEADLINES[id]` is a frozen `{}`: even its inherited members spread nothing.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn exempt(id: &Value) -> bool {
    id.as_str() == Some("claude-agent")
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

/// `{...value}` merged into `out`.
fn spread(out: &mut Map<String, Value>, value: &Value) {
    let items: Vec<Value> = match (js::string_units(value), value) {
        (Some(units), _) => units.iter().map(|u| js::utf16_string(&[*u])).collect(),
        (_, Value::Array(items)) => items.clone(),
        (_, Value::Object(o)) if plain(value).is_none() => o.get("$bytes").and_then(Value::as_array).cloned().unwrap_or_default(),
        (_, Value::Object(o)) => return out.extend(o.clone()),
        _ => Vec::new(),
    };
    out.extend(items.into_iter().enumerate().map(|(i, v)| (i.to_string(), v)));
}

/// An object's keys in JS order: array indexes ascending, then insertion order.
fn js_order(map: Map<String, Value>) -> Value {
    let index = |k: &str| k.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == k);
    let (mut indexed, rest): (Vec<_>, Vec<_>) = map.into_iter().partition(|(k, _)| index(k).is_some());
    indexed.sort_by_key(|(k, _)| index(k));
    Value::Object(indexed.into_iter().chain(rest).collect())
}

/// A value handed back unchanged; a number marker crosses back as a number.
fn same(value: Value) -> Value {
    js::as_number(&value).map_or(value, js::number)
}

/// Port of `nativeProviderDeadlines` (`native-provider-deadlines.js:22`).
pub fn native_provider_deadlines(id: Value, settings: Value) -> Result<Value, String> {
    if exempt(&id) {
        return Ok(same(settings));
    }
    let mut out = Map::from_iter([("headerTimeout".into(), 45_000.into()), ("chunkTimeout".into(), 300_000.into())]);
    spread(&mut out, &settings);
    Ok(js_order(out))
}

/// Port of `withNativeProviderDeadlines` (`native-provider-deadlines.js:26`).
pub fn with_native_provider_deadlines(id: Value, provider: Value) -> Result<Value, String> {
    if provider.is_null() || js::is_undefined(&provider) {
        let shown = if provider.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {shown} (reading 'settings')")); // recorded-literal: V8 TypeError text
    }
    let own = plain(&provider).and_then(|o| o.get("settings").cloned()).unwrap_or_else(js::undefined);
    let settings = native_provider_deadlines(id, own)?;
    if js::is_undefined(&settings) {
        return Ok(same(provider));
    }
    let mut out = Map::new();
    spread(&mut out, &provider);
    out.insert("settings".into(), settings);
    Ok(js_order(out))
}

/// Port of `nativeRequestHeaderDeadline` (`native-provider-deadlines.js:41`): `!==` on bridge values,
/// where two objects are never the same reference.
pub fn native_request_header_deadline(provider_id: Value, configured: Value, core_default: Value) -> Result<Value, String> {
    let equal = match (js::as_number(&configured), js::as_number(&core_default)) {
        (Some(a), Some(b)) => a == b,
        (None, None) => {
            configured == core_default
                && (!configured.is_object() && !configured.is_array() || js::string_units(&configured).is_some() || js::is_undefined(&configured))
        }
        _ => false,
    };
    let kept = exempt(&provider_id) || (!js::is_undefined(&configured) && !equal);
    Ok(if kept { js::undefined() } else { 45_000.into() })
}
