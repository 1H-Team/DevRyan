//! ICU root collation for ASCII strings, and nothing else.
//!
//! **What this covers.** The order `String.prototype.localeCompare` gives
//! under ICU's root collation, which English uses (CLDR's `en` has no
//! tailoring), for strings of ASCII code units. Any other input is
//! `NotCovered`, never a guess. The weights come from Node itself
//! (`collate_table.rs`, written by `tests/generate-collate.mjs` with the
//! pinned locale `en`).
//!
//! **What it does not cover.** The ledger calls `localeCompare` with no
//! locale, so JavaScript orders by the process's default locale. Under 13 of
//! the 56 locales of Electron's ICU (`tests/locale-survey.tsv`; Danish and
//! Norwegian put `aa` after `z`, Czech and Slovak `ch` after `h`, ...) that
//! is not this order. This module never models those locales. Instead the
//! host compares the two orders on `ledger_key_sample()` at start-up and does
//! not use the native ledger when they differ (DOCUMENTATION.md, "The locale
//! check").
//!
//! **The model.** For ASCII, root has no contractions and no expansions:
//! every character is either completely ignorable (most C0 controls, DEL)
//! or one collation element with a primary, a secondary and a tertiary
//! weight. Comparison is the standard multi-level one: the primary weights of
//! the non-ignorable characters in order, then (if all equal) the secondary
//! weights, then the tertiary ones, a shorter sequence first. Punctuation is
//! not ignorable (`alternate=non-ignorable`), and lowercase sorts before
//! uppercase.
#![forbid(unsafe_code)]

use std::cmp::Ordering;

#[path = "collate_table.rs"]
mod table;

#[path = "key_sample.rs"]
mod sample;

/// The ledger key sample, in code-unit order: keys of every shape the ledger
/// builds (seeded IDs) and every one- and two-character string over
/// `CODE_UNIT_ORDER_SAFE` (1,867 strings; `tests/ledger-key-sample.txt` is the
/// same list). A JavaScript host sorts these with its own `localeCompare`
/// and uses the native ledger only when its order equals this one.
pub fn ledger_key_sample() -> Vec<&'static str> {
    let mut keys = sample::KEY_SAMPLE.to_vec();
    // ASCII only, so byte order is code-unit order.
    keys.sort_unstable();
    keys
}

/// The input held a code unit outside ASCII, for which no table exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotCovered;

fn weights(units: &[u16]) -> Result<Vec<[u8; 3]>, NotCovered> {
    let mut out = Vec::with_capacity(units.len());
    for &unit in units {
        let weight = *table::WEIGHTS.get(usize::from(unit)).ok_or(NotCovered)?;
        if weight != [0, 0, 0] {
            out.push(weight);
        }
    }
    Ok(out)
}

/// The sign of `left.localeCompare(right)` under ICU's root collation, for
/// strings of ASCII code units.
pub fn locale_compare(left: &[u16], right: &[u16]) -> Result<Ordering, NotCovered> {
    let (left, right) = (weights(left)?, weights(right)?);
    for level in 0..3 {
        let ordering = left
            .iter()
            .map(|weight| weight[level])
            .cmp(right.iter().map(|weight| weight[level]));
        if ordering != Ordering::Equal {
            return Ok(ordering);
        }
    }
    Ok(Ordering::Equal)
}

/// `locale_compare` for Rust text.
pub fn locale_compare_str(left: &str, right: &str) -> Result<Ordering, NotCovered> {
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    locale_compare(&left, &right)
}

/// The characters on which root collation and code-unit order provably
/// agree (under root only; see the module documentation for other locales):
/// `-`, `.`, `/`, `0`-`9` and `a`-`z`. Each has its own primary
/// weight, none is ignorable, and their primary order is their code-unit
/// order (checked against the table by `tests/collate.rs`), so for strings
/// made only of them `localeCompare` and `<` give the same order. Adding
/// `A`-`Z` or `_` breaks that (`"a" < "B"` under ICU, `"_" < "0"`).
pub const CODE_UNIT_ORDER_SAFE: &[u8] = b"-./0123456789abcdefghijklmnopqrstuvwxyz";

/// True when root collation and code-unit order agree on every string made
/// of these units, so a sort by either gives the same result under root.
pub fn code_unit_order_is_collation_order(units: &[u16]) -> bool {
    units
        .iter()
        .all(|&unit| u8::try_from(unit).is_ok_and(|byte| CODE_UNIT_ORDER_SAFE.contains(&byte)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_order_samples() {
        use Ordering::*;
        for (left, right, expected) in [
            ("a", "B", Less),
            ("a", "A", Less),
            ("A", "b", Less),
            ("_", "0", Less),
            ("a-b", "ab", Less),
            ("ab", "a\u{1}b", Equal),
            ("", "\u{1}", Equal),
            ("1", "a", Less),
        ] {
            assert_eq!(
                locale_compare_str(left, right),
                Ok(expected),
                "{left:?} {right:?}"
            );
        }
        assert_eq!(locale_compare_str("é", "e"), Err(NotCovered));
    }
}
