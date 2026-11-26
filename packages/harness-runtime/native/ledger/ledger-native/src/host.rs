//! The event loop the ledger runs on: Node's, as the worker thread it
//! replaces runs it. One loop per thread, installed with `install`. The
//! process drives it with the real clock (`process`); the test-only virtual
//! loop (`virtual_host`) drives the same loop with a clock that only moves
//! when a test moves it. Both share every rule below; only the clock and
//! where units come from differ. JavaScript's jobs (promises, microtasks,
//! ticks, async functions) are `js`; this module is the loop around them.
//!
//! The model (the contract in `packages/harness-runtime/DOCUMENTATION.md`,
//! "Native ledger process", "Event loop"):
//!
//! - A **unit of work** is one inbound message, one timer callback, one
//!   immediate, or one completion of blocking work. After each unit comes
//!   Node's checkpoint (`js::checkpoint`: ticks, microtasks, unhandled
//!   rejections). Only then does the next unit start.
//! - An iteration (`iterate`) is libuv's: poll (inbound units, up to the
//!   larger of those queued and 1,000, as a `MessagePort` delivers them),
//!   check (`processImmediate`: the immediates queued before the phase),
//!   timers (`processTimers`).
//! - Timers are Node's `lib/internal/timers.js` and `lib/timers.js`, ported
//!   by object identity: a `Timeout` with its synchronous callback, lists
//!   of one duration, the priority queue by (expiry, list id), `insert`,
//!   `unenroll`, `listOnTimeout` (it peeks a timer before the checkpoint
//!   between two timers and skips it after if that checkpoint cleared it)
//!   and the interval re-armed from the time read before its callback.
//!
//! Other threads reach the loop only by posting a unit to its `Inbox`;
//! nothing they hold can run or resume JavaScript work.
#![forbid(unsafe_code)]

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex};

use crate::js::{self, Frame, Jobs, Promise, Resolvers};

/// The loop's two clocks.
pub trait Clock {
    /// libuv's loop time after `uv_update_time`: whole milliseconds of a
    /// monotonic clock, read anew on each call.
    fn loop_ms(&self) -> i64;
    /// `Date.now()`: whole milliseconds since the Unix epoch.
    fn epoch_ms(&self) -> f64;
}

/// The process's clocks: `Instant` since the loop started, and the system
/// time.
pub struct RealClock {
    start: std::time::Instant,
}

impl RealClock {
    pub fn new() -> RealClock {
        RealClock {
            start: std::time::Instant::now(),
        }
    }
}

impl Default for RealClock {
    fn default() -> Self {
        RealClock::new()
    }
}

impl Clock for RealClock {
    fn loop_ms(&self) -> i64 {
        i64::try_from(self.start.elapsed().as_millis()).unwrap_or(i64::MAX)
    }

    fn epoch_ms(&self) -> f64 {
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        since.as_millis() as f64
    }
}

/// What reaches the loop from other threads.
pub enum Unit {
    /// A line from the host, or the end of its stream.
    Input(Input),
    /// Blocking work finished: its id and result.
    Done(u64, Box<dyn Any + Send>),
    /// One delivery of a long-lived source (a child's output reader, its
    /// exit waiter): the source's id and what it read.
    Source(u64, Box<dyn Any + Send>),
}

/// Where the thread of a long-lived source posts its units ([`open_source`]).
/// It holds nothing of the loop but its inbox.
#[derive(Clone)]
pub struct Poster {
    inbox: Arc<Inbox>,
    id: u64,
}

impl Poster {
    /// Posts one delivery; it runs as a unit of its own on the loop.
    pub fn post<T: Send + 'static>(&self, value: T) {
        self.inbox.post(Unit::Source(self.id, Box::new(value)));
    }

    /// The source's id ([`close_source`]).
    pub fn id(&self) -> u64 {
        self.id
    }
}

/// What the stdin reader hands the loop.
pub enum Input {
    Line(Vec<u8>),
    Eof,
    Corrupt(String),
}

/// The queue of units other threads post to the loop: the only thing of the
/// loop another thread holds.
#[derive(Default)]
pub struct Inbox {
    units: Mutex<VecDeque<Unit>>,
    posted: Condvar,
}

impl Inbox {
    pub fn new() -> Arc<Inbox> {
        Arc::new(Inbox::default())
    }

    pub fn post(&self, unit: Unit) {
        self.units.lock().expect("inbox").push_back(unit);
        self.posted.notify_one();
    }

    /// Waits up to `timeout_ms` (forever when `None`) for a unit; returns
    /// how many are queued.
    fn wait(&self, timeout_ms: Option<i64>) -> usize {
        let mut units = self.units.lock().expect("inbox");
        match timeout_ms {
            Some(ms) if ms <= 0 => {}
            Some(ms) => {
                let deadline = std::time::Instant::now()
                    + std::time::Duration::from_millis(u64::try_from(ms).unwrap_or(0));
                while units.is_empty() {
                    let left = deadline.saturating_duration_since(std::time::Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    units = self.posted.wait_timeout(units, left).expect("inbox").0;
                }
            }
            None => {
                while units.is_empty() {
                    units = self.posted.wait(units).expect("inbox");
                }
            }
        }
        units.len()
    }

    fn pop(&self) -> Option<Unit> {
        self.units.lock().expect("inbox").pop_front()
    }
}

/// The most units one poll phase handles when fewer are queued (Node's
/// `MessagePort::OnMessage` limit for messages; Node's pool completions
/// come through a handle of their own in the same phase).
const POLL_UNITS: usize = 1_000;

/// Node's `TIMEOUT_MAX`.
const TIMEOUT_MAX: f64 = 2_147_483_647.0;

/// A `Timeout` of Node's (`lib/internal/timers.js`).
struct TimerObj {
    /// `_idleTimeout`: the coerced delay, -1 once unenrolled.
    idle_timeout: Cell<f64>,
    /// `_idleStart`.
    idle_start: Cell<i64>,
    /// `_onTimeout`; `armed` is whether it is set (it is taken out while it
    /// runs).
    callback: RefCell<Option<Box<dyn FnMut()>>>,
    armed: Cell<bool>,
    /// `_repeat`.
    repeat: Option<f64>,
    /// `_destroyed`.
    destroyed: Cell<bool>,
    /// `kRefed`.
    refed: Cell<bool>,
    /// The list it is linked into (`_idleNext`/`_idlePrev` set), if any.
    list: RefCell<Option<Rc<TimerList>>>,
    frame: Frame,
}

/// A `TimersList`: the timers of one duration, in insertion order.
struct TimerList {
    msecs: i64,
    expiry: Cell<i64>,
    id: Cell<i64>,
    timers: RefCell<VecDeque<Rc<TimerObj>>>,
}

#[derive(Default)]
struct Timers {
    /// `timerListMap`.
    map: HashMap<i64, Rc<TimerList>>,
    /// `timerListQueue`, a priority queue by (expiry, id): a total order.
    queue: BTreeMap<(i64, i64), Rc<TimerList>>,
    /// `timerListId`.
    next_id: i64,
}

impl Timers {
    fn next_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// `insert(item, msecs, start)`.
    fn insert(&mut self, timer: &Rc<TimerObj>, msecs: f64, start: i64) {
        let msecs = msecs.trunc() as i64;
        timer.idle_start.set(start);
        let list = match self.map.get(&msecs) {
            Some(list) => list.clone(),
            None => {
                let list = Rc::new(TimerList {
                    msecs,
                    expiry: Cell::new(start + msecs),
                    id: Cell::new(self.next_id()),
                    timers: RefCell::new(VecDeque::new()),
                });
                self.map.insert(msecs, list.clone());
                self.queue
                    .insert((list.expiry.get(), list.id.get()), list.clone());
                list
            }
        };
        list.timers.borrow_mut().push_back(timer.clone());
        *timer.list.borrow_mut() = Some(list);
    }

    /// `L.remove(item)`: unlinks it from whatever list holds it.
    fn remove(timer: &Rc<TimerObj>) {
        let Some(list) = timer.list.borrow_mut().take() else {
            return;
        };
        let mut timers = list.timers.borrow_mut();
        if timers.front().is_some_and(|first| Rc::ptr_eq(first, timer)) {
            timers.pop_front();
        } else {
            timers.retain(|other| !Rc::ptr_eq(other, timer));
        }
    }

    /// `unenroll(item)` of `lib/timers.js`.
    fn unenroll(&mut self, timer: &Rc<TimerObj>) {
        if timer.destroyed.get() {
            return;
        }
        timer.destroyed.set(true);
        Timers::remove(timer);
        // Node deletes only refed lists: unrefed ones stay until visited.
        if timer.refed.get() {
            let msecs = timer.idle_timeout.get().trunc() as i64;
            if let Some(list) = self.map.get(&msecs).cloned()
                && list.timers.borrow().is_empty()
            {
                self.queue.remove(&(list.expiry.get(), list.id.get()));
                self.map.remove(&msecs);
            }
        }
        timer.idle_timeout.set(-1.0);
    }
}

/// An `Immediate` of Node's.
struct ImmediateObj {
    callback: RefCell<Option<Box<dyn FnOnce()>>>,
    destroyed: Cell<bool>,
    frame: Frame,
}

/// `process.env[name]` for a loop.
pub type EnvReader = Box<dyn Fn(&str) -> Option<String>>;

type Delivery = Box<dyn FnOnce(Box<dyn Any + Send>)>;

type SourceHandler = Rc<RefCell<Box<dyn FnMut(Box<dyn Any + Send>)>>>;

/// The loop of one thread.
pub struct EventLoop {
    clock: Box<dyn Clock>,
    env: EnvReader,
    jobs: Rc<Jobs>,
    timers: RefCell<Timers>,
    immediates: RefCell<Vec<Rc<ImmediateObj>>>,
    /// Called before each unit, timer, immediate and job: the process ends
    /// itself here once stdin has closed.
    halt: Rc<dyn Fn()>,
    inbox: Arc<Inbox>,
    blocking: RefCell<HashMap<u64, Delivery>>,
    next_blocking: Cell<u64>,
    pool: RefCell<Option<BlockingPool>>,
    /// The open long-lived sources: each delivery runs in the frame the
    /// source was opened in.
    sources: RefCell<HashMap<u64, (Frame, SourceHandler)>>,
}

impl EventLoop {
    pub fn new(clock: Box<dyn Clock>, env: EnvReader, halt: Box<dyn Fn()>) -> Rc<EventLoop> {
        let halt: Rc<dyn Fn()> = Rc::from(halt);
        Rc::new(EventLoop {
            clock,
            env,
            jobs: Jobs::new(halt.clone()),
            timers: RefCell::new(Timers::default()),
            immediates: RefCell::new(Vec::new()),
            halt,
            inbox: Inbox::new(),
            blocking: RefCell::new(HashMap::new()),
            next_blocking: Cell::new(0),
            pool: RefCell::new(None),
            sources: RefCell::new(HashMap::new()),
        })
    }

    /// Where other threads post units for this loop.
    pub fn inbox(&self) -> Arc<Inbox> {
        self.inbox.clone()
    }

    /// Node's checkpoint after a callback (`js::checkpoint`).
    pub fn checkpoint(&self) {
        self.jobs.checkpoint();
    }

    /// Whether no job or tick is queued.
    pub fn jobs_idle(&self) -> bool {
        self.jobs.idle()
    }

    /// Node's `processTimers(now)` with the checkpoint after it, as
    /// `Environment::RunTimers` closes its callback scope. Nothing runs
    /// when no list is due.
    pub fn timers_phase(&self) {
        let now = self.clock.loop_ms();
        let mut ran_list = false;
        loop {
            let first = self
                .timers
                .borrow()
                .queue
                .first_key_value()
                .map(|(_, list)| list.clone());
            let Some(list) = first else { break };
            if list.expiry.get() > now {
                break;
            }
            if ran_list {
                self.checkpoint();
            }
            ran_list = true;
            self.list_on_timeout(&list, now);
        }
        if ran_list {
            self.checkpoint();
        }
    }

    /// Node's `listOnTimeout(list, now)`, on the list object itself.
    fn list_on_timeout(&self, list: &Rc<TimerList>, now: i64) {
        let msecs = list.msecs;
        let mut ran_timer = false;
        loop {
            let peeked = list.timers.borrow().front().cloned();
            let Some(timer) = peeked else { break };
            let diff = now - timer.idle_start.get();
            if diff < msecs {
                // Too early for this one: the list (the queue's root) waits.
                let mut timers = self.timers.borrow_mut();
                timers.queue.remove(&(list.expiry.get(), list.id.get()));
                list.expiry
                    .set((timer.idle_start.get() + msecs).max(now + 1));
                let id = timers.next_id();
                list.id.set(id);
                timers.queue.insert((list.expiry.get(), id), list.clone());
                return;
            }
            if ran_timer {
                self.checkpoint();
            }
            ran_timer = true;
            // The timer peeked before the checkpoint: the checkpoint may have
            // cleared it, and then it is skipped (and was already removed).
            Timers::remove(&timer);
            if !timer.armed.get() {
                timer.destroyed.set(true);
                continue;
            }
            (self.halt)();
            let start = timer.repeat.map(|_| self.clock.loop_ms());
            let callback = timer.callback.borrow_mut().take();
            if let Some(mut callback) = callback {
                js::with_frame(timer.frame.clone(), &mut callback);
                if timer.armed.get() && timer.repeat.is_some() {
                    *timer.callback.borrow_mut() = Some(callback);
                }
            }
            match (timer.repeat, start) {
                (Some(repeat), Some(start)) if timer.idle_timeout.get() != -1.0 => {
                    timer.idle_timeout.set(repeat);
                    self.timers.borrow_mut().insert(&timer, repeat, start);
                }
                _ => {
                    if timer.list.borrow().is_none() {
                        timer.destroyed.set(true);
                        if timer.repeat.is_none() {
                            timer.armed.set(false);
                        }
                    }
                }
            }
        }
        // The list may have been deleted, and one of the same duration made,
        // meanwhile: only this very list is deleted.
        let mut timers = self.timers.borrow_mut();
        if timers
            .map
            .get(&msecs)
            .is_some_and(|current| Rc::ptr_eq(current, list))
        {
            timers.map.remove(&msecs);
            timers.queue.remove(&(list.expiry.get(), list.id.get()));
        }
    }

    /// Node's `processImmediate` with the checkpoint after it (only when an
    /// immediate is queued, as `CheckImmediate` returns early otherwise).
    pub fn check_phase(&self) {
        if !self.has_immediates() {
            return;
        }
        let queue = std::mem::take(&mut *self.immediates.borrow_mut());
        let mut ran = false;
        for immediate in queue {
            if immediate.destroyed.get() {
                continue;
            }
            if ran {
                self.checkpoint();
                if immediate.destroyed.get() {
                    continue;
                }
            }
            ran = true;
            immediate.destroyed.set(true);
            (self.halt)();
            let callback = immediate.callback.borrow_mut().take();
            if let Some(callback) = callback {
                js::with_frame(immediate.frame.clone(), callback);
            }
        }
        self.checkpoint();
    }

    /// Whether an immediate is queued.
    pub fn has_immediates(&self) -> bool {
        self.immediates
            .borrow()
            .iter()
            .any(|immediate| !immediate.destroyed.get())
    }

    /// The expiry of the first timer list, in loop time.
    pub fn next_expiry(&self) -> Option<i64> {
        self.timers
            .borrow()
            .queue
            .first_key_value()
            .map(|((expiry, _), _)| *expiry)
    }

    /// One unit from another thread: input goes to `input`, a completion
    /// settles what waits for it. Then the checkpoint.
    fn unit(&self, unit: Unit, input: &mut dyn FnMut(Input)) {
        (self.halt)();
        match unit {
            Unit::Input(line) => input(line),
            Unit::Done(id, result) => {
                let delivery = self.blocking.borrow_mut().remove(&id);
                if let Some(delivery) = delivery {
                    delivery(result);
                }
            }
            Unit::Source(id, value) => {
                // A source closed meanwhile drops what its thread still sent.
                let entry = self.sources.borrow().get(&id).cloned();
                if let Some((frame, handler)) = entry {
                    js::with_frame(frame, move || (handler.borrow_mut())(value));
                }
            }
        }
        self.checkpoint();
    }

    /// The poll phase: waits up to `timeout_ms` for units, then handles as
    /// many as a `MessagePort` would (those queued, at least 1,000), those
    /// that arrive meanwhile included.
    pub fn poll_phase(&self, timeout_ms: Option<i64>, input: &mut dyn FnMut(Input)) {
        let queued = self.inbox.wait(timeout_ms);
        let mut limit = queued.max(POLL_UNITS);
        while limit > 0 {
            let Some(unit) = self.inbox.pop() else { break };
            self.unit(unit, input);
            limit -= 1;
        }
    }

    /// How long the poll phase may wait: not at all with an immediate
    /// queued, else until the first timer list is due (forever with none).
    pub fn poll_timeout(&self) -> Option<i64> {
        if self.has_immediates() {
            return Some(0);
        }
        self.next_expiry()
            .map(|expiry| (expiry - self.clock.loop_ms()).max(0))
    }

    /// One iteration after the first timers phase: poll, check, timers
    /// (libuv's `uv_run` from its poll phase to the next iteration's
    /// timers).
    pub fn iterate(&self, input: &mut dyn FnMut(Input)) {
        let timeout = self.poll_timeout();
        self.poll_phase(timeout, input);
        self.check_phase();
        self.timers_phase();
    }

    /// The process's loop, on the real clock: libuv's `uv_run` in its
    /// default mode. Never returns; `input` or `halt` end the process.
    pub fn run(&self, input: &mut dyn FnMut(Input)) -> ! {
        self.timers_phase();
        loop {
            self.iterate(input);
        }
    }

    /// The virtual loop's iteration with no inbound unit: check, then
    /// timers due by now.
    pub fn idle_iteration(&self) {
        self.check_phase();
        self.timers_phase();
    }

    /// How many pieces of blocking work have not been delivered yet, and
    /// how many long-lived sources are open (a child process's readers, its
    /// exit waiter, a write in flight): what a test driver waits for before
    /// it moves a virtual clock.
    pub fn blocking_pending(&self) -> usize {
        self.blocking.borrow().len() + self.sources.borrow().len()
    }

    /// How many long-lived sources are open.
    pub fn sources_open(&self) -> usize {
        self.sources.borrow().len()
    }

    fn open_source<T: Send + 'static>(&self, mut deliver: impl FnMut(T) + 'static) -> Poster {
        let id = self.next_blocking.get() + 1;
        self.next_blocking.set(id);
        let handler: Box<dyn FnMut(Box<dyn Any + Send>)> = Box::new(move |value| {
            deliver(delivered::<T>(value));
        });
        self.sources
            .borrow_mut()
            .insert(id, (js::current_frame(), Rc::new(RefCell::new(handler))));
        Poster {
            inbox: self.inbox.clone(),
            id,
        }
    }

    /// Runs `work` on the pool; `deliver` gets its result in a unit of its
    /// own on this loop, in the async context frame current here (a libuv
    /// request's callback runs in the frame its request was made in).
    fn submit<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
        deliver: impl FnOnce(T) + 'static,
    ) {
        let id = self.next_blocking.get() + 1;
        self.next_blocking.set(id);
        let frame = js::current_frame();
        self.blocking.borrow_mut().insert(
            id,
            Box::new(move |result| {
                let value = delivered::<T>(result);
                js::with_frame(frame, move || deliver(value));
            }),
        );
        let inbox = self.inbox.clone();
        self.pool
            .borrow_mut()
            .get_or_insert_with(BlockingPool::new)
            .run(Box::new(move || {
                inbox.post(Unit::Done(id, guarded(work)));
            }));
    }

    fn blocking<T: Clone + Send + 'static, E: Clone + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Promise<T, E> {
        let id = self.next_blocking.get() + 1;
        self.next_blocking.set(id);
        let (promise, resolvers): (Promise<T, E>, Resolvers<T, E>) = Promise::with_resolvers();
        self.blocking.borrow_mut().insert(
            id,
            Box::new(move |result| {
                resolvers.fulfill(delivered::<T>(result));
            }),
        );
        let inbox = self.inbox.clone();
        self.pool
            .borrow_mut()
            .get_or_insert_with(BlockingPool::new)
            .run(Box::new(move || {
                inbox.post(Unit::Done(id, guarded(work)));
            }));
        promise
    }
}

/// A pool job that panicked: its message, carried to the loop thread.
struct PoolPanic(String);

/// Runs a pool job; a panic in it becomes a [`PoolPanic`] delivered to the
/// loop (whose delivery panics there), so a dying job never leaves its
/// promise unsettled. In the process the panic hook has already ended it
/// (exit 70); in tests the loop thread fails loudly instead of waiting.
fn guarded<T: Send + 'static>(work: impl FnOnce() -> T) -> Box<dyn Any + Send> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)) {
        Ok(value) => Box::new(value),
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|text| (*text).to_owned())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| String::from("a panic without a message"));
            Box::new(PoolPanic(message))
        }
    }
}

/// A job's result on the loop thread; a job that panicked panics here.
fn delivered<T: 'static>(result: Box<dyn Any + Send>) -> T {
    if let Some(PoolPanic(message)) = result.downcast_ref::<PoolPanic>() {
        panic!("a pool job panicked: {message}");
    }
    *result.downcast::<T>().expect("the blocking work's result")
}

/// libuv's thread pool: four threads, jobs in submission order.
struct BlockingPool {
    jobs: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>,
}

/// libuv's default `UV_THREADPOOL_SIZE`.
const POOL_THREADS: usize = 4;

impl BlockingPool {
    fn new() -> BlockingPool {
        let (jobs, receive) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let receive = Arc::new(Mutex::new(receive));
        for _ in 0..POOL_THREADS {
            let receive = receive.clone();
            std::thread::spawn(move || {
                loop {
                    let job = receive.lock().expect("pool queue").recv();
                    match job {
                        Ok(job) => job(),
                        Err(_) => return,
                    }
                }
            });
        }
        BlockingPool { jobs }
    }

    fn run(&self, job: Box<dyn FnOnce() + Send>) {
        let _ = self.jobs.send(job);
    }
}

thread_local! {
    static LOOP: RefCell<Option<Rc<EventLoop>>> = const { RefCell::new(None) };
}

/// Installs the loop of this thread, replacing any earlier one and the
/// process-wide state that belonged to it (pools, the shared stall clock).
pub fn install(event_loop: Rc<EventLoop>) {
    js::install(event_loop.jobs.clone());
    js::register_errors(crate::ctx::js_error);
    // The old loop (and what it holds) goes after the new one is in.
    let old = LOOP.with(|slot| slot.borrow_mut().replace(event_loop));
    drop(old);
    crate::iopool::reset();
    crate::stall::reset_shared();
    crate::signal::reset();
}

/// The loop of this thread.
pub fn current() -> Rc<EventLoop> {
    LOOP.with(|slot| slot.borrow().clone())
        .expect("no event loop installed on this thread")
}

/// `Date.now()`.
pub fn now() -> f64 {
    current().clock.epoch_ms()
}

/// The duration of Node's timer for `ms`: `after *= 1`; anything outside
/// [1, 2^31 - 1] (NaN included) is 1 ms. Lists are keyed by its truncation
/// (`insert`'s `MathTrunc`).
pub fn timer_delay(ms: f64) -> f64 {
    if (1.0..=TIMEOUT_MAX).contains(&ms) {
        ms
    } else {
        1.0
    }
}

/// A `Timeout` handle (`setTimeout`, `setInterval`). Dropping it clears
/// nothing, as in JavaScript.
#[derive(Clone)]
pub struct Timeout(Rc<TimerObj>);

fn new_timer(ms: f64, repeat: bool, callback: Box<dyn FnMut()>) -> Timeout {
    let event_loop = current();
    let after = timer_delay(ms);
    let timer = Rc::new(TimerObj {
        idle_timeout: Cell::new(after),
        idle_start: Cell::new(0),
        callback: RefCell::new(Some(callback)),
        armed: Cell::new(true),
        repeat: repeat.then_some(after),
        destroyed: Cell::new(false),
        refed: Cell::new(true),
        list: RefCell::new(None),
        frame: js::current_frame(),
    });
    let start = event_loop.clock.loop_ms();
    event_loop.timers.borrow_mut().insert(&timer, after, start);
    Timeout(timer)
}

/// `setTimeout(callback, ms)`.
pub fn set_timeout(ms: f64, callback: impl FnOnce() + 'static) -> Timeout {
    let mut callback = Some(callback);
    new_timer(
        ms,
        false,
        Box::new(move || {
            if let Some(callback) = callback.take() {
                callback();
            }
        }),
    )
}

/// `setInterval(callback, ms)`.
pub fn set_interval(ms: f64, callback: impl FnMut() + 'static) -> Timeout {
    new_timer(ms, true, Box::new(callback))
}

/// `clearTimeout(timer)` (and `clearInterval`).
pub fn clear_timeout(timer: &Timeout) {
    if !timer.0.armed.replace(false) {
        return;
    }
    timer.0.callback.borrow_mut().take();
    if let Some(event_loop) = LOOP.with(|slot| slot.borrow().clone()) {
        event_loop.timers.borrow_mut().unenroll(&timer.0);
    }
}

impl Timeout {
    /// `timer.unref()`: it no longer keeps the loop alive, and clearing it
    /// keeps its emptied list.
    pub fn unref(&self) -> &Timeout {
        self.0.refed.set(false);
        self
    }

    /// `timer.ref()`.
    pub fn ref_(&self) -> &Timeout {
        self.0.refed.set(true);
        self
    }
}

/// `clearTimeout` of an optional timer (`clearTimeout(null)` does nothing).
pub fn clear_optional(timer: &Option<Timeout>) {
    if let Some(timer) = timer {
        clear_timeout(timer);
    }
}

/// An `Immediate` handle.
#[derive(Clone)]
pub struct Immediate(Rc<ImmediateObj>);

/// `setImmediate(callback)`.
pub fn set_immediate(callback: impl FnOnce() + 'static) -> Immediate {
    let immediate = Rc::new(ImmediateObj {
        callback: RefCell::new(Some(Box::new(callback))),
        destroyed: Cell::new(false),
        frame: js::current_frame(),
    });
    current().immediates.borrow_mut().push(immediate.clone());
    Immediate(immediate)
}

/// `clearImmediate(immediate)`.
pub fn clear_immediate(immediate: &Immediate) {
    if immediate.0.destroyed.replace(true) {
        return;
    }
    immediate.0.callback.borrow_mut().take();
}

/// `new Promise((resolve) => setTimeout(resolve, ms))`.
pub fn sleep<E: Clone + 'static>(ms: f64) -> Promise<(), E> {
    Promise::executor(|resolvers| {
        set_timeout(ms, move || resolvers.fulfill(()));
        Ok(())
    })
}

/// `new Promise((resolve) => setImmediate(resolve))`.
pub fn immediate<E: Clone + 'static>() -> Promise<(), E> {
    Promise::executor(|resolvers| {
        set_immediate(move || resolvers.fulfill(()));
        Ok(())
    })
}

/// Runs `work` on the four-thread pool (libuv's); its result settles the
/// promise in a unit of its own on this loop.
pub fn blocking<T: Clone + Send + 'static, E: Clone + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Promise<T, E> {
    current().blocking(work)
}

/// Runs `work` on the four-thread pool; `deliver` gets its result in a unit
/// of its own on this loop (never in the checkpoint that submitted it), in
/// the frame current at the submission. `work` runs on another thread and
/// only computes: it holds no promise, task or job, and settles nothing.
pub fn submit<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    deliver: impl FnOnce(T) + 'static,
) {
    current().submit(work, deliver);
}

/// Opens a long-lived source: another thread posts deliveries through the
/// returned [`Poster`], and each runs `deliver` in a unit of its own on this
/// loop, in the async context frame current here (a libuv handle's callbacks
/// run in the frame the handle was made in), until [`close_source`].
pub fn open_source<T: Send + 'static>(deliver: impl FnMut(T) + 'static) -> Poster {
    current().open_source(deliver)
}

/// Closes a source: what its thread posts afterwards is dropped.
pub fn close_source(id: u64) {
    if let Some(event_loop) = LOOP.with(|slot| slot.borrow().clone()) {
        let removed = event_loop.sources.borrow_mut().remove(&id);
        drop(removed);
    }
}

/// `process.env[name]`, read per use.
pub fn env(name: &str) -> Option<String> {
    (current().env)(name)
}

/// A loop on a hand-moved clock at 1000 ms, installed on this thread, for
/// the unit tests of the modules on it.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    struct TestClock(Rc<Cell<i64>>);

    impl Clock for TestClock {
        fn loop_ms(&self) -> i64 {
            self.0.get()
        }
        fn epoch_ms(&self) -> f64 {
            self.0.get() as f64
        }
    }

    pub(crate) fn test_loop_with(
        env: impl Fn(&str) -> Option<String> + 'static,
    ) -> (Rc<EventLoop>, Rc<Cell<i64>>) {
        let time = Rc::new(Cell::new(1_000));
        let event_loop = EventLoop::new(
            Box::new(TestClock(time.clone())),
            Box::new(env),
            Box::new(|| {}),
        );
        install(event_loop.clone());
        (event_loop, time)
    }

    pub(crate) fn test_loop() -> (Rc<EventLoop>, Rc<Cell<i64>>) {
        test_loop_with(|_| None)
    }

    /// Runs check and timers phases, moving the clock to each expiry, until `until`.
    pub(crate) fn run_until(event_loop: &EventLoop, time: &Cell<i64>, until: i64) {
        loop {
            event_loop.check_phase();
            event_loop.timers_phase();
            if event_loop.has_immediates() {
                continue;
            }
            match event_loop.next_expiry() {
                Some(expiry) if expiry <= until => time.set(expiry.max(time.get())),
                _ => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{run_until, test_loop};
    use super::*;
    use crate::js::{Resolution, async_fn};
    use std::future::{Future, IntoFuture};

    type Log = Rc<RefCell<Vec<String>>>;

    fn logger() -> (Log, impl Fn(&str) + Clone) {
        let log = Rc::new(RefCell::new(Vec::new()));
        let push = {
            let log = log.clone();
            move |entry: &str| log.borrow_mut().push(entry.to_string())
        };
        (log, push)
    }

    #[test]
    fn node_timer_delays() {
        assert_eq!(timer_delay(0.0), 1.0);
        assert_eq!(timer_delay(f64::NAN), 1.0);
        assert_eq!(timer_delay(-5.0), 1.0);
        assert_eq!(timer_delay(0.5), 1.0);
        assert_eq!(timer_delay(2.5), 2.5);
        assert_eq!(timer_delay(250.0), 250.0);
        assert_eq!(timer_delay(3e9), 1.0);
    }

    #[test]
    fn continuations_run_between_timers_and_lists_fire_by_expiry_then_id() {
        let (event_loop, time) = test_loop();
        let (log, push) = logger();
        let (gate, open) = Promise::<(), ()>::with_resolvers();
        {
            let push = push.clone();
            set_timeout(30.0, move || {
                push("a1");
                open.fulfill(());
            });
        }
        {
            let push = push.clone();
            set_timeout(30.0, move || push("b"));
        }
        {
            let push = push.clone();
            let _ = async_fn::<(), ()>(async move {
                gate.await?;
                push("a2");
                Ok(Resolution::Value(()))
            });
        }
        // A 2.5 ms timer is in the 2 ms list, behind the first.
        {
            let push = push.clone();
            set_timeout(2.0, move || push("two"));
        }
        {
            let push = push.clone();
            set_timeout(2.5, move || push("two and a half"));
        }
        time.set(1_002);
        event_loop.timers_phase();
        time.set(1_030);
        event_loop.timers_phase();
        assert_eq!(
            *log.borrow(),
            ["two", "two and a half", "a1", "a2", "b"].map(String::from)
        );
    }

    #[test]
    fn immediates_queued_during_the_check_phase_wait_for_the_next() {
        let (event_loop, _) = test_loop();
        let (log, push) = logger();
        set_immediate(move || {
            push("first");
            let again = push.clone();
            set_immediate(move || again("next iteration"));
            push("after");
        });
        event_loop.check_phase();
        assert_eq!(*log.borrow(), ["first", "after"].map(String::from));
        event_loop.check_phase();
        assert_eq!(log.borrow().len(), 3);
    }

    #[test]
    fn an_immediate_cleared_by_the_checkpoint_before_it_is_skipped() {
        let (event_loop, _) = test_loop();
        let (log, push) = logger();
        let second: Rc<RefCell<Option<Immediate>>> = Rc::new(RefCell::new(None));
        {
            let (push, second) = (push.clone(), second.clone());
            set_immediate(move || {
                push("first");
                js::queue_microtask(move || {
                    if let Some(second) = second.borrow().as_ref() {
                        clear_immediate(second);
                    }
                });
            });
        }
        {
            let push = push.clone();
            *second.borrow_mut() = Some(set_immediate(move || push("second")));
        }
        set_immediate(move || push("third"));
        event_loop.check_phase();
        assert_eq!(*log.borrow(), ["first", "third"].map(String::from));
    }

    #[test]
    fn a_blocking_completion_is_a_unit_of_its_own() {
        let (event_loop, _) = test_loop();
        let (log, push) = logger();
        let result = blocking::<i32, ()>(|| 41 + 1);
        let _ = async_fn::<(), ()>(async move {
            let value = result.await?;
            push(&format!("got {value}"));
            Ok(Resolution::Value(()))
        });
        assert!(log.borrow().is_empty());
        let mut input = |_: Input| {};
        while log.borrow().is_empty() {
            event_loop.poll_phase(Some(1_000), &mut input);
        }
        assert_eq!(*log.borrow(), ["got 42"].map(String::from));
    }

    #[test]
    fn clearing_an_unrefed_timer_keeps_its_list_until_visited() {
        let (event_loop, time) = test_loop();
        let unrefed = set_timeout(10.0, || {});
        unrefed.unref();
        clear_timeout(&unrefed);
        assert_eq!(event_loop.next_expiry(), Some(1_010));
        clear_timeout(&set_timeout(20.0, || {}));
        assert_eq!(event_loop.next_expiry(), Some(1_010));
        time.set(1_010);
        event_loop.timers_phase();
        assert_eq!(event_loop.next_expiry(), None);
    }

    /// S5: one iteration is poll, then check, then timers.
    #[test]
    fn an_iteration_is_poll_then_check_then_timers() {
        let (event_loop, time) = test_loop();
        let (log, push) = logger();
        {
            let push = push.clone();
            set_timeout(5.0, move || push("timer"));
        }
        {
            let push = push.clone();
            set_immediate(move || push("immediate"));
        }
        time.set(1_005);
        event_loop
            .inbox()
            .post(Unit::Input(Input::Line(b"line".to_vec())));
        let mut input = {
            let push = push.clone();
            move |unit: Input| {
                if let Input::Line(line) = unit {
                    push(&String::from_utf8_lossy(&line));
                }
            }
        };
        event_loop.iterate(&mut input);
        assert_eq!(
            *log.borrow(),
            ["line", "immediate", "timer"].map(String::from)
        );
    }

    /// n10: the poll phase handles every unit queued, not one per iteration.
    #[test]
    fn one_poll_phase_handles_every_queued_unit_before_the_check_phase() {
        let (event_loop, _) = test_loop();
        let (log, push) = logger();
        {
            let push = push.clone();
            set_immediate(move || push("immediate"));
        }
        for line in ["a", "b", "c"] {
            event_loop
                .inbox()
                .post(Unit::Input(Input::Line(line.as_bytes().to_vec())));
        }
        let mut input = {
            let push = push.clone();
            move |unit: Input| {
                if let Input::Line(line) = unit {
                    push(&String::from_utf8_lossy(&line));
                }
            }
        };
        event_loop.iterate(&mut input);
        assert_eq!(
            *log.borrow(),
            ["a", "b", "c", "immediate"].map(String::from)
        );
    }

    /// H01 of the third review: an interval cleared in its own callback is
    /// not re-armed, and its refed list is gone (Node's `unenroll` sets
    /// `_idleTimeout` to -1, so `listOnTimeout` does not insert it again).
    #[test]
    fn an_interval_cleared_in_its_own_callback_is_not_rearmed() {
        let (event_loop, time) = test_loop();
        let (log, push) = logger();
        let own: Rc<RefCell<Option<Timeout>>> = Rc::new(RefCell::new(None));
        let timer = {
            let own = own.clone();
            set_interval(5.0, move || {
                push("I");
                if let Some(timer) = own.borrow().as_ref() {
                    clear_timeout(timer);
                }
            })
        };
        *own.borrow_mut() = Some(timer);
        time.set(1_005);
        event_loop.timers_phase();
        assert_eq!(*log.borrow(), ["I"].map(String::from));
        assert_eq!(event_loop.next_expiry(), None, "no list is left");
    }

    /// H02 of the third review: a poll phase handles every unit queued when
    /// it starts, also above 1,000, before the check phase.
    #[test]
    fn a_poll_phase_handles_more_than_a_thousand_queued_units_before_the_check_phase() {
        let (event_loop, _) = test_loop();
        let (log, push) = logger();
        {
            let push = push.clone();
            set_immediate(move || push("immediate"));
        }
        for _ in 0..1_500 {
            event_loop
                .inbox()
                .post(Unit::Input(Input::Line(b"u".to_vec())));
        }
        let mut input = move |unit: Input| {
            if let Input::Line(_) = unit {
                push("u");
            }
        };
        event_loop.iterate(&mut input);
        let log = log.borrow();
        assert_eq!(log.len(), 1_501);
        assert_eq!(log.last().map(String::as_str), Some("immediate"));
    }

    /// B1 of the second review (`mini.jsonl`): T1 and T2, 1 ms intervals of
    /// 3 firings, and T6 (2 ms), which makes T10 (1 ms), whose callback or a
    /// continuation of it clears T1. The traces are Node's (Electron's
    /// Node, jobs-differential's "b1" programs): T2 still fires at 1003.
    fn b1(clear_after_jobs: usize, unref_t2: bool) -> Vec<String> {
        let (event_loop, time) = test_loop();
        let (log, push) = logger();
        let t1: Rc<RefCell<Option<Timeout>>> = Rc::new(RefCell::new(None));
        for (name, slot) in [("T1", Some(t1.clone())), ("T2", None)] {
            let (push, now) = (push.clone(), time.clone());
            let own: Rc<RefCell<Option<Timeout>>> = slot.unwrap_or_default();
            let mine = own.clone();
            let mut left = 3;
            let timer = set_interval(1.0, move || {
                left -= 1;
                if left == 0 {
                    clear_timeout(mine.borrow().as_ref().expect("the interval"));
                }
                push(&format!("{name}@{}", now.get()));
            });
            if unref_t2 && name == "T2" {
                timer.unref();
            }
            *own.borrow_mut() = Some(timer);
        }
        {
            let (push, now) = (push.clone(), time.clone());
            set_timeout(2.0, move || {
                push(&format!("T6@{}", now.get()));
                let (push, now, t1) = (push.clone(), now.clone(), t1.clone());
                set_timeout(1.0, move || {
                    push(&format!("T10@{}", now.get()));
                    fn clear_later(jobs: usize, t1: Rc<RefCell<Option<Timeout>>>) {
                        if jobs == 0 {
                            clear_timeout(t1.borrow().as_ref().expect("T1"));
                        } else {
                            js::queue_microtask(move || clear_later(jobs - 1, t1));
                        }
                    }
                    clear_later(clear_after_jobs, t1);
                });
            });
        }
        run_until(&event_loop, &time, 1_020);
        log.borrow().clone()
    }

    const B1_NODE: [&str; 7] = [
        "T1@1001", "T2@1001", "T6@1002", "T1@1002", "T2@1002", "T10@1003", "T2@1003",
    ];

    #[test]
    fn b1_a_timer_cleared_in_the_callback_before_it_does_not_drop_the_next() {
        assert_eq!(b1(0, false), B1_NODE.map(String::from));
    }

    #[test]
    fn b1_a_timer_cleared_two_jobs_into_the_continuation_before_it_does_not_drop_the_next() {
        assert_eq!(b1(2, false), B1_NODE.map(String::from));
    }

    #[test]
    fn b1_the_same_with_the_other_interval_unrefed() {
        assert_eq!(b1(1, true), B1_NODE.map(String::from));
    }

    /// B1's second path: the checkpoint empties the list (deleting it) and
    /// makes a new one of the same duration; the old list is not the new one.
    #[test]
    fn b1_a_list_emptied_and_made_anew_by_a_continuation() {
        let (event_loop, time) = test_loop();
        let (log, push) = logger();
        let b: Rc<RefCell<Option<Timeout>>> = Rc::new(RefCell::new(None));
        {
            let (push, b, now) = (push.clone(), b.clone(), time.clone());
            set_timeout(1.0, move || {
                push(&format!("A@{}", now.get()));
                let (push, now) = (push.clone(), now.clone());
                js::queue_microtask(move || {
                    clear_timeout(b.borrow().as_ref().expect("B"));
                    set_timeout(1.0, move || push(&format!("D@{}", now.get())));
                });
            });
        }
        {
            let (push, now) = (push.clone(), time.clone());
            *b.borrow_mut() = Some(set_timeout(1.0, move || push(&format!("B@{}", now.get()))));
        }
        run_until(&event_loop, &time, 1_020);
        assert_eq!(*log.borrow(), ["A@1001", "D@1002"].map(String::from));
    }

    /// The porting rule, enforced: a task that suspends on a plain future
    /// (which nothing could wake) panics.
    #[test]
    #[should_panic(expected = "something other than a JavaScript await")]
    fn a_task_suspended_on_a_plain_future_panics() {
        let _ = test_loop();
        let _ = async_fn::<(), ()>(async {
            std::future::pending::<()>().await;
            Ok(Resolution::Value(()))
        });
    }

    /// Two awaits at once (`join!`) panic too.
    #[test]
    #[should_panic(expected = "two awaits at once")]
    fn a_task_awaiting_two_promises_at_once_panics() {
        let _ = test_loop();
        let (a, _ra) = Promise::<(), ()>::with_resolvers();
        let (b, _rb) = Promise::<(), ()>::with_resolvers();
        let _ = async_fn::<(), ()>(async move {
            let (mut first, mut second) = (
                std::pin::pin!(a.into_future()),
                std::pin::pin!(b.into_future()),
            );
            std::future::poll_fn(|cx| {
                let _ = first.as_mut().poll(cx);
                let _ = second.as_mut().poll(cx);
                std::task::Poll::<()>::Pending
            })
            .await;
            Ok(Resolution::Value(()))
        });
    }
}
