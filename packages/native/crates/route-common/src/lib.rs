//! What every Rust route-group candidate of the backend conformance harness
//! shares (packages/native/DOCUMENTATION.md, "devryan-route-common"). **Nothing
//! in the product starts, calls or ships it.**
//!
//! The request path as Node and the product's edge give it to a group: Node's
//! HTTP reading (`http`), the product's request decoding (`body`, `qs`,
//! `inflate`, `json`, `text`), Express's answer (`answer`), the order in which
//! the JavaScript's handlers reach their writes (`order`, `server`), JSON as
//! V8 parses and writes it (`value`), Node's file-system calls and texts as the
//! JavaScript makes them (`fsjs`, `uv`), and the planted changes of the shared
//! path (`plant`). A group crate implements [`server::Group`] and calls
//! [`server::main`].

pub mod alloc;
pub mod answer;
pub mod body;
pub mod fsjs;
pub mod http;
pub mod inflate;
pub mod json;
pub mod order;
pub mod plant;
pub mod props;
pub mod qs;
pub mod server;
pub mod text;
pub mod uv;
pub mod value;
