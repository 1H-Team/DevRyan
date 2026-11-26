//! What a step hands a family besides its arguments, and what the family
//! gives back besides its result (the C0i review's S6(a)): the step's time,
//! the host that answers its ports and draws from the recording, and the
//! microtask queue its continuations run in. Everything observable a family
//! makes goes through the host in the order it is made, so a delivery's
//! observables are one ordered list (protocol 5's group list); the host
//! records each one when it is made (its values taken then, as the
//! TypeScript engine takes them).
//!
//! Sans-IO: the engine never reads a clock or a random source; `now` is the
//! step's own time, and a draw is the recording's next one. A family that
//! needs none of this ignores the context.

use std::collections::VecDeque;

use crate::js::{Js, Value};

/// The host stopped the case (an effect asked for out of order, one the
/// recording does not hold): the family's code unwinds and its result is not
/// used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Halted;

/// What answers a family's observables: the runner, from the step's env.
pub trait Host {
    /// A port call (`port`: the export the family calls): the effect is
    /// recorded (its arguments taken now) and the recording's next answer of
    /// that port is returned, as a value or as what the port threw.
    fn port(&mut self, port: &str, args: &[Value]) -> Result<Js, Halted>;
    /// A draw from a random source (`Math.random`, `crypto.randomUUID`, ...): the recording's next one.
    fn draw(&mut self, source: &str) -> Result<Value, Halted>;
}

/// A continuation: a job the family queued (a promise reaction), run once the
/// synchronous parts of the delivery returned, in the order queued, as a
/// microtask is. What it throws is uncaught (the runner charges it to the
/// case, as `outside`).
pub type Job = Box<dyn FnOnce(&mut Ctx<'_>) -> Js<()>>;

/// The most jobs one delivery runs before it is taken as running forever (the TypeScript engine's 10,000 rounds).
pub const JOB_LIMIT: usize = 10_000;

/// A delivery's microtask queue, and what its jobs left: a halt, uncaught throws.
#[derive(Default)]
pub struct Jobs {
    queue: VecDeque<Job>,
    halted: bool,
    uncaught: Vec<Value>,
}

/// How running a delivery's jobs ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quiet {
    /// The queue ran out.
    Quiet,
    /// The host stopped the case.
    Halted,
    /// More than `JOB_LIMIT` jobs ran.
    Endless,
}

impl Jobs {
    /// Whether a host stopped the case.
    pub fn halted(&self) -> bool {
        self.halted
    }

    /// Runs the queued jobs, and those they queue, in order, until none is left.
    pub fn run(&mut self, now: Option<f64>, host: &mut dyn Host) -> Quiet {
        let mut ran = 0;
        while let Some(job) = self.queue.pop_front() {
            if self.halted {
                return Quiet::Halted;
            }
            if ran == JOB_LIMIT {
                return Quiet::Endless;
            }
            ran += 1;
            let mut ctx = Ctx { now, host, jobs: self };
            if let Err(thrown) = job(&mut ctx)
                && !self.halted
            {
                self.uncaught.push(thrown);
            }
        }
        if self.halted { Quiet::Halted } else { Quiet::Quiet }
    }

    /// What the jobs threw that nothing caught, in order (taken).
    pub fn take_uncaught(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.uncaught)
    }
}

/// The context of one call or job.
pub struct Ctx<'a> {
    now: Option<f64>,
    host: &'a mut dyn Host,
    jobs: &'a mut Jobs,
}

impl<'a> Ctx<'a> {
    pub fn new(now: Option<f64>, host: &'a mut dyn Host, jobs: &'a mut Jobs) -> Ctx<'a> {
        Ctx { now, host, jobs }
    }

    /// `Date.now()`: the step's time (NaN when the step gave none, which no recorded step lacks).
    pub fn now(&self) -> f64 {
        self.now.unwrap_or(f64::NAN)
    }

    /// Whether the host stopped the case.
    pub fn halted(&self) -> bool {
        self.jobs.halted
    }

    /// A port call; on a halt the family's code sees `undefined` thrown and unwinds.
    pub fn port(&mut self, port: &str, args: &[Value]) -> Js {
        if self.jobs.halted {
            return Err(Value::Undefined);
        }
        match self.host.port(port, args) {
            Ok(answer) => answer,
            Err(Halted) => {
                self.jobs.halted = true;
                Err(Value::Undefined)
            }
        }
    }

    /// A draw; on a halt the family's code sees `undefined` thrown and unwinds.
    pub fn draw(&mut self, source: &str) -> Js {
        if self.jobs.halted {
            return Err(Value::Undefined);
        }
        match self.host.draw(source) {
            Ok(value) => Ok(value),
            Err(Halted) => {
                self.jobs.halted = true;
                Err(Value::Undefined)
            }
        }
    }

    /// Queues a microtask.
    pub fn queue(&mut self, job: Job) {
        self.jobs.queue.push_back(job);
    }
}

/// A host for code that makes no observable (tests, the pure families'
/// vectors): every port call and draw halts.
pub struct NoHost;

impl Host for NoHost {
    fn port(&mut self, _port: &str, _args: &[Value]) -> Result<Js, Halted> {
        Err(Halted)
    }

    fn draw(&mut self, _source: &str) -> Result<Value, Halted> {
        Err(Halted)
    }
}
