//! The group's own planted behaviour changes (test-only); the shared request path's are in
//! devryan_route_common::plant. scripts/backend-conformance/rust-plants.mjs names the row that must catch each.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plant {
    /// A body that is not an object answers 422.
    Status422,
    /// `Body must be an object.` instead of `Body must be an object`.
    ErrorText,
    /// A document of exactly 4 MiB is refused.
    LimitOffByOne,
    /// The limit counts UTF-16 units instead of UTF-8 bytes.
    LimitInUtf16Units,
    /// The file ends with a newline.
    TrailingNewline,
    /// The file is indented by 4 spaces.
    Indent4,
    /// The file is created with mode 0600.
    FileMode600,
    /// The file is written in place (no temporary file, no rename).
    WrittenInPlace,
    /// A failed save leaves its temporary file.
    TemporaryLeftBehind,
    /// The temporary file's name has no pid.
    TemporaryNameWithoutPid,
    /// Every save uses one temporary name (`<file>.tmp`, the defect fixed in a71afdbc).
    SharedTemporaryName,
    /// Stale temporary files are never removed.
    NoCleanup,
    /// The cleanup removes links whose names match too.
    CleanupFollowsLinks,
    /// The cleanup removes every matching file, fresh ones too.
    CleanupIgnoresAge,
    /// The cleanup runs after the rename (a save that fails cleans nothing).
    CleanupAfterWrite,
    /// The save is answered but never written.
    MissingWrite,
    /// A save is answered first and written when the next connection arrives.
    AnsweredBeforeDurable,
    /// A read waits until every earlier save has finished.
    GetWaitsForTurn,
    /// The document read first is kept: later edits of the file are not seen.
    StaleCache,
    /// Routes match their letter case exactly.
    CaseSensitiveRoutes,
    /// A byte-order mark at the start of the file is dropped when it is read.
    ReadBomStripped,
    /// Each ill-formed byte of the file is its own U+FFFD (not the maximal subpart).
    ReplacementPerByte,
    /// A lone surrogate is written raw, not escaped.
    LoneSurrogateRaw,
    /// Array-index keys keep their place instead of coming first.
    IndexKeysInPlace,
    /// A repeated key moves to its last place.
    DuplicateKeyLastPlace,
    /// A `__proto__` key is dropped.
    ProtoDropped,
    /// `-0` is written `-0`.
    NegativeZeroKept,
    /// A failed save answers Rust's error text instead of Node's.
    RustErrorText,
    /// A read that fails answers the empty document instead of 500.
    ReadErrorsAsEmpty,
    /// Values nested beyond 100 levels are taken for V8's stack overflow.
    DepthLimit100,
    /// A form's sparse arrays keep their holes (as null).
    FormHolesKept,
    /// An empty JSON body is refused.
    EmptyJsonRefused,
    // The independent review's plants (BH7 fix round 1, `rv-*`): the group's own here, the shared path's read by id
    // where the shared crate implements them (`devryan_route_common::plant::named`).
    /// The empty document's keys in another order.
    RvEmptyDocOrder,
    /// A read error's text without its path.
    RvGetTextNoPath,
    /// A link loop at the file's path read as no file.
    RvGetLoopEmpty,
    /// The temporary file in a folder below the data root.
    RvTmpInSubdir,
    /// The temporary file in the OS temp dir.
    RvTmpInOsTmpdir,
    /// The file created with mode 0640.
    RvModeSix40,
    /// The data file's folder is not made.
    RvNoMkdir,
    /// The cleanup also runs one folder down.
    RvCleanupRecurses,
    /// A GET runs the cleanup.
    RvCleanupOnGet,
    /// A GET's body ends with a newline.
    RvGetTrailingNewline,
    /// A GET answers the document indented.
    RvGetPretty,
    /// A GET of a file that holds no object answers the empty document.
    RvGetNonObjectEmpty,
    /// A GET answers the file's bytes as they stand when they parse.
    RvGetRawBytes,
    /// An array body is stored.
    RvPostAcceptsArray,
    /// An array over 4 MiB answers 413, not 400.
    RvSizeBeforeType,
    /// The 4 MiB limit does not count newlines.
    RvLimitIgnoresNewlines,
    /// The success answer has an extra key.
    RvSuccessExtraKey,
    /// A failed save's text under `message`, not `error`.
    RvErrorKeyMessage,
    /// Saves do not wait their turn.
    RvNoSaveLock,
    /// A save through a link replaces the link's target.
    RvRenameThroughLink,
    /// A rename's text without `-> 'to'` (shared path).
    RvRenameTextFromOnly,
    /// The temporary name's UUID is version 7 (shared path).
    RvUuidV7,
    /// One UUID for every save (shared path).
    RvUuidConstant,
    /// The file's mode set to 0644, the umask ignored (shared path).
    RvModeFixedSix44,
    /// The cleanup keeps a file exactly a day old (shared path).
    RvCleanupBoundaryStrict,
    /// The cleanup goes on after a refused removal (shared path).
    RvCleanupContinues,
    /// The cleanup removes folders (shared path).
    RvCleanupRemovesDirs,
    /// The cleanup's prefix without its dash (shared path).
    RvCleanupPrefixNoDash,
    /// The cleanup ages files by ctime (shared path).
    RvCleanupUsesCtime,
    /// The cleanup takes any name holding `.tmp-` (shared path).
    RvCleanupAnyFilePrefix,
    /// A read refuses links (shared path).
    RvReadNofollow,
    /// DEL escaped where a string is written again (shared path).
    RvEscapeDel,
    /// U+2028 and U+2029 escaped where a string is written again (shared path).
    RvEscapeLs,
    /// The one pass copies a number in a container as written (shared path).
    RvTranscodeNestedNumberRaw,
    /// The one pass copies an escaped string in a container as written (shared path).
    RvTranscodeEscapeRaw,
    /// `"01"` taken for an array index (shared path).
    RvIndexKeyZero1,
    /// `4294967295` taken for an array index (shared path).
    RvIndexKeyMax,
    /// The one pass copies integers of any length (shared path).
    RvCanonicalIntegerAnyLength,
    /// A form's digit texts stored as numbers (shared path).
    RvFormNumberCoerce,
    /// A UTF-16 body's byte-order mark kept (shared path).
    RvBomKept,
    /// The form parameter limit one higher (shared path).
    RvParamLimit10zero1,
    /// Chunk extensions refused (shared path).
    RvChunkExtRefused,
}

pub const ALL: &[(&str, Plant)] = &[
    ("status-422", Plant::Status422),
    ("error-text", Plant::ErrorText),
    ("limit-off-by-one", Plant::LimitOffByOne),
    ("limit-in-utf16-units", Plant::LimitInUtf16Units),
    ("trailing-newline", Plant::TrailingNewline),
    ("indent-4", Plant::Indent4),
    ("file-mode-600", Plant::FileMode600),
    ("written-in-place", Plant::WrittenInPlace),
    ("temporary-left-behind", Plant::TemporaryLeftBehind),
    ("temporary-name-without-pid", Plant::TemporaryNameWithoutPid),
    ("shared-temporary-name", Plant::SharedTemporaryName),
    ("no-cleanup", Plant::NoCleanup),
    ("cleanup-follows-links", Plant::CleanupFollowsLinks),
    ("cleanup-ignores-age", Plant::CleanupIgnoresAge),
    ("cleanup-after-write", Plant::CleanupAfterWrite),
    ("missing-write", Plant::MissingWrite),
    ("answered-before-durable", Plant::AnsweredBeforeDurable),
    ("get-waits-for-turn", Plant::GetWaitsForTurn),
    ("stale-cache", Plant::StaleCache),
    ("case-sensitive-routes", Plant::CaseSensitiveRoutes),
    ("read-bom-stripped", Plant::ReadBomStripped),
    ("replacement-per-byte", Plant::ReplacementPerByte),
    ("lone-surrogate-raw", Plant::LoneSurrogateRaw),
    ("index-keys-in-place", Plant::IndexKeysInPlace),
    ("duplicate-key-last-place", Plant::DuplicateKeyLastPlace),
    ("proto-dropped", Plant::ProtoDropped),
    ("negative-zero-kept", Plant::NegativeZeroKept),
    ("rust-error-text", Plant::RustErrorText),
    ("read-errors-as-empty", Plant::ReadErrorsAsEmpty),
    ("depth-limit-100", Plant::DepthLimit100),
    ("form-holes-kept", Plant::FormHolesKept),
    ("empty-json-refused", Plant::EmptyJsonRefused),
    ("rv-empty-doc-order", Plant::RvEmptyDocOrder),
    ("rv-get-text-no-path", Plant::RvGetTextNoPath),
    ("rv-get-loop-empty", Plant::RvGetLoopEmpty),
    ("rv-tmp-in-subdir", Plant::RvTmpInSubdir),
    ("rv-tmp-in-os-tmpdir", Plant::RvTmpInOsTmpdir),
    ("rv-mode-640", Plant::RvModeSix40),
    ("rv-no-mkdir", Plant::RvNoMkdir),
    ("rv-cleanup-recurses", Plant::RvCleanupRecurses),
    ("rv-cleanup-on-get", Plant::RvCleanupOnGet),
    ("rv-get-trailing-newline", Plant::RvGetTrailingNewline),
    ("rv-get-pretty", Plant::RvGetPretty),
    ("rv-get-non-object-empty", Plant::RvGetNonObjectEmpty),
    ("rv-get-raw-bytes", Plant::RvGetRawBytes),
    ("rv-post-accepts-array", Plant::RvPostAcceptsArray),
    ("rv-size-before-type", Plant::RvSizeBeforeType),
    ("rv-limit-ignores-newlines", Plant::RvLimitIgnoresNewlines),
    ("rv-success-extra-key", Plant::RvSuccessExtraKey),
    ("rv-error-key-message", Plant::RvErrorKeyMessage),
    ("rv-no-save-lock", Plant::RvNoSaveLock),
    ("rv-rename-through-link", Plant::RvRenameThroughLink),
    ("rv-rename-text-from-only", Plant::RvRenameTextFromOnly),
    ("rv-uuid-v7", Plant::RvUuidV7),
    ("rv-uuid-constant", Plant::RvUuidConstant),
    ("rv-mode-fixed-644", Plant::RvModeFixedSix44),
    ("rv-cleanup-boundary-strict", Plant::RvCleanupBoundaryStrict),
    ("rv-cleanup-continues", Plant::RvCleanupContinues),
    ("rv-cleanup-removes-dirs", Plant::RvCleanupRemovesDirs),
    ("rv-cleanup-prefix-no-dash", Plant::RvCleanupPrefixNoDash),
    ("rv-cleanup-uses-ctime", Plant::RvCleanupUsesCtime),
    ("rv-cleanup-any-file-prefix", Plant::RvCleanupAnyFilePrefix),
    ("rv-read-nofollow", Plant::RvReadNofollow),
    ("rv-escape-del", Plant::RvEscapeDel),
    ("rv-escape-2028", Plant::RvEscapeLs),
    ("rv-transcode-nested-number-raw", Plant::RvTranscodeNestedNumberRaw),
    ("rv-transcode-escape-raw", Plant::RvTranscodeEscapeRaw),
    ("rv-index-key-01", Plant::RvIndexKeyZero1),
    ("rv-index-key-max", Plant::RvIndexKeyMax),
    ("rv-canonical-integer-any-length", Plant::RvCanonicalIntegerAnyLength),
    ("rv-form-number-coerce", Plant::RvFormNumberCoerce),
    ("rv-bom-kept", Plant::RvBomKept),
    ("rv-param-limit-1001", Plant::RvParamLimit10zero1),
    ("rv-chunk-ext-refused", Plant::RvChunkExtRefused),
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
