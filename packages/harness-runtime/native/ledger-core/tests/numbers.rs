//! `ledger_core::js::number_to_string` against Node's `String(x)`
//! (`numbers.tsv`, written by `generate-numbers.mjs`).
mod support;

use ledger_core::js::number_to_string;
use support::{Failures, rows, vector_files};

#[test]
fn number_to_string_matches_node() {
    for (path, text) in vector_files("numbers.tsv") {
        let mut failures = Failures::new();
        for fields in rows(&text) {
            let x = f64::from_bits(u64::from_str_radix(fields[0], 16).expect("bits"));
            let actual = number_to_string(x);
            failures.check(actual == fields[1], || {
                format!("{} ({x:e}): Node {}, Rust {actual}", fields[0], fields[1])
            });
        }
        failures.assert_clean(&format!("numbers in {path}"), 5000);
    }
}
