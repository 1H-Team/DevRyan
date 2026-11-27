//! `packages/ui/src/sync/sanitize.ts` (family `sanitize`).

use crate::js::{Elements, Js, Kind, Obj, Props, Proto, Value, delete, get, get_opt, s, spread, truthy, type_of};
use crate::plant;

pub const EXPORTS: &[&str] = &["stripMessageDiffSnapshots", "stripSessionDiffSnapshots"];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    match export {
        "stripSessionDiffSnapshots" | "stripMessageDiffSnapshots" => Some(strip_diff_summary(&super::arg(args, 0))),
        _ => None,
    }
}

const DIFF_CONTENT_FIELDS: [&str; 5] = ["patch", "before", "after", "from", "to"];

fn fields() -> &'static [&'static str] {
    if plant::on("sanitize-patch-kept") {
        &DIFF_CONTENT_FIELDS[1..]
    } else {
        &DIFF_CONTENT_FIELDS
    }
}

/// `stripDiffSummary`: patch bodies dropped from `summary.diffs`, the original
/// returned when nothing needed stripping.
pub fn strip_diff_summary(target: &Value) -> Js {
    let summary = get(target, "summary", "target.summary")?;
    let diffs = get_opt(&summary, "diffs");
    let Some(list) = diffs.as_object().filter(|object| truthy(&diffs) && object.is_array()) else {
        return Ok(target.clone());
    };
    let mut changed = false;
    // `summary.diffs.map(...)`: a hole stays a hole.
    let entries: Elements = match &list.borrow().kind {
        Kind::Array { elements, .. } => elements.clone(),
        _ => Elements::default(),
    };
    // `map` visits the members present and keeps the length: a hole stays a hole, whatever the length.
    let mut stripped = Elements::default();
    stripped.push_holes(u64::from(entries.len()));
    if plant::on("sanitize-holes-filled") {
        for index in 0..entries.len().min(crate::js::ITERATION_LIMIT) {
            stripped.set(index, Value::Undefined);
        }
    }
    for (index, entry) in entries.present() {
        let entry = entry.clone();
        if !truthy(&entry) {
            stripped.set(
                index,
                if plant::on("sanitize-falsy-entry-object") {
                    Value::Object(Obj::object())
                } else {
                    entry
                },
            );
            continue;
        }
        let mut next = entry.clone();
        for field in fields() {
            let present = if plant::on("sanitize-non-string-stripped") {
                entry.as_object().is_some_and(|object| object.borrow().props.has(&s(field)))
            } else {
                type_of(&get_opt(&entry, field)) == "string"
                    && !(plant::on("rv-sz-empty-string-kept") && get_opt(&entry, field).as_str().is_some_and(|text| text.is_empty()))
            };
            if !present {
                continue;
            }
            if !plant::on("sanitize-strip-in-place") && matches!((&next, &entry), (Value::Object(a), Value::Object(b)) if a.same(b)) {
                next = Value::Object(spread(&entry));
            }
            if let Value::Object(object) = &next {
                delete(object, &s(field));
            }
            changed = true;
            if plant::on("sanitize-first-field-only") {
                break;
            }
        }
        stripped.set(index, next);
    }
    if !changed && !plant::on("sanitize-always-copies") {
        return Ok(target.clone());
    }
    let diffs = Obj::new(
        Kind::Array {
            elements: stripped,
            class: None,
        },
        Props::default(),
    );
    let summary_copy = spread(&summary);
    summary_copy.borrow_mut().props.set(s("diffs"), Value::Object(diffs));
    let outer = if plant::on("sanitize-summary-shared") {
        if let Value::Object(object) = &summary {
            object
                .borrow_mut()
                .props
                .set(s("diffs"), summary_copy.borrow().props.get(&s("diffs")).cloned().unwrap_or(Value::Undefined));
        }
        summary.clone()
    } else {
        Value::Object(summary_copy)
    };
    let result = spread(target);
    if plant::on("sanitize-summary-key-last") {
        result.borrow_mut().props.remove(&s("summary"));
    }
    result.borrow_mut().props.set(s("summary"), outer);
    if plant::on("sanitize-result-prototype-less") {
        let mut data = result.borrow_mut();
        data.kind = Kind::Object(Proto::Null);
    }
    Ok(Value::Object(result))
}
