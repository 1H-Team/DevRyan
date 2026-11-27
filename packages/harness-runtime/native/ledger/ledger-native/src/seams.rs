//! Test-only (`test-hooks`): the seams the differential tests observe the
//! product's code through (the twin of `seams_off.rs`, whose functions do
//! nothing and are what the product is built with).
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use ledger_core::js::JsStr;

use crate::value::W;

thread_local! {
    /// How many `filehandle.sync()` calls this thread made.
    static SYNC_CALLS: Cell<u64> = const { Cell::new(0) };
    /// How often each crash point was reached (and, with an arm file, since it appeared).
    static CRASH_COUNTS: RefCell<HashMap<String, (u64, u64)>> = RefCell::new(HashMap::new());
}

/// A `filehandle.sync()` call made (`node::fs`).
pub fn sync_called() {
    SYNC_CALLS.with(|calls| calls.set(calls.get() + 1));
}

/// How many `filehandle.sync()` calls this thread made.
pub fn sync_calls() -> u64 {
    SYNC_CALLS.with(Cell::get)
}

/// The object directory's handle opened (`durability`): the store's and the
/// object store's shims, whichever a test turned on.
pub fn durability_opened(directory: &str) {
    crate::store_program::durability_opened(directory);
    crate::object_program::handle_opened(directory);
}

/// The outcome of the object directory's `sync` or `close` (`durability`),
/// as the durability tests' shims give it.
pub fn durability_outcome(op: &str, directory: &str, outcome: Result<(), W>) -> Result<(), W> {
    let outcome = crate::store_program::durability_outcome(op, directory, outcome);
    crate::object_program::handle_outcome(op, directory, outcome)
}

/// A content object's temporary opened (`objects`).
pub fn content_opened(temporary: &str) {
    crate::object_program::handle_opened(temporary);
}

/// The outcome of a content object temporary's `sync` or `close` (`objects`).
pub fn content_outcome(op: &str, temporary: &str, outcome: Result<(), W>) -> Result<(), W> {
    crate::object_program::handle_outcome(op, temporary, outcome)
}

/// A content object temporary's link (`objects`): `ok` or the code it failed with.
pub fn content_linked(temporary: &str, outcome: &str) {
    crate::object_program::handle_linked(temporary, outcome);
}

/// An observed file's handle opened, read to its end or closed
/// (`objects`): the object store tests' change hook.
pub fn observation(event: &str, path: &str) {
    crate::object_program::observation(event, path);
}

/// A crash point of the dual-run harness (`LEDGER_DUAL_RUN_CRASH`, as its
/// JavaScript preload reads it: `{point, nth, marker, armFile}`): at the
/// `nth` time `point` is reached (counted from when `armFile` exists, if
/// given), unless `marker` already exists, the point and its count are
/// written to `marker` and the process is killed with SIGKILL.
pub fn crash_point(point: &str) {
    let Ok(text) = std::env::var("LEDGER_DUAL_RUN_CRASH") else {
        return;
    };
    let Ok(spec) = crate::git::json_parse(&JsStr::from(text.as_str())) else {
        return;
    };
    let field = |name: &str| match spec.get(name) {
        W::String(value) => Some(value.to_string_lossy()),
        _ => None,
    };
    let nth = match spec.get("nth") {
        W::Number(nth) => nth as u64,
        _ => 1,
    };
    let (Some(wanted), Some(marker)) = (field("point"), field("marker")) else {
        return;
    };
    // port: sync call (the arm file, as the preload's existsSync)
    let armed = field("armFile").map(|file| std::path::Path::new(&file).exists());
    let (n, since_armed) = CRASH_COUNTS.with(|counts| {
        let mut counts = counts.borrow_mut();
        let entry = counts.entry(point.to_owned()).or_insert((0, 0));
        entry.0 += 1;
        if armed == Some(true) {
            entry.1 += 1;
        }
        *entry
    });
    // port: sync call (the marker, as the preload's existsSync)
    if point != wanted || std::path::Path::new(&marker).exists() {
        return;
    }
    match armed {
        Some(false) => return,
        Some(true) if since_armed != nth => return,
        None if n != nth => return,
        _ => {}
    }
    let line = format!(
        "{{\"point\":\"{point}\",\"n\":{n},\"pid\":{},\"thread\":0}}\n",
        std::process::id()
    );
    // port: sync call (the marker, as the preload's writeFileSync)
    let _ = std::fs::write(&marker, line);
    // port: sync call (SIGKILL of this process, as the preload's process.kill)
    let _ = ledger_io::fs::sys::kill(std::process::id() as i32, 9);
}
