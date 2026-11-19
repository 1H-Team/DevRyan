//! The values that cross the ledger's seam, as the worker holds them after
//! the line codec has decoded a message: JSON values, `undefined`, bytes
//! (`Buffer`), and the three things only the wire markers carry (a host
//! function, a result stream, an `Error`). `Unsupported` stands for a tagged
//! `Map`, `Set`, `Date` or `BigInt`, which the native ledger refuses
//! (`mutation_wire_type`) where the JavaScript would accept them.
//!
//! The JavaScript conversions the worker applies to such values (`ToNumber`,
//! `ToString`, truthiness, property reads, `SameValueZero` map keys) are here
//! too, so every caller converts the same way.
#![forbid(unsafe_code)]

use std::rc::Rc;

use ledger_core::js::{JsStr, array_index, number_to_string};

use crate::Ret;
use crate::js::Promise;

/// A JavaScript value at the seam.
#[derive(Clone, Default)]
pub enum W {
    #[default]
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(JsStr),
    Bytes(Rc<Vec<u8>>),
    Array(Vec<W>),
    Object(Obj),
    Function(Rc<Func>),
    Stream(Rc<dyn Stream>),
    Error(Rc<JsError>),
    Unsupported(&'static str),
}

/// How a function value is called: its arguments and the cause of the work.
pub type FuncCall = dyn Fn(Vec<W>, &W) -> Ret;

/// A function value: a host function of a call's input (calling it sends
/// `callback`) or a function the ledger made itself.
pub struct Func {
    /// `String(fn)`: the function's source text, as `ToString` reads it.
    pub source: &'static str,
    /// Calls it with the cause of the work in progress: what it returns (a
    /// value or a promise) or throws.
    pub call: Box<FuncCall>,
}

/// One step of an async iterator: `{done, value}`.
#[derive(Clone)]
pub struct IterStep {
    pub done: bool,
    pub value: W,
}

/// An async iterable in a result (a receipt stream), pulled by the host.
pub trait Stream {
    /// `iterator.next()`.
    fn next(self: Rc<Self>) -> Promise<IterStep, W>;
    /// `iterator.return()`.
    fn finish(self: Rc<Self>) -> Promise<IterStep, W>;
}

/// The fields of an `Error` the seam carries, in the order the worker reads
/// them (`session-mutation-wire.js` `ERROR_FIELDS`).
pub const ERROR_FIELDS: [&str; 6] = [
    "code",
    "status",
    "committed",
    "rollbackFailed",
    "retryable",
    "reason",
];

/// An `Error` (or `AggregateError` when `errors` is set). `fields` are the
/// assigned own properties, in assignment order; `stack` is kept as decoded
/// but never encoded (the host keeps its own).
#[derive(Clone)]
pub struct JsError {
    pub name: JsStr,
    pub message: JsStr,
    pub stack: Option<JsStr>,
    pub fields: Vec<(&'static str, W)>,
    pub errors: Option<Vec<W>>,
    pub cause: Option<W>,
}

impl JsError {
    /// `new Error(message)` (or another constructor's name).
    pub fn new(name: &str, message: &str) -> JsError {
        JsError {
            name: JsStr::from(name),
            message: JsStr::from(message),
            stack: None,
            fields: Vec::new(),
            errors: None,
            cause: None,
        }
    }

    pub fn field(&self, name: &str) -> Option<&W> {
        self.fields
            .iter()
            .find(|(field, _)| *field == name)
            .map(|(_, value)| value)
    }

    /// `error[field] = value`: keeps the first position of a field set twice.
    pub fn set_field(&mut self, name: &'static str, value: W) {
        match self.fields.iter_mut().find(|(field, _)| *field == name) {
            Some(slot) => slot.1 = value,
            None => self.fields.push((name, value)),
        }
    }
}

/// `Object.assign(new Error(code), { code })`, the worker's own failures.
pub fn code_error(code: &str) -> W {
    let mut error = JsError::new("Error", code);
    error.set_field("code", W::string(code));
    W::Error(Rc::new(error))
}

/// `Object.assign(new Error(message), { code, status })`.
pub fn status_error(code: &str, status: f64) -> JsError {
    let mut error = JsError::new("Error", code);
    error.set_field("code", W::string(code));
    error.set_field("status", W::Number(status));
    error
}

/// A plain object's own properties in V8's order: canonical array indices
/// ascending first, then the other keys in insertion order.
#[derive(Clone, Default)]
pub struct Obj(Vec<(JsStr, W)>);

impl Obj {
    pub fn new() -> Obj {
        Obj(Vec::new())
    }

    /// `object[key] = value` for a data property.
    pub fn set(&mut self, key: JsStr, value: W) {
        if let Some(index) = array_index(key.units()) {
            let mut at = 0;
            while at < self.0.len() {
                match array_index(self.0[at].0.units()) {
                    Some(existing) if existing == index => {
                        self.0[at].1 = value;
                        return;
                    }
                    Some(existing) if existing < index => at += 1,
                    _ => break,
                }
            }
            self.0.insert(at, (key, value));
            return;
        }
        match self.0.iter_mut().find(|(existing, _)| *existing == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key, value)),
        }
    }

    pub fn put(&mut self, key: &str, value: W) {
        self.set(JsStr::from(key), value);
    }

    /// A literal object, keys in this order.
    pub fn with(entries: Vec<(&str, W)>) -> Obj {
        let mut object = Obj::new();
        for (key, value) in entries {
            object.put(key, value);
        }
        object
    }

    pub fn get(&self, key: &str) -> Option<&W> {
        let key = JsStr::from(key);
        self.get_js(&key)
    }

    pub fn get_js(&self, key: &JsStr) -> Option<&W> {
        self.0
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }

    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn iter(&self) -> impl Iterator<Item = &(JsStr, W)> {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for W {
    /// The value as the line codec writes it.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match crate::codec::encode_line(self) {
            Ok(line) => formatter.write_str(String::from_utf8_lossy(&line).trim_end()),
            Err(_) => formatter.write_str("<unencodable>"),
        }
    }
}

impl W {
    pub fn string(text: &str) -> W {
        W::String(JsStr::from(text))
    }

    pub fn object(entries: Vec<(&str, W)>) -> W {
        W::Object(Obj::with(entries))
    }

    pub fn as_object(&self) -> Option<&Obj> {
        match self {
            W::Object(object) => Some(object),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&JsStr> {
        match self {
            W::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn is_undefined(&self) -> bool {
        matches!(self, W::Undefined)
    }

    /// `value?.[key]` for the property reads the worker makes: own data of a
    /// plain object, the fields of an `Error`; `undefined` elsewhere (no
    /// such read reaches `Object.prototype`).
    pub fn get(&self, key: &str) -> W {
        match self {
            W::Object(object) => object.get(key).cloned().unwrap_or(W::Undefined),
            W::Error(error) => match key {
                "name" => W::String(error.name.clone()),
                "message" => W::String(error.message.clone()),
                "stack" => error.stack.clone().map(W::String).unwrap_or(W::Undefined),
                "errors" => error.errors.clone().map(W::Array).unwrap_or(W::Undefined),
                "cause" => error.cause.clone().unwrap_or(W::Undefined),
                _ => error.field(key).cloned().unwrap_or(W::Undefined),
            },
            _ => W::Undefined,
        }
    }

    /// Whether any part of the value is a refused tagged type.
    pub fn has_unsupported(&self) -> bool {
        let mut stack = vec![self];
        while let Some(item) = stack.pop() {
            match item {
                W::Unsupported(_) => return true,
                W::Array(items) => stack.extend(items.iter()),
                W::Object(object) => stack.extend(object.iter().map(|(_, value)| value)),
                _ => {}
            }
        }
        false
    }
}

/// JavaScript truthiness.
pub fn truthy(value: &W) -> bool {
    match value {
        W::Undefined | W::Null => false,
        W::Bool(value) => *value,
        W::Number(value) => !(value.is_nan() || *value == 0.0),
        W::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `String(value)`.
pub fn to_js_string(value: &W) -> JsStr {
    let mut out = JsStr::new();
    write_js_string(value, &mut out, 0);
    out
}

fn write_js_string(value: &W, out: &mut JsStr, depth: usize) {
    match value {
        W::Undefined => out.push_str("undefined"),
        W::Null => out.push_str("null"),
        W::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        W::Number(value) => out.push_str(&number_to_string(*value)),
        W::String(text) => out.push_units(text.units()),
        W::Bytes(bytes) => out.push_units(JsStr::from_utf8_lossy(bytes).units()),
        W::Array(items) => {
            // join(','): null and undefined elements are empty. A cycle is
            // impossible in a decoded value; the depth bound keeps it total.
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(",");
                }
                if depth < 1024 && !matches!(item, W::Undefined | W::Null) {
                    write_js_string(item, out, depth + 1);
                }
            }
        }
        W::Object(_) => out.push_str("[object Object]"),
        W::Function(func) => out.push_str(func.source),
        W::Stream(_) => out.push_str("[object AsyncGenerator]"),
        W::Error(error) => {
            // Error.prototype.toString.
            if error.name.is_empty() {
                out.push_units(error.message.units());
            } else if error.message.is_empty() {
                out.push_units(error.name.units());
            } else {
                out.push_units(error.name.units());
                out.push_str(": ");
                out.push_units(error.message.units());
            }
        }
        W::Unsupported(kind) => out.push_str(kind),
    }
}

/// `Number(value)`.
pub fn to_number(value: &W) -> f64 {
    match value {
        W::Undefined => f64::NAN,
        W::Null => 0.0,
        W::Bool(value) => f64::from(u8::from(*value)),
        W::Number(value) => *value,
        W::String(text) => string_to_number(text.units()),
        W::Unsupported(_) => f64::NAN,
        other => string_to_number(to_js_string(other).units()),
    }
}

fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000
            ..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// ECMAScript `StringToNumber`.
pub fn string_to_number(units: &[u16]) -> f64 {
    let start = units.iter().position(|unit| !is_js_whitespace(*unit));
    let Some(start) = start else { return 0.0 };
    let end = units
        .iter()
        .rposition(|unit| !is_js_whitespace(*unit))
        .map_or(start, |end| end + 1);
    let Ok(text) = String::from_utf16(&units[start..end]) else {
        return f64::NAN;
    };
    let bytes = text.as_bytes();
    let radix = match bytes {
        [b'0', b'x' | b'X', ..] => Some(16),
        [b'0', b'o' | b'O', ..] => Some(8),
        [b'0', b'b' | b'B', ..] => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &text[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0.0f64;
        for character in digits.chars() {
            let Some(digit) = character.to_digit(radix) else {
                return f64::NAN;
            };
            value = value * f64::from(radix) + f64::from(digit);
        }
        return value;
    }
    let (sign, body) = match bytes.first() {
        Some(b'+') => (1.0, &text[1..]),
        Some(b'-') => (-1.0, &text[1..]),
        _ => (1.0, &text[..]),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !decimal_literal(body.as_bytes()) {
        return f64::NAN;
    }
    // Validated StrUnsignedDecimalLiteral: Rust's parser rounds correctly.
    body.parse::<f64>().map_or(f64::NAN, |value| sign * value)
}

/// `StrUnsignedDecimalLiteral` without `Infinity`.
fn decimal_literal(bytes: &[u8]) -> bool {
    let mut at = 0;
    let digits = |at: &mut usize| {
        let from = *at;
        while *at < bytes.len() && bytes[*at].is_ascii_digit() {
            *at += 1;
        }
        *at - from
    };
    let whole = digits(&mut at);
    let mut fraction = 0;
    if at < bytes.len() && bytes[at] == b'.' {
        at += 1;
        fraction = digits(&mut at);
    }
    if whole == 0 && fraction == 0 {
        return false;
    }
    if at < bytes.len() && (bytes[at] == b'e' || bytes[at] == b'E') {
        at += 1;
        if at < bytes.len() && (bytes[at] == b'+' || bytes[at] == b'-') {
            at += 1;
        }
        if digits(&mut at) == 0 {
            return false;
        }
    }
    at == bytes.len()
}

/// `Math.max(a, b)`: NaN wins, `+0` over `-0`.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { b } else { a }
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)`: NaN wins, `-0` over `+0`.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else {
        a.min(b)
    }
}

/// `Number.isSafeInteger(value)`.
pub fn is_safe_integer(value: &W) -> bool {
    matches!(value, W::Number(n) if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

/// A `Map` key by `SameValueZero`: primitives by value; anything else is
/// an object, equal only to itself, which no later message can name.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum Key {
    Undefined,
    Null,
    Bool(bool),
    Number(u64),
    NaN,
    String(JsStr),
    Object(u64),
}

impl Key {
    /// The key of `value`, or `None` for an object (no lookup can match it).
    pub fn of(value: &W) -> Option<Key> {
        Some(match value {
            W::Undefined => Key::Undefined,
            W::Null => Key::Null,
            W::Bool(value) => Key::Bool(*value),
            W::Number(value) if value.is_nan() => Key::NaN,
            // -0 and +0 are one key.
            W::Number(value) => Key::Number((*value + 0.0).to_bits()),
            W::String(text) => Key::String(text.clone()),
            _ => return None,
        })
    }

    /// The key a `Map.set(value, ...)` uses: an object gets a fresh identity.
    pub fn insert_key(value: &W, fresh: &mut u64) -> Key {
        Key::of(value).unwrap_or_else(|| {
            *fresh += 1;
            Key::Object(*fresh)
        })
    }
}

/// `Object.entries(value)` for the values JSON and the codec produce.
pub fn own_entries(value: &W) -> Vec<(JsStr, W)> {
    match value {
        W::Object(object) => object.iter().cloned().collect(),
        W::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (JsStr::from(index.to_string()), item.clone()))
            .collect(),
        W::String(text) => text
            .units()
            .iter()
            .enumerate()
            .map(|(index, unit)| {
                (
                    JsStr::from(index.to_string()),
                    W::String(JsStr::from_units(vec![*unit])),
                )
            })
            .collect(),
        W::Bytes(bytes) => bytes
            .iter()
            .enumerate()
            .map(|(index, byte)| (JsStr::from(index.to_string()), W::Number(f64::from(*byte))))
            .collect(),
        W::Error(error) => error
            .fields
            .iter()
            .map(|(field, value)| (JsStr::from(*field), value.clone()))
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_conversion_follows_string_to_number() {
        let cases: [(&str, f64); 14] = [
            ("", 0.0),
            ("  12  ", 12.0),
            ("0x10", 16.0),
            ("0b11", 3.0),
            ("0o17", 15.0),
            ("-Infinity", f64::NEG_INFINITY),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("\u{feff}7\u{3000}", 7.0),
            ("1_000", f64::NAN),
            ("inf", f64::NAN),
            ("-0x10", f64::NAN),
            ("e5", f64::NAN),
        ];
        for (text, expected) in cases {
            let got = to_number(&W::string(text));
            assert!(
                got == expected || (got.is_nan() && expected.is_nan()),
                "{text:?} -> {got}"
            );
        }
        assert!(to_number(&W::string("-0")).is_sign_negative());
        assert_eq!(to_number(&W::Array(vec![W::Number(5.0)])), 5.0);
        assert_eq!(to_number(&W::Array(vec![])), 0.0);
        assert!(to_number(&W::Array(vec![W::Number(1.0), W::Number(2.0)])).is_nan());
    }

    #[test]
    fn objects_keep_v8_order() {
        let mut object = Obj::new();
        for key in ["b", "2", "a", "0", "10", "01", "b"] {
            object.put(key, W::Null);
        }
        let keys: Vec<String> = object
            .iter()
            .map(|(key, _)| key.to_string_lossy())
            .collect();
        assert_eq!(keys, ["0", "2", "10", "b", "a", "01"]);
    }

    #[test]
    fn map_keys_are_same_value_zero() {
        assert_eq!(Key::of(&W::Number(0.0)), Key::of(&W::Number(-0.0)));
        assert_eq!(Key::of(&W::Number(f64::NAN)), Some(Key::NaN));
        assert_ne!(Key::of(&W::Number(1.0)), Key::of(&W::string("1")));
        assert_eq!(Key::of(&W::Array(vec![])), None);
    }
}
