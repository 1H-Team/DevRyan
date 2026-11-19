//! `AbortController` and `AbortSignal`, dispatching `abort` as Node's
//! `EventTarget` does (`internal/event_target.js`, `[kHybridDispatch]`, and
//! `internal/abort_controller.js` of Node 24.22):
//!
//! - The listeners are a linked list behind a root, in registration order.
//!   Dispatch walks the live list and reads each listener's `next` before
//!   calling it: a listener removed during the dispatch (by an earlier one)
//!   is skipped, one added during it runs when it was linked behind a
//!   listener still to come (so one added by the last listener does not).
//! - A `once` listener is unlinked before it is called. Removing the last
//!   listener with `remove_listener` drops the root, so a listener added
//!   after that starts a new list the dispatch in progress never reaches.
//! - `abort` sets the reason before any listener runs; a second `abort`
//!   does nothing; `throw_if_aborted` throws the reason itself. A listener
//!   added to a signal that already aborted is kept and never called.
//! - [`Signal::any`]: a composite signal follows its sources from its
//!   creation (composites given as sources are flattened to theirs). When a
//!   source aborts, every dependent not yet aborted takes its reason first,
//!   then the source's listeners run, then each dependent's, in the order
//!   the dependents began following. A source that already aborted gives a
//!   signal that already aborted. A composite with a listener is kept alive
//!   by the process (Node's `gcPersistentSignals`) until it aborts or loses
//!   its last listener; one without is held weakly by its sources.
//!
//! Listeners run synchronously in the frame of the code that aborts (the
//! dispatcher's, as in Node). A listener cannot throw: its Rust type has no
//! error (a JavaScript listener that throws ends the worker). The same
//! function registered twice is two listeners here (Rust closures have no
//! identity); the ledger registers each listener once.
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use crate::value::W;

type Listener = Box<dyn FnOnce(&W)>;

/// A node of the listener list: a root (the events map's entry) or a
/// listener. Links are node ids; a node unlinked during a dispatch stays
/// until the dispatch ends, so a cached `next` still leads on.
struct Node {
    previous: Option<u64>,
    next: Option<u64>,
    removed: bool,
    once: bool,
    /// The root's count of listeners (`root.size`).
    size: usize,
    callback: Option<Listener>,
}

#[derive(Default)]
struct State {
    reason: Option<W>,
    next_id: u64,
    nodes: HashMap<u64, Node>,
    /// The events map's entry for `abort`.
    root: Option<u64>,
    dispatching: bool,
    /// Nodes unlinked during the dispatch, freed when it ends.
    unlinked: Vec<u64>,
    composite: bool,
    /// A composite's sources (never composites themselves).
    sources: Vec<Weak<RefCell<State>>>,
    /// The composites following this signal, in the order they began.
    dependants: Vec<Weak<RefCell<State>>>,
}

impl State {
    fn fresh_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// `Listener.remove()`: unlinks the node and flags it; its own links
    /// stay as they were.
    fn unlink(&mut self, id: u64) {
        let Some(node) = self.nodes.get_mut(&id) else {
            return;
        };
        node.removed = true;
        let (previous, next) = (node.previous, node.next);
        if let Some(previous) = previous.and_then(|previous| self.nodes.get_mut(&previous)) {
            previous.next = next;
        }
        if let Some(next) = next.and_then(|next| self.nodes.get_mut(&next)) {
            next.previous = previous;
        }
        if self.dispatching {
            self.unlinked.push(id);
        } else {
            self.nodes.remove(&id);
        }
    }

    /// Frees what the dispatch unlinked, once nothing walks it.
    fn collect(&mut self) {
        for id in std::mem::take(&mut self.unlinked) {
            self.nodes.remove(&id);
        }
    }
}

thread_local! {
    /// Node's `gcPersistentSignals`: composites with a listener, kept alive
    /// until they abort or lose their last listener.
    static PERSISTENT: RefCell<Vec<Rc<RefCell<State>>>> = const { RefCell::new(Vec::new()) };
}

fn persist(state: &Rc<RefCell<State>>) {
    PERSISTENT.with(|kept| {
        let mut kept = kept.borrow_mut();
        if !kept.iter().any(|known| Rc::ptr_eq(known, state)) {
            kept.push(state.clone());
        }
    });
}

fn release(state: &Rc<RefCell<State>>) {
    // A thread ending drops its signals after the store.
    let _ = PERSISTENT.try_with(|kept| {
        let released = {
            let mut kept = kept.borrow_mut();
            kept.iter()
                .position(|known| Rc::ptr_eq(known, state))
                .map(|index| kept.remove(index))
        };
        drop(released);
    });
}

/// An `AbortSignal`; clones are the same signal.
#[derive(Clone, Default)]
pub struct Signal(Rc<RefCell<State>>);

/// A listener registration, for `removeEventListener`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ListenerId(u64);

impl Signal {
    pub fn aborted(&self) -> bool {
        self.0.borrow().reason.is_some()
    }

    pub fn reason(&self) -> W {
        self.0.borrow().reason.clone().unwrap_or(W::Undefined)
    }

    pub fn same(&self, other: &Signal) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }

    /// `signal.throwIfAborted()`.
    pub fn throw_if_aborted(&self) -> Result<(), W> {
        match &self.0.borrow().reason {
            Some(reason) => Err(reason.clone()),
            None => Ok(()),
        }
    }

    /// `addEventListener('abort', listener, { once: true })`.
    pub fn add_listener(&self, listener: impl FnOnce(&W) + 'static) -> ListenerId {
        self.add_listener_with(true, listener)
    }

    /// `addEventListener('abort', listener, { once })`. `abort` dispatches
    /// once, so a listener is called at most once either way; `once` decides
    /// whether it is unlinked before its call.
    pub fn add_listener_with(&self, once: bool, listener: impl FnOnce(&W) + 'static) -> ListenerId {
        let (id, size) = {
            let mut state = self.0.borrow_mut();
            let id = state.fresh_id();
            let root = match state.root {
                Some(root) => root,
                None => {
                    let root = state.fresh_id();
                    state.nodes.insert(
                        root,
                        Node {
                            previous: None,
                            next: None,
                            removed: false,
                            once: false,
                            size: 0,
                            callback: None,
                        },
                    );
                    state.root = Some(root);
                    root
                }
            };
            let mut tail = root;
            while let Some(next) = state.nodes[&tail].next {
                tail = next;
            }
            state.nodes.insert(
                id,
                Node {
                    previous: Some(tail),
                    next: None,
                    removed: false,
                    once,
                    size: 0,
                    callback: Some(Box::new(listener)),
                },
            );
            state.nodes.get_mut(&tail).expect("the tail").next = Some(id);
            let root = state.nodes.get_mut(&root).expect("the root");
            root.size += 1;
            (id, root.size)
        };
        // `[kNewListener]`: a following composite with its first listener
        // is kept alive.
        let keep = {
            let state = self.0.borrow();
            state.composite && state.reason.is_none() && !state.sources.is_empty() && size == 1
        };
        if keep {
            persist(&self.0);
        }
        ListenerId(id)
    }

    /// `removeEventListener('abort', listener)`: the first match in the
    /// current list; nothing when it is no longer there.
    pub fn remove_listener(&self, id: ListenerId) {
        let size = {
            let mut state = self.0.borrow_mut();
            let Some(root) = state.root else { return };
            let mut handler = state.nodes[&root].next;
            let mut found = false;
            while let Some(current) = handler {
                if current == id.0 {
                    found = true;
                    break;
                }
                handler = state.nodes[&current].next;
            }
            if !found {
                return;
            }
            state.unlink(id.0);
            let node = state.nodes.get_mut(&root).expect("the root");
            node.size -= 1;
            let size = node.size;
            if size == 0 {
                // `this[kEvents].delete(type)`.
                state.root = None;
                if state.dispatching {
                    state.unlinked.push(root);
                } else {
                    state.nodes.remove(&root);
                }
            }
            size
        };
        self.removed_listener(size);
    }

    /// `[kRemoveListener]`.
    fn removed_listener(&self, size: usize) {
        let release_it = {
            let state = self.0.borrow();
            state.composite && !state.sources.is_empty() && size == 0
        };
        if release_it {
            release(&self.0);
        }
    }

    /// The abort steps of one signal (`runAbort`): dispatches `abort`.
    fn dispatch(&self, reason: &W) {
        let first = {
            let mut state = self.0.borrow_mut();
            let Some(root) = state.root else { return };
            state.dispatching = true;
            (root, state.nodes[&root].next)
        };
        let (root, mut handler) = first;
        while let Some(current) = handler {
            let callback = {
                let mut state = self.0.borrow_mut();
                let node = &state.nodes[&current];
                // Cache the next in case this one removes the current.
                let next = node.next;
                if node.removed {
                    handler = next;
                    continue;
                }
                let once = node.once;
                if once {
                    state.unlink(current);
                    if let Some(root) = state.nodes.get_mut(&root) {
                        root.size -= 1;
                    }
                }
                handler = next;
                let size = state.nodes.get(&root).map_or(0, |root| root.size);
                let callback = state
                    .nodes
                    .get_mut(&current)
                    .and_then(|node| node.callback.take());
                (callback, once.then_some(size))
            };
            let (callback, removed) = callback;
            if let Some(size) = removed {
                self.removed_listener(size);
            }
            if let Some(callback) = callback {
                callback(reason);
            }
        }
        let mut state = self.0.borrow_mut();
        state.dispatching = false;
        state.collect();
    }

    /// `abortSignal(signal, reason)`.
    fn abort(&self, reason: W) {
        let dependants = {
            let mut state = self.0.borrow_mut();
            if state.reason.is_some() {
                return;
            }
            state.reason = Some(reason.clone());
            let mut aborting = Vec::new();
            for dependant in &state.dependants {
                let Some(dependant) = dependant.upgrade() else {
                    continue;
                };
                let mut dependant_state = dependant.borrow_mut();
                if dependant_state.reason.is_none() {
                    dependant_state.reason = Some(reason.clone());
                    drop(dependant_state);
                    aborting.push(Signal(dependant));
                }
            }
            state.dependants.clear();
            aborting
        };
        self.dispatch(&reason);
        for dependant in &dependants {
            dependant.dispatch(&reason);
            release(&dependant.0);
        }
        release(&self.0);
    }

    /// `AbortSignal.any(signals)`.
    pub fn any(signals: &[Signal]) -> Signal {
        let result = Signal::default();
        result.0.borrow_mut().composite = true;
        if signals.is_empty() {
            return result;
        }
        let mut sources: Vec<Rc<RefCell<State>>> = Vec::new();
        for signal in signals {
            let (reason, composite, nested) = {
                let state = signal.0.borrow();
                (state.reason.clone(), state.composite, state.sources.clone())
            };
            if let Some(reason) = reason {
                result.abort(reason);
                return result;
            }
            if !composite {
                if !sources.iter().any(|known| Rc::ptr_eq(known, &signal.0)) {
                    sources.push(signal.0.clone());
                }
                continue;
            }
            for source in nested.iter().filter_map(Weak::upgrade) {
                let aborted = source.borrow().reason.clone();
                if let Some(reason) = aborted {
                    result.abort(reason);
                    return result;
                }
                if !sources.iter().any(|known| Rc::ptr_eq(known, &source)) {
                    sources.push(source);
                }
            }
        }
        // `followCompositeSignal`: from its creation.
        let weak = Rc::downgrade(&result.0);
        for source in &sources {
            let mut state = source.borrow_mut();
            state.dependants.retain(|known| known.strong_count() > 0);
            state.dependants.push(weak.clone());
        }
        result.0.borrow_mut().sources = sources.iter().map(Rc::downgrade).collect();
        result
    }
}

/// An `AbortController`.
#[derive(Clone, Default)]
pub struct Controller {
    signal: Signal,
}

impl Controller {
    pub fn new() -> Controller {
        Controller::default()
    }

    pub fn signal(&self) -> Signal {
        self.signal.clone()
    }

    /// `controller.abort(reason)`.
    pub fn abort(&self, reason: W) {
        self.signal.abort(reason);
    }
}

/// Forgets the composites kept for their listeners (a loop replaced).
pub(crate) fn reset() {
    let kept = PERSISTENT.with(|kept| std::mem::take(&mut *kept.borrow_mut()));
    drop(kept);
}

/// How many composites the process keeps alive for their listeners (tests).
pub fn persistent_count() -> usize {
    PERSISTENT.with(|kept| kept.borrow().len())
}

/// How many listeners the signal's current list has (`root.size`).
pub fn listener_count(signal: &Signal) -> usize {
    let state = signal.0.borrow();
    state
        .root
        .and_then(|root| state.nodes.get(&root))
        .map_or(0, |root| root.size)
}

/// Counts the listener nodes a signal holds (tests: removed ones are freed).
pub fn node_count(signal: &Signal) -> usize {
    signal.0.borrow().nodes.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    type Log = Rc<RefCell<Vec<String>>>;

    fn listen(signal: &Signal, log: &Log, name: &'static str) -> ListenerId {
        let log = log.clone();
        signal.add_listener(move |reason| {
            log.borrow_mut().push(format!(
                "{name}:{}",
                crate::value::to_js_string(reason).to_string_lossy()
            ))
        })
    }

    #[test]
    fn listeners_run_once_in_order_and_a_second_abort_does_nothing() {
        let controller = Controller::new();
        let seen = Rc::new(RefCell::new(Vec::new()));
        for name in ["a", "b", "c"] {
            let seen = seen.clone();
            let id = controller
                .signal()
                .add_listener(move |_| seen.borrow_mut().push(name));
            if name == "b" {
                controller.signal().remove_listener(id);
            }
        }
        controller.abort(W::string("first"));
        controller.abort(W::string("second"));
        assert_eq!(*seen.borrow(), ["a", "c"]);
        assert!(
            matches!(controller.signal().throw_if_aborted(), Err(W::String(text)) if text == "first")
        );
    }

    /// The review's program (B1): `a` removes `b` and adds `late`; Node
    /// gives `a c late`.
    #[test]
    fn a_listener_removed_during_dispatch_is_skipped_and_one_added_runs() {
        let controller = Controller::new();
        let signal = controller.signal();
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        let b: Rc<Cell<Option<ListenerId>>> = Rc::new(Cell::new(None));
        {
            let (log, b, inner) = (log.clone(), b.clone(), signal.clone());
            signal.add_listener(move |_| {
                log.borrow_mut().push("a".into());
                if let Some(id) = b.get() {
                    inner.remove_listener(id);
                }
                let log = log.clone();
                inner.add_listener(move |_| log.borrow_mut().push("late".into()));
            });
        }
        b.set(Some(listen(&signal, &log, "b")));
        listen(&signal, &log, "c");
        controller.abort(W::string("r"));
        assert_eq!(*log.borrow(), ["a", "c:r", "late"]);
        assert_eq!(node_count(&signal), 1, "only the root is left");
    }

    /// A listener added by the last listener, or added after the list was
    /// emptied by removal, does not run in that dispatch.
    #[test]
    fn a_listener_added_by_the_last_or_into_a_new_list_does_not_run() {
        let controller = Controller::new();
        let signal = controller.signal();
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        {
            let (log, inner) = (log.clone(), signal.clone());
            signal.add_listener(move |_| {
                log.borrow_mut().push("last".into());
                let log = log.clone();
                inner.add_listener(move |_| log.borrow_mut().push("never".into()));
            });
        }
        controller.abort(W::Undefined);
        let other = Controller::new();
        let signal = other.signal();
        let b: Rc<Cell<Option<ListenerId>>> = Rc::new(Cell::new(None));
        let own: Rc<Cell<Option<ListenerId>>> = Rc::new(Cell::new(None));
        {
            let (log, b, mine, inner) = (log.clone(), b.clone(), own.clone(), signal.clone());
            let id = signal.add_listener_with(false, move |_| {
                log.borrow_mut().push("a".into());
                // Both removed: the root goes; `late` starts a new list.
                inner.remove_listener(mine.get().expect("a"));
                inner.remove_listener(b.get().expect("b"));
                let log = log.clone();
                inner.add_listener(move |_| log.borrow_mut().push("late".into()));
            });
            own.set(Some(id));
        }
        b.set(Some(listen(&signal, &log, "b")));
        other.abort(W::Undefined);
        assert_eq!(*log.borrow(), ["last", "a"]);
    }

    #[test]
    fn a_listener_added_after_the_abort_is_kept_and_never_called() {
        let controller = Controller::new();
        controller.abort(W::string("r"));
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        listen(&controller.signal(), &log, "late");
        controller.abort(W::string("again"));
        assert!(log.borrow().is_empty());
        assert!(matches!(controller.signal().reason(), W::String(text) if text == "r"));
    }

    /// `any`: dependents take the reason before the source's listeners run
    /// and dispatch after them; nested composites flatten; an aborted
    /// source gives an aborted signal.
    #[test]
    fn any_follows_its_sources_as_node_does() {
        let (a, b) = (Controller::new(), Controller::new());
        let combined = Signal::any(&[a.signal(), b.signal()]);
        let nested = Signal::any(&[combined.clone(), b.signal()]);
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        {
            let (log, combined) = (log.clone(), combined.clone());
            a.signal().add_listener(move |_| {
                log.borrow_mut()
                    .push(format!("a(any.aborted={})", combined.aborted()));
            });
        }
        listen(&combined, &log, "any");
        listen(&nested, &log, "nested");
        assert_eq!(persistent_count(), 2);
        a.abort(W::string("x"));
        b.abort(W::string("y"));
        assert_eq!(*log.borrow(), ["a(any.aborted=true)", "any:x", "nested:x"]);
        assert_eq!(persistent_count(), 0);
        let already = Signal::any(&[b.signal()]);
        assert!(matches!(already.reason(), W::String(text) if text == "y"));
        assert!(!Signal::any(&[]).aborted());
    }

    /// A composite with a listener lives on through its source alone, as
    /// Node keeps it; one without is held weakly.
    #[test]
    fn a_composite_with_a_listener_is_kept_alive_until_it_aborts() {
        let source = Controller::new();
        let log: Log = Rc::new(RefCell::new(Vec::new()));
        listen(&Signal::any(&[source.signal()]), &log, "kept");
        let unobserved = Rc::downgrade(&Signal::any(&[source.signal()]).0);
        assert!(unobserved.upgrade().is_none());
        source.abort(W::string("z"));
        assert_eq!(*log.borrow(), ["kept:z"]);
        assert_eq!(persistent_count(), 0);
    }
}
