//! `ledger_core::js::default_sort` against Node's `.sort()` with no
//! comparator (`sort.tsv`, written by `generate-sort.mjs`).
mod support;

use ledger_core::js::{Value, default_sort, parse};
use support::{Failures, base64, rows, vector_files, wtf8_units};

#[test]
fn default_sort_matches_node() {
    for (path, text) in vector_files("sort.tsv") {
        let mut failures = Failures::new();
        for fields in rows(&text) {
            let mut array = parse(&wtf8_units(&base64(fields[1]))).expect("vector JSON");
            let mut items = array.take_array().expect("an array");
            for special in fields[2].split(',').filter(|entry| !entry.is_empty()) {
                let (at, kind) = special.split_once(':').expect("index:kind");
                items[at.parse::<usize>().expect("index")] = match kind {
                    "u" => Value::Undefined,
                    "n" => Value::Number(f64::NAN),
                    "i" => Value::Number(f64::INFINITY),
                    "j" => Value::Number(f64::NEG_INFINITY),
                    other => panic!("unknown special {other}"),
                };
            }
            // Tag each value with its index: a one-element array [value, index]
            // would change ToString, so sort the values and track them apart.
            let tagged: Vec<(usize, Value)> = items.iter().cloned().enumerate().collect();
            let mut sorted = items;
            default_sort(&mut sorted);
            let mut used = vec![false; tagged.len()];
            let permutation: Vec<String> = sorted
                .iter()
                .map(|value| {
                    let found = tagged
                        .iter()
                        .position(|(index, candidate)| !used[*index] && same(candidate, value))
                        .expect("a sorted value comes from the input");
                    used[found] = true;
                    found.to_string()
                })
                .collect();
            let actual = permutation.join(",");
            failures.check(actual == fields[3], || {
                format!("{}: Node {}, Rust {actual}", fields[0], fields[3])
            });
        }
        failures.assert_clean(&format!("sorted arrays in {path}"), 500);
    }
}

/// `Object.is` for values, structural for containers: equal containers keep
/// their relative order in a stable sort, so either match gives the same index.
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => {
            a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
        }
        _ => left == right,
    }
}
