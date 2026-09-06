# Shared runtime

`@openchamber/shared-runtime` contains dependency-light host logic that must behave identically in the web/Electron runtimes.

## Plan storage identity

`lib/plan-storage-id.js` preserves project IDs up to 255 ASCII characters as plan directory names. Longer encoded project IDs use `path_sha256_<full SHA-256 of the ID>` for the storage component only. This keeps long project roots within the filesystem component limit without changing public project identity or relocating any previously writable plan directory. Web/Electron and the injected UI storage helper share this rule.

## Free OpenCode Zen model catalog

`lib/free-zen-model-catalog.js` intersects the models currently served by the Zen API with the OpenCode rows whose models.dev input and output costs are both zero. It owns a five-minute success cache, single-flight refreshes, bounded fetches, and a stale snapshot for temporary catalog outages. Web/Electron share this policy while retaining their own feature-specific ordering and request transports.

`lib/free-zen-generation.js` runs a supplied direct-generation transport sequentially across that catalog. Every model receives its own caller-selected timeout, invalid output advances to the next model, and only sanitized attempt metadata is exposed. It also owns the shared PR title/body JSON normalizer used by web/Electron.

## Commit message drafts

`lib/commit-message-draft.js` owns the shared 20-second generation deadline, compact subject-and-details prompt, Conventional Commit normalization, word-boundary repair for subjects over 72 characters, bounded detail sanitization, provider cooldown selection, and deterministic local fallback. Web/Electron provide authoritative Git context and direct provider transport; both hosts return the same valid subject plus two to four factual details without creating an OpenCode session. Provider timeouts and invalid output become an explicit local-fallback warning rather than a failed Generate action.

## Safe skill archives

`lib/safe-archive.js` owns remote ZIP download and installation safety. Downloads are HTTPS-only, redirect and reported final-response origins are allowlisted, bodies are read incrementally, and compressed bytes are capped. ZIP metadata is fully preflighted before extraction, including entry count, declared sizes, strict UTF-8 path decoding, path shape, encryption, duplicate/case-colliding paths, file/directory conflicts, and Unix special-file modes.

Extraction happens entry-by-entry into a sibling staging directory. Actual expanded bytes are capped and the completed tree is audited before it can replace a target. Replacement moves an existing target aside, commits the audited staging tree, and restores the previous target on failure. Callers must explicitly opt into replacement.

Archive safety failures use `ArchiveRejectionError` with one of the public `ARCHIVE_*` codes. Web return that code directly in the affected catalog item's `skipped[].code`; ordinary network, installation, or commit failures remain `installFailed`. Error messages and recovery envelopes never expose archive entry contents or filesystem paths.

## Configuration apply coordination

`lib/config-apply-coordinator.js` owns the revisioned apply state machine used by web/Electron. Effective mutations are classified into `agents`, `providers`, `commands`, `skills`, `mcp`, `behavior`, or `runtime` scopes and append to the current pending revision; no-op writes return the current envelope without advancing it. Every mutation response includes the same apply envelope, so UI callers do not infer restart requirements from a route name or stale lifecycle history.

Managed runtimes can apply immediately when authoritative active-session count is zero, wait until idle, or perform an administrator-authorized forced restart after rechecking the count and requesting graceful aborts. Concurrent mutations are retained for a later revision, repeated requests for the same in-flight revision share one apply operation, and failures leave the captured changes retryable. External runtimes never claim a managed restart: an explicit acknowledgement refreshes catalogs and records user confirmation while leaving runtime restart ownership outside DevRyan.

## Quota adapters

`lib/quota-adapters.js` owns provider request and normalization rules used by the web server for OpenCode Zen, OpenCode Go, z.ai, Kimi, Codex, xAI, and DeepSeek. Adapters accept injected credentials, `fetch`, and clocks; they return a common usage-window shape, value-only rows when a percentage does not exist, partial-parse warnings, and deterministic configured/error state. The Zen adapter performs a bounded, non-evaluating SolidJS billing hydration parse and enforces the exact authenticated workspace billing origin. It emits one Credits progress window comparing current-month spend with the available balance; monthly-limit and auto-reload fields are parsed for payload compatibility but are not exposed in usage output.

Codex merges usage and reset-credit responses without suppressing either balance. xAI uses the pinned CLI billing contract, validates the reported final HTTPS origin, and supports one refresh-and-retry through a host-provided credential persistence callback. When xAI supplies a recognized weekly or monthly period with a valid reset timestamp but omits the percentage field, the adapter treats the protobuf-default omission as zero usage; a present but malformed percentage still produces a warning. After billing succeeds, xAI also makes a bounded, best-effort read of the private `ConsumerUiSvc.GetRemainingResets` gRPC-Web method with the effective OAuth token. Valid, unexpired reset tokens are reduced to a count and expiry-only reset-bank summary; redemption-capable token IDs never leave the adapter. Reset-service failures add a sanitized warning without discarding billing usage. DeepSeek reports the provider's available balances as value-only rows. Credentials, persistence, OAuth ownership, and transport policy remain host responsibilities.

## Assistant image syntax

`lib/assistant-image-sources.js` is the dependency-free parser shared by the UI candidate projection and authoritative web authorization. It recognizes supported Markdown image/link forms while masking escaped syntax and code, canonicalizes local/file/raw/HTTP/data sources, rejects SVG and unsupported schemes, and can strip load-bearing image syntax without removing surrounding prose. `testing/assistant-image-fixtures.js` is the golden parity set consumed by both hosts.
