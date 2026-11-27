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
//! `signal`, event emitters on `emitter`. A compiled function of a program
//! (`co`: an async function or an async generator, the twin of the
//! JavaScript arm's generated source) is one `async_fn` or `agen::async_gen`
//! whose blocks run in it as inline awaits: `await` is one `.await`,
//! `yield` is `co.yield_`, `yield*` is `co.delegate`, `for await` is
//! `agen::for_await` with its `close`/`close_throw` on each exit, exactly as
//! a port is written.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use ledger_core::js::number_to_string;

use crate::agen::{
    self, Abrupt, AsyncGen, AsyncIterator, Co, IntoAsyncIterator, SyncIterator, SyncStep,
};
use crate::emitter::{Emitter, Listener};
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

/// A value of a program: plain JSON, a combinator's array or outcome, a
/// promise, a generator object, a sync iterable or an iterator result.
#[derive(Clone, Default)]
pub enum V {
    #[default]
    Undefined,
    Json(String),
    Array(Vec<V>),
    Fulfilled(Box<V>),
    Rejected(Box<V>),
    Promise(Promise<V, V>),
    Gen(AsyncGen<V, V>),
    SyncIt(Rc<SyncDef>),
    AsyncIt(Rc<AsyncDef>),
    Step(Box<V>, bool),
    /// A value made by kind (`{ made }`): a plain object, a `Buffer`, an
    /// `Error`, a function, a `Map`, a bigint …, shown as `"<kind>"`.
    Made(String),
}

thread_local! {
    /// Node 26.13's rule (the frame kept after every `yield`), so the
    /// differential compares the system Node's frames exactly
    /// (`ledger-native-probe jobs node26`); Electron's otherwise.
    static NODE_26_FRAME_RULE: Cell<bool> = const { Cell::new(false) };
}

/// Run the programs under Node 26.13's frame rule after a `yield` (`true`)
/// or Electron's (`false`, the default).
pub fn use_node_26_frame_rule(on: bool) {
    NODE_26_FRAME_RULE.with(|rule| rule.set(on));
}

/// Electron's V8 frame rule for `yield v` (`agen::YieldFrame`), on what
/// the JavaScript arm makes of each value: `undefined`, JSON primitives and
/// objects, `allSettled` outcomes, iterator results, a sync or async
/// iterable (an object whose only key is `Symbol.iterator` or
/// `Symbol.asyncIterator`), a made plain object and a bigint lose the
/// frame; arrays (JSON or a combinator's), generator objects and the other
/// made kinds (an object with an own `then`, `Object.create(null)`, a
/// `Buffer`, a `Uint8Array`, an `Error`, a function, a class instance, a
/// `Map`, a `Set`, a `Date`, a boxed number) keep it.
impl agen::YieldFrame for V {
    fn loses_frame_when_yielded(&self) -> bool {
        if NODE_26_FRAME_RULE.with(Cell::get) {
            return false;
        }
        match self {
            V::Json(text) => !text.starts_with('['),
            V::Undefined
            | V::Fulfilled(_)
            | V::Rejected(_)
            | V::SyncIt(_)
            | V::AsyncIt(_)
            | V::Step(..) => true,
            V::Made(kind) => matches!(kind.as_str(), "object" | "bigint"),
            V::Array(_) | V::Gen(_) | V::Promise(_) => false,
        }
    }
}

/// A program's sync iterable (`syncIt`): its values, and a `return` method
/// that logs when `ret`.
pub struct SyncDef {
    values: Vec<V>,
    ret: bool,
    /// The value its `return` gives (`retv`), and whether that result says
    /// it is not done (`retOpen`).
    returned: V,
    open: bool,
    label: String,
    machine: Weak<Machine>,
}

/// One iterator of a [`SyncDef`] (each `[Symbol.iterator]()` makes one).
struct SyncIter {
    def: Rc<SyncDef>,
    at: Cell<usize>,
}

impl SyncIterator<V, V> for SyncIter {
    fn next(&self, _value: V) -> Result<SyncStep<V, V>, V> {
        let at = self.at.get();
        match self.def.values.get(at) {
            Some(value) => {
                self.at.set(at + 1);
                Ok(SyncStep {
                    value: resolution(value.clone()),
                    done: false,
                })
            }
            None => Ok(SyncStep {
                value: Resolution::Value(V::Undefined),
                done: true,
            }),
        }
    }

    fn return_(&self, _value: V) -> Option<Result<SyncStep<V, V>, V>> {
        if !self.def.ret {
            return None;
        }
        if let Some(machine) = self.def.machine.upgrade() {
            machine.log(format!("{}=ret", self.def.label));
        }
        Some(Ok(SyncStep {
            value: resolution(self.def.returned.clone()),
            done: !self.def.open,
        }))
    }

    fn throw_(&self, _reason: V) -> Option<Result<SyncStep<V, V>, V>> {
        None
    }
}

/// A program's async iterable (`asyncIt`): an iterator with `next` (logged
/// with what it was sent when labelled), no `throw`, and a `return` only
/// when `ret`.
pub struct AsyncDef {
    values: Vec<V>,
    ret: bool,
    label: String,
    machine: Weak<Machine>,
}

/// One iterator of an [`AsyncDef`] (each `[Symbol.asyncIterator]()` makes
/// one); its results are settled promises, as `Promise.resolve` makes them.
struct AsyncIter {
    def: Rc<AsyncDef>,
    at: Cell<usize>,
}

impl AsyncIter {
    fn note(&self, method: &str, sent: &V) {
        if self.def.label.is_empty() {
            return;
        }
        if let Some(machine) = self.def.machine.upgrade() {
            machine.log(format!("{}.{method}={}", self.def.label, show(sent)));
        }
    }
}

impl AsyncIterator<V, V> for AsyncIter {
    fn next(&self, sent: V) -> agen::Call<V, V> {
        self.note("next", &sent);
        let at = self.at.get();
        let step = match self.def.values.get(at) {
            Some(value) => {
                self.at.set(at + 1);
                agen::Step {
                    value: value.clone(),
                    done: false,
                }
            }
            None => agen::Step {
                value: V::Undefined,
                done: true,
            },
        };
        Ok(js::value(step))
    }

    fn return_(&self, sent: V) -> Option<agen::Call<V, V>> {
        if !self.def.ret {
            return None;
        }
        self.note("return", &sent);
        Some(Ok(js::value(agen::Step {
            value: sent,
            done: true,
        })))
    }

    fn throw_(&self, _reason: V) -> Option<agen::Call<V, V>> {
        None
    }
}

/// What `for await` and `yield*` iterate: a generator, an array or a sync
/// iterable as it is (the latter two through the async-from-sync
/// iterator), anything else as an empty array.
fn iterable_of(value: V) -> Rc<dyn AsyncIterator<V, V>> {
    match value {
        V::Gen(generator) => generator.into_async_iterator(),
        V::Array(items) => {
            agen::from_sync(agen::array(items.into_iter().map(resolution).collect()))
        }
        V::SyncIt(def) => agen::from_sync(Rc::new(SyncIter {
            def,
            at: Cell::new(0),
        })),
        V::AsyncIt(def) => Rc::new(AsyncIter {
            def,
            at: Cell::new(0),
        }),
        _ => agen::from_sync(agen::array(Vec::new())),
    }
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
        V::Promise(_) | V::Gen(_) | V::SyncIt(_) | V::AsyncIt(_) => "{}".into(),
        V::Made(kind) => format!("\"<{kind}>\""),
        V::Step(value, done) if matches!(**value, V::Undefined) => format!("{{\"done\":{done}}}"),
        V::Step(value, done) => format!("{{\"value\":{},\"done\":{done}}}", json(value)),
    }
}

/// What `emit('error', value)` throws with no `error` listener: an `Error`
/// itself, anything else as `ERR_UNHANDLED_ERROR` with the value as its
/// `context`.
fn unhandled(value: &V) -> V {
    match value {
        // An `Error` is thrown as it is (`events.js`: `if (er instanceof Error) throw er`).
        V::Made(kind) if kind == "error" => value.clone(),
        V::Undefined => V::Json("{\"code\":\"ERR_UNHANDLED_ERROR\"}".into()),
        other => V::Json(format!(
            "{{\"code\":\"ERR_UNHANDLED_ERROR\",\"context\":{}}}",
            json(other)
        )),
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
    emitters: RefCell<HashMap<String, Emitter<V, V>>>,
    handlers: RefCell<HashMap<String, Listener<V, V>>>,
    /// The compiled functions (`co`).
    co: Vec<W>,
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
        self.emitters.borrow_mut().clear();
        self.handlers.borrow_mut().clear();
    }

    fn emitter(&self, name: &W) -> Option<Emitter<V, V>> {
        self.emitters.borrow().get(&text(name)).cloned()
    }

    fn handler(&self, id: &W) -> Option<Listener<V, V>> {
        self.handlers.borrow().get(&text(id)).cloned()
    }

    /// A `yield`, `yield*`, loop item or awaited value: logged and kept.
    fn sent(&self, st: &W, value: V) {
        if let W::String(label) = st.get("l") {
            self.log(format!("{}={}", label.to_string_lossy(), show(&value)));
        }
        self.set(&st.get("as"), value);
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
        if object.is_some_and(|object| object.get("made").is_some()) {
            return V::Made(text(&target.get("made")));
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

/// A callback of the loop or of a signal: what it throws (an emit's
/// unhandled error, a listener's throw) is logged, never uncaught.
fn guarded(machine: &M, body: &[W]) {
    if let Err(reason) = exec_sync(machine, body, &V::Undefined) {
        machine.log(format!("X:{}", show(&reason)));
    }
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
            js::next_tick(move || guarded(&machine, &body));
        }
        "micro" => {
            let (machine, body) = (machine.clone(), list(&st.get("body")));
            js::queue_microtask(move || guarded(&machine, &body));
        }
        "timeout" => {
            let (inner, body) = (machine.clone(), list(&st.get("body")));
            let timer = host::set_timeout(delay(&st.get("ms")), move || guarded(&inner, &body));
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
                guarded(&inner, &body);
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
            let immediate = host::set_immediate(move || guarded(&inner, &body));
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
                        guarded(&inner, &body);
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
        "em" => {
            machine
                .emitters
                .borrow_mut()
                .insert(text(&st.get("n")), Emitter::new(unhandled));
        }
        "on" => {
            if let Some(emitter) = machine.emitter(&st.get("e")) {
                let (inner, body) = (machine.clone(), list(&st.get("body")));
                let listener =
                    Listener::new(move |value: &V| exec_sync(&inner, &body, value).map(|_| ()));
                machine
                    .handlers
                    .borrow_mut()
                    .insert(text(&st.get("id")), listener.clone());
                add_to(&emitter, &st.get("mode"), &text(&st.get("ev")), &listener);
            }
        }
        "onAgain" => {
            if let (Some(emitter), Some(listener)) = (
                machine.emitter(&st.get("e")),
                machine.handler(&st.get("id")),
            ) {
                add_to(&emitter, &st.get("mode"), &text(&st.get("ev")), &listener);
            }
        }
        "off" => {
            if let (Some(emitter), Some(listener)) = (
                machine.emitter(&st.get("e")),
                machine.handler(&st.get("id")),
            ) {
                emitter.remove_listener(&text(&st.get("ev")), &listener);
            }
        }
        "offAll" => {
            if let Some(emitter) = machine.emitter(&st.get("e")) {
                match st.get("ev") {
                    W::Undefined => emitter.remove_all_listeners(None),
                    event => emitter.remove_all_listeners(Some(&text(&event))),
                }
            }
        }
        "emit" => {
            if let Some(emitter) = machine.emitter(&st.get("e")) {
                let value = machine.value_of(&st.get("v"), arg);
                let had = emitter.emit(&text(&st.get("ev")), &value)?;
                if let W::String(label) = st.get("l") {
                    machine.log(format!("{}={had}", label.to_string_lossy()));
                }
            }
        }
        "count" => {
            let count = machine
                .emitter(&st.get("e"))
                .map_or("none".to_string(), |emitter| {
                    emitter.listener_count(&text(&st.get("ev"))).to_string()
                });
            machine.log(format!("{}={count}", text(&st.get("l"))));
        }
        "cocall" => {
            if let Some(made) = call_compiled(machine, to_number(&st.get("f")) as usize) {
                machine.set(&st.get("as"), made);
            }
        }
        "gcall" => gen_call(machine, st, &st.get("g"), arg),
        "burst" => {
            for call in list(&st.get("of")) {
                gen_call(machine, &call, &st.get("g"), arg);
            }
        }
        "arr" => {
            let values = list(&st.get("of"))
                .iter()
                .map(|target| machine.value_of(target, arg))
                .collect();
            machine.set(&st.get("as"), V::Array(values));
        }
        "syncIt" => {
            let values = list(&st.get("of"))
                .iter()
                .map(|target| machine.value_of(target, arg))
                .collect();
            let def = SyncDef {
                values,
                ret: crate::value::truthy(&st.get("ret")),
                returned: machine.value_of(&st.get("retv"), arg),
                open: crate::value::truthy(&st.get("retOpen")),
                label: text(&st.get("l")),
                machine: Rc::downgrade(machine),
            };
            machine.set(&st.get("as"), V::SyncIt(Rc::new(def)));
        }
        "asyncIt" => {
            let values = list(&st.get("of"))
                .iter()
                .map(|target| machine.value_of(target, arg))
                .collect();
            let def = AsyncDef {
                values,
                ret: crate::value::truthy(&st.get("ret")),
                label: match st.get("l") {
                    W::String(label) => label.to_string_lossy(),
                    _ => String::new(),
                },
                machine: Rc::downgrade(machine),
            };
            machine.set(&st.get("as"), V::AsyncIt(Rc::new(def)));
        }
        other => panic!("unknown statement {other}"),
    }
    Ok(None)
}

/// A compiled function called: its generator object or its promise.
fn call_compiled(machine: &M, index: usize) -> Option<V> {
    let definition = machine.co.get(index)?;
    Some(if crate::value::truthy(&definition.get("gen")) {
        V::Gen(run_gen(machine, index))
    } else {
        V::Promise(run_co(machine, index))
    })
}

/// What a loop or `yield*` iterates: a fresh call (`call`) or a target.
fn source_of(machine: &M, st: &W, key: &str) -> V {
    match st.get("call") {
        W::Undefined => machine.value_of(&st.get(key), &V::Undefined),
        index => call_compiled(machine, to_number(&index) as usize).unwrap_or(V::Undefined),
    }
}

fn add_to(emitter: &Emitter<V, V>, mode: &W, event: &str, listener: &Listener<V, V>) {
    match text(mode).as_str() {
        "once" => emitter.once(event, listener),
        "prepend" => emitter.prepend_listener(event, listener),
        "prependOnce" => emitter.prepend_once_listener(event, listener),
        _ => emitter.on(event, listener),
    }
}

/// The generator a register holds, if it holds one.
fn generator_in(machine: &M, reg: &W) -> Option<AsyncGen<V, V>> {
    match machine.regs.borrow().get(&text(reg)) {
        Some(V::Gen(generator)) => Some(generator.clone()),
        _ => None,
    }
}

/// `generator.next(v)`, `.return(v)` or `.throw(v)` (`k`).
fn call_generator(generator: &AsyncGen<V, V>, kind: &W, value: V) -> Promise<agen::Step<V>, V> {
    match text(kind).as_str() {
        "return" => generator.return_(resolution(value)),
        "throw" => generator.throw_(value),
        _ => generator.next(value),
    }
}

/// A manual call of a generator's method, its outcome logged.
fn gen_call(machine: &M, st: &W, reg: &W, arg: &V) {
    let Some(generator) = generator_in(machine, reg) else {
        return;
    };
    let promise = call_generator(
        &generator,
        &st.get("k"),
        machine.value_of(&st.get("v"), arg),
    );
    if let W::String(label) = st.get("l") {
        let (on_value, on_error) = (machine.clone(), machine.clone());
        let label = label.to_string_lossy();
        let again = label.clone();
        let _ = promise.then::<()>(
            move |step| {
                on_value.log(format!(
                    "{label}={}",
                    show(&V::Step(Box::new(step.value), step.done))
                ));
                Ok(Resolution::Value(()))
            },
            move |reason| {
                on_error.log(format!("{again}!{}", show(&reason)));
                Ok(Resolution::Value(()))
            },
        );
    }
}

/// How a block of a compiled function ended.
enum Flow {
    Normal,
    Break,
    Continue,
    /// `return v` of an async function (a generator's is an `Abrupt`).
    Return(Resolution<V, V>),
}

type Done = Result<Flow, Abrupt<V, V>>;

/// One call of a compiled function: its machine, and its generator's
/// handle when it is one.
struct CoRun {
    machine: M,
    co: Option<Co<V, V>>,
}

fn co_body(machine: &M, index: usize) -> Rc<Vec<W>> {
    Rc::new(
        machine
            .co
            .get(index)
            .map(|definition| list(&definition.get("body")))
            .unwrap_or_default(),
    )
}

/// A compiled async function, called.
fn run_co(machine: &M, index: usize) -> Promise<V, V> {
    let run = Rc::new(CoRun {
        machine: machine.clone(),
        co: None,
    });
    let body = co_body(machine, index);
    async_fn(async move {
        match exec_block(run, body, None).await {
            Ok(Flow::Return(resolution)) => Ok(resolution),
            Ok(_) => Ok(Resolution::Value(V::Undefined)),
            Err(Abrupt::Throw(reason)) => Err(reason),
            Err(Abrupt::Return(value)) => Ok(Resolution::Value(value)),
        }
    })
}

/// A compiled async generator, called: the generator object.
fn run_gen(machine: &M, index: usize) -> AsyncGen<V, V> {
    let (machine, body) = (machine.clone(), co_body(machine, index));
    agen::async_gen(move |co: Co<V, V>| async move {
        let run = Rc::new(CoRun {
            machine,
            co: Some(co),
        });
        exec_block(run, body, None).await?;
        Ok(())
    })
}

/// A block of a compiled function, statement by statement; `counter` is the
/// innermost loop's iteration count (for its exits).
// port: inline await (a block of a compiled function: its awaits are the program's own)
async fn exec_block(run: Rc<CoRun>, stmts: Rc<Vec<W>>, counter: Option<Rc<Cell<usize>>>) -> Done {
    for st in stmts.iter() {
        let flow = Box::pin(exec_statement(run.clone(), st.clone(), counter.clone())).await?;
        if !matches!(flow, Flow::Normal) {
            return Ok(flow);
        }
    }
    Ok(Flow::Normal)
}

/// `return v`: an async function's resolves its promise with `v` (followed
/// when a promise); a generator's awaits `v` first.
// port: inline await (a generator's `return` awaits its value)
async fn returning(run: &CoRun, value: Resolution<V, V>) -> Done {
    match &run.co {
        Some(co) => Err(co.ret(value).await),
        None => Ok(Flow::Return(value)),
    }
}

// port: inline await (one statement of a compiled function)
async fn exec_statement(run: Rc<CoRun>, st: W, counter: Option<Rc<Cell<usize>>>) -> Done {
    let machine = run.machine.clone();
    let value = || machine.value_of(&st.get("v"), &V::Undefined);
    match text(&st.get("s")).as_str() {
        "await" => {
            let awaited = Promise::resolve(resolution(value())).await?;
            machine.sent(&st, awaited);
        }
        "sleep" => host::sleep::<V>(delay(&st.get("ms"))).await?,
        "ret" => return returning(&run, resolution(value())).await,
        // `return;`: no value to await (a generator's is the return
        // completion at once, `Err(Abrupt::Return(undefined))`).
        "retBare" => {
            return match &run.co {
                Some(_) => Err(Abrupt::Return(V::Undefined)),
                None => Ok(Flow::Return(Resolution::Value(V::Undefined))),
            };
        }
        "retAwait" => {
            let awaited = Promise::resolve(resolution(value())).await?;
            return returning(&run, Resolution::Value(awaited)).await;
        }
        "throw" => return Err(Abrupt::Throw(value())),
        "try" => return exec_try(run, st, counter).await,
        "yield" => {
            let co = run.co.clone().expect("yield in a generator");
            let received = co.yield_(resolution(value())).await?;
            machine.sent(&st, received);
        }
        "yieldStar" => {
            let co = run.co.clone().expect("yield* in a generator");
            let source = source_of(&machine, &st, "v");
            let source = if crate::value::truthy(&st.get("await")) {
                Promise::resolve(resolution(source)).await?
            } else {
                source
            };
            let returned = co.delegate(iterable_of(source)).await?;
            machine.sent(&st, returned);
        }
        "forAwait" => return exec_for_await(run, st).await,
        "exit" => {
            let at = to_number(&st.get("at")) as usize;
            if counter.is_some_and(|count| count.get() == at) {
                return match text(&st.get("kind")).as_str() {
                    "break" => Ok(Flow::Break),
                    "continue" => Ok(Flow::Continue),
                    "ret" => returning(&run, resolution(value())).await,
                    _ => Err(Abrupt::Throw(value())),
                };
            }
        }
        "awaitCall" => {
            if let Some(generator) = generator_in(&machine, &st.get("g")) {
                let step = call_generator(&generator, &st.get("k"), value()).await?;
                machine.sent(&st, V::Step(Box::new(step.value), step.done));
            }
        }
        _ => {
            step(&machine, &st, &V::Undefined)?;
        }
    }
    Ok(Flow::Normal)
}

/// `try { body } catch (e) { handler } finally { fin }`: a catch takes a
/// throw only (never a received return); an abrupt `finally` replaces the
/// completion.
// port: inline await (a try statement of a compiled function)
async fn exec_try(run: Rc<CoRun>, st: W, counter: Option<Rc<Cell<usize>>>) -> Done {
    let mut result = exec_block(run.clone(), Rc::new(list(&st.get("body"))), counter.clone()).await;
    let handler = st.get("catch");
    if let W::Array(handler) = &handler
        && let Err(Abrupt::Throw(reason)) = &result
    {
        if let W::String(label) = st.get("as") {
            run.machine
                .log(format!("{}!{}", label.to_string_lossy(), show(reason)));
        }
        result = exec_block(run.clone(), Rc::new(handler.clone()), counter.clone()).await;
    }
    let fin = st.get("fin");
    if matches!(fin, W::Array(_)) || !matches!(handler, W::Array(_)) {
        let ended = exec_block(run.clone(), Rc::new(list(&fin)), counter).await;
        if !matches!(ended, Ok(Flow::Normal)) {
            result = ended;
        }
    }
    result
}

/// `for await (const x of source) { body }`, with AsyncIteratorClose on
/// each way out of the body.
// port: inline await (a for await statement of a compiled function)
async fn exec_for_await(run: Rc<CoRun>, st: W) -> Done {
    let source = source_of(&run.machine, &st, "of");
    let rows = agen::for_await(iterable_of(source));
    let count = Rc::new(Cell::new(0usize));
    let body = Rc::new(list(&st.get("body")));
    loop {
        let item = match rows.next().await {
            Ok(Some(item)) => item,
            Ok(None) => return Ok(Flow::Normal),
            Err(reason) => return Err(Abrupt::Throw(reason)),
        };
        count.set(count.get() + 1);
        run.machine.sent(&st, item);
        match exec_block(run.clone(), body.clone(), Some(count.clone())).await {
            Ok(Flow::Normal | Flow::Continue) => {}
            Ok(Flow::Break) => {
                rows.close().await?;
                return Ok(Flow::Normal);
            }
            Ok(Flow::Return(value)) => {
                rows.close().await?;
                return Ok(Flow::Return(value));
            }
            Err(abrupt) => return Err(rows.exit(abrupt).await),
        }
    }
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
        emitters: RefCell::new(HashMap::new()),
        handlers: RefCell::new(HashMap::new()),
        co: list(&program.get("co")),
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
