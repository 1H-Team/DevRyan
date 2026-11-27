//! The orchestration scheduler's pure policy modules (plan package OR1),
//! ported from `packages/orchestration-runtime` and held to vectors the
//! JavaScript writes (`tests/generate-vectors.mjs`). Nothing in the product
//! calls this crate yet.
//!
//! Every value is a `devryan_js_layer::js::Value`. A JavaScript `throw` is
//! `Failure::Throw` (its name, message and `code`); an input this port does
//! not reproduce is refused with `Failure::Unsupported`, never answered
//! differently. Each module names the JavaScript file it ports; the functions
//! keep the JavaScript's checks in the JavaScript's order.
#![forbid(unsafe_code)]

pub mod auto_resume;
pub mod checks;
pub mod codec;
pub mod contract;
pub mod envelope;
pub mod error;
pub mod jsv;
pub mod leaves;
pub mod persistence;
pub mod primitives;
pub mod proof_store;
mod regex;
pub mod retry;
pub mod text;
pub mod transitions;

pub use devryan_js_layer::js;
pub use error::{Failure, JsError, JsResult};
