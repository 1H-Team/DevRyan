//! The yaml 2.9.0 operations the server performs, byte for byte.
//!
//! | Entry point | JavaScript |
//! |---|---|
//! | `parse` | `yaml.parse(source)` (no reviver, no options): the value, the warnings it emits, or what it throws |
//! | `stringify` | `yaml.stringify(value)` (no replacer, no options) |
//!
//! `parse` refuses (`Parsed::Refused`) rather than guess where the
//! package builds something the value graph does not hold, or where Node's
//! own limits decide: a `%YAML 1.1` document (the yaml-1.1 schema), an
//! explicit `!!binary`, `!!timestamp`, `!!merge`, `!!set`, `!!omap` or
//! `!!pairs` tag (a Uint8Array, Date, merge, Set or Map), a scalar tag named
//! like an `Object.prototype` member, a collection used as a mapping key
//! (stringified with a warning), and collections nested deeper than
//! `MAX_DEPTH`. Everything else in the package (other options, documents as
//! objects, the CST and visitor APIs, `parseAllDocuments`) is deliberately absent.

mod compose;
mod cst;
mod directives;
mod lexer;
mod parser;
mod scalars;
mod stringify;
mod tojs;

pub use compose::MAX_DEPTH;
pub use stringify::stringify;

/// The refusal for collections nested deeper than `MAX_DEPTH` (parse and stringify).
pub const TOO_DEEP: Refused = Refused("YAML collections nested deeper than yaml::MAX_DEPTH");

use crate::value::{Graph, Val};
use crate::{Refused, js};
use scalars::Problem;

/// A warning `yaml.parse` emits, or the error it throws: the code and the
/// message, prettified with the line and its context as the package does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub message: Vec<u16>,
}

/// What `yaml.parse(source)` does.
pub enum Parsed {
    /// It returns `value`, after emitting `warnings` (in order).
    Value { graph: Graph, value: Val, warnings: Vec<Diagnostic> },
    /// It throws, after emitting `warnings`. `name` is `YAMLParseError` (with
    /// its `code`) or `ReferenceError` (alias resolution, without one).
    Thrown {
        name: &'static str,
        code: Option<&'static str>,
        message: Vec<u16>,
        warnings: Vec<Diagnostic>,
    },
    /// A case the crate hands back to JavaScript; never an error of the package.
    Refused(Refused),
}

/// `LineCounter.linePos(offset)`.
fn line_pos(line_starts: &[usize], offset: usize) -> (usize, usize) {
    let (mut low, mut high) = (0, line_starts.len());
    while low < high {
        let mid = (low + high) >> 1;
        if line_starts[mid] < offset {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    if line_starts.get(low) == Some(&offset) {
        return (low + 1, 1);
    }
    if low == 0 {
        return (0, offset);
    }
    let start = line_starts[low - 1];
    (low, offset - start + 1)
}

/// `prettifyError(src, lc)(error)`.
fn prettify(source: &[u16], line_starts: &[usize], problem: &Problem) -> Vec<u16> {
    let mut message = problem.message.clone();
    let (line, col) = line_pos(line_starts, problem.start);
    let end = line_pos(line_starts, problem.end);
    message.extend(js::units(&format!(" at line {line}, column {col}")));
    let mut ci = col as i64 - 1;
    let start_of = |index: usize| -> i64 { line_starts.get(index).map_or(i64::MAX, |at| *at as i64) };
    let line_start = if line >= 1 { start_of(line - 1) } else { i64::MAX };
    let mut line_str: Vec<u16> = js::substring(source, line_start, start_of(line)).to_vec();
    while matches!(line_str.last(), Some(0x0a | 0x0d)) {
        line_str.pop();
    }
    let ellipsis = 0x2026u16;
    if ci >= 60 && line_str.len() > 80 {
        let trim_start = (ci - 39).min(line_str.len() as i64 - 79);
        let mut trimmed = vec![ellipsis];
        trimmed.extend_from_slice(js::substring(&line_str, trim_start, i64::MAX));
        line_str = trimmed;
        ci -= trim_start - 1;
    }
    if line_str.len() > 80 {
        line_str.truncate(79);
        line_str.push(ellipsis);
    }
    let leading = js::substring(&line_str, 0, ci);
    if line > 1 && leading.iter().all(|unit| *unit == 0x20) {
        let mut prev = js::substring(source, start_of(line - 2), start_of(line - 1)).to_vec();
        if prev.len() > 80 {
            prev.truncate(79);
            prev.push(ellipsis);
            prev.push(0x0a);
        }
        prev.extend(line_str);
        line_str = prev;
    }
    if line_str.iter().any(|unit| *unit != 0x20) {
        let mut count: i64 = 1;
        if end.0 == line && end.1 > col {
            count = ((end.1 - col) as i64).min(80 - ci).max(1);
        }
        message.extend(js::units(":\n\n"));
        message.extend(line_str);
        message.push(0x0a);
        message.extend(std::iter::repeat_n(0x20, ci.max(0) as usize));
        message.extend(std::iter::repeat_n(0x5e, count as usize));
        message.push(0x0a);
    }
    message
}

/// `yaml.parse(source)`.
pub fn parse(source: &[u16]) -> Parsed {
    let parser = parser::Parser::parse(source);
    if cst::max_depth(&parser.out) > MAX_DEPTH {
        return Parsed::Refused(TOO_DEEP);
    }
    let mut docs = compose::compose(&parser.out, source.len());
    let depth_exceeded = docs
        .iter()
        .skip(1)
        .any(|doc| doc.decline.is_some_and(|why| why.starts_with("collections nested")));
    let second = docs.get(1).map(|doc| doc.range);
    let doc = &mut docs[0];
    if let Some(why) = doc.decline {
        return Parsed::Refused(Refused(why));
    }
    if depth_exceeded {
        return Parsed::Refused(TOO_DEEP);
    }
    if let Some(range) = second {
        doc.errors.push(Problem {
            start: range[0],
            end: range[1],
            code: "MULTIPLE_DOCS",
            message: js::units("Source contains multiple documents; please use YAML.parseAllDocuments()"),
        });
    }
    let warnings: Vec<Diagnostic> = doc
        .warnings
        .iter()
        .map(|problem| Diagnostic {
            code: problem.code,
            message: prettify(source, &parser.line_starts, problem),
        })
        .collect();
    if let Some(first) = doc.errors.first() {
        return Parsed::Thrown {
            name: "YAMLParseError",
            code: Some(first.code),
            message: prettify(source, &parser.line_starts, first),
            warnings,
        };
    }
    match tojs::to_js(doc) {
        Ok((graph, value)) => Parsed::Value { graph, value, warnings },
        Err(tojs::Stop::Thrown(message)) => Parsed::Thrown {
            name: "ReferenceError",
            code: None,
            message: js::units(&message),
            warnings,
        },
        Err(tojs::Stop::Declined(why)) => Parsed::Refused(Refused(why)),
    }
}
