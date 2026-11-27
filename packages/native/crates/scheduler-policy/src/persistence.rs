//! `persistence.js`: ledger retention (`compactManagedOrchestrationState`)
//! and the native proof tombstone.
//!
//! Domain (refused otherwise, before any work): `options.now` is a number
//! (the JavaScript reads the wall clock when it is absent); every task and
//! envelope is an object; task and envelope IDs, roots and lineage IDs are
//! strings; prior and parent IDs are strings or nullish; timestamps and
//! sequences are numbers, `null`, `undefined` or booleans; every value sorted
//! by `terminalOldestFirst` has a finite age and sequence (else V8's sort
//! order depends on its algorithm) and an ID over `[_0-9a-z]`; no
//! `priorTaskId` chain is a cycle reached from a live task (the JavaScript
//! never returns there).

use std::collections::{HashMap, HashSet};

use devryan_js_layer::js::{JsObject, JsStr, Value};

use crate::auto_resume::{create_lineage_id, is_auto_resume_active};
use crate::contract::is_terminal_managed_task_status;
use crate::error::{JsResult, unsupported};
use crate::jsv::{UNDEFINED, as_str, get, is_nullish, is_str, math_max, nullish_or, object, read, spread, stringify_text, to_number, truthy};
use crate::leaves::{length_above_zero, requires_managed_native_input_disposition};
use crate::primitives::locale_compare_ids;

pub const DEFAULT_MANAGED_TERMINAL_MAX_RECORDS: f64 = 2_000.0;
pub const DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS: f64 = 14.0 * 24.0 * 60.0 * 60.0 * 1_000.0;
pub const DEFAULT_MANAGED_LEDGER_MAX_BYTES: f64 = 20.0 * 1024.0 * 1024.0;
pub const MAX_RETAINED_LINEAGE_RECORDS: usize = 3;
pub const MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT: &str = "Released native job proof";

/// `retainsManagedNativeJobProof(task)`.
fn retains_managed_native_job_proof(task: &Value) -> JsResult<bool> {
    if !is_terminal_managed_task_status(read(task, "status")?)
        || !is_str(get(task, "executionBackend"), "native-job")
        || !length_above_zero(get(task, "nativeJobSegments"))?
    {
        return Ok(false);
    }
    if requires_managed_native_input_disposition(task)? {
        return Ok(true);
    }
    let Some(segments) = get(task, "nativeJobSegments").as_array() else {
        return unsupported("nativeJobSegments with a length that is not an array");
    };
    for segment in segments {
        if !is_str(read(segment, "completion")?, "done") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `isManagedNativeJobTombstone(task)`.
pub fn is_managed_native_job_tombstone(task: &Value) -> JsResult<bool> {
    Ok(retains_managed_native_job_proof(task)? && is_str(get(task, "prompt"), MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT))
}

const RELEASED_TASK_FIELDS: [&str; 7] = [
    "approvedPlanRef",
    "taskPrerequisites",
    "requiredChecks",
    "requiredCheckReceipts",
    "requiredCheckCorrections",
    "primaryStepBudget",
    "dispatchObjectiveId",
];

fn release_bodies(object: &mut JsObject) {
    object.set("failureReason", Value::Null);
    object.set("recoverablePreview", Value::string(""));
    object.set("canonicalRefs", Value::Array(Vec::new()));
}

/// `toManagedNativeJobTombstone(task, envelope)`: (task, envelope or null).
fn to_managed_native_job_tombstone(task: &Value, envelope: Option<&Value>) -> (Value, Value) {
    let mut retained = spread(task);
    for field in RELEASED_TASK_FIELDS {
        retained.remove(&JsStr::from(field));
    }
    release_bodies(&mut retained);
    retained.set("prompt", Value::string(MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT));
    for field in ["dispatchGroupId", "dispatchCallId", "dispatchWaveId", "transportRecovery"] {
        retained.set(field, Value::Null);
    }
    let envelope = envelope.map_or(Value::Null, |envelope| {
        let mut copy = spread(envelope);
        release_bodies(&mut copy);
        Value::Object(copy)
    });
    (Value::Object(retained), envelope)
}

fn id(value: &Value, field: &str) -> JsStr {
    as_str(get(value, field)).expect("a checked string").clone()
}

/// `taskAgeTimestamp(task)` as a number.
fn age(task: &Value) -> JsResult<f64> {
    to_number(nullish_or(get(task, "finishedAt"), get(task, "createdAt")))
}

/// `terminalOldestFirst(left, right)` for tasks with finite ages and sequences.
fn terminal_oldest_first(left: &Value, right: &Value) -> JsResult<std::cmp::Ordering> {
    let by_age = age(left)? - age(right)?;
    if truthy(&Value::Number(by_age)) {
        return Ok(by_age.partial_cmp(&0.0).expect("finite"));
    }
    let by_sequence = to_number(get(left, "sequence"))? - to_number(get(right, "sequence"))?;
    if truthy(&Value::Number(by_sequence)) {
        return Ok(by_sequence.partial_cmp(&0.0).expect("finite"));
    }
    Ok(locale_compare_ids(&id(left, "taskId"), &id(right, "taskId"))?
        .partial_cmp(&0.0)
        .expect("finite"))
}

/// Sorts tasks with `terminalOldestFirst`, refusing a set it would not order consistently.
fn sort_oldest_first(tasks: &[Value], indices: &mut [usize]) -> JsResult<()> {
    for index in indices.iter() {
        let task = &tasks[*index];
        if !age(task)?.is_finite() || !to_number(get(task, "sequence"))?.is_finite() {
            return unsupported("terminalOldestFirst over a task without a finite age and sequence");
        }
        locale_compare_ids(&id(task, "taskId"), &id(task, "taskId"))?;
    }
    let mut failure = None;
    indices.sort_by(|left, right| match terminal_oldest_first(&tasks[*left], &tasks[*right]) {
        Ok(order) => order,
        Err(error) => {
            failure.get_or_insert(error);
            std::cmp::Ordering::Equal
        }
    });
    failure.map_or(Ok(()), Err)
}

fn check_domain(tasks: &[Value], envelopes: &[Value]) -> JsResult<()> {
    for task in tasks {
        if !matches!(task, Value::Object(_)) {
            return unsupported("a compaction task that is not an object");
        }
        for field in ["taskId", "rootSessionId"] {
            if as_str(get(task, field)).is_none() {
                return unsupported("a compaction task ID or root that is not a string");
            }
        }
        for field in ["priorTaskId", "parentTaskId", "recoveryLineageId"] {
            let value = get(task, field);
            if !is_nullish(value) && as_str(value).is_none() {
                return unsupported("a compaction prior, parent or lineage ID that is not a string");
            }
        }
        for field in ["createdAt", "startedAt", "finishedAt", "sequence"] {
            to_number(get(task, field))?;
        }
        for field in ["nativeJobSegments", "taskPrerequisites"] {
            let value = get(task, field);
            if !is_nullish(value) && value.as_array().is_none() {
                return unsupported("compaction segments or prerequisites that are not an array");
            }
        }
    }
    for envelope in envelopes {
        if !matches!(envelope, Value::Object(_)) || as_str(get(envelope, "taskId")).is_none() {
            return unsupported("a compaction envelope that is not an object with a string task ID");
        }
        for field in ["createdAt", "acknowledgedAt"] {
            to_number(get(envelope, field))?;
        }
    }
    Ok(())
}

struct Ledger<'a> {
    tasks: &'a [Value],
    envelopes: &'a [Value],
    envelope_by_task: HashMap<JsStr, usize>,
    task_by_id: HashMap<JsStr, usize>,
}

impl Ledger<'_> {
    fn envelope_of(&self, task_id: &JsStr) -> Option<&Value> {
        self.envelope_by_task.get(task_id).map(|index| &self.envelopes[*index])
    }

    fn task(&self, task_id: &JsStr) -> Option<&Value> {
        self.task_by_id.get(task_id).map(|index| &self.tasks[*index])
    }
}

fn collect_active_roots(ledger: &Ledger<'_>, now: f64, max_age_ms: f64) -> JsResult<HashSet<JsStr>> {
    let mut active = HashSet::new();
    for task in ledger.tasks {
        let root = id(task, "rootSessionId");
        if active.contains(&root) {
            continue;
        }
        let envelope = ledger.envelope_of(&id(task, "taskId")).unwrap_or(&UNDEFINED);
        let zero = Value::Number(0.0);
        let latest = math_max(&[
            to_number(nullish_or(get(task, "createdAt"), &zero))?,
            to_number(nullish_or(get(task, "startedAt"), &zero))?,
            to_number(nullish_or(get(task, "finishedAt"), &zero))?,
            to_number(nullish_or(get(envelope, "createdAt"), &zero))?,
            to_number(nullish_or(get(envelope, "acknowledgedAt"), &zero))?,
        ]);
        if !is_terminal_managed_task_status(get(task, "status")) || now - latest <= max_age_ms {
            active.insert(root);
        }
    }
    Ok(active)
}

struct Protection {
    hard: HashSet<JsStr>,
    protected: HashSet<JsStr>,
    proofs: HashSet<JsStr>,
}

fn collect_protected_task_ids(ledger: &Ledger<'_>, now: f64, max_age_ms: f64, expire_unacknowledged: bool) -> JsResult<Protection> {
    let mut hard = HashSet::new();
    let mut protected = HashSet::new();
    let mut proofs = HashSet::new();
    let prior_ids: HashSet<JsStr> = ledger
        .tasks
        .iter()
        .filter_map(|task| as_str(get(task, "priorTaskId")).filter(|id| !id.is_empty()).cloned())
        .collect();
    let active_roots = if expire_unacknowledged && max_age_ms.is_finite() {
        Some(collect_active_roots(ledger, now, max_age_ms)?)
    } else {
        None
    };
    let root_active = |root: Option<JsStr>| active_roots.as_ref().is_none_or(|roots| root.is_some_and(|root| roots.contains(&root)));
    let unacknowledged = |task_id: &JsStr| {
        ledger
            .envelope_of(task_id)
            .is_some_and(|envelope| matches!(get(envelope, "action"), Value::Null))
            && root_active(ledger.task(task_id).map(|task| id(task, "rootSessionId")))
    };
    for (position, task) in ledger.tasks.iter().enumerate() {
        let task_id = id(task, "taskId");
        let terminal = is_terminal_managed_task_status(get(task, "status"));
        if retains_managed_native_job_proof(task)? {
            proofs.insert(task_id.clone());
        }
        if !terminal {
            hard.insert(task_id.clone());
            for reference in get(task, "taskPrerequisites").as_array().unwrap_or_default() {
                if let Some(producer) = as_str(read(reference, "taskId")?)
                    && ledger.task_by_id.contains_key(producer)
                {
                    hard.insert(producer.clone());
                }
            }
        }
        let grouped = !matches!(get(task, "dispatchGroupId"), Value::Null);
        if grouped && unacknowledged(&task_id) {
            hard.insert(task_id.clone());
        }
        let envelope = ledger.envelope_of(&task_id);
        if grouped
            && envelope.is_some_and(|envelope| is_str(get(envelope, "action"), "collect"))
            && length_above_zero(get(task, "requiredChecks"))?
            && root_active(Some(id(task, "rootSessionId")))
        {
            hard.insert(task_id.clone());
        }
        if envelope.is_some_and(is_auto_resume_active) {
            hard.insert(task_id.clone());
        }
        if let Some(parent) = as_str(get(task, "parentTaskId")).filter(|parent| !parent.is_empty())
            && !terminal
        {
            hard.insert(parent.clone());
        }
        let prior = as_str(get(task, "priorTaskId")).filter(|prior| !prior.is_empty());
        let Some(prior) = prior.filter(|_| !prior_ids.contains(&task_id)) else {
            continue;
        };
        let parked = terminal && (unacknowledged(&task_id) || envelope.is_some_and(is_auto_resume_active));
        if terminal && !parked {
            continue;
        }
        hard.insert(prior.clone());
        // The walk visits record objects: the first is this one, the others
        // come from the ID map, so a repeated index is a cycle.
        let mut current = Some(position);
        let mut walked = HashSet::new();
        while let Some(index) = current {
            if !walked.insert(index) {
                return unsupported("a priorTaskId cycle reached from a live task (the JavaScript never returns)");
            }
            let member = &ledger.tasks[index];
            protected.insert(id(member, "taskId"));
            current = as_str(get(member, "priorTaskId"))
                .filter(|prior| !prior.is_empty())
                .and_then(|prior| ledger.task_by_id.get(prior).copied());
        }
    }
    for task_id in &hard {
        protected.insert(task_id.clone());
    }
    Ok(Protection { hard, protected, proofs })
}

/// `lineageKeyOf(task, taskById)`.
fn lineage_key_of(task: &Value, ledger: &Ledger<'_>) -> JsResult<JsStr> {
    if let Some(lineage) = as_str(get(task, "recoveryLineageId")).filter(|lineage| !lineage.is_empty()) {
        return Ok(lineage.clone());
    }
    let mut current = task;
    let mut seen = HashSet::from([id(task, "taskId")]);
    while let Some(prior_id) = as_str(get(current, "priorTaskId")).filter(|prior| !prior.is_empty() && !seen.contains(*prior)) {
        let Some(prior) = ledger.task(prior_id) else {
            break;
        };
        seen.insert(id(prior, "taskId"));
        current = prior;
    }
    create_lineage_id(get(current, "taskId"))
}

fn collect_eager_lineage_removals(ledger: &Ledger<'_>, hard: &HashSet<JsStr>) -> JsResult<Vec<usize>> {
    let mut lineages: Vec<(JsStr, Vec<usize>)> = Vec::new();
    for (index, task) in ledger.tasks.iter().enumerate() {
        let task_id = id(task, "taskId");
        if !is_terminal_managed_task_status(get(task, "status")) || hard.contains(&task_id) || is_managed_native_job_tombstone(task)? {
            continue;
        }
        let Some(envelope) = ledger.envelope_of(&task_id) else {
            continue;
        };
        if matches!(get(envelope, "action"), Value::Null) {
            continue;
        }
        let key = lineage_key_of(task, ledger)?;
        match lineages.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, members)) => members.push(index),
            None => lineages.push((key, vec![index])),
        }
    }
    let mut removals = Vec::new();
    for (_, mut members) in lineages {
        if members.len() <= MAX_RETAINED_LINEAGE_RECORDS {
            continue;
        }
        sort_oldest_first(ledger.tasks, &mut members)?;
        removals.extend_from_slice(&members[..members.len() - MAX_RETAINED_LINEAGE_RECORDS]);
    }
    Ok(removals)
}

struct Tombstone {
    task: Value,
    envelope: Value,
}

struct Compaction<'a> {
    ledger: Ledger<'a>,
    proofs: HashSet<JsStr>,
    removed: HashSet<JsStr>,
    removed_ids: Vec<JsStr>,
    tombstones: HashMap<JsStr, Tombstone>,
    tombstoned_ids: Vec<JsStr>,
    objective_checks: Option<Value>,
}

impl Compaction<'_> {
    fn is_tombstone(&self, task: &Value) -> JsResult<bool> {
        Ok(self.tombstones.contains_key(&id(task, "taskId")) || is_managed_native_job_tombstone(task)?)
    }

    /// `removeTask(task)`: whether it made a tombstone (whose bytes the caller counts).
    fn remove_task(&mut self, index: usize) -> JsResult<bool> {
        let task = &self.ledger.tasks[index];
        let task_id = id(task, "taskId");
        if self.removed.contains(&task_id) {
            return Ok(false);
        }
        if self.proofs.contains(&task_id) {
            if self.is_tombstone(task)? {
                return Ok(false);
            }
            let (task, envelope) = to_managed_native_job_tombstone(task, self.ledger.envelope_of(&task_id));
            self.tombstones.insert(task_id.clone(), Tombstone { task, envelope });
            self.tombstoned_ids.push(task_id);
            return Ok(true);
        }
        self.removed.insert(task_id.clone());
        self.removed_ids.push(task_id);
        Ok(false)
    }

    /// `buildState()`: the tasks and envelopes kept, tombstones in place.
    fn build_state(&self) -> (Vec<Value>, Vec<Value>) {
        let tasks = self
            .ledger
            .tasks
            .iter()
            .filter(|task| !self.removed.contains(&id(task, "taskId")))
            .map(|task| {
                self.tombstones
                    .get(&id(task, "taskId"))
                    .map_or_else(|| task.clone(), |tombstone| tombstone.task.clone())
            })
            .collect();
        let envelopes = self
            .ledger
            .envelopes
            .iter()
            .filter(|envelope| !self.removed.contains(&id(envelope, "taskId")))
            .map(|envelope| match self.tombstones.get(&id(envelope, "taskId")) {
                Some(tombstone) if !matches!(tombstone.envelope, Value::Null) => tombstone.envelope.clone(),
                _ => envelope.clone(),
            })
            .collect();
        (tasks, envelopes)
    }

    fn counted_terminal(&self, tasks: &[Value]) -> JsResult<usize> {
        let mut count = 0;
        for task in tasks {
            if is_terminal_managed_task_status(get(task, "status")) && !self.is_tombstone(task)? {
                count += 1;
            }
        }
        Ok(count)
    }

    fn state_value(&self, tasks: Vec<Value>, envelopes: Vec<Value>) -> Value {
        let mut state = JsObject::new();
        state.set("version", Value::Number(1.0));
        if let Some(checks) = &self.objective_checks {
            state.set("objectiveChecks", checks.clone());
        }
        state.set("tasks", Value::Array(tasks));
        state.set("resultEnvelopes", Value::Array(envelopes));
        Value::Object(state)
    }
}

fn byte_length(value: &Value) -> JsResult<i64> {
    Ok(stringify_text(value)?.len() as i64)
}

/// `compactManagedOrchestrationState(input, options = {})`:
/// `{ state, removedTaskIds, tombstonedTaskIds, proofTaskIds, serializedBytes, overLimit }`.
pub fn compact_managed_orchestration_state(input: &Value, options: &Value) -> JsResult<Value> {
    if matches!(options, Value::Null) {
        return crate::error::type_error("Cannot read properties of null (reading 'now')");
    }
    let now = match get(options, "now") {
        Value::Number(now) => *now,
        value if is_nullish(value) => return unsupported("compaction without options.now (the JavaScript reads the wall clock)"),
        _ => return unsupported("compaction with an options.now that is not a number"),
    };
    let number_option = |name: &str, fallback: f64| match nullish_or(get(options, name), &Value::Undefined) {
        Value::Undefined => fallback,
        Value::Number(number) => *number,
        // Not a number: Number.isFinite is false, so the cap is off.
        _ => f64::NAN,
    };
    let max_terminal_records = number_option("maxTerminalRecords", DEFAULT_MANAGED_TERMINAL_MAX_RECORDS);
    let max_age_ms = number_option("maxAgeMs", DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS);
    let max_bytes = number_option("maxBytes", DEFAULT_MANAGED_LEDGER_MAX_BYTES);
    let expire_unacknowledged = !matches!(get(options, "expireUnacknowledged"), Value::Bool(false));
    let tasks: &[Value] = get(input, "tasks").as_array().unwrap_or_default();
    let envelopes: &[Value] = get(input, "resultEnvelopes").as_array().unwrap_or_default();
    check_domain(tasks, envelopes)?;
    let ledger = Ledger {
        tasks,
        envelopes,
        envelope_by_task: envelopes.iter().enumerate().map(|(index, envelope)| (id(envelope, "taskId"), index)).collect(),
        task_by_id: tasks.iter().enumerate().map(|(index, task)| (id(task, "taskId"), index)).collect(),
    };
    let protection = collect_protected_task_ids(&ledger, now, max_age_ms, expire_unacknowledged)?;
    let mut removable: Vec<usize> = Vec::new();
    for (index, task) in tasks.iter().enumerate() {
        if is_terminal_managed_task_status(get(task, "status")) && !protection.protected.contains(&id(task, "taskId")) {
            removable.push(index);
        }
    }
    sort_oldest_first(tasks, &mut removable)?;
    let eager = collect_eager_lineage_removals(&ledger, &protection.hard)?;
    // `input.objectiveChecks?.length ? { objectiveChecks: … } : {}` (read after the removals start).
    let objective_checks = match read(input, "objectiveChecks")? {
        Value::Array(items) if !items.is_empty() => Some(Value::Array(items.clone())),
        Value::String(text) if !text.is_empty() => return unsupported("objectiveChecks that is a string"),
        Value::Object(object) if object.get_str("length").is_some() => return unsupported("objectiveChecks that is an object with a length"),
        _ => None,
    };
    let mut run = Compaction {
        ledger,
        proofs: protection.proofs,
        removed: HashSet::new(),
        removed_ids: Vec::new(),
        tombstones: HashMap::new(),
        tombstoned_ids: Vec::new(),
        objective_checks,
    };
    for index in eager {
        run.remove_task(index)?;
    }
    if max_age_ms.is_finite() {
        for &index in &removable {
            if now - age(&tasks[index])? > max_age_ms {
                run.remove_task(index)?;
            }
        }
    }
    let (mut kept_tasks, mut kept_envelopes) = run.build_state();
    let mut terminal_count = run.counted_terminal(&kept_tasks)? as f64;
    if max_terminal_records.is_finite() {
        for &index in &removable {
            if terminal_count <= max_terminal_records {
                break;
            }
            let task = &tasks[index];
            if run.removed.contains(&id(task, "taskId")) || run.is_tombstone(task)? {
                continue;
            }
            run.remove_task(index)?;
            terminal_count -= 1.0;
        }
        (kept_tasks, kept_envelopes) = run.build_state();
    }

    let mut task_bytes: HashMap<JsStr, i64> = HashMap::new();
    let mut task_order: Vec<JsStr> = Vec::new();
    for task in &kept_tasks {
        let task_id = id(task, "taskId");
        if !task_bytes.contains_key(&task_id) {
            task_order.push(task_id.clone());
        }
        task_bytes.insert(task_id, byte_length(task)?);
    }
    let mut envelope_bytes: HashMap<JsStr, (i64, i64)> = HashMap::new();
    for envelope in &kept_envelopes {
        let entry = envelope_bytes.entry(id(envelope, "taskId")).or_insert((0, 0));
        entry.0 += byte_length(envelope)?;
        entry.1 += 1;
    }
    let mut task_count = kept_tasks.len() as i64;
    let mut envelope_count = kept_envelopes.len() as i64;
    let separators = |count: i64| (count - 1).max(0);
    let shell = run.state_value(Vec::new(), Vec::new());
    let mut serialized_bytes = byte_length(&shell)?
        + task_order.iter().map(|task_id| task_bytes[task_id]).sum::<i64>()
        + envelope_bytes.values().map(|entry| entry.0).sum::<i64>()
        + separators(task_count)
        + separators(envelope_count);
    let mut tombstone_bytes = 0i64;
    for task in &kept_tasks {
        if run.is_tombstone(task)? {
            let task_id = id(task, "taskId");
            tombstone_bytes += task_bytes[&task_id] + envelope_bytes.get(&task_id).map_or(0, |entry| entry.0);
        }
    }
    if max_bytes.is_finite() {
        for &index in &removable {
            if ((serialized_bytes - tombstone_bytes) as f64) <= max_bytes {
                break;
            }
            let task = &tasks[index];
            let task_id = id(task, "taskId");
            if run.removed.contains(&task_id) || run.is_tombstone(task)? {
                continue;
            }
            let (bytes_of_envelopes, envelopes_of_task) = envelope_bytes.get(&task_id).copied().unwrap_or((0, 0));
            if run.remove_task(index)? {
                let tombstone = &run.tombstones[&task_id];
                let bytes = byte_length(&tombstone.task)?
                    + if matches!(tombstone.envelope, Value::Null) {
                        0
                    } else {
                        byte_length(&tombstone.envelope)?
                    };
                serialized_bytes += bytes - task_bytes[&task_id] - bytes_of_envelopes;
                tombstone_bytes += bytes;
                continue;
            }
            serialized_bytes -= task_bytes[&task_id] + bytes_of_envelopes + separators(task_count) - separators(task_count - 1) + separators(envelope_count)
                - separators(envelope_count - envelopes_of_task);
            task_count -= 1;
            envelope_count -= envelopes_of_task;
        }
        (kept_tasks, kept_envelopes) = run.build_state();
    }

    let terminal_count = run.counted_terminal(&kept_tasks)? as f64;
    let envelope_task_ids: HashSet<JsStr> = kept_envelopes.iter().map(|envelope| id(envelope, "taskId")).collect();
    let mut proof_task_ids = Vec::new();
    for task in &kept_tasks {
        let task_id = id(task, "taskId");
        if run.is_tombstone(task)? && !protection.hard.contains(&task_id) && envelope_task_ids.contains(&task_id) {
            proof_task_ids.push(Value::String(task_id));
        }
    }
    let over_limit = (max_terminal_records.is_finite() && terminal_count > max_terminal_records)
        || (max_bytes.is_finite() && ((serialized_bytes - tombstone_bytes) as f64) > max_bytes);
    let strings = |ids: &[JsStr]| Value::Array(ids.iter().cloned().map(Value::String).collect());
    Ok(object(vec![
        ("state", run.state_value(kept_tasks, kept_envelopes)),
        ("removedTaskIds", strings(&run.removed_ids)),
        ("tombstonedTaskIds", strings(&run.tombstoned_ids)),
        ("proofTaskIds", Value::Array(proof_task_ids)),
        ("serializedBytes", Value::Number(serialized_bytes as f64)),
        ("overLimit", Value::Bool(over_limit)),
    ]))
}
