# Primary provider recovery

## Incident evidence and scope

The August 30, 2026 incident in `ses_fabc85566ffe6tFmBYAM8iX5Ws` expired after
900.295 seconds, matching the configured total transport deadline. OpenCode
1.18.25 and its resolved OpenAI configuration supported the shorter header and
chunk limits. Forty-one completed tools preceded a blank failed model step;
idle preceded message finalization. Neither journal gap scan found gaps.

There is no historical wire trace showing why the shorter limits did not fire.
Raw SSE heartbeat bytes can reset the transport chunk timer. That mechanism is
verified; its involvement in this particular request remains a hypothesis.
Current configuration is not a historical per-request snapshot. This change
does not replay the incident or change the running application's settings.

## Ownership and policy

`packages/harness-runtime/lib/provider-recovery.js` owns durable admission,
semantic liveness, settlement, cancellation and the single automatic attempt.
`provider-recovery-host.js` implements the shared HTTP-shaped contract and
bounded OpenCode reads. The web harness composes it for web and Electron;
`packages/vscode/src/extension.ts` composes the same host for VS Code. Electron
main and legacy Tauri have no new recovery backend.

Host environment settings, applied only when the host is launched:

| Setting | Default | Meaning |
| --- | --- | --- |
| `DEVRYAN_PRIMARY_RECOVERY_MODE` | `observe` | `off`, `observe`, or `enforce` |
| `DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS` | `300000` | Semantic progress deadline; `0` disables this watchdog |

These settings do not overwrite provider `headersTimeout`, `chunkTimeout`, or
`timeout`, or any explicit user override. Observe records decisions but neither
aborts a suspected stall nor sends automatic recovery. Existing renderer
recovery remains the fallback until host enforcement is advertised.

Enforcement requires a live managed runtime, exclusive private file-lock owner,
healthy durable storage, an allow-listed OpenCode version verified through
`/global/health` (`PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS` in
`provider-recovery-policy.js`: 1.18.25, 1.18.26 and 1.18.27, the current host target
pin), and the bundled plugin handshake. Unsupported versions, external
runtimes, and opt-in WebSocket/native transports remain manual. Do not expand
this allowlist without transport and hook conformance tests.

A handshake in another directory is insufficient: the exact admitted turn must
also have a pre-request hook receipt from that runtime instance, and the failed
assistant must match that receipt. Stale session errors are only reconciliation
signals; they cannot authorize stopping or recovering a newer invocation.

The version gate follows OpenCode's [plugin hooks](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/plugin/src/index.ts),
[request preparation](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/llm/request.ts),
and [tool registry](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/tool/registry.ts).
`OPENCODE_EXPERIMENTAL_WEBSOCKETS` and `OPENCODE_EXPERIMENTAL_NATIVE_LLM`
disable enforcement until separately validated.

## Safety contract

Only admitted primary OpenAI user turns are observed. Model, agent, reasoning
variant, canonical directory and prompt tool restrictions are captured at
admission. Managed children and title helper calls are excluded. Managed parent
wakes use fresh sortable IDs and the same primary admission boundary without
creating another recovery budget. Queued input records an intent fence before
the UI clears its draft; it does not abort ordinary work.

The pre-request hook starts semantic timing. New text, reasoning and tool-input
changes count as progress. Busy repetition, accounting changes, heartbeat bytes
and reconnection do not. Verified tool execution, questions, permissions, and
native retry backoff suspend timing. A fresh canonical read rechecks identity,
progress and blockers before a watchdog stop. The watchdog never restarts
OpenCode and never cancels managed descendants. Its result is a local suspected
stall, which alone cannot authorize recovery.

OpenCode 1.18.25's [processor](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/processor.ts)
does not publish incremental tool-argument deltas after creating a pending tool
part. This phase cannot satisfy the originally proposed progress-observation
contract. When the deadline encounters pending arguments, the host reports
`provider_input_progress_unavailable`, keeps Stop available, and suspends the
semantic cutoff until an observable phase resumes. It does not label argument
generation as tool execution or infer a stall from missing events. Existing
transport deadlines still apply. Full tool-input liveness needs a future runtime
capability; do not claim it is implemented by the current canonical event feed.

Before recovery, the host requires a narrowly classified transient error,
finalized exact assistant/parent identity, complete canonical turn, valid live
status, no execution with an unknown outcome, no pending permission/question or
managed barrier, current authorization, and an unused budget. Settlement is
bounded to 30 seconds with bounded individual observations. Idle, an abort
acknowledgement, a failed read, and renderer-forced idle are not sufficient.
Healthy status-map omission is accepted only with independent session,
transcript and blocker checks. Generic timeout wording is ineligible; the exact
`UnknownError` timeout shape of an allow-listed runtime (1.18.25, 1.18.26, 1.18.27) has
a version-specific compatibility rule.

With no prior work, recovery reuses original text and safe file/data attachment
references. Otherwise it appends a continuation. It never removes history,
reverts files, truncates tool results or executes recorded calls. The prompt is
not the safety boundary: every known tool is explicitly disabled except verified
native `read`, `glob`, and `grep`, intersected with original restrictions. The
plugin rechecks the registry for collisions and guards execution independently.
Shell, writes, browser actions, delegation and unverified MCP tools are denied.
A blocked action ends recovery and requests explicit user continuation.

Reservation, attempt count and the recovery message ID are persisted before
the one POST. The ID is correlation, not assumed server execution idempotency.
An ambiguous POST is never resent. Restart reconciliation only reads durable
admissions; it never scans history to discover old failures. Existing accepted
recovery is observed without resubmission. Cancellation markers and consumed
attempts survive restart. Stop persists its fence before requesting abort and
descendant cancellation; the UI distinguishes this acknowledgement from proven
settlement. Failed descendant cancellation does not prevent the primary abort.

Private records are bounded by count (1000), aggregate bytes (10 MiB), per-read
bytes (128 KiB), guarded identities per session (128), and seven-day terminal
retention. Active or uncertain guards are not pruned to make room: admission
fails closed at capacity. Corrupt/quarantined storage disables safeguards and
prevents an unknown recovery from executing tools. Do not delete recovery
records as a troubleshooting shortcut while work may remain active.

## Public contract

- `GET /api/session/:sessionID/recovery`: version-1 snapshot, fixed selection,
  state/revision, attempt count, restrictions and capability.
- `POST .../recovery/cancel`: version-checked durable Stop; abort is requested,
  but the response explicitly does not claim settlement.
- `POST .../recovery/intent`: version-checked queued-user-input fence.
- `POST .../recovery/continue`: explicit new user turn after settlement, using
  original permissions and a fresh caller-supplied message ID. No implicit retry
  after uncertain delivery.
- Ordinary prompt and abort routes use the same controller. VS Code's proxy
  handles the identical contract without the `/api` prefix.
- `openchamber:primary-recovery`: versioned per-session snapshot event. The UI
  uses a bounded narrow store and refreshes after reconnect and while visible.

Web routes retain normal authentication and session ownership middleware;
automatic actions revalidate the saved application-session hash and current
ownership. Hashes and private directory/tool policy data are never published.

## Diagnostics

Lifecycle records correlate runtime instance/version, host build (or explicitly
unavailable), session, original/failed/recovery message IDs, and tool call IDs.
They record phase, last meaningful progress, elapsed silence, blockers,
classification source, stop decisions, reservation, control and uncertain
submission. Provider option values are observations at the pre-request hook,
not an assertion about hidden OAuth/transport internals. Wire timing and request
IDs remain unavailable. No prompts, tool arguments, credentials or raw headers
are added to recovery metadata. Session errors now produce `turn_failed` unless
they carry an explicit abort type; they are not all labelled user cancellation.

## Verification and rollout

Run the focused Bun controller/host/lifecycle suites, the web Vitest plugin and
managed-orchestration suites, affected validation, full type-check and lint.
The browser fixture at `tests/visual-provider-recovery` mounts the real component
with an isolated API adapter. It covers recovery status, Stop, blocked actions,
disconnect/reconnect and explicit continuation without provider access.

Implementation verification, August 30–31, 2026:

| Check | Result |
| --- | --- |
| Full harness plus recovery-store suites | 139 passed |
| Focused web plugin, managed-orchestration, overlay and harness suites | 139 passed |
| Focused VS Code bridge and managed-runtime suites | 54 passed |
| Full `bun run type-check` and `bun run lint` | Passed |
| `bun run validate:affected` | Lint/type-check passed; aggregate stopped on seven failures in existing script suites |
| Separate rerun of those script suites | All 45 passed; aggregate validation is not claimed green |
| Real OpenCode 1.18.25 with loopback fake provider | Heartbeat-only, missing headers, silent SSE and stalled non-SSE body each recovered exactly once |
| Semantic cutoff with heartbeat traffic | One provider request, `needs_attention`, zero automatic recovery attempts |
| Shared browser component | Status, Stop, blocked action, disconnect/reconnect and explicit continuation checked |

OpenCode 1.18.27 compatibility was verified on September 3, 2026 with the
isolated loopback-provider fixture. Heartbeat-only traffic completed exactly one
automatic recovery. Missing headers, silent SSE and a stalled non-SSE body
reached the native-retry fence with one provider request and zero recovery
attempts. Semantic cutoff also made only one request and no recovery attempt.
The plugin hooks, request preparation, tool registry and processor sources are
unchanged from 1.18.26. See [upgrade notes](OPENCODE_1_18_27_UPGRADE_NOTES.md).

The opt-in executable fixture is `tests/provider-recovery/runtime-conformance.mjs`.
It requires `DEVRYAN_TEST_OPENCODE_BIN` and has no access to the user's provider
key or application runtime. Cold SDK initialization exceeded test startup bounds
in some local runs; the non-SSE and semantic cases passed using the already
initialized isolated fixture directory. These results validate recovery outcomes,
not the identity of the transport timer that fired or the historical incident's
wire behavior. Packaged Electron/VS Code visual acceptance, OAuth-specific
transport behavior, and the remaining full release matrix below are not signed
off by the shared fixture checks.

Before enabling enforce in a release, additionally run the packaged web/Electron
and VS Code acceptance matrix against an isolated OpenCode process/provider
fixture: missing headers, silent SSE, OAuth/SSE heartbeats, non-SSE stalled body,
tool-input progress, reasoning, blockers, sleep, restart at each dispatch phase,
native retry fencing and simultaneous windows. WebSocket remains unsupported.
Do not touch a user's provider credentials, firewall, live connection or runtime
to inject these faults. Passing the shared browser fixture is not native-shell
acceptance. Keep observe as the shipping default until this release gate passes.

Monitor cutoff frequency, late progress, recovery success, blocked actions,
uncertain stops, duplicate-dispatch detections, and cancellation latency. A
duplicate side effect or recovery after acknowledged Stop blocks release.

Rollback switches policy to `off` or `observe` at the host. Retain durable
records, cancellation fences, diagnostics and the bundled guard plugin. Already
accepted recovery remains read-only and is observed through settlement. Removing
the plugin or deleting state is not a safe rollback.
