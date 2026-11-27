//! The product's seams (`seams.rs` without the `test-hooks` feature): each
//! does nothing, so the code that calls them is the product's as written.
#![forbid(unsafe_code)]

use crate::value::W;

#[inline(always)]
pub fn sync_called() {}

#[inline(always)]
pub fn durability_opened(_directory: &str) {}

#[inline(always)]
pub fn durability_outcome(_op: &str, _directory: &str, outcome: Result<(), W>) -> Result<(), W> {
    outcome
}

#[inline(always)]
pub fn content_opened(_temporary: &str) {}

#[inline(always)]
pub fn content_outcome(_op: &str, _temporary: &str, outcome: Result<(), W>) -> Result<(), W> {
    outcome
}

#[inline(always)]
pub fn crash_point(_point: &str) {}

#[inline(always)]
pub fn observation(_event: &str, _path: &str) {}

#[inline(always)]
pub fn content_linked(_temporary: &str, _outcome: &str) {}
