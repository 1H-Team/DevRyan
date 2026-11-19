//! JavaScript values as the two packages produce and consume them.
//!
//! A value graph holds every array and object once, in an arena, and refers to
//! them by index, so a YAML alias that repeats an object (or contains its own
//! anchor) keeps its identity, and `yaml.stringify` can see it. Objects keep
//! V8's own-property order: canonical array-index keys ascending, then the
//! other keys in insertion order. An object also records its prototype,
//! because `jsonc-parser` assigns a `"__proto__"` key with `=`, which sets the
//! prototype instead of creating a property.
//!
//! `describe` writes the canonical text the vector files compare (the same
//! algorithm as `tests/config-text-format.mjs`); `from_description` reads it back.

use std::collections::{BTreeMap, HashMap};

use crate::{Refused, js};

/// `JSON.stringify` of a value that holds itself (JavaScript throws a `TypeError`).
pub const CYCLIC_VALUE: Refused = Refused("a cyclic value for JSON.stringify");
/// `JSON.stringify` of containers nested deeper than `jsonc::MAX_DEPTH`.
pub const DEEP_VALUE: Refused = Refused("a value nested deeper than jsonc::MAX_DEPTH for JSON.stringify");

/// A JavaScript value: a primitive or a reference into the graph's arena.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Ref(usize),
}

/// The prototype of an object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proto {
    /// `Object.prototype`.
    Object,
    /// `null`.
    Null,
    /// Another array or object of the graph.
    Ref(usize),
}

/// An object's own enumerable properties in V8 order, and its prototype.
#[derive(Clone, Debug)]
pub struct Object {
    indexed: BTreeMap<u32, Val>,
    named: Vec<(Vec<u16>, Val)>,
    positions: HashMap<Vec<u16>, usize>,
    pub proto: Proto,
}

impl Default for Object {
    fn default() -> Self {
        Object {
            indexed: BTreeMap::new(),
            named: Vec::new(),
            positions: HashMap::new(),
            proto: Proto::Object,
        }
    }
}

/// The canonical array index a key denotes (`0` to `2^32 - 2`), if any.
pub fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut value: u64 = 0;
    for unit in key {
        let digit = unit.checked_sub(u16::from(b'0')).filter(|digit| *digit < 10)?;
        value = value * 10 + u64::from(digit);
    }
    (value <= 4_294_967_294).then_some(value as u32)
}

impl Object {
    /// Defines or overwrites an own data property (`Object.defineProperty`, or
    /// `=` for a key that is not `__proto__`): an existing key keeps its place.
    pub fn insert(&mut self, key: Vec<u16>, value: Val) {
        if let Some(index) = array_index(&key) {
            self.indexed.insert(index, value);
            return;
        }
        if let Some(&position) = self.positions.get(&key) {
            self.named[position].1 = value;
            return;
        }
        self.positions.insert(key.clone(), self.named.len());
        self.named.push((key, value));
    }

    pub fn get(&self, key: &[u16]) -> Option<&Val> {
        if let Some(index) = array_index(key) {
            return self.indexed.get(&index);
        }
        self.positions.get(key).map(|position| &self.named[*position].1)
    }

    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// `Object.keys` with values, in order.
    pub fn entries(&self) -> Vec<(Vec<u16>, &Val)> {
        let mut out: Vec<(Vec<u16>, &Val)> = self.indexed.iter().map(|(index, value)| (js::units(&index.to_string()), value)).collect();
        out.extend(self.named.iter().map(|(key, value)| (key.clone(), value)));
        out
    }
}

/// An array or an object.
#[derive(Clone, Debug)]
pub enum Node {
    Array(Vec<Val>),
    Object(Object),
}

/// The arena of a value graph.
#[derive(Clone, Debug, Default)]
pub struct Graph {
    pub nodes: Vec<Node>,
}

impl Graph {
    pub fn new() -> Self {
        Graph::default()
    }

    pub fn add(&mut self, node: Node) -> usize {
        self.nodes.push(node);
        self.nodes.len() - 1
    }

    pub fn array(&mut self) -> usize {
        self.add(Node::Array(Vec::new()))
    }

    pub fn object(&mut self) -> usize {
        self.add(Node::Object(Object::default()))
    }

    pub fn node(&self, id: usize) -> &Node {
        &self.nodes[id]
    }

    pub fn node_mut(&mut self, id: usize) -> &mut Node {
        &mut self.nodes[id]
    }

    /// Pushes onto an array (no-op for an object).
    pub fn push(&mut self, id: usize, value: Val) {
        if let Node::Array(items) = &mut self.nodes[id] {
            items.push(value);
        }
    }

    /// Defines an own property on an object (no-op for an array).
    pub fn define(&mut self, id: usize, key: Vec<u16>, value: Val) {
        if let Node::Object(object) = &mut self.nodes[id] {
            object.insert(key, value);
        }
    }

    /// `object[key] = value` on an object whose prototype chain holds only
    /// data properties: `"__proto__"` sets the prototype to an object, an
    /// array or null and ignores any other value; every other key defines an
    /// own property.
    pub fn assign(&mut self, id: usize, key: Vec<u16>, value: Val) {
        let proto_setter = key == js::units("__proto__") && self.reaches_proto_setter(id);
        let Node::Object(object) = &mut self.nodes[id] else { return };
        if proto_setter {
            match value {
                Val::Null => object.proto = Proto::Null,
                Val::Ref(target) => object.proto = Proto::Ref(target),
                _ => {}
            }
            return;
        }
        object.insert(key, value);
    }

    /// Whether `object.__proto__ = v` reaches `Object.prototype`'s setter: the
    /// lookup walks the prototype chain from the object itself, and an own
    /// `"__proto__"` data property on the way (or a chain ending in `null`)
    /// makes the assignment an own property instead.
    fn reaches_proto_setter(&self, id: usize) -> bool {
        let key = js::units("__proto__");
        let mut at = id;
        // A chain is acyclic (JavaScript refuses a cyclic prototype); the bound only guards the walk.
        for _ in 0..=self.nodes.len() {
            match &self.nodes[at] {
                // An array's chain is Array.prototype, then Object.prototype.
                Node::Array(_) => return true,
                Node::Object(object) => {
                    if object.get(&key).is_some() {
                        return false;
                    }
                    match object.proto {
                        Proto::Object => return true,
                        Proto::Null => return false,
                        Proto::Ref(next) => at = next,
                    }
                }
            }
        }
        false
    }

    /// The canonical description of `root` (`describe` in tests/config-text-format.mjs).
    pub fn describe(&self, root: &Val) -> String {
        let mut out = String::new();
        let mut seen: HashMap<usize, usize> = HashMap::new();
        // An explicit stack keeps deep values off the call stack.
        enum Step<'a> {
            Value(&'a Val),
            Text(String),
            Proto(Proto),
        }
        let mut stack: Vec<Step> = vec![Step::Value(root)];
        let proto_holder: Vec<Val> = (0..self.nodes.len()).map(Val::Ref).collect();
        while let Some(step) = stack.pop() {
            let value = match step {
                Step::Text(text) => {
                    out.push_str(&text);
                    continue;
                }
                Step::Proto(proto) => {
                    match proto {
                        Proto::Object => {}
                        Proto::Null => out.push_str("^n"),
                        Proto::Ref(id) => {
                            out.push('^');
                            stack.push(Step::Value(&proto_holder[id]));
                        }
                    }
                    continue;
                }
                Step::Value(value) => value,
            };
            match value {
                Val::Undefined => out.push('u'),
                Val::Null => out.push('n'),
                Val::Bool(true) => out.push('t'),
                Val::Bool(false) => out.push('f'),
                Val::Number(x) => {
                    out.push('#');
                    if *x == 0.0 && x.is_sign_negative() {
                        out.push_str("-0");
                    } else {
                        out.push_str(&js::number_to_string(*x));
                    }
                }
                Val::String(text) => out.push_str(&js::lossy_json(text)),
                Val::Ref(id) => {
                    if let Some(index) = seen.get(id) {
                        out.push('*');
                        out.push_str(&index.to_string());
                        continue;
                    }
                    seen.insert(*id, seen.len());
                    match &self.nodes[*id] {
                        Node::Array(items) => {
                            out.push('[');
                            stack.push(Step::Text("]".to_owned()));
                            for (index, item) in items.iter().enumerate().rev() {
                                stack.push(Step::Value(item));
                                if index > 0 {
                                    stack.push(Step::Text(",".to_owned()));
                                }
                            }
                        }
                        Node::Object(object) => {
                            out.push('{');
                            stack.push(Step::Proto(object.proto));
                            stack.push(Step::Text("}".to_owned()));
                            let indexed = object.indexed.iter().map(|(index, value)| (js::units(&index.to_string()), value));
                            let named = object.named.iter().map(|(key, value)| (key.clone(), value));
                            let entries: Vec<(Vec<u16>, &Val)> = indexed.chain(named).collect();
                            for (index, (key, value)) in entries.into_iter().enumerate().rev() {
                                stack.push(Step::Value(value));
                                let mut prefix = String::new();
                                if index > 0 {
                                    prefix.push(',');
                                }
                                prefix.push_str(&js::lossy_json(&key));
                                prefix.push(':');
                                stack.push(Step::Text(prefix));
                            }
                        }
                    }
                }
            }
        }
        out
    }

    /// Reads a description back into this graph; the inverse of `describe`.
    pub fn from_description(&mut self, text: &str) -> Result<Val, String> {
        self.from_description_units(&js::units(text))
    }

    /// `from_description` of a JavaScript string: its units are read as they
    /// are, so a raw lone surrogate inside a string stays that surrogate.
    pub fn from_description_units(&mut self, units: &[u16]) -> Result<Val, String> {
        let mut reader = Reader {
            text: units,
            at: 0,
            ids: Vec::new(),
        };
        let value = reader.value(self, 0)?;
        if reader.at != units.len() {
            return Err(format!("trailing text at {}", reader.at));
        }
        Ok(value)
    }

    /// `JSON.stringify(value)`: `None` where it returns undefined. A cycle (where
    /// JavaScript throws) and containers nested deeper than `jsonc::MAX_DEPTH`
    /// (where Node's stack decides) are refused; the server never passes either.
    pub fn json_stringify(&self, value: &Val) -> Result<Option<Vec<u16>>, Refused> {
        let mut out = Vec::new();
        let mut active = Vec::new();
        if !self.json_write(value, &mut out, &mut active)? {
            return Ok(None);
        }
        Ok(Some(out))
    }

    fn json_write(&self, value: &Val, out: &mut Vec<u16>, active: &mut Vec<usize>) -> Result<bool, Refused> {
        match value {
            Val::Undefined => return Ok(false),
            Val::Null => out.extend(js::units("null")),
            Val::Bool(flag) => out.extend(js::units(if *flag { "true" } else { "false" })),
            Val::Number(x) => {
                if x.is_finite() {
                    out.extend(js::units(&js::number_to_string(*x)));
                } else {
                    out.extend(js::units("null"));
                }
            }
            Val::String(text) => js::push_json_string(out, text),
            Val::Ref(id) => {
                if active.contains(id) {
                    return Err(CYCLIC_VALUE);
                }
                if active.len() >= crate::jsonc::MAX_DEPTH {
                    return Err(DEEP_VALUE);
                }
                active.push(*id);
                match &self.nodes[*id] {
                    Node::Array(items) => {
                        out.push(u16::from(b'['));
                        for (index, item) in items.iter().enumerate() {
                            if index > 0 {
                                out.push(u16::from(b','));
                            }
                            if !self.json_write(item, out, active)? {
                                out.extend(js::units("null"));
                            }
                        }
                        out.push(u16::from(b']'));
                    }
                    Node::Object(object) => {
                        out.push(u16::from(b'{'));
                        let mut first = true;
                        for (key, item) in object.entries() {
                            let mark = out.len();
                            if !first {
                                out.push(u16::from(b','));
                            }
                            js::push_json_string(out, &key);
                            out.push(u16::from(b':'));
                            if self.json_write(item, out, active)? {
                                first = false;
                            } else {
                                out.truncate(mark);
                            }
                        }
                        out.push(u16::from(b'}'));
                    }
                }
                active.pop();
            }
        }
        Ok(true)
    }
}

struct Reader<'a> {
    text: &'a [u16],
    at: usize,
    ids: Vec<usize>,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u16> {
        self.text.get(self.at).copied()
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.peek() == Some(u16::from(byte)) {
            self.at += 1;
            Ok(())
        } else {
            Err(format!("expected {} at {}", byte as char, self.at))
        }
    }

    fn value(&mut self, graph: &mut Graph, depth: usize) -> Result<Val, String> {
        if depth > 2_000 {
            return Err("description nested too deeply".to_owned());
        }
        let Some(unit) = self.peek() else { return Err("unexpected end".to_owned()) };
        self.at += 1;
        Ok(match unit {
            0x75 => Val::Undefined,
            0x6e => Val::Null,
            0x74 => Val::Bool(true),
            0x66 => Val::Bool(false),
            0x23 => {
                let start = self.at;
                while self.peek().is_some_and(|unit| !matches!(unit, 0x2c | 0x5d | 0x7d | 0x5e)) {
                    self.at += 1;
                }
                let text = js::lossy(&self.text[start..self.at]);
                Val::Number(match text.as_str() {
                    "NaN" => f64::NAN,
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    "-0" => -0.0,
                    other => other.parse::<f64>().map_err(|_| format!("bad number {other}"))?,
                })
            }
            0x22 => {
                self.at -= 1;
                Val::String(self.string()?)
            }
            0x2a => {
                let start = self.at;
                while self.peek().is_some_and(|unit| (0x30..=0x39).contains(&unit)) {
                    self.at += 1;
                }
                let index: usize = js::lossy(&self.text[start..self.at]).parse().map_err(|_| "bad reference".to_owned())?;
                Val::Ref(*self.ids.get(index).ok_or("reference before its target")?)
            }
            0x5b => {
                let id = graph.array();
                self.ids.push(id);
                if self.peek() != Some(0x5d) {
                    loop {
                        let item = self.value(graph, depth + 1)?;
                        graph.push(id, item);
                        if self.peek() == Some(0x2c) {
                            self.at += 1;
                        } else {
                            break;
                        }
                    }
                }
                self.expect(b']')?;
                Val::Ref(id)
            }
            0x7b => {
                let id = graph.object();
                self.ids.push(id);
                if self.peek() != Some(0x7d) {
                    loop {
                        let key = self.string()?;
                        self.expect(b':')?;
                        let item = self.value(graph, depth + 1)?;
                        graph.define(id, key, item);
                        if self.peek() == Some(0x2c) {
                            self.at += 1;
                        } else {
                            break;
                        }
                    }
                }
                self.expect(b'}')?;
                if self.peek() == Some(0x5e) {
                    self.at += 1;
                    let proto = if self.peek() == Some(0x6e) {
                        self.at += 1;
                        Proto::Null
                    } else {
                        match self.value(graph, depth + 1)? {
                            Val::Ref(target) => Proto::Ref(target),
                            _ => return Err("a prototype must be an object".to_owned()),
                        }
                    };
                    if let Node::Object(object) = graph.node_mut(id) {
                        object.proto = proto;
                    }
                }
                Val::Ref(id)
            }
            other => return Err(format!("unexpected {other:#x} at {}", self.at - 1)),
        })
    }

    fn string(&mut self) -> Result<Vec<u16>, String> {
        self.expect(b'"')?;
        let mut out = Vec::new();
        loop {
            let Some(unit) = self.peek() else {
                return Err("unterminated string".to_owned());
            };
            self.at += 1;
            match unit {
                0x22 => return Ok(out),
                0x5c => {
                    let Some(escape) = self.peek() else {
                        return Err("unterminated escape".to_owned());
                    };
                    self.at += 1;
                    out.push(match escape {
                        0x62 => 0x08,
                        0x66 => 0x0c,
                        0x6e => 0x0a,
                        0x72 => 0x0d,
                        0x74 => 0x09,
                        0x75 => {
                            let digits = self.text.get(self.at..self.at + 4).ok_or("short \\u escape")?;
                            self.at += 4;
                            u16::from_str_radix(&js::lossy(digits), 16).map_err(|_| "bad \\u escape".to_owned())?
                        }
                        other => other,
                    });
                }
                other => out.push(other),
            }
        }
    }
}
