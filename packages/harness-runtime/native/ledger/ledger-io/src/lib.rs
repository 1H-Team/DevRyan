//! The native ledger's file system, lock and atomic writes (research file 28,
//! sections 3 and 4; plan package L2). Nothing in the product calls it yet.
//!
//! - `fs`: the primitives exactly as libuv makes them for Node (stamps, the
//!   sync chain, copyfile, links, opens, recursive mkdir, utimes, realpath,
//!   statfs). All of the crate's `unsafe` code is there.
//! - `atomic`: `writeFileAtomic`, `withCrossProcessFileLock` and
//!   `cleanupStaleAtomicFiles` of `lib/atomic-file.js`, with an injectable
//!   file system and environment.
//! - `path`: the `path.posix` functions those use.
//! - `git::odb`: the ledger repository's object database, refs and tree
//!   listings read in-process, and loose objects written as the JavaScript
//!   writes them (plan package L3a); anything it does not fully understand is
//!   answered "ask Git".
pub mod atomic;
pub mod fs;
pub mod git;
pub mod path;
