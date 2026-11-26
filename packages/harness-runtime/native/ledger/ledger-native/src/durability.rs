//! `lib/object-durability.js` off Windows (plan package L3b, the default
//! `syncObjects` of the store): content objects linked into
//! `<root>/objects` become durable as one directory sync before the next
//! ledger commit under that root. Process-wide, as the JavaScript's module
//! state. Nothing in the product calls it yet.
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use crate::WPromise;
use crate::host;
use crate::js::{Promise, Resolution, async_fn};
use crate::node::fs::{self as nfs, Flags};
use crate::node::odb;
use crate::value::W;

thread_local! {
    static PENDING: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    static RUNNING: RefCell<HashMap<String, WPromise>> = RefCell::new(HashMap::new());
    static SYNC_STARTED: RefCell<HashMap<String, f64>> = RefCell::new(HashMap::new());
}

const CTIME_SLACK_MS: f64 = 1_000.0;

/// `markObjectDirectoryPending(directory)`.
pub fn mark_object_directory_pending(directory: &str) {
    PENDING.with(|pending| pending.borrow_mut().insert(directory.to_owned()));
}

/// `markObjectIfUnsynced(directory, ctimeMs)`.
pub fn mark_object_if_unsynced(directory: &str, ctime_ms: f64) {
    let started =
        SYNC_STARTED.with(|started| started.borrow().get(directory).copied().unwrap_or(0.0));
    if ctime_ms >= started - CTIME_SLACK_MS {
        mark_object_directory_pending(directory);
    }
}

/// `syncPendingObjectDirectory(root)`: an async function.
pub fn sync_pending_object_directory(root: &str) -> WPromise {
    let directory = odb::join(&[root, "objects"]);
    async_fn(async move {
        loop {
            let current = RUNNING.with(|running| running.borrow().get(&directory).cloned());
            if let Some(current) = current {
                let _ = current.catch(|_| Ok(Resolution::Value(W::Undefined))).await;
                continue;
            }
            if !PENDING.with(|pending| pending.borrow().contains(&directory)) {
                return Ok(Resolution::Value(W::Undefined));
            }
            PENDING.with(|pending| pending.borrow_mut().remove(&directory));
            SYNC_STARTED
                .with(|started| started.borrow_mut().insert(directory.clone(), host::now()));
            let work: WPromise = {
                let directory = directory.clone();
                async_fn(async move {
                    let handle = nfs::open(&directory, Flags::Str("r"), None).await?;
                    // The durability tests' seams (nothing, in the product).
                    crate::seams::durability_opened(&directory);
                    let body = handle.sync().await;
                    let body = crate::seams::durability_outcome("sync", &directory, body);
                    let closed = handle.close().await;
                    let closed = crate::seams::durability_outcome("close", &directory, closed);
                    closed?;
                    body?;
                    Ok(Resolution::Value(W::Undefined))
                })
            };
            RUNNING.with(|running| running.borrow_mut().insert(directory.clone(), work.clone()));
            let outcome = work.clone().await;
            if outcome.is_err() {
                mark_object_directory_pending(&directory);
            }
            // `finally`
            RUNNING.with(|running| {
                let mut running = running.borrow_mut();
                if running
                    .get(&directory)
                    .is_some_and(|known| same(known, &work))
                {
                    running.remove(&directory);
                }
            });
            outcome?;
            return Ok(Resolution::Value(W::Undefined));
        }
    })
}

fn same(left: &WPromise, right: &WPromise) -> bool {
    Promise::same(left, right)
}
