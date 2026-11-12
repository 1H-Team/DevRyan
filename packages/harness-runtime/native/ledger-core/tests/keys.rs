//! `ledger_core::keys` and `ledger_core::paths` against the JavaScript
//! (`keys.tsv`, written by `generate-keys.mjs`).
mod support;

use ledger_core::js::{JsStr, Value, parse, stringify};
use ledger_core::keys::{
    PagingError, entity_key, page_name, pages_of, record_too_large, valid_import_source, valid_key,
    valid_lease_token, valid_list_object, valid_object_id, valid_prefix, valid_store_ref,
};
use ledger_core::paths::safe_change_path;
use ledger_core::tree::Digest;
use support::{Failures, fnv64, hex, rows, vector_files};

fn value(text: &str) -> Value {
    parse(&text.encode_utf16().collect::<Vec<u16>>())
        .unwrap_or_else(|error| panic!("{text}: {error:?}"))
}

fn string(text: &str) -> JsStr {
    match &value(text) {
        Value::String(text) => text.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

/// A value from the generator's spec: `{"j":JSON}`, `{"r":[unit, count]}`, `{"u":1}`.
fn spec_value(spec: &Value) -> Value {
    let spec = spec.as_object().unwrap();
    if spec.get_str("u").is_some() {
        return Value::Undefined;
    }
    if let Some(Value::String(json)) = spec.get_str("j") {
        return value(&json.to_string());
    }
    let repeat = spec.get_str("r").and_then(Value::as_array).expect("a spec");
    let (Value::Number(unit), Value::Number(count)) = (&repeat[0], &repeat[1]) else {
        panic!("spec")
    };
    Value::String(JsStr::from_units(vec![*unit as u16; *count as usize]))
}

/// Hands back the digest the vector names, after checking the bytes it was given.
struct Expect<'a> {
    bytes: Vec<u8>,
    digest: &'a str,
    seen: bool,
}

impl Digest for Expect<'_> {
    fn hex(&mut self, parts: &[&[u8]]) -> JsStr {
        self.seen = parts.concat() == self.bytes;
        JsStr::from(self.digest)
    }
}

#[test]
fn keys_pages_and_paths_match_the_javascript() {
    for (path, text) in vector_files("keys.tsv") {
        let mut failures = Failures::new();
        let mut kinds = std::collections::BTreeMap::new();
        for fields in rows(&text) {
            *kinds.entry(fields[0].to_owned()).or_insert(0) += 1;
            match fields[0] {
                "key" => {
                    let text = string(fields[2]);
                    let units = text.units();
                    let actual = match fields[1] {
                        "key" => valid_key(units),
                        "prefix" => valid_prefix(units),
                        "at" => valid_object_id(units),
                        "ref" => valid_store_ref(units),
                        "lease" => valid_lease_token(units),
                        "import" => valid_import_source(units),
                        "list40" => valid_list_object(units, 40),
                        other => panic!("{path}: unknown check {other}"),
                    };
                    failures.check(actual == (fields[3] == "1"), || {
                        format!(
                            "{} {}: JavaScript {}, Rust {actual}",
                            fields[1], fields[2], fields[3]
                        )
                    });
                }
                "entity" => {
                    let mut digest = Expect {
                        bytes: hex(fields[3]),
                        digest: fields[4],
                        seen: false,
                    };
                    let key = entity_key(&mut digest, fields[1], &string(fields[2]));
                    failures.check(digest.seen && key == fields[5], || {
                        format!(
                            "entity {} {}: JavaScript {}, Rust {key} (hashed the same bytes: {})",
                            fields[1], fields[2], fields[5], digest.seen
                        )
                    });
                }
                "pages" => {
                    let values: Vec<Value> = value(fields[1])
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(spec_value)
                        .collect();
                    let actual = match pages_of(&values) {
                        Ok(pages) => format!(
                            "{}\t{}\t{}",
                            pages
                                .pages
                                .iter()
                                .map(|page| (page.end - page.start).to_string())
                                .collect::<Vec<_>>()
                                .join(","),
                            pages.bytes,
                            pages
                                .pages
                                .iter()
                                .map(|page| fnv64(&[&page.json]))
                                .collect::<Vec<_>>()
                                .join(",")
                        ),
                        Err(PagingError::NoJson(index)) => format!("error:{index}"),
                        Err(PagingError::TooDeep(index)) => format!("too deep:{index}"),
                    };
                    let expected = fields[2..].join("\t");
                    failures.check(actual == expected, || {
                        format!(
                            "pages of {} values: JavaScript {expected}, Rust {actual}",
                            values.len()
                        )
                    });
                }
                "names" => {
                    let prefix = string(fields[1]);
                    let first: i64 = fields[2].parse().unwrap();
                    let count: usize = fields[3].parse().unwrap();
                    let values: Vec<Value> = (0..count)
                        .map(|index| Value::Number(index as f64))
                        .collect();
                    let pages = pages_of(&values).unwrap().pages.len() as i64;
                    // The JavaScript's names come from `staged`, in key order (past
                    // 9,999,999,999, and below 0, that is not page order); compare sets.
                    let mut names: Vec<JsStr> = (first..first + pages)
                        .map(|index| page_name(prefix.units(), index))
                        .collect();
                    let mut expected: Vec<JsStr> = value(fields[4])
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|name| match name {
                            Value::String(name) => name.clone(),
                            other => panic!("{other:?}"),
                        })
                        .collect();
                    names.sort();
                    expected.sort();
                    let actual = stringify(&Value::Array(
                        names.iter().cloned().map(Value::String).collect(),
                    ))
                    .unwrap()
                    .unwrap()
                    .to_string();
                    failures.check(names == expected, || {
                        format!(
                            "names {} from {first}: JavaScript {}, Rust {actual}",
                            fields[1], fields[4]
                        )
                    });
                }
                "record" => {
                    let json = ledger_core::js::stringify_utf8(&spec_value(&value(fields[1])))
                        .unwrap()
                        .unwrap();
                    let actual = record_too_large(json.len());
                    failures.check(actual == (fields[2] == "1"), || {
                        format!(
                            "record of {} bytes: JavaScript {}, Rust {actual}",
                            json.len(),
                            fields[2]
                        )
                    });
                }
                "path" => {
                    let actual = safe_change_path(string(fields[1]).units());
                    failures.check(actual == (fields[2] == "1"), || {
                        format!(
                            "path {}: JavaScript {}, Rust {actual}",
                            fields[1], fields[2]
                        )
                    });
                }
                other => panic!("{path}: unknown row {other}"),
            }
        }
        assert!(
            ["key", "entity", "pages", "names", "record", "path"]
                .iter()
                .all(|kind| kinds.contains_key(*kind)),
            "{path}: {kinds:?}"
        );
        eprintln!("{path}: {kinds:?}");
        failures.assert_clean(&format!("key, page and path cases in {path}"), 2000);
    }
}
