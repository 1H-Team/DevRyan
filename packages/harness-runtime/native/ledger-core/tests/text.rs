//! `ledger_core::text` against the JavaScript (`text.tsv`, written by
//! `generate-text.mjs`): edit histories through `applyMutationText`, the
//! projections, run rows in both formats, `saveRuns` and `runsFor`, and
//! `minimizeMutationAncestry` with its sequence of pauses.
mod support;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use ledger_core::base64;
use ledger_core::js::{JsStr, Value, parse, stringify_utf8};
use ledger_core::keys::{page_name, pages_of};
use ledger_core::text::{
    AncestryPause, BASELINE_PAGE, LoadError, PauseSite, Range, RowError, Run, SavePlan,
    SlicedPause, ancestry_format, apply_mutation_text, decode_mutation_run_rows,
    encode_mutation_run_rows, format_one_rows, initial_mutation_runs, load_document, marker_value,
    minimize_mutation_ancestry, mutation_text, save_plan, visible_mutation_runs,
};
use support::{Failures, Random, ancestry_runs, fnv64, rows, seeded_bytes, vector_files};

fn value(text: &str) -> Value {
    parse(&text.encode_utf16().collect::<Vec<u16>>())
        .unwrap_or_else(|error| panic!("{text}: {error:?}"))
}

fn json_bytes(value: &Value) -> Vec<u8> {
    stringify_utf8(value).unwrap().unwrap()
}

fn fnv(value: &Value) -> String {
    fnv64(&[&json_bytes(value)])
}

fn runs_value(runs: &[Run]) -> Value {
    Value::Array(
        runs.iter()
            .map(|run| {
                Value::Object(
                    run.to_object(|text| Some(Value::String(JsStr::from(base64::encode(text))))),
                )
            })
            .collect(),
    )
}

fn runs_json(runs: &[Run]) -> String {
    String::from_utf8(json_bytes(&runs_value(runs))).unwrap()
}

fn text_fnv(text: &[u8]) -> String {
    fnv64(&[base64::encode(text).as_bytes()])
}

fn str_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.to_string(),
        other => panic!("not a string: {other:?}"),
    }
}

fn num_of(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => *number,
        other => panic!("not a number: {other:?}"),
    }
}

fn set_of(value: Option<&Value>) -> HashSet<JsStr> {
    value
        .and_then(Value::as_array)
        .expect("an id list")
        .iter()
        .map(|id| match id {
            Value::String(id) => id.clone(),
            other => panic!("{other:?}"),
        })
        .collect()
}

/// Runs a future whose every await is ready.
fn now<F: Future>(future: F) -> F::Output {
    match pin!(future).poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("a pause waited"),
    }
}

const LETTERS: [(PauseSite, u8); 6] = [
    (PauseSite::Read, b'r'),
    (PauseSite::Height, b'h'),
    (PauseSite::Order, b'o'),
    (PauseSite::Reach, b'e'),
    (PauseSite::Check, b'c'),
    (PauseSite::Verify, b'v'),
];

/// Records each pause's site and lets the JavaScript's own slice rule decide.
struct Traced<'a, P> {
    inner: P,
    trace: &'a RefCell<Vec<u8>>,
}

impl<P: AncestryPause> AncestryPause for Traced<'_, P> {
    async fn pause(&mut self, site: PauseSite) {
        let letter = LETTERS.iter().find(|(known, _)| *known == site).unwrap().1;
        self.trace.borrow_mut().push(letter);
        self.inner.pause(site).await;
    }
}

/// minimizeMutationAncestry as the generator ran it: `{ f, before, after, changed, trace }` or `{ error, trace }`.
fn traced(runs: &[Run], clock_seed: u32, slice: f64) -> String {
    let trace: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    let mut clock = Random::new(clock_seed);
    let mut now_ms = 1000.0;
    let pause = SlicedPause::start(
        move || {
            now_ms += (clock.next() * 3.0).floor();
            now_ms
        },
        slice,
        || {
            if let Some(last) = trace.borrow_mut().last_mut() {
                *last = last.to_ascii_uppercase();
            }
            std::future::ready(())
        },
    );
    let mut hook = Traced {
        inner: pause,
        trace: &trace,
    };
    let result = now(minimize_mutation_ancestry(runs, &mut hook));
    let trace = trace.into_inner();
    let mut encoded = String::new();
    let mut at = 0;
    while at < trace.len() {
        let end = at
            + trace[at..]
                .iter()
                .take_while(|letter| **letter == trace[at])
                .count();
        encoded.push_str(&format!("{}{}", trace[at] as char, end - at));
        at = end;
    }
    let encoded = format!("\"trace\":\"{encoded}\"");
    match result {
        Ok(done) => format!(
            r#"{{"f":"{}","before":{},"after":{},"changed":{},{encoded}}}"#,
            fnv(&runs_value(&done.runs)),
            done.before,
            done.after,
            done.changed
        ),
        Err(error) => format!(r#"{{"error":"{}",{encoded}}}"#, error.message()),
    }
}

/// The page keys and values `saveRuns` stages under `runs/<id>` for a plan.
fn planned_pages(
    plan: &SavePlan,
    id: &JsStr,
    hash: Option<&JsStr>,
) -> (Vec<(String, Value)>, usize) {
    let mut prefix = JsStr::from("runs/");
    prefix.push_units(id.units());
    let mut first_key = prefix.clone();
    first_key.push_str("/");
    first_key.push_str(BASELINE_PAGE);
    let paged = |rows: &[Value], first: i64, out: &mut Vec<(String, Value)>| {
        let pages = pages_of(rows).unwrap();
        for (index, page) in pages.pages.iter().enumerate() {
            let values = Value::Array(rows[page.start..page.end].to_vec());
            assert_eq!(
                json_bytes(&values),
                page.json,
                "a page's JSON is JSON.stringify(page)"
            );
            out.push((
                page_name(prefix.units(), first + index as i64).to_string(),
                values,
            ));
        }
        pages.bytes
    };
    let mut out = Vec::new();
    let bytes = match plan {
        SavePlan::Marker(text) => {
            out.push((
                first_key.to_string(),
                marker_value(hash.expect("a marker names its object"), text.len()),
            ));
            0
        }
        SavePlan::FormatOne(rows) => paged(rows, 0, &mut out),
        SavePlan::Fenced(rows) => {
            out.push((first_key.to_string(), ancestry_format()));
            paged(rows, 1, &mut out)
        }
    };
    (out, bytes)
}

/// `{ rows, save }` of a run list, as generate-text.mjs `rowsAndSave` writes them.
fn check_rows_and_save(
    failures: &mut Failures,
    label: &str,
    case: &ledger_core::js::JsObject,
    runs: &[Run],
    id: &JsStr,
) {
    let rows = case
        .get_str("rows")
        .and_then(Value::as_object)
        .expect("rows");
    let two = encode_mutation_run_rows(runs);
    // Rows whose starts passed 2^53 do not decode again.
    let back = match decode_mutation_run_rows(&two) {
        Ok(back) => fnv(&runs_value(&back)),
        Err(error) => row_error(error).to_owned(),
    };
    let actual = [
        fnv(&Value::Array(two)),
        fnv(&Value::Array(format_one_rows(runs))),
        back,
    ];
    let expected = [
        str_of(rows.get_str("two")),
        str_of(rows.get_str("one")),
        str_of(rows.get_str("back")),
    ];
    failures.check(actual == expected, || {
        format!(
            "{label}: rows (format 2, format 1, decoded): JavaScript {expected:?}, Rust {actual:?}"
        )
    });
    let save = case
        .get_str("save")
        .and_then(Value::as_object)
        .expect("save");
    let refs = matches!(save.get_str("refs"), Some(Value::Bool(true)));
    let hash = match save.get_str("hash") {
        Some(Value::String(hash)) => Some(hash.clone()),
        _ => None,
    };
    let (plan, entries) = save_plan(runs, id, refs);
    let (pages, bytes) = planned_pages(&plan, id, hash.as_ref());
    let actual: Vec<(String, String)> = pages
        .iter()
        .map(|(name, value)| (name.clone(), fnv(value)))
        .collect();
    let expected: Vec<(String, String)> = save
        .get_str("pages")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|pair| {
            let pair = pair.as_array().unwrap();
            (str_of(pair.first()), str_of(pair.get(1)))
        })
        .collect();
    failures.check(actual == expected, || {
        format!("{label}: saved pages: JavaScript {expected:?}, Rust {actual:?}")
    });
    let counts = (entries as f64, bytes as f64);
    let expected = (
        num_of(save.get_str("entries")),
        num_of(save.get_str("bytes")),
    );
    failures.check(counts == expected, || {
        format!("{label}: saveRuns returned {expected:?}, Rust {counts:?}")
    });
    let marker_text = match &plan {
        SavePlan::Marker(text) => Some(text.clone()),
        _ => None,
    };
    let page_values: Vec<Value> = pages.into_iter().map(|(_, value)| value).collect();
    let loaded = load_document(&page_values, id, |hash: &Value| {
        match (hash, &marker_text) {
            (Value::String(_), Some(text)) => Ok(text.clone()),
            _ => Err(()),
        }
    });
    let actual = match &loaded {
        Ok(runs) => fnv(&runs_value(runs)),
        Err(error) => load_error(error).to_owned(),
    };
    let expected = str_of(save.get_str("load"));
    failures.check(actual == expected, || {
        format!("{label}: runsFor of the saved pages: JavaScript {expected}, Rust {actual}")
    });
}

/// The generator's names for a decoding's refusal.
fn row_error(error: RowError) -> &'static str {
    match error {
        RowError::Invalid => "invalid",
        RowError::Unsupported => "unsupported",
    }
}

/// The generator's names for `runsFor`'s failures.
fn load_error(error: &LoadError<()>) -> &'static str {
    match error {
        LoadError::InvalidChangeRecord | LoadError::Bytes(()) => "invalid",
        LoadError::TypeError => "type",
        LoadError::Unsupported => "unsupported",
    }
}

fn check_history(
    failures: &mut Failures,
    case: &ledger_core::js::JsObject,
    counts: &mut HashMap<&'static str, usize>,
) {
    let id = JsStr::from(str_of(case.get_str("id")));
    let mut baseline = id.clone();
    baseline.push_str(":baseline");
    let runs = initial_mutation_runs(&support::base64(&str_of(case.get_str("text"))), &baseline);
    check_steps(failures, case, counts, &id, runs);
}

/// A case of `large` rows: format 2 rows whose numbers pass 2^53, decoded,
/// then edited, minimized and saved as a history is.
fn check_large(
    failures: &mut Failures,
    case: &ledger_core::js::JsObject,
    counts: &mut HashMap<&'static str, usize>,
) {
    let id = JsStr::from(str_of(case.get_str("id")));
    let mut rows = case
        .get_str("input")
        .and_then(Value::as_array)
        .expect("input rows")
        .to_vec();
    let fill = num_of(case.get_str("fill")) as usize;
    if fill > 0 {
        let Value::Object(first) = &mut rows[0] else {
            panic!("a run row")
        };
        first.set(
            "bytes",
            Value::String(JsStr::from(base64::encode(&vec![b'a'; fill]))),
        );
    }
    let runs = decode_mutation_run_rows(&rows).expect("the rows decode");
    let actual = fnv(&runs_value(&runs));
    let expected = str_of(case.get_str("decoded"));
    failures.check(actual == expected, || {
        format!(
            "large {id}: decoded runs: JavaScript {expected}, Rust {actual}: {}",
            runs_json(&runs)
        )
    });
    check_steps(failures, case, counts, &id, runs);
}

/// A history's steps, views, minimization, rows and save, from `runs`.
fn check_steps(
    failures: &mut Failures,
    case: &ledger_core::js::JsObject,
    counts: &mut HashMap<&'static str, usize>,
    id: &JsStr,
    mut runs: Vec<Run>,
) {
    for (index, step) in case
        .get_str("steps")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .enumerate()
    {
        let step = step.as_object().unwrap();
        let inactive = set_of(step.get_str("off"));
        let after = support::base64(&str_of(step.get_str("after")));
        let budget = num_of(step.get_str("budget"));
        let operation = JsStr::from(str_of(step.get_str("op")));
        let base = visible_mutation_runs(&runs, &inactive);
        let next = apply_mutation_text(&runs, &base, &after, &operation, budget);
        runs = next;
        *counts.entry("steps").or_default() += 1;
        if budget < 2_000_000.0 {
            *counts.entry("small hunk budgets").or_default() += 1;
        }
        let expected = (str_of(step.get_str("f")), str_of(step.get_str("v")));
        let actual = (
            fnv(&runs_value(&runs)),
            text_fnv(&mutation_text(&runs, &inactive)),
        );
        failures.check(actual == expected, || {
            format!(
                "history {id} step {index}: JavaScript {expected:?}, Rust {actual:?}: {}",
                runs_json(&runs)
            )
        });
    }
    for view in case
        .get_str("views")
        .and_then(Value::as_array)
        .unwrap_or_default()
    {
        let view = view.as_object().unwrap();
        let actual = text_fnv(&mutation_text(&runs, &set_of(view.get_str("off"))));
        failures.check(actual == str_of(view.get_str("v")), || {
            format!("history {id}: a view differs")
        });
    }
    let expected = String::from_utf8(json_bytes(case.get_str("m").unwrap())).unwrap();
    let actual = traced(
        &runs,
        num_of(case.get_str("clock")) as u32,
        num_of(case.get_str("slice")),
    );
    failures.check(actual == expected, || {
        format!("history {id}: minimize: JavaScript {expected}, Rust {actual}")
    });
    check_rows_and_save(failures, &format!("history {id}"), case, &runs, id);
}

#[test]
fn the_text_engine_matches_the_javascript() {
    for (path, text) in vector_files("text.tsv") {
        let mut failures = Failures::new();
        let mut counts: HashMap<&'static str, usize> = HashMap::new();
        for fields in rows(&text) {
            *counts
                .entry(match fields[0] {
                    "history" => "histories",
                    "long" => "long texts",
                    "ancestry" => "ancestry cases",
                    "decode" => "row decodings",
                    "document" => "documents",
                    "large" => "runs past 2^53",
                    other => panic!("{path}: unknown row {other}"),
                })
                .or_default() += 1;
            match fields[0] {
                "history" => check_history(
                    &mut failures,
                    value(fields[1]).as_object().unwrap(),
                    &mut counts,
                ),
                "large" => check_large(
                    &mut failures,
                    value(fields[1]).as_object().unwrap(),
                    &mut counts,
                ),
                "long" => {
                    let case = value(fields[1]);
                    let case = case.as_object().unwrap();
                    let id = JsStr::from(str_of(case.get_str("id")));
                    let mut baseline = id.clone();
                    baseline.push_str(":baseline");
                    let text = seeded_bytes(
                        &mut Random::new(num_of(case.get_str("seed")) as u32),
                        num_of(case.get_str("length")) as usize,
                    );
                    let mut runs = initial_mutation_runs(&text, &baseline);
                    if let Some(edit) = case.get_str("edit").and_then(Value::as_array) {
                        let [at, cut, insert] =
                            [0, 1, 2].map(|index| num_of(edit.get(index)) as usize);
                        let mut after = text[..at].to_vec();
                        after.extend(std::iter::repeat_n(b'X', insert));
                        after.extend_from_slice(&text[(at + cut).min(text.len())..]);
                        let base: Vec<&Run> = runs.iter().collect();
                        let next = apply_mutation_text(
                            &runs,
                            &base,
                            &after,
                            &JsStr::from("op0"),
                            2_000_000.0,
                        );
                        runs = next;
                    }
                    let actual = fnv(&runs_value(&runs));
                    failures.check(actual == str_of(case.get_str("f")), || {
                        format!("long {id}: runs differ")
                    });
                    check_rows_and_save(&mut failures, &format!("long {id}"), case, &runs, &id);
                }
                "ancestry" => {
                    let case = value(fields[1]);
                    let case = case.as_object().unwrap();
                    let seed = num_of(case.get_str("seed")) as u32;
                    let runs: Vec<Run> = ancestry_runs(seed)
                        .into_iter()
                        .map(|seeded| {
                            let mut run = Run::new(
                                JsStr::from(format!("o{}", seeded.id)),
                                seeded.start,
                                vec![b'a'; seeded.length],
                                (seeded.id > 0).then(|| JsStr::from(format!("op{}", seeded.id))),
                            );
                            run.replaces = Arc::from(
                                seeded
                                    .replaces
                                    .iter()
                                    .map(|(id, start, length)| Range {
                                        id: JsStr::from(format!("o{id}")),
                                        start: *start,
                                        length: *length,
                                    })
                                    .collect::<Vec<_>>(),
                            );
                            run
                        })
                        .collect();
                    let expected =
                        String::from_utf8(json_bytes(case.get_str("m").unwrap())).unwrap();
                    let actual = traced(
                        &runs,
                        num_of(case.get_str("clock")) as u32,
                        num_of(case.get_str("slice")),
                    );
                    if expected.contains("\"error\"") {
                        *counts.entry("ancestry errors").or_default() += 1;
                    }
                    if expected.bytes().any(|byte| byte.is_ascii_uppercase()) {
                        *counts.entry("ancestry cases that yielded").or_default() += 1;
                    }
                    failures.check(actual == expected, || {
                        format!("ancestry seed {seed}: JavaScript {expected}, Rust {actual}")
                    });
                }
                "decode" => {
                    let rows = value(fields[1]);
                    let actual = match decode_mutation_run_rows(rows.as_array().unwrap()) {
                        Ok(runs) => fnv(&runs_value(&runs)),
                        Err(error) => row_error(error).to_owned(),
                    };
                    failures.check(actual == fields[2], || {
                        format!(
                            "decode {}: JavaScript {}, Rust {actual}",
                            fields[1], fields[2]
                        )
                    });
                }
                "document" => {
                    let pages = value(fields[1]);
                    let objects = value(fields[2]);
                    let objects = objects.as_object().unwrap();
                    let read = |hash: &Value| -> Result<Vec<u8>, ()> {
                        let Value::String(hash) = hash else {
                            return Err(());
                        };
                        let hex = hash.len() == 64
                            && hash
                                .units()
                                .iter()
                                .all(|unit| matches!(*unit, 0x30..=0x39 | 0x61..=0x66));
                        match objects.get(hash) {
                            Some(Value::String(bytes)) if hex => {
                                Ok(support::base64(&bytes.to_string()))
                            }
                            _ => Err(()),
                        }
                    };
                    let actual =
                        match load_document(pages.as_array().unwrap(), &JsStr::from("doc"), read) {
                            Ok(runs) => [
                                runs_value(&runs),
                                Value::Array(encode_mutation_run_rows(&runs)),
                                Value::Array(format_one_rows(&runs)),
                            ]
                            .iter()
                            .map(fnv)
                            .collect::<Vec<_>>()
                            .join(","),
                            Err(error) => load_error(&error).to_owned(),
                        };
                    failures.check(actual == fields[3], || {
                        format!(
                            "document {}: JavaScript {}, Rust {actual}",
                            fields[1], fields[3]
                        )
                    });
                }
                _ => unreachable!(),
            }
        }
        let mut shown: Vec<_> = counts.iter().collect();
        shown.sort();
        eprintln!("{path}: {shown:?}");
        failures.assert_clean(&format!("text cases in {path}"), 1000);
    }
}
