//! The Rust port of `opencode/native-verification-order.js` (1 of 2;
//! `awaitVerificationPublications` awaits the caller's lease and job callbacks and stays in JS).
//! The regular expression is matched by hand over UTF-16 units, `\s` being JS's whitespace and
//! `^`/`$` the ends of the whole string; its lookahead applies to the package-manager branch.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

fn space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

/// The length of `word` at `at`, if it is there.
fn word(text: &[u16], at: usize, word: &str) -> Option<usize> {
    let units: Vec<u16> = word.encode_utf16().collect();
    text.get(at..at + units.len()).filter(|s| *s == units.as_slice()).map(|_| at + units.len())
}

/// `\s+` at `at`: the end of the run, if it has at least one unit.
fn spaces(text: &[u16], at: usize) -> Option<usize> {
    let end = at + text[at.min(text.len())..].iter().take_while(|u| space(**u)).count();
    (end > at).then_some(end)
}

fn then_word(text: &[u16], at: Option<usize>, w: &str) -> Option<usize> {
    word(text, spaces(text, at?)?, w)
}

fn branch_at(text: &[u16], at: usize) -> bool {
    let simple = ["vitest", "jest", "playwright", "tsc", "pytest"].iter().any(|w| word(text, at, w).is_some());
    let paired = then_word(text, word(text, at, "cargo"), "test")
        .or_else(|| then_word(text, word(text, at, "go"), "test"))
        .is_some();
    let tasks = ["test", "build", "lint", "check", "type-check", "typecheck", "validate"];
    let ends = |end: usize| text.get(end).is_none_or(|u| space(*u) || matches!(u, 0x3a | 0x3b | 0x26 | 0x7c));
    let manager = ["bun", "npm", "pnpm", "yarn"]
        .iter()
        .filter_map(|m| spaces(text, word(text, at, m)?))
        .any(|after| {
            let starts = [Some(after), word(text, after, "run").and_then(|r| spaces(text, r))];
            starts.into_iter().flatten().any(|s| tasks.iter().any(|t| word(text, s, t).is_some_and(ends)))
        });
    simple || paired || manager
}

/// Port of `isVerificationCommand` (`native-verification-order.js:4`).
pub fn is_verification_command(command: Value) -> Result<Value, String> {
    let Some(text) = js::string_units(&command) else { return Ok(false.into()) };
    let found = (0..=text.len()).any(|at| (at == 0 || space(text[at - 1]) || matches!(text[at - 1], 0x3b | 0x26 | 0x7c | 0x2f)) && branch_at(&text, at));
    Ok(found.into())
}
