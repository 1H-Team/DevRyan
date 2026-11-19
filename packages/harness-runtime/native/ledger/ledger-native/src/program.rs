//! Test-only (`test-hooks`): the Rust interpreter of the job-order
//! programs (`scripts/ledger-native/jobs-programs.mjs`), the twin of
//! `scripts/ledger-native/jobs-js-arm.mjs`. It runs them on `js` and `host`
//! exactly as a port would be written: an async function of a program is one
//! `async_fn` whose statements (try blocks included) run in it with an
//! explicit stack, one `await` statement is one `.await` of a promise, and
//! callbacks, ticks, microtasks, timers and immediates are synchronous
//! closures. `run` gives the trace the JavaScript arm prints. Two stores
//! (`AsyncLocalStorage` `a` and `b`) tag every log entry with the frame it
//! runs in; abort controllers, `AbortSignal.any` and abort listeners run on
//! `signal`.
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use ledger_core::js::number_to_string;

use crate::host::{self, Immediate, Timeout};
use crate::js::{self, Promise, Resolution, Resolvers, Store, async_fn};
use crate::signal::{Controller, ListenerId, Signal};
use crate::value::{W, to_js_string, to_number};

/// The programs' two `AsyncLocalStorage`s.
static STORE_A: Store<V> = Store::new();
static STORE_B: Store<V> = Store::new();

fn store_of(name: &W) -> &'static Store<V> {
    if text(name) == "b" {
        &STORE_B
    } else {
        &STORE_A
    }
}

/// The frame a log entry runs in: `~a/b` (`-` for a store without a
/// value), nothing when neither has one.
fn frame_tag() -> String {
    let shown = |store: &Store<V>| match store.get() {
        None | Some(V::Undefined) => "-".to_string(),
        Some(value) => show(&value),
    };
    let (a, b) = (shown(&STORE_A), shown(&STORE_B));
    if a == "-" && b == "-" {
        String::new()
    } else {
        format!("~{a}/{b}")
    }
}

/// An abort reason crosses `signal` as a seam value: its JSON text.
fn to_reason(value: &V) -> W {
    match value {
        V::Undefined => W::Undefined,
        other => W::string(&json(other)),
    }
}

fn from_reason(reason: &W) -> V {
    match reason {
        W::Undefined => V::Undefined,
        other => V::Json(text(other)),
    }
}

/// A value of a program: plain JSON, a combinator's array or outcome, or a
/// promise.
#[derive(Clone)]
pub enum V {
    Undefined,
    Json(String),
    Array(Vec<V>),
    Fulfilled(Box<V>),
    Rejected(Box<V>),
    Promise(Promise<V, V>),
}

/// `JSON.stringify`, `undefined` itself shown as `undefined`.
fn show(value: &V) -> String {
    match value {
        V::Undefined => "undefined".into(),
        other => json(other),
    }
}

fn json(value: &V) -> String {
    match value {
        V::Undefined => "null".into(),
        V::Json(text) => text.clone(),
        V::Array(items) => format!("[{}]", items.iter().map(json).collect::<Vec<_>>().join(",")),
        V::Fulfilled(inner) if matches!(**inner, V::Undefined) => "{}".into(),
        V::Rejected(inner) if matches!(**inner, V::Undefined) => "{}".into(),
        V::Fulfilled(inner) => format!("{{\"ok\":{}}}", json(inner)),
        V::Rejected(inner) => format!("{{\"err\":{}}}", json(inner)),
        V::Promise(_) => "{}".into(),
    }
}

fn literal(value: &W) -> V {
    match value {
        W::Undefined => V::Undefined,
        W::Null => V::Json("null".into()),
        W::Number(n) => V::Json(number_to_string(*n)),
        W::Bool(b) => V::Json(b.to_string()),
        other => V::Json(format!("\"{}\"", to_js_string(other).to_string_lossy())),
    }
}

fn list(value: &W) -> Vec<W> {
    match value {
        W::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn text(value: &W) -> String {
    to_js_string(value).to_string_lossy()
}

fn resolution(value: V) -> Resolution<V, V> {
    match value {
        V::Promise(promise) => Resolution::Promise(promise),
        other => Resolution::Value(other),
    }
}

/// One program's state.
struct Machine {
    fns: Vec<W>,
    regs: RefCell<HashMap<String, V>>,
    resolvers: RefCell<HashMap<String, Resolvers<V, V>>>,
    timers: RefCell<HashMap<String, Timeout>>,
    immediates: RefCell<HashMap<String, Immediate>>,
    controllers: RefCell<HashMap<String, Controller>>,
    signals: RefCell<HashMap<String, Signal>>,
    listeners: RefCell<HashMap<String, (Signal, ListenerId)>>,
    snaps: RefCell<HashMap<String, js::Frame>>,
    trace: Rc<RefCell<Vec<String>>>,
    /// Moves the virtual clock on by `ms` (a callback that blocks the loop).
    block: Box<dyn Fn(i64)>,
}

type M = Rc<Machine>;

impl Machine {
    fn log(&self, entry: String) {
        self.trace
            .borrow_mut()
            .push(format!("{entry}{}", frame_tag()));
    }

    fn signal(&self, name: &W) -> Option<Signal> {
        self.signals.borrow().get(&text(name)).cloned()
    }

    /// Forgets every register, so nothing the program made is reachable
    /// from it (the census after a program counts what is still alive).
    fn forget(&self) {
        self.regs.borrow_mut().clear();
        self.resolvers.borrow_mut().clear();
        self.timers.borrow_mut().clear();
        self.immediates.borrow_mut().clear();
        self.controllers.borrow_mut().clear();
        self.signals.borrow_mut().clear();
        self.listeners.borrow_mut().clear();
        self.snaps.borrow_mut().clear();
    }

    fn value_of(&self, target: &W, arg: &V) -> V {
        if target.is_undefined() {
            return V::Undefined;
        }
        let object = target.as_object();
        if object.is_some_and(|object| object.get("val").is_some()) {
            return literal(&target.get("val"));
        }
        if object.is_some_and(|object| object.get("arg").is_some()) {
            return arg.clone();
        }
        self.regs
            .borrow()
            .get(&text(&target.get("reg")))
            .cloned()
            .unwrap_or(V::Json("\"missing\"".into()))
    }

    fn promise_of(&self, reg: &W) -> Promise<V, V> {
        match self
            .regs
            .borrow()
            .get(&text(reg))
            .cloned()
            .unwrap_or(V::Json("\"missing\"".into()))
        {
            V::Promise(promise) => promise,
            other => js::value(other),
        }
    }

    fn set(&self, reg: &W, value: V) {
        if !reg.is_undefined() {
            self.regs.borrow_mut().insert(text(reg), value);
        }
    }

    fn items(&self, of: &W, arg: &V) -> Vec<Resolution<V, V>> {
        list(of)
            .iter()
            .map(|target| resolution(self.value_of(target, arg)))
            .collect()
    }
}

/// A synchronous body: `Ok(Some(value))` for its `give`, `Err` for a throw.
fn exec_sync(machine: &M, stmts: &[W], arg: &V) -> Result<V, V> {
    for st in stmts {
        if let Some(given) = step(machine, st, arg)? {
            return Ok(given);
        }
    }
    Ok(V::Undefined)
}

/// A callback of `then`, `catch` or `finally`: absent is a pass-through.
fn handler(machine: &M, stmts: &W) -> Option<Rc<Vec<W>>> {
    let _ = machine;
    match stmts {
        W::Array(items) => Some(Rc::new(items.clone())),
        _ => None,
    }
}

fn give(machine: &M, body: &Rc<Vec<W>>, arg: V) -> Result<Resolution<V, V>, V> {
    exec_sync(machine, body, &arg).map(resolution)
}

/// One statement any body may run; `Some` ends a synchronous body (`give`).
fn step(machine: &M, st: &W, arg: &V) -> Result<Option<V>, V> {
    let kind = text(&st.get("s"));
    match kind.as_str() {
        "log" => {
            let label = text(&st.get("l"));
            let entry = match st.get("v") {
                W::Undefined => format!("{label}@{}", host::now()),
                target => format!("{label}={}", show(&machine.value_of(&target, arg))),
            };
            machine.log(entry);
        }
        "call" => {
            let promise = run_fn(machine, to_number(&st.get("f")) as usize);
            machine.set(&st.get("as"), V::Promise(promise));
        }
        "give" => return Ok(Some(machine.value_of(&st.get("v"), arg))),
        "throw" => return Err(machine.value_of(&st.get("v"), arg)),
        "new" => {
            let name = text(&st.get("as"));
            let body = list(&st.get("body"));
            let promise = Promise::executor(|resolvers| {
                machine.resolvers.borrow_mut().insert(name, resolvers);
                exec_sync(machine, &body, arg).map(|_| ())
            });
            machine.set(&st.get("as"), V::Promise(promise));
        }
        "settle" => {
            let entry = machine.resolvers.borrow().get(&text(&st.get("p"))).cloned();
            if let Some(entry) = entry {
                let value = machine.value_of(&st.get("v"), arg);
                if crate::value::truthy(&st.get("ok")) {
                    entry.resolve(resolution(value));
                } else {
                    entry.reject(value);
                }
            }
        }
        "then" => {
            let promise = machine.promise_of(&st.get("p"));
            let (ok, err) = (
                handler(machine, &st.get("ok")),
                handler(machine, &st.get("err")),
            );
            let (on_value, on_error) = (machine.clone(), machine.clone());
            let derived = promise.then(
                move |value| match &ok {
                    Some(body) => give(&on_value, body, value),
                    None => Ok(Resolution::Value(value)),
                },
                move |reason| match &err {
                    Some(body) => give(&on_error, body, reason),
                    None => Err(reason),
                },
            );
            machine.set(&st.get("as"), V::Promise(derived));
        }
        "catch" => {
            let promise = machine.promise_of(&st.get("p"));
            let err = handler(machine, &st.get("err"));
            let on_error = machine.clone();
            let derived = promise.catch(move |reason| match &err {
                Some(body) => give(&on_error, body, reason),
                None => Err(reason),
            });
            machine.set(&st.get("as"), V::Promise(derived));
        }
        "finally" => {
            let promise = machine.promise_of(&st.get("p"));
            let body = handler(machine, &st.get("body"));
            let on_finally = machine.clone();
            let derived = promise.finally(move || match &body {
                Some(body) => give(&on_finally, body, V::Undefined),
                None => Ok(Resolution::Value(V::Undefined)),
            });
            machine.set(&st.get("as"), V::Promise(derived));
        }
        "all" => {
            let all = Promise::all_into(machine.items(&st.get("of"), arg), V::Array);
            machine.set(&st.get("as"), V::Promise(all));
        }
        "allSettled" => {
            let settled = Promise::all_settled(machine.items(&st.get("of"), arg));
            // `.then(settledOf)`, as the JavaScript arm shapes the outcomes.
            let shaped = settled.then_ok(|outcomes| {
                Ok(Resolution::Value(V::Array(
                    outcomes
                        .into_iter()
                        .map(|outcome| match outcome {
                            Ok(value) => V::Fulfilled(Box::new(value)),
                            Err(reason) => V::Rejected(Box::new(reason)),
                        })
                        .collect(),
                )))
            });
            machine.set(&st.get("as"), V::Promise(shaped));
        }
        "race" => machine.set(
            &st.get("as"),
            V::Promise(Promise::race(machine.items(&st.get("of"), arg))),
        ),
        "resolve" => machine.set(
            &st.get("as"),
            V::Promise(Promise::resolve(resolution(
                machine.value_of(&st.get("v"), arg),
            ))),
        ),
        "reject" => machine.set(
            &st.get("as"),
            V::Promise(Promise::reject(machine.value_of(&st.get("v"), arg))),
        ),
        "handle" => {
            let _ = machine
                .promise_of(&st.get("p"))
                .catch(|_| Ok(Resolution::Value(V::Undefined)));
        }
        "tick" => {
            let (machine, body) = (machine.clone(), list(&st.get("body")));
            js::next_tick(move || {
                let _ = exec_sync(&machine, &body, &V::Undefined);
            });
        }
        "micro" => {
            let (machine, body) = (machine.clone(), list(&st.get("body")));
            js::queue_microtask(move || {
                let _ = exec_sync(&machine, &body, &V::Undefined);
            });
        }
        "timeout" => {
            let (inner, body) = (machine.clone(), list(&st.get("body")));
            let timer = host::set_timeout(delay(&st.get("ms")), move || {
                let _ = exec_sync(&inner, &body, &V::Undefined);
            });
            if crate::value::truthy(&st.get("unref")) {
                timer.unref();
            }
            machine
                .timers
                .borrow_mut()
                .insert(text(&st.get("n")), timer);
        }
        "interval" => {
            let (inner, body) = (machine.clone(), list(&st.get("body")));
            let handle: Rc<RefCell<Option<Timeout>>> = Rc::new(RefCell::new(None));
            let own = handle.clone();
            let mut left = to_number(&st.get("times"));
            let timer = host::set_interval(delay(&st.get("ms")), move || {
                left -= 1.0;
                if left <= 0.0
                    && let Some(timer) = own.borrow().as_ref()
                {
                    host::clear_timeout(timer);
                }
                let _ = exec_sync(&inner, &body, &V::Undefined);
            });
            if crate::value::truthy(&st.get("unref")) {
                timer.unref();
            }
            *handle.borrow_mut() = Some(timer.clone());
            machine
                .timers
                .borrow_mut()
                .insert(text(&st.get("n")), timer);
        }
        "clear" => {
            let timer = machine.timers.borrow().get(&text(&st.get("n"))).cloned();
            if let Some(timer) = timer {
                host::clear_timeout(&timer);
            }
        }
        "immediate" => {
            let (inner, body) = (machine.clone(), list(&st.get("body")));
            let immediate = host::set_immediate(move || {
                let _ = exec_sync(&inner, &body, &V::Undefined);
            });
            machine
                .immediates
                .borrow_mut()
                .insert(text(&st.get("n")), immediate);
        }
        "clearImmediate" => {
            let immediate = machine
                .immediates
                .borrow()
                .get(&text(&st.get("n")))
                .cloned();
            if let Some(immediate) = immediate {
                host::clear_immediate(&immediate);
            }
        }
        "block" => (machine.block)(to_number(&st.get("ms")) as i64),
        "run" => {
            let value = machine.value_of(&st.get("v"), arg);
            let body = list(&st.get("body"));
            store_of(&st.get("st")).run(value, || exec_sync(machine, &body, arg))?;
        }
        "exit" => {
            let body = list(&st.get("body"));
            store_of(&st.get("st")).exit(|| exec_sync(machine, &body, arg))?;
        }
        "snap" => {
            machine
                .snaps
                .borrow_mut()
                .insert(text(&st.get("as")), js::snapshot());
        }
        "replay" => {
            let body = list(&st.get("body"));
            let frame = machine.snaps.borrow().get(&text(&st.get("f"))).cloned();
            match frame {
                Some(frame) => js::run_in_frame(frame, || exec_sync(machine, &body, arg))?,
                None => exec_sync(machine, &body, arg)?,
            };
        }
        "ctl" => {
            let controller = Controller::new();
            let name = text(&st.get("n"));
            machine
                .signals
                .borrow_mut()
                .insert(name.clone(), controller.signal());
            machine.controllers.borrow_mut().insert(name, controller);
        }
        "any" => {
            let of: Vec<Signal> = list(&st.get("of"))
                .iter()
                .filter_map(|name| machine.signal(name))
                .collect();
            machine
                .signals
                .borrow_mut()
                .insert(text(&st.get("n")), Signal::any(&of));
        }
        "listen" => {
            if let Some(signal) = machine.signal(&st.get("g")) {
                let (inner, body) = (machine.clone(), list(&st.get("body")));
                let id =
                    signal.add_listener_with(crate::value::truthy(&st.get("once")), move |_| {
                        let _ = exec_sync(&inner, &body, &V::Undefined);
                    });
                machine
                    .listeners
                    .borrow_mut()
                    .insert(text(&st.get("id")), (signal, id));
            }
        }
        "unlisten" => {
            let entry = machine
                .listeners
                .borrow()
                .get(&text(&st.get("id")))
                .cloned();
            if let Some((signal, id)) = entry {
                signal.remove_listener(id);
            }
        }
        "abort" => {
            let controller = machine
                .controllers
                .borrow()
                .get(&text(&st.get("c")))
                .cloned();
            if let Some(controller) = controller {
                controller.abort(to_reason(&machine.value_of(&st.get("v"), arg)));
            }
        }
        "checkAbort" => {
            if let Some(signal) = machine.signal(&st.get("g")) {
                signal
                    .throw_if_aborted()
                    .map_err(|reason| from_reason(&reason))?;
            }
        }
        "reason" => {
            let label = text(&st.get("l"));
            let entry = match machine.signal(&st.get("g")) {
                Some(signal) => format!(
                    "{label}={}:{}",
                    signal.aborted(),
                    show(&from_reason(&signal.reason()))
                ),
                None => format!("{label}=none"),
            };
            machine.log(entry);
        }
        other => panic!("unknown statement {other}"),
    }
    Ok(None)
}

/// `setTimeout`'s `after`: JSON `null` is `null * 1`, 0.
fn delay(ms: &W) -> f64 {
    match ms {
        W::Null => 0.0,
        other => to_number(other),
    }
}

struct Frame {
    stmts: Vec<W>,
    at: usize,
    /// A try statement whose body this frame runs.
    handler: Option<W>,
}

/// One async function of the program.
fn run_fn(machine: &M, index: usize) -> Promise<V, V> {
    let machine = machine.clone();
    let body = machine
        .fns
        .get(index)
        .map(|f| list(&f.get("body")))
        .unwrap_or_default();
    async_fn(async move {
        let mut frames = vec![Frame {
            stmts: body,
            at: 0,
            handler: None,
        }];
        let mut thrown: Option<V> = None;
        loop {
            if let Some(reason) = thrown.take() {
                let mut caught = None;
                while let Some(top) = frames.pop() {
                    if let Some(handler) = top.handler {
                        caught = Some(handler);
                        break;
                    }
                }
                let Some(handler) = caught else {
                    return Err(reason);
                };
                if let W::String(label) = handler.get("as") {
                    machine.log(format!("{}!{}", label.to_string_lossy(), show(&reason)));
                }
                frames.push(Frame {
                    stmts: list(&handler.get("catch")),
                    at: 0,
                    handler: None,
                });
                continue;
            }
            let Some(frame) = frames.last_mut() else {
                return Ok(Resolution::Value(V::Undefined));
            };
            if frame.at >= frame.stmts.len() {
                frames.pop();
                if frames.is_empty() {
                    return Ok(Resolution::Value(V::Undefined));
                }
                continue;
            }
            let st = frame.stmts[frame.at].clone();
            frame.at += 1;
            let kind = text(&st.get("s"));
            let outcome: Result<(), V> = match kind.as_str() {
                "await" => match Promise::resolve(resolution(
                    machine.value_of(&st.get("v"), &V::Undefined),
                ))
                .await
                {
                    Ok(value) => {
                        if let W::String(label) = st.get("l") {
                            machine.log(format!("{}={}", label.to_string_lossy(), show(&value)));
                        }
                        machine.set(&st.get("as"), value);
                        Ok(())
                    }
                    Err(reason) => Err(reason),
                },
                "sleep" => host::sleep::<V>(delay(&st.get("ms"))).await,
                "ret" => return Ok(resolution(machine.value_of(&st.get("v"), &V::Undefined))),
                "retAwait" => {
                    match Promise::resolve(resolution(
                        machine.value_of(&st.get("v"), &V::Undefined),
                    ))
                    .await
                    {
                        Ok(value) => return Ok(Resolution::Value(value)),
                        Err(reason) => Err(reason),
                    }
                }
                "try" => {
                    frames.push(Frame {
                        stmts: list(&st.get("body")),
                        at: 0,
                        handler: Some(st.clone()),
                    });
                    Ok(())
                }
                _ => step(&machine, &st, &V::Undefined).map(|_| ()),
            };
            if let Err(reason) = outcome {
                thrown = Some(reason);
            }
        }
    })
}

/// Runs one program as the JavaScript arm does: the main body as a unit,
/// the first timers phase, then iterations (poll with the messages due,
/// check, timers) until nothing is due before `until`. The loop must be a
/// virtual one at 1000 (`virtual_host`).
pub fn run(program: &W, virtual_host: &Rc<crate::virtual_host::VirtualHost>) -> String {
    let trace = Rc::new(RefCell::new(Vec::new()));
    // `JSON.stringify` of an Error is `{}`.
    js::register_errors(|_, _| V::Json("{}".into()));
    let machine: M = Rc::new(Machine {
        fns: list(&program.get("fns")),
        regs: RefCell::new(HashMap::new()),
        resolvers: RefCell::new(HashMap::new()),
        timers: RefCell::new(HashMap::new()),
        immediates: RefCell::new(HashMap::new()),
        controllers: RefCell::new(HashMap::new()),
        signals: RefCell::new(HashMap::new()),
        listeners: RefCell::new(HashMap::new()),
        snaps: RefCell::new(HashMap::new()),
        trace: trace.clone(),
        block: {
            let clock = virtual_host.clone();
            Box::new(move |ms| clock.move_to(clock.now_ms() + ms))
        },
    });
    {
        // The listener reports in the rejection's frame, then runs the
        // program's `onUnhandled` statements there.
        let (inner, body) = (Rc::downgrade(&machine), list(&program.get("onUnhandled")));
        js::on_unhandled_rejection(Rc::new(move |reason| {
            let shown = reason.downcast_ref::<V>().map_or_else(|| "?".into(), show);
            let Some(machine) = inner.upgrade() else {
                return;
            };
            machine.log(format!("U:{shown}"));
            let _ = exec_sync(&machine, &body, &V::Undefined);
        }));
    }
    let until = 1_000
        + match program.get("until") {
            W::Undefined => 50,
            other => to_number(&other) as i64,
        };
    let mut messages: Vec<(i64, Vec<W>)> = list(&program.get("messages"))
        .iter()
        .map(|message| {
            (
                1_000 + to_number(&message.get("at")) as i64,
                list(&message.get("body")),
            )
        })
        .collect();
    messages.sort_by_key(|(at, _)| *at);
    let mut messages: std::collections::VecDeque<_> = messages.into();
    let event_loop = virtual_host.event_loop().clone();
    let unit = |body: &[W]| {
        if let Err(reason) = exec_sync(&machine, body, &V::Undefined) {
            trace.borrow_mut().push(format!("X:{}", show(&reason)));
        }
        event_loop.checkpoint();
    };
    unit(&list(&program.get("main")));
    event_loop.timers_phase();
    for _ in 0..10_000 {
        if !event_loop.has_immediates() {
            let timer = event_loop.next_expiry().unwrap_or(i64::MAX);
            let message = messages.front().map_or(i64::MAX, |(at, _)| *at);
            let next = timer.min(message);
            if next > until {
                break;
            }
            virtual_host.move_to(next);
        }
        while messages
            .front()
            .is_some_and(|(at, _)| *at <= virtual_host.now_ms())
        {
            let (_, body) = messages.pop_front().expect("a message");
            trace.borrow_mut().push(format!("M@{}", host::now()));
            unit(&body);
        }
        event_loop.check_phase();
        event_loop.timers_phase();
    }
    machine.forget();
    trace.borrow().join(" ")
}
