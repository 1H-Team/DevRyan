//! The `magic-prompts` route group of the web server
//! (packages/web/server/lib/magic-prompts/) as a standalone candidate for the
//! backend conformance harness (packages/native/DOCUMENTATION.md,
//! "devryan-route-magic-prompts"). **Nothing in the product starts, calls or
//! ships it**: the forwarding seam that could send it traffic does not exist.
//!
//! It reproduces today's JavaScript at the group's boundary, quirks included:
//! what Express and the product's request decoding hand the group (`body`,
//! `qs`, `inflate`, `json`, `group`), the group's runtime and data file
//! (`runtime`), Express's answer (`answer`), Node's file-system error texts
//! (`uv`), and the harness's candidate protocol (`candidate`).

pub mod answer;
pub mod body;
pub mod candidate;
pub mod group;
pub mod http;
pub mod inflate;
pub mod json;
pub mod order;
pub mod plant;
pub mod props;
pub mod qs;
pub mod runtime;
pub mod text;
pub mod uv;
