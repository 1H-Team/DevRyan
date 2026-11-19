//! The native ledger's process (research file 28, sections 1 to 3; plan
//! package L3d): the protocol, the execution context and the I/O pool of
//! the JavaScript ledger worker, with **no ledger method implemented**.
//! Every method of the product's runtime is listed in `ready` and fails
//! with `mutation_method_unimplemented`, so this build cannot serve the
//! product; nothing in the product starts it.
//!
//! - `proto`: the stdio protocol of `session-mutation-worker.js` (calls,
//!   aborts, callbacks, streams, reports, progress, observers), over
//!   `codec` (the line codec) and `wire` (the wire markers).
//! - `ctx`, `stall`, `iopool`: `execution-admission.js`,
//!   `host-stall-clock.js` and `execution-io-pool.js` as the worker uses them.
//! - `js`: JavaScript's jobs (promises, microtasks, ticks, async functions,
//!   `await`, the combinators), with no ledger type in it; `agen`: async
//!   generators, `for await` and `yield*` on it; `emitter`: Node's
//!   `EventEmitter`; `host`: the event
//!   loop around them (units of work, Node's timers and immediates, blocking
//!   work); `runtime`: the methods and the worker's options.
//! - With the `test-hooks` feature only: `stub` (the stub methods of the
//!   conformance suite), `program` (the job-order programs' interpreter)
//!   and `virtual_host` (a clock tests move by hand).
#![forbid(unsafe_code)]

use std::rc::Rc;

pub mod agen;
pub mod codec;
pub mod ctx;
pub mod emitter;
pub mod host;
pub mod iopool;
pub mod js;
pub mod methods;
pub mod process;
pub mod proto;
pub mod runtime;
pub mod signal;
pub mod stall;
pub mod value;
pub mod wire;

#[cfg(feature = "test-hooks")]
pub mod program;
#[cfg(feature = "test-hooks")]
pub mod stub;
#[cfg(feature = "test-hooks")]
pub mod virtual_host;

/// A JavaScript promise of a seam value.
pub type WPromise = js::Promise<value::W, value::W>;

/// What calling a JavaScript function gives: its return value (a plain
/// value or a promise) or what it throws.
pub type Ret = Result<js::Resolution<value::W, value::W>, value::W>;

/// A journal record sink (`report(record)`).
pub type Report = Rc<dyn Fn(value::W)>;

/// Whether this build has the test hooks (never a shipped build).
pub const TEST_HOOKS: bool = cfg!(feature = "test-hooks");

/// The wire protocol version of `init` and `ready`.
pub const PROTOCOL: f64 = 1.0;
