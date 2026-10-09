# Primary provider recovery

## Why this exists

A primary provider turn can stall while raw SSE heartbeat bytes keep resetting
the transport chunk timer, so the configured header and chunk limits never
fire and the turn expires only at the total transport deadline. Recovery
therefore watches semantic progress rather than bytes. The mechanism is
verified; its involvement in any one historical request cannot be proven
without a wire trace. Recovery does not change provider settings of the
running application. Incident evidence is in the
[verification history](audits/2026-10-09/provider-recovery-history/README.md).

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
`/global/health`, and the bundled plugin handshake. Unsupported versions,
external runtimes, and opt-in WebSocket/native-LLM transports remain manual.

Recovery is enabled per reviewed release, by exact version. Two allow-lists in
`packages/harness-runtime/lib/provider-recovery-policy.js` carry the versions:

- `NATIVE_PRIMARY_SUPPORTED_OPENCODE_VERSIONS`, tested through
  `isNativePrimaryRuntimeVersion`, covers the native generation-2 runtime that
  is the current execution path. Native Step and continuation ownership has its
  own conformance, so a native release is added only after the fixture below
  passes against that release's bundle. A version missing from the list is
  fenced as `recovery_runtime_unverified` or `runtime_unsupported` and stays
  manual.
- `PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS` covers the legacy 1.x
  generation. It gates the 1.x transport-error shape, managed collection
  continuation and retained rollback only; it does not make a 1.x runtime the
  current one, and it is never extended for new releases.

Read the constants for the exact versions rather than copying them into
documents. Do not expand either list without transport and hook conformance
tests.

A handshake in another directory is insufficient: the exact admitted turn must
also have a pre-request hook receipt from that runtime instance, and the failed
assistant must match that receipt. Stale session errors are only reconciliation
signals; they cannot authorize stopping or recovering a newer invocation.

The plugin allows ten seconds for the initial private handshake because the
host's live health verification has its own five-second deadline. Subsequent
private RPCs retain their five-second deadline. The read-only scope lookup retries one failed request/body read with a fresh
five-second budget; host rejections and all mutating RPCs remain single-attempt.
An exhausted scope lookup stays fail-closed. Transport failures identify the RPC
action and request/response phase without including bridge credentials; the UI
identifies these as local recovery-service failures, not provider outages.

The version gate follows OpenCode's plugin hooks, request preparation and tool
registry for the release in question; a release that changes any of them needs
fresh conformance evidence before it is listed.
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

A finalized Claude `UnknownError` carrying the upstream stall envelope is a
classified chunk timeout, but the incident that exposed it
([history](audits/2026-10-09/provider-recovery-history/README.md)) shows a
pending tool may already have run. A finalized failure with any unresolved tool yields
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

The OpenCode processor does not publish incremental tool-argument deltas after
creating a pending tool part. The current event feed cannot satisfy the originally proposed progress-observation
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
`UnknownError` timeout shape of an allow-listed legacy runtime has a
version-specific compatibility rule.

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
admissions; it never scans history to discover old failures. It runs once per
runtime instance (not on every plugin hello), with at most eight observations at
a time, and writes one `provider_recovery_sweep_summary` record. A stored
objective from a replaced runtime is retired (`superseded`,
`recovery_runtime_replaced`) only when OpenCode answers 404 for the session
itself. A busy or restarting runtime is transient and never retires anything.
Existing accepted
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

Verification of each reviewed release is recorded as a paragraph in the
[verification history](audits/2026-10-09/provider-recovery-history/README.md):
the isolated loopback-provider fixture (`tests/provider-recovery/runtime-conformance.mjs`)
runs heartbeat-only, silent-SSE, non-SSE, missing-header and Anthropic
upstream-timeout traffic, each expected to complete exactly one recovery, and
semantic cutoff plus interrupted Anthropic tool input, each expected to make one
provider request with zero automatic attempts. A release is added to an
allow-list only after that fixture passes against its executable. The bundled
companion runtime of the legacy 1.x line reports `<upstream>-devryan.<n>`; its
patch does not touch provider transport, so compatibility follows the upstream
base version exactly.

The bundled plugin's hooks only observe while the host does not enforce
recovery (its hello reports `enforced: false`: observe mode, or a runtime it
cannot act on). In that state an unreachable host, for example one whose event
loop stalled under load, no longer fails the user's turn: a scope verdict that
cannot stop a turn is reused for 30 seconds, until the next user message, and a
transport failure proceeds. A host rejection (an error code) and a session last
seen guarded always stand. `DEVRYAN_RECOVERY_ADVISORY_PLUGIN=0` restores the
fail-closed hooks and the one-second poll of every record.

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




## Collecting a user-recovered child after a parent failure

A completed child result remains in the managed ledger until explicitly
acknowledged. A `collect` continuation can follow a finalized parent transport
failure only with a scheduler proof of a completed, unacknowledged same-child
recovery. The proof binds the task/envelope, root, directory, dispatch group,
attempt and live plugin claim. Its recovery must start after the failed parent
step, and the dispatch group must belong to the admitted objective. Automatic
backup attempts and ordinary completed children do not authorize this exception.
The legacy API connection wording is matched exactly and version-gated; this
exception does not broaden ordinary automatic provider retry eligibility.

Cancellation, supersession, questions/permissions, unresolved tools, changed
model/agent, owner replacement, read-only recovery and rejection fences remain
in force. Admission persists the wake's message ID and cancellation generation
before the plugin sends its single POST. After an ambiguous acknowledgement or
restart, a matching canonical synthetic user message confirms delivery. An
absent message requires explicit continuation rather than another generated ID.
A completed child is never relaunched by the collection path.

Permanent admission failures publish a small `collectionIssue` in the parent
projection and a reason-coded `managed_collection_rejected` diagnostic. The
plugin stops retrying that task's admission fence. The parent shows "Sub-agent
result ready — parent paused" with a Collect Result action that uses the explicit
continuation API; stored results and diagnostics remain available, and ordinary
user input can also resume the parent. Unreadable (not missing) outcome evidence
is retried, with plugin recovery scans backing off from 1 s to 8 s; after five
consecutive unreadable attempts the task is also published as a
`managed_collection_unverified` issue so the user can collect it. A busy or
superseded turn is fenced regardless of evidence. An explicit continuation records
`objectiveID`, the objective it continued, so compaction re-anchors to the user's
objective rather than the continuation text. Explicit continuation rechecks
live settlement, pending requests, current objective, revision and permissions
before a fresh user-authorized prompt; the completed result stays intact.

Regression coverage includes the real scheduler, plugin and primary host with
an API-error tail, host restart, user recovery, competing watchers, lost HTTP
acknowledgement, result collection and acknowledgement. The disposable
`tests/visual-provider-recovery/` fixture also exercises the retained-result
presentation without provider access.

The version-1 public record also exposes optional `failureObserved`. It reports an unresolved observed error in observing/needs-attention state independently of automatic-recovery support. The shared chat uses it as a sanitized fallback after reconnect when the original notification was missed; it does not establish provider blame, settlement, or permission to retry.
