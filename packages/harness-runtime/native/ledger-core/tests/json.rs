//! `ledger_core::js::{parse, stringify}` against Node's
//! `JSON.stringify(JSON.parse(input))` (`json.tsv`, written by
//! `generate-json.mjs`). The record corpus is `tests/corpus.rs`.
mod support;

use ledger_core::js::{JsStr, MAX_DEPTH, ParseErrorKind, parse, stringify, stringify_utf8};
use support::{Failures, base64, rows, vector_files, wtf8_units};

#[test]
fn json_round_trips_match_node() {
    for (file, (path, text)) in vector_files("json.tsv").into_iter().enumerate() {
        let mut failures = Failures::new();
        let mut deep = 0;
        for fields in rows(&text) {
            assert_eq!(fields.len(), 3, "{path}: malformed line {}", fields[0]);
            if fields[0] == "bound" {
                assert_eq!(
                    fields[1],
                    MAX_DEPTH.to_string(),
                    "{path} was written for another depth bound (JSON_MAX_DEPTH in generate-json.mjs)"
                );
                continue;
            }
            if fields[0].starts_with("known-engine-discrepancy:") {
                // Listed in known-engine-discrepancies.mjs; the expected answer
                // is the specification's, and it is checked like any other.
                eprintln!(
                    "{}: known engine discrepancy, checked against the specification's answer",
                    fields[0]
                );
            }
            let input = wtf8_units(&base64(fields[1]));
            let parsed = parse(&input);
            match fields[2] {
                "!" => failures.check(
                    parsed
                        .as_ref()
                        .is_err_and(|error| error.kind == ParseErrorKind::Syntax),
                    || {
                        format!(
                            "{}: Node throws, Rust gave {:?} for {:?}",
                            fields[0],
                            parsed.as_ref().map(|_| ()),
                            JsStr::from_units(input.clone())
                        )
                    },
                ),
                "deep" => {
                    deep += 1;
                    failures.check(
                        parsed
                            .as_ref()
                            .is_err_and(|error| error.kind == ParseErrorKind::TooDeep),
                        || {
                            format!(
                                "{}: deeper than {MAX_DEPTH}, Rust gave {:?}",
                                fields[0],
                                parsed.as_ref().map(|_| ())
                            )
                        },
                    )
                }
                expected => {
                    let expected = base64(expected);
                    let actual = parsed.as_ref().map(stringify_utf8);
                    failures.check(
                        matches!(&actual, Ok(Ok(Some(bytes))) if *bytes == expected),
                        || {
                            format!(
                                "{}: input {:?}\n  Node: {}\n  Rust: {:?}",
                                fields[0],
                                JsStr::from_units(input.clone()),
                                String::from_utf8_lossy(&expected),
                                actual.as_ref().map(|bytes| bytes
                                    .as_ref()
                                    .map(|bytes| bytes.as_deref().map(String::from_utf8_lossy)))
                            )
                        },
                    )
                }
            }
        }
        if file == 0 {
            // Both sides of the bound are in the tracked file.
            assert!(deep >= 2, "{path}: only {deep} cases deeper than the bound");
        }
        failures.assert_clean(&format!("JSON round trips in {path}"), 1);
    }
}

#[test]
fn stringify_of_a_string_is_the_quoted_string() {
    let value = parse(&JsStr::from("\"a\\u2028\\ud800b\"").into_units()).unwrap();
    assert_eq!(
        stringify(&value),
        Ok(Some(JsStr::from("\"a\u{2028}\\ud800b\"")))
    );
}
