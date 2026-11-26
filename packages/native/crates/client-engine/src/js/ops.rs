//! The JavaScript operations the ported families perform, as the TypeScript
//! does them under V8 (the product's renderer; where V8 and JavaScriptCore
//! agree, either): property reads on any value, `typeof`, truthiness, `===`,
//! `<`, `ToString`, `ToNumber`, spreads, `Object.keys`, `in`, and
//! `JSON.stringify`. An error the JavaScript engine would throw itself is
//! thrown at the same point with the same class and a text of this engine's
//! own (`client-engine: ...`): the harness compares an engine-written error's
//! class, never its message (candidate-compare.mjs, the `engine-message`
//! freedom), and a message the module's code builds exactly.

use super::number;
use super::string::concat;
use super::value::{Kind, Obj, Props, Proto, Str, Value, array_index, s};

/// A thrown value.
pub type Thrown = Value;
/// What a JavaScript expression gives: a value, or what it threw.
pub type Js<T = Value> = Result<T, Thrown>;

/// The members of `Object.prototype` (what `in` and a read find on a plain object without an own member).
const OBJECT_PROTOTYPE: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// A new error of a built-in class (`TypeError`, ...) with this message.
pub fn error(class: &str, message: &str) -> Value {
    Value::Object(Obj::new(
        Kind::Error {
            class: s(class),
            name: s(class),
            message: s(message),
            cause: None,
        },
        Props::default(),
    ))
}

/// The TypeError an engine throws for a member read on `null` or `undefined` (`expression`: the source's, for the reader).
pub fn not_an_object(base: &Value, expression: &str) -> Value {
    let what = if matches!(base, Value::Null) { "null" } else { "undefined" };
    error("TypeError", &format!("client-engine: {what} has no members ({expression})"))
}

pub fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Undefined => "undefined",
        Value::Null => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Object(object) if object.is_function() => "function",
        Value::Object(_) => "object",
    }
}

/// `typeof value === "object" && value !== null` (no function).
pub fn is_object(value: &Value) -> bool {
    matches!(value, Value::Object(object) if !object.is_function())
}

/// `Boolean(value)`.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Undefined | Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) if crate::plant::on("rv-truthy-negative-zero") && *value == 0.0 && value.is_sign_negative() => true,
        Value::Number(value) => *value != 0.0 && !value.is_nan(),
        Value::String(text) => !text.is_empty(),
        Value::Object(_) => true,
    }
}

/// `left === right`.
pub fn strict_equals(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a == b || (crate::plant::on("rv-eq-nan") && a.is_nan() && b.is_nan()),
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Object(a), Value::Object(b)) => a.same(b),
        _ => false,
    }
}

/// SameValueZero (Map keys, Set members, `includes`).
pub fn same_value_zero(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a == b || (a.is_nan() && b.is_nan()),
        _ => strict_equals(left, right),
    }
}

/// `ToString(value)` for what the families stringify (`join`, template literals).
pub fn to_string(value: &Value) -> Js<Str> {
    Ok(match value {
        Value::Undefined => s("undefined"),
        Value::Null => s("null"),
        Value::Bool(value) => s(if *value { "true" } else { "false" }),
        Value::Number(value) => s(&number::to_string(*value)),
        Value::String(text) => text.clone(),
        Value::Object(object) => {
            if object.is_array() {
                return join(object, &s(","));
            }
            let data = object.borrow();
            // OrdinaryToPrimitive (hint string): an own `toString` or `valueOf` that is no function is passed over; one
            // that is a function the engine cannot call (a port the test handed in) is refused.
            let own = |key: &str| data.props.get(&s(key)).cloned();
            let callable = |value: &Option<Value>| matches!(value, Some(Value::Object(object)) if object.is_function());
            let (own_to_string, own_value_of) = (own("toString"), own("valueOf"));
            if callable(&own_to_string) || (own_to_string.is_some() && callable(&own_value_of)) {
                return Err(error("TypeError", "client-engine: a primitive from a function member is not reproduced"));
            }
            if own_to_string.is_some() && !matches!(data.kind, Kind::Object(Proto::Null)) {
                // `toString` is no function: `valueOf` (Object.prototype's gives the object itself) gives no primitive.
                return Err(error("TypeError", "client-engine: an object with no callable toString has no primitive value"));
            }
            match &data.kind {
                Kind::Date(time) => s(&super::date::to_string(*time)),
                Kind::Error { name, message, .. } => {
                    if message.is_empty() {
                        name.clone()
                    } else if name.is_empty() {
                        message.clone()
                    } else {
                        concat(&[name, &s(": "), message])
                    }
                }
                // `Object.prototype.toString` by the object's tag (the C0i review's S4(d)).
                Kind::Object(Proto::Object | Proto::Class(_)) | Kind::Port(_) => s("[object Object]"),
                Kind::Map(_) => s("[object Map]"),
                Kind::Set(_) => s("[object Set]"),
                // No `toString` or `valueOf` on the chain: OrdinaryToPrimitive throws (the engine's TypeError).
                Kind::Object(Proto::Null) => return Err(error("TypeError", "client-engine: an object without a prototype has no primitive value")),
                _ => return Err(error("TypeError", "client-engine: ToString of this platform value is not reproduced")),
            }
        }
    })
}

/// `ToPropertyKey(value)` (a computed member key): `ToString` of its primitive (no symbol reaches the families).
pub fn to_property_key(value: &Value) -> Js<Str> {
    to_string(value)
}

/// `left + right`: a string when either primitive is one, else the numbers added.
pub fn add(left: &Value, right: &Value) -> Js {
    let primitive = |value: &Value| -> Js<Value> {
        match value {
            Value::Object(_) => Ok(Value::String(to_string(value)?)),
            other => Ok(other.clone()),
        }
    };
    let (left, right) = (primitive(left)?, primitive(right)?);
    if matches!(left, Value::String(_)) || matches!(right, Value::String(_)) {
        return Ok(Value::String(concat(&[&to_string(&left)?, &to_string(&right)?])));
    }
    Ok(Value::Number(to_number(&left) + to_number(&right)))
}

/// `array.join(separator)`: `null` and `undefined` elements as nothing.
pub fn join(array: &Obj, separator: &Str) -> Js<Str> {
    let mut out: Vec<u16> = Vec::new();
    for (index, item) in array.elements().transpose()?.unwrap_or_default().iter().enumerate() {
        if index > 0 {
            out.extend_from_slice(separator);
        }
        if !item.is_nullish() || crate::plant::on("rv-join-null-text") {
            out.extend_from_slice(&to_string(item)?);
        }
    }
    Ok(out.into())
}

/// `ToNumber(value)` for primitives and Dates (any other object is NaN here: the families that compare objects take
/// them through `less_than`, which reads their primitive first).
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Undefined => f64::NAN,
        Value::Null => 0.0,
        Value::Bool(value) => f64::from(u8::from(*value)),
        Value::Number(value) => *value,
        Value::String(text) => number::from_string(text),
        Value::Object(object) => match object.borrow().kind {
            Kind::Date(time) => time,
            _ => f64::NAN,
        },
    }
}

/// `ToPrimitive(value, number)`: a Date its time, an array or a plain object its text (`valueOf` gives the object).
pub fn to_primitive_number(value: &Value) -> Js {
    match value {
        Value::Object(object) => {
            if let Kind::Date(time) = object.borrow().kind {
                return Ok(Value::Number(time));
            }
            Ok(Value::String(to_string(value)?))
        }
        other => Ok(other.clone()),
    }
}

/// `left < right` (IsLessThan with the left operand first; undefined, from a NaN, is false).
pub fn less_than(left: &Value, right: &Value) -> Js<bool> {
    let (left, right) = (to_primitive_number(left)?, to_primitive_number(right)?);
    if let (Value::String(a), Value::String(b)) = (&left, &right) {
        if crate::plant::on("rv-lt-codepoint") {
            return Ok(String::from_utf16_lossy(a) < String::from_utf16_lossy(b));
        }
        return Ok(a < b);
    }
    Ok(to_number(&left) < to_number(&right))
}

/// `Math.max(a, b)`: NaN wins, and +0 is greater than -0.
pub fn math_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        if crate::plant::on("rv-max-neg-zero") {
            return b;
        }
        return if a.is_sign_negative() && b.is_sign_negative() { -0.0 } else { 0.0 };
    }
    if a > b { a } else { b }
}

/// `Number.isFinite(value)`.
pub fn is_finite_number(value: &Value) -> bool {
    matches!(value, Value::Number(number) if number.is_finite())
}

/// `value[key]` for a string key, on any value but `null` and `undefined`
/// (`None` for those: the caller throws or short-circuits). Members of the
/// prototypes are functions named as theirs; nothing a family reads is one.
pub fn member(base: &Value, key: &[u16]) -> Option<Value> {
    match base {
        Value::Undefined | Value::Null => None,
        Value::String(text) => Some(if key.iter().copied().eq("length".encode_utf16()) {
            Value::Number(text.len() as f64)
        } else if let Some(index) = array_index(key) {
            text.get(index as usize).map_or(Value::Undefined, |unit| Value::String(vec![*unit].into()))
        } else {
            Value::Undefined
        }),
        Value::Bool(_) | Value::Number(_) => Some(Value::Undefined),
        Value::Object(object) => Some(object_member(object, key)),
    }
}

fn object_member(object: &Obj, key: &[u16]) -> Value {
    let data = object.borrow();
    if let Kind::Array { elements, .. } = &data.kind {
        if key.iter().copied().eq("length".encode_utf16()) {
            return Value::Number(f64::from(elements.len()));
        }
        if let Some(index) = array_index(key) {
            return elements.get(index).cloned().unwrap_or(Value::Undefined);
        }
    }
    if let Kind::Error { name, message, cause, .. } = &data.kind {
        if let Some(value) = data.props.get(key) {
            return value.clone();
        }
        if key.iter().copied().eq("message".encode_utf16()) {
            return Value::String(message.clone());
        }
        if key.iter().copied().eq("name".encode_utf16()) {
            return Value::String(name.clone());
        }
        if key.iter().copied().eq("cause".encode_utf16()) {
            return cause.clone().unwrap_or(Value::Undefined);
        }
    }
    if let Some(value) = data.props.get(key) {
        return value.clone();
    }
    let inherits_object = !matches!(data.kind, Kind::Object(Proto::Null) | Kind::Port(_) | Kind::Leaf(_)) && !crate::plant::on("rv-member-no-prototype");
    if inherits_object && OBJECT_PROTOTYPE.iter().any(|name| name.encode_utf16().eq(key.iter().copied())) {
        return Value::Object(Obj::new(Kind::Function { name: key.into(), port: None }, Props::default()));
    }
    Value::Undefined
}

/// `base.key`, throwing the engine's TypeError on `null` and `undefined`;
/// `expression` is the member expression's source text.
pub fn get(base: &Value, key: &str, expression: &str) -> Js {
    let key: Vec<u16> = key.encode_utf16().collect();
    member(base, &key).ok_or_else(|| not_an_object(base, expression))
}

/// `base?.key`.
pub fn get_opt(base: &Value, key: &str) -> Value {
    let key: Vec<u16> = key.encode_utf16().collect();
    member(base, &key).unwrap_or(Value::Undefined)
}

/// `base[key]` for a computed key, throwing the engine's TypeError on `null` and `undefined`.
pub fn get_key(base: &Value, key: &[u16], expression: &str) -> Js {
    member(base, key).ok_or_else(|| not_an_object(base, expression))
}

/// `base?.[key]` with the key still a value: a nullish base short-circuits before `ToPropertyKey(key)` runs (a key
/// that cannot be made a string throws only when there is a base to read).
pub fn get_value_key_opt(base: &Value, key: &Value) -> Js {
    if base.is_nullish() {
        return Ok(Value::Undefined);
    }
    Ok(member(base, &to_property_key(key)?).unwrap_or(Value::Undefined))
}

/// `base?.[key]` for a computed key.
pub fn get_key_opt(base: &Value, key: &[u16]) -> Value {
    member(base, key).unwrap_or(Value::Undefined)
}

/// `key in object` (own members and `Object.prototype`'s; an array's indices and `length`).
pub fn has_property(object: &Obj, key: &[u16]) -> bool {
    let data = object.borrow();
    if let Kind::Array { elements, .. } = &data.kind {
        if key.iter().copied().eq("length".encode_utf16()) {
            return true;
        }
        if let Some(index) = array_index(key) {
            return elements.has(index);
        }
    }
    if data.props.has(key) {
        return true;
    }
    let inherits_object = !matches!(data.kind, Kind::Object(Proto::Null) | Kind::Port(_) | Kind::Leaf(_)) && !crate::plant::on("rv-in-own-only");
    inherits_object && OBJECT_PROTOTYPE.iter().any(|name| name.encode_utf16().eq(key.iter().copied()))
}

/// `Object.keys(value)` for an object: own enumerable string keys in V8's order (an array's indices first).
pub fn own_keys(object: &Obj) -> Vec<Str> {
    own_entries(object).into_iter().map(|(key, _)| key).collect()
}

/// Own enumerable string-keyed members, in order (what a spread, `Object.entries` and `JSON.stringify` walk).
pub fn own_entries(object: &Obj) -> Vec<(Str, Value)> {
    let data = object.borrow();
    let mut out = Vec::new();
    if let Kind::Array { elements, .. } = &data.kind {
        for (index, item) in elements.present() {
            out.push((s(&index.to_string()), item.clone()));
        }
    }
    out.extend(data.props.entries());
    out
}

/// `{ ...source }` members appended to `props` in order (nothing for `null` and `undefined`, a string's units by index).
pub fn spread_into(props: &mut Props, source: &Value) {
    match source {
        Value::Object(object) => {
            for (key, value) in own_entries(object) {
                props.set(key, value);
            }
        }
        Value::String(text) => {
            for (index, unit) in text.iter().enumerate() {
                props.set(s(&index.to_string()), Value::String(vec![*unit].into()));
            }
        }
        _ => {}
    }
}

/// `{ ...source }`.
pub fn spread(source: &Value) -> Obj {
    let mut props = Props::default();
    spread_into(&mut props, source);
    Obj::new(Kind::Object(Proto::Object), props)
}

/// `object[key] = value` on an object (an array index writes the element, growing the array with holes).
pub fn set(object: &Obj, key: Str, value: Value) {
    let mut data = object.borrow_mut();
    if let Kind::Array { elements, .. } = &mut data.kind
        && let Some(index) = array_index(&key)
    {
        elements.set(index, value);
        return;
    }
    data.props.set(key, value);
}

/// `delete object[key]`.
pub fn delete(object: &Obj, key: &[u16]) {
    let mut data = object.borrow_mut();
    if let Kind::Array { elements, .. } = &mut data.kind
        && let Some(index) = array_index(key)
    {
        elements.delete(index);
        return;
    }
    data.props.remove(key);
}

/// The elements a `for...of` or a spread of `value` gives, for an array
/// (holes as `undefined`); anything else is a TypeError of the engine's own
/// (no family iterates anything else in a recorded case).
pub fn iterate(value: &Value, expression: &str) -> Js<Vec<Value>> {
    match value {
        Value::Object(object) if object.is_array() => object.elements().unwrap_or(Ok(Vec::new())),
        Value::Object(object) if matches!(object.borrow().kind, Kind::Set(_)) => match &object.borrow().kind {
            Kind::Set(values) => Ok(values.clone()),
            _ => unreachable!("checked above"),
        },
        // A Map iterates its entries, each a fresh `[key, value]` array.
        Value::Object(object) if matches!(object.borrow().kind, Kind::Map(_)) => match &object.borrow().kind {
            Kind::Map(entries) => Ok(entries
                .iter()
                .map(|(key, value)| Value::Object(Obj::array(vec![key.clone(), value.clone()])))
                .collect()),
            _ => unreachable!("checked above"),
        },
        Value::String(text) => Ok(char::decode_utf16(text.iter().copied())
            .scan(0usize, |at, item| {
                let width = item.as_ref().map_or(1, |character| character.len_utf16());
                let unit = text[*at..*at + width].to_vec();
                *at += width;
                Some(Value::String(unit.into()))
            })
            .collect()),
        _ => Err(error(
            "TypeError",
            &format!("client-engine: iterating {} in '{expression}' is not reproduced", type_of(value)),
        )),
    }
}

/// `JSON.stringify(value)` as a string, or `None` where it gives `undefined`.
pub fn json_stringify(value: &Value) -> Js<Option<Str>> {
    let mut out: Vec<u16> = Vec::new();
    let mut stack: Vec<u64> = Vec::new();
    if !write_json(value, &mut out, &mut stack)? {
        return Ok(None);
    }
    Ok(Some(out.into()))
}

fn push_ascii(out: &mut Vec<u16>, text: &str) {
    out.extend(text.encode_utf16());
}

/// `JSON.stringify` of a string: quotes and escapes, lone surrogates as `\udxxx`.
pub fn push_json_string(out: &mut Vec<u16>, text: &[u16]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(u16::from(b'"'));
    let mut index = 0;
    while index < text.len() {
        let unit = text[index];
        index += 1;
        let escape: Option<&str> = match unit {
            0x22 => Some("\\\""),
            0x5c => Some("\\\\"),
            0x08 => Some("\\b"),
            0x0c => Some("\\f"),
            0x0a => Some("\\n"),
            0x0d => Some("\\r"),
            0x09 => Some("\\t"),
            _ => None,
        };
        if let Some(escape) = escape {
            push_ascii(out, escape);
            continue;
        }
        let lone = match unit {
            0xd800..=0xdbff => {
                if text.get(index).is_some_and(|low| (0xdc00..=0xdfff).contains(low)) {
                    out.push(unit);
                    out.push(text[index]);
                    index += 1;
                    continue;
                }
                true
            }
            0xdc00..=0xdfff => true,
            _ => false,
        };
        if unit < 0x20 || lone {
            push_ascii(out, "\\u");
            for shift in [12, 8, 4, 0] {
                out.push(u16::from(HEX[usize::from((unit >> shift) & 0xf)]));
            }
        } else {
            out.push(unit);
        }
    }
    out.push(u16::from(b'"'));
}

/// Writes `value`; false where it is no JSON value (`undefined`, a function).
fn write_json(value: &Value, out: &mut Vec<u16>, stack: &mut Vec<u64>) -> Js<bool> {
    match value {
        Value::Undefined => return Ok(false),
        Value::Null => push_ascii(out, "null"),
        Value::Bool(value) => push_ascii(out, if *value { "true" } else { "false" }),
        Value::Number(value) if crate::plant::on("rv-json-neg-zero") && *value == 0.0 && value.is_sign_negative() => push_ascii(out, "-0"),
        Value::Number(value) => push_ascii(out, &if value.is_finite() { number::to_string(*value) } else { "null".to_owned() }),
        Value::String(text) => push_json_string(out, text),
        Value::Object(object) => {
            if object.is_function() {
                return Ok(false);
            }
            if let Kind::Date(time) = object.borrow().kind {
                // `toJSON`: the ISO text, or `null` for an invalid date.
                match super::date::to_json(time) {
                    Some(text) => push_json_string(out, &s(&text)),
                    None => push_ascii(out, "null"),
                }
                return Ok(true);
            }
            if matches!(object.borrow().kind, Kind::Leaf(_) | Kind::Port(_)) {
                return Err(error("TypeError", "client-engine: JSON.stringify of a platform value is not reproduced"));
            }
            if stack.contains(&object.id()) {
                return Err(error("TypeError", "client-engine: JSON.stringify of a cyclic structure"));
            }
            stack.push(object.id());
            if object.is_array() {
                out.push(u16::from(b'['));
                for (index, item) in object.elements().transpose()?.unwrap_or_default().iter().enumerate() {
                    if index > 0 {
                        out.push(u16::from(b','));
                    }
                    if !write_json(item, out, stack)? {
                        push_ascii(out, "null");
                    }
                }
                out.push(u16::from(b']'));
            } else {
                out.push(u16::from(b'{'));
                let mut first = true;
                for (key, item) in own_entries(object) {
                    let mark = out.len();
                    if !first {
                        out.push(u16::from(b','));
                    }
                    push_json_string(out, &key);
                    out.push(u16::from(b':'));
                    if write_json(&item, out, stack)? {
                        first = false;
                    } else if crate::plant::on("rv-json-undefined-member-null") {
                        push_ascii(out, "null");
                        first = false;
                    } else {
                        out.truncate(mark);
                    }
                }
                out.push(u16::from(b'}'));
            }
            stack.pop();
        }
    }
    Ok(true)
}

/// A key for a Map or Set of the families' own (SameValueZero).
#[derive(Clone, PartialEq, Eq, Hash)]
pub enum MapKey {
    Undefined,
    Null,
    Bool(bool),
    Number(u64),
    String(Str),
    Object(u64),
}

impl MapKey {
    pub fn of(value: &Value) -> MapKey {
        match value {
            Value::Undefined => MapKey::Undefined,
            Value::Null => MapKey::Null,
            Value::Bool(value) => MapKey::Bool(*value),
            Value::Number(value) => MapKey::Number(if value.is_nan() {
                f64::NAN.to_bits()
            } else if *value == 0.0 && !crate::plant::on("rv-mapkey-signed-zero") {
                0
            } else {
                value.to_bits()
            }),
            Value::String(text) => MapKey::String(text.clone()),
            Value::Object(object) => MapKey::Object(object.id()),
        }
    }
}

/// A JavaScript `Map` the families keep for themselves: insertion order, SameValueZero keys.
#[derive(Default)]
pub struct JsMap {
    entries: Vec<(Value, Value)>,
    index: std::collections::HashMap<MapKey, usize>,
}

impl JsMap {
    pub fn get(&self, key: &Value) -> Option<&Value> {
        self.index.get(&MapKey::of(key)).map(|at| &self.entries[*at].1)
    }

    pub fn has(&self, key: &Value) -> bool {
        self.index.contains_key(&MapKey::of(key))
    }

    pub fn set(&mut self, key: Value, value: Value) {
        match self.index.get(&MapKey::of(&key)) {
            Some(at) => self.entries[*at].1 = value,
            None => {
                self.index.insert(MapKey::of(&key), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    pub fn entries(&self) -> &[(Value, Value)] {
        &self.entries
    }

    pub fn values(&self) -> Vec<Value> {
        self.entries.iter().map(|(_, value)| value.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_stringify_keeps_member_order_and_escapes_lone_surrogates() {
        let inner = Obj::object_from(vec![(s("b"), Value::Number(1.0)), (s("2"), Value::Undefined), (s("1"), Value::Null)]);
        let text = Value::String(vec![0xd800, u16::from(b'x')].into());
        let array = Obj::array(vec![Value::Undefined, text, Value::Number(f64::NAN)]);
        let outer = Obj::object_from(vec![(s("z"), Value::Object(inner)), (s("a"), Value::Object(array))]);
        let written = json_stringify(&Value::Object(outer)).unwrap().unwrap();
        assert_eq!(String::from_utf16(&written).unwrap(), r#"{"z":{"1":null,"b":1},"a":[null,"\ud800x",null]}"#);
    }

    #[test]
    fn math_max_orders_signed_zeroes_and_nan() {
        assert!(math_max(0.0, -0.0).is_sign_positive());
        assert!(math_max(-0.0, -0.0).is_sign_negative());
        assert!(math_max(0.0, f64::NAN).is_nan());
    }
}
