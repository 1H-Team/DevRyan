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
main and legacy Tauri have no new recovery backend.

Host environment settings, applied only when the host is launched:

| Setting | Default | Meaning |
| --- | --- | --- |
| `DEVRYAN_PRIMARY_RECOVERY_MODE` | `observe` for OpenAI | `off`, `observe`, or `enforce`; an explicit value also supplies the Claude fallback |
| `DEVRYAN_ANTHROPIC_RECOVERY_MODE` | explicit global value, otherwise `enforce` | Claude override: `off`, `observe`, or `enforce`; enforcement still requires Claude conformance |
| `DEVRYAN_PROVIDER_PROGRESS_TIMEOUT_MS` | `300000` | Semantic progress deadline; `0` disables this watchdog |

These settings do not overwrite provider `headersTimeout`, `chunkTimeout`, or
`timeout`, or any explicit user override. Observe records decisions but neither
aborts a suspected stall nor sends automatic recovery. Existing renderer
recovery remains the fallback until host enforcement is advertised.

Enforcement requires a live managed runtime, exclusive private file-lock owner,
healthy durable storage, an allow-listed OpenCode version verified through
`/global/health` (`PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS` in
`provider-recovery-policy.js`: 1.18.25, 1.18.26, 1.18.27, 1.18.29 and 1.18.30, the current host target
pin), and the bundled plugin handshake. Unsupported versions, external
runtimes, and opt-in WebSocket/native transports remain manual. Do not expand
this allowlist without transport and hook conformance tests.

A handshake in another directory is insufficient: the exact admitted turn must
also have a pre-request hook receipt from that runtime instance, and the failed
assistant must match that receipt. Stale session errors are only reconciliation
signals; they cannot authorize stopping or recovering a newer invocation.

The plugin allows ten seconds for the initial private handshake because the
host's live health verification has its own five-second deadline. Subsequent
private RPCs retain their five-second deadline. Neither path retries failed
requests or bypasses verification; transport failures identify the RPC action
and request/response phase without including bridge credentials.

The version gate follows OpenCode's [plugin hooks](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/plugin/src/index.ts),
[request preparation](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/llm/request.ts),
and [tool registry](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/tool/registry.ts).
`OPENCODE_EXPERIMENTAL_WEBSOCKETS` and `OPENCODE_EXPERIMENTAL_NATIVE_LLM`
disable enforcement until separately validated.

## Claude conformance gate

The host/controller accepts an `isAnthropicConformant(record, runtimeVersion)`
attestation from its composing adapter. Its default is false. This is not an
HTTP request field or environment bypass. Claude's provider mode takes
precedence over the explicit global mode, but neither can replace the runtime,
per-turn hook, authorization, storage, or Claude integration checks. OpenAI's
existing default stays observe. Existing accepted recoveries retain their tool
guards after capability loss, rollback, and restart.

The current production web/Electron composition does not attest the managed
`opencode-with-claude`/Meridian/Agent SDK path: its full recovery transport and
native-tool conformance has not been established. Consequently Claude still
uses manual recovery there, even if its requested mode is enforce. The isolated
fake-provider fixture supplies its own test-only attestation; a pass from that
fixture must never be promoted to production Claude conformance. No installed
runtime, dependencies, provider timeout, or running application setting is
changed by this work.

The September 9 incident (`ses_f79443fdbffe6LFuH0cTDWNLNM`, assistant
`msg_086dd906e001mqkNXEeII0GNDN`) used `anthropic/claude-opus-5`. Its finalized
`UnknownError` contained the 208771 ms stall envelope, without a corresponding
`session.error` in the inspected window. A pending `edit` subsequently became
an error; the journal does not prove whether it executed. There were no recorded
session gaps; the gap scan reported unrelated Bot network gaps. The cached
Meridian 1.62.6 source emits this envelope for its upstream-idle error, but there
is no wire/SDK trace establishing why this request stopped producing data.
A finalized failure with any unresolved tool yields
`recovery_tool_outcome_unknown` with zero automatic attempts. The user must
review the outcome and explicitly continue; tool-error labels alone never prove
that no side effect occurred.

## Safety contract

Only admitted primary OpenAI and Anthropic user turns are observed. Model, agent, reasoning
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
transcript and blocker checks. Generic timeout wording is ineligible; a bounded, valid JSON envelope with `type: upstream_timeout` and the exact `Upstream stalled: no data for <positive milliseconds>ms` message is classified as a chunk timeout on verified runtime versions. The presentation classifier maps the same envelope to `stream_idle_timeout`. The exact
`UnknownError` timeout shape of an allow-listed runtime (1.18.25, 1.18.26, 1.18.27, 1.18.29, 1.18.30) has
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
- Ordinary prompt and abort routes use the same controller.
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
are added to recovery metadata. Finalized assistant-message errors also trigger identity-checked reconciliation without requiring `session.error`. Signals arriving during an existing read cause a fresh coalesced read. Lifecycle tracking records `turn_failed` for final assistant errors; when idle arrived first, it emits one correction for that same retained turn, leaving newer turns untouched. Session errors produce `turn_failed` unless
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

OpenCode 1.18.29 compatibility was verified on September 5, 2026 with the same
isolated loopback-provider fixture. Heartbeat-only traffic completed exactly one
automatic recovery. Missing headers, silent SSE and a stalled non-SSE body
reached the native-retry fence with one provider request and zero recovery
attempts. Semantic cutoff also made only one request and no recovery attempt.

OpenCode 1.18.30 compatibility was verified on September 9, 2026 with the
isolated loopback-provider fixture. Heartbeat-only OpenAI traffic and the exact
Anthropic upstream-timeout envelope each completed one recovery with two provider
requests. Semantic cutoff and interrupted Anthropic tool input each made one
provider request and zero recovery attempts; both stopped for user attention.

The opt-in executable fixture is `tests/provider-recovery/runtime-conformance.mjs`.
It requires `DEVRYAN_TEST_OPENCODE_BIN` and has no access to the user's provider
key or application runtime. Cold SDK initialization exceeded test startup bounds
in some local runs; the non-SSE and semantic cases passed using the already
initialized isolated fixture directory. These results validate recovery outcomes,
not the identity of the transport timer that fired or the historical incident's
wire behavior. Packaged Electron visual acceptance, OAuth-specific
transport behavior, and the remaining full release matrix below are not signed
off by the shared fixture checks.

Before enabling enforce in a release, additionally run the packaged web/Electron
acceptance matrix against an isolated OpenCode process/provider
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


### Claude timeout verification — September 9, 2026

- The focused recovery/controller/host, lifecycle, classifier, UI-error, and
  recovery-store run passed 148 tests. A subsequent targeted check also verified
  that a failed old observation is logged against the original user message.
- Real OpenCode 1.18.29 with a loopback fake Anthropic provider completed exactly
  one recovery for the reported upstream-timeout envelope and heartbeat-only
  transport failure. Interrupted edit arguments made one provider request,
  zero recovery attempts, and left the fixture sentinel unchanged.
- Additional silent-SSE, semantic, missing-header and non-SSE runs failed during
  isolated OpenCode startup/session initialization, before their provider
  fault scenarios ran. These are unavailable conformance checks, not passes.
  All owned native fixture processes/directories were cleaned up; reports are
  retained locally under `.cache/claude-recovery-native-evidence`.
- The real shared browser component was checked for Claude timeout wording,
  uncertain-edit attention, explicit continuation, Stop, and disconnect/reconnect.
- The bundled recovery plugin passed all 14 contract tests, including Claude
  identity and tool-guard coverage. `bun run bundle:check` and the final
  workspace type-check rerun passed.
- `bun run build` passed for web and Electron. Full validation passed lint,
  type checks and documentation validation, then failed in six repository-script
  tests. Both agent-evaluation failures passed a serial rerun; the bootstrap
  retry-count assertion and three release-smoke timeouts still failed.
- Continued package checks passed orchestration (399 tests), Cursor, Electron,
  legacy desktop, shared runtime, and the Bot suites except egress. The broad
  harness run hit repeated failures/timeouts in the separate session-change
  work and was interrupted after retaining those failures; focused recovery
  tests passed independently. UI had 3595 passes and one hard-coded-label source
  scan timeout, which also timed out in isolation. The web run also reported
  scoped-revert and Git fixture failures and was interrupted before completion;
  its recovery plugin was checked separately. No failing assertions or test
  deadlines were weakened. Full-suite validation is not claimed green.

These tests do not certify the managed Meridian/Claude Agent SDK connection.
The production Claude conformance gate therefore remains closed.
