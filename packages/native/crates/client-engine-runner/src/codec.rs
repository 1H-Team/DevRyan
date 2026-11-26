//! The value codec of the harness (scripts/client-conformance/codec.mjs), on
//! the Rust side: codec trees rebuilt into engine values with the case's
//! identity scope (`bound`: the recording's numbers of objects the case
//! holds), values taken (`snapshot`) when a slot is taken, and the slots of a
//! case written together (`emit_slots`), objects reached more than once
//! numbered by first appearance, `id` at their first appearance in each slot
//! and `ref` after it. What the families exchange is covered: primitives,
//! `undefined`, the special numbers, plain objects (escaped, prototype-less
//! and class instances too), arrays with holes, subclasses and members, Map,
//! Set, errors, functions and ports by name; any other platform value (a
//! Date, bytes, a RegExp) is carried as its tree. What would need behaviour
//! the families do not have (accessors, symbols, bigints, promises) is
//! refused, so the step halts rather than run on a wrong value.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use devryan_client_engine::js::{Elements, Kind, MapKey, Obj, Props, Proto, Str, Value, array_index, s};

use crate::json::Json;

/// Why a tree could not be rebuilt.
#[derive(Debug)]
pub struct RebuildError(pub String);

fn refuse<T>(what: impl Into<String>) -> Result<T, RebuildError> {
    Err(RebuildError(what.into()))
}

/// A tagged node's tag.
fn tag(node: &Json) -> Option<String> {
    node.get("$dr").and_then(Json::as_string)
}

/// The members of a tagged node other than its tag.
fn number_word(word: &str) -> Option<f64> {
    match word {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        "-0" => Some(-0.0),
        _ => None,
    }
}

/// Codec tags whose node is carried as it came (a platform value the families only hold).
const LEAVES: &[&str] = &[
    "date",
    "regexp",
    "bytes",
    "typed",
    "arraybuffer",
    "dataview",
    "url",
    "searchparams",
    "headers",
    "response",
    "request",
    "event",
    "weak",
    "opaque",
    "unencodable",
];

/// Rebuilds a tree into a value of the case: an `id` the case already holds
/// is that object, brought in place to the content given; a new one is made
/// and bound.
pub fn rebuild(tree: &Json, bound: &mut HashMap<i64, Obj>) -> Result<Value, RebuildError> {
    let mut local: HashMap<i64, Obj> = HashMap::new();
    visit(tree, bound, &mut local)
}

fn visit(node: &Json, bound: &mut HashMap<i64, Obj>, local: &mut HashMap<i64, Obj>) -> Result<Value, RebuildError> {
    Ok(match node {
        Json::Null => Value::Null,
        Json::Bool(value) => Value::Bool(*value),
        Json::Number(value) => Value::Number(*value),
        Json::String(text) => Value::String(text.clone()),
        Json::Array(_) | Json::Object(_) => {
            let Some(kind) = tag(node) else {
                let made = shell(node)?;
                fill(&made, node, bound, local)?;
                return Ok(Value::Object(made));
            };
            match kind.as_str() {
                "undefined" => Value::Undefined,
                "number" => Value::Number(
                    node.text("value")
                        .and_then(|word| number_word(&word))
                        .ok_or_else(|| RebuildError("a number node of no known value".into()))?,
                ),
                "id" => {
                    let n = node.integer("n").ok_or_else(|| RebuildError("an id without its number".into()))?;
                    let value = node.get("value").ok_or_else(|| RebuildError("an id without its value".into()))?;
                    if let Some(known) = bound.get(&n).cloned() {
                        local.insert(n, known.clone());
                        reconcile(&known, value, bound, local)?;
                        return Ok(Value::Object(known));
                    }
                    let made = shell(value)?;
                    bound.insert(n, made.clone());
                    local.insert(n, made.clone());
                    fill(&made, value, bound, local)?;
                    Value::Object(made)
                }
                "ref" => {
                    let n = node.integer("n").ok_or_else(|| RebuildError("a ref without its number".into()))?;
                    Value::Object(local.get(&n).cloned().ok_or_else(|| RebuildError(format!("ref {n} before its id")))?)
                }
                _ => {
                    let made = shell(node)?;
                    fill(&made, node, bound, local)?;
                    Value::Object(made)
                }
            }
        }
    })
}

/// A fresh object of the node's kind with nothing in it yet.
fn shell(node: &Json) -> Result<Obj, RebuildError> {
    let array = |class: Option<Str>| {
        Obj::new(
            Kind::Array {
                elements: Elements::default(),
                class,
            },
            Props::default(),
        )
    };
    if node.as_array().is_some() {
        return Ok(array(None));
    }
    let Some(kind) = tag(node) else { return Ok(Obj::object()) };
    Ok(match kind.as_str() {
        "escape" => Obj::object(),
        "nullproto" => Obj::new(Kind::Object(Proto::Null), Props::default()),
        "array" => array(match node.get("className") {
            Some(Json::String(name)) => Some(name.clone()),
            Some(_) => return refuse("an array subclass with no constructor name"),
            None => None,
        }),
        "map" if node.get("className").is_none() => Obj::new(Kind::Map(Vec::new()), Props::default()),
        "set" if node.get("className").is_none() => Obj::new(Kind::Set(Vec::new()), Props::default()),
        "class" => {
            let name = match node.get("name") {
                Some(Json::String(name)) => Some(name.clone()),
                Some(Json::Null) => None,
                _ => return refuse("a class node without a name"),
            };
            if let Some(error) = node.get("error") {
                if node.get("errors").is_some() || error.get("code").is_some() {
                    return refuse("an AggregateError or a DOMException");
                }
                let text = |key: &str| error.get(key).and_then(Json::as_str).cloned().unwrap_or_else(|| s(""));
                Obj::new(
                    Kind::Error {
                        class: name.unwrap_or_else(|| s("")),
                        name: text("name"),
                        message: text("message"),
                        cause: None,
                    },
                    Props::default(),
                )
            } else if node.get("primitive").is_some() {
                leaf(node)
            } else {
                Obj::new(Kind::Object(Proto::Class(name)), Props::default())
            }
        }
        "function" => Obj::new(
            Kind::Function {
                name: node.get("name").and_then(Json::as_str).cloned().unwrap_or_else(|| s("")),
                port: node.get("port").and_then(Json::as_str).cloned(),
            },
            Props::default(),
        ),
        "port" => Obj::new(
            Kind::Port(node.get("name").and_then(Json::as_str).cloned().unwrap_or_else(|| s(""))),
            Props::default(),
        ),
        // A Date is a value the families read (its text, its JSON, its time), so it is no carried leaf.
        "date" => {
            let time = match node.get("value") {
                Some(Json::Number(value)) => *value,
                Some(number) if number.is_tag("number") => number
                    .text("value")
                    .and_then(|word| number_word(&word))
                    .ok_or_else(|| RebuildError("a date of no known time".into()))?,
                _ => return refuse("a date without its time"),
            };
            Obj::new(Kind::Date(time), Props::default())
        }
        other if LEAVES.contains(&other) => {
            if holds_identity(node) {
                return refuse(format!("a {other} value that holds objects"));
            }
            leaf(node)
        }
        other => return refuse(format!("a {other} value, which no ported family takes")),
    })
}

fn leaf(node: &Json) -> Obj {
    Obj::new(Kind::Leaf(Rc::new(node.clone())), Props::default())
}

/// The tree inside a leaf, as it came.
pub fn leaf_tree(object: &Obj) -> Option<Json> {
    match &object.borrow().kind {
        Kind::Leaf(tree) => tree.downcast_ref::<Json>().cloned(),
        _ => None,
    }
}

fn holds_identity(node: &Json) -> bool {
    match node {
        Json::Array(items) => items.iter().any(holds_identity),
        Json::Object(members) => node.is_tag("id") || node.is_tag("ref") || members.iter().any(|(_, value)| holds_identity(value)),
        _ => false,
    }
}

fn is_hole(node: &Json) -> Option<i64> {
    if node.is_tag("hole") { Some(node.integer("n").unwrap_or(-1)) } else { None }
}

/// An object's members from a tree of members (an accessor is refused).
fn members(node: &Json, bound: &mut HashMap<i64, Obj>, local: &mut HashMap<i64, Obj>) -> Result<Vec<(Str, Value)>, RebuildError> {
    let Json::Object(items) = node else {
        return refuse("members that are no object");
    };
    let mut out = Vec::with_capacity(items.len());
    for (key, value) in items {
        if value.is_tag("accessor") {
            return refuse("an accessor member");
        }
        out.push((key.clone(), visit(value, bound, local)?));
    }
    Ok(out)
}

/// An array's index members from its items: a hole run is a count, never an allocation (the C0i review's M4a), so
/// what this takes is bounded by the tree's own size; a length past 2^32 - 1, or a hole count that is no positive
/// integer, is refused as the JavaScript codec cannot have written it.
fn elements(items: &[Json], bound: &mut HashMap<i64, Obj>, local: &mut HashMap<i64, Obj>) -> Result<Elements, RebuildError> {
    let mut out = Elements::default();
    for item in items {
        if let Some(count) = is_hole(item) {
            let count = u64::try_from(count).ok().filter(|count| *count > 0);
            if !count.is_some_and(|count| out.push_holes(count)) {
                return refuse("a hole run that is no positive count, or an array longer than 2^32 - 1");
            }
            continue;
        }
        if item.is_tag("accessor") {
            return refuse("an accessor element");
        }
        let value = visit(item, bound, local)?;
        if !out.push(value) {
            return refuse("an array longer than 2^32 - 1");
        }
    }
    Ok(out)
}

/// Fills a fresh shell with the node's content.
fn fill(target: &Obj, node: &Json, bound: &mut HashMap<i64, Obj>, local: &mut HashMap<i64, Obj>) -> Result<(), RebuildError> {
    if let Some(items) = node.as_array() {
        let made = elements(items, bound, local)?;
        if let Kind::Array { elements, .. } = &mut target.borrow_mut().kind {
            *elements = made;
        }
        return Ok(());
    }
    let Some(kind) = tag(node) else {
        let made = members(node, bound, local)?;
        let mut data = target.borrow_mut();
        for (key, value) in made {
            data.props.set(key, value);
        }
        return Ok(());
    };
    match kind.as_str() {
        "escape" | "nullproto" | "class" => {
            let value = node.get("value").ok_or_else(|| RebuildError(format!("a {kind} node without its value")))?;
            if kind == "class" && node.get("primitive").is_some() {
                return Ok(());
            }
            let made = members(value, bound, local)?;
            let cause = match node.get("cause") {
                Some(cause) => Some(visit(cause, bound, local)?),
                None => None,
            };
            let mut data = target.borrow_mut();
            for (key, value) in made {
                data.props.set(key, value);
            }
            if let (Kind::Error { cause: slot, .. }, Some(cause)) = (&mut data.kind, cause) {
                *slot = Some(cause);
            }
        }
        "array" => {
            let items = node
                .get("items")
                .and_then(Json::as_array)
                .ok_or_else(|| RebuildError("an array node without items".into()))?;
            let made = elements(items, bound, local)?;
            let props = match node.get("props") {
                Some(props) => members(props, bound, local)?,
                None => Vec::new(),
            };
            let mut data = target.borrow_mut();
            if let Kind::Array { elements, .. } = &mut data.kind {
                *elements = made;
            }
            for (key, value) in props {
                if array_index(&key).is_some() {
                    return refuse("an array member with an index key");
                }
                data.props.set(key, value);
            }
        }
        "map" => {
            let entries = node
                .get("entries")
                .and_then(Json::as_array)
                .ok_or_else(|| RebuildError("a map without entries".into()))?;
            let mut made = Vec::with_capacity(entries.len());
            for entry in entries {
                let pair = entry
                    .as_array()
                    .filter(|pair| pair.len() == 2)
                    .ok_or_else(|| RebuildError("a map entry that is no pair".into()))?;
                made.push((visit(&pair[0], bound, local)?, visit(&pair[1], bound, local)?));
            }
            // A later entry of the same key replaces the value in the first one's place, as Map.prototype.set.
            let mut unique: Vec<(Value, Value)> = Vec::with_capacity(made.len());
            let mut seen: HashMap<MapKey, usize> = HashMap::with_capacity(made.len());
            for (key, value) in made {
                match seen.get(&MapKey::of(&key)) {
                    Some(at) => unique[*at].1 = value,
                    None => {
                        seen.insert(MapKey::of(&key), unique.len());
                        unique.push((key, value));
                    }
                }
            }
            target.borrow_mut().kind = Kind::Map(unique);
        }
        "set" => {
            let values = node
                .get("values")
                .and_then(Json::as_array)
                .ok_or_else(|| RebuildError("a set without values".into()))?;
            let mut made: Vec<Value> = Vec::with_capacity(values.len());
            let mut seen: HashSet<MapKey> = HashSet::with_capacity(values.len());
            for item in values {
                let value = visit(item, bound, local)?;
                if seen.insert(MapKey::of(&value)) {
                    made.push(value);
                }
            }
            target.borrow_mut().kind = Kind::Set(made);
        }
        _ => {}
    }
    Ok(())
}

/// Brings an object the case already holds to the content `node` gives it, in place (identity kept).
fn reconcile(target: &Obj, node: &Json, bound: &mut HashMap<i64, Obj>, local: &mut HashMap<i64, Obj>) -> Result<(), RebuildError> {
    let kind_matches = match (&target.borrow().kind, tag(node).as_deref()) {
        (Kind::Array { .. }, None) => node.as_array().is_some(),
        (Kind::Array { .. }, Some("array")) => true,
        (Kind::Object(_), None) => node.as_array().is_none(),
        (Kind::Object(_), Some("escape" | "nullproto" | "class")) => true,
        (Kind::Error { .. }, Some("class")) => true,
        (Kind::Map(_), Some("map")) | (Kind::Set(_), Some("set")) => true,
        (Kind::Function { .. } | Kind::Port(_) | Kind::Leaf(_) | Kind::Date(_), _) => return Ok(()),
        _ => false,
    };
    if !kind_matches {
        return refuse("an object the case holds is named again as a value of another kind");
    }
    match tag(node).as_deref() {
        None if node.as_array().is_some() => {
            let made = elements(node.as_array().unwrap_or_default(), bound, local)?;
            if let Kind::Array { elements, .. } = &mut target.borrow_mut().kind {
                *elements = made;
            }
        }
        Some("array") => {
            target.borrow_mut().props = Props::default();
            fill(target, node, bound, local)?;
        }
        Some("map" | "set") => fill(target, node, bound, local)?,
        _ => {
            let value = if tag(node).is_some() {
                node.get("value").ok_or_else(|| RebuildError("a node without its value".into()))?
            } else {
                node
            };
            let made = members(value, bound, local)?;
            let mut data = target.borrow_mut();
            let same_keys = data
                .props
                .entries()
                .iter()
                .map(|(key, _)| key.clone())
                .eq(made.iter().map(|(key, _)| key.clone()));
            if !same_keys {
                data.props = Props::default();
            }
            for (key, value) in made {
                data.props.set(key, value);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- snapshots

/// A slot of a snapshot: a tree, or an object (its number in the case's identity scope, `id()`).
#[derive(Clone)]
enum Slot {
    Tree(Json),
    Object(u64),
}

/// An object's content when the snapshot was taken.
enum Body {
    Members {
        members: Vec<(Str, Slot)>,
        wrap: Wrap,
    },
    Array {
        /// The members present by index, and the length (holes are the indices between).
        items: Vec<(u32, Slot)>,
        len: u32,
        class: Option<Str>,
        props: Vec<(Str, Slot)>,
    },
    Map(Vec<(Slot, Slot)>),
    Set(Vec<Slot>),
    Error {
        class: Str,
        name: Str,
        message: Str,
        members: Vec<(Str, Slot)>,
        cause: Option<Slot>,
    },
    Tree(Json),
}

enum Wrap {
    Plain,
    NullProto,
    Class(Option<Str>),
}

/// A value taken now: its root and every object it reaches, with how often.
pub struct Snapshot {
    root: Slot,
    nodes: Vec<(u64, usize, Body)>,
}

/// Takes `value`'s content now (codec.mjs `snapshot`).
pub fn snapshot(value: &Value) -> Snapshot {
    let mut nodes: Vec<(u64, usize, Body)> = Vec::new();
    let mut index: HashMap<u64, usize> = HashMap::new();
    let root = build(value, &mut nodes, &mut index);
    Snapshot { root, nodes }
}

fn number_tree(value: f64) -> Json {
    if devryan_client_engine::plant::on("rv-codec-negative-zero-lost") && value == 0.0 {
        return Json::Number(0.0);
    }
    let word = if value.is_nan() {
        "NaN"
    } else if value == f64::INFINITY {
        "Infinity"
    } else if value == f64::NEG_INFINITY {
        "-Infinity"
    } else if value == 0.0 && value.is_sign_negative() {
        "-0"
    } else {
        return Json::Number(value);
    };
    Json::object(vec![("$dr", Json::str("number")), ("value", Json::str(word))])
}

fn build(value: &Value, nodes: &mut Vec<(u64, usize, Body)>, index: &mut HashMap<u64, usize>) -> Slot {
    match value {
        Value::Undefined => Slot::Tree(Json::object(vec![("$dr", Json::str("undefined"))])),
        Value::Null => Slot::Tree(Json::Null),
        Value::Bool(value) => Slot::Tree(Json::Bool(*value)),
        Value::Number(value) => Slot::Tree(number_tree(*value)),
        Value::String(text) => Slot::Tree(Json::String(text.clone())),
        Value::Object(object) => {
            let id = object.id();
            if let Some(at) = index.get(&id) {
                nodes[*at].1 += 1;
                return Slot::Object(id);
            }
            index.insert(id, nodes.len());
            nodes.push((id, 1, Body::Tree(Json::Null)));
            let at = nodes.len() - 1;
            let body = describe(object, nodes, index);
            nodes[at].2 = body;
            Slot::Object(id)
        }
    }
}

fn describe(object: &Obj, nodes: &mut Vec<(u64, usize, Body)>, index: &mut HashMap<u64, usize>) -> Body {
    let data = object.borrow();
    let props: Vec<(Str, Value)> = data.props.entries();
    let slots = |list: Vec<(Str, Value)>, nodes: &mut Vec<(u64, usize, Body)>, index: &mut HashMap<u64, usize>| {
        list.into_iter().map(|(key, value)| (key, build(&value, nodes, index))).collect::<Vec<_>>()
    };
    match &data.kind {
        Kind::Object(proto) => {
            let wrap = match proto {
                Proto::Object => Wrap::Plain,
                Proto::Null => Wrap::NullProto,
                Proto::Class(name) => Wrap::Class(name.clone()),
            };
            let kind_props = props;
            drop(data);
            Body::Members {
                members: slots(kind_props, nodes, index),
                wrap,
            }
        }
        Kind::Array { elements, class } => {
            let elements = elements.clone();
            let class = class.clone();
            drop(data);
            let items = elements.present().map(|(at, value)| (at, build(value, nodes, index))).collect();
            Body::Array {
                items,
                len: elements.len(),
                class,
                props: slots(props, nodes, index),
            }
        }
        Kind::Map(entries) => {
            let entries = entries.clone();
            drop(data);
            Body::Map(
                entries
                    .iter()
                    .map(|(key, value)| (build(key, nodes, index), build(value, nodes, index)))
                    .collect(),
            )
        }
        Kind::Set(values) => {
            let values = values.clone();
            drop(data);
            Body::Set(values.iter().map(|value| build(value, nodes, index)).collect())
        }
        Kind::Error { class, name, message, cause } => {
            let (class, name, message, cause) = (class.clone(), name.clone(), message.clone(), cause.clone());
            drop(data);
            let members = slots(props, nodes, index);
            Body::Error {
                class,
                name,
                message,
                members,
                cause: cause.map(|cause| build(&cause, nodes, index)),
            }
        }
        Kind::Function { name, port } => {
            let mut members = vec![("$dr", Json::str("function")), ("name", Json::String(name.clone()))];
            if let Some(port) = port {
                members.push(("port", Json::String(port.clone())));
            }
            Body::Tree(Json::object(members))
        }
        Kind::Port(name) => Body::Tree(Json::object(vec![("$dr", Json::str("port")), ("name", Json::String(name.clone()))])),
        Kind::Leaf(tree) => Body::Tree(tree.downcast_ref::<Json>().cloned().unwrap_or(Json::Null)),
        Kind::Date(time) => Body::Tree(Json::object(vec![("$dr", Json::str("date")), ("value", number_tree(*time))])),
    }
}

/// Writes the snapshots of one identity scope, in order (codec.mjs `emitSlots`).
pub fn emit_slots(snapshots: &[&Snapshot]) -> Vec<Json> {
    let mut totals: HashMap<u64, usize> = HashMap::new();
    for snapshot in snapshots {
        for (id, seen, _) in &snapshot.nodes {
            *totals.entry(*id).or_default() += seen;
        }
    }
    let mut numbers: HashMap<u64, i64> = HashMap::new();
    let mut next = 0;
    let mut out = Vec::with_capacity(snapshots.len());
    for snapshot in snapshots {
        let bodies: HashMap<u64, &Body> = snapshot.nodes.iter().map(|(id, _, body)| (*id, body)).collect();
        let mut emitter = Emitter {
            bodies,
            totals: &totals,
            numbers: &mut numbers,
            next: &mut next,
            here: HashSet::new(),
        };
        out.push(emitter.emit(&snapshot.root));
    }
    out
}

struct Emitter<'a> {
    bodies: HashMap<u64, &'a Body>,
    totals: &'a HashMap<u64, usize>,
    numbers: &'a mut HashMap<u64, i64>,
    next: &'a mut i64,
    here: HashSet<u64>,
}

impl Emitter<'_> {
    fn emit(&mut self, slot: &Slot) -> Json {
        let id = match slot {
            Slot::Tree(tree) => return tree.clone(),
            Slot::Object(id) => *id,
        };
        if self.totals.get(&id).copied().unwrap_or(0) > 1 {
            let n = match self.numbers.get(&id) {
                Some(n) => *n,
                None => {
                    *self.next += 1;
                    self.numbers.insert(id, *self.next);
                    *self.next
                }
            };
            if !self.here.insert(id) {
                return Json::object(vec![("$dr", Json::str("ref")), ("n", Json::Number(n as f64))]);
            }
            let body = self.body(id);
            return Json::object(vec![("$dr", Json::str("id")), ("n", Json::Number(n as f64)), ("value", body)]);
        }
        self.body(id)
    }

    fn members(&mut self, members: &[(Str, Slot)]) -> Vec<(Str, Json)> {
        members.iter().map(|(key, slot)| (key.clone(), self.emit(slot))).collect()
    }

    fn body(&mut self, id: u64) -> Json {
        let Some(body) = self.bodies.get(&id).copied() else { return Json::Null };
        let tagged = |tag: &str, rest: Vec<(&str, Json)>| {
            let mut members = vec![("$dr", Json::str(tag))];
            members.extend(rest);
            Json::object(members)
        };
        match body {
            Body::Tree(tree) => tree.clone(),
            Body::Members { members, wrap } => {
                let written = Json::Object(self.members(members));
                match wrap {
                    Wrap::NullProto => tagged("nullproto", vec![("value", written)]),
                    Wrap::Class(name) => tagged("class", vec![("name", name.clone().map_or(Json::Null, Json::String)), ("value", written)]),
                    Wrap::Plain if written.get("$dr").is_some() => tagged("escape", vec![("value", written)]),
                    Wrap::Plain => written,
                }
            }
            Body::Array { items, len, class, props } => {
                let mut written = Vec::with_capacity(items.len());
                let mut next: u32 = 0;
                for (index, slot) in items {
                    if *index > next {
                        written.push(tagged("hole", vec![("n", Json::Number(f64::from(index - next)))]));
                    }
                    written.push(self.emit(slot));
                    next = index + 1;
                }
                if *len > next {
                    written.push(tagged("hole", vec![("n", Json::Number(f64::from(len - next)))]));
                }
                if class.is_none() && props.is_empty() {
                    return Json::Array(written);
                }
                let mut rest = vec![("items", Json::Array(written))];
                if let Some(class) = class {
                    rest.push(("className", Json::String(class.clone())));
                }
                if !props.is_empty() {
                    rest.push(("props", Json::Object(self.members(props))));
                }
                tagged("array", rest)
            }
            Body::Map(entries) => {
                let written = entries.iter().map(|(key, value)| Json::Array(vec![self.emit(key), self.emit(value)])).collect();
                tagged("map", vec![("entries", Json::Array(written))])
            }
            Body::Set(values) => {
                let written = values.iter().map(|value| self.emit(value)).collect();
                tagged("set", vec![("values", Json::Array(written))])
            }
            Body::Error {
                class,
                name,
                message,
                members,
                cause,
            } => {
                let error = Json::object(vec![("name", Json::String(name.clone())), ("message", Json::String(message.clone()))]);
                let mut rest = vec![
                    ("name", Json::String(class.clone())),
                    ("error", error),
                    ("value", Json::Object(self.members(members))),
                ];
                if let Some(cause) = cause {
                    rest.push(("cause", self.emit(cause)));
                }
                tagged("class", rest)
            }
        }
    }
}

// ---------------------------------------------------------------- paths

/// A part of a path into a value: a member key, an array index, or a Map entry (by its key) as the recorder writes it.
#[derive(Clone)]
pub enum Part {
    Key(Str),
    Index(u32),
    Map(Value),
}

/// The value at `path` in `root` (a bind's path: keys, indices, `{map, part}`, `{set}`, `{own}`).
pub fn at_path(root: &Value, path: &[Json]) -> Option<Value> {
    let mut value = root.clone();
    for part in path {
        let Value::Object(object) = &value else { return None };
        let next = match part {
            Json::String(key) => own_data(object, key),
            Json::Number(index) => own_data(object, &s(&devryan_client_engine::js::number::to_string(*index))),
            Json::Object(_) => {
                if let Some(index) = part.integer("map") {
                    let which = part.integer("part")?;
                    let data = object.borrow();
                    let Kind::Map(entries) = &data.kind else { return None };
                    let entry = entries.get(usize::try_from(index).ok()?)?;
                    match which {
                        0 => Some(entry.0.clone()),
                        1 => Some(entry.1.clone()),
                        _ => None,
                    }
                } else if let Some(index) = part.integer("set") {
                    let data = object.borrow();
                    let Kind::Set(values) = &data.kind else { return None };
                    values.get(usize::try_from(index).ok()?).cloned()
                } else if let Some(key) = part.get("own").and_then(Json::as_str) {
                    own_data(object, key)
                } else {
                    None
                }
            }
            _ => None,
        };
        value = next?;
    }
    Some(value)
}

/// An own data member, as `getOwnPropertyDescriptor(...).value` reads it (an array's `length` included).
fn own_data(object: &Obj, key: &[u16]) -> Option<Value> {
    let data = object.borrow();
    if let Kind::Array { elements, .. } = &data.kind {
        if key.iter().copied().eq("length".encode_utf16()) {
            return Some(Value::Number(f64::from(elements.len())));
        }
        if let Some(index) = array_index(key) {
            return elements.get(index).cloned();
        }
    }
    if let Kind::Error { message, .. } = &data.kind
        && key.iter().copied().eq("message".encode_utf16())
        && !data.props.has(key)
    {
        return Some(Value::String(message.clone()));
    }
    data.props.get(key).cloned()
}

/// Every object reached from `root` with its path (engine-ts.mjs `identityPaths`, the recorder's change-set rule):
/// each object once below (a second sight is listed, not walked), functions not walked, Map entries by key.
pub fn identity_paths(root: &Value) -> Vec<(Vec<Part>, Obj)> {
    let mut out = Vec::new();
    let mut visited: HashSet<u64> = HashSet::new();
    walk(root, Vec::new(), &mut out, &mut visited);
    out
}

fn walk(value: &Value, at: Vec<Part>, out: &mut Vec<(Vec<Part>, Obj)>, visited: &mut HashSet<u64>) {
    let Value::Object(object) = value else { return };
    out.push((at.clone(), object.clone()));
    if !visited.insert(object.id()) || object.is_function() {
        return;
    }
    let children: Vec<(Part, Value)> = {
        let data = object.borrow();
        match &data.kind {
            Kind::Map(entries) => entries.iter().map(|(key, entry)| (Part::Map(key.clone()), entry.clone())).collect(),
            // A Set has no own members; a port and a leaf are walked by their own members (none the families hold).
            // A function is not walked; a port and a leaf hold no member the families write.
            Kind::Port(_) | Kind::Leaf(_) | Kind::Function { .. } => Vec::new(),
            // A Set or a Date is walked by its own members, as the recorder walks every object.
            Kind::Set(_) | Kind::Date(_) => data.props.entries().into_iter().map(|(key, value)| (Part::Key(key), value)).collect(),
            Kind::Array { elements, .. } => {
                let mut list: Vec<(Part, Value)> = elements.present().map(|(index, item)| (Part::Index(index), item.clone())).collect();
                list.extend(data.props.entries().into_iter().map(|(key, value)| (Part::Key(key), value)));
                list
            }
            _ => data.props.entries().into_iter().map(|(key, value)| (Part::Key(key), value)).collect(),
        }
    };
    for (part, child) in children {
        let mut next = at.clone();
        next.push(part);
        walk(&child, next, out, visited);
    }
}

/// The change set: every path of `after`'s walk whose object is not the one the same path held in `before`.
pub fn changed_paths(before: &[(Vec<Part>, Obj)], after: &[(Vec<Part>, Obj)]) -> Vec<Vec<Part>> {
    let mut keys: Vec<Value> = Vec::new();
    let mut key_of = |path: &[Part]| -> Vec<u8> {
        let mut out = Vec::new();
        for part in path {
            match part {
                Part::Key(key) => {
                    out.push(b'k');
                    for unit in key.iter() {
                        out.extend_from_slice(&unit.to_le_bytes());
                    }
                }
                Part::Index(index) => {
                    out.push(b'i');
                    out.extend_from_slice(&index.to_le_bytes());
                }
                Part::Map(key) => {
                    let id = keys
                        .iter()
                        .position(|known| devryan_client_engine::js::same_value_zero(known, key))
                        .unwrap_or_else(|| {
                            keys.push(key.clone());
                            keys.len() - 1
                        });
                    out.push(b'm');
                    out.extend_from_slice(&id.to_le_bytes());
                }
            }
            out.push(0xff);
        }
        out
    };
    let mut known: HashMap<Vec<u8>, u64> = HashMap::new();
    for (path, object) in before {
        known.insert(key_of(path), object.id());
    }
    after
        .iter()
        .filter(|(path, object)| known.get(&key_of(path)) != Some(&object.id()))
        .map(|(path, _)| path.clone())
        .collect()
}

/// A change set as the value the recorder takes: a list of paths, each a list of keys, indices and `{map: key}`.
pub fn paths_value(paths: &[Vec<Part>]) -> Value {
    let items = paths
        .iter()
        .map(|path| {
            let parts = path
                .iter()
                .map(|part| match part {
                    Part::Key(key) => Value::String(key.clone()),
                    Part::Index(index) => Value::Number(f64::from(*index)),
                    Part::Map(key) => Value::Object(Obj::object_from(vec![(s("map"), key.clone())])),
                })
                .collect();
            Value::Object(Obj::array(parts))
        })
        .collect();
    Value::Object(Obj::array(items))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{parse, write};

    fn text(tree: &Json) -> String {
        let mut out = Vec::new();
        write(tree, &mut out);
        String::from_utf8(out).unwrap()
    }

    /// Rebuilds each tree in one case scope and writes them back as one identity scope.
    fn round_trip(trees: &[&str]) -> Vec<String> {
        let mut bound = HashMap::new();
        let values: Vec<Value> = trees
            .iter()
            .map(|tree| rebuild(&parse(tree.as_bytes()).unwrap(), &mut bound).unwrap())
            .collect();
        let snapshots: Vec<Snapshot> = values.iter().map(snapshot).collect();
        emit_slots(&snapshots.iter().collect::<Vec<_>>()).iter().map(text).collect()
    }

    #[test]
    fn trees_the_families_exchange_round_trip_byte_for_byte() {
        for tree in [
            r#"[1,{"$dr":"hole","n":2},"x",{"$dr":"undefined"},{"$dr":"number","value":"NaN"},{"$dr":"number","value":"-0"}]"#,
            r#"{"$dr":"escape","value":{"$dr":"x","a":1}}"#,
            r#"{"$dr":"nullproto","value":{"b":2,"a":1}}"#,
            r#"{"$dr":"class","name":"Point","value":{"x":1}}"#,
            r#"{"$dr":"class","name":null,"value":{}}"#,
            r#"{"$dr":"array","items":[1],"props":{"extra":true}}"#,
            r#"{"$dr":"map","entries":[["k",{"$dr":"set","values":[1,"a"]}]]}"#,
            r#"{"$dr":"class","name":"Error","error":{"name":"Error","message":"m"},"value":{"status":503},"cause":"why"}"#,
            r#"{"$dr":"function","name":"f","port":"onRefresh"}"#,
            r#"{"$dr":"date","value":1700000000000}"#,
            r#"{"$dr":"bytes","base64":"AAE="}"#,
            r#"{"a":{"$dr":"id","n":1,"value":{"x":[{"$dr":"ref","n":1}]}},"b":{"$dr":"ref","n":1}}"#,
        ] {
            assert_eq!(round_trip(&[tree]), vec![tree.to_owned()], "{tree}");
        }
        // Integer-like keys come first, ascending, as JSON.parse and every JavaScript object order them.
        assert_eq!(
            round_trip(&[r#"{"b":"bee","2":"two","1":"one"}"#]),
            vec![r#"{"1":"one","2":"two","b":"bee"}"#.to_owned()]
        );
    }

    #[test]
    fn an_object_in_two_slots_gets_an_id_in_each_numbered_by_first_appearance() {
        let written = round_trip(&[
            r#"[{"$dr":"id","n":7,"value":{"a":1}},{"$dr":"id","n":3,"value":{}}]"#,
            r#"[{"$dr":"id","n":3,"value":{}},{"$dr":"id","n":7,"value":{"a":1}}]"#,
        ]);
        assert_eq!(
            written,
            vec![
                r#"[{"$dr":"id","n":1,"value":{"a":1}},{"$dr":"id","n":2,"value":{}}]"#,
                r#"[{"$dr":"id","n":2,"value":{}},{"$dr":"id","n":1,"value":{"a":1}}]"#
            ]
        );
    }

    #[test]
    fn what_needs_behaviour_the_families_lack_is_refused() {
        for tree in [
            r#"{"$dr":"bigint","value":"1"}"#,
            r#"{"$dr":"promise"}"#,
            r#"{"$dr":"symbol","n":1}"#,
            r#"{"a":{"$dr":"accessor","get":true,"set":false}}"#,
            r#"{"$dr":"ref","n":1}"#,
            r#"{"$dr":"abortsignal","aborted":true,"reason":{"$dr":"id","n":1,"value":{}}}"#,
        ] {
            assert!(rebuild(&parse(tree.as_bytes()).unwrap(), &mut HashMap::new()).is_err(), "{tree}");
        }
    }

    #[test]
    fn a_known_object_is_brought_in_place_to_the_content_given() {
        let mut bound = HashMap::new();
        let first = rebuild(&parse(br#"{"$dr":"id","n":1,"value":{"a":1,"b":2}}"#).unwrap(), &mut bound).unwrap();
        let again = rebuild(&parse(br#"{"$dr":"id","n":1,"value":{"b":3}}"#).unwrap(), &mut bound).unwrap();
        let (Value::Object(first), Value::Object(again)) = (first, again) else {
            panic!("objects")
        };
        assert!(first.same(&again));
        assert_eq!(text(&emit_slots(&[&snapshot(&Value::Object(first))])[0]), r#"{"b":3}"#);
    }

    #[test]
    fn change_sets_follow_identity_by_path() {
        let mut bound = HashMap::new();
        let root = rebuild(&parse(br#"{"a":{"x":{}},"m":{"$dr":"map","entries":[[1,{}]]}}"#).unwrap(), &mut bound).unwrap();
        let before = identity_paths(&root);
        let Value::Object(object) = &root else { panic!("object") };
        let fresh = Value::Object(Obj::object());
        object.borrow_mut().props.set(s("b"), fresh);
        let after = identity_paths(&root);
        let changes = paths_value(&changed_paths(&before, &after));
        assert_eq!(text(&emit_slots(&[&snapshot(&changes)])[0]), r#"[["b"]]"#);
    }
}
