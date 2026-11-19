//! Test-only (`test-hooks`): the process's event loop (`host::EventLoop`,
//! every rule of it) on a clock that only moves when a test moves it, for
//! comparing the execution context, the stall clock, the I/O pool and the
//! protocol with the JavaScript run on Node's own timer code under the same
//! clock (`scripts/ledger-native/ctx-js-arm.mjs`).
//!
//! `advance_to` runs loop iterations with no inbound unit (check, then the
//! timers due), moving the clock to each next expiry until `until`;
//! `deliver` is one inbound unit at the current time.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use crate::host::{self, Clock, EventLoop};

struct VirtualClock(Rc<Cell<i64>>);

impl Clock for VirtualClock {
    fn loop_ms(&self) -> i64 {
        self.0.get()
    }

    fn epoch_ms(&self) -> f64 {
        self.0.get() as f64
    }
}

/// The virtual loop: its clock reads `now` for both `Date.now()` and the
/// loop time.
pub struct VirtualHost {
    now: Rc<Cell<i64>>,
    env: Rc<RefCell<HashMap<String, String>>>,
    event_loop: Rc<EventLoop>,
}

impl VirtualHost {
    /// A virtual loop at `epoch`, installed on this thread.
    pub fn new(epoch: i64) -> Rc<VirtualHost> {
        let now = Rc::new(Cell::new(epoch));
        let env: Rc<RefCell<HashMap<String, String>>> = Rc::new(RefCell::new(HashMap::new()));
        let read = env.clone();
        let event_loop = EventLoop::new(
            Box::new(VirtualClock(now.clone())),
            Box::new(move |name| read.borrow().get(name).cloned()),
            Box::new(|| {}),
        );
        host::install(event_loop.clone());
        Rc::new(VirtualHost {
            now,
            env,
            event_loop,
        })
    }

    pub fn set_env(&self, name: &str, value: Option<&str>) {
        match value {
            Some(value) => self
                .env
                .borrow_mut()
                .insert(name.to_string(), value.to_string()),
            None => self.env.borrow_mut().remove(name),
        };
    }

    /// The checkpoint (ticks, microtasks, rejections).
    pub fn run_until_idle(&self) {
        self.event_loop.checkpoint();
    }

    /// One inbound unit now: `unit`, then the checkpoint.
    pub fn deliver(&self, unit: impl FnOnce()) {
        unit();
        self.event_loop.checkpoint();
    }

    /// The loop itself (for driving its phases one by one).
    pub fn event_loop(&self) -> &Rc<EventLoop> {
        &self.event_loop
    }

    /// Moves the clock to `until`, running every iteration due by then.
    pub fn advance_to(&self, until: i64) {
        self.event_loop.checkpoint();
        loop {
            self.event_loop.idle_iteration();
            if self.event_loop.has_immediates() {
                continue;
            }
            match self.event_loop.next_expiry() {
                Some(expiry) if expiry <= until => self.now.set(expiry.max(self.now.get())),
                _ => break,
            }
        }
        self.now.set(until.max(self.now.get()));
    }

    /// Moves the clock forward to `time` (never back), running nothing.
    pub fn move_to(&self, time: i64) {
        self.now.set(time.max(self.now.get()));
    }

    /// The expiry of the first timer list.
    pub fn next_expiry(&self) -> Option<i64> {
        self.event_loop.next_expiry()
    }

    pub fn now_ms(&self) -> i64 {
        self.now.get()
    }
}
