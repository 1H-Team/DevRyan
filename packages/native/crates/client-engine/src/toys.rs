//! Harness-owned toy families ported to Rust, so the runner's handling of
//! what the product families still to come need (port calls answered from
//! the recording, continuations after the return, draws, the step's time,
//! module state that only file order shows) is proven on recorded cases
//! before a product family relies on it. **Not product code**: the toys are
//! the conformance harness's own modules (`scripts/client-conformance/toy/`).
//!
//! - `toy-relay` (`toy/replay/toy-relay.mjs`, the replayer's toy family).

use std::cell::Cell;
use std::rc::Rc;

use crate::ctx::Ctx;
use crate::families::{Family, Instance, Make};
use crate::js::string::trim;
use crate::js::{Js, Obj, Value, error, get, own_keys, s, set, spread, to_property_key, to_string, type_of};
use crate::plant;

/// The toy families the engine implements.
pub const TOYS: &[Family] = &[Family {
    name: "toy-relay",
    exports: &["relay", "settle", "tally", "note", "pair", "share", "label", "ids", "stamp"],
    make: Make::Stateful(relay_instance),
    ports: &["log"],
    module_state: &[],
}];

fn relay_instance() -> Box<dyn Instance> {
    Box::new(Relay { calls: Rc::new(Cell::new(0)) })
}

/// `toy-relay.mjs`, one module instance: `calls` is its hidden module state.
struct Relay {
    calls: Rc<Cell<u32>>,
}

fn arg(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Undefined)
}

/// `log(kind, detail)`, the toy logger port.
fn log(ctx: &mut Ctx<'_>, kind: &str, detail: Value) -> Js {
    ctx.port("log", &[Value::str(kind), detail])
}

impl Instance for Relay {
    fn call(&mut self, ctx: &mut Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
        let first = arg(args, 0);
        let second = arg(args, 1);
        Some(match export {
            // `Promise.resolve().then(() => log('relay', String(items.length)))`: one job after the return.
            "relay" => {
                ctx.queue(Box::new(move |ctx| {
                    let length = get(&first, "length", "items.length")?;
                    log(ctx, "relay", Value::String(to_string(&length)?))?;
                    Ok(())
                }));
                Ok(Value::str("queued"))
            }
            // Four jobs, each queued by the one before, the fourth logging.
            "settle" => {
                let hops = if plant::on("toy-relay-settle-one-hop-early") { 3 } else { 4 };
                ctx.queue(chain(hops, first));
                Ok(Value::str("later"))
            }
            "tally" => {
                self.calls.set(self.calls.get() + 1);
                let name = match to_string(&first) {
                    Ok(name) => name,
                    Err(thrown) => return Some(Err(thrown)),
                };
                let count = if plant::on("toy-relay-tally-stateless") { 1 } else { self.calls.get() };
                Ok(Value::String(crate::js::string::concat(&[&name, &s(":"), &s(&count.to_string())])))
            }
            "note" => (|| {
                log(ctx, "note", first.clone())?;
                get(&first, "length", "text.length")
            })(),
            "pair" => (|| {
                let a = log(ctx, "first", first.clone())?;
                let b = log(ctx, "second", second.clone())?;
                Ok(Value::Object(Obj::array(if plant::on("toy-relay-pair-swapped") {
                    vec![b, a]
                } else {
                    vec![a, b]
                })))
            })(),
            "share" => (|| {
                let tag = Obj::object_from(vec![(s("kind"), get(&first, "kind", "event.kind")?)]);
                Ok(Value::Object(Obj::object_from(vec![
                    (s("left"), Value::Object(tag.clone())),
                    (s("right"), Value::Object(tag)),
                    (s("event"), first.clone()),
                ])))
            })(),
            "label" => (|| {
                let Value::String(text) = &first else {
                    // The module's own TypeError: its message is the module's, compared exactly.
                    return Err(error("TypeError", &format!("label needs text, got {}", type_of(&first))));
                };
                Ok(Value::Object(Obj::object_from(vec![
                    (s("text"), Value::String(trim(text).into())),
                    (s("units"), Value::Number(text.len() as f64)),
                ])))
            })(),
            "ids" => (|| {
                let first = ctx.draw("crypto.randomUUID")?;
                let second = ctx.draw("crypto.randomUUID")?;
                Ok(Value::Object(Obj::array(vec![first, second])))
            })(),
            "stamp" => stamp(ctx, &first, &second),
            _ => return None,
        })
    }
}

/// A job that queues `hops - 1` more before its last one logs `settled`.
fn chain(hops: u32, items: Value) -> crate::ctx::Job {
    Box::new(move |ctx| {
        if hops > 1 {
            ctx.queue(chain(hops - 1, items));
            return Ok(());
        }
        let length = get(&items, "length", "items.length")?;
        log(ctx, "settled", Value::String(to_string(&length)?))?;
        Ok(())
    })
}

/// `draft.items = { ...draft.items, [key]: { at: Date.now(), id: crypto.randomUUID() } }; draft.count += 1;
/// return Object.keys(draft.items).length`.
fn stamp(ctx: &mut Ctx<'_>, draft: &Value, key: &Value) -> Js {
    let items = get(draft, "items", "draft.items")?;
    let next = spread(&items);
    let key = to_property_key(key)?;
    let at = Value::Number(ctx.now());
    let id = ctx.draw("crypto.randomUUID")?;
    set(&next, key, Value::Object(Obj::object_from(vec![(s("at"), at), (s("id"), id)])));
    let Value::Object(target) = draft else {
        return Err(error("TypeError", "client-engine: a member written on a primitive"));
    };
    set(target, s("items"), Value::Object(next.clone()));
    let count = get(draft, "count", "draft.count")?;
    set(target, s("count"), crate::js::add(&count, &Value::Number(1.0))?);
    Ok(Value::Number(own_keys(&next).len() as f64))
}
