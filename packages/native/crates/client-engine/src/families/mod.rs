//! The ported families, one module each, named as the port map names them
//! (`scripts/client-conformance/product/product-port-map.json`). Each is a
//! set of pure functions over JavaScript values: a call's arguments in, its
//! result or what it threw out, and the arguments changed in place where the
//! TypeScript changes them (a draft). None of them has a port, a clock, a
//! draw, a timer or module state, so a call makes no other observable.

pub mod live_aggregate;
pub mod materialization;
pub mod message_order;
pub mod native_cursor_text;
pub mod optimistic;
pub mod revert_transactions;
pub mod sanitize;
pub mod session_diff_stats;
pub mod session_working;
pub mod tool_output;
pub mod tool_status;

use crate::ctx::Ctx;
use crate::js::{Js, Value};

/// The `index`-th argument (`undefined` past the end, as in JavaScript).
pub(crate) fn arg(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Undefined)
}

/// One instance of a family (a unit: one fresh module, its module state with it), called step by step.
pub trait Instance {
    /// Calls an export with the step's context: `None` when the family has no such export.
    fn call(&mut self, ctx: &mut Ctx<'_>, export: &str, args: &[Value]) -> Option<Js>;
}

/// A call of a family that keeps no module state.
pub type Call = fn(&mut Ctx<'_>, &str, &[Value]) -> Option<Js>;

/// The instance of a family without module state.
pub struct Stateless(pub Call);

impl Instance for Stateless {
    fn call(&mut self, ctx: &mut Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
        (self.0)(ctx, export, args)
    }
}

/// How a family makes a fresh instance.
pub enum Make {
    Stateless(Call),
    Stateful(fn() -> Box<dyn Instance>),
}

/// A family the engine implements.
pub struct Family {
    /// The port map's name of the family.
    pub name: &'static str,
    /// The exports a step may call (the family module's function exports).
    pub exports: &'static [&'static str],
    /// How a unit gets a fresh instance.
    pub make: Make,
    /// The module port exports the port calls, by export name (the port map must list exactly these; a call carries
    /// the port map's name of that port).
    pub ports: &'static [&'static str],
    /// The module state bindings the port keeps (the port map's `moduleState.bindings`, exactly these).
    pub module_state: &'static [&'static str],
}

impl Family {
    /// A fresh instance (one unit).
    pub fn open(&self) -> Box<dyn Instance> {
        match self.make {
            Make::Stateless(call) => Box::new(Stateless(call)),
            Make::Stateful(make) => make(),
        }
    }

    /// Calls an export on a fresh instance with no host (what a vector test of a pure family does).
    pub fn call_pure(&self, export: &str, args: &[Value]) -> Option<Js> {
        let mut host = crate::ctx::NoHost;
        let mut jobs = crate::ctx::Jobs::default();
        let mut ctx = Ctx::new(None, &mut host, &mut jobs);
        self.open().call(&mut ctx, export, args)
    }
}

const fn pure(name: &'static str, exports: &'static [&'static str], call: Call) -> Family {
    Family {
        name,
        exports,
        make: Make::Stateless(call),
        ports: &[],
        module_state: &[],
    }
}

/// Every family the engine implements, in the design's order of purity.
pub const FAMILIES: &[Family] = &[
    pure("native-cursor-text", native_cursor_text::EXPORTS, native_cursor_text::call),
    pure("tool-status", tool_status::EXPORTS, tool_status::call),
    pure("sanitize", sanitize::EXPORTS, sanitize::call),
    pure("tool-output", tool_output::EXPORTS, tool_output::call),
    pure("message-order", message_order::EXPORTS, message_order::call),
    pure("session-diff-stats", session_diff_stats::EXPORTS, session_diff_stats::call),
    pure("session-working", session_working::EXPORTS, session_working::call),
    pure("live-aggregate", live_aggregate::EXPORTS, live_aggregate::call),
    pure("optimistic", optimistic::EXPORTS, optimistic::call),
    pure("revert-transactions", revert_transactions::EXPORTS, revert_transactions::call),
    pure("materialization", materialization::EXPORTS, materialization::call),
];

/// The family of that name, if the engine implements it.
pub fn family(name: &str) -> Option<&'static Family> {
    FAMILIES.iter().chain(crate::toys::TOYS).find(|family| family.name == name)
}
