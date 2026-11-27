//! The process candidate's protocol (`devryan-scheduler-candidate`, version 1;
//! `scripts/scheduler-conformance/process-candidate.mjs` is its other side and
//! says what each message means): one JSON object per line on stdin and
//! stdout, values tagged under `$`, objects named by ids that both sides keep
//! for good, so identity crosses both ways.
//!
//! This side only answers: every request of the host is answered once, after
//! the requests of this side it caused (a port call, an option read), which
//! the host answers in turn. A request this side makes waits for its answer;
//! a `sync` the host sends meanwhile is answered there, any other input
//! arriving there (one the recording places inside a port call) is refused.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::rc::Rc;

use devryan_js_layer::js::{self, JsObject, JsStr, Value};

use crate::value::{Body, HostRef, Obj, ObjData, Props, V};

pub const PROTOCOL: &str = "devryan-scheduler-candidate";
pub const PROTOCOL_VERSION: f64 = 1.0;

thread_local! {
    static IO: RefCell<Option<Io>> = const { RefCell::new(None) };
    /// Every object and function that crossed, by id.
    static REGISTRY: RefCell<HashMap<i64, V>> = RefCell::new(HashMap::new());
    static NEXT_ID: Cell<i64> = const { Cell::new(0) };
}

struct Io {
    input: Box<dyn BufRead>,
    output: Box<dyn Write>,
}

/// Installs the streams (stdin and stdout in the binary).
pub fn install(input: Box<dyn BufRead>, output: Box<dyn Write>) {
    IO.with(|io| *io.borrow_mut() = Some(Io { input, output }));
}

/// The next line as a JSON tree; `None` at the end of input.
pub fn read() -> Option<Value> {
    let mut line = String::new();
    let read = IO.with(|io| io.borrow_mut().as_mut().expect("streams installed").input.read_line(&mut line));
    match read {
        Ok(0) => None,
        Ok(_) => match js::parse_utf8(line.trim_end_matches('\n').as_bytes()) {
            Ok(tree) => Some(tree),
            Err(_) => fatal("a line that is no JSON"),
        },
        Err(_) => None,
    }
}

/// Writes one line.
pub fn write(tree: &Value) {
    let Ok(Some(mut bytes)) = js::stringify_utf8(tree) else {
        fatal("a message that does not stringify")
    };
    bytes.push(b'\n');
    let failed = IO.with(|io| {
        let mut io = io.borrow_mut();
        let output = &mut io.as_mut().expect("streams installed").output;
        output.write_all(&bytes).and_then(|()| output.flush()).is_err()
    });
    if failed {
        std::process::exit(0);
    }
}

/// A fatal error of this process: reported, then the process ends.
pub fn fatal(message: &str) -> ! {
    let mut out = JsObject::new();
    out.set("x", Value::string(message));
    let bytes = js::stringify_utf8(&Value::Object(out)).ok().flatten().unwrap_or_default();
    IO.with(|io| {
        if let Ok(mut io) = io.try_borrow_mut()
            && let Some(io) = io.as_mut()
        {
            let _ = io.output.write_all(&bytes);
            let _ = io.output.write_all(b"\n");
            let _ = io.output.flush();
        }
    });
    std::process::exit(70);
}

pub fn obj(entries: Vec<(&str, Value)>) -> Value {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    Value::Object(out)
}

pub fn get<'a>(tree: &'a Value, key: &str) -> &'a Value {
    static UNDEFINED: Value = Value::Undefined;
    tree.as_object().and_then(|object| object.get_str(key)).unwrap_or(&UNDEFINED)
}

pub fn text(tree: &Value, key: &str) -> String {
    match get(tree, key) {
        Value::String(text) => text.to_string_lossy(),
        _ => String::new(),
    }
}

pub fn number(tree: &Value, key: &str) -> f64 {
    match get(tree, key) {
        Value::Number(value) => *value,
        _ => f64::NAN,
    }
}

// ------------------------------------------------------------------ values

fn next_id() -> i64 {
    NEXT_ID.with(|next| {
        next.set(next.get() + 1);
        next.get()
    })
}

fn register(id: i64, value: V) {
    REGISTRY.with(|registry| registry.borrow_mut().insert(id, value));
}

fn lookup(id: i64) -> Option<V> {
    REGISTRY.with(|registry| registry.borrow().get(&id).cloned())
}

/// The id of an object or function, given when it first crosses.
fn id_of(value: &V) -> i64 {
    let cell = match value {
        V::Obj(object) => &object.0.id,
        V::Func(func) => &func.0.id,
        _ => unreachable!("only objects and functions have ids"),
    };
    if cell.get() == 0 {
        cell.set(next_id());
        register(cell.get(), value.clone());
    }
    cell.get()
}

fn tag(name: &str, mut rest: Vec<(&str, Value)>) -> Value {
    rest.insert(0, ("$", Value::string(name)));
    obj(rest)
}

fn props_tree(props: &Props, seen: &mut HashSet<i64>) -> Value {
    Value::Array(
        props
            .entries()
            .into_iter()
            .map(|(key, value)| Value::Array(vec![Value::String(key), encode_in(&value, seen)]))
            .collect(),
    )
}

/// A value on the wire.
pub fn encode(value: &V) -> Value {
    encode_in(value, &mut HashSet::new())
}

fn encode_in(value: &V, seen: &mut HashSet<i64>) -> Value {
    match value {
        V::Undef => tag("u", vec![]),
        V::Null => Value::Null,
        V::Bool(value) => Value::Bool(*value),
        V::Str(text) => Value::String(text.clone()),
        V::Num(number) => {
            let special = if number.is_nan() {
                Some("NaN")
            } else if *number == f64::INFINITY {
                Some("Infinity")
            } else if *number == f64::NEG_INFINITY {
                Some("-Infinity")
            } else if *number == 0.0 && number.is_sign_negative() {
                Some("-0")
            } else {
                None
            };
            match special {
                Some(name) => tag("n", vec![("v", Value::string(name))]),
                None => Value::Number(*number),
            }
        }
        V::Host(reference) => tag("h", vec![("id", Value::Number(reference.id as f64))]),
        V::Opaque(id, _) => tag("x", vec![("id", Value::Number(*id as f64))]),
        V::Promise(_) => crate::host::refuse("a promise inside a value that crosses to the host"),
        V::Func(func) => {
            let id = id_of(value);
            tag("f", vec![("id", Value::Number(id as f64)), ("name", Value::string(&func.0.name))])
        }
        V::Obj(object) => {
            let id = id_of(value);
            if !seen.insert(id) {
                return tag("r", vec![("id", Value::Number(id as f64))]);
            }
            let body = object.0.body.borrow();
            match &*body {
                Body::Object(props) => tag("o", vec![("id", Value::Number(id as f64)), ("p", props_tree(props, seen))]),
                Body::Array(items) => {
                    let items = items.clone();
                    drop(body);
                    tag(
                        "a",
                        vec![
                            ("id", Value::Number(id as f64)),
                            ("i", Value::Array(items.iter().map(|item| encode_in(item, seen)).collect())),
                        ],
                    )
                }
                Body::Error { class, message, props } => tag(
                    "e",
                    vec![
                        ("id", Value::Number(id as f64)),
                        ("cls", Value::string(class)),
                        ("message", Value::String(message.clone())),
                        ("p", props_tree(props, seen)),
                    ],
                ),
            }
        }
    }
}

fn wire_id(tree: &Value) -> i64 {
    let id = number(tree, "id");
    if !id.is_finite() || id == 0.0 {
        fatal("a value with no id");
    }
    id as i64
}

fn decode_props(tree: &Value) -> Props {
    let mut props = Props::new();
    for pair in get(tree, "p").as_array().unwrap_or(&[]) {
        let [Value::String(key), item] = pair.as_array().unwrap_or(&[]) else {
            fatal("a member that is no pair")
        };
        props.set_js(key.clone(), decode(item));
    }
    props
}

/// The live object for an id: the one already known, its content replaced, or a new one.
fn object_for(id: i64, body: Body) -> V {
    if let Some(V::Obj(object)) = lookup(id) {
        *object.0.body.borrow_mut() = body;
        return V::Obj(object);
    }
    let made = V::Obj(Obj(Rc::new(ObjData {
        id: Cell::new(id),
        body: RefCell::new(body),
    })));
    register(id, made.clone());
    made
}

/// A value from the wire.
pub fn decode(tree: &Value) -> V {
    match tree {
        Value::Undefined => V::Undef,
        Value::Null => V::Null,
        Value::Bool(value) => V::Bool(*value),
        Value::Number(value) => V::Num(*value),
        Value::String(text) => V::Str(text.clone()),
        Value::Array(_) => fatal("a bare array on the wire"),
        Value::Object(_) => match text(tree, "$").as_str() {
            "u" => V::Undef,
            "n" => V::Num(match text(tree, "v").as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                _ => fatal("an unknown number"),
            }),
            "r" => lookup(wire_id(tree)).unwrap_or_else(|| fatal("a reference to an object that never crossed")),
            "f" => match lookup(wire_id(tree)) {
                Some(func @ V::Func(_)) => func,
                _ => fatal("a function that is not this process's"),
            },
            "h" => {
                let optional = |key: &str| match get(tree, key) {
                    Value::String(text) => Some(Rc::from(text.to_string_lossy().as_str())),
                    _ => None,
                };
                V::Host(HostRef {
                    id: wire_id(tree),
                    kind: Rc::from(text(tree, "k").as_str()),
                    name: optional("name"),
                    key: optional("key"),
                })
            }
            "x" => {
                let id = number(tree, "id");
                V::Opaque(if id.is_finite() { id as i64 } else { 0 }, Rc::from(text(tree, "what").as_str()))
            }
            "s" => crate::host::refuse("the scheduler object passed back in a value"),
            "o" => {
                let id = wire_id(tree);
                let props = decode_props(tree);
                object_for(id, Body::Object(props))
            }
            "a" => {
                let id = wire_id(tree);
                let items = get(tree, "i").as_array().unwrap_or(&[]).iter().map(decode).collect();
                object_for(id, Body::Array(items))
            }
            "e" => {
                let id = wire_id(tree);
                if let Some(known @ V::Obj(_)) = lookup(id) {
                    return known;
                }
                let message = match get(tree, "message") {
                    Value::String(text) => text.clone(),
                    _ => JsStr::from(""),
                };
                let props = decode_props(tree);
                object_for(
                    id,
                    Body::Error {
                        class: Rc::from(text(tree, "cls").as_str()),
                        message,
                        props,
                    },
                )
            }
            _ => fatal("an unknown value tag"),
        },
    }
}

/// Every object that crossed, as it is now (`sync`).
pub fn sync_list() -> Value {
    let objects: Vec<V> = REGISTRY.with(|registry| {
        let registry = registry.borrow();
        let mut ids: Vec<&i64> = registry.keys().collect();
        ids.sort();
        ids.into_iter()
            .map(|id| registry[id].clone())
            .filter(|value| matches!(value, V::Obj(_)))
            .collect()
    });
    Value::Array(objects.iter().map(encode).collect())
}

/// A function of this process by its id (an input calls it).
pub fn function(id: i64) -> Option<V> {
    match lookup(id) {
        Some(found @ V::Func(_)) => Some(found),
        _ => None,
    }
}
