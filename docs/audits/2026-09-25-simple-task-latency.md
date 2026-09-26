# Simple-task latency implementation and verification

Date: 2026-09-25. Scope: managed Cursor plugin ownership, proportional agent
routing, bounded Explorer work and execution diagnostics. No installed profile,
active user runtime, model defaults, reasoning defaults or dependency versions
were changed. Release publication and installation were not performed.

## Implemented

- Managed provisioning recognizes the audited 734,390-byte standalone Cursor
  bundle by SHA-256
  `954ceb8ef4de6ac2cb3e95d81d56a11bda58d396d2dd7756915724e193d8f622`.
  Both `plugin/cursor-acp.js` and `plugins/cursor-acp.js` are covered. Verified
  backups live outside plugin discovery; matching local registrations are
  removed. Modified files and invalid configuration remain intact and produce
  conflicts. Interrupted attempts resume from verified backups. Migration runs
  at normal managed startup, without restarting an active session.
- Orchestrator directly handles bounded changes, unknown component filenames,
  specified visual tweaks and their tests. Delegation depends on uncertainty,
  coupling, risk and useful parallel work. Explicit specialist requests and
  Plan restrictions remain authoritative. The line-count threshold and blanket
  visual/unknown-location routing rules are removed.
- Explorer receives a navigation brief and stops at the requested entrypoint,
  symbol and immediate connections. Two unsuccessful search rounds return
  candidates and uncertainty; explicitly broad maps retain their scope. Its
  default answer template no longer suggests migration investigation.
- Existing diagnostic records gain bounded tool-origin, execution-tier and
  fallback enums. Preparation duration uses existing elapsed phase summaries.
  No new tool API, routing service or public setting was introduced.

Ownership and recovery details are in [the runtime guide](../CONCURRENT_REVERT.md),
[profile codemap](../../packages/web/server/lib/opencode/codemap.md),
[agent codemap](../../packages/web/server/default-config/codemap.md), and
[evaluation codemap](../../scripts/agent-evals/codemap.md).

## Deterministic and native verification

Migration tests cover both discovery directories, duplicate relative/absolute/
file-URL registrations, JSONC preservation, repeated provisioning, interrupted
backup/removal, stale registrations, modified plugins, symlinks, damaged backups
and invalid configuration. Provisioning itself is checked to stop before
unrelated writes on a conflict. Tiny deterministic stand-ins use a test-only
hash seam; production recognition computes the exact SHA-256.

A separate disposable-profile check used the actual observed bundle with the
production hasher. Both copies were removed, backup bytes matched, and a second
run made no changes. The installed specimen was read without modifying it.

The pinned companion compiled, typechecked, and passed its 95 selected tests,
including custom same-name tool confinement, permissions, direct-admission
fallback, cancellation and Revert-fenced receipts. Real native acceptance loaded
the maintained Cursor adapter after retiring legacy stand-ins. Native `read`,
`glob` and `grep` issued only direct admission/completion receipts. Confined
writes, Revert/Redo, descendants, cancellation, browser isolation and Cursor
publication checks passed.

The ledger-warming check uses a separate cold Git project with 8,000 files. It
asserts that the ledger was actually built and that a native inspection completed
before that build settled, with no reserved preparation for the inspected calls.
An initial weaker check reused a previously built ledger; it was replaced and
rerun successfully.

- `bun run build`: passed.
- `bun run bundle:check`: passed.
- Final `bun run validate:full`: passed, including workspace lint, type checks
  and deterministic suites (the final web suite passed 4,347 tests across 402 files).
- macOS arm64 isolated Electron package: built; packaged SQLite/PTY ABI smoke
  checks passed. Computer-use requests were submitted through the actual app.
- Signing/notarization, updater installation, other platforms and the installed
  user profile were not tested or changed.

Initial full runs found outdated expected evaluation-case lists and assertions
for the removed routing rules. Those contracts were updated to the new policy;
the focused prompt and evaluation tests passed before the final full run.

## Live results and limits

Three alternating baseline/candidate pairs used the same fixture, GPT-6 Sol,
explicit nullable default variant and preserved specialist assignments. Both
arms used the repaired native runtime; this pilot compares routing prompts and
does not measure the removed legacy plugin's overhead. Candidate defaults were
snapshotted before the final removal of unused Explorer migration-template text
and clarification that direct implementers load their own skills. The final
packaged computer-use check used those final prompt bytes.

All nine simple candidate runs passed, with zero children. Footer-plan runs
left the source, tests and other fixture files unchanged.

| Candidate case (3 runs each) | Median first component read | Median completion | Median tool interval union | Children |
| --- | ---: | ---: | ---: | ---: |
| Unknown footer location, plan only | 13.4 s | 29.9 s | 1.7 s | 0 |
| Bounded behavior fix | 9.0 s | 37.7 s | 10.8 s | 0 |
| Specified visual tweak | 7.1 s | 37.9 s | 13.9 s | 0 |

Completion includes the client's terminal observation. Component location is
measured at the first completed read of the target source. Tool durations use
the union of native intervals to avoid double-counting parallel/nested calls.
These are local pilot measurements, not a general response-time guarantee.

The paired report correctly returned **inconclusive**, not canary-eligible:

- Explorer's configured DeepSeek Go model was rejected because the provider
  requires Global regions in workspace privacy settings.
- Designer's Claude provider rejected third-party usage because extra usage
  was unavailable. Cached xAI access was expired, limiting Fixer acceptance.
- The comparison also detected differing catalog fingerprints and missing
  evidence for failed baseline runs. The baseline's behavior-fix median was
  36.7 seconds; its candidate median was 37.7 seconds. This pilot does not
  establish a 50% improvement, even for the case both arms completed.

Natural-request fixtures for substantial design, broad discovery and explicit
specialists are implemented and deterministically graded. Successful live
specialist completion remains unverified under the preserved provider settings.
No provider privacy, billing, authentication or model settings were changed to
force acceptance. Journal gap checks for the inspected isolated runs were clean.
The automatic suggestion to expand to ten pairs was not followed: repeated
provider rejection cannot establish a useful speed comparison.

## Packaged computer-use check and separate defect

In the isolated Electron app, Orchestrator completed the first footer-label and
spacing request in 58.1 seconds, with zero children and a passing independent
footer test. In the final package, a subsequent spacing request completed in
81.6 seconds, also with zero children and a passing independent test. Its source
was first read at 22.0 seconds; native file inspection calls were approximately
0.5–1.3 seconds, while mutation/testing and a correction consumed more time.

The second request exposed an existing text-publication defect. The canonical
patch requested `gap:24px` to `gap:32px`, but the published content first read
`gap:23px`. The test failed; Orchestrator reread the file, corrected it and reran
the test successfully. A separate two-session probe reproduced `16 → 24 → 23`
when the second requested value was 32. The probe verified that
`session-mutations.js` is byte-for-byte unchanged from HEAD. This is a remaining
ledger correctness issue, not an agent-delegation failure, and is outside these
routing/provisioning changes. It prevents claiming a flawless first-attempt
footer implementation in that final UI check.

## Local evidence and rollout

Local evidence is retained under the ignored repository cache:

- `.cache/simple-task-native-build.log` and `simple-task-native-final.log`
- `.cache/simple-task-specimen-result.json`
- `.cache/simple-task-validate-final.log`, `simple-task-build.log`,
  `simple-task-bundle-check.log`
- `.cache/qa/simple-task-latency/reports/` (all six trial reports and comparison)
- `.cache/simple-task-final-package.json` (final package evidence locator)
- `.cache/simple-task-electron-result.json` and `simple-task-electron-final-result.json`
- `.cache/simple-task-publication-probe.mjs` and `simple-task-publication-probe.json`

Source changes are ready for review. A release speedup claim remains gated on
provider-available, fingerprint-matched trials demonstrating the requested
improvement. When this version is deployed, normal managed startup performs the
migration and installs the routing changes together. The current installed app
was neither replaced nor interrupted.
