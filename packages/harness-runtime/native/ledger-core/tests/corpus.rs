//! Real records round-trip byte for byte as Node does them: for each record
//! of `json-corpus.tsv` (written by `json-corpus.mjs`), `parse_utf8` then
//! `stringify_utf8` equals Node's `JSON.stringify(JSON.parse(buffer.toString('utf8')))`,
//! and what Node refuses the Rust refuses.
//!
//! This target is not part of a plain `cargo test` (`test = false` in
//! Cargo.toml) because it needs a corpus; `tests/run-extended.mjs` runs it
//! with `cargo test --test corpus` and `LEDGER_CORE_CORPUS=<file>`. Without
//! a corpus, or with an empty one, it fails.
mod support;

use ledger_core::js::{parse_utf8, stringify_utf8};
use support::{Failures, base64, rows};

#[test]
fn record_corpus_round_trips_match_node() {
    let corpus = std::env::var_os("LEDGER_CORE_CORPUS")
        .expect("LEDGER_CORE_CORPUS must name a json-corpus.tsv (tests/json-corpus.mjs writes one; tests/run-extended.mjs runs this)");
    let text = std::fs::read_to_string(&corpus)
        .unwrap_or_else(|error| panic!("{}: {error}", corpus.display()));
    let mut failures = Failures::new();
    for fields in rows(&text) {
        let bytes = base64(fields[1]);
        let actual = parse_utf8(&bytes).map(|value| stringify_utf8(&value));
        let expected = (fields[2] != "!").then(|| base64(fields[2]));
        failures.check(
            match (&actual, &expected) {
                (Ok(Ok(Some(actual))), Some(expected)) => actual == expected,
                (Err(_), None) => true,
                _ => false,
            },
            || {
                format!(
                    "{}: Node {:?}, Rust {:?}",
                    fields[0],
                    expected.as_deref().map(String::from_utf8_lossy),
                    actual
                )
            },
        );
    }
    failures.assert_clean(&format!("corpus records in {}", corpus.display()), 1);
}
