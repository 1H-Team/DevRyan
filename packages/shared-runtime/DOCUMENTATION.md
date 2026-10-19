# Shared runtime

`@devryan/shared-runtime` contains dependency-light host logic that must behave identically in the web/Electron runtimes.

## Entry points

`package.json` `exports` is the public surface:

- `./startup-diagnostics.js` and the `./lib/<name>.js` modules listed there are portable: no Node builtins or packages, safe for the browser bundle;
- `./node/safe-archive.js` is Node-only (`node:fs`, `node:crypto`, `adm-zip`);
- `./testing/*.js` are portable test fixtures;
- the root `.` is the compatibility barrel for web and Electron. It re-exports the archive module, so it is Node-only and browser code must use the portable subpaths.

Any other file is private. `scripts/check-import-boundaries.mjs` enforces this for package-name and relative imports, and `scripts/check-browser-graph.mjs` keeps the Node-only module out of the UI.

## Legacy environment aliases

`lib/legacy-environment.js` owns the `DEVRYAN_*` / `OPENCHAMBER_*` alias rule
([identity compatibility](../../docs/IDENTITY_COMPATIBILITY.md)). It is portable
and operates on any env record: `adoptLegacyEnvironment` copies unset aliases
without overriding or deleting, `readDevRyanEnv` prefers the DevRyan name,
`setDevRyanEnv` writes or removes both names so they never diverge, and
`canonicalEnvironmentName` lets name lists judge an alias as its DevRyan name.
`./node/adopt-legacy-environment.js` is the side-effect entry: Electron main, the
web server entry and the CLI import it first, before any module reads its
environment, and re-run adoption after each login-shell merge.

## Data root

`./node/data-root.js` (`lib/data-root.js`, Node-only) resolves the DevRyan data
root for every host: `DEVRYAN_DATA_DIR` (or its alias) unless it names a default
location, else `~/.config/devryan`, or the pre-rename `~/.config/openchamber`
while it is still a real directory. The one-time move is owned by
`packages/harness-runtime/lib/data-root-migration.js`.

## Startup integrity diagnostics

`startup-diagnostics.js` owns the bounded artifact diagnostic shared by the verifier,
health response, renderer and Electron splash. Only finite stage/reason/purpose
labels and an approved artifact basename cross this boundary. The public code
remains `native_runtime_artifacts_unverified`. `startupDiagnosticSummary` emits
only that safe envelope plus a finite error code and optional attempt number;
Copy Diagnostics never includes raw exceptions, credentials or paths.

## Plan storage identity

`lib/plan-storage-id.js` preserves project IDs up to 255 ASCII characters as plan directory names. Longer encoded project IDs use `path_sha256_<full SHA-256 of the ID>` for the storage component only. This keeps long project roots within the filesystem component limit without changing public project identity or relocating any previously writable plan directory. Web/Electron and the injected UI storage helper share this rule.

## Shared helper model setting

`lib/model-selection-availability.js` inspects exact provider/model/effort catalog evidence without changing the selection. A catalog marked `catalogIncomplete` is unknown, never evidence that a provider or model is missing. Agent settings saves and managed execution admission share this distinction.

`lib/helper-model-selection.js` owns the typed `helperModelSelection` setting:
`{ providerID, modelID, revision }`. The default is `opencode/deepseek-v4.1-flash`
with revision `default`. There is no reasoning override: helpers use provider
Default reasoning. Every explicit selection gets a new revision; personal reset
removes the sparse override and inherits the host tuple and revision. UI, web and
Electron use the same parser. Notification `zenModel` and legacy Git fields have
separate ownership.

## Free OpenCode Zen model catalog

`lib/free-zen-model-catalog.js` intersects the models currently served by the Zen API with the OpenCode rows whose models.dev input and output costs are both zero. It owns a five-minute success cache, single-flight refreshes, bounded fetches, and a stale snapshot for temporary catalog outages. Web/Electron share this policy while retaining their own feature-specific ordering and request transports.

`lib/free-zen-generation.js` runs a supplied direct-generation transport sequentially across that catalog. Every model receives its own caller-selected timeout and AbortSignal; expiry aborts the request before advancing, and late results are ignored. Invalid output advances to the next model, and only sanitized attempt metadata is exposed. The default cooldown policy skips cooling models unless the entire pool is cooling; Git's explicit `prioritize` policy orders warm models first and then fills remaining attempt slots with cooling models. Callers choose model limits and optional overall deadlines. An optional `afterAttempt` hook waits for bounded native helper cleanup after transport cancellation, before advancing. It also owns the shared PR title/body JSON normalizer used by web/Electron.

## Commit message drafts

`lib/commit-message-draft.js` owns the shared 20-second generation deadline, compact subject-and-details prompt, Conventional Commit normalization, word-boundary repair for subjects over 72 characters, bounded detail sanitization, provider cooldown selection, and deterministic local fallback. Web/Electron provide authoritative Git context through the native no-tools helper. Production routes disable deterministic fallback and permit only a freshly authorized active-session model after configured helper settlement; standalone injected consumers may still opt into the shared factual fallback.

## Safe skill archives

`lib/safe-archive.js` owns remote ZIP download and installation safety. Downloads are HTTPS-only, redirect and reported final-response origins are allowlisted, bodies are read incrementally, and compressed bytes are capped. ZIP metadata is fully preflighted before extraction, including entry count, declared sizes, strict UTF-8 path decoding, path shape, encryption, duplicate/case-colliding paths, file/directory conflicts, and Unix special-file modes.

Extraction happens entry-by-entry into a sibling staging directory. Actual expanded bytes are capped and the completed tree is audited before it can replace a target. Replacement moves an existing target aside, commits the audited staging tree, and restores the previous target on failure. Callers must explicitly opt into replacement.

Archive safety failures use `ArchiveRejectionError` with one of the public `ARCHIVE_*` codes. Web return that code directly in the affected catalog item's `skipped[].code`; ordinary network, installation, or commit failures remain `installFailed`. Error messages and recovery envelopes never expose archive entry contents or filesystem paths.

## Configuration apply coordination

`lib/config-apply-coordinator.js` owns the revisioned apply state machine used by web/Electron. Effective mutations are classified into `agents`, `providers`, `commands`, `skills`, `mcp`, `behavior`, or `runtime` scopes and append to the current pending revision; no-op writes return the current envelope without advancing it. Every mutation response includes the same apply envelope, so UI callers do not infer restart requirements from a route name or stale lifecycle history.

Managed runtimes can apply immediately when authoritative active-session count is zero, wait until idle, or perform an administrator-authorized forced restart after rechecking the count and requesting graceful aborts. Concurrent mutations are retained for a later revision, repeated requests for the same in-flight revision share one apply operation, and failures leave the captured changes retryable. External runtimes never claim a managed restart: an explicit acknowledgement refreshes catalogs and records user confirmation while leaving runtime restart ownership outside DevRyan.

## Quota adapters

`normalizeCodexAppServerQuota` maps the documented `account/rateLimits/read`
windows by duration and limit bucket. It keeps reset-credit inventories separate
from ordinary credits, preserves authoritative counts when expiry details are
partial, and distinguishes unavailable details from an empty inventory. The
normalizer remains a compatibility export; desktop/web usage now reuses the
selected native Codex sign-in instead of owning an app-server profile.

`lib/quota-adapters.js` owns provider request and normalization rules used by the web server for OpenCode Zen, OpenCode Go, z.ai, Kimi, Codex, xAI, and DeepSeek. Adapters accept injected credentials, `fetch`, and clocks; they return a common usage-window shape, value-only rows when a percentage does not exist, partial-parse warnings, and deterministic configured/error state. The Zen adapter performs a bounded, non-evaluating SolidJS billing hydration parse and enforces the exact authenticated workspace billing origin. It emits one Credits progress window comparing current-month spend with the available balance; monthly-limit and auto-reload fields are parsed for payload compatibility but are not exposed in usage output.

Codex merges usage and reset-credit responses without suppressing either balance. xAI uses the pinned CLI billing contract, validates the reported final HTTPS origin, and supports one refresh-and-retry through a host-provided credential persistence callback. When xAI supplies a recognized weekly or monthly period with a valid reset timestamp but omits the percentage field, the adapter treats the protobuf-default omission as zero usage; a present but malformed percentage still produces a warning. After billing succeeds, xAI also makes a bounded, best-effort read of the private `ConsumerUiSvc.GetRemainingResets` gRPC-Web method with the effective OAuth token. Valid, unexpired reset tokens are reduced to a count and expiry-only reset-bank summary; redemption-capable token IDs never leave the adapter. Reset-service failures add a sanitized warning without discarding billing usage. DeepSeek reports the provider's available balances as value-only rows. Credentials, persistence, OAuth ownership, and transport policy remain host responsibilities.

## Safe provider errors

`lib/provider-error-details.js` extracts only finite allowlisted provider error
codes and request parameter names from bounded structured bodies. Session error
projection and the diagnostic sanitizer share this allowlist, preserving useful
failure classification without copying response bodies into diagnostic fields.

`lib/native-observation.js` validates native runtime observation envelopes.
Its `provider-refusal` stage accepts only reviewed local OpenAI refusal codes,
request kinds and physical hook names; additional fields are rejected. The
runtime host emits these records and the harness sanitizer validates their
safe journal projection using the same contract.
Prepared/physical observations optionally carry numeric `toolCount`, and physical
observations carry `wireToolCount` (null when the existing bounded serialized-body
inspection cannot determine it). These contain no tool definitions or content.
Physical records may separately carry `wireEffortUpdates`: a strict finite count
(1–256) and final Responses configuration-update effort, or null when actual
controls are malformed or ambiguous. The last ordered update governs effective
effort; differing sequential values are valid. Top-level `wireOptions` retain
their original provenance and are never populated from input controls. Additional
update fields and unknown efforts are rejected by the shared parser. The existing
sanitizer preserves only this finite contract, with no input or message content.
`helperSelectionMode` and `helperSelectionRevision` are added only by the Node
observation owner from the exact captured helper selection after existing permit
rechecks; controller-supplied selection proof is rejected. Older records remain
readable, but cannot qualify a missing live witness. Active-session fallback keeps
its actual tuple and revision rather than inheriting the configured helper tuple.

## Assistant image syntax

`lib/assistant-image-sources.js` is the dependency-free parser shared by the UI candidate projection and authoritative web authorization. It recognizes supported Markdown image/link forms while masking escaped syntax and code, canonicalizes local/file/raw/HTTP/data sources, rejects SVG and unsupported schemes, and can strip load-bearing image syntax without removing surrounding prose. `testing/assistant-image-fixtures.js` is the golden parity set consumed by both hosts.

Codex usage and optional reset-bank reads reject redirects, use 20/10-second
timeouts and reuse bounded 64-KiB response parsing. A usage 401 exposes
`REAUTHENTICATION_REQUIRED`; native hosts can report renewal pending because
OpenCode owns refresh. Optional reset failures preserve the main allowance.

`lib/event-types.js` canonicalises pre-rename `openchamber:*` event identities
for journal and in-process readers. New synthetic events use `devryan:*`; the
web stream owner translates only the leading serialized type for older clients.
