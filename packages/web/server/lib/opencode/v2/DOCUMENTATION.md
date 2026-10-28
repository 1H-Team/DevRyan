# OpenCode 2 compatibility boundary: contracts

Ephemeral `shell.created`, `shell.exited` and `shell.deleted` intentionally project to no public
session event and emit no unsupported-event diagnostic. Durable shell jobs keep
their existing session/message ownership; ephemeral notifications cannot
impersonate those records.

This directory adapts the pinned OpenCode 2 responses (`TARGET_OPENCODE_VERSION` in
`../version-policy.js`) to the existing DevRyan application contract. It does not
implement the native execution host or certify plugin, confinement, migration or
performance parity. Remaining gates are in [the OpenCode module documentation](../DOCUMENTATION.md).
`openapi-*.json` and `__vectors__/` files carry the runtime version of the build that produced them.

## Adapter contracts

- `route-policy.js` classifies every operation from `routes.generated.js` by
  audience, validates body-dependent privilege and rejects unknown routes.
  The repository-init endpoint and the external integration connect
  endpoint stay denied; the session `parentID`
  body field cannot bypass managed child-session ownership.
  `openapi-routes.js` checks the readiness document against that pinned table.
- `../opencode-client/` owns both-generation requests, bounded response reads,
  location encoding, pagination and runtime fencing. A nested operation retains
  one generation/URL/version/epoch; a replacement cannot receive its remaining
  requests. `privileged.js` is deliberately absent from the public barrel.
  `health.runtimeInfo` observes only the native `/api/info` version within the
  same byte/deadline/epoch fences for the private primary handshake. It makes
  no readiness claim and is explicitly unsupported on generation one.
- `native-archive.js` owns native session archive state (OpenCode 2.1). The
  owned `metadata.devryan.archive` override stays the commit point and wins in
  the projection; native `time.archived` is the index `GET /api/session?archived=`
  filters before it paginates. `sessions.archive` writes both through the
  scoped privileged PATCH in the session lock: archive sends the override with
  `archived: true` (native applies metadata first), unarchive restores native
  state first, so a partial failure stays in the native active set. Lists push
  the filter down only after the one-time backfill has a durable receipt for the
  current native store (`<data>/runtime/native-archive-backfill.json`); until
  then they paginate natively and filter projected state. Every filtered row is
  verified against its projected state; a disagreement is dropped and repaired
  from the override (`alignArchive`, never the reverse). The backfill scans
  `archiveDisagreements`, aligns each session through the native owner's
  detached `withArchiveAlignment` permit, oldest first (native archive moves
  `time.updated`), and is idempotent: a partial failure or restart records
  `incomplete` and the next pass writes only what is left.
  `DEVRYAN_NATIVE_ARCHIVE=0`, read on each use, restores the legacy
  metadata-only writes and complete unfiltered reads exactly, and invalidates
  the receipt so returning to native mode backfills what legacy writes left.
- `admission.js` owns prompt selection, accepted-operation identity and session
  metadata mutation serialization. Native selection affects the next step even
  while a session is busy. Retry validation precedes selection changes. A
  versioned fingerprint binds generation/session/message and the normalized
  accepted operation in per-turn `metadata.devryan.admission`; inbox/history
  preflight and native 200/409 responses must prove equivalence. Missing or
  legacy evidence returns nonretryable identity uncertainty. Runtime epoch and
  physical database path are lifetime fences, not durable turn identity.
  Canonical readback may additionally contain the constructor-sealed private
  `managedTitle` tuple. `managed-title-metadata.js` validates its exact bounded
  shape; `validateCanonicalDevryanPromptMetadata` checks the source text/fingerprint
  and then applies the unchanged public metadata validator. Acceptance still
  requires the original operation fingerprint and exact child/source IDs. Public
  builders reject that reserved field, projections remove it, and only the live
  managed title owner can use its independently rechecked assignment witness.
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
- `facade-routes.js` serves application routes through the native client. Prompts
  retain only the exact `x-devryan-prompt-origin: human` UI marker;
  absent, malformed and constructor-origin markers remain unknown. The marker
  does not replace principal or native admission authorization, and private
  canonical metadata remains constructor-owned.
  `GET /experimental/session` is global history: without an explicit directory
  it lists unscoped (every location, none activated) instead of the last-used
  directory, and `archived=true` includes archived sessions (v1 meaning).
  `listFacadeSessionPage` keeps the legacy page contract (strict-before
  `time.updated` cursor, whole timestamp cohorts, newest first then id) but
  paginates natively through `sessions.page`: it reads the page plus a small
  cohort tail and resumes a remembered native cursor for the next legacy cursor,
  instead of reading every session on each request.
  Session creation retains its deadline and content-free attempt timing; an ambiguous
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
- `saved-permission-facade.js` owns saved approvals ("Always allow",
  native `PermissionSaved`) behind `GET /api/permission/saved` and
  `PATCH|DELETE /api/permission/saved/:id`, all with an explicit `?directory=`
  (the host's fallback workspace is never used). The multi-user middleware has
  already translated the directory; the owner additionally requires a managed
  non-administrator's directory to lie in one of their assignments and refuses
  the native `global` project for them. It resolves the project through
  `/api/location`, lists only that project's rows (a foreign row fails closed
  with 502), and forwards an update (`action` and/or `resource`, nothing else,
  validated) or a removal only for an ID found in that list; unknown IDs answer
  404 `saved_approval_not_found` and a native unique conflict 409
  `saved_approval_conflict`. Editing can widen a rule for everyone on the
  project, so PATCH is allowed only for administrators and the local
  administrator; a managed non-administrator gets 403
  `saved_approval_edit_forbidden` before any native call (the route and the
  owner both refuse), while listing and revoking stay available to them.
  Rows are allow rules shared by every user of the project, returned as `{id, projectID, action, resource, anyInput, time}`.
  `DEVRYAN_SAVED_APPROVALS=0` (read per request) answers 501
  `capability_unavailable`. The native routes stay server-class, so the raw
  `/api/opencode-v2` pass-through cannot reach them.
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
  OpenCode reports every interrupt as reason `user`; the live event projector
  adds the host's recorded abort source (`resolveAbortSource`, the harness
  control journal) as `data.source` on the interrupt's `session.error` and on
  the aborted assistant's `MessageAbortedError`, keeping `reason` unchanged.
  REST message pages do not carry it.
- `projection/interaction.js` maps forms to v1 questions (B.6). An `external`
  field becomes `external {url, title?}` only for an absolute `http(s)` URL
  without credentials; any other scheme cancels a session form with the
  content-free `external_url_refused` diagnostic. A confirmed reply answers
  `true`. Forms other than the question tool's carry typed hints
  (`input {kind, minimum, maximum, minLength, maxLength, pattern, placeholder,
  default}`, `required`, `minItems`/`maxItems`) and number bounds are checked
  when the reply is built. A `global` MCP elicitation form projects onto the
  session in the host's `metadata.devryan` stamp, with `tool` and
  `source {type: 'mcp-elicitation', server, message}`. Its settled events
  return to that session, and the per-user event filters then scope it like
  any session question. An unstamped `global` form is ignored, never cancelled
  here: the host refused it before creation (runtime-host DOCUMENTATION, MCP
  elicitation). `formOwnerOf` and the projector's `formOwner` keep both owners;
  the client answers on `/api/session/global/form/:id` and passes the
  attributed session as `elicitationSessionID` for admission only. Skip
  declines (cancels) an elicitation instead of answering it with
  best-judgment text.

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
Archive (override and native `archived`) and admission metadata updates share
one session lock, native archive moves `time.updated` and repeating the current
archive state is a native no-op, and inherited
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

`GET /api/provider/:providerID/accounts` lists one provider's saved accounts
(`openai`, `cursor-acp`, `xai`, `opencode`, `opencode-go`) for Settings →
Providers. It reads the owner's credential metadata under the same integration
grant and returns `{ providerID, accounts: [{ id, label, method, active,
needsAuth? }] }` through `toProviderAccountList`, which copies only those
allowlisted primitives: no key, token, refresh grant, credential value, method
ID or mutation fingerprint ever reaches a browser, and the native
`GET /api/credential` stays unrouted. Switching, renaming and removing use the
existing `/api/credential/:id` activate/PATCH/DELETE facade routes; adding an
account reuses the connect flow, whose native create activates the new
credential without removing the others.

Tool restrictions preserve unrelated permission rules. Native write/edit/patch
share the `edit` action: partial writer grants and contradictory aliases are
explicitly unavailable until the native host enforces per-executor restrictions.
The pinned native `opencode_session_rename` permission action accepts only an
explicit deny override, allowing managed children to hide the unavailable tool
without granting rename authority or changing root prompts.

The reviewed `devryan.harness-context` tools `todoread` and `todowrite` each use
their own permission action. Admission preserves managed children's explicit
denies for both while leaving their editing grants intact; unknown plugin
permission mappings still fail closed.
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

The host pins OpenCode 2.2.0. Message and SSE projections read the current
`native` provider metadata and the retained `state`/`providerState` aliases,
including original Cursor content identities, but project only DevRyan's own
`devryan` marker into part metadata (`projectProviderState` in
`projection/tools.js`). Encrypted reasoning, provider item IDs and signatures
stay host-side; OpenCode replays them natively and no browser reader needs them. The 156-operation inventory
keeps saved-permission list/update/remove server-only and denies the experimental voice routes, including
2.1.3 model discovery and session instruction updates, 2.1.4's client-hosted
MCP socket and token routes and heap dump, and 2.2.0's file watch, stateless
generate, blob media, usage-limit and plugin GUI routes; archival fields do not
grant a browser a generic native mutation path.
