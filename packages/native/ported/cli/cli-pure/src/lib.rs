//! See `port.rs` (arguments and pure commands) and `state.rs` (commands that read the data root).
//! The front door's glue reads the environment, calls `answer` and prints what it returns.
pub mod port;
mod state;
pub use port::{Answer, Context, answer};
