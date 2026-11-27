//! The ledger core's tracked V8 vectors run through this crate's JSON values (`value`): `numbers.tsv` (a double
//! and `String(x)`) as `JSON.stringify(JSON.parse("[<String(x)>]"))` on both paths (the tree and the one pass), and
//! `json.tsv` (`JSON.stringify(JSON.parse(input))` as Node writes it, or `!` where JSON.parse throws) through
//! `value::parse` and `value::stringify` with no gap, and through `value::transcode` where it takes the text. Rows
//! the ledger bounds by its own depth (`deep`, `bound`) are passed over and counted.

use devryan_route_common::value;

fn rows(text: &'static str) -> impl Iterator<Item = Vec<&'static str>> {
    text.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("end\t"))
        .map(|line| line.split('\t').collect())
}

fn base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0);
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        buffer = (buffer << 6) | ALPHABET.iter().position(|item| *item == byte).expect("base64") as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

fn tree(input: &[u8], wtf8: bool) -> Option<Vec<u8>> {
    let parsed = value::parse(input, wtf8).ok()?;
    Some(value::stringify(parsed.value.as_ref()?, 0, usize::MAX))
}

#[test]
fn numbers_match_the_ledger_core_s_v8_vectors_on_both_paths() {
    let mut failures = Vec::new();
    let mut count = 0;
    for fields in rows(include_str!("../../../../harness-runtime/native/ledger-core/tests/numbers.tsv")) {
        let written = fields[1];
        if !f64::from_bits(u64::from_str_radix(fields[0], 16).expect("hex")).is_finite() {
            continue;
        }
        let text = format!("[{written},{{\"n\":{written}}}]");
        let wanted = text.as_bytes();
        let fast = value::transcode(wanted, 0, usize::MAX, usize::MAX).ok().flatten().map(|done| done.out);
        for (how, actual) in [("tree", tree(wanted, false)), ("one pass", fast)] {
            if actual.as_deref() != Some(wanted) {
                failures.push(format!(
                    "{}: V8 {written}, {how} {:?}",
                    fields[0],
                    actual.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                ));
            }
        }
        count += 1;
    }
    assert!(count >= 4900, "{count} rows");
    assert!(failures.is_empty(), "{} differ: {:?}", failures.len(), &failures[..failures.len().min(5)]);
}

#[test]
fn json_matches_the_ledger_core_s_v8_vectors() {
    // Some vectors nest to the ledger's bound; the walks here are iterative, the test thread's stack is enough.
    let (mut compared, mut one_pass, mut passed_over) = (0, 0, 0);
    let mut failures = Vec::new();
    for fields in rows(include_str!("../../../../harness-runtime/native/ledger-core/tests/json.tsv")) {
        if fields.len() != 3 || fields[0] == "bound" || fields[2] == "deep" {
            passed_over += 1;
            continue;
        }
        let input = base64(fields[1]);
        // Text with a raw lone surrogate is no UTF-8: read as WTF-8 (the string JSON.parse was given).
        let utf8 = std::str::from_utf8(&input).is_ok();
        let actual = tree(&input, !utf8);
        let wanted = (fields[2] != "!").then(|| base64(fields[2]));
        if actual != wanted {
            failures.push(format!(
                "{}: V8 {:?}, tree {:?}",
                fields[0],
                wanted.as_ref().map(|bytes| String::from_utf8_lossy(bytes).into_owned()),
                actual.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            ));
        }
        if utf8 {
            match value::transcode(&input, 0, usize::MAX, usize::MAX) {
                Ok(Some(done)) => {
                    one_pass += 1;
                    if Some(&done.out) != wanted.as_ref() {
                        failures.push(format!("{}: one pass {:?}", fields[0], String::from_utf8_lossy(&done.out)));
                    }
                }
                Ok(None) => {}
                Err(_) if wanted.is_none() => {}
                Err(_) => failures.push(format!("{}: one pass threw", fields[0])),
            }
        }
        compared += 1;
    }
    assert!(
        compared >= 3000 && one_pass >= 500,
        "{compared} compared ({one_pass} on the one pass), {passed_over} passed over"
    );
    assert!(
        failures.is_empty(),
        "{} of {compared} differ: {:?}",
        failures.len(),
        &failures[..failures.len().min(3)]
    );
}
