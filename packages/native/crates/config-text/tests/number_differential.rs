//! The number differential's Rust side (`tests/number-differential.mjs` runs it; ignored otherwise): rows of
//! `layout<TAB><64 bits hex><TAB><Node String(x)>` and `parse<TAB><JSON numeral><TAB><64 bits of Node
//! JSON.parse(numeral)>` from `DEVRYAN_NUMBER_ROWS`, each through the workspace's one number implementation
//! (`devryan_config_text::js`). Prints the count and the differences, and fails on any.

use devryan_config_text::js::{decimal_to_f64, number_to_string};

#[test]
#[ignore = "run by tests/number-differential.mjs with DEVRYAN_NUMBER_ROWS"]
fn rows_from_node() {
    let Ok(file) = std::env::var("DEVRYAN_NUMBER_ROWS") else {
        panic!("DEVRYAN_NUMBER_ROWS names no file")
    };
    let text = std::fs::read_to_string(&file).expect("the rows file");
    let (mut layouts, mut parses) = (0, 0);
    let mut failures = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[..] {
            ["layout", bits, written] => {
                layouts += 1;
                let actual = number_to_string(f64::from_bits(u64::from_str_radix(bits, 16).expect("hex")));
                if actual != written {
                    failures.push(format!("layout {bits}: V8 {written}, Rust {actual}"));
                }
            }
            ["parse", numeral, bits] => {
                parses += 1;
                let actual = decimal_to_f64(numeral.as_bytes()).map(f64::to_bits);
                if actual != Some(u64::from_str_radix(bits, 16).expect("hex")) {
                    failures.push(format!("parse {numeral}: V8 {bits}, Rust {actual:x?}"));
                }
            }
            _ => panic!("malformed row {line:?}"),
        }
    }
    println!("number differential: {layouts} layouts, {parses} parses, {} differ", failures.len());
    assert!(failures.is_empty(), "{:?}", &failures[..failures.len().min(12)]);
}
