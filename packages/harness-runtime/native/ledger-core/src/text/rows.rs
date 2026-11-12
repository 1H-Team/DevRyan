//! Stored run rows and the pages around them.
//!
//! - Format 2 (`encodeMutationRunRows`, `decodeMutationRunRows` in
//!   `session-mutation-text.js`): a run's first 32 KiB chunk carries its
//!   properties and `bytes`, further chunks are `{ continues: true, bytes }`.
//! - Format 1 (`formatOneRows` and the unfenced loop of `runsFor` in
//!   `session-mutations.js`): every chunk repeats the run's properties, with
//!   `start` advanced to the chunk.
//! - Pages: a document whose runs are its untouched baseline is one marker
//!   page `{ baseline: <sha256>, size }` at `0000000000.json`; a document
//!   whose runs replace something is fenced by `{"format":"ancestry","version":2}`
//!   at `0000000000.json` with format 2 rows from page 1; any other document
//!   is format 1 rows from page 0 (`saveRuns`).
//!
//! Text is base64 of the latin1 bytes (`crate::base64`, with Node's lenient
//! decoding). Decoding runs in two passes: first every check the JavaScript
//! makes, in its order, so that a row it refuses is refused here with the
//! same outcome; then the conversion into the run model, which refuses rows
//! outside it (`Unsupported`, see the module documentation of `text`).

use super::{Run, initial_mutation_runs, js_add, run_from_object, safe_integer};
use crate::base64;
use crate::js::{JsObject, JsStr, Value};

/// `MUTATION_RUN_CHUNK`: the text bytes per row.
pub const MUTATION_RUN_CHUNK: usize = 32_768;
/// `BASELINE_PAGE`: the page of a marker or a fence.
pub const BASELINE_PAGE: &str = "0000000000.json";
/// The stamp file written once baseline compaction leaves no inline baseline.
pub const BASELINE_COMPACTED: &str = "baseline-refs";
/// The stamp file written once ancestry compaction has finished.
pub const ANCESTRY_COMPACTED: &str = "ancestry-compacted";

/// Why rows did not decode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowError {
    /// The JavaScript throws (`TypeError('invalid mutation run row')`).
    Invalid,
    /// The JavaScript accepts the rows, but a run is outside the model.
    Unsupported,
}

/// `ANCESTRY_FORMAT`, the fence page `{ format: 'ancestry', version: 2 }`.
pub fn ancestry_format() -> Value {
    let mut object = JsObject::new();
    object.set("format", Value::string("ancestry"));
    object.set("version", Value::Number(2.0));
    Value::Object(object)
}

/// The baseline marker page `{ baseline: hash, size }`.
pub fn marker_value(hash: &JsStr, size: usize) -> Value {
    let mut object = JsObject::new();
    object.set("baseline", Value::String(hash.clone()));
    object.set("size", Value::Number(size as f64));
    Value::Object(object)
}

/// `ancestryFormatPage(value)`: an object with exactly two properties,
/// `format === 'ancestry'` and `version === 2`.
pub fn ancestry_format_page(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == 2
        && matches!(object.get_str("format"), Some(Value::String(format)) if *format == "ancestry")
        && matches!(object.get_str("version"), Some(Value::Number(version)) if *version == 2.0)
}

/// `baselineMarker(value)` threw: `RegExp.prototype.test` could not convert
/// the `baseline` to a string (a `TypeError`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarkerTypeError;

/// `baselineMarker(value)`: an object with exactly two properties, a
/// `baseline` whose string form (`RegExp.prototype.test` converts it) is 64
/// lowercase hex digits, and a `size` that is a positive safe integer.
/// Fails as the JavaScript throws where that conversion throws: a parsed
/// object with its own `toString` (never callable, so `ToPrimitive` falls to
/// `valueOf`, which gives no primitive), also as an element of an array.
pub fn baseline_marker(value: &Value) -> Result<bool, MarkerTypeError> {
    let Some(object) = value.as_object() else {
        return Ok(false);
    };
    if object.len() != 2 {
        return Ok(false);
    }
    let hash = match object.get_str("baseline") {
        None => JsStr::from("undefined"),
        Some(baseline) if to_string_throws(baseline) => return Err(MarkerTypeError),
        Some(baseline) => baseline.to_js_string(),
    };
    let hex = hash.len() == 64
        && hash
            .units()
            .iter()
            .all(|unit| matches!(*unit, 0x30..=0x39 | 0x61..=0x66));
    Ok(hex
        && object
            .get_str("size")
            .and_then(safe_integer)
            .is_some_and(|size| size > 0))
}

/// Whether `String(value)` throws for a parsed JSON value: an object with an
/// own `toString`, itself or inside arrays (`join` converts each element).
fn to_string_throws(value: &Value) -> bool {
    let mut stack = vec![value];
    while let Some(value) = stack.pop() {
        match value {
            Value::Object(object) => {
                if object.get_str("toString").is_some() {
                    return true;
                }
            }
            Value::Array(items) => stack.extend(items.iter()),
            _ => {}
        }
    }
    false
}

fn bytes_value(text: &[u8]) -> Value {
    Value::String(JsStr::from(base64::encode(text)))
}

/// `encodeMutationRunRows(runs)` (format 2). A run without text writes no row.
pub fn encode_mutation_run_rows(runs: &[Run]) -> Vec<Value> {
    let mut rows = Vec::new();
    for run in runs {
        for (index, chunk) in run.text.chunks(MUTATION_RUN_CHUNK).enumerate() {
            if index > 0 {
                let mut row = JsObject::new();
                row.set("continues", Value::Bool(true));
                row.set("bytes", bytes_value(chunk));
                rows.push(Value::Object(row));
                continue;
            }
            // `{ ...metadata, bytes }`: a `bytes` the run holds keeps its place.
            let mut row = run.to_object(|_| None);
            row.set("bytes", bytes_value(chunk));
            rows.push(Value::Object(row));
        }
    }
    rows
}

/// `formatOneRows(runs)` (format 1): every chunk repeats the run's
/// properties except `text` and `bytes`, `start` advanced to the chunk, and
/// `bytes` last.
pub fn format_one_rows(runs: &[Run]) -> Vec<Value> {
    let mut rows = Vec::new();
    for run in runs {
        let stale = run.shape.extra("bytes");
        for (index, chunk) in run.text.chunks(MUTATION_RUN_CHUNK).enumerate() {
            let mut shifted = run.clone();
            shifted.start = js_add(run.start, (index * MUTATION_RUN_CHUNK) as i64);
            let mut row = JsObject::new();
            let full = shifted.to_object(|_| None);
            for (key, value) in full.iter() {
                if stale.is_some() && key == "bytes" {
                    continue;
                }
                row.insert(key, value.clone());
            }
            row.set("bytes", bytes_value(chunk));
            rows.push(Value::Object(row));
        }
    }
    rows
}

/// What the first pass found for one format 2 row.
enum Pending<'a> {
    Run(&'a JsObject, Vec<u8>),
    Continues(Vec<u8>),
}

/// `decodeMutationRunRows(rows)` (format 2).
pub fn decode_mutation_run_rows(rows: &[Value]) -> Result<Vec<Run>, RowError> {
    // The JavaScript's checks, in its order.
    let mut pending = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(object) = row.as_object() else {
            return Err(RowError::Invalid);
        };
        let Some(Value::String(bytes)) = object.get_str("bytes") else {
            return Err(RowError::Invalid);
        };
        let text = base64::decode(bytes.units());
        if matches!(object.get_str("continues"), Some(Value::Bool(true))) {
            if pending.is_empty() || object.len() != 2 {
                return Err(RowError::Invalid);
            }
            pending.push(Pending::Continues(text));
            continue;
        }
        let id = matches!(object.get_str("id"), Some(Value::String(_)));
        let start = object.get_str("start").and_then(safe_integer).is_some();
        let arrays = ["deletedBy", "replaces"]
            .iter()
            .all(|name| matches!(object.get_str(name), Some(Value::Array(_))));
        if !(id && start && arrays) {
            return Err(RowError::Invalid);
        }
        pending.push(Pending::Run(object, text));
    }
    // The model.
    let mut runs: Vec<Run> = Vec::with_capacity(pending.len());
    for item in pending {
        let run = match item {
            Pending::Run(object, text) => {
                run_from_object(object, text, Some("bytes")).ok_or(RowError::Unsupported)?
            }
            Pending::Continues(text) => {
                let previous = runs.last().expect("checked in the first pass");
                let mut run = previous.clone();
                run.start = previous.end();
                run.text = text;
                run
            }
        };
        runs.push(run);
    }
    Ok(runs)
}

/// `baselineText(runs, id)`: the text of runs that are exactly the
/// document's untouched baseline (`<id>:baseline`, no owner, not deleted,
/// replacing nothing, contiguous from 0), or `None`, also for no text.
pub fn baseline_text(runs: &[Run], id: &JsStr) -> Option<Vec<u8>> {
    let mut baseline = id.clone();
    baseline.push_str(":baseline");
    let mut text = Vec::new();
    for run in runs {
        if run.id != baseline
            || run.owner.is_some()
            || !run.deleted_by.is_empty()
            || !run.replaces.is_empty()
            || run.start != text.len() as i64
        {
            return None;
        }
        text.extend_from_slice(&run.text);
    }
    (!text.is_empty()).then_some(text)
}

/// What `saveRuns` stores for a document.
#[derive(Clone, Debug, PartialEq)]
pub enum SavePlan {
    /// One marker page naming this text's content object (the caller stores
    /// the bytes and writes `marker_value(hash, text.len())` at `BASELINE_PAGE`).
    Marker(Vec<u8>),
    /// Format 1 rows, paged from page 0 (`setList(..., { absent: true })`).
    FormatOne(Vec<Value>),
    /// The fence at `BASELINE_PAGE`, then format 2 rows paged from page 1.
    Fenced(Vec<Value>),
}

/// The choice `saveRuns(repo, id, runs)` makes, and its stored ancestry
/// entries (the sum of the runs' `replaces` lengths; 0 for a marker).
/// `baseline_refs` is the kill switch `DEVRYAN_LEDGER_BASELINE_REFS !== '0'`.
pub fn save_plan(runs: &[Run], id: &JsStr, baseline_refs: bool) -> (SavePlan, usize) {
    if let Some(text) = baseline_refs.then(|| baseline_text(runs, id)).flatten() {
        return (SavePlan::Marker(text), 0);
    }
    let entries = runs.iter().map(|run| run.replaces.len()).sum();
    if entries == 0 {
        return (SavePlan::FormatOne(format_one_rows(runs)), 0);
    }
    (SavePlan::Fenced(encode_mutation_run_rows(runs)), entries)
}

/// Why `load_document` failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadError<E> {
    /// `invalid_change_record`.
    InvalidChangeRecord,
    /// The JavaScript throws a `TypeError` reading a format 1 row (a row
    /// that is not an object, or whose `bytes` is missing, a number, a
    /// boolean, `null` or an object `Buffer.from` refuses), or testing a
    /// marker whose `baseline` has no string form (`baseline_marker`).
    TypeError,
    /// The JavaScript reads the pages, but a run is outside the model.
    Unsupported,
    /// The caller's `bytes_for` failed.
    Bytes(E),
}

/// What the first pass found in an unfenced document.
enum Unfenced<'a> {
    Baseline(Vec<u8>),
    Row(&'a JsObject, Vec<u8>),
    /// `bytes` is an array or array-like object: `Buffer.from` takes its
    /// elements, which the model does not.
    ArrayLike,
}

/// `Buffer.from(value, 'base64')` for a format 1 row's `bytes`, as far as
/// the model goes: `Some(Ok(bytes))` for a string, `Some(Err(()))` where
/// `Buffer.from` makes a buffer of something else (an array or array-like,
/// a `{ type: 'Buffer', data }` object, an object whose own `valueOf` is
/// `""`), `None` where it throws a `TypeError` (no value, a number, a
/// boolean, `null`, an object with a truthy own `valueOf`, other objects).
///
/// JS: `{ length: 1e10 }` makes the JavaScript allocate that many bytes (or
/// throw a `RangeError`); here it is `Unsupported` like any array-like.
fn format_one_bytes(value: Option<&Value>) -> Option<Result<Vec<u8>, ()>> {
    match value? {
        Value::String(text) => Some(Ok(base64::decode(text.units()))),
        Value::Array(_) => Some(Err(())),
        Value::Object(object) => {
            // `value.valueOf && value.valueOf()`: a falsy own `valueOf`
            // (`null`, `0`, `false`, `""`) is not called; `""` is then
            // `Buffer.from("")`, the others fall to `fromObject`. A truthy
            // one is not callable, and calling it throws.
            match object.get_str("valueOf") {
                None | Some(Value::Null | Value::Bool(false)) => {}
                Some(Value::Number(number)) if *number == 0.0 => {}
                Some(Value::String(text)) if text.is_empty() => return Some(Err(())),
                Some(_) => return None,
            }
            // `fromObject`: any `length`, or a serialized Buffer.
            let length = object.get_str("length").is_some();
            let buffer = matches!(object.get_str("type"), Some(Value::String(kind)) if *kind == "Buffer")
                && matches!(object.get_str("data"), Some(Value::Array(_)));
            (length || buffer).then_some(Err(()))
        }
        _ => None,
    }
}

/// `runsFor(repo, id)` over a document's pages, in key order. `bytes_for`
/// reads a baseline marker's content object (`bytesFor(repo, value.baseline)`),
/// given the marker's `baseline` value.
pub fn load_document<E>(
    pages: &[Value],
    id: &JsStr,
    mut bytes_for: impl FnMut(&Value) -> Result<Vec<u8>, E>,
) -> Result<Vec<Run>, LoadError<E>> {
    let invalid = || LoadError::InvalidChangeRecord;
    let mut found: Vec<Unfenced> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    let (mut marker, mut fenced, mut first) = (false, false, true);
    for value in pages {
        // The format page is valid only as a document's first page.
        if first && ancestry_format_page(value) {
            fenced = true;
            first = false;
            continue;
        }
        first = false;
        if fenced {
            let Some(items) = value.as_array() else {
                return Err(invalid());
            };
            rows.extend(items.iter().cloned());
            continue;
        }
        // A marker is the document's only page.
        if marker {
            return Err(invalid());
        }
        let is_marker = baseline_marker(value).map_err(|_| LoadError::TypeError)?;
        if is_marker && !found.is_empty() {
            return Err(invalid());
        }
        if is_marker {
            let object = value.as_object().expect("a marker is an object");
            let hash = object.get_str("baseline").expect("a marker has a baseline");
            let bytes = bytes_for(hash).map_err(LoadError::Bytes)?;
            let size = object.get_str("size").and_then(safe_integer);
            if Some(bytes.len() as i64) != size {
                return Err(invalid());
            }
            found.push(Unfenced::Baseline(bytes));
            marker = true;
            continue;
        }
        let Some(items) = value.as_array() else {
            return Err(invalid());
        };
        for item in items {
            let Some(object) = item.as_object() else {
                return Err(LoadError::TypeError);
            };
            match format_one_bytes(object.get_str("bytes")) {
                Some(Ok(text)) => found.push(Unfenced::Row(object, text)),
                Some(Err(())) => found.push(Unfenced::ArrayLike),
                None => return Err(LoadError::TypeError),
            }
        }
    }
    if fenced {
        return decode_mutation_run_rows(&rows).map_err(|error| match error {
            RowError::Invalid => invalid(),
            RowError::Unsupported => LoadError::Unsupported,
        });
    }
    let mut baseline = id.clone();
    baseline.push_str(":baseline");
    let mut runs = Vec::new();
    for item in found {
        match item {
            Unfenced::Baseline(bytes) => runs.extend(initial_mutation_runs(&bytes, &baseline)),
            // `{ ...run, text }`: the stale `bytes` stays on the run.
            Unfenced::Row(object, text) => {
                runs.push(run_from_object(object, text, None).ok_or(LoadError::Unsupported)?)
            }
            Unfenced::ArrayLike => return Err(LoadError::Unsupported),
        }
    }
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::stringify;
    use crate::text::Field;

    fn json(value: &Value) -> String {
        stringify(value).unwrap().unwrap().to_string()
    }

    #[test]
    fn long_runs_continue_in_format_two_and_repeat_in_format_one() {
        let runs = initial_mutation_runs(
            &vec![b'a'; MUTATION_RUN_CHUNK + 1],
            &JsStr::from("d:baseline"),
        );
        let two = encode_mutation_run_rows(&runs);
        assert_eq!(two.len(), 2);
        assert_eq!(json(&two[1]), r#"{"continues":true,"bytes":"YQ=="}"#);
        // A decoded run holds `text` last, as `{ ...metadata, text }` does.
        let decoded = decode_mutation_run_rows(&two).unwrap();
        assert_eq!(
            decoded.iter().map(|run| run.text.len()).collect::<Vec<_>>(),
            [MUTATION_RUN_CHUNK, 1]
        );
        assert_eq!(decoded[0].shape.fields().last(), Some(&Field::Text));
        assert_eq!(
            json(&Value::Array(encode_mutation_run_rows(&decoded))),
            json(&Value::Array(format_two_merged(&two)))
        );
        let one = format_one_rows(&runs);
        assert_eq!(
            json(&one[1]),
            r#"{"id":"d:baseline","start":32768,"owner":null,"deletedBy":[],"replaces":[],"bytes":"YQ=="}"#
        );
        assert_eq!(
            json(&ancestry_format()),
            r#"{"format":"ancestry","version":2}"#
        );
    }

    /// Decoding splits a long run into one run per chunk, which encode as
    /// one row each.
    fn format_two_merged(rows: &[Value]) -> Vec<Value> {
        let mut first = rows[0].as_object().unwrap().clone();
        let second = rows[1]
            .as_object()
            .unwrap()
            .get_str("bytes")
            .unwrap()
            .clone();
        let mut next = first.clone();
        next.set("start", Value::Number(MUTATION_RUN_CHUNK as f64));
        next.set("bytes", second);
        first.set("start", Value::Number(0.0));
        vec![Value::Object(first), Value::Object(next)]
    }

    #[test]
    fn a_continuation_needs_a_run_before_it() {
        let mut row = JsObject::new();
        row.set("continues", Value::Bool(true));
        row.set("bytes", Value::string(""));
        assert_eq!(
            decode_mutation_run_rows(&[Value::Object(row)]),
            Err(RowError::Invalid)
        );
        assert_eq!(
            decode_mutation_run_rows(&[Value::Null]),
            Err(RowError::Invalid)
        );
    }

    #[test]
    fn a_marker_must_be_the_only_page() {
        let hash = JsStr::from("a".repeat(64));
        let marker = marker_value(&hash, 3);
        let read = |_: &Value| Ok::<_, ()>(b"abc".to_vec());
        let runs = load_document(std::slice::from_ref(&marker), &JsStr::from("d"), read).unwrap();
        assert_eq!(
            runs,
            initial_mutation_runs(b"abc", &JsStr::from("d:baseline"))
        );
        assert_eq!(
            load_document(&[marker.clone(), marker], &JsStr::from("d"), read),
            Err(LoadError::InvalidChangeRecord)
        );
        assert_eq!(baseline_marker(&marker_value(&hash, 0)), Ok(false));
    }

    #[test]
    fn field_order_survives_a_decode_and_an_encode() {
        let text = r#"[{"start":0,"id":"x","owner":null,"replaces":[],"deletedBy":[],"extra":1,"bytes":"YWI="}]"#;
        let rows = crate::js::parse(&text.encode_utf16().collect::<Vec<u16>>()).unwrap();
        let runs = decode_mutation_run_rows(rows.as_array().unwrap()).unwrap();
        assert_eq!(runs[0].shape.fields().last(), Some(&Field::Text));
        assert_eq!(json(&Value::Array(encode_mutation_run_rows(&runs))), text);
    }
}
