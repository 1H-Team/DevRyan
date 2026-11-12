//! Runs every tracked vector row through the crate and requires the result
//! the installed JavaScript packages gave (the generators beside this file
//! write the rows; `node <generator> --check` proves them current).
//! `CONFIG_TEXT_EXTENDED_DIR=<dir>` also runs the same files found in <dir>
//! (written with a generator's `--extended <dir> --count N`).

use std::path::{Path, PathBuf};

use devryan_config_text::vector;

const FILES: [&str; 5] = [
    "config-jsonc.tsv",
    "config-jsonc-edits.tsv",
    "config-yaml-parse.tsv",
    "config-yaml-stringify.tsv",
    "config-front-matter.tsv",
];

struct Row {
    name: String,
    op: String,
    args: Vec<String>,
    expected: String,
}

fn read_rows(path: &Path) -> Vec<Row> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let mut rows = Vec::new();
    let mut end = None;
    for line in text.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields[0] == "end" {
            end = Some(fields[1].parse::<usize>().expect("end count"));
            continue;
        }
        assert!(fields.len() >= 3, "{}: short row {}", path.display(), fields[0]);
        rows.push(Row {
            name: fields[0].to_owned(),
            op: fields[1].to_owned(),
            args: fields[2..fields.len() - 1].iter().map(|field| (*field).to_owned()).collect(),
            expected: fields[fields.len() - 1].to_owned(),
        });
    }
    assert_eq!(end, Some(rows.len()), "{}: truncated (the `end` row counts the rows)", path.display());
    rows
}

fn show(field: &str) -> String {
    match vector::field(field) {
        Ok(units) => devryan_config_text::js::lossy_json(&units).chars().take(600).collect(),
        Err(error) => format!("<{error}>"),
    }
}

fn check_file(path: &Path) -> usize {
    let rows = read_rows(path);
    assert!(!rows.is_empty(), "{}: no rows", path.display());
    let mut failures = Vec::new();
    for row in &rows {
        let args: Vec<Vec<u16>> = row.args.iter().map(|field| vector::field(field).expect("argument field")).collect();
        let actual = match vector::run(&row.op, &args) {
            Ok(result) => vector::encode_field(&result),
            Err(error) => format!("<error {error}>"),
        };
        if actual != row.expected {
            failures.push(format!(
                "{} ({})\n  input:    {}\n  expected: {}\n  actual:   {}",
                row.name,
                row.op,
                row.args.first().map_or(String::new(), |a| show(a)),
                show(&row.expected),
                show(&actual)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{}: {} of {} rows differ:\n{}",
        path.display(),
        failures.len(),
        rows.len(),
        failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
    );
    rows.len()
}

fn tests_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}

#[test]
fn jsonc_parse_and_strip_comments() {
    check_file(&tests_dir().join(FILES[0]));
}

#[test]
fn jsonc_edits_and_sequences() {
    check_file(&tests_dir().join(FILES[1]));
}

#[test]
fn yaml_parse() {
    check_file(&tests_dir().join(FILES[2]));
}

#[test]
fn yaml_stringify() {
    check_file(&tests_dir().join(FILES[3]));
}

#[test]
fn front_matter_trim_and_utf8() {
    check_file(&tests_dir().join(FILES[4]));
}

#[test]
fn extended_vectors() {
    let Some(dir) = std::env::var_os("CONFIG_TEXT_EXTENDED_DIR") else { return };
    let mut total = 0;
    for file in FILES {
        let path = Path::new(&dir).join(file);
        if path.exists() {
            total += check_file(&path);
        }
    }
    assert!(total > 0, "CONFIG_TEXT_EXTENDED_DIR holds none of {FILES:?}");
}
