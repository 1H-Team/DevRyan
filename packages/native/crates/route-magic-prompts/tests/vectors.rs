//! Runs every row of the tracked vectors (tests/generate-vectors.mjs made them
//! by running the JavaScript this crate ports) through the crate and requires
//! the same bytes: the runtime's answers and data file after each operation,
//! what the request decoding leaves in `req.body?.text` (plain and compressed
//! bodies), Express's ETag and fresh's verdict.

use std::path::PathBuf;

use devryan_route_magic_prompts::answer::{base64, base64_decode, fresh, weak_etag};
use devryan_route_magic_prompts::body;
use devryan_route_magic_prompts::group::pathname;
use devryan_route_magic_prompts::http::Headers;
use devryan_route_magic_prompts::order::Ticket;
use devryan_route_magic_prompts::runtime::{Runtime, stringify};

fn rows(name: &str) -> Vec<(Vec<String>, Vec<String>)> {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name);
    let text = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
    let rows: Vec<(Vec<String>, Vec<String>)> = text
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let fields: Vec<String> = line.split('\t').map(str::to_owned).collect();
            let at = fields.iter().position(|field| field == "=>").expect("a row has its => field");
            (fields[..at].to_vec(), fields[at + 1..].to_vec())
        })
        .collect();
    assert!(rows.len() >= 100, "{name} holds {} rows", rows.len());
    rows
}

fn utf16(field: &str) -> Vec<u16> {
    base64_decode(field.as_bytes())
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect()
}

/// A private folder under the OS temp dir, removed when dropped (a failing assertion included).
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("devryan-route-vectors-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch folder");
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn runtime_operations_match_the_javascript() {
    let scratch = Scratch::new();
    for (index, (input, outputs)) in rows("runtime.tsv").into_iter().enumerate() {
        let dir = scratch.0.join(index.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("magic-prompts.json");
        if input[0] != "-" {
            std::fs::write(&file, base64_decode(input[0].as_bytes())).unwrap();
        }
        let runtime = Runtime::new(dir.to_str().unwrap());
        for (step, (op, expected)) in input[1..].iter().zip(&outputs).enumerate() {
            let parts: Vec<&str> = op.split(':').collect();
            let (id, text) = (utf16(parts[1]), utf16(parts[2]));
            let result = match parts[0] {
                "set" => runtime.set_override(&Ticket::alone(), &id, &text),
                "reset" => runtime.reset_override(&Ticket::alone(), &id),
                "all" => runtime.reset_all_overrides(&Ticket::alone()),
                _ => Ok(runtime.read_prompt_state()),
            };
            let shown = match result {
                Ok(state) => format!("ok:{}", base64(&devryan_config_text::js::to_utf8(&stringify(&state, false)))),
                Err(message) => format!("error:{}", base64(message.as_bytes())),
            };
            let on_disk = std::fs::read(&file).map_or_else(|_| "-".to_owned(), |bytes| base64(&bytes));
            assert_eq!(format!("{shown}:{on_disk}"), *expected, "runtime.tsv row {} operation {}", index + 1, step + 1);
        }
    }
}

#[test]
fn request_decoding_matches_the_javascript() {
    decoding_matches("bodies.tsv");
}

#[test]
fn compressed_bodies_match_node_zlib() {
    decoding_matches("encodings.tsv");
}

fn decoding_matches(file: &str) {
    for (index, (input, output)) in rows(file).into_iter().enumerate() {
        let target = String::from_utf8(base64_decode(input[0].as_bytes())).unwrap();
        let body = base64_decode(input[3].as_bytes());
        let mut raw: Vec<(String, Vec<u8>)> = vec![("Host".to_owned(), b"127.0.0.1".to_vec()), ("Connection".to_owned(), b"close".to_vec())];
        if input[1] != "-" {
            raw.push(("Content-Type".to_owned(), base64_decode(input[1].as_bytes())));
        }
        if input[2] != "-" {
            raw.push(("Content-Encoding".to_owned(), base64_decode(input[2].as_bytes())));
        }
        raw.push(("Content-Length".to_owned(), body.len().to_string().into_bytes()));
        let headers = Headers::from_raw(&raw);
        let shown = match body::decode(&headers, &body, pathname(&target)) {
            Ok(decoded) => match body::text_field(&decoded) {
                Some(text) => format!("text:{}", base64(&text.iter().flat_map(|unit| unit.to_le_bytes()).collect::<Vec<u8>>())),
                None => "none".to_owned(),
            },
            Err(refusal) => format!("refused:{}", refusal.status),
        };
        assert_eq!(
            shown,
            output[0],
            "{file} row {} ({target}, {:?}, {:?})",
            index + 1,
            headers.text("content-type"),
            headers.text("content-encoding")
        );
    }
}

#[test]
fn answers_match_express() {
    for (index, (input, output)) in rows("answers.tsv").into_iter().enumerate() {
        let decoded = |field: &str| (field != "-").then(|| String::from_utf8_lossy(&base64_decode(field.as_bytes())).into_owned());
        let shown = if input[0] == "etag" {
            weak_etag(&base64_decode(input[1].as_bytes()))
        } else {
            let etag = decoded(&input[1]).unwrap();
            let mut pairs: Vec<(&str, String)> = Vec::new();
            for (name, field) in [("if-none-match", &input[2]), ("if-modified-since", &input[3]), ("cache-control", &input[4])] {
                if let Some(value) = decoded(field) {
                    pairs.push((name, value));
                }
            }
            let borrowed: Vec<(&str, &str)> = pairs.iter().map(|(name, value)| (*name, value.as_str())).collect();
            fresh(&Headers::from_pairs(&borrowed), &etag).to_string()
        };
        assert_eq!(shown, output[0], "answers.tsv row {}", index + 1);
    }
}
