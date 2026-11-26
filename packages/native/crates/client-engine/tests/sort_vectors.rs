//! The port of V8's `Array.prototype.sort` (`src/js/sort.rs`) against V8
//! itself: `sort-vectors.tsv` holds, per row, a seeded input, a comparator
//! kind (consistent, with ties, random, antisymmetric, NaN-answering), and
//! the order and comparator call count Electron's Node gave
//! (`generate-sort-vectors.mjs`). The comparators are the generator's, from
//! the same 32-bit hash, so an inconsistent comparator answers here as it did
//! there, and the port must give V8's order with the same number of calls.

use devryan_client_engine::js::{Value, sort_by};

/// The generator's `mix`: JavaScript's `Math.imul` and `>>>` on the low 32 bits.
fn mix(seed: u32, a: i64, b: i64) -> u32 {
    let mut h = (seed ^ 0x9e37_79b9).wrapping_mul(0x85eb_ca6b);
    h = (h ^ ((a + 0x632b_e5ab) as u32).wrapping_mul(0xc2b2_ae35)).wrapping_mul(0x27d4_eb2f);
    h = (h ^ ((b + 0x1656_67b1) as u32).wrapping_mul(0x9e37_79b1)).wrapping_mul(0x85eb_ca6b);
    h ^ (h >> 15)
}

fn compare(kind: &str, seed: u32, a: i64, b: i64) -> f64 {
    let (x, y) = (a as f64, b as f64);
    match kind {
        "consistent" => x - y,
        "ties" => f64::from((a as i32) >> 2) - f64::from((b as i32) >> 2),
        "random" => f64::from(mix(seed, a, b) % 3) - 1.0,
        "antisymmetric" => {
            if a == b {
                0.0
            } else if a < b {
                f64::from(mix(seed, a, b) % 3) - 1.0
            } else {
                -(f64::from(mix(seed, b, a) % 3) - 1.0)
            }
        }
        "nan" => {
            if mix(seed, a, b).is_multiple_of(5) {
                f64::NAN
            } else {
                x - y
            }
        }
        other => panic!("unknown comparator kind {other}"),
    }
}

fn numbers(field: &str) -> Vec<i64> {
    if field.is_empty() {
        Vec::new()
    } else {
        field.split(',').map(|item| item.parse().expect("an integer")).collect()
    }
}

#[test]
fn sort_matches_v8_call_for_call() {
    let text = include_str!("sort-vectors.tsv");
    let mut rows = 0;
    let mut failures = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty() && !line.starts_with('#')) {
        let fields: Vec<&str> = line.split('\t').collect();
        let (seed, kind) = (fields[0].parse::<u32>().expect("seed"), fields[1]);
        let mut items: Vec<Value> = numbers(fields[2]).into_iter().map(|n| Value::Number(n as f64)).collect();
        let mut calls = 0u64;
        sort_by(&mut items, &mut |left, right| {
            calls += 1;
            Ok(compare(kind, seed, left.as_number().unwrap() as i64, right.as_number().unwrap() as i64))
        })
        .unwrap();
        let got: Vec<String> = items.iter().map(|item| (item.as_number().unwrap() as i64).to_string()).collect();
        if got.join(",") != fields[3] || calls.to_string() != fields[4] {
            let order = if got.join(",") == fields[3] { "same order" } else { "another order" };
            failures.push(format!(
                "seed {seed} ({kind}, {} items, {order}): V8 {} in {} calls, Rust {} in {calls}",
                numbers(fields[2]).len(),
                fields[3],
                fields[4],
                got.join(",")
            ));
        }
        rows += 1;
    }
    assert!(rows >= 600, "{rows} rows");
    let mut kinds = std::collections::BTreeMap::new();
    for failure in &failures {
        *kinds
            .entry(
                failure
                    .split(':')
                    .next()
                    .unwrap_or_default()
                    .split_once('(')
                    .map_or("", |(_, rest)| rest)
                    .to_owned(),
            )
            .or_insert(0) += 1;
    }
    assert!(
        failures.is_empty(),
        "{} of {rows} rows differ from V8 ({kinds:?}); first: {}",
        failures.len(),
        failures
            .iter()
            .take(2)
            .map(|line| line.chars().take(300).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    );
}
