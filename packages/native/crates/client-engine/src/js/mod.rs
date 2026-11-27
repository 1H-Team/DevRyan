//! JavaScript semantics the ported families depend on (design file 29 §5):
//! values with identity and V8's property order, UTF-16 strings, numbers,
//! and the operations the TypeScript performs on them.

pub mod date;
pub mod number;
mod ops;
mod sort;
pub mod string;
mod value;

pub use ops::*;
pub use sort::{sort_by, sort_elements};
pub use value::{Elements, ITERATION_LIMIT, Kind, MAX_ARRAY_LENGTH, Obj, ObjectData, Props, Proto, Str, Value, array_index, s};
