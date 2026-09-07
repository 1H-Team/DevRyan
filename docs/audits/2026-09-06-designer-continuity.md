# Designer continuity and default thinking — 2026-09-06

## Observed problem

The reported Designer used Claude Opus 4.8/high with the user's Claude-only
compatibility setting. Journal inspection found repeated reads without an
OpenCode compaction or qualifying journal gap. The correlated Meridian sample
contained 121 requests and 29 SDK sessions; 27 of 28 SDK-session changes followed
`sdk_termination_recovered` at `max_turns=4`. This supports a continuity failure
at tool handoffs rather than a recommendation to lower model effort.

## Implementation

The managed Meridian 1.62.6 source-hash gate now installs an SDK handoff helper
alongside the existing HTTP cancellation fix. A complete passthrough boundary
requests SDK interruption and drains its terminal. A narrowly classified local
interrupt/max-turn exit can retain the session only after exact native persisted
assistant/tool-result verification. No synthetic terminal is emitted. Incomplete
results, unknown exits, timeout, cancellation, duplicate tool-use and independent
sessions retain their rejection/eviction behavior. Stream and non-stream storage
use the same proof and explicitly reject aborted requests.

The catalog exposes optional display-only default-thinking metadata. The thinking
control shows the known level or “Provider-controlled,” with a default explanation.
Explicit selection, null/default semantics, session restoration and queue-time
send snapshots are unchanged. Unknown SDK/profile defaults are not guessed.

No model, reasoning effort or prompt compatibility configuration was changed.
The installed active package/runtime was not patched or restarted. The managed
installer applies the change on a subsequent normal managed-runtime startup.

## Isolated live evidence

Both arms used copied Meridian packages, Opus 4.8/high, the same brief, two
cache-owned files, four read/edit tool calls and three provider requests. The
control retained the existing HTTP fix but omitted the new handoff patch.
Existing OAuth was reused only in memory. Native session/config directories and
tool writes stayed in the isolated fixture for the reported runs.

| Run | Arm | First edit | Completion | SDK sessions | Fresh requests | Accepted |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Control | 11.6 s | 21.1 s | 1 | 1 | Yes |
| 1 | Candidate | 8.0 s | 13.5 s | 1 | 1 | Yes |
| 2 | Control | 23.3 s | 32.7 s | 1 | 1 | Yes |
| 2 | Candidate | 16.9 s | 24.2 s | 1 | 1 | Yes |

Each candidate recorded six bounded checkpoint diagnostics across its two tool
handoffs. Both arms completed the specified TSX/CSS edits and preserved the
rating/count. Neither control reproduced the original long-session max-turn
failure. These are small, sequential live samples with variable service/build
load; they demonstrate fixture acceptance and candidate continuity, not a
general latency estimate or proof that all Designer slowness is eliminated.

Deterministic tests force max-turn exits over repeated handoffs, missing and
duplicate tool results, wrong UUID/session/cwd, malformed/torn persistence,
cancellation during verification, transport errors and drain timeout. Mounted
UI tests verify default labeling, explicit selection, remount/hydration and
queued null-variant sends.

## Reproduction

With explicit access to the user's installed Meridian and existing OAuth session:

```sh
bun scripts/qa/meridian-designer-continuity.mjs
```

This opt-in live check consumes provider usage. It never restarts the user's
runtime. Each arm is bounded to 12 requests/240 seconds. Results are written
under `.cache/qa/designer-continuity/`; failure to meet fixture acceptance exits
nonzero. The supplied tools permit only exact reads/edits of the two fixture
files. The comparison is separate from default automated validation.

## Validation result

- Workspace lint and type checks passed.
- Full workspace build passed, including web and Electron.
- Full UI suite passed after correcting the new Default label capitalization.
- Web server suite: 356 files passed; 3,692 tests passed. One pre-existing
  Orchestrator prompt byte-count snapshot failed: expected 34,572, actual 35,236
  in `packaged-agent-defaults.test.js:332`. The separately edited Orchestrator
  prompt and that test were not changed by this task.
- The full validation run passed the script/runtime/native suites before its
  original UI copy-style failure; the UI suite was rerun successfully, followed
  by the server suite above. Validation is not reported as wholly green.
- Focused handoff, installation, default-thinking metadata and provider-route
  tests passed. The mounted default-label/queued-send test also passed.
