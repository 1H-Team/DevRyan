//! `native-job-proof-store.js`: which shard holds a released native proof,
//! and the shard document's codec.

use std::collections::HashMap;

use devryan_js_layer::js::{JsStr, Value};

use crate::codec::{DecodeOptions, decode_ledger_snapshot};
use crate::error::{Failure, JsError, JsResult, coded_type_error, unsupported};
use crate::jsv::{as_str, get, is_record, keys, object, read, strict_equal, stringify_text};
use crate::persistence::is_managed_native_job_tombstone;
use crate::text::{concat, units};

pub const MANAGED_NATIVE_JOB_PROOF_DIRECTORY: &str = "native-job-proofs";
pub const MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT: u32 = 64;
pub const MANAGED_NATIVE_JOB_PROOF_SHARD_MAX_BYTES: u64 = 32 * 1024 * 1024;
const DOCUMENT_KEYS: [&str; 4] = ["version", "shard", "tasks", "resultEnvelopes"];
const SHARD_INVALID: &str = "native_job_proof_shard_invalid";
const PROOF_INVALID: &str = "native_job_proof_invalid";

/// `MANAGED_NATIVE_JOB_PROOF_SHARDS[index]`: two lowercase hex digits.
fn shard_name(index: u32) -> String {
    format!("{index:02x}")
}

/// `isManagedNativeJobProofShard(value)`.
pub fn is_managed_native_job_proof_shard(value: &Value) -> bool {
    as_str(value).is_some_and(|text| (0..MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT).any(|index| *text == *shard_name(index)))
}

/// `managedNativeJobProofShard(taskId)`: 32-bit FNV-1a over the UTF-16 units.
pub fn managed_native_job_proof_shard(task_id: &Value) -> JsResult<String> {
    let Some(text) = as_str(task_id).filter(|text| !text.is_empty()) else {
        return coded_type_error("native job proof task ID is invalid", PROOF_INVALID);
    };
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.units() {
        hash ^= u32::from(*unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    Ok(shard_name(hash % MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT))
}

/// `managedNativeJobProofShardFile(shard)`.
pub fn managed_native_job_proof_shard_file(shard: &Value) -> JsResult<JsStr> {
    if !is_managed_native_job_proof_shard(shard) {
        return coded_type_error("native job proof shard name is invalid", SHARD_INVALID);
    }
    Ok(concat(&[as_str(shard).expect("a shard").units(), &units(".json")]))
}

fn shard_error(shard: &Value, detail: &str) -> JsError {
    let name = if is_managed_native_job_proof_shard(shard) {
        as_str(shard).expect("a shard").to_string_lossy()
    } else {
        "?".to_owned()
    };
    JsError::new("TypeError", format!("native job proof shard {name} is invalid: {detail}")).with_code(SHARD_INVALID)
}

/// `decodeManagedNativeJobProofShard(value, shard)`: `[{ task, envelope }]`.
pub fn decode_managed_native_job_proof_shard(value: &Value, shard: &Value) -> JsResult<Value> {
    let invalid = |detail: &str| Failure::throw(shard_error(shard, detail));
    if !is_managed_native_job_proof_shard(shard) {
        return Err(invalid("name"));
    }
    if !is_record(value)
        || !strict_equal(get(value, "shard"), shard)?
        || keys(value).iter().any(|key| !DOCUMENT_KEYS.iter().any(|known| key == *known))
        || get(value, "resultEnvelopes").as_array().is_none()
    {
        return Err(invalid("document"));
    }
    let create_error = |code: &str, _detail: &Value| shard_error(shard, code);
    let options = DecodeOptions {
        require_result_envelopes: true,
        create_error: &create_error,
    };
    let ledger = match decode_ledger_snapshot(value, &options) {
        Ok(ledger) => ledger,
        Err(Failure::Throw(error)) if error.code.as_ref().is_some_and(|code| as_str(code).is_some_and(|code| code == SHARD_INVALID)) => {
            return Err(Failure::Throw(error));
        }
        Err(Failure::Throw(_)) => return Err(invalid("record")),
        Err(refusal) => return Err(refusal),
    };
    let tasks = get(&ledger, "tasks").as_array().expect("decoded tasks");
    let envelopes = get(&ledger, "resultEnvelopes").as_array().expect("decoded envelopes");
    if tasks.len() != envelopes.len() {
        return Err(invalid("envelope"));
    }
    let by_task: HashMap<&JsStr, &Value> = envelopes
        .iter()
        .map(|envelope| (as_str(get(envelope, "taskId")).expect("a decoded ID"), envelope))
        .collect();
    let mut proofs = Vec::new();
    for task in tasks {
        let task_id = as_str(get(task, "taskId")).expect("a decoded ID");
        let Some(envelope) = by_task.get(task_id) else {
            return Err(invalid("proof"));
        };
        if !is_managed_native_job_tombstone(task)? || managed_native_job_proof_shard(get(task, "taskId"))? != as_str(shard).expect("a shard").to_string_lossy()
        {
            return Err(invalid("proof"));
        }
        proofs.push(object(vec![("task", task.clone()), ("envelope", (*envelope).clone())]));
    }
    Ok(Value::Array(proofs))
}

/// `decodeManagedNativeJobProof(entry)`: the decoded `{ task, envelope }`.
pub fn decode_managed_native_job_proof(entry: &Value) -> JsResult<Value> {
    let shard = Value::string(&managed_native_job_proof_shard(get(get(entry, "task"), "taskId"))?);
    let document = object(vec![
        ("version", Value::Number(1.0)),
        ("shard", shard.clone()),
        ("tasks", Value::Array(vec![get(entry, "task").clone()])),
        ("resultEnvelopes", Value::Array(vec![get(entry, "envelope").clone()])),
    ]);
    let mut proofs = decode_managed_native_job_proof_shard(&document, &shard)?;
    Ok(proofs.take_array().expect("an array").swap_remove(0))
}

/// `encodeManagedNativeJobProofShard(shard, entries)`: the shard file's text as UTF-8.
pub fn encode_managed_native_job_proof_shard(shard: &Value, entries: &Value) -> JsResult<Vec<u8>> {
    if !is_managed_native_job_proof_shard(shard) {
        return coded_type_error("native job proof shard name is invalid", SHARD_INVALID);
    }
    let Some(entries) = entries.as_array() else {
        return unsupported("proof entries that are not an array");
    };
    let mut sorted: Vec<&Value> = entries.iter().collect();
    if sorted.len() >= 2 {
        // The comparator runs: every task ID must be a string for `<` to be code-unit order.
        if sorted.iter().any(|entry| as_str(get(get(entry, "task"), "taskId")).is_none()) {
            return unsupported("proof entries whose task IDs are not strings");
        }
        sorted.sort_by(|left, right| as_str(get(get(left, "task"), "taskId")).cmp(&as_str(get(get(right, "task"), "taskId"))));
    }
    let name = as_str(shard).expect("a shard").to_string_lossy();
    for entry in &sorted {
        let task_id = read(read(entry, "task")?, "taskId")?;
        if managed_native_job_proof_shard(task_id)? != name || !strict_equal(get(get(entry, "envelope"), "taskId"), task_id)? {
            return coded_type_error(format!("native job proof does not belong to shard {name}"), PROOF_INVALID);
        }
    }
    let document = object(vec![
        ("version", Value::Number(1.0)),
        ("shard", shard.clone()),
        ("tasks", Value::Array(sorted.iter().map(|entry| get(entry, "task").clone()).collect())),
        (
            "resultEnvelopes",
            Value::Array(sorted.iter().map(|entry| get(entry, "envelope").clone()).collect()),
        ),
    ]);
    let mut bytes = stringify_text(&document)?;
    bytes.push(b'\n');
    Ok(bytes)
}
