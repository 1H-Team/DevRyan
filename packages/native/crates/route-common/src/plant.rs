//! Planted behaviour changes (test-only). With the `plants` feature, a group
//! candidate's `--plant <id>` switches on exactly one change: one of the
//! shared request path's ([`Plant`], [`ALL`]) or one of the group's own (the
//! group crate's table, handed to [`choose`]). The harness shows that a named
//! row catches each (scripts/backend-conformance/rust-plants.mjs). A build
//! without the feature has no `--plant` option and every switch is off.

use std::sync::OnceLock;

/// The shared path's planted changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plant {
    /// No ETag header.
    EtagDropped,
    /// The ETag header is written before Content-Type (the order across names).
    HeadersReordered,
    /// An extra `X-Powered-By: Express` header.
    ExtraHeader,
    /// `Content-Type: application/json` without the charset.
    ContentTypeNoCharset,
    /// A repeated key of a JSON body keeps its first value.
    DuplicateKeyFirstWins,
    /// A conditional GET whose ETag matches answers 200, never 304.
    NeverNotModified,
    /// Content-Length one more than the body.
    ContentLengthOffByOne,
    /// A brotli body is not decompressed (the body is left unparsed).
    BrotliUnsupported,
    /// The harness's sequence header is sent back on the answer.
    EnvelopeEchoed,
    /// HEAD answers with the body.
    HeadWithBody,
    /// A request whose body no parser reads takes its place in the order of writes when its body has arrived,
    /// not when its head has (the order before BH6's fix round 1).
    TicketsAtBodyEnd,
    /// A compressed request takes its place when its raw body has arrived, before it is inflated.
    CompressedTicketAtBodyEnd,
    /// Requests that become readable in one wake-up are taken in the order their connections were accepted.
    AcceptOrder,
    /// A gzip body's first member only is inflated.
    GzipFirstMemberOnly,
}

/// The shared switches by `--plant` id.
pub const ALL: &[(&str, Plant)] = &[
    ("etag-dropped", Plant::EtagDropped),
    ("headers-reordered", Plant::HeadersReordered),
    ("extra-header", Plant::ExtraHeader),
    ("content-type-no-charset", Plant::ContentTypeNoCharset),
    ("duplicate-key-first-wins", Plant::DuplicateKeyFirstWins),
    ("never-not-modified", Plant::NeverNotModified),
    ("content-length-off-by-one", Plant::ContentLengthOffByOne),
    ("brotli-unsupported", Plant::BrotliUnsupported),
    ("envelope-echoed", Plant::EnvelopeEchoed),
    ("head-with-body", Plant::HeadWithBody),
    ("tickets-at-body-end", Plant::TicketsAtBodyEnd),
    ("compressed-ticket-at-body-end", Plant::CompressedTicketAtBodyEnd),
    ("accept-order", Plant::AcceptOrder),
    ("gzip-first-member-only", Plant::GzipFirstMemberOnly),
];

static ACTIVE: OnceLock<&'static str> = OnceLock::new();

/// Chooses the plant (once, at start): a shared id, or one of `group` (the group crate's ids). Refused without
/// the `plants` feature.
pub fn choose(name: &str, group: &[&'static str]) -> Result<(), String> {
    if !cfg!(feature = "plants") {
        return Err("--plant needs a build with the plants feature".to_owned());
    }
    let id = ALL
        .iter()
        .map(|(id, _)| *id)
        .chain(group.iter().copied())
        .find(|id| *id == name)
        .ok_or_else(|| format!("unknown plant {name}"))?;
    ACTIVE.set(id).map_err(|_| "--plant given twice".to_owned())
}

/// The id switched on, if any (a group crate compares its own switches with it).
#[inline]
pub fn active() -> Option<&'static str> {
    if cfg!(feature = "plants") { ACTIVE.get().copied() } else { None }
}

/// Whether the change a group's table names `id` is switched on, read where the shared path implements it (the
/// independent review's plants of BH7, `rv-*`, which only the session-folders binary accepts).
#[inline]
pub fn named(id: &str) -> bool {
    cfg!(feature = "plants") && active() == Some(id)
}

/// Whether the shared change `plant` is switched on.
#[inline]
pub fn on(plant: Plant) -> bool {
    cfg!(feature = "plants") && active().is_some_and(|id| ALL.iter().any(|(name, which)| *which == plant && *name == id))
}

/// A lost-update plant's meeting point: a writer waits (up to a second) for a second writer, then both go on.
pub fn rendezvous() {
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;
    static WAITING: Mutex<u64> = Mutex::new(0);
    static ARRIVED: Condvar = Condvar::new();
    let mut generation = WAITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mine = *generation;
    *generation += 1;
    if mine % 2 == 1 {
        ARRIVED.notify_all();
        return;
    }
    let (mut generation, timeout) = ARRIVED
        .wait_timeout_while(generation, Duration::from_secs(1), |now| *now == mine + 1)
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if timeout.timed_out() {
        // Nobody came: the next writer waits again.
        *generation = mine + 2;
    }
}

type Deferred = Box<dyn FnOnce() + Send>;
static DEFERRED: std::sync::Mutex<Vec<Deferred>> = std::sync::Mutex::new(Vec::new());

/// An answered-before-durable plant: work kept for the next connection.
pub fn defer(work: Deferred) {
    DEFERRED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(work);
}

/// Runs what was deferred (a new connection arrived on the listen port).
pub fn run_deferred() {
    if !cfg!(feature = "plants") {
        return;
    }
    let work: Vec<Deferred> = std::mem::take(&mut *DEFERRED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
    for item in work {
        item();
    }
}
