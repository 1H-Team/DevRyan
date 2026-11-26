//! The order in which writes take the group's lock: the order in which the
//! JavaScript's handlers call `persist` (whose `writeLock.then(...)` queues
//! each write behind the last). The JavaScript runs on one event loop, and a
//! handler runs up to that call as soon as the loop has what the request
//! decoding waits for (fix round 1 of BH6, read from body-parser 2.2.2's
//! `read` and checked against the reference by the write-order scenario):
//!
//! - **the head**, when no parser reads the body (no Content-Length or
//!   Transfer-Encoding, a type neither parser takes, or a path whose spelling
//!   has no JSON parser): body-parser calls `next()` at once, and the body
//!   arrives after the handler has run;
//! - **the end of the body**, when a parser reads it plainly: raw-body's
//!   `end` comes in the same turn of the loop as the last body bytes;
//! - **the end of inflation**, when the body is compressed: zlib inflates on
//!   Node's thread pool, and the parser goes on when the last thread-pool call
//!   reports back to the loop, however late that is after the body ended.
//!
//! Events that reach the loop in one turn are taken in the order the kernel
//! reports them (kqueue, epoll: the order sockets became readable), each
//! handler running to its `persist` before the next event. A new
//! connection is watched from the turn after it was accepted. A read
//! (`GET`) never waits: `readPromptState` takes no lock; but it is on the
//! thread pool before any later write has read, parsed and truncated the file,
//! so a later write never truncates the file under it.
//!
//! Here the candidate's one reader thread (src/candidate.rs) issues a request's
//! ticket at those same points, in the order it takes the kernel's events; a
//! write waits until every request with an earlier ticket has written or been
//! found not to write (a read, once it has read); a request that does not
//! write releases its ticket as soon as that is known. What cannot be equal from outside: when two such
//! points fall within microseconds (an inflate that ends as another request
//! arrives), the order depends on timing on the reference as on the candidate.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
struct State {
    issued: u64,
    serving: u64,
    done: BTreeSet<u64>,
}

/// The ticket dispenser of one candidate process.
#[derive(Default)]
pub struct Turns {
    state: Mutex<State>,
    changed: Condvar,
}

impl Turns {
    pub fn new() -> Arc<Self> {
        Arc::new(Turns::default())
    }

    /// The next ticket (called by the reader, in the order requests were read in full).
    pub fn issue(self: &Arc<Self>) -> Ticket {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let id = state.issued;
        state.issued += 1;
        Ticket {
            turns: Arc::clone(self),
            id,
            released: AtomicBool::new(false),
        }
    }
}

/// One request's place in the order of writes; released once, at the latest when dropped.
pub struct Ticket {
    turns: Arc<Turns>,
    id: u64,
    released: AtomicBool,
}

impl Ticket {
    /// A ticket outside any order (tests and tools that call the runtime directly).
    pub fn alone() -> Self {
        Turns::new().issue()
    }

    /// Waits until every earlier ticket is released.
    pub fn wait(&self) {
        let mut state = self.turns.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while state.serving != self.id {
            state = self.turns.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// This request writes no more (or never did): later tickets may go on.
    pub fn release(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut state = self.turns.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.done.insert(self.id);
        loop {
            let next = state.serving;
            if !state.done.remove(&next) {
                break;
            }
            state.serving += 1;
        }
        self.turns.changed.notify_all();
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn writes_go_in_ticket_order() {
        let turns = Turns::new();
        let (first, second, third) = (turns.issue(), turns.issue(), turns.issue());
        let log = Arc::new(Mutex::new(Vec::new()));
        let late = {
            let log = Arc::clone(&log);
            thread::spawn(move || {
                third.wait();
                log.lock().unwrap().push(3);
            })
        };
        let middle = {
            let log = Arc::clone(&log);
            thread::spawn(move || {
                second.wait();
                log.lock().unwrap().push(2);
                second.release();
            })
        };
        thread::sleep(Duration::from_millis(20));
        assert!(log.lock().unwrap().is_empty(), "nothing goes before the first ticket is released");
        drop(first);
        middle.join().unwrap();
        late.join().unwrap();
        assert_eq!(*log.lock().unwrap(), vec![2, 3]);
    }
}
