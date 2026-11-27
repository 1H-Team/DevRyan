# Ported units of `packages/ui/src/sync`

Rust ports made with `rust-anything` 5.0.1, one standalone crate per unit (`<unit>-rs/`, each with
its own empty `[workspace]` table, outside the `packages/native` workspace). Nothing in the
product calls, loads or ships them: no unit is enabled, and no product or test file changed.

Each crate: `src/port.rs` (the port), `cases.jsonl` (recorded calls of the TypeScript under
Node), generated bindings. "Recorded" is `diff` (generated cases, plus `--inputs` hand cases and
`--from-tests` captures where noted); "fuzz" is `fuzz --cases 5000` fresh cases (the tool
deduplicates, so the count differs from 5000; `0/0` means the tool has no generator for the
parameter types). Lines are `wc -l` of the `.ts` file and of `port.rs`.

38 units done (some partly, as noted), 5 skipped, 0 open (of 88); the rest not attempted, listed below.

Units of `packages/shared-runtime`, `packages/orchestration-runtime` and `packages/harness-runtime/lib`
are listed in `shared-runtime/MAP.md`, `orchestration-runtime/MAP.md` and `harness-runtime/MAP.md`.

A `mutation/` crate inside a unit's folder proves exports that only mutate their arguments: a
test-only wrapper module (`mutation-ts/`, never part of the product) imports the original by
relative path, calls the export and returns what it mutated with the result; it is bridged with
`--kind napi` (the bridge otherwise picks wasm) and checked like any unit.

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
| `optimistic.ts` | done | 213/213 + 250/250 | 4988/4988 + 1/1 | 108 | 198 + 387 | Logic after `client-engine/families/optimistic.rs`. `applyOptimisticAdd`/`applyOptimisticRemove` only mutate their draft: proven through the wrapper `mutation-ts/` (returns the draft), crate `mutation/`, 85 hand cases; fuzz has almost no generator for the SDK `Message` (1 fresh case). `{...page}` of an array or string spreads its indexes. |
| `revert-transactions.ts` | done | 1731/1731 | 34423/34423 | 113 | 242 | Logic after `client-engine/families/revert_transactions.rs`. The committed-resend `Set` is module state, kept per thread in Rust; recorded and fuzzed call sequences (state included) all match. `ReadonlySet` crosses as `{"$set": [...]}`; anything else non-nullish throws `...?.has is not a function`. |
| `part-delta.ts` | done | 4404/4404 | 27727/27727 | 331 | 432 | All in UTF-16 code units (slices may split surrogate pairs; results cross as lone-surrogate strings). Its four regexes matched by hand. 3 test files captured. `syncDebug` logging has no port (no return value). |
| `message-fetch.ts` | done | 875/875 | 9875/9875 | 101 | 133 | `normalizeFetchedMessageRecords` and `unwrapMessageRecordsResult` kept in TS (they call part-delta; duplicating it breaks the size bound). `returnedCount < limit` uses full JS `ToNumber` (`[true]` is NaN, `" 0x1f "` is 31). |
| `session-assistant-activity.ts` | done | 230/230 | 4814/4814 | 42 | 131 | Revert filter ported alongside. `Math.max` prefers +0 over -0 (kept). |
| `eviction.ts` | done | 400/400 | 9818/9818 | 53 | 46 | The trial port, unchanged. `pickDirectoriesToEvict` kept in TS (callback parameter). No tests. |
| `subtaskParentMaterialization.ts` | done | 235/235 | 4984/4984 | 34 | 60 | |
| `display-session.ts` | done | 549/549 | 9970/9970 | 142 | 237 | 68 hand cases. "Same reference back" is not observable over JSON; fork identity holds only for absent/`null` forks. |
| `part-change-hints.ts` | skipped: identity | - | - | 21 | - | `WeakMap`/`WeakRef` keyed by object identity of the part maps; identity does not cross the JSON bridge. |
| `directory-disposal.ts` | done (3 of 4 exports) | 949/949 | 19908/19908 | 107 | 376 | The three collection-mutating exports through the wrapper `directory-disposal-rs/mutation-ts/` (builds the `Map`s/`Set`s from entries, returns their entries with the result); crate `mutation/` only, as nothing else is pure. `clearTimeout` of a received `retryTimer` has no effect to port. `createRestartSafeOwnershipCleanup` (callbacks, `queueMicrotask`) stays in TS. |
| `live-aggregate.ts` | done | 1830/1830 | 19490/19490 | 229 | 377 | Logic after `client-engine/families/live_aggregate.rs` + `getSessionSummaryDiffTotals` of `@/lib/sessionDiffStats`. Result record orders integer-like keys first (JS object order). Fuzz found one gap the recorded cases missed (`key in array`), fixed. No mismatch in the earlier port's logic. Fixed 2026-11-27 (found by the `ui/src/lib` port): `parseSessionDiffCount` ignored JS `Number()` radix prefixes (`"0x10"` read 0, JS 16); 78 hand cases pin `0x`/`0o`/`0b`, signs after the prefix and >64-bit hex. |
| `session-cache.ts` | done | 204/204 + 433/433 | 4991/4991 + 9980/9980 | 106 | 89 + 360 | `getProtectedSessionCacheIds` in the main crate (result `Set` crosses as `{"$set": [...]}`). `dropSessionCaches` and `pickSessionCacheEvictions` mutate their arguments: proven through the wrapper `mutation-ts/` (returns the store / the `seen` set's members), crate `mutation/`, 33 hand cases. |
| `plan-idle-settlement.ts` | done | 341/341 | 4941/4941 | 42 | 422 | 123 hand cases (the generator's 200 all throw); `--from-tests`: 12 calls. The gate's size bound counts the imported TS lines too (311 here), so inlining `session-working` + `revert-transactions` passes. |
| `plan-implementation-detection.ts` | done | 285/285 | 4823/4823 | 74 | 784 | `@/lib/messages/actionablePlan` ported alongside as far as the unit reaches it (`parsePlanImplementationRequestPart`; `resolveMessagePlanCard(parts, { isPlanModeSource: true })` down to its plan text: sentinel line, structured headings, reasoning candidates and the straddle rule; its regexes by hand on UTF-16). The gate's size check counts 221 TS lines (3.1x) because it does not count the `@/` import; against the actionablePlan code ported, the ratio is near 1x. `JSON.parse` is serde_json (refuses lone-surrogate escapes and numbers beyond f64, which JS reads). 80 hand cases + 5 test calls. |
| `materialization.ts` | done | 548/548 | 9984/9984 | 324 | 897 | Logic after `client-engine/families/materialization.rs` with seven imports inlined. Reference-identity change flags (`kept !== next`) are tracked by helpers saying which value they returned. 32 calls captured from tests. |
| `session-user-activity.ts` | done | 328/328 + 440/440 | 4965/4965 + 4821/4821 | 95 | 344 + 482 | The four pure exports, 96 hand cases (arrow exports: tests not capturable). The two `update*` exports mutate their draft: proven through the test wrapper `mutation-ts/` (returns `{ result, draft }`), bridged as its own crate `mutation/` (`--kind napi`, else it picks wasm); 144 hand cases. |
| `session-recency.ts` | done | 2880/2880 | 2/2 | 140 | 383 | `display-session` lifecycle helpers inlined; 2200 hand cases (arrow exports). Fuzz finds almost nothing new: the generator has little for the SDK `Session` type and dedups against the recording. `areSessionRecordsEqual` is `Object.is` at leaves; a `Set` equals `{}` (no own keys). |
| `sdk-result.ts` | done | 332/332 | 4964/4964 | 25 | 111 | Bridged with `--as-json T`; `getSdkErrorMessage` (`@/lib/opencode/sdk-error`) inlined. The thrown `Error`'s `status` property does not cross (message only). A message with a lone surrogate breaks `record` itself (`unexpected end of hex escape`), so those inputs are left out. |
| `session-draft-storage.ts` | done (4 of 11 exports) | 892/892 | 3172/3172 | 231 | 24 | Only the four storage-key builders. Kept in TS: the five functions over browser `Storage`, `subscribePersistedSessionInputRemoval` (callbacks), `createDraftId` (clock and `Math.random`). |
| `pending-part-deltas.ts` | done | 1019/1019 + 2178/2178 | 14995/14995 + 39533/39533 | 401 | 773 + 700 | `part-delta` logic inlined. Pure exports: 290 hand cases + `--from-tests`. The seven store-mutating exports (and `hasPendingPartDeltasForMessages`) through the wrapper `mutation-ts/`: it builds the `Map` from entries and returns them, since the generator passes arrays where a `Map` is typed; explicit `now`. Overflow prune sorts as V8 (`js::sort`); 354 hand cases incl. 500+ entry stores. |
| `reconnect-recovery.ts` | done (13 of 17 exports) | 3424/3424 | 53927/53927 | 529 | 720 | `isCompactionSummaryInfo` inlined; `getReconnectCandidateSessionIds` inlines the `getSessionMaterializationStatus` it calls (on `{ message, part }` only, so no revert applies); ~1100 hand cases + 61 test calls. Kept in TS: `mergeAuthoritative`/`mergeRecoveredSessionStatuses` (abort guard module state), `shouldRecoverStaleActiveSession` (`Date.now()`), `captureSessionStatusBaseline`: it returns a `Map` under a type alias, the bridge sends it untyped and its binary wire returns a `{"$map"}` marker as a literal object (`{"$object": ...}`), so a returned `Map` cannot be proven. |
| `event-reducer.ts` | done | 904/904 | 1/1 | 1031 | 2916 | Through the wrapper `mutation-ts/` (returns `{ result, draft }`), crate `mutation/`; loads under Node via `RA_TS_OVERRIDES` for `binary.ts` (README); `--pin-clock` (the provisional message of `message.part.updated` reads `Date.now()`). `reduceGlobalEvent`, `applyGlobalProject` and `applyDirectoryEvent` for every event type, no callbacks passed; the abort guard and the committed-resend set stay empty (the wrapper never fills them). `session.created`/`.updated` use `isPlaceholderSessionTitle` (logic of `ui-lib/sessionTitles-rs`) and `isManagedTaskPlaceholderSession` + `formatManagedTaskDisplayName` of `@devryan/orchestration-runtime`, ported alongside in the crate, with `display-session`, `session-recency` and `sanitize` as their crates port them. Cases: 227 from the UI suite's own calls (200 `applyDirectoryEvent`, 14 `reduceGlobalEvent`, 13 `applyGlobalProject`) and 677 from ~500 hand inputs. To make the test-derived inputs again: bridge `event-reducer.ts` into a scratch folder outside the repo, move `applyDirectoryEvent` from `js_only` to `exports` in its `rust-anything.json` (the bridge keeps it because of the callbacks parameter), run `record --from-tests -- node <repo>/scripts/test-ui.mjs` with `RA_TS_OVERRIDES` set, then rewrite each `test-inputs.jsonl` line to the wrapper's name with the first two arguments (draft, event). The whole UI suite gives 201 distinct `applyDirectoryEvent` calls, the same as the 7 test files that touch the reducer; under capture, 1 test fails (it counts revert lookups; the capture wrapper changes the count) and its earlier calls are kept. Fuzz has no generator for the SDK `Event`/`State` types. |
| `event-batch.ts` | done (1 of 4 exports) | 284/284 | 4994/4994 | 117 | 207 | `canBatchStreamingDelta`; 66 hand cases (the tests reach it only through `applyStreamingEventBatch`: 0 captured). The unit loads under Node only through `RA_TS_OVERRIDES` (its class has a constructor parameter property; see the README). Kept in TS: `createEventDraft` (reference identity, `WeakMap` part-change hints), `StreamingEventBatch`, `applyStreamingEventBatch` (callbacks, zustand stores). |

Shared fix 2026-11-27: the JS `ToNumber` of `0x`/`0o`/`0b` strings in `message-fetch`, `message-order`,
`session-assistant-activity`, `materialization` and `plan-idle-settlement` used `u64::from_str_radix`, which
accepts a sign after the prefix (`"0x+1"` read 1, JS NaN) and fails above 64 bits; all now read digits as JS
does. Each crate: diff, fuzz 5000 and gate rerun and pass; `plan-idle-settlement` pins it with hand cases.

Not attempted, with the reason (2026-11-27):
- Stores on zustand (a UI state library): global-sync-store, streaming, notification-store,
  child-store, selection-store, input-store, session-ui-store, viewport-store,
  session-worktree-store, message-pagination-store, session-prefetch-cache.
- Callback-taking or closure-returning: session-plan-selection (returns a selector closure),
  turn-completion-detection, plan-completion-detection and plan-proposed-detection (callback in
  the argument object, plus the 720-line `@/lib/messages/actionablePlan`), session-record-
  subscription, user-message-history, sync-refs (store references).
- Async work, timers, clock: provider-catalog-recovery, claude-catalog-recovery,
  long-running-tool-recovery, provider-stall-recovery, transient-retry, retry, abort-retry-guard,
  directory-bootstrap-request, bootstrap, session-children, session-history(+memory-probe),
  session-message-loader, session-creation, session-actions, event-pipeline,
  composer-attachment-storage, session-presentation, session-load-performance (`performance`
  marks), history-cache-budget (class over stores).
- Browser APIs: persist-cache (storage), integration-ui-events (window events), send-config
  (reads three stores), use-sync and sync-context.tsx (React).
- types.ts, session-materializer.ts: constants and re-exports only.

