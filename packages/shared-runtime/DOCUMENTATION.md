# Shared runtime

`@openchamber/shared-runtime` contains dependency-light host logic that must behave identically in the web/Electron and VS Code runtimes.

## Safe skill archives

`lib/safe-archive.js` owns remote ZIP download and installation safety. Downloads are HTTPS-only, redirect and reported final-response origins are allowlisted, bodies are read incrementally, and compressed bytes are capped. ZIP metadata is fully preflighted before extraction, including entry count, declared sizes, strict UTF-8 path decoding, path shape, encryption, duplicate/case-colliding paths, file/directory conflicts, and Unix special-file modes.

Extraction happens entry-by-entry into a sibling staging directory. Actual expanded bytes are capped and the completed tree is audited before it can replace a target. Replacement moves an existing target aside, commits the audited staging tree, and restores the previous target on failure. Callers must explicitly opt into replacement.

Archive safety failures use `ArchiveRejectionError` with one of the public `ARCHIVE_*` codes. Web and VS Code return that code directly in the affected catalog item's `skipped[].code`; ordinary network, installation, or commit failures remain `installFailed`. Error messages and recovery envelopes never expose archive entry contents or filesystem paths.

## Configuration apply coordination

`lib/config-apply-coordinator.js` owns the revisioned apply state machine used by web/Electron and VS Code. Effective mutations are classified into `agents`, `providers`, `commands`, `skills`, `mcp`, `behavior`, or `runtime` scopes and append to the current pending revision; no-op writes return the current envelope without advancing it. Every mutation response includes the same apply envelope, so UI callers do not infer restart requirements from a route name or stale lifecycle history.

Managed runtimes can apply immediately when authoritative active-session count is zero, wait until idle, or perform an administrator-authorized forced restart after rechecking the count and requesting graceful aborts. Concurrent mutations are retained for a later revision, repeated requests for the same in-flight revision share one apply operation, and failures leave the captured changes retryable. External runtimes never claim a managed restart: an explicit acknowledgement refreshes catalogs and records user confirmation while leaving runtime restart ownership outside DevRyan.

## Quota adapters

`lib/quota-adapters.js` owns provider request and normalization rules shared by the web server and VS Code extension for z.ai, Kimi, Codex, xAI, and DeepSeek. Adapters accept injected credentials, `fetch`, and clocks; they return a common usage-window shape, value-only rows when a percentage does not exist, partial-parse warnings, and deterministic configured/error state.

Codex merges usage and reset-credit responses without suppressing either balance. xAI uses the pinned CLI billing contract, validates the reported final HTTPS origin, and supports one refresh-and-retry through a host-provided credential persistence callback. DeepSeek reports the provider's available balances as value-only rows. Credentials, persistence, OAuth ownership, and transport policy remain host responsibilities.
