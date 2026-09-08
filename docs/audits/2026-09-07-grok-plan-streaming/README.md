# Grok plan streaming verification — 2026-09-07

Plan text visibly grows inside one card before the assistant completes, including split markers and multiple reasoning parts. The replay also verifies reasoning-to-text continuation, final-message replacement, exact saved Markdown after idle and reload, and an aborted draft that cannot save or enable implementation. Both host runs passed 19 automated checks.

The shared resolver now supplies source ranges to rendering and activity projection. `ChatMessage` retains reasoning source parts on Plan turns when Thinking is hidden; `MessageBody` applies the visibility preference after resolving the card. This outer filter was a second defect found by the visual reload check. Persistence, ready detection, and implementation also reject busy/retry gaps and terminal errors.

## Scope and identity

- These are controlled xAI-shaped events (`providerID: xai`, `modelID: grok-4.6`, no variant), transported through the real HTTP/SSE stack. They do **not** establish live xAI success.
- DevRyan 1.1.15; Electron 41.2.1; web server Node 26.0.0. The Electron run uses the actual development desktop host, not an installed-app replacement or release artifact.
- The web and staged Electron UI inventories contain 647 files and have identical aggregate SHA-256 `370d0830f99e523baccb1be710291f3e5aa51c4357dc54a6b886b0ed2049b5f5`. [Build identity](build-identity.json) records the revision, dirty-tree status, and changed plan-source hashes. Sources and asset hashes were rechecked after the host runs.
- Web ran at 21:56 UTC; the retained Electron run ran at 22:00–22:02 UTC. Both use separate temporary data, profile, and workspace directories. Cleanup completed without errors.
- Live xAI verification was unavailable: the authorized repository-local QA OAuth access expired at 2026-09-05 02:53:47 UTC, and no usable xAI API key was present. No live model/variant or live journal correlation is claimed.
- The product uses Live rendering. Legacy Sorted activity projection is covered by the shared projection regression tests; it is not a selectable visual mode in this build.

## Reviewed evidence

All 62 retained original PNGs were individually inspected. [Review inventory](review.json) records their hashes and review status; the automated [web result](web/result.json) and [Electron result](electron/result.json) retain their original data. The web result's sanitizer redacted four long screenshot basenames; the review inventory lists the actual files. Future captures use shorter names.

At the first three streaming checkpoints, visible card text grows from 14 to 58 to 118 characters while implementation remains disabled. Expanded Thinking contains the ordinary preamble and excludes the plan body. Each of the eight handoff probes sampled 11–15 animation frames without a blank or duplicate card. The largest frame-to-frame scroll change was 44px on mobile web and 12px on Electron; these small adjustments accompany changed card height, not a reset to another transcript position. Static images alone are not a continuous-motion recording.

Text and controls remain readable in both themes with no horizontal overflow. Collapsed cards use their existing preview fade. At 600px in Electron, an expanded card uses normal vertical chat scrolling; the additional action captures verify that its final section and Implement Plan button can be fully revealed.

| Host / theme / width | Streaming | Expanded | Reloaded |
| --- | --- | --- | --- |
| Web light 1280 | [PNG](web/grok-light-1280-streaming.png) | [PNG](web/grok-light-1280-expanded.png) | [PNG](web/grok-light-1280-reloaded.png) |
| Web light 390 | [PNG](web/grok-light-390-streaming.png) | [PNG](web/grok-light-390-expanded.png) | [PNG](web/grok-light-390-reloaded.png) |
| Web dark 1280 | [PNG](web/grok-dark-1280-streaming.png) | [PNG](web/grok-dark-1280-expanded.png) | [PNG](web/grok-dark-1280-reloaded.png) |
| Web dark 390 | [PNG](web/grok-dark-390-streaming.png) | [PNG](web/grok-dark-390-expanded.png) | [PNG](web/grok-dark-390-reloaded.png) |
| Electron light 1280 | [PNG](electron/grok-light-1280-streaming.png) | [PNG](electron/grok-light-1280-expanded.png) | [PNG](electron/grok-light-1280-reloaded.png) |
| Electron light 600 | [PNG](electron/grok-light-600-streaming.png) | [Full action](electron/grok-light-600-action.png) | [PNG](electron/grok-light-600-reloaded.png) |
| Electron dark 1280 | [PNG](electron/grok-dark-1280-streaming.png) | [PNG](electron/grok-dark-1280-expanded.png) | [PNG](electron/grok-dark-1280-reloaded.png) |
| Electron dark 600 | [PNG](electron/grok-dark-600-streaming.png) | [Full action](electron/grok-dark-600-action.png) | [PNG](electron/grok-dark-600-reloaded.png) |

Cancellation evidence: [web](web/grok-cancelled-draft.png), [Electron](electron/grok-cancelled-draft.png). Both retained runs have zero renderer errors, zero diagnostic gap records, and no diagnostic last error. The journal gap CLI also returned no gaps. A discarded earlier web attempt ended on Node's diagnostic-journal FileHandle garbage-collection error; it is not counted as a passing run.

## Validation

| Check | Result |
| --- | --- |
| [Focused plan/lifecycle suite](validation-plan.log) | 220 passed, 0 failed across six files |
| [Final `validate:full`](validation-full.log) | Workspace lint, type checks, docs, and all 575 script tests passed; stopped at the unrelated Bot egress `bounds a relayed response` test (`ECONNRESET`) |
| [Isolated egress retry](validation-egress-retry.log) | Same failure; 8 passed, 1 failed; its source was not changed by this task |
| [Standalone UI suite](validation-ui.log) | Main batch: 3,569 passed, 3 failed in concurrent Bots transcript/Telegram/copy changes |
| [Standalone web suite](validation-web.log) | 3,755 passed, 5 failed in Git status/PR-description, scoped-revert timeout, and Bot context tests |
| [Standalone Electron suite](validation-electron.log) | 309 passed, 0 failed |
| [Build and Electron staging](build.log) | Passed on the tested source; a root `bun run build` also passed before the final visibility correction |
| [Bundle budgets](bundle-check.log) | Passed |

The full suite is not green; unrelated assertions were not weakened or edited. The final visibility correction is covered by final-source lint/type checks, rebuilding both hosts, and the passing hidden-reasoning reload checks.

Reproduce after building/staging current assets:

```sh
DEVRYAN_QA_SCENARIO=grok-plan bun scripts/qa/run.mjs
DEVRYAN_QA_RUNTIME=electron DEVRYAN_QA_SCENARIO=grok-plan bun scripts/qa/run.mjs
```
