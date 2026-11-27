//! `ledger_core::collate` against Node's `localeCompare` (`collate.tsv`,
//! written by `generate-collate.mjs`), and the proof that the ledger's keys
//! sort the same under `localeCompare` and under code units.
mod support;

use std::cmp::Ordering;

use ledger_core::collate::{
    CODE_UNIT_ORDER_SAFE, NotCovered, code_unit_order_is_collation_order, ledger_key_sample,
    locale_compare,
};
use support::{Failures, Random, rows, vector_files};

const SEED: u32 = 20261113;

fn sign(ordering: Ordering) -> char {
    match ordering {
        Ordering::Less => '<',
        Ordering::Equal => '=',
        Ordering::Greater => '>',
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `randomStrings` of generate-collate.mjs, draw for draw.
fn random_strings(count: usize) -> (Vec<Vec<u16>>, Vec<Vec<u16>>) {
    let mut random = Random::new(SEED);
    let (mut strings, mut mutants) = (Vec::new(), Vec::new());
    for _ in 0..count {
        let length = random.int(65);
        let mut text = Vec::new();
        for _ in 0..length {
            let unit = if random.next() < 0.9 {
                0x20 + random.int(95)
            } else {
                random.int(128)
            };
            text.push(unit as u16);
        }
        let at = random.int(text.len() as u32 + 1) as usize;
        let op = random.int(3);
        let mut mutant = text.clone();
        let is_letter = |unit: u16| (unit as u8).is_ascii_alphabetic() && unit < 0x80;
        if op == 0 {
            let unit = if random.next() < 0.5 {
                random.int(32)
            } else {
                0x20 + random.int(95)
            };
            mutant.insert(at, unit as u16);
        } else if op == 1 && at < text.len() && is_letter(text[at]) {
            mutant[at] = u16::from((text[at] as u8) ^ 0x20);
        } else if at < text.len() {
            mutant[at] = (0x20 + random.int(95)) as u16;
        } else {
            mutant.push((0x20 + random.int(95)) as u16);
        }
        strings.push(text);
        mutants.push(mutant);
    }
    (strings, mutants)
}

fn checksum(strings: &[Vec<u16>], mutants: &[Vec<u16>]) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for text in strings.iter().chain(mutants) {
        for &unit in text.iter().chain(std::iter::once(&0xffff)) {
            for byte in [unit & 0xff, unit >> 8] {
                hash ^= u32::from(byte);
                hash = hash.wrapping_mul(0x01000193);
            }
        }
    }
    format!("{hash:08x}")
}

#[test]
fn collation_matches_node() {
    for (path, text) in vector_files("collate.tsv") {
        let mut failures = Failures::new();
        let mut compare = |left: &[u16], right: &[u16], expected: char| {
            let actual = locale_compare(left, right).map(sign);
            failures.check(actual == Ok(expected), || {
                format!(
                    "{:?} vs {:?}: Node {expected}, Rust {actual:?}",
                    String::from_utf16_lossy(left),
                    String::from_utf16_lossy(right)
                )
            });
        };
        let mut sections = 0;
        for fields in rows(&text) {
            match fields[0] {
                "pairs" => {
                    sections += 1;
                    let signs: Vec<char> = fields[1].chars().collect();
                    assert_eq!(signs.len(), 95 * 95);
                    for a in 0..95u16 {
                        for b in 0..95u16 {
                            compare(&[0x20 + a], &[0x20 + b], signs[usize::from(a * 95 + b)]);
                        }
                    }
                }
                "random" => {
                    sections += 1;
                    let count: usize = fields[1].parse().expect("count");
                    let (strings, mutants) = random_strings(count);
                    assert_eq!(
                        checksum(&strings, &mutants),
                        fields[2],
                        "{path}: the regenerated strings are not the generator's"
                    );
                    let signs: Vec<char> = fields[3].chars().collect();
                    assert_eq!(signs.len(), 2 * count);
                    for index in 0..count {
                        compare(
                            &strings[index],
                            &strings[(index + 1) % count],
                            signs[2 * index],
                        );
                        compare(&strings[index], &mutants[index], signs[2 * index + 1]);
                    }
                }
                "key" | "counter" => {}
                other => panic!("{path}: unknown section {other}"),
            }
        }
        assert_eq!(sections, 2, "{path}");
        failures.assert_clean(&format!("localeCompare signs in {path}"), 9025 + 2 * 20000);
    }
}

#[test]
fn non_ascii_is_not_covered() {
    assert_eq!(
        locale_compare(&units("a"), &units("\u{e9}")),
        Err(NotCovered)
    );
    assert_eq!(locale_compare(&[0x80], &[]), Err(NotCovered));
    assert_eq!(locale_compare(&[0xd800], &units("a")), Err(NotCovered));
}

/// The proof the design asks for (research file 28 §4.2, last row), for
/// root collation (English) only: other default locales are the host's
/// locale check (`the_key_sample_is_tracked_and_in_code_unit_order`). Its
/// premise, checked exhaustively over Node's own weights: every character
/// of `CODE_UNIT_ORDER_SAFE` is non-ignorable and has its own primary
/// weight, and their primary order is their code-unit order. Then for any
/// two strings over that set the primary sequences compare as the strings
/// do by code unit, and equal primaries mean equal strings, so
/// root collation and `<` agree on every such pair. The ledger's keys of
/// every shape it builds (listed in collate.tsv, from seeded IDs) use only
/// that set, and Node's `en` collation order of them is their code-unit order.
#[test]
fn ledger_keys_sort_the_same_under_collation_and_code_units() {
    let safe: Vec<u16> = CODE_UNIT_ORDER_SAFE
        .iter()
        .map(|&byte| u16::from(byte))
        .collect();
    for (index, &a) in safe.iter().enumerate() {
        for &b in &safe[index + 1..] {
            assert!(
                a < b,
                "CODE_UNIT_ORDER_SAFE must be listed in code-unit order"
            );
            // Primary level alone: a single character each, and a tie broken
            // only beyond the primary level would show as equal primaries.
            assert_eq!(
                locale_compare(&[a, 0x7a, 0x7a], &[b]),
                Ok(Ordering::Less),
                "{} {}",
                a as u8 as char,
                b as u8 as char
            );
            assert_eq!(locale_compare(&[a], &[b]), Ok(Ordering::Less));
        }
        assert_ne!(
            locale_compare(&[a], &[]),
            Ok(Ordering::Equal),
            "{} is ignorable",
            a as u8 as char
        );
    }

    let (_, text) = vector_files("collate.tsv").remove(0);
    let keys: Vec<Vec<u16>> = rows(&text)
        .filter(|fields| fields[0] == "key")
        .map(|fields| units(fields[1]))
        .collect();
    assert!(keys.len() > 200, "only {} keys", keys.len());
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(
        sorted, keys,
        "Node's localeCompare order of the ledger keys is not their code-unit order"
    );
    for key in &keys {
        assert!(
            code_unit_order_is_collation_order(key),
            "{} uses a character outside the proven set",
            String::from_utf16_lossy(key)
        );
    }
    for left in &keys {
        for right in &keys {
            assert_eq!(locale_compare(left, right), Ok(left.cmp(right)));
        }
    }

    // The full key alphabet is not safe: the counterexamples Node gives.
    let counters: Vec<(String, String)> = rows(&text)
        .filter(|fields| fields[0] == "counter")
        .map(|fields| (fields[1].to_string(), fields[2].to_string()))
        .collect();
    assert!(!counters.is_empty());
    for (a, b) in &counters {
        assert!(
            a.bytes()
                .chain(b.bytes())
                .any(|byte| byte.is_ascii_uppercase() || byte == b'_'),
            "{a:?} {b:?}: a counterexample inside the proven set"
        );
        assert_ne!(
            locale_compare(&units(a), &units(b)),
            Ok(units(a).cmp(&units(b)))
        );
    }
    eprintln!(
        "{} ledger keys: localeCompare order equals code-unit order; {} single-character counterexamples, all with A-Z or _",
        keys.len(),
        counters.len()
    );
}

/// The sample a host sorts at start-up (`ledger_key_sample`): the same list
/// as the tracked copy, in code-unit order, every key over the proven set,
/// and in that same order under root collation.
#[test]
fn the_key_sample_is_tracked_and_in_code_unit_order() {
    let sample = ledger_key_sample();
    let copy = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ledger-key-sample.txt"),
    )
    .expect("tracked sample");
    let copy: Vec<&str> = copy.lines().collect();
    assert_eq!(
        sample, copy,
        "ledger_key_sample() is not tests/ledger-key-sample.txt: node tests/generate-collate.mjs"
    );
    assert!(
        sample
            .windows(2)
            .all(|pair| units(pair[0]) < units(pair[1])),
        "not strictly in code-unit order"
    );
    assert!(sample.len() > 1800, "only {} keys", sample.len());
    for key in &sample {
        assert!(
            code_unit_order_is_collation_order(&units(key)),
            "{key} is outside the proven set"
        );
    }
    for pair in sample.windows(2) {
        assert_eq!(
            locale_compare(&units(pair[0]), &units(pair[1])),
            Ok(Ordering::Less),
            "{} {}",
            pair[0],
            pair[1]
        );
    }
}
