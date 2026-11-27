//! JavaScript values with object identity, as the scheduler holds them.
//!
//! An object or array is one `Rc`: cloning a [`V`] shares it, as a JavaScript
//! reference does, and [`V::same`] is `===`. The operations that copy in
//! JavaScript copy here, by name: [`V::spread`] (`{ ...object }`, a shallow
//! copy whose members are shared), [`V::structured_clone`] (a deep copy),
//! [`V::array_map_spread`] (`array.map((item) => ({ ...item }))`). The pure
//! policies (`devryan-scheduler-policy`) take and return trees without
//! identity: [`V::to_tree`] copies into one, [`V::from_tree`] builds fresh
//! objects from one, which is right wherever the JavaScript policy builds new
//! objects; where it shares an input object in its result, the caller puts
//! the shared one back (named at each such place).
//!
//! Every object keeps its own-property order as V8 does: array-index keys
//! ascending first, then the other keys in insertion order.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

use devryan_js_layer::jobs::Promise;
use devryan_js_layer::js::{self, JsObject, JsStr, Value};

/// A JavaScript value.
#[derive(Clone)]
pub enum V {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(JsStr),
    Obj(Obj),
    /// A function of this process, handed to the host (it calls it through an input).
    Func(Func),
    /// A function or object the host handed this process: an option member, a port, a port object, the options.
    Host(HostRef),
    Promise(Promise<V, V>),
    /// A value the host holds and this process cannot (a signal, a platform object): it can only be passed back.
    Opaque(i64, Rc<str>),
}

/// A stand-in of the host, named by its id and kind.
#[derive(Clone, Debug)]
pub struct HostRef {
    pub id: i64,
    pub kind: Rc<str>,
    pub name: Option<Rc<str>>,
    pub key: Option<Rc<str>>,
}

/// What a function of this process does when the host calls it: its result
/// (a value or a promise) or what it throws.
pub type FuncBody = Rc<dyn Fn(Vec<V>) -> Result<V, V>>;

#[derive(Clone)]
pub struct Func(pub Rc<FuncData>);

pub struct FuncData {
    pub id: Cell<i64>,
    pub name: Rc<str>,
    pub body: FuncBody,
}

#[derive(Clone)]
pub struct Obj(pub Rc<ObjData>);

pub struct ObjData {
    /// 0 until the object first crosses; then its id for good (the host's negative, this process's positive).
    pub id: Cell<i64>,
    pub body: RefCell<Body>,
}

pub enum Body {
    Object(Props),
    Array(Vec<V>),
    /// An error: its class (`TypeError`, `ManagedOrchestrationError`, …), message and own members.
    Error {
        class: Rc<str>,
        message: JsStr,
        props: Props,
    },
}

/// Own properties in V8's order.
#[derive(Clone, Default)]
pub struct Props {
    indexed: BTreeMap<u32, V>,
    named: Vec<(JsStr, V)>,
}

impl Props {
    pub fn new() -> Props {
        Props::default()
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        let units: Vec<u16> = key.encode_utf16().collect();
        match js::array_index(&units) {
            Some(index) => self.indexed.get(&index),
            None => self.named.iter().find(|(name, _)| name.units() == units.as_slice()).map(|(_, value)| value),
        }
    }

    pub fn get_js(&self, key: &JsStr) -> Option<&V> {
        match js::array_index(key.units()) {
            Some(index) => self.indexed.get(&index),
            None => self.named.iter().find(|(name, _)| name == key).map(|(_, value)| value),
        }
    }

    /// `object[key] = value`: an existing key keeps its place.
    pub fn set_js(&mut self, key: JsStr, value: V) {
        if let Some(index) = js::array_index(key.units()) {
            self.indexed.insert(index, value);
            return;
        }
        if let Some(slot) = self.named.iter_mut().find(|(name, _)| *name == key) {
            slot.1 = value;
            return;
        }
        self.named.push((key, value));
    }

    pub fn set(&mut self, key: &str, value: V) {
        self.set_js(JsStr::from(key), value);
    }

    /// `delete object[key]`.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let units: Vec<u16> = key.encode_utf16().collect();
        if let Some(index) = js::array_index(&units) {
            return self.indexed.remove(&index);
        }
        let position = self.named.iter().position(|(name, _)| name.units() == units.as_slice())?;
        Some(self.named.remove(position).1)
    }

    /// The members in enumeration order.
    pub fn entries(&self) -> Vec<(JsStr, V)> {
        self.indexed
            .iter()
            .map(|(index, value)| (JsStr::from(index.to_string()), value.clone()))
            .chain(self.named.iter().cloned())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Why a value cannot become a policy tree (the caller refuses with it).
pub struct NotData(pub &'static str);

impl V {
    pub fn str(text: &str) -> V {
        V::Str(JsStr::from(text))
    }

    pub fn object(entries: Vec<(&str, V)>) -> V {
        let mut props = Props::new();
        for (key, value) in entries {
            props.set(key, value);
        }
        V::from_props(props)
    }

    pub fn from_props(props: Props) -> V {
        V::Obj(Obj(Rc::new(ObjData {
            id: Cell::new(0),
            body: RefCell::new(Body::Object(props)),
        })))
    }

    pub fn array(items: Vec<V>) -> V {
        V::Obj(Obj(Rc::new(ObjData {
            id: Cell::new(0),
            body: RefCell::new(Body::Array(items)),
        })))
    }

    /// A built-in error (`new TypeError(message)`), or one with own members (`ManagedOrchestrationError`).
    pub fn error(class: &str, message: impl Into<JsStr>, props: Props) -> V {
        V::Obj(Obj(Rc::new(ObjData {
            id: Cell::new(0),
            body: RefCell::new(Body::Error {
                class: Rc::from(class),
                message: message.into(),
                props,
            }),
        })))
    }

    /// `new ManagedOrchestrationError(code, message)`: own `name` then `code` after the message.
    pub fn orchestration_error(code: &str, message: impl Into<JsStr>) -> V {
        let mut props = Props::new();
        props.set("name", V::str("ManagedOrchestrationError"));
        props.set("code", V::str(code));
        V::error("ManagedOrchestrationError", message, props)
    }

    pub fn func(name: &str, body: impl Fn(Vec<V>) -> Result<V, V> + 'static) -> V {
        V::Func(Func(Rc::new(FuncData {
            id: Cell::new(0),
            name: Rc::from(name),
            body: Rc::new(body),
        })))
    }

    pub fn is_nullish(&self) -> bool {
        matches!(self, V::Undef | V::Null)
    }

    /// `Boolean(value)`.
    pub fn truthy(&self) -> bool {
        match self {
            V::Undef | V::Null => false,
            V::Bool(value) => *value,
            V::Num(value) => !(*value == 0.0 || value.is_nan()),
            V::Str(text) => !text.is_empty(),
            _ => true,
        }
    }

    /// `typeof value`.
    pub fn type_of(&self) -> &'static str {
        match self {
            V::Undef => "undefined",
            V::Null | V::Obj(_) | V::Promise(_) | V::Opaque(..) => "object",
            V::Bool(_) => "boolean",
            V::Num(_) => "number",
            V::Str(_) => "string",
            V::Func(_) => "function",
            V::Host(reference) => {
                if &*reference.kind == "port-function" || &*reference.kind == "option" {
                    "function"
                } else {
                    "object"
                }
            }
        }
    }

    pub fn is_function(&self) -> bool {
        self.type_of() == "function"
    }

    pub fn as_num(&self) -> Option<f64> {
        match self {
            V::Num(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_js_str(&self) -> Option<&JsStr> {
        match self {
            V::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn is_str(&self, text: &str) -> bool {
        matches!(self, V::Str(value) if *value == text)
    }

    pub fn is_array(&self) -> bool {
        matches!(self, V::Obj(object) if matches!(*object.0.body.borrow(), Body::Array(_)))
    }

    /// `a === b`.
    pub fn same(&self, other: &V) -> bool {
        match (self, other) {
            (V::Undef, V::Undef) | (V::Null, V::Null) => true,
            (V::Bool(a), V::Bool(b)) => a == b,
            (V::Num(a), V::Num(b)) => a == b,
            (V::Str(a), V::Str(b)) => a == b,
            (V::Obj(a), V::Obj(b)) => Rc::ptr_eq(&a.0, &b.0),
            (V::Func(a), V::Func(b)) => Rc::ptr_eq(&a.0, &b.0),
            (V::Host(a), V::Host(b)) => a.id == b.id,
            (V::Promise(a), V::Promise(b)) => a.same(b),
            (V::Opaque(a, _), V::Opaque(b, _)) => a == b,
            _ => false,
        }
    }

    /// `value[key]` of a plain object, array (`length` and indices) or error; `undefined` for anything else
    /// (the scheduler reads no key of a primitive's prototype). A host stand-in is read through the host
    /// (`crate::host`), never here.
    pub fn get(&self, key: &str) -> V {
        let V::Obj(object) = self else { return V::Undef };
        match &*object.0.body.borrow() {
            Body::Object(props) => props.get(key).cloned().unwrap_or(V::Undef),
            Body::Array(items) => {
                if key == "length" {
                    return V::Num(items.len() as f64);
                }
                let units: Vec<u16> = key.encode_utf16().collect();
                js::array_index(&units).and_then(|index| items.get(index as usize).cloned()).unwrap_or(V::Undef)
            }
            Body::Error { message, props, .. } => {
                if key == "message" {
                    V::Str(message.clone())
                } else {
                    props.get(key).cloned().unwrap_or(V::Undef)
                }
            }
        }
    }

    /// `value?.[key]`.
    pub fn get_opt(&self, key: &str) -> V {
        if self.is_nullish() { V::Undef } else { self.get(key) }
    }

    /// `object[key] = value` on a plain object (anything else is a harness error).
    pub fn set(&self, key: &str, value: V) {
        if let V::Obj(object) = self {
            match &mut *object.0.body.borrow_mut() {
                Body::Object(props) | Body::Error { props, .. } => props.set(key, value),
                Body::Array(_) => panic!("set {key} on an array"),
            }
        } else {
            panic!("set {key} on a primitive");
        }
    }

    /// The own members of a plain object in order (empty for anything else).
    pub fn entries(&self) -> Vec<(JsStr, V)> {
        match self {
            V::Obj(object) => match &*object.0.body.borrow() {
                Body::Object(props) => props.entries(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// The items of an array (a copy of the list; the items are shared).
    pub fn items(&self) -> Vec<V> {
        match self {
            V::Obj(object) => match &*object.0.body.borrow() {
                Body::Array(items) => items.clone(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// `{ ...value }`: a new object; the members are shared. Spreading a primitive or nullish gives `{}`.
    pub fn spread(&self) -> Props {
        let mut props = Props::new();
        if let V::Obj(object) = self {
            match &*object.0.body.borrow() {
                Body::Object(own) => props = own.clone(),
                Body::Array(items) => {
                    for (index, item) in items.iter().enumerate() {
                        props.set(&index.to_string(), item.clone());
                    }
                }
                Body::Error { props: own, .. } => props = own.clone(),
            }
        }
        props
    }

    /// `array.map((item) => ({ ...item }))`.
    pub fn array_map_spread(&self) -> V {
        V::array(self.items().iter().map(|item| V::from_props(item.spread())).collect())
    }

    /// `structuredClone(value)` of data (objects, arrays, primitives, errors as plain data are not cloned here).
    pub fn structured_clone(&self) -> Result<V, NotData> {
        Ok(V::from_tree(&self.to_tree()?))
    }

    /// The value as a policy tree (a deep copy without identity).
    pub fn to_tree(&self) -> Result<Value, NotData> {
        Ok(match self {
            V::Undef => Value::Undefined,
            V::Null => Value::Null,
            V::Bool(value) => Value::Bool(*value),
            V::Num(value) => Value::Number(*value),
            V::Str(text) => Value::String(text.clone()),
            V::Obj(object) => match &*object.0.body.borrow() {
                Body::Object(props) => {
                    let mut out = JsObject::new();
                    for (key, value) in props.entries() {
                        out.insert(key, value.to_tree()?);
                    }
                    Value::Object(out)
                }
                Body::Array(items) => Value::Array(items.iter().map(V::to_tree).collect::<Result<_, _>>()?),
                Body::Error { .. } => return Err(NotData("an error object inside policy data")),
            },
            V::Func(_) | V::Host(_) => return Err(NotData("a function inside policy data")),
            V::Promise(_) => return Err(NotData("a promise inside policy data")),
            V::Opaque(..) => return Err(NotData("a host object inside policy data")),
        })
    }

    /// Fresh objects from a policy tree.
    pub fn from_tree(tree: &Value) -> V {
        match tree {
            Value::Undefined => V::Undef,
            Value::Null => V::Null,
            Value::Bool(value) => V::Bool(*value),
            Value::Number(value) => V::Num(*value),
            Value::String(text) => V::Str(text.clone()),
            Value::Array(items) => V::array(items.iter().map(V::from_tree).collect()),
            Value::Object(object) => {
                let mut props = Props::new();
                for (key, value) in object.iter() {
                    props.set_js(key, V::from_tree(value));
                }
                V::from_props(props)
            }
        }
    }
}
