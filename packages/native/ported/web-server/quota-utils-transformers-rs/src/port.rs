//! The Rust port of `quota/utils/transformers.js` (5 of 6; `toTimestamp` rests on `Date.parse`,
//! V8's date-string heuristics). `Number(text)` and `3600 * x` use full JS `ToNumber`; the window
//! table is a plain object, so `unit: 'constructor'` finds a function and gives NaN.

#![forbid(unsafe_code)]

use serde_json::Value;

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

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JS `Number(text)`.
fn string_number(text: &str) -> f64 {
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |acc, c| c.to_digit(radix).map(|d| acc * f64::from(radix) + f64::from(d)))
                .unwrap_or(f64::NAN);
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        // recorded-literal: the JS numeric literal Number() accepts
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let (mantissa, exponent) = body.split_once(['e', 'E']).unwrap_or((body, "0"));
    let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if (int.is_empty() && frac.is_empty()) || !digits(int) || !digits(frac) || exponent.is_empty() || !digits(exponent) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Object.prototype` member names: a plain-object lookup finds them.
const OBJECT_PROTOTYPE: [&str; 12] = [
    "constructor",          // recorded-literal: an Object.prototype member name
    "__defineGetter__",     // recorded-literal: an Object.prototype member name
    "__defineSetter__",     // recorded-literal: an Object.prototype member name
    "hasOwnProperty",       // recorded-literal: an Object.prototype member name
    "__lookupGetter__",     // recorded-literal: an Object.prototype member name
    "__lookupSetter__",     // recorded-literal: an Object.prototype member name
    "isPrototypeOf",        // recorded-literal: an Object.prototype member name
    "propertyIsEnumerable", // recorded-literal: an Object.prototype member name
    "toString",             // recorded-literal: an Object.prototype member name
    "valueOf",              // recorded-literal: an Object.prototype member name
    "toLocaleString",       // recorded-literal: an Object.prototype member name
    "__proto__",            // recorded-literal: an Object.prototype member name
];

/// JS `ToNumber(value)`.
fn to_num(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::String(s) => string_number(s),
        Value::Array(_) => string_number(&key_of(value)),
        _ => js::as_number(value).unwrap_or(f64::NAN),
    }
}

/// `String(value)` as a property key.
fn key_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|v| if nullish(v) { String::new() } else { key_of(v) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(value) => "undefined".into(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
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

fn typeof_object(value: &Value) -> bool {
    value.is_array() || (value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value))
}

/// Port of `asObject` (`quota/utils/transformers.js:1`).
pub fn as_object(value: Value) -> Result<Value, String> {
    Ok(if truthy(&value) && typeof_object(&value) { value } else { Value::Null })
}

/// Port of `asNonEmptyString` (`quota/utils/transformers.js:3`).
pub fn as_non_empty_string(value: Value) -> Result<Value, String> {
    let Some(units) = js::string_units(&value) else { return Ok(Value::Null) };
    let space = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(js_space);
    let Some(start) = units.iter().position(|u| !space(u)) else {
        return Ok(Value::Null);
    };
    let end = units.iter().rposition(|u| !space(u)).map_or(start, |i| i + 1);
    Ok(js::utf16_string(&units[start..end]))
}

/// Port of `toNumber` (`quota/utils/transformers.js:9`).
pub fn to_number(value: Value) -> Result<Value, String> {
    if value.is_number() || value.get("$num").is_some() {
        return Ok(js::as_number(&value).filter(|n| n.is_finite()).map_or(Value::Null, |_| value));
    }
    if let Some(text) = value.as_str() {
        let parsed = string_number(text);
        return Ok(if parsed.is_finite() { js::number(parsed) } else { Value::Null });
    }
    if js::string_units(&value).is_some() {
        return Ok(Value::Null);
    }
    Ok(Value::Null)
}

/// Port of `normalizeTimestamp` (`quota/utils/transformers.js:33`).
pub fn normalize_timestamp(value: Value) -> Result<Value, String> {
    let Some(n) = js::as_number(&value).filter(|_| value.is_number() || value.get("$num").is_some()) else {
        return Ok(Value::Null);
    };
    Ok(js::number(if n < 1_000_000_000_000.0 { n * 1000.0 } else { n }))
}

/// Port of `resolveWindowSeconds` (`quota/utils/transformers.js:38`).
pub fn resolve_window_seconds(limit: Value) -> Result<Value, String> {
    if !truthy(&limit) {
        return Ok(Value::Null);
    }
    let number = field(&limit, "number");
    if !truthy(&number) {
        return Ok(Value::Null);
    }
    let unit = key_of(&field(&limit, "unit"));
    let seconds = match unit.as_str() {
        "3" => 3600.0,
        name if OBJECT_PROTOTYPE.contains(&name) => f64::NAN,
        _ => return Ok(Value::Null),
    };
    Ok(js::number(seconds * to_num(&number)))
}
