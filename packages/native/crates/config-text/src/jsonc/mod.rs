//! The jsonc-parser 3.3.1 operations the server performs, byte for byte.
//!
//! | Entry point | JavaScript |
//! |---|---|
//! | `parse` | `parse(text, errors, { allowTrailingComma: true })` |
//! | `strip_comments` | `stripComments(text)` |
//! | `modify` | `modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } })`, string paths |
//! | `apply_edits` | `applyEdits(text, edits)` |
//! | `remove_key_paths` | `removeJsoncKeyPaths` of `lib/opencode/jsonc-config.js` (one `modify` and `applyEdits` per path) |
//! | `set_key_path` | `applyEdits(source, modify(source, path, value, …))` with the server's `eol` choice |
//!
//! Anything else in the package (other options, `parseTree` for callers,
//! `format` without a range, `getLocation`, number path segments, array
//! insertion) is deliberately absent.

mod edit;
mod format;
mod parser;
mod scanner;

pub use edit::{Edit, ModifyError, apply_edits};
pub use parser::{MAX_DEPTH, ParseError, TOO_DEEP};

use crate::value::{Graph, Val};
use crate::{Refused, js};

/// The value and errors `parse` gives.
pub struct Parsed {
    pub graph: Graph,
    /// `undefined` when the text holds no value.
    pub value: Val,
    pub errors: Vec<ParseError>,
}

/// `parse(text, errors, { allowTrailingComma: true })`. Texts nested deeper
/// than `MAX_DEPTH` are refused (Node would parse them up to its stack size).
pub fn parse(text: &[u16]) -> Result<Parsed, Refused> {
    let mut graph = Graph::new();
    let (value, errors) = parser::parse(text, &mut graph, true)?;
    Ok(Parsed { graph, value, errors })
}

/// `stripComments(text)`.
pub fn strip_comments(text: &[u16]) -> Vec<u16> {
    let mut scanner = scanner::Scanner::new(text);
    let mut out = Vec::with_capacity(text.len());
    let mut offset = 0;
    loop {
        let pos = scanner.position();
        let kind = scanner.scan();
        if matches!(kind, scanner::Kind::LineComment | scanner::Kind::BlockComment | scanner::Kind::Eof) {
            if offset != pos {
                out.extend_from_slice(js::substring(text, offset as i64, pos as i64));
            }
            offset = scanner.position();
        }
        if kind == scanner::Kind::Eof {
            return out;
        }
    }
}

/// `modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } })`;
/// `Val::Undefined` removes the property. A value `JSON.stringify` cannot
/// write (a cycle) or nested deeper than `MAX_DEPTH` is refused, as is a
/// text nested deeper than `MAX_DEPTH`.
pub fn modify(text: &[u16], path: &[Vec<u16>], graph: &Graph, value: &Val, eol: &[u16]) -> Result<Vec<Edit>, ModifyError> {
    let json = graph.json_stringify(value).map_err(ModifyError::Refused)?;
    edit::modify(text, path, json, eol)
}

/// The `eol` the server passes: `'\r\n'` when the source holds one, else `'\n'`.
pub fn server_eol(source: &[u16]) -> Vec<u16> {
    if js::contains(source, &[0x0d, 0x0a]) { vec![0x0d, 0x0a] } else { vec![0x0a] }
}

/// `removeJsoncKeyPaths(source, keyPaths)`: each removal applied to the text
/// the previous one left.
pub fn remove_key_paths(source: &[u16], key_paths: &[Vec<Vec<u16>>]) -> Result<Vec<u16>, ModifyError> {
    let eol = server_eol(source);
    let mut text = source.to_vec();
    for key_path in key_paths {
        let edits = edit::modify(&text, key_path, None, &eol)?;
        text = apply_edits(&text, &edits)?;
    }
    Ok(text)
}

/// `applyEdits(source, modify(source, path, value, …))` with the server's `eol`.
pub fn set_key_path(source: &[u16], path: &[Vec<u16>], graph: &Graph, value: &Val) -> Result<Vec<u16>, ModifyError> {
    let edits = modify(source, path, graph, value, &server_eol(source))?;
    apply_edits(source, &edits)
}
