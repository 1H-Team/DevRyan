//! The per-root I/O pool of `execution-io-pool.js`: one FIFO per root
//! across every caller, eight operations at a time unless
//! `DEVRYAN_EXECUTION_IO_CAP` (an integer 1 to 64, read per use) says
//! otherwise. Waiting counts as waiting on the caller's meter and can be
//! cancelled without leaving a queued row; a pool with nothing active or
//! queued is forgotten.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use crate::ctx::{Ctx, execution_signal, with_execution_slot_wait};
use crate::host;
use crate::js::{Promise, Resolution, Resolvers, async_fn};
use crate::signal::{ListenerId, Signal};
use crate::value::{Key, W, is_safe_integer, to_number};
use crate::{Ret, WPromise};

const DEFAULT_CAP: f64 = 8.0;

/// `executionIOCap()`.
pub fn execution_io_cap() -> f64 {
    let value =
        host::env("DEVRYAN_EXECUTION_IO_CAP").map_or(f64::NAN, |text| to_number(&W::string(&text)));
    if is_safe_integer(&W::Number(value)) && (1.0..=64.0).contains(&value) {
        value
    } else {
        DEFAULT_CAP
    }
}

/// A queued caller: `{ run }`, with the resolving functions of its wait
/// and its abort listener.
struct Row {
    resolvers: Resolvers<W, W>,
    signal: Option<Signal>,
    listener: Cell<Option<ListenerId>>,
}

impl Row {
    /// `row.run()`: `signal?.removeEventListener('abort', abort);
    /// pool.active++; resolve();`.
    fn run(&self, pool: &RefCell<Pool>) {
        if let (Some(signal), Some(id)) = (&self.signal, self.listener.take()) {
            signal.remove_listener(id);
        }
        pool.borrow_mut().active += 1.0;
        self.resolvers.fulfill(W::Undefined);
    }
}

#[derive(Default)]
struct Pool {
    active: f64,
    pending: VecDeque<Rc<Row>>,
}

thread_local! {
    static POOLS: RefCell<HashMap<Key, Rc<RefCell<Pool>>>> = RefCell::new(HashMap::new());
    static FRESH: Cell<u64> = const { Cell::new(0) };
}

pub(crate) fn reset() {
    POOLS.with(|pools| pools.borrow_mut().clear());
}

/// How many pools exist (an idle pool is forgotten).
pub fn pool_count() -> usize {
    POOLS.with(|pools| pools.borrow().len())
}

/// `withExecutionIO(root, action)`: an async function.
pub fn with_execution_io(ctx: &Ctx, root: &W, action: impl FnOnce() -> Ret + 'static) -> WPromise {
    let (ctx, root) = (ctx.clone(), root.clone());
    async_fn(async move {
        // An object root is a key of its own, as in a `Map`.
        let key = Key::of(&root).unwrap_or_else(|| {
            let fresh = FRESH.with(|fresh| {
                fresh.set(fresh.get() + 1);
                fresh.get()
            });
            Key::Object(fresh)
        });
        let pool = POOLS.with(|pools| pools.borrow_mut().entry(key.clone()).or_default().clone());
        let signal = execution_signal(&ctx);
        if let Some(signal) = &signal {
            signal.throw_if_aborted()?;
        }
        let waiting = {
            let (pool, signal) = (pool.clone(), signal.clone());
            move || {
                Ok(Resolution::Promise(Promise::executor(|resolvers| {
                    let row = Rc::new(Row {
                        resolvers,
                        signal: signal.clone(),
                        listener: Cell::new(None),
                    });
                    if pool.borrow().active < execution_io_cap() {
                        row.run(&pool);
                    } else {
                        pool.borrow_mut().pending.push_back(row.clone());
                        if let Some(signal) = &signal {
                            let (queue, queued) = (Rc::downgrade(&pool), Rc::downgrade(&row));
                            let id = signal.add_listener(move |reason| {
                                let (Some(queue), Some(queued)) =
                                    (queue.upgrade(), queued.upgrade())
                                else {
                                    return;
                                };
                                queue
                                    .borrow_mut()
                                    .pending
                                    .retain(|other| !Rc::ptr_eq(other, &queued));
                                queued.resolvers.reject(reason.clone());
                            });
                            row.listener.set(Some(id));
                        }
                    }
                    Ok(())
                })))
            }
        };
        with_execution_slot_wait(&ctx, waiting).await?;
        // try { signal?.throwIfAborted(); return await action(); } finally { … }
        let result = match signal.as_ref().map(Signal::throw_if_aborted) {
            Some(Err(reason)) => Err(reason),
            _ => match action() {
                Ok(resolution) => Promise::resolve(resolution).await,
                Err(reason) => Err(reason),
            },
        };
        pool.borrow_mut().active -= 1.0;
        let next = pool.borrow_mut().pending.pop_front();
        if let Some(next) = next {
            next.run(&pool);
        }
        let idle = {
            let state = pool.borrow();
            state.active == 0.0 && state.pending.is_empty()
        };
        if idle {
            POOLS.with(|pools| pools.borrow_mut().remove(&key));
        }
        result.map(Resolution::Value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ctx::Store;
    use crate::host::testing::test_loop_with;
    use crate::signal::Controller;
    use std::cell::RefCell;

    fn with_signal(controller: &Controller) -> Ctx {
        Some(Rc::new(Store {
            signal: Some(controller.signal()),
            ..Store::default()
        }))
    }

    fn outcome(promise: &WPromise) -> Rc<RefCell<Option<Result<W, W>>>> {
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

    /// I06 of the third review: a caller granted its slot, then aborted
    /// before its continuation runs, does not run its action
    /// (`signal?.throwIfAborted()` after the wait); I04: the pool is
    /// forgotten once idle.
    #[test]
    fn a_caller_aborted_between_its_grant_and_its_turn_does_not_run() {
        let (event_loop, _) =
            test_loop_with(|name| (name == "DEVRYAN_EXECUTION_IO_CAP").then(|| "1".into()));
        let root = W::string("/p");
        let (gate, open) = Promise::<W, W>::with_resolvers();
        let holder = with_execution_io(&None, &root, move || Ok(Resolution::Promise(gate)));
        let controller = Controller::new();
        let ran = Rc::new(Cell::new(false));
        let waiter = {
            let ran = ran.clone();
            with_execution_io(&with_signal(&controller), &root, move || {
                ran.set(true);
                Ok(Resolution::Value(W::string("ran")))
            })
        };
        let seen = outcome(&waiter);
        // The holder's own continuation runs one job after the release,
        // before the waiter's (two jobs after it is granted).
        let _ = holder.then_ok::<()>(move |_| {
            controller.abort(W::string("stop"));
            Ok(Resolution::Value(()))
        });
        open.fulfill(W::Undefined);
        event_loop.checkpoint();
        assert!(!ran.get(), "the aborted caller's action ran");
        assert!(matches!(&*seen.borrow(), Some(Err(W::String(text))) if text == "stop"));
        assert_eq!(pool_count(), 0, "the idle pool is forgotten");
    }
}
