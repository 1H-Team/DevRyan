//! `codec-primitives.js` (constants, `isManagedTaskId`,
//! `findManagedResultPayloadMismatch`, `isAutoResumeActiveState`) and the
//! pure exports of `scheduler.js` (`compareManagedTaskQueueOrder`,
//! `DUPLICATE_DISPATCH_WINDOW_MS`), with the identifier shapes the scheduler
//! creates and the `localeCompare` order of task IDs.

use std::cmp::Ordering;

use devryan_js_layer::js::{JsStr, Value};

use crate::error::{JsResult, type_error, unsupported};
use crate::jsv::{as_str, get, has_own, is_nullish, json_equal, read, same_value, to_number, truthy};
use crate::regex::pattern;

pub const MANAGED_TASK_ID_PREFIX: &str = "dvr_task_";
pub const MANAGED_WAVE_ID_PREFIX: &str = "dvr_wave_";
pub const MANAGED_LEASE_ID_PREFIX: &str = "dvr_lease_";
pub const MANAGED_TASK_STATUSES: [&str; 7] = ["queued", "starting", "running", "completed", "failed", "aborted", "interrupted"];
pub const MANAGED_TASK_LIVE_STATUSES: [&str; 3] = ["queued", "starting", "running"];
pub const MANAGED_TASK_TERMINAL_STATUSES: [&str; 4] = ["completed", "failed", "aborted", "interrupted"];
pub const MANAGED_TASK_FAILURE_KINDS: [&str; 8] = [
    "provider_configuration",
    "runtime_capability",
    "provider_transport",
    "provider_usage_limit",
    "provider_authentication",
    "provider_prompt_rejected",
    "model_unavailable",
    "deadline_exceeded",
];
pub const AUTO_RESUME_STATES: [&str; 9] = [
    "planning",
    "scheduled",
    "attempting",
    "superseded",
    "succeeded",
    "ended",
    "cancelled",
    "exhausted",
    "acknowledged",
];
pub const AUTO_RESUME_ACTIVE_STATES: [&str; 3] = ["planning", "scheduled", "attempting"];
pub const AUTO_RESUME_RESET_SOURCES: [&str; 3] = ["opencode_status", "meridian_quota", "backoff"];
pub const AUTO_RESUME_REASONS: [&str; 9] = [
    "user",
    "manual_retry",
    "session_deleted",
    "cancelled",
    "attempt_cap",
    "time_cap",
    "host_failures",
    "window_rejections",
    "backup_unavailable",
];
pub const MANAGED_RESULT_PAYLOAD_FIELDS: [&str; 12] = [
    "taskId",
    "rootSessionId",
    "parentTaskId",
    "childSessionId",
    "directory",
    "status",
    "partial",
    "failureReason",
    "attempt",
    "priorTaskId",
    "executionKind",
    "recoverablePreview",
];
pub const MANAGED_RESULT_COMPACTED_FIELDS: [&str; 3] = ["failureReason", "recoverablePreview", "canonicalRefs"];

/// `scheduler.js` `DUPLICATE_DISPATCH_WINDOW_MS`.
pub const DUPLICATE_DISPATCH_WINDOW_MS: f64 = 10.0 * 60.0 * 1_000.0;

pattern!(managed_task_id, r"^dvr_task_[A-Za-z0-9_-]+$", false);

/// `isManagedTaskId(value)`.
pub fn is_managed_task_id(value: &Value) -> bool {
    as_str(value).is_some_and(|text| managed_task_id().test(text.units()))
}

/// `isAutoResumeActiveState(state)`.
pub fn is_auto_resume_active_state(state: &Value) -> bool {
    as_str(state).is_some_and(|state| AUTO_RESUME_ACTIVE_STATES.iter().any(|active| state == *active))
}

/// `Object.hasOwn(value, key)`, which throws for `null` and `undefined`.
fn has_own_or_throw(value: &Value, key: &str) -> JsResult<bool> {
    if is_nullish(value) {
        return type_error("Cannot convert undefined or null to object");
    }
    Ok(has_own(value, key))
}

/// `findManagedResultPayloadMismatch(task, envelope, { requireOwnFields })`.
pub fn find_managed_result_payload_mismatch(task: &Value, envelope: &Value, require_own_fields: bool) -> JsResult<Option<&'static str>> {
    for field in MANAGED_RESULT_PAYLOAD_FIELDS {
        if require_own_fields && (!has_own_or_throw(task, field)? || !has_own_or_throw(envelope, field)?) {
            return Ok(Some(field));
        }
        if !same_value(read(task, field)?, read(envelope, field)?)? {
            return Ok(Some(field));
        }
    }
    let task_refs = get(task, "canonicalRefs");
    let envelope_refs = get(envelope, "canonicalRefs");
    if require_own_fields && (task_refs.as_array().is_none() || envelope_refs.as_array().is_none()) {
        return Ok(Some("canonicalRefs"));
    }
    Ok(if json_equal(task_refs, envelope_refs)? { None } else { Some("canonicalRefs") })
}

/// The primary weight of a task-ID unit under `localeCompare` (ICU's root
/// collation, punctuation not ignorable): `_` below the digits, the digits
/// below the letters. `None` outside `[_0-9a-z]`.
fn collation_weight(unit: u16) -> Option<u16> {
    match unit {
        0x5f => Some(0),
        0x30..=0x39 => Some(unit - 0x30 + 1),
        0x61..=0x7a => Some(unit - 0x61 + 11),
        _ => None,
    }
}

/// `left.localeCompare(right)` for two strings over `[_0-9a-z]` (every task
/// ID the scheduler creates: `dvr_task_` and 32 lowercase hex digits). This is
/// not code-unit order: `_` sorts before the digits (`dvr_task_1` <
/// `dvr_task01`). Any other unit is refused.
pub fn locale_compare_ids(left: &JsStr, right: &JsStr) -> JsResult<f64> {
    let weights = |text: &JsStr| text.units().iter().map(|unit| collation_weight(*unit)).collect::<Option<Vec<u16>>>();
    let (Some(left), Some(right)) = (weights(left), weights(right)) else {
        return unsupported("localeCompare outside the task-ID alphabet [_0-9a-z]");
    };
    Ok(match left.cmp(&right) {
        Ordering::Less => -1.0,
        Ordering::Equal => 0.0,
        Ordering::Greater => 1.0,
    })
}

/// `a - b` for two record fields.
fn difference(left: &Value, right: &Value) -> JsResult<f64> {
    Ok(to_number(left)? - to_number(right)?)
}

/// `left.taskId.localeCompare(right.taskId)`.
pub fn compare_task_ids(left: &Value, right: &Value) -> JsResult<f64> {
    match (read(left, "taskId")?, read(right, "taskId")?) {
        (Value::String(left), Value::String(right)) => locale_compare_ids(left, right),
        _ => unsupported("localeCompare of a task ID that is not a string"),
    }
}

/// `compareManagedTaskQueueOrder(left, right)`: the comparator's number.
pub fn compare_managed_task_queue_order(left: &Value, right: &Value) -> JsResult<f64> {
    let sequence = difference(read(left, "sequence")?, read(right, "sequence")?)?;
    if truthy(&Value::Number(sequence)) {
        return Ok(sequence);
    }
    let created = difference(read(left, "createdAt")?, read(right, "createdAt")?)?;
    if truthy(&Value::Number(created)) {
        return Ok(created);
    }
    compare_task_ids(left, right)
}

/// The text of `scheduler.js` `createRandomId`, which is not exported: an ID
/// is its prefix and `crypto.randomUUID()` without dashes (32 lowercase hex
/// digits, version 4). The vectors pin this text against the JavaScript.
pub const SCHEDULER_RANDOM_ID_SOURCE: &str = "const createRandomId = (prefix) => {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}${random.replaceAll('-', '')}`;
};";

/// Whether `value` has the shape `createRandomId(prefix)` gives where
/// `crypto.randomUUID` exists: the prefix, then a version-4 UUID's 32
/// lowercase hex digits (`xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx`, y in 8-b).
pub fn is_scheduler_random_id(prefix: &str, value: &JsStr) -> bool {
    let prefix: Vec<u16> = prefix.encode_utf16().collect();
    let Some(rest) = value.units().strip_prefix(prefix.as_slice()) else {
        return false;
    };
    rest.len() == 32
        && rest.iter().all(|unit| matches!(unit, 0x30..=0x39 | 0x61..=0x66))
        && rest[12] == u16::from(b'4')
        && matches!(rest[16], 0x38 | 0x39 | 0x61 | 0x62)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collation_puts_underscore_before_digits() {
        let compare = |a: &str, b: &str| locale_compare_ids(&JsStr::from(a), &JsStr::from(b)).unwrap();
        assert_eq!(compare("dvr_task_1", "dvr_task01"), -1.0);
        assert_eq!(compare("a_", "a_1"), -1.0);
        assert_eq!(compare("ab", "a0"), 1.0);
        assert!(locale_compare_ids(&JsStr::from("A"), &JsStr::from("a")).is_err());
    }

    #[test]
    fn scheduler_id_shape() {
        assert!(is_scheduler_random_id("dvr_task_", &JsStr::from("dvr_task_0123456789ab4def8123456789abcdef")));
        assert!(!is_scheduler_random_id("dvr_task_", &JsStr::from("dvr_task_0123456789ab5def8123456789abcdef")));
        assert!(!is_scheduler_random_id("dvr_task_", &JsStr::from("dvr_task_0123456789ab4defc123456789abcdef")));
        assert!(!is_scheduler_random_id("dvr_lease_", &JsStr::from("dvr_task_0123456789ab4def8123456789abcdef")));
    }
}
