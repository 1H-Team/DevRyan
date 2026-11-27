//! See `port.rs`. No I/O here: the front door's glue reads the environment and prints the answer.
pub mod port;
pub use port::{Answer, Context, answer};
