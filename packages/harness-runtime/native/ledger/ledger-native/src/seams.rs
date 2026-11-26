//! Test-only (`test-hooks`): the seams the differential tests observe the
//! product's code through (the twin of `seams_off.rs`, whose functions do
//! nothing and are what the product is built with).
#![forbid(unsafe_code)]

use std::cell::Cell;

use crate::value::W;

thread_local! {
    /// How many `filehandle.sync()` calls this thread made.
    static SYNC_CALLS: Cell<u64> = const { Cell::new(0) };
}

/// A `filehandle.sync()` call made (`node::fs`).
pub fn sync_called() {
    SYNC_CALLS.with(|calls| calls.set(calls.get() + 1));
}

/// How many `filehandle.sync()` calls this thread made.
pub fn sync_calls() -> u64 {
    SYNC_CALLS.with(Cell::get)
}

/// The object directory's handle opened (`durability`).
pub fn durability_opened(directory: &str) {
    crate::store_program::durability_opened(directory);
}

/// The outcome of the object directory's `sync` or `close` (`durability`),
/// as the durability tests' shim gives it.
pub fn durability_outcome(op: &str, directory: &str, outcome: Result<(), W>) -> Result<(), W> {
    crate::store_program::durability_outcome(op, directory, outcome)
}
