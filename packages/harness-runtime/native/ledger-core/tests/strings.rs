//! `JsStr::{from_utf8_lossy, to_utf8}` against Node's `buffer.toString('utf8')`
//! and `Buffer.from(string)` (`strings.tsv`, written by `generate-strings.mjs`).
mod support;

use ledger_core::js::JsStr;
use support::{Failures, hex, hex_units, rows, vector_files};

#[test]
fn utf8_conversions_match_node() {
    for (path, text) in vector_files("strings.tsv") {
        let mut failures = Failures::new();
        for fields in rows(&text) {
            match fields[0] {
                "decode" => {
                    let actual = JsStr::from_utf8_lossy(&hex(fields[1]));
                    let expected = hex_units(fields[2]);
                    failures.check(actual.units() == expected.as_slice(), || {
                        format!(
                            "decode {}: Node {:?}, Rust {actual:?}",
                            fields[1],
                            JsStr::from_units(expected.clone())
                        )
                    });
                }
                "encode" => {
                    let actual = JsStr::from_units(hex_units(fields[1])).to_utf8();
                    failures.check(actual == hex(fields[2]), || {
                        format!(
                            "encode {}: Node {}, Rust {actual:02x?}",
                            fields[1], fields[2]
                        )
                    });
                }
                other => panic!("{path}: unknown row {other}"),
            }
        }
        failures.assert_clean(&format!("string conversions in {path}"), 1600);
    }
}
