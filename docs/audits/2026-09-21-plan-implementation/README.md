# DevRyan selected-plan implementation

Implemented scope: bundles **1–8, 10, 11, 12 and 15**, plus the orchestrator
subtask-start `local_execution_timeout` repair. The footer dropdown mentioned in
the incident was the attempted task, not an additional UI change. Existing quota,
provider-settings, storage-policy and packaging work was preserved.

**Review status:** the critical review and its evidence are preserved in the
[implementation review](implementation-review.md). The subsequent requested
[repairs and verification](repairs.md) supersede its open-finding status. Original
checks below describe the initial implementation, not release approval.

## Changes and remaining risk

The order below retains the approved benefit/risk ranking. The execution repair
is urgent and has a separate, high-risk rollout requirement.

| Bundle | Implemented behavior | Remaining risk or limit |
| --- | --- | --- |
| 3 | Commands load for the exact message directory before fallback; lookup failures block sending with a retryable error. MCP loads on demand/events. Both hidden Files view polling loops pause and refresh on reveal. | Provider/runtime availability still governs discovery. |
| 4 | OpenRouter inference-key quota uses `/api/v1/key`; limited and unlimited states remain distinct. Ollama reports finite cost/balance with absence and authentication errors preserved. Gemini matching accepts dotted 3.x names without broad family matching. | Fixtures establish response interpretation; no paid provider calls were made. |
| 1 | Background Git reads coalesce by canonical root and mode, run with concurrency four and a 30-second deadline, and terminate/reap owned subprocesses. Requests arriving after a read starts require a later read. Untracked results expose truncation after 2,000 paths. | Large repositories can still take time; the existing 200-file/1-MiB line-count limits remain. Dispatch and mutations are outside this read pool. |
| 2 | Hunk application regenerates a canonical current single-file hunk under the shared index lock, rejecting stale or unsupported input. Status separates staged/unstaged counts and invalidates same-count content changes. Push resolves configured destinations and reports actual porcelain refs. | Managed-branch policy and its existing response fields remain compatible. External tools can still alter a repository independently. |
| 5 | Editors load complete buffers independently of previews, preserve untouched LF/CRLF/mixed endings and the final-newline state, and use expected source versions for atomic saves. Incomplete buffers remain read-only. Editor key handling receives Escape first. | The expected-version check protects application saves; a foreign filesystem writer can race the final check/rename. No Vim dependency exists in this checkout; real CodeMirror extension precedence was tested. |
| 8 | Standalone authentication cookies and JWT audiences use the trusted actual listening port; Host and forwarded headers cannot select another instance's cookie. Login/logout, passkeys, CSRF, WebSockets and proxies share the boundary. | Standalone users need a fresh login. Managed runtime authentication keeps its separate contract. |
| 12 | JWT, WebAuthn and web-push dependencies load only when needed. | The measured benefit is module loading in a packed installation, not end-to-end UI readiness; see below. |
| 7 | ID-less events get boot-scoped transport cursors. New SSE clients opt into an ID-less named replay-gap control event handled before cursor updates; application queues reject control payloads. | Older SSE clients retain their previous recovery behavior. Existing WebSocket gap signalling remains compatible. |
| 6 | Authenticated server retention coordinates complete session trees with native and host activity holds, protects selections, recent/shared/managed sessions and captured history, and returns completed/skipped/failed reasons. It is off by default, with archive as the default action; archived-only deletion uses archive time. | Uncoordinated runtimes and incomplete or unknown state skip cleanup. Lost mutation acknowledgements retain protection until authoritative confirmation or runtime reconciliation. Conservative protection may retain more history. |
| 10 | Managed SSH reuse requires a challenge proving owned instance identity, version and actual port before credentials. Updater-owned quit bounds cleanup of owned children and preserves installation ownership; failure clears quit state. | Real remote SSH, signed installation/update and Intel execution remain release checks. |
| 11 | Sidebar selection and bulk actions use a stable row model. Lists above 200 logical visible rows virtualize with ten-row overscan, measured heights, pinned interactive rows, selected-row reveal and anchor preservation. | Real cross-list drag/drop, mobile and assistive-technology review remain manual checks. Keyboard navigation within a list is verified; a new global cross-list keyboard model was not added. |
| 15 | The terminal now uses a pinned vendored Ghostty WASM core, adapter and symbols font. Replay suppresses historical device-query replies; serialization retains scrollback and viewport. Input, IME, paste, selection, links, resize and disposal retain their contracts. Build output includes licenses and verified asset digests. | Real browser fixtures passed. Mobile touch, screen readers and native packaged menu behavior still need platform review before release. |

### Orchestrator startup and execution ownership

The retained incident journal contained 177 records with zero sequence gaps.
Two skill admissions and one task admission exhausted about 25 seconds, with
24.5–24.7 seconds spent reconciling and no observed child launch. The redacted
incident directory prevents proving its size or equating it to a benchmark root.

Preparation protocol 2 separates a 25-second identity reservation from bounded,
progress-tracked project preparation. Trusted control operations use empty
non-executable views. File work observes after reservation, pins the reconciled
base, then materializes outside the project lock with four fair I/O slots.
Authenticated polls never replay a tool. Cancellation retains ownership until
I/O and native writers settle; the native OS lifetime lock establishes host loss.

Large text and binary files stream through whole-content ownership independently
of permission changes. Conflicting proposed bytes live outside normal revision
history, while nonconflicting paths publish. Native tools, Cursor final messages
and Revert/Redo expose partial publication. Cleanup preserves termination,
history, conflict objects and live base refs. Skills bind canonical source and
mapped-content digest without URL refetch. Companion tool-worker and owned Cursor requests now freeze and fail explicitly
above 16 MiB before admission and after view-specific expansion; history is not
truncated. See the repair report for the added regression evidence. Friendly UI failures retain the underlying
classification. See [Concurrent Revert](../../CONCURRENT_REVERT.md) for the
protocol and paired artifact requirements.

## Verification

All automated checks used isolated fixtures, profiles and mock provider data.
The user's running application and live provider accounts were not test inputs.

| Check | Result |
| --- | --- |
| `bun run validate:full` | Passed workspace lint, types, documentation and deterministic suites, including 3,784 UI tests and 4,245 server tests across 398 server files. |
| Final corrections | The final type check and lint passed. The Cursor package passed 160 tests, including delayed partial publication, notice-before-idle ordering and persistence after restart. Focused Revert/Redo conflict, Git push/cache, retention and terminal transport regressions passed. |
| `bun run build` and `bun run bundle:check` | Web and Electron builds passed. Startup bundle: 4,807,365 raw bytes and 1,414,411 gzip bytes, within the 4,962,877 / 1,456,388 budgets. |
| `bun run build:revert-runtime` | Passed 54 companion tests, compilation and real native dispatcher acceptance on macOS arm64. Companion `1.18.31-devryan.4` advertises preparation 2 and retention 1. |
| `bun run verify:revert-runtime` | Accepted artifact digests, platform and required capability versions verified. |
| Execution regressions | Passed 32 concurrent warm reservations under 25 seconds, real large streamed receipts, 64-MiB scale fixtures, same-base conflicts, independent chmod ownership, cancellation, restart/owner loss, disk-full recovery and live-ref preservation through Git GC. |
| Native journey | Passed real child read/write/publication/Revert/Redo, concurrent and cancelled descendants, skills from global/project/tilde/symlink/cached-URL sources and includes, retained admission errors, Cursor confinement/persistence, and private retention authentication/holds. |
| `node scripts/qa/runtime-parity.mjs` | Passed 13 Electron browser checks with zero console errors: actual WASM/canvas, keyboard/IME/paste, VT replies/replay suppression, scrollback/viewport, resize/hidden output, pointer selection/links, 1,000-row virtualization/anchoring, empty-state recovery and complete 250-KB mixed-EOL CodeMirror editing. |
| Terminal reproducibility | Local Zig 0.15.2 rebuild produced the pinned WASM byte-for-byte and matching PTY trampoline. WASM SHA-256: `51b016a6aa3c29ead71c7c8acf8c01d43b064bae19957a9c9f9e2bf469267629`. |
| Packed distribution | The production packer completed. The tarball contains all six terminal notice/provenance files and the exact WASM/font digests, with the retired terminal dependency absent. |

The complete browser result is preserved in [browser-checks.json](browser-checks.json).
The fixture lives in `tests/visual-runtime-parity`, and its runner cleans up its
owned browser, server and profile. The native journey lives in
`scripts/verify-concurrent-revert-execution.mjs`; set its two documented artifact
environment variables to the verified native binary and supervisor.

### Packaged startup measurement

Twelve alternating fresh Node processes per mode imported the packed auth and
notification entrypoints on macOS arm64, Node v26.0.0. The eager comparison
preloaded exactly the three dependencies that were previously eager. Both modes
used the same installed dependency versions and isolated data/home directories.

| Mode | Median module-load time | Median RSS |
| --- | --- | --- |
| Eager comparison | 82.62 ms | 70.20 MiB |
| Lazy implementation | 10.85 ms | 49.50 MiB |

This isolates about 71.8 ms and 20.7 MiB of avoided startup work. It does not measure
window creation, provider readiness or full application startup. Raw samples and
environment are preserved in [startup-measurement.json](startup-measurement.json).

## Rollout and rollback

- Ship the host and verified companion together. macOS arm64 passed native
  acceptance here; Intel and other platform artifacts require their own native
  acceptance. Missing or incompatible expected artifacts block capture.
- A preparation rollback must preserve the large-file/conflict ledger reader.
  Never discard retained conflicts or live refs to make an older host start.
- Retention stays off until enabled. Disabling stops new actions and drains an
  already accepted action; an unknown outcome stays protected until reconciled.
- Sidebar virtualization can be disabled with the storage key
  `devryan:sidebar:virtualization` set to `off`, followed by a reload.
- Terminal rollback must restore the old manifests, lockfile, dependency patch,
  ambient types and integration together. Do not mix an older terminal package
  with the new adapter or serializer. Compatibility identities and third-party
  attribution remain intact.

No release or deployment was performed. Signed packaging, Intel/native platform
acceptance, real SSH/update installation, live-provider checks, mobile and screen
reader testing remain unavailable or outside this local verification. The terminal
and sidebar browser fixture is narrower than a full production UI acceptance run.
