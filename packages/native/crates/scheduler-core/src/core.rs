//! The scheduler (`createManagedTaskScheduler`, `packages/orchestration-runtime/
//! scheduler.js`), ported function for function. Each Rust function names the
//! JavaScript it ports by line (`scheduler.js:N`); every `await` of the
//! JavaScript on a ported path is one await here, marked
//! `// await scheduler.js:N` (the marks are the audit: JavaScript line to
//! this file's line), and nothing else suspends. An await of the JavaScript
//! with no mark is on a path this file refuses.
//!
//! Ported: construction; `initialize`, on an empty or a saved ledger, with the
//! recovery of loaded active tasks (`recoverTask`, its reconcile branches, the
//! re-armed starting leases and reconciliation retries); `submit` with its
//! preparation, commit and launch; the pump without an admission hook; the
//! launch; completion (`finishTask`, `commitTerminalTaskLocked`); `waitForTask`
//! without a signal or a timeout; the control methods `setChildSessionId` and
//! `markAccepted`. Everything else is refused by name (`host::refuse`): the
//! case is reported not-ported there, with every event before it compared.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use devryan_js_layer::jobs::{self, Promise, Resolution, async_fn};
use devryan_js_layer::js::{JsStr, Value, number_to_string};
use devryan_scheduler_policy::{Failure, JsResult, contract, persistence, primitives, transitions};

use crate::host;
use crate::value::{HostRef, Props, V};
use crate::wire;

/// The members this core ports (the hello answer names them).
pub const PORTED: &[&str] = &[
    "createManagedTaskScheduler",
    "initialize",
    "submit",
    "control.setChildSessionId",
    "control.markAccepted",
    "finishTask",
    "recoverTask",
    "waitForTask",
];

type P = Promise<V, V>;
type R<T> = Result<T, V>;
type Op = Box<dyn FnOnce() -> R<P>>;

const ACTIVE_STATUSES: [&str; 2] = ["starting", "running"];
const PERSISTENCE_STALL_MS: f64 = 300_000.0;

// ------------------------------------------------------------------ JavaScript helpers

fn refuse(what: &str) -> ! {
    host::refuse(what)
}

/// A policy result: its value, the error it throws (a JavaScript error value), or a refusal.
fn pol<T>(result: JsResult<T>) -> R<T> {
    match result {
        Ok(value) => Ok(value),
        Err(Failure::Throw(error)) if error.name == "ManagedOrchestrationError" => {
            let code = match &error.code {
                Some(Value::String(code)) => code.to_string_lossy(),
                _ => refuse("a ManagedOrchestrationError without a string code"),
            };
            Err(V::orchestration_error(&code, error.message.clone()))
        }
        Err(Failure::Throw(error)) => {
            let mut props = Props::new();
            if let Some(code) = &error.code {
                props.set("code", V::from_tree(code));
            }
            Err(V::error(&error.name, error.message.clone(), props))
        }
        Err(Failure::Unsupported(what)) => refuse(what),
    }
}

/// A value as policy data (a deep copy), or a refusal naming what it holds.
fn tree(value: &V) -> Value {
    match value.to_tree() {
        Ok(tree) => tree,
        Err(not) => refuse(not.0),
    }
}

/// `await value`: a promise is followed, anything else is wrapped (one job either way).
async fn wait(value: V) -> R<V> {
    match value {
        V::Promise(promise) => promise.await,
        other => jobs::value::<V, V>(other).await,
    }
}

fn done(value: V) -> R<Resolution<V, V>> {
    Ok(Resolution::Value(value))
}

fn js_str(value: &V) -> JsStr {
    match value {
        V::Str(text) => text.clone(),
        V::Undef => JsStr::from("undefined"),
        V::Null => JsStr::from("null"),
        V::Bool(value) => JsStr::from(if *value { "true" } else { "false" }),
        V::Num(value) => JsStr::from(number_to_string(*value)),
        _ => refuse("a template string of an object"),
    }
}

/// `${a}\u0000${b}` (scheduler.js:139 `idempotencyIndexKey`).
fn index_key(root: &V, key: &V) -> JsStr {
    let mut out = js_str(root);
    out.push_units(&[0]);
    out.push_units(js_str(key).units());
    out
}

fn num(value: &V, what: &str) -> f64 {
    match value {
        V::Num(value) => *value,
        _ => refuse(&format!("arithmetic on {what}, which is no number")),
    }
}

/// `Math.max(a, b)`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() || b.is_sign_positive() { 0.0 } else { -0.0 }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() || b.is_sign_negative() { -0.0 } else { 0.0 }
    } else if a < b {
        a
    } else {
        b
    }
}

fn is_terminal(task: &V) -> bool {
    contract::is_terminal_managed_task_status(&tree(&task.get("status")))
}

fn is_active(task: &V) -> bool {
    matches!(task.get("status"), V::Str(status) if ACTIVE_STATUSES.iter().any(|name| status == *name))
}

/// `typeof value === 'object' && value !== null` for an option object.
fn has_length(value: &V) -> bool {
    // `value?.length` truthy, for the arrays the scheduler tests so.
    value.get_opt("length").truthy()
}

/// `.sort(compareManagedTaskQueueOrder)`.
fn sort_queue(tasks: &mut [V]) -> R<()> {
    let mut failed = None;
    tasks.sort_by(|left, right| match primitives::compare_managed_task_queue_order(&tree(left), &tree(right)) {
        Ok(order) => order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal),
        Err(error) => {
            failed.get_or_insert(error);
            std::cmp::Ordering::Equal
        }
    });
    match failed {
        Some(error) => pol(Err(error)),
        None => Ok(()),
    }
}

/// `createLedgerDecodeError(code, detail)` (scheduler.js:144-157).
fn ledger_decode_error(code: &str, detail: &Value) -> devryan_scheduler_policy::JsError {
    let part = |name: &str| match detail.as_object().and_then(|object| object.get_str(name)) {
        Some(Value::String(text)) => text.to_string_lossy(),
        Some(Value::Undefined) | None => "undefined".to_owned(),
        Some(_) => refuse("a ledger decode error detail that is no string"),
    };
    let (scheduler_code, message) = match code {
        "invalid_ledger_version" | "invalid_ledger_collections" => ("invalid_ledger", "managed orchestration ledger is invalid".to_owned()),
        "invalid_result_envelopes" => ("invalid_ledger", "managed result envelopes are invalid".to_owned()),
        "duplicate_task" => ("duplicate_task", format!("duplicate task {} in ledger", part("taskId"))),
        "duplicate_idempotency_key" => (
            "duplicate_idempotency_key",
            format!("duplicate idempotency key for root {}", part("rootSessionId")),
        ),
        "duplicate_result_envelope" | "orphan_result_envelope" => {
            ("invalid_result_envelope", format!("result envelope {} has no unique task", part("envelopeId")))
        }
        _ => refuse("an unknown ledger decode error"),
    };
    devryan_scheduler_policy::JsError::new("ManagedOrchestrationError", message).with_code(scheduler_code)
}

/// `String.prototype.trim`'s white space and line terminators.
fn js_trim(text: &JsStr) -> &[u16] {
    let space = |unit: &u16| matches!(*unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
    let units = text.units();
    let start = units.iter().position(|unit| !space(unit)).unwrap_or(units.len());
    let end = units.iter().rposition(|unit| !space(unit)).map_or(start, |at| at + 1);
    &units[start..end]
}

/// What a policy reads of a thrown value: an error as an object with its `name` (own, or its class's) and
/// `message`, any other value as data.
fn error_view(error: &V) -> Value {
    if let V::Obj(object) = error
        && let crate::value::Body::Error { class, message, props } = &*object.0.body.borrow()
    {
        let mut view = Props::new();
        view.set("name", props.get("name").cloned().unwrap_or_else(|| V::str(class)));
        view.set("message", V::Str(message.clone()));
        for (key, value) in props.entries() {
            if key != "name" {
                view.set_js(key, value);
            }
        }
        return tree(&V::from_props(view));
    }
    tree(error)
}

/// An insertion-ordered map (JavaScript's `Map`): setting an existing key keeps its place.
pub struct OMap<T: Clone> {
    slots: Vec<Option<(JsStr, T)>>,
    index: HashMap<JsStr, usize>,
}

impl<T: Clone> Default for OMap<T> {
    fn default() -> Self {
        OMap {
            slots: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<T: Clone> OMap<T> {
    pub fn get(&self, key: &JsStr) -> Option<T> {
        self.index.get(key).and_then(|&at| self.slots[at].as_ref().map(|(_, value)| value.clone()))
    }
    pub fn has(&self, key: &JsStr) -> bool {
        self.index.contains_key(key)
    }
    pub fn set(&mut self, key: JsStr, value: T) {
        if let Some(&at) = self.index.get(&key) {
            self.slots[at] = Some((key, value));
            return;
        }
        self.index.insert(key.clone(), self.slots.len());
        self.slots.push(Some((key, value)));
    }
    pub fn delete(&mut self, key: &JsStr) -> bool {
        match self.index.remove(key) {
            Some(at) => {
                self.slots[at] = None;
                true
            }
            None => false,
        }
    }
    pub fn values(&self) -> Vec<T> {
        self.slots.iter().flatten().map(|(_, value)| value.clone()).collect()
    }
    pub fn len(&self) -> usize {
        self.index.len()
    }
    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }
}

/// `cloneTask(task)` (scheduler.js:105): a spread of the task with its nested records copied.
pub fn clone_task(task: &V) -> V {
    if !task.truthy() {
        return V::Null;
    }
    let mut props = task.spread();
    if task.get("nativeJobSegments").truthy() {
        props.set("nativeJobSegments", task.get("nativeJobSegments").array_map_spread());
    }
    for key in [
        "primaryStepBudget",
        "approvedPlanRef",
        "requiredChecks",
        "taskPrerequisites",
        "requiredCheckReceipts",
        "requiredCheckCorrections",
    ] {
        let value = task.get(key);
        if value.truthy() {
            props.set(key, V::from_tree(&tree(&value)));
        }
    }
    let spread_or_null = |value: V| if value.truthy() { V::from_props(value.spread()) } else { V::Null };
    props.set("transportRecovery", spread_or_null(task.get("transportRecovery")));
    props.set("waitingReason", spread_or_null(task.get("waitingReason")));
    let refs = task.get("canonicalRefs");
    if !refs.is_array() {
        refuse("cloneTask of a task whose canonicalRefs is no array (the JavaScript throws a TypeError)");
    }
    props.set("canonicalRefs", refs.array_map_spread());
    V::from_props(props)
}

/// A task record with one member changed: `{ ...previous, key: value }`.
fn with(previous: &V, changes: Vec<(&str, V)>) -> V {
    let mut props = previous.spread();
    for (key, value) in changes {
        props.set(key, value);
    }
    V::from_props(props)
}

fn task_id(task: &V) -> JsStr {
    match task.get("taskId") {
        V::Str(text) => text,
        _ => refuse("a task without a string taskId"),
    }
}

// ------------------------------------------------------------------ the core

pub struct Core {
    schedulers: RefCell<HashMap<i64, Rc<Sched>>>,
}

impl Default for Core {
    fn default() -> Core {
        Core::new()
    }
}

impl Core {
    pub fn new() -> Core {
        Core {
            schedulers: RefCell::new(HashMap::new()),
        }
    }

    /// `createManagedTaskScheduler(options = {})` (scheduler.js:220).
    pub fn construct(&self, c: i64, args: Vec<V>) -> R<V> {
        let options = match args.into_iter().next() {
            Some(V::Host(options)) if &*options.kind == "options" => options,
            Some(V::Undef) | None => refuse("createManagedTaskScheduler without options (its defaults are not ported)"),
            Some(_) => refuse("createManagedTaskScheduler with options that are not the host's object"),
        };
        let sched = Sched::construct(c, options)?;
        self.schedulers.borrow_mut().insert(c, sched);
        Ok(V::Null)
    }

    pub fn call(&self, c: i64, member: &str, args: Vec<V>) -> R<V> {
        let Some(sched) = self.schedulers.borrow().get(&c).cloned() else {
            refuse("a member of a construction that threw")
        };
        match member {
            "initialize" => sched.initialize_member(args.first().cloned().unwrap_or(V::Undef)),
            "submit" => sched.submit(args.first().cloned().unwrap_or(V::Undef), args.get(1).cloned().unwrap_or(V::Undef)),
            "waitForTask" => sched.wait_for_task(args.first().cloned().unwrap_or(V::Undef), args.get(1).cloned().unwrap_or(V::Undef)),
            other => refuse(&format!("the member {other}")),
        }
    }

    pub fn invoke(&self, _c: i64, function: i64, args: Vec<V>) -> R<V> {
        match wire::function(function) {
            Some(V::Func(func)) => (func.0.body)(args),
            _ => wire::fatal("an input calls a function this process never handed out"),
        }
    }
}

/// The persistence writer's ownership record (scheduler.js:550).
struct Owner {
    timer: RefCell<V>,
    attention: Cell<bool>,
}

pub struct Sched {
    c: i64,
    options: HostRef,
    executor: V,
    persistence: V,
    now_fn: V,
    schedule_timeout: V,
    cancel_timeout: V,
    create_task_id: V,
    create_lease_token: V,
    publish_event: Option<V>,
    persistence_stall_ms: f64,
    max_terminal_records: V,
    max_history_age_ms: V,
    max_persisted_bytes: V,
    starting_lease_timeout_ms: f64,
    admit_launch: Option<V>,
    tasks: RefCell<OMap<V>>,
    result_envelopes: RefCell<OMap<V>>,
    idempotency_index: RefCell<HashMap<JsStr, JsStr>>,
    active_launches: RefCell<OMap<P>>,
    timeout_timers: RefCell<HashMap<JsStr, V>>,
    operator_stop_timers: RefCell<HashMap<JsStr, V>>,
    starting_lease_timers: RefCell<HashMap<JsStr, V>>,
    reconciliation_retry_timers: RefCell<HashMap<JsStr, V>>,
    reconciliation_retry_ms: f64,
    task_waiters: RefCell<HashMap<JsStr, Vec<devryan_js_layer::jobs::Resolvers<V, V>>>>,
    initialized: Cell<bool>,
    activated: Cell<bool>,
    shut_down: Cell<bool>,
    initialize_promise: RefCell<Option<P>>,
    mutation_tail: RefCell<P>,
    committed_read_state: RefCell<V>,
    persistence_owner: RefCell<Option<Rc<Owner>>>,
    uncommitted_read: Cell<bool>,
    publication_tail: RefCell<P>,
    recovering: Cell<bool>,
    last_serialized_bytes: Cell<f64>,
    admission_retry_timer: RefCell<Option<V>>,
    admission_held_count: Cell<f64>,
}

impl Sched {
    // -------------------------------------------------------------- host access

    /// `options[key]`: a read the host answers.
    fn opt(&self, key: &str) -> V {
        host::get_member(self.c, &self.options, key)
    }

    /// `holder[key]` of a host object or of one of this process's values.
    fn member(&self, holder: &V, key: &str) -> V {
        match holder {
            V::Host(reference) if &*reference.kind == "port-object" || &*reference.kind == "options" => host::get_member(self.c, reference, key),
            V::Host(_) => refuse("a member of a host function"),
            other => other.get(key),
        }
    }

    /// `f(...args)`.
    fn call_fn(&self, function: &V, args: Vec<V>) -> R<V> {
        match function {
            V::Host(reference) => host::call(self.c, reference, &args),
            V::Func(func) => (func.0.body)(args),
            _ => Err(V::error("TypeError", "function is not a function", Props::new())),
        }
    }

    /// `now()`.
    fn now(&self) -> R<f64> {
        let value = self.call_fn(&self.now_fn, Vec::new())?;
        Ok(num(&value, "now()"))
    }

    /// `unrefTimer(scheduleTimeout(callback, delay))` (scheduler.js:367): the host's handle has no `unref`.
    fn set_timer(&self, callback: V, delay: f64) -> R<V> {
        let handle = self.call_fn(&self.schedule_timeout, vec![callback, V::Num(delay)])?;
        if handle.truthy() && self.member(&handle, "unref").is_function() {
            refuse("a timer handle with unref");
        }
        Ok(handle)
    }

    fn cancel(&self, handle: V) -> R<()> {
        self.call_fn(&self.cancel_timeout, vec![handle])?;
        Ok(())
    }

    /// `options.onMutationTiming ? performance.now() : 0` (scheduler.js:378, 381, 386).
    fn mutation_timing(&self) {
        if self.opt("onMutationTiming").truthy() {
            refuse("options.onMutationTiming (performance.now and the timing report)");
        }
    }

    fn error(&self, code: &str, message: String) -> V {
        V::orchestration_error(code, message)
    }

    // -------------------------------------------------------------- construction

    /// scheduler.js:220-400: the options read in the JavaScript's order, then the empty state.
    fn construct(c: i64, options: HostRef) -> R<Rc<Sched>> {
        let read = |key: &str| host::get_member(c, &options, key);
        let range = |message: &str| Err(V::error("RangeError", message, Props::new()));
        let _cursor_read_only = read("cursorReadOnly");
        let executor = read("executor");
        // `if (!executor || typeof executor.start !== 'function')`
        let start_ok = executor.truthy()
            && match &executor {
                V::Host(reference) if &*reference.kind == "port-object" => host::get_member(c, reference, "start").is_function(),
                V::Host(_) => refuse("an executor that is a function"),
                other => other.get("start").is_function(),
            };
        if !start_ok {
            return Err(V::error("TypeError", "executor.start is required", Props::new()));
        }
        let persistence = read("persistence");
        if persistence.is_nullish() {
            refuse("the default persistence (createDefaultPersistence)");
        }
        let required = |value: V, what: &str| if value.is_nullish() { refuse(&format!("the default {what}")) } else { value };
        let now_fn = required(read("now"), "clock (Date.now)");
        let schedule_timeout = required(read("scheduleTimeout"), "setTimeout");
        let cancel_timeout = required(read("cancelTimeout"), "clearTimeout");
        let abort_timeout_ms = read("abortTimeoutMs");
        let abort_timeout_ms = if abort_timeout_ms.is_nullish() {
            5_000.0
        } else {
            num(&abort_timeout_ms, "abortTimeoutMs")
        };
        if !abort_timeout_ms.is_finite() || abort_timeout_ms < 1.0 {
            return range("abortTimeoutMs must be a positive finite number");
        }
        let create_task_id = required(read("createTaskId"), "createTaskId (createRandomId)");
        let create_lease_token = required(read("createLeaseToken"), "createLeaseToken (createRandomId)");
        let _create_wave_id = required(read("createWaveId"), "createWaveId (createRandomId)");
        let publish_event = read("publishEvent");
        let publish_event = if publish_event.is_nullish() { None } else { Some(publish_event) };
        let logger = read("logger");
        if logger.is_nullish() {
            refuse("the default logger (console)");
        }
        let finite_at_least = |value: V, fallback: f64, name: &str| -> R<f64> {
            let number = if value.is_nullish() { fallback } else { num(&value, name) };
            if !number.is_finite() || number < 1.0 {
                return Err(V::error("RangeError", format!("{name} must be a positive finite number"), Props::new()));
            }
            Ok(number)
        };
        let persistence_stall_ms = finite_at_least(read("persistenceStallMs"), PERSISTENCE_STALL_MS, "persistenceStallMs")?;
        let or = |value: V, fallback: f64| if value.is_nullish() { V::Num(fallback) } else { value };
        let max_terminal_records = or(read("maxTerminalRecords"), persistence::DEFAULT_MANAGED_TERMINAL_MAX_RECORDS);
        let max_history_age_ms = or(read("maxHistoryAgeMs"), persistence::DEFAULT_MANAGED_TERMINAL_MAX_AGE_MS);
        let max_persisted_bytes = or(read("maxPersistedBytes"), persistence::DEFAULT_MANAGED_LEDGER_MAX_BYTES);
        let starting_lease_timeout_ms = finite_at_least(read("startingLeaseTimeoutMs"), 60_000.0, "startingLeaseTimeoutMs")?;
        let reconciliation_retry_ms = finite_at_least(read("reconciliationRetryMs"), 1_000.0, "reconciliationRetryMs")?;
        let _continuation_lease_ms = finite_at_least(read("providerRecoveryContinuationLeaseMs"), 60_000.0, "providerRecoveryContinuationLeaseMs")?;
        // `options.autoResume && typeof options.autoResume === 'object' ? options.autoResume : null`
        let auto_resume = read("autoResume");
        if auto_resume.truthy() && read("autoResume").type_of() == "object" {
            refuse("options.autoResume (auto-resume)");
        }
        let admit_launch = read("admitLaunch");
        let admit_launch = if admit_launch.is_function() { Some(admit_launch) } else { None };
        // `['loadNativeJobProofShards', …].every(name => typeof persistence[name] === 'function')` (scheduler.js:290)
        let member = |name: &str| match &persistence {
            V::Host(reference) if &*reference.kind == "port-object" => host::get_member(c, reference, name),
            V::Host(_) => refuse("a persistence that is a function"),
            other => other.get(name),
        };
        let proof_store = ["loadNativeJobProofShards", "putNativeJobProofShard", "removeNativeJobProofShard"]
            .iter()
            .all(|name| member(name).is_function());
        if proof_store {
            refuse("a persistence with native job proof shards (the proof store)");
        }
        Ok(Rc::new(Sched {
            c,
            options,
            executor,
            persistence,
            now_fn,
            schedule_timeout,
            cancel_timeout,
            create_task_id,
            create_lease_token,
            publish_event,
            persistence_stall_ms,
            max_terminal_records,
            max_history_age_ms,
            max_persisted_bytes,
            starting_lease_timeout_ms,
            admit_launch,
            tasks: RefCell::new(OMap::default()),
            result_envelopes: RefCell::new(OMap::default()),
            idempotency_index: RefCell::new(HashMap::new()),
            active_launches: RefCell::new(OMap::default()),
            timeout_timers: RefCell::new(HashMap::new()),
            operator_stop_timers: RefCell::new(HashMap::new()),
            starting_lease_timers: RefCell::new(HashMap::new()),
            reconciliation_retry_timers: RefCell::new(HashMap::new()),
            reconciliation_retry_ms,
            task_waiters: RefCell::new(HashMap::new()),
            initialized: Cell::new(false),
            activated: Cell::new(false),
            shut_down: Cell::new(false),
            initialize_promise: RefCell::new(None),
            mutation_tail: RefCell::new(jobs::value(V::Undef)),
            committed_read_state: RefCell::new(V::object(vec![
                ("version", V::Num(1.0)),
                ("tasks", V::array(Vec::new())),
                ("resultEnvelopes", V::array(Vec::new())),
            ])),
            persistence_owner: RefCell::new(None),
            uncommitted_read: Cell::new(false),
            publication_tail: RefCell::new(jobs::value(V::Undef)),
            recovering: Cell::new(false),
            last_serialized_bytes: Cell::new(0.0),
            admission_retry_timer: RefCell::new(None),
            admission_held_count: Cell::new(0.0),
        }))
    }

    // -------------------------------------------------------------- the exclusive section

    /// `runExclusive(operation)` (scheduler.js:377-404).
    fn run_exclusive(self: &Rc<Self>, operation: Op) -> R<P> {
        self.mutation_timing(); // queuedAt, scheduler.js:378
        let shared = Rc::new(RefCell::new(Some(operation)));
        let make_run = |s: Rc<Sched>, shared: Rc<RefCell<Option<Op>>>| {
            move |_: V| -> R<Resolution<V, V>> {
                let operation = shared.borrow_mut().take().expect("run runs once");
                Ok(Resolution::Promise(s.clone().exclusive_run(operation)))
            }
        };
        let tail = self.mutation_tail.borrow().clone();
        // scheduler.js:393 `mutationTail.then(run, run)`
        let result = tail.then(make_run(self.clone(), shared.clone()), make_run(self.clone(), shared));
        // scheduler.js:394
        *self.mutation_tail.borrow_mut() = result.catch(|_| done(V::Undef));
        // scheduler.js:402 `void result.then(release, release)`: nothing the ported paths run registers after-commit work.
        let _ = result.then(|_| done(V::Undef), |_| done(V::Undef));
        Ok(result)
    }

    /// `run` of runExclusive (scheduler.js:380-391): the operation awaited, then the `finally`.
    fn exclusive_run(self: Rc<Self>, operation: Op) -> P {
        async_fn(async move {
            self.mutation_timing(); // startedAt, scheduler.js:381
            let outcome = match operation() {
                Ok(promise) => promise.await, // await scheduler.js:383
                Err(error) => Err(error),
            };
            // finally, scheduler.js:384-390
            self.uncommitted_read.set(false);
            self.mutation_timing();
            outcome.map(Resolution::Value)
        })
    }

    // -------------------------------------------------------------- persistence

    /// `snapshotLocked()` (scheduler.js:406).
    fn snapshot_locked(&self) -> V {
        let mut tasks = self.tasks.borrow().values();
        let mut failed = None;
        tasks.sort_by(|left, right| {
            let created = num(&left.get("createdAt"), "createdAt") - num(&right.get("createdAt"), "createdAt");
            let order = if created != 0.0 && !created.is_nan() {
                created
            } else {
                match primitives::locale_compare_ids(&task_id(left), &task_id(right)) {
                    Ok(order) => order,
                    Err(error) => {
                        failed.get_or_insert(error);
                        0.0
                    }
                }
            };
            order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(error) = failed {
            let _ = pol::<()>(Err(error));
        }
        let mut envelopes = self.result_envelopes.borrow().values();
        envelopes.sort_by(|left, right| {
            let order = num(&left.get("sequence"), "sequence") - num(&right.get("sequence"), "sequence");
            order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        let envelopes: Vec<V> = envelopes.iter().map(|envelope| V::from_tree(&tree(envelope))).collect();
        V::object(vec![
            ("version", V::Num(1.0)),
            ("tasks", V::array(tasks.iter().map(clone_task).collect())),
            ("resultEnvelopes", V::array(envelopes)),
        ])
    }

    /// `persistLocked()` (scheduler.js:516-635).
    fn persist_locked(self: &Rc<Self>) -> P {
        let s = self.clone();
        async_fn(async move {
            s.uncommitted_read.set(true);
            let snapshot = s.snapshot_locked();
            let at = s.now()?;
            let expire = s.opt("expireUnacknowledged");
            let expire = if expire.is_nullish() {
                let env = host::ask(
                    s.c,
                    "env",
                    vec![
                        ("site", Value::string("persistLocked")),
                        ("name", Value::string("DEVRYAN_ORCHESTRATION_UNACKNOWLEDGED_EXPIRY")),
                    ],
                );
                V::Bool(!env.is_str("0"))
            } else {
                expire
            };
            let options = V::object(vec![
                ("now", V::Num(at)),
                ("maxTerminalRecords", s.max_terminal_records.clone()),
                ("maxAgeMs", s.max_history_age_ms.clone()),
                ("maxBytes", s.max_persisted_bytes.clone()),
                ("expireUnacknowledged", expire),
                ("assumeOwnedInput", V::Bool(true)),
            ]);
            let compaction = V::from_tree(&pol(persistence::compact_managed_orchestration_state(&tree(&snapshot), &tree(&options)))?);
            if compaction.get("overLimit").truthy() {
                return Err(s.error(
                    "ledger_capacity_exceeded",
                    format!(
                        "managed orchestration ledger cannot fit within {} bytes without removing protected work",
                        js_str(&s.max_persisted_bytes)
                    ),
                ));
            }
            // A tombstone and its envelope share one `canonicalRefs` array (persistence.js:51-57), aliasing the
            // policy's tree result cannot carry: refused before the save that would show it.
            if has_length(&compaction.get("tombstonedTaskIds")) {
                refuse("a save that tombstones tasks inline (a tombstone shares its released fields with its envelope)");
            }
            // scheduler.js:538: no proof store, so no await.
            let state = compaction.get("state");
            let started_at = s.now()?;
            let mut due_task: Option<V> = None;
            let committed = s.committed_read_state.borrow().get("tasks").items();
            for task in committed.iter().chain(state.get("tasks").items().iter()) {
                let timeout = task.get("timeoutAt");
                if !is_terminal(task) && matches!(timeout, V::Num(at) if at.is_finite()) {
                    let earlier = match &due_task {
                        None => true,
                        Some(due) => num(&timeout, "timeoutAt") < num(&due.get("timeoutAt"), "timeoutAt"),
                    };
                    if earlier {
                        due_task = Some(task.clone());
                    }
                }
            }
            // `ownerID: createRandomId('dvr_save_')` (scheduler.js:548, 133): the hidden draw at persistLocked.
            let drawn = host::ask(s.c, "draw", vec![("site", Value::string("persistLocked")), ("source", Value::string("hidden"))]);
            if !matches!(drawn, V::Str(_)) {
                refuse("a hidden draw that is no string");
            }
            let owner = Rc::new(Owner {
                timer: RefCell::new(V::Null),
                attention: Cell::new(false),
            });
            *s.persistence_owner.borrow_mut() = Some(owner.clone());
            // arm() (scheduler.js:569-573)
            s.cancel(owner.timer.borrow().clone())?;
            let check = V::func("check", |_| refuse("the persistence stall check (a timer the case fires)"));
            let due = due_task.as_ref().map_or(f64::INFINITY, |task| num(&task.get("timeoutAt"), "timeoutAt"));
            let bound = js_min(started_at + s.persistence_stall_ms, due);
            let delay = js_max(0.0, bound - s.now()?);
            *owner.timer.borrow_mut() = s.set_timer(check, delay)?;
            let on_progress = V::object(vec![(
                "onProgress",
                V::func("onProgress", |_| refuse("persistence progress reports (onProgress)")),
            )]);
            let save = s.member(&s.persistence, "save");
            let saved = match s.call_fn(&save, vec![state.clone(), on_progress]) {
                Ok(value) => wait(value).await, // await scheduler.js:577
                Err(error) => Err(error),
            };
            if saved.is_ok() {
                *s.committed_read_state.borrow_mut() = state.clone();
                s.uncommitted_read.set(false);
            }
            // finally, scheduler.js:597-602
            s.cancel(owner.timer.borrow().clone())?;
            let current = s.persistence_owner.borrow().clone();
            if current.is_some_and(|current| Rc::ptr_eq(&current, &owner)) {
                *s.persistence_owner.borrow_mut() = None;
            }
            if owner.attention.get() {
                refuse("the stalled persistence report");
            }
            saved?;
            s.last_serialized_bytes
                .set(js_max(0.0, num(&compaction.get("serializedBytes"), "serializedBytes")));
            if has_length(&compaction.get("removedTaskIds")) {
                refuse("a save that removes compacted tasks");
            }
            done(V::Undef)
        })
    }

    /// `commitNewTaskLocked(task)` (scheduler.js:637-648).
    fn commit_new_task_locked(self: &Rc<Self>, task: V) -> P {
        let s = self.clone();
        async_fn(async move {
            let id = task_id(&task);
            let key = index_key(&task.get("rootSessionId"), &task.get("idempotencyKey"));
            s.tasks.borrow_mut().set(id.clone(), task.clone());
            s.idempotency_index.borrow_mut().insert(key.clone(), id.clone());
            if let Err(error) = s.persist_locked().await {
                // await scheduler.js:641
                s.tasks.borrow_mut().delete(&id);
                s.idempotency_index.borrow_mut().remove(&key);
                return Err(error);
            }
            s.queue_task_publication(&task)?;
            done(V::Undef)
        })
    }

    /// `commitTaskUpdateLocked(previous, next, { publish })` (scheduler.js:650-660).
    fn commit_task_update_locked(self: &Rc<Self>, previous: V, next: V, publish: bool) -> P {
        let s = self.clone();
        async_fn(async move {
            let same = |key: &JsStr| {
                let key = key.to_string_lossy();
                previous.get(&key).same(&next.get(&key))
            };
            pol(transitions::assert_managed_task_transition(&tree(&previous), &tree(&next), &same))?;
            s.tasks.borrow_mut().set(task_id(&next), next.clone());
            if let Err(error) = s.persist_locked().await {
                // await scheduler.js:654
                s.tasks.borrow_mut().set(task_id(&previous), previous.clone());
                return Err(error);
            }
            if publish && s.tasks.borrow().has(&task_id(&next)) {
                s.queue_task_publication(&next)?;
            }
            done(V::Undef)
        })
    }

    // -------------------------------------------------------------- publication

    /// `queueTaskPublication(task)` (scheduler.js:429-445).
    fn queue_task_publication(self: &Rc<Self>, task: &V) -> R<()> {
        let envelope = self.result_envelopes.borrow().get(&task_id(task)).unwrap_or(V::Null);
        let event = V::from_tree(&pol(contract::to_managed_task_event(&tree(task), &tree(&envelope)))?);
        // projectTaskForEvent shares the task's canonicalRefs array (contract.js:410).
        event.get("properties").get("task").set("canonicalRefs", task.get("canonicalRefs"));
        if self.opt("onBarrierChange").is_function() {
            refuse("options.onBarrierChange (barrier diagnostics)");
        }
        let publish = |s: Rc<Sched>, event: V| move |_: V| -> R<Resolution<V, V>> { Ok(Resolution::Promise(s.publish_managed_event(event))) };
        let tail = self.publication_tail.borrow().clone();
        let next = tail.then(publish(self.clone(), event.clone()), publish(self.clone(), event));
        *self.publication_tail.borrow_mut() = next;
        Ok(())
    }

    /// `publishManagedEvent(event)` (scheduler.js:417-427).
    fn publish_managed_event(self: Rc<Self>, event: V) -> P {
        async_fn(async move {
            let published = match &self.publish_event {
                Some(publish) => match self.call_fn(publish, vec![event]) {
                    Ok(value) => wait(value).await, // await scheduler.js:419
                    Err(error) => Err(error),
                },
                None => wait(V::Undef).await, // await scheduler.js:419 (the default publishEvent returns undefined)
            };
            if published.is_err() {
                refuse("a failed publication (logger.warn)");
            }
            done(V::Undef)
        })
    }

    // -------------------------------------------------------------- timers

    /// `clearTaskTimeout(taskId)` (scheduler.js:690).
    fn clear_task_timeout(&self, id: &JsStr) -> R<()> {
        let timer = self.timeout_timers.borrow_mut().remove(id);
        if let Some(timer) = timer {
            self.cancel(timer)?;
        }
        Ok(())
    }

    /// `clearStartingLease(taskId)` (scheduler.js:697).
    fn clear_starting_lease(&self, id: &JsStr) -> R<()> {
        let timer = self.starting_lease_timers.borrow_mut().remove(id);
        if let Some(timer) = timer {
            self.cancel(timer)?;
        }
        Ok(())
    }

    /// `handleStartingLease(taskId, leaseToken)` (scheduler.js:2111-2120).
    fn handle_starting_lease(self: &Rc<Self>, id: JsStr, lease: V) -> P {
        let s = self.clone();
        async_fn(async move {
            if s.shut_down.get() {
                return done(V::Undef);
            }
            let task = s.tasks.borrow().get(&id);
            let Some(task) = task else { return done(V::Undef) };
            if !task.get("status").is_str("starting") || !task.get("leaseToken").same(&lease) {
                return done(V::Undef);
            }
            s.active_launches.borrow_mut().delete(&id);
            s.recover_task(clone_task(&task)).await?; // await scheduler.js:2119
            done(V::Undef)
        })
    }

    /// `scheduleReconciliationRetry(task)` (scheduler.js:1914-1937).
    fn schedule_reconciliation_retry(self: &Rc<Self>, task: &V) -> R<()> {
        let id = task_id(task);
        if self.shut_down.get() || !is_active(task) || self.reconciliation_retry_timers.borrow().contains_key(&id) {
            return Ok(());
        }
        let (s, fired, lease) = (self.clone(), id.clone(), task.get("leaseToken"));
        let callback = V::func("", move |_| {
            s.reconciliation_retry_timers.borrow_mut().remove(&fired);
            if s.shut_down.get() {
                return Ok(V::Undef);
            }
            let current = s.tasks.borrow().get(&fired);
            let Some(current) = current else { return Ok(V::Undef) };
            if !is_active(&current) || !current.get("leaseToken").same(&lease) {
                return Ok(V::Undef);
            }
            let retried = s.recover_task(clone_task(&current));
            let _ = retried.catch(|_| refuse("a failed reconciliation retry (logger.warn)"));
            Ok(V::Undef)
        });
        let timer = self.set_timer(callback, self.reconciliation_retry_ms)?;
        self.reconciliation_retry_timers.borrow_mut().insert(id, timer);
        Ok(())
    }

    /// `clearReconciliationRetry(taskId)` (scheduler.js:704).
    fn clear_reconciliation_retry(&self, id: &JsStr) -> R<()> {
        let timer = self.reconciliation_retry_timers.borrow_mut().remove(id);
        if let Some(timer) = timer {
            self.cancel(timer)?;
        }
        Ok(())
    }

    /// `nextResultSequenceLocked()` (scheduler.js:662).
    fn next_result_sequence_locked(&self) -> f64 {
        self.result_envelopes
            .borrow()
            .values()
            .iter()
            .fold(0.0, |sequence, envelope| js_max(sequence, num(&envelope.get("sequence"), "sequence")))
            + 1.0
    }

    // -------------------------------------------------------------- recovery

    /// `recoverTask(task)` (scheduler.js:1842-1912).
    fn recover_task(self: &Rc<Self>, task: V) -> P {
        let s = self.clone();
        async_fn(async move {
            let id = task_id(&task);
            let lease = task.get("leaseToken");
            let reconcile = s.member(&s.executor, "reconcile");
            if !reconcile.is_function() {
                refuse("recovery without executor.reconcile (the caught TypeError)");
            }
            let reconciliation = match s.call_fn(&reconcile, vec![clone_task(&task)]) {
                Ok(value) => wait(value).await, // await scheduler.js:1846
                Err(error) => Err(error),
            };
            let reconciliation = match reconciliation {
                Ok(value) => value,
                Err(error) => {
                    let reason = pol(devryan_scheduler_policy::retry::format_managed_task_failure_reason(&error_view(&error)))?;
                    V::object(vec![("state", V::str("unavailable")), ("failureReason", V::Str(reason))])
                }
            };
            let state = reconciliation.get_opt("state");
            if state.is_str("terminal") {
                let result = reconciliation.get("result");
                let result = if result.is_nullish() {
                    V::object(vec![("status", V::str("interrupted"))])
                } else {
                    result
                };
                if task.get("status").is_str("starting") && result.get_opt("status").is_str("completed") {
                    s.mark_accepted(id.clone(), lease.clone()).await?; // await scheduler.js:1857
                }
                s.finish_task(id, lease, result, "interrupted").await?; // await scheduler.js:1859
                return done(V::Undef);
            }
            if state.is_str("relaunch") {
                let current = s.tasks.borrow().get(&id);
                if let Some(current) = current
                    && !is_terminal(&current)
                {
                    s.launch_task(&clone_task(&current))?;
                }
                return done(V::Undef);
            }
            if state.is_str("live") {
                if task.get("status").is_str("starting") {
                    s.mark_accepted(id.clone(), lease.clone()).await?; // await scheduler.js:1873
                }
                let current = s.tasks.borrow().get(&id);
                if let Some(current) = current
                    && !is_terminal(&current)
                {
                    s.observe_recovered_task(&clone_task(&current))?;
                }
                return done(V::Undef);
            }
            if state.is_str("transient") {
                let current = s.tasks.borrow().get(&id);
                if let Some(current) = current
                    && !is_terminal(&current)
                    && current.get("leaseToken").same(&lease)
                {
                    s.schedule_reconciliation_retry(&current)?;
                }
                return done(V::Undef);
            }
            let recovery = reconciliation.get_opt("recovery");
            let recovery = if recovery.is_nullish() { s.read_recovery(&task).await? } else { recovery }; // await scheduler.js:1894
            let preview = recovery.get_opt("recoverablePreview");
            let preview = if matches!(preview, V::Str(_)) { preview } else { V::str("") };
            let refs = recovery.get_opt("canonicalRefs");
            let refs = if refs.is_array() { refs.array_map_spread() } else { V::array(Vec::new()) };
            let partial = match recovery.get_opt("partial") {
                V::Bool(partial) => partial,
                _ => preview.truthy() || !refs.items().is_empty(),
            };
            let reason = reconciliation.get_opt("failureReason");
            let reason = if reason.truthy() {
                reason
            } else {
                V::str("Child session ownership could not be recovered after restart")
            };
            let result = V::object(vec![
                ("status", V::str("interrupted")),
                ("failureReason", reason),
                ("partial", V::Bool(partial)),
                ("recoverablePreview", preview),
                ("canonicalRefs", refs),
                ("resumable", V::Bool(recovery.get_opt("resumable").truthy())),
            ]);
            s.finish_task(id, lease, result, "interrupted").await?; // await scheduler.js:1901
            done(V::Undef)
        })
    }

    /// `readRecovery(task)` (scheduler.js:1825-1835): `await executor.readRecoverableResult(cloneTask(task)) ?? {}`.
    fn read_recovery(self: &Rc<Self>, task: &V) -> P {
        let s = self.clone();
        let task = task.clone();
        async_fn(async move {
            let read = s.member(&s.executor, "readRecoverableResult");
            if !read.is_function() {
                refuse("recovery without executor.readRecoverableResult (the logged failure)");
            }
            let value = match s.call_fn(&read, vec![clone_task(&task)]) {
                Ok(value) => wait(value).await, // await scheduler.js:1827
                Err(error) => Err(error),
            };
            match value {
                Ok(value) if value.is_nullish() => done(V::object(Vec::new())),
                Ok(value) => done(value),
                Err(_) => refuse("a failed read of the recoverable result (logger.warn)"),
            }
        })
    }

    /// `observeRecoveredTask(task)` (scheduler.js:1799-1823).
    fn observe_recovered_task(self: &Rc<Self>, task: &V) -> R<()> {
        let id = task_id(task);
        if self.active_launches.borrow().has(&id) {
            return Ok(());
        }
        let lease = task.get("leaseToken");
        let control = self.create_task_control(id.clone(), lease.clone());
        let (s, task, observed) = (self.clone(), task.clone(), id.clone());
        // scheduler.js:1804 `(async () => { … })()`
        let observation = async_fn(async move {
            let attempt: R<()> = async {
                let observe = s.member(&s.executor, "observe");
                if !observe.is_function() {
                    return Err(V::error("Error", "executor.observe is required to recover a live child session", Props::new()));
                }
                let result = wait(s.call_fn(&observe, vec![clone_task(&task), control])?).await?; // await scheduler.js:1809
                s.finish_task(observed.clone(), lease.clone(), result, "interrupted").await?; // await scheduler.js:1810
                Ok(())
            }
            .await;
            if let Err(error) = attempt {
                let reason = pol(devryan_scheduler_policy::retry::format_managed_task_failure_reason(&error_view(&error)))?;
                let failed = V::object(vec![("status", V::str("interrupted")), ("failureReason", V::Str(reason))]);
                s.finish_task(observed.clone(), lease.clone(), failed, "interrupted").await?; // await scheduler.js:1812
            }
            done(V::Undef)
        });
        self.active_launches.borrow_mut().set(id.clone(), observation.clone());
        let remove = |s: Rc<Sched>, id: JsStr| {
            move |_: V| -> R<Resolution<V, V>> {
                s.active_launches.borrow_mut().delete(&id);
                done(V::Undef)
            }
        };
        // scheduler.js:1818 `void observation.then(…, …)`
        let _ = observation.then(remove(self.clone(), id.clone()), remove(self.clone(), id));
        Ok(())
    }

    /// `scheduleTaskDeadline(task)` (scheduler.js:2138).
    fn schedule_task_deadline(&self, task: &V) -> R<()> {
        let id = task_id(task);
        self.clear_task_timeout(&id)?;
        if self.shut_down.get() || matches!(task.get("timeoutAt"), V::Null) || is_terminal(task) {
            return Ok(());
        }
        let delay = js_max(0.0, num(&task.get("timeoutAt"), "timeoutAt") - self.now()?);
        let timer = self.set_timer(V::func("", |_| refuse("a task deadline (a timer the case fires)")), delay)?;
        self.timeout_timers.borrow_mut().insert(id, timer);
        Ok(())
    }

    /// `scheduleStartingLease(task)` (scheduler.js:2122).
    fn schedule_starting_lease(self: &Rc<Self>, task: &V) -> R<()> {
        let id = task_id(task);
        self.clear_starting_lease(&id)?;
        if !task.get("status").is_str("starting") || !task.get("leaseToken").truthy() || self.shut_down.get() {
            return Ok(());
        }
        let started = task.get("startedAt");
        let base = if started.is_nullish() { self.now()? } else { num(&started, "startedAt") };
        let due_at = base + self.starting_lease_timeout_ms;
        let delay = js_max(0.0, due_at - self.now()?);
        let (s, fired, lease) = (self.clone(), id.clone(), task.get("leaseToken"));
        // scheduler.js:2126-2133: the lease runs out, and reconciliation becomes the observer.
        let callback = V::func("", move |_| {
            s.starting_lease_timers.borrow_mut().remove(&fired);
            let handled = s.handle_starting_lease(fired.clone(), lease.clone());
            let _ = handled.catch(|_| refuse("a failed starting-lease reconciliation (logger.warn)"));
            Ok(V::Undef)
        });
        let timer = self.set_timer(callback, delay)?;
        self.starting_lease_timers.borrow_mut().insert(id, timer);
        Ok(())
    }

    /// `scheduleOperatorStopExpiry(task)` (scheduler.js:2158).
    fn schedule_operator_stop_expiry(&self, task: &V) -> R<()> {
        let id = task_id(task);
        let timer = self.operator_stop_timers.borrow_mut().remove(&id);
        if let Some(timer) = timer {
            self.cancel(timer)?;
        }
        if self.shut_down.get() || !contract::has_pending_operator_stop(&tree(task)) {
            return Ok(());
        }
        refuse("a pending operator stop's expiry")
    }

    /// `clearAdmissionRetry()` (scheduler.js:1939).
    fn clear_admission_retry(&self) -> R<()> {
        let timer = self.admission_retry_timer.borrow_mut().take();
        if let Some(timer) = timer {
            self.cancel(timer)?;
        }
        Ok(())
    }

    // -------------------------------------------------------------- initialize

    /// The member `initialize(options)`: `{ loadOnly = false } = {}`.
    fn initialize_member(self: &Rc<Self>, options: V) -> R<V> {
        let load_only = if options.is_nullish() {
            if matches!(options, V::Null) {
                refuse("initialize(null) (a TypeError at destructuring)");
            }
            false
        } else {
            let value = self.member(&options, "loadOnly");
            if value.is_nullish() { false } else { value.truthy() }
        };
        if load_only {
            refuse("initialize({ loadOnly: true })");
        }
        Ok(V::Promise(self.initialize()?))
    }

    /// `initialize()` (scheduler.js:2310-2391), with loadOnly false.
    fn initialize(self: &Rc<Self>) -> R<P> {
        if self.shut_down.get() {
            return Ok(Promise::reject(
                self.error("scheduler_shut_down", "managed orchestration scheduler is shut down".into()),
            ));
        }
        if self.initialized.get() && self.activated.get() {
            return Ok(jobs::value(V::Undef));
        }
        if let Some(pending) = self.initialize_promise.borrow().clone() {
            // scheduler.js:2320 `initializePromise.then(() => !loadOnly && !activated ? initialize() : undefined)`
            let s = self.clone();
            return Ok(pending.then_ok(move |_| {
                if !s.activated.get() {
                    return Ok(Resolution::Promise(s.initialize()?));
                }
                done(V::Undef)
            }));
        }
        let s = self.clone();
        let first = self.run_exclusive(Box::new(move || Ok(s.initialize_load())))?;
        let s = self.clone();
        // scheduler.js:2336 `.then(async () => { … })`
        let second = first.then_ok(move |_| Ok(Resolution::Promise(s.initialize_activate())));
        let s = self.clone();
        // scheduler.js:2387 `.finally(() => { initializePromise = null; })`
        let promise = second.finally(move || {
            *s.initialize_promise.borrow_mut() = None;
            done(V::Undef)
        });
        *self.initialize_promise.borrow_mut() = Some(promise.clone());
        Ok(promise)
    }

    /// The first exclusive operation of initialize (scheduler.js:2321-2336).
    fn initialize_load(self: &Rc<Self>) -> P {
        let s = self.clone();
        async_fn(async move {
            if s.initialized.get() {
                return done(V::Undef);
            }
            let load = s.member(&s.persistence, "load");
            let loaded = wait(s.call_fn(&load, Vec::new())?).await?; // await scheduler.js:2323
            if !loaded.is_nullish() {
                // decodeLedgerSnapshot(loaded, { requireResultEnvelopes: false, createError: createLedgerDecodeError })
                let create_error = |code: &str, detail: &Value| ledger_decode_error(code, detail);
                let options = devryan_scheduler_policy::codec::DecodeOptions {
                    require_result_envelopes: false,
                    create_error: &create_error,
                };
                let ledger = V::from_tree(&pol(devryan_scheduler_policy::codec::decode_ledger_snapshot(&tree(&loaded), &options))?);
                if has_length(&ledger.get("objectiveChecks")) {
                    refuse("a saved ledger with objective checks");
                }
                for task in ledger.get("tasks").items() {
                    let id = task_id(&task);
                    s.tasks.borrow_mut().set(id.clone(), clone_task(&task));
                    s.idempotency_index
                        .borrow_mut()
                        .insert(index_key(&task.get("rootSessionId"), &task.get("idempotencyKey")), id);
                }
                for envelope in ledger.get("resultEnvelopes").items() {
                    s.result_envelopes.borrow_mut().set(task_id(&envelope), V::from_tree(&tree(&envelope)));
                }
            }
            let tasks = s.tasks.borrow().values();
            let envelopes = s.result_envelopes.borrow().values();
            *s.committed_read_state.borrow_mut() = V::object(vec![
                ("version", V::Num(1.0)),
                ("tasks", V::array(tasks)),
                ("resultEnvelopes", V::array(envelopes)),
            ]);
            s.initialized.set(true);
            done(V::Undef)
        })
    }

    /// The activation after the load (scheduler.js:2336-2386).
    fn initialize_activate(self: &Rc<Self>) -> P {
        let s = self.clone();
        async_fn(async move {
            let missing: Vec<V> = s
                .tasks
                .borrow()
                .values()
                .into_iter()
                .filter(|task| is_terminal(task) && !s.result_envelopes.borrow().has(&task_id(task)))
                .collect();
            let inner = s.clone();
            // scheduler.js:2339 `await runExclusive(async () => { …; await persistLocked(); })`
            let persisted = s.run_exclusive(Box::new(move || {
                let inner = inner.clone();
                Ok(async_fn(async move {
                    for task in &missing {
                        let sequence = inner.next_result_sequence_locked();
                        let finished = task.get("finishedAt");
                        let created = if finished.is_nullish() { task.get("createdAt") } else { finished };
                        let options = V::object(vec![("sequence", V::Num(sequence)), ("createdAt", created), ("resumable", V::Bool(false))]);
                        let envelope = V::from_tree(&pol(devryan_scheduler_policy::envelope::create_managed_task_result_envelope(
                            &tree(task),
                            &tree(&options),
                        ))?);
                        inner.result_envelopes.borrow_mut().set(task_id(task), envelope);
                    }
                    inner.persist_locked().await?; // await scheduler.js:2349
                    done(V::Undef)
                }))
            }))?;
            persisted.await?; // await scheduler.js:2339
            for task in s.tasks.borrow().values() {
                s.schedule_operator_stop_expiry(&task)?;
            }
            s.recovering.set(true);
            let mut active: Vec<V> = s.tasks.borrow().values().into_iter().filter(is_active).collect();
            sort_queue(&mut active)?;
            let mut recovered: R<()> = Ok(());
            for task in active {
                if let Err(error) = s.recover_task(clone_task(&task)).await {
                    // await scheduler.js:2359
                    recovered = Err(error);
                    break;
                }
            }
            // finally, scheduler.js:2360-2362
            s.recovering.set(false);
            recovered?;
            for task in s.tasks.borrow().values() {
                s.schedule_task_deadline(&task)?;
                s.schedule_starting_lease(&task)?;
                if is_terminal(&task)
                    && task
                        .get("nativeJobSegments")
                        .items()
                        .iter()
                        .any(|segment| segment.get("completion").is_str("pending"))
                {
                    refuse("native job completion at initialize (completeNativeJobs)");
                }
            }
            for envelope in s.result_envelopes.borrow().values() {
                let cleanup = envelope.get("runCleanup");
                if cleanup.truthy() && !cleanup.get("state").is_str("done") {
                    refuse("a run cleanup re-armed at initialize (scheduleRunCleanup)");
                }
            }
            s.activated.set(true);
            s.clone().pump().await?; // await scheduler.js:2386
            done(V::Undef)
        })
    }

    /// `ensureInitialized()` (scheduler.js:2393-2409), allowPaused false.
    fn ensure_initialized(self: &Rc<Self>) -> P {
        let s = self.clone();
        async_fn(async move {
            if s.shut_down.get() {
                return Err(s.error("scheduler_shut_down", "managed orchestration scheduler is shut down".into()));
            }
            if !s.activated.get() {
                s.initialize()?.await?; // await scheduler.js:2401
            }
            if s.shut_down.get() {
                return Err(s.error("scheduler_shut_down", "managed orchestration scheduler is shut down".into()));
            }
            done(V::Undef)
        })
    }

    // -------------------------------------------------------------- submit

    /// `submit(input, { signal, authorize } = {})` (scheduler.js:2548-2557).
    fn submit(self: &Rc<Self>, input: V, options: V) -> R<V> {
        let (signal, authorize) = if options.is_nullish() {
            if matches!(options, V::Null) {
                refuse("submit with null options (a TypeError at destructuring)");
            }
            (V::Undef, V::Undef)
        } else {
            (self.member(&options, "signal"), self.member(&options, "authorize"))
        };
        if !signal.is_nullish() {
            refuse("submit with an abort signal");
        }
        if !authorize.is_nullish() {
            refuse("submit with an authorize hook");
        }
        let s = self.clone();
        Ok(V::Promise(async_fn(async move {
            s.ensure_initialized().await?; // await scheduler.js:2550
            let inner = s.clone();
            let operation: Op = Box::new(move || {
                let inner = inner.clone();
                Ok(async_fn(async move {
                    let next = inner.prepare_submission_locked(input).await?; // await scheduler.js:2552
                    if !inner.tasks.borrow().has(&task_id(&next)) {
                        inner.commit_new_task_locked(next.clone()).await?; // await scheduler.js:2553
                    }
                    done(clone_task(&next))
                }))
            });
            let task = s.run_exclusive(operation)?.await?; // await scheduler.js:2551
            let launched = s.launch_committed_task(task).await?; // await scheduler.js:2556
            done(launched)
        })))
    }

    /// `prepareSubmissionLocked(input)` (scheduler.js:2416-2535), with no signal and no authorize hook.
    fn prepare_submission_locked(self: &Rc<Self>, input: V) -> P {
        let s = self.clone();
        async_fn(async move {
            if !matches!(input, V::Obj(_)) {
                refuse("a submission whose input is not a plain object");
            }
            wait(V::Undef).await?; // await scheduler.js:2419 (`authorize?.()` is undefined)
            let index = index_key(&input.get("rootSessionId"), &input.get("idempotencyKey"));
            let existing = s.idempotency_index.borrow().get(&index).cloned();
            if let Some(existing) = existing {
                let task = s.tasks.borrow().get(&existing).unwrap_or(V::Undef);
                return done(clone_task(&task));
            }
            if !matches!(input.get("allowDuplicate"), V::Bool(true))
                && !input.get("deadlineClass").is_str("council")
                && !input.get("parentTaskId").truthy()
                && let Some(fingerprint) = dispatch_fingerprint(&input)
            {
                let at = s.now()?;
                for candidate in s.tasks.borrow().values() {
                    if !candidate.get("rootSessionId").same(&input.get("rootSessionId")) || !is_active(&candidate) {
                        continue;
                    }
                    if at - num(&candidate.get("createdAt"), "createdAt") > primitives::DUPLICATE_DISPATCH_WINDOW_MS {
                        continue;
                    }
                    if dispatch_fingerprint(&candidate).as_ref() != Some(&fingerprint) {
                        continue;
                    }
                    return done(clone_task(&candidate));
                }
            }
            if input.get("readOnly").truthy() {
                refuse("a read-only submission (supportsManagedReadOnlyAgent)");
            }
            if !input.get("dispatchGroupId").is_nullish() {
                refuse("a grouped submission (handoff locks and dispatch waves)");
            }
            let root = input.get("rootSessionId");
            let active_mode = s
                .tasks
                .borrow()
                .values()
                .into_iter()
                .find(|task| task.get("rootSessionId").same(&root) && !is_terminal(task))
                .map(|task| task.get("mode"));
            if let Some(mode) = active_mode
                && mode.truthy()
                && !mode.same(&input.get("mode"))
            {
                return Err(s.error("mode_lease_conflict", format!("root {} is leased to {} mode", js_str(&root), js_str(&mode))));
            }
            if input.get("parentTaskId").truthy() {
                refuse("a submission with a parent task");
            }
            let id = s.call_fn(&s.create_task_id, Vec::new())?;
            let id_text = js_str(&id);
            if s.tasks.borrow().has(&id_text) {
                return Err(s.error("task_id_collision", format!("task ID {} already exists", id_text)));
            }
            if s.opt("resolveExecutionBackend").is_function() {
                refuse("options.resolveExecutionBackend");
            }
            for key in [
                "dispatchWaveId",
                "priorTaskId",
                "transportRecovery",
                "approvedPlanRef",
                "requiredChecks",
                "taskPrerequisites",
                "requiredCheckCorrections",
            ] {
                if !input.get(key).is_nullish() {
                    refuse(&format!("a submission with {key}"));
                }
            }
            if !matches!(input.get("dispatchObjectiveId"), V::Undef) {
                refuse("a submission with dispatchObjectiveId");
            }
            let or = |key: &str, fallback: V| {
                let value = input.get(key);
                if value.is_nullish() { fallback } else { value }
            };
            let sequence = s
                .tasks
                .borrow()
                .values()
                .iter()
                .fold(0.0, |sequence, task| js_max(sequence, num(&task.get("sequence"), "sequence")))
                + 1.0;
            let mut record = Props::new();
            record.set("taskId", id);
            record.set("idempotencyKey", input.get("idempotencyKey"));
            record.set("rootSessionId", root);
            record.set("dispatchGroupId", or("dispatchGroupId", V::Null));
            record.set("dispatchCallId", or("dispatchCallId", V::Null));
            record.set("dispatchWaveId", V::Null);
            record.set("parentTaskId", or("parentTaskId", V::Null));
            record.set("childSessionId", or("childSessionId", V::Null));
            record.set("transportRecovery", or("transportRecovery", V::Null));
            record.set("directory", input.get("directory"));
            record.set("sequence", V::Num(sequence));
            record.set("mode", input.get("mode"));
            record.set("readOnly", or("readOnly", V::Bool(false)));
            record.set("providerId", input.get("providerId"));
            record.set("modelId", input.get("modelId"));
            record.set("agent", input.get("agent"));
            record.set("variant", or("variant", V::Null));
            record.set("label", input.get("label"));
            record.set("prompt", input.get("prompt"));
            record.set("attempt", or("attempt", V::Num(1.0)));
            record.set("priorTaskId", or("priorTaskId", V::Null));
            record.set("executionKind", or("executionKind", V::str("start")));
            record.set("createdAt", V::Num(s.now()?));
            record.set("timeoutAt", or("timeoutAt", V::Null));
            record.set("recoveryLineageId", or("recoveryLineageId", V::Null));
            let next = V::from_tree(&pol(contract::create_managed_task_record(&tree(&V::from_props(record))))?);
            wait(V::Undef).await?; // await scheduler.js:2532 (`authorize?.()` is undefined)
            done(next)
        })
    }

    /// `launchCommittedTask(task)` (scheduler.js:2536-2547).
    fn launch_committed_task(self: &Rc<Self>, task: V) -> P {
        let s = self.clone();
        async_fn(async move {
            let current = s.tasks.borrow().get(&task_id(&task));
            let Some(current) = current else {
                refuse("a committed task gone before its launch (the logged admission failure)")
            };
            s.schedule_task_deadline(&current)?;
            if s.clone().pump().await.is_err() {
                // await scheduler.js:2539
                refuse("a committed task's failed launch admission (logger.warn and the admission retry)");
            }
            let committed = if s.uncommitted_read.get() {
                s.committed_read_state
                    .borrow()
                    .get("tasks")
                    .items()
                    .into_iter()
                    .find(|row| row.get("taskId").same(&task.get("taskId")))
            } else {
                s.tasks.borrow().get(&task_id(&task))
            };
            done(clone_task(&committed.unwrap_or(task)))
        })
    }

    // -------------------------------------------------------------- the pump and the launch

    /// `pump()` (scheduler.js:2031-2096).
    fn pump(self: Rc<Self>) -> P {
        async_fn(async move {
            if self.shut_down.get() {
                return done(V::Undef);
            }
            let admitted: Rc<RefCell<Vec<V>>> = Rc::new(RefCell::new(Vec::new()));
            let inner = self.clone();
            let list = admitted.clone();
            let operation: Op = Box::new(move || Ok(inner.pump_locked(list)));
            let outcome = match self.run_exclusive(operation) {
                Ok(promise) => promise.await, // await scheduler.js:2034
                Err(error) => Err(error),
            };
            // finally, scheduler.js:2088-2095
            for task in admitted.borrow().iter() {
                let current = self.tasks.borrow().get(&task_id(task));
                if !self.shut_down.get()
                    && let Some(current) = current
                    && current.get("status").is_str("starting")
                    && current.get("leaseToken").same(&task.get("leaseToken"))
                {
                    self.launch_task(task)?;
                }
            }
            outcome?;
            done(V::Undef)
        })
    }

    /// The exclusive operation of pump (scheduler.js:2034-2087).
    fn pump_locked(self: &Rc<Self>, admitted: Rc<RefCell<Vec<V>>>) -> P {
        let s = self.clone();
        async_fn(async move {
            if s.shut_down.get() {
                return done(V::Undef);
            }
            let mut queued: Vec<V> = s
                .tasks
                .borrow()
                .values()
                .into_iter()
                .filter(|task| task.get("status").is_str("queued"))
                .collect();
            sort_queue(&mut queued)?;
            let mut active_count = 0.0;
            let mut queued_count = 0.0;
            for task in s.tasks.borrow().values() {
                if is_active(&task) {
                    active_count += 1.0;
                } else if task.get("status").is_str("queued") {
                    queued_count += 1.0;
                }
            }
            let held = 0.0;
            for previous in queued {
                if has_length(&previous.get("taskPrerequisites")) {
                    refuse("a task with prerequisites in the pump (verifyTaskPrerequisites)");
                }
                let decision = s.resolve_launch_admission(&previous, active_count, queued_count).await?; // await scheduler.js:2063
                if !decision.get("admit").truthy() {
                    refuse("a held launch admission");
                }
                let lease = s.call_fn(&s.create_lease_token, Vec::new())?;
                let started = s.now()?;
                let next = with(
                    &previous,
                    vec![
                        ("status", V::str("starting")),
                        ("leaseToken", lease),
                        ("startedAt", V::Num(started)),
                        ("waitingReason", V::Null),
                    ],
                );
                s.commit_task_update_locked(previous.clone(), next.clone(), true).await?; // await scheduler.js:2080
                s.schedule_starting_lease(&next)?;
                admitted.borrow_mut().push(clone_task(&next));
                active_count += 1.0;
                queued_count -= 1.0;
            }
            let _ = (active_count, queued_count);
            s.admission_held_count.set(held);
            if held == 0.0 {
                s.clear_admission_retry()?;
            }
            done(V::Undef)
        })
    }

    /// `resolveLaunchAdmission(task, activeCount, queuedCount)` (scheduler.js:1974-2007), without a hook.
    fn resolve_launch_admission(&self, _task: &V, _active: f64, _queued: f64) -> P {
        if self.admit_launch.is_some() {
            refuse("options.admitLaunch (launch admission)");
        }
        async_fn(async move { done(V::object(vec![("admit", V::Bool(true))])) })
    }

    // -------------------------------------------------------------- waiting

    /// `waitForTask(taskId, { signal, timeoutMs } = {})` (scheduler.js:2854-2930), without a signal or a timeout.
    fn wait_for_task(self: &Rc<Self>, id: V, options: V) -> R<V> {
        if matches!(options, V::Null) {
            refuse("waitForTask with null options (a TypeError at destructuring)");
        }
        if !options.is_nullish() && (!self.member(&options, "signal").is_nullish() || !matches!(self.member(&options, "timeoutMs"), V::Undef)) {
            refuse("waitForTask with a signal or a timeout");
        }
        let s = self.clone();
        Ok(V::Promise(async_fn(async move {
            s.ensure_initialized().await?; // await scheduler.js:2859
            if s.shut_down.get() {
                return Err(s.error("scheduler_shut_down", "managed orchestration scheduler is shut down".into()));
            }
            let key = js_str(&id);
            let task = if matches!(id, V::Str(_)) { s.tasks.borrow().get(&key) } else { None };
            let Some(task) = task else {
                return Err(s.error("task_not_found", format!("managed task {key} was not found")));
            };
            if is_terminal(&task) {
                return done(clone_task(&task));
            }
            // `await new Promise(…)`: the waiter registers synchronously after the terminal check.
            let (promise, resolvers) = Promise::<V, V>::with_resolvers();
            s.task_waiters.borrow_mut().entry(key).or_default().push(resolvers);
            let value = promise.await?; // await scheduler.js:2872
            done(value)
        })))
    }

    /// `notifyTaskWaiters(task)` (scheduler.js:670).
    fn notify_task_waiters(&self, task: &V) {
        let waiters = self.task_waiters.borrow_mut().remove(&task_id(task));
        for waiter in waiters.unwrap_or_default() {
            waiter.fulfill(clone_task(task));
        }
    }

    // -------------------------------------------------------------- completion

    /// `finishTask(taskId, leaseToken, result, fallbackStatus)` (scheduler.js:1131-1187), with no settlement
    /// owner and no expected stop request.
    fn finish_task(self: &Rc<Self>, id: JsStr, lease: V, result: V, fallback: &'static str) -> P {
        let s = self.clone();
        async_fn(async move {
            if s.shut_down.get() {
                return done(V::Undef);
            }
            let changed = Rc::new(Cell::new(false));
            let inner = s.clone();
            let flag = changed.clone();
            let operation: Op = Box::new(move || Ok(inner.finish_task_locked(id, lease, result, fallback, flag)));
            s.run_exclusive(operation)?.await?; // await scheduler.js:1134
            if changed.get() && !s.recovering.get() {
                s.clone().pump().await?; // await scheduler.js:1186
            }
            done(V::Undef)
        })
    }

    /// The exclusive operation of finishTask (scheduler.js:1134-1185).
    fn finish_task_locked(self: &Rc<Self>, id: JsStr, lease: V, result: V, fallback: &'static str, changed: Rc<Cell<bool>>) -> P {
        let s = self.clone();
        async_fn(async move {
            let previous = s.tasks.borrow().get(&id);
            let Some(previous) = previous else { return done(V::Undef) };
            if is_terminal(&previous) || !previous.get("leaseToken").same(&lease) {
                return done(V::Undef);
            }
            if contract::has_pending_operator_stop(&tree(&previous)) {
                return done(V::Undef);
            }
            let field = |key: &str| {
                if matches!(result, V::Obj(_)) {
                    result.get(key)
                } else if result.is_nullish() {
                    V::Undef
                } else {
                    refuse("a settlement that is no object")
                }
            };
            let status = field("status");
            let terminal = matches!(&status, V::Str(text) if primitives::MANAGED_TASK_TERMINAL_STATUSES.iter().any(|name| text == *name));
            let mut status = if terminal { status } else { V::str(fallback) };
            let reason = field("failureReason");
            let mut failure = match &reason {
                V::Str(text) if !js_trim(text).is_empty() => V::Str(pol(contract::truncate_managed_text(
                    &tree(&reason),
                    &Value::Number(contract::MAX_MANAGED_TASK_FAILURE_BYTES as f64),
                ))?),
                _ => V::Null,
            };
            if previous.get("status").is_str("starting") && status.is_str("completed") {
                status = V::str("interrupted");
                failure = V::str("Executor completed before provider acceptance was recorded");
            }
            let finished = s.now()?;
            let mut changes = vec![("status", status), ("finishedAt", V::Num(finished)), ("failureReason", failure)];
            if field("terminationIntent").is_str("user_stopped") {
                changes.push(("terminationIntent", V::str("user_stopped")));
            }
            changes.push(("partial", V::Bool(field("partial").truthy())));
            let preview = field("recoverablePreview");
            let preview = if matches!(preview, V::Str(_)) {
                V::Str(pol(contract::truncate_managed_text(
                    &tree(&preview),
                    &Value::Number(contract::MAX_MANAGED_TASK_PREVIEW_BYTES as f64),
                ))?)
            } else {
                V::str("")
            };
            changes.push(("recoverablePreview", preview));
            let refs = field("canonicalRefs");
            changes.push(("canonicalRefs", if refs.is_array() { refs.array_map_spread() } else { V::array(Vec::new()) }));
            let next = with(&previous, changes);
            let reset = field("providerResetAt");
            let reset = if matches!(reset, V::Num(at) if at.is_finite()) { reset } else { V::Null };
            s.commit_terminal_task_locked(previous, next.clone(), field("resumable").truthy(), reset)
                .await?; // await scheduler.js:1171
            changed.set(true);
            // try { await parkAutoResumeLocked(next) } (scheduler.js:1177-1184): auto-resume is inert without
            // options.autoResume.attempt (the construction refuses it), so the park returns at once.
            s.park_auto_resume_locked().await?; // await scheduler.js:1178
            done(V::Undef)
        })
    }

    /// `parkAutoResumeLocked(task)` (scheduler.js:1440): `if (!autoResumeAttempt …) return;`.
    fn park_auto_resume_locked(&self) -> P {
        async_fn(async move { done(V::Undef) })
    }

    /// `commitTerminalTaskLocked(previous, next, { resumable, providerResetAt })` (scheduler.js:840-875).
    fn commit_terminal_task_locked(self: &Rc<Self>, previous: V, next: V, resumable: bool, reset: V) -> P {
        let s = self.clone();
        async_fn(async move {
            if has_length(&next.get("nativeJobSegments")) {
                refuse("a terminal commit with native job segments");
            }
            let same = |key: &JsStr| {
                let key = key.to_string_lossy();
                previous.get(&key).same(&next.get(&key))
            };
            pol(transitions::assert_managed_task_transition(&tree(&previous), &tree(&next), &same))?;
            let id = task_id(&next);
            let existing = s.result_envelopes.borrow().get(&id);
            let envelope = match &existing {
                Some(envelope) => envelope.clone(),
                None => {
                    let sequence = s
                        .result_envelopes
                        .borrow()
                        .values()
                        .iter()
                        .fold(0.0, |sequence, envelope| js_max(sequence, num(&envelope.get("sequence"), "sequence")))
                        + 1.0;
                    let finished = next.get("finishedAt");
                    let created = if finished.is_nullish() { V::Num(s.now()?) } else { finished };
                    let options = V::object(vec![
                        ("sequence", V::Num(sequence)),
                        ("createdAt", created),
                        ("resumable", V::Bool(resumable)),
                        ("providerResetAt", reset),
                    ]);
                    V::from_tree(&pol(devryan_scheduler_policy::envelope::create_managed_task_result_envelope(
                        &tree(&next),
                        &tree(&options),
                    ))?)
                }
            };
            // runCleanupFor (scheduler.js:920)
            let leased = matches!(next.get("leaseToken"), V::Str(ref token) if !token.is_empty());
            let child = matches!(next.get("childSessionId"), V::Str(ref text) if !text.is_empty());
            if s.opt("stopAttemptRuns").is_function() && !envelope.get("runCleanup").truthy() && child && leased {
                refuse("the run cleanup of a settled attempt (options.stopAttemptRuns)");
            }
            s.tasks.borrow_mut().set(id.clone(), next.clone());
            s.result_envelopes.borrow_mut().set(id.clone(), envelope);
            if let Err(error) = s.persist_locked().await {
                // await scheduler.js:858
                s.tasks.borrow_mut().set(task_id(&previous), previous.clone());
                if existing.is_none() {
                    s.result_envelopes.borrow_mut().delete(&id);
                }
                return Err(error);
            }
            s.clear_task_timeout(&id)?;
            s.clear_starting_lease(&id)?;
            s.clear_reconciliation_retry(&id)?;
            if s.tasks.borrow().has(&id) {
                s.queue_task_publication(&next)?;
            }
            s.notify_task_waiters(&next);
            // notifyResultCollectionWaiters: no collection waiter exists (those waits are not ported, and refused).
            done(V::Undef)
        })
    }

    /// `launchTask(task)` (scheduler.js:1760-1797).
    fn launch_task(self: &Rc<Self>, task: &V) -> R<()> {
        let id = task_id(task);
        if self.active_launches.borrow().has(&id) {
            return Ok(());
        }
        let lease = task.get("leaseToken");
        let control = self.create_task_control(id.clone(), lease.clone());
        let s = self.clone();
        let task = task.clone();
        let launch_id = id.clone();
        // scheduler.js:1765 `(async () => { … })()`
        let launch = async_fn(async move {
            if has_length(&task.get("taskPrerequisites")) {
                refuse("launch prerequisites (assertLaunchPrerequisites)");
            }
            let current = s.tasks.borrow().get(&launch_id);
            let Some(current) = current else { return done(V::Undef) };
            if !current.get("leaseToken").same(&lease) || is_terminal(&current) {
                return done(V::Undef);
            }
            let kind = task.get("executionKind");
            if kind.is_str("resume") || kind.is_str("retry_in_place") || kind.is_str("recover_in_place") {
                refuse("a launch that resumes or retries in place");
            }
            let method = s.member(&s.executor, "start");
            if !method.is_function() {
                refuse("a launch without executor.start (the logged failure)");
            }
            // try, scheduler.js:1766-1784
            let attempt: R<()> = async {
                let result = wait(s.call_fn(&method, vec![clone_task(&task), control])?).await?; // await scheduler.js:1783
                s.finish_task(launch_id.clone(), lease.clone(), result, "failed").await?; // await scheduler.js:1784
                Ok(())
            }
            .await;
            // catch, scheduler.js:1785-1790
            if let Err(error) = attempt {
                let reason = pol(devryan_scheduler_policy::retry::format_managed_task_failure_reason(&error_view(&error)))?;
                let failed = V::object(vec![("status", V::str("failed")), ("failureReason", V::Str(reason))]);
                s.finish_task(launch_id.clone(), lease.clone(), failed, "failed").await?; // await scheduler.js:1786
            }
            done(V::Undef)
        });
        self.active_launches.borrow_mut().set(id.clone(), launch.clone());
        let remove = |s: Rc<Sched>, id: JsStr| {
            move |_: V| -> R<Resolution<V, V>> {
                s.active_launches.borrow_mut().delete(&id);
                done(V::Undef)
            }
        };
        // scheduler.js:1793 `void launch.then(…, …)`
        let _ = launch.then(remove(self.clone(), id.clone()), remove(self.clone(), id));
        Ok(())
    }

    // -------------------------------------------------------------- the control object

    /// `createTaskControl(taskId, leaseToken)` (scheduler.js:1200-1353): its nine methods, in order.
    fn create_task_control(self: &Rc<Self>, id: JsStr, lease: V) -> V {
        let mut props = Props::new();
        for name in [
            "reserveNativeJobSegment",
            "recordNativeJobSegment",
            "readPriorFailureReason",
            "recordTransportRecovery",
        ] {
            props.set(name, V::func(name, move |_| refuse(&format!("the control method {name}"))));
        }
        let (s, task, token) = (self.clone(), id.clone(), lease.clone());
        props.set(
            "setChildSessionId",
            V::func("setChildSessionId", move |args| {
                Ok(V::Promise(s.set_child_session_id(
                    task.clone(),
                    token.clone(),
                    args.first().cloned().unwrap_or(V::Undef),
                )))
            }),
        );
        props.set(
            "assertPrerequisites",
            V::func("assertPrerequisites", |_| refuse("the control method assertPrerequisites")),
        );
        let (s, task, token) = (self.clone(), id, lease);
        props.set(
            "markAccepted",
            V::func("markAccepted", move |_| Ok(V::Promise(s.mark_accepted(task.clone(), token.clone())))),
        );
        for name in ["readPrimaryStepBudget", "recordProgress"] {
            props.set(name, V::func(name, move |_| refuse(&format!("the control method {name}"))));
        }
        V::from_props(props)
    }

    /// `control.setChildSessionId(childSessionId)` (scheduler.js:1256-1273).
    fn set_child_session_id(self: &Rc<Self>, id: JsStr, lease: V, child: V) -> P {
        let s = self.clone();
        async_fn(async move {
            if s.shut_down.get() {
                return done(V::Bool(false));
            }
            let inner = s.clone();
            let operation: Op = Box::new(move || {
                Ok(async_fn(async move {
                    let previous = inner.tasks.borrow().get(&id);
                    let Some(previous) = previous else { return done(V::Bool(false)) };
                    if is_terminal(&previous) || !previous.get("leaseToken").same(&lease) {
                        return done(V::Bool(false));
                    }
                    let owned = previous.get("childSessionId");
                    if owned.truthy() && !owned.same(&child) {
                        return Err(inner.error("child_session_conflict", format!("task {} already owns child session {}", id, js_str(&owned))));
                    }
                    if owned.same(&child) {
                        return done(V::Bool(true));
                    }
                    let next = with(&previous, vec![("childSessionId", child)]);
                    inner.commit_task_update_locked(previous, next, true).await?; // await scheduler.js:1270
                    done(V::Bool(true))
                }))
            });
            let result = s.run_exclusive(operation)?.await?; // await scheduler.js:1258
            done(result)
        })
    }

    /// `control.markAccepted()` (scheduler.js:1284-1301).
    fn mark_accepted(self: &Rc<Self>, id: JsStr, lease: V) -> P {
        let s = self.clone();
        async_fn(async move {
            if s.shut_down.get() {
                return done(V::Bool(false));
            }
            let inner = s.clone();
            let operation: Op = Box::new(move || {
                Ok(async_fn(async move {
                    let previous = inner.tasks.borrow().get(&id);
                    let Some(previous) = previous else { return done(V::Bool(false)) };
                    if !previous.get("leaseToken").same(&lease) {
                        return done(V::Bool(false));
                    }
                    if previous.get("status").is_str("running") {
                        return done(V::Bool(true));
                    }
                    if is_terminal(&previous) {
                        return done(V::Bool(false));
                    }
                    if !previous.get("status").is_str("starting") {
                        return Err(inner.error(
                            "invalid_acceptance_state",
                            format!("task {} cannot record provider acceptance from {}", id, js_str(&previous.get("status"))),
                        ));
                    }
                    let next = with(&previous, vec![("status", V::str("running"))]);
                    inner.commit_task_update_locked(previous, next, true).await?; // await scheduler.js:1298
                    inner.clear_starting_lease(&id)?;
                    done(V::Bool(true))
                }))
            });
            let result = s.run_exclusive(operation)?.await?; // await scheduler.js:1286
            done(result)
        })
    }
}

/// `dispatchFingerprint(input)` (scheduler.js:180-196), for ASCII prompts (the lowercasing of other text is
/// refused rather than guessed).
fn dispatch_fingerprint(input: &V) -> Option<JsStr> {
    let prompt = match input.get("prompt") {
        V::Str(text) => text,
        _ => JsStr::from(""),
    };
    if prompt.units().iter().any(|unit| *unit > 0x7f) {
        refuse("the duplicate fingerprint of a non-ASCII prompt (toLowerCase)");
    }
    let lower: Vec<u8> = prompt.units().iter().map(|unit| (*unit as u8).to_ascii_lowercase()).collect();
    let stripped = strip_scaffolding(&lower);
    // `.replace(/[^a-z0-9]+/g, ' ')`
    let mut normalized: Vec<u8> = Vec::new();
    let mut run = false;
    for byte in stripped {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            normalized.push(byte);
            run = false;
        } else if !run {
            normalized.push(b' ');
            run = true;
        }
    }
    // `.trim()`: only spaces remain outside [a-z0-9].
    let text = String::from_utf8(normalized).unwrap_or_default();
    let text = text.trim_matches(' ');
    if text.is_empty() {
        return None;
    }
    let part = |key: &str| {
        let value = input.get(key);
        if value.is_nullish() { JsStr::from("") } else { js_str(&value) }
    };
    let checks = input.get("requiredChecks");
    let checks = if checks.is_nullish() { V::array(Vec::new()) } else { checks };
    let checks = match devryan_scheduler_policy::jsv::stringify(&tree(&checks)) {
        Ok(Some(bytes)) => JsStr::from(String::from_utf8_lossy(&bytes).into_owned()),
        Ok(None) => JsStr::from(""),
        Err(_) => refuse("a fingerprint whose requiredChecks do not stringify"),
    };
    let mut out = JsStr::from("");
    for (index, item) in [
        part("rootSessionId"),
        part("dispatchObjectiveId"),
        part("directory"),
        part("agent"),
        JsStr::from(text),
        checks,
    ]
    .iter()
    .enumerate()
    {
        if index > 0 {
            out.push_units(&[0]);
        }
        out.push_units(item.units());
    }
    Some(out)
}

/// `.replace(/^\s*(?:find|scope|goal|task|context|deliverable|report|return)\s*:/gm, ' ')` on ASCII text.
fn strip_scaffolding(text: &[u8]) -> Vec<u8> {
    const WORDS: [&[u8]; 8] = [b"find", b"scope", b"goal", b"task", b"context", b"deliverable", b"report", b"return"];
    let space = |byte: u8| matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r');
    let line_start = |at: usize| at == 0 || matches!(text[at - 1], b'\n' | b'\r');
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if line_start(at) {
            let mut cursor = at;
            while cursor < text.len() && space(text[cursor]) {
                cursor += 1;
            }
            let mut matched = None;
            for word in WORDS {
                if text[cursor..].starts_with(word) {
                    let mut end = cursor + word.len();
                    while end < text.len() && space(text[end]) {
                        end += 1;
                    }
                    if end < text.len() && text[end] == b':' {
                        matched = Some(end + 1);
                    }
                    break;
                }
            }
            if let Some(end) = matched {
                out.push(b' ');
                at = end;
                continue;
            }
        }
        out.push(text[at]);
        at += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The normalisation of `dispatchFingerprint` (lowercase, scaffolding, non-alphanumerics, trim), against
    /// what Node gives for the same prompts.
    #[test]
    fn fingerprint_normalisation_is_the_javascript() {
        let normalise = |prompt: &str| {
            let lower: Vec<u8> = prompt.bytes().map(|byte| byte.to_ascii_lowercase()).collect();
            let mut out = String::new();
            let mut run = false;
            for byte in strip_scaffolding(&lower) {
                if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
                    out.push(byte as char);
                    run = false;
                } else if !run {
                    out.push(' ');
                    run = true;
                }
            }
            out.trim_matches(' ').to_owned()
        };
        for (prompt, expected) in [
            ("Perform fan-1.", "perform fan 1"),
            ("Task: Do X\nREPORT : y\n\n  goal:z", "do x y z"),
            ("returnx: no\nreturn:", "returnx no"),
            ("  \n\nFind: a", "a"),
            ("scope\t:b:c", "b c"),
            ("", ""),
            ("...", ""),
            ("Deliverable:\r\ncontext   :   q", "q"),
        ] {
            assert_eq!(normalise(prompt), expected, "{prompt:?}");
        }
    }

    #[test]
    fn math_max_and_min_keep_the_sign_of_zero_and_nan() {
        assert!(js_max(0.0, -0.0).is_sign_positive());
        assert!(js_max(-0.0, -0.0).is_sign_negative());
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert!(js_max(1.0, f64::NAN).is_nan());
        assert_eq!(js_min(3.0, f64::INFINITY), 3.0);
    }

    #[test]
    fn a_map_keeps_insertion_order_and_moves_a_key_set_again_after_a_delete() {
        let mut map: OMap<f64> = OMap::default();
        for (key, value) in [("a", 1.0), ("b", 2.0), ("c", 3.0)] {
            map.set(JsStr::from(key), value);
        }
        map.set(JsStr::from("a"), 4.0);
        assert_eq!(map.values(), vec![4.0, 2.0, 3.0]);
        assert!(map.delete(&JsStr::from("a")));
        map.set(JsStr::from("a"), 5.0);
        assert_eq!(map.values(), vec![2.0, 3.0, 5.0]);
        assert_eq!(map.len(), 3);
    }

    /// cloneTask copies canonicalRefs and the nested records; a spread shares them.
    #[test]
    fn clone_task_copies_what_the_javascript_copies() {
        let refs = V::array(vec![V::object(vec![("path", V::str("a"))])]);
        let reason = V::object(vec![("kind", V::str("capacity"))]);
        let task = V::object(vec![
            ("taskId", V::str("dvr_task_1")),
            ("canonicalRefs", refs.clone()),
            ("waitingReason", reason.clone()),
        ]);
        let cloned = clone_task(&task);
        assert!(!cloned.get("canonicalRefs").same(&refs));
        assert!(!cloned.get("canonicalRefs").items()[0].same(&refs.items()[0]));
        assert!(!cloned.get("waitingReason").same(&reason));
        assert!(matches!(cloned.get("transportRecovery"), V::Null));
        let spread = with(&task, vec![("status", V::str("starting"))]);
        assert!(spread.get("canonicalRefs").same(&refs));
        assert!(spread.get("waitingReason").same(&reason));
        let keys: Vec<String> = cloned.entries().iter().map(|(key, _)| key.to_string_lossy()).collect();
        assert_eq!(keys, ["taskId", "canonicalRefs", "waitingReason", "transportRecovery"]);
    }
}
