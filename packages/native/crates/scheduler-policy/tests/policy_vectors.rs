//! Replays every row of the tracked vectors (tests/vectors/*.jsonl, written
//! by tests/generate-vectors.mjs from the real JavaScript) and requires the
//! Rust outcome to be the JavaScript's exactly: the tagged JSON of the value
//! (vector-format.mjs), or the thrown error's name, message and code. A row
//! marked `refuse` must be refused (`Failure::Unsupported`); no other row may be.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use devryan_scheduler_policy::js::{self, JsObject, JsStr, Value};
use devryan_scheduler_policy::{
    Failure, JsError, JsResult, auto_resume, checks, codec, contract, envelope, leaves, persistence, primitives, proof_store, retry, transitions,
};

const FILES: [&str; 8] = [
    "retry.jsonl",
    "primitives.jsonl",
    "records.jsonl",
    "codec.jsonl",
    "persistence.jsonl",
    "transitions.jsonl",
    "auto-resume.jsonl",
    "proof-store.jsonl",
];

static UNDEFINED: Value = Value::Undefined;

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.to_string_lossy(),
        other => panic!("expected a string, found {other:?}"),
    }
}

fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|object| object.get_str(key)).unwrap_or(&UNDEFINED)
}

/// A string of at least 64 units as at most 8 runs of one unit (vector-format.mjs `runsOf`).
fn runs_of(text: &[u16]) -> Option<Vec<(u16, usize)>> {
    if text.len() < 64 {
        return None;
    }
    let mut runs: Vec<(u16, usize)> = Vec::new();
    for unit in text {
        match runs.last_mut() {
            Some((last, count)) if last == unit => *count += 1,
            _ => {
                runs.push((*unit, 1));
                if runs.len() > 8 {
                    return None;
                }
            }
        }
    }
    Some(runs)
}

/// The tagged form of a value (vector-format.mjs `encode`).
fn encode(value: &Value) -> Value {
    let tag = |name: &str| {
        let mut object = JsObject::new();
        object.set("$", Value::string(name));
        Value::Object(object)
    };
    match value {
        Value::Undefined => tag("undefined"),
        Value::Number(number) if number.is_nan() => tag("NaN"),
        Value::Number(number) if *number == f64::INFINITY => tag("Infinity"),
        Value::Number(number) if *number == f64::NEG_INFINITY => tag("-Infinity"),
        Value::Number(number) if *number == 0.0 && number.is_sign_negative() => tag("-0"),
        Value::String(text) => match runs_of(text.units()) {
            Some(runs) => {
                let mut tagged = JsObject::new();
                tagged.set("$", Value::string("runs"));
                tagged.set(
                    "runs",
                    Value::Array(
                        runs.into_iter()
                            .map(|(unit, count)| Value::Array(vec![Value::String(JsStr::from_units(vec![unit])), Value::Number(count as f64)]))
                            .collect(),
                    ),
                );
                Value::Object(tagged)
            }
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(encode).collect()),
        Value::Object(object) => {
            if object.get_str("$").is_some() {
                let entries = object.iter().map(|(key, item)| Value::Array(vec![Value::String(key), encode(item)])).collect();
                let mut tagged = JsObject::new();
                tagged.set("$", Value::string("object"));
                tagged.set("entries", Value::Array(entries));
                Value::Object(tagged)
            } else {
                let mut out = JsObject::new();
                for (key, item) in object.iter() {
                    out.insert(key, encode(item));
                }
                Value::Object(out)
            }
        }
        scalar => scalar.clone(),
    }
}

/// A row value back to the JavaScript value (tags, base references and ops).
fn decode(tagged: &Value, bases: &HashMap<String, Value>) -> Value {
    match tagged {
        Value::Array(items) => Value::Array(items.iter().map(|item| decode(item, bases)).collect()),
        Value::Object(object) => match object.get_str("$") {
            None => {
                let mut out = JsObject::new();
                for (key, item) in object.iter() {
                    out.insert(key, decode(item, bases));
                }
                Value::Object(out)
            }
            Some(tag) => match text_of(tag).as_str() {
                "undefined" => Value::Undefined,
                "NaN" => Value::Number(f64::NAN),
                "Infinity" => Value::Number(f64::INFINITY),
                "-Infinity" => Value::Number(f64::NEG_INFINITY),
                "-0" => Value::Number(-0.0),
                "runs" => {
                    let mut out = Vec::new();
                    for run in get(tagged, "runs").as_array().expect("runs") {
                        let run = run.as_array().expect("a run");
                        let unit = match &run[0] {
                            Value::String(unit) => unit.units()[0],
                            other => panic!("a run unit, not {other:?}"),
                        };
                        let count = match run[1] {
                            Value::Number(count) => count as usize,
                            _ => panic!("a run count"),
                        };
                        out.extend(std::iter::repeat_n(unit, count));
                    }
                    Value::String(JsStr::from_units(out))
                }
                "repeat" => {
                    let item = decode(get(tagged, "value"), bases);
                    let count = match get(tagged, "count") {
                        Value::Number(count) => *count as usize,
                        _ => panic!("a repeat count"),
                    };
                    Value::Array(vec![item; count])
                }
                "object" => {
                    let mut out = JsObject::new();
                    for entry in get(tagged, "entries").as_array().expect("entries") {
                        let pair = entry.as_array().expect("an entry");
                        out.insert(JsStr::from(text_of(&pair[0])), decode(&pair[1], bases));
                    }
                    Value::Object(out)
                }
                "base" => {
                    let mut value = bases.get(&text_of(get(tagged, "name"))).expect("a defined base").clone();
                    for op in get(tagged, "ops").as_array().expect("ops") {
                        let op = op.as_array().expect("an op");
                        let path = op[1].as_array().expect("a path");
                        let item = op.get(2).map(|item| decode(item, bases));
                        apply(&mut value, path, &text_of(&op[0]), item);
                    }
                    value
                }
                other => panic!("unknown tag {other}"),
            },
        },
        scalar => scalar.clone(),
    }
}

fn path_key(key: &Value) -> JsStr {
    match key {
        Value::String(text) => text.clone(),
        Value::Number(number) => JsStr::from(js::number_to_string(*number)),
        other => panic!("a path key is a string or index, not {other:?}"),
    }
}

/// One op at a path (`parent[key] = item`, `delete parent[key]`, `parent[key].push(item)`).
fn apply(value: &mut Value, path: &[Value], op: &str, item: Option<Value>) {
    let (first, rest) = path.split_first().expect("a non-empty path");
    match value {
        Value::Array(items) => {
            let index = match first {
                Value::Number(number) => *number as usize,
                other => panic!("an array index, not {other:?}"),
            };
            if rest.is_empty() {
                match op {
                    "set" => items[index] = item.expect("a value"),
                    "push" => push(&mut items[index], item.expect("a value")),
                    other => panic!("{other} at an array index"),
                }
            } else {
                apply(&mut items[index], rest, op, item);
            }
        }
        Value::Object(object) => {
            let key = path_key(first);
            if rest.is_empty() {
                match op {
                    "set" => {
                        object.insert(key, item.expect("a value"));
                    }
                    "delete" => {
                        object.remove(&key);
                    }
                    "push" => {
                        let mut child = object.get(&key).expect("an array to push to").clone();
                        push(&mut child, item.expect("a value"));
                        object.insert(key, child);
                    }
                    other => panic!("unknown op {other}"),
                }
            } else {
                let mut child = object.get(&key).expect("a path that exists").clone();
                apply(&mut child, rest, op, item);
                object.insert(key, child);
            }
        }
        other => panic!("a path through {other:?}"),
    }
}

fn push(target: &mut Value, item: Value) {
    match target {
        Value::Array(items) => items.push(item),
        other => panic!("push to {other:?}"),
    }
}

/// What a row's call gives: a value, or "the call's argument i".
enum Outcome {
    Value(Value),
    Arg(usize),
}

fn value(value: Value) -> JsResult<Outcome> {
    Ok(Outcome::Value(value))
}

fn kind(kind: Option<&str>) -> Value {
    kind.map_or(Value::Null, Value::string)
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut object = JsObject::new();
    for (key, item) in entries {
        object.set(key, item);
    }
    Value::Object(object)
}

fn strings(list: &[&str]) -> Value {
    Value::Array(list.iter().map(|item| Value::string(item)).collect())
}

fn bytes_text(bytes: Vec<u8>) -> Value {
    Value::String(JsStr::from(String::from_utf8(bytes).expect("JSON text is UTF-8")))
}

/// `sameOrEncode` of a validator that returns its argument `index`.
fn same_or(args: &[Value], index: usize) -> JsResult<Outcome> {
    let arg = args.get(index).unwrap_or(&UNDEFINED);
    Ok(if matches!(arg, Value::Array(_) | Value::Object(_)) {
        Outcome::Arg(index)
    } else {
        Outcome::Value(arg.clone())
    })
}

fn defaulted_array(args: &[Value], index: usize) -> JsResult<Outcome> {
    if matches!(args.get(index).unwrap_or(&UNDEFINED), Value::Undefined) {
        value(Value::Array(Vec::new()))
    } else {
        same_or(args, index)
    }
}

fn truthy(value: &Value) -> bool {
    devryan_scheduler_policy::jsv::truthy(value)
}

fn tagged_error(code: &str, detail: &Value) -> JsError {
    let detail = String::from_utf8(js::stringify_utf8(detail).expect("a detail").expect("JSON")).expect("UTF-8");
    JsError::new("RangeError", format!("{code}:{detail}")).with_code(&format!("x_{code}"))
}

fn constants() -> Value {
    use auto_resume as ar;
    use persistence as pe;
    use primitives as pr;
    let number = Value::Number;
    object(vec![
        ("MANAGED_TASK_ID_PREFIX", Value::string(pr::MANAGED_TASK_ID_PREFIX)),
        ("MANAGED_WAVE_ID_PREFIX", Value::string(pr::MANAGED_WAVE_ID_PREFIX)),
        ("MANAGED_TASK_STATUSES", strings(&pr::MANAGED_TASK_STATUSES)),
        ("MANAGED_TASK_LIVE_STATUSES", strings(&pr::MANAGED_TASK_LIVE_STATUSES)),
        ("MANAGED_TASK_TERMINAL_STATUSES", strings(&pr::MANAGED_TASK_TERMINAL_STATUSES)),
        ("MANAGED_TASK_FAILURE_KINDS", strings(&pr::MANAGED_TASK_FAILURE_KINDS)),
        ("AUTO_RESUME_STATES", strings(&pr::AUTO_RESUME_STATES)),
        ("AUTO_RESUME_ACTIVE_STATES", strings(&pr::AUTO_RESUME_ACTIVE_STATES)),
        ("AUTO_RESUME_RESET_SOURCES", strings(&pr::AUTO_RESUME_RESET_SOURCES)),
        ("AUTO_RESUME_REASONS", strings(&pr::AUTO_RESUME_REASONS)),
        ("MANAGED_RESULT_PAYLOAD_FIELDS", strings(&pr::MANAGED_RESULT_PAYLOAD_FIELDS)),
        ("MANAGED_RESULT_COMPACTED_FIELDS", strings(&pr::MANAGED_RESULT_COMPACTED_FIELDS)),
        ("MANAGED_TASK_OWNER", Value::string(contract::MANAGED_TASK_OWNER)),
        ("MAX_MANAGED_TASK_LABEL_BYTES", number(contract::MAX_MANAGED_TASK_LABEL_BYTES as f64)),
        ("MAX_MANAGED_TASK_PROMPT_BYTES", number(contract::MAX_MANAGED_TASK_PROMPT_BYTES as f64)),
        ("MAX_MANAGED_TASK_PREVIEW_BYTES", number(contract::MAX_MANAGED_TASK_PREVIEW_BYTES as f64)),
        ("MAX_MANAGED_TASK_FAILURE_BYTES", number(contract::MAX_MANAGED_TASK_FAILURE_BYTES as f64)),
        ("MANAGED_TASK_WAITING_REASON_KINDS", strings(&contract::MANAGED_TASK_WAITING_REASON_KINDS)),
        ("DUPLICATE_DISPATCH_WINDOW_MS", number(pr::DUPLICATE_DISPATCH_WINDOW_MS)),
        ("PROVIDER_TRANSPORT_FAILURE_KINDS", strings(&retry::PROVIDER_TRANSPORT_FAILURE_KINDS)),
        ("MANAGED_TASK_TIMEOUT_REASON_PREFIX", Value::string(retry::MANAGED_TASK_TIMEOUT_REASON_PREFIX)),
        ("DEFAULT_MANAGED_TERMINAL_MAX_RECORDS", number(pe::DEFAULT_MANAGED_TERMINAL_MAX_RECORDS)),
        ("DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS", number(pe::DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS)),
        ("DEFAULT_MANAGED_LEDGER_MAX_BYTES", number(pe::DEFAULT_MANAGED_LEDGER_MAX_BYTES)),
        ("MAX_RETAINED_LINEAGE_RECORDS", number(pe::MAX_RETAINED_LINEAGE_RECORDS as f64)),
        ("MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT", Value::string(pe::MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT)),
        ("AUTO_RESUME_MAX_ATTEMPTS", number(ar::AUTO_RESUME_MAX_ATTEMPTS)),
        ("AUTO_RESUME_MAX_LINEAGE_MS", number(ar::AUTO_RESUME_MAX_LINEAGE_MS)),
        (
            "AUTO_RESUME_BACKOFF_MS",
            Value::Array(ar::AUTO_RESUME_BACKOFF_MS.iter().map(|ms| number(*ms)).collect()),
        ),
        ("AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW", number(ar::AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW)),
        ("AUTO_RESUME_MAX_HOST_FAILURES", number(ar::AUTO_RESUME_MAX_HOST_FAILURES)),
        ("AUTO_RESUME_RESET_JITTER_MS", number(ar::AUTO_RESUME_RESET_JITTER_MS)),
        ("AUTO_RESUME_MIN_DELAY_MS", number(ar::AUTO_RESUME_MIN_DELAY_MS)),
        ("AUTO_RESUME_HOST_RETRY_MS", number(ar::AUTO_RESUME_HOST_RETRY_MS)),
        ("MANAGED_LINEAGE_ID_PREFIX", Value::string(ar::MANAGED_LINEAGE_ID_PREFIX)),
        (
            "MANAGED_NATIVE_JOB_PROOF_DIRECTORY",
            Value::string(proof_store::MANAGED_NATIVE_JOB_PROOF_DIRECTORY),
        ),
        (
            "MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT",
            number(f64::from(proof_store::MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT)),
        ),
        (
            "MANAGED_NATIVE_JOB_PROOF_SHARD_MAX_BYTES",
            number(proof_store::MANAGED_NATIVE_JOB_PROOF_SHARD_MAX_BYTES as f64),
        ),
        (
            "MANAGED_NATIVE_JOB_PROOF_SHARDS",
            Value::Array(
                (0..proof_store::MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT)
                    .map(|index| Value::string(&format!("{index:02x}")))
                    .collect(),
            ),
        ),
    ])
}

/// The Rust of every vector function name.
fn run(name: &str, args: &[Value]) -> JsResult<Outcome> {
    let arg = |index: usize| args.get(index).unwrap_or(&UNDEFINED);
    match name {
        "failureText" => {
            let text = arg(0);
            let status = object(vec![("message", text.clone())]);
            value(object(vec![
                ("a", Value::Bool(retry::is_provider_authentication_failure(text))),
                ("c", Value::Bool(retry::is_provider_configuration_failure(text))),
                ("k", Value::Bool(retry::is_managed_task_capability_failure(text))),
                ("r", kind(retry::classify_provider_retry_failure(text))),
                ("u", Value::Bool(retry::is_definite_provider_usage_limit(text))),
                ("p", Value::Bool(retry::is_provider_prompt_rejected(text))),
                ("d", Value::Bool(retry::is_managed_task_deadline_exceeded(text))),
                ("m", Value::Bool(retry::is_managed_task_model_unavailable(text))),
                ("f", kind(retry::classify_managed_task_failure(text)?)),
                ("t", kind(retry::classify_provider_transport_failure(&Value::Null, text)?)),
                ("n", kind(retry::classify_provider_transport_failure(text, &Value::Null)?)),
                ("s", kind(retry::classify_provider_retry_status(&status))),
            ]))
        }
        "formatManagedTaskFailureReason" => value(Value::String(retry::format_managed_task_failure_reason(arg(0))?)),
        "classifyProviderTransportFailure" => value(kind(retry::classify_provider_transport_failure(arg(0), arg(1))?)),
        "classifyProviderRetryStatus" => value(kind(retry::classify_provider_retry_status(arg(0)))),
        "supportsManagedReadOnlyProvider" => value(Value::Bool(retry::supports_managed_read_only_provider(arg(0), get(arg(1), "cursorReadOnly")))),
        "truncateManagedText" => value(Value::String(contract::truncate_managed_text(arg(0), arg(1))?)),
        "isManagedTaskId" => value(Value::Bool(primitives::is_managed_task_id(arg(0)))),
        "compareManagedTaskQueueOrder" => value(Value::Number(primitives::compare_managed_task_queue_order(arg(0), arg(1))?)),
        "canTransitionManagedTaskStatus" => value(Value::Bool(transitions::can_transition_managed_task_status(arg(0), arg(1))?)),
        "managedNativeJobProofShard" => value(Value::string(&proof_store::managed_native_job_proof_shard(arg(0))?)),
        "managedNativeJobProofShardFile" => value(Value::String(proof_store::managed_native_job_proof_shard_file(arg(0))?)),
        "isManagedNativeJobProofShard" => value(Value::Bool(proof_store::is_managed_native_job_proof_shard(arg(0)))),
        "createLineageId" => value(Value::String(auto_resume::create_lineage_id(arg(0))?)),
        "findManagedResultPayloadMismatch" => value(kind(primitives::find_managed_result_payload_mismatch(
            arg(0),
            arg(1),
            truthy(get(arg(2), "requireOwnFields")),
        )?)),
        "isAutoResumeActiveState" => value(Value::Bool(primitives::is_auto_resume_active_state(arg(0)))),
        "isAutoResumeActive" => value(Value::Bool(auto_resume::is_auto_resume_active(arg(0)))),
        "constants" => value(constants()),
        "schedulerRandomIdSource" => value(Value::string(primitives::SCHEDULER_RANDOM_ID_SOURCE)),
        "validateManagedTaskRecord" => contract::validate_managed_task_record(arg(0)).and_then(|()| same_or(args, 0)),
        "createManagedTaskRecord" => value(contract::create_managed_task_record(arg(0))?),
        "validateRequiredChecks" => checks::validate_required_checks(arg(0)).and_then(|()| defaulted_array(args, 0)),
        "validateRequiredCheckReceipts" => checks::validate_required_check_receipts(arg(0), arg(1)).and_then(|()| defaulted_array(args, 0)),
        "visualCheckPassed" => value(Value::Bool(checks::visual_check_passed(arg(0), arg(1)))),
        "validateCheckCorrection" => checks::validate_check_correction(arg(0), arg(1)).and_then(|()| value(arg(0).clone())),
        "validateCheckCorrectionHistory" => checks::validate_check_correction_history(arg(0)).and_then(|()| {
            value(if matches!(arg(0), Value::Undefined) {
                Value::Array(Vec::new())
            } else {
                arg(0).clone()
            })
        }),
        "applyCheckCorrection" => {
            let state = arg(0);
            value(checks::apply_check_correction(
                get(state, "checks"),
                get(state, "receipts"),
                get(state, "history"),
                arg(1),
            )?)
        }
        "isCheckCorrectionTransition" => value(Value::Bool(checks::is_check_correction_transition(arg(0), arg(1))?)),
        "validateTaskPrerequisites" => leaves::validate_task_prerequisites(arg(0)).and_then(|()| defaulted_array(args, 0)),
        "validateApprovedPlanRef" => leaves::validate_approved_plan_ref(arg(0)).and_then(|()| value(Value::Undefined)),
        "validatePrimaryStepBudget" => leaves::validate_primary_step_budget(arg(0)).and_then(|()| value(Value::Undefined)),
        "validateManagedExecutionBackend" => leaves::validate_managed_execution_backend(arg(0)).and_then(|()| same_or(args, 0)),
        "validateManagedNativeJobSegments" => leaves::validate_managed_native_job_segments(arg(0), arg(1)).and_then(|()| value(Value::Undefined)),
        "isManagedNativeJobReceiptTransition" => value(Value::Bool(leaves::is_managed_native_job_receipt_transition(arg(0), arg(1))?)),
        "validateManagedTransportRecovery" => value(leaves::validate_managed_transport_recovery(arg(0))?),
        "validateManagedTaskResultEnvelope" => envelope::validate_managed_task_result_envelope(arg(0)).and_then(|()| same_or(args, 0)),
        "validateManagedTaskAutoResume" => value(envelope::validate_managed_task_auto_resume(arg(0))?),
        "createManagedTaskResultEnvelope" => value(envelope::create_managed_task_result_envelope(arg(0), arg(1))?),
        "assertManagedTaskResultEnvelopeMatchesTask" => {
            envelope::assert_managed_task_result_envelope_matches_task(arg(0), arg(1)).and_then(|()| same_or(args, 1))
        }
        "taskPredicates" => {
            let (task, envelope) = (arg(0), arg(1));
            value(object(vec![
                ("terminal", Value::Bool(contract::is_terminal_managed_task_status(get(task, "status")))),
                ("pending", Value::Bool(contract::has_pending_operator_stop(task))),
                ("accepted", Value::Bool(contract::has_accepted_user_stop(task))),
                ("agentRetry", Value::Bool(contract::is_managed_task_agent_retry_available(task)?)),
                ("stopped", Value::Bool(contract::is_stopped_recovery_available(task, envelope)?)),
                ("userStopped", Value::Bool(contract::is_user_stopped_recovery_available(task, envelope)?)),
                ("manual", Value::Bool(contract::requires_manual_model_recovery(task, envelope)?)),
                ("eligible", Value::Bool(auto_resume::is_auto_resume_eligible(task, envelope)?)),
                ("backup", Value::Bool(leaves::is_managed_transport_backup_eligible(task)?)),
                ("disposition", Value::Bool(leaves::requires_managed_native_input_disposition(task)?)),
            ]))
        }
        "isStoppedRecoveryAvailable" => value(Value::Bool(contract::is_stopped_recovery_available(arg(0), arg(1))?)),
        "requiresManualModelRecovery" => value(Value::Bool(contract::requires_manual_model_recovery(arg(0), arg(1))?)),
        "requiresManagedNativeInputDisposition" => value(Value::Bool(leaves::requires_managed_native_input_disposition(arg(0))?)),
        "isAutoResumeEligible" => value(Value::Bool(auto_resume::is_auto_resume_eligible(arg(0), arg(1))?)),
        "toManagedTaskEvent" => value(contract::to_managed_task_event(arg(0), arg(1))?),
        "toManagedTaskRemovalEvent" => value(contract::to_managed_task_removal_event(arg(0))?),
        "decodeLedgerSnapshot" => {
            let options = arg(1);
            let tagged = |code: &str, detail: &Value| tagged_error(code, detail);
            let default = codec::DecodeOptions::default();
            let decode_options = codec::DecodeOptions {
                require_result_envelopes: matches!(get(options, "requireResultEnvelopes"), Value::Undefined) || truthy(get(options, "requireResultEnvelopes")),
                create_error: if text_is(get(options, "createError"), "tagged") {
                    &tagged
                } else {
                    default.create_error
                },
            };
            value(codec::decode_ledger_snapshot(arg(0), &decode_options)?)
        }
        "encodeLedgerSnapshot" => value(bytes_text(codec::encode_ledger_snapshot(arg(0))?)),
        "decodeManagedTaskRecord" => value(codec::decode_managed_task_record(arg(0))?),
        "decodeResultEnvelope" => value(codec::decode_result_envelope(arg(0))?),
        "compactManagedOrchestrationState" => value(persistence::compact_managed_orchestration_state(arg(0), arg(1))?),
        "isManagedNativeJobTombstone" => value(Value::Bool(persistence::is_managed_native_job_tombstone(arg(0))?)),
        "assertManagedTaskTransition" => {
            let same: Vec<JsStr> = arg(2).as_array().expect("identity keys").iter().map(|key| JsStr::from(text_of(key))).collect();
            let identical = |key: &JsStr| same.contains(key);
            transitions::assert_managed_task_transition(arg(0), arg(1), &identical).and_then(|()| same_or(args, 1))
        }
        "initialAutoResumeState" => {
            let params = arg(0);
            let field = |name: &str| get(params, name);
            value(auto_resume::initial_auto_resume_state(
                field("now"),
                field("enabled"),
                field("providerResetAt"),
                field("prior"),
                field("taskId"),
            )?)
        }
        "recordProviderRejection" => value(auto_resume::record_provider_rejection(
            arg(0),
            get(arg(1), "now"),
            get(arg(1), "providerResetAt"),
        )?),
        "planAutoResumeAttempt" => {
            let params = arg(0);
            let table = arg(1).clone();
            let breaker = move |provider: &Value| match provider {
                Value::String(id) => table.as_object().and_then(|table| table.get(id)).cloned().unwrap_or(Value::Undefined),
                _ => Value::Undefined,
            };
            let field = |name: &str| get(params, name);
            let input = auto_resume::PlanInput {
                now: field("now"),
                task: field("task"),
                state: field("state"),
                backup: field("backup"),
                breaker_until: if matches!(arg(1), Value::Null) { None } else { Some(&breaker) },
                provider_reset: field("providerReset"),
                origin: field("origin"),
                cursor_read_only: field("cursorReadOnly"),
            };
            value(auto_resume::plan_auto_resume_attempt(&input)?)
        }
        "buildAutoResumeAcknowledgeParams" => value(auto_resume::build_auto_resume_acknowledge_params(get(arg(0), "task"), get(arg(0), "envelope"))?),
        "decodeManagedNativeJobProofShard" => value(proof_store::decode_managed_native_job_proof_shard(arg(0), arg(1))?),
        "decodeManagedNativeJobProof" => value(proof_store::decode_managed_native_job_proof(arg(0))?),
        "encodeManagedNativeJobProofShard" => value(bytes_text(proof_store::encode_managed_native_job_proof_shard(arg(0), arg(1))?)),
        other => panic!("no Rust for vector function {other}"),
    }
}

fn text_is(value: &Value, text: &str) -> bool {
    matches!(value, Value::String(string) if *string == *text)
}

fn json(value: &Value) -> String {
    String::from_utf8(js::stringify_utf8(value).expect("not too deep").unwrap_or_default()).expect("UTF-8")
}

fn error_value(error: &JsError) -> Value {
    let mut entries = vec![("name", Value::string(&error.name)), ("message", Value::String(error.message.clone()))];
    if let Some(code) = &error.code {
        entries.push(("code", encode(code)));
    }
    object(entries)
}

#[derive(Default)]
struct Tally {
    rows: usize,
    refused: usize,
}

#[test]
fn every_vector_row_matches_the_javascript() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("vectors");
    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    let mut failures: Vec<String> = Vec::new();
    for file in FILES {
        let text = std::fs::read_to_string(dir.join(file)).unwrap_or_else(|error| panic!("{file}: {error}"));
        let mut bases: HashMap<String, Value> = HashMap::new();
        for (line_number, line) in text.lines().enumerate() {
            let row = js::parse(&units(line)).unwrap_or_else(|error| panic!("{file}:{}: {error:?}", line_number + 1));
            if let Value::String(name) = get(&row, "base") {
                let base = decode(get(&row, "value"), &bases);
                bases.insert(name.to_string_lossy(), base);
                continue;
            }
            let name = text_of(get(&row, "fn"));
            let args: Vec<Value> = get(&row, "args").as_array().expect("args").iter().map(|arg| decode(arg, &bases)).collect();
            let refuse = matches!(get(&row, "refuse"), Value::Bool(true));
            let tally = tallies.entry(name.clone()).or_default();
            tally.rows += 1;
            let expected = if matches!(get(&row, "ok"), Value::Undefined) {
                format!("throw {}", json(get(&row, "throw")))
            } else {
                format!("ok {}", json(get(&row, "ok")))
            };
            let actual = match run(&name, &args) {
                Ok(Outcome::Value(result)) => format!("ok {}", json(&encode(&result))),
                Ok(Outcome::Arg(index)) => format!("ok {{\"$\":\"arg\",\"index\":{index}}}"),
                Err(Failure::Throw(error)) => format!("throw {}", json(&error_value(&error))),
                Err(Failure::Unsupported(what)) => {
                    if refuse {
                        tally.refused += 1;
                        continue;
                    }
                    format!("refused ({what})")
                }
            };
            if refuse {
                failures.push(format!("{file}:{} {name}: must be refused, gave {}", line_number + 1, clip(&actual)));
            } else if actual != expected {
                failures.push(format!(
                    "{file}:{} {name}:\n  expected {}\n  actual   {}",
                    line_number + 1,
                    clip(&expected),
                    clip(&actual)
                ));
            }
        }
    }
    let total: usize = tallies.values().map(|tally| tally.rows).sum();
    for (name, tally) in &tallies {
        println!("{name}: {} rows, {} refused", tally.rows, tally.refused);
    }
    println!("{total} rows in {} functions", tallies.len());
    if !failures.is_empty() {
        let shown: Vec<&String> = failures.iter().take(25).collect();
        panic!(
            "{} of {total} rows differ from the JavaScript:\n{}",
            failures.len(),
            shown.iter().map(|line| line.as_str()).collect::<Vec<_>>().join("\n")
        );
    }
}

fn clip(text: &str) -> String {
    if text.chars().count() > 700 {
        format!("{}…", text.chars().take(700).collect::<String>())
    } else {
        text.to_owned()
    }
}
