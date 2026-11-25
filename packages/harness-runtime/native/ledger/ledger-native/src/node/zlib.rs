//! `promisify(zlib.deflate)` as `session-changes-trees.js` uses it (the
//! loose object writer's compression): one piece of pool work whose result
//! settles the promise in a unit of its own (`node::io`, rule 1). Nothing
//! else of `zlib` is reached by the worker.
//!
//! The bytes are `miniz_oxide`'s at Node's default level 6
//! (`ledger_io::git::odb::zlib_deflate`), not Node's zlib's: they inflate to
//! the same input, and Git objects are compared by content and id, never as
//! compressed files (`ledger_io::git::odb`'s writer says the same).
#![forbid(unsafe_code)]

use std::rc::Rc;

use super::io_with;
use crate::js::Promise;
use crate::value::W;

/// `await promisify(zlib.deflate)(buffer)`.
pub fn deflate(input: &Rc<Vec<u8>>) -> Promise<Rc<Vec<u8>>, W> {
    let raw = input.as_ref().clone();
    io_with(
        move || Ok(ledger_io::git::odb::zlib_deflate(&raw)),
        |bytes| Ok(Rc::new(bytes)),
    )
}
