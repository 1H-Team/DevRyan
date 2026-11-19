//! The port against edit scripts the JavaScript `mutationDiff` produced
//! (`vectors.tsv`, written by `generate-vectors.mjs`). Needs no JavaScript.

const VECTORS: &str = include_str!("vectors.tsv");

fn hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "odd hex length");
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn the_port_reproduces_every_javascript_vector() {
    let mut cases = 0;
    let mut failures = Vec::new();
    for line in VECTORS.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        assert_eq!(fields.len(), 5, "malformed vector line: {line}");
        let budget: i64 = fields[1].parse().expect("budget");
        let expected: Vec<u32> = if fields[4].is_empty() {
            Vec::new()
        } else {
            fields[4]
                .split(',')
                .map(|value| value.parse().expect("pair"))
                .collect()
        };
        let actual = ledger_core::diff::mutation_diff(&hex(fields[2]), &hex(fields[3]), budget);
        if actual != expected {
            failures.push(format!(
                "{}: expected {expected:?}, got {actual:?}",
                fields[0]
            ));
        }
        cases += 1;
    }
    assert!(cases >= 1000, "only {cases} vectors");
    assert!(
        failures.is_empty(),
        "{} of {cases} vectors differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
