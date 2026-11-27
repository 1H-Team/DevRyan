//! Test-only (`test-hooks`): the Rust side of the Git runner and store
//! differential test (`scripts/ledger-native/store-differential.mjs`), the
//! twin of `scripts/ledger-native/store-js-arm.mjs`. One request per line,
//! one answer line each, on a loop with the real clock:
//!
//! - `{op: 'git' | 'tokens' | 'records' | 'read', …}`: one call of the
//!   runner (`crate::git`) inside an execution context with a signal,
//!   aborted at once, by a timer or not at all;
//! - `{op: 'store', id, steps}`: steps against the stores of scenario `id`
//!   (kept between requests), each awaited in turn; a step's outcome is its
//!   value or its error, shown as `show` prints them;
//! - `{op: 'env', set}`: the environment the ledger reads (`host::env`,
//!   `host::process_env`);
//! - `{op: 'census', settle}`: the readers, children, helper threads and
//!   descriptors alive; with `settle`, first runs the loop (its timers
//!   too) until no reader, source, pool job or helper thread is left, within
//!   30 s.
//!
//! The loop runs its due timers before each request, as Node's runs them
//! between requests (an idle reader closes on time). `Date.now()` is the
//! system's, `skew` ms ahead once a `skew` step set it.
//!
//! Written as a port is (one `async_fn` per async function, one `.await`
//! per JavaScript await), so the arms' awaits match.
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use ledger_core::js::JsStr;

use crate::agen::{self, AsyncGen, Co};
use crate::ctx::{Remote, run_in_remote_execution_context};
use crate::durability::mark_object_directory_pending;
use crate::git::{self, GitOptions, Input, Rows};
use crate::host::{self, EventLoop, RealClock};
use crate::js::{self, Promise, Resolution, async_fn};
use crate::signal::Controller;
use crate::store::{ChangeStore, Collect, Guard, StoreOptions, Values, open_change_store};
use crate::value::{JsError, Obj, W, to_js_string, to_number, truthy};
use crate::{Ret, WPromise};

/// The system's clocks, `Date.now()` moved by `SKEW`.
struct SkewedClock(RealClock);

impl host::Clock for SkewedClock {
    fn loop_ms(&self) -> i64 {
        self.0.loop_ms()
    }
    fn epoch_ms(&self) -> f64 {
        self.0.epoch_ms() + SKEW.with(std::cell::Cell::get)
    }
}

/// The sync shim (durability tests): the log and the faults to come.
#[derive(Default)]
struct SyncShim {
    faults: Vec<String>,
    log: Vec<String>,
    /// `filehandle.sync()` calls counted at the directory's open.
    calls: u64,
}

/// The object directory's handle opened (`durability`'s seam, test hooks).
pub fn durability_opened(directory: &str) {
    SYNC_SHIM.with(|shim| {
        if let Some(shim) = shim.borrow_mut().as_mut() {
            shim.log.push(format!("open {directory}"));
            shim.calls = crate::seams::sync_calls();
        }
    });
}

/// The outcome of the object directory's `sync` or `close` (`op`), logged,
/// and failed with EIO when the shim has that fault next (after the real
/// call, as the JavaScript arm's shim fails it).
pub fn durability_outcome(op: &str, directory: &str, outcome: Result<(), W>) -> Result<(), W> {
    SYNC_SHIM.with(|shim| {
        let mut shim = shim.borrow_mut();
        let Some(shim) = shim.as_mut() else {
            return outcome;
        };
        outcome?;
        // A sync the handle never made is logged as such (the shim wraps the
        // real call on the JavaScript arm; here the handle counts its calls).
        if op == "sync" && crate::seams::sync_calls() == shim.calls {
            shim.log.push(format!("{op} {directory} not made"));
            return Ok(());
        }
        let failed = shim
            .faults
            .iter()
            .position(|fault| fault == op)
            .map(|at| shim.faults.remove(at))
            .is_some();
        shim.log.push(format!(
            "{op} {directory} {}",
            if failed { "EIO" } else { "ok" }
        ));
        if !failed {
            return Ok(());
        }
        let syscall = if op == "sync" { "fsync" } else { "close" };
        let mut error = JsError::new("Error", &format!("EIO: i/o error, {syscall}"));
        error.set_field("errno", W::Number(-5.0));
        error.set_field("code", W::string("EIO"));
        error.set_field("syscall", W::string(syscall));
        Err(W::Error(Rc::new(error)))
    })
}

thread_local! {
    static SYNC_SHIM: RefCell<Option<SyncShim>> = const { RefCell::new(None) };
    static SKEW: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    /// The environment `host::env` reads, over the process's.
    static ENV: RefCell<HashMap<String, Option<String>>> = RefCell::new(HashMap::new());
    /// Each scenario's stores and registers.
    static SCENARIOS: RefCell<HashMap<String, Rc<Scenario>>> = RefCell::new(HashMap::new());
}

#[derive(Default)]
struct Scenario {
    stores: RefCell<HashMap<String, ChangeStore>>,
    registers: RefCell<HashMap<String, W>>,
}

fn text(value: &W) -> String {
    to_js_string(value).to_string_lossy()
}

fn list(value: &W) -> Vec<W> {
    match value {
        W::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn strings(value: &W) -> Vec<String> {
    list(value).iter().map(text).collect()
}

fn defined(value: &W) -> Option<W> {
    (!value.is_undefined()).then(|| value.clone())
}

/// A value as both arms print it: bytes as `{$bytes: base64}`, an error
/// as `{$error: {…}}`, `undefined` and the numbers JSON cannot hold tagged.
pub fn show(value: &W) -> W {
    match value {
        W::Undefined => W::object(vec![("$undefined", W::Bool(true))]),
        W::Number(number) if number.is_nan() => W::object(vec![("$num", W::string("NaN"))]),
        W::Number(number) if number.is_infinite() => W::object(vec![(
            "$num",
            W::string(if *number > 0.0 {
                "Infinity"
            } else {
                "-Infinity"
            }),
        )]),
        W::Number(number) if *number == 0.0 && number.is_sign_negative() => {
            W::object(vec![("$num", W::string("-0"))])
        }
        W::Bytes(bytes) => W::object(vec![(
            "$bytes",
            W::string(&ledger_core::base64::encode(bytes)),
        )]),
        W::Array(items) => W::Array(items.iter().map(show).collect()),
        W::Object(object) => {
            let mut out = Obj::new();
            for (key, value) in object.iter() {
                out.set(key.clone(), show(value));
            }
            W::Object(out)
        }
        W::Error(error) => {
            let mut out = Obj::new();
            out.put("name", W::String(error.name.clone()));
            let message = if error.name.to_string_lossy() == "SyntaxError" {
                W::string("<json>")
            } else {
                W::String(error.message.clone())
            };
            out.put("message", message);
            for key in [
                "code",
                "status",
                "command",
                "failure",
                "errno",
                "syscall",
                "committed",
                "rollbackFailed",
            ] {
                if let Some(value) = error.field(key) {
                    out.put(key, show(value));
                }
            }
            if let Some(errors) = &error.errors {
                out.put("errors", W::Array(errors.iter().map(show).collect()));
            }
            W::object(vec![("$error", W::Object(out))])
        }
        other => other.clone(),
    }
}

fn outcome(result: Result<W, W>) -> W {
    match result {
        Ok(value) => W::object(vec![("ok", show(&value))]),
        Err(error) => W::object(vec![("error", show(&error))]),
    }
}

fn error_with(code: &str, message: &str) -> W {
    let mut error = JsError::new("Error", message);
    error.set_field("code", W::string(code));
    W::Error(Rc::new(error))
}

/// The runner's options from a request (`env` as `[key, value | null]` pairs).
fn git_options(value: &W) -> GitOptions {
    let mut options = GitOptions::default();
    for pair in list(&value.get("env")) {
        let pair = list(&pair);
        let key = pair.first().map(text).unwrap_or_default();
        let value = pair
            .get(1)
            .filter(|value| !matches!(value, W::Null))
            .map(text);
        options.env.push((key, value));
    }
    if let W::String(input) = value.get("input") {
        options.input = Input::Text(input);
    }
    let rows = value.get("inputRows");
    if !rows.is_undefined() {
        options.input = Input::Rows(strings_gen(strings(&rows)));
    }
    let size = value.get("inputBytes");
    if !size.is_undefined() {
        options.input = Input::Bytes(Rc::new(vec![0x61; to_number(&size) as usize]));
    }
    options.timeout_ms = defined(&value.get("timeoutMs")).map(|ms| to_number(&ms));
    options.accept_exit_codes = list(&value.get("acceptExitCodes"))
        .iter()
        .map(to_number)
        .collect();
    options.limit = defined(&value.get("limit")).map(|limit| to_number(&limit));
    options.delimiter = defined(&value.get("delimiter")).map(|byte| to_number(&byte) as u8);
    options
}

/// `(async function* () { for (const row of rows) yield row; })()`.
fn strings_gen(rows: Vec<String>) -> AsyncGen<W, W> {
    agen::async_gen(move |co: Co<W, W>| async move {
        // port: for-of over an awaited value (`for (const row of rows)`, an array)
        for row in rows {
            co.yield_(Resolution::Value(W::string(&row))).await?;
        }
        Ok(())
    })
}

/// `(async function* () { for (const row of rows) yield row; })()` of values.
fn values_gen(rows: Vec<W>) -> AsyncGen<W, W> {
    agen::async_gen(move |co: Co<W, W>| async move {
        // port: for-of over an awaited value (`for (const row of rows)`, an array)
        for row in rows {
            co.yield_(Resolution::Value(row)).await?;
        }
        Ok(())
    })
}

/// Every value of an async iterable (`for await`), at most `take`.
fn drain(source: AsyncGen<W, W>, take: Option<usize>) -> WPromise {
    async_fn(async move {
        let mut out = Vec::new();
        let rows = agen::for_await(source);
        while let Some(row) = rows.next().await? {
            out.push(row);
            if take.is_some_and(|take| out.len() >= take) {
                rows.close().await?;
                break;
            }
        }
        Ok(Resolution::Value(W::Array(out)))
    })
}

/// Takes descriptors until `EMFILE`, then gives `free` of them back: the
/// rest, held until dropped.
// port: sync call (the descriptors a test holds)
fn hold_descriptors(free: usize) -> Vec<std::fs::File> {
    let mut held = Vec::new();
    loop {
        // port: sync call (the descriptors a test holds)
        match std::fs::File::open("/dev/null") {
            Ok(file) => held.push(file),
            Err(error) if error.raw_os_error() == Some(24) => break,
            Err(error) => panic!("taking descriptors: {error}"),
        }
    }
    for _ in 0..free {
        held.pop();
    }
    held
}

/// One runner request, in the execution context `ctx`.
fn runner(ctx: crate::ctx::Ctx, request: W) -> WPromise {
    let cwd = text(&request.get("cwd"));
    let args = strings(&request.get("args"));
    let options = git_options(&request.get("options"));
    match text(&request.get("op")).as_str() {
        "git" => git::git(&ctx, &cwd, &args, &options),
        "tokens" => {
            let take = defined(&request.get("breakAt")).map(|at| to_number(&at) as usize);
            drain(git::git_tokens(&ctx, &cwd, &args, &options), take)
        }
        "records" => {
            let rows = list(&request.get("rows"));
            let rows = if truthy(&request.get("rowsGen")) {
                Rows::Gen(values_gen(rows))
            } else {
                Rows::Array(rows)
            };
            drain(git::git_records(&ctx, &cwd, &args, rows, &options), None)
        }
        "read" => {
            // `Promise.allSettled(reads.map((r) => readGitObject(…)))`, a sync throw shown as such.
            // `atDescriptorLimit` (the Rust arm only): every descriptor taken
            // but that many while the reads run, given back when they settle.
            let held = defined(&request.get("atDescriptorLimit"))
                .map(|free| hold_descriptors(to_number(&free) as usize));
            let mut items = Vec::new();
            for read in list(&request.get("reads")) {
                let idle =
                    defined(&read.get("idleMs")).map_or(git::READER_IDLE_MS, |ms| to_number(&ms));
                let promise = match git::read_git_object_with(
                    &ctx,
                    &cwd,
                    &args,
                    &read.get("name"),
                    truthy(&read.get("check")),
                    idle,
                ) {
                    Ok(resolution) => Promise::resolve(resolution),
                    Err(error) => js::value(W::object(vec![("thrown", show(&error))])),
                };
                items.push(Resolution::Promise(promise));
            }
            let settled = Promise::all_settled(items);
            settled.then_ok(move |outcomes| {
                drop(held);
                Ok(Resolution::Value(W::Array(
                    outcomes.into_iter().map(outcome).collect(),
                )))
            })
        }
        other => Promise::reject(error_with("unknown_op", other)),
    }
}

/// A guard (`assertCurrent`) from a step: `{failAt, abortAt, async}`;
/// counts its calls, throws (or rejects) at `failAt`, aborts the request's
/// controller at `abortAt`.
fn guard(spec: &W, controller: &Controller, calls: Rc<RefCell<Vec<W>>>) -> Option<Guard> {
    if spec.is_undefined() {
        return None;
    }
    let fail_at = defined(&spec.get("failAt")).map(|at| to_number(&at) as usize);
    let abort_at = defined(&spec.get("abortAt")).map(|at| to_number(&at) as usize);
    let is_async = truthy(&spec.get("async"));
    let controller = controller.clone();
    let count = Rc::new(std::cell::Cell::new(0usize));
    Some(Rc::new(move || -> Ret {
        count.set(count.get() + 1);
        let at = count.get();
        calls.borrow_mut().push(W::Number(at as f64));
        if abort_at == Some(at) {
            controller.abort(error_with("call_aborted", "aborted by the guard"));
        }
        if fail_at == Some(at) {
            let revoked = error_with("guard_revoked", "the guard was revoked");
            return if is_async {
                Ok(Resolution::Promise(Promise::reject(revoked)))
            } else {
                Err(revoked)
            };
        }
        Ok(if is_async {
            Resolution::Promise(js::value(W::Undefined))
        } else {
            Resolution::Value(W::Undefined)
        })
    }))
}

fn state(store: &ChangeStore) -> W {
    W::object(vec![
        ("tree", store.tree().map_or(W::Null, W::String)),
        ("exists", W::Bool(store.exists())),
        ("pendingCount", W::Number(store.pending_count() as f64)),
    ])
}

/// `{$map: [[key, value], …]}`.
fn map_of(pairs: W) -> W {
    W::object(vec![("$map", pairs)])
}

fn store_of(scenario: &Scenario, name: &W) -> Result<ChangeStore, W> {
    scenario
        .stores
        .borrow()
        .get(&text(name))
        .cloned()
        .ok_or_else(|| error_with("no_store", &text(name)))
}

fn values_of(scenario: &Scenario, step: &W) -> Values {
    let values = list(&step.get("values"));
    if truthy(&step.get("valuesGen")) {
        Values::Gen(values_gen(values))
    } else {
        let _ = scenario;
        Values::Array(values)
    }
}

/// One step: its value (a promise for an async call, a value for a sync
/// one) or what it throws at once.
fn step(scenario: Rc<Scenario>, ctx: crate::ctx::Ctx, controller: Controller, step: W) -> Ret {
    let kind = text(&step.get("s"));
    if kind == "open" {
        let mut options = StoreOptions::default();
        let given = step.get("options");
        options.ref_ = defined(&given.get("ref"));
        options.listing_limit_bytes = defined(&given.get("listingLimitBytes"));
        options.persistent_index = truthy(&given.get("persistentIndex"));
        options.at = match given.get("at") {
            W::String(name) if name.to_string_lossy() == "@tree" => Some(
                store_of(&scenario, &given.get("of"))?
                    .tree()
                    .map_or(W::Null, W::String),
            ),
            other => defined(&other),
        };
        if text(&given.get("sync")) == "fail" {
            options.sync_objects = Some(Rc::new(|_| {
                Promise::reject(error_with("sync_failed", "the sync failed"))
            }));
        }
        let opened = open_change_store(
            &ctx,
            &text(&step.get("cwd")),
            &text(&step.get("gitDir")),
            options,
        );
        let (scenario, name) = (scenario.clone(), text(&step.get("as")));
        return Ok(Resolution::Promise(opened.then_ok(move |store| {
            let shown = state(&store);
            scenario.stores.borrow_mut().insert(name, store);
            Ok(Resolution::Value(shown))
        })));
    }
    if kind == "env" {
        set_env(&step.get("set"));
        return Ok(Resolution::Value(W::Undefined));
    }
    if kind == "syncShim" {
        SYNC_SHIM.with(|shim| {
            *shim.borrow_mut() = (!truthy(&step.get("off"))).then(|| SyncShim {
                faults: strings(&step.get("faults")),
                log: Vec::new(),
                calls: 0,
            });
        });
        return Ok(Resolution::Value(W::Undefined));
    }
    if kind == "syncLog" {
        return Ok(Resolution::Value(SYNC_SHIM.with(|shim| {
            shim.borrow().as_ref().map_or(W::Null, |shim| {
                W::Array(shim.log.iter().map(|line| W::string(line)).collect())
            })
        })));
    }
    if kind == "skew" {
        let ms = to_number(&step.get("ms"));
        let after = defined(&step.get("after")).map_or(0.0, |after| to_number(&after));
        return Ok(Resolution::Promise(Promise::executor(move |resolvers| {
            let _ = host::set_timeout(after, move || {
                SKEW.with(|skew| skew.set(ms));
                resolvers.fulfill(W::Undefined);
            });
            Ok(())
        })));
    }
    if kind == "read" {
        // `readGitObject(cwd, args, name, { check })` as a step (with `skew`
        // beside it in a `concurrent` step).
        return git::read_git_object(
            &ctx,
            &text(&step.get("cwd")),
            &strings(&step.get("args")),
            &step.get("name"),
            truthy(&step.get("check")),
        );
    }
    if kind == "abort" {
        controller.abort(error_with("call_aborted", "aborted by the scenario"));
        return Ok(Resolution::Value(W::Undefined));
    }
    if kind == "markPending" {
        mark_object_directory_pending(&text(&step.get("directory")));
        return Ok(Resolution::Value(W::Undefined));
    }
    if kind == "concurrent" {
        let steps = list(&step.get("steps"));
        let mut started = Vec::new();
        for inner in steps {
            let promise = match self::step(scenario.clone(), ctx.clone(), controller.clone(), inner)
            {
                Ok(resolution) => Promise::resolve(resolution),
                Err(error) => Promise::reject(error),
            };
            started.push(Resolution::Promise(promise));
        }
        return Ok(Resolution::Promise(Promise::all_settled(started).then_ok(
            |outcomes| {
                Ok(Resolution::Value(W::Array(
                    outcomes.into_iter().map(outcome).collect(),
                )))
            },
        )));
    }
    let store = store_of(&scenario, &step.get("st"))?;
    let take = defined(&step.get("take")).map(|at| to_number(&at) as usize);
    match kind.as_str() {
        "state" => Ok(Resolution::Value(state(&store))),
        "get" => Ok(Resolution::Promise(store.get(&ctx, &step.get("key")))),
        "set" => store
            .set(&step.get("key"), &step.get("value"))
            .map(|()| Resolution::Value(W::Undefined)),
        "remove" => store
            .remove(&step.get("key"))
            .map(|()| Resolution::Value(W::Undefined)),
        "entries" => Ok(Resolution::Promise(drain(
            store.entries(&ctx, &step.get("prefix")),
            take,
        ))),
        "list" => Ok(Resolution::Promise(drain(
            store.list(&ctx, &step.get("prefix")),
            take,
        ))),
        "records" => Ok(Resolution::Promise(drain(
            store.records(&ctx, None, None),
            take,
        ))),
        "recordsAcross" => {
            let rows = store.records(&ctx, None, None);
            let then = self::step(
                scenario.clone(),
                ctx.clone(),
                controller.clone(),
                step.get("then"),
            )?;
            Ok(Resolution::Promise(async_fn(async move {
                let stepped = Promise::resolve(then).await?;
                let read = drain(rows, None).await?;
                Ok(Resolution::Value(W::object(vec![
                    ("inner", stepped),
                    ("rows", read),
                ])))
            })))
        }
        "committedRows" => Ok(Resolution::Promise(drain(
            store.committed_rows(&ctx, &step.get("prefix")),
            take,
        ))),
        "readRows" => {
            let rows = store.committed_rows(&ctx, &step.get("prefix"));
            let (store, ctx) = (store.clone(), ctx.clone());
            Ok(Resolution::Promise(async_fn(async move {
                let rows = list(&drain(rows, None).await?);
                let read = drain(store.read_rows(&ctx, Values::Array(rows)), None).await?;
                Ok(Resolution::Value(read))
            })))
        }
        "setList" => {
            let collected = Rc::new(RefCell::new(Vec::new()));
            let collect: Option<Collect> = truthy(&step.get("collect")).then(|| {
                let collected = collected.clone();
                Rc::new(move |data: &JsStr, rows: usize| {
                    collected.borrow_mut().push(W::Array(vec![
                        W::String(data.clone()),
                        W::Number(rows as f64),
                    ]));
                }) as Collect
            });
            let first = defined(&step.get("firstPage")).map_or(0.0, |first| to_number(&first));
            let set = store.set_list(
                &ctx,
                &step.get("prefix"),
                values_of(&scenario, &step),
                truthy(&step.get("absent")),
                first,
                collect,
            );
            Ok(Resolution::Promise(set.then_ok(move |bytes| {
                Ok(Resolution::Value(W::object(vec![
                    ("bytes", bytes),
                    ("collected", W::Array(collected.borrow().clone())),
                ])))
            })))
        }
        "writeList" => {
            let written = store.write_list(values_of(&scenario, &step));
            let (scenario, name) = (scenario.clone(), text(&step.get("as")));
            Ok(Resolution::Promise(written.then_ok(move |value| {
                scenario
                    .registers
                    .borrow_mut()
                    .insert(name, value.get("objects"));
                Ok(Resolution::Value(value))
            })))
        }
        "setListObjects" => {
            let oids = match step.get("from") {
                W::String(name) => list(
                    &scenario
                        .registers
                        .borrow()
                        .get(&name.to_string_lossy())
                        .cloned()
                        .unwrap_or_default(),
                ),
                _ => list(&step.get("oids")),
            };
            let first = defined(&step.get("firstPage")).map_or(0.0, |first| to_number(&first));
            store
                .set_list_objects(&step.get("prefix"), &oids, first)
                .map(|()| Resolution::Value(W::Undefined))
        }
        "commit" => {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let guard = guard(&step.get("guard"), &controller, calls.clone());
            Ok(Resolution::Promise(store.commit(&ctx, guard).then(
                {
                    let calls = calls.clone();
                    move |value| {
                        Ok(Resolution::Value(W::object(vec![
                            ("value", value),
                            ("guardCalls", W::Array(calls.borrow().clone())),
                        ])))
                    }
                },
                move |error| {
                    let mut shown = match error {
                        W::Error(made) => (*made).clone(),
                        other => return Err(other),
                    };
                    shown.set_field("guardCalls", W::Array(calls.borrow().clone()));
                    Err(W::Error(Rc::new(shown)))
                },
            )))
        }
        "pin" => Ok(Resolution::Promise(store.pin(&ctx, &step.get("token")))),
        "release" => store
            .release(&ctx, &step.get("token"))
            .map(Resolution::Promise),
        "importPrefix" => {
            let source = match step.get("source") {
                W::String(name) if name.units().first() == Some(&u16::from(b'@')) => {
                    let of = JsStr::from_units(name.units()[1..].to_vec());
                    store_of(&scenario, &W::String(of))?
                        .tree()
                        .map_or(W::Null, W::String)
                }
                other => other,
            };
            let destination = defined(&step.get("destination"));
            Ok(Resolution::Promise(store.import_prefix(
                &ctx,
                &source,
                &step.get("prefix"),
                destination.as_ref(),
            )))
        }
        "prefixIdentity" => Ok(Resolution::Promise(
            store.prefix_identity(&ctx, &step.get("prefix")),
        )),
        "committedIdentity" => Ok(Resolution::Promise(
            store.committed_identity(&ctx, &step.get("prefix")),
        )),
        "prefixIdentities" => Ok(Resolution::Promise(
            store
                .prefix_identities(&ctx, list(&step.get("prefixes")))
                .then_ok(|pairs| Ok(Resolution::Value(map_of(pairs)))),
        )),
        "staged" => Ok(Resolution::Promise(
            store
                .staged(&ctx, &step.get("prefix"))
                .then_ok(|pairs| Ok(Resolution::Value(map_of(pairs)))),
        )),
        "stage" => {
            let inner = list(&step.get("steps"));
            let fail = truthy(&step.get("fail"));
            let (scenario, ctx, controller) = (scenario.clone(), ctx.clone(), controller.clone());
            Ok(Resolution::Promise(store.stage(Box::new(
                move || -> Ret {
                    for inner in inner {
                        self::step(scenario.clone(), ctx.clone(), controller.clone(), inner)?;
                    }
                    if fail {
                        return Err(error_with("stage_failed", "the staged action failed"));
                    }
                    Ok(Resolution::Value(W::string("staged")))
                },
            ))))
        }
        "leaseRef" => ChangeStore::lease_ref(&step.get("token"))
            .map(|name| Resolution::Value(W::String(name))),
        other => Err(error_with("unknown_step", other)),
    }
}

fn set_env(set: &W) {
    if let W::Object(object) = set {
        ENV.with(|env| {
            let mut env = env.borrow_mut();
            for (key, value) in object.iter() {
                let value = (!matches!(value, W::Null | W::Undefined)).then(|| text(value));
                host::set_process_env(&key.to_string_lossy(), value.as_deref());
                env.insert(key.to_string_lossy(), value);
            }
        });
    }
}

/// One request, in a remote execution context whose signal it may abort.
fn request_of(request: W) -> Promise<W, W> {
    let controller = Controller::new();
    let abort = request.get("abort");
    if text(&abort) == "before" {
        controller.abort(error_with("call_aborted", "aborted before the call"));
    } else if !abort.is_undefined() {
        let controller = controller.clone();
        let _ = host::set_timeout(to_number(&abort.get("ms")), move || {
            controller.abort(error_with("call_aborted", "aborted by a timer"));
        });
    }
    let captured = W::object(vec![("cancellable", W::Bool(true))]);
    let op = text(&request.get("op"));
    let action: crate::ctx::Action = {
        let controller = controller.clone();
        Box::new(move |ctx| -> Ret {
            if op == "store" {
                let id = text(&request.get("id"));
                let scenario = SCENARIOS.with(|scenarios| {
                    scenarios
                        .borrow_mut()
                        .entry(id)
                        .or_insert_with(|| Rc::new(Scenario::default()))
                        .clone()
                });
                let steps = list(&request.get("steps"));
                return Ok(Resolution::Promise(async_fn(async move {
                    let mut outcomes = Vec::new();
                    for item in steps {
                        let result =
                            match step(scenario.clone(), ctx.clone(), controller.clone(), item) {
                                Ok(resolution) => Promise::resolve(resolution).await,
                                Err(error) => Err(error),
                            };
                        outcomes.push(outcome(result));
                    }
                    Ok(Resolution::Value(W::Array(outcomes)))
                })));
            }
            Ok(Resolution::Promise(runner(ctx, request)))
        })
    };
    let settled = run_in_remote_execution_context(
        &captured,
        action,
        Remote {
            signal: Some(controller.signal()),
            on_report: None,
            on_progress: None,
            progress_ms: 250.0,
        },
    );
    settled.then_ok(|outcome| {
        Ok(Resolution::Value(if outcome.failed {
            W::object(vec![("error", show(&outcome.value))])
        } else {
            W::object(vec![("ok", show(&outcome.value))])
        }))
    })
}

/// `ledger-native-probe store`: one request per line, one answer line each.
pub fn serve(
    lines: impl Iterator<Item = Vec<u8>>,
    mut out: impl FnMut(&W),
    decode: impl Fn(&[u8]) -> Option<W>,
) {
    let event_loop = EventLoop::new(
        Box::new(SkewedClock(RealClock::new())),
        Box::new(|name: &str| {
            ENV.with(|env| env.borrow().get(name).cloned())
                .unwrap_or_else(|| std::env::var(name).ok())
        }),
        Box::new(|| {}),
    );
    host::install(event_loop.clone());
    for line in lines {
        let Some(request) = decode(&line) else {
            out(&W::object(vec![("corrupt", W::Bool(true))]));
            continue;
        };
        if text(&request.get("op")) == "env" {
            set_env(&request.get("set"));
            out(&W::object(vec![("ok", W::Bool(true))]));
            continue;
        }
        if text(&request.get("op")) == "census" {
            let mut waited = W::Undefined;
            if truthy(&request.get("settle")) {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                loop {
                    event_loop.checkpoint();
                    let left = (
                        git::live_readers(),
                        event_loop.blocking_pending(),
                        crate::node::net::live_threads(),
                    );
                    if left == (0, 0, 0) {
                        break;
                    }
                    if std::time::Instant::now() > deadline {
                        waited = W::string(&format!(
                            "readers, sources and pool jobs, helper threads still alive after 30 s: {left:?}"
                        ));
                        break;
                    }
                    event_loop.timers_phase();
                    event_loop.check_phase();
                    let wait = event_loop.poll_timeout().map_or(20, |ms| ms.min(20));
                    event_loop.poll_phase(Some(wait), &mut |_| {});
                }
            }
            out(&W::object(vec![
                ("readers", W::Number(git::live_readers() as f64)),
                (
                    "children",
                    W::Number(crate::node::child::live_children() as f64),
                ),
                (
                    "threads",
                    W::Number(crate::node::net::live_threads() as f64),
                ),
                (
                    "fds",
                    W::Number(crate::node::fs::open_descriptor_count() as f64),
                ),
                ("timeout", waited),
            ]));
            continue;
        }
        // Node runs the timers due between two requests (an idle reader's).
        event_loop.checkpoint();
        event_loop.timers_phase();
        event_loop.checkpoint();
        let answer: Rc<RefCell<Option<W>>> = Rc::default();
        {
            let answer = answer.clone();
            let promise = request_of(request);
            let _ = promise.then(
                move |value| {
                    *answer.borrow_mut() = Some(value);
                    Ok(Resolution::Value(()))
                },
                |_| Ok(Resolution::Value(())),
            );
        }
        event_loop.checkpoint();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            event_loop.checkpoint();
            // The live readers' Git processes stay (unreferenced in Node).
            if answer.borrow().is_some()
                && event_loop.blocking_pending() == git::reader_process_sources()
            {
                break;
            }
            if std::time::Instant::now() > deadline {
                *answer.borrow_mut() = Some(W::object(vec![(
                    "timeout",
                    W::string(&format!(
                        "the request did not settle within 60 s ({} sources and pool jobs open)",
                        event_loop.blocking_pending()
                    )),
                )]));
                break;
            }
            event_loop.timers_phase();
            event_loop.check_phase();
            let wait = event_loop.poll_timeout().map_or(20, |ms| ms.min(20));
            event_loop.poll_phase(Some(wait), &mut |_| {});
        }
        let shown = answer.borrow_mut().take().unwrap_or(W::Null);
        out(&shown);
    }
}
