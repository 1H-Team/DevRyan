# Editor extension removal verification

The extension workspace, renderer entrypoints/layout, theme adapter, editor-only
attachment state, runtime descriptor and branches, development/package commands,
CI publisher, release integration, container manifest copy, and extension-only
dependencies were removed. Current codemaps, module contracts, installation docs,
and agent instructions describe the supported web and desktop runtimes.

The GitHub extension publisher was disabled immediately. All 26 published
extension packages and all matching Actions download artifacts were deleted.
The release asset verifier now rejects extension packages and related artifacts.
Source changes are in the working tree; no commit or push was performed.

## Verification

- `bun run type-check` and `bun run lint`: passed for every remaining workspace.
- `bun run test:full`: passed, including all 355 web test files / 3,658 web tests.
- `bun run build`: passed.
- `bun run bundle:check`: passed; web startup 4,637,915 raw bytes and 1,359,244 gzip bytes, below unchanged budgets.
- Frozen lockfile verification passed. The dependency graph removed 176 resolved package versions and introduced no new resolved version.
- `bun run docs:validate` and `git diff --check`: passed.
- Web QA: `.cache/qa/web-chat-z5zQZT/result.json`, passed.
- Electron QA: `.cache/qa/electron-chat-g6jhkN/result.json`, passed.

Both isolated QA runs used the deterministic loopback provider and exercised
session selection, four concurrent streams, typing during streaming, composer
submission and reconciliation, cancellation, and reconnect/reopen without
message duplication. Both reported no console or cleanup errors. The two
`chat-idle.png` images were visually reviewed: sidebar, transcript, session
changes card, and composer controls remained legible and correctly positioned.
These checks do not claim live-provider, signing, updater, or physical-device
acceptance.

The complete suite initially stopped at the historical update-check benchmark's
assumption that current source still matched its old checksum. Its original
study checksums remain unchanged. The unit test now checks the pin against the
actual current digest and verifies rejection when application code has changed;
the complete suite then passed.

Logs are retained in `.cache/validation/extension-removal/`. Verification used
the working tree, including the pre-existing Electron runtime-service edits,
which were preserved.
