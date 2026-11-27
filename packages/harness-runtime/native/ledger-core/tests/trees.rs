//! `ledger_core::tree` against the JavaScript (`trees.tsv`, `commits.tsv`,
//! written by `generate-trees.mjs`) and against Git: every seeded tree's
//! serialization is the one `git mktree` wrote when the vectors were made.
//! With `LEDGER_CORE_GIT=<git>` (the extended run sets it) the ids are also
//! recomputed by that git from the Rust's own bytes (`git hash-object`), as
//! the crate implements no hash function.
mod support;

use std::collections::HashMap;

use ledger_core::js::{JsStr, Value, parse};
use ledger_core::tree::{
    Change, CommitError, Digest, InvalidChangeRecord, ObjectKind, TreeEntry, TreeStore,
    commit_tree_changes, latin1_string, object_header, object_id, parse_tree, serialize_tree,
};
use support::{Failures, fnv64, hex, hex_units, rows, test_object_id, tree_entries, vector_files};

fn entry_json(entry: &TreeEntry) -> String {
    let units = |text: &JsStr| {
        text.units()
            .iter()
            .map(|unit| format!("{unit:04x}"))
            .collect::<String>()
    };
    format!(
        r#"{{"mode":"{}","name":"{}","oid":"{}"}}"#,
        units(&entry.mode),
        units(&entry.name),
        units(&entry.oid)
    )
}

fn entries_json(entries: &[TreeEntry]) -> String {
    format!(
        "[{}]",
        entries.iter().map(entry_json).collect::<Vec<_>>().join(",")
    )
}

/// Entries from the generator's JSON of unit-hex strings.
fn entries_from_json(text: &str) -> Vec<TreeEntry> {
    let value = parse(&text.encode_utf16().collect::<Vec<u16>>()).expect("entries JSON");
    let field = |entry: &Value, name: &str| match entry.as_object().unwrap().get_str(name) {
        Some(Value::String(text)) => JsStr::from_units(hex_units(&text.to_string())),
        other => panic!("{name}: {other:?}"),
    };
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| TreeEntry {
            mode: field(entry, "mode"),
            name: field(entry, "name"),
            oid: field(entry, "oid"),
        })
        .collect()
}

/// Records what it is asked to hash.
struct Recorder(Vec<u8>);

impl Digest for Recorder {
    fn hex(&mut self, parts: &[&[u8]]) -> JsStr {
        self.0 = parts.concat();
        JsStr::new()
    }
}

/// The ids `git hash-object` gives the Rust's own tree bytes, one repository per width.
fn git_ids(git: &str, width: usize, objects: &[Vec<u8>]) -> Vec<String> {
    let scratch =
        std::env::temp_dir().join(format!("ledger-core-trees-{}-{width}", std::process::id()));
    std::fs::create_dir_all(&scratch).unwrap();
    let repository = scratch.join("repo.git");
    let format = if width == 64 { "sha256" } else { "sha1" };
    let status = std::process::Command::new(git)
        .args([
            "init",
            "--quiet",
            "--bare",
            &format!("--object-format={format}"),
        ])
        .arg(&repository)
        .status()
        .unwrap();
    assert!(status.success());
    let mut paths = String::new();
    for (index, bytes) in objects.iter().enumerate() {
        let file = scratch.join(index.to_string());
        std::fs::write(&file, bytes).unwrap();
        paths.push_str(&format!("{}\n", file.display()));
    }
    let mut child = std::process::Command::new(git)
        .arg(format!("--git-dir={}", repository.display()))
        .args(["hash-object", "--literally", "-t", "tree", "--stdin-paths"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    // Feed the paths from another thread: git answers while it reads, and a
    // full stdout pipe would otherwise stop both sides.
    let mut stdin = child.stdin.take().unwrap();
    let feeder = std::thread::spawn(move || stdin.write_all(paths.as_bytes()));
    let output = child.wait_with_output().unwrap();
    feeder.join().unwrap().unwrap();
    std::fs::remove_dir_all(&scratch).unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn trees_match_git_and_the_javascript() {
    let git = std::env::var("LEDGER_CORE_GIT").ok();
    for (path, text) in vector_files("trees.tsv") {
        let mut failures = Failures::new();
        let mut hashed: HashMap<usize, (Vec<Vec<u8>>, Vec<String>)> = HashMap::new();
        let mut counts = [0usize; 3];
        for fields in rows(&text) {
            match fields[0] {
                "tree" => {
                    counts[0] += 1;
                    let (width, seed, count): (usize, u32, usize) = (
                        fields[1].parse().unwrap(),
                        fields[2].parse().unwrap(),
                        fields[3].parse().unwrap(),
                    );
                    let seeded = tree_entries(seed, width);
                    let fingerprint = fnv64(
                        &seeded
                            .iter()
                            .map(|entry| {
                                [
                                    entry.mode.as_bytes(),
                                    b" ",
                                    &entry.name,
                                    b"\0",
                                    &hex(&entry.oid),
                                ]
                                .concat()
                            })
                            .collect::<Vec<_>>()
                            .iter()
                            .map(Vec::as_slice)
                            .collect::<Vec<_>>(),
                    );
                    assert_eq!(
                        (seeded.len(), fingerprint.as_str()),
                        (count, fields[4]),
                        "{path}: seed {seed} draws other entries"
                    );
                    let entries: Vec<TreeEntry> = seeded
                        .iter()
                        .map(|entry| {
                            TreeEntry::new(
                                entry.mode,
                                latin1_string(&entry.name),
                                JsStr::from(entry.oid.as_str()),
                            )
                        })
                        .collect();
                    let order: Vec<usize> = fields[5]
                        .split(',')
                        .map(|index| usize::from_str_radix(index, 36).unwrap())
                        .collect();
                    // Git's bytes, assembled from the entries in Git's order.
                    let expected: Vec<u8> = order
                        .iter()
                        .flat_map(|&index| {
                            let entry = &seeded[index];
                            [
                                entry.mode.as_bytes(),
                                b" ",
                                &entry.name,
                                b"\0",
                                &hex(&entry.oid),
                            ]
                            .concat()
                        })
                        .collect();
                    let bytes = serialize_tree(&entries);
                    failures.check(bytes == expected, || {
                        format!("seed {seed} width {width}: serialization differs from git mktree")
                    });
                    let mut recorder = Recorder(Vec::new());
                    object_id(&mut recorder, "tree", &bytes);
                    failures.check(recorder.0 == [object_header("tree", expected.len()), expected.clone()].concat(), || {
                        format!("seed {seed}: the hashed bytes are not `tree <length>\\0` and the content")
                    });
                    let parsed = parse_tree(&bytes, width);
                    let reordered: Vec<TreeEntry> =
                        order.iter().map(|&index| entries[index].clone()).collect();
                    failures.check(parsed.as_ref() == Ok(&reordered), || {
                        format!("seed {seed}: parse is not Git's entries in Git's order")
                    });
                    if let Ok(parsed) = &parsed {
                        failures.check(serialize_tree(parsed) == bytes, || {
                            format!("seed {seed}: parse then serialize does not round-trip")
                        });
                    }
                    let slot = hashed.entry(width).or_default();
                    slot.0
                        .push(recorder.0[object_header("tree", bytes.len()).len()..].to_vec());
                    slot.1.push(fields[6].to_owned());
                }
                "parse" => {
                    counts[1] += 1;
                    let width: usize = fields[1].parse().unwrap();
                    let actual = match parse_tree(&hex(fields[2]), width) {
                        Ok(entries) => entries_json(&entries),
                        Err(InvalidChangeRecord { status }) => format!("throws:{status}"),
                    };
                    failures.check(actual == fields[3], || {
                        format!(
                            "parse {}: JavaScript {}, Rust {actual}",
                            fields[2], fields[3]
                        )
                    });
                }
                "serialize" => {
                    counts[2] += 1;
                    let actual = serialize_tree(&entries_from_json(fields[1]));
                    failures.check(actual == hex(fields[2]), || {
                        format!(
                            "serialize {}: JavaScript {}, Rust {actual:02x?}",
                            fields[1], fields[2]
                        )
                    });
                }
                other => panic!("{path}: unknown row {other}"),
            }
        }
        assert!(counts.iter().all(|count| *count > 0), "{path}: {counts:?}");
        failures.assert_clean(&format!("tree cases in {path}"), 2400);
        if let Some(git) = &git {
            for (width, (objects, ids)) in &hashed {
                let actual = git_ids(git, *width, objects);
                let differing = actual.iter().zip(ids).filter(|(a, b)| a != b).count();
                assert_eq!(
                    (actual.len(), differing),
                    (ids.len(), 0),
                    "{path}: git hash-object of the Rust's trees (width {width})"
                );
                eprintln!(
                    "{} trees of width {width} in {path}: git hash-object of the Rust's bytes gives the recorded ids",
                    ids.len()
                );
            }
        }
    }
}

/// The generator's in-memory store: ids are `testObjectId`, a tree that is
/// not one is refused as the change store refuses it (503).
struct Memory {
    width: usize,
    unreadable: Option<JsStr>,
    objects: HashMap<JsStr, (ObjectKind, Vec<u8>)>,
    writes: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct NotATree;

impl TreeStore for Memory {
    type Error = NotATree;
    fn read_tree(&mut self, oid: &JsStr) -> Result<Vec<u8>, NotATree> {
        match self.objects.get(oid) {
            Some((ObjectKind::Tree, data)) if self.unreadable.as_ref() != Some(oid) => {
                Ok(data.clone())
            }
            _ => Err(NotATree),
        }
    }
    fn write_object(&mut self, kind: ObjectKind, content: &[u8]) -> Result<JsStr, NotATree> {
        let oid = test_object_id(kind.name(), content, self.width);
        self.objects
            .insert(JsStr::from(oid.as_str()), (kind, content.to_vec()));
        self.writes.push(oid.clone());
        Ok(JsStr::from(oid))
    }
}

fn changes_of(value: &Value) -> Vec<(JsStr, Change)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            let pair = pair.as_array().unwrap();
            let Value::String(key) = &pair[0] else {
                panic!("key")
            };
            let change = match &pair[1] {
                Value::String(text) => Change::Blob(text.clone()),
                Value::Null => Change::Remove,
                Value::Object(object) => match object.get_str("oid") {
                    Some(Value::String(oid)) => Change::Existing(oid.clone()),
                    other => panic!("oid {other:?}"),
                },
                other => panic!("change {other:?}"),
            };
            (key.clone(), change)
        })
        .collect()
}

/// The result as the generator writes it: `{"r":..,"n":..,"f":..}` or `{"e":status}`.
fn outcome(result: &Result<JsStr, CommitError<NotATree>>, writes: &[String]) -> String {
    match result {
        Ok(root) => {
            let mut sorted = writes.to_vec();
            sorted.sort();
            format!(
                r#"{{"r":"{root}","n":{},"f":"{}"}}"#,
                writes.len(),
                fnv64(&[sorted.join("\n").as_bytes()])
            )
        }
        Err(CommitError::Invalid(InvalidChangeRecord { status })) => format!(r#"{{"e":{status}}}"#),
        Err(CommitError::Store(NotATree)) => r#"{"e":503}"#.to_owned(),
    }
}

fn json(value: &Value) -> String {
    ledger_core::js::stringify(value)
        .unwrap()
        .unwrap()
        .to_string()
}

#[test]
fn commits_match_the_javascript() {
    for (path, text) in vector_files("commits.tsv") {
        let mut failures = Failures::new();
        let (mut succeeded, mut refused, mut timing) = (0, 0, 0);
        for fields in rows(&text) {
            assert_eq!(fields[0], "commit", "{path}");
            let case = parse(&fields[1].encode_utf16().collect::<Vec<u16>>()).expect("case JSON");
            let case = case.as_object().unwrap();
            let get = |name: &str| case.get_str(name);
            let Some(Value::Number(width)) = get("w") else {
                panic!("width")
            };
            let width = *width as usize;
            let tree = match get("t") {
                Some(Value::String(tree)) => Some(tree.clone()),
                _ => None,
            };
            let mut store = Memory {
                width,
                unreadable: None,
                objects: HashMap::new(),
                writes: Vec::new(),
            };
            let first = commit_tree_changes(
                tree.as_ref(),
                &changes_of(get("i").unwrap()),
                width,
                &mut store,
            );
            let actual = outcome(&first, &store.writes);
            let expected = json(get("a").unwrap());
            failures.check(actual == expected, || {
                format!(
                    "{}: first commit: JavaScript {expected}, Rust {actual}",
                    fields[1]
                )
            });
            let Some(changes) = get("c") else {
                refused += 1;
                continue;
            };
            if let Some(Value::String(unreadable)) = get("x") {
                assert!(
                    store.objects.contains_key(unreadable),
                    "the unreadable tree was written"
                );
                store.unreadable = Some(unreadable.clone());
            }
            store.writes.clear();
            let root = first.as_ref().ok();
            let second = commit_tree_changes(root, &changes_of(changes), width, &mut store);
            let actual = outcome(&second, &store.writes);
            // One outcome, or every outcome the JavaScript gave under different schedules.
            let expected = get("b").unwrap();
            let allowed: Vec<String> = match expected
                .as_object()
                .and_then(|object| object.get_str("any"))
            {
                Some(any) => any.as_array().unwrap().iter().map(json).collect(),
                None => vec![json(expected)],
            };
            if allowed.len() > 1 {
                timing += 1;
            }
            if second.is_ok() {
                succeeded += 1
            } else {
                refused += 1
            }
            failures.check(allowed.contains(&actual), || {
                format!(
                    "{}: second commit: JavaScript {allowed:?}, Rust {actual}",
                    fields[1]
                )
            });
        }
        failures.assert_clean(
            &format!("commits in {path} ({succeeded} change sets committed, {refused} refused, {timing} whose outcome depends on timing)"),
            500,
        );
    }
}
