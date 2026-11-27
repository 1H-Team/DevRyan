//! The workspace's one number implementation (`devryan_config_text::js`, which compiles the ledger core's
//! `number.rs` in by path) against the ledger core's tracked V8 vectors
//! (`packages/harness-runtime/native/ledger-core/tests/numbers.tsv`, written by its `generate-numbers.mjs` under
//! Node: the double's bits and `String(x)`): the layout with and without the integer shortcut, and the parse of
//! each written form back to the same double (`JSON.parse(String(x)) === x`).

use devryan_config_text::js::{decimal_to_f64, ledger_number_to_string, number_to_string, parse_decimal};

fn vectors() -> Vec<(u64, &'static str)> {
    include_str!("../../../../harness-runtime/native/ledger-core/tests/numbers.tsv")
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("end\t"))
        .map(|line| {
            let (bits, written) = line.split_once('\t').expect("two fields");
            (u64::from_str_radix(bits, 16).expect("hex bits"), written)
        })
        .collect()
}

#[test]
fn number_layout_and_parse_match_the_ledger_core_s_v8_vectors() {
    let rows = vectors();
    assert!(rows.len() >= 5000, "{} rows", rows.len());
    let mut failures = Vec::new();
    for (bits, written) in &rows {
        let x = f64::from_bits(*bits);
        for (how, actual) in [("layout", number_to_string(x)), ("ledger layout", ledger_number_to_string(x))] {
            if actual != *written {
                failures.push(format!("{bits:016x}: V8 {written}, {how} {actual}"));
            }
        }
        // The written form read back: JSON.parse's numeral (a JSON number has no `+` exponent sign requirement, and
        // Number::toString's forms are all JSON numerals but `NaN` and the infinities, which JSON never holds).
        if x.is_finite() {
            let back = decimal_to_f64(written.as_bytes()).map(f64::to_bits);
            let zero = x == 0.0;
            if back != Some(if zero { 0 } else { *bits }) {
                failures.push(format!("{bits:016x}: {written} parsed as {back:?}"));
            }
            if parse_decimal(written).map(f64::to_bits) != back {
                failures.push(format!("{bits:016x}: Number({written:?}) and the JSON numeral differ"));
            }
        }
    }
    assert!(failures.is_empty(), "{} differ: {:?}", failures.len(), &failures[..failures.len().min(5)]);
}

#[test]
fn the_integer_shortcut_is_the_ledger_layout() {
    // Every integer of magnitude up to 2^53 the shortcut writes: the boundaries, and a seeded spread of magnitudes.
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut cases: Vec<f64> = vec![
        0.0,
        -0.0,
        1.0,
        -1.0,
        9_007_199_254_740_992.0,
        -9_007_199_254_740_992.0,
        9_007_199_254_740_991.0,
        1e15,
        1e15 - 1.0,
        4_294_967_295.0,
    ];
    for _ in 0..200_000 {
        let magnitude = next() % 54;
        let value = (next() >> (64 - magnitude.max(1))) as f64;
        cases.push(if next() & 1 == 1 { -value } else { value });
    }
    for x in cases {
        assert_eq!(number_to_string(x), ledger_number_to_string(x), "{x:?}");
    }
    // Just past 2^53 the ledger's layout takes over (the shortest digits are no longer the integer's).
    assert_eq!(number_to_string(9_007_199_254_740_994.0), "9007199254740994");
    assert_eq!(number_to_string(123_456_789_012_345_680_000.0), "123456789012345680000");
}
