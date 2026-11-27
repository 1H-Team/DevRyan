//! The ledger runtime behind the protocol: its methods and the options the
//! worker builds it with (`init.workerData`).
//!
//! No ledger method is ported yet. `UnportedRuntime` lists every method of
//! the product's runtime (`methods::METHODS`, generated from the product) and
//! fails each call with `mutation_method_unimplemented`, after checking its
//! options as `createSessionMutationRuntime` does when it is constructed (a
//! refusal there ends the worker before `ready`, with exit code 70).
#![forbid(unsafe_code)]

use std::rc::Rc;

use ledger_core::js::JsStr;

use crate::ctx::Ctx;
use crate::value::{W, code_error, is_safe_integer, own_entries, truthy};
use crate::{Ret, WPromise};

/// The cause of the work in progress: the `id` of the call that started it
/// (the worker's `activeCall` store), `undefined` for background work.
#[derive(Clone)]
pub struct Scope {
    pub cause: W,
}

/// What a runtime may call in the host: the observers the worker passes
/// it (`onChange`, `onMaterialize` as callbacks; `onDiagnostic`,
/// `onLockTiming` as observations), each present only when the host has it.
pub trait Observers {
    fn has(&self, observer: &str) -> bool;
    /// `onChange(payload)` or `onMaterialize(row)`: a host callback.
    fn callback(&self, observer: &str, payload: W, scope: &Scope) -> WPromise;
    /// `onDiagnostic(record)` or `onLockTiming(timing)`: never awaited. The
    /// error is the encoder's, as `postMessage` throws it.
    fn observe(&self, observer: &str, payload: W, scope: &Scope) -> Result<(), W>;
}

/// A ledger runtime: its method names and calls.
pub trait Runtime {
    /// Every method, in `ready` order.
    fn methods(&self) -> Vec<JsStr>;
    /// `runtime[method](...args)` inside `ctx`: what the method returns or
    /// throws (a product method is an async function, so a promise).
    fn call(&self, method: &JsStr, args: Vec<W>, ctx: Ctx, scope: Scope) -> Ret;
}

/// The failure of a method that is not ported.
pub fn unimplemented_error() -> W {
    code_error("mutation_method_unimplemented")
}

/// The product's runtime with no method ported.
pub struct UnportedRuntime;

impl Runtime for UnportedRuntime {
    fn methods(&self) -> Vec<JsStr> {
        crate::methods::METHODS
            .iter()
            .map(|name| JsStr::from(*name))
            .collect()
    }

    /// An async function that throws: a promise rejected at once.
    fn call(&self, _method: &JsStr, _args: Vec<W>, _ctx: Ctx, _scope: Scope) -> Ret {
        Ok(crate::js::Resolution::Promise(crate::js::Promise::reject(
            unimplemented_error(),
        )))
    }
}

/// Builds the runtime from `init.workerData`; `Err` ends the worker before
/// `ready`, as a throw from the JavaScript factory does.
pub type Factory = Box<dyn FnOnce(&W, Rc<dyn Observers>) -> Result<Rc<dyn Runtime>, String>>;

const INSTALL_BATCH: f64 = 128.0;
const INITIAL_INSTALL_BATCH: f64 = 1024.0;
const COMPLEXITY: [(&str, f64); 4] = [
    ("warnEntries", 250_000.0),
    ("warnBytes", 16.0 * 1024.0 * 1024.0),
    ("ceilingEntries", 1_000_000.0),
    ("ceilingBytes", 64.0 * 1024.0 * 1024.0),
];

/// The checks `createSessionMutationRuntime` makes of the options the worker
/// passes it, in its order.
pub fn check_runtime_options(worker_data: &W) -> Result<(), String> {
    match worker_data.get("directory") {
        W::String(directory) if directory.units().first() == Some(&u16::from(b'/')) => {}
        W::String(_) | W::Undefined | W::Null => {
            return Err("Absolute mutation storage directory is required".into());
        }
        _ => return Err("The \"path\" argument must be of type string".into()),
    }
    let batching = worker_data.get("batching");
    if truthy(&batching) {
        let read = |key: &str, default: f64| match batching.get(key) {
            W::Undefined => W::Number(default),
            other => other,
        };
        let sizes = [
            read("install", INSTALL_BATCH),
            read("initialInstall", INITIAL_INSTALL_BATCH),
        ];
        if !sizes
            .iter()
            .all(|value| is_safe_integer(value) && matches!(value, W::Number(n) if *n > 0.0))
        {
            return Err("Install batch sizes must be positive integers".into());
        }
    }
    let complexity = worker_data.get("complexity");
    if truthy(&complexity) {
        // `{ ...DOCUMENT_COMPLEXITY, ...complexity }`.
        let mut limits: Vec<(JsStr, W)> = COMPLEXITY
            .iter()
            .map(|(key, value)| (JsStr::from(*key), W::Number(*value)))
            .collect();
        for (key, value) in own_entries(&complexity) {
            match limits.iter_mut().find(|(existing, _)| *existing == key) {
                Some(slot) => slot.1 = value,
                None => limits.push((key, value)),
            }
        }
        let number = |key: &str| {
            limits
                .iter()
                .find(|(existing, _)| *existing == key)
                .map(|(_, value)| value.clone())
                .unwrap_or(W::Undefined)
        };
        let positive = limits
            .iter()
            .all(|(_, value)| is_safe_integer(value) && matches!(value, W::Number(n) if *n > 0.0));
        let ordered = |warn: &str, ceiling: &str| match (number(warn), number(ceiling)) {
            (W::Number(warn), W::Number(ceiling)) => warn <= ceiling,
            _ => false,
        };
        if !positive
            || !ordered("warnEntries", "ceilingEntries")
            || !ordered("warnBytes", "ceilingBytes")
        {
            return Err("Document complexity limits must be positive integers, each warning at most its ceiling".into());
        }
    }
    Ok(())
}

/// The product factory: the options checked, no method ported.
pub fn unported_factory() -> Factory {
    Box::new(|worker_data, _observers| {
        check_runtime_options(worker_data)?;
        Ok(Rc::new(UnportedRuntime))
    })
}
