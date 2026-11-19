//! The WebAssembly export layer of the ledger core, and the crate's only
//! unsafe code: it turns (pointer, length) pairs handed over by
//! `packages/harness-runtime/lib/ledger-core.js` into slices and hands result
//! buffers back. The diff itself is `diff`, which forbids unsafe code.
//!
//! The ABI (version `ABI_VERSION`; the loader refuses any other):
//! - `ledger_core_abi_version() -> u32`
//! - `ledger_core_alloc(len) -> ptr` (0 when the memory cannot grow) and
//!   `ledger_core_free(ptr, len)`: buffers the loader fills with the two texts.
//! - `ledger_core_diff(before_ptr, before_len, after_ptr, after_len, budget: f64) -> ptr`
//!   to u32 words `[status, count, kind0, bytes0, kind1, bytes1, ...]`;
//!   free it with `ledger_core_free_result(ptr)`.
//!
//! Status 0 is success. `STATUS_BAD_BUDGET` means the budget is not an
//! integer of at most 2^53 - 1 in magnitude (the loader never sends one).
//! A failed allocation inside the diff aborts, which is a trap in
//! WebAssembly; the loader then drops the instance and uses JavaScript.
//!
//! `js`, `base64` and `collate` (JavaScript values and JSON, Node's base64,
//! ICU root collation for ASCII) are the native ledger's foundations, and
//! `tree`, `keys`, `text` and `paths` its codecs (Git trees and direct tree
//! commits, store keys and list pages, run rows and the text engine, change
//! paths); no export calls them yet, so they are not part of the module's code.
pub mod base64;
pub mod collate;
pub mod diff;
pub mod js;
pub mod keys;
pub mod paths;
pub mod text;
pub mod tree;

use std::alloc::{Layout, alloc, dealloc};

pub const ABI_VERSION: u32 = 1;
pub const STATUS_OK: u32 = 0;
pub const STATUS_BAD_BUDGET: u32 = 2;
/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn byte_layout(len: usize) -> Option<Layout> {
    // A zero-length request still gets a distinct, freeable allocation.
    Layout::array::<u8>(len.max(1)).ok()
}

#[unsafe(no_mangle)]
pub extern "C" fn ledger_core_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocates `len` bytes for the loader to fill. Returns null on failure.
#[unsafe(no_mangle)]
pub extern "C" fn ledger_core_alloc(len: usize) -> *mut u8 {
    match byte_layout(len) {
        // SAFETY: the layout has a non-zero size, which is all `alloc` requires.
        Some(layout) => unsafe { alloc(layout) },
        None => std::ptr::null_mut(),
    }
}

/// Frees a buffer from `ledger_core_alloc` with the same length.
///
/// # Safety
/// `ptr` must come from `ledger_core_alloc(len)` with this `len` and must not
/// be freed twice.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ledger_core_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    if let Some(layout) = byte_layout(len) {
        // SAFETY: by the caller's contract `ptr` was allocated with this layout
        // (`ledger_core_alloc` computes it from the same `len`) and is live.
        unsafe { dealloc(ptr, layout) }
    }
}

/// Diffs two byte strings. See the module documentation for the result layout.
///
/// # Safety
/// `(before_ptr, before_len)` and `(after_ptr, after_len)` must each be a live
/// buffer from `ledger_core_alloc` of at least that length, initialised by the
/// caller, and not written while the call runs.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ledger_core_diff(
    before_ptr: *const u8,
    before_len: usize,
    after_ptr: *const u8,
    after_len: usize,
    budget: f64,
) -> *mut u32 {
    // SAFETY: by the caller's contract each pointer is non-null (an allocation
    // from `ledger_core_alloc`, never 0), aligned (u8), points to `len`
    // initialised bytes inside one allocation, and nothing writes them during
    // the call, so both shared slices are valid for their lifetime here.
    let (before, after) = unsafe {
        (
            std::slice::from_raw_parts(before_ptr, before_len),
            std::slice::from_raw_parts(after_ptr, after_len),
        )
    };
    let words = match safe_budget(budget) {
        Some(budget) => {
            let pairs = diff::mutation_diff(before, after, budget);
            let mut words = Vec::with_capacity(pairs.len() + 2);
            words.push(STATUS_OK);
            words.push((pairs.len() / 2) as u32);
            words.extend_from_slice(&pairs);
            words
        }
        None => vec![STATUS_BAD_BUDGET, 0],
    };
    Box::into_raw(words.into_boxed_slice()) as *mut u32
}

/// Frees a result from `ledger_core_diff`.
///
/// # Safety
/// `ptr` must come from `ledger_core_diff`, must not be freed twice, and its
/// header must not have been changed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ledger_core_free_result(ptr: *mut u32) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: by the caller's contract `ptr` is a live boxed slice from
    // `ledger_core_diff`, whose length is `2 + 2 * count` with `count` its
    // second word; rebuilding the box with that length frees the same
    // allocation exactly once.
    unsafe {
        let len = 2 + 2 * (*ptr.add(1) as usize);
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

/// The budget as an integer when it is one JavaScript holds exactly.
fn safe_budget(budget: f64) -> Option<i64> {
    (budget.is_finite() && budget.fract() == 0.0 && budget.abs() <= MAX_SAFE_INTEGER)
        .then_some(budget as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the exported functions the way the loader does, natively.
    fn call(before: &[u8], after: &[u8], budget: f64) -> Vec<u32> {
        let a = ledger_core_alloc(before.len());
        let b = ledger_core_alloc(after.len());
        assert!(!a.is_null() && !b.is_null());
        // SAFETY: `a` and `b` are fresh allocations of at least these lengths;
        // the result is read within its `2 + 2 * count` words, then freed once.
        unsafe {
            std::ptr::copy_nonoverlapping(before.as_ptr(), a, before.len());
            std::ptr::copy_nonoverlapping(after.as_ptr(), b, after.len());
            let result = ledger_core_diff(a, before.len(), b, after.len(), budget);
            let count = *result.add(1) as usize;
            let words = std::slice::from_raw_parts(result, 2 + 2 * count).to_vec();
            ledger_core_free_result(result);
            ledger_core_free(a, before.len());
            ledger_core_free(b, after.len());
            words
        }
    }

    #[test]
    fn the_export_layer_returns_status_count_and_pairs() {
        assert_eq!(
            call(b"abc", b"abd", 100.0),
            vec![STATUS_OK, 3, 0, 2, 1, 1, 2, 1]
        );
        assert_eq!(call(b"", b"", 100.0), vec![STATUS_OK, 0]);
        assert_eq!(ledger_core_abi_version(), ABI_VERSION);
    }

    #[test]
    fn budgets_outside_the_safe_integers_are_refused() {
        for budget in [
            0.5,
            f64::NAN,
            f64::INFINITY,
            -f64::INFINITY,
            9_007_199_254_740_992.0,
        ] {
            assert_eq!(
                call(b"a", b"b", budget),
                vec![STATUS_BAD_BUDGET, 0],
                "{budget}"
            );
        }
        assert_eq!(call(b"a", b"b", -MAX_SAFE_INTEGER)[0], STATUS_OK);
        assert_eq!(call(b"a", b"b", MAX_SAFE_INTEGER)[0], STATUS_OK);
    }
}
