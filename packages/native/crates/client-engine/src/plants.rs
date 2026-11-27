//! Every planted difference the families' sources hold (`plant::on` sites),
//! by family, with the change it makes. The runner refuses any other name,
//! and a test checks this list against the sources.

use crate::plant::Plant;

const fn plant(id: &'static str, family: &'static str, change: &'static str) -> Plant {
    Plant { id, family, change }
}

pub const PLANTS: &[Plant] = &[
    plant("native-cursor-text-array-is-record", "native-cursor-text", "an array counts as a record"),
    plant(
        "native-cursor-text-reasoning-dropped",
        "native-cursor-text",
        "a reasoning part never has provenance",
    ),
    plant(
        "native-cursor-text-id-unchecked",
        "native-cursor-text",
        "a part id that is no string passes the first check",
    ),
    plant(
        "native-cursor-text-state-swapped",
        "native-cursor-text",
        "text parts read the metadata, reasoning parts providerState",
    ),
    plant(
        "native-cursor-text-missing-namespace-true",
        "native-cursor-text",
        "a state without a devryan record has provenance",
    ),
    plant(
        "native-cursor-text-wrong-namespace",
        "native-cursor-text",
        "the cursor record is read from devryan.native",
    ),
    plant(
        "native-cursor-text-missing-cursor-true",
        "native-cursor-text",
        "a devryan record without a cursor record has provenance",
    ),
    plant(
        "native-cursor-text-owner-key",
        "native-cursor-text",
        "the owner is read from cursor.id, not cursor.partID",
    ),
    plant("native-cursor-text-any-string-owner", "native-cursor-text", "any string owner matches"),
    plant("native-cursor-text-negated", "native-cursor-text", "the owner comparison is negated"),
    plant("tool-status-no-lowercase", "tool-status", "the status is not lower-cased"),
    plant("tool-status-hyphen-kept", "tool-status", "hyphens are kept"),
    plant("tool-status-underscore-kept", "tool-status", "underscores are kept"),
    plant("tool-status-empty-kept", "tool-status", "an empty normalized status is returned as \"\""),
    plant("tool-status-pending-not-active", "tool-status", "pending is not an active status"),
    plant("tool-status-canceled-not-final", "tool-status", "canceled is not a final status"),
    plant("tool-status-infinite-timestamp", "tool-status", "an infinite time counts as a timestamp"),
    plant("tool-status-range-inclusive", "tool-status", "an end equal to the start is an invalid range"),
    plant("tool-status-unknown-not-in-flight", "tool-status", "an unknown status is not in flight"),
    plant(
        "tool-status-finalized-ignores-range",
        "tool-status",
        "an invalid time range does not prevent finalization",
    ),
    plant("sanitize-patch-kept", "sanitize", "the patch field is not stripped"),
    plant("sanitize-holes-filled", "sanitize", "a hole in diffs becomes undefined"),
    plant("sanitize-falsy-entry-object", "sanitize", "a falsy diff entry becomes an empty object"),
    plant("sanitize-non-string-stripped", "sanitize", "a content field is stripped whatever its type"),
    plant("sanitize-strip-in-place", "sanitize", "the entry is stripped in place, not copied"),
    plant("sanitize-first-field-only", "sanitize", "only the first content field of an entry is stripped"),
    plant("sanitize-always-copies", "sanitize", "the target is copied even when nothing was stripped"),
    plant("sanitize-summary-shared", "sanitize", "the original summary gets the stripped diffs"),
    plant("sanitize-summary-key-last", "sanitize", "the summary member moves last in the copy"),
    plant("sanitize-result-prototype-less", "sanitize", "the copy has no prototype"),
    plant("tool-output-status-done", "tool-output", "a completed tool part is one whose status is done"),
    plant("tool-output-truthy-marker", "tool-output", "any truthy outputOmitted marks the output omitted"),
    plant("tool-output-negative-bytes", "tool-output", "a negative byte count is returned"),
    plant("tool-output-ids-unchecked", "tool-output", "keepFullToolOutput does not compare the part ids"),
    plant("tool-output-bytes-kept", "tool-output", "the restored state keeps outputBytes"),
    plant(
        "tool-output-metadata-dropped",
        "tool-output",
        "the restored state does not take the existing metadata",
    ),
    plant(
        "tool-output-never-keeps-existing",
        "tool-output",
        "an equal restored part is returned instead of the existing one",
    ),
    plant(
        "tool-output-first-loaded-wins",
        "tool-output",
        "the first loaded part of an id wins, not the last",
    ),
    plant(
        "tool-output-any-loaded",
        "tool-output",
        "a loaded part replaces the omitted one even when it is not a full output",
    ),
    plant(
        "tool-output-always-copies",
        "tool-output",
        "mergeLoadedToolOutput copies the list even when nothing was restored",
    ),
    plant("message-order-infinite-time", "message-order", "an infinite created time is used, not 0"),
    plant("message-order-ids-reversed", "message-order", "ids break ties in descending order"),
    plant("message-order-ids-ignored", "message-order", "ids do not break ties"),
    plant("message-order-sort-unstable", "message-order", "equal messages come out in reverse order"),
    plant(
        "message-order-insert-before-equal",
        "message-order",
        "an inserted message goes before its equals",
    ),
    plant("message-order-find-last", "message-order", "findMessageIndex returns the last match"),
    plant(
        "message-order-before-copies",
        "message-order",
        "messagesBefore copies the list when the marker is missing",
    ),
    plant("message-order-before-includes-marker", "message-order", "messagesBefore includes the marker"),
    plant(
        "message-order-from-missing-keeps-all",
        "message-order",
        "messagesFrom returns every message when the marker is missing",
    ),
    plant("message-order-from-excludes-marker", "message-order", "messagesFrom leaves the marker out"),
    plant("session-diff-stats-negative-kept", "session-diff-stats", "a negative count is kept"),
    plant("session-diff-stats-true-counts", "session-diff-stats", "true counts as 1"),
    plant("session-diff-stats-string-unparsed", "session-diff-stats", "a numeric string counts 0"),
    plant(
        "session-diff-stats-deletions-ignored",
        "session-diff-stats",
        "diff entries' deletions are not summed",
    ),
    plant(
        "session-diff-stats-totals-need-both",
        "session-diff-stats",
        "summary totals are used only when both are given",
    ),
    plant(
        "session-diff-stats-scoped-trusts-totals",
        "session-diff-stats",
        "the scoped totals trust bare additions and deletions",
    ),
    plant(
        "session-diff-stats-backslash-kept",
        "session-diff-stats",
        "backslashes in touched paths are kept",
    ),
    plant(
        "session-diff-stats-additions-key",
        "session-diff-stats",
        "working-tree stats are read from additions, not insertions",
    ),
    plant("session-diff-stats-files-kept", "session-diff-stats", "the untrusted files count is kept"),
    plant(
        "session-diff-stats-unchanged-copied",
        "session-diff-stats",
        "a target with nothing untrusted is copied",
    ),
    plant("session-working-no-trim", "session-working", "finish and status are not trimmed"),
    plant("session-working-tool-calls-terminal", "session-working", "a tool-calls finish is terminal"),
    plant("session-working-zero-completed", "session-working", "a completed time of 0 counts"),
    plant(
        "session-working-streaming-ignored",
        "session-working",
        "streaming: true does not make a turn incomplete",
    ),
    plant("session-working-done-not-complete", "session-working", "a done status does not complete a turn"),
    plant(
        "session-working-in-flight-is-unfinalized",
        "session-working",
        "a tool part is in flight when it is not finalized",
    ),
    plant(
        "session-working-output-ignored",
        "session-working",
        "a part's output does not make a visible summary",
    ),
    plant(
        "session-working-status-not-authoritative",
        "session-working",
        "a session status does not decide working on its own",
    ),
    plant(
        "session-working-parts-always-last",
        "session-working",
        "live parts always belong to the last message",
    ),
    plant(
        "session-working-scan-past-user",
        "session-working",
        "the backward scan for the live message does not stop at a user message",
    ),
    plant(
        "live-aggregate-created-ignored",
        "live-aggregate",
        "a session without an updated time sorts as 0, its created time ignored",
    ),
    plant(
        "live-aggregate-signature-without-title",
        "live-aggregate",
        "the session signature leaves the title out",
    ),
    plant("live-aggregate-busy-over-retry", "live-aggregate", "busy outranks retry"),
    plant(
        "live-aggregate-attempt-ignored",
        "live-aggregate",
        "statuses that differ by attempt are equivalent",
    ),
    plant(
        "live-aggregate-priority-ties-keep-first",
        "live-aggregate",
        "a status of equal priority does not replace the candidate",
    ),
    plant(
        "live-aggregate-missing-session-zero",
        "live-aggregate",
        "a status whose session is missing ranks as updated at 0, not -1",
    ),
    plant(
        "live-aggregate-identity-not-shortcut",
        "live-aggregate",
        "the same list is compared member by member",
    ),
    plant(
        "live-aggregate-missing-key-equal",
        "live-aggregate",
        "a key missing from the right map is no difference",
    ),
    plant(
        "live-aggregate-ties-keep-first",
        "live-aggregate",
        "a session updated at the same time does not replace the earlier one",
    ),
    plant("live-aggregate-oldest-first", "live-aggregate", "sessions are sorted oldest first"),
    plant("optimistic-parts-unfiltered", "optimistic", "parts without an id are kept"),
    plant("optimistic-duplicate-parts", "optimistic", "a part whose id is present is merged again"),
    plant("optimistic-unchanged-parts-copied", "optimistic", "an unchanged part list is copied"),
    plant("optimistic-confirmed-also-inserted", "optimistic", "a confirmed message is inserted again"),
    plant("optimistic-empty-part-pages", "optimistic", "a message without parts gets a part page"),
    plant("optimistic-cursor-dropped", "optimistic", "the merged page has no cursor member"),
    plant("optimistic-add-duplicates", "optimistic", "a message already present is inserted again"),
    plant(
        "optimistic-add-replaces-list",
        "optimistic",
        "the session's message list is replaced, not changed in place",
    ),
    plant("optimistic-remove-keeps-message", "optimistic", "the removed message stays in the list"),
    plant("optimistic-remove-keeps-parts", "optimistic", "the removed message's parts stay"),
    plant(
        "revert-transactions-revert-key",
        "revert-transactions",
        "a session's revert marker is read from revert.id",
    ),
    plant(
        "revert-transactions-failed-counts",
        "revert-transactions",
        "a failed transaction's message still counts",
    ),
    plant(
        "revert-transactions-session-argument-ignored",
        "revert-transactions",
        "the session given is ignored and looked up again",
    ),
    plant(
        "revert-transactions-failed-hides",
        "revert-transactions",
        "a failed transaction's hidden set still hides",
    ),
    plant("revert-transactions-hidden-set-ignored", "revert-transactions", "the hidden set never hides"),
    plant(
        "revert-transactions-unchanged-list-hides",
        "revert-transactions",
        "a message list the marker does not cut still hides",
    ),
    plant(
        "revert-transactions-visible-hidden",
        "revert-transactions",
        "a message before the marker is hidden",
    ),
    plant(
        "revert-transactions-missing-session-visible",
        "revert-transactions",
        "a transaction whose session is missing hides nothing",
    ),
    plant(
        "revert-transactions-any-session-hides",
        "revert-transactions",
        "a transaction hides whatever the session's effective marker",
    ),
    plant(
        "revert-transactions-filter-without-marker",
        "revert-transactions",
        "filterMessagesForRevert cuts even without a marker",
    ),
    plant("materialization-skip-types-ignored", "materialization", "parts of a skipped type are kept"),
    plant(
        "materialization-part-content-ignored",
        "materialization",
        "part snapshots with the same ids are equivalent whatever their content",
    ),
    plant(
        "materialization-incomplete-replaces-complete",
        "materialization",
        "an incomplete assistant snapshot replaces a complete one",
    ),
    plant(
        "materialization-unchanged-messages-copied",
        "materialization",
        "an unchanged message list is sorted into a copy",
    ),
    plant("materialization-part-time-ignored", "materialization", "a part's own time.end is no end time"),
    plant(
        "materialization-finalized-tool-replaced",
        "materialization",
        "an in-flight tool snapshot replaces a finalized tool part",
    ),
    plant(
        "materialization-diverging-text-kept",
        "materialization",
        "a longer local text is kept even when the snapshot's text diverges from it",
    ),
    plant(
        "materialization-missing-live-parts-dropped",
        "materialization",
        "live streaming parts the snapshot lacks are dropped",
    ),
    plant(
        "materialization-session-summary-kept",
        "materialization",
        "the session's untrusted diff summary is kept",
    ),
    plant(
        "materialization-user-envelope-materialized",
        "materialization",
        "a user record without a parts list is materialized",
    ),
    plant(
        "materialization-status-without-own-key",
        "materialization",
        "a session with no message key has messages",
    ),
    plant(
        "materialization-always-renderable",
        "materialization",
        "a session missing assistant parts is renderable",
    ),
    // The C0i review's 38 (its `rv-*`), kept as switches since its fix round: the JavaScript semantics (`js`), the
    // families, and the runner's codec and protocol writer (`runner`).
    plant("rv-space-nel", "js", "U+0085 counted as white space"),
    plant("rv-space-no-feff", "js", "U+FEFF not counted as white space"),
    plant("rv-trim-start-only", "js", "trim removes leading white space only"),
    plant("rv-lower-ascii", "js", "toLowerCase maps ASCII letters only"),
    plant("rv-lower-no-final-sigma", "js", "toLowerCase without the Final_Sigma rule"),
    plant("rv-lower-lone-fffd", "js", "toLowerCase writes a lone surrogate as U+FFFD"),
    plant("rv-num-exp-20", "js", "Number::toString switches to an exponent from 1e20"),
    plant("rv-num-empty-nan", "js", "Number('') is NaN"),
    plant("rv-num-signed-hex", "js", "Number('-0x10') is -16"),
    plant("rv-num-lenient-suffix", "js", "Number('12px') is 12"),
    plant("rv-index-max", "js", "4294967295 taken as an array index"),
    plant("rv-props-insertion-order", "js", "integer-like keys kept in insertion order"),
    plant("rv-truthy-negative-zero", "js", "-0 is truthy"),
    plant("rv-eq-nan", "js", "NaN === NaN"),
    plant("rv-join-null-text", "js", "join writes null and undefined as text"),
    plant("rv-lt-codepoint", "js", "< compares strings by code point"),
    plant("rv-max-neg-zero", "js", "Math.max(+0, -0) gives its second argument"),
    plant("rv-member-no-prototype", "js", "member reads see no Object.prototype member"),
    plant("rv-in-own-only", "js", "the in operator sees own members only"),
    plant("rv-json-neg-zero", "js", "JSON.stringify writes -0"),
    plant("rv-json-undefined-member-null", "js", "JSON.stringify writes an undefined member as null"),
    plant("rv-mapkey-signed-zero", "js", "Map keys tell -0 from +0"),
    plant("rv-sort-undefined-kept", "js", "sort hands undefined to the comparator in place"),
    plant("rv-sort-unstable-ties", "js", "sort puts equal elements before their earlier equals"),
    plant("rv-nct-owner-svz", "native-cursor-text", "the owner check is SameValueZero"),
    plant("rv-la-status-candidate-svz", "live-aggregate", "status candidates matched by SameValueZero"),
    plant("rv-mat-message-json-ignored", "materialization", "a merged message's JSON text not compared"),
    plant("rv-mat-len-strict", "materialization", "an existing list that is no array not taken as empty"),
    plant("rv-op-id-nonnull", "optimistic", "renderable parts are those with a non-null id"),
    plant("rv-rt-hidden-array-ok", "revert-transactions", "an array taken as a hidden set"),
    plant(
        "rv-sds-first-backslash-only",
        "session-diff-stats",
        "only the first backslash of a path replaced",
    ),
    plant("rv-sds-strip-all-dot-slash", "session-diff-stats", "every leading ./ stripped"),
    plant("rv-sw-lower-then-trim", "session-working", "lower-cased before it is trimmed"),
    plant("rv-sz-empty-string-kept", "sanitize", "an empty string field not stripped"),
    plant("rv-to-zero-bytes-rejected", "tool-output", "zero omitted bytes rejected"),
    plant("rv-ts-no-line-separators", "tool-status", "U+2028 and U+2029 not removed"),
    plant("rv-codec-negative-zero-lost", "runner", "the codec writes -0 as 0"),
    plant("rv-json-raw-line-separators", "runner", "U+2028 and U+2029 written raw on the protocol line"),
    // The toys (src/toys.rs): what the runner does with port calls, continuations and module state, planted.
    plant("toy-relay-settle-one-hop-early", "toy-relay", "the settle chain logs one job early"),
    plant("toy-relay-tally-stateless", "toy-relay", "the call counter is not kept between calls"),
    plant("toy-relay-pair-swapped", "toy-relay", "pair returns its two port answers in the other order"),
];

#[cfg(test)]
mod tests {
    use super::PLANTS;

    /// The sources' `plant::on("...")` sites, by file.
    const SOURCES: &[(&str, &str)] = &[
        ("native-cursor-text", include_str!("families/native_cursor_text.rs")),
        ("tool-status", include_str!("families/tool_status.rs")),
        ("sanitize", include_str!("families/sanitize.rs")),
        ("tool-output", include_str!("families/tool_output.rs")),
        ("message-order", include_str!("families/message_order.rs")),
        ("session-diff-stats", include_str!("families/session_diff_stats.rs")),
        ("session-working", include_str!("families/session_working.rs")),
        ("live-aggregate", include_str!("families/live_aggregate.rs")),
        ("optimistic", include_str!("families/optimistic.rs")),
        ("revert-transactions", include_str!("families/revert_transactions.rs")),
        ("materialization", include_str!("families/materialization.rs")),
        ("toy-relay", include_str!("toys.rs")),
        ("js", include_str!("js/string.rs")),
        ("js", include_str!("js/number.rs")),
        ("js", include_str!("js/value.rs")),
        ("js", include_str!("js/ops.rs")),
        ("js", include_str!("js/sort.rs")),
        ("runner", include_str!("../../client-engine-runner/src/codec.rs")),
        ("runner", include_str!("../../client-engine-runner/src/json.rs")),
    ];

    fn sites(source: &str) -> Vec<String> {
        source
            .split("plant::on(\"")
            .skip(1)
            .filter_map(|rest| rest.split_once('"').map(|(id, _)| id.to_owned()))
            .collect()
    }

    #[test]
    fn every_plant_site_is_listed_once_and_every_listed_plant_has_a_site() {
        let mut seen = std::collections::BTreeSet::new();
        for (family, source) in SOURCES {
            for id in sites(source) {
                let listed = PLANTS.iter().find(|plant| plant.id == id).unwrap_or_else(|| panic!("{id} is not in PLANTS"));
                assert_eq!(listed.family, *family, "{id} is listed under another family");
                seen.insert(id);
            }
        }
        for plant in PLANTS {
            assert!(seen.contains(plant.id), "{} has no site in its family's source", plant.id);
        }
        let ids: std::collections::BTreeSet<&str> = PLANTS.iter().map(|plant| plant.id).collect();
        assert_eq!(ids.len(), PLANTS.len(), "plant ids are unique");
    }
}
