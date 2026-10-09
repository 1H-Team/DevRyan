# OpenCode 2 compatibility boundary

## Ownership and evidence

This directory adapts pinned OpenCode 2.0.26 responses to the existing DevRyan
application contract. It does not implement the native execution host or certify
plugin, confinement, migration or performance parity. The remaining gates are in
[the upgrade plan](../../../../../../docs/OPENCODE_V2_AGENT_UPGRADE_PLAN.md).

- `route-policy.js` classifies every operation from `routes.generated.js` by
  audience, validates body-dependent privilege and rejects unknown routes.
  The repository-init endpoint and the 2.0.26 external integration connect
  endpoint stay denied; the session `parentID`
  body field cannot bypass managed child-session ownership. Historic 2.0.20
  vectors remain labeled with the runtime that produced them.
  `openapi-routes.js` checks the readiness document against that pinned table.
- `../opencode-client/` owns both-generation requests, bounded response reads,
  location encoding, pagination and runtime fencing. A nested operation retains
  one generation/URL/version/epoch; a replacement cannot receive its remaining
  requests. `privileged.js` is deliberately absent from the public barrel.
  `health.runtimeInfo` observes only the native `/api/info` version within the
  same byte/deadline/epoch fences for the private primary handshake. It makes
  no readiness claim and is explicitly unsupported on generation one.
- `admission.js` owns prompt selection, accepted-operation identity and session
  metadata mutation serialization. Native selection affects the next step even
  while a session is busy. Retry validation precedes selection changes. A
  versioned fingerprint binds generation/session/message and the normalized
  accepted operation in per-turn `metadata.devryan.admission`; inbox/history
  preflight and native 200/409 responses must prove equivalence. Missing or
  legacy evidence returns nonretryable identity uncertainty. Runtime epoch and
  physical database path are lifetime fences, not durable turn identity.
  `buildV2PromptFingerprint` shares the exact accepted-operation recipe with
  read-only bundle resume checks; those checks cannot authorize dispatch.
  A trusted pre-dispatch callback supplies the effective canonical selection to
  managed primary ownership after native selection succeeds. Original request
  intent remains in the fingerprint; inherited effort and explicit default are
  frozen separately for continuation. Failed dispatch acknowledgements preserve
  an uncertain primary record instead of guessing whether native accepted work.
  A primary callback rereads the actual session after an agent or model switch,
  including background recovery outside the web prompt context. Its implicit
  selection opt-out still applies when no selection changes; child admission
  keeps its existing scope. A refused switch cannot dispatch using a stale tuple.
- `facade-routes.js` serves application routes through the native client. Session
  creation retains its deadline and content-free attempt timing; an ambiguous
  dispatched write is never retried. `sse-routes.js` maps live native frames and
  requests reconciliation on stream loss. Its active global subscriber owns the
  opt-in `X-DevRyan-Subscription-Ready: 1` handshake: an ID-less named
  `devryan.subscription-ready` frame follows principal registration, live attachment,
  authorized replay and actual upstream hub connectivity. Upstream disconnect
  revokes this readiness by closing opted-in subscribers. Only previously ready
  cursor-free reconnects request `X-DevRyan-Replay-Unanchored: 1`; the same bounded
  hub replay and branded gap control precede the new ACK. Initial connections skip
  history. Directory envelopes, ownership filtering and drain backpressure stay
  on this owner. Other runtime generations are refused.
- `projection/` owns display shapes, stable derived part IDs and content-free
  errors. Only canonical native sequence establishes `turnOwnership` for
  execution and plan checks. Display parentage and tool file summaries grant
  neither permission nor ownership. An explicitly marked standalone synthetic
  row preserves only the exact `compaction_continue: true` boolean on its text
  part, alongside its description, for existing maintenance classifiers. Folded
  prefaces leave the following human request unmarked. This does not establish
  built-in native automatic-compaction lifecycle coverage. A reviewed skill's
  hashed `devryan-<hash>` id is never projected as its name; skill tool rows take
  `input.name` and the title from `metadata.name` (live progress or completion).

[Captured vectors](__vectors__/README.md) and their
[observed answers](__vectors__/ANSWERS.md) establish the native behavior below.
The focused projection, policy, admission and client tests protect the adapter
contract. They do not replace integrated native acceptance.

## Semantic-loss register

`LOSS(key)` comments refer to this register. These are intentional representation
limits, with their operational consequences made explicit.

| Key | Projection and limit |
| --- | --- |
| `system-notices` | Migrated legacy tool system notices are hidden from conversation rendering. |
| `idle-rows` | Idle records do not become messages; session status owns completion. Projected idle includes the last native inbox `userMessageID` when known so late delivery settles only that turn's diagnostic timing; it grants no execution authority. |
| `user-selection` | Without DevRyan turn metadata, selection comes from the sequence fold or answering assistant. This historical display fallback cannot attest the admitted selection. |
| `segment-kind` | Attachment and synthetic text segments both become synthetic text parts. |
| `part-order` | Files and agents follow text segments; their original interleaving is unavailable. |
| `file-source` | Native file source, description and mention have no application FilePart fields. |
| `user-skills` | Native skill attachments have no application part; effective skill access needs separate qualification. |
| `synthetic-description` | Synthetic description is retained in part metadata rather than a dedicated application field. |
| `variant-default` | Native model switching may add the literal variant `default`; it passes through. |
| `assistant-retry` | Retry details belong to projected status, not the assistant record. A retried native step may reuse its ID and replace its creation time. |
| `assistant-streamed` | Native streamed time, raw finish and provider state are omitted. The projection cannot establish provider TTFT. |
| `text-time` | REST text items lack individual times and use step times; live text ends may retain their observed event time. |
| `compaction-time` | One native compaction record becomes a compaction user plus summary assistant; display timestamps are derived. |
| `compaction-recent` | Native recent/context/provider-state fields are omitted. Native compaction evidence remains necessary for acceptance. |
| `parent-edge` | Live timestamp indexes are display fallbacks only. Canonical REST ownership requires bounded unfiltered sequence traversal; missing ownership cannot authorize a call. |
| `diff-shell` | Shell changes are absent from projected per-turn tool file counts. |
| `diff-page` | Tool file counts cover only the assistants in the projected page. |
| `diff-files` | Native tools without `metadata.files` contribute no counts, including observed writes with snapshots disabled. The existing ledger remains the publication authority. |
| `time-clamp` | Equal or decreasing native timestamps are raised by milliseconds for display order; these are not measured execution times. |
| `synthetic-fold` | A synthetic row folded into the immediately following user loses its separate displayed ID/time. |
| `live-synthetic-fold` | Live synthetic events can be displayed separately until REST reconciliation performs the page-local fold. |
| `retry-action` | Native retry status has no source for the legacy action field. |
| `revert-diff` | Native Revert has no legacy patch body; available file summaries retain counts only. Revert publication requires the ledger coordinator. |
| `session-time` | Native idle/viewed times and outcome have no matching application session fields. |
| `session-slug` | A session without cached creation-event slug uses its ID as display fallback. |
| `fork-lineage` | Native fork boundary/source is not projected as a parent-child relationship. |
| `session-share-summary` | Native share and summary fields are absent from the application projection. |
| `command-result` | The pinned command endpoint returns no assistant message; admission returns null and later state arrives through events/history. |
| `compact-model` | Native compaction uses the session selection; the legacy compact request's provider/model pair is not a separate native selection. |

## Native behavior that must not be inferred away

Metadata PATCH replaces the entire map, while forks and children inherit it.
Archive and admission metadata updates share one session lock, and inherited
ownership fields require validation against the destination session. The native
TODO writer uses this same owner and an exact private metadata derivative. The pinned
plugin `session.update` ignores metadata; host metadata changes use the native
session boundary that actually persists it.

`native-integration-facade.js` adapts existing provider-account and MCP OAuth
routes to the owned native Integration acquisitions. Original caller grants,
configuration digests, attempt ownership and redacted credential fingerprints
are retained through completion and mutation; secret Credential GET stays
private. MCP OAuth availability requires the ready owned runtime. Config-wide
provider disconnect remains unavailable where prepared configuration removal
has not been qualified.

Tool restrictions preserve unrelated permission rules. Native write/edit/patch
share the `edit` action: partial writer grants and contradictory aliases are
explicitly unavailable until the native host enforces per-executor restrictions.
Permission changes while busy are rejected before selection or prompt effects.
The integrated host must seal admission metadata authorship and enforce these
decisions atomically against direct and in-process native callers.

Canonical single-message ownership currently reads at most 50 native pages of
200 rows, stopping once the target and preceding parent are known. Missing
sequence evidence or exhausted bounds fail closed. This cost
can be removed only by a native ownership attestation with the same guarantees.

Native location requests use `location[directory]` or the directory header;
the legacy `directory` query is ignored. Message `type` accepts one value.
Cold catalogs can be empty until location loading finishes. Readiness must
establish the required catalog, not treat a successful empty response as parity.

Native input tokens exclude cache reads/writes and output excludes reasoning;
the projection preserves those components and derives their sum. SSE subscriber
overflow can appear as a clean HTTP end, so every unexpected stream end requires
bounded reconciliation. Optional stored event payloads are not a live stream.

Native Revert commit removes the boundary and subsequent conversation records.
Conversation-only Revert, pending inbox disposition, completion ownership and
file publication must be coordinated by the existing DevRyan authorities before
generation-2 execution can become active.

Natural FIFO requests keep delivery `queue`, including the default. Human queue admission checks the original native subtree before selection, stages the existing primary callback until native enqueue commit, and preserves exact accepted identity on failure/retry. The final Bus transaction repeats the activity/selection proof. An authenticated rollback receipt reports known nonacceptance; a retained item without its current primary owner reports `native_queued_input_retained`. Explicit manual steering uses `steer`; request metadata cannot opt out of the reserved human queue contract.
