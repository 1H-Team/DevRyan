//! The client-engine vectors (`tests/client-vectors/<family>.ndjson`,
//! written by `scripts/client-conformance/client-vectors.mjs`): for every
//! family ported to Rust, generated calls and the answers its TypeScript
//! gives under V8 (Electron's Node), replayed here through the runner over
//! protocol 5, one case per call, with no recording, no Bun and no Node. Each
//! call's record (the arguments the engine saw, what it returned or threw,
//! the arguments after, a draft's change set) must equal V8's, identity
//! numbers compared as structure (renumbered by first appearance on both
//! sides) and the message of an error V8 wrote itself (`engineMessages`)
//! compared by class only, as the candidate comparer does.

use std::path::PathBuf;

use devryan_client_engine::families::FAMILIES;
use devryan_client_engine_runner::json::{Json, parse, write};
use devryan_client_engine_runner::serve;

fn text_of(json: &Json) -> String {
    let mut out = Vec::new();
    write(json, &mut out);
    String::from_utf8(out).expect("UTF-8")
}

/// The record with identity numbers renumbered by first appearance.
fn renumbered(node: &Json, numbers: &mut Vec<f64>) -> Json {
    match node {
        Json::Array(items) => Json::Array(items.iter().map(|item| renumbered(item, numbers)).collect()),
        Json::Object(members) => {
            let identity = node.is_tag("id") || node.is_tag("ref");
            Json::Object(
                members
                    .iter()
                    .map(|(key, value)| {
                        if identity
                            && String::from_utf16_lossy(key) == "n"
                            && let Json::Number(n) = value
                        {
                            let at = numbers.iter().position(|known| known == n).unwrap_or_else(|| {
                                numbers.push(*n);
                                numbers.len() - 1
                            });
                            return (key.clone(), Json::Number((at + 1) as f64));
                        }
                        (key.clone(), renumbered(value, numbers))
                    })
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

fn locate<'a>(node: &'a mut Json, path: &[Json]) -> Option<&'a mut Json> {
    let Some((first, rest)) = path.split_first() else { return Some(node) };
    let next = match (node, first) {
        (Json::Array(items), Json::Number(index)) => items.get_mut(*index as usize)?,
        (Json::Object(members), Json::String(key)) => members.iter_mut().find(|(name, _)| name == key).map(|(_, value)| value)?,
        _ => return None,
    };
    locate(next, rest)
}

fn member_mut<'a>(node: &'a mut Json, key: &str) -> Option<&'a mut Json> {
    match node {
        Json::Object(members) => members
            .iter_mut()
            .find(|(name, _)| String::from_utf16_lossy(name) == key)
            .map(|(_, value)| value),
        _ => None,
    }
}

/// The error at `path` (through an identity node) with its message put as a marker, where an error is there.
fn without_message(node: &mut Json, path: &[Json]) {
    let Some(found) = locate(node, path) else { return };
    let target = if found.is_tag("id") { member_mut(found, "value") } else { Some(found) };
    let Some(target) = target else { return };
    if !target.is_tag("class") {
        return;
    }
    if let Some(message) = member_mut(target, "error").and_then(|error| member_mut(error, "message")) {
        *message = Json::str("<engine-written>");
    }
}

/// The compared parts of a record, in a fixed order.
fn record_of(args: &Json, step: &Json) -> Json {
    let mut out = vec![(
        "args",
        step.get("input").and_then(|input| input.get("args")).cloned().unwrap_or_else(|| args.clone()),
    )];
    for key in ["returns", "throws", "after", "changes"] {
        if let Some(value) = step.get(key) {
            out.push((key, value.clone()));
        }
    }
    Json::object(out)
}

/// A tree with the answer's string-table references put back.
fn expand(node: &Json, table: &[Json]) -> Json {
    match node {
        Json::Array(items) => Json::Array(items.iter().map(|item| expand(item, table)).collect()),
        Json::Object(members) if node.is_tag("slice") && members.len() == 2 => table[node.integer("s").expect("index") as usize].clone(),
        Json::Object(members) => Json::Object(members.iter().map(|(key, value)| (key.clone(), expand(value, table))).collect()),
        other => other.clone(),
    }
}

#[test]
fn every_ported_family_answers_its_vectors_as_v8() {
    // The records nest as deep as the generators make them; the runner's main thread has the room a test thread lacks.
    std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(check_vectors)
        .expect("a thread")
        .join()
        .expect("the check passes");
}

fn check_vectors() {
    // A planted difference of the engine turned on for this run only (scoring the plants against this gate; unset
    // in every gate): the run must then fail.
    if let Ok(id) = std::env::var("CLIENT_ENGINE_PLANT") {
        devryan_client_engine::plant::activate(&id).expect("a known planted difference");
    }
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("client-vectors");
    let mut failures = Vec::new();
    let mut calls = 0;
    for family in FAMILIES {
        let file = directory.join(format!("{}.ndjson", family.name));
        let text = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error} (write it with client-vectors.mjs)", file.display()));
        let mut lines = text.lines();
        let header = parse(lines.next().expect("a header").as_bytes()).expect("the header is JSON");
        assert_eq!(header.text("format").as_deref(), Some("devryan-client-vectors@1"), "{}", file.display());
        assert_eq!(header.text("family").as_deref(), Some(family.name));
        let descriptor = header.get("descriptor").expect("a descriptor");
        let vectors: Vec<Json> = lines.map(|line| parse(line.as_bytes()).expect("a vector line is JSON")).collect();
        let counts = header.get("counts").expect("counts");
        assert_eq!(
            vectors.len() as i64,
            counts.integer("full").unwrap() + counts.integer("typed").unwrap() + counts.integer("witnesses").unwrap_or(0),
            "{}",
            file.display()
        );
        // One unit, one case per call: open, then case, step and end for each.
        let mut requests = vec![text_of(&Json::object(vec![
            ("id", Json::Number(1.0)),
            ("op", Json::str("open")),
            ("unit", Json::Number(1.0)),
            ("family", descriptor.clone()),
            ("plants", Json::Array(Vec::new())),
        ]))];
        for (at, vector) in vectors.iter().enumerate() {
            let id = 10.0 + 3.0 * at as f64;
            let step = Json::object(vec![
                (
                    "input",
                    Json::object(vec![
                        ("kind", Json::str("call")),
                        ("entry", vector.get("entry").cloned().expect("entry")),
                        ("args", vector.get("args").cloned().expect("args")),
                        ("now", Json::Number(1.0)),
                    ]),
                ),
                ("env", Json::Array(Vec::new())),
                ("bind", Json::Array(Vec::new())),
                ("entryBind", Json::Array(Vec::new())),
            ]);
            requests.push(text_of(&Json::object(vec![
                ("id", Json::Number(id)),
                ("op", Json::str("case")),
                ("unit", Json::Number(1.0)),
            ])));
            requests.push(text_of(&Json::object(vec![
                ("id", Json::Number(id + 1.0)),
                ("op", Json::str("step")),
                ("unit", Json::Number(1.0)),
                ("step", step),
            ])));
            requests.push(text_of(&Json::object(vec![
                ("id", Json::Number(id + 2.0)),
                ("op", Json::str("end")),
                ("unit", Json::Number(1.0)),
            ])));
        }
        let input: String = requests.iter().map(|line| format!("{line}\n")).collect();
        let mut output = Vec::new();
        serve(input.as_bytes(), &mut output).expect("serve");
        let answers: Vec<Json> = String::from_utf8(output)
            .expect("UTF-8")
            .lines()
            .map(|line| parse(line.as_bytes()).expect("an answer is JSON"))
            .collect();
        assert_eq!(answers[0].get("ok"), Some(&Json::Bool(true)), "open {}: {}", family.name, text_of(&answers[0]));
        for (at, vector) in vectors.iter().enumerate() {
            calls += 1;
            let end = &answers[3 + 3 * at];
            let replayed = end
                .get("replayed")
                .unwrap_or_else(|| panic!("{} call {}: {}", family.name, at + 1, text_of(end)));
            let table = replayed.get("strings").and_then(Json::as_array).unwrap_or_default().to_vec();
            let args = vector.get("args").expect("args");
            let mut actual = match replayed.get("halt") {
                Some(halt) if !matches!(halt, Json::Null) => Json::object(vec![("halt", halt.clone())]),
                _ => record_of(args, &expand(&replayed.get("steps").and_then(Json::as_array).expect("steps")[0], &table)),
            };
            let mut wanted = vector.get("record").cloned().expect("record");
            for path in vector.get("engineMessages").and_then(Json::as_array).unwrap_or_default() {
                let path = path.as_array().unwrap_or_default();
                without_message(&mut wanted, path);
                without_message(&mut actual, path);
            }
            let (wanted, actual) = (text_of(&renumbered(&wanted, &mut Vec::new())), text_of(&renumbered(&actual, &mut Vec::new())));
            if wanted != actual {
                failures.push(format!(
                    "{} call {} ({}): V8 {}\n    Rust {}",
                    family.name,
                    at + 1,
                    vector.text("entry").unwrap_or_default(),
                    wanted.chars().take(400).collect::<String>(),
                    actual.chars().take(400).collect::<String>()
                ));
            }
        }
    }
    assert!(calls >= 1000, "{calls} calls");
    assert!(
        failures.is_empty(),
        "{} of {calls} calls answered otherwise than V8:\n{}",
        failures.len(),
        failures.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
    );
}
