//! Node's `EventEmitter` (`lib/events.js` of Node 24.22, Electron's), the
//! part a port reaches: `on`/`addListener`, `prependListener`, `once`,
//! `prependOnceListener`, `removeListener`/`off`, `removeAllListeners`,
//! `emit` and `listenerCount`. Emitters are synchronous: listeners run
//! inside `emit`, in its caller's job and async context frame, in
//! registration order.
//!
//! - `emit` calls the listeners registered when it starts: one added during
//!   the emit does not run in it, one removed during it still runs (Node
//!   copies a listener array that changes while it is emitted,
//!   `ensureMutableListenerArray`; this is the opposite of EventTarget's
//!   dispatch in `signal`).
//! - A throw out of a listener leaves `emit` at once: the later listeners
//!   do not run, and the caller gets the error.
//! - `once` wraps its listener: the wrapper removes itself, then calls it,
//!   and calls it at most once even when an emit inside it reaches it again.
//! - `removeListener` removes the most recently added match (searching from
//!   the end), a listener or a `once` wrapper of it.
//! - `emit('error', …)` with no `error` listener throws: the emitter's
//!   `unhandled` maker turns the arguments into the error (Node: the first
//!   argument when it is an `Error`, else `ERR_UNHANDLED_ERROR` with it as
//!   `context`).
//!
//! Left out because no site uses them (design file 32, section 2.3; the
//! ledger itself only calls `on`, and `once` on an unreachable path): the
//! `newListener` and `removeListener` events, `errorMonitor`,
//! `captureRejections`, `listeners`/`rawListeners`, `eventNames`, the
//! `events.once`/`events.on` helpers, and the max-listeners warning (a tick
//! that only writes to stderr: no job of it is observable). A listener for
//! `newListener` or `removeListener` panics where it is added: Node would
//! call it on every later addition or removal, which is not built, so a
//! port that needs it is refused loudly rather than run without it.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

type Call<A, E> = dyn Fn(&A) -> Result<(), E>;

/// A listener: a function with an identity (Node compares functions with
/// `===`). Clones are the same listener.
pub struct Listener<A: 'static, E: 'static>(Rc<Call<A, E>>);

impl<A: 'static, E: 'static> Clone for Listener<A, E> {
    fn clone(&self) -> Self {
        Listener(self.0.clone())
    }
}

impl<A: 'static, E: 'static> Listener<A, E> {
    pub fn new(call: impl Fn(&A) -> Result<(), E> + 'static) -> Listener<A, E> {
        Listener(Rc::new(call))
    }

    fn same(&self, other: &Listener<A, E>) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

/// `_onceWrap`'s wrapper: its listener, and whether it fired.
struct Once<A: 'static, E: 'static> {
    listener: Listener<A, E>,
    fired: Cell<bool>,
}

/// One entry of an event's listener array.
enum Entry<A: 'static, E: 'static> {
    Plain(Listener<A, E>),
    Once(Rc<Once<A, E>>),
}

impl<A: 'static, E: 'static> Clone for Entry<A, E> {
    fn clone(&self) -> Self {
        match self {
            Entry::Plain(listener) => Entry::Plain(listener.clone()),
            Entry::Once(once) => Entry::Once(once.clone()),
        }
    }
}

impl<A: 'static, E: 'static> Entry<A, E> {
    /// `list[i] === listener || list[i].listener === listener`.
    fn matches(&self, listener: &Listener<A, E>) -> bool {
        match self {
            Entry::Plain(own) => own.same(listener),
            Entry::Once(once) => once.listener.same(listener),
        }
    }
}

/// An event's listeners. An emit holds a clone of the `Rc`, so a change
/// during it copies the array (`Rc::make_mut`), as Node's does.
type Listeners<A, E> = Rc<Vec<Entry<A, E>>>;

struct Inner<A: 'static, E: 'static> {
    /// Events in the order their first listener was added.
    events: RefCell<Vec<(String, Listeners<A, E>)>>,
    unhandled: Box<dyn Fn(&A) -> E>,
}

/// An `EventEmitter` whose events carry `A` (a port's argument tuple or
/// struct) and whose listeners throw `E`. Clones are the same emitter.
pub struct Emitter<A: 'static, E: 'static>(Rc<Inner<A, E>>);

impl<A: 'static, E: 'static> Clone for Emitter<A, E> {
    fn clone(&self) -> Self {
        Emitter(self.0.clone())
    }
}

impl<A: 'static, E: 'static> Emitter<A, E> {
    /// `new EventEmitter()`; `unhandled` makes what `emit('error', args)`
    /// throws when no `error` listener is registered.
    pub fn new(unhandled: impl Fn(&A) -> E + 'static) -> Emitter<A, E> {
        Emitter(Rc::new(Inner {
            events: RefCell::new(Vec::new()),
            unhandled: Box::new(unhandled),
        }))
    }

    fn add(&self, event: &str, entry: Entry<A, E>, prepend: bool) {
        assert!(
            event != "newListener" && event != "removeListener",
            "the {event} event of an emitter is not built (a listener for it would never run)"
        );
        let mut events = self.0.events.borrow_mut();
        match events.iter_mut().find(|(name, _)| name == event) {
            Some((_, listeners)) => {
                let list = Rc::make_mut(listeners);
                if prepend {
                    list.insert(0, entry);
                } else {
                    list.push(entry);
                }
            }
            None => events.push((event.to_string(), Rc::new(vec![entry]))),
        }
    }

    /// `emitter.on(event, listener)` (`addListener`).
    pub fn on(&self, event: &str, listener: &Listener<A, E>) {
        self.add(event, Entry::Plain(listener.clone()), false);
    }

    /// `emitter.prependListener(event, listener)`.
    pub fn prepend_listener(&self, event: &str, listener: &Listener<A, E>) {
        self.add(event, Entry::Plain(listener.clone()), true);
    }

    fn once_entry(listener: &Listener<A, E>) -> Entry<A, E> {
        Entry::Once(Rc::new(Once {
            listener: listener.clone(),
            fired: Cell::new(false),
        }))
    }

    /// `emitter.once(event, listener)`.
    pub fn once(&self, event: &str, listener: &Listener<A, E>) {
        self.add(event, Emitter::once_entry(listener), false);
    }

    /// `emitter.prependOnceListener(event, listener)`.
    pub fn prepend_once_listener(&self, event: &str, listener: &Listener<A, E>) {
        self.add(event, Emitter::once_entry(listener), true);
    }

    /// Removes the last entry `matches` accepts; deletes the event when it
    /// was the last.
    fn remove_where(&self, event: &str, matches: impl Fn(&Entry<A, E>) -> bool) {
        let mut events = self.0.events.borrow_mut();
        let Some(index) = events.iter().position(|(name, _)| name == event) else {
            return;
        };
        let listeners = &mut events[index].1;
        let Some(position) = listeners.iter().rposition(matches) else {
            return;
        };
        // Removed after the borrow ends: a listener's drop may reach this
        // emitter.
        let removed = Rc::make_mut(listeners).remove(position);
        if listeners.is_empty() {
            let gone = events.remove(index);
            drop(events);
            drop(gone);
        } else {
            drop(events);
        }
        drop(removed);
    }

    /// `emitter.removeListener(event, listener)` (`off`).
    pub fn remove_listener(&self, event: &str, listener: &Listener<A, E>) {
        self.remove_where(event, |entry| entry.matches(listener));
    }

    /// `emitter.removeAllListeners(event)`, or of every event for `None`.
    pub fn remove_all_listeners(&self, event: Option<&str>) {
        let gone = {
            let mut events = self.0.events.borrow_mut();
            match event {
                None => std::mem::take(&mut *events),
                Some(event) => match events.iter().position(|(name, _)| name == event) {
                    Some(index) => vec![events.remove(index)],
                    None => Vec::new(),
                },
            }
        };
        drop(gone);
    }

    /// `emitter.listenerCount(event)`.
    pub fn listener_count(&self, event: &str) -> usize {
        self.0
            .events
            .borrow()
            .iter()
            .find(|(name, _)| name == event)
            .map_or(0, |(_, listeners)| listeners.len())
    }

    /// `emitter.emit(event, args)`: whether it had listeners, or what a
    /// listener threw (or the unhandled `error`).
    pub fn emit(&self, event: &str, args: &A) -> Result<bool, E> {
        let listeners = self
            .0
            .events
            .borrow()
            .iter()
            .find(|(name, _)| name == event)
            .map(|(_, listeners)| listeners.clone());
        let Some(listeners) = listeners else {
            if event == "error" {
                return Err((self.0.unhandled)(args));
            }
            return Ok(false);
        };
        for entry in listeners.iter() {
            match entry {
                Entry::Plain(listener) => (listener.0)(args)?,
                Entry::Once(once) => {
                    // The wrapper: at most once, removed before the call.
                    if once.fired.replace(true) {
                        continue;
                    }
                    self.remove_where(
                        event,
                        |entry| matches!(entry, Entry::Once(own) if Rc::ptr_eq(own, once)),
                    );
                    (once.listener.0)(args)?;
                }
            }
        }
        Ok(true)
    }

    /// A handle that does not keep the emitter alive (for a listener that
    /// refers to its own emitter: an `Rc` cycle JavaScript's collector would
    /// free).
    pub fn downgrade(&self) -> WeakEmitter<A, E> {
        WeakEmitter(Rc::downgrade(&self.0))
    }
}

/// A weak handle on an emitter.
pub struct WeakEmitter<A: 'static, E: 'static>(Weak<Inner<A, E>>);

impl<A: 'static, E: 'static> WeakEmitter<A, E> {
    pub fn upgrade(&self) -> Option<Emitter<A, E>> {
        self.0.upgrade().map(Emitter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Log = Rc<RefCell<Vec<String>>>;

    /// The `newListener` and `removeListener` events are not built: a
    /// listener for either is refused where it is added.
    #[test]
    #[should_panic(expected = "the newListener event of an emitter is not built")]
    fn a_new_listener_listener_is_refused() {
        let emitter = Emitter::<u32, String>::new(|_| String::new());
        emitter.once("newListener", &Listener::new(|_: &u32| Ok(())));
    }

    #[test]
    #[should_panic(expected = "the removeListener event of an emitter is not built")]
    fn a_remove_listener_listener_is_refused() {
        let emitter = Emitter::<u32, String>::new(|_| String::new());
        emitter.on("removeListener", &Listener::new(|_: &u32| Ok(())));
    }

    fn logging(log: &Log, name: &'static str) -> Listener<u32, String> {
        let log = log.clone();
        Listener::new(move |value: &u32| {
            log.borrow_mut().push(format!("{name}:{value}"));
            Ok(())
        })
    }

    fn emitter() -> Emitter<u32, String> {
        Emitter::new(|value: &u32| format!("unhandled:{value}"))
    }

    /// The same listener added twice runs twice; removing it removes the
    /// last one added; a once wrapper of it is removed by it too.
    #[test]
    fn remove_listener_takes_the_last_match_and_once_wrappers() {
        let log: Log = Rc::default();
        let events = emitter();
        let (a, b) = (logging(&log, "a"), logging(&log, "b"));
        events.on("x", &a);
        events.on("x", &b);
        events.once("x", &a);
        assert_eq!(events.listener_count("x"), 3);
        events.remove_listener("x", &a);
        assert_eq!(events.listener_count("x"), 2);
        assert_eq!(events.emit("x", &1), Ok(true));
        events.remove_listener("x", &a);
        events.remove_listener("x", &b);
        assert_eq!(events.listener_count("x"), 0);
        assert_eq!(events.emit("x", &2), Ok(false));
        assert_eq!(*log.borrow(), ["a:1", "b:1"]);
        assert_eq!(events.emit("error", &3), Err("unhandled:3".to_string()));
    }

    /// A once listener reached again by an emit inside itself runs once.
    #[test]
    fn a_once_listener_emitted_from_inside_itself_runs_once() {
        let log: Log = Rc::default();
        let events = emitter();
        let weak = events.downgrade();
        let inner = log.clone();
        let reentrant = Listener::new(move |value: &u32| {
            inner.borrow_mut().push(format!("once:{value}"));
            if let Some(events) = weak.upgrade() {
                events.emit("x", &(value + 1))?;
            }
            Ok(())
        });
        events.once("x", &reentrant);
        events.on("x", &logging(&log, "after"));
        assert_eq!(events.emit("x", &1), Ok(true));
        assert_eq!(*log.borrow(), ["once:1", "after:2", "after:1"]);
    }
}
