//! The client state engine of `packages/ui/src/sync`, ported to Rust family
//! by family (refactor program plan file 29, packages C1 to C12), behind the
//! client conformance harness (`scripts/client-conformance/`,
//! docs/TESTING.md). **Nothing in the product calls, bundles or ships it.**
//!
//! Sans-IO: no thread, no clock, no system call, no randomness. A family is
//! a step function: its arguments in (and the state it keeps, for the
//! stateful families still to come), its result out; the pure families here
//! make no other observable. The port reproduces today's TypeScript as V8
//! (the product's renderer) runs it, the behaviour earlier reviews flagged as
//! looking wrong included: it fixes nothing. Where V8 and JavaScriptCore (the
//! engine the recordings are made with) differ, V8 is the reference, and the
//! difference is a named rule (docs/TESTING.md, "Engine differences").
//!
//! - `js`: the JavaScript semantics the families depend on;
//! - `families`: the ported families and their registry (`FAMILIES`);
//! - `plant` and `plants`: the planted differences that prove the harness
//!   bites on this code (off unless a runner turns one on).
#![forbid(unsafe_code)]

pub mod ctx;
pub mod families;
pub mod js;
pub mod plant;
pub mod plants;
pub mod toys;
