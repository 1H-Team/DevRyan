//! Byte-exact JSONC and YAML text operations, as the server performs them
//! with jsonc-parser 3.3.1 and yaml 2.9.0 (packages/native/DOCUMENTATION.md,
//! "devryan-config-text"). Nothing in the product calls it yet.
//!
//! - `jsonc`: `parse`, `stripComments`, `modify`, `applyEdits`, with the
//!   options the server passes, and the server's edit sequences.
//! - `yaml`: `parse` and `stringify`, without options.
//! - `front_matter`: the server's two front-matter regular expressions.
//! - `value`: JavaScript values (V8 property order, prototypes, shared
//!   objects) and their canonical description; `js`: JavaScript strings.
//! - `vector`: the test interchange format.
//!
//! Every public result keeps two outcomes apart by type: what the JavaScript
//! package does (a value, or the error it throws, reproduced), and `Refused`,
//! an input the crate hands back to JavaScript because it does not reproduce
//! the package there (too deep, a declined YAML feature, a cyclic value).
#![forbid(unsafe_code)]

/// The crate declines this input: the caller must run the JavaScript package
/// instead. It is never an error of the package; the text says why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refused(pub &'static str);

pub mod front_matter;
pub mod js;
pub mod jsonc;
pub mod value;
pub mod vector;
pub mod yaml;
