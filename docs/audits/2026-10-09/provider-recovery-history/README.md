# Provider recovery verification history

> Historical — archived 2026-10-09; current contract: [Primary provider recovery](../../../PROVIDER_RECOVERY.md)

Per-version verification records for the legacy OpenCode 1.18.x runtimes and the September 9 Claude timeout verification, removed verbatim from `docs/PROVIDER_RECOVERY.md`. They describe the runtimes and counts of their day and do not qualify any current runtime.

## Incident evidence and scope (removed verbatim)

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


## September 9 incident (removed from the Claude gate section, verbatim)

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

## Implementation and per-version conformance log, August 30 to September 30, 2026

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
unchanged from 1.18.26.

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

The bundled companion runtime reports `<upstream>-devryan.<n>` from
`/global/health`. Its patch does not touch provider transport, request
preparation or error shapes, so compatibility follows the upstream base: only
`<allow-listed version>-devryan.<n>` is accepted. From v1.2.7 until this change,
companion runtimes were treated as unsupported and never recovered automatically.
On September 23, 2026 the fixture below was run against the bundled
`1.18.31-devryan.9` binary. Heartbeat, silent-SSE, non-SSE, missing-header and
Anthropic upstream-timeout traffic each completed one recovery with two provider
requests; non-SSE needed one rerun for the documented cold start. Semantic cutoff
and interrupted Anthropic tool input each made one request and zero recovery
attempts, stopping for user attention.

OpenCode 1.18.31 compatibility was verified on September 14, 2026 with the
isolated loopback-provider fixture. Heartbeat, silent-SSE, non-SSE, and
missing-header traffic each completed one recovery with two provider requests.
The Anthropic upstream-timeout envelope also completed one recovery. Semantic
cutoff and interrupted Anthropic tool input each made one provider request and
zero recovery attempts; both stopped for user attention.

OpenCode 1.18.32 compatibility was verified on September 24, 2026 with the
isolated loopback-provider fixture against the bundled DevRyan companion 2.1.0
(upstream 1.18.32). Heartbeat, silent-SSE, non-SSE, missing-header and Anthropic
upstream-timeout traffic each completed one recovery with two provider requests;
heartbeat needed one rerun for the documented cold start. Semantic cutoff and
interrupted Anthropic tool input each made one provider request and zero
recovery attempts, stopping for user attention.

OpenCode 1.18.33 compatibility was verified on September 30, 2026 with the
isolated loopback-provider fixture against the bundled DevRyan companion 2.1.2
(upstream 1.18.33). Heartbeat, silent-SSE, non-SSE, missing-header and Anthropic
upstream-timeout traffic each completed one recovery with two provider requests;
missing-header needed one rerun. Semantic cutoff and interrupted Anthropic tool
input each made one provider request and zero recovery attempts, stopping for
user attention. The allow-list also gates managed continuation (the wake that
makes a parent collect a finished sub-agent's result), which was fenced as
`runtime_unsupported` on 1.18.33 until this verification.

## Claude timeout verification, September 9, 2026

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
