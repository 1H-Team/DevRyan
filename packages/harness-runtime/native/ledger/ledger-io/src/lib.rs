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
pub mod atomic;
pub mod fs;
pub mod path;
