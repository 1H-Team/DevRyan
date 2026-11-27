# Ported units of `packages/ui/src/sync`

Rust ports made with `rust-anything` 5.0.1, one standalone crate per unit (`<unit>-rs/`, each with
its own empty `[workspace]` table, outside the `packages/native` workspace). Nothing in the
product calls, loads or ships them: no unit is enabled, and no product or test file changed.

Each crate: `src/port.rs` (the port), `cases.jsonl` (recorded calls of the TypeScript under
Node), generated bindings. "Recorded" is `diff` (generated cases, plus `--inputs` hand cases and
`--from-tests` captures where noted); "fuzz" is `fuzz --cases 5000` fresh cases (the tool
deduplicates, so the count differs from 5000; `0/0` means the tool has no generator for the
parameter types). Lines are `wc -l` of the `.ts` file and of `port.rs`.

26 units done, 9 skipped, 1 open (of 88).

| Unit | State | Recorded | Fuzz | TS | Rust | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `request-signature.ts` | done | 200/200 | 4932/4932 | 9 | 43 | No tests. Ids sort in UTF-16 order; ids that are not strings go last as `undefined`. |
| `abort-source.ts` | done | 11/11 | 0/0 | 13 | 21 | No tests. Header name is the `@devryan/orchestration-runtime` constant (marked recorded-literal). |
| `compaction-summary.ts` | done | 22/22 | 0/0 | 8 | 17 | No tests; 10 hand cases (`--inputs`) for the true branches the generator never reached. |
| `composer-target.ts` | done | 1075/1075 | 9018/9018 | 27 | 69 | No tests; hand cases for the key regex. `.` in `/^(?:session\|draft):.+/` excludes JS line terminators (U+2028/9), not U+0085. |
| `todo-completion.ts` | done | 423/423 | 5451/5451 | 36 | 44 | No tests; hand cases for the agent branch. JS `trim` strips U+FEFF and keeps U+0085, unlike Rust `trim`. |
| `event-pipeline-connection-state.ts` | done | 204/204 | 3842/3842 | 39 | 39 | `--from-tests`: 4 captured calls. |
| `sanitize.ts` | done | 1087/1087 | 0/0 | 75 | 57 | Logic after `client-engine/families/sanitize.rs`; 1069 calls captured from the whole UI suite. No fuzz generator for the SDK `Session`/`Message` types. No mismatch found in the earlier port's logic. |
| `tool-output.ts` | done | 350/350 | 4906/4906 | 64 | 137 | Logic after `client-engine/families/tool_output.rs`; 38 hand cases. Arrow-function exports: `--from-tests` captures nothing. No mismatch found in the earlier port's logic. |
| `plan-indicator.ts` | done | 697/697 | 10703/10703 | 86 | 114 | 15 hand cases; arrow exports, tests not capturable. Unknown states rank `undefined`, so never "lower". |
| `question-orphan.ts` | done | 880/880 | 19928/19928 | 110 | 230 | Calls captured from the whole UI suite. V8 error texts reproduced (`Cannot read properties of undefined (reading '<key>')`, `entries is not iterable`). |
| `session-failure.ts` | done | 739/739 | 14916/14916 | 95 | 245 | Imports four classifiers from `@/lib` and `@devryan/shared-runtime`; ported alongside (regexes by hand: ASCII `\b`, ASCII-only `/i`). Needs an `@/` alias loader for `record`/`fuzz`/`gate` (see report). `--from-tests`: 62 calls. |
| `session-selectors.ts` | done | 647/647 | 14741/14741 | 62 | 76 | `subscribeToSessionBranch` kept in TS (callback). Identity reuse of `previous` is not observable over JSON (same printed result). `previous = []` default applies to `undefined` only; `null` throws. |
| `subtask-agent.ts` | done | 424/424 | 9982/9982 | 133 | 59 | `resolveLatestUserChoiceFromMessages` (callback) and `createLatestUserChoiceSelector` (returns a closure; the bridge did not detect this, kept with `--keep`) stay in TS. `--from-tests`: 24 calls. |
| `session-working.ts` | done | 1255/1255 | 15868/15868 | 139 | 260 | Logic after `client-engine/families/session_working.rs` + `tool_status.rs` (`@/lib/toolStatus` ported alongside). `--from-tests`: all 10 exports captured. Lone-surrogate strings count as strings. No mismatch in the earlier port's logic. |
| `message-order.ts` | done | 1162/1162 | 20094/20094 | 69 | 188 | Logic after `client-engine/families/message_order.rs`; bridged with `--as-json T` (else the two generic exports stay in TS). Sort is V8's (`js::sort`); ids compare with full JS `<` (ToNumber for mixed types). No mismatch in the earlier port's logic. |
| `session-worktree-contract.ts` | done | 1360/1360 | 29398/29398 | 231 | 333 | 98 hand cases. Quirk kept: `worktreeSource ?? metadata?.source === 'sdk' ? …` tests `worktreeSource ?? (source === 'sdk')`. |
| `client-message-id.ts` | skipped: random output | - | - | 37 | - | `--pin-clock` pins `Date.now`/`Math.random`, not `crypto.getRandomValues` (what Node uses): the 14 random characters differ on every recording. |
| `debug.ts` | skipped: environment | - | - | 99 | - | Only export the bridge offers is `isSyncDebugEnabled`, a cached read of browser storage; `syncDebug` is an object of logging callbacks. Nothing pure to port. |
| `binary.ts` | skipped: not bridgeable | - | - | 46 | - | Exports a `namespace` with callback (`compare`) functions; `bridge` refuses ("exports no functions"). |
| `content-cache.ts` | skipped: split state | - | - | 80 | - | Module-level LRU shared with `evictContentLru`, which takes a callback and stays in TS; porting the rest would split the state. |
| `optimistic.ts` | done | 213/213 | 4988/4988 | 108 | 198 | Logic after `client-engine/families/optimistic.rs`. `applyOptimisticAdd`/`applyOptimisticRemove` kept in TS: they only mutate their draft and `record` keeps return values only, so a port could not be proven (a no-op would pass). `{...page}` of an array or string spreads its indexes. |
| `revert-transactions.ts` | done | 1731/1731 | 34423/34423 | 113 | 242 | Logic after `client-engine/families/revert_transactions.rs`. The committed-resend `Set` is module state, kept per thread in Rust; recorded and fuzzed call sequences (state included) all match. `ReadonlySet` crosses as `{"$set": [...]}`; anything else non-nullish throws `...?.has is not a function`. |
| `part-delta.ts` | done | 4404/4404 | 27727/27727 | 331 | 432 | All in UTF-16 code units (slices may split surrogate pairs; results cross as lone-surrogate strings). Its four regexes matched by hand. 3 test files captured. `syncDebug` logging has no port (no return value). |
| `message-fetch.ts` | done | 875/875 | 9875/9875 | 101 | 133 | `normalizeFetchedMessageRecords` and `unwrapMessageRecordsResult` kept in TS (they call part-delta; duplicating it breaks the size bound). `returnedCount < limit` uses full JS `ToNumber` (`[true]` is NaN, `" 0x1f "` is 31). |
| `session-assistant-activity.ts` | done | 230/230 | 4814/4814 | 42 | 131 | Revert filter ported alongside. `Math.max` prefers +0 over -0 (kept). |
| `eviction.ts` | done | 400/400 | 9818/9818 | 53 | 46 | The trial port, unchanged. `pickDirectoriesToEvict` kept in TS (callback parameter). No tests. |
| `subtaskParentMaterialization.ts` | done | 235/235 | 4984/4984 | 34 | 60 | |
| `display-session.ts` | done | 549/549 | 9970/9970 | 142 | 237 | 68 hand cases. "Same reference back" is not observable over JSON; fork identity holds only for absent/`null` forks. |
| `part-change-hints.ts` | skipped: identity | - | - | 21 | - | `WeakMap`/`WeakRef` keyed by object identity of the part maps; identity does not cross the JSON bridge. |
| `directory-disposal.ts` | skipped: mutation, callbacks | - | - | 107 | - | Mutates its `Map`/`Set` arguments in place (not recorded), clears timers, and `createRestartSafeOwnershipCleanup` takes and returns callbacks. |
| `live-aggregate.ts` | done | 868/868 | 19495/19495 | 229 | 377 | Logic after `client-engine/families/live_aggregate.rs` + `getSessionSummaryDiffTotals` of `@/lib/sessionDiffStats`. Result record orders integer-like keys first (JS object order). Fuzz found one gap the recorded cases missed (`key in array`), fixed. No mismatch in the earlier port's logic. |
| `session-cache.ts` | done | 204/204 | 4991/4991 | 106 | 89 | Only `getProtectedSessionCacheIds`; `dropSessionCaches` and `pickSessionCacheEvictions` kept in TS (they mutate their arguments). Result `Set` crosses as `{"$set": [...]}`. |
| `plan-idle-settlement.ts` | skipped: size bound | - | - | 42 | - | 35 lines over `session-working` + `revert-transactions` logic; a standalone crate needs ~150 lines of it, over the gate's 3x size bound. |
| `plan-implementation-detection.ts` | skipped: dependency | - | - | 74 | - | Imports the 720-line `@/lib/messages/actionablePlan` (parsers); out of reasonable scope and size bound. |
| `materialization.ts` | open | - | - | 324 | - | Not attempted: change flags rest on reference identity (`messages !== rawCurrentMessages`, `kept !== next`) across seven imported modules incl. `@/lib/sessionDiffStats`; needs identity tracking in the port, est. 800+ lines. |

Not attempted (stateful stores, async or callback shells; the analyzer's `ready` does not see that
their exports share module state with exports that must stay in TS): session-load-performance,
session-worktree-store, session-prefetch-cache, viewport-store, composer-attachment-storage,
session-presentation, abort-retry-guard, message-pagination-store, session-creation,
selection-store, and waves 3 to 7 beyond the units above.

