//! JavaScript operators on `Value`: property reads, `typeof`, truthiness,
//! the equality algorithms, `Number` predicates, spread, `JSON.stringify`.
//!
//! A `Value` is a tree: it has no object identity. Wherever the JavaScript
//! compares two objects by reference (`===`, `Object.is`, `Set`/`Map` keys),
//! these helpers refuse (`Failure::Unsupported`) instead of guessing, unless the
//! caller supplies the identity (transitions.rs).

use devryan_js_layer::js::{self, JsObject, JsStr, Value};

use crate::error::{Failure, JsResult, type_error, unsupported};

pub static UNDEFINED: Value = Value::Undefined;
pub static NULL: Value = Value::Null;
pub static EMPTY_ARRAY: Value = Value::Array(Vec::new());
pub static FALSE: Value = Value::Bool(false);

/// `value[key]` for an own data property of a plain object; `undefined` for a
/// missing one and on every other value. (No key the policies read is a
/// property of `Object.prototype` or of a primitive's prototype.)
pub fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    match value {
        Value::Object(object) => object.get_str(key).unwrap_or(&UNDEFINED),
        _ => &UNDEFINED,
    }
}

/// `value.key` where the JavaScript does not guard with `?.`: reading a
/// property of `null` or `undefined` throws V8's TypeError.
pub fn read<'a>(value: &'a Value, key: &str) -> JsResult<&'a Value> {
    match value {
        Value::Null | Value::Undefined => {
            let what = if matches!(value, Value::Null) { "null" } else { "undefined" };
            type_error(format!("Cannot read properties of {what} (reading '{key}')"))
        }
        _ => Ok(get(value, key)),
    }
}

/// `Object.hasOwn(value, key)` for an object.
pub fn has_own(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|object| object.get_str(key).is_some())
}

/// `Boolean(value) && typeof value === 'object' && !Array.isArray(value)`.
pub fn is_record(value: &Value) -> bool {
    matches!(value, Value::Object(_))
}

/// `Boolean(value)`.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Undefined | Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => !(*value == 0.0 || value.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value === undefined || value === null`.
pub fn is_nullish(value: &Value) -> bool {
    matches!(value, Value::Undefined | Value::Null)
}

/// `a ?? b`.
pub fn nullish_or<'a>(value: &'a Value, fallback: &'a Value) -> &'a Value {
    if is_nullish(value) { fallback } else { value }
}

pub fn is_string(value: &Value) -> bool {
    matches!(value, Value::String(_))
}

pub fn as_str(value: &Value) -> Option<&JsStr> {
    match value {
        Value::String(text) => Some(text),
        _ => None,
    }
}

pub fn as_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => Some(*number),
        _ => None,
    }
}

/// `value === 'text'`.
pub fn is_str(value: &Value, text: &str) -> bool {
    as_str(value).is_some_and(|value| value == text)
}

/// `[...].includes(value)` over string literals (SameValueZero).
pub fn is_one_of(value: &Value, list: &[&str]) -> bool {
    as_str(value).is_some_and(|value| list.iter().any(|item| value == *item))
}

/// `Number.isFinite(value)`.
pub fn is_finite(value: &Value) -> bool {
    as_number(value).is_some_and(f64::is_finite)
}

/// `Number.isSafeInteger(value)`.
pub fn is_safe_integer(value: &Value) -> bool {
    as_number(value).is_some_and(|number| number.is_finite() && number.trunc() == number && number.abs() <= 9_007_199_254_740_991.0)
}

/// `Object.is(a, b)` (SameValue) for two values that are not both objects.
pub fn same_value(left: &Value, right: &Value) -> JsResult<bool> {
    Ok(match (left, right) {
        (Value::Number(a), Value::Number(b)) => (a.is_nan() && b.is_nan()) || (a == b && a.is_sign_negative() == b.is_sign_negative()),
        (Value::Array(_) | Value::Object(_), Value::Array(_) | Value::Object(_)) => return unsupported("object identity (Object.is)"),
        _ => scalar_equal(left, right),
    })
}

/// `a === b` for two values that are not both objects.
pub fn strict_equal(left: &Value, right: &Value) -> JsResult<bool> {
    Ok(match (left, right) {
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::Array(_) | Value::Object(_), Value::Array(_) | Value::Object(_)) => return unsupported("object identity (===)"),
        _ => scalar_equal(left, right),
    })
}

fn scalar_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        _ => false,
    }
}

/// `typeof value === 'object'` (null included, arrays included).
pub fn is_typeof_object(value: &Value) -> bool {
    matches!(value, Value::Null | Value::Array(_) | Value::Object(_))
}

/// `ToNumber` of a primitive that is not a string (`undefined` is NaN,
/// `null` 0, booleans 0 and 1). Strings and objects are refused: no policy
/// input that reaches arithmetic or a relational operator holds one.
pub fn to_number(value: &Value) -> JsResult<f64> {
    match value {
        Value::Number(number) => Ok(*number),
        Value::Undefined => Ok(f64::NAN),
        Value::Null => Ok(0.0),
        Value::Bool(value) => Ok(if *value { 1.0 } else { 0.0 }),
        Value::String(_) | Value::Array(_) | Value::Object(_) => unsupported("ToNumber of a string or object"),
    }
}

/// `Math.max(...values)` with its NaN and signed-zero rules.
pub fn math_max(values: &[f64]) -> f64 {
    let mut result = f64::NEG_INFINITY;
    for value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if *value > result || (*value == 0.0 && result == 0.0 && result.is_sign_negative()) {
            result = *value;
        }
    }
    result
}

/// `Math.min(...values)` with its NaN and signed-zero rules.
pub fn math_min(values: &[f64]) -> f64 {
    let mut result = f64::INFINITY;
    for value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if *value < result || (*value == 0.0 && result == 0.0 && value.is_sign_negative()) {
            result = *value;
        }
    }
    result
}

/// `{ ...value }`: the own enumerable properties, as an object literal copies
/// them (a string spreads its code units by index, an array its elements).
pub fn spread(value: &Value) -> JsObject {
    let mut object = JsObject::new();
    match value {
        Value::Object(source) => {
            for (key, item) in source.iter() {
                object.insert(key, item.clone());
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                object.insert(JsStr::from(index.to_string()), item.clone());
            }
        }
        Value::String(text) => {
            for (index, unit) in text.units().iter().enumerate() {
                object.insert(JsStr::from(index.to_string()), Value::String(JsStr::from_units(vec![*unit])));
            }
        }
        _ => {}
    }
    object
}

/// `Object.keys(object)` of a plain object.
pub fn keys(value: &Value) -> Vec<JsStr> {
    value.as_object().map(JsObject::keys).unwrap_or_default()
}

/// `JSON.stringify(value)` as UTF-8 bytes; `None` for `undefined`. Values
/// nested deeper than the JSON layer's bound are refused.
pub fn stringify(value: &Value) -> JsResult<Option<Vec<u8>>> {
    js::stringify_utf8(value).map_err(|_| Failure::Unsupported("JSON nesting deeper than the JSON layer's bound"))
}

/// `JSON.stringify(value)` where the value is never `undefined`.
pub fn stringify_text(value: &Value) -> JsResult<Vec<u8>> {
    Ok(stringify(value)?.unwrap_or_default())
}

/// `new TextEncoder().encode(JSON.stringify(value)).length` for a value that
/// is not `undefined` (every caller passes an array or an object).
pub fn json_byte_length(value: &Value) -> JsResult<u64> {
    Ok(stringify_text(value)?.len() as u64)
}

/// `JSON.stringify(a) === JSON.stringify(b)` (undefined equals undefined).
pub fn json_equal(left: &Value, right: &Value) -> JsResult<bool> {
    Ok(stringify(left)? == stringify(right)?)
}

/// `String(value)` / a template literal's `${value}`. An object with an own
/// `toString` or `valueOf` property (here never a function) would change
/// `ToPrimitive`, so such a value is refused.
pub fn to_string(value: &Value) -> JsResult<JsStr> {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Object(object) if object.get_str("toString").is_some() || object.get_str("valueOf").is_some() => {
                return unsupported("ToString of an object with its own toString or valueOf");
            }
            Value::Array(items) => pending.extend(items.iter()),
            _ => {}
        }
    }
    Ok(value.to_js_string())
}

/// An object from `(key, value)` pairs in literal order.
pub fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.set(key, value);
    }
    Value::Object(object)
}

/// A string value from units.
pub fn string_units(units: Vec<u16>) -> Value {
    Value::String(JsStr::from_units(units))
}

/// The number of elements of an array value.
pub fn array_len(value: &Value) -> Option<usize> {
    value.as_array().map(<[Value]>::len)
}

/// Nesting depth of a value (`[]` is 1), walked iteratively.
pub fn depth(value: &Value) -> usize {
    let mut deepest = 0;
    let mut pending = vec![(value, 1usize)];
    while let Some((value, level)) = pending.pop() {
        match value {
            Value::Array(items) => {
                deepest = deepest.max(level);
                pending.extend(items.iter().map(|item| (item, level + 1)));
            }
            Value::Object(object) => {
                deepest = deepest.max(level);
                pending.extend(object.values().map(|item| (item, level + 1)));
            }
            _ => {}
        }
    }
    deepest
}
