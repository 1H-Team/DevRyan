//! The ledger's text engine: a port of
//! `packages/harness-runtime/lib/session-mutation-text.js` apart from the
//! diff (`crate::diff`), and of the run-row code around it in
//! `session-mutations.js` (format 1 rows, the baseline marker, the ancestry
//! fence, `runsFor` and the choice `saveRuns` makes).
//!
//! Texts are byte strings: the JavaScript holds them as latin1 strings (one
//! code unit per byte), this holds them as bytes.
//!
//! **The run model.** A JavaScript run is an object
//! `{ id, start, text, owner, deletedBy, replaces }`. Runs decoded from
//! stored rows keep every other property a row carries, in the row's order
//! (format 1 runs keep their stale `bytes`), and the rows they are encoded to
//! again carry them, so `Run` keeps the property order and the other
//! properties (`Shape`). The typed fields cover what the ledger writes:
//! `id` a string, `start` an integer, `owner` `null` or a string,
//! `deletedBy` strings, `replaces` objects exactly `{ id, start, length }`
//! (a string and two integers, in that order). The JavaScript accepts
//! rows outside that model (an `owner` that is a number, a range with an
//! extra property, a format 1 row with no `start`), and then does what its
//! operators do with such values; the decoders here refuse them as
//! `Unsupported` after every check the JavaScript makes has passed, so that
//! a caller can fail closed. Everything inside the model is reproduced
//! exactly, property order included.
//!
//! **Numbers.** A stored number in the model is an integer of magnitude at
//! most 2^62 (`model_integer`); where the JavaScript requires a safe integer
//! (`decodeMutationRunRows`' `start`, `validRange`) so does this. Every such
//! integer is a double, and the JavaScript computes with doubles: past 2^53
//! a sum rounds (2^53 - 1 + 2 is 2^53). Every sum and difference of stored
//! numbers here is therefore `js_add`/`js_sub`, which round as the
//! JavaScript does, so derived starts and range ends are the JavaScript's
//! numbers, and an `i64` holds each exactly.
#![forbid(unsafe_code)]

mod ancestry;
mod apply;
mod rows;

use std::collections::HashSet;
use std::sync::Arc;

use crate::js::{JsObject, JsStr, Key, Value};

pub use ancestry::{
    AncestryError, AncestryPause, Minimized, PauseSite, SlicedPause, minimize_mutation_ancestry,
    minimize_mutation_ancestry_now,
};
pub use apply::{MUTATION_DIFF_WORK_BUDGET, MUTATION_HUNK_WORK_BUDGET, apply_mutation_text};
pub use rows::{
    ANCESTRY_COMPACTED, BASELINE_COMPACTED, BASELINE_PAGE, LoadError, MUTATION_RUN_CHUNK,
    MarkerTypeError, RowError, SavePlan, ancestry_format, ancestry_format_page, baseline_marker,
    baseline_text, decode_mutation_run_rows, encode_mutation_run_rows, format_one_rows,
    load_document, marker_value, save_plan,
};

/// A range of an older run's text that a replacement run replaced:
/// `{ id, start, length }`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Range {
    pub id: JsStr,
    pub start: i64,
    pub length: i64,
}

impl Range {
    /// The range as the object `{ id, start, length }`.
    pub fn to_value(&self) -> Value {
        let mut object = JsObject::new();
        object.set("id", Value::String(self.id.clone()));
        object.set("start", Value::Number(self.start as f64));
        object.set("length", Value::Number(self.length as f64));
        Value::Object(object)
    }

    /// `inRange(run, range)`: the run belongs to the range's id and starts
    /// inside it.
    pub fn holds(&self, run: &Run) -> bool {
        run.id == self.id && run.start >= self.start && run.start < self.end()
    }

    /// `range.start + range.length`.
    pub fn end(&self) -> i64 {
        js_add(self.start, self.length)
    }
}

/// A run's own property, in the order the run object holds them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Id,
    Start,
    Text,
    Owner,
    DeletedBy,
    Replaces,
    /// The other property at this index of `Shape::extras`.
    Extra(usize),
}

const CANONICAL: [Field; 6] = [
    Field::Id,
    Field::Start,
    Field::Text,
    Field::Owner,
    Field::DeletedBy,
    Field::Replaces,
];

/// A run's property order and its other properties. The default is the
/// order `initialMutationRuns` and `applyMutationText` create:
/// `id, start, text, owner, deletedBy, replaces`, and nothing else.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shape(Option<Arc<ShapeData>>);

#[derive(Debug, PartialEq)]
struct ShapeData {
    fields: Vec<Field>,
    extras: Vec<(JsStr, Value)>,
}

impl Shape {
    /// The fields in property order.
    pub fn fields(&self) -> &[Field] {
        match &self.0 {
            Some(data) => &data.fields,
            None => &CANONICAL,
        }
    }

    /// The other properties, by `Field::Extra` index.
    pub fn extras(&self) -> &[(JsStr, Value)] {
        match &self.0 {
            Some(data) => &data.extras,
            None => &[],
        }
    }

    fn new(fields: Vec<Field>, extras: Vec<(JsStr, Value)>) -> Self {
        if extras.is_empty() && fields == CANONICAL {
            Shape(None)
        } else {
            Shape(Some(Arc::new(ShapeData { fields, extras })))
        }
    }

    /// The index of the other property named `name`.
    fn extra(&self, name: &str) -> Option<usize> {
        self.extras().iter().position(|(key, _)| *key == name)
    }
}

/// One run of a document's text.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub id: JsStr,
    pub start: i64,
    pub text: Vec<u8>,
    /// `null` for baseline text, else the operation that inserted the run.
    pub owner: Option<JsStr>,
    pub deleted_by: Vec<JsStr>,
    /// Shared between the pieces of a split run, as in the JavaScript.
    pub replaces: Arc<[Range]>,
    pub shape: Shape,
}

impl Run {
    /// A run in the canonical shape.
    pub fn new(id: JsStr, start: i64, text: Vec<u8>, owner: Option<JsStr>) -> Self {
        Run {
            id,
            start,
            text,
            owner,
            deleted_by: Vec::new(),
            replaces: Arc::from(Vec::new()),
            shape: Shape::default(),
        }
    }

    /// `run.start + run.text.length`.
    fn end(&self) -> i64 {
        js_add(self.start, self.text.len() as i64)
    }

    /// The run as an object, its properties in the run's order; `text`
    /// gives the value of the `text` property, or `None` to leave it out.
    pub fn to_object(&self, text: impl FnOnce(&[u8]) -> Option<Value>) -> JsObject {
        let mut text = Some(text);
        let mut object = JsObject::new();
        let extras = self.shape.extras();
        for field in self.shape.fields() {
            let (key, value) = match *field {
                Field::Id => (JsStr::from("id"), Value::String(self.id.clone())),
                Field::Start => (JsStr::from("start"), Value::Number(self.start as f64)),
                Field::Text => match text.take().and_then(|text| text(&self.text)) {
                    Some(value) => (JsStr::from("text"), value),
                    None => continue,
                },
                Field::Owner => (
                    JsStr::from("owner"),
                    self.owner.clone().map_or(Value::Null, Value::String),
                ),
                Field::DeletedBy => (
                    JsStr::from("deletedBy"),
                    Value::Array(self.deleted_by.iter().cloned().map(Value::String).collect()),
                ),
                Field::Replaces => (
                    JsStr::from("replaces"),
                    Value::Array(self.replaces.iter().map(Range::to_value).collect()),
                ),
                Field::Extra(index) => (extras[index].0.clone(), extras[index].1.clone()),
            };
            object.insert(key, value);
        }
        object
    }
}

/// `enabled(id, inactive)`: baseline text (`null`) or an active operation.
fn enabled(id: Option<&JsStr>, inactive: &HashSet<JsStr>) -> bool {
    id.is_none_or(|id| !inactive.contains(id))
}

/// `visibleMutationRuns(runs, inactive)`: runs whose owner is enabled and
/// that no enabled operation deleted.
pub fn visible_mutation_runs<'a>(runs: &'a [Run], inactive: &HashSet<JsStr>) -> Vec<&'a Run> {
    runs.iter()
        .filter(|run| {
            enabled(run.owner.as_ref(), inactive)
                && !run.deleted_by.iter().any(|id| enabled(Some(id), inactive))
        })
        .collect()
}

/// `mutationText(runs, inactive)`: the text of the visible runs.
pub fn mutation_text(runs: &[Run], inactive: &HashSet<JsStr>) -> Vec<u8> {
    visible_mutation_runs(runs, inactive)
        .into_iter()
        .flat_map(|run| run.text.iter().copied())
        .collect()
}

/// `initialMutationRuns(text, id)`: one baseline run, or none for no text.
pub fn initial_mutation_runs(text: &[u8], id: &JsStr) -> Vec<Run> {
    if text.is_empty() {
        return Vec::new();
    }
    vec![Run::new(id.clone(), 0, text.to_vec(), None)]
}

/// `Number.isSafeInteger(value)`.
pub(crate) fn safe_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number)
            if number.is_finite()
                && number.fract() == 0.0
                && number.abs() <= 9_007_199_254_740_991.0 =>
        {
            Some(*number as i64)
        }
        _ => None,
    }
}

/// The largest magnitude of a stored number the model holds, 2^62: far
/// enough below `i64::MAX` that adding a text length never leaves it.
const MODEL_LIMIT: f64 = 4_611_686_018_427_387_904.0;

/// A stored number inside the model: an integer (`-0` as 0) of magnitude at
/// most 2^62. Each is exactly a double, so the JavaScript's arithmetic on it
/// is `js_add`/`js_sub`.
pub(crate) fn model_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number)
            if number.is_finite() && number.fract() == 0.0 && number.abs() <= MODEL_LIMIT =>
        {
            Some(*number as i64)
        }
        _ => None,
    }
}

/// `a + b` as JavaScript adds numbers: in doubles, rounded to the nearest,
/// ties to even. `a` and `b` are integers a double holds exactly (stored
/// numbers of the model, results of this and `js_sub`, text lengths), and
/// so is the result, which stays far inside `i64`.
pub(crate) fn js_add(a: i64, b: i64) -> i64 {
    (a as f64 + b as f64) as i64
}

/// `a - b` as JavaScript subtracts numbers (see `js_add`).
pub(crate) fn js_sub(a: i64, b: i64) -> i64 {
    (a as f64 - b as f64) as i64
}

/// A range in the model: exactly `{ id, start, length }`, a string and two
/// integers (`model_integer`).
fn range_from(value: &Value) -> Option<Range> {
    let object = value.as_object()?;
    let mut entries = object.entries();
    let mut field = |name: &str| match entries.next() {
        Some((Key::Named(key), value)) if *key == name => Some(value),
        _ => None,
    };
    let id = match field("id")? {
        Value::String(id) => id.clone(),
        _ => return None,
    };
    let start = model_integer(field("start")?)?;
    let length = model_integer(field("length")?)?;
    entries
        .next()
        .is_none()
        .then_some(Range { id, start, length })
}

/// A run built from a JavaScript run object (`{ ...row, text }`): `text`
/// takes the position of an existing `text` property or goes last, and
/// `skip` names a property the object loses (`bytes` for format 2 rows).
/// `None` when the object is outside the model.
fn run_from_object(object: &JsObject, text: Vec<u8>, skip: Option<&str>) -> Option<Run> {
    let mut fields = Vec::new();
    let mut extras = Vec::new();
    let (mut id, mut start, mut owner, mut deleted_by, mut replaces) =
        (None, None, None, None, None);
    let mut has_text = false;
    for (key, value) in object.entries() {
        let name = match key {
            Key::Named(name) => name.clone(),
            Key::Index(index) => JsStr::from(index.to_string()),
        };
        if skip.is_some_and(|skip| name == skip) {
            continue;
        }
        let field = if name == "id" {
            let Value::String(text) = value else {
                return None;
            };
            id = Some(text.clone());
            Field::Id
        } else if name == "start" {
            start = Some(model_integer(value)?);
            Field::Start
        } else if name == "text" {
            has_text = true;
            Field::Text
        } else if name == "owner" {
            owner = Some(match value {
                Value::Null => None,
                Value::String(text) => Some(text.clone()),
                _ => return None,
            });
            Field::Owner
        } else if name == "deletedBy" {
            let mut ids = Vec::new();
            for item in value.as_array()? {
                let Value::String(text) = item else {
                    return None;
                };
                ids.push(text.clone());
            }
            deleted_by = Some(ids);
            Field::DeletedBy
        } else if name == "replaces" {
            let ranges: Option<Vec<Range>> = value.as_array()?.iter().map(range_from).collect();
            replaces = Some(Arc::from(ranges?));
            Field::Replaces
        } else {
            extras.push((name, value.clone()));
            Field::Extra(extras.len() - 1)
        };
        fields.push(field);
    }
    if !has_text {
        fields.push(Field::Text);
    }
    Some(Run {
        id: id?,
        start: start?,
        text,
        owner: owner?,
        deleted_by: deleted_by?,
        replaces: replaces?,
        shape: Shape::new(fields, extras),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_runs_reappear_when_their_deleter_is_inactive() {
        let mut runs = initial_mutation_runs(b"abc", &JsStr::from("d:baseline"));
        runs[0].deleted_by.push(JsStr::from("op1"));
        let mut inserted = Run::new(
            JsStr::from("op1:0"),
            0,
            b"X".to_vec(),
            Some(JsStr::from("op1")),
        );
        inserted.replaces = Arc::from(vec![Range {
            id: JsStr::from("d:baseline"),
            start: 0,
            length: 3,
        }]);
        runs.push(inserted);
        assert_eq!(mutation_text(&runs, &HashSet::new()), b"X");
        assert_eq!(
            mutation_text(&runs, &HashSet::from([JsStr::from("op1")])),
            b"abc"
        );
        assert!(initial_mutation_runs(b"", &JsStr::from("d")).is_empty());
    }
}
