//! The execution context of `execution-admission.js` as the ledger's worker
//! uses it. JavaScript keeps it in an `AsyncLocalStorage`; here it is passed
//! explicitly (`Ctx`), and a derived context is a copy of the store that
//! shares its meter and summary, as `{ ...store }` does.
//!
//! - deadline (`executionRemainingMs`), cancellation (`executionSignal`,
//!   `checkExecutionAdmission`), reports (`executionDiagnostic`,
//!   `executionReporting`);
//! - the progress meter (`executionProgress`, `withExecutionSlotWait`,
//!   `withExecutionMeter`, followed meters);
//! - summaries (`executionStep`, `timedExecutionStep`, 32 steps at most);
//! - `executionPhase`, `quietExecutionPhase`, `withoutExecutionDeadline`,
//!   `waitForExecutionQueue`, `executionCleanup` (5 s of runnable time, 60 s cap);
//! - `runInRemoteExecutionContext`, the worker's side of a call: progress
//!   forwarded on change and every 250 ms, and once more when it settles.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use ledger_core::js::{JsStr, number_to_string};

use crate::host::{self, Timeout};
use crate::js::{Promise, Resolution, async_fn};
use crate::signal::{Controller, Signal};
use crate::stall::host_deadline_expired;
use crate::value::{JsError, Obj, W, js_max, js_min, status_error, to_number, truthy};
use crate::{Report, Ret, WPromise};

const SLOW_PHASE_MS: f64 = 2_000.0;
const MAX_SUMMARY_STEPS: usize = 32;
/// The summary root of a remote call; no phase is named this.
pub const REMOTE_ROOT: &str = "\0remote";
const TIMEOUT_CODES: [&str; 5] = [
    "local_execution_timeout",
    "execution_preparation_stalled",
    "execution_poller_lost",
    "workspace_changing",
    "local_execution_cleanup_timeout",
];

/// A progress meter: `{ progress, waiters, following }`.
#[derive(Clone)]
pub struct Meter(pub Rc<RefCell<MeterState>>);

pub struct MeterState {
    pub progress: f64,
    pub waiters: f64,
    pub following: Option<Meter>,
}

impl Meter {
    pub fn new(progress: f64) -> Meter {
        Meter(Rc::new(RefCell::new(MeterState {
            progress,
            waiters: 0.0,
            following: None,
        })))
    }

    pub fn same(&self, other: &Meter) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// One summary step: `{ count, elapsedMs }`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub count: f64,
    pub elapsed_ms: f64,
}

#[derive(Clone)]
pub struct Summary(pub Rc<RefCell<SummaryState>>);

pub struct SummaryState {
    pub root: JsStr,
    pub steps: Vec<(JsStr, Step)>,
    pub min_ms: f64,
    pub slow_ms: f64,
}

/// `createSummary(summary, root)`.
pub fn create_summary(summary: &W, root: &str) -> Summary {
    let min = to_number(&summary.get("minMs"));
    let min = if min.is_nan() || min == 0.0 { 0.0 } else { min };
    let slow = to_number(&summary.get("slowMs"));
    Summary(Rc::new(RefCell::new(SummaryState {
        root: JsStr::from(root),
        steps: Vec::new(),
        min_ms: js_max(0.0, min),
        slow_ms: if slow > 0.0 { slow } else { SLOW_PHASE_MS },
    })))
}

/// The store of an execution context.
#[derive(Clone, Default)]
pub struct Store {
    pub signal: Option<Signal>,
    /// `undefined` when the work has none.
    pub deadline: W,
    pub report: Option<Report>,
    pub meter: Option<Meter>,
    pub summary: Option<Summary>,
    pub observe_only: bool,
}

/// The current execution context, or none.
pub type Ctx = Option<Rc<Store>>;

/// An action run inside a context: a JavaScript function called there.
pub type Action = Box<dyn FnOnce(Ctx) -> Ret>;

/// `await action()`: a value or promise it returns is awaited (one job at
/// least); what it throws is thrown at once, with no job.
// port: inline await (one JavaScript `await`, not a JavaScript function)
async fn await_call(called: Ret) -> Result<W, W> {
    match called {
        Ok(resolution) => Promise::resolve(resolution).await,
        Err(reason) => Err(reason),
    }
}

fn value(result: Result<W, W>) -> Ret {
    result.map(Resolution::Value)
}

fn report(ctx: &Ctx, record: W) {
    if let Some(report) = ctx.as_ref().and_then(|store| store.report.clone()) {
        report(record);
    }
}

/// `executionRemainingMs()`.
pub fn execution_remaining_ms(ctx: &Ctx) -> f64 {
    let deadline = match ctx.as_ref().map(|store| &store.deadline) {
        None | Some(W::Undefined | W::Null) => f64::INFINITY,
        Some(deadline) => to_number(deadline),
    };
    js_max(0.0, deadline - host::now())
}

/// `executionDiagnostic(record)`.
pub fn execution_diagnostic(ctx: &Ctx, record: W) {
    report(ctx, record);
}

/// `executionReporting()`.
pub fn execution_reporting(ctx: &Ctx) -> bool {
    ctx.as_ref().is_some_and(|store| store.report.is_some())
}

/// `executionSignal()`.
pub fn execution_signal(ctx: &Ctx) -> Option<Signal> {
    ctx.as_ref().and_then(|store| store.signal.clone())
}

/// `checkExecutionAdmission()`.
pub fn check_execution_admission(ctx: &Ctx) -> Result<(), W> {
    match execution_signal(ctx) {
        Some(signal) => signal.throw_if_aborted(),
        None => Ok(()),
    }
}

/// `executionProgressMeter()`.
pub fn execution_progress_meter(ctx: &Ctx) -> Option<Meter> {
    ctx.as_ref().and_then(|store| store.meter.clone())
}

/// `executionProgress()`.
pub fn execution_progress(ctx: &Ctx) {
    if let Some(meter) = execution_progress_meter(ctx) {
        meter.0.borrow_mut().progress = host::now();
    }
}

/// `withExecutionSlotWait(action)`: an async function.
pub fn with_execution_slot_wait(ctx: &Ctx, action: impl FnOnce() -> Ret + 'static) -> WPromise {
    let current = execution_progress_meter(ctx);
    async_fn(async move {
        if let Some(meter) = &current {
            meter.0.borrow_mut().waiters += 1.0;
        }
        // try { return await action(); } finally { … }
        let result = await_call(action()).await;
        if let Some(meter) = &current {
            let mut state = meter.0.borrow_mut();
            state.waiters -= 1.0;
            state.progress = host::now();
        }
        value(result)
    })
}

/// `withoutExecutionDeadline`: the context without its signal and deadline.
pub fn without_execution_deadline(ctx: &Ctx) -> Ctx {
    ctx.as_ref().map(|store| {
        Rc::new(Store {
            signal: None,
            deadline: W::Undefined,
            ..(**store).clone()
        })
    })
}

/// `followedProgress(meter)`: `{ progress, waiting }`.
pub fn followed_progress(start: &Meter) -> (f64, bool) {
    let mut progress = start.0.borrow().progress;
    let mut waiting = false;
    let mut seen: Vec<Meter> = Vec::new();
    let mut meter = Some(start.clone());
    while let Some(current) = meter {
        if seen.iter().any(|known| known.same(&current)) {
            break;
        }
        let state = current.0.borrow();
        progress = js_max(progress, state.progress);
        waiting = waiting || state.waiters > 0.0;
        let next = state.following.clone();
        drop(state);
        seen.push(current);
        meter = next;
    }
    (progress, waiting)
}

/// `recordStep(current, phase, elapsedMs, count)`.
pub fn record_step(ctx: &Ctx, phase: &JsStr, elapsed_ms: f64, count: f64) {
    let Some(summary) = ctx.as_ref().and_then(|store| store.summary.clone()) else {
        return;
    };
    let mut state = summary.0.borrow_mut();
    match state.steps.iter_mut().find(|(name, _)| name == phase) {
        Some((_, step)) => {
            step.count += count;
            step.elapsed_ms += elapsed_ms;
        }
        None => {
            if state.steps.len() >= MAX_SUMMARY_STEPS {
                return;
            }
            state
                .steps
                .push((phase.clone(), Step { count, elapsed_ms }));
        }
    }
}

/// `formatSteps(steps)`: `phase:count/elapsedMs`, comma-joined.
pub fn format_steps(summary: &Summary) -> JsStr {
    let mut out = JsStr::new();
    for (index, (phase, step)) in summary.0.borrow().steps.iter().enumerate() {
        if index > 0 {
            out.push_str(",");
        }
        out.push_units(phase.units());
        out.push_str(&format!(
            ":{}/{}",
            number_to_string(step.count),
            number_to_string(step.elapsed_ms)
        ));
    }
    out
}

/// `executionStep(phase, elapsedMs, count)`; `count` is `None` when omitted.
pub fn execution_step(ctx: &Ctx, phase: &JsStr, elapsed_ms: f64, count: Option<&W>) {
    let count = match count {
        None => 1.0,
        Some(value @ W::Number(n)) if crate::value::is_safe_integer(value) && *n >= 0.0 => *n,
        Some(_) => 1.0,
    };
    record_step(ctx, phase, elapsed_ms, count);
}

/// `timedExecutionStep(phase, action)`: an async function; with no summary
/// it returns the action's promise (`return action()`), which its own
/// promise follows two jobs later.
pub fn timed_execution_step(
    ctx: &Ctx,
    phase: &JsStr,
    action: impl FnOnce() -> Ret + 'static,
) -> WPromise {
    let (ctx, phase) = (ctx.clone(), phase.clone());
    async_fn(async move {
        if ctx.as_ref().is_none_or(|store| store.summary.is_none()) {
            return action();
        }
        let started = host::now();
        let result = await_call(action()).await;
        record_step(&ctx, &phase, host::now() - started, 1.0);
        value(result)
    })
}

fn record(entries: Vec<(&str, W)>) -> W {
    W::Object(Obj::with(entries))
}

/// The failure a phase rethrows: the abort reason, a local timeout for a
/// lock or capture timeout of work that has a context, or the cause.
fn phase_failure(ctx: &Ctx, cause: W) -> W {
    if let Some(signal) = execution_signal(ctx).filter(Signal::aborted) {
        return signal.reason();
    }
    let timeout = ctx.as_ref().is_some_and(|store| !store.observe_only)
        && (matches!(cause.get("name"), W::String(name) if name == "TimeoutError")
            || matches!(cause.get("code"), W::String(code) if code == "capture_timeout" || code == "LOCK_TIMEOUT"));
    if !timeout {
        return cause;
    }
    let mut error = status_error("local_execution_timeout", 503.0);
    error.message = JsStr::from("local_execution_timeout");
    error.cause = Some(cause);
    W::Error(Rc::new(error))
}

fn failure_code(failure: &W) -> W {
    match failure.get("code") {
        W::String(code) if TIMEOUT_CODES.iter().any(|known| code == *known) => W::String(code),
        _ => W::string("local_execution_failed"),
    }
}

/// `executionPhase(phase, action)`: an async function.
pub fn execution_phase(
    ctx: &Ctx,
    phase: JsStr,
    action: impl FnOnce() -> Ret + 'static,
) -> WPromise {
    let ctx = ctx.clone();
    async_fn(async move {
        let started = host::now();
        let summary = ctx.as_ref().and_then(|store| store.summary.clone());
        let reported = Rc::new(Cell::new(false));
        let mut timer: Option<Timeout> = None;
        match &summary {
            None => report(
                &ctx,
                record(vec![
                    ("phase", W::String(phase.clone())),
                    ("state", W::string("started")),
                ]),
            ),
            Some(summary) => {
                let (ctx, phase, reported) = (ctx.clone(), phase.clone(), reported.clone());
                let slow = host::set_timeout(summary.0.borrow().slow_ms, move || {
                    reported.set(true);
                    report(
                        &ctx,
                        record(vec![
                            ("phase", W::String(phase)),
                            ("state", W::string("started")),
                            ("slow", W::Bool(true)),
                        ]),
                    );
                });
                slow.unref();
                timer = Some(slow);
            }
        }
        let settle = |record_value: W, failed: bool, elapsed: f64| {
            host::clear_optional(&timer);
            let Some(summary) = &summary else {
                report(&ctx, record_value);
                return;
            };
            let (root, min_ms, slow_ms) = {
                let state = summary.0.borrow();
                (state.root.clone(), state.min_ms, state.slow_ms)
            };
            if phase == root {
                if failed || elapsed >= min_ms {
                    let mut object = record_value.as_object().cloned().unwrap_or_default();
                    object.put("steps", W::String(format_steps(summary)));
                    report(&ctx, W::Object(object));
                }
                return;
            }
            record_step(&ctx, &phase, elapsed, 1.0);
            if reported.get() || failed || elapsed >= slow_ms {
                report(&ctx, record_value);
            }
        };
        let outcome = async {
            check_execution_admission(&ctx)?;
            let result = await_call(action()).await?;
            check_execution_admission(&ctx)?;
            Ok(result)
        }
        .await;
        match outcome {
            Ok(result) => {
                let elapsed = host::now() - started;
                settle(
                    record(vec![
                        ("phase", W::String(phase.clone())),
                        ("state", W::string("completed")),
                        ("elapsedMs", W::Number(elapsed)),
                    ]),
                    false,
                    elapsed,
                );
                Ok(Resolution::Value(result))
            }
            Err(cause) => {
                let failure = phase_failure(&ctx, cause);
                let elapsed = host::now() - started;
                settle(
                    record(vec![
                        ("phase", W::String(phase.clone())),
                        ("state", W::string("failed")),
                        ("elapsedMs", W::Number(elapsed)),
                        ("code", failure_code(&failure)),
                    ]),
                    true,
                    elapsed,
                );
                Err(failure)
            }
        }
    })
}

/// `quietExecutionPhase(phase, action, slowMs = 250)`: an async function.
pub fn quiet_execution_phase(
    ctx: &Ctx,
    phase: JsStr,
    action: impl FnOnce() -> Ret + 'static,
    slow_ms: f64,
) -> WPromise {
    let ctx = ctx.clone();
    async_fn(async move {
        let started = host::now();
        let outcome = async {
            check_execution_admission(&ctx)?;
            let result = await_call(action()).await?;
            check_execution_admission(&ctx)?;
            Ok(result)
        }
        .await;
        match outcome {
            Ok(result) => {
                let elapsed = host::now() - started;
                record_step(&ctx, &phase, elapsed, 1.0);
                if elapsed >= slow_ms {
                    report(
                        &ctx,
                        record(vec![
                            ("phase", W::String(phase)),
                            ("state", W::string("completed")),
                            ("elapsedMs", W::Number(elapsed)),
                            ("slow", W::Bool(true)),
                        ]),
                    );
                }
                Ok(Resolution::Value(result))
            }
            Err(cause) => {
                let failure = phase_failure(&ctx, cause);
                report(
                    &ctx,
                    record(vec![
                        ("phase", W::String(phase)),
                        ("state", W::string("failed")),
                        ("elapsedMs", W::Number(host::now() - started)),
                        ("code", failure_code(&failure)),
                    ]),
                );
                Err(failure)
            }
        }
    })
}

/// `waitForQueue(previous)`, a plain function: `previous` itself with no
/// signal, else a promise that only an abort settles early.
fn wait_for_queue(ctx: &Ctx, previous: WPromise) -> Result<WPromise, W> {
    let Some(signal) = execution_signal(ctx) else {
        return Ok(previous);
    };
    signal.throw_if_aborted()?;
    Ok(Promise::executor(|resolvers| {
        let listener = Rc::new(Cell::new(None));
        let cleanup = {
            let (signal, listener) = (signal.clone(), listener.clone());
            Rc::new(move || {
                if let Some(id) = listener.take() {
                    signal.remove_listener(id);
                }
            })
        };
        let (on_abort, aborting) = (cleanup.clone(), resolvers.clone());
        let id = signal.add_listener(move |reason| {
            on_abort();
            aborting.reject(reason.clone());
        });
        listener.set(Some(id));
        let (on_value, on_error) = (cleanup.clone(), cleanup);
        let (resolve, reject) = (resolvers.clone(), resolvers);
        let _ = previous.then::<()>(
            move |result| {
                on_value();
                resolve.fulfill(result);
                Ok(Resolution::Value(()))
            },
            move |error| {
                on_error();
                reject.reject(error);
                Ok(Resolution::Value(()))
            },
        );
        Ok(())
    }))
}

/// `waitForExecutionQueue(previous, progress)`: an async function.
pub fn wait_for_execution_queue(
    ctx: &Ctx,
    previous: WPromise,
    progress: Option<Meter>,
) -> WPromise {
    let ctx = ctx.clone();
    async_fn(async move {
        let meter = execution_progress_meter(&ctx);
        let following = meter
            .as_ref()
            .and_then(|meter| meter.0.borrow().following.clone());
        if let (Some(meter), Some(progress)) = (&meter, &progress)
            && !meter.same(progress)
        {
            meter.0.borrow_mut().following = Some(progress.clone());
        }
        let result = match wait_for_queue(&ctx, previous) {
            Ok(waiting) => waiting.await,
            Err(reason) => Err(reason),
        };
        if let Some(meter) = &meter {
            let mut state = meter.0.borrow_mut();
            state.following = following;
            state.progress = host::now();
        }
        value(result)
    })
}

/// `withExecutionMeter(action)`: the context the action runs in.
pub fn with_execution_meter(ctx: &Ctx) -> Ctx {
    if execution_progress_meter(ctx).is_some() {
        return ctx.clone();
    }
    let base = ctx
        .as_ref()
        .map(|store| (**store).clone())
        .unwrap_or_default();
    Some(Rc::new(Store {
        meter: Some(Meter::new(host::now())),
        ..base
    }))
}

/// `executionCleanup(action, { timeoutMs, capMs })`: an async function.
pub fn execution_cleanup(ctx: &Ctx, action: Action, timeout_ms: f64, cap_ms: f64) -> WPromise {
    let ctx = ctx.clone();
    async_fn(async move {
        let controller = Controller::new();
        let started = host::now();
        let timer = {
            let controller = controller.clone();
            host::set_interval(js_min(timeout_ms, 250.0), move || {
                if host_deadline_expired(started, timeout_ms, cap_ms) {
                    controller.abort(W::Error(Rc::new(status_error(
                        "local_execution_cleanup_timeout",
                        503.0,
                    ))));
                }
            })
        };
        timer.unref();
        let base = ctx
            .as_ref()
            .map(|store| (**store).clone())
            .unwrap_or_default();
        let inner: Ctx = Some(Rc::new(Store {
            signal: Some(controller.signal()),
            ..base
        }));
        let phase_ctx = inner.clone();
        let result =
            execution_phase(&phase_ctx, JsStr::from("cleanup"), move || action(inner)).await;
        host::clear_timeout(&timer);
        value(result)
    })
}

/// What a remote call settled with: `{ failed, result | failure, steps }`.
#[derive(Clone)]
pub struct Outcome {
    pub failed: bool,
    pub value: W,
    pub steps: Vec<(JsStr, Step)>,
}

/// The forwarding hooks of a remote call.
pub struct Remote {
    pub signal: Option<Signal>,
    pub on_report: Option<Report>,
    pub on_progress: Option<Rc<dyn Fn(bool)>>,
    pub progress_ms: f64,
}

fn outcome(result: Result<W, W>, steps: Vec<(JsStr, Step)>) -> Outcome {
    match result {
        Ok(value) => Outcome {
            failed: false,
            value,
            steps,
        },
        Err(value) => Outcome {
            failed: true,
            value,
            steps,
        },
    }
}

/// `runInRemoteExecutionContext(captured, action, { signal, onReport, onProgress, progressMs })`:
/// an async function.
pub fn run_in_remote_execution_context(
    captured: &W,
    action: Action,
    remote: Remote,
) -> Promise<Outcome, W> {
    let captured = captured.clone();
    async_fn(async move {
        if !truthy(&captured) {
            let result = await_call(action(None)).await;
            return Ok(Resolution::Value(outcome(result, Vec::new())));
        }
        let meter = truthy(&captured.get("metered")).then(|| Meter::new(host::now()));
        let summary_value = captured.get("summary");
        let summary = truthy(&summary_value).then(|| create_summary(&summary_value, REMOTE_ROOT));
        let last: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
        let forward = {
            let (meter, last, on_progress) =
                (meter.clone(), last.clone(), remote.on_progress.clone());
            Rc::new(move || {
                let Some(meter) = &meter else { return };
                let (progress, waiting) = followed_progress(meter);
                let next = format!("{}:{}", number_to_string(progress), waiting);
                if last.borrow().as_deref() != Some(next.as_str()) {
                    *last.borrow_mut() = Some(next);
                    if let Some(on_progress) = &on_progress {
                        on_progress(waiting);
                    }
                }
            })
        };
        let timer = meter.as_ref().map(|_| {
            let forward = forward.clone();
            let timer = host::set_interval(remote.progress_ms, move || forward());
            timer.unref();
            timer
        });
        let deadline = match captured.get("deadline") {
            W::Null => W::Undefined,
            other => other,
        };
        let reporting = truthy(&captured.get("reporting"));
        let store = Store {
            signal: if truthy(&captured.get("cancellable")) {
                remote.signal.clone()
            } else {
                None
            },
            deadline,
            report: if reporting {
                remote.on_report.clone().or_else(|| Some(Rc::new(|_| {})))
            } else {
                None
            },
            meter: meter.clone(),
            summary: summary.clone(),
            observe_only: truthy(&captured.get("observeOnly")),
        };
        let result = await_call(action(Some(Rc::new(store)))).await;
        let steps = summary
            .map(|summary| summary.0.borrow().steps.clone())
            .unwrap_or_default();
        host::clear_optional(&timer);
        forward();
        Ok(Resolution::Value(outcome(result, steps)))
    })
}

/// A `TypeError` with this message (a misused argument).
pub fn type_error(message: &str) -> W {
    js_error("TypeError", message)
}

/// An error JavaScript throws itself (`TypeError`, `RangeError`).
pub fn js_error(name: &str, message: &str) -> W {
    W::Error(Rc::new(JsError::new(name, message)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::testing::test_loop;
    use crate::signal::listener_count;

    /// C09 of the third review: a queue wait removes its abort listener when
    /// `previous` settles (`cleanup()` in both reactions), so a long-lived
    /// signal does not collect one listener per wait.
    #[test]
    fn a_queue_wait_removes_its_abort_listener_when_it_settles() {
        let (event_loop, _) = test_loop();
        let controller = Controller::new();
        let ctx: Ctx = Some(Rc::new(Store {
            signal: Some(controller.signal()),
            ..Store::default()
        }));
        let (previous, open) = Promise::<W, W>::with_resolvers();
        let waited = wait_for_execution_queue(&ctx, previous, None);
        assert_eq!(listener_count(&controller.signal()), 1);
        open.fulfill(W::string("done"));
        event_loop.checkpoint();
        assert!(waited.is_settled());
        assert_eq!(listener_count(&controller.signal()), 0);
    }
}
