# Ported units of `packages/ui/src/lib`

Rust ports made with `rust-anything` 5.0.1, one standalone crate per unit (`<unit>-rs/`, each with
its own empty `[workspace]` table, outside the `packages/native` workspace). Nothing in the
product calls, loads or ships them: no unit is enabled, and no product or test file changed.

Each crate: `src/port.rs` (the port), `cases.jsonl` (recorded calls of the TypeScript under
Node), `hand-inputs.jsonl` (hand cases passed with `--inputs`, where present; `test-inputs.jsonl`
is the tool's own capture of the unit's tests), generated bindings. "Recorded" is `diff`
(generated cases, plus hand cases and `--from-tests` captures where noted); "fuzz" is
`fuzz --cases 5000` fresh cases (the tool deduplicates, so the count differs from 5000; `0/0`
means the tool has no generator for the parameter types). Lines are `wc -l` of the `.ts` file and
of `port.rs`. Most `lib` exports are `export const f = (...) =>`, which `--from-tests` cannot
capture; hand cases cover what the generator misses instead.

26 units done, 4 skipped (of 133 in the plan; 99 `ready`).

| Unit | State | Recorded | Fuzz | TS | Rust | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `agentDisplay.ts` | done | 235/235 | 793/793 | 7 | 33 | 12 hand cases. JS `\s` (U+FEFF yes, U+0085 no); `charAt(0).toUpperCase()` leaves a supplementary first character alone (lone surrogate). Tests: arrow export, not capturable. |
| `eventTypes.ts` | done | 218/218 | 793/793 | 13 | 11 | 7 hand cases (the test's 3 calls included). Only the `openchamber:` prefix is rewritten, case-sensitive. |
| `github/` | done | 121/121 | 0/0 | 9 | 34 | `sourceRepo.ts`; 11 hand cases (the test's calls included). JS `trim` set (U+FEFF stripped, U+0085 kept); lone-surrogate strings cross as `$utf16`. No fuzz generator for `{ owner?: unknown }`. |
| `formatBytes.ts` | done | 1896/1896 | 0/0 | 13 | 41 | 1871 hand cases (powers of 1024 and their neighbours, 1500 log-spread values, exact `.25`/`.75` halves). Quirk kept: below 1 the unit index goes negative, so `0.5` prints `512.0 undefined`. `toFixed(1)` rounds exact halves up, Rust `{:.1}` to even. No fuzz generator for a bare `number`. |
| `modelIdentifier.ts` | done | 222/222 | 795/795 | 20 | 18 | 11 hand cases. |
| `chatLayout.ts` | done | 538/538 | 0/0 | 23 | 17 | `clampChatWidth` only; `applyChatWidth` writes to a DOM element (kept in TS). 513 hand cases (grid halves, non-finite, `-0`). |
| `fileOpenLimits.ts` | done | 232/232 | 4832/4832 | 19 | 18 | 10 hand cases; a NaN limit never stops the count. |
| `userSendAnimation.ts` | done | 654/654 | 2379/2379 | 34 | 43 | Module-level `Map` kept per thread; a 21-call hand sequence (mark/has/consume interleaved) matches in order. |
| `projectDisplayName.ts` | done | 487/487 | 9795/9795 | 21 | 48 | 23 hand cases (the test's calls included). V8 TypeError texts for a missing or non-string `path` (marked recorded-literal). |
| `contextUsagePresentation.ts` | done | 247/247 | 4095/4095 | 28 | 125 | 36 hand cases (the test's calls included). V8 destructuring and optional-call TypeError texts; `activeInputTokens > 0` with JS `ToNumber` (`" 0x1f "`, `[3]`, `"Infinity"` count, `{}` does not). |
| `agentModelSelection.ts` | done | 32/32 | 0/0 | 29 | 73 | 20 hand cases (the test's calls included). Keys in JS order (array indexes first) both reading and writing; `"1"` and `" 1"` collide on `"1"`, the later one wins in the first one's place. No fuzz generator for `unknown`. |
| `legacyStorageMigration.ts` | done | 233/233 | 793/793 | 36 | 13 | `devRyanStorageKey` only; `migrateLegacyStorageKeys`/`migrateLegacyBrowserStorage` call browser `Storage` (kept in TS). |
| `projectId.ts` | done | 233/233 | 793/793 | 18 | 37 | Node has `btoa`, so only the base64url branch is reachable. Trim runs after the trailing-slash strip (`"a/ "` keeps its slash). |
| `sessionLineage.ts` | done | 504/504 | 9902/9902 | 74 | 84 | 66 hand cases (the test's calls, cycles, self-parent). `sessions` iterates as V8 for-of does (a string's characters, a `Set`; else `sessions is not iterable`); bridged as `Vec` first, which threw on non-arrays, so parameters are JSON values. |
| `projectResolution.ts` | done | 882/882 | 15546/15546 | 69 | 173 | 42 hand cases (the test's calls included). Path lengths compare in UTF-16 units; `"//"` normalizes to `""`, not `null`; `.entries()` of an array or `Set` and `.find()`/for-of TypeErrors as V8 has them. |
| `sessionDiffStats.ts` | done | 1349/1349 | 25549/25549 | 135 | 220 | 142 hand cases (both test files' calls). `--as-json T`. Full JS `Number(text)` (`"0x10"` is 16, `"0b11"` 3, as the tests require); `live-aggregate-rs`'s copy of `parseSessionDiffCount` reads hex/binary/octal strings as 0 (its tests could not be captured), a latent mismatch there. |
| `agentColors.ts` | done | 460/460 | 1590/1590 | 58 | 82 | Function declarations: `--from-tests` captured 24 calls; 36 hand cases. Hash in int32 over UTF-16 units. Quirk kept (found by a hand case): the fixed-colour table is a plain object, so `getAgentIconColor('constructor')` returns the `Object` function and `'__proto__'` returns `Object.prototype` (`{}`). |
| `toolStatus.ts` | done | 405/405 | 820/820 | 79 | 117 | After the lifecycle check in `session-working-rs`; 181 hand cases (the test's cases, lone surrogates as `$utf16`). Lowercasing keeps lone surrogates; unset `status`/`start`/`end` are `undefined` keys. A literal `-0.0` hand input replays as `0` (false mismatch): written as `{"$num": "-0"}`. |
| `sessionLifecycleStatus.ts` | done | 227/227 | 4868/4868 | 92 | 119 | 27 hand cases. `questionCount > 0` with JS `ToNumber` (`"2"`, `[1]`, `true` count); the inputs' values are returned as given (`questionCount: "2"`). |
| `executionFailure.ts` | done | 744/744 | 1586/1586 | 36 | 104 | Function declarations: `--from-tests` captured 4 calls; 294 hand cases (each code at word boundaries). `\b` is ASCII (`é` beside a code is a boundary); the first code in table order wins, not the first in the text. Two messages carry an escaped quote in the source (marked recorded-literal). |
| `responseStyle.ts` | done | 1261/1261 | 10474/10474 | 128 | 278 | 356 hand cases (the cache sequence included); the cache is module state, per thread. `String(preset)` keeps `['mentor']` as `detailed`; `shouldAttachResponseStyleReminder` returns the `||`/`&&` operand (`"x"`, `0`, `""`), not a boolean; the marker regex matched by hand (JS `\s+`). |
| `sessionVisibility.ts` | skipped: split state | - | - | 37 | - | Reads the registered-ids `Set` of `git/gitGenerationSessions.ts`, filled by exports that stay in TS; a port would see an always-empty set. |
| `helperModelSelection.ts` | skipped: random, re-export | - | - | 5 | - | Re-exports `@devryan/shared-runtime`; its own export is a `crypto.randomUUID` / `Math.random` id. |
| `openInApps.ts` | done | 239/239 | 795/795 | 41 | 40 | 28 hand cases (every app id). |
| `permissions/` | done | 18/18 | 0/0 | 30 | 19 | `editModeColors.ts`; 7 hand cases. The generator only offers the `EditPermissionMode` literals; no fuzz generator. |
| `duration.ts` | done | 1078/1078 | 4866/4866 | 61 | 87 | Recorded with `--pin-clock` (`now = Date.now()` default; the port reads `src/port/pinned.rs`). 644 hand cases (the test's calls, exact `.25`/`.75` halves, `-0` prints `0.0s`). `end ?? now` treats `null` as missing yet `end !== undefined` still marks it final; `options.final` is read only after the finite check (a `null` options throws only then). |
| `pwa.ts` | skipped: browser | - | - | 29 | - | Reads `window`, `document` and `navigator`. |
| `typographyWatcher.ts` | skipped: browser | - | - | 28 | - | Writes a `<style>` element into `document`. |
| `agentSelection.ts` | done | 1902/1902 | 18072/18072 | 108 | 166 | 8 of 11 exports; `compareAgentOptions`, `getSelectablePrimaryAgents`, `resolveSelectableAgentOptions` sort with `localeCompare` (ICU collation) and stay in TS (`--keep`). `--as-json T`; 416 hand cases. `name?.trim()` on a non-string throws `name?.trim is not a function`; `options?.hidden` must be exactly `true`. |
| `commitTemplate.ts` | done | 543/543 | 1586/1586 | 152 | 163 | Function declarations: `--from-tests` captured 21 calls; 75 hand cases. Subject regex matched by hand (`.` stops at `\r` and U+2028/9, `\s` has U+FEFF but not U+0085); subject length in UTF-16 units. The "summary is empty" branch is unreachable (`\S.*` cannot trim to empty). The hook script is assembled from the same constants. |

Not attempted yet (wave 0 `ready`, roughly smallest first): agentDefaultResolution (needs
`providers/modelAvailability` + `variantControls`), decoders/ (`oneOf` returns a closure),
quota/providers/ (`Intl.Collator` sort), projectMeta (`@remixicon/react` import, `URLSearchParams`),
url, utils, jsonTreeUtils, router/, typography, fileTypeIcons, modelPrefsSync, modelPrefsAutoSave,
directoryPersistence, desktopBoot, configUpdate, and the larger and async units after them.
