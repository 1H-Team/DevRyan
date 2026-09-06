# Bot settings and operations simplification

Date: 2026-08-27

This document records the product research, migration boundaries, target
information architecture, and acceptance plan for the simplified Bot
experience. It distinguishes the current product from compatibility machinery
that remains in storage or runtime code.

## Research summary

### Hands-on Grokbot observations

The test Bot was created and exercised through Grokbot's product UI before the
DevRyan design was changed.

- Creation was short and outcome-first. A usable Bot did not require policy,
  endpoint, filesystem, or network configuration.
- Direct questions stayed in the conversation and needed no setup.
- Scheduling was presented as a routine/task rather than a deployment feature.
  The creation path was simple, although one recurrence attempt did not settle
  cleanly during the test.
- Files could be supplied as work material without a separate source-library
  model.
- Browser work provisioned a computer and exposed a takeover/screen-sharing
  path for interactive sign-in.
- Service integrations were global plugin/account connections, not a per-Bot
  transport configuration exercise.
- Consequential work used an explicit confirmation request with direct actions.
- The computer and browser state survived navigation during the observed
  session. Long-term authenticated-session persistence was not claimed from a
  single test window.
- Responsiveness was generally direct for chat and ordinary tool use, but some
  computer/routine work was visibly slower and one operation appeared stuck.
  The useful lesson is the small configuration surface, not that every observed
  behavior should be copied.

The scenarios exercised were: question answering, schedule creation, file
work, browsing, interactive sign-in/takeover, available service connections,
and an action requiring confirmation.

### Concise comparison

| Experience | Strongest product idea | Friction relevant to DevRyan | Direction used here |
| --- | --- | --- | --- |
| Grokbot | A Bot is useful immediately; computer, files, takeover, confirmations, and connections appear when the work needs them. | Some slower/stuck operations; long-term login persistence was not proven in the test. | Adopt capability-first defaults and small, task-named surfaces. |
| [Openbot](https://github.com/CopilotKit/openbot) | A persistent remote computer/browser makes normal web and file work possible, with human takeover for interactive steps. | Its repository includes more deployment and policy concepts than a Bot owner should configure day to day. | Keep the persistent-computer model, but hide infrastructure and policy implementation. |
| DevRyan before this change | Strong governance, immutable run pinning, encryption, recovery, and auditability. | Overview, Files, Library, Permissions, roles, revisions, bundles, policy matchers, adapter/MCP configuration, and Activity exposed implementation details. | Preserve the security boundaries internally while presenting Overview, Resources, Memory, Members, Routines, and Lifecycle. |

Memory research also reviewed the bounded, curated memory approach documented
by [Hermes Agent](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
and its [memory manager implementation](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_manager.py).
The applicable pattern is small durable facts, asynchronous post-turn
extraction, explicit forgetting, and prompt retrieval by relevance—not placing
an ever-growing transcript or every Skill body in ordinary context.

## Runtime evidence behind the memory change

The DevRyan diagnostic journal was inspected before changing code. It reported
no qualifying gaps. Code/runtime tracing then found three concrete causes:

1. The memory runtime was created only after execution/index startup, so memory
   administration could exist in the UI before the extraction path existed.
2. Automatic extraction was awaited by the run dispatcher, adding post-run
   latency even though memory is not required to complete the user's request.
3. Memory writes did not emit a renderer event, so Remembered and Forgotten
   could remain stale until a manual reload.

The new model constructs the memory boundary independently of execution
startup, performs completed-turn extraction asynchronously with tracked
shutdown, emits `memory.changed` after extraction/edit/merge/forget/restore,
refreshes the visible console from that event, and uses a low-frequency visible
poll only as transport recovery. **Remembered** means a current retrievable
fact. **Forgotten** means an explicit tombstone or a superseded duplicate; it is
not an ambiguous confidence bucket.

## Affected component inventory

| Layer | Primary affected components |
| --- | --- |
| Settings UI | `BotEditor`, `BotDetails`, `BotComputerFiles`, `BotSkills`, `BotCredentials`, `BotEnvironmentSecrets`, `BotMemoryConsole`, `BotMemberships`, `BotRoutines`, `BotLifecycleActions`, `BotsPage` |
| Operations UI/state | `BotOperationsRail`, `BotCurrentRun`, `BotApprovalsTab`, `useBotOperationsNavigationStore`, transcript action presentation |
| Renderer API/events | `botsApi`, `botsDesktopApi`, `BotsEventOwner`, native file/folder dialog and Finder reveal bridge |
| Server HTTP/domain | Bot management, capability bindings, routes, policy engine, approval service, memory runtime, library/index rebuild boundary, computer-resource import |
| Persistence/index | Existing Bot/revision/capability tables, encrypted environment/provider secrets, computer-resource manifest, encrypted reference projections, Bot memory rows and tombstones |
| Execution runtime | OpenCode-only new activation, default tool/network/computer policies, no MCP connector registration, asynchronous memory extraction, persistent computer/browser profile |
| Native/supervisor | Electron resource import and Finder integration, bounded safe workspace archive writes, persistent Bot computer volume |

## Removal and migration plan

### UI-only removals

- Remove Short summary, Advanced, extra instruction, Permissions, Activity,
  Reference Library, Manage Sources, revisions, imports/exports, recovery
  bundles, policy matchers, access controls, network-isolation choices, AG-UI,
  MCP, and role-selection surfaces.
- Rename Files to Resources and place computer files, optional Skills, provider
  credentials, and environment secrets there.
- Present only Active, Paused, and Deleted. Present routine retirement as
  Delete and omit retired rows.
- Keep Current Run, Computer, Confirmations, and Shared in operations.

### Runtime behavior changes

- New Bot configurations are OpenCode-only. New AG-UI activation is rejected.
- MCP assignment creation returns `410`, MCP is not registered as an execution
  connector, and activation does not preflight retained legacy MCP bindings.
- New and newly saved configurations clear MCP bindings plus operating,
  prohibited, and advanced instruction layers. Optional Skills remain pinned
  SOP packages and are materialized for OpenCode's on-demand Skill loading.
- The server—not a hidden form—enforces full file/runtime tools, public internet,
  the standard computer boundary, persistent browser profile, and allow-by-
  default ordinary actions. Hard safety checks and confirmation for genuinely
  consequential actions remain.
- Every active member may operate a Bot. Internal settings authorization does
  not reduce the Bot's ability to perform a request from an allowed member.
- Computer resource import copies safe files/folders into
  `/workspace/Resources`; bounded text content is automatically indexed as a
  Bot reference.
- Memory extraction no longer delays run completion and memory changes refresh
  the UI from authoritative events.

### Data-model and API handling

- No destructive database migration is required for this rollout.
- Historical revision rows, run-pinned revision IDs, legacy Library rows,
  recovery data, AG-UI descriptors, MCP rows, and role values remain readable so
  deployed clients, in-flight runs, purge, audit, and migration code do not lose
  integrity.
- User-facing revision/import/export/bundle APIs have no current UI consumer.
  They remain internal compatibility surfaces until deployed-client telemetry
  proves removal is safe.
- Legacy MCP APIs retain read/detach/cleanup behavior, but cannot attach or
  execute an MCP server.
- `retired` remains an internal transitional value for existing rows and safe
  deletion/purge, while the product lifecycle is Active, Paused, Deleted.

### Compatibility and security that must remain internal

- Immutable revision snapshots for admitted/in-flight run reproducibility.
- Optimistic concurrency, encrypted secrets, scoped credentials, audit records,
  purge compensation, and the final settings-authority invariant.
- Browser profile isolation, secret redaction, public-only egress enforcement,
  confirmation identity/hashes, control leases, and human takeover boundaries.
- Existing active AG-UI execution compatibility until those deployments are
  migrated; it is not selectable or activatable for new configurations.
- Legacy recovery/import parsing needed to restore or delete old data safely;
  it is not a Bot-owner feature.

## Simplified information architecture

### Bot settings

1. **Overview** — name, title, avatar, Soul/personality, Standing Role,
   Objectives, Provider, Model, Thinking, status. Core identity is revision-backed and applies to future
   runs; advanced instruction and token controls remain hidden.
2. **Resources** — built-in capability summary; computer files/folders; optional
   Skills/SOPs; protected provider API keys/accounts; environment secrets.
3. **Memory** — Remembered and Forgotten facts with remember/forget controls.
4. **Members** — who may message and operate the Bot; no role selector.
5. **Routines** — goal, schedule, timezone, timeout, rationale, completion
   criteria; consequential actions confirm with the requester.
6. **Lifecycle** — Active, Paused, Delete.

### Operations sidebar

- **Current run** — live state and cancel when applicable.
- **Computer** — view, take control, return control.
- **Confirmations** — consequential actions and reconciliation.
- **Shared** — files produced or shared in the current conversation.

## Acceptance criteria

- A new Bot requires only a name before it has server-enforced capability-first
  defaults.
- Overview exposes Soul/personality, Standing Role, Objectives, Provider, Model,
  and Thinking, preserves unsaved edits across settings-tab switches, and publishes them only for
  future runs.
- No reachable Bot UI exposes Summary, Advanced, Permissions, Activity,
  Reference Library, source management, MCP/AG-UI, policy matchers, access
  control matrices, revision history, bundles, recovery, or role selection.
- Resources can import desktop files and folders, reveal the original in Finder,
  and automatically retrieve indexed text as a reference.
- Skills remain optional per-Bot SOPs and do not inject their full bodies into
  every ordinary prompt.
- Neither new nor newly saved Bot configuration can attach or execute MCP.
- Any allowed member can ask the Bot to use files, public internet, and its
  persistent computer; consequential actions produce simple confirmation
  controls.
- Browser/computer state survives ordinary runs and supports human takeover for
  sign-in without exposing cookies or secrets to renderer state/logs.
- Memory changes appear without manual reload; completed runs do not await
  extraction; Remembered/Forgotten semantics match durable state.
- Lifecycle exposes Active, Paused, Deleted only, and complete deletion remains
  partial-failure-safe.
- Web/Electron contracts stay aligned continues its explicit
  unsupported-computer presentation.

## Verification plan

Automated verification:

```bash
bun run --cwd packages/ui test
bun run --cwd packages/web test
bun run type-check
bun run lint
bun run validate:affected
bun run build
```

Focused suites cover settings navigation/removals, resources/Finder import,
Skill assignment, policy/confirmation semantics, operations tabs, memory
events and asynchronous extraction, OpenCode-only activation, disabled MCP
attachment/execution, lifecycle deletion, and server-enforced defaults.

Manual verification uses an isolated DevRyan data directory and the agent-test
login endpoint. It creates and activates a Bot, asks a question, imports and
edits a file, schedules a routine, browses to a sign-in flow, takes and returns
computer control, confirms and rejects consequential actions, reconnects to
the same browser profile, verifies memory event refresh, pauses/resumes, and
performs exact-name complete deletion. Secret values, cookies, hidden role
values, and legacy configuration must never appear in the DOM, API projection,
logs, or exported diagnostics.
