# Session-specific change attribution — 2026-09-08

The selected session's card now uses exact execution receipts and verified descendants. Independent sessions and external writes do not contribute ownership. Interrupted edit chains remain reviewable as separate recorded edits, with restore disabled when its evidence is insufficient.

## Visual and runtime acceptance

Passed: 24 automated checks and 37 individually inspected screenshots per runtime. See the [web result](web/result.json), [Electron result](electron/result.json), and [individual screenshot review](SCREENSHOTS.md).

The final runs used the production controller, HTTP/SSE, private Git store, deterministic canonical tool executions, and a separate external writer process. Web covered 1280×800 and touch/mobile 390×844; Electron covered 1280×800 and narrow desktop 600×844. Both covered light and dark themes.

- A completed root card retains four distinct files while an independent session is busy. Its verified child contributes one file. Independent and external files are excluded.
- Two selected edits separated by an external write appear under one shared.txt row, labelled as recorded edits. The dialog navigates the immutable edits independently from 64 KiB patch pages.
- Selecting and reloading the child shows only child.txt. A live exact receipt adds a second file to the independently selected session through SSE without changing the root summary.
- An opaque shell write leaves only the exact known.txt receipt in the card, with a precise capture limitation and disabled Undo.
- Exact restorable changes complete Undo and Redo through the UI. A current-file conflict returns HTTP 409; the external conflict and unrelated external-only file are preserved.

No clipping, overlapping controls, or unreadable session-change text was found in the final card and dialog views. Electron's existing 600-pixel desktop toolbar truncates the session title; this does not truncate the card, its counts, or review controls. The native session-header totals come from the existing provider summary and can briefly lag the receipt-backed card after SSE updates.

Each final diagnostic journal contained 76 records, including the live session-changes update, and zero gap records. The gap command and a complete retained-record scan were both run. These runs do not use a live model provider, physical mobile device, signed package, or installed-user profile. They establish deterministic adapter/UI acceptance, not live-provider or release-signing acceptance.

## Regression coverage

| Contract | Evidence |
| --- | --- |
| Concurrent sources, external process, selected descendants, receipt repair and repeated delivery | `packages/harness-runtime/lib/session-changes-attribution.test.js` |
| Known tool aliases, native failed writes, historical pagination, canonical identity validation, bounded Cursor child previews | `packages/harness-runtime/lib/session-changes-host.test.js` |
| Restore conflict/activity/rollback, raw bytes, binaries, renames, symlinks, net-zero edits, restart and retained revisions | `packages/harness-runtime/lib/session-changes.test.js` |
| Large files, paging, metadata transactions, garbage collection and streamed restore | `packages/harness-runtime/lib/session-changes-scale.test.js` |
| Native Cursor execution diff normalization | `packages/cursor-sdk-runtime/cursor-tool-receipts.test.js` |
| Shared plugin classification and host delivery | `packages/web/server/default-config/plugins/devryan-session-changes.test.mjs` |
| Selected card, delayed responses, subtree SSE invalidation, segments and paging | UI card, diff-dialog, tree-store and `client.session-changes.test.ts` suites |

## Validation

Validation commands used repository-local disposable fixtures. `TMPDIR` and `GIT_CEILING_DIRECTORIES` pointed at `.cache/session-changes-tmp`, whose CommonJS package boundary reproduces ordinary outside-repository temporary-directory behavior. This avoids test fixtures accidentally inheriting the canonical Git repository or its ESM package scope.

Build and bundle budget checks passed. Full validation passed lint, types, and documentation checks, then failed in unrelated timing assertions in `initial-bootstrap.test.mjs` and `manual-compaction-submission.test.mjs`; both passed when rerun together. A subsequent complete script-suite run passed 585 of 586 tests, with a separate 200 ms deadline failure in the agent-evaluation client test; that exact test passed on isolated rerun. These retries do not turn the full gate into a pass.

The complete workspace package rerun and its remaining failures are recorded in `VALIDATION.md`.

## Rejected development evidence

Earlier captures were individually inspected but are not acceptance evidence. The local `.cache/qa/` runs exposed a missing directory on the live receipt SSE event, incorrect mobile emulation, and screenshots taken before confirmation animations settled; those issues were corrected before the final runs. One later web run (`web-session-changes-gKHVAg`) passed its light-theme journeys but failed when a concurrent build temporarily removed `packages/web/dist/index.html`. All 18 captures from that run were inspected; the final run started after build/staging completed.

The original incident journal did not identify the exact operation responsible for the reported blanket warning. The original investigation's 12 journal gaps concerned Bot browser-network evidence, so no claim of reconstructing that specific operation is made.

## Remaining attribution limits

Unrestricted parallel filesystem writes cannot always be attributed retrospectively. Opaque shell/MCP effects, legacy workspace snapshots, synthetic turn diffs, and incomplete native Cursor child previews remain explicit capture limitations. Cursor write/delete results without trustworthy before-content are not invented into receipts. Retained exact historical receipts can repair review attribution, but historical review alone cannot authorize restore.
