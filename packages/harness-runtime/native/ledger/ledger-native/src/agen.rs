//! Async generators, `for await`, `yield*` and the async-from-sync
//! iterator, by ECMA-262's steps (the job layer's second part, plan package
//! O2b; the porting rule is in `packages/harness-runtime/DOCUMENTATION.md`,
//! "Native ledger process"). No ledger type is used here.
//!
//! - [`async_gen`] is `async function*`: the call makes the generator object
//!   and runs nothing; the body starts at the first `next()`, synchronously
//!   inside it, in the caller's frame. Requests (`next`, `return_`,
//!   `throw_`) are queued and answered in order (AsyncGeneratorEnqueue,
//!   AsyncGeneratorResume, AsyncGeneratorCompleteStep,
//!   AsyncGeneratorDrainQueue, AsyncGeneratorAwaitReturn).
//! - In the body, [`Co::yield_`] is `yield v` (it awaits `v` first, then
//!   AsyncGeneratorYield; a received return awaits its value:
//!   AsyncGeneratorUnwrapYieldResumption), [`Co::delegate`] is `yield*`,
//!   [`Co::ret`] is `return v` (which awaits `v`). The body's `Err` is an
//!   abrupt completion ([`Abrupt`]): `?` carries a received return or throw
//!   out through the port's explicit `finally` code, as JavaScript does.
//! - [`for_await`] is the `for await` loop: [`ForAwait::next`] is one
//!   iteration's `Await(next())`, [`ForAwait::close`] and
//!   [`ForAwait::close_throw`] are AsyncIteratorClose on `break`/`return`
//!   and on a throw. A loop left without either (an early `?` or `return`
//!   while it is open) panics where it is dropped, in its own task; one
//!   dropped with an abandoned task (an await that never settles) does not.
//! - [`from_sync`] is CreateAsyncFromSyncIterator (a `for await` or
//!   `yield*` over an array or another sync iterable), with its extra await
//!   per value and its close on a rejected value.
//!
//! - After `yield v` with a request already queued, the body goes on in the
//!   empty async context frame when `v` is a primitive or a plain object
//!   (Electron's V8; [`YieldFrame`] decides by value), in the caller's
//!   otherwise.
//! - A return received at a `yield*` whose value rejects is sent to the
//!   inner iterator as `next(reason)`, as V8 does on both Nodes.
//!
//! Values are of one type `T` whose `Default` is JavaScript's `undefined`;
//! where JavaScript awaits a value (`yield`, `return`, `return()`), the API
//! takes a [`Resolution`], so a promise is followed and a plain value is
//! not. A request made with this thread's stack budget spent is rejected
//! with a `RangeError`, as `async_fn` is.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use crate::js::{self, Coroutine, Promise, Resolution, Resolvers};

/// An iterator result, `{ value, done }`.
#[derive(Clone)]
pub struct Step<T> {
    pub value: T,
    pub done: bool,
}

/// Electron's V8 frame rule for `yield v` (`packages/harness-runtime/DOCUMENTATION.md`,
/// "Iteration"): whether V8 awaits `v` on its fast path, whose job carries
/// no async context frame. That is so for a primitive and for an ordinary
/// object whose prototype is `Object.prototype` (in V8's fast mode, with no
/// accessor and no own `then`); an array, a `Buffer` or typed array, an
/// `Error`, a function, a class instance, a `Map`, a `Date`, a generator
/// object, a boxed primitive, a promise or a thenable keeps the frame.
/// Node 26.13's V8 keeps it for every value; the product's runtime is
/// Electron's.
pub trait YieldFrame {
    fn loses_frame_when_yielded(&self) -> bool;
}

/// An abrupt completion in a generator body: a return (its value already
/// awaited) or a throw.
#[derive(Clone)]
pub enum Abrupt<T, E> {
    Return(T),
    Throw(E),
}

impl<T, E> From<E> for Abrupt<T, E> {
    fn from(reason: E) -> Abrupt<T, E> {
        Abrupt::Throw(reason)
    }
}

/// What a request's promise is: `Ok` with the call's promise, or the
/// method's synchronous throw.
pub type Call<T, E> = Result<Promise<Step<T>, E>, E>;

/// An async iterator as `for await` and `yield*` call it (its `next`,
/// `return` and `throw` methods). `return_` and `throw_` give `None` when the
/// iterator has no such method.
pub trait AsyncIterator<T: 'static, E: 'static> {
    fn next(&self, value: T) -> Call<T, E>;
    fn return_(&self, value: T) -> Option<Call<T, E>>;
    fn throw_(&self, reason: E) -> Option<Call<T, E>>;
}

/// A sync iterator's result: its value may be a promise (an async-from-sync
/// iterator awaits it).
pub struct SyncStep<T: 'static, E: 'static> {
    pub value: Resolution<T, E>,
    pub done: bool,
}

/// A sync iterator (`next`, and `return`/`throw` when it has them), as
/// CreateAsyncFromSyncIterator wraps it.
pub trait SyncIterator<T: 'static, E: 'static> {
    fn next(&self, value: T) -> Result<SyncStep<T, E>, E>;
    fn return_(&self, value: T) -> Option<Result<SyncStep<T, E>, E>>;
    fn throw_(&self, reason: E) -> Option<Result<SyncStep<T, E>, E>>;
}

/// What a `for await` or `yield*` can iterate: an async iterator, made from
/// its source (GetIterator with kind async).
pub trait IntoAsyncIterator<T: 'static, E: 'static> {
    fn into_async_iterator(self) -> Rc<dyn AsyncIterator<T, E>>;
}

impl<T: 'static, E: 'static> IntoAsyncIterator<T, E> for Rc<dyn AsyncIterator<T, E>> {
    fn into_async_iterator(self) -> Rc<dyn AsyncIterator<T, E>> {
        self
    }
}

fn copy<T: Clone + 'static, E: 'static>(resolution: &Resolution<T, E>) -> Resolution<T, E> {
    match resolution {
        Resolution::Value(value) => Resolution::Value(value.clone()),
        Resolution::Promise(promise) => Resolution::Promise(promise.clone()),
    }
}

fn range_error<T: Clone + 'static, E: Clone + 'static>() -> Promise<T, E> {
    Promise::reject(js::js_error(
        "RangeError",
        "Maximum call stack size exceeded",
    ))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    SuspendedStart,
    SuspendedYield,
    Executing,
    DrainingQueue,
    Completed,
}

/// A queued request's completion.
enum Completion<T: 'static, E: 'static> {
    Normal(T),
    Return(Resolution<T, E>),
    Throw(E),
}

impl<T: Clone + 'static, E: Clone + 'static> Completion<T, E> {
    fn copy(&self) -> Completion<T, E> {
        match self {
            Completion::Normal(value) => Completion::Normal(value.clone()),
            Completion::Return(resolution) => Completion::Return(copy(resolution)),
            Completion::Throw(reason) => Completion::Throw(reason.clone()),
        }
    }
}

struct Request<T: 'static, E: 'static> {
    completion: Completion<T, E>,
    resolvers: Resolvers<Step<T>, E>,
}

type Body<T, E> = Pin<Box<dyn Future<Output = Result<(), Abrupt<T, E>>>>>;
type Start<T, E> = Box<dyn FnOnce(Co<T, E>) -> Body<T, E>>;

/// One generator object.
struct Gen<T: 'static, E: 'static> {
    state: Cell<State>,
    queue: RefCell<VecDeque<Request<T, E>>>,
    start: RefCell<Option<Start<T, E>>>,
    body: RefCell<Option<Coroutine>>,
    shared: Rc<Shared<T, E>>,
}

/// What the body's [`Co`] holds: the generator while it executes (so an
/// await in the body keeps it alive, as the pending await keeps a
/// JavaScript generator), nothing while it is suspended (so an abandoned
/// generator is freed, as JavaScript's collector frees it). The generator
/// holds its body's task only while it is suspended: while it executes, the
/// task is held by what runs it or by the reaction of the promise it
/// awaits, so a generator whose await is abandoned (the promise dropped by
/// everyone) is freed with it, as JavaScript collects it.
struct Shared<T: 'static, E: 'static> {
    keep: RefCell<Option<Rc<Gen<T, E>>>>,
}

impl<T: 'static, E: 'static> Drop for Gen<T, E> {
    /// A generator suspended inside another's `yield*` holds that one:
    /// bodies are freed one at a time, so a chain of any depth drops
    /// without recursion.
    fn drop(&mut self) {
        if let Some(body) = self.body.get_mut().take() {
            js::defer_drop(Box::new(body));
        }
        if let Some(start) = self.start.get_mut().take() {
            js::defer_drop(Box::new(start));
        }
    }
}

/// An async generator object (`async function*`'s call). Clones are the
/// same object.
pub struct AsyncGen<T: 'static, E: 'static>(Rc<Gen<T, E>>);

impl<T: 'static, E: 'static> Clone for AsyncGen<T, E> {
    fn clone(&self) -> Self {
        AsyncGen(self.0.clone())
    }
}

/// The body's handle on its generator: `yield`, `yield*`, `return`.
pub struct Co<T: 'static, E: 'static>(Rc<Shared<T, E>>);

impl<T: 'static, E: 'static> Clone for Co<T, E> {
    fn clone(&self) -> Self {
        Co(self.0.clone())
    }
}

/// `async function* (…) { body }` called: the generator object; `body`
/// runs at the first `next()`.
pub fn async_gen<T, E, F, Fut>(body: F) -> AsyncGen<T, E>
where
    T: Clone + Default + 'static,
    E: Clone + 'static,
    F: FnOnce(Co<T, E>) -> Fut + 'static,
    Fut: Future<Output = Result<(), Abrupt<T, E>>> + 'static,
{
    let start: Start<T, E> = Box::new(move |co| Box::pin(body(co)));
    AsyncGen(Rc::new(Gen {
        state: Cell::new(State::SuspendedStart),
        queue: RefCell::new(VecDeque::new()),
        start: RefCell::new(Some(start)),
        body: RefCell::new(None),
        shared: Rc::new(Shared {
            keep: RefCell::new(None),
        }),
    }))
}

impl<T: Clone + Default + 'static, E: Clone + 'static> Gen<T, E> {
    fn enqueue(&self, completion: Completion<T, E>) -> Promise<Step<T>, E> {
        let (promise, resolvers) = Promise::with_resolvers();
        self.queue.borrow_mut().push_back(Request {
            completion,
            resolvers,
        });
        promise
    }

    fn front(&self) -> Completion<T, E> {
        self.queue
            .borrow()
            .front()
            .map(|request| request.completion.copy())
            .expect("a resumed generator has a request")
    }

    /// AsyncGeneratorCompleteStep: the first request settles.
    fn complete_step(&self, result: Result<T, E>, done: bool) {
        let request = self
            .queue
            .borrow_mut()
            .pop_front()
            .expect("a step completes a request");
        match result {
            Ok(value) => request.resolvers.fulfill(Step { value, done }),
            Err(reason) => request.resolvers.reject(reason),
        }
    }

    /// AsyncGeneratorResume: runs the body now, up to its next suspension.
    /// The body's task leaves the generator while it executes, and comes
    /// back when it suspends at a `yield` ([`Co::yield_step`]).
    fn resume(self: &Rc<Self>) {
        self.state.set(State::Executing);
        *self.shared.keep.borrow_mut() = Some(self.clone());
        let suspended = self.body.borrow_mut().take();
        let body = match suspended {
            Some(body) => body,
            None => {
                let start = self
                    .start
                    .borrow_mut()
                    .take()
                    .expect("a generator starts once");
                let shared = self.shared.clone();
                let body = start(Co(shared.clone()));
                Coroutine::new(async move {
                    let ended = body.await;
                    let generator = shared
                        .keep
                        .borrow()
                        .clone()
                        .expect("a body ends while it executes");
                    generator.finish(ended);
                })
            }
        };
        body.resume();
    }

    /// AsyncGeneratorStart's end: the body's completion settles the request
    /// that resumed it, then the queue drains.
    fn finish(self: &Rc<Self>, ended: Result<(), Abrupt<T, E>>) {
        self.state.set(State::DrainingQueue);
        match ended {
            Ok(()) => self.complete_step(Ok(T::default()), true),
            Err(Abrupt::Return(value)) => self.complete_step(Ok(value), true),
            Err(Abrupt::Throw(reason)) => self.complete_step(Err(reason), true),
        }
        self.drain_queue();
        // The body is done: nothing it holds keeps the generator now.
        let kept = self.shared.keep.borrow_mut().take();
        js::defer_drop(Box::new(kept));
    }

    /// AsyncGeneratorDrainQueue.
    fn drain_queue(self: &Rc<Self>) {
        loop {
            let front = self
                .queue
                .borrow()
                .front()
                .map(|request| request.completion.copy());
            match front {
                None => {
                    self.state.set(State::Completed);
                    return;
                }
                Some(Completion::Return(value)) => {
                    self.await_return(value);
                    return;
                }
                Some(Completion::Normal(_)) => self.complete_step(Ok(T::default()), true),
                Some(Completion::Throw(reason)) => self.complete_step(Err(reason), true),
            }
        }
    }

    /// AsyncGeneratorAwaitReturn: `PromiseResolve(value)`, then the request
    /// settles with its outcome and the queue drains.
    fn await_return(self: &Rc<Self>, value: Resolution<T, E>) {
        let generator = self.clone();
        Promise::resolve(value).react(move |outcome| {
            generator.complete_step(outcome, true);
            generator.drain_queue();
        });
    }
}

impl<T: Clone + Default + 'static, E: Clone + 'static> AsyncGen<T, E> {
    /// `generator.next(value)`.
    pub fn next(&self, value: T) -> Promise<Step<T>, E> {
        if js::stack_exhausted() {
            return range_error();
        }
        let generator = &self.0;
        let state = generator.state.get();
        if state == State::Completed {
            return js::value(Step {
                value: T::default(),
                done: true,
            });
        }
        let promise = generator.enqueue(Completion::Normal(value));
        if matches!(state, State::SuspendedStart | State::SuspendedYield) {
            generator.resume();
        }
        promise
    }

    /// `generator.return(value)`: `value` is awaited.
    pub fn return_(&self, value: Resolution<T, E>) -> Promise<Step<T>, E> {
        if js::stack_exhausted() {
            return range_error();
        }
        let generator = &self.0;
        let state = generator.state.get();
        let promise = generator.enqueue(Completion::Return(copy(&value)));
        match state {
            State::SuspendedStart | State::Completed => {
                // Never started: it never will.
                let start = generator.start.borrow_mut().take();
                drop(start);
                generator.state.set(State::DrainingQueue);
                generator.await_return(value);
            }
            State::SuspendedYield => generator.resume(),
            State::Executing | State::DrainingQueue => {}
        }
        promise
    }

    /// `generator.throw(reason)`.
    pub fn throw_(&self, reason: E) -> Promise<Step<T>, E> {
        if js::stack_exhausted() {
            return range_error();
        }
        let generator = &self.0;
        let mut state = generator.state.get();
        if state == State::SuspendedStart {
            let start = generator.start.borrow_mut().take();
            drop(start);
            generator.state.set(State::Completed);
            state = State::Completed;
        }
        if state == State::Completed {
            return Promise::reject(reason);
        }
        let promise = generator.enqueue(Completion::Throw(reason));
        if state == State::SuspendedYield {
            generator.resume();
        }
        promise
    }

    /// Whether two handles are one generator object.
    pub fn same(&self, other: &AsyncGen<T, E>) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl<T: Clone + Default + 'static, E: Clone + 'static> AsyncIterator<T, E> for AsyncGen<T, E> {
    fn next(&self, value: T) -> Call<T, E> {
        Ok(AsyncGen::next(self, value))
    }

    fn return_(&self, value: T) -> Option<Call<T, E>> {
        Some(Ok(AsyncGen::return_(self, Resolution::Value(value))))
    }

    fn throw_(&self, reason: E) -> Option<Call<T, E>> {
        Some(Ok(AsyncGen::throw_(self, reason)))
    }
}

impl<T: Clone + Default + 'static, E: Clone + 'static> IntoAsyncIterator<T, E> for AsyncGen<T, E> {
    fn into_async_iterator(self) -> Rc<dyn AsyncIterator<T, E>> {
        Rc::new(self)
    }
}

impl<T: Clone + Default + 'static, E: Clone + 'static> IntoAsyncIterator<T, E> for &AsyncGen<T, E> {
    fn into_async_iterator(self) -> Rc<dyn AsyncIterator<T, E>> {
        Rc::new(self.clone())
    }
}

/// What resumed a `yield`.
enum Received<T, E> {
    Normal(T),
    Return(T),
    Throw(E),
}

impl<T: Clone + Default + YieldFrame + 'static, E: Clone + 'static> Co<T, E> {
    fn generator(&self) -> Rc<Gen<T, E>> {
        self.0
            .keep
            .borrow()
            .clone()
            .expect("a generator's body runs only while it executes")
    }

    /// `yield value`: `Await(value)`, then AsyncGeneratorYield. Gives what
    /// the next request sends (`next(v)`'s `v`), or the received return or
    /// throw as `Err`.
    pub async fn yield_(&self, value: Resolution<T, E>) -> Result<T, Abrupt<T, E>> {
        let value = match value {
            Resolution::Promise(promise) => promise.await?,
            // Electron's V8 awaits a primitive or a plain object on a fast
            // path whose job carries no async context frame: what the body
            // runs after it, when a request is already queued, runs in the
            // empty frame ([`YieldFrame`]; Node 26.13's V8 keeps the frame).
            // Any other value keeps it. The product's runtime is Electron's.
            Resolution::Value(value) if value.loses_frame_when_yielded() => {
                js::await_in(js::value::<T, E>(value), js::Frame::default()).await?
            }
            Resolution::Value(value) => js::value::<T, E>(value).await?,
        };
        self.yield_value(value).await
    }

    /// AsyncGeneratorYield of a value already awaited (`yield*`'s inner
    /// values are not awaited again).
    async fn yield_value(&self, value: T) -> Result<T, Abrupt<T, E>> {
        let completion = self.yield_step(value).await;
        self.unwrap_resumption(completion).await
    }

    /// AsyncGeneratorYield up to the resumption: the request it answers
    /// settles, and the body suspends (its task back in the generator)
    /// unless a request is already queued; gives the request that resumes
    /// it.
    async fn yield_step(&self, value: T) -> Completion<T, E> {
        let generator = self.generator();
        generator.complete_step(Ok(value), false);
        if generator.queue.borrow().is_empty() {
            generator.state.set(State::SuspendedYield);
            *generator.body.borrow_mut() = Some(js::running_coroutine());
            drop(generator);
            let kept = self.0.keep.borrow_mut().take();
            js::defer_drop(Box::new(kept));
            js::suspend().await;
        } else {
            drop(generator);
        }
        self.generator().front()
    }

    /// AsyncGeneratorUnwrapYieldResumption: a received return awaits its
    /// value (a rejection becomes a throw).
    async fn unwrap_resumption(&self, completion: Completion<T, E>) -> Result<T, Abrupt<T, E>> {
        match completion {
            Completion::Normal(value) => Ok(value),
            Completion::Throw(reason) => Err(Abrupt::Throw(reason)),
            Completion::Return(value) => match Promise::resolve(value).await {
                Ok(value) => Err(Abrupt::Return(value)),
                Err(reason) => Err(Abrupt::Throw(reason)),
            },
        }
    }

    /// `return value` in the body: `Await(value)`; the body returns the
    /// result as its `Err` (`return Err(co.ret(v).await)`), so it passes
    /// through the port's `finally` code as a return completion.
    pub async fn ret(&self, value: Resolution<T, E>) -> Abrupt<T, E> {
        match Promise::resolve(value).await {
            Ok(value) => Abrupt::Return(value),
            Err(reason) => Abrupt::Throw(reason),
        }
    }

    /// The resumption of a `yield*`'s own yield. A received return awaits
    /// its value, as AsyncGeneratorUnwrapYieldResumption does; when that
    /// value rejects, V8 (both Nodes) sends the reason to the inner
    /// iterator as `next(reason)`, where the specification's text makes it
    /// a throw (measured: a return of a rejected promise or of a rejecting
    /// thenable at a `yield*` over an async generator, a sync iterable with
    /// or without `return`, and an async iterator without `return`).
    async fn received(&self, value: T) -> Received<T, E>
    where
        E: Into<T>,
    {
        match self.yield_step(value).await {
            Completion::Normal(value) => Received::Normal(value),
            Completion::Throw(reason) => Received::Throw(reason),
            Completion::Return(value) => match Promise::resolve(value).await {
                Ok(value) => Received::Return(value),
                Err(reason) => Received::Normal(reason.into()),
            },
        }
    }

    /// `yield* source` (the delegation steps of YieldExpression, async):
    /// gives the inner iterator's return value, or the abrupt completion
    /// that ended it.
    pub async fn delegate(&self, source: impl IntoAsyncIterator<T, E>) -> Result<T, Abrupt<T, E>>
    where
        E: Into<T>,
    {
        let inner = source.into_async_iterator();
        let mut received = Received::Normal(T::default());
        loop {
            let step = match received {
                Received::Normal(value) => inner.next(value)?.await?,
                Received::Throw(reason) => match inner.throw_(reason) {
                    Some(call) => call?.await?,
                    None => {
                        // No throw method: close the inner iterator, then a
                        // TypeError.
                        close(&inner).await?;
                        return Err(Abrupt::Throw(js::js_error(
                            "TypeError",
                            "The iterator does not provide a 'throw' method",
                        )));
                    }
                },
                Received::Return(value) => {
                    // No return method: the value is awaited again; with
                    // one, its done value is not (V8, both Nodes; measured
                    // in the report's e4).
                    let Some(call) = inner.return_(value.clone()) else {
                        let value = js::value::<T, E>(value).await?;
                        return Err(Abrupt::Return(value));
                    };
                    let step = call?.await?;
                    if step.done {
                        return Err(Abrupt::Return(step.value));
                    }
                    received = self.received(step.value).await;
                    continue;
                }
            };
            if step.done {
                return Ok(step.value);
            }
            received = self.received(step.value).await;
        }
    }
}

/// AsyncIteratorClose with a normal completion: `return()` called and
/// awaited; its failure is the loop's.
async fn close<T: Clone + Default + 'static, E: Clone + 'static>(
    iterator: &Rc<dyn AsyncIterator<T, E>>,
) -> Result<(), E> {
    match iterator.return_(T::default()) {
        None => Ok(()),
        Some(call) => {
            call?.await?;
            Ok(())
        }
    }
}

/// One `for await` loop over an async iterator.
pub struct ForAwait<T: 'static, E: 'static> {
    iterator: Rc<dyn AsyncIterator<T, E>>,
    open: Cell<bool>,
    /// The task the loop runs in (`js::running_task`).
    owner: usize,
}

/// `for await (const x of source)`: GetIterator (kind async), then the loop.
/// Must be made inside an async function or generator body.
pub fn for_await<T: 'static, E: 'static>(source: impl IntoAsyncIterator<T, E>) -> ForAwait<T, E> {
    let owner = js::running_task();
    assert!(owner != 0, "for await outside an async function");
    ForAwait {
        iterator: source.into_async_iterator(),
        open: Cell::new(true),
        owner,
    }
}

impl<T: Clone + Default + 'static, E: Clone + 'static> ForAwait<T, E> {
    /// One iteration: `Await(next())`; `None` at the end. A throw of
    /// `next()` or a rejection ends the loop without closing the iterator.
    pub async fn next(&self) -> Result<Option<T>, E> {
        assert!(self.open.get(), "a for await iterated after its end");
        let call = match self.iterator.next(T::default()) {
            Ok(call) => call,
            Err(reason) => {
                self.open.set(false);
                return Err(reason);
            }
        };
        match call.await {
            Ok(step) if step.done => {
                self.open.set(false);
                Ok(None)
            }
            Ok(step) => Ok(Some(step.value)),
            Err(reason) => {
                self.open.set(false);
                Err(reason)
            }
        }
    }

    /// AsyncIteratorClose for `break` or `return` (or a `continue`/`break`
    /// of an outer loop): `return()` called and awaited; its failure
    /// replaces the completion.
    pub async fn close(&self) -> Result<(), E> {
        assert!(
            self.open.replace(false),
            "a for await closed twice or after its end"
        );
        close(&self.iterator).await
    }

    /// AsyncIteratorClose for a throw out of the body: `return()` called and
    /// awaited (when it does not throw at once), and the original error
    /// kept whatever it gives.
    pub async fn close_throw(&self, reason: E) -> E {
        assert!(
            self.open.replace(false),
            "a for await closed twice or after its end"
        );
        if let Some(Ok(call)) = self.iterator.return_(T::default()) {
            let _ = call.await;
        }
        reason
    }
}

impl<T: Clone + Default + 'static, E: Clone + 'static> ForAwait<T, E> {
    /// AsyncIteratorClose for an abrupt completion out of a loop body in a
    /// generator (`Err(abrupt)` of the body's inline block): a return
    /// closes as `close` does (a failure of `return()` becomes the throw), a
    /// throw as `close_throw` does.
    pub async fn exit(&self, abrupt: Abrupt<T, E>) -> Abrupt<T, E> {
        match abrupt {
            Abrupt::Return(value) => match self.close().await {
                Ok(()) => Abrupt::Return(value),
                Err(reason) => Abrupt::Throw(reason),
            },
            Abrupt::Throw(reason) => Abrupt::Throw(self.close_throw(reason).await),
        }
    }
}

impl<T: 'static, E: 'static> Drop for ForAwait<T, E> {
    /// The porting rule's close guard: a loop left open by its own body.
    fn drop(&mut self) {
        if self.open.get() && js::running_task() == self.owner && !std::thread::panicking() {
            panic!(
                "a for await was left without closing its iterator (call close() on break or return, close_throw(e) on a throw)"
            );
        }
    }
}

/// CreateAsyncFromSyncIterator.
struct FromSync<T: 'static, E: 'static>(Rc<dyn SyncIterator<T, E>>);

/// A sync iterator as an async one (CreateAsyncFromSyncIterator).
pub fn from_sync<T: Clone + Default + 'static, E: Clone + 'static>(
    iterator: Rc<dyn SyncIterator<T, E>>,
) -> Rc<dyn AsyncIterator<T, E>> {
    Rc::new(FromSync(iterator))
}

impl<T: Clone + Default + 'static, E: Clone + 'static> FromSync<T, E> {
    /// AsyncFromSyncIteratorContinuation: `PromiseResolve(value)`, then the
    /// result; a rejected value closes the sync iterator first when
    /// `close_on_rejection` and not done.
    fn continuation(
        &self,
        step: SyncStep<T, E>,
        resolvers: Resolvers<Step<T>, E>,
        close_on_rejection: bool,
    ) {
        let done = step.done;
        let sync = self.0.clone();
        Promise::resolve(step.value).react(move |outcome| match outcome {
            Ok(value) => resolvers.fulfill(Step { value, done }),
            Err(reason) => {
                if !done && close_on_rejection {
                    // IteratorClose(syncIteratorRecord, ThrowCompletion(reason)).
                    let _ = sync.return_(T::default());
                }
                resolvers.reject(reason);
            }
        });
    }
}

impl<T: Clone + Default + 'static, E: Clone + 'static> AsyncIterator<T, E> for FromSync<T, E> {
    fn next(&self, value: T) -> Call<T, E> {
        let (promise, resolvers) = Promise::with_resolvers();
        match self.0.next(value) {
            Ok(step) => self.continuation(step, resolvers, true),
            Err(reason) => resolvers.reject(reason),
        }
        Ok(promise)
    }

    fn return_(&self, value: T) -> Option<Call<T, E>> {
        let (promise, resolvers) = Promise::with_resolvers();
        match self.0.return_(value.clone()) {
            None => resolvers.fulfill(Step { value, done: true }),
            Some(Ok(step)) => self.continuation(step, resolvers, false),
            Some(Err(reason)) => resolvers.reject(reason),
        }
        Some(Ok(promise))
    }

    fn throw_(&self, reason: E) -> Option<Call<T, E>> {
        let (promise, resolvers) = Promise::with_resolvers();
        match self.0.throw_(reason) {
            Some(Ok(step)) => self.continuation(step, resolvers, true),
            Some(Err(reason)) => resolvers.reject(reason),
            None => {
                // No throw method: close the sync iterator, then a TypeError
                // (a throw of its `return` wins).
                match self.0.return_(T::default()) {
                    Some(Err(failure)) => resolvers.reject(failure),
                    _ => resolvers.reject(js::js_error(
                        "TypeError",
                        "The iterator does not provide a 'throw' method",
                    )),
                }
            }
        }
        Some(Ok(promise))
    }
}

/// An array's iterator (`%ArrayIteratorPrototype%`): its items in order, no
/// `return`, no `throw`.
struct ArrayIterator<T: 'static, E: 'static> {
    items: Vec<Resolution<T, E>>,
    at: Cell<usize>,
}

/// `array[Symbol.iterator]()` over `items` (values or promises).
pub fn array<T: Clone + Default + 'static, E: Clone + 'static>(
    items: Vec<Resolution<T, E>>,
) -> Rc<dyn SyncIterator<T, E>> {
    Rc::new(ArrayIterator {
        items,
        at: Cell::new(0),
    })
}

impl<T: Clone + Default + 'static, E: Clone + 'static> SyncIterator<T, E> for ArrayIterator<T, E> {
    fn next(&self, _value: T) -> Result<SyncStep<T, E>, E> {
        let at = self.at.get();
        match self.items.get(at) {
            Some(item) => {
                self.at.set(at + 1);
                Ok(SyncStep {
                    value: copy(item),
                    done: false,
                })
            }
            None => {
                // Exhausted for ever (its index is set past any length).
                self.at.set(usize::MAX);
                Ok(SyncStep {
                    value: Resolution::Value(T::default()),
                    done: true,
                })
            }
        }
    }

    fn return_(&self, _value: T) -> Option<Result<SyncStep<T, E>, E>> {
        None
    }

    fn throw_(&self, _reason: E) -> Option<Result<SyncStep<T, E>, E>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::testing::test_loop;
    use crate::js::{Promise, async_fn, live_tasks};
    use crate::value::W;

    fn n(value: f64) -> Resolution<W, W> {
        Resolution::Value(W::Number(value))
    }

    /// `async function* count(k) { for (let i = 0; i < k; i++) yield i; }`
    fn count(k: usize) -> AsyncGen<W, W> {
        async_gen(move |co: Co<W, W>| async move {
            for i in 0..k {
                co.yield_(n(i as f64)).await?;
            }
            Ok(())
        })
    }

    /// `async function* nest(d) { if (d === 0) yield 1; else yield* nest(d - 1); }`
    fn nest(depth: usize) -> AsyncGen<W, W> {
        async_gen(move |co: Co<W, W>| async move {
            if depth == 0 {
                co.yield_(n(1.0)).await?;
            } else {
                co.delegate(nest(depth - 1)).await?;
            }
            Ok(())
        })
    }

    /// `nest`, each level awaiting once before its `yield*`: the levels
    /// start in jobs of their own, so no stack grows with the depth.
    fn lazy_nest(depth: usize) -> AsyncGen<W, W> {
        async_gen(move |co: Co<W, W>| async move {
            js::value::<W, W>(W::Undefined).await?;
            if depth == 0 {
                co.yield_(n(1.0)).await?;
            } else {
                co.delegate(lazy_nest(depth - 1)).await?;
            }
            Ok(())
        })
    }

    fn settled<T: Clone + 'static>(promise: &Promise<T, W>) -> Rc<RefCell<Option<Result<T, W>>>> {
        let seen = Rc::new(RefCell::new(None));
        let (ok, err) = (seen.clone(), seen.clone());
        promise.react(move |outcome| match outcome {
            Ok(value) => *ok.borrow_mut() = Some(Ok(value)),
            Err(reason) => *err.borrow_mut() = Some(Err(reason)),
        });
        seen
    }

    fn on_loop_thread(test: impl FnOnce() + Send + 'static) {
        std::thread::Builder::new()
            .stack_size(crate::process::LOOP_STACK)
            .spawn(move || {
                js::set_stack_budget(crate::process::LOOP_STACK_BUDGET);
                test();
            })
            .expect("a thread")
            .join()
            .expect("the test passed");
    }

    /// 2,000 generators deep in `yield*` answer the first `next()`.
    #[test]
    fn a_yield_star_chain_two_thousand_deep_yields_on_the_loop_thread() {
        on_loop_thread(|| {
            let (event_loop, _) = test_loop();
            let seen = settled(&nest(2_000).next(W::Undefined));
            event_loop.checkpoint();
            assert!(
                matches!(&*seen.borrow(), Some(Ok(step)) if !step.done && matches!(step.value, W::Number(v) if v == 1.0))
            );
        });
    }

    /// Past the stack budget a request is rejected with a `RangeError`
    /// that every level rethrows, and the loop goes on.
    #[test]
    fn a_yield_star_chain_past_the_stack_budget_rejects_with_a_range_error() {
        on_loop_thread(|| {
            js::set_stack_budget(256 << 10);
            let (event_loop, _) = test_loop();
            let seen = settled(&nest(1_000_000).next(W::Undefined));
            event_loop.checkpoint();
            let failure = seen.borrow_mut().take();
            let Some(Err(W::Error(error))) = failure else {
                panic!("no RangeError");
            };
            assert_eq!(error.name.to_string_lossy(), "RangeError");
            let after = settled(&count(1).next(W::Undefined));
            event_loop.checkpoint();
            assert!(matches!(&*after.borrow(), Some(Ok(step)) if !step.done));
        });
    }

    /// A generator suspended at a `yield` and dropped is freed, its
    /// `finally` never runs (as JavaScript collects it); so is a chain of
    /// 100,000 suspended in `yield*`, without recursion.
    #[test]
    fn a_suspended_generator_dropped_is_freed_without_running_its_finally() {
        let (event_loop, _) = test_loop();
        let before = live_tasks();
        let finally_ran = Rc::new(Cell::new(false));
        let ran = finally_ran.clone();
        let generator = async_gen(move |co: Co<W, W>| async move {
            let body = co.yield_(n(1.0)).await;
            ran.set(true);
            body?;
            Ok(())
        });
        let _first = generator.next(W::Undefined);
        event_loop.checkpoint();
        assert_eq!(live_tasks(), before + 1);
        drop(generator);
        assert_eq!(live_tasks(), before);
        assert!(!finally_ran.get());
        let deep = lazy_nest(100_000);
        let _first = deep.next(W::Undefined);
        event_loop.checkpoint();
        assert_eq!(live_tasks(), before + 100_001);
        drop(deep);
        assert_eq!(live_tasks(), before);
    }

    /// Electron's frame rule on the ledger's values: after `yield v` with a
    /// request queued in a frame, a primitive, a bigint or a plain object
    /// leaves the body in the empty frame; an object with an own `then`, a
    /// `Buffer`, an array, a function, a stream, an `Error`, a `Date`, a
    /// `Map` keep the caller's (the measured table is in the
    /// documentation's "Iteration").
    #[test]
    fn electron_s_frame_rule_by_ledger_value() {
        use crate::value::{Func, JsError};
        static FRAME: js::Store<W> = js::Store::new();
        let (event_loop, _) = test_loop();
        let function = W::Function(Rc::new(Func {
            source: "() => {}",
            call: Box::new(|_, _| Ok(Resolution::Value(W::Undefined))),
        }));
        let kinds: Vec<(&str, W, bool)> = vec![
            ("undefined", W::Undefined, true),
            ("null", W::Null, true),
            ("a boolean", W::Bool(true), true),
            ("a number", W::Number(1.0), true),
            ("a string", W::string("file"), true),
            ("a bigint", W::Unsupported("bigint"), true),
            (
                "a plain object",
                W::object(vec![("key", W::string("k"))]),
                true,
            ),
            (
                "an object with an own then",
                W::object(vec![("then", W::Undefined)]),
                false,
            ),
            ("a Buffer", W::Bytes(Rc::new(vec![1, 2])), false),
            ("an array", W::Array(vec![W::string("page")]), false),
            ("a function", function, false),
            ("a stream", W::Stream(Rc::new(count(1))), false),
            (
                "an Error",
                W::Error(Rc::new(JsError::new("Error", "e"))),
                false,
            ),
            ("a Date", W::Unsupported("date"), false),
            ("a Map", W::Unsupported("map"), false),
        ];
        for (kind, value, loses) in kinds {
            let seen = Rc::new(RefCell::new(None));
            let into = seen.clone();
            let generator = async_gen(move |co: Co<W, W>| async move {
                co.yield_(Resolution::Value(value)).await?;
                *into.borrow_mut() = Some(FRAME.get());
                Ok(())
            });
            FRAME.run(W::string("C"), || {
                let _first = generator.next(W::Undefined);
                let _second = generator.next(W::Undefined);
            });
            event_loop.checkpoint();
            let frame = seen.borrow_mut().take().expect("the body ran on");
            assert_eq!(frame.is_none(), loses, "{kind}: the frame after the yield");
        }
    }

    /// A generator abandoned while it executes (its body awaits a promise
    /// everyone then drops, with requests queued behind it) is freed with
    /// that await, as JavaScript collects it: its body's task is held by
    /// the await's reaction, not by the generator.
    #[test]
    fn a_generator_abandoned_while_it_executes_is_freed() {
        let (event_loop, _) = test_loop();
        let before = live_tasks();
        let (never, settle) = Promise::<W, W>::with_resolvers();
        let held = Rc::new(RefCell::new(Some(never)));
        let taken = held.clone();
        let generator = async_gen(move |co: Co<W, W>| async move {
            let never = taken.borrow_mut().take().expect("the promise");
            never.await?;
            co.yield_(n(1.0)).await?;
            Ok(())
        });
        let calls: Vec<_> = (0..5).map(|_| generator.next(W::Undefined)).collect();
        let returned = generator.return_(n(2.0));
        event_loop.checkpoint();
        assert_eq!(live_tasks(), before + 1);
        drop((generator, calls, returned, settle, held));
        event_loop.checkpoint();
        assert_eq!(live_tasks(), before);
    }

    /// A generator whose body holds its own handle (a loop body pulling its
    /// own iterator) is a cycle of its own: JavaScript collects it, `Rc`
    /// cannot. It is the porting rule's fourth mistake, which the job
    /// differential's census counts; this pins that it stays one task.
    #[test]
    fn a_generator_holding_its_own_handle_is_a_counted_cycle() {
        let (event_loop, _) = test_loop();
        let before = live_tasks();
        let slot: Rc<RefCell<Option<AsyncGen<W, W>>>> = Rc::new(RefCell::new(None));
        let inner = slot.clone();
        let generator = async_gen(move |co: Co<W, W>| async move {
            let me = inner.borrow().clone();
            co.yield_(n(1.0)).await?;
            drop(me);
            Ok(())
        });
        *slot.borrow_mut() = Some(generator.clone());
        let _first = generator.next(W::Undefined);
        event_loop.checkpoint();
        slot.borrow_mut().take();
        drop(generator);
        event_loop.checkpoint();
        assert_eq!(live_tasks(), before + 1);
    }

    /// A `for await` whose task is abandoned (it awaits a promise no one
    /// will settle, inside the generator it iterates) is dropped without
    /// the close guard firing; its iterator is not closed.
    #[test]
    fn a_generator_abandoned_mid_for_await_drops_without_closing() {
        let (event_loop, _) = test_loop();
        let before = live_tasks();
        // The promise is held by its resolvers only (the await takes it out
        // of the task), so dropping them abandons the task, as
        // JavaScript's collector would free it.
        let (never, settle) = Promise::<W, W>::with_resolvers();
        let held = Rc::new(RefCell::new(Some(never)));
        let taken = held.clone();
        let closed = Rc::new(Cell::new(false));
        let saw_close = closed.clone();
        let source = async_gen(move |co: Co<W, W>| async move {
            let body = async {
                co.yield_(n(1.0)).await?;
                co.yield_(n(2.0)).await?;
                Ok(())
            }
            .await;
            saw_close.set(true);
            body
        });
        let looping = async_fn::<W, W>(async move {
            let rows = for_await(source);
            while let Some(_row) = rows.next().await? {
                let never = taken.borrow_mut().take().expect("the promise");
                never.await?;
            }
            Ok(Resolution::Value(W::Undefined))
        });
        event_loop.checkpoint();
        assert!(!looping.is_settled());
        drop((looping, settle, held));
        assert_eq!(live_tasks(), before);
        assert!(!closed.get(), "an abandoned loop never closes its iterator");
    }

    /// The close guard: a body that leaves an open loop with `?` panics in
    /// its own task.
    #[test]
    #[should_panic(expected = "a for await was left without closing its iterator")]
    fn a_for_await_left_by_its_own_body_without_closing_panics() {
        let (event_loop, _) = test_loop();
        let _call = async_fn::<W, W>(async move {
            let rows = for_await(count(3));
            while let Some(_row) = rows.next().await? {
                Promise::<W, W>::reject(W::Null).await?;
            }
            Ok(Resolution::Value(W::Undefined))
        });
        event_loop.checkpoint();
    }
}
