//! Git for the native ledger (research file 28, sections 3 and 5).
//!
//! - `odb`: the ledger repository read in-process (loose and packed objects,
//!   refs, `ls-tree -r -l -z` listings) and loose objects written as
//!   `lib/session-changes-trees.js` writes them. What keeps spawning Git
//!   (`update-ref`, `init`, `repack`, `prune`, `count-objects`, every command
//!   on the user's project) belongs to the runner, a later package.
#![forbid(unsafe_code)]

pub mod odb;
