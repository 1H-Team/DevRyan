//! What this process asks of the host (the replayer, through the process
//! candidate): every effect and every input the scheduler reads. Each call
//! writes one request and waits for its answer (`wire`), answering a `sync`
//! that arrives meanwhile and refusing any other input there.

use devryan_js_layer::jobs::{Promise, Resolvers};
use devryan_js_layer::js::Value;
use std::cell::RefCell;
use std::collections::HashMap;

use crate::value::{HostRef, V};
use crate::wire::{self, decode, encode, get, obj, text};

thread_local! {
    /// Port promises not yet settled, by construction and port.
    static PORTS: RefCell<HashMap<(i64, i64), Resolvers<V, V>>> = RefCell::new(HashMap::new());
}

/// Sends a request and returns its answer (`r`).
fn request(message: Value) -> Value {
    wire::write(&message);
    loop {
        let Some(tree) = wire::read() else { std::process::exit(0) };
        if let Some(answer) = tree.as_object().and_then(|object| object.get_str("r")) {
            return answer.clone();
        }
        match text(&tree, "t").as_str() {
            "sync" => wire::write(&obj(vec![("r", wire::sync_list())])),
            "" => wire::fatal("a line that is neither an answer nor a request"),
            other => refuse(&format!("an input ({other}) the recording places inside a port call (placed during)")),
        }
    }
}

/// Refuses what the case needs: the host stops the case as not-ported and never answers. This process then
/// only answers `sync` until its input ends.
pub fn refuse(detail: &str) -> ! {
    wire::write(&obj(vec![("q", Value::string("refuse")), ("detail", Value::string(detail))]));
    loop {
        let Some(tree) = wire::read() else { std::process::exit(0) };
        if text(&tree, "t") == "sync" {
            wire::write(&obj(vec![("r", wire::sync_list())]));
        }
    }
}

fn c_field(c: i64) -> (&'static str, Value) {
    ("c", Value::Number(c as f64))
}

/// A member of an object the host handed this process (the options, a port object).
pub fn get_member(c: i64, holder: &HostRef, key: &str) -> V {
    let answer = request(obj(vec![
        ("q", Value::string("get")),
        c_field(c),
        ("h", Value::Number(holder.id as f64)),
        ("key", Value::string(key)),
    ]));
    decode(&answer)
}

/// A call of a function the host handed this process: an option member (the clock, a timer, an
/// identifier) or a port. A port's promise is this process's own, observed as the JavaScript candidate
/// observes it, and settled when the host delivers its answer.
pub fn call(c: i64, function: &HostRef, args: &[V]) -> Result<V, V> {
    let answer = request(obj(vec![
        ("q", Value::string("callHost")),
        c_field(c),
        ("h", Value::Number(function.id as f64)),
        ("args", Value::Array(args.iter().map(encode).collect())),
    ]));
    if let Some(value) = answer.as_object().and_then(|object| object.get_str("return")) {
        return Ok(decode(value));
    }
    if let Some(value) = answer.as_object().and_then(|object| object.get_str("throw")) {
        return Err(decode(value));
    }
    let port = wire::number(&answer, "promise");
    if !port.is_finite() {
        wire::fatal("a host call answered with nothing");
    }
    let port = port as i64;
    let (promise, resolvers) = Promise::<V, V>::with_resolvers();
    // The candidate's own observer of the port's promise: it writes the answer's settlement.
    let _ = promise.then(
        move |_| {
            answered(c, port, "resolve");
            Ok(devryan_js_layer::jobs::Resolution::Value(V::Undef))
        },
        move |_| {
            answered(c, port, "reject");
            Ok(devryan_js_layer::jobs::Resolution::Value(V::Undef))
        },
    );
    let settle = get(&answer, "settle");
    if matches!(settle, Value::Object(_)) {
        let value = decode(get(settle, "value"));
        if text(settle, "outcome") == "reject" {
            resolvers.reject(value)
        } else {
            resolvers.fulfill(value)
        }
    } else {
        PORTS.with(|ports| ports.borrow_mut().insert((c, port), resolvers));
    }
    Ok(V::Promise(promise))
}

/// The host delivers a port's answer.
pub fn settle_port(c: i64, port: i64, reject: bool, value: V) {
    let Some(resolvers) = PORTS.with(|ports| ports.borrow_mut().remove(&(c, port))) else {
        wire::fatal("an answer to a port with no promise pending");
    };
    if reject { resolvers.reject(value) } else { resolvers.fulfill(value) }
}

fn answered(c: i64, port: i64, outcome: &str) {
    request(obj(vec![
        ("q", Value::string("answered")),
        c_field(c),
        ("port", Value::Number(port as f64)),
        ("outcome", Value::string(outcome)),
    ]));
}

/// A hidden read (a draw, a clock, an environment variable) at a named site.
pub fn ask(c: i64, kind: &str, fields: Vec<(&str, Value)>) -> V {
    let answer = request(obj(vec![
        ("q", Value::string("ask")),
        c_field(c),
        ("kind", Value::string(kind)),
        ("fields", obj(fields)),
    ]));
    decode(&answer)
}

/// A member's promise settled (the candidate's own observer of it).
pub fn settled(c: i64, call: i64, reject: bool, value: &V) {
    request(obj(vec![
        ("q", Value::string("settle")),
        c_field(c),
        ("call", Value::Number(call as f64)),
        ("outcome", Value::string(if reject { "reject" } else { "resolve" })),
        ("value", encode(value)),
    ]));
}

/// A rejection nothing handled.
pub fn unhandled() {
    request(obj(vec![("q", Value::string("unhandled")), c_field(0)]));
}
