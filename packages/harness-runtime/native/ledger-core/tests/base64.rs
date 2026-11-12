//! `ledger_core::base64` against Node's `Buffer` (`base64.tsv`, written by
//! `generate-base64.mjs`).
mod support;

use ledger_core::base64::{decode, encode};
use support::{Failures, hex, rows, vector_files, wtf8_units};

#[test]
fn base64_matches_node() {
    for (path, text) in vector_files("base64.tsv") {
        let mut failures = Failures::new();
        for fields in rows(&text) {
            match fields[0] {
                "encode" => {
                    let actual = encode(&hex(fields[1]));
                    failures.check(actual == fields[2], || {
                        format!("encode {}: Node {}, Rust {actual}", fields[1], fields[2])
                    });
                }
                "decode" => {
                    let units = wtf8_units(&hex(fields[1]));
                    let actual = decode(&units);
                    failures.check(actual == hex(fields[2]), || {
                        format!(
                            "decode {:?}: Node {}, Rust {actual:02x?}",
                            String::from_utf16_lossy(&units),
                            fields[2]
                        )
                    });
                }
                other => panic!("{path}: unknown row {other}"),
            }
        }
        failures.assert_clean(&format!("base64 cases in {path}"), 3000);
    }
}
