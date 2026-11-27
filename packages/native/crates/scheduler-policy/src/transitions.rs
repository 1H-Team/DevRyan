//! `transitions.js`: which status changes are allowed and what a transition
//! may change.
//!
//! The JavaScript compares record fields with `Object.is`, so an object or
//! array field is unchanged only when `next` holds the very same object (the
//! scheduler builds `next` as `{ ...previous, ... }`). A `Value` has no
//! identity, so the caller says which fields share their object: `same(key)`
//! is consulted only when `previous[key]` and `next[key]` are both objects or
//! both arrays (or one of each).

use devryan_js_layer::js::{JsStr, Value};

use crate::checks::is_check_correction_transition;
use crate::contract::{is_terminal_managed_task_status, validate_managed_task_record};
use crate::error::{JsResult, plain_error, type_error, unsupported};
use crate::jsv::{UNDEFINED, as_number, as_str, get, is_finite, is_one_of, is_str, json_equal, keys, read, same_value, strict_equal, to_string, truthy};
use crate::leaves::is_managed_native_job_receipt_transition;
use crate::text::{concat, units};

/// Whether `previous[key]` and `next[key]` are the same object.
pub type SameReference<'a> = &'a dyn Fn(&JsStr) -> bool;

const ALLOWED_TRANSITIONS: [(&str, &[&str]); 7] = [
    ("queued", &["starting", "aborted"]),
    ("starting", &["running", "failed", "aborted", "interrupted"]),
    ("running", &["completed", "failed", "aborted", "interrupted"]),
    ("completed", &[]),
    ("failed", &[]),
    ("aborted", &[]),
    ("interrupted", &[]),
];

/// `Object.getOwnPropertyNames(Object.prototype)`: the keys an object literal
/// inherits, whose values have no `has` method.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

const IMMUTABLE_FIELDS: [&str; 27] = [
    "owner",
    "taskId",
    "idempotencyKey",
    "rootSessionId",
    "dispatchGroupId",
    "dispatchObjectiveId",
    "dispatchCallId",
    "dispatchWaveId",
    "parentTaskId",
    "directory",
    "sequence",
    "mode",
    "readOnly",
    "providerId",
    "modelId",
    "agent",
    "variant",
    "label",
    "prompt",
    "approvedPlanRef",
    "taskPrerequisites",
    "attempt",
    "priorTaskId",
    "executionKind",
    "executionBackend",
    "createdAt",
    "recoveryLineageId",
];

/// `canTransitionManagedTaskStatus(from, to)`.
pub fn can_transition_managed_task_status(from: &Value, to: &Value) -> JsResult<bool> {
    if strict_equal(from, to)? {
        return Ok(true);
    }
    let key = to_string(from)?;
    if let Some((_, allowed)) = ALLOWED_TRANSITIONS.iter().find(|(status, _)| key == *status) {
        return Ok(is_one_of(to, allowed));
    }
    if OBJECT_PROTOTYPE_KEYS.iter().any(|name| key == *name) {
        return type_error("ALLOWED_TRANSITIONS[from]?.has is not a function");
    }
    Ok(false)
}

fn is_container(value: &Value) -> bool {
    matches!(value, Value::Array(_) | Value::Object(_))
}

/// `Object.is(previous[key], next[key])`, with the caller's identity for objects.
fn unchanged(previous: &Value, next: &Value, key: &JsStr, same: SameReference<'_>) -> JsResult<bool> {
    let before = previous.as_object().and_then(|object| object.get(key)).unwrap_or(&UNDEFINED);
    let after = next.as_object().and_then(|object| object.get(key)).unwrap_or(&UNDEFINED);
    if is_container(before) && is_container(after) {
        return Ok(same(key));
    }
    same_value(before, after)
}

fn terminal_record_changed(previous: &Value, next: &Value, same: SameReference<'_>) -> JsResult<bool> {
    let correction = is_check_correction_transition(previous, next)?;
    let mut all = keys(previous);
    for key in keys(next) {
        if !all.contains(&key) {
            all.push(key);
        }
    }
    for key in all {
        if key == "nativeJobSegments" && is_managed_native_job_receipt_transition(previous, next)? {
            continue;
        }
        if key == "operatorStop" || key == "requiredCheckReceipts" {
            continue;
        }
        if correction && (key == "requiredChecks" || key == "requiredCheckCorrections") {
            continue;
        }
        if !unchanged(previous, next, &key, same)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `assertManagedTaskTransition(previous, next)` (the JavaScript returns `next`).
pub fn assert_managed_task_transition(previous: &Value, next: &Value, same: SameReference<'_>) -> JsResult<()> {
    validate_managed_task_record(previous)?;
    let next_checks = read(next, "requiredChecks")?;
    if !matches!(next, Value::Object(_)) {
        return unsupported("a transition to a value that is not an object");
    }
    let definitions_changed = !json_equal(get(previous, "requiredChecks"), next_checks)?
        || !json_equal(get(previous, "requiredCheckCorrections"), get(next, "requiredCheckCorrections"))?;
    if definitions_changed && !is_check_correction_transition(previous, next)? {
        return plain_error("Required check definitions are immutable outside an audited runner correction");
    }
    let task_id = as_str(get(previous, "taskId")).expect("a validated task ID");
    if is_terminal_managed_task_status(get(previous, "status")) && terminal_record_changed(previous, next, same)? {
        return plain_error(concat(&[&units("terminal task "), task_id.units(), &units(" is immutable")]));
    }
    for field in IMMUTABLE_FIELDS {
        if !unchanged(previous, next, &JsStr::from(field), same)? {
            return plain_error(format!("{field} is immutable"));
        }
    }
    let (before, after) = (get(previous, "timeoutAt"), get(next, "timeoutAt"));
    if !strict_equal(before, after)? {
        let extends = is_str(get(previous, "status"), "running")
            && is_str(get(next, "status"), "running")
            && !truthy(get(previous, "readOnly"))
            && is_one_of(get(previous, "agent"), &["fixer", "designer"])
            && is_finite(before)
            && is_finite(after)
            && as_number(after)
                .zip(as_number(before))
                .is_some_and(|(after, before)| after > before && after - before <= 15.0 * 60_000.0);
        if !extends {
            return plain_error("timeoutAt may only advance for a running implementation task");
        }
    }
    if !is_str(get(next, "status"), "queued") && !matches!(get(next, "waitingReason"), Value::Null) {
        return plain_error("waitingReason must be null unless the task is queued");
    }
    validate_managed_task_record(next)?;
    if !can_transition_managed_task_status(get(previous, "status"), get(next, "status"))? {
        let from = as_str(get(previous, "status")).expect("a validated status");
        let to = as_str(get(next, "status")).expect("a validated status");
        return plain_error(concat(&[&units("invalid managed task transition: "), from.units(), &units(" -> "), to.units()]));
    }
    Ok(())
}
