//! The `magic-prompts` route group of the web server
//! (packages/web/server/lib/magic-prompts/) as a standalone candidate for the
//! backend conformance harness (packages/native/DOCUMENTATION.md,
//! "devryan-route-magic-prompts"). **Nothing in the product starts, calls or
//! ships it**: the forwarding seam that could send it traffic does not exist.
//!
//! It reproduces today's JavaScript at the group's boundary, quirks included:
//! the group's routes (`group`), its runtime and data file (`runtime`) and its
//! planted changes (`plant`), on the request path every Rust group shares
//! (devryan-route-common, re-exported here under the module names it had:
//! `answer`, `body`, `http`, `inflate`, `json`, `order`, `props`, `qs`,
//! `text`, `uv`), served by the shared candidate protocol (`candidate`).

pub use devryan_route_common::{answer, http, inflate, json, order, props, qs, text, uv};

pub mod body;
pub mod candidate;
pub mod group;
pub mod plant;
pub mod runtime;
