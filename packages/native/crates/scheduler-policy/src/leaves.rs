//! The record validators' other leaves: `task-prerequisites.js`,
//! `approved-plan.js` `validateApprovedPlanRef`, `designer-step-budget.js`
//! `validatePrimaryStepBudget`, `native-job-segments.js` and
//! `transport-recovery.js` (validation and the backup predicate).

use std::collections::HashSet;

use devryan_js_layer::js::Value;

use crate::checks::validate_required_checks;
use crate::error::{JsResult, range_error, type_error};
use crate::jsv::{
    EMPTY_ARRAY, as_number, as_str, get, is_finite, is_nullish, is_one_of, is_record, is_safe_integer, is_str, json_byte_length, keys, object, read, spread,
    strict_equal, to_number,
};
use crate::regex::pattern;
use crate::retry::{PROVIDER_TRANSPORT_FAILURE_KINDS, classify_provider_transport_failure, is_provider_configuration_failure};
use crate::text::{concat, split_slashes, trim, units, utf8_len};

pattern!(prerequisite_task_id, r"^dvr_task_[a-zA-Z0-9_-]{1,247}$", false);
pattern!(content_hash, r"^[a-f0-9]{64}$", false);
pattern!(plan_digest, r"^[a-f0-9]{64}$", false);
pattern!(plan_absolute_path, r"^(?:[\\/]|[a-zA-Z]:)", false);
pattern!(step_identifier, r"^[A-Za-z0-9_:-]{1,256}$", false);
pattern!(segment_identifier, r"^[A-Za-z0-9_-]{1,256}$", false);

fn matches_str(value: &Value, regex: &crate::regex::Regex) -> bool {
    as_str(value).is_some_and(|text| regex.test(text.units()))
}

/// `validateTaskPrerequisites(value = [])`.
pub fn validate_task_prerequisites(value: &Value) -> JsResult<()> {
    let value = if matches!(value, Value::Undefined) { &EMPTY_ARRAY } else { value };
    let Some(references) = value.as_array().filter(|items| items.len() <= 8) else {
        return type_error("Invalid task prerequisites");
    };
    let mut seen: HashSet<Vec<u16>> = HashSet::new();
    for reference in references {
        let mut names = keys(reference);
        names.sort();
        let joined = names.iter().map(|key| key.units().to_vec()).collect::<Vec<_>>().join(&u16::from(b','));
        let check_name = get(reference, "checkName");
        if !is_record(reference)
            || joined != units("checkName,contentHash,paths,taskId")
            || !matches_str(get(reference, "taskId"), prerequisite_task_id())
            || as_str(check_name).is_none_or(|name| trim(name.units()).is_empty() || name.len() > 128)
            || !matches_str(get(reference, "contentHash"), content_hash())
        {
            return type_error("Invalid task prerequisite reference");
        }
        validate_required_checks(&Value::Array(vec![object(vec![
            ("name", check_name.clone()),
            ("command", Value::string("interface")),
            ("paths", get(reference, "paths").clone()),
        ])]))?;
        let key = concat(&[
            as_str(get(reference, "taskId")).expect("a checked id").units(),
            &[0],
            as_str(check_name).expect("a checked name").units(),
        ]);
        if !seen.insert(key.into_units()) {
            return type_error("Duplicate task prerequisite");
        }
    }
    if json_byte_length(value)? > 32 * 1024 {
        return range_error("Task prerequisites exceed 32 KiB");
    }
    Ok(())
}

/// `text(value, limit)` of approved-plan.js: trimmed non-empty, at most
/// `limit` UTF-8 bytes.
fn plan_text(value: &Value, limit: u64) -> bool {
    as_str(value).is_some_and(|text| !trim(text.units()).is_empty() && utf8_len(text.units()) <= limit)
}

const PLAN_FIELDS: [&str; 8] = [
    "rootSessionId",
    "objectiveId",
    "sourceMessageId",
    "version",
    "phase",
    "paths",
    "content",
    "contentHash",
];

/// `validateApprovedPlanRef(value)`.
pub fn validate_approved_plan_ref(value: &Value) -> JsResult<()> {
    if matches!(value, Value::Undefined) {
        return Ok(());
    }
    let invalid = !is_record(value)
        || keys(value).iter().any(|key| !PLAN_FIELDS.iter().any(|field| key == field))
        || !["rootSessionId", "objectiveId", "sourceMessageId"]
            .iter()
            .all(|key| plan_text(get(value, key), 256))
        || !matches_str(get(value, "version"), plan_digest())
        || !plan_text(get(value, "phase"), 512)
        || !plan_text(get(value, "content"), 32 * 1024)
        || !matches_str(get(value, "contentHash"), plan_digest())
        || get(value, "paths").as_array().is_none_or(|paths| {
            paths.len() > 32
                || paths.iter().any(|item| {
                    !plan_text(item, 512)
                        || as_str(item).is_some_and(|item| {
                            plan_absolute_path().test(item.units()) || split_slashes(item.units()).iter().any(|piece| *piece == units("..").as_slice())
                        })
                })
        });
    if invalid {
        return type_error("Invalid approved plan reference");
    }
    Ok(())
}

const STEP_BUDGET_FIELDS: [&str; 6] = [
    "acceptedPrompts",
    "userMessageID",
    "assistantMessageIDs",
    "warningClaimedAt",
    "maintenanceParents",
    "retiredPromptThrough",
];
const DESIGNER_PRIMARY_STEP_WARNING: usize = 180;
const DESIGNER_PRIMARY_STEP_EMERGENCY: usize = 260;

fn only_keys(value: &Value, allowed: &[&str]) -> bool {
    keys(value).iter().all(|key| allowed.iter().any(|field| key == field))
}

fn non_negative_finite(value: &Value) -> bool {
    is_finite(value) && as_number(value).is_some_and(|number| number >= 0.0)
}

/// `validatePrimaryStepBudget(value)`.
pub fn validate_primary_step_budget(value: &Value) -> JsResult<()> {
    if matches!(value, Value::Undefined) {
        return Ok(());
    }
    // `!prompt || Object.keys(prompt)…`: a primitive or an array never passes
    // (its keys are indices or its fields are missing), so only a plain object can.
    let invalid = !is_record(value) || !only_keys(value, &STEP_BUDGET_FIELDS) || {
        let prompts = get(value, "acceptedPrompts").as_array();
        let user_message = get(value, "userMessageID");
        let assistant = get(value, "assistantMessageIDs").as_array();
        let warning = get(value, "warningClaimedAt");
        let retired = get(value, "retiredPromptThrough");
        let parents = get(value, "maintenanceParents");
        match prompts {
            None => true,
            Some(prompts) => {
                let has_prompt = |id: &Value| {
                    prompts
                        .iter()
                        .any(|prompt| as_str(get(prompt, "userMessageID")).is_some() && as_str(get(prompt, "userMessageID")) == as_str(id))
                };
                prompts.len() > 32
                    || prompts.iter().any(|prompt| {
                        !is_record(prompt)
                            || !only_keys(prompt, &["userMessageID", "createdAt"])
                            || !matches_str(get(prompt, "userMessageID"), step_identifier())
                            || !non_negative_finite(get(prompt, "createdAt"))
                    })
                    || {
                        let mut seen = HashSet::new();
                        !prompts.iter().all(|prompt| seen.insert(as_str(get(prompt, "userMessageID"))))
                    }
                    || (!matches!(retired, Value::Undefined) && !non_negative_finite(retired))
                    || (!matches!(parents, Value::Undefined)
                        && parents.as_array().is_none_or(|parents| {
                            parents.len() > 32
                                || parents.iter().any(|parent| {
                                    !is_record(parent)
                                        || !only_keys(parent, &["parentID", "userMessageID"])
                                        || !matches_str(get(parent, "parentID"), step_identifier())
                                        || !has_prompt(get(parent, "userMessageID"))
                                })
                                || {
                                    let mut seen = HashSet::new();
                                    !parents.iter().all(|parent| seen.insert(as_str(get(parent, "parentID"))))
                                }
                        }))
                    || (!matches!(user_message, Value::Null) && !has_prompt(user_message))
                    || match assistant {
                        None => true,
                        Some(assistant) => {
                            assistant.len() > DESIGNER_PRIMARY_STEP_EMERGENCY
                                || assistant.iter().any(|id| !matches_str(id, step_identifier()))
                                || {
                                    let mut seen = HashSet::new();
                                    !assistant.iter().all(|id| seen.insert(as_str(id)))
                                }
                                || (matches!(user_message, Value::Null) && !assistant.is_empty())
                                || (!matches!(warning, Value::Null) && !non_negative_finite(warning))
                                || (!matches!(warning, Value::Null) && assistant.len() < DESIGNER_PRIMARY_STEP_WARNING)
                        }
                    }
            }
        }
    };
    if invalid {
        return type_error("Invalid managed primary step budget");
    }
    Ok(())
}

const BACKENDS: [&str; 3] = ["legacy-session", "native-job", "cursor"];
const SEGMENT_STATES: [&str; 5] = ["reserved", "prepared", "accepted", "uncertain", "cancelled"];
const SEGMENT_ID_FIELDS: [&str; 3] = ["jobID", "notificationID", "messageID"];

/// `validateManagedExecutionBackend(value)`.
pub fn validate_managed_execution_backend(value: &Value) -> JsResult<()> {
    if !matches!(value, Value::Undefined) && !is_one_of(value, &BACKENDS) {
        return type_error("Invalid managed execution backend");
    }
    Ok(())
}

/// `validateManagedNativeJobSegments(value, backend)`.
pub fn validate_managed_native_job_segments(value: &Value, backend: &Value) -> JsResult<()> {
    if matches!(value, Value::Undefined) {
        return Ok(());
    }
    let Some(segments) = value.as_array().filter(|_| is_str(backend, "native-job")) else {
        return type_error("Native job segments require their native backend");
    };
    let mut identities: HashSet<Vec<u16>> = HashSet::new();
    for segment in segments {
        let completion = get(segment, "completion");
        if !is_record(segment)
            || !only_keys(segment, &["jobID", "notificationID", "messageID", "state", "completion"])
            || !SEGMENT_ID_FIELDS.iter().all(|key| matches_str(get(segment, key), segment_identifier()))
            || as_str(get(segment, "messageID")) == as_str(get(segment, "notificationID"))
            || !is_one_of(get(segment, "state"), &SEGMENT_STATES)
            || (!matches!(completion, Value::Undefined) && !is_one_of(completion, &["pending", "done"]))
        {
            return type_error("Invalid native job segment");
        }
        for key in SEGMENT_ID_FIELDS {
            let identity = concat(&[&units(key), &units(":"), as_str(get(segment, key)).expect("a checked id").units()]);
            if !identities.insert(identity.into_units()) {
                return type_error("Duplicate native job segment identity");
            }
        }
    }
    Ok(())
}

/// `isManagedNativeJobReceiptTransition(previous, next)` for a validated `previous`.
pub fn is_managed_native_job_receipt_transition(previous: &Value, next: &Value) -> JsResult<bool> {
    let (Some(before), Some(after)) = (get(previous, "nativeJobSegments").as_array(), get(next, "nativeJobSegments").as_array()) else {
        return Ok(false);
    };
    if before.len() != after.len() {
        return Ok(false);
    }
    for (segment, later) in before.iter().zip(after) {
        for key in SEGMENT_ID_FIELDS {
            if !strict_equal(get(segment, key), read(later, key)?)? {
                return Ok(false);
            }
        }
        if !strict_equal(get(segment, "state"), read(later, "state")?)? {
            return Ok(false);
        }
        let completion = get(segment, "completion");
        let next_completion = read(later, "completion")?;
        if !(strict_equal(completion, next_completion)? || (is_str(completion, "pending") && is_str(next_completion, "done"))) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `value?.length > 0` for the values a record field can hold.
pub fn length_above_zero(value: &Value) -> JsResult<bool> {
    Ok(match value {
        Value::Array(items) => !items.is_empty(),
        Value::String(text) => !text.is_empty(),
        Value::Object(object) => match object.get_str("length") {
            Some(length) => to_number(length)? > 0.0,
            None => false,
        },
        _ => false,
    })
}

/// `requiresManagedNativeInputDisposition(task)`.
pub fn requires_managed_native_input_disposition(task: &Value) -> JsResult<bool> {
    Ok(is_str(read(task, "executionBackend")?, "native-job")
        && is_one_of(get(task, "status"), &["failed", "aborted", "interrupted"])
        && length_above_zero(get(task, "nativeJobSegments"))?)
}

const TRANSPORT_PHASES: [&str; 7] = ["backup_pending", "reserved", "submitted", "recovered", "exhausted", "uncertain", "blocked"];
const TRANSPORT_FIELDS: [&str; 11] = [
    "revision",
    "phase",
    "kind",
    "sameModelAttempts",
    "backupAttempts",
    "failedMessageId",
    "failedUserMessageId",
    "recoveryMessageId",
    "eventId",
    "reservedAt",
    "submittedAt",
];

/// `validateManagedTransportRecovery(value)`: `null` for a nullish value,
/// else a copy (`{ ...value }`).
pub fn validate_managed_transport_recovery(value: &Value) -> JsResult<Value> {
    if is_nullish(value) {
        return Ok(Value::Null);
    }
    if !is_record(value) {
        return type_error("transportRecovery must be an object or null");
    }
    for field in keys(value) {
        if !TRANSPORT_FIELDS.iter().any(|known| field == *known) {
            return type_error(concat(&[&units("Unknown transportRecovery field: "), field.units()]));
        }
    }
    let backup = get(value, "backupAttempts");
    if !is_safe_integer(get(value, "revision"))
        || as_number(get(value, "revision")).is_some_and(|revision| revision < 1.0)
        || !is_one_of(get(value, "phase"), &TRANSPORT_PHASES)
        || !is_one_of(get(value, "kind"), &PROVIDER_TRANSPORT_FAILURE_KINDS)
        || as_number(get(value, "sameModelAttempts")) != Some(1.0)
        || !matches!(backup, Value::Number(number) if *number == 0.0 || *number == 1.0)
    {
        return type_error("Invalid transportRecovery state or attempt count");
    }
    for field in ["failedMessageId", "failedUserMessageId", "recoveryMessageId", "eventId"] {
        let item = get(value, field);
        if matches!(item, Value::Null) && (field == "failedUserMessageId" || field == "eventId") {
            continue;
        }
        if as_str(item).is_none_or(|text| trim(text.units()).is_empty() || text.len() > 256) {
            return type_error(format!("Invalid transportRecovery.{field}"));
        }
    }
    let reserved = get(value, "reservedAt");
    let submitted = get(value, "submittedAt");
    if !is_finite(reserved)
        || as_number(reserved).is_some_and(|at| at < 0.0)
        || (!matches!(submitted, Value::Null)
            && (!is_finite(submitted)
                || as_number(submitted)
                    .zip(as_number(reserved))
                    .is_some_and(|(submitted, reserved)| submitted < reserved)))
    {
        return type_error("Invalid transportRecovery timestamps");
    }
    Ok(Value::Object(spread(value)))
}

/// `isManagedTransportBackupEligible(task)`.
pub fn is_managed_transport_backup_eligible(task: &Value) -> JsResult<bool> {
    let recovery = get(task, "transportRecovery");
    if !is_str(get(recovery, "phase"), "exhausted")
        || as_number(get(recovery, "sameModelAttempts")) != Some(1.0)
        || as_number(get(recovery, "backupAttempts")) != Some(0.0)
    {
        return Ok(false);
    }
    let reason = get(task, "failureReason");
    Ok(is_provider_configuration_failure(reason) || classify_provider_transport_failure(&Value::Null, reason)?.is_some())
}
