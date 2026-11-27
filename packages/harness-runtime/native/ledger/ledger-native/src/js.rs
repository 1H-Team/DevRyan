//! JavaScript's jobs, as V8 and Node run them: promises, the microtask queue,
//! Node's tick queue, async functions and `await`, the promise combinators,
//! unhandled rejections and the async context frame. No ledger type is used
//! here; the ledger's ports are written on it (the porting rule is in
//! `packages/harness-runtime/DOCUMENTATION.md`, "Native ledger process").
//!
//! - A [`Promise`] is single-threaded (`Rc`, never `Send`): pending with an
//!   ordered list of reactions, or settled. Settling queues its reactions as
//!   jobs in registration order; reacting to a settled promise queues the
//!   job at once. Resolving with a promise takes the specification's two
//!   extra jobs (NewPromiseResolveThenableJob, then the reaction).
//! - One microtask queue (FIFO) and the tick queue (`process.nextTick`),
//!   drained by [`checkpoint`] in Node's order (`processTicksAndRejections`):
//!   every tick, then every microtask, again until both are empty, with the
//!   unhandled rejections reported once both are.
//! - [`async_fn`] is an async function call: its body runs at once, up to its
//!   first `await`, and its return value resolves the call's promise by the
//!   resolve steps above (so `return promise` costs two jobs more than
//!   `return await promise`).
//! - `promise.await` (or [`value`]`(v).await`) is JavaScript's `await`: it
//!   always suspends, and the task resumes in the job of the promise's
//!   reaction. A task suspends only on such an await: a task that returns
//!   `Pending` on anything else, or with two awaits outstanding (a `join!`
//!   or `select!`), panics, because no waker exists that could resume it.
//! - The combinators follow the specification's steps: [`Promise::all`],
//!   [`Promise::all_settled`], [`Promise::race`], `then`, `catch`,
//!   `finally`, [`Promise::resolve`], [`Promise::reject`],
//!   [`Promise::executor`], [`queue_microtask`], [`next_tick`].
//! - [`Frame`] is Node's `AsyncContextFrame`: a map from each
//!   [`Store`] (`AsyncLocalStorage`) to its value, captured by every job,
//!   tick, timer and immediate when it is queued and restored when it runs;
//!   [`Store::run`] sets one key for what runs inside it, [`snapshot`] and
//!   [`run_in_frame`] are `AsyncLocalStorage.snapshot()` and its call.
//! - Depth: an async function started when the loop thread's stack budget
//!   is spent returns a promise rejected with a `RangeError` ("Maximum call
//!   stack size exceeded", JavaScript's catchable failure) instead of
//!   overflowing the stack; a pending chain is dropped iteratively, so a
//!   chain of any length is freed without recursion.
//!
//! Work on another thread never touches any of this: it posts a unit to the
//! loop's inbox (`host`), and the loop settles the promise on its thread.
#![forbid(unsafe_code)]

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::future::{Future, IntoFuture};
use std::marker::PhantomData;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll, Waker};

/// Node's async context frame (`AsyncContextFrame`): the value of every
/// [`Store`] that code runs with. A job, a tick, a timer or an immediate
/// captures the frame current when it is queued and runs in it. Frames are
/// immutable: [`Store::run`] makes a copy with one key set, as Node's
/// `new AsyncContextFrame(store, value)` copies the current map.
#[derive(Clone, Default)]
pub struct Frame(Option<Rc<Vec<StoreEntry>>>);

/// One store's key and value in a frame (`None`: set to `undefined`).
type StoreEntry = (u64, Option<Rc<dyn Any>>);

impl Frame {
    /// The value of the store `key`: `None` when the frame never set it,
    /// `Some(None)` when it set it to `undefined` (`exit`).
    fn lookup(&self, key: u64) -> Option<Option<Rc<dyn Any>>> {
        let entries = self.0.as_ref()?;
        entries
            .iter()
            .find(|(known, _)| *known == key)
            .map(|(_, value)| value.clone())
    }

    /// A copy with `key` set to `value`.
    fn with(&self, key: u64, value: Option<Rc<dyn Any>>) -> Frame {
        let mut entries: Vec<_> = self.0.as_deref().cloned().unwrap_or_default();
        match entries.iter_mut().find(|(known, _)| *known == key) {
            Some(entry) => entry.1 = value,
            None => entries.push((key, value)),
        }
        Frame(Some(Rc::new(entries)))
    }

    /// Whether no store is set (the top-level frame).
    pub fn is_empty(&self) -> bool {
        self.0.as_ref().is_none_or(|entries| entries.is_empty())
    }
}

static NEXT_STORE: AtomicU64 = AtomicU64::new(0);

/// An `AsyncLocalStorage` of `T`: `static S: Store<T> = Store::new();`.
/// Its identity is the store itself (a key drawn on first use).
pub struct Store<T> {
    key: AtomicU64,
    of: PhantomData<fn() -> T>,
}

impl<T> Default for Store<T> {
    fn default() -> Self {
        Store::new()
    }
}

impl<T> Store<T> {
    pub const fn new() -> Store<T> {
        Store {
            key: AtomicU64::new(0),
            of: PhantomData,
        }
    }

    fn key(&self) -> u64 {
        let known = self.key.load(Ordering::Acquire);
        if known != 0 {
            return known;
        }
        let fresh = NEXT_STORE.fetch_add(1, Ordering::AcqRel) + 1;
        match self
            .key
            .compare_exchange(0, fresh, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => fresh,
            Err(existing) => existing,
        }
    }
}

impl<T: Clone + 'static> Store<T> {
    /// `store.run(value, f)`: `f`, and what it queues, starts or awaits,
    /// sees `value`; the other stores keep theirs.
    pub fn run<R>(&self, value: T, f: impl FnOnce() -> R) -> R {
        let frame = current_frame().with(self.key(), Some(Rc::new(value)));
        run_in_frame(frame, f)
    }

    /// `store.exit(f)` (`run(undefined, f)`).
    pub fn exit<R>(&self, f: impl FnOnce() -> R) -> R {
        let frame = current_frame().with(self.key(), None);
        run_in_frame(frame, f)
    }

    /// `store.getStore()`.
    pub fn get(&self) -> Option<T> {
        current_frame()
            .lookup(self.key())
            .flatten()
            .and_then(|value| value.downcast_ref::<T>().cloned())
    }
}

type Job = Box<dyn FnOnce()>;

/// What `process.on('unhandledRejection')` gets: the reason (the promise's
/// rejection type, as `Any`). It runs in the frame current when the promise
/// was rejected.
pub type RejectionHook = Rc<dyn Fn(Rc<dyn Any>)>;

struct Pending {
    id: u64,
    reason: Rc<dyn Any>,
    frame: Frame,
}

/// The job queues of one loop.
pub struct Jobs {
    micro: RefCell<VecDeque<(Frame, Job)>>,
    ticks: RefCell<VecDeque<(Frame, Job)>>,
    /// Rejected promises with no handler yet, in rejection order (Node's
    /// `pendingUnhandledRejections`).
    rejections: RefCell<Vec<Pending>>,
    rejection_to_warn: Cell<bool>,
    hook: RefCell<Option<RejectionHook>>,
    frame: RefCell<Frame>,
    /// Called before each job: the process ends itself here once stdin has
    /// closed.
    halt: Rc<dyn Fn()>,
    next_promise: Cell<u64>,
    draining: Cell<bool>,
    /// How many checkpoints have ended: everything a unit of work runs, its
    /// checkpoint included, sees one value ([`checkpoint_epoch`]).
    epoch: Cell<u64>,
}

impl Jobs {
    pub fn new(halt: Rc<dyn Fn()>) -> Rc<Jobs> {
        Rc::new(Jobs {
            micro: RefCell::new(VecDeque::new()),
            ticks: RefCell::new(VecDeque::new()),
            rejections: RefCell::new(Vec::new()),
            rejection_to_warn: Cell::new(false),
            hook: RefCell::new(None),
            frame: RefCell::new(Frame::default()),
            halt,
            next_promise: Cell::new(0),
            draining: Cell::new(false),
            epoch: Cell::new(0),
        })
    }

    fn run(&self, frame: Frame, job: Job) {
        (self.halt)();
        let prior = self.frame.replace(frame);
        job();
        *self.frame.borrow_mut() = prior;
    }

    /// V8's `PerformCheckpoint`: every microtask, those queued meanwhile too.
    fn run_microtasks(&self) {
        loop {
            let next = self.micro.borrow_mut().pop_front();
            let Some((frame, job)) = next else { return };
            self.run(frame, job);
        }
    }

    /// Node's `processPromiseRejections`: reports every rejection still
    /// unhandled; true when it reported one or more remain.
    fn process_rejections(&self) -> bool {
        let pending = std::mem::take(&mut *self.rejections.borrow_mut());
        let reported = !pending.is_empty();
        for Pending { reason, frame, .. } in pending {
            let hook = self.hook.borrow().clone();
            let prior = self.frame.replace(frame);
            match hook {
                Some(hook) => hook(reason),
                // Node's default mode with no listener: an uncaught
                // exception, which ends a worker thread.
                None => panic!(
                    "a promise rejection nothing handled, and no unhandledRejection listener"
                ),
            }
            *self.frame.borrow_mut() = prior;
        }
        reported || !self.rejections.borrow().is_empty()
    }

    /// Node's checkpoint after a callback from the loop (`runNextTicks`, the
    /// close of an `InternalCallbackScope`): every tick, then every
    /// microtask, until both queues are empty, then the unhandled
    /// rejections, and again while they queued more. Inside a job it does
    /// nothing, as V8's checkpoint does while microtasks run.
    pub fn checkpoint(&self) {
        if self.draining.replace(true) {
            return;
        }
        loop {
            loop {
                let next = self.ticks.borrow_mut().pop_front();
                let Some((frame, tick)) = next else { break };
                self.run(frame, tick);
            }
            self.run_microtasks();
            if !self.ticks.borrow().is_empty() {
                continue;
            }
            if self.rejection_to_warn.get() && self.process_rejections() {
                continue;
            }
            break;
        }
        self.rejection_to_warn.set(false);
        self.draining.set(false);
        self.epoch.set(self.epoch.get() + 1);
    }

    /// Whether a job or tick is queued.
    pub fn idle(&self) -> bool {
        self.micro.borrow().is_empty() && self.ticks.borrow().is_empty()
    }
}

type ErrorMaker = Rc<dyn Fn(&str, &str) -> Rc<dyn Any>>;
type Outcomes<T, E> = Rc<RefCell<Vec<Option<Result<T, E>>>>>;

thread_local! {
    static ERRORS: RefCell<Vec<(std::any::TypeId, ErrorMaker)>> = const { RefCell::new(Vec::new()) };
    static JOBS: RefCell<Option<Rc<Jobs>>> = const { RefCell::new(None) };
    static TASKS: RefCell<Vec<Rc<Task>>> = const { RefCell::new(Vec::new()) };
    /// Tasks (async function calls and coroutines) not yet freed.
    static LIVE_TASKS: Cell<usize> = const { Cell::new(0) };
    /// The lowest stack address an async function may start at (0: none).
    static STACK_LIMIT: Cell<usize> = const { Cell::new(0) };
    static STACK_BUDGET: Cell<usize> = const { Cell::new(DEFAULT_STACK_BUDGET) };
    /// Reaction lists of dropped promises, freed one at a time.
    static DROPS: RefCell<Vec<Box<dyn Any>>> = const { RefCell::new(Vec::new()) };
    static DROPPING: Cell<bool> = const { Cell::new(false) };
}

/// The stack an install leaves async functions on its thread, unless the
/// thread's owner gives another ([`set_stack_budget`]): about what V8 has
/// (984 KiB).
pub const DEFAULT_STACK_BUDGET: usize = 1 << 20;

/// The stack budget of this thread from its next [`install`] on: the bytes
/// below the install's own frame that nested async function starts may
/// use. The loop thread's owner sets it from the stack it gave the thread.
pub fn set_stack_budget(bytes: usize) {
    STACK_BUDGET.with(|budget| budget.set(bytes));
}

/// An address in the caller's frame (the stack grows down on every target
/// this builds for).
#[inline(never)]
fn stack_address() -> usize {
    let marker = 0u8;
    std::hint::black_box(&marker) as *const u8 as usize
}

pub(crate) fn stack_exhausted() -> bool {
    let limit = STACK_LIMIT.with(Cell::get);
    limit != 0 && stack_address() < limit
}

/// How many async function calls and coroutines are alive on this thread:
/// suspended ones included, finished ones freed. A census for tests and
/// reviews (an await that can never settle and is never freed shows here).
pub fn live_tasks() -> usize {
    LIVE_TASKS.with(Cell::get)
}

pub(crate) fn defer_drop(item: Box<dyn Any>) {
    // A thread ending: free inline.
    if DROPS
        .try_with(|drops| drops.borrow_mut().push(item))
        .is_err()
    {
        return;
    }
    if DROPPING.with(|dropping| dropping.replace(true)) {
        return;
    }
    loop {
        let next = DROPS.with(|drops| drops.borrow_mut().pop());
        match next {
            Some(item) => drop(item),
            None => break,
        }
    }
    DROPPING.with(|dropping| dropping.set(false));
}

/// How a rejection type makes the errors JavaScript throws itself, by
/// name and message: a `TypeError` (a promise resolved with itself rejects
/// with one) and a `RangeError` (an async function started with the stack
/// spent).
pub fn register_errors<E: 'static>(make: impl Fn(&str, &str) -> E + 'static) {
    let id = std::any::TypeId::of::<E>();
    ERRORS.with(|errors| {
        let mut errors = errors.borrow_mut();
        errors.retain(|(known, _)| *known != id);
        errors.push((
            id,
            Rc::new(move |name, message| Rc::new(make(name, message)) as Rc<dyn Any>),
        ));
    });
}

pub(crate) fn js_error<E: Clone + 'static>(name: &str, message: &str) -> E {
    let id = std::any::TypeId::of::<E>();
    let make = ERRORS
        .with(|errors| {
            errors
                .borrow()
                .iter()
                .find(|(known, _)| *known == id)
                .map(|(_, make)| make.clone())
        })
        .unwrap_or_else(|| panic!("no {name} for this rejection type: {message}"));
    make(name, message)
        .downcast_ref::<E>()
        .expect("the registered error")
        .clone()
}

/// Makes `jobs` this thread's queues (the loop's `install` calls it), and
/// the stack below this call the async functions' budget.
pub fn install(jobs: Rc<Jobs>) {
    let budget = STACK_BUDGET.with(Cell::get);
    STACK_LIMIT.with(|limit| limit.set(stack_address().saturating_sub(budget)));
    let old = JOBS.with(|slot| slot.borrow_mut().replace(jobs));
    drop(old);
}

fn jobs() -> Rc<Jobs> {
    JOBS.with(|slot| slot.borrow().clone())
        .expect("no event loop installed on this thread")
}

/// The checkpoint of this thread's loop (see [`Jobs::checkpoint`]).
pub fn checkpoint() {
    jobs().checkpoint();
}

/// The checkpoint epoch: how many checkpoints of this thread's loop have
/// ended. A unit of work and the checkpoint after it see one value, the next
/// unit a larger one; so an I/O promise that records it where it starts and
/// finds it unchanged where it settles was settled in the checkpoint that
/// started it, an order Node never gives (`node::io` panics on it).
pub fn checkpoint_epoch() -> u64 {
    jobs().epoch.get()
}

/// `queueMicrotask(job)`.
pub fn queue_microtask(job: impl FnOnce() + 'static) {
    let jobs = jobs();
    let frame = jobs.frame.borrow().clone();
    jobs.micro.borrow_mut().push_back((frame, Box::new(job)));
}

/// `process.nextTick(job)`.
pub fn next_tick(job: impl FnOnce() + 'static) {
    let jobs = jobs();
    let frame = jobs.frame.borrow().clone();
    jobs.ticks.borrow_mut().push_back((frame, Box::new(job)));
}

/// `process.on('unhandledRejection', hook)` (one listener).
pub fn on_unhandled_rejection(hook: RejectionHook) {
    *jobs().hook.borrow_mut() = Some(hook);
}

/// The current async context frame.
pub fn current_frame() -> Frame {
    jobs().frame.borrow().clone()
}

/// `AsyncLocalStorage.snapshot()`: the current frame, to replay with
/// [`run_in_frame`].
pub fn snapshot() -> Frame {
    current_frame()
}

/// The call of a snapshot (`AsyncLocalStorage.snapshot()(f)`): `f` runs in
/// `frame`, and what it queues, starts or awaits keeps it.
pub fn run_in_frame<R>(frame: Frame, f: impl FnOnce() -> R) -> R {
    let jobs = jobs();
    let prior = jobs.frame.replace(frame);
    let result = f();
    *jobs.frame.borrow_mut() = prior;
    result
}

/// Runs `f` in `frame`, from a callback of the loop (a timer, an immediate).
pub(crate) fn with_frame(frame: Frame, f: impl FnOnce()) {
    run_in_frame(frame, f);
}

/// What a promise is resolved with: a plain value fulfils it at once; a
/// promise makes it follow that one, two jobs later.
pub enum Resolution<T: 'static, E: 'static> {
    Value(T),
    Promise(Promise<T, E>),
}

type Reaction<T, E> = (Frame, Box<dyn FnOnce(Result<T, E>)>);

enum State<T, E> {
    Pending(Vec<Reaction<T, E>>),
    Fulfilled(T),
    Rejected(E),
}

struct Inner<T: 'static, E: 'static> {
    id: u64,
    state: RefCell<State<T, E>>,
    handled: Cell<bool>,
}

impl<T: 'static, E: 'static> Drop for Inner<T, E> {
    /// A pending promise's reactions hold what follows it (derived
    /// promises, suspended tasks, theirs in turn): they are freed one list
    /// at a time, so a chain of any length drops without recursion.
    fn drop(&mut self) {
        let state = std::mem::replace(self.state.get_mut(), State::Pending(Vec::new()));
        if let State::Pending(reactions) = state
            && !reactions.is_empty()
        {
            defer_drop(Box::new(reactions));
        }
    }
}

/// A JavaScript promise of `T`, rejected with `E`. Clones are the same
/// promise.
pub struct Promise<T: 'static, E: 'static>(Rc<Inner<T, E>>);

impl<T: 'static, E: 'static> Clone for Promise<T, E> {
    fn clone(&self) -> Self {
        Promise(self.0.clone())
    }
}

/// The resolving functions of one promise (`resolve`, `reject`); only the
/// first call does anything.
pub struct Resolvers<T: 'static, E: 'static> {
    promise: Promise<T, E>,
    done: Rc<Cell<bool>>,
}

impl<T: 'static, E: 'static> Clone for Resolvers<T, E> {
    fn clone(&self) -> Self {
        Resolvers {
            promise: self.promise.clone(),
            done: self.done.clone(),
        }
    }
}

impl<T: Clone + 'static, E: Clone + 'static> Resolvers<T, E> {
    fn fresh(promise: Promise<T, E>) -> Resolvers<T, E> {
        Resolvers {
            promise,
            done: Rc::new(Cell::new(false)),
        }
    }

    /// `resolve(resolution)`.
    pub fn resolve(&self, resolution: Resolution<T, E>) {
        if self.done.replace(true) {
            return;
        }
        match resolution {
            Resolution::Value(value) => self.promise.fulfill(value),
            Resolution::Promise(thenable) => {
                if Rc::ptr_eq(&thenable.0, &self.promise.0) {
                    self.promise.reject_now(js_error(
                        "TypeError",
                        "Chaining cycle detected for promise #<Promise>",
                    ));
                    return;
                }
                // NewPromiseResolveThenableJob: `thenable.then(resolve,
                // reject)` with fresh resolving functions, one job later.
                let target = self.promise.clone();
                queue_microtask(move || {
                    let follow = Resolvers::fresh(target);
                    thenable.react(move |result| match result {
                        Ok(value) => follow.resolve(Resolution::Value(value)),
                        Err(reason) => follow.reject(reason),
                    });
                });
            }
        }
    }

    /// `resolve(value)` with a plain value.
    pub fn fulfill(&self, value: T) {
        self.resolve(Resolution::Value(value));
    }

    /// `reject(reason)`.
    pub fn reject(&self, reason: E) {
        if self.done.replace(true) {
            return;
        }
        self.promise.reject_now(reason);
    }

    /// The promise these functions settle.
    pub fn promise(&self) -> Promise<T, E> {
        self.promise.clone()
    }
}

impl<T: Clone + 'static, E: Clone + 'static> Promise<T, E> {
    fn pending() -> Promise<T, E> {
        let jobs = jobs();
        let id = jobs.next_promise.get() + 1;
        jobs.next_promise.set(id);
        Promise(Rc::new(Inner {
            id,
            state: RefCell::new(State::Pending(Vec::new())),
            handled: Cell::new(false),
        }))
    }

    /// `Promise.withResolvers()`.
    pub fn with_resolvers() -> (Promise<T, E>, Resolvers<T, E>) {
        let promise = Promise::pending();
        let resolvers = Resolvers::fresh(promise.clone());
        (promise, resolvers)
    }

    /// `new Promise(executor)`: the executor runs now; a throw rejects.
    pub fn executor(executor: impl FnOnce(Resolvers<T, E>) -> Result<(), E>) -> Promise<T, E> {
        let (promise, resolvers) = Promise::with_resolvers();
        if let Err(reason) = executor(resolvers.clone()) {
            resolvers.reject(reason);
        }
        promise
    }

    /// `Promise.resolve(x)`: a promise is returned as it is, a value is
    /// wrapped in a fulfilled promise.
    pub fn resolve(resolution: Resolution<T, E>) -> Promise<T, E> {
        match resolution {
            Resolution::Promise(promise) => promise,
            Resolution::Value(value) => {
                let promise = Promise::pending();
                promise.fulfill(value);
                promise
            }
        }
    }

    /// `Promise.reject(reason)`.
    pub fn reject(reason: E) -> Promise<T, E> {
        let promise = Promise::pending();
        promise.reject_now(reason);
        promise
    }

    /// Whether two handles are the same promise (`a === b`).
    pub fn same(&self, other: &Promise<T, E>) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }

    /// Whether it is settled (tests and diagnostics; JavaScript cannot ask).
    pub fn is_settled(&self) -> bool {
        !matches!(*self.0.state.borrow(), State::Pending(_))
    }

    fn fulfill(&self, value: T) {
        let reactions = {
            let mut state = self.0.state.borrow_mut();
            let State::Pending(reactions) =
                std::mem::replace(&mut *state, State::Fulfilled(value.clone()))
            else {
                unreachable!("a promise settles once")
            };
            reactions
        };
        let jobs = jobs();
        for (frame, reaction) in reactions {
            let value = value.clone();
            jobs.micro
                .borrow_mut()
                .push_back((frame, Box::new(move || reaction(Ok(value)))));
        }
    }

    fn reject_now(&self, reason: E) {
        let reactions = {
            let mut state = self.0.state.borrow_mut();
            let State::Pending(reactions) =
                std::mem::replace(&mut *state, State::Rejected(reason.clone()))
            else {
                unreachable!("a promise settles once")
            };
            reactions
        };
        let jobs = jobs();
        if !self.0.handled.get() {
            // HostPromiseRejectionTracker(promise, "reject").
            let frame = jobs.frame.borrow().clone();
            jobs.rejections.borrow_mut().push(Pending {
                id: self.0.id,
                reason: Rc::new(reason.clone()),
                frame,
            });
            jobs.rejection_to_warn.set(true);
        }
        for (frame, reaction) in reactions {
            let reason = reason.clone();
            jobs.micro
                .borrow_mut()
                .push_back((frame, Box::new(move || reaction(Err(reason)))));
        }
    }

    /// PerformPromiseThen without a derived promise: `reaction` runs in a
    /// job of its own once the promise settles (at once when it has).
    pub(crate) fn react(&self, reaction: impl FnOnce(Result<T, E>) + 'static) {
        let jobs = jobs();
        let frame = jobs.frame.borrow().clone();
        let settled = match &mut *self.0.state.borrow_mut() {
            State::Pending(reactions) => {
                reactions.push((frame, Box::new(reaction)));
                None
            }
            State::Fulfilled(value) => Some((frame, Ok(value.clone()), reaction)),
            State::Rejected(reason) => Some((frame, Err(reason.clone()), reaction)),
        };
        if !self.0.handled.replace(true) && matches!(*self.0.state.borrow(), State::Rejected(_)) {
            // HostPromiseRejectionTracker(promise, "handle").
            let id = self.0.id;
            jobs.rejections
                .borrow_mut()
                .retain(|pending| pending.id != id);
        }
        if let Some((frame, result, reaction)) = settled {
            jobs.micro
                .borrow_mut()
                .push_back((frame, Box::new(move || reaction(result))));
        }
    }

    /// `promise.then(onFulfilled, onRejected)`.
    pub fn then<U: Clone + 'static>(
        &self,
        on_fulfilled: impl FnOnce(T) -> Result<Resolution<U, E>, E> + 'static,
        on_rejected: impl FnOnce(E) -> Result<Resolution<U, E>, E> + 'static,
    ) -> Promise<U, E> {
        let (derived, resolvers) = Promise::with_resolvers();
        self.react(move |result| {
            let outcome = match result {
                Ok(value) => on_fulfilled(value),
                Err(reason) => on_rejected(reason),
            };
            match outcome {
                Ok(resolution) => resolvers.resolve(resolution),
                Err(reason) => resolvers.reject(reason),
            }
        });
        derived
    }

    /// `promise.then(onFulfilled)`: a rejection passes through.
    pub fn then_ok<U: Clone + 'static>(
        &self,
        on_fulfilled: impl FnOnce(T) -> Result<Resolution<U, E>, E> + 'static,
    ) -> Promise<U, E> {
        self.then(on_fulfilled, Err)
    }

    /// `promise.catch(onRejected)`: a value passes through.
    pub fn catch(
        &self,
        on_rejected: impl FnOnce(E) -> Result<Resolution<T, E>, E> + 'static,
    ) -> Promise<T, E> {
        self.then(|value| Ok(Resolution::Value(value)), on_rejected)
    }

    /// `promise.finally(onFinally)`, by the specification's thenFinally and
    /// catchFinally: what `onFinally` returns is awaited through
    /// `Promise.resolve(result).then(…)`, so the outcome comes later than a
    /// `then` would give it.
    pub fn finally<V: Clone + 'static>(
        &self,
        on_finally: impl FnOnce() -> Result<Resolution<V, E>, E> + 'static,
    ) -> Promise<T, E> {
        let shared = Rc::new(RefCell::new(Some(on_finally)));
        let again = shared.clone();
        self.then(
            move |value: T| {
                let on_finally = shared.borrow_mut().take().expect("finally runs once");
                let settled = Promise::resolve(on_finally()?);
                Ok(Resolution::Promise(
                    settled.then_ok(move |_| Ok(Resolution::Value(value))),
                ))
            },
            move |reason: E| {
                let on_finally = again.borrow_mut().take().expect("finally runs once");
                let settled = Promise::resolve(on_finally()?);
                Ok(Resolution::Promise(settled.then_ok(move |_| Err(reason))))
            },
        )
    }

    /// `Promise.all(items)`.
    pub fn all(items: Vec<Resolution<T, E>>) -> Promise<Vec<T>, E> {
        Promise::all_into(items, |values| values)
    }

    /// `Promise.all(items)` whose array is held as `U` (`into` shapes the
    /// values when it fulfils, adding no job).
    pub fn all_into<U: Clone + 'static>(
        items: Vec<Resolution<T, E>>,
        into: impl FnOnce(Vec<T>) -> U + 'static,
    ) -> Promise<U, E> {
        let (promise, resolvers) = Promise::with_resolvers();
        let into = Rc::new(RefCell::new(Some(into)));
        let values: Rc<RefCell<Vec<Option<T>>>> = Rc::new(RefCell::new(Vec::new()));
        let remaining = Rc::new(Cell::new(1usize));
        let finish = {
            let (values, resolvers) = (values.clone(), resolvers.clone());
            move || {
                let values = values
                    .borrow_mut()
                    .drain(..)
                    .map(|value| value.expect("every element"))
                    .collect();
                let into = into.borrow_mut().take().expect("all settles once");
                resolvers.fulfill(into(values));
            }
        };
        let finish = Rc::new(finish);
        for (index, item) in items.into_iter().enumerate() {
            values.borrow_mut().push(None);
            let next = Promise::resolve(item);
            remaining.set(remaining.get() + 1);
            let called = Rc::new(Cell::new(false));
            let (values, remaining, finish, reject) = (
                values.clone(),
                remaining.clone(),
                finish.clone(),
                resolvers.clone(),
            );
            let _ = next.then::<()>(
                move |value| {
                    if !called.replace(true) {
                        values.borrow_mut()[index] = Some(value);
                        remaining.set(remaining.get() - 1);
                        if remaining.get() == 0 {
                            finish();
                        }
                    }
                    Ok(Resolution::Value(()))
                },
                move |reason| {
                    reject.reject(reason);
                    Ok(Resolution::Value(()))
                },
            );
        }
        remaining.set(remaining.get() - 1);
        if remaining.get() == 0 {
            finish();
        }
        promise
    }

    /// `Promise.allSettled(items)`: each outcome, in order.
    pub fn all_settled(items: Vec<Resolution<T, E>>) -> Promise<Vec<Result<T, E>>, E> {
        let (promise, resolvers) = Promise::with_resolvers();
        let values: Outcomes<T, E> = Rc::new(RefCell::new(Vec::new()));
        let remaining = Rc::new(Cell::new(1usize));
        let finish = Rc::new({
            let (values, resolvers) = (values.clone(), resolvers.clone());
            move || {
                let values = values
                    .borrow_mut()
                    .drain(..)
                    .map(|value| value.expect("every element"))
                    .collect();
                resolvers.fulfill(values);
            }
        });
        for (index, item) in items.into_iter().enumerate() {
            values.borrow_mut().push(None);
            let next = Promise::resolve(item);
            remaining.set(remaining.get() + 1);
            let called = Rc::new(Cell::new(false));
            let record = {
                let (values, remaining, finish) =
                    (values.clone(), remaining.clone(), finish.clone());
                Rc::new(move |outcome: Result<T, E>| {
                    if !called.replace(true) {
                        values.borrow_mut()[index] = Some(outcome);
                        remaining.set(remaining.get() - 1);
                        if remaining.get() == 0 {
                            finish();
                        }
                    }
                })
            };
            let on_rejected = record.clone();
            let _ = next.then::<()>(
                move |value| {
                    record(Ok(value));
                    Ok(Resolution::Value(()))
                },
                move |reason| {
                    on_rejected(Err(reason));
                    Ok(Resolution::Value(()))
                },
            );
        }
        remaining.set(remaining.get() - 1);
        if remaining.get() == 0 {
            finish();
        }
        promise
    }

    /// `Promise.race(items)`.
    pub fn race(items: Vec<Resolution<T, E>>) -> Promise<T, E> {
        let (promise, resolvers) = Promise::with_resolvers();
        for item in items {
            let (resolve, reject) = (resolvers.clone(), resolvers.clone());
            let _ = Promise::resolve(item).then::<()>(
                move |value| {
                    resolve.fulfill(value);
                    Ok(Resolution::Value(()))
                },
                move |reason| {
                    reject.reject(reason);
                    Ok(Resolution::Value(()))
                },
            );
        }
        promise
    }
}

/// `await value` for a plain value: a promise fulfilled with it.
pub fn value<T: Clone + 'static, E: Clone + 'static>(value: T) -> Promise<T, E> {
    Promise::resolve(Resolution::Value(value))
}

/// One async function call in progress.
struct Task {
    body: RefCell<Option<Pin<Box<dyn Future<Output = ()>>>>>,
    /// Awaits begun during the current resumption.
    awaits: Cell<u32>,
}

impl Task {
    fn new(body: Pin<Box<dyn Future<Output = ()>>>) -> Rc<Task> {
        LIVE_TASKS.with(|live| live.set(live.get() + 1));
        Rc::new(Task {
            body: RefCell::new(Some(body)),
            awaits: Cell::new(0),
        })
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        let _ = LIVE_TASKS.try_with(|live| live.set(live.get() - 1));
    }
}

fn resume(task: &Rc<Task>) {
    let mut body = task
        .body
        .borrow_mut()
        .take()
        .expect("an async function resumed while it runs");
    TASKS.with(|tasks| tasks.borrow_mut().push(task.clone()));
    task.awaits.set(0);
    let polled = body.as_mut().poll(&mut Context::from_waker(Waker::noop()));
    TASKS.with(|tasks| tasks.borrow_mut().pop());
    if polled.is_pending() {
        match task.awaits.get() {
            1 => *task.body.borrow_mut() = Some(body),
            0 => panic!(
                "an async function suspended on something other than a JavaScript await (a plain Rust future)"
            ),
            _ => panic!("an async function suspended on two awaits at once (join! or select!)"),
        }
    }
}

/// An async function call: `body` runs now up to its first await; what it
/// returns resolves the returned promise (a promise returned is followed,
/// two jobs later), what it throws rejects it.
///
/// Started with this thread's stack budget spent (an async recursion far
/// deeper than the ledger's own), it does not run `body`: the promise it
/// returns is rejected with a `RangeError`, which the caller's await
/// throws, as JavaScript throws one at the call (there with no job before
/// the caller sees it).
pub fn async_fn<T: Clone + 'static, E: Clone + 'static>(
    body: impl Future<Output = Result<Resolution<T, E>, E>> + 'static,
) -> Promise<T, E> {
    if stack_exhausted() {
        return Promise::reject(js_error("RangeError", "Maximum call stack size exceeded"));
    }
    let (promise, resolvers) = Promise::with_resolvers();
    let task = Task::new(Box::pin(async move {
        match body.await {
            Ok(resolution) => resolvers.resolve(resolution),
            Err(reason) => resolvers.reject(reason),
        }
    }));
    resume(&task);
    promise
}

/// `await promise`: suspends always; resumes in the job of the promise's
/// reaction with its value or reason.
pub struct Await<T: 'static, E: 'static> {
    promise: Option<Promise<T, E>>,
    slot: Rc<RefCell<Option<Result<T, E>>>>,
    /// The frame the continuation runs in, when not the current one.
    frame: Option<Frame>,
}

/// An await whose continuation runs in `frame` rather than the frame
/// current at the await: V8's `yield` of a value that is not a promise
/// (`agen`), whose job carries no async context frame.
pub(crate) fn await_in<T: Clone + 'static, E: Clone + 'static>(
    promise: Promise<T, E>,
    frame: Frame,
) -> Await<T, E> {
    Await {
        promise: Some(promise),
        slot: Rc::new(RefCell::new(None)),
        frame: Some(frame),
    }
}

impl<T: Clone + 'static, E: Clone + 'static> Future for Await<T, E> {
    type Output = Result<T, E>;

    fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<T, E>> {
        if let Some(promise) = self.promise.take() {
            let task = TASKS
                .with(|tasks| tasks.borrow().last().cloned())
                .expect("await outside an async function");
            task.awaits.set(task.awaits.get() + 1);
            let slot = self.slot.clone();
            let reaction = move |result| {
                *slot.borrow_mut() = Some(result);
                resume(&task);
            };
            match self.frame.take() {
                Some(frame) => run_in_frame(frame, || promise.react(reaction)),
                None => promise.react(reaction),
            }
            return Poll::Pending;
        }
        match self.slot.borrow_mut().take() {
            Some(result) => Poll::Ready(result),
            None => panic!(
                "an await polled before its promise settled (join!, select! or a plain future)"
            ),
        }
    }
}

impl<T: Clone + 'static, E: Clone + 'static> IntoFuture for Promise<T, E> {
    type Output = Result<T, E>;
    type IntoFuture = Await<T, E>;

    fn into_future(self) -> Await<T, E> {
        Await {
            promise: Some(self),
            slot: Rc::new(RefCell::new(None)),
            frame: None,
        }
    }
}

impl<T: Clone + 'static, E: Clone + 'static> IntoFuture for &Promise<T, E> {
    type Output = Result<T, E>;
    type IntoFuture = Await<T, E>;

    fn into_future(self) -> Await<T, E> {
        self.clone().into_future()
    }
}

/// A body resumed synchronously by its owner, as a generator is by `next()`
/// (the base an async generator is built on; `async_fn` is resumed by jobs
/// only). It starts at its first `resume`; inside, [`suspend`] stops it
/// until the next `resume`, and its awaits are JavaScript awaits.
#[derive(Clone)]
pub struct Coroutine(Rc<Task>);

impl Coroutine {
    pub fn new(body: impl Future<Output = ()> + 'static) -> Coroutine {
        Coroutine(Task::new(Box::pin(body)))
    }

    /// Runs the body now up to its next suspension (an await or `suspend`).
    pub fn resume(&self) {
        resume(&self.0);
    }
}

/// The identity of the async function call or coroutine running now (0
/// outside any): `for await`'s close guard tells a loop its own body left
/// from one dropped with an abandoned task.
pub(crate) fn running_task() -> usize {
    TASKS.with(|tasks| {
        tasks
            .borrow()
            .last()
            .map_or(0, |task| Rc::as_ptr(task) as usize)
    })
}

/// The coroutine running now, as a handle its owner can resume later (an
/// async generator takes its body's task back when the body suspends).
pub(crate) fn running_coroutine() -> Coroutine {
    Coroutine(
        TASKS
            .with(|tasks| tasks.borrow().last().cloned())
            .expect("a coroutine is running"),
    )
}

/// Stops the current coroutine until its owner resumes it.
pub fn suspend() -> Suspend {
    Suspend { suspended: false }
}

pub struct Suspend {
    suspended: bool,
}

impl Future for Suspend {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
        if self.suspended {
            return Poll::Ready(());
        }
        self.suspended = true;
        let task = TASKS
            .with(|tasks| tasks.borrow().last().cloned())
            .expect("suspend outside a coroutine");
        task.awaits.set(task.awaits.get() + 1);
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::testing::test_loop;
    use crate::value::W;

    /// `f(n) = async () => n === 0 ? 0 : 1 + await f(n - 1)`.
    fn nest(n: u32) -> Promise<f64, W> {
        async_fn(async move {
            if n == 0 {
                return Ok(Resolution::Value(0.0));
            }
            let below = nest(n - 1).await?;
            Ok(Resolution::Value(below + 1.0))
        })
    }

    fn outcome<T: Clone + 'static>(promise: &Promise<T, W>) -> Rc<RefCell<Option<Result<T, W>>>> {
        let seen = Rc::new(RefCell::new(None));
        let (ok, err) = (seen.clone(), seen.clone());
        let _ = promise.then::<()>(
            move |value| {
                *ok.borrow_mut() = Some(Ok(value));
                Ok(Resolution::Value(()))
            },
            move |reason| {
                *err.borrow_mut() = Some(Err(reason));
                Ok(Resolution::Value(()))
            },
        );
        seen
    }

    /// Runs `test` on a thread with the loop thread's stack and budget
    /// (`process::LOOP_STACK`), as the shipped process runs its loop.
    fn on_loop_thread(test: impl FnOnce() + Send + 'static) {
        std::thread::Builder::new()
            .stack_size(crate::process::LOOP_STACK)
            .spawn(move || {
                set_stack_budget(crate::process::LOOP_STACK_BUDGET);
                test();
            })
            .expect("a thread")
            .join()
            .expect("the test passed");
    }

    /// The ledger's recursions go a directory tree deep; 10,000 nested async
    /// calls (where the review's probe overflowed the 8 MiB main thread)
    /// complete on the loop thread.
    #[test]
    fn ten_thousand_nested_async_calls_complete_on_the_loop_thread() {
        on_loop_thread(|| {
            let (event_loop, _) = test_loop();
            let seen = outcome(&nest(10_000));
            event_loop.checkpoint();
            assert!(matches!(*seen.borrow(), Some(Ok(depth)) if depth == 10_000.0));
        });
    }

    /// Past the budget a start fails with a catchable `RangeError` that
    /// every level rethrows, as in JavaScript; the process lives on.
    #[test]
    fn an_async_recursion_past_the_stack_budget_rejects_with_a_range_error() {
        on_loop_thread(|| {
            set_stack_budget(256 << 10);
            let (event_loop, _) = test_loop();
            let seen = outcome(&nest(1_000_000));
            event_loop.checkpoint();
            let failure = seen.borrow_mut().take();
            let Some(Err(W::Error(error))) = failure else {
                panic!("no RangeError");
            };
            assert_eq!(error.name.to_string_lossy(), "RangeError");
            assert_eq!(
                error.message.to_string_lossy(),
                "Maximum call stack size exceeded"
            );
            // The budget is spent no more: the loop goes on.
            let after = outcome(&nest(10));
            event_loop.checkpoint();
            assert!(matches!(*after.borrow(), Some(Ok(depth)) if depth == 10.0));
            assert_eq!(live_tasks(), 0);
        });
    }

    /// A pending chain of a million links (`tail = tail.then(…)`, and
    /// async functions each awaiting the one before) drops without
    /// recursion, on the 2 MiB stack of a test thread.
    #[test]
    fn a_pending_chain_of_a_million_links_drops_without_recursion() {
        let _ = test_loop();
        let (head, settle) = Promise::<u32, W>::with_resolvers();
        let mut tail = head.clone();
        for _ in 0..1_000_000 {
            tail = tail.then_ok(|value| Ok(Resolution::Value(value + 1)));
        }
        let mut waiting = tail;
        for _ in 0..100_000 {
            let previous = waiting.clone();
            waiting = async_fn(async move { Ok(Resolution::Value(previous.await? + 1)) });
        }
        assert_eq!(live_tasks(), 100_000);
        drop((head, settle, waiting));
        assert_eq!(live_tasks(), 0);
    }

    /// The same chain settled: one job per link, iteratively.
    #[test]
    fn a_chain_of_a_hundred_thousand_links_settles() {
        let (event_loop, _) = test_loop();
        let (head, settle) = Promise::<u32, W>::with_resolvers();
        let mut tail = head;
        for _ in 0..100_000 {
            tail = tail.then_ok(|value| Ok(Resolution::Value(value + 1)));
        }
        let seen = outcome(&tail);
        settle.fulfill(0);
        event_loop.checkpoint();
        assert!(matches!(*seen.borrow(), Some(Ok(100_000))));
    }
}
