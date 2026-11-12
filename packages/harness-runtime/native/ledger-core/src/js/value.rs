//! The JSON value model with V8's own-property order, and the default
//! comparator of `Array.prototype.sort`.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use super::number::write_number;
use super::string::JsStr;

/// A JavaScript value as the ledger's records hold it. `Undefined` is
/// distinct from `Null`: `JSON.stringify` omits it from objects, writes it as
/// `null` in arrays and returns no text for it at the top level.
///
/// Every operation that walks a value (drop, `Clone`, `PartialEq`, `Debug`,
/// `to_js_string`) is iterative, so no depth exhausts the stack, on a small
/// thread stack or in WebAssembly alike. `parse` and `stringify` add a fixed
/// depth bound (`MAX_DEPTH`) on top. Holes (sparse arrays) have no
/// representation: no ledger value has them.
pub enum Value {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(JsStr),
    Array(Vec<Value>),
    Object(JsObject),
}

impl Value {
    /// A string value from Rust text.
    pub fn string(text: &str) -> Value {
        Value::String(JsStr::from(text))
    }

    pub fn as_object(&self) -> Option<&JsObject> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    /// Takes the elements of an array, leaving it empty (a value that
    /// implements `Drop` cannot be destructured by move).
    pub fn take_array(&mut self) -> Option<Vec<Value>> {
        match self {
            Value::Array(items) => Some(std::mem::take(items)),
            _ => None,
        }
    }

    /// Takes the properties of an object, leaving it empty.
    pub fn take_object(&mut self) -> Option<JsObject> {
        match self {
            Value::Object(object) => Some(std::mem::take(object)),
            _ => None,
        }
    }

    /// ECMAScript `ToString` for the value, as `String(value)` computes it
    /// (`Array.prototype.join(',')` for arrays, with `null` and `undefined`
    /// elements written as nothing; `[object Object]` for plain objects).
    pub fn to_js_string(&self) -> JsStr {
        let mut out = Vec::new();
        self.write_js_string(&mut out);
        JsStr::from_units(out)
    }

    fn write_js_string(&self, out: &mut Vec<u16>) {
        let Value::Array(items) = self else {
            write_scalar_string(self, out);
            return;
        };
        // join(',') of nested arrays, iteratively: (elements, next index).
        let mut stack: Vec<(&[Value], usize)> = vec![(items, 0)];
        while let Some((items, index)) = stack.last_mut() {
            if *index == items.len() {
                stack.pop();
                continue;
            }
            if *index > 0 {
                out.push(u16::from(b','));
            }
            let item = &items[*index];
            *index += 1;
            match item {
                Value::Null | Value::Undefined => {}
                Value::Array(inner) => stack.push((inner, 0)),
                other => write_scalar_string(other, out),
            }
        }
    }
}

/// `ToString` of anything but an array.
fn write_scalar_string(value: &Value, out: &mut Vec<u16>) {
    let mut text = String::new();
    match value {
        Value::Undefined => text.push_str("undefined"),
        Value::Null => text.push_str("null"),
        Value::Bool(value) => text.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => write_number(&mut text, *value),
        Value::String(value) => out.extend_from_slice(value.units()),
        Value::Object(_) => text.push_str("[object Object]"),
        Value::Array(_) => unreachable!("arrays are joined by write_js_string"),
    }
    out.extend(text.encode_utf16());
}

impl Clone for Value {
    /// A deep copy, built bottom-up without recursion.
    fn clone(&self) -> Self {
        enum Task<'a> {
            Visit(&'a Value),
            Array(usize),
            Object(&'a JsObject),
        }
        let mut tasks = vec![Task::Visit(self)];
        let mut done: Vec<Value> = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Visit(Value::Array(items)) => {
                    tasks.push(Task::Array(items.len()));
                    tasks.extend(items.iter().rev().map(Task::Visit));
                }
                Task::Visit(Value::Object(object)) => {
                    tasks.push(Task::Object(object));
                    tasks.extend(object.values().rev().map(Task::Visit));
                }
                Task::Visit(scalar) => done.push(match scalar {
                    Value::Undefined => Value::Undefined,
                    Value::Null => Value::Null,
                    Value::Bool(value) => Value::Bool(*value),
                    Value::Number(value) => Value::Number(*value),
                    Value::String(value) => Value::String(value.clone()),
                    Value::Array(_) | Value::Object(_) => unreachable!(),
                }),
                Task::Array(count) => {
                    let items = done.split_off(done.len() - count);
                    done.push(Value::Array(items));
                }
                Task::Object(object) => {
                    let mut values = done.split_off(done.len() - object.len()).into_iter();
                    let copy = JsObject {
                        indexed: object
                            .indexed
                            .keys()
                            .map(|key| (*key, values.next().expect("a value per key")))
                            .collect(),
                        named: object
                            .named
                            .iter()
                            .map(|(key, _)| (key.clone(), values.next().expect("a value per key")))
                            .collect(),
                        positions: object.positions.clone(),
                    };
                    done.push(Value::Object(copy));
                }
            }
        }
        done.pop().expect("the copy of the root")
    }
}

impl PartialEq for Value {
    /// Structural equality without recursion: the same variants, numbers by
    /// `f64` equality (so `NaN != NaN` and `-0 == 0`), properties equal in
    /// the same enumeration order. Write suppression must compare the bytes
    /// `stringify` writes instead, as the JavaScript compares texts.
    fn eq(&self, other: &Self) -> bool {
        let mut pending = vec![(self, other)];
        while let Some(pair) = pending.pop() {
            match pair {
                (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => {}
                (Value::Bool(a), Value::Bool(b)) if a == b => {}
                (Value::Number(a), Value::Number(b)) if a == b => {}
                (Value::String(a), Value::String(b)) if a == b => {}
                (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
                    pending.extend(a.iter().zip(b))
                }
                (Value::Object(a), Value::Object(b)) => {
                    if !a.indexed.keys().eq(b.indexed.keys())
                        || !a
                            .named
                            .iter()
                            .map(|(key, _)| key)
                            .eq(b.named.iter().map(|(key, _)| key))
                    {
                        return false;
                    }
                    pending.extend(a.values().zip(b.values()));
                }
                _ => return false,
            }
        }
        true
    }
}

impl std::fmt::Debug for Value {
    /// JSON-like text written without recursion, with `undefined`, `NaN` and
    /// the infinities spelled out.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&String::from_utf8_lossy(&super::json::debug_text(self)))
    }
}

impl Drop for Value {
    fn drop(&mut self) {
        let mut pending = Vec::new();
        drain_children(self, &mut pending);
        while let Some(mut value) = pending.pop() {
            // Each child is emptied before it is dropped, so this never recurses.
            drain_children(&mut value, &mut pending);
        }
    }
}

fn drain_children(value: &mut Value, into: &mut Vec<Value>) {
    match value {
        Value::Array(items) => into.append(items),
        Value::Object(object) => {
            into.extend(std::mem::take(&mut object.indexed).into_values());
            into.extend(object.named.drain(..).map(|(_, value)| value));
            object.positions.clear();
        }
        _ => {}
    }
}

/// An ordinary JavaScript object's own string-keyed properties, enumerated in
/// V8's order (`OrdinaryOwnPropertyKeys`): keys that are canonical array
/// indices (`"0"` to `"4294967294"`, no leading zeros) in ascending numeric
/// order, then every other key in insertion order. Setting an existing key
/// keeps its position; removing a key and setting it again moves it last.
/// `"__proto__"` is an ordinary key here, as `JSON.parse` creates it.
#[derive(Clone, Default)]
pub struct JsObject {
    indexed: BTreeMap<u32, Value>,
    named: Vec<(JsStr, Value)>,
    positions: HashMap<JsStr, usize>,
}

/// A property key as an object stores it: a canonical array index, or any
/// other string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key<'a> {
    Index(u32),
    Named(&'a JsStr),
}

/// The canonical array index a key denotes, if any.
pub fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut value: u64 = 0;
    for unit in key {
        let digit = unit
            .checked_sub(u16::from(b'0'))
            .filter(|digit| *digit < 10)?;
        value = value * 10 + u64::from(digit);
    }
    (value <= 4_294_967_294).then_some(value as u32)
}

impl JsObject {
    pub fn new() -> Self {
        JsObject::default()
    }

    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// `object[key] = value`. Returns the value it replaced.
    pub fn insert(&mut self, key: JsStr, value: Value) -> Option<Value> {
        if let Some(index) = array_index(key.units()) {
            return self.indexed.insert(index, value);
        }
        if let Some(&position) = self.positions.get(&key) {
            return Some(std::mem::replace(&mut self.named[position].1, value));
        }
        self.positions.insert(key.clone(), self.named.len());
        self.named.push((key, value));
        None
    }

    /// `object[key] = value` with a Rust key.
    pub fn set(&mut self, key: &str, value: Value) -> Option<Value> {
        self.insert(JsStr::from(key), value)
    }

    pub fn get(&self, key: &JsStr) -> Option<&Value> {
        match array_index(key.units()) {
            Some(index) => self.indexed.get(&index),
            None => self
                .positions
                .get(key)
                .map(|&position| &self.named[position].1),
        }
    }

    pub fn get_str(&self, key: &str) -> Option<&Value> {
        self.get(&JsStr::from(key))
    }

    /// `delete object[key]`. Returns the removed value.
    pub fn remove(&mut self, key: &JsStr) -> Option<Value> {
        if let Some(index) = array_index(key.units()) {
            return self.indexed.remove(&index);
        }
        let position = self.positions.remove(key)?;
        let (_, value) = self.named.remove(position);
        for (moved, (key, _)) in self.named.iter().enumerate().skip(position) {
            self.positions.insert(key.clone(), moved);
        }
        Some(value)
    }

    /// The properties in V8's enumeration order (`Object.keys`, `JSON.stringify`).
    pub fn iter(&self) -> impl Iterator<Item = (JsStr, &Value)> {
        self.indexed
            .iter()
            .map(|(index, value)| (JsStr::from(index.to_string()), value))
            .chain(self.named.iter().map(|(key, value)| (key.clone(), value)))
    }

    /// The properties in V8's enumeration order without copying the keys.
    pub fn entries(&self) -> impl Iterator<Item = (Key<'_>, &Value)> {
        self.indexed
            .iter()
            .map(|(index, value)| (Key::Index(*index), value))
            .chain(
                self.named
                    .iter()
                    .map(|(key, value)| (Key::Named(key), value)),
            )
    }

    /// The values in V8's enumeration order.
    pub fn values(&self) -> impl DoubleEndedIterator<Item = &Value> {
        self.indexed
            .values()
            .chain(self.named.iter().map(|(_, value)| value))
    }

    /// The keys in V8's enumeration order.
    pub fn keys(&self) -> Vec<JsStr> {
        self.iter().map(|(key, _)| key).collect()
    }
}

impl PartialEq for JsObject {
    /// Equal properties in the same enumeration order (`Value`'s equality).
    fn eq(&self, other: &Self) -> bool {
        self.indexed.keys().eq(other.indexed.keys())
            && self
                .named
                .iter()
                .map(|(key, _)| key)
                .eq(other.named.iter().map(|(key, _)| key))
            && self.values().zip(other.values()).all(|(a, b)| a == b)
    }
}

impl std::fmt::Debug for JsObject {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut text = String::from("{");
        for (index, (key, value)) in self.iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            text.push_str(&format!("{key:?}:{value:?}"));
        }
        text.push('}');
        formatter.write_str(&text)
    }
}

/// The default comparator of `Array.prototype.sort` for two defined values:
/// their `ToString` forms, compared by code unit.
pub fn default_compare(left: &Value, right: &Value) -> Ordering {
    left.to_js_string().cmp(&right.to_js_string())
}

/// `values.sort()` with no comparator: `undefined` elements go last, the rest
/// are ordered stably by `default_compare`.
pub fn default_sort(values: &mut Vec<Value>) {
    let mut keyed: Vec<(Option<JsStr>, Value)> = values
        .drain(..)
        .map(|value| match value {
            Value::Undefined => (None, value),
            _ => (Some(value.to_js_string()), value),
        })
        .collect();
    // `None` (undefined) orders after every string; the sort is stable.
    keyed.sort_by(|(left, _), (right, _)| match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    });
    values.extend(keyed.into_iter().map(|(_, value)| value));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_keys_enumerate_first_in_numeric_order() {
        let mut object = JsObject::new();
        for key in [
            "b",
            "4294967295",
            "4294967294",
            "1",
            "01",
            "-0",
            "0",
            "__proto__",
            "10",
            "9",
        ] {
            object.set(key, Value::Null);
        }
        object.set("b", Value::Bool(true));
        let keys: Vec<String> = object.keys().iter().map(JsStr::to_string_lossy).collect();
        assert_eq!(
            keys,
            [
                "0",
                "1",
                "9",
                "10",
                "4294967294",
                "b",
                "4294967295",
                "01",
                "-0",
                "__proto__"
            ]
        );
        assert_eq!(object.get_str("b"), Some(&Value::Bool(true)));
        object.remove(&JsStr::from("b"));
        object.set("b", Value::Null);
        assert_eq!(object.keys().last(), Some(&JsStr::from("b")));
        assert_eq!(object.keys()[5], JsStr::from("4294967295"));
    }

    #[test]
    fn default_sort_puts_undefined_last_and_compares_strings() {
        let mut values = vec![
            Value::Undefined,
            Value::Number(10.0),
            Value::Number(9.0),
            Value::Array(vec![Value::Number(1.0), Value::Null]),
            Value::string("1,"),
            Value::Null,
            Value::Object(JsObject::new()),
            Value::Bool(true),
        ];
        default_sort(&mut values);
        let strings: Vec<String> = values
            .iter()
            .map(|value| value.to_js_string().to_string_lossy())
            .collect();
        assert_eq!(
            strings,
            [
                "1,",
                "1,",
                "10",
                "9",
                "[object Object]",
                "null",
                "true",
                "undefined"
            ]
        );
        // Stable: the array [1, null] came before the string "1,".
        assert!(matches!(values[0], Value::Array(_)));
    }

    #[test]
    fn a_million_deep_value_is_walked_on_a_64_kib_stack() {
        let worker = std::thread::Builder::new().stack_size(64 * 1024).spawn(|| {
            // A million levels of arrays, every hundredth (the outermost too) an object.
            let mut value = Value::Number(1.0);
            for level in 0..1_000_000 {
                value = if (level + 1) % 100 != 0 {
                    Value::Array(vec![value, Value::Null])
                } else {
                    let mut object = JsObject::new();
                    object.set("0", value);
                    Value::Object(object)
                };
            }
            let copy = value.clone();
            assert!(copy == value);
            if let Value::Object(object) = &mut value {
                object.set("x", Value::Null);
            }
            assert!(copy != value);
            assert_eq!(value.to_js_string(), JsStr::from("[object Object]"));
            let mut nested = Value::Null;
            for _ in 0..1_000_000 {
                nested = Value::Array(vec![nested, Value::Number(2.0)]);
            }
            assert_eq!(nested.to_js_string().len(), 2_000_000);
            assert!(format!("{nested:?}").len() > 1_000_000);
            drop((value, copy, nested));
        });
        worker.expect("spawn").join().expect("no stack overflow");
    }
}
