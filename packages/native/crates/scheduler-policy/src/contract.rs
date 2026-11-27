//! `contract.js`: the task record's validator and constructor, text
//! truncation, the stop and recovery predicates, and the task events.

use devryan_js_layer::js::{JsObject, JsStr, Value};

use crate::checks::{validate_check_correction_history, validate_required_check_receipts, validate_required_checks};
use crate::error::{JsResult, range_error, type_error, unsupported};
use crate::jsv::{
    NULL, as_number, as_str, get, is_finite, is_one_of, is_record, is_safe_integer, is_str, keys, nullish_or, object, read, spread, strict_equal, truthy,
};
use crate::leaves::{
    validate_approved_plan_ref, validate_managed_execution_backend, validate_managed_native_job_segments, validate_managed_transport_recovery,
    validate_primary_step_budget, validate_task_prerequisites,
};
use crate::primitives::{MANAGED_TASK_ID_PREFIX, MANAGED_TASK_STATUSES, MANAGED_TASK_TERMINAL_STATUSES, MANAGED_WAVE_ID_PREFIX};
use crate::retry::{
    MODEL_UNAVAILABLE_FAILURE_KIND, PROVIDER_USAGE_LIMIT_FAILURE_KIND, classify_managed_task_failure, is_definite_provider_usage_limit,
    is_managed_task_capability_failure, is_managed_task_model_unavailable, is_provider_authentication_failure, is_provider_configuration_failure,
    is_provider_prompt_rejected,
};
use crate::text::{concat, starts_with, trim, units, utf8_len};

pub const MANAGED_TASK_OWNER: &str = "devryan";
pub const MAX_MANAGED_TASK_LABEL_BYTES: u64 = 512;
pub const MAX_MANAGED_TASK_PROMPT_BYTES: u64 = 256 * 1024;
pub const MAX_MANAGED_TASK_PREVIEW_BYTES: u64 = 64 * 1024;
pub const MAX_MANAGED_TASK_FAILURE_BYTES: u64 = 16 * 1024;
pub const MANAGED_TASK_WAITING_REASON_KINDS: [&str; 3] = ["capacity", "system_pressure", "prerequisites"];
const WAITING_REASON_FIELDS: [&str; 4] = ["kind", "activeCount", "limit", "since"];
const EXECUTION_KINDS: [&str; 5] = ["start", "retry", "resume", "recover_in_place", "retry_in_place"];

/// `truncateManagedText(value, maxBytes)`: the longest prefix of `value`, cut
/// at a code point, whose UTF-8 form fits (as the JavaScript computes it, a
/// lone surrogate ends the prefix before it, and a leading U+FEFF empties a
/// cut text, since `TextDecoder` strips a byte order mark).
pub fn truncate_managed_text(value: &Value, max_bytes: &Value) -> JsResult<JsStr> {
    let Value::String(text) = value else {
        return Ok(JsStr::new());
    };
    if !is_safe_integer(max_bytes) || as_number(max_bytes).is_some_and(|max| max < 0.0) {
        return range_error("maxBytes must be a non-negative safe integer");
    }
    let max = as_number(max_bytes).expect("a safe integer") as u64;
    let encoded = text.to_utf8();
    if encoded.len() as u64 <= max {
        return Ok(text.clone());
    }
    let mut cut = &encoded[..max as usize];
    if cut.starts_with(&[0xef, 0xbb, 0xbf]) {
        cut = &cut[3..];
    }
    let decoded = JsStr::from_utf8_lossy(cut);
    let decoded = decoded.units();
    let original = text.units();
    let common = decoded.iter().zip(original).take_while(|(a, b)| a == b).count();
    // The JavaScript drops one code point at a time until the prefix is a
    // prefix of the value and fits; both conditions hold for every shorter
    // prefix once they hold, so this takes the longest prefix that passes.
    let (mut end, mut bytes, mut best) = (0usize, 0u64, 0usize);
    while end < decoded.len() {
        let width = if (0xd800..=0xdbff).contains(&decoded[end]) { 2 } else { 1 };
        let next = end + width;
        bytes += utf8_len(&decoded[end..next]);
        if next > common || bytes > max {
            break;
        }
        end = next;
        best = end;
    }
    Ok(JsStr::from_units(decoded[..best].to_vec()))
}

fn assert_string(value: &Value, field: &str, prefix: Option<&str>, allow_empty: bool, max_bytes: Option<u64>) -> JsResult<()> {
    let text = match value {
        Value::String(text) if allow_empty || !trim(text.units()).is_empty() => text,
        _ => return type_error(format!("{field} is required")),
    };
    if let Some(prefix) = prefix
        && !starts_with(text.units(), prefix)
    {
        return type_error(format!("{field} must start with {prefix}"));
    }
    if let Some(max) = max_bytes
        && utf8_len(text.units()) > max
    {
        return range_error(format!("{field} exceeds {max} UTF-8 bytes"));
    }
    Ok(())
}

fn assert_nullable_string(value: &Value, field: &str, prefix: Option<&str>, max_bytes: Option<u64>) -> JsResult<()> {
    if matches!(value, Value::Null) {
        return Ok(());
    }
    assert_string(value, field, prefix, false, max_bytes)
}

fn non_negative_finite(value: &Value) -> bool {
    is_finite(value) && as_number(value).is_some_and(|number| number >= 0.0)
}

fn assert_nullable_timestamp(value: &Value, field: &str) -> JsResult<()> {
    if matches!(value, Value::Null) || non_negative_finite(value) {
        return Ok(());
    }
    type_error(format!("{field} must be a non-negative finite timestamp or null"))
}

fn assert_nullable_waiting_reason(value: &Value, field: &str) -> JsResult<()> {
    if matches!(value, Value::Null) {
        return Ok(());
    }
    if !is_record(value) {
        return type_error(format!("{field} must be an object or null"));
    }
    for key in keys(value) {
        if !WAITING_REASON_FIELDS.iter().any(|known| key == *known) {
            return type_error(concat(&[&units(field), &units("."), key.units(), &units(" is not a waiting reason field")]));
        }
    }
    let kind = get(value, "kind");
    if !is_one_of(kind, &MANAGED_TASK_WAITING_REASON_KINDS) {
        return type_error(format!("{field}.kind must be capacity or system_pressure or prerequisites"));
    }
    let active = get(value, "activeCount");
    if !is_safe_integer(active) || as_number(active).is_some_and(|count| count < 0.0) {
        return type_error(format!("{field}.activeCount must be a non-negative integer"));
    }
    let limit = get(value, "limit");
    if is_str(kind, "system_pressure") || is_str(kind, "prerequisites") {
        if !matches!(limit, Value::Null) {
            let kind = as_str(kind).expect("a checked kind").to_string_lossy();
            return type_error(format!("{field}.limit must be null for {kind}"));
        }
    } else if !matches!(limit, Value::Null) && (!is_safe_integer(limit) || as_number(limit).is_some_and(|limit| limit < 1.0)) {
        return type_error(format!("{field}.limit must be a positive integer or null"));
    }
    if !non_negative_finite(get(value, "since")) {
        return type_error(format!("{field}.since must be a non-negative finite timestamp"));
    }
    Ok(())
}

/// The deepest value `assertJsonCompatible` walks here; V8 recurses further.
const JSON_COMPATIBLE_DEPTH: usize = 512;

/// `assertJsonCompatible(value, path)`.
pub fn assert_json_compatible(value: &Value, path: &str) -> JsResult<()> {
    json_compatible(value, &mut units(path), 0)
}

fn json_compatible(value: &Value, path: &mut Vec<u16>, depth: usize) -> JsResult<()> {
    if depth > JSON_COMPATIBLE_DEPTH {
        return unsupported("assertJsonCompatible nesting deeper than its bound");
    }
    match value {
        Value::Null | Value::String(_) | Value::Bool(_) => Ok(()),
        Value::Number(number) if number.is_finite() => Ok(()),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let length = path.len();
                path.extend(format!("[{index}]").encode_utf16());
                json_compatible(item, path, depth + 1)?;
                path.truncate(length);
            }
            Ok(())
        }
        Value::Object(object) => {
            for (key, item) in object.iter() {
                let length = path.len();
                path.push(u16::from(b'.'));
                path.extend_from_slice(key.units());
                if matches!(item, Value::Undefined) {
                    return type_error(concat(&[path, &units(" must be JSON-compatible")]));
                }
                json_compatible(item, path, depth + 1)?;
                path.truncate(length);
            }
            Ok(())
        }
        _ => type_error(concat(&[path, &units(" must be JSON-compatible")])),
    }
}

/// `isTerminalManagedTaskStatus(status)`.
pub fn is_terminal_managed_task_status(status: &Value) -> bool {
    is_one_of(status, &MANAGED_TASK_TERMINAL_STATUSES)
}

/// `validateManagedTaskRecord(task)` (the JavaScript returns `task`).
pub fn validate_managed_task_record(task: &Value) -> JsResult<()> {
    if !is_record(task) {
        return type_error("task must be an object");
    }
    let field = |name: &str| get(task, name);
    if !is_str(field("owner"), MANAGED_TASK_OWNER) {
        return type_error("owner must be devryan");
    }
    assert_string(field("taskId"), "taskId", Some(MANAGED_TASK_ID_PREFIX), false, None)?;
    assert_string(field("idempotencyKey"), "idempotencyKey", None, false, Some(1024))?;
    assert_string(field("rootSessionId"), "rootSessionId", None, false, None)?;
    assert_nullable_string(field("dispatchGroupId"), "dispatchGroupId", None, Some(1024))?;
    assert_nullable_string(field("dispatchCallId"), "dispatchCallId", None, Some(1024))?;
    assert_nullable_string(field("dispatchWaveId"), "dispatchWaveId", Some(MANAGED_WAVE_ID_PREFIX), Some(1024))?;
    assert_nullable_string(field("parentTaskId"), "parentTaskId", Some(MANAGED_TASK_ID_PREFIX), None)?;
    assert_nullable_string(field("childSessionId"), "childSessionId", None, None)?;
    assert_string(field("directory"), "directory", None, false, None)?;
    if !is_safe_integer(field("sequence")) || as_number(field("sequence")).is_some_and(|sequence| sequence < 1.0) {
        return type_error("sequence must be a positive safe integer");
    }
    if !is_one_of(field("mode"), &["builder", "orchestrator"]) {
        return type_error("mode must be builder or orchestrator");
    }
    if !matches!(field("readOnly"), Value::Bool(_)) {
        return type_error("readOnly must be a boolean");
    }
    assert_string(field("providerId"), "providerId", None, false, None)?;
    assert_string(field("modelId"), "modelId", None, false, None)?;
    assert_string(field("agent"), "agent", None, false, None)?;
    assert_nullable_string(field("variant"), "variant", None, None)?;
    assert_string(field("label"), "label", None, false, Some(MAX_MANAGED_TASK_LABEL_BYTES))?;
    assert_string(field("prompt"), "prompt", None, false, Some(MAX_MANAGED_TASK_PROMPT_BYTES))?;
    if !is_safe_integer(field("attempt")) || as_number(field("attempt")).is_some_and(|attempt| attempt < 1.0) {
        return type_error("attempt must be a positive integer");
    }
    assert_nullable_string(field("priorTaskId"), "priorTaskId", Some(MANAGED_TASK_ID_PREFIX), None)?;
    if !is_one_of(field("executionKind"), &EXECUTION_KINDS) {
        return type_error("executionKind must be start, retry, resume, recover_in_place, or retry_in_place");
    }
    if !is_one_of(field("status"), &MANAGED_TASK_STATUSES) {
        return type_error(format!("status must be one of {}", MANAGED_TASK_STATUSES.join(", ")));
    }
    assert_nullable_string(field("leaseToken"), "leaseToken", Some("dvr_lease_"), None)?;
    let intent = field("terminationIntent");
    if !matches!(intent, Value::Undefined | Value::Null) && !is_str(intent, "user_stopped") {
        return type_error("invalid termination intent");
    }
    let stop = field("operatorStop");
    if !matches!(stop, Value::Undefined | Value::Null)
        && (!is_record(stop)
            || !non_negative_finite(get(stop, "requestedAt"))
            || !matches!(get(stop, "requestId"), Value::String(_))
            || (!matches!(get(stop, "state"), Value::Undefined) && !is_one_of(get(stop, "state"), &["pending", "accepted", "uncertain"]))
            || !strict_equal(get(stop, "leaseToken"), field("leaseToken"))?)
    {
        return type_error("invalid operator stop");
    }
    assert_nullable_string(field("failureReason"), "failureReason", None, Some(MAX_MANAGED_TASK_FAILURE_BYTES))?;
    if !matches!(field("partial"), Value::Bool(_)) {
        return type_error("partial must be a boolean");
    }
    assert_string(
        field("recoverablePreview"),
        "recoverablePreview",
        None,
        true,
        Some(MAX_MANAGED_TASK_PREVIEW_BYTES),
    )?;
    if !matches!(field("canonicalRefs"), Value::Array(_)) {
        return type_error("canonicalRefs must be an array");
    }
    if !non_negative_finite(field("createdAt")) {
        return type_error("createdAt must be a non-negative finite timestamp");
    }
    assert_nullable_timestamp(field("startedAt"), "startedAt")?;
    assert_nullable_timestamp(field("finishedAt"), "finishedAt")?;
    assert_nullable_timestamp(field("timeoutAt"), "timeoutAt")?;
    assert_nullable_string(field("recoveryLineageId"), "recoveryLineageId", Some("dvr_lineage_"), None)?;
    assert_nullable_timestamp(field("childPromptedAt"), "childPromptedAt")?;
    assert_nullable_timestamp(field("firstAssistantPartAt"), "firstAssistantPartAt")?;
    assert_nullable_waiting_reason(field("waitingReason"), "waitingReason")?;
    validate_managed_transport_recovery(field("transportRecovery"))?;
    validate_managed_execution_backend(field("executionBackend"))?;
    validate_managed_native_job_segments(field("nativeJobSegments"), field("executionBackend"))?;
    if !is_str(field("status"), "queued") && !matches!(field("waitingReason"), Value::Null) {
        return type_error("waitingReason must be null unless the task is queued");
    }
    let plan = field("approvedPlanRef");
    validate_approved_plan_ref(plan)?;
    if truthy(plan) && as_str(get(plan, "rootSessionId")) != as_str(field("rootSessionId")) {
        return type_error("Approved plan root mismatch");
    }
    validate_task_prerequisites(field("taskPrerequisites"))?;
    validate_required_checks(field("requiredChecks"))?;
    validate_required_check_receipts(field("requiredCheckReceipts"), field("requiredChecks"))?;
    validate_check_correction_history(field("requiredCheckCorrections"))?;
    validate_primary_step_budget(field("primaryStepBudget"))?;
    assert_nullable_string(nullish_or(field("dispatchObjectiveId"), &NULL), "dispatchObjectiveId", None, None)?;
    assert_json_compatible(task, "task")
}

/// `createManagedTaskRecord(input)`.
pub fn create_managed_task_record(input: &Value) -> JsResult<Value> {
    if !is_record(input) {
        return type_error("task input must be an object");
    }
    let or_null = |name: &str| nullish_or(get(input, name), &NULL).clone();
    let mut task = spread(input);
    task.set("owner", Value::string(MANAGED_TASK_OWNER));
    task.set("status", Value::string("queued"));
    task.set("dispatchGroupId", or_null("dispatchGroupId"));
    task.set("dispatchCallId", or_null("dispatchCallId"));
    task.set("dispatchWaveId", or_null("dispatchWaveId"));
    task.set("readOnly", nullish_or(get(input, "readOnly"), &Value::Bool(false)).clone());
    task.set("childSessionId", or_null("childSessionId"));
    task.set("recoveryLineageId", or_null("recoveryLineageId"));
    task.set("leaseToken", Value::Null);
    task.set("startedAt", Value::Null);
    task.set("finishedAt", Value::Null);
    task.set("childPromptedAt", Value::Null);
    task.set("firstAssistantPartAt", Value::Null);
    task.set("waitingReason", Value::Null);
    task.set("transportRecovery", or_null("transportRecovery"));
    task.set("failureReason", Value::Null);
    task.set("partial", Value::Bool(false));
    task.set("recoverablePreview", Value::string(""));
    task.set("canonicalRefs", Value::Array(Vec::new()));
    let task = Value::Object(task);
    validate_managed_task_record(&task)?;
    Ok(task)
}

/// `hasAcceptedUserStop(task)`.
pub fn has_accepted_user_stop(task: &Value) -> bool {
    is_str(get(task, "terminationIntent"), "user_stopped") || is_str(get(get(task, "operatorStop"), "state"), "accepted")
}

/// `hasPendingOperatorStop(task)`.
pub fn has_pending_operator_stop(task: &Value) -> bool {
    let stop = get(task, "operatorStop");
    truthy(stop) && (matches!(get(stop, "state"), Value::Undefined) || is_str(get(stop, "state"), "pending"))
}

fn resolve_agent_retry_available(task: &Value, failure_kind: Option<&str>) -> bool {
    let reason = get(task, "failureReason");
    is_str(get(task, "mode"), "orchestrator")
        && !matches!(get(task, "dispatchGroupId"), Value::Null)
        && !has_accepted_user_stop(task)
        && !truthy(get(task, "operatorStop"))
        && as_number(get(task, "attempt")).is_some_and(|attempt| attempt < 2.0)
        && failure_kind != Some(PROVIDER_USAGE_LIMIT_FAILURE_KIND)
        && failure_kind != Some(MODEL_UNAVAILABLE_FAILURE_KIND)
        && !is_provider_authentication_failure(reason)
        && !is_provider_configuration_failure(reason)
        && !is_managed_task_capability_failure(reason)
        && !truthy(get(task, "transportRecovery"))
}

/// `isManagedTaskAgentRetryAvailable(task)`.
pub fn is_managed_task_agent_retry_available(task: &Value) -> JsResult<bool> {
    validate_managed_task_record(task)?;
    Ok(resolve_agent_retry_available(task, classify_managed_task_failure(get(task, "failureReason"))?))
}

/// `isStoppedRecoveryAvailable(task, envelope)`.
pub fn is_stopped_recovery_available(task: &Value, envelope: &Value) -> JsResult<bool> {
    if has_pending_operator_stop(task) {
        return Ok(false);
    }
    let status = read(task, "status")?;
    let stopped = is_str(status, "aborted")
        || ((has_accepted_user_stop(task) || is_str(get(get(task, "operatorStop"), "state"), "uncertain")) && is_one_of(status, &["failed", "interrupted"]));
    Ok(stopped && truthy(get(task, "childSessionId")) && truthy(get(envelope, "resumable")) && matches!(get(envelope, "action"), Value::Null))
}

/// `isUserStoppedRecoveryAvailable(task, envelope)`.
pub fn is_user_stopped_recovery_available(task: &Value, envelope: &Value) -> JsResult<bool> {
    Ok(has_accepted_user_stop(task) && is_stopped_recovery_available(task, envelope)?)
}

/// `requiresManualModelRecovery(task, resultEnvelope)`.
pub fn requires_manual_model_recovery(task: &Value, envelope: &Value) -> JsResult<bool> {
    if !truthy(read(task, "childSessionId")?) || is_managed_task_agent_retry_available(task)? {
        return Ok(false);
    }
    let reason = get(task, "failureReason");
    Ok(is_one_of(get(task, "status"), &["failed", "interrupted"])
        && truthy(get(envelope, "resumable"))
        && !is_provider_prompt_rejected(reason)
        && (is_definite_provider_usage_limit(reason)
            || is_managed_task_model_unavailable(reason)
            || is_provider_authentication_failure(reason)
            || is_provider_configuration_failure(reason)
            || truthy(get(task, "transportRecovery"))
            || (is_str(get(task, "mode"), "orchestrator")
                && !matches!(get(task, "dispatchGroupId"), Value::Null)
                && as_number(get(task, "attempt")).is_some_and(|attempt| attempt >= 2.0))))
}

fn kind_value(kind: Option<&str>) -> Value {
    kind.map_or(Value::Null, Value::string)
}

fn project_task_for_event(task: &Value, envelope: &Value) -> JsResult<Value> {
    let failure_kind = classify_managed_task_failure(get(task, "failureReason"))?;
    let copy = |name: &str| get(task, name).clone();
    let mut out = JsObject::new();
    for name in ["owner", "taskId", "rootSessionId", "dispatchCallId"] {
        out.set(name, copy(name));
    }
    out.set("dispatchGrouped", Value::Bool(!matches!(get(task, "dispatchGroupId"), Value::Null)));
    for name in ["requiredChecks", "taskPrerequisites"] {
        if get(task, name).as_array().is_some_and(|items| !items.is_empty()) {
            out.set(name, copy(name));
        }
    }
    for name in [
        "dispatchWaveId",
        "parentTaskId",
        "childSessionId",
        "directory",
        "sequence",
        "mode",
        "providerId",
        "modelId",
        "agent",
        "variant",
        "label",
        "status",
        "attempt",
        "priorTaskId",
        "executionKind",
        "createdAt",
        "startedAt",
        "finishedAt",
        "timeoutAt",
        "recoveryLineageId",
        "childPromptedAt",
        "firstAssistantPartAt",
    ] {
        out.set(name, copy(name));
    }
    for name in ["waitingReason", "transportRecovery"] {
        let value = get(task, name);
        out.set(name, if truthy(value) { Value::Object(spread(value)) } else { Value::Null });
    }
    if has_accepted_user_stop(task) {
        out.set("terminationIntent", Value::string("user_stopped"));
        out.set("userStoppedRecoveryAvailable", Value::Bool(is_user_stopped_recovery_available(task, envelope)?));
    }
    if is_stopped_recovery_available(task, envelope)? {
        out.set("stoppedRecoveryAvailable", Value::Bool(true));
    }
    out.set("failureReason", copy("failureReason"));
    out.set("failureKind", kind_value(failure_kind));
    for name in ["partial", "recoverablePreview", "canonicalRefs"] {
        out.set(name, copy(name));
    }
    out.set("agentRetryAvailable", Value::Bool(resolve_agent_retry_available(task, failure_kind)));
    if truthy(envelope) {
        let required = !has_pending_operator_stop(task) && matches!(get(envelope, "action"), Value::Null) && requires_manual_model_recovery(task, envelope)?;
        out.set("manualRecoveryRequired", Value::Bool(required));
    }
    Ok(Value::Object(out))
}

/// `toManagedTaskEvent(task, resultEnvelope = null)` (`undefined` is the default).
pub fn to_managed_task_event(task: &Value, result_envelope: &Value) -> JsResult<Value> {
    let envelope = if matches!(result_envelope, Value::Undefined) {
        &NULL
    } else {
        result_envelope
    };
    validate_managed_task_record(task)?;
    if !matches!(envelope, Value::Null) {
        if !is_record(envelope) || !is_str(get(envelope, "owner"), MANAGED_TASK_OWNER) || !strict_equal(get(envelope, "taskId"), get(task, "taskId"))? {
            return type_error("resultEnvelope must belong to the managed task");
        }
        assert_json_compatible(envelope, "resultEnvelope")?;
    }
    let mut properties = JsObject::new();
    properties.set("owner", Value::string(MANAGED_TASK_OWNER));
    properties.set("directory", get(task, "directory").clone());
    properties.set("task", project_task_for_event(task, envelope)?);
    if truthy(envelope) {
        properties.set("resultEnvelope", envelope.clone());
    }
    Ok(object(vec![
        ("type", Value::string("devryan:managed-task")),
        ("properties", Value::Object(properties)),
    ]))
}

/// `toManagedTaskRemovalEvent(task)`.
pub fn to_managed_task_removal_event(task: &Value) -> JsResult<Value> {
    validate_managed_task_record(task)?;
    let properties = object(vec![
        ("owner", Value::string(MANAGED_TASK_OWNER)),
        ("taskId", get(task, "taskId").clone()),
        ("rootSessionId", get(task, "rootSessionId").clone()),
        ("directory", get(task, "directory").clone()),
        ("sequence", get(task, "sequence").clone()),
    ]);
    Ok(object(vec![
        ("type", Value::string("devryan:managed-task-removed")),
        ("properties", properties),
    ]))
}
