//! `auto-resume-policy.js`: the pure planning of automatic resumption.
//!
//! Domain: `now` is a number (the JavaScript would add, compare and copy any
//! value); every other numeric field is a number, `null`, `undefined` or a
//! boolean (`ToNumber` without strings), else the call is refused.

use devryan_js_layer::js::{JsObject, JsStr, Value};

use crate::contract::{has_accepted_user_stop, requires_manual_model_recovery};
use crate::error::{JsResult, type_error, unsupported};
use crate::jsv::{FALSE, NULL, as_number, as_str, get, is_finite, nullish_or, object, read, spread, strict_equal, to_number, to_string, truthy};
use crate::leaves::is_managed_transport_backup_eligible;
use crate::primitives::{MANAGED_TASK_ID_PREFIX, is_auto_resume_active_state};
use crate::retry::{is_definite_provider_usage_limit, supports_managed_read_only_provider};
use crate::text::{concat, units};

pub const AUTO_RESUME_MAX_ATTEMPTS: f64 = 8.0;
pub const AUTO_RESUME_MAX_LINEAGE_MS: f64 = 6.0 * 60.0 * 60.0 * 1_000.0;
pub const AUTO_RESUME_BACKOFF_MS: [f64; 3] = [15.0 * 60.0 * 1_000.0, 30.0 * 60.0 * 1_000.0, 60.0 * 60.0 * 1_000.0];
pub const AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW: f64 = 2.0;
pub const AUTO_RESUME_MAX_HOST_FAILURES: f64 = 5.0;
pub const AUTO_RESUME_RESET_JITTER_MS: f64 = 15_000.0;
pub const AUTO_RESUME_MIN_DELAY_MS: f64 = 5_000.0;
pub const AUTO_RESUME_HOST_RETRY_MS: f64 = 60_000.0;
pub const MANAGED_LINEAGE_ID_PREFIX: &str = "dvr_lineage_";

fn number_now(now: &Value) -> JsResult<f64> {
    match now {
        Value::Number(now) => Ok(*now),
        _ => unsupported("auto-resume `now` that is not a number"),
    }
}

/// `futureTimestamp(value, now)`.
fn future_timestamp(value: &Value, now: f64) -> Value {
    match value {
        Value::Number(at) if at.is_finite() && *at > now => Value::Number(*at),
        _ => Value::Null,
    }
}

/// `nonNegativeTimestamp(value)`.
fn non_negative_timestamp(value: &Value) -> Value {
    match value {
        Value::Number(at) if at.is_finite() && *at >= 0.0 => Value::Number(*at),
        _ => Value::Null,
    }
}

/// `value + addend` for a number-like field.
fn plus(value: &Value, addend: f64) -> JsResult<Value> {
    Ok(Value::Number(to_number(value)? + addend))
}

/// `createLineageId(rootTaskId)`.
pub fn create_lineage_id(root_task_id: &Value) -> JsResult<JsStr> {
    match as_str(root_task_id) {
        Some(id) if crate::text::starts_with(id.units(), MANAGED_TASK_ID_PREFIX) => {
            Ok(concat(&[&units(MANAGED_LINEAGE_ID_PREFIX), &id.units()[MANAGED_TASK_ID_PREFIX.len()..]]))
        }
        _ => type_error("rootTaskId must be a managed task id"),
    }
}

/// `isAutoResumeEligible(task, envelope)`.
pub fn is_auto_resume_eligible(task: &Value, envelope: &Value) -> JsResult<bool> {
    if !truthy(envelope)
        || has_accepted_user_stop(task)
        || truthy(get(task, "operatorStop"))
        || !matches!(get(envelope, "action"), Value::Null)
        || as_number(get(get(task, "transportRecovery"), "backupAttempts")) == Some(1.0)
    {
        return Ok(false);
    }
    if !(is_definite_provider_usage_limit(get(task, "failureReason")) || is_managed_transport_backup_eligible(task)?) {
        return Ok(false);
    }
    requires_manual_model_recovery(task, envelope)
}

/// `isAutoResumeActive(envelope)`.
pub fn is_auto_resume_active(envelope: &Value) -> bool {
    let state = get(envelope, "autoResume");
    truthy(state) && matches!(get(state, "enabled"), Value::Bool(true)) && is_auto_resume_active_state(get(state, "state"))
}

/// `initialAutoResumeState({ now, enabled, providerResetAt, prior = null, taskId = null })`.
pub fn initial_auto_resume_state(now: &Value, enabled: &Value, provider_reset_at: &Value, prior: &Value, task_id: &Value) -> JsResult<Value> {
    let now_number = number_now(now)?;
    let prior = if matches!(prior, Value::Undefined) { &NULL } else { prior };
    let task_id = if matches!(task_id, Value::Undefined) { &NULL } else { task_id };
    let inherit = truthy(prior)
        && as_str(get(prior, "state")).is_some_and(|state| state == "attempting")
        && (matches!(task_id, Value::Null) || strict_equal(get(prior, "lastAttemptTaskId"), task_id)?);
    let mut reset_at = future_timestamp(provider_reset_at, now_number);
    if matches!(reset_at, Value::Null) && inherit {
        reset_at = future_timestamp(get(prior, "resetAt"), now_number);
    }
    let from_prior = |name: &str, fallback: Value| if inherit { get(prior, name).clone() } else { fallback };
    let reset_source = if matches!(reset_at, Value::Null) {
        Value::Null
    } else if inherit && strict_equal(&reset_at, get(prior, "resetAt"))? {
        nullish_or(get(prior, "resetSource"), &Value::string("opencode_status")).clone()
    } else {
        Value::string("opencode_status")
    };
    Ok(object(vec![
        ("revision", Value::Number(1.0)),
        ("enabled", Value::Bool(truthy(enabled))),
        ("state", Value::string("planning")),
        ("cancelGeneration", from_prior("cancelGeneration", Value::Number(0.0))),
        ("lineageStartedAt", from_prior("lineageStartedAt", now.clone())),
        ("expiresAt", from_prior("expiresAt", Value::Number(now_number + AUTO_RESUME_MAX_LINEAGE_MS))),
        ("attemptCount", from_prior("attemptCount", Value::Number(0.0))),
        (
            "recoveryCycleTaskId",
            if inherit {
                nullish_or(get(prior, "recoveryCycleTaskId"), &NULL).clone()
            } else {
                Value::Null
            },
        ),
        (
            "backupAttemptTaskId",
            if inherit {
                nullish_or(get(prior, "backupAttemptTaskId"), &NULL).clone()
            } else {
                Value::Null
            },
        ),
        ("noSignalProbes", from_prior("noSignalProbes", Value::Number(0.0))),
        ("rejectionsInWindow", from_prior("rejectionsInWindow", Value::Number(0.0))),
        ("windowResetAt", from_prior("windowResetAt", Value::Null)),
        ("nextAttemptAt", Value::Null),
        ("resetAt", reset_at),
        ("resetSource", reset_source),
        ("target", Value::Null),
        ("lastAttemptTaskId", from_prior("lastAttemptTaskId", Value::Null)),
        ("lastAttemptAt", from_prior("lastAttemptAt", Value::Null)),
        ("lastError", Value::Null),
        ("hostFailures", from_prior("hostFailures", Value::Number(0.0))),
        ("reason", Value::Null),
    ]))
}

/// `recordProviderRejection(state, { now, providerResetAt })`.
pub fn record_provider_rejection(state: &Value, now: &Value, provider_reset_at: &Value) -> JsResult<Value> {
    let now = number_now(now)?;
    let raw_reset = non_negative_timestamp(provider_reset_at);
    let reset_at = future_timestamp(&raw_reset, now);
    let window = read(state, "windowResetAt")?;
    let same_window = !matches!(window, Value::Null) && {
        let window = to_number(window)?;
        now < window || as_number(&raw_reset).is_some_and(|raw| (raw - window).abs() <= AUTO_RESUME_RESET_JITTER_MS)
    };
    let mut known_reset = reset_at.clone();
    if matches!(known_reset, Value::Null) && same_window {
        known_reset = future_timestamp(get(state, "resetAt"), now);
    }
    let mut next = spread(state);
    next.set(
        "rejectionsInWindow",
        if same_window {
            plus(get(state, "rejectionsInWindow"), 1.0)?
        } else {
            Value::Number(1.0)
        },
    );
    next.set("windowResetAt", if same_window { window.clone() } else { reset_at.clone() });
    let probes = get(state, "noSignalProbes");
    next.set(
        "noSignalProbes",
        if matches!(reset_at, Value::Null) {
            plus(probes, 1.0)?
        } else {
            probes.clone()
        },
    );
    let source = if matches!(known_reset, Value::Null) {
        Value::Null
    } else if !matches!(reset_at, Value::Null) {
        Value::string("opencode_status")
    } else {
        nullish_or(get(state, "resetSource"), &Value::string("opencode_status")).clone()
    };
    next.set("resetAt", known_reset);
    next.set("resetSource", source);
    Ok(Value::Object(next))
}

/// `breakerUntil` of `planAutoResumeAttempt`: called with a provider ID.
pub type BreakerUntil<'a> = &'a dyn Fn(&Value) -> Value;

/// `readBreaker(breakerUntil, providerId, now)`: (until, source).
fn read_breaker(breaker_until: Option<BreakerUntil<'_>>, provider_id: &Value, now: f64) -> (Value, Value) {
    let value = breaker_until.map_or(Value::Null, |breaker| breaker(provider_id));
    match &value {
        Value::Null | Value::Undefined => (Value::Null, Value::Null),
        Value::Number(_) => (future_timestamp(&value, now), Value::Null),
        _ => {
            let source = get(&value, "source");
            (
                future_timestamp(get(&value, "until"), now),
                if matches!(source, Value::String(_)) { source.clone() } else { Value::Null },
            )
        }
    }
}

/// The arguments of `planAutoResumeAttempt` (each `&Value::Undefined` when
/// omitted; `backup`, `providerReset` and `origin` default to `null`,
/// `cursorReadOnly` to `false`).
pub struct PlanInput<'a> {
    pub now: &'a Value,
    pub task: &'a Value,
    pub state: &'a Value,
    pub backup: &'a Value,
    pub breaker_until: Option<BreakerUntil<'a>>,
    pub provider_reset: &'a Value,
    pub origin: &'a Value,
    pub cursor_read_only: &'a Value,
}

fn exhausted(reason: &str) -> Value {
    object(vec![("state", Value::string("exhausted")), ("reason", Value::string(reason))])
}

fn backup_target(backup: &Value) -> Value {
    object(vec![
        ("kind", Value::string("backup")),
        ("providerId", get(backup, "providerId").clone()),
        ("modelId", get(backup, "modelId").clone()),
        ("variant", nullish_or(get(backup, "variant"), &NULL).clone()),
    ])
}

fn defaulted<'a>(value: &'a Value, fallback: &'a Value) -> &'a Value {
    if matches!(value, Value::Undefined) { fallback } else { value }
}

/// `planAutoResumeAttempt({ now, task, state, backup, breakerUntil, providerReset, origin, cursorReadOnly })`.
pub fn plan_auto_resume_attempt(input: &PlanInput<'_>) -> JsResult<Value> {
    let now_value = input.now;
    let now = number_now(now_value)?;
    let (task, state) = (input.task, input.state);
    let backup = defaulted(input.backup, &NULL);
    let provider_reset = defaulted(input.provider_reset, &NULL);
    let origin = defaulted(input.origin, &NULL);
    let cursor_read_only = defaulted(input.cursor_read_only, &FALSE);
    let breaker = input.breaker_until;
    let origin_provider = nullish_or(get(origin, "providerId"), read(task, "providerId")?).clone();
    let origin_model = nullish_or(get(origin, "modelId"), read(task, "modelId")?).clone();
    let origin_variant = if matches!(get(origin, "variant"), Value::Undefined) {
        nullish_or(get(task, "variant"), &NULL).clone()
    } else {
        get(origin, "variant").clone()
    };
    let attempt_count = to_number(get(state, "attemptCount"))?;
    if as_str(read(state, "trigger")?).is_some_and(|trigger| trigger == "provider_transport") {
        if attempt_count >= 1.0 || as_number(get(get(task, "transportRecovery"), "backupAttempts")) == Some(1.0) {
            return Ok(exhausted("attempt_cap"));
        }
        if now >= to_number(get(state, "expiresAt"))? {
            return Ok(exhausted("time_cap"));
        }
        let distinct = truthy(backup)
            && (!strict_equal(get(backup, "providerId"), get(task, "providerId"))? || !strict_equal(get(backup, "modelId"), get(task, "modelId"))?);
        if !distinct
            || (truthy(get(task, "readOnly")) && !supports_managed_read_only_provider(get(backup, "providerId"), cursor_read_only))
            || !matches!(read_breaker(breaker, get(backup, "providerId"), now).0, Value::Null)
        {
            return Ok(exhausted("backup_unavailable"));
        }
        return Ok(object(vec![
            ("state", Value::string("scheduled")),
            ("nextAttemptAt", now_value.clone()),
            ("target", backup_target(backup)),
            ("resetAt", Value::Null),
            ("resetSource", Value::Null),
        ]));
    }
    if attempt_count >= AUTO_RESUME_MAX_ATTEMPTS {
        return Ok(exhausted("attempt_cap"));
    }
    let expires_at = to_number(get(state, "expiresAt"))?;
    if now >= expires_at {
        return Ok(exhausted("time_cap"));
    }
    let original_target = object(vec![
        ("kind", Value::string("original")),
        ("providerId", origin_provider.clone()),
        ("modelId", origin_model.clone()),
        ("variant", origin_variant),
    ]);
    let schedule_original = |next_attempt_at: f64, reset_at: Value, reset_source: Value| {
        if next_attempt_at > expires_at {
            exhausted("time_cap")
        } else {
            object(vec![
                ("state", Value::string("scheduled")),
                ("nextAttemptAt", Value::Number(next_attempt_at)),
                ("target", original_target.clone()),
                ("resetAt", reset_at),
                ("resetSource", reset_source),
            ])
        }
    };
    let (origin_until, origin_source) = read_breaker(breaker, &origin_provider, now);
    let opencode = Value::string("opencode_status");
    let provider_reset_at = if truthy(provider_reset) && !matches!(get(provider_reset, "limited"), Value::Bool(false)) {
        future_timestamp(get(provider_reset, "resetAt"), now)
    } else {
        Value::Null
    };
    let mut known_resets: Vec<(f64, Value)> = [
        (
            future_timestamp(get(state, "resetAt"), now),
            nullish_or(get(state, "resetSource"), &opencode).clone(),
        ),
        (provider_reset_at, Value::string("meridian_quota")),
        (origin_until, nullish_or(&origin_source, &opencode).clone()),
    ]
    .into_iter()
    .filter_map(|(at, source)| as_number(&at).map(|at| (at, source)))
    .collect();
    // `left[0] - right[0]` over finite numbers, stable (so -0 ties with 0).
    known_resets.sort_by(|left, right| left.0.partial_cmp(&right.0).expect("finite resets"));
    let earliest = known_resets.first().cloned();

    let backup_provider = get(backup, "providerId");
    let backup_model = get(backup, "modelId");
    let backup_differs = truthy(backup)
        && matches!(backup_provider, Value::String(_))
        && matches!(backup_model, Value::String(_))
        && (!strict_equal(backup_provider, &origin_provider)? || !strict_equal(backup_model, &origin_model)?);
    if backup_differs
        && !truthy(get(state, "backupAttemptTaskId"))
        && (!truthy(get(task, "readOnly")) || supports_managed_read_only_provider(backup_provider, cursor_read_only))
        && matches!(read_breaker(breaker, backup_provider, now).0, Value::Null)
    {
        let (reset_at, reset_source) = earliest.map_or((Value::Null, Value::Null), |(at, source)| (Value::Number(at), source));
        return Ok(object(vec![
            ("state", Value::string("scheduled")),
            ("nextAttemptAt", now_value.clone()),
            ("target", backup_target(backup)),
            ("resetAt", reset_at),
            ("resetSource", reset_source),
        ]));
    }

    let rejections = to_number(get(state, "rejectionsInWindow"))?;
    if rejections > AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW {
        return Ok(exhausted("window_rejections"));
    }
    let window_reset_at = future_timestamp(get(state, "windowResetAt"), now);
    if rejections >= AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW
        && let Some(window) = as_number(&window_reset_at)
    {
        return Ok(schedule_original(window + AUTO_RESUME_RESET_JITTER_MS, window_reset_at, opencode));
    }
    if let Some((reset_at, reset_source)) = earliest {
        let next = crate::jsv::math_max(&[now + AUTO_RESUME_MIN_DELAY_MS, reset_at + AUTO_RESUME_RESET_JITTER_MS]);
        return Ok(schedule_original(next, Value::Number(reset_at), reset_source));
    }
    let state_reset = get(state, "resetAt");
    if as_str(get(get(state, "lastError"), "code")).is_some_and(|code| code == "backup_availability_unknown")
        && is_finite(state_reset)
        && as_number(state_reset).is_some_and(|at| at <= now)
    {
        let at = as_number(state_reset).expect("a finite reset");
        let next = crate::jsv::math_max(&[now + AUTO_RESUME_MIN_DELAY_MS, at + AUTO_RESUME_RESET_JITTER_MS]);
        return Ok(schedule_original(
            next,
            state_reset.clone(),
            nullish_or(get(state, "resetSource"), &opencode).clone(),
        ));
    }
    let probes = to_number(get(state, "noSignalProbes"))?;
    let ladder = crate::jsv::math_min(&[crate::jsv::math_max(&[probes, 1.0]) - 1.0, (AUTO_RESUME_BACKOFF_MS.len() - 1) as f64]);
    // AUTO_RESUME_BACKOFF_MS[ladder]: an index that is not 0, 1 or 2 reads undefined (NaN once added).
    let delay = if ladder.trunc() == ladder && (0.0..3.0).contains(&ladder) {
        AUTO_RESUME_BACKOFF_MS[ladder as usize]
    } else {
        f64::NAN
    };
    let next_attempt_at = now + delay;
    Ok(schedule_original(next_attempt_at, Value::Number(next_attempt_at), Value::string("backoff")))
}

/// `buildAutoResumeAcknowledgeParams({ task, envelope })`.
pub fn build_auto_resume_acknowledge_params(task: &Value, envelope: &Value) -> JsResult<Value> {
    let state = get(envelope, "autoResume");
    if !truthy(state) || !truthy(get(state, "target")) {
        return type_error("auto-resume attempts require a scheduled target");
    }
    let task_id = read(task, "taskId")?;
    let target = get(state, "target");
    let key = concat(&[
        &units("auto-resume:"),
        to_string(task_id)?.units(),
        &units(":"),
        to_string(get(state, "cancelGeneration"))?.units(),
        &units(":"),
        to_string(get(state, "attemptCount"))?.units(),
    ]);
    let mut params = JsObject::new();
    params.set("taskId", task_id.clone());
    params.set("rootSessionId", get(task, "rootSessionId").clone());
    params.set("directory", get(task, "directory").clone());
    params.set("action", Value::string("retry_in_place"));
    params.set("idempotencyKey", Value::String(key));
    params.set("providerId", get(target, "providerId").clone());
    params.set("modelId", get(target, "modelId").clone());
    params.set("variant", nullish_or(get(target, "variant"), &NULL).clone());
    params.set("autoResumeGeneration", get(state, "cancelGeneration").clone());
    Ok(Value::Object(params))
}
