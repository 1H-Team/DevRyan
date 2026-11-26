//! The ledger core's tracked V8 vectors run against this crate's number
//! layout (the C0i review's S1): `number::to_string` is the ledger core's
//! own `number.rs`, compiled in by path, so the two cannot disagree; this
//! test holds that the file compiled here is the one the ledger core's
//! vectors prove (`packages/harness-runtime/native/ledger-core/tests/numbers.tsv`,
//! written by its `generate-numbers.mjs` under Node), as `String(x)` writes
//! every double in it.

use devryan_client_engine::js::number::to_string;

#[test]
fn number_to_string_matches_the_ledger_core_s_v8_vectors() {
    let text = include_str!("../../../../harness-runtime/native/ledger-core/tests/numbers.tsv");
    let mut rows = 0;
    let mut failures = Vec::new();
    for line in text
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("end\t"))
    {
        let (bits, written) = line.split_once('\t').expect("two fields");
        let x = f64::from_bits(u64::from_str_radix(bits, 16).expect("hex bits"));
        let actual = to_string(x);
        if actual != written {
            failures.push(format!("{bits}: V8 {written}, Rust {actual}"));
        }
        rows += 1;
    }
    assert!(rows >= 5000, "{rows} rows");
    assert!(
        failures.is_empty(),
        "{} of {rows} differ: {:?}",
        failures.len(),
        &failures[..failures.len().min(5)]
    );
}
