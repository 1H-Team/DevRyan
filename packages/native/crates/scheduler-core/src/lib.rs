//! The orchestration scheduler's core in Rust (plan package OR2), judged only
//! by the scheduler conformance harness (`scripts/scheduler-conformance/`)
//! through its process candidate. Nothing in the product calls, starts or
//! ships it.
//!
//! The core is the JavaScript scheduler (`packages/orchestration-runtime/
//! scheduler.js`) ported function for function on the ledger's job layer
//! (`devryan_js_layer::jobs`): one JavaScript async function is one
//! `async_fn`, one `await` one await, one `.then` one `then`, so every input
//! is taken and every effect made at the place the recording pins, in exact
//! total order (decision OD2). It performs no I/O and reads no clock and no
//! randomness of its own: the clock, the timers, the identifier draws and the
//! ports are the host's (`host`), reached over the protocol (`wire`). Values
//! keep JavaScript's object identity (`value`). What it does not port it
//! refuses (`host::refuse`), and the harness reports the case `not-ported`.
#![forbid(unsafe_code)]

pub mod core;
pub mod host;
pub mod value;
pub mod wire;

use std::io::{BufRead, Write};
use std::rc::Rc;

use devryan_js_layer::jobs::{self, Jobs, Resolution};
use devryan_js_layer::js::Value;

use crate::value::V;
use crate::wire::{decode, encode, get, number, obj, text};

/// Serves the protocol until the host closes the input.
pub fn serve(input: Box<dyn BufRead>, output: Box<dyn Write>, refuse_all: bool) {
    wire::install(input, output);
    let queues = Jobs::new(Rc::new(|| {}));
    jobs::install(queues.clone());
    jobs::register_errors::<V>(|name, message| V::error(name, message, value::Props::new()));
    jobs::on_unhandled_rejection(Rc::new(|_| host::unhandled()));
    let core = core::Core::new();
    while let Some(message) = wire::read() {
        let answer = match text(&message, "t").as_str() {
            "hello" => {
                if text(&message, "protocol") != wire::PROTOCOL || number(&message, "version") != wire::PROTOCOL_VERSION {
                    wire::fatal("the host speaks another protocol or version");
                }
                let members = if refuse_all {
                    Vec::new()
                } else {
                    core::PORTED.iter().map(|name| Value::string(name)).collect()
                };
                let hello = obj(vec![
                    ("protocol", Value::string(wire::PROTOCOL)),
                    ("version", Value::Number(wire::PROTOCOL_VERSION)),
                    ("members", Value::Array(members)),
                ]);
                obj(vec![("r", hello)])
            }
            "construct" | "call" | "invoke" => {
                if refuse_all {
                    host::refuse("anything: this candidate refuses every case (--refuse-all)");
                }
                let c = number(&message, "c") as i64;
                let call = number(&message, "call");
                let args: Vec<V> = get(&message, "args").as_array().unwrap_or(&[]).iter().map(decode).collect();
                let result = match text(&message, "t").as_str() {
                    "construct" => core.construct(c, args),
                    "call" => core.call(c, &text(&message, "member"), args),
                    _ => core.invoke(c, number(&message, "fn") as i64, args),
                };
                let call = if call.is_finite() { call as i64 } else { 0 };
                // The construction returns the scheduler, which the host names `scheduler#c`.
                let result = if text(&message, "t") == "construct" {
                    result.map(|_| V::Undef)
                } else {
                    result
                };
                let outcome = outcome(c, call, result);
                return_with_pending(&queues, outcome)
            }
            "answer" => {
                let c = number(&message, "c") as i64;
                host::settle_port(
                    c,
                    number(&message, "port") as i64,
                    text(&message, "outcome") == "reject",
                    decode(get(&message, "value")),
                );
                return_with_pending(&queues, Value::Null)
            }
            "run" => {
                jobs::checkpoint();
                obj(vec![("r", Value::Null)])
            }
            "sync" => obj(vec![("r", wire::sync_list())]),
            _ => wire::fatal("an unknown request"),
        };
        wire::write(&answer);
    }
}

/// The answer to a delivery, with whether jobs are queued (the host then runs them in a microtask of its own).
fn return_with_pending(queues: &Jobs, result: Value) -> Value {
    obj(vec![("r", result), ("pending", Value::Bool(!queues.idle()))])
}

/// The answer to a delivered call: its value, what it threw, or its promise (observed here, as the
/// JavaScript candidate observes it, right after the call returns).
fn outcome(c: i64, call: i64, result: Result<V, V>) -> Value {
    if call == 0 && result.is_ok() {
        return obj(vec![("return", obj(vec![("$", Value::string("s"))]))]);
    }
    match result {
        Ok(V::Promise(promise)) => {
            let _ = promise.then(
                move |value| {
                    host::settled(c, call, false, &value);
                    Ok(Resolution::Value(V::Undef))
                },
                move |reason| {
                    host::settled(c, call, true, &reason);
                    Ok(Resolution::Value(V::Undef))
                },
            );
            obj(vec![("promise", Value::Bool(true))])
        }
        Ok(value) => obj(vec![("return", encode(&value))]),
        Err(reason) => obj(vec![("throw", encode(&reason))]),
    }
}
