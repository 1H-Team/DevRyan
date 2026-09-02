# Production Bots runtime contracts

`@openchamber/bots-runtime` is the dependency-free source of truth for policy that must remain identical in Electron, the web server, container-facing adapters, and the shared UI. It intentionally contains no HTTP, Supabase, Docker, OpenCode, browser, filesystem, or React logic.

Operator setup, recovery, retention, and trust-boundary guidance lives in
`docs/BOTS_RUNTIME.md`.

## Strict JSON boundaries

Every public function that accepts an object checks an exact key set. Missing or unknown keys fail before policy is evaluated. Nested connector-specific `target`, `args`, and `limits` fields may vary, but they must still be plain JSON data. Accessors, custom prototypes, sparse arrays, non-finite numbers, symbols, `undefined`, and circular references are rejected rather than being silently altered by `JSON.stringify`.

`canonicalizeBotJson(value)` recursively sorts object keys while retaining array order. `hashCanonicalBotJson(value)` returns the lowercase SHA-256 hex digest of that UTF-8 representation. `hashBotAction(action)` adds the `sha256:` algorithm prefix and binds the complete validated action descriptor: Bot, revision, run, channel, initiator, tool/action, target, credential/computer scope, arguments, and limits. Any bound-field change therefore invalidates a prior approval.

`parseStrictBotJson(text)` is the bounded textual boundary for portable Bot
specifications and other signed inputs. It rejects duplicate object keys before
ordinary parsing, caps bytes/depth/collection sizes, and preserves the same
canonical JSON representation used for hashing and signing.

## Scope ownership

- Team computer: `bot:<botId>` (the production runtime always resolves here)
- Personalized computer: `bot:<botId>:user:<ownerUserId>` (legacy contract
  compatibility only; it does not create a second production computer)
- Reasoning/workspace in both modes: `channel:<channelId>`

Canonical IDs remain server metadata. Docker adapters hash these scope values before using them in resource names.

## Lifecycle and revisions

The lifecycle graph is `draft -> active`, `active <-> paused`, and `active|paused -> retired`. Retirement is terminal and purge is deliberately outside the lifecycle graph.

Draft revision content and compiled hash may change while identity fields remain fixed. Once `activatedAt` is present, contract content, compiled hash, activation metadata, and identity are immutable. The only later update is one `retiredAt` stamp.

Revision contract v3 adds immutable `agent`, `browserPolicy.networkAccess`, and
`computerPolicy.isolationTier` fields. `agent.kind` is `opencode` or `ag_ui`;
legacy contracts omit it and resolve to OpenCode without a hash rewrite.
Browser policy defaults effectively to `public_only`, and computer isolation
defaults to `standard`. Matcher v2 is selected only by v3 contracts, leaving the
legacy policy corpus on matcher v1.

## Authorization and approval

Membership and transcript access are separate:

- an active channel owner may read and send;
- an active Reader may read;
- an active Collaborator may read and send;
- Operator/Manager membership alone does not reveal a private transcript;
- global-admin transcript access requires an explicit, attributable read-only break-glass decision.

Prompted low-risk actions require the requester, sensitive actions require another Operator or Manager, and critical actions require a Manager. Callers may additionally require a distinct Manager for purge, secret export, or broad-autonomy grants.

Structured matcher v2 is deliberately not an expression language. It supports
bounded actor-role lists, normalized URL-path globs, canonical virtual-file
globs with `any`/`all`, typed JSON-Pointer argument predicates, and fixed-window
actor/Bot quotas. Top-level dimensions are ANDed, values inside a list are ORed,
and one rule's predicates are all required. Precompiled globs support escaped
literals, `?`, `*`, and `**`; operators are limited to `exists`, `eq`, `in`,
`prefix`, `suffix`, `glob`, `gte`, `lte`, and `arrayContains`. Approval state
binds matcher version, canonical authoritative facts, actor role, quota buckets,
and reservation IDs so execution-time fact drift invalidates the decision.

## Run, action, and lease state

Run and action transitions are explicit allowlists. Settled terminal states cannot transition again. `needs_reconciliation` is not terminal: it blocks normal completion until the uncertain operation is resolved.

`waiting_control` is an active, durable pre-execution state for both runs and
action attempts. A human browser lease fences execution without failing the
action or making a write uncertain. Return or natural expiry resumes the same
idempotent attempt; renewed leases keep it waiting and cancellation remains
available. Database claim/index rules prevent another run from taking the
computer scope during this wait.

If transport is lost while an action is executing, a read becomes `failed` and may be retried as a new action. A write becomes `unknown`; its only direct state transition is `reconciled`. This prevents arbitrary website writes from replaying without evidence or an Operator decision.

`decideBotRunAdmission` is a pure mirror of the database claim invariant. An absent or expired lease admits a run, the current owning run is idempotently admitted, and a different run is refused while the lease remains live. The Supabase RPC remains the authoritative atomic claim.

## Routines

Missed occurrence policies are `skip`, `run_once`, and `replay_capped`. Replay is hard-capped at three and selects the newest bounded window in chronological order. Write-capable routines default to `run_once`; any recovered write occurrence requires a fresh approval.

Run the package suite with:

```bash
bun run --cwd packages/bots-runtime test
```

## Scoped OpenCode runtime

`docker/opencode/Dockerfile` pins both `opencode-ai` and its plugin API to
1.18.26, pins the reviewed `opencode-gpt-imagegen@0.1.10`, and runs as UID/GID
10001. The server compiles the single-agent config
into an immutable host channel/hash directory; Electron verifies it and the
supervisor mounts it read-only at `/runtime-config`. The reviewed gateway
plugin remains pinned in the image at `/opt/devryan/devryan-bot-tools.mjs`.
OpenCode data, the exact one-provider per-run `auth.json` file, and channel
workspace use separate writable mounts, and the service exposes only port 4096. The legacy
`initialize` command remains solely as an image contract fixture and is not
used by the production supervisor path.

The server-compiled `bot` agent starts from deny-by-default and then enables the
revision's scoped file tools (`read`, `glob`, `grep`, `edit`, `write`) and
runtime tools (`bash`, `terminal`, `git`, `task`). `task` exposes only the
compiled `explore` and `general` subagents, which cannot delegate again. Raw
browser/CDP, direct MCP, Docker, host orchestration, host credentials, and
external directories remain denied; governed computer/MCP/actions use
`devryan_bot`. Its tool description identifies `computer.command` as the
persistent browser connector and documents the reviewed payload shape without
changing immutable revision permissions. A matching per-turn runtime instruction
keeps the connector discoverable to already-compiled Active Bots. The plugin
accepts only reviewed operations and binds
every gateway request to `DEVRYAN_BOT_RUN_ID`, `DEVRYAN_BOT_CHANNEL_ID`, and
`DEVRYAN_BOT_REVISION_ID` from the runtime capability rather than tool input.
`devryan_write` accepts only one top-level workspace filename (including the
equivalent `/workspace/<name>` spelling), normalizes it before dispatch, and
returns the gateway result as the text contract required by OpenCode tools.
`artifact.put` remains the explicit arbitrary Bot-created Shared-file
publication path;
it carries bounded bytes through the governed gateway and never accepts a host
or existing computer path. The gateway contract at
`devryan-bot-tools@1.4.0` exposes the dedicated primary-agent `devryan_ask` quick-reply question tool and the `devryan_image`
tool, reusing the pinned `gpt_imagegen` schema: required `prompt`, `out`, and
`quality`, optional `size` and `images`. For example:
`devryan_image({prompt: "A small blue bird", out: "/workspace/generated-images/bird.png", quality: "low"})`.
The server grants this tool solely when the admitted model snapshot resolves
to OpenAI ChatGPT OAuth. API-key and other-provider runs receive no image tool;
subagents cannot invoke it. Existing `1.2.0` revisions remain compatible and the
legacy `devryan_bot` `image.generate` executor remains available for persisted
calls, but is no longer advertised. The resulting
workspace image is collected and attached by the host after tool finalization,
so the Bot never needs a second `artifact.put` call or a promise to publish it
later. Both direct and legacy completed-tool results use the same bounded,
validated encrypted attachment path; optional Shared publication does not
control inline transcript visibility.

The fixed launcher parses the host-materialized per-run
`/runtime-secrets/environment.json` document and assigns its validated values
to `process.env` without a shell. OpenCode tools and non-recursive subagents
inherit the snapshot. The file is read-only, run-scoped, absent from computer
containers, and removed by host cleanup on every terminal/startup/shutdown path.
