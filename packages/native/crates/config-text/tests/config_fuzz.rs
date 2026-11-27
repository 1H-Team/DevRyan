//! Seeded fuzzing: every entry point on random texts, on mutations of every
//! tracked vector input and on pathological nesting, on a thread with a
//! 1 MiB stack. Nothing may panic or overflow the stack, whatever the input.
//! `CONFIG_TEXT_FUZZ_ROUNDS=<n>` runs more rounds (the default is 1).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use devryan_config_text::value::{Graph, Val};
use devryan_config_text::{front_matter, js, jsonc, vector, yaml};

/// mulberry32, as the JavaScript generators draw.
struct Random(u32);

impl Random {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut value = (self.0 ^ (self.0 >> 15)).wrapping_mul(1 | self.0);
        value = (value.wrapping_add((value ^ (value >> 7)).wrapping_mul(61 | value))) ^ value;
        value ^ (value >> 14)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() as usize) % n.max(1)
    }
}

const POOL: &str = "{}[],:\"'/*\n\r\t \\#-?&!|>%@`~.0123456789eE+abtrufnlsxyz\u{feff}\u{2028}é";

fn random_text(random: &mut Random) -> Vec<u16> {
    let pool: Vec<u16> = js::units(POOL);
    let length = random.below(120);
    let mut out = Vec::with_capacity(length);
    for _ in 0..length {
        match random.below(40) {
            0 => out.push(0xd800 + random.below(0x800) as u16),
            1 => out.push(random.below(0x20) as u16),
            _ => out.push(pool[random.below(pool.len())]),
        }
    }
    out
}

fn mutate(random: &mut Random, text: &[u16]) -> Vec<u16> {
    let pool: Vec<u16> = js::units(POOL);
    let mut out = text.to_vec();
    for _ in 0..1 + random.below(4) {
        let at = random.below(out.len() + 1);
        match random.below(4) {
            0 if !out.is_empty() && at < out.len() => {
                out.remove(at);
            }
            1 => out.insert(at, pool[random.below(pool.len())]),
            2 if at < out.len() => out[at] = pool[random.below(pool.len())],
            _ => {
                let start = random.below(out.len() + 1);
                let end = (start + random.below(30)).min(out.len());
                let copy = out[start..end].to_vec();
                for (offset, unit) in copy.into_iter().enumerate() {
                    out.insert((at + offset).min(out.len()), unit);
                }
            }
        }
    }
    out
}

fn exercise(random: &mut Random, text: &[u16]) {
    let parsed = jsonc::parse(text);
    jsonc::strip_comments(text);
    let paths = [
        vec![js::units("plugin")],
        vec![js::units("a"), js::units("b")],
        vec![js::units("__proto__")],
        Vec::new(),
    ];
    let path = &paths[random.below(paths.len())];
    let mut graph = Graph::new();
    let value = graph.from_description("[\"x\",{\"y\":-0}]").unwrap_or(Val::Undefined);
    let _ = jsonc::modify(text, path, &graph, &value, &[0x0a]);
    let _ = jsonc::modify(text, path, &graph, &Val::Undefined, &[0x0d, 0x0a]);
    let _ = jsonc::remove_key_paths(text, &[path.clone(), vec![js::units("provider"), js::units("x")]]);
    if let Ok(parsed) = parsed {
        // A parsed JSONC value (prototypes included) through stringify.
        let _ = yaml::stringify(&parsed.graph, &parsed.value);
        let _ = parsed.graph.describe(&parsed.value);
    }
    match yaml::parse(text) {
        yaml::Parsed::Value { graph, value, .. } => {
            let _ = yaml::stringify(&graph, &value);
            let _ = graph.describe(&value);
        }
        yaml::Parsed::Thrown { .. } | yaml::Parsed::Refused(_) => {}
    }
    front_matter::split(text);
    front_matter::split_skill(text);
    js::trim(text);
    js::to_utf8(text);
}

fn vector_inputs() -> Vec<Vec<u16>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut out = Vec::new();
    for file in ["config-jsonc.tsv", "config-jsonc-edits.tsv", "config-yaml-parse.tsv", "config-front-matter.tsv"] {
        let text = std::fs::read_to_string(dir.join(file)).unwrap_or_default();
        for line in text.lines().filter(|line| !line.starts_with('#') && !line.starts_with("end\t")) {
            if let Some(field) = line.split('\t').nth(2)
                && let Ok(units) = vector::field(field)
            {
                out.push(units);
            }
        }
    }
    out
}

fn pathological() -> Vec<Vec<u16>> {
    let repeat = |piece: &str, count: usize| js::units(&piece.repeat(count));
    vec![
        repeat("[", 100_000),
        repeat("{\"a\":", 50_000),
        repeat("- ", 50_000),
        repeat("? ", 50_000),
        repeat("[a, ", 30_000),
        repeat("{a: ", 30_000),
        repeat("a:\n ", 20_000),
        repeat("&a [*a, ", 5_000),
        repeat("/*", 50_000),
        repeat("\"\\u", 30_000),
        repeat("x", 300_000),
        repeat("a: &a [*a]\n", 2_000),
        js::units(&format!("a: &a [{}]\nb: [{}]\n", "x, ".repeat(5_000), "*a, ".repeat(5_000))),
    ]
}

#[test]
fn no_input_panics() {
    let rounds: u32 = std::env::var("CONFIG_TEXT_FUZZ_ROUNDS").ok().and_then(|text| text.parse().ok()).unwrap_or(1);
    let worker = std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || {
            let inputs = vector_inputs();
            assert!(inputs.len() > 1000, "the tracked vectors hold the corpus");
            let mut failures: Vec<String> = Vec::new();
            let mut random = Random(20_261_112);
            let mut run = |random: &mut Random, label: String, text: Vec<u16>| {
                if catch_unwind(AssertUnwindSafe(|| exercise(random, &text))).is_err() {
                    failures.push(format!("{label}: {}", js::lossy_json(&text).chars().take(300).collect::<String>()));
                }
            };
            for text in pathological() {
                run(&mut random, "pathological".to_owned(), text);
            }
            for round in 0..rounds {
                for (index, input) in inputs.iter().enumerate() {
                    let mutated = mutate(&mut random, input);
                    run(&mut random, format!("round {round} mutation of input {index}"), mutated);
                }
                for index in 0..3000 {
                    let text = random_text(&mut random);
                    run(&mut random, format!("round {round} random {index}"), text);
                }
            }
            failures
        })
        .expect("spawn the fuzz thread");
    let failures = worker.join().expect("the fuzz thread overflowed its stack or aborted");
    assert!(
        failures.is_empty(),
        "{} inputs panicked:\n{}",
        failures.len(),
        failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n")
    );
}
