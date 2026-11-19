//! JavaScript's strings, values and JSON, reproduced exactly.
//!
//! Every record the ledger stores is the output of `JSON.stringify`, and
//! several orders that reach disk come from JavaScript string comparison.
//! A general JSON library does not reproduce V8's property order, its number
//! layout or lone surrogates, so this module does, and its tests compare it
//! with Node itself (`tests/generate-json.mjs`, `tests/generate-sort.mjs`).
//! Nothing in the shipped WebAssembly module calls it yet.
#![forbid(unsafe_code)]

mod json;
mod number;
mod string;
mod value;

pub use json::{
    MAX_DEPTH, ParseError, ParseErrorKind, TooDeep, parse, parse_utf8, stringify, stringify_utf8,
    write_json_string,
};
pub use number::{number_to_string, write_number};
pub use string::JsStr;
pub use value::{JsObject, Key, Value, array_index, default_compare, default_sort};
