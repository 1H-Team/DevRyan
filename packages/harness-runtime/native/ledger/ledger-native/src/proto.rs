//! The stdio protocol of the ledger worker (`session-mutation-worker.js`;
//! research file 28, section 2), message for message.
//!
//! Host to ledger: `init` first (`protocol`, when present, must be 1), then
//! `call {id, method, input, context}`, `abort {id, reason}`,
//! `callback-result {id, failed, value|error}`, `pull {stream}` and
//! `stream-return {stream}`. Ledger to host: `ready {methods, protocol,
//! build}` first, then `result`, `report`, `progress`, `observe`,
//! `callback` and `chunk`, in the worker's shapes and key order.
//!
//! Each message is handled in arrival order. A call starts at once as its
//! own task (no queue, no cap, no delay) and runs in place up to its first
//! suspension, as the worker's handler does. Everything a call emits is
//! written in emission order, before its `result`. A message of an unknown
//! type is ignored (one line on stderr per type). Messages are written to
//! an unbounded queue drained by the writer thread, so no call waits on a
//! write.
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use ledger_core::js::JsStr;

use crate::codec::encode_line;
use crate::ctx::{Outcome, Remote, Step, run_in_remote_execution_context};
use crate::js::{self, Promise, Resolution, Resolvers, async_fn};
use crate::runtime::{Factory, Observers, Runtime, Scope};
use crate::signal::Controller;
use crate::stall::{OnStall, StallClock, on_host_stall};
use crate::value::{Func, Key, Obj, Stream, W, code_error, to_number, truthy};
use crate::wire::{
    decode_wire_error, decode_wire_value, encode_wire_error, encode_wire_value, spread_arguments,
};
use crate::{PROTOCOL, Report, WPromise};

/// Writes one encoded line.
pub type Writer = Rc<dyn Fn(Vec<u8>)>;

/// Why the process must stop before `ready`.
#[derive(Debug)]
pub enum InitFailure {
    /// The first message is not `init`, or names another protocol.
    Protocol(String),
    /// The runtime refused its options.
    Runtime(String),
}

const OBSERVERS: [&str; 5] = [
    "onChange",
    "onMaterialize",
    "onDiagnostic",
    "onLockTiming",
    "onWorkerStall",
];

#[derive(Default)]
struct State {
    next_callback: f64,
    next_stream: f64,
    fresh: u64,
    callbacks: HashMap<Key, Resolvers<W, W>>,
    streams: HashMap<Key, Rc<dyn Stream>>,
    calls: HashMap<Key, Controller>,
    ignored: HashSet<String>,
}

/// The worker: its runtime, observers and the state of the seam.
pub struct Process {
    out: Writer,
    observers: HashSet<&'static str>,
    state: RefCell<State>,
    runtime: RefCell<Option<Rc<dyn Runtime>>>,
    methods: RefCell<HashSet<JsStr>>,
}

impl Process {
    fn post(&self, message: W) -> Result<(), W> {
        let line = encode_line(&message)?;
        (self.out)(line);
        Ok(())
    }

    /// `callHost(target, args)`: `new Promise(…)` whose executor registers
    /// the callback and posts it; an encoding failure there rejects it.
    fn call_host(self: &Rc<Self>, target: Obj, args: Vec<W>) -> WPromise {
        Promise::executor(|resolvers| {
            let id = {
                let mut state = self.state.borrow_mut();
                state.next_callback += 1.0;
                let id = state.next_callback;
                state
                    .callbacks
                    .insert(Key::of(&W::Number(id)).expect("a number key"), resolvers);
                id
            };
            let args = encode_wire_value(&W::Array(args), None, None)?;
            self.post(W::object(vec![
                ("type", W::string("callback")),
                ("id", W::Number(id)),
                ("target", W::Object(target)),
                ("args", args),
            ]))
        })
    }

    /// `observe(observer, payload)` with the cause of the work in progress.
    fn observation(&self, observer: &str, payload: W, cause: W) -> Result<(), W> {
        self.post(W::object(vec![
            ("type", W::string("observe")),
            ("observer", W::string(observer)),
            ("payload", payload),
            ("cause", cause),
        ]))
    }

    /// A host function of call `call` (the `toFunction` of the worker).
    fn host_function(self: &Rc<Self>, call: W, fn_id: W) -> W {
        let process = Rc::downgrade(self);
        W::Function(Rc::new(Func {
            source: "(...args) => callHost({ call: id, fn }, args)",
            call: Box::new(move |args, cause| {
                let Some(process) = process.upgrade() else {
                    return Err(code_error("mutation_runtime_unavailable"));
                };
                let mut target = Obj::with(vec![("call", call.clone()), ("fn", fn_id.clone())]);
                if call.is_undefined() {
                    target.put("cause", cause.clone());
                }
                Ok(Resolution::Promise(process.call_host(target, args)))
            }),
        }))
    }

    /// Handles one message from the host.
    pub fn handle(self: &Rc<Self>, message: W) {
        let kind = match message.get("type") {
            W::String(kind) => kind.to_string_lossy(),
            _ => String::new(),
        };
        match kind.as_str() {
            "call" => self.on_call(&message),
            "abort" => {
                let controller = Key::of(&message.get("id"))
                    .and_then(|key| self.state.borrow().calls.get(&key).cloned());
                if let Some(controller) = controller {
                    let reason = message.get("reason");
                    let reason = if reason.has_unsupported() {
                        code_error("mutation_wire_type")
                    } else {
                        decode_wire_error(&reason)
                    };
                    controller.abort(reason);
                }
            }
            "callback-result" => {
                let pending = Key::of(&message.get("id"))
                    .and_then(|key| self.state.borrow_mut().callbacks.remove(&key));
                if let Some(pending) = pending {
                    if truthy(&message.get("failed")) {
                        pending.reject(decode_wire_error(&message.get("error")));
                    } else {
                        let value = message.get("value");
                        if value.has_unsupported() {
                            pending.reject(code_error("mutation_wire_type"));
                        } else {
                            pending.fulfill(decode_wire_value(&value, None));
                        }
                    }
                }
            }
            "pull" => self.on_pull(message.get("stream")),
            "stream-return" => {
                let stream = message.get("stream");
                let iterator =
                    Key::of(&stream).and_then(|key| self.state.borrow_mut().streams.remove(&key));
                // `await iterator?.return?.().catch(() => {})` in the async handler.
                if let Some(iterator) = iterator {
                    let _ = async_fn::<(), W>(async move {
                        let returned = iterator.finish().then::<W>(
                            |_| Ok(Resolution::Value(W::Undefined)),
                            |_| Ok(Resolution::Value(W::Undefined)),
                        );
                        returned.await?;
                        Ok(Resolution::Value(()))
                    });
                }
            }
            _ => {
                if self.state.borrow_mut().ignored.insert(kind.clone()) {
                    eprintln!("devryan-ledger: ignored a message of type {kind:?}");
                }
            }
        }
    }

    fn on_call(self: &Rc<Self>, message: &W) {
        let id = message.get("id");
        let method = message.get("method");
        if message.has_unsupported() {
            let _ = self.post(W::object(vec![
                ("type", W::string("result")),
                (
                    "id",
                    if id.has_unsupported() {
                        W::Undefined
                    } else {
                        id
                    },
                ),
                ("failed", W::Bool(true)),
                (
                    "error",
                    encode_wire_error(&code_error("mutation_wire_type"), 0),
                ),
                ("steps", W::Array(vec![])),
            ]));
            return;
        }
        let known = matches!(&method, W::String(name) if self.methods.borrow().contains(name));
        if !known {
            let _ = self.post(W::object(vec![
                ("type", W::string("result")),
                ("id", id),
                ("failed", W::Bool(true)),
                (
                    "error",
                    encode_wire_error(&code_error("mutation_method_unknown"), 0),
                ),
                ("steps", W::Array(vec![])),
            ]));
            return;
        }
        let W::String(method) = method else {
            unreachable!("a known method is a string")
        };
        let controller = Controller::new();
        let key = {
            let mut state = self.state.borrow_mut();
            let key = Key::insert_key(&id, &mut state.fresh);
            state.calls.insert(key.clone(), controller.clone());
            key
        };
        let process = self.clone();
        let (input, context) = (message.get("input"), message.get("context"));
        // The rest of the async message handler.
        let _ = async_fn::<(), W>(async move {
            let weak = Rc::downgrade(&process);
            let call_id = id.clone();
            let to_function = move |fn_id: &W| match weak.upgrade() {
                Some(process) => process.host_function(call_id.clone(), fn_id.clone()),
                None => W::Undefined,
            };
            let input = decode_wire_value(&input, Some(&to_function));
            let runtime = process
                .runtime
                .borrow()
                .clone()
                .expect("a runtime after init");
            let scope = Scope { cause: id.clone() };
            // `() => activeCall.run(id, () => runtime[method](...input))`.
            let call = id.clone();
            let action: crate::ctx::Action = Box::new(move |ctx| {
                ACTIVE_CALL.run(call, || {
                    let args = spread_arguments(&input)?;
                    runtime.call(&method, args, ctx, scope)
                })
            });
            let report: Report = {
                let (process, id) = (process.clone(), id.clone());
                Rc::new(move |record| {
                    let _ = process.post(W::object(vec![
                        ("type", W::string("report")),
                        ("id", id.clone()),
                        ("record", record),
                    ]));
                })
            };
            let progress: Rc<dyn Fn(bool)> = {
                let (process, id) = (process.clone(), id.clone());
                Rc::new(move |waiting| {
                    let _ = process.post(W::object(vec![
                        ("type", W::string("progress")),
                        ("id", id.clone()),
                        ("waiting", W::Bool(waiting)),
                    ]));
                })
            };
            let remote = Remote {
                signal: Some(controller.signal()),
                on_report: Some(report),
                on_progress: Some(progress),
                progress_ms: 250.0,
            };
            let Outcome {
                mut failed,
                value,
                steps,
            } = run_in_remote_execution_context(&context, action, remote).await?;
            let mut failure = value.clone();
            let mut encoded = W::Undefined;
            if !failed {
                match process.encode_result(&value) {
                    Ok(result) => encoded = result,
                    Err(cause) => {
                        failed = true;
                        failure = cause;
                    }
                }
            }
            let mut result = Obj::with(vec![
                ("type", W::string("result")),
                ("id", id),
                ("failed", W::Bool(failed)),
                ("value", encoded),
                ("steps", steps_value(&steps)),
            ]);
            if failed {
                result.put("error", encode_wire_error(&failure, 0));
            }
            let _ = process.post(W::Object(result));
            process.state.borrow_mut().calls.remove(&key);
            Ok(Resolution::Value(()))
        });
    }

    /// `encodeResult(value)`: streams registered as they are met.
    fn encode_result(self: &Rc<Self>, value: &W) -> Result<W, W> {
        let mut on_stream = |stream: &Rc<dyn Stream>| {
            let mut state = self.state.borrow_mut();
            state.next_stream += 1.0;
            let id = state.next_stream;
            state.streams.insert(
                Key::of(&W::Number(id)).expect("a number key"),
                stream.clone(),
            );
            W::Number(id)
        };
        encode_wire_value(value, None, Some(&mut on_stream))
    }

    fn on_pull(self: &Rc<Self>, stream: W) {
        let key = Key::of(&stream);
        let iterator = key
            .as_ref()
            .and_then(|key| self.state.borrow().streams.get(key).cloned());
        let Some(iterator) = iterator else {
            let _ = self.post(W::object(vec![
                ("type", W::string("chunk")),
                ("stream", stream),
                ("done", W::Bool(true)),
            ]));
            return;
        };
        let process = self.clone();
        // The rest of the async message handler: `await iterator.next()`.
        let _ = async_fn::<(), W>(async move {
            let forget = || {
                if let Some(key) = &key {
                    process.state.borrow_mut().streams.remove(key);
                }
            };
            let posted = match iterator.clone().next().await {
                Ok(step) => {
                    if step.done {
                        forget();
                    }
                    let value = if step.done { W::Undefined } else { step.value };
                    process.post(W::object(vec![
                        ("type", W::string("chunk")),
                        ("stream", stream.clone()),
                        ("done", W::Bool(step.done)),
                        ("value", value),
                    ]))
                }
                Err(cause) => Err(cause),
            };
            if let Err(cause) = posted {
                forget();
                let _ = process.post(W::object(vec![
                    ("type", W::string("chunk")),
                    ("stream", stream),
                    ("done", W::Bool(true)),
                    ("error", encode_wire_error(&cause, 0)),
                ]));
            }
            Ok(Resolution::Value(()))
        });
    }
}

/// The worker's `activeCall` store: the id of the call whose work runs.
static ACTIVE_CALL: js::Store<W> = js::Store::new();

/// The cause of the work in progress (`activeCall.getStore()`).
fn frame_cause() -> W {
    ACTIVE_CALL.get().unwrap_or(W::Undefined)
}

fn steps_value(steps: &[(JsStr, Step)]) -> W {
    W::Array(
        steps
            .iter()
            .map(|(phase, step)| {
                W::Array(vec![
                    W::String(phase.clone()),
                    W::object(vec![
                        ("count", W::Number(step.count)),
                        ("elapsedMs", W::Number(step.elapsed_ms)),
                    ]),
                ])
            })
            .collect(),
    )
}

/// The observers a runtime sees: those the host has.
struct HostObservers(std::rc::Weak<Process>);

impl Observers for HostObservers {
    fn has(&self, observer: &str) -> bool {
        self.0
            .upgrade()
            .is_some_and(|process| process.observers.contains(observer))
    }

    fn callback(&self, observer: &str, payload: W, scope: &Scope) -> WPromise {
        match self.0.upgrade() {
            Some(process) => process.call_host(
                Obj::with(vec![
                    ("observer", W::string(observer)),
                    ("cause", scope.cause.clone()),
                ]),
                vec![payload],
            ),
            None => Promise::reject(code_error("mutation_runtime_unavailable")),
        }
    }

    fn observe(&self, observer: &str, payload: W, scope: &Scope) -> Result<(), W> {
        match self.0.upgrade() {
            Some(process) => process.observation(observer, payload, scope.cause.clone()),
            None => Ok(()),
        }
    }
}

/// The build identity `ready` carries: `unported+<source digest>` while no
/// method is ported, so no host can take this build for a ledger, and
/// `unported+hooks+<source digest>` for a test-hooks build, which a host
/// refuses by identity too.
pub fn build_identity() -> String {
    format!(
        "unported+{}{}",
        if crate::TEST_HOOKS { "hooks+" } else { "" },
        option_env!("DEVRYAN_LEDGER_SOURCE_DIGEST").unwrap_or("development")
    )
}

/// Starts the worker from the `init` message: builds the runtime, starts
/// the stall observer and writes `ready`.
pub fn start(init: &W, factory: Factory, out: Writer) -> Result<Rc<Process>, InitFailure> {
    if !matches!(init.get("type"), W::String(kind) if kind == "init") {
        return Err(InitFailure::Protocol(
            "the first message must be init".into(),
        ));
    }
    match init.get("protocol") {
        W::Undefined => {}
        W::Number(protocol) if protocol == PROTOCOL => {}
        other => {
            return Err(InitFailure::Protocol(format!(
                "protocol {} is not {PROTOCOL}",
                crate::value::to_js_string(&other)
            )));
        }
    }
    let worker_data = match init.get("workerData") {
        W::Undefined | W::Null => W::Object(Obj::new()),
        other => other,
    };
    let observers_value = worker_data.get("observers");
    let observers: HashSet<&'static str> = OBSERVERS
        .into_iter()
        .filter(|name| truthy(&observers_value.get(name)))
        .collect();
    let process = Rc::new(Process {
        out,
        observers,
        state: RefCell::new(State::default()),
        runtime: RefCell::new(None),
        methods: RefCell::new(HashSet::new()),
    });
    let runtime = factory(
        &worker_data,
        Rc::new(HostObservers(Rc::downgrade(&process))),
    )
    .map_err(InitFailure::Runtime)?;
    if process.observers.contains("onWorkerStall") {
        start_stall_observer(&process, &worker_data.get("stallClock"))?;
    }
    // `process.on('unhandledRejection', …)`: reported, not fatal, with the
    // cause of the work that rejected.
    let weak = Rc::downgrade(&process);
    js::on_unhandled_rejection(Rc::new(move |reason| {
        let Some(process) = weak.upgrade() else {
            return;
        };
        if !process.observers.contains("onDiagnostic") {
            return;
        }
        let code = match reason.downcast_ref::<W>().map(|reason| reason.get("code")) {
            Some(code @ W::String(_)) => code,
            _ => W::string("unhandled_rejection"),
        };
        let record = W::object(vec![
            ("phase", W::string("ledger_worker")),
            ("state", W::string("failed")),
            ("code", code),
        ]);
        let _ = process.observation("onDiagnostic", record, frame_cause());
    }));
    let methods = runtime.methods();
    *process.methods.borrow_mut() = methods.iter().cloned().collect();
    *process.runtime.borrow_mut() = Some(runtime);
    let ready = W::object(vec![
        ("type", W::string("ready")),
        (
            "methods",
            W::Array(methods.into_iter().map(W::String).collect()),
        ),
        ("protocol", W::Number(PROTOCOL)),
        ("build", W::string(&build_identity())),
    ]);
    process
        .post(ready)
        .map_err(|_| InitFailure::Runtime("ready could not be encoded".into()))?;
    Ok(process)
}

/// `onWorkerStall`: a dedicated clock when `stallClock` tunes one, else the
/// process's shared clock.
fn start_stall_observer(process: &Rc<Process>, tuning: &W) -> Result<(), InitFailure> {
    let weak = Rc::downgrade(process);
    let report: OnStall = Rc::new(move |stall| {
        if let Some(process) = weak.upgrade() {
            let payload = W::object(vec![
                ("ms", W::Number(stall.ms)),
                ("from", W::Number(stall.from)),
                ("to", W::Number(stall.to)),
            ]);
            let _ = process.observation("onWorkerStall", payload, W::Undefined);
        }
    });
    if !truthy(tuning) {
        let _ = on_host_stall(report);
        return Ok(());
    }
    // `{ ...stallClock, onStall }`: an injected clock or timer cannot come
    // over JSON, and calling one that is not a function throws.
    let entries = crate::value::own_entries(tuning);
    let read = |key: &str| {
        entries
            .iter()
            .find(|(existing, _)| *existing == key)
            .map(|(_, value)| value.clone())
            .unwrap_or(W::Undefined)
    };
    for injected in ["now", "setIntervalImpl"] {
        if !read(injected).is_undefined() {
            return Err(InitFailure::Runtime(format!(
                "stallClock.{injected} is not a function"
            )));
        }
    }
    let number = |key: &str, default: f64| match read(key) {
        W::Undefined => default,
        other => to_number(&other),
    };
    StallClock::on_host(
        number("tickMs", crate::stall::TICK_MS),
        number("stallMs", crate::stall::STALL_MS),
        Some(report),
    )
    .start();
    Ok(())
}
