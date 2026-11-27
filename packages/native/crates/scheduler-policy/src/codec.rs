//! `codec.js`: the persisted ledger's decoder and encoder. (The wire
//! decoders for host payloads are not ported; see DOCUMENTATION.md.)

use std::collections::{HashMap, HashSet};

use devryan_js_layer::js::{JsObject, JsStr, Value};

use crate::checks::{validate_check_correction_history, validate_required_check_receipts, validate_required_checks};
use crate::contract::validate_managed_task_record;
use crate::envelope::{assert_managed_task_result_envelope_matches_task, validate_managed_task_result_envelope};
use crate::error::{Failure, JsError, JsResult, type_error};
use crate::jsv::{EMPTY_ARRAY, as_number, as_str, get, is_finite, is_record, keys, nullish_or, object, spread, stringify_text};
use crate::text::{concat, units};

/// `TASK_LEGACY_DEFAULTS`: fields added after the first ledger release, set
/// (in this order) after the stored record's own fields.
const TASK_LEGACY_DEFAULTS: [(&str, Fallback); 8] = [
    ("dispatchGroupId", Fallback::Null),
    ("dispatchCallId", Fallback::Null),
    ("dispatchWaveId", Fallback::Null),
    ("readOnly", Fallback::False),
    ("recoveryLineageId", Fallback::Null),
    ("childPromptedAt", Fallback::Null),
    ("firstAssistantPartAt", Fallback::Null),
    ("waitingReason", Fallback::Null),
];
const ENVELOPE_LEGACY_DEFAULTS: [(&str, Fallback); 2] = [("providerResetAt", Fallback::Null), ("autoResume", Fallback::Null)];

#[derive(Clone, Copy)]
enum Fallback {
    Null,
    False,
}

/// `withLegacyDefaults(value, defaults)`: `{ ...value }`, then each default as
/// `record[field] = value?.[field] ?? fallback`.
fn with_legacy_defaults(value: &Value, defaults: &[(&str, Fallback)]) -> Value {
    let mut record = spread(value);
    for (field, fallback) in defaults {
        let fallback = match fallback {
            Fallback::Null => Value::Null,
            Fallback::False => Value::Bool(false),
        };
        record.set(field, nullish_or(get(value, field), &fallback).clone());
    }
    Value::Object(record)
}

/// `decodeManagedTaskRecord(value)`.
pub fn decode_managed_task_record(value: &Value) -> JsResult<Value> {
    let record = with_legacy_defaults(value, &TASK_LEGACY_DEFAULTS);
    validate_managed_task_record(&record)?;
    Ok(record)
}

/// `decodeResultEnvelope(value)`.
pub fn decode_result_envelope(value: &Value) -> JsResult<Value> {
    let record = with_legacy_defaults(value, &ENVELOPE_LEGACY_DEFAULTS);
    validate_managed_task_result_envelope(&record)?;
    Ok(record)
}

/// `LEDGER_ERROR_MESSAGES[code](detail)`.
pub fn ledger_error_message(code: &str, detail: &Value) -> JsStr {
    let part = |name: &str| {
        as_str(get(detail, name))
            .map(|text| text.units().to_vec())
            .unwrap_or_else(|| units("undefined"))
    };
    match code {
        "invalid_ledger_version" => JsStr::from("managed orchestration ledger version is invalid"),
        "invalid_ledger_collections" | "invalid_result_envelopes" => JsStr::from("managed orchestration ledger collections are invalid"),
        "duplicate_task" => concat(&[&units("duplicate managed task "), &part("taskId")]),
        "duplicate_idempotency_key" => concat(&[&units("duplicate managed idempotency key for root "), &part("rootSessionId")]),
        "duplicate_result_envelope" => concat(&[&units("duplicate managed result envelope for task "), &part("taskId")]),
        "orphan_result_envelope" => concat(&[&units("managed result envelope has no task "), &part("taskId")]),
        other => unreachable!("no ledger error {other}"),
    }
}

/// `defaultLedgerError(code, detail)`: a TypeError with its `code`.
pub fn default_ledger_error(code: &str, detail: &Value) -> JsError {
    JsError::new("TypeError", ledger_error_message(code, detail)).with_code(code)
}

/// The options of `decodeLedgerSnapshot`.
pub struct DecodeOptions<'a> {
    /// `requireResultEnvelopes` (default true).
    pub require_result_envelopes: bool,
    /// `createError(code, detail)` for the structural failures (default
    /// `default_ledger_error`). `detail` is the JavaScript's object:
    /// `{}`, `{ taskId }`, `{ rootSessionId }` or `{ taskId, envelopeId }`.
    pub create_error: &'a dyn Fn(&str, &Value) -> JsError,
}

impl Default for DecodeOptions<'_> {
    fn default() -> Self {
        DecodeOptions {
            require_result_envelopes: true,
            create_error: &default_ledger_error,
        }
    }
}

const OBJECTIVE_CHECK_FIELDS: [&str; 7] = [
    "rootSessionId",
    "directory",
    "objectiveId",
    "requiredChecks",
    "requiredCheckReceipts",
    "requiredCheckCorrections",
    "updatedAt",
];

fn validate_objective_checks(checks: &Value) -> JsResult<()> {
    let Some(records) = checks.as_array() else {
        return type_error("Invalid objective checks");
    };
    let mut identities: HashSet<[JsStr; 3]> = HashSet::new();
    for record in records {
        let parts = ["rootSessionId", "directory", "objectiveId"].map(|name| get(record, name));
        let updated = get(record, "updatedAt");
        if !is_record(record)
            || keys(record).iter().any(|key| !OBJECTIVE_CHECK_FIELDS.iter().any(|field| key == field))
            || parts.iter().any(|part| as_str(part).is_none_or(|text| text.is_empty() || text.len() > 4096))
            || (!matches!(updated, Value::Undefined) && (!is_finite(updated) || as_number(updated).is_some_and(|at| at < 0.0)))
        {
            return type_error("Invalid objective check scope");
        }
        let identity = parts.map(|part| as_str(part).expect("a checked part").clone());
        if !identities.insert(identity) {
            return type_error("Duplicate objective check scope");
        }
        validate_required_checks(get(record, "requiredChecks"))?;
        validate_required_check_receipts(get(record, "requiredCheckReceipts"), get(record, "requiredChecks"))?;
        validate_check_correction_history(get(record, "requiredCheckCorrections"))?;
    }
    Ok(())
}

/// `decodeLedgerSnapshot(value, options)`: the decoded snapshot.
pub fn decode_ledger_snapshot(value: &Value, options: &DecodeOptions<'_>) -> JsResult<Value> {
    let fail = |code: &str, detail: Value| -> Failure { Failure::throw((options.create_error)(code, &detail)) };
    let empty = || object(Vec::new());
    if !is_record(value) || as_number(get(value, "version")) != Some(1.0) {
        return Err(fail("invalid_ledger_version", empty()));
    }
    let (Some(candidates), envelopes) = (get(value, "tasks").as_array(), get(value, "resultEnvelopes")) else {
        return Err(fail("invalid_ledger_collections", empty()));
    };
    if options.require_result_envelopes && envelopes.as_array().is_none() {
        return Err(fail("invalid_ledger_collections", empty()));
    }
    let objective_checks = get(value, "objectiveChecks");
    if !matches!(objective_checks, Value::Undefined) {
        validate_objective_checks(objective_checks)?;
    }
    let mut tasks_by_id: HashMap<JsStr, usize> = HashMap::new();
    let mut tasks: Vec<Value> = Vec::new();
    let mut idempotency_keys: HashSet<Vec<u16>> = HashSet::new();
    for candidate in candidates {
        let task = decode_managed_task_record(candidate)?;
        let task_id = as_str(get(&task, "taskId")).expect("a validated task ID").clone();
        if tasks_by_id.contains_key(&task_id) {
            return Err(fail("duplicate_task", object(vec![("taskId", Value::String(task_id))])));
        }
        let root = as_str(get(&task, "rootSessionId")).expect("a validated root").clone();
        let key = concat(&[root.units(), &[0], as_str(get(&task, "idempotencyKey")).expect("a validated key").units()]).into_units();
        if idempotency_keys.contains(&key) {
            return Err(fail("duplicate_idempotency_key", object(vec![("rootSessionId", Value::String(root))])));
        }
        tasks_by_id.insert(task_id, tasks.len());
        tasks.push(task);
        idempotency_keys.insert(key);
    }
    let envelope_candidates = nullish_or(envelopes, &EMPTY_ARRAY);
    let Some(envelope_candidates) = envelope_candidates.as_array() else {
        return Err(fail("invalid_result_envelopes", empty()));
    };
    let mut envelope_task_ids: HashSet<JsStr> = HashSet::new();
    let mut result_envelopes = Vec::new();
    for candidate in envelope_candidates {
        let envelope = decode_result_envelope(candidate)?;
        let task_id = as_str(get(&envelope, "taskId")).expect("a validated task ID").clone();
        let detail = || {
            object(vec![
                ("taskId", Value::String(task_id.clone())),
                ("envelopeId", get(&envelope, "envelopeId").clone()),
            ])
        };
        if envelope_task_ids.contains(&task_id) {
            return Err(fail("duplicate_result_envelope", detail()));
        }
        let Some(&index) = tasks_by_id.get(&task_id) else {
            return Err(fail("orphan_result_envelope", detail()));
        };
        assert_managed_task_result_envelope_matches_task(&tasks[index], &envelope)?;
        envelope_task_ids.insert(task_id);
        result_envelopes.push(envelope);
    }
    let mut snapshot: JsObject = spread(value);
    snapshot.set("tasks", Value::Array(tasks));
    snapshot.set("resultEnvelopes", Value::Array(result_envelopes));
    Ok(Value::Object(snapshot))
}

/// `encodeLedgerSnapshot(snapshot)`: the persisted bytes,
/// `JSON.stringify(decodeLedgerSnapshot(snapshot)) + '\n'`, as UTF-8.
pub fn encode_ledger_snapshot(snapshot: &Value) -> JsResult<Vec<u8>> {
    let decoded = decode_ledger_snapshot(snapshot, &DecodeOptions::default())?;
    let mut bytes = stringify_text(&decoded)?;
    bytes.push(b'\n');
    Ok(bytes)
}
