//! JavaScript values as the ported families see them: primitives, and
//! objects with identity (`Rc` pointer plus a number of its own, so a freed
//! object's address is never taken for a new one), V8's own-property order
//! (integer-like keys ascending, then insertion order), holes in arrays,
//! Map and Set insertion order, errors, functions and platform values the
//! engine only carries (a codec tree kept as it came).

use std::cell::{Ref, RefCell, RefMut};
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

/// A JavaScript string: UTF-16 code units, lone surrogates kept.
pub type Str = Rc<[u16]>;

/// A string from Rust text.
pub fn s(text: &str) -> Str {
    text.encode_utf16().collect::<Vec<u16>>().into()
}

#[derive(Clone)]
pub enum Value {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(Str),
    Object(Obj),
}

impl std::fmt::Debug for Value {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Value::Undefined => formatter.write_str("undefined"),
            Value::Null => formatter.write_str("null"),
            Value::Bool(value) => write!(formatter, "{value}"),
            Value::Number(value) => write!(formatter, "{value}"),
            Value::String(text) => write!(formatter, "{:?}", String::from_utf16_lossy(text)),
            Value::Object(object) => write!(formatter, "<object {}>", object.id()),
        }
    }
}

impl Value {
    pub fn str(text: &str) -> Value {
        Value::String(s(text))
    }

    pub fn is_nullish(&self) -> bool {
        matches!(self, Value::Undefined | Value::Null)
    }

    pub fn as_object(&self) -> Option<&Obj> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&Str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(number) => Some(*number),
            _ => None,
        }
    }

    /// The value is this very string (Rust text).
    pub fn is_str(&self, text: &str) -> bool {
        matches!(self, Value::String(units) if units.iter().copied().eq(text.encode_utf16()))
    }
}

/// What an object's prototype is, as far as the families can tell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Proto {
    /// `Object.prototype`: a plain object.
    Object,
    /// No prototype (`Object.create(null)`).
    Null,
    /// An instance of a class the codec names (`None`: no constructor on the chain).
    Class(Option<Str>),
}

/// The kinds of objects.
pub enum Kind {
    Object(Proto),
    /// An array: `elements` holds its length and index members (a hole costs nothing); `props` any other own member.
    Array {
        elements: Elements,
        class: Option<Str>,
    },
    Map(Vec<(Value, Value)>),
    Set(Vec<Value>),
    /// An error: its class (the constructor's name), `name` and `message` (own, not enumerable), `cause`.
    Error {
        class: Str,
        name: Str,
        message: Str,
        cause: Option<Value>,
    },
    /// A function the test handed in (`port`: the port it stands for) or one the platform has (a method read off a value).
    Function {
        name: Str,
        port: Option<Str>,
    },
    /// A port object the recording names.
    Port(Str),
    /// A Date: its time value (ms since the epoch; NaN for an invalid date).
    Date(f64),
    /// A platform value the engine only carries (a Date, bytes, a RegExp...): its codec tree, re-emitted as it came.
    Leaf(Rc<dyn std::any::Any>),
}

pub struct ObjectData {
    pub kind: Kind,
    pub props: Props,
}

struct Cell {
    id: u64,
    data: RefCell<ObjectData>,
}

/// An object: shared, mutable, compared by identity.
#[derive(Clone)]
pub struct Obj(Rc<Cell>);

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Obj {
    pub fn new(kind: Kind, props: Props) -> Obj {
        Obj(Rc::new(Cell {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            data: RefCell::new(ObjectData { kind, props }),
        }))
    }

    /// A fresh plain object.
    pub fn object() -> Obj {
        Obj::new(Kind::Object(Proto::Object), Props::default())
    }

    /// A fresh plain object with these members, in this order (V8's order applied).
    pub fn object_from(members: Vec<(Str, Value)>) -> Obj {
        let mut props = Props::default();
        for (key, value) in members {
            props.set(key, value);
        }
        Obj::new(Kind::Object(Proto::Object), props)
    }

    /// A fresh array of these elements.
    pub fn array(items: Vec<Value>) -> Obj {
        Obj::new(
            Kind::Array {
                elements: Elements::from_values(items),
                class: None,
            },
            Props::default(),
        )
    }

    /// A fresh array of these index members.
    pub fn array_of(elements: Elements) -> Obj {
        Obj::new(Kind::Array { elements, class: None }, Props::default())
    }

    pub fn id(&self) -> u64 {
        self.0.id
    }

    pub fn same(&self, other: &Obj) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }

    pub fn borrow(&self) -> Ref<'_, ObjectData> {
        self.0.data.borrow()
    }

    pub fn borrow_mut(&self) -> RefMut<'_, ObjectData> {
        self.0.data.borrow_mut()
    }

    pub fn is_array(&self) -> bool {
        matches!(self.borrow().kind, Kind::Array { .. })
    }

    pub fn is_function(&self) -> bool {
        matches!(self.borrow().kind, Kind::Function { .. })
    }

    /// A plain object (`Object.prototype`), the only kind the families copy, spread and read as records.
    pub fn is_plain(&self) -> bool {
        matches!(self.borrow().kind, Kind::Object(Proto::Object))
    }

    /// The array's elements, holes as `undefined` (what iteration and spread give); `None` for no array, a
    /// RangeError for an array longer than this engine iterates (`Elements::values`).
    pub fn elements(&self) -> Option<Result<Vec<Value>, Value>> {
        match &self.borrow().kind {
            Kind::Array { elements, .. } => Some(elements.values()),
            _ => None,
        }
    }

    /// The array's present members in index order (what `some`, `filter` and `forEach` visit).
    pub fn present_elements(&self) -> Option<Vec<Value>> {
        match &self.borrow().kind {
            Kind::Array { elements, .. } => Some(elements.present().map(|(_, value)| value.clone()).collect()),
            _ => None,
        }
    }

    /// The array's length.
    pub fn array_len(&self) -> Option<u32> {
        match &self.borrow().kind {
            Kind::Array { elements, .. } => Some(elements.len()),
            _ => None,
        }
    }

    /// Replaces the array's elements.
    pub fn set_elements(&self, items: Vec<Value>) {
        if let Kind::Array { elements, .. } = &mut self.borrow_mut().kind {
            *elements = Elements::from_values(items);
        }
    }
}

/// The largest array length (2^32 - 1).
pub const MAX_ARRAY_LENGTH: u64 = 4_294_967_295;
/// The most elements, holes included, an operation that visits every index (a spread, `join`, `for...of`) takes
/// before it gives up with a RangeError: a sparse array keeps no hole in memory, and visiting 2^32 - 1 of them
/// would exhaust what any JavaScript engine has too (the C0i review's M4a). No recorded or generated case comes near.
pub const ITERATION_LIMIT: u32 = 1 << 24;

/// An array's index members: its length (up to 2^32 - 1) and the members present, so a hole costs nothing and a
/// codec tree's hole count never becomes an allocation.
#[derive(Clone, Default)]
pub struct Elements {
    present: BTreeMap<u32, Value>,
    len: u32,
}

impl Elements {
    pub fn from_values(items: Vec<Value>) -> Elements {
        let len = u32::try_from(items.len()).expect("an array the engine made is shorter than 2^32");
        Elements {
            present: items.into_iter().enumerate().map(|(at, item)| (at as u32, item)).collect(),
            len,
        }
    }

    pub fn len(&self) -> u32 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The member at `index`, `None` for a hole or past the end.
    pub fn get(&self, index: u32) -> Option<&Value> {
        self.present.get(&index)
    }

    /// Whether `index` holds a member (no hole, not past the end).
    pub fn has(&self, index: u32) -> bool {
        self.present.contains_key(&index)
    }

    /// `array[index] = value` (the length grows to `index + 1`, holes between).
    pub fn set(&mut self, index: u32, value: Value) {
        self.present.insert(index, value);
        self.len = self.len.max(index + 1);
    }

    /// `delete array[index]`: a hole, the length kept.
    pub fn delete(&mut self, index: u32) {
        self.present.remove(&index);
    }

    /// `array.push(value)`; false when the length would pass 2^32 - 1.
    pub fn push(&mut self, value: Value) -> bool {
        if u64::from(self.len) >= MAX_ARRAY_LENGTH {
            return false;
        }
        self.present.insert(self.len, value);
        self.len += 1;
        true
    }

    /// Appends `count` holes; false when the length would pass 2^32 - 1.
    pub fn push_holes(&mut self, count: u64) -> bool {
        match u64::from(self.len).checked_add(count) {
            Some(len) if len <= MAX_ARRAY_LENGTH => {
                self.len = len as u32;
                true
            }
            _ => false,
        }
    }

    /// The members present, by ascending index.
    pub fn present(&self) -> impl Iterator<Item = (u32, &Value)> {
        self.present.iter().map(|(index, value)| (*index, value))
    }

    /// Every index from 0 to the length, holes as `undefined`; a RangeError past `ITERATION_LIMIT`.
    pub fn values(&self) -> Result<Vec<Value>, Value> {
        if self.len > ITERATION_LIMIT {
            return Err(crate::js::error(
                "RangeError",
                &format!("client-engine: an array of length {} is longer than this engine visits", self.len),
            ));
        }
        let mut out = vec![Value::Undefined; self.len as usize];
        for (index, value) in &self.present {
            out[*index as usize] = value.clone();
        }
        Ok(out)
    }

    /// Every index from 0 to the length, `None` for a hole; the same limit as `values`.
    pub fn slots(&self) -> Result<Vec<Option<Value>>, Value> {
        if self.len > ITERATION_LIMIT {
            return Err(crate::js::error(
                "RangeError",
                &format!("client-engine: an array of length {} is longer than this engine visits", self.len),
            ));
        }
        let mut out = vec![None; self.len as usize];
        for (index, value) in &self.present {
            out[*index as usize] = Some(value.clone());
        }
        Ok(out)
    }

    /// `array.slice(start, end)` for `start <= end <= length`: holes kept.
    pub fn slice(&self, start: u32, end: u32) -> Elements {
        Elements {
            present: self.present.range(start..end).map(|(index, value)| (index - start, value.clone())).collect(),
            len: end.saturating_sub(start),
        }
    }

    /// `array.splice(index, 1)` for `index < length`: later members move down one place, holes with them.
    pub fn remove_at(&mut self, index: u32) {
        let later = self.present.split_off(&index);
        for (at, value) in later {
            if at > index {
                self.present.insert(at - 1, value);
            }
        }
        self.len -= 1;
    }
}

/// A property key as an object stores it.
pub fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut value: u64 = 0;
    for unit in key {
        let digit = unit.checked_sub(u16::from(b'0')).filter(|digit| *digit < 10)?;
        value = value * 10 + u64::from(digit);
    }
    let max = if crate::plant::on("rv-index-max") { 4_294_967_295 } else { 4_294_967_294 };
    (value <= max).then_some(value as u32)
}

/// Own enumerable string-keyed data members in V8's order: integer-like keys
/// ascending, then every other key in insertion order. Setting an existing
/// key keeps its place; deleting it and setting it again moves it last.
#[derive(Clone, Default)]
pub struct Props {
    indexed: BTreeMap<u32, Value>,
    named: Vec<(Str, Value)>,
    /// Positions of the named keys, kept once an object has more than a few (a session map, a part map).
    positions: Option<HashMap<Str, usize>>,
}

/// From this many named members an object keeps an index of their positions.
const INDEXED_FROM: usize = 12;

impl Props {
    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn position(&self, key: &[u16]) -> Option<usize> {
        match &self.positions {
            Some(positions) => positions.get(key).copied(),
            None => self.named.iter().position(|(name, _)| &**name == key),
        }
    }

    pub fn get(&self, key: &[u16]) -> Option<&Value> {
        match array_index(key).filter(|_| !crate::plant::on("rv-props-insertion-order")) {
            Some(index) => self.indexed.get(&index),
            None => self.position(key).map(|at| &self.named[at].1),
        }
    }

    pub fn has(&self, key: &[u16]) -> bool {
        self.get(key).is_some()
    }

    pub fn set(&mut self, key: Str, value: Value) {
        if let Some(index) = array_index(&key).filter(|_| !crate::plant::on("rv-props-insertion-order")) {
            self.indexed.insert(index, value);
            return;
        }
        match self.position(&key) {
            Some(at) => self.named[at].1 = value,
            None => {
                if let Some(positions) = &mut self.positions {
                    positions.insert(key.clone(), self.named.len());
                }
                self.named.push((key, value));
                if self.positions.is_none() && self.named.len() > INDEXED_FROM {
                    self.positions = Some(self.named.iter().enumerate().map(|(at, (name, _))| (name.clone(), at)).collect());
                }
            }
        }
    }

    pub fn remove(&mut self, key: &[u16]) -> Option<Value> {
        if let Some(index) = array_index(key).filter(|_| !crate::plant::on("rv-props-insertion-order")) {
            return self.indexed.remove(&index);
        }
        let position = self.position(key)?;
        let (_, value) = self.named.remove(position);
        if let Some(positions) = &mut self.positions {
            positions.remove(key);
            for (at, (name, _)) in self.named.iter().enumerate().skip(position) {
                positions.insert(name.clone(), at);
            }
        }
        Some(value)
    }

    /// The members in V8's order.
    pub fn entries(&self) -> Vec<(Str, Value)> {
        let mut out = Vec::with_capacity(self.len());
        for (index, value) in &self.indexed {
            out.push((crate::js::s(&index.to_string()), value.clone()));
        }
        for (key, value) in &self.named {
            out.push((key.clone(), value.clone()));
        }
        out
    }
}
