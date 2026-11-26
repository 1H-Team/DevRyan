//! Planted behaviour changes (test-only): with the `plants` feature, the
//! command line's `--plant <id>` switches on exactly one of them, so the
//! harness can be shown to catch each (scripts/backend-conformance/rust-plants.mjs
//! names the row that must catch it). A build without the feature has no
//! `--plant` option and `on` is always false.

use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plant {
    /// A validation failure answers 422 instead of 400.
    Status422,
    /// No ETag header.
    EtagDropped,
    /// The ETag header is written before Content-Type (the order across names).
    HeadersReordered,
    /// An extra `X-Powered-By: Express` header.
    ExtraHeader,
    /// `Content-Type: application/json` without the charset.
    ContentTypeNoCharset,
    /// The body's version as the string "1".
    VersionString,
    /// `text is required.` instead of `text is required`.
    ErrorText,
    /// The data file ends with a newline.
    TrailingNewline,
    /// The data file is created with mode 0600.
    FileMode600,
    /// The data file is written to a temporary file and renamed over.
    ReplacedNotInPlace,
    /// A temporary copy of the data file is written beside it and never removed.
    TemporaryLeftBehind,
    /// The state is answered but never written.
    MissingWrite,
    /// Writes do not take the lock: two writers read the same state.
    NoWriteLock,
    /// Ids may be 159 characters at most.
    IdLimit159,
    /// Text of exactly 200 000 characters is refused.
    TextLimitOffByOne,
    /// A text holding a lone surrogate is refused with 400.
    LoneSurrogateRejected,
    /// The state read first is kept in memory: later edits of the file are not seen.
    StaleCache,
    /// A write is answered first and made when the next connection arrives.
    AnsweredBeforeDurable,
    /// A failed write answers Rust's error text instead of Node's.
    RustErrorText,
    /// A repeated key of the JSON body keeps its first value.
    DuplicateKeyFirstWins,
    /// Routes match their letter case exactly.
    CaseSensitiveRoutes,
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
    /// A read waits until every earlier write has finished (the JavaScript reads without the lock).
    GetWaitsForTurn,
    /// A request whose body no parser reads takes its place in the order of writes when its body has arrived,
    /// not when its head has (the order before fix round 1).
    TicketsAtBodyEnd,
    /// A compressed request takes its place when its raw body has arrived, before it is inflated.
    CompressedTicketAtBodyEnd,
    /// Requests that become readable in one wake-up are taken in the order their connections were accepted.
    AcceptOrder,
    /// A DELETE of one id does not trim the id.
    NoTrimDelete,
    /// The visible-text check trims ASCII whitespace only.
    VisibleAsciiTrim,
    /// A `__proto__` key of the data file is kept when it is read.
    ProtoKeptOnRead,
    /// The data root is not created before a write.
    NoMkdir,
    /// A byte-order mark at the start of the data file is dropped when it is read.
    ReadBomStripped,
    /// The text limit counts UTF-8 bytes instead of UTF-16 units.
    LengthInUtf8Bytes,
    /// A gzip body's first member only is inflated.
    GzipFirstMemberOnly,
}

pub const ALL: &[(&str, Plant)] = &[
    ("status-422", Plant::Status422),
    ("etag-dropped", Plant::EtagDropped),
    ("headers-reordered", Plant::HeadersReordered),
    ("extra-header", Plant::ExtraHeader),
    ("content-type-no-charset", Plant::ContentTypeNoCharset),
    ("version-string", Plant::VersionString),
    ("error-text", Plant::ErrorText),
    ("trailing-newline", Plant::TrailingNewline),
    ("file-mode-600", Plant::FileMode600),
    ("replaced-not-in-place", Plant::ReplacedNotInPlace),
    ("temporary-left-behind", Plant::TemporaryLeftBehind),
    ("missing-write", Plant::MissingWrite),
    ("no-write-lock", Plant::NoWriteLock),
    ("id-limit-159", Plant::IdLimit159),
    ("text-limit-off-by-one", Plant::TextLimitOffByOne),
    ("lone-surrogate-rejected", Plant::LoneSurrogateRejected),
    ("stale-cache", Plant::StaleCache),
    ("answered-before-durable", Plant::AnsweredBeforeDurable),
    ("rust-error-text", Plant::RustErrorText),
    ("duplicate-key-first-wins", Plant::DuplicateKeyFirstWins),
    ("case-sensitive-routes", Plant::CaseSensitiveRoutes),
    ("never-not-modified", Plant::NeverNotModified),
    ("content-length-off-by-one", Plant::ContentLengthOffByOne),
    ("brotli-unsupported", Plant::BrotliUnsupported),
    ("envelope-echoed", Plant::EnvelopeEchoed),
    ("head-with-body", Plant::HeadWithBody),
    ("get-waits-for-turn", Plant::GetWaitsForTurn),
    ("tickets-at-body-end", Plant::TicketsAtBodyEnd),
    ("compressed-ticket-at-body-end", Plant::CompressedTicketAtBodyEnd),
    ("accept-order", Plant::AcceptOrder),
    ("no-trim-delete", Plant::NoTrimDelete),
    ("visible-ascii-trim", Plant::VisibleAsciiTrim),
    ("proto-kept-on-read", Plant::ProtoKeptOnRead),
    ("no-mkdir", Plant::NoMkdir),
    ("read-bom-stripped", Plant::ReadBomStripped),
    ("length-in-utf8-bytes", Plant::LengthInUtf8Bytes),
    ("gzip-first-member-only", Plant::GzipFirstMemberOnly),
];

static ACTIVE: OnceLock<Option<Plant>> = OnceLock::new();

/// Chooses the plant (once, at start). Refused without the `plants` feature.
pub fn choose(name: &str) -> Result<(), String> {
    if !cfg!(feature = "plants") {
        return Err("--plant needs a build with the plants feature".to_owned());
    }
    let plant = ALL
        .iter()
        .find(|(id, _)| *id == name)
        .map(|(_, plant)| *plant)
        .ok_or_else(|| format!("unknown plant {name}"))?;
    ACTIVE.set(Some(plant)).map_err(|_| "--plant given twice".to_owned())
}

/// Whether `plant` is switched on.
#[inline]
pub fn on(plant: Plant) -> bool {
    cfg!(feature = "plants") && ACTIVE.get().copied().flatten() == Some(plant)
}

/// The no-write-lock plant's meeting point: a writer waits (up to a second) for a second writer, then both go on.
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

/// The answered-before-durable plant: work kept for the next connection.
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
