//! Test-only (`test-hooks`): the stub methods of the conformance suite, the
//! Rust twin of `scripts/ledger-native/stub-interpreter.mjs`. A program is
//! an array of ops over the execution context, the I/O pool, host
//! callbacks, observers, streams and errors; both interpreters must make
//! the same messages of it. The product's methods stay unported beside them.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use ledger_core::js::JsStr;

use crate::ctx::{self, Ctx, Meter};
use crate::host;
use crate::iopool::with_execution_io;
use crate::js::{self, Coroutine, Promise, Resolution, Resolvers, async_fn};
use crate::runtime::{Factory, Observers, Runtime, Scope, UnportedRuntime};
use crate::value::{
    ERROR_FIELDS, Func, IterStep, JsError, Obj, Stream, W, to_js_string, to_number,
};
use crate::wire::encode_wire_error;
use crate::{Report, Ret, WPromise};

/// Sinks of the virtual-clock runner: the event log and its epoch.
pub struct Log {
    pub events: RefCell<Vec<W>>,
    pub epoch: f64,
}

/// A gate: its promise and the functions that settle it.
type Gate = (WPromise, Resolvers<W, W>);

/// State shared by every program of one process.
pub struct Global {
    gates: RefCell<HashMap<JsStr, Gate>>,
    meters: RefCell<HashMap<JsStr, Option<Meter>>>,
    observers: Option<Rc<dyn Observers>>,
    pub log: Option<Rc<Log>>,
}

impl Global {
    pub fn new(observers: Option<Rc<dyn Observers>>, log: Option<Rc<Log>>) -> Rc<Global> {
        Rc::new(Global {
            gates: RefCell::new(HashMap::new()),
            meters: RefCell::new(HashMap::new()),
            observers,
            log,
        })
    }

    /// `gate(global, name)`: made on first use as `new Promise(…)` with
    /// `promise.catch(() => {})`, so a failed gate is never unhandled.
    fn gate(&self, name: &W) -> (WPromise, Resolvers<W, W>) {
        let name = to_js_string(name);
        if let Some(entry) = self.gates.borrow().get(&name) {
            return entry.clone();
        }
        let (promise, resolvers) = Promise::with_resolvers();
        let _ = promise.catch(|_| Ok(Resolution::Value(W::Undefined)));
        self.gates
            .borrow_mut()
            .insert(name, (promise.clone(), resolvers.clone()));
        (promise, resolvers)
    }

    fn has_observer(&self, observer: &str) -> bool {
        self.observers
            .as_ref()
            .is_some_and(|observers| observers.has(observer))
    }
}

/// One program's environment: input functions, registers, the cause.
pub struct Env {
    fns: Vec<W>,
    regs: RefCell<Obj>,
    global: Rc<Global>,
    scope: Scope,
    pub task: W,
}

impl Env {
    pub fn new(fns: Vec<W>, global: Rc<Global>, scope: Scope, task: W) -> Rc<Env> {
        Rc::new(Env {
            fns,
            regs: RefCell::new(Obj::new()),
            global,
            scope,
            task,
        })
    }

    fn store(&self, op: &W, value: W) {
        if let W::String(name) = op.get("as") {
            self.regs.borrow_mut().set(name, value);
        }
    }

    fn function(&self, index: &W) -> W {
        let index = to_number(index);
        if index >= 0.0 && index.fract() == 0.0 && (index as usize) < self.fns.len() {
            self.fns[index as usize].clone()
        } else {
            W::Undefined
        }
    }

    fn observe(&self, observer: &str, payload: W) -> Result<(), W> {
        self.observe_in(observer, payload, &self.scope)
    }

    fn observe_in(&self, observer: &str, payload: W, scope: &Scope) -> Result<(), W> {
        match &self.global.observers {
            Some(observers) if observers.has(observer) => {
                observers.observe(observer, payload, scope)
            }
            _ => Ok(()),
        }
    }
}

/// Calls a function value (`fn(...args)`): what it returns or throws; a
/// value that is not a function throws the `TypeError` V8 names it by.
fn call_value(func: &W, args: Vec<W>, cause: &W, shown: &str) -> Ret {
    match func {
        W::Function(func) => (func.call)(args, cause),
        _ => Err(ctx::type_error(&format!("{shown} is not a function"))),
    }
}

/// `await x` of what a call returned (a throw is thrown at once).
// port: inline await (one JavaScript `await`, not a JavaScript function)
async fn awaited(called: Ret) -> Result<W, W> {
    match called {
        Ok(resolution) => Promise::resolve(resolution).await,
        Err(reason) => Err(reason),
    }
}

fn plain_stub(template: &W) -> Option<(JsStr, &Obj)> {
    match template {
        W::Object(object) => match object.get("$stub") {
            Some(W::String(kind)) => Some((kind.clone(), object)),
            Some(_) => Some((JsStr::from("?"), object)),
            None => None,
        },
        _ => None,
    }
}

/// A template's value.
pub fn value(template: &W, env: &Rc<Env>) -> Result<W, W> {
    if let W::Array(items) = template {
        return items
            .iter()
            .map(|item| value(item, env))
            .collect::<Result<_, _>>()
            .map(W::Array);
    }
    let Some((kind, spec)) = plain_stub(template) else {
        if let W::Object(object) = template {
            let mut out = Obj::new();
            for (key, item) in object.iter() {
                out.set(key.clone(), value(item, env)?);
            }
            return Ok(W::Object(out));
        }
        return Ok(template.clone());
    };
    let field = |key: &str| spec.get(key).cloned().unwrap_or(W::Undefined);
    Ok(match kind.to_string_lossy().as_str() {
        "error" => make_error(spec, env)?,
        "fn" => W::Function(Rc::new(Func {
            source: "() => 'local'",
            call: Box::new(|_, _| Ok(Resolution::Value(W::string("local")))),
        })),
        "stream" => make_stream(spec, env)?,
        "deep" => {
            let mut out = value(&field("leaf"), env)?;
            let depth = to_number(&field("depth"));
            let mut level = 0.0;
            while level < depth {
                out = W::Array(vec![out]);
                level += 1.0;
            }
            out
        }
        "reg" => match field("name") {
            W::String(name) => env
                .regs
                .borrow()
                .get_js(&name)
                .cloned()
                .unwrap_or(W::Undefined),
            _ => W::Undefined,
        },
        "regs" => W::Object(env.regs.borrow().clone()),
        "fnarg" => env.function(&field("index")),
        other => return Err(ctx::type_error(&format!("unknown stub value {other}"))),
    })
}

fn make_error(spec: &Obj, env: &Rc<Env>) -> Result<W, W> {
    let message = value(spec.get("message").unwrap_or(&W::Undefined), env)?;
    let cause = match spec.get("cause") {
        Some(cause) => Some(value(cause, env)?),
        None => None,
    };
    let errors = match spec.get("errors") {
        Some(W::Array(items)) => Some(
            items
                .iter()
                .map(|item| value(item, env))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        _ => None,
    };
    let mut error = JsError::new(
        if errors.is_some() {
            "AggregateError"
        } else {
            "Error"
        },
        "",
    );
    if !message.is_undefined() {
        error.message = to_js_string(&message);
    }
    error.errors = errors;
    error.cause = cause;
    if let Some(W::String(name)) = spec.get("name") {
        error.name = name.clone();
    }
    if let Some(W::Object(fields)) = spec.get("fields") {
        for field in ERROR_FIELDS {
            if let Some(item) = fields.get(field) {
                error.set_field(field, value(item, env)?);
            }
        }
    }
    Ok(W::Error(Rc::new(error)))
}

/// What resumes the stream's generator: `next()` or `return()`.
#[derive(Clone)]
enum Completion {
    Normal,
    Return(W),
}

struct Request {
    completion: Completion,
    resolvers: Resolvers<IterStep, W>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GenState {
    SuspendedStart,
    SuspendedYield,
    Executing,
    AwaitingReturn,
    DrainingQueue,
    Completed,
}

/// The stub's stream: the async generator of `makeStream` (fixed chunks,
/// an optional host wait before each, an optional failure after the last,
/// a diagnostic in its `finally`), run by the specification's async
/// generator steps (AsyncGeneratorEnqueue, Resume, Yield with its Await,
/// CompleteStep, DrainQueue, AwaitReturn) over a `Coroutine`.
struct StubStream {
    name: W,
    chunks: Vec<W>,
    failure: Option<W>,
    wait: Option<W>,
    env: Rc<Env>,
    state: Cell<GenState>,
    queue: RefCell<VecDeque<Request>>,
    body: RefCell<Option<Coroutine>>,
    resumed_with: RefCell<Completion>,
}

/// How the generator's body ended.
enum Ended {
    Normal,
    Return(W),
    Throw(W),
}

impl StubStream {
    fn done(value: W) -> IterStep {
        IterStep { done: true, value }
    }

    /// AsyncGeneratorCompleteStep: the first request settles.
    fn complete_step(&self, result: Result<W, W>, done: bool) {
        let Some(request) = self.queue.borrow_mut().pop_front() else {
            return;
        };
        match result {
            Ok(value) => request.resolvers.fulfill(IterStep { done, value }),
            Err(reason) => request.resolvers.reject(reason),
        }
    }

    /// AsyncGeneratorDrainQueue.
    fn drain_queue(self: &Rc<Self>) {
        loop {
            let front = self
                .queue
                .borrow()
                .front()
                .map(|request| request.completion.clone());
            match front {
                None => {
                    self.state.set(GenState::Completed);
                    return;
                }
                Some(Completion::Return(_)) => {
                    self.state.set(GenState::AwaitingReturn);
                    self.await_return();
                    return;
                }
                Some(Completion::Normal) => self.complete_step(Ok(W::Undefined), true),
            }
        }
    }

    /// AsyncGeneratorAwaitReturn: the return value is awaited (one job).
    fn await_return(self: &Rc<Self>) {
        let value = match self
            .queue
            .borrow()
            .front()
            .map(|request| request.completion.clone())
        {
            Some(Completion::Return(value)) => value,
            _ => W::Undefined,
        };
        let (on_value, on_error) = (self.clone(), self.clone());
        let _ = js::value::<W, W>(value).then::<()>(
            move |value| {
                on_value.state.set(GenState::DrainingQueue);
                on_value.complete_step(Ok(value), true);
                on_value.drain_queue();
                Ok(Resolution::Value(()))
            },
            move |reason| {
                on_error.state.set(GenState::DrainingQueue);
                on_error.complete_step(Err(reason), true);
                on_error.drain_queue();
                Ok(Resolution::Value(()))
            },
        );
    }

    /// AsyncGeneratorResume.
    fn resume(self: &Rc<Self>, completion: Completion) {
        self.state.set(GenState::Executing);
        *self.resumed_with.borrow_mut() = completion;
        if self.body.borrow().is_none() {
            let stream = self.clone();
            *self.body.borrow_mut() = Some(Coroutine::new(async move { stream.run_body().await }));
        }
        let body = self.body.borrow().clone().expect("the generator's body");
        body.resume();
    }

    /// `yield value` (AsyncGeneratorYield after its Await): what resumed it.
    // port: inline await (the generator's own `yield` steps, in its body)
    async fn yield_value(self: &Rc<Self>, value: W) -> Result<Completion, W> {
        let value = js::value::<W, W>(value).await?;
        self.complete_step(Ok(value), false);
        let next = self
            .queue
            .borrow()
            .front()
            .map(|request| request.completion.clone());
        let resumption = match next {
            Some(completion) => completion,
            None => {
                self.state.set(GenState::SuspendedYield);
                js::suspend().await;
                self.resumed_with.borrow().clone()
            }
        };
        // AsyncGeneratorUnwrapYieldResumption: a return awaits its value.
        match resumption {
            Completion::Normal => Ok(Completion::Normal),
            Completion::Return(value) => Ok(Completion::Return(js::value::<W, W>(value).await?)),
        }
    }

    /// The generator's body, then AsyncGeneratorStart's ending.
    // port: inline await (the generator's body, run only by its coroutine)
    async fn run_body(self: Rc<Self>) {
        let mut state = "return";
        let ended = async {
            for index in 0..self.chunks.len() {
                if let Some(wait) = &self.wait {
                    let func = self.env.function(wait);
                    let args = vec![self.name.clone(), W::Number(index as f64)];
                    awaited(call_value(&func, args, &W::Undefined, "env.fns[spec.wait]")).await?;
                }
                if let Completion::Return(value) =
                    self.yield_value(self.chunks[index].clone()).await?
                {
                    return Ok(Ended::Return(value));
                }
            }
            if let Some(failure) = &self.failure {
                state = "error";
                return Err(failure.clone());
            }
            state = "done";
            Ok(Ended::Normal)
        }
        .await;
        let ended = match ended {
            Ok(ended) => ended,
            // catch (cause) { state = 'error'; throw cause; }
            Err(cause) => {
                state = "error";
                Ended::Throw(cause)
            }
        };
        // finally { onDiagnostic?.({ stream: name, closed: state }) }: the
        // body runs in the context of the pull that resumed it, no call's.
        let payload = W::object(vec![
            ("stream", self.name.clone()),
            ("closed", W::string(state)),
        ]);
        let _ = self.env.observe_in(
            "onDiagnostic",
            payload,
            &Scope {
                cause: W::Undefined,
            },
        );
        self.state.set(GenState::DrainingQueue);
        match ended {
            Ended::Normal => self.complete_step(Ok(W::Undefined), true),
            Ended::Return(value) => self.complete_step(Ok(value), true),
            Ended::Throw(reason) => self.complete_step(Err(reason), true),
        }
        self.drain_queue();
    }
}

impl Stream for StubStream {
    /// `next()`.
    fn next(self: Rc<Self>) -> Promise<IterStep, W> {
        let (promise, resolvers) = Promise::with_resolvers();
        if self.state.get() == GenState::Completed {
            resolvers.fulfill(StubStream::done(W::Undefined));
            return promise;
        }
        self.queue.borrow_mut().push_back(Request {
            completion: Completion::Normal,
            resolvers,
        });
        if matches!(
            self.state.get(),
            GenState::SuspendedStart | GenState::SuspendedYield
        ) {
            self.resume(Completion::Normal);
        }
        promise
    }

    /// `return()`.
    fn finish(self: Rc<Self>) -> Promise<IterStep, W> {
        let (promise, resolvers) = Promise::with_resolvers();
        self.queue.borrow_mut().push_back(Request {
            completion: Completion::Return(W::Undefined),
            resolvers,
        });
        match self.state.get() {
            GenState::SuspendedStart | GenState::Completed => {
                self.state.set(GenState::AwaitingReturn);
                self.await_return();
            }
            GenState::SuspendedYield => self.resume(Completion::Return(W::Undefined)),
            _ => {}
        }
        promise
    }
}

fn make_stream(spec: &Obj, env: &Rc<Env>) -> Result<W, W> {
    let chunks = match spec.get("chunks") {
        Some(W::Array(items)) => items
            .iter()
            .map(|item| value(item, env))
            .collect::<Result<Vec<_>, _>>()?,
        _ => Vec::new(),
    };
    let failure = match spec.get("fail") {
        Some(item) => Some(value(item, env)?),
        None => None,
    };
    Ok(W::Stream(Rc::new(StubStream {
        name: spec.get("name").cloned().unwrap_or(W::Undefined),
        chunks,
        failure,
        wait: spec
            .get("wait")
            .filter(|wait| !wait.is_undefined())
            .cloned(),
        env: env.clone(),
        state: Cell::new(GenState::SuspendedStart),
        queue: RefCell::new(VecDeque::new()),
        body: RefCell::new(None),
        resumed_with: RefCell::new(Completion::Normal),
    })))
}

fn classify(ms: f64) -> W {
    W::string(if ms.is_nan() {
        "nan"
    } else if ms == f64::INFINITY {
        "infinite"
    } else if ms > 0.0 {
        "positive"
    } else {
        "zero"
    })
}

/// `encodeWireError(error)` without its stacks (natively there are none).
pub fn summarize(error: &W) -> W {
    encode_wire_error(error, 0)
}

fn name_of(op: &W, key: &str) -> JsStr {
    to_js_string(&op.get(key))
}

fn ops_of(value: &W) -> Vec<W> {
    match value {
        W::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

/// `body(op, env)`: `async () => (await run(op.body ?? [], env)).value`,
/// called in `ctx`.
fn body_call(op: &W, env: &Rc<Env>, ctx: Ctx) -> Ret {
    let (program, env) = (ops_of(&op.get("body")), env.clone());
    Ok(Resolution::Promise(async_fn(async move {
        let ran = run(env, ctx, program).await?;
        Ok(Resolution::Value(ran.unwrap_or(W::Undefined)))
    })))
}

/// `body(op, env)` as a function of the context it is called in.
fn body_fn(op: &W, env: &Rc<Env>, ctx: &Ctx) -> impl FnOnce() -> Ret + 'static {
    let (op, env, ctx) = (op.clone(), env.clone(), ctx.clone());
    move || body_call(&op, &env, ctx)
}

fn args_of(op: &W, env: &Rc<Env>) -> Result<Vec<W>, W> {
    match value(&op.get("args"), env)? {
        W::Array(items) => Ok(items),
        W::Undefined => Ok(Vec::new()),
        other => crate::wire::spread_arguments(&other),
    }
}

/// `run(program, env)`, an async function: `Some(value)` when it returned.
pub fn run(env: Rc<Env>, ctx: Ctx, program: Vec<W>) -> Promise<Option<W>, W> {
    async_fn(async move {
        for op in program {
            let kind = to_js_string(&op.get("op")).to_string_lossy();
            match kind.as_str() {
                "return" => return Ok(Resolution::Value(Some(value(&op.get("value"), &env)?))),
                "throw" => return Err(value(&op.get("value"), &env)?),
                "try" => {
                    let kept = match awaited(body_call(&op, &env, ctx.clone())).await {
                        Ok(result) => W::object(vec![("ok", result)]),
                        Err(cause) => W::object(vec![("caught", summarize(&cause))]),
                    };
                    env.store(&op, kept);
                }
                "call" => {
                    let func = env.function(&op.get("fn"));
                    let args = args_of(&op, &env)?;
                    let result =
                        awaited(call_value(&func, args, &env.scope.cause, "env.fns[op.fn]"))
                            .await?;
                    env.store(&op, result);
                }
                "start" => {
                    let (_, gate) = env.global.gate(&op.get("gate"));
                    let func = env.function(&op.get("fn"));
                    let args = args_of(&op, &env)?;
                    // `env.fns[op.fn](...).then(entry.resolve, entry.reject)`.
                    match call_value(&func, args, &env.scope.cause, "env.fns[op.fn]")? {
                        Resolution::Promise(started) => {
                            let (resolve, reject) = (gate.clone(), gate);
                            let _ = started.then::<W>(
                                move |result| {
                                    resolve.fulfill(result);
                                    Ok(Resolution::Value(W::Undefined))
                                },
                                move |reason| {
                                    reject.reject(reason);
                                    Ok(Resolution::Value(W::Undefined))
                                },
                            );
                        }
                        Resolution::Value(_) => {
                            return Err(ctx::type_error(
                                "env.fns[op.fn](...).then is not a function",
                            ));
                        }
                    }
                }
                "await" => {
                    let (gate, _) = env.global.gate(&op.get("gate"));
                    let result = gate.await?;
                    env.store(&op, result);
                }
                "open" => {
                    let (_, gate) = env.global.gate(&op.get("gate"));
                    gate.fulfill(value(&op.get("value"), &env)?);
                }
                "fail" => {
                    let (_, gate) = env.global.gate(&op.get("gate"));
                    gate.reject(value(&op.get("value"), &env)?);
                }
                "emit" => {
                    let observer = name_of(&op, "observer").to_string_lossy();
                    let answer = if env.global.has_observer(&observer) {
                        let payload = value(&op.get("payload"), &env)?;
                        let observers = env.global.observers.clone().expect("observers");
                        Some(observers.callback(&observer, payload, &env.scope))
                    } else {
                        None
                    };
                    if !op.get("as").is_undefined() {
                        let answer = match answer {
                            Some(answer) => answer.await?,
                            None => W::string("absent"),
                        };
                        env.store(&op, answer);
                    } else if let Some(answer) = answer {
                        let _ = answer.catch(|_| Ok(Resolution::Value(W::Undefined)));
                    }
                }
                "observe" => {
                    let observer = name_of(&op, "observer").to_string_lossy();
                    if env.global.has_observer(&observer) {
                        env.observe(&observer, value(&op.get("payload"), &env)?)?;
                    }
                }
                "phase" => {
                    let result =
                        ctx::execution_phase(&ctx, name_of(&op, "name"), body_fn(&op, &env, &ctx))
                            .await?;
                    env.store(&op, result);
                }
                "quiet" => {
                    let slow = match op.get("slowMs") {
                        W::Undefined => 250.0,
                        other => to_number(&other),
                    };
                    let result = ctx::quiet_execution_phase(
                        &ctx,
                        name_of(&op, "name"),
                        body_fn(&op, &env, &ctx),
                        slow,
                    )
                    .await?;
                    env.store(&op, result);
                }
                "timed" => {
                    let name = name_of(&op, "name");
                    // `plain`: the action returns that value itself.
                    let timed = match op.as_object().and_then(|object| object.get("plain")) {
                        Some(plain) => {
                            let (plain, env) = (plain.clone(), env.clone());
                            ctx::timed_execution_step(&ctx, &name, move || {
                                Ok(Resolution::Value(value(&plain, &env)?))
                            })
                        }
                        None => ctx::timed_execution_step(&ctx, &name, body_fn(&op, &env, &ctx)),
                    };
                    let result = timed.await?;
                    env.store(&op, result);
                }
                "step" => {
                    let count = op
                        .as_object()
                        .and_then(|object| object.get("count"))
                        .cloned();
                    ctx::execution_step(
                        &ctx,
                        &name_of(&op, "name"),
                        to_number(&op.get("elapsedMs")),
                        count.as_ref(),
                    );
                }
                "progress" => ctx::execution_progress(&ctx),
                "check" => ctx::check_execution_admission(&ctx)?,
                "slotWait" => {
                    let result =
                        ctx::with_execution_slot_wait(&ctx, body_fn(&op, &env, &ctx)).await?;
                    env.store(&op, result);
                }
                "io" => {
                    let result =
                        with_execution_io(&ctx, &op.get("root"), body_fn(&op, &env, &ctx)).await?;
                    env.store(&op, result);
                }
                // withExecutionMeter and withoutExecutionDeadline are plain
                // functions returning the body's promise.
                "meter" => {
                    let inner = ctx::with_execution_meter(&ctx);
                    let result = awaited(body_call(&op, &env, inner)).await?;
                    env.store(&op, result);
                }
                "noDeadline" => {
                    let inner = ctx::without_execution_deadline(&ctx);
                    let result = awaited(body_call(&op, &env, inner)).await?;
                    env.store(&op, result);
                }
                "cleanup" => {
                    let number = |key: &str, default: f64| match op.get(key) {
                        W::Undefined => default,
                        other => to_number(&other),
                    };
                    let (body_op, body_env) = (op.clone(), env.clone());
                    let result = ctx::execution_cleanup(
                        &ctx,
                        Box::new(move |inner| body_call(&body_op, &body_env, inner)),
                        number("timeoutMs", 5_000.0),
                        number("capMs", 60_000.0),
                    )
                    .await?;
                    env.store(&op, result);
                }
                "queue" => {
                    let (gate, _) = env.global.gate(&op.get("gate"));
                    let follow = match op.get("follow") {
                        W::Undefined => None,
                        name => env
                            .global
                            .meters
                            .borrow()
                            .get(&to_js_string(&name))
                            .cloned()
                            .flatten(),
                    };
                    let result = ctx::wait_for_execution_queue(&ctx, gate, follow).await?;
                    env.store(&op, result);
                }
                "nameMeter" => {
                    env.global
                        .meters
                        .borrow_mut()
                        .insert(name_of(&op, "as"), ctx::execution_progress_meter(&ctx));
                }
                "diagnostic" => ctx::execution_diagnostic(&ctx, value(&op.get("record"), &env)?),
                "remaining" => {
                    let ms = ctx::execution_remaining_ms(&ctx);
                    env.store(
                        &op,
                        if crate::value::truthy(&op.get("exact")) {
                            W::Number(ms)
                        } else {
                            classify(ms)
                        },
                    );
                }
                "reporting" => env.store(&op, W::Bool(ctx::execution_reporting(&ctx))),
                "signal" => {
                    let state = match ctx::execution_signal(&ctx) {
                        Some(signal) if signal.aborted() => "aborted",
                        Some(_) => "live",
                        None => "none",
                    };
                    env.store(&op, W::string(state));
                }
                "meterState" => {
                    let state = match ctx::execution_progress_meter(&ctx) {
                        Some(meter) => {
                            let meter = meter.0.borrow();
                            let mut object = Obj::with(vec![
                                ("waiters", W::Number(meter.waiters)),
                                ("following", W::Bool(meter.following.is_some())),
                            ]);
                            if crate::value::truthy(&op.get("exact")) {
                                let epoch = env.global.log.as_ref().map_or(0.0, |log| log.epoch);
                                object.put("progress", W::Number(meter.progress - epoch));
                            }
                            W::Object(object)
                        }
                        None => W::Null,
                    };
                    env.store(&op, state);
                }
                "background" => {
                    let started = body_call(&op, &env, ctx.clone())?;
                    if !crate::value::truthy(&op.get("unhandled"))
                        && let Resolution::Promise(started) = started
                    {
                        let _ = started.catch(|_| Ok(Resolution::Value(W::Undefined)));
                    }
                }
                "unhandled" => {
                    let _ = Promise::<W, W>::reject(value(&op.get("value"), &env)?);
                }
                "block" => std::thread::sleep(std::time::Duration::from_millis(
                    to_number(&op.get("ms")).max(0.0) as u64,
                )),
                "sleep" => host::sleep::<W>(to_number(&op.get("ms"))).await?,
                // Rust only: blocks the loop until a file exists.
                "blockUntil" => {
                    let path = to_js_string(&op.get("path")).to_string_lossy();
                    while !std::path::Path::new(&path).exists() {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
                // Rust only: a broken invariant, which ends the process.
                "panic" => panic!("stub panic: {}", to_js_string(&op.get("message"))),
                "log" => {
                    if let Some(log) = &env.global.log {
                        let entry = W::object(vec![
                            ("t", W::Number(host::now() - log.epoch)),
                            ("task", env.task.clone()),
                            ("log", value(&op.get("value"), &env)?),
                        ]);
                        log.events.borrow_mut().push(entry);
                    }
                }
                other => return Err(ctx::type_error(&format!("unknown stub op {other}"))),
            }
        }
        Ok(Resolution::Value(None))
    })
}

/// The stub runtime: the product's methods unported, then `stubRun` and `stubEcho`.
pub struct StubRuntime {
    global: Rc<Global>,
}

impl Runtime for StubRuntime {
    fn methods(&self) -> Vec<JsStr> {
        let mut methods = UnportedRuntime.methods();
        methods.extend(["stubRun", "stubEcho"].map(JsStr::from));
        methods
    }

    fn call(&self, method: &JsStr, args: Vec<W>, ctx: Ctx, scope: Scope) -> Ret {
        match method.to_string_lossy().as_str() {
            // `(...args) => args`: a plain function.
            "stubEcho" => Ok(Resolution::Value(W::Array(args))),
            // `async (spec) => (await run(spec?.program ?? [], …)).value`.
            "stubRun" => {
                let spec = args.into_iter().next().unwrap_or(W::Undefined);
                let fns = ops_of(&spec.get("fns"));
                let program = ops_of(&spec.get("program"));
                let env = Env::new(fns, self.global.clone(), scope, W::Undefined);
                Ok(Resolution::Promise(async_fn(async move {
                    let ran = run(env, ctx, program).await?;
                    Ok(Resolution::Value(ran.unwrap_or(W::Undefined)))
                })))
            }
            _ => UnportedRuntime.call(method, Vec::new(), ctx, scope),
        }
    }
}

/// The factory of a `test-hooks` build. It checks no option, as the
/// JavaScript stub checks none.
pub fn factory() -> Factory {
    Box::new(|_worker_data, observers| {
        let global = Rc::new(Global {
            gates: RefCell::new(HashMap::new()),
            meters: RefCell::new(HashMap::new()),
            observers: Some(observers),
            log: None,
        });
        Ok(Rc::new(StubRuntime { global }))
    })
}

/// A report sink that appends `{ t, task, <key>: record }` to a log.
pub fn log_sink(log: &Rc<Log>, task: W, key: &'static str) -> Report {
    let (log, task) = (log.clone(), task);
    Rc::new(move |record| {
        let entry = W::object(vec![
            ("t", W::Number(host::now() - log.epoch)),
            ("task", task.clone()),
            (key, record),
        ]);
        log.events.borrow_mut().push(entry);
    })
}
