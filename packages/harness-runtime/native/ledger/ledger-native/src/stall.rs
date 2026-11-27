//! The host stall clock (`host-stall-clock.js`): time during which this
//! process's event loop did not run, noticed by a 250 ms ticker that fires
//! at least 1 s late, kept 30 minutes (at most 512 stalls) and subtracted
//! from deadlines. `DEVRYAN_STALL_AWARE_DEADLINES=0`, read per use, makes
//! every deadline a wall-clock deadline again. One shared clock per process
//! starts on first use, as the JavaScript's does.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use crate::host;
use crate::value::{js_max, js_min};

pub const TICK_MS: f64 = 250.0;
pub const STALL_MS: f64 = 1_000.0;
const RETAIN_MS: f64 = 30.0 * 60_000.0;
const MAX_STALLS: usize = 512;

/// One stall: `{ from, to, ms }`, `ms` being how late the tick was.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stall {
    pub from: f64,
    pub to: f64,
    pub ms: f64,
}

pub type OnStall = Rc<dyn Fn(Stall)>;

/// `createHostStallClock({ now, tickMs, stallMs, onStall })`.
pub struct StallClock {
    now: Rc<dyn Fn() -> f64>,
    tick_ms: f64,
    stall_ms: f64,
    on_stall: Option<OnStall>,
    stalls: RefCell<VecDeque<(f64, f64)>>,
    last: Cell<f64>,
    /// `timer`: the ticker while started.
    timer: RefCell<Option<host::Timeout>>,
    count: Cell<f64>,
    total: Cell<f64>,
    longest: Cell<f64>,
}

impl StallClock {
    pub fn new(
        now: Rc<dyn Fn() -> f64>,
        tick_ms: f64,
        stall_ms: f64,
        on_stall: Option<OnStall>,
    ) -> Rc<StallClock> {
        let last = now();
        Rc::new(StallClock {
            now,
            tick_ms,
            stall_ms,
            on_stall,
            stalls: RefCell::new(VecDeque::new()),
            last: Cell::new(last),
            timer: RefCell::new(None),
            count: Cell::new(0.0),
            total: Cell::new(0.0),
            longest: Cell::new(0.0),
        })
    }

    /// The clock on the installed loop's time.
    pub fn on_host(tick_ms: f64, stall_ms: f64, on_stall: Option<OnStall>) -> Rc<StallClock> {
        StallClock::new(Rc::new(host::now), tick_ms, stall_ms, on_stall)
    }

    pub fn tick(&self) {
        let at = (self.now)();
        let last = self.last.get();
        let late = at - last - self.tick_ms;
        if late >= self.stall_ms {
            let stall = Stall {
                from: last + self.tick_ms,
                to: at,
                ms: late,
            };
            {
                let mut stalls = self.stalls.borrow_mut();
                stalls.push_back((stall.from, stall.to));
                self.count.set(self.count.get() + 1.0);
                self.total.set(self.total.get() + late);
                self.longest.set(js_max(self.longest.get(), late));
                while stalls.len() > MAX_STALLS
                    || stalls.front().is_some_and(|first| at - first.1 > RETAIN_MS)
                {
                    stalls.pop_front();
                }
            }
            if let Some(on_stall) = &self.on_stall {
                on_stall(stall);
            }
        }
        self.last.set(at);
    }

    fn enabled() -> bool {
        host::env("DEVRYAN_STALL_AWARE_DEADLINES").as_deref() != Some("0")
    }

    /// Stalled time inside [from, to], a stall still in progress included.
    pub fn stalled_ms_between(&self, from: f64, to: Option<f64>) -> f64 {
        let to = to.unwrap_or_else(|| (self.now)());
        // `!(to > from)`: NaN bounds count nothing.
        if !StallClock::enabled() || to.partial_cmp(&from) != Some(std::cmp::Ordering::Greater) {
            return 0.0;
        }
        let mut ms = 0.0;
        for (stall_from, stall_to) in self.stalls.borrow().iter() {
            ms += js_max(0.0, js_min(to, *stall_to) - js_max(from, *stall_from));
        }
        let at = (self.now)();
        let last = self.last.get();
        if at - last - self.tick_ms >= self.stall_ms {
            ms += js_max(0.0, js_min(to, at) - js_max(from, last + self.tick_ms));
        }
        js_min(ms, to - from)
    }

    /// Time since `since` during which the host could run.
    pub fn active_ms_since(&self, since: f64, at: Option<f64>) -> f64 {
        let at = at.unwrap_or_else(|| (self.now)());
        js_max(0.0, at - since - self.stalled_ms_between(since, Some(at)))
    }

    /// True once `limit_ms` of runnable time passed since `since`, or `cap_ms` of wall time.
    pub fn expired(&self, since: f64, limit_ms: f64, cap_ms: f64, at: Option<f64>) -> bool {
        let at = at.unwrap_or_else(|| (self.now)());
        at - since >= cap_ms || self.active_ms_since(since, Some(at)) >= limit_ms
    }

    /// `{ stalls, stalledMs, longestStallMs }`.
    pub fn snapshot(&self) -> (f64, f64, f64) {
        (self.count.get(), self.total.get(), self.longest.get())
    }

    /// `start()`: `setInterval(tick, tickMs).unref()` on the installed loop.
    pub fn start(self: &Rc<StallClock>) {
        if self.timer.borrow().is_some() {
            return;
        }
        self.last.set((self.now)());
        // The interval holds the clock, as its JavaScript closure does.
        let clock = self.clone();
        let timer = host::set_interval(self.tick_ms, move || clock.tick());
        timer.unref();
        *self.timer.borrow_mut() = Some(timer);
    }

    /// `stop()`: `clearInterval(timer)`.
    pub fn stop(&self) {
        if let Some(timer) = self.timer.borrow_mut().take() {
            host::clear_timeout(&timer);
        }
    }
}

thread_local! {
    static SHARED: RefCell<Option<Rc<StallClock>>> = const { RefCell::new(None) };
    /// `listeners`, a `Set`: insertion order, one entry per listener, a
    /// removed entry left empty while a notification walks the list.
    static LISTENERS: RefCell<Vec<Option<OnStall>>> = const { RefCell::new(Vec::new()) };
    static NOTIFYING: Cell<usize> = const { Cell::new(0) };
}

pub(crate) fn reset_shared() {
    // The old clock's ticker belonged to the loop being replaced.
    SHARED.with(|slot| slot.borrow_mut().take());
    LISTENERS.with(|listeners| listeners.borrow_mut().clear());
}

/// `hostStallClock()`: the process's clock, started on first use.
pub fn host_stall_clock() -> Rc<StallClock> {
    if let Some(clock) = SHARED.with(|slot| slot.borrow().clone()) {
        return clock;
    }
    // `for (const listener of listeners)`: a listener added meanwhile is
    // reached, one removed before its turn is not.
    let notify: OnStall = Rc::new(|stall| {
        NOTIFYING.with(|depth| depth.set(depth.get() + 1));
        let mut index = 0;
        while let Some(entry) = LISTENERS.with(|listeners| listeners.borrow().get(index).cloned()) {
            if let Some(listener) = entry {
                listener(stall);
            }
            index += 1;
        }
        if NOTIFYING.with(|depth| depth.replace(depth.get() - 1)) == 1 {
            LISTENERS.with(|listeners| listeners.borrow_mut().retain(Option::is_some));
        }
    });
    let clock = StallClock::on_host(TICK_MS, STALL_MS, Some(notify));
    SHARED.with(|slot| *slot.borrow_mut() = Some(clock.clone()));
    clock.start();
    clock
}

/// `onHostStall(listener)`: adds it once (a `Set`); returns the function
/// that stops observing (`listeners.delete(listener)`).
pub fn on_host_stall(listener: OnStall) -> impl Fn() {
    host_stall_clock();
    LISTENERS.with(|listeners| {
        let mut listeners = listeners.borrow_mut();
        if !listeners
            .iter()
            .flatten()
            .any(|known| Rc::ptr_eq(known, &listener))
        {
            listeners.push(Some(listener.clone()));
        }
    });
    move || {
        LISTENERS.with(|listeners| {
            let mut listeners = listeners.borrow_mut();
            if let Some(entry) = listeners.iter_mut().find(|entry| {
                entry
                    .as_ref()
                    .is_some_and(|known| Rc::ptr_eq(known, &listener))
            }) {
                *entry = None;
            }
            if NOTIFYING.with(Cell::get) == 0 {
                listeners.retain(Option::is_some);
            }
        });
    }
}

/// `hostDeadlineExpired(since, limitMs, capMs)`.
pub fn host_deadline_expired(since: f64, limit_ms: f64, cap_ms: f64) -> bool {
    host_stall_clock().expired(since, limit_ms, cap_ms, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::testing::test_loop;

    /// S06 of the third review: `start` measures from its own call, not
    /// from the clock's creation (`last = now()` in `start`).
    #[test]
    fn start_measures_from_itself_not_from_creation() {
        let (_event_loop, time) = test_loop();
        let clock = StallClock::on_host(TICK_MS, STALL_MS, None);
        time.set(time.get() + 5_000);
        clock.start();
        time.set(time.get() + 250);
        clock.tick();
        assert_eq!(clock.snapshot(), (0.0, 0.0, 0.0));
        clock.stop();
    }

    /// S5 of the third review: the listeners are a `Set`: one added twice
    /// is one, one added during a notification is reached, removal works.
    #[test]
    fn stall_listeners_are_a_set() {
        let (_event_loop, time) = test_loop();
        let seen = Rc::new(RefCell::new(Vec::new()));
        let late: OnStall = {
            let seen = seen.clone();
            Rc::new(move |_| seen.borrow_mut().push("late"))
        };
        let first: OnStall = {
            let (seen, late, added) = (seen.clone(), late.clone(), Cell::new(false));
            Rc::new(move |_| {
                seen.borrow_mut().push("first");
                if !added.replace(true) {
                    let _ = on_host_stall(late.clone());
                }
            })
        };
        let _ = on_host_stall(first.clone());
        let _ = on_host_stall(first.clone());
        time.set(time.get() + 250 + 1_000);
        host_stall_clock().tick();
        assert_eq!(*seen.borrow(), ["first", "late"]);
        let stop = on_host_stall(late);
        stop();
        time.set(time.get() + 250 + 1_000);
        host_stall_clock().tick();
        assert_eq!(*seen.borrow(), ["first", "late", "first"]);
    }
}
