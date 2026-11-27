//! The group's own planted behaviour changes (test-only). With the `plants`
//! feature, the command line's `--plant <id>` switches on exactly one change:
//! one of these, or one of the shared request path's
//! (devryan_route_common::plant). scripts/backend-conformance/rust-plants.mjs
//! names the row that must catch each. A build without the feature has no
//! `--plant` option and `on` is always false.

pub use devryan_route_common::plant::{defer, rendezvous, run_deferred};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plant {
    /// A validation failure answers 422 instead of 400.
    Status422,
    /// The body's version as the string "1".
    VersionString,
    /// `text is required.` instead of `text is required`.
    ErrorText,
    /// The data file ends with a newline.
    TrailingNewline,
    /// The data file is created with mode 0600.
    FileMode600,
    /// The data file's mode is set to 0644 after it is opened, the umask ignored (BH7 fix round 1, S4: equal to 0666
    /// masked under 022 only).
    ModeFixed644,
    /// The data file is written to a temporary file and renamed over.
    ReplacedNotInPlace,
    /// A temporary copy of the data file is written beside it and never removed.
    TemporaryLeftBehind,
    /// The state is answered but never written.
    MissingWrite,
    /// Writes do not take the lock: two writers read the same state.
    NoWriteLock,
    /// No write lock, and nothing that makes two writers meet (BH7 fix round 1, S1: only the scenario's timing
    /// makes them overlap).
    NoWriteLockPlain,
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
    /// Routes match their letter case exactly.
    CaseSensitiveRoutes,
    /// A read waits until every earlier write has finished (the JavaScript reads without the lock).
    GetWaitsForTurn,
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
}

pub const ALL: &[(&str, Plant)] = &[
    ("status-422", Plant::Status422),
    ("version-string", Plant::VersionString),
    ("error-text", Plant::ErrorText),
    ("trailing-newline", Plant::TrailingNewline),
    ("file-mode-600", Plant::FileMode600),
    ("mode-fixed-644", Plant::ModeFixed644),
    ("replaced-not-in-place", Plant::ReplacedNotInPlace),
    ("temporary-left-behind", Plant::TemporaryLeftBehind),
    ("missing-write", Plant::MissingWrite),
    ("no-write-lock", Plant::NoWriteLock),
    ("no-write-lock-plain", Plant::NoWriteLockPlain),
    ("id-limit-159", Plant::IdLimit159),
    ("text-limit-off-by-one", Plant::TextLimitOffByOne),
    ("lone-surrogate-rejected", Plant::LoneSurrogateRejected),
    ("stale-cache", Plant::StaleCache),
    ("answered-before-durable", Plant::AnsweredBeforeDurable),
    ("rust-error-text", Plant::RustErrorText),
    ("case-sensitive-routes", Plant::CaseSensitiveRoutes),
    ("get-waits-for-turn", Plant::GetWaitsForTurn),
    ("no-trim-delete", Plant::NoTrimDelete),
    ("visible-ascii-trim", Plant::VisibleAsciiTrim),
    ("proto-kept-on-read", Plant::ProtoKeptOnRead),
    ("no-mkdir", Plant::NoMkdir),
    ("read-bom-stripped", Plant::ReadBomStripped),
    ("length-in-utf8-bytes", Plant::LengthInUtf8Bytes),
];

/// The group's ids, for the shared `choose`.
pub fn ids() -> Vec<&'static str> {
    ALL.iter().map(|(id, _)| *id).collect()
}

/// Whether the group's change `plant` is switched on.
#[inline]
pub fn on(plant: Plant) -> bool {
    devryan_route_common::plant::active().is_some_and(|id| ALL.iter().any(|(name, which)| *which == plant && *name == id))
}
