//! The ledger core's tracked V8 vectors for JSON (`json.tsv`:
//! `JSON.stringify(JSON.parse(input))` as Node writes it) run through this
//! workspace's JavaScript semantics: the runner's JSON reader, the engine's
//! values (V8's member order: integer keys ascending, then insertion; a
//! repeated key keeps its first place and its last value) and the engine's
//! `JSON.stringify` (escapes, number layout). Rows the protocol never carries
//! are passed over and counted: input that is no UTF-8 (raw lone surrogates
//! in WTF-8), members named `$dr` (the codec's tag), the ledger's depth-bound
//! rows, and inputs Node refuses.

use devryan_client_engine::js::json_stringify;
use devryan_client_engine_runner::codec::rebuild;
use devryan_client_engine_runner::json::parse;

fn base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        let value = ALPHABET.iter().position(|item| *item == byte).expect("base64") as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

#[test]
fn json_member_order_escapes_and_numbers_match_the_ledger_core_s_v8_vectors() {
    // The vectors nest arrays up to the ledger's depth bound; the runner's main thread has the room a test thread lacks.
    std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(check_json_vectors)
        .expect("a thread")
        .join()
        .expect("the check passes");
}

fn check_json_vectors() {
    let text = include_str!("../../../../harness-runtime/native/ledger-core/tests/json.tsv");
    let (mut compared, mut passed_over) = (0, 0);
    let mut failures = Vec::new();
    for line in text
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("end\t"))
    {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() != 3 || fields[0] == "bound" || fields[2] == "!" || fields[2] == "deep" {
            passed_over += 1;
            continue;
        }
        let input = base64(fields[1]);
        let Ok(utf8) = std::str::from_utf8(&input) else {
            passed_over += 1;
            continue;
        };
        if utf8.contains("\"$dr\"") {
            passed_over += 1;
            continue;
        }
        let Ok(tree) = parse(&input) else {
            passed_over += 1;
            continue;
        };
        let value = rebuild(&tree, &mut std::collections::HashMap::new()).expect("a plain JSON tree rebuilds");
        let written = json_stringify(&value).expect("no cycle").map(|units| String::from_utf16_lossy(&units));
        let wanted = String::from_utf8(base64(fields[2])).expect("UTF-8");
        if written.as_deref() != Some(wanted.as_str()) {
            failures.push(format!("{}: V8 {wanted}, Rust {written:?}", fields[0]));
        }
        compared += 1;
    }
    assert!(compared >= 1000, "{compared} rows compared, {passed_over} passed over");
    assert!(
        failures.is_empty(),
        "{} of {compared} differ: {:?}",
        failures.len(),
        &failures[..failures.len().min(3)]
    );
}
