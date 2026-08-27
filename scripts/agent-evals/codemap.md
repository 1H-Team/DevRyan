# scripts/agent-evals/

## Responsibility

Non-interactive evaluation of pinned agents through an already-running DevRyan loopback API, with deterministic fixture/test/tool/task grading, bounded read-only Oracle review cases, and optional macOS Electron process-tree sampling. The harness does not start providers, discover credentials, or change production lifecycle behavior.

## Entrypoints and modules

- `main.mjs`: CLI entrypoint. It accepts exactly `--config <path>`, prints only stable status/error codes, and exits nonzero for failed graders or execution errors.
- `config.mjs`: strict schema-v1 validation. Required fields are `schemaVersion`, `fixtureRoot`, `devRyanBaseUrl`, `providerId`, `modelId`, `agent`, `variant` (string or explicit `null`), `caseIds`, `repetitions`, `timeoutMs`, and `reportDirectory`. Unknown fields fail closed.
- `runner.mjs`: captures the initial fixture manifest before any session/report IO, executes the configured matrix, optionally runs the memory profile, verifies restoration, and writes the aggregate report. Fatal execution state and planned/completed run counts are projected honestly even when no case result exists.
- `cases.mjs`: owns the `inspect`, `context-large-analysis`, `context-explorer-analysis`, `context-bounded-lookup`, `repair-and-test`, `managed-change`, `oracle-review-focused`, and `oracle-review-deep` prompts and fixtures. Context cases seed a large deterministic two-file route inventory: broad parent and managed Explorer-child cases require applicable Context Mode evidence, while the exact-sentinel control stays on bounded native inspection. Oracle cases seed review-only defects at explicit trust boundaries and supply exact scope, invariants, validation evidence, exclusions, and finding limits. Repair cases retain unique run-owned TypeScript source seeds and Node-20-compatible `.test.mjs` RED/GREEN checks; generated tests load plain-JavaScript-compatible `.ts` source text through a data URL instead of asking Node to import TypeScript directly.
- `client.mjs`: credential-free `/api` client for session create/prompt/status/abort/messages/children, turn-timing diagnostics, and managed-orchestration snapshots. Prompt submission applies the shared provider-specific tool policy without discovering credentials, and every Oracle evaluation disables the ambient tool surface before reopening only approved inspection tools. Completion requires authoritative terminal-message or active-to-idle evidence for the recursive session graph; returned live tasks are always awaited, while orchestration unavailability fails only `managed-change` closed. Oracle grading extracts only whitelisted semantic finding codes, path/line presence, and the terminal completion marker from root-session assistant text; raw response text, paths, and child-session findings never enter case results or reports. Repair test outcomes come only from bounded numeric metadata or a strictly validated Cursor shell-result envelope on the exact direct command, or from an exact canonical wrapper's private trailing exit marker. The wrapper marker is usable only after every present strict outer-carrier exit channel agrees and at least one proves exit zero; absent, malformed, conflicting, or nonzero carrier evidence fails closed while outer zero plus an inner nonzero marker remains legitimate RED evidence. The wrapper remains observable under shell `errexit`. Cursor envelopes accept only the SDK's supported no-signal sentinels (`null` and the exact empty string); non-empty, whitespace, missing, malformed, or conflicting signal evidence fails closed without metadata or marker fallback. A synthetic workspace-patch card is excluded only when the runtime-reserved marker, canonical producer identity, and exact patch/input/output/file structure all agree. Sanitized tool events remain in traversal order without pre-grading ordinals, while their raw start/end intervals are registered through the private evidence handoff. Failure cleanup has one bounded deadline, aborts known descendants before the parent, and returns explicit discovery/completeness evidence.
- `tool-evidence.mjs`: module-private `WeakMap` handoff for raw tool start/end intervals. Grading consumes and deletes entries immediately, so timestamps never become enumerable sanitized fields or report inputs.
- `fixture.mjs`: exact tracked/untracked content manifests, tracked-dirty preflight, collision-safe `src/devryan-eval-<run>.ts` plus `.test.mjs` allocation, surgical deletion, and exact restoration verification. Literal fixture-root and `src` entries must be ordinary directories before canonicalization, and their device/inode identities are revalidated before every owned write/delete; it never invokes reset, checkout, or clean.
- `graders.mjs`: deterministic filesystem/test/tool/managed-task disposition graders. Context routing graders distinguish root and child journal scopes, accept direct and MCP-prefixed `ctx_*` aliases for broad analysis, and reject Context Mode in the bounded native control. Focused Oracle review permits at most 20 completed inspection tools and 15 minutes; deep review permits at most 50 tools and 30 minutes. Both require read evidence, exact expected semantic findings, path/line evidence, and a terminal completion marker while accepting only the inspection-tool allowlist, which excludes validation, mutation, delegation, and external research. Repair evidence must prove an authoritative root-session read → owned-test RED → source mutation → owned-test GREEN chain using finite private intervals, unique completion timestamps, and non-overlapping boundaries; only the selected chain receives safe ordinals. Managed work requires unique exact one-to-one completed task/child/envelope membership and a final `continue` disposition.
- `report.mjs`: whitelist-only schema-v1 report builder and private-mode writer. Reports contain safe/opaque IDs, pinned selections, aggregate and execution status, resource classification, grader counts, and explicit fixture/session cleanup results; no prompt, message, tool IO, header, cookie, credential, URL, path-shaped identifier, response body, or exception text is copied.
- `process-sampler.mjs`: `/bin/ps` argument-array sampler, recursive RSS aggregation, fixed 60-second idle / five-cycle / 30-second settlement profile repeated twice, and report-only retained-growth classification. Samples hash the configured root's PID/start/command identity and become insufficient if the root disappears or changes within or across runs.
- `*.test.mjs`: temporary Git fixtures and fake loopback servers only; no live or billable provider calls.

## Config and sampling contract

Paths may be absolute or repository-relative. `devRyanBaseUrl` must be credential-free HTTP(S) loopback with an empty path or `/api`. Case IDs are `inspect`, `context-large-analysis`, `context-explorer-analysis`, `context-bounded-lookup`, `repair-and-test`, `managed-change`, `oracle-review-focused`, and `oracle-review-deep`.

Optional `processSampling` is strict and explicit:

```json
{
  "electronPid": 12345,
  "caseId": "inspect",
  "intervalMs": 1000,
  "idleSeconds": 60,
  "cycles": 5,
  "settlementSeconds": 30,
  "runs": 2
}
```

The classifier requires one stable configured Electron root across every sample, a final monotonic settlement suffix of at least four samples, and final growth strictly above both 10 percent and 100 MiB in two runs. Missing or replaced roots produce `insufficient-data`. It reports evidence classification only and makes no lifecycle mutation.
