//! `result-envelope.js`: the result envelope's validators, its constructor and
//! its match with its task.

use devryan_js_layer::js::{JsObject, Value};

use crate::contract::{
    MANAGED_TASK_OWNER, MAX_MANAGED_TASK_FAILURE_BYTES, MAX_MANAGED_TASK_PREVIEW_BYTES, is_terminal_managed_task_status, validate_managed_task_record,
};
use crate::error::{JsResult, plain_error, range_error, type_error};
use crate::jsv::{
    NULL, as_number, as_str, get, is_finite, is_one_of, is_record, is_safe_integer, is_str, nullish_or, spread, strict_equal, stringify, to_string, truthy,
};
use crate::primitives::{AUTO_RESUME_REASONS, AUTO_RESUME_RESET_SOURCES, AUTO_RESUME_STATES, find_managed_result_payload_mismatch};
use crate::regex::pattern;
use crate::text::{concat, starts_with, trim, units, utf8_len};

const ACTIONS: [&str; 7] = ["collect", "continue", "resume", "retry", "recover_in_place", "retry_in_place", "abandon"];
const TARGET_KINDS: [&str; 2] = ["backup", "original"];
const TRIGGERS: [&str; 2] = ["provider_usage_limit", "provider_transport"];
const RUN_CLEANUP_STATES: [&str; 3] = ["pending", "failed", "done"];

pattern!(acknowledgement_identity, r"^[a-f0-9]{64}$", false);

fn non_negative_finite(value: &Value) -> bool {
    is_finite(value) && as_number(value).is_some_and(|number| number >= 0.0)
}

fn assert_timestamp(value: &Value, field: &str) -> JsResult<()> {
    if non_negative_finite(value) {
        Ok(())
    } else {
        type_error(format!("{field} must be a non-negative finite timestamp"))
    }
}

fn assert_nullable_timestamp(value: &Value, field: &str) -> JsResult<()> {
    if matches!(value, Value::Null) || non_negative_finite(value) {
        Ok(())
    } else {
        type_error(format!("{field} must be a non-negative finite timestamp or null"))
    }
}

fn assert_count(value: &Value, field: &str) -> JsResult<()> {
    if is_safe_integer(value) && as_number(value).is_some_and(|count| count >= 0.0) {
        Ok(())
    } else {
        type_error(format!("{field} must be a non-negative safe integer"))
    }
}

fn assert_enum(value: &Value, field: &str, allowed: &[&str]) -> JsResult<()> {
    if is_one_of(value, allowed) {
        Ok(())
    } else {
        type_error(format!("{field} must be one of {}", allowed.join(", ")))
    }
}

fn assert_nullable_enum(value: &Value, field: &str, allowed: &[&str]) -> JsResult<()> {
    if matches!(value, Value::Null) {
        Ok(())
    } else {
        assert_enum(value, field, allowed)
    }
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
        Ok(())
    } else {
        assert_string(value, field, prefix, false, max_bytes)
    }
}

/// `validateManagedTaskAutoResume(value)`: the normalized copy, or `null`.
pub fn validate_managed_task_auto_resume(value: &Value) -> JsResult<Value> {
    if matches!(value, Value::Null | Value::Undefined) {
        return Ok(Value::Null);
    }
    if !is_record(value) {
        return type_error("autoResume must be an object or null");
    }
    let field = |name: &str| get(value, name);
    let revision = field("revision");
    if !is_safe_integer(revision) || as_number(revision).is_some_and(|revision| revision < 1.0) {
        return type_error("autoResume.revision must be a positive safe integer");
    }
    if !matches!(field("enabled"), Value::Bool(_)) {
        return type_error("autoResume.enabled must be a boolean");
    }
    assert_enum(field("state"), "autoResume.state", &AUTO_RESUME_STATES)?;
    if !matches!(field("trigger"), Value::Undefined) {
        assert_enum(field("trigger"), "autoResume.trigger", &TRIGGERS)?;
    }
    assert_count(field("cancelGeneration"), "autoResume.cancelGeneration")?;
    assert_timestamp(field("lineageStartedAt"), "autoResume.lineageStartedAt")?;
    assert_timestamp(field("expiresAt"), "autoResume.expiresAt")?;
    let zero = Value::Number(0.0);
    let attempt_count = nullish_or(field("attemptCount"), &zero);
    let no_signal_probes = nullish_or(field("noSignalProbes"), &zero);
    let rejections = nullish_or(field("rejectionsInWindow"), &zero);
    let host_failures = nullish_or(field("hostFailures"), &zero);
    assert_count(attempt_count, "autoResume.attemptCount")?;
    assert_count(no_signal_probes, "autoResume.noSignalProbes")?;
    assert_count(rejections, "autoResume.rejectionsInWindow")?;
    assert_count(host_failures, "autoResume.hostFailures")?;
    let window_reset_at = nullish_or(field("windowResetAt"), &NULL);
    let next_attempt_at = nullish_or(field("nextAttemptAt"), &NULL);
    let reset_at = nullish_or(field("resetAt"), &NULL);
    let last_attempt_at = nullish_or(field("lastAttemptAt"), &NULL);
    assert_nullable_timestamp(window_reset_at, "autoResume.windowResetAt")?;
    assert_nullable_timestamp(next_attempt_at, "autoResume.nextAttemptAt")?;
    assert_nullable_timestamp(reset_at, "autoResume.resetAt")?;
    assert_nullable_timestamp(last_attempt_at, "autoResume.lastAttemptAt")?;
    let reset_source = nullish_or(field("resetSource"), &NULL);
    assert_nullable_enum(reset_source, "autoResume.resetSource", &AUTO_RESUME_RESET_SOURCES)?;
    let reason = nullish_or(field("reason"), &NULL);
    assert_nullable_enum(reason, "autoResume.reason", &AUTO_RESUME_REASONS)?;
    let last_attempt_task_id = nullish_or(field("lastAttemptTaskId"), &NULL);
    assert_nullable_string(last_attempt_task_id, "autoResume.lastAttemptTaskId", Some("dvr_task_"), None)?;
    let recovery_cycle_task_id = nullish_or(field("recoveryCycleTaskId"), &NULL);
    let backup_attempt_task_id = nullish_or(field("backupAttemptTaskId"), &NULL);
    assert_nullable_string(recovery_cycle_task_id, "autoResume.recoveryCycleTaskId", Some("dvr_task_"), None)?;
    assert_nullable_string(backup_attempt_task_id, "autoResume.backupAttemptTaskId", Some("dvr_task_"), None)?;

    let mut target = Value::Null;
    let raw_target = field("target");
    if !matches!(raw_target, Value::Null | Value::Undefined) {
        if !is_record(raw_target) {
            return type_error("autoResume.target must be an object or null");
        }
        assert_enum(get(raw_target, "kind"), "autoResume.target.kind", &TARGET_KINDS)?;
        assert_string(get(raw_target, "providerId"), "autoResume.target.providerId", None, false, None)?;
        assert_string(get(raw_target, "modelId"), "autoResume.target.modelId", None, false, None)?;
        let variant = nullish_or(get(raw_target, "variant"), &NULL);
        assert_nullable_string(variant, "autoResume.target.variant", None, None)?;
        let mut copy = JsObject::new();
        copy.set("kind", get(raw_target, "kind").clone());
        copy.set("providerId", get(raw_target, "providerId").clone());
        copy.set("modelId", get(raw_target, "modelId").clone());
        copy.set("variant", variant.clone());
        target = Value::Object(copy);
    }

    let mut last_error = Value::Null;
    let raw_error = field("lastError");
    if !matches!(raw_error, Value::Null | Value::Undefined) {
        if !is_record(raw_error) {
            return type_error("autoResume.lastError must be an object or null");
        }
        assert_string(get(raw_error, "code"), "autoResume.lastError.code", None, false, None)?;
        assert_string(get(raw_error, "message"), "autoResume.lastError.message", None, true, None)?;
        assert_timestamp(get(raw_error, "at"), "autoResume.lastError.at")?;
        let mut copy = JsObject::new();
        copy.set("code", get(raw_error, "code").clone());
        copy.set("message", get(raw_error, "message").clone());
        copy.set("at", get(raw_error, "at").clone());
        last_error = Value::Object(copy);
    }

    let mut out = JsObject::new();
    out.set("revision", revision.clone());
    if !matches!(field("trigger"), Value::Undefined) {
        out.set("trigger", field("trigger").clone());
    }
    out.set("enabled", field("enabled").clone());
    out.set("state", field("state").clone());
    out.set("cancelGeneration", field("cancelGeneration").clone());
    out.set("lineageStartedAt", field("lineageStartedAt").clone());
    out.set("expiresAt", field("expiresAt").clone());
    out.set("attemptCount", attempt_count.clone());
    out.set("noSignalProbes", no_signal_probes.clone());
    out.set("rejectionsInWindow", rejections.clone());
    out.set("windowResetAt", window_reset_at.clone());
    out.set("nextAttemptAt", next_attempt_at.clone());
    out.set("resetAt", reset_at.clone());
    out.set("resetSource", reset_source.clone());
    out.set("target", target);
    out.set("recoveryCycleTaskId", recovery_cycle_task_id.clone());
    out.set("backupAttemptTaskId", backup_attempt_task_id.clone());
    out.set("lastAttemptTaskId", last_attempt_task_id.clone());
    out.set("lastAttemptAt", last_attempt_at.clone());
    out.set("lastError", last_error);
    out.set("hostFailures", host_failures.clone());
    out.set("reason", reason.clone());
    Ok(Value::Object(out))
}

fn validate_managed_task_run_cleanup(envelope: &Value, value: &Value) -> JsResult<()> {
    if !is_record(value) {
        return type_error("result runCleanup must be an object");
    }
    assert_enum(get(value, "state"), "runCleanup.state", &RUN_CLEANUP_STATES)?;
    let child = get(value, "childSessionId");
    if !strict_equal(get(value, "taskId"), get(envelope, "taskId"))?
        || !matches!(child, Value::String(_))
        || !strict_equal(child, get(envelope, "childSessionId"))?
    {
        return type_error("result runCleanup must bind its task and child session");
    }
    assert_string(get(value, "leaseToken"), "runCleanup.leaseToken", None, false, None)?;
    assert_count(get(value, "attempts"), "runCleanup.attempts")?;
    if !matches!(get(value, "stopped"), Value::Undefined) {
        assert_count(get(value, "stopped"), "runCleanup.stopped")?;
    }
    if !matches!(get(value, "code"), Value::Undefined) {
        assert_string(get(value, "code"), "runCleanup.code", None, false, None)?;
    }
    if is_str(get(value, "state"), "failed") != !matches!(get(value, "code"), Value::Undefined) {
        return type_error("result runCleanup.code must be present exactly when it failed");
    }
    Ok(())
}

/// `validateManagedTaskResultEnvelope(envelope)` (the JavaScript returns it).
pub fn validate_managed_task_result_envelope(envelope: &Value) -> JsResult<()> {
    if !is_record(envelope) {
        return type_error("result envelope must be an object");
    }
    let field = |name: &str| get(envelope, name);
    if !is_str(field("owner"), MANAGED_TASK_OWNER) {
        return type_error("result owner must be devryan");
    }
    assert_string(field("envelopeId"), "envelopeId", Some("dvr_result_"), false, None)?;
    assert_string(field("taskId"), "taskId", Some("dvr_task_"), false, None)?;
    assert_string(field("rootSessionId"), "rootSessionId", None, false, None)?;
    assert_nullable_string(field("parentTaskId"), "parentTaskId", Some("dvr_task_"), None)?;
    assert_nullable_string(field("childSessionId"), "childSessionId", None, None)?;
    assert_string(field("directory"), "directory", None, false, None)?;
    if !is_safe_integer(field("sequence")) || as_number(field("sequence")).is_some_and(|sequence| sequence < 1.0) {
        return type_error("result sequence must be a positive safe integer");
    }
    if !is_terminal_managed_task_status(field("status")) {
        return type_error("result status must be terminal");
    }
    if !matches!(field("partial"), Value::Bool(_)) {
        return type_error("result partial must be a boolean");
    }
    assert_nullable_string(field("failureReason"), "failureReason", None, Some(MAX_MANAGED_TASK_FAILURE_BYTES))?;
    if !is_safe_integer(field("attempt")) || as_number(field("attempt")).is_some_and(|attempt| attempt < 1.0) {
        return type_error("result attempt must be a positive integer");
    }
    assert_nullable_string(field("priorTaskId"), "priorTaskId", Some("dvr_task_"), None)?;
    if !is_one_of(field("executionKind"), &["start", "retry", "resume", "recover_in_place", "retry_in_place"]) {
        return type_error("result executionKind is invalid");
    }
    assert_string(
        field("recoverablePreview"),
        "recoverablePreview",
        None,
        true,
        Some(MAX_MANAGED_TASK_PREVIEW_BYTES),
    )?;
    if !matches!(field("canonicalRefs"), Value::Array(_)) {
        return type_error("result canonicalRefs must be an array");
    }
    if !matches!(field("resumable"), Value::Bool(_)) {
        return type_error("result resumable must be a boolean");
    }
    if !non_negative_finite(field("createdAt")) {
        return type_error("result createdAt must be a non-negative finite timestamp");
    }
    if !matches!(field("acknowledgedAt"), Value::Null) && !non_negative_finite(field("acknowledgedAt")) {
        return type_error("result acknowledgedAt must be a non-negative finite timestamp or null");
    }
    if !matches!(field("action"), Value::Null) && !is_one_of(field("action"), &ACTIONS) {
        return type_error("result action is invalid");
    }
    let identity = field("acknowledgementIdentity");
    if !matches!(identity, Value::Undefined)
        && (as_str(identity).is_none_or(|identity| !acknowledgement_identity().test(identity.units())) || matches!(field("action"), Value::Null))
    {
        return type_error("result acknowledgementIdentity is invalid");
    }
    assert_nullable_string(field("followUpTaskId"), "followUpTaskId", Some("dvr_task_"), None)?;
    if !matches!(field("providerResetAt"), Value::Undefined) {
        assert_nullable_timestamp(field("providerResetAt"), "result providerResetAt")?;
    }
    let observed = field("promptObserved");
    if !matches!(observed, Value::Undefined) {
        let attempt = get(observed, "attempt");
        let sequence = get(observed, "sequence");
        if !is_record(observed)
            || !is_safe_integer(attempt)
            || !strict_equal(attempt, field("attempt"))?
            || !is_safe_integer(sequence)
            || as_number(sequence).is_some_and(|sequence| sequence < 1.0)
            || as_number(sequence)
                .zip(as_number(field("sequence")))
                .is_some_and(|(observed, sequence)| observed > sequence)
        {
            return type_error("result promptObserved must bind its exact terminal attempt and sequence");
        }
        assert_timestamp(get(observed, "observedAt"), "result promptObserved.observedAt")?;
    }
    if !matches!(field("autoResume"), Value::Undefined) {
        validate_managed_task_auto_resume(field("autoResume"))?;
    }
    if !matches!(field("runCleanup"), Value::Undefined) {
        validate_managed_task_run_cleanup(envelope, field("runCleanup"))?;
    }
    stringify(envelope)?;
    Ok(())
}

/// `createManagedTaskResultEnvelope(task, options)`.
pub fn create_managed_task_result_envelope(task: &Value, options: &Value) -> JsResult<Value> {
    validate_managed_task_record(task)?;
    if !is_terminal_managed_task_status(get(task, "status")) {
        return plain_error("result envelopes require a terminal task");
    }
    let sequence = get(options, "sequence");
    let task_id = as_str(get(task, "taskId")).expect("a validated task ID");
    let suffix = &task_id.units()["dvr_task_".len()..];
    let envelope_id = concat(&[&units("dvr_result_"), suffix, &units("_"), to_string(sequence)?.units()]);
    let copy = |name: &str| get(task, name).clone();
    let references: Vec<Value> = get(task, "canonicalRefs")
        .as_array()
        .unwrap_or_default()
        .iter()
        .map(|reference| Value::Object(spread(reference)))
        .collect();
    let provider_reset_at = get(options, "providerResetAt");
    let mut envelope = JsObject::new();
    envelope.set("owner", Value::string(MANAGED_TASK_OWNER));
    envelope.set("envelopeId", Value::String(envelope_id));
    for name in ["taskId", "rootSessionId", "parentTaskId", "childSessionId", "directory"] {
        envelope.set(name, copy(name));
    }
    envelope.set("sequence", sequence.clone());
    for name in [
        "status",
        "partial",
        "failureReason",
        "attempt",
        "priorTaskId",
        "executionKind",
        "recoverablePreview",
    ] {
        envelope.set(name, copy(name));
    }
    envelope.set("canonicalRefs", Value::Array(references));
    envelope.set(
        "resumable",
        Value::Bool(truthy(get(options, "resumable")) && truthy(get(task, "childSessionId"))),
    );
    envelope.set("createdAt", get(options, "createdAt").clone());
    envelope.set("acknowledgedAt", Value::Null);
    envelope.set("action", Value::Null);
    envelope.set("followUpTaskId", Value::Null);
    envelope.set(
        "providerResetAt",
        if non_negative_finite(provider_reset_at) {
            provider_reset_at.clone()
        } else {
            Value::Null
        },
    );
    envelope.set("autoResume", Value::Null);
    let envelope = Value::Object(envelope);
    validate_managed_task_result_envelope(&envelope)?;
    Ok(envelope)
}

/// `assertManagedTaskResultEnvelopeMatchesTask(task, envelope)`.
pub fn assert_managed_task_result_envelope_matches_task(task: &Value, envelope: &Value) -> JsResult<()> {
    validate_managed_task_record(task)?;
    validate_managed_task_result_envelope(envelope)?;
    let task_id = as_str(get(task, "taskId")).expect("a validated task ID");
    match find_managed_result_payload_mismatch(task, envelope, false)? {
        None => Ok(()),
        Some("canonicalRefs") => type_error(concat(&[&units("result envelope canonicalRefs do not match task "), task_id.units()])),
        Some(field) => type_error(concat(&[&units(&format!("result envelope {field} does not match task ")), task_id.units()])),
    }
}
