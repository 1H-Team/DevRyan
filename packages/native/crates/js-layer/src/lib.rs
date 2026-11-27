//! The JavaScript layers the scheduler crates are written on, compiled from
//! the native ledger's own source files by path, never copied:
//!
//! - `jobs`: `packages/harness-runtime/native/ledger/ledger-native/src/js.rs`,
//!   JavaScript's jobs (promises with ordered reactions, one microtask queue,
//!   async functions that start at the call, awaits that always suspend).
//! - `js`: `packages/harness-runtime/native/ledger-core/src/js/`,
//!   JavaScript strings, numbers, values and `JSON.stringify` exactly.
//!
//! Both are the ledger's: their unit tests need the ledger's crates and run
//! there, so a test build of this crate leaves the modules out (`not(test)`),
//! and this crate adds nothing to them. `rustfmt::skip` keeps this
//! workspace's formatting off their files; `dead_code` is allowed because
//! the ledger's other modules use what the scheduler does not.
#![forbid(unsafe_code)]

#[cfg(not(test))]
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../../../harness-runtime/native/ledger/ledger-native/src/js.rs"]
pub mod jobs;

#[cfg(not(test))]
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../../../harness-runtime/native/ledger-core/src/js/mod.rs"]
pub mod js;
