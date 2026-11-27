# Harness Runtime

File materialization receipts list changed paths in lexical order, independent
of asynchronous or synchronous filesystem traversal order.

New synthetic events and plan-action markers use `devryan` names. Journal,
recovery, objective and task-context readers accept the pre-rename aliases with
the same ownership, single-marker and scope validation. Event normalisation is
owned by the portable shared-runtime event-types leaf.

`@devryan/harness-runtime` is the Node ESM owner for durable DevRyan
harness operations. It has no third-party dependencies; its only workspace
dependency is `@devryan/shared-runtime` (native status, observation, usage
and provider-error leaf modules), and its production modules never import the web
server. It contains atomic private-file persistence,
versioned record stores, turn lifecycle correlation, durable worktree bootstrap
receipts, sanitized diagnostic journaling/export preparation, and optional Git
turn-evidence primitives. It also owns the host-neutral persisted command-
deadline controller used by web/Electron.

The command-deadline controller first requests optional exact-command
cancellation from its constructor-owned execution host, then confirms the
canonical tool part. Unavailable or unconfirmed command cancellation retains
bounded session abort and the existing sole-active-session restart restriction.
Repeated updates never extend the absolute deadline. New command admission
rejects zero timeouts and timeouts above one hour; the observer defensively
defaults malformed or missing input to four minutes so it cannot disable
recovery, and clamps values above the maximum instead of shortening them.

The deadline is bound to the running call, never to the streaming placeholder.
The execution host registers each native shell job when it binds it
(`register`): the real start and the timeout the native shell enforces
(`effectiveTimeoutMs`; 0 for a background job, which is not watched). A
registered deadline is authoritative. Without a registration, a `running` part
arms the deadline; a `pending` part only creates an in-memory candidate that is
never cancelled, re-checked against the exact message with backoff until it
runs, ends or expires (30 minutes). Before cancelling, observed and version 1
(`legacy`) deadlines are recomputed from the authoritative running part and
rescheduled when later. Records keep `requestedTimeoutMs`,
`effectiveTimeoutMs`, `deadlineAt` (start plus the effective timeout) apart;
the watchdog fires at `deadlineAt + grace`. The cancellation intent
(`command_deadline_exceeded`, with those values) is persisted and journaled
before any effect, so a kill whose terminal update arrives first is journaled
as `recovered`, not as a normal completion; the escalation to a session abort
is its own incident (`command_deadline_session_abort`). A command that already
exited and is still publishing is never aborted: the execution host answers
`'publishing'` and the watchdog re-checks it 30 seconds later
(`command_deadline_publishing`).

`lib/atomic-file.js` also exports a dependency-free cross-process lock. Locks
on POSIX publish a synced private temporary inode with exclusive `link()`, so a
process killed while writing cannot expose a partial lock. Only explicitly
unsupported hard links (`ENOSYS`, `ENOTSUP`, `EOPNOTSUPP`) fall back to exclusive
`wx`; permission and I/O failures propagate. Locks carry a random
token plus PID/timestamp, reclaim only proven-dead or safely stale malformed
owners, time out deterministically around live owners, and delete only when the
release token still matches. Project configuration uses this primitive to
serialize scheduler claims and ordinary mutations across web/Electron server
processes.
The legacy malformed-lock threshold remains 30 seconds; existing lock records
keep their format. Windows continues to use its execution-host owner.

`writeFileAtomicSync` is the synchronous replace for user-owned files that
another process watches (the web server's OpenCode config, agent and command
writes). It is not a private-file writer: an existing file keeps its mode, a
symlink is followed to its file, a read-only file is refused, and on Windows a
rename refused because another process holds the target falls back to a direct
write.

Atomic writes accept an optional content-free progress observer. Started phases
describe pending physical work; only completed write/sync/rename boundaries
prove progress. Observer failures cannot interrupt or confirm persistence.
Managed ledger watchdogs consume these constructor observations while retaining
uncertain mandatory-write ownership until settlement.

Host packages inject storage roots and platform effects. The shared UI never
imports this package; it consumes HTTP bridge contracts.

`SessionChangeRuntime.recordReceipts` and the host's matching method are trusted
in-process batches for one project. They use the same exact-evidence validation,
single commit and meaningful-change notification rules as scalar receipts; the
HTTP/plugin bridge does not expose a batch writer. Empty complete receipts may
repair coverage and therefore still notify. Identical evidence does not.
Snapshot and native call ownership remain active until that batch commits;
a later receipt or durable-write failure leaves both available for late calls
and a retry without marking the pending capture interrupted.

Canonical history can repair a failed tool without file metadata only through
the constructor-injected mutation ledger's exact session/message/call
`never_started` outcome. The host validates the whole returned identity batch
before recording empty complete receipts. Missing, uncertain, finished,
mismatched and nonterminal calls remain incomplete; error text is not evidence
of non-execution. This attests no start, not process termination.
File-only restore skips an exact durable cancelled no-start call because it has
no operation to restore. Missing or mismatched evidence cannot skip a call;
published operations still require their original lease and operation identity.
A request containing only no-start calls cannot create a restore transaction.
Outcome queries and file restore share one predicate: an absent execution
pointer needs its exact session/message cancelled-call receipt; an existing
pointer needs an exact, clean cancelled prelaunch lease, even without that
receipt. Dirty, started, reboot-recovered and mismatched leases remain uncertain.
Cached restore retries revalidate these identities before returning the original
transaction.
Every file-restore call requires a valid message ID, including published and
cached selections. The cached fingerprint includes session, message and call ID.
Older cache receipts without the message identity refuse with
`capture_identity_mismatch`; they cannot mutate or replace the prior transaction.
Negative outcome batches share the writer's owner lock so a guarded
commit awaiting recheck or rollback cannot become history authority.
Constructor-owned denial cancellation carries a synchronous owner fence and
captured admission revision into the ledger transaction. The guarded store
commit rechecks before the ref CAS and afterward under the same lock, rolls back
revocation, and reports a failed rollback as committed uncertainty. Other store
commits retain their existing behavior.

`lib/session-reboot-recovery.js` owns the versioned
`devryan.session-reboot-recovery/1` lease attestation. A cold native host must
first establish an exact locked fence and a changed kernel boot identity. The
helper accepts only a claimed ready process lease matching its original hash,
records a terminal cancelled lease with an uncertain outcome, and retains its
private view. The `cleaned` terminal marker disables ordinary deletion; the
`retained` proof states why the view remains. This is not a supervisor receipt:
it asserts neither confinement, exit code, success nor non-execution. Stable
token/owner/scope identity survives bundle relocation. Original-record hashing
is used only to resume the same partially applied recovery fence. Historical
lease refs are retained by the native host under its explicit recovery ref.
Execution outcome queries never report this lease as `never_started`, and
`cancelUnstartedCall` refuses to reclassify its uncertainty.

`startSessionExecution` marks its rejection `neverStarted` when the launcher
could not be created, or closed without creating its termination receipt. The
execution owner then records the same no-launch attestation as a failed start
(`cancelUnstartedCall` and cleanup) instead of leaving a claimed `ready` lease.
Any other receipt failure stays unconfirmed and held.

Session records created by `registerChild` carry no `directory` until the
session is next touched; every consumer treats the field as optional.

## Storage

`createHarnessPaths({ rootDir })` creates a `harness/` namespace below a host
owned data root. Files are written with private permissions using a
file-fsync/rename/parent-fsync sequence. Invalid JSON records are moved to a
`quarantine/` directory and do not prevent startup.

## Data folder migration

`lib/data-root-migration.js` (`migrateLegacyDataRoot`, exported from the root)
moves `~/.config/openchamber` to `~/.config/devryan` once, under a cross-process
lock outside both folders, and leaves a relative compatibility link. It is
idempotent and finishes an interrupted move; outcomes and recovery are described
in [identity compatibility](../../docs/IDENTITY_COMPATIBILITY.md#saved-settings-and-managed-configuration).

## Runtime ownership

- `lifecycle.js`: synchronous canonical OpenCode-event correlation. Idle is
  OpenCode's only terminal edge for an abort during a provider-retry wait and
  for a turn whose process exited, so hosts record those before it:
  `recordAbortRequested` settles the active turn at idle as `turn_aborted`
  (reason `abort_requested`; `withdrawAbortRequest` undoes a rejected abort) and
  `recordRuntimeInterrupted` as `turn_failed` (reason `runtime_exit`). An abort
  request wins over a runtime exit, and neither carries over to a later turn.
- `prompt-admission.js`: synchronous named-hold controller shared by web/Electron
 . A hold returns the exact HTTP-shaped block for new prompts and
  managed-work launches while allowing active work, cancellation, result
  acknowledgement, and shutdown to drain. Reference-counted releases prevent
  one recovery owner from reopening admission held by another.
- `worktree-bootstrap.js`: durable idempotent receipt state machine.
  Version 3 receipts add the explicit `run_post_checkout_hook` stage; version 1
  records first migrate to the `local-admin` owner and version 1/2 terminal or
  already-advanced receipts skip the newly introduced hook so migration never
  replays user code. New receipts run the stage immediately after population.
  A terminal receipt can be explicitly superseded when the same idempotency key
  is reused with a different request fingerprint; active queued/running work is
  never superseded and still returns a conflict. Resolved worktree directories
  are also single-flight keys: matching concurrent submissions share the one
  authoritative receipt, conflicting setup or maintenance returns
  `409 WORKTREE_DIRECTORY_BUSY`, and active setup prevents removal.
- `command-deadline.js`: exact shell-call deadline ownership. It fingerprints
  the session, assistant message, part, call, and tool; persists no command
  text; prefers the execution host's registration and never arms from a
  streaming placeholder; preserves the first absolute deadline across repeated updates; and
  immediately reconciles overdue records after restart or system sleep. Thirty
  seconds after the declared deadline it fetches the exact message, issues at
  most one session abort, and waits up to ten seconds for authoritative
  settlement. A managed runtime restart is allowed only when that session is
  the sole active operation. Concurrent and external runtimes remain untouched
  and surface an unresolved incident. Commands are never replayed.
  When the host owns the command process, recovery first cancels that exact
  session/message/part/call/tool and waits for its confined termination receipt
  and canonical tool settlement. Whole-host restart eligibility reads active
  sessions across every project location, rather than only the command's project.
- `git-post-checkout-hook.js`: bounded cross-host post-checkout runner. It
  resolves the effective `core.hooksPath` (including a global path that shadows
  repository-local hooks), skips absent hooks, and requires Git 2.36+ only when
  a hook is present. Existing hooks run once as
  `git hook run --ignore-missing post-checkout -- <zero> <HEAD> 1` in the new
  worktree. Timeout/nonzero failures are hard setup failures with byte-capped,
  terminal-control-stripped, path-sanitized receipt excerpts. The stage is not
  replay-safe: interrupted execution becomes `needs_attention` and reruns only
  after explicit Retry.
- `session-id.js`: canonical four-way record attribution plus session-parent
  relations shared by storage and export selection.
- `journal-trim.js`: bounded pre-sanitization policy that drops streaming
  deltas and coalesces repeated part/session updates, unchanged primary-recovery snapshots, plus property-free,
  unattributed `sync` events (OpenCode's `{ type, id, syncEvent }` shape; the
  held copy drops the `syncEvent` body the sanitizer never stores). It flushes on completion, lifecycle boundaries,
  debounce, drain, and capacity pressure.
- `sanitizer.js` and `journal.js`: always-on, bounded, sanitized NDJSON capture
  partitioned into `sessions/<sessionID>/` and an unattributed `runtime/`
  bucket. Each bucket has an atomic manifest, gzip-compressed closed chunks,
  one plain crash-safe active chunk, and gzip blob sidecars. The root generated
  `README.md` and `index.json` make the format self-describing. Clear can remove
  a recent time range by rebuilding older retained records and their blob
  sidecars, or remove all current and legacy journal data. Both modes preserve
  the discovery files and accept newly arriving records afterward.
  `HARNESS_BEHAVIOUR_SWITCHES` is the closed allowlist of behaviour switches a run
  fingerprint records (`switches`); each value is reduced to `unset`, a switch word
  or `other`, and the sanitizer drops a switch name used as a key anywhere else.
- `trace.js`: per-session usage roll-up for evaluations. Managed children fold
  into their root through task relations, related helper sessions fold into their
  root, and direct helper provider calls come from journal `usageObservation`
  records. Each root reports `helperInput`/`helperOutput` and an `attribution`
  block; `attribution.unattributedHelperUsage` makes the paired comparator hold a
  pair instead of dropping usage silently.
  These modules also preserve validated native startup catalog codes and bounded recognized
  stderr diagnostics. Schema paths accept only fixed field names and indices;
  raw errors, values and arbitrary plugin logfmt fields remain excluded. The
  `sanitizeNativeSchemaPath` submodule export shares that path policy with the
  native producer. Startup export applies the same validation again.
  Provider failures retain only finite allowlisted error types, codes and parameter
  names from `shared-runtime/lib/provider-error-details.js`; raw provider bodies
  remain excluded. Journal export revalidates these fields.
  Provider transport failure timing records (`turn.provider_request_failed`)
  add the nested fields `host`, `port`, `sinceLastByteMs` and `probe`; their
  producer already reduced the target to a hostname and port.
  Free-text high-entropy redaction judges a slash-separated candidate segment
  by segment: when every segment is a readable name (digit runs, lowercase
  names with short digit runs such as `v2-native`, camel words and acronyms
  such as `useSSE`) or is itself high-entropy, only the high-entropy segments
  become `[REDACTED]:high_entropy`. Other slash-bearing tokens, such as base64
  secrets, are still redacted whole.
  Web/Electron hosts record raw OpenCode events only from the canonical global
  watcher; event transport bridges never call the journal, preventing duplicate
  records when multiple UI stream clients are attached.
  Supported record schemas retain a sanitized `actor` identifier supplied by
  the host, allowing shared-host diagnostics to be attributed without exposing
  authentication material. Provider-reported assistant token snapshots retain
  only the numeric `total`, `input`, `output`, `reasoning`, `cache.read`, and
  `cache.write` fields so context-usage counts remain auditable without widening
  the general nested-field allowlist.
  `elapsedMs` is retained only as a finite non-negative number.
  `native_claude_process` has an exact payload projection for validated
  attempt/provider identities, exit code, signal presence, bounded byte counts,
  truncation and literal diagnostic clue enums. Raw stderr, nested payloads,
  credentials and unknown clues are excluded from both journal disk and export;
  other events do not inherit this allowlist.
  `opencode_process_exit` payloads retain only typed PID, exit code, signal,
  non-negative safe-integer uptime, expected-exit flag, and a redacted stderr
  tail clipped to 16,384 characters. Other payload fields are excluded.
  `cursor_final_association` retains only assistant/part IDs, ordinals and counts
  capped at 4,096, lengths capped at 16 MiB, equality, fixed association states
  and the finite inner refusal reason/code. Its dedicated journal/export
  projection excludes response text and hashes without widening other events.
- `export.js`: task/runtime export selection and second-pass redaction. Bundle
  version 2 streams one plain NDJSON entry per session plus `runtime.ndjson`,
  an included-manifest index, and decompressed plain-text blobs.
- `evidence-git.js` and `evidence-ledger.js`: opt-in interval evidence that never
  mutates the user's index, HEAD, branch, or working tree.

## Operational limits

- `createSessionMutationRuntime({ batching: { install, initialInstall } })` overrides rows per install transaction (defaults 128 and 1024 for a first build; validated positive integers); tests pass small values to cross batch boundaries with ~150 files.
- A reservation may carry `attempt` (`{ taskId, leaseToken }`, or `{ state: 'none' | 'unknown' }`), stored on the lease so the orchestrator can stop exactly a settled attempt's runs; `cancelLease` records `stoppedBy: 'operator'` (a user Stop) or `'task_settled'` (that cleanup), and neither run's completion restarts the conversation.
- `createSessionMutationRuntime({ complexity: { warnEntries, warnBytes, ceilingEntries, ceilingBytes } })` overrides the document complexity guard (defaults 250,000 entries / 16 MiB to journal, 1,000,000 / 64 MiB to record whole content; validated positive integers, each warning at most its ceiling). See [Concurrent Revert](../../docs/CONCURRENT_REVERT.md).
- `createSessionMutationRuntime({ preparedBaselines: { rows, bytes } })` overrides the prepared-baseline budget this runtime admits entries under (defaults 100,000 rows and 32 MiB, shared by the process; validated positive integers); tests shrink it.
- `openChangeStore(..., { listingLimitBytes })` overrides the 1 MiB in-memory key-listing bound (validated positive integer; default unchanged); tests pass a small value to cross it with a few hundred records.
- Whole-ledger listings must stream. `openChangeStore().records()` yields every
  `{key, oid, value}` of a snapshot through `gitTokens` plus batched
  `gitRecords`, ignoring pending writes so callers may `set()` while iterating.
  Never list a whole tree through `git()`: its stdout cap is 1 MiB, and a ledger
  with tens of thousands of keys exceeds it (`change_record_too_large` at boot).
- Mutation ledger size follows the project, not its history, for untouched
  files: their baseline runs are one content-reference page. Replacement
  ancestry grows with direct ranges only; maintenance reduces closures older
  hosts stored. Edited documents, operations, leases and calls have no
  retention horizon yet. Superseded Git
  trees and pages are pruned after a two-hour grace. See
  [Concurrent Revert](../../docs/CONCURRENT_REVERT.md).
- Journal writes are ordered through a bounded O(1) enqueue path. Per-session
  chunks rotate at 4 MiB, the LRU writer pool keeps at most six file
  descriptors open, retention is seven days, and total storage caps at 1 GiB
  by default. Legacy
  flat segments prune before whole inactive session directories; runtime
  closed chunks are the final tier.
- `message.part.delta` is intentionally omitted. Repeated
  `message.part.updated` and `session.updated` events are last-write-wins with
  stored `coalesced` counts and manifest trim totals. Property-free,
  unattributed `sync` events (string `id` and object `syncEvent` allowed; the
  last `id` is kept) use the same bounded last-write-wins window without
  changing live SSE delivery; intentional trims never emit `gap` records.
  Stateless `server.heartbeat` events keep one record per 5 minutes and count
  the rest in `trimmedHeartbeats`.
- `devryan:primary-recovery` (and the `openchamber:` alias) snapshots are
  broadcast on every revision but journaled on identity change only: mode,
  support/enforcement, anchor, failed and recovery message, state, attempt
  count and failure fields. Revisions with the same identity are held
  last-write-wins without a debounce timer and flush on the next change, a
  session boundary, capacity pressure or drain; eliminated copies count in
  `coalescedDiagnostics`.
- Large sanitized strings are stored as bucket-local gzip blobs. Binary attachments
  retain only filename/MIME/size/SHA-256 metadata.
- Worktree terminal receipts retain 90 days or 2,000 operations; active
  receipts are never pruned.
- Shell commands default to 240,000 ms and may declare 1,000 through 3,600,000
  ms. Deadline reconciliation begins after a 30,000 ms grace period.
- Evidence retains seven days or 200 turns per primary repository and removes
  its hidden refs when records are pruned, sessions are deleted, or the user
  clears a project. A clean unchanged worktree reuses the before tree for the
  after commit, avoiding a second temporary-index scan.

Diagnostics are always local and always on. Export is explicit, branded
`DevRyan-diagnostics-*.zip`, and receives a second redaction pass plus a sharing
warning. Turn evidence is separately opt-in, default-off, read-only interval
evidence; it is never a restore point or an attribution mechanism.

## Journal inspection

`execution-admission.js` exports `withExecutionTiming` for publication observers.
It adds a bounded phase summary and substep timings without checking its root's
inherited admission signal or mapping errors. The existing signal, deadline,
meter and nested execution checks stay intact; committed results and original
failures remain authoritative. Native publication reports `mutation_finish`,
`execution_receipt` and `change_receipt` separately inside its `finish` record.

From the repository root, run `bun scripts/journal.mjs list`, then
`bun scripts/journal.mjs show <sessionID>`. The zero-dependency CLI reads gzip,
active plain chunks, runtime records, and legacy segments. It also supports
type/event/time/grep/tail filters plus `gaps`, `blob`, and `path` commands.
The default `gaps` command trusts valid zero-gap bucket manifests and scans only
positive, missing, or invalid manifests plus legacy segments. Use `gaps
--verify` to scan every chunk when checking the manifests themselves.

An administrator Error Log event UUID locates a durable sanitized summary; it
is not expected to appear in this journal. Resolve the UUID through the Error
Log detail API first and capture its `sessionId`, timestamp, action/kind, and
available `callId`, `toolId`, `messageId`, or `taskId`. Use the session and
strongest identifier to retrieve execution evidence, normally
`bun scripts/journal.mjs show <sessionID> --grep <callId>`. Fall back to another
identifier or a bounded `--since`/`--until` window and run
`bun scripts/journal.mjs gaps` before drawing conclusions. Error Logs provide
durable administrative indexing and classification; the local journal provides
prompts, tool output, lifecycle ordering, recovery behavior, and detailed
failure evidence. If the relevant host journal is unavailable, expired, or has
a qualifying gap, report the limitation instead of reconstructing missing
detail.
# Primary provider recovery

The dependency-free `provider-recovery` controller and `provider-recovery-host`
adapter own primary turn admission, semantic liveness, durable recovery and
cancellation across web/Electron. OpenAI defaults to observe; Anthropic has a provider-specific mode and requires an explicit composing-adapter conformance attestation before enforcement. Final assistant errors are reconciled even without a session-error event; unresolved tools prevent replay. Full
safety, protocol, storage, rollout and rollback contracts are documented in
[`docs/PROVIDER_RECOVERY.md`](../../docs/PROVIDER_RECOVERY.md).

On the native transport class (`NATIVE_TRANSPORT_RECOVERY_OPENCODE_VERSIONS`,
2.1.x), `reconcileOne` owns one automatic continuation after a Step bound by the
current runtime finalizes with a typed `provider.transport`/`provider.timeout`
error or the 2.x upstream stall text. It reuses the single-attempt reservation and
the native recovery dispatch of model fallback (`recoveryKind: 'native_transport'`,
`recoveryExecution` equal to the record's own selection, a synthetic read-only
`RECOVERY_CONTINUATION` part, preceded by the original synthetic plan-mode preface
and `planMode: true` for a plan turn; `recoveryPlanMode` and
`nativeTransportContinuation` build it). The snapshot field `automaticRecoveryPending` tells
the UI to hold its manual card; a declined failure sets `reason:
'failure_not_eligible'` without changing state. The `provider_recovery_capability`
diagnostic is written once per runtime instance and when `{supported, transport}`
changes, not on every hello.

An objective completes only from a settled read: an idle, unblocked turn whose
last Step finished without error. Native jobs review and acknowledge a delivered
result after the root goes idle, so that idle read can still see the workspace
barrier. While the root is idle, each `devryan:managed-task` event for it
schedules another read, so the barrier clearing completes the objective instead
of leaving it `observing`.

For the exact pinned native 2.2.6 controller (and retained 2.0.26/2.0.30/2.1.0/2.1.3/2.1.4/2.2.0/2.2.1/2.2.2/2.2.5), constructor-only
`nativeStreamContinuation` owns interrupted-stream reserve, canonical Synthetic
binding, successor preparation/send and Step adoption. Pending plus consumed
reservations never exceed two per original objective; preparation consumes the
reservation before any physical successor. Lost or stale proofs expire on the
existing provider progress timeout, extended only by new bytes/frames from the
exact owned successor attempt. Failure preserves the budget and enters
`needs_attention`/`provider_stream_interrupted`; Stop clears pending authority.
Plain native Retry does not reserve a Continue.

Interrupted-stream admission permits a managed barrier of `clear` or `active`
when requests are explicitly unblocked. Unsettled tools, acknowledgement barriers
and unknown barrier states remain fenced, including successor Step adoption.
A refused reservation declines the retry; failures after reservation still fail
closed. `native_stream_continuation_refused` records the bounded action and reason.

`settleMissingNativeContinuation` cancels an exact pending native continuation
only under the primary mutation lock, with matching revision, directory, message
and current controller. It repeats canonical missing-session proof before commit,
clears the reservation and increments the cancellation generation. Child result
envelopes are retained; observation or transport failures cannot prove removal.

`nativeStreamContinuationReceipts(sessionID, objectiveID)` reads the consumed
canonical chain for that exact objective. Current records keep at most two
receipts; the existing record-store primitive archives each settled objective
separately under `harness/provider-stream` before later human admission or
primary pruning. The archive also keeps consumed budget without an adopted Step
receipt; explicit admission of the same original objective retains that budget
across anchor replacement or historical reload. There is no session lifetime
continuation cap. Receipts retain
the predecessor/successor assistant and Synthetic event/user identities,
selection/permit/controller fingerprints and ordinal. The read API supplies
proof candidates; a consumer must still authorize and verify canonical saved
source. Native session removal discards current and archived receipts only after
its durable decision is committed and every selected canonical session was
removed. Cleanup failure keeps that removal retryable.

## Session-owned changes

`lib/session-changes.js` owns always-on execution receipts, private Git snapshots, cumulative net summaries, paged stored revisions retained until deletion, and conflict-checked file-only Undo/Redo. It is independent of optional diagnostic evidence. `lib/session-changes-host.js` validates canonical session identity, lineage and directory; consumes and repairs paginated history; acknowledges private native execution receipts; reconciles pending observations before summary and restore; and exposes the same plugin/HTTP contract in web/Electron. The focused `session-changes-{git,snapshot,store}.js` modules own bounded Git I/O, scoped raw capture/stat caching, and atomic individually indexed metadata. Full contract, operational limits and verification: `docs/SESSION_CHANGES.md`.
Attribution version 4 orders confined receipts through a private publication
index using the mutation owner's sequence. Legacy full-file histories compose
only along unique byte/mode lineage, keeping disconnected evidence segmented.
History classification version 3 requires a call-bound reviewed tool-effect
attestation before excluding a read-only call. `session-tool-effects.js` owns
the reviewed per-tool catalog; names and compatibility aliases are capture
hints, never provenance. Native read/control completion attaches the reviewed
registration identity to its existing ledger commit, without an empty receipt
or a second per-call transaction. Conflicting exact edits remain failures.
`hasUnattributedMutations` reports unresolved call evidence rather than a constant.

File-only restore can use a version-1 proof from `previewFileRestore` for the
exact selected calls. Preview and live publication share the materialization
target/path-winner calculation. The digest binds ledger graph identity,
direction, scope, current and target paths, modes and hashes. Preview never
imports unknown foreign bytes. Prepare and settlement revalidate the proof
after writer termination and reconciliation; a stale file-only transaction is
cancelled and releases its fences. Review receipts keep their original private
branch before/after bytes and may remain segmented. Missing graph evidence,
conflicts and dependent granular edits whose surviving input ownership cannot
be proved remain unavailable; no hash-chain relaxation grants restore.
Every owned restore, including a net review, requires this proof. GET returns
`restoreProof: {version: 1, digest}`; Undo/Redo must return the exact reviewed
token with the capture revision. A refreshed proof can share that immutable
revision, but a different client token refuses with `restore_proof_stale`.

Cursor call aliases may instead report `coveredBy` for their published enclosing
execution. History excludes a read candidate only when the same-session,
same-message alias also matches the exact complete confined `cursor_sdk` outer
receipt. Metadata claims, unknown aliases and missing receipts grant no coverage;
no per-read receipt or read-only provenance is invented.

Native preflight reserves a provisional prompt sequence in the existing ledger,
bound to the exact candidate hash, fingerprint and parent. It grants no execution
or Revert authority and does not invalidate Redo. Canonical committed input
promotes that exact reservation. If Stop or a lost callback interrupts delivery,
Revert and tool admission can promote it only from matching persisted native
inbox/promoted-user proof; ordering never depends on a later guessed insertion.
This covers zero-edit prompts independently of the first managed control call.
Unresolved provisional rows are retained conservatively, bounded at 128 per
session; reaching that limit refuses admission instead of forgetting a possibly
committing input. A late promotion preserves newer transaction ownership.

### Selective conversation rollback

`createSessionMutationRuntime` records immutable execution bases and attributed
operations. `begin` creates a private view; it does **not** confine writes.
An adapter must enforce the filesystem boundary and obtain an authoritative
process-tree termination receipt before calling `finish`. Exact call scope and
execution fingerprints protect duplicate delivery. Explicit rename receipts
preserve identity when a rename also replaces the inode. Publication decisions
and their results are committed together before materializing shared files.
Recovery refuses to replace a file changed by a foreign writer after that intent.

Repeated native session registration reads the committed ledger snapshot when
the session already exists with the same parent and directory. New registrations
and pending materialization recovery still take the owner lock and commit
durably; the read path never bypasses lineage or directory validation.
`executionReceipt`, the lease capture that starts `finish`, and the
cleanability check in `cleanupLease` also read the last committed snapshot: a
published lease and its publication rows never change again. An absent or
unsettled lease in the snapshot falls back to the owner lock, and publication
and cleanup still re-read the lease under it.

Attached native `devryan_task` `wait`, `wait_any` and `status` slices may reattach
to their published control lease. `claimLease({ reattach: true })` checks control
execution with no preparation, cancellation, pending revert, changed generation
or native admission hold and returns the lease without rewriting it. The host
also rechecks the exact captured invocation and permit. Only the original slice
finishes the lease; later slices never publish another receipt or clean up a
published lease on refusal. Claimed ready leases cannot reattach.

The web server's execution host creates the runtime with
`createSessionMutationHost` (`lib/session-mutation-host.js`): under Node, as in
the packaged Electron host, the ledger runs on a worker thread of the same
process (not a sidecar) that owns every lock of the process, so walks,
hashing, ledger transactions and their Git processes stay off the event loop
that serves UI IPC and SSE (two parallel editing subagents drove the Electron
main thread to 231% CPU in the 2026-10-24 live QA). Each call carries the
caller's execution context (deadline, cancellation, journal reports, progress
meter, summary steps), which the worker recreates and reports back; input
functions (native permit guards, `beforeCommit`) and the runtime's observers
run on the caller's thread, inside the AsyncLocalStorage context of the call
that caused them (a native permit guard asserts its controller there), so a
guard check is asynchronous; and receipt byte streams are pulled on demand. A
rejection nothing awaited inside the worker is reported as a `ledger_worker`
diagnostic instead of ending the thread, as on the host's own event loop. The
worker runs its own stall clock: a stall of 1 s or more of its event loop
delays every session's ledger calls while the host's loop, and so
`host_stall`, runs on, so it reaches the host's `onWorkerStall` observer, which
the web server journals as `ledger_worker_stall` (`stallClock` tunes that clock
for tests; inline, the host clock covers the ledger). A publication's
`ledger_transaction` is attributed to exclusive steps of its summary
(`finish_lookup`, `finish_reconcile`, `finish_publish`, `finish_receipt`,
`finish_materialize`), so its lock hold is read directly, never by
subtraction; a finish summary carries 21 of the 32 step names a summary keeps. A worker exit fails pending calls with
`mutation_runtime_unavailable` (503); the next call starts a new worker and
the next lock runs durable recovery, as after a host crash. An owner lock the
dead worker held would otherwise stay: its file names the host process, which
lives on, so no other owner ever removes it and every later call failed with
`LOCK_TIMEOUT` after 30 s until the app restarted. The ledger therefore draws
each owner lock's token itself (passed to the lock as `randomToken`, the
expression the lock uses) and, with the runtime option `ownerLockClaims`,
names it to its worker's host before the lock file can exist and settles it
once the lock call has ended. The worker sends these on a dedicated
`MessagePort` in `workerData.lockPort`, not on the seam (absent inline and
under the dual-run harness's stdio transport). Posting is synchronous, so a
claim made before the thread dies is queued; on the worker's `exit` the host
drains the port, removes each unsettled lock whose file still holds exactly
that token and this process's pid (anything else is another owner's lock and
stays, including the lock a worker was only waiting for), journals one
`ledger_worker` `worker_lock_released` diagnostic, and only then fails the
pending calls; after an uncaught error the calls fail on `error`, just before
`exit`, and a new worker that already waits takes the lock at its next retry.
The lock protocol, its bytes and every other owner are unchanged. A Git
child the dead worker started (a `git update-ref` already running) is not
killed with the thread and can outlive it, so it may still run after the next
owner has taken the lock. The state ref moves only by compare-and-swap, so
such a late child makes at most one call fail (its own move or the next
owner's) and cannot corrupt the ledger: the same exposure as after a process
crash, whose children are reparented and finish, only now reached within a
lock retry rather than after an app restart.
`scripts/harness-session-mutation-host.test.mjs` makes a worker die through the
harness's crash preload (thread exit, uncaught error, termination) before the
lock file exists, holding it, during the commit and after release, with two
hosts in one process, and with the lock replaced meanwhile. The worker
inherits the host's Node flags except inline-entry ones (`--input-type`,
`-e`, `-p`): a host started with `node --input-type=module -e …`, as the
release upgrade lane starts the server, used to lose its worker before it
loaded and failed startup with `mutation_runtime_unavailable`. The runtime stays
inline with `DEVRYAN_LEDGER_WORKER=0`, on Windows, with a Windows owner or
launcher, with an injected Git runner, and under Bun unless
`DEVRYAN_LEDGER_WORKER=1` (`bun test` ends a test body early around
`expect(promise).rejects` and then terminates the worker under the pending
call). `scripts/harness-session-mutation-host.test.mjs` checks under Node that
the worker answers like the inline runtime, receives the host's runtime limits
and reports its stalls. The worker creates its runtime
with `synchronousWalks: true`: project and view walks (reconciliation, the
finish pass over a view, directory stamps) list directories and stamp files
with synchronous calls, chunk by chunk, since only that thread waits; on
13k files a stamp pass took 49 ms instead of 311 ms through the thread pool
(`DEVRYAN_LEDGER_SYNC_WALKS=0` keeps the asynchronous calls). Inline, ledger work runs on the
host event loop. Gitignored directories without tracked content are inputs: linked into
views, never ingested or published, and fenced from history replay
(`ignored_input`). On macOS, ignored output folders among them (`.artifacts/`,
`dist/`, `coverage/`, a Vite `cacheDir`) are written through to the project:
`lib/execution-inputs.js` grants their resolved directories in the Seatbelt
profile when they stay inside the project and outside the ledger storage.
Dependencies (`node_modules`, `.venv`, `__pycache__`, `vendor`, virtualenvs),
hidden folders other than known output locations (so `.husky/_`, `.opencode/`
and `.claude/` stay read-only), and anything resolving elsewhere stay
read-only; Linux and Windows keep every input read-only
(`DEVRYAN_IGNORED_WRITE_THROUGH=0` restores that on macOS).
The supported place for a call's evidence is `$DEVRYAN_ARTIFACT_DIR`. On
macOS, preparation creates a missing `.artifacts/` when Git ignores it, so it
is a write-through input before any command writes there (an ignored folder a
call creates is published like other output). `prepareArtifactDirectory`
(`lib/session-execution.js`) then creates the call's own
`.artifacts/devryan/<session>/<call>/` inside that granted directory, one
component at a time, and sets the variable only when no component is a link
and the folder resolves to itself. Its files reach the project unpublished,
so file tools read the same bytes; deleting `.artifacts/` itself replaces the
input and is reported in `ignoredInputs`. `DEVRYAN_ARTIFACT_DIR=0` stops both
steps.
A process lease also records the ledger's file epoch when its view is copied:
the count of commits that changed project files (publications, Revert, Redo
and reconciled outside edits). `viewFreshness({directory, token})` answers
`fresh`, `stale` (with how many such commits followed) or `unknown` (a lease
that is not running); a read-only lease runs in the project and is always
fresh. An outside edit counts once the ledger reconciles it, at the next
preparation or publication. Every execution's environment carries
`DEVRYAN_EXECUTION_VIEW`, a 16-hex digest of its lease token
(`executionViewMarker`) that the servers it starts inherit, so the host can
tell which view a loopback listener serves.
Plan shell instead marks its execution lease read-only: preparation suppresses
all input write grants and browser allowances, macOS denies networking, and the
Linux launcher creates a private network namespace before its acknowledgement.
On Linux the original snapshot remains visible as its logical working directory
under the read-only host mount/profile; on macOS a lease reserved with
`preparation: 'read-only'` has no snapshot and runs from the live project
directory under the same read-only profile. Windows refuses this mode because its current
LPAC policy lacks equivalent read-only workspace and isolated-network grants.
An ignored folder a call creates in its view is published like any other output.
A `node_modules` input links instead to a
host-owned overlay under the ledger's `module-overlays/`: one link per project
entry, re-synced from the project listing at each preparation, with `.vite`,
`.vite-temp`, and `.cache` linked into the project's writable execution cache
(`context-cache/module-caches/`). Vite and similar tools can write their caches
while dependencies, the overlay, and the project's own caches stay read-only
(`DEVRYAN_MODULE_CACHE_OVERLAY=0` restores the direct link). Walks yield between tree levels and batches;
diffs and hunk bookkeeping have fixed work budgets past which they emit exact
but coarser replacements. Replacement runs store only their direct ancestry and
hunk bookkeeping indexes runs by id (no whole-run-list scan per ancestor);
documents whose runs replace text are fenced by a format page that older hosts
reject (`docs/CONCURRENT_REVERT.md`). Ledger maintenance reduces documents an
older host stored with every run's closure (`minimizeMutationAncestry`, whose
comment gives the argument that every closure is kept) and rewrites them fenced.
A document whose runs still reach the complexity ceiling switches to whole
content, decided before conflict detection.
`scripts/perf/mutation-ancestry-replay.mjs` replays
overlapping rewrites of one large file through `applyMutationText` and reports
per-edit apply and row encode/decode times and run/ancestry growth, with the
source, runtime, machine and fixture identity; `--runtime` runs a frozen
baseline against a candidate, and `--max-apply-ms`/`--max-pages-mib` make it a
gate. `scripts/perf/ancestry-compaction-load.mjs` plants that history as stored
closures and times another session's direct admissions, confined calls and
lease cleanups before, during and after the compaction pass, with timer
lateness, lock timings and machine load; it gates direct admission, its finish
and lease cleanup p99 and the lateness. The background first build (`warm`) is a single
budgeted pass that real calls never treat as their observation. Every 32 rows
under the ledger lock it checks for a queued call; when one waits, it commits
what it installed and carries the rest to its next batch, so a new worktree's
first build no longer holds tool receipts for 10–15 s. Maintenance and
input-classification failures reach `onDiagnostic` as codes; a failed Git step
adds its subcommand (`command`) and a bounded class (`failure`: `timeout`,
`lock`, `corrupt`, `no_space`, `not_git`, `signal` or `exit_<code>`), never a
path or stderr. Ledger maintenance (pack, then prune past a 2-hour grace) runs
every 64 ledger commits of a process and, because a runtime process often
commits far fewer times, also when a process's first commit to a ledger finds
1,000 or more loose objects. Session-change stores collect every 128 settled
operations or as soon as they hold 1,000 loose objects
(`maintenanceLooseObjects`).

`createSessionRevertCoordinator` requires both the legacy conversation-only API
capability and a confined execution owner. It persists target-tree fences,
previous conversation boundaries and phases before changing native history.
Conversation failures restore only those boundaries; after the file commit
decision, recovery proceeds forward. Revert disables recorded operations and
Redo reactivates them. No project publication lock is held during cancellation.
Absent exact history, incompatible runtime and unconfirmed termination are
distinct errors. The declarations adjacent to these modules define the host
contract.

Cold startup can call `settleRevert` with `commit: false, cancelUnstarted: true`
to cancel a conversation Revert/Redo still in its initial `prepared` phase,
without saved boundaries. The locked ledger refuses later phases, file-only
transactions and unresolved member execution leases. Cancellation clears pending
fences while retaining the transaction, generations and captured history.

The production host installs this coordinator when the companion and native
artifacts have passed acceptance. Native OpenCode, managed
descendants, Cursor/Claude and file Undo/Redo share that boundary. See
[Concurrent Revert](../../docs/CONCURRENT_REVERT.md) for rollout, recovery and
unsupported-runtime behavior.

### Session title correlation

Selected-project ledger warming may refresh an existing ledger within its file/byte budget. Warm budgets must be positive safe integers within the production caps (20,000 files and 512 MiB); directory enumeration also stops after four times the file budget, including empty directories, before inspecting file contents. A foreground observation supersedes the advisory pass at its next checked enumeration or batch boundary; already committed batches remain, and an interrupted install uses the same guarded commit and rollback as other owner changes. Host replacement cancels queued warming through its captured lifetime before any new pass starts. Advisory refresh batches identical-content restamps while preserving device/inode/size/time/mode identities and install rechecks. A real reservation still requires an authoritative observation started after reservation; a warm pass cannot supply admission proof. Process settlement, publication, Cursor receipt drain and native save have separate diagnostic phases and do not set early completion timestamps.

The web host emits `session_title_generation` lifecycle records with the target session in top-level `sessionID` and the hidden helper in `payload.helperSessionID`. The event-specific sanitizer preserves stable IDs, enumerated stage/outcome/source/selection mode/refusal codes, nonnegative bounded lengths and timing, strict equality/provenance booleans, and valid provider/model/status/attempt metadata. Native/candidate/expected title comparison evidence survives both journaling and export. Title text, raw errors, source prompts and title/source hashes are excluded even when injected into this event; these extra comparison fields do not widen unrelated payloads.

Parent collection and native stream-continuation admission may request host-owned `executionOutcomes` for failed tools. The mutation ledger returns `never_started`, `finished`, or `uncertain`, scoped to exact session/message/call identities. A cancelled call without execution, or a cancelled and fully cleaned pre-launch lease, proves `never_started`; a published lease proves `finished`. Initial negative native Plan admission uses `cancelUnstartedCall` with `requireAbsent: true`: an existing execution pointer or mismatched receipt is refused without rewriting a lease. Missing, mismatched, or unsettled evidence stays uncertain. A call the caller observed as a built-in read-only direct tool (`read`, `glob`, `grep`, `skill`, passed as `tool`) has no side effect to attest and is reported `finished` unless a non-direct lease for that call carries other evidence; provider recovery passes each failed part's tool. Read-only direct calls are admitted against the committed snapshot's generation and record their call row only through the grouped `finishDirect` commit, which still completes before the tool result is acknowledged. Neither collection nor recovery treats error text as execution evidence or replays those commands. Existing collection idempotency, stop and supersession fences remain in force.

The session execution owner forwards its caller signal and diagnostic observer
through admission and preparation. A rejected start waits for all preparation I/O,
the no-launch cancellation attestation and lease cleanup before rejecting to the
provider; it never releases provider authority while cleanup is still pending.

Concurrent native read-only `finishDirect` calls for the same requested directory
and execution signal share a commit in groups of at most 64. A group stays open
while it queues for the owner lock and closes once the lock is held, so calls
that arrive as separate requests during that wait join it. Each call keeps its captured execution
scope, cancellation, generation and exact identity checks. Private store staging
rolls back a refused call without losing accepted siblings; every caller waits
for the shared durable commit before receiving its own acknowledgment. A failed
commit acknowledges none of them, leaving the original tokens retryable. Queued
callers follow the actual lock holder's progress, and mandatory commit I/O settles
before ownership is released.

Ledger stores read objects through one long-lived `git cat-file --batch`
(and `--batch-check` for subtree identities) per ledger Git directory instead
of a process per read, and read the state ref's loose file directly, asking
Git only when it is absent or unexpected. Idle readers exit after 15 seconds
and never keep the host alive; a dead or stuck reader fails its pending reads
and the next read starts a new one. Windows and constructor-owned Git runners
keep one process per read. Owner-locked state commits keep the ledger's Git
index (`state.metadata-index`) between commits instead of rebuilding it from
the whole tree; it is trusted only while its sibling `.tree` record names the
current tree, which is removed before the index changes and rewritten after
the ref moves. Kill switches: `DEVRYAN_LEDGER_PERSISTENT_READER=0`,
`DEVRYAN_LEDGER_PERSISTENT_INDEX=0`.

With the persistent reader, a commit does not use the index at all
(`session-changes-trees.js`): it writes the transaction's new blobs and the
trees on the changed paths as loose objects (the same bytes `hash-object -w`
and `write-tree` would write, in SHA-1 and SHA-256 ledgers, under Git's
default policy of not syncing loose objects) and then moves the ref with the
same guarded `update-ref` compare-and-swap and rollback. Through the index a
commit cost four processes and read and rewrote the whole index (8 MB and
49k entries on a 13k-file project, about 115 ms per commit, seven commits per
confined edit, all under the owner lock). Direct commits remove the kept
index's `.tree` record first, so an index commit later rebuilds it. Kill
switch: `DEVRYAN_LEDGER_DIRECT_TREES=0`. After a commit a store remembers the
values it just wrote, so rewriting one unchanged stages nothing (a finished
publication no longer commits its unchanged `meta.json` again). Publication
recovery records the observation stamp of each file it writes and verifies,
naming the document in its materialization rows; the next reconciliation then
skips those files instead of restamping them in a commit of its own. Rows
written by older hosts carry no document and are left to reconciliation.

`createSessionMutationRuntime({ gitRunner })` routes ledger store Git I/O
through an injected runner (`git`, `gitTokens`, `gitRecords`, optional
`readObject`). `lib/session-mutations.latency-budget.test.js` counts store
processes and state commits through it: a direct read costs one commit and
one process, eight concurrent finishes share one commit, staggered separate
requests at most two, and a single-file confined edit at most seven commits
(reserve, pin, ready, claim, publication intent and completion, cleanup) and
16 processes (41 through the index). A read-only process lease
(`reserve({ preparation: 'read-only' })`, the macOS Plan-mode shell) runs no
reconciliation and no `view_files`, `view_commit`, `view_git` or `view_inputs`
step, costs at most five commits and seven processes, and
always publishes an empty result; on a 2,000-file fixture its preparation took
75 ms instead of about 400 ms. `cancelLease({ stoppedBy: 'operator' })` records
that a user Stop ended a run.

Incremental views (macOS and Linux; `DEVRYAN_VIEW_REUSE=0` copies every file
again). Cleanup of a published process lease, after its termination receipt is
verified, renames the view to `view-standby/<id>` in the ledger root instead of
deleting it; the session's next preparation (`view_reuse` step) moves into its
own fresh view every file still exactly as materialized and copies only the
rest. A file is adopted only while its ledger entry is unchanged and its full
stamp (inode, size, mode, nanosecond mtime and ctime) still equals the one
recorded at materialization and found untouched by publication; any write,
chmod, link, attribute change or replacement moves ctime or the inode. A
directory is kept only while its stamp is unchanged since its preparation
finished (`view_record` step), and is otherwise rebuilt fresh around its
verified entries. Links (inputs among them), `.git`, special files and
directories holding no expected file are discarded, so the view equals a full
copy file by file (`session-mutations-view-reuse.test.js`). Summary steps
`view_copied` and `view_reused` count files. Standbys are known only to the
process that parked them: at most four per session and twelve per process, never
adopted after 30 minutes, and swept by any process after an hour.
`prewarmView({ directory, sessionID })` builds a session's standby before its
first confined call: the execution host calls it when it registers a managed
Cursor child (including inspection-only Explorer) or another child that may
write (not Plan-mode read-only and not Explorer, Librarian, Oracle or Council;
`managedTaskMayWrite` in `@devryan/orchestration-runtime`). Cursor's confined
worker needs a private view even for inspection; preparation grants no write
permission. The executor carries this trusted choice in `prewarmExecutionView`.
It materializes the published files from the committed snapshot outside any
lock, and the child's first preparation adopts the standby under the same
checks, copying anything that changed meanwhile; a preparation that starts
while the prewarm runs waits for it instead of copying twice (13k files cost
each subagent 1.8–3.2 s of `view_files` in the 2026-10-24 live QA). Kill
switch: `DEVRYAN_CHILD_VIEW_PREWARM=0`. A session without a standby of its own
adopts the most recent one another session of the same project parked (parallel
calls in one session and a primary session's first calls copied the whole
project otherwise: 7 of 36 preparations in the 2026-10-24 replay); adoption
checks every file against the adopting lease's snapshot either way. Kill switch:
`DEVRYAN_VIEW_SHARED_STANDBY=0`. Windows views
carry owner-created ACLs and are still rebuilt per lease. A later single-file
edit (prepare, publish, cleanup; p50 of 12 on an idle machine) went from
0.98 s to 0.71 s on 2,000 files, 2.1 s to 1.1 s on 6,000 and 5.4 s to 2.0 s on
12,000, where `view_files` fell from 2,050 ms to 74 ms (plus 81 ms
`view_reuse`) and cleanup from 954 ms to 120 ms. A view's Git metadata (`view_git`) takes two processes:
`git init`, and one `rev-parse` that answers the project's common and private
Git directories and HEAD together; the branch ref is written as the loose ref
`update-ref HEAD` would write. Content objects are verified by SHA-256 once
per file identity (device, inode, size, nanosecond mtime and ctime) before a
view clones them, and verified identities persist in the ledger root's
`verified-objects.v1` (mode 0600, compacted when it holds twice as many lines
as objects; newly installed objects are recorded at install). After an app
start the first view no longer rehashes every object (13k files took 5.9 s of
`view_files` in the 2026-10-24 live QA); summary step `object_verify_hashed`
counts the objects still hashed. Kill switch:
`DEVRYAN_PERSISTENT_OBJECT_VERIFY=0`. Edit and write tools still get the whole view: their worker runs the
project's formatter, which reads configuration and dependencies outside the
named target, so a target-only view would change their results.

Publication finds the current owner of each path it writes from one parsed
listing of the committed `files` documents per tree, shared with the
preparation that read the same tree, plus this transaction's staged documents
(`DEVRYAN_LEDGER_PATH_WINNERS=0` reads every document again, about 190 ms per
publication on 6,000 files). A new tree's listing reuses the previous
listing's parsed documents whose object id is unchanged and reads only the
rest, so object reads per confined edit no longer grow with the project
(`DEVRYAN_LEDGER_INCREMENTAL_FILE_INDEX=0` reads every document again).

Prepared baseline reuse (`DEVRYAN_PREPARED_BASELINE_REUSE=1`; off by default,
any other value runs the durable read only). Preparation keeps the
`bases/<token>/files` pages it stages, as the exact JSON page strings
`setList({ collect })` stages (never the shared `doc.published` objects), and
publishes the entry only after `view_commit` and the ready lease are durable.
Publication (`finish_baseline`) uses it only in the runtime that prepared the
lease, for the same ledger root, while the store opened at the lease ref names
the same view tree OID; any mismatch reads the durable rows, and the parsed rows
are fresh objects. One LRU budget for the process, 100,000 rows and 32 MiB of
the values' JSON (`setList`'s byte total): a new entry evicts the least recently
used, and a lease larger than the whole budget is never kept (its collection
stops there). A miss only costs the durable read, so nothing waits for or is
refused by it. Entries go on publication (success or failure, including
`execution_reverted`), `cleanupLease` (which releases the lease ref),
`cancelLease`/`cancelUnstartedCall` and `drain`. Finish summaries then carry
`finish_baseline_prepared`, the rows taken from memory (0 on a miss).
`preparedBaselineUsage()` reports the process totals. Termination, lease and
admission checks, output inspection, conflicts, intents, CAS, rollback and
Revert/Redo are unchanged (`session-mutations.baseline-cache.test.js`). On a
synthetic single-file edit (2026-11-05, loaded machine) `finish_baseline` fell
from 22 to 1 ms at 2,000 files and from 23 to 4 ms at 6,000, and object reads per
edit from 101 to 87 at 2,000; processes stay at 16. At 12,000 files
(`node scripts/perf/tool-latency-benchmark.mjs --files 12000 --edits 12`, two
alternating runs per mode) the whole edit did not improve: median 1,003 → 1,026 ms
direct and 957 → 981 ms through the host, p90 1,178 → 1,579 ms and 1,018 →
1,109 ms, and the cold first wave was slower. No benefit was shown, so the
switch stays off by default and is not qualified.

While this process applies a publication or revert intent (between its intent
commit and the commit that completes it), lock-free snapshot readers such as
`nativeAdmissionState` and `assertAdmission` answer from the tree committed
before that intent instead of queueing behind the owner: the operation has not
completed, so the read is ordered before it, exactly as one arriving a moment
earlier. Another process's pending intent, or an unrecoverable one, still makes
them fall back to the lock and fail closed. A read that would fail or write
also still takes the lock. Slow `ledger_lock` records of such a fallback carry
`reason: snapshot_<absent|materialization|meta|write|error>`. Writers such as
`bindNativeShellJob` keep the owner lock; their queue time behind sibling
writers is reported in the same records.

`withExecutionPreparation` is its own summary root: one `preparation` record
carries its steps, so the same time is no longer journaled as both `admission`
and `preparation`. `executionToolMetadata` maps the native host kinds `shell`,
`writer` and `read` to `executionTier: 'process'`. `scripts/perf/tool-latency-benchmark.mjs` reports per-phase p50/p90
for the same calls on a seeded ledger, optionally with Git process and commit
counts (`--count-git`) and against another checkout (`--runtime`).

Publication summaries also record `finish_baseline`, `finish_walk`,
`finish_inspect`, `finish_reconcile`, `finish_materialize` and `finish_notify`.
`finish_files`, `finish_reused`, `finish_inspected` and `finish_touched` are counts,
not durations. Timing uses `timedExecutionStep`, preserving existing admission,
termination, lease and publication checks. No file content or path is journaled.
The tool-latency benchmark retains paired `samples` by call/writer/wave alongside
aggregate percentiles and per-wave process CPU versus host event-loop busy time.
Finish substeps may nest inside lock/transaction totals; do not sum overlapping
steps or add percentiles from different calls. Its synthetic edits bypass real
provider/worker/formatter startup and do not qualify end-to-end app latency.

Read-only lease and outcome queries retain the owner lock and durable recovery checks, but do not stage unchanged metadata or rebuild the Git index. `lock_wait`, `ledger_open`, `ledger_recovery`, `ledger_transaction`, and `ledger_commit` diagnostics identify work inside the lock; they are journaled only when a phase fails or takes at least 250 ms, because every tool call takes this lock. Every confined worker receives its own scratch `HOME`, temporary paths, and execution-worker marker, including Cursor and read-only provider workers. On macOS each execution also gets a short private runtime directory, exported as `XDG_RUNTIME_DIR` and spelled `/tmp/dr-<uid>/<lease digest>`, because the scratch path exceeds the 104-byte Unix socket limit. The agent-browser daemon socket therefore fits with its full lease session name (budget: 26 bytes for the directory). The profile lets the execution create and reach sockets only there, plus the system resolver. Cleanup removes it, and host recovery sweeps orphans older than a day. The parent must be a real directory owned by the user with mode 0700, or preparation fails closed. Every session-scoped execution also gets `DEVRYAN_SESSION_TMP`, `context-cache/session-tmp/<session digest>`: unlike the per-call scratch it survives between the session's calls, so logs and reproduction output remain readable. Preparation never follows a link planted at either level, and directories idle for a week are swept at most hourly per project. `/tmp` itself stays unwritable. Session-scoped executions on macOS can also run headless Chromium (a project's Playwright check): `PLAYWRIGHT_BROWSERS_PATH` names the host's `~/Library/Caches/ms-playwright` (read and execute only; an explicit host value is kept), a `NODE_OPTIONS` preload (`$HOME/.devryan-node-spawn.cjs`) restores the verified spawn adapter that macOS strips when `npm run` passes through `/usr/bin/env` and `/bin/sh`, and the profile allows exactly one mach lookup, `org.chromium.Chromium.MachPortRendezvousServer.<pid>`, which Chromium's helpers need for their IPC ports. Native-bundle shell executions get them too (`workerBrowsers: true` in `packages/web/server/application.js`); before that, agents had to find the cache and set `PLAYWRIGHT_BROWSERS_PATH` by hand. Provider transports, read-only shells and document/AST workers never get these. `DEVRYAN_WORKER_BROWSERS=0` restores the previous environment and profile exactly. A detached child cannot get its own process group inside the boundary, so a starter that stops it with `process.kill(-pid)` (Playwright's `webServer`, bounded test wrappers) used to signal nothing and wait for an exit that never came. The preload names the group of each detached child in `DEVRYAN_SPAWN_GROUP` and delivers a group signal through the verified launcher's `--signal-group` mode; the spawn adapter does the same for processes that have it. Signals stay inside the execution's own sandbox. `DEVRYAN_WORKER_GROUP_SIGNALS=0` turns this off in the preload and the adapter. WebKit, Firefox, the Google Chrome channel, headed mode and `chromiumSandbox: true` remain unsupported.

On macOS with a full Xcode selected, Apple's `/usr/bin` developer tools exit 71
(`EX_OSERR`) under both execution profiles. This covers `git`, `cc`, `clang`,
`make`, `swift` and the other hard links of the tool shim, and `xcrun`. The shim
spawns `xcodebuild` before it selects the tool, the profile denies `posix_spawn`
so that process groups stay supervised, and the spawn adapter never loads into a
platform binary. With only the Command Line Tools selected, the shim runs the
tool directly and works. `prepareSessionExecution` therefore receives the
environment the command will run with, and `lib/execution-developer-tools.js`
inserts the selected Xcode's `Toolchains/XcodeDefault.xctoolchain/usr/bin` and
then its `usr/bin` immediately before the first `/usr/bin` entry of that `PATH`.
This is the order `xcrun` resolves in; `Developer/usr/bin/ld` is itself an
`xcrun` stub. It also sets `SDKROOT` to the macOS SDK when the command has none,
as the shim does for the tools it launches; without it, `cc` finds no SDK
headers. `PATH` entries ahead of `/usr/bin`, such as Homebrew's, keep their
precedence.

The host reads the selection with `xcode-select -p`, passing the command's own
`DEVELOPER_DIR`. This spawns no `xcodebuild`, and the result is re-read at most
once a minute per `DEVELOPER_DIR` value. The environment stays unchanged
on other platforms, with a Command Line Tools selection, when `PATH` has no
`/usr/bin`, or when the selection cannot be read. Known limits:

- Explicit `/usr/bin/<tool>` and `xcrun` calls still exit 71. So do Xcode tools
  that are themselves `xcrun` stubs: `gcc`, `g++`, `swift-package` and
  `sourcekit-lsp`.
- Xcode's `python3` needs the spawn adapter's in-place spawns, described below,
  and Xcode's `pip3` still exits 71 because its interpreter is `xcrun`.
- Because whole directories are added, Xcode tools without a `/usr/bin` shim
  become visible (`clang-format`, `xctest`, `simctl`), and Xcode's copies of a
  few `/usr/bin` tools (`leaks`, `vmmap`, `xcodebuild`) come first.
- `TOOLCHAINS` is not consulted.

`DEVRYAN_DEVELOPER_TOOL_PATH=0` restores the previous environment.

The profile still denies `posix_spawn`, and the macOS spawn adapter also emulates
in-place spawns (`POSIX_SPAWN_SETEXEC`, an `execve` with spawn attributes).
Xcode's `python3` is a stub that re-executes its framework's `Python` this way,
preferring its own architecture. The adapter applies the attributes and file
actions to the calling process and calls `execve` without forking, so the
process keeps its pid and its supervised group. If `execve` fails, the adapter
restores the caller's descriptors, working directory, effective IDs, signal
actions and mask before it returns the error, as the kernel does, so
`posix_spawnp` can try the next `PATH` entry. `execve` cannot choose a slice of a
universal binary: it runs the caller's architecture, and only native processes
can load the adapter (dyld stops a Rosetta process that names it). An
architecture preference is honoured when its first entry is the native type or
`CPU_TYPE_ANY`, as the stub's is, and refused with `ENOTSUP` otherwise. Xcode's
`python3` and `python3 -m pip` therefore run under both execution profiles when
started directly or from zsh or bash, which restore the adapter. Started by a
protected binary such as `/bin/sh` or `/usr/bin/env`, they still fail, because
macOS strips `DYLD_*` there. Xcode's `pip3` script still exits 71: its
interpreter is `/usr/bin/xcrun`, which spawns `xcodebuild` first.

`SessionMutationRuntime.recoverNativeRemovalOwnership` is constructor-only clone
recovery. Its checkpoint ID and source object ID come from complete selected
bundle verification, not HTTP input. Under the ledger lock it verifies the
preserved migration ref, unchanged inherited removal decisions, member
generations and removal holds, then atomically adopts unfinished records for
the new bundle. A plain admission hold left beside the removal hold by the
record's previous owner or the clone's source bundle is released, as that
settled controller's own restart would have done; any other hold refuses. It
preserves removal holds and all terminal decisions; preparing records still
need a new authorized delete request.

`beginNativeRemoval` checks unfinished descendant decisions under the same
ledger lock before adding an ancestor hold. A conflict returns
`native_removal_in_progress` (409), leaving the descendant's original decision
and authorized retry usable; completed descendant decisions do not block a
later ancestor removal.

Session change responses separate immutable captured revisions from bounded,
read-only `current` content observations and per-session `coverageBySession`
reasons. Each file row also exposes the same observation as `verification: { state, reason }`;
content mismatch does not identify an author or authorize restoration. See
`docs/SESSION_CHANGES.md` for verification states and limits.

For a provider-free preparation benchmark, run `DEVRYAN_VIEW_PREWARM_BENCHMARK=1 node scripts/test-isolation-guard.mjs bun test packages/harness-runtime/lib/session-mutations-view-reuse.test.js -t "prewarm benchmark"`. The isolated 243-file fixture compares cold, prewarmed and two concurrently prewarmed first leases plus a subsequent lease in the same session, reports elapsed times without timing assertions, checks adopted-file counts, and verifies separate private views. The symlink is intentionally copied during the first preparation; the subsequent lease adopts all 243 unchanged entries and verifies the complete view's content. These measurements exclude provider, SDK startup, network and native process latency.

## Direct ledger listings

Once a ledger's whole listing has passed the 1 MiB bound, its store lists one
prefix at a time (`ls-tree -r -l -z <tree> -- <prefix>/`). That paged listing
no longer starts a Git process: `listTreeRows` in
`lib/session-changes-trees.js` walks the prefix's tree objects through the
store's persistent object reader, parses them with `parseTree` and asks the
reader's `--batch-check` mode for blob sizes. The rows and their order are
exactly Git's. It is on by default wherever the persistent reader is (not on
Windows, nor with `DEVRYAN_LEDGER_PERSISTENT_READER=0` or a runner without
`readObject`).

Git still answers whenever its answer could differ: any missing, corrupt or
unreadable object on the path or below it (Git then fails as before,
`capture_git_failed`), a mode Git would print otherwise, a tree on the path or
below it that is not strictly in Git's order or repeats a name (`inGitOrder`;
Git's walk stops early or matches twice there), a prefix component that names
a file, or a prefix outside `[a-zA-Z0-9_-]` path components. A
prefix is resolved one tree at a time, and an empty answer is given only when
a component is absent from a tree that was read. Nothing is remembered between
listings, and a listing keeps at most 256 reads queued on the shared reader.
Whole-tree listings stay with `git ls-tree`: read object by object without a
cache, they cost a read per tree and blob of the ledger, which the harness
budget (`session-mutations.latency-budget.test.js`) forbids.

Kill switch, read per use: `DEVRYAN_LEDGER_DIRECT_LISTINGS=0` pages with
`git ls-tree` as before. The switch is recorded in run fingerprints. Measured
on 2026-11-12 on a shared, loaded machine (ratios between interleaved arms): a
first warm of a 7,324-file repository starts 28 instead of about 3,018 Git
processes (2,988 of them were paged listings) and takes about half the time;
a publication in a ledger under the bound is unchanged.

## Rust ledger core

A first-party Rust port of the ledger's text diff (`mutationDiff` in
`lib/session-mutation-text.js`), run as WebAssembly. `mutationDiff` uses it
only when `DEVRYAN_LEDGER_RUST=1`, which is off by default. The JavaScript
implementation (`javascriptMutationDiff`, unchanged) is the reference and
stays the fallback.

- **Where.** The crate is `native/ledger-core/` (no dependencies of any kind;
  `rust-toolchain.toml` pins Rust 1.99.1 with `rustfmt`, `clippy` and the
  `wasm32-unknown-unknown` target). `native/ledger-core/src/diff.rs` is the
  port and forbids unsafe code; `native/ledger-core/src/lib.rs` is the export
  layer and the only unsafe code. The
  built module is tracked as `lib/native/ledger-core.wasm`, with
  `lib/native/ledger-core.json` beside it. `native/ledger-core/tests/vectors.tsv`
  holds edit scripts the JavaScript produced
  (`native/ledger-core/tests/generate-vectors.mjs` writes it), so
  `cargo test` checks the port without JavaScript.
- **Rebuild** after any crate edit with `node scripts/build-ledger-core.mjs`.
  It needs the pinned toolchain and never downloads one; a missing toolchain,
  component or target fails with the `rustup toolchain install` command. Every
  cargo command runs on a copy of the crate under the OS temp dir, with a
  private `CARGO_HOME` and target directory there, so no Cargo configuration
  of the checkout's ancestors (a `~/.cargo/config.toml`) reaches the build; any
  above the copy fails it. The copy is removed afterwards (`--keep-artifacts`
  keeps a failed build's). It builds with `--locked --offline` in release, the
  flags recorded in the provenance file and `SOURCE_DATE_EPOCH=0`. Two builds from different directories are
  byte-identical. `--check` rebuilds and fails unless both tracked files are
  byte-identical; `--verify` runs `cargo fmt --check`, `cargo clippy -D
  warnings` for the host and the WebAssembly target, `cargo test`, then
  `--check`. Fast `validate` runs `--verify` when the crate, the build script
  or the tracked module change, so only those changes need Rust; CI's `static`
  job runs it on every push and on pull requests that make such changes.
- **The provenance file** records the schema version, the module's SHA-256 and
  size, its ABI version, the target, the compiler and Cargo versions, the build
  command, flags (`{crate}`, `{cargoHome}` and `{toolchain}` stand for local
  paths) and environment, and the SHA-256 of each crate input with their
  digest: SHA-256 over one `<path>\0<sha256>\n` line per file, in the order
  `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, then `build.rs`,
  `.cargo/config.toml` and `.cargo/config` when they exist, then every file
  under `src/` sorted by path. `scripts/build-ledger-core.test.mjs`, which needs
  no Rust, fails when the digest, the module's hash or its ABI no longer match,
  so a crate edit without a rebuild fails on every lane, and when the crate
  holds a file that is neither a digest input nor under `tests/` (or
  `.gitignore`).
- **The native acceptance digest** (`scripts/opencode-v2-native/artifacts.mjs`)
  hashes the `.js`, `.json` and `.rs` files of this package, so it covers the
  loader, the crate sources and `lib/native/ledger-core.json`, not the `.wasm`
  itself nor the `.toml` and `.lock` files. That is enough: the provenance file
  pins the module's SHA-256 and size and the hashes of those crate files, and
  the loader refuses any module whose bytes differ, so the code that can run is
  bound to the digest through the provenance file. Every crate edit changes the
  digest, so existing native evidence goes stale as for any runtime change.
- **The switch.** `DEVRYAN_LEDGER_RUST=1` turns the Rust path on; it is off by
  default and any other value is off. `lib/ledger-core.js` reads it on every
  call; it is recorded in run fingerprints (`HARNESS_BEHAVIOUR_SWITCHES`). In
  the ledger worker the value is the one the worker started with. Off,
  `mutationDiff` calls `javascriptMutationDiff` directly, as before (it adds
  one environment read, a counter increment and a `{ budget }` object per
  call). On, `mutationDiff` keeps the JavaScript early exits
  ahead of the core (equal texts, a NUL byte, invalid UTF-8: nothing is
  copied), asks the core for the edit script as (kind, byte length) pairs and
  rebuilds the same `[{ kind, text }]` list by slicing its own two strings, so
  the result, and every run and byte the ledger persists from it, is the one
  `javascriptMutationDiff` returns. `applyMutationText` and the rest of the
  ledger are unchanged and reach the core only through `mutationDiff`. The core
  repeats the early exits itself so that it is a total function over bytes
  (`native/ledger-core/tests/vectors.tsv` pins both); from `mutationDiff` they
  are never reached, and JavaScript owns them. `mutationDiffPaths()` counts the
  calls each path answered in this thread (`rust`, `javascript`, `early`); the
  tests use it to fail a silent fallback, nothing in the product reads it.
- **The loader.** `ledgerCoreDiff(before, after, budget, { onDiagnostic })`
  takes the two latin1 byte strings `mutationDiff` receives and a budget, and
  returns the edit script as a `Uint32Array` of `[kind, bytes, ...]` pairs
  (kind 0 equal, 1 delete, 2 insert), or `null` to use JavaScript.
  `createLedgerCore({ moduleUrl, provenanceUrl, environment })` builds a
  separate loader (tests). The module is read once, lazily and synchronously,
  and compiled only when its size and SHA-256 equal the provenance file's.
  Paths resolve relative to the loader, which the packaged app keeps in the
  unpacked `harness-runtime` folder. It works on the main thread and in worker
  threads, under Node and under Bun; `lib/ledger-core.test.js` also loads a copy
  laid out as `Resources/app.asar.unpacked/node_modules/@devryan/harness-runtime`
  from a worker thread. The packaged proof itself is the release dry run.
  WebAssembly memory never shrinks, so an instance whose memory exceeds
  `LEDGER_CORE_RETAINED_MEMORY_BYTES` (8 MiB) after a call is dropped and the
  next call instantiates the compiled module again. Measured: a two-edit diff
  of a 32 KiB file leaves 1.4 MiB, 256 KiB 3.7 MiB, 1 MiB 11.2 MiB, 8 MiB
  81 MiB. So edits up to a few hundred KiB reuse one instance (about 1 µs per
  call for a tiny diff), and nothing a large call grew is kept. A fresh
  instance costs about 50 µs under Node and 160 µs under Bun (measured on a
  loaded machine, load average 20 to 30).
- **Fallback.** A call answers `null` when the switch is off, and also when the
  module or provenance file is missing or unreadable, the hash does not match,
  compiling or instantiating fails, the ABI version or exports differ, the
  budget is not a safe integer, a text is not a byte string, an allocation
  fails, the call traps (the instance is then dropped), the status is an error,
  or the script does not cover both texts exactly. Each cause except the
  switch is reported once per loader (once per thread for `ledgerCoreDiff`) to
  the caller's `onDiagnostic` as `{ phase: 'ledger_core', state: 'fallback',
  code: 'ledger_core_<cause>' }`, the shape the runtime's other diagnostics
  take. The loader never throws: any options value (`null`, a non-object, a
  throwing getter) is accepted, and only a function `onDiagnostic` is called.
  `mutationDiff` passes the execution's own diagnostics
  (`executionDiagnostic`, and only while an admission, summary or observation
  journals the work), so a fallback reaches the diagnostic journal as a
  `session_execution` record with `phase: 'ledger_core'`, `state: 'fallback'`,
  `code: 'ledger_core_<cause>'` and the call's session, message and call IDs;
  from the ledger worker it crosses to the host like the worker's other
  reports. Diffs outside such work (background maintenance) fall back silently
  and leave the cause unreported, so the next journaled call reports it. A
  call that falls back runs `javascriptMutationDiff` (after a load-time cause,
  every later call does), so a fallback never changes a result.
- **Equivalence evidence.** `lib/session-mutation-text.test.js` runs every case
  on both paths and asserts the path counters; with the module missing every
  Rust run fails. `lib/session-mutation-text.differential.test.js` compares the
  whole result of both paths on seeded inputs for a time budget (2 s by
  default, each case with its own timeout): one-ASCII-side pairs, four-byte
  code points sharing leading bytes, unrelated pairs, empty sides, early exits,
  budgets 0, 1, small, random and the default (at least 1,000 pairs whatever
  the clock, `DEVRYAN_LEDGER_DIFFERENTIAL_PAIRS`), budgets that run out inside
  the second recursive call (found by bisection on constructed pairs, and
  asserted to occur), every pair of small strings over `ab` and `abc` across 16
  budgets, and texts at and near the 8 MiB granular limit, after which no
  instance larger than the retention cap is kept. The trap fallback is tested
  on the loader (`lib/ledger-core.test.js`), the journal wiring through
  `mutationDiff` with a budget fallback. The extended run (by hand,
  before default-on):
  `cd packages/harness-runtime && DEVRYAN_LEDGER_DIFFERENTIAL=extended DEVRYAN_LEDGER_DIFFERENTIAL_MS=1800000 bun run test ./lib/session-mutation-text.differential.test.js --timeout 7200000`
  adds pairs up to 64 KiB and prints its counts (`DEVRYAN_LEDGER_DIFFERENTIAL_SEED`
  picks another seed). The history replay diffs every file each commit in a
  range changed (to 8 MiB) on both paths and exits 1 on any difference or
  fallback:
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/perf/mutation-diff-history-replay.mjs [--range "-n 2000 HEAD"]`
  (default `--all`). Results on 2026-11-12 (Bun for the tests, Electron's
  Node for the replay, a heavily loaded machine): the extended run compared
  7,846,576 results over 1,553,773 pairs in 40 minutes, plus 1,666 budgets that
  run out inside the second recursive call and the 8 MiB pairs; the replay of
  all 318 commits reachable in the checkout compared 34,130 distinct
  before-and-after pairs of file versions (43,848 file changes, 1.44 GB,
  largest 7.8 MB, 8,463 with non-ASCII text, 1,086 binary or invalid UTF-8) in
  95 minutes. No difference and no fallback in either.
  `scripts/perf/mutation-ancestry-replay.mjs` (70 overlapping rewrites through
  `applyMutationText`) writes the same report with the switch off and on, apart
  from its timing fields, with every diff answered by the core. A split point
  past the end of a text, which the core clamps as JavaScript's `slice` does,
  was never produced: the extended run's exhaustive search (all 393,617 pairs
  over `ab` to length 8 and `abc` to length 5, 16 budgets each, 6,297,872
  comparisons) stored 653,992 past-the-edge entries but returned none as a
  split, and
  the crate's `a_split_point_past_the_end_clamps_like_javascript` test covers
  the clamp directly.
- **Benchmark.** `scripts/perf/mutation-diff-benchmark.mjs` reruns R0's
  measurement on the product code: R0's diff shapes on both arms, interleaved,
  then, with `--publication`, one confined edit's `finish` with the switch off,
  on and off again (the A/A arm shows the noise), with the load average on
  every row:
  `ELECTRON_RUN_AS_NODE=1 node scripts/test-isolation-guard.mjs node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc scripts/perf/mutation-diff-benchmark.mjs --publication`
  (also under `node --expose-gc` or `bun`; `--sizes 32k,256k,1m,8m`,
  `--shapes`, `--publication-shapes`, `--runs`, `--out`). On 2026-11-12, in
  Electron's Node at load average 12 to 18 on 8 cores (read as ratios): the
  diff is 10 to 19 times faster on the 256 KiB edit shapes and 6.7 to 12.5 times on
  the 1 MiB ones (copies and rebuild included), about 4.5 times on unrelated
  texts, where the work budget caps both; no instance over 8 MiB is kept after
  a call. Publication (`finish`) measured, on that loaded machine: a ten-hunk
  edit to a 256 KiB file +20%, +34%, -7% (with 17% A/A noise) and +22% in four
  runs; two edits to a 1 MiB file +18% to +35% in four runs; a 32 KiB file
  -0.5% and +2.0% over 31 calls per arm (A/A 0.4 to 2.9%). A later rerun with 21
  calls per arm (load 36 to 59, so times are inflated) gave +50.7% for the
  ten-hunk 256 KiB edit against 11% A/A noise and +39.9% for two edits to a
  1 MiB file, and the measurement before the port, on a quieter machine, gave
  +23% and +19 to +22%: the restated bar is met.
- **Never** load a native Rust module (`.node`, `dlopen`) into the process that
  hosts the server: a fault there ends every session. Rust runs in this process
  only as WebAssembly. Never ship the crate: the packaged app excludes `.rs`,
  `Cargo.*`, `rust-toolchain.toml` and the crate folder, and
  `scripts/packaged-app.config.mjs` fails a package that holds them. Never edit
  the tracked module or provenance file by hand, and never change the switch's
  default without the owner's yes.

### JavaScript semantics in the crate (`js`, `base64`, `collate`)

Foundations for the native ledger (research file 28, package L1a). No export
of the WebAssembly module calls them, and nothing in the product uses them
yet.

- **The shipped module.** Its behaviour is unchanged; its bytes are not.
  Declaring `js` and `base64` changed how the optimiser compiled one internal
  function, so the module grew from 42,719 to 42,729 bytes (same exports,
  imports and data; one function 10 bytes longer and the code reordered).
  Evidence: the loader's tests (`lib/ledger-core.test.js`) and the text
  module's tests (`lib/session-mutation-text.test.js`,
  `lib/session-mutation-text.differential.test.js`) pass on the new module, and
  R1's 1,580 diff vectors give the same scripts. Every module added to the
  crate can move the bytes again.
- **What they are.** `js` holds `JsStr` (a string as UTF-16 code units, so lone
  surrogates survive; `Ord` is JavaScript's `<`; `to_utf8` is
  `Buffer.from(string)`, lone surrogates to `EF BF BD`; `from_utf8_lossy` is
  `buffer.toString('utf8')`), `Value` (with a distinct `Undefined`; no holes,
  which no ledger value has; no `Buffer` value, which no corpus record holds)
  and `JsObject` in V8's property order (canonical array indices `"0"` to
  `"4294967294"` first, ascending, then insertion order; `__proto__` an
  ordinary key), `parse` and `stringify` exactly as `JSON.parse` and
  `JSON.stringify` (research file 28 §4.3, with the corrections below),
  `number_to_string` (ECMAScript `Number::toString`) and `default_sort`
  (`.sort()` with no comparator). `base64` is `Buffer`'s base64 both ways,
  including Node's lenient decoding (rules in
  `native/ledger-core/src/base64.rs`). `collate` is described under "The locale
  check". `Value`'s `PartialEq` compares numbers as `f64` (`NaN != NaN`,
  `-0 == 0`): compare `stringify` output where the JavaScript compares text.
  `ParseError.position` is not V8's error position.
- **Depth, a deliberate difference from V8.** `parse` and `stringify` refuse
  values nested deeper than `js::MAX_DEPTH` (512 containers): `parse` with
  `ParseErrorKind::TooDeep`, `stringify` with `TooDeep`, and callers fail
  closed. V8 parses any depth, and its `stringify` throws at a depth that
  depends on shape, thread and version (measured on 2026-11-12: from 2,688
  levels of `{"0":...}` on Node 26's main thread, 3,634 on Electron's Node 24
  main thread and 14,524 on its worker thread, to 400,000 levels of
  `[{"a":...}]`), which cannot be reproduced. The deepest record of the
  aged-profile corpus nests 5 containers. Drop, `Clone`, `PartialEq`, `Debug`
  and `to_js_string` are iterative, so any depth is safe on a small thread
  stack or in WebAssembly (tests walk a million levels on a 64 KiB stack).
- **Number layout.** Rust's shortest formatting supplies the digits, except on
  an exact tie between two shortest candidates (`1000000000000042.25`), where
  Rust rounds up and V8 takes the even digit (`...42.2`); `number_to_string`
  detects the tie exactly and takes the even candidate.
- **Vectors.** Each of `native/ledger-core/tests/generate-{json,numbers,strings,sort,base64,collate}.mjs`
  writes a seeded file beside it (`json.tsv`, `numbers.tsv`, `strings.tsv`,
  `sort.tsv`, `base64.tsv`, `collate.tsv`) from what Node actually does, closed
  by an `end <rows>` row so that a truncated file fails, and the matching
  `native/ledger-core/tests/*.rs` checks the Rust against it in `cargo test`.
  `generate-collate.mjs` also writes `native/ledger-core/src/collate_table.rs`,
  `native/ledger-core/src/key_sample.rs` and
  `native/ledger-core/tests/ledger-key-sample.txt`. Regenerate with
  `node packages/harness-runtime/native/ledger-core/tests/generate-<name>.mjs`;
  `--check` fails unless the file is what this Node writes (the header line
  naming the runtime and its default locale is ignored).
  `scripts/build-ledger-core.test.mjs` runs that check for all six files, the
  table and the sample, so a Node or ICU whose behaviour differs fails the
  contract test. A new table or sample is a source change: rebuild the module
  afterwards. The tracked JSON set is 3,000 seeded texts plus fixed cases (the
  design asked for 50,000; the extended run below runs 500,000).
- **Extended run and corpus.**
  `node packages/harness-runtime/native/ledger-core/tests/run-extended.mjs`
  generates much larger sets (500,000 JSON texts, 1,000,000 numbers, 200,000
  collation strings, 200,000 base64 cases, `--scale` multiplies) and the record
  corpus into a scratch directory under the OS temp dir and runs
  `cargo test --release` with `LEDGER_CORE_EXTENDED_DIR` pointing at it (a
  missing file there fails); the scratch is removed unless `--keep-artifacts`.
  The corpus test is the `corpus` test target, which a plain `cargo test`
  leaves out (`test = false`) and which fails without a corpus
  (`LEDGER_CORE_CORPUS`) or with an empty one. The corpus is every record of
  the aged-profile fixture (`scripts/opencode-v2-native/aged-profile-fixture.mjs`,
  written under the test isolation preload; at least 300 records or the run
  fails): the blobs of its ledger's Git store and the files of its web data,
  each read as Node reads a record (`JSON.parse(buffer.toString('utf8'))`).
  `--corpus <dir>` (repeatable) adds every file under a directory, a Git object
  store in it read as its blobs;
  `native/ledger-core/tests/json-corpus.mjs --out <file> --dir <dir>` writes
  such a corpus file on its own. The ledger dual-run harness's stage records
  and seam messages are to be added this way when that harness lands.
- **Known engine discrepancies.**
  `native/ledger-core/tests/known-engine-discrepancies.mjs` lists the cases
  where an engine answered against ECMA-262 and the other engine. Each entry
  names the seed and row, the engine and version, the wrong answer, the
  specification's answer, and why the ledger cannot meet that input. Under the
  listed engine the row must still give exactly the listed wrong answer. It is
  then written with the specification's answer, named
  `known-engine-discrepancy:<id>:<row>`, reported as a known engine
  discrepancy, and the Rust is checked against it. If the engine agrees again,
  or answers differently, generation fails and asks for the list to be
  updated. A discrepancy that is not listed fails as any other. The one entry
  so far comes from the 500,000-text extended run under Electron's Node 24.22
  (V8 15.2), row `random-440717`. There the duplicate escaped key `"\u0015"`
  came back as `"\\"` and was not merged, while Node 26 and the same text
  parsed on its own gave the merged object. The ledger's own records cannot
  hold a duplicate key, since they are `JSON.stringify` of objects. The entry
  names the files the ledger parses without having written them: the
  confined launchers' receipts and identities, which use fixed formats; the
  launcher manifest; and a hand-written `no-execution-socket.json`, the one
  place a duplicate key can occur, whose keys are validated.

### The locale check

- **What `collate` covers.** The collation of the root locale, which English
  uses, for ASCII strings, and nothing else: `locale_compare` returns
  `NotCovered` for any other code unit. Its tables are generated under the
  pinned locale `en` (not `und`: `Intl.Collator('und')` falls back to the
  process's default locale), checked against other locales that inherit root
  unchanged, with the locale and the ICU version recorded in the headers;
  the generator ignores `LANG`. Under root, keys made of
  `collate::CODE_UNIT_ORDER_SAFE` (`-./0-9a-z`, which every key shape the
  ledger builds uses) sort the same by collation and by code unit; `A`-`Z` and
  `_` do not (`native/ledger-core/tests/collate.rs` proves the first from
  Node's weights and lists the counterexamples).
- **Why a check is needed.** The ledger sorts keys with `localeCompare` and no
  locale (`session-changes-store.js`, the pending keys of both commit paths;
  `session-mutations.js`, staged `files` documents and restore paths), so
  today's JavaScript orders them by the process's default locale. Some locales
  order the ledger's keys differently from code units (Danish and Norwegian
  put `aa` after `z`, so any hex digest or UUID holding `aa` moves; Czech and
  Slovak put `ch` after `h`; Thai orders `-`, `.` and `/` differently). The
  native ledger sorts by code unit, and the JavaScript is not changed, so the
  native ledger must not be used where the two differ.
- **The sample.** `collate::ledger_key_sample()` returns, in code-unit order,
  1,867 strings: keys of every shape the ledger builds, from seeded IDs, and
  every one- and two-character string over `CODE_UNIT_ORDER_SAFE`, which
  catches a locale that reorders two of those characters, gives two of them
  one primary weight, or contracts two of them. The same list is tracked in
  `native/ledger-core/tests/ledger-key-sample.txt`.
- **What the host check must do** (L3i, in the JavaScript host, before it
  selects the native ledger, once per host object, on the thread that would
  otherwise run the ledger worker, since that thread's default locale is the
  one the JavaScript ledger would use):
  1. Obtain the native ledger's sample (in its start-up handshake) and verify
     it is byte-for-byte the copy shipped with the host (the tracked file),
     refusing on any difference, so a binary cannot pass with an empty or
     altered sample.
  2. Sort a copy with exactly the ledger's call,
     `[...sample].sort((a, b) => a.localeCompare(b))`, with no locale argument.
  3. Use the native ledger only if that order equals the sample's order element
     for element. Otherwise use the JavaScript worker for the host's lifetime
     and journal the fallback with the resolved default locale
     (`new Intl.Collator().resolvedOptions().locale`) and the first pair out of
     order. The check is read once, like the switch: a locale change takes
     effect at the next host start, as it does for the JavaScript ledger.
  The check covers key order only. Restore rows sorted by user paths
  (`session-mutations.js` `targets.rows`) need the D-collate decision in
  addition.
- **The survey.** `native/ledger-core/tests/survey-locales.mjs` sorts the
  sample, 2,902 real-shape keys and the safe alphabet under every locale the
  runtime's ICU supports and writes `native/ledger-core/tests/locale-survey.tsv`
  (it fails if a locale passes the sample but not the keys). The tracked file
  is Electron's, since the app ships it:
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron packages/harness-runtime/native/ledger-core/tests/survey-locales.mjs [--check]`.
  Electron's ICU data has 56 locales; a full-ICU Node 26 (ICU 79.1) has 121
  and refuses 35 of them, because a locale with no data in Electron collates
  as root there. Under these default locales the native ledger is not used
  (ICU 78.2, Electron's Node 24.22): `cs`, `da`, `et`, `fil`, `hr`, `hu`, `lt`, `lv`, `nb`, `no`, `sk`, `sr-Latn`, `th`.
  `scripts/build-ledger-core.test.mjs` fails when that sentence and the survey
  disagree. Of these, the real keys sampled differ only under `da`, `nb` and
  `no`; the others fail the stricter sample.

### The codecs in the crate (`tree`, `keys`, `text`, `paths`)

Ports for the native ledger (research file 28, package L1b). As with `js`, no
export of the WebAssembly module calls them and nothing in the product uses
them. Each is a line-for-line port of today's JavaScript, which stays the
reference.

- **`tree`** is `lib/session-changes-trees.js` without its file-system half:
  `parse_tree`, `serialize_tree` (Git's order, a subtree compared as if its
  name ended in `/`), `object_header` and `object_id`, and
  `commit_tree_changes` over a `TreeStore` the caller supplies (`read_tree`,
  `write_object`). Names, modes and ids are JavaScript strings as the
  JavaScript holds them: latin1 names, and ids written as `Buffer.from(oid,
  'hex')` does (pairs of digits read from each unit's low byte, up to the
  first pair that is not one). On success the set of objects written
  equals the JavaScript's, and so does the root with one exception; their
  order does not, since the JavaScript starts the writes concurrently and
  this writes blobs first, then trees after their subtrees. The exception:
  two entries new to one directory (not in the tree being rewritten), of
  the same kind, whose names differ as strings but have the same latin1
  bytes (a code unit above U+00FF: `Ā` and `\ud800` are both byte `00`).
  `serializeTree`'s stable sort keeps their insertion order, which in the
  JavaScript is the order their branches finish, so its root depends on
  timing; the Rust adds them in change order, one of the JavaScript's
  possible roots but not always its undelayed one. Only `importPrefix` can
  stage such names, by copying names that `git ls-tree` lists (decoded as
  UTF-8) from a ledger tree; `set`, `remove` and the lists take `validKey`
  names (ASCII), and the product imports only the ledger's own `runs/` and
  `bases/` trees, so a ledger the product wrote holds none. On failure this
  stops at the first error, while the JavaScript's other branches keep
  writing unreferenced objects. A conflict among one directory's children
  (409) is reported before any of its subtrees is read, so it wins over an
  unreadable subtree beside it (503), as the JavaScript finds it
  synchronously. Timing-dependent in the JavaScript, and fixed here: a
  conflict inside one subtree against an unreadable tree inside another,
  and a failing blob write against a conflict (the Rust reports the
  write's error). For these and the names above the vectors record every
  outcome the JavaScript gives under several schedules (`{ any: [...] }`),
  one of which the Rust must give. An odd `oid_length` (the callers pass 40
  or 64) makes the JavaScript's width a fraction; the Rust rounds it down.
- **`keys`** is the pure part of `lib/session-changes-store.js`: `valid_key`
  and the other id and token checks (`at`, `ref`, lease tokens,
  `importPrefix`'s source, `setListObjects`' ids), page names, `pages_of`
  (at most 128 values and 256 KiB of the values' UTF-8 JSON per page, a
  larger value on a page of its own; `undefined` fails as `Buffer.byteLength`
  throws, values past `js::MAX_DEPTH` fail closed), the 512 KiB record bound,
  and `entity_key` (`key()` of `lib/session-mutations.js`).
- **`paths`** is `safeChangePath` (`lib/session-changes-snapshot.js`), POSIX only.
- **`text`** is `lib/session-mutation-text.js` apart from the diff
  (`apply_mutation_text` with the hunk budget and coalescing,
  `initial_mutation_runs`, `visible_mutation_runs`, `mutation_text`, run rows
  in format 2, `minimize_mutation_ancestry`) and the run-row code of
  `lib/session-mutations.js` (format 1 rows, `runsFor` as `load_document`,
  the marker and fence predicates, the choice `saveRuns` makes as
  `save_plan`). A `Run` keeps the JavaScript object's property order and any
  other properties a stored row carries (`Shape`): a decoded run holds `text`
  last, a format 1 run keeps its stale `bytes`, and the rows written again
  carry them. The typed fields cover what the ledger writes (`id` a string,
  `start` an integer, `owner` `null` or a string, `deletedBy` strings,
  `replaces` exactly `{ id, start, length }`). The model's numbers are
  integers of magnitude at most 2^62 (a safe integer where the JavaScript
  checks for one), and every sum or difference of them rounds as the
  JavaScript's doubles do: a continuation of a run at 2^53 - 1 with 2 bytes
  starts at 2^53, and range ends past 2^53 round the same way. Rows the
  JavaScript accepts outside that model (an `owner` that is a number, a
  range with another property, a format 1 row without `start`, `bytes` that
  `Buffer.from` takes as an array, also `{ length: 1e10 }`, for which the
  JavaScript tries to allocate 10 GB) are refused as `Unsupported`, after
  every check the JavaScript makes has passed, so that the JavaScript's own
  refusals (`invalid`, `TypeError`, also from a marker whose `baseline`
  has its own `toString`, which `RegExp.prototype.test` cannot convert)
  come out the same and a caller can fail closed on the rest. The native
  layer must surface `Unsupported` like `invalid_change_record`: it locks
  one document, not the ledger. One further difference: the JavaScript's
  recursive `visit` in `applyMutationText` can overflow its stack on a very
  deep ancestry chain, which the Rust's explicit stack does not.
  `load_document`'s `bytes_for` must make `bytesFor`'s checks (a string of
  64 hex digits whose object exists and hashes to it).
- **Yielding.** `minimize_mutation_ancestry` is an `async fn` that awaits the
  caller's `AncestryPause::pause(site)` exactly where the JavaScript awaits
  `pause()` (every 256 units of work, at its six call sites, in order);
  `SlicedPause` is the JavaScript's rule (yield once `sliceMs` have passed on
  a clock) and `minimize_mutation_ancestry_now` runs it with a hook that never
  waits. The two recursive walks of `applyMutationText` run on explicit
  stacks in the JavaScript's order.
- **Hashing** is the caller's (`tree::Digest`): the crate implements no hash.
  The tests use FNV-1a only as a fingerprint and, for commits, as a stand-in
  object id (`testObjectId` in `native/ledger-core/tests/codec-tools.mjs`):
  `commitTreeChanges` takes whatever ids its store returns.
- **Vectors.** `native/ledger-core/tests/generate-trees.mjs` writes
  `trees.tsv` (1,000 seeded trees per id width, whose entries
  `native/ledger-core/tests/support/mod.rs` draws again from the seed, with Git's order and id;
  damaged trees for `parseTree`; JavaScript strings no Git tree holds for
  `serializeTree`) and `commits.tsv` (500 cases of two commits over an
  in-memory store). When writing, `git mktree --missing` builds every seeded
  tree and the generator refuses unless `serializeTree` gives Git's bytes and
  `objectID` Git's id (`--no-git` skips that; the content is the same).
  `generate-keys.mjs` writes `keys.tsv`; `generate-text.mjs` writes `text.tsv`
  (300 seeded edit histories with undo, redo, overlapping hunks, small hunk
  budgets, multi-byte and invalid UTF-8; texts of 32 KiB and more; seeded
  ancestry graphs with a fake clock, whose pause sites are read from the
  JavaScript's stack; hand-made rows and pages; runs whose starts and range
  ends pass 2^53). `commits.tsv` ends with fixed cases: a sibling conflict
  beside an unreadable subtree, and new names with the same latin1 bytes,
  each under 64 schedules. The closures of
  `session-mutations.js` that are not exported (`formatOneRows`, `runsFor`,
  `saveRuns`, the predicates, `key`) and `validKey` and `pagesOf` are
  evaluated from their own source text (`codec-tools.mjs`
  `declarationSource`), so the vectors are today's code. `cargo test`
  (`native/ledger-core/tests/trees.rs`, `keys.rs`, `text.rs`) checks the Rust against them;
  `scripts/build-ledger-core.test.mjs` fails when they are not what today's
  JavaScript writes (without Git). Regenerate with
  `node packages/harness-runtime/native/ledger-core/tests/generate-<trees|keys|text>.mjs`
  (`--check` compares). The extended run (`run-extended.mjs`) adds 20,000
  trees per width checked against `git mktree` with the Rust's own bytes
  hashed by `git hash-object` (`LEDGER_CORE_GIT`), 5,000 commit cases,
  20,000 key cases and 3,000 histories.

## Native ledger I/O

The first package of the native ledger (research file 28, plan package L2):
the file-system primitives, the cross-process lock and the atomic writes of
`lib/atomic-file.js`, in Rust. **Nothing in the product calls it**: there is
no switch, no binary in the package and no change to any JavaScript.

- **Where.** `native/ledger/` is a cargo workspace (tracked `Cargo.lock`) with
  one library crate, `ledger-io`. It has no toolchain file of its own: the
  build script selects ledger-core's pin through `RUSTUP_TOOLCHAIN`. Its
  dependencies are `libc` (exactly pinned, MIT or Apache-2.0),
  `../ledger-core` by path (JavaScript strings, numbers and JSON for the lock
  file's bytes) and, for the object database below, `sha1`, `sha2` and
  `miniz_oxide` (exactly pinned, default features off; see "The object
  database").
  - `ledger-io/src/fs.rs` reproduces the primitives as the libuv inside
    Electron's Node makes them (`process.versions.uv`, 1.52.1 when this was
    written), and holds every `unsafe` block of the workspace. It covers bigint
    stamps (`dev:ino:size:mtimeNs:ctimeNs[:mode]`, signed 64-bit as Node's
    `BigInt64Array` holds them), `mtimeMs`, the sync chain, `copyfile`, `link`,
    `rename`, `unlink`, `chmod`, exclusive opens with a mode, Node's recursive
    `mkdir` (and the first directory it made), `utimes`, `realpath`,
    `statfs`, directory listing (with every dirent type) and directory sync;
    for the `node` module also `access`, `symlink`, `readlink`, reads and
    writes at a position or the descriptor's offset, `fchmod`, Node's open
    flag strings and the `fs.constants` values the sites pass, and
    `atomic::rm` with `recursive` and `force`.
  - Errors are Node's: libuv's names and texts (`uv_err_name`,
    `uv_strerror`, the table `util.getSystemErrorMap()` prints) in Node's
    layout (`<code>: <text>, <syscall> '<path>' -> '<dest>'`), with `errno`
    negated as Node's is, `syscall`, `path` and `dest`. An errno libuv does
    not know (macOS `EOPNOTSUPP` and `ENODATA`) is `Unknown system error -<n>`
    in both. A recursive `mkdir` reports every failure as `mkdir` of the path
    it was making, a failed `stat` included.
  - Limits a caller must know: `utimes` takes seconds at libuv's level, so a
    caller applies Node's `toUnixTimestamp` first (a negative time becomes the
    current time there); `read_file` reads to the end without Node's size
    check (`ERR_FS_FILE_TOO_LARGE` above 2 GiB), which a reader of large files
    must add; `realpath` and directory names decode ill-formed UTF-8 lossily,
    as Node's `'utf8'` does.
  - `ledger-io/src/atomic.rs` holds `write_file_atomic`,
    `with_cross_process_file_lock` and `cleanup_stale_atomic_files`: the same
    calls in the same order, the same names, modes, retry gaps, timeouts,
    codes and lock bytes. Everything the JavaScript lets a caller inject is
    injectable (`Fs`, `Env`: clock, wait, liveness, token, identifier, signal,
    progress). The functions block; a caller that needs concurrency runs them
    on a blocking thread.
  - `ledger-io/src/path.rs` ports the `path.posix` functions they use.
  - `ledger-io/src/bin/atomic-probe.rs` is a test-only binary, built only with
    the `probe` feature.
- **What libuv does, measured.** These were checked with a test-only
  interposer (`scripts/ledger-native/trace-interpose.c`, macOS
  `DYLD_INSERT_LIBRARIES` on the unsigned development Electron):
  - **Sync on macOS** is `fcntl(F_FULLFSYNC)`; if that does not return 0,
    `fcntl(F_BARRIERFSYNC)` (85); if that does not either, `fsync`. The whole
    chain is retried on `EINTR`. Each fallback was forced and observed in both
    implementations. On Linux it is `fsync`.
  - **`copyfile` has no `copyfile(3)` and no clone on macOS** in this libuv.
    It opens, `fstat`s, opens the destination with the source's mode,
    truncates, `futimens`, `fchown`, `fchmod`, then copies the bytes:
    `sendfile` refuses a file target, so it falls back to 8 KiB
    `pread`/`write` rounds. `COPYFILE_FICLONE` is ignored there and
    `COPYFILE_FICLONE_FORCE` fails with `ENOSYS`. The bytes are written after
    the times are set, so a non-empty copy does not keep the source's
    modification time (measured on Electron's Node). On Linux, `FICLONE`,
    `copy_file_range` and `sendfile` are tried first.
  - **Writes** go out in chunks of at most 512 KiB (`kWriteFileMaxChunkSize`).
  - **`rm(path, { force: true })`** is `lstat`, `lstat`, `unlink`.
  - **Recursive `mkdir`** is Node's own `MKDirpAsync`: `mkdir`; on `ENOENT`
    the parent first; `EACCES`, `ENOSPC`, `ENOTDIR` and `EPERM` end it; any
    other error (`EEXIST` above all) `stat`s the path.
- **Build and verify** with `node scripts/build-ledger-native.mjs [--verify]`.
  Every cargo command runs with `--locked` on a copy of the workspace and of
  ledger-core under the OS temp dir, with a private `CARGO_HOME` and target
  directory there (removed afterwards; `--keep-artifacts` keeps them). The
  dependencies are fetched once per run with `cargo fetch --locked`, which
  needs the network, unless the developer's own cargo cache (`CARGO_HOME`,
  else `~/.cargo`) holds every locked crates.io crate and its index entry:
  then they are copied into the private `CARGO_HOME` (each `.crate` checked
  against `Cargo.lock`'s checksum) and the fetch runs `--offline` too, and
  goes to the network only if that fails. A cold runner finds nothing there
  and fetches as before. Everything after the fetch runs `--offline` (the
  RustSec check, when `cargo-deny` is installed, still fetches its advisory
  database). `--verify` runs
  `cargo fmt --check`, `cargo clippy -D warnings` (every target and feature),
  `cargo test`, then `cargo check` and `cargo clippy -D warnings` for
  `x86_64-unknown-linux-gnu` when the pinned toolchain has that target (the
  only way to lint the Linux-only code on a Mac; it prints one line saying so
  when the target is missing, and on x86_64 Linux the host clippy is that
  lint), then the differential tests
  (`scripts/ledger-native/atomic-differential.mjs`) against the probe it
  built. It passes the probe's path in `LEDGER_NATIVE_PROBE`; the tests build
  one themselves when that is unset. The system-call tests skip themselves
  off macOS, with the reason in the output.
  - **The JavaScript reference** is the Node inside Electron, the ledger's
    runtime: the binary the installed `electron` package names, started with
    `ELECTRON_RUN_AS_NODE=1` (`scripts/ledger-native/reference-runtime.mjs`).
    Only where that binary is absent does the JavaScript run on the Node that
    runs the tests. The run prints which runtime it used and its libuv.
  - **Inputs.** `scripts/ledger-native/inputs.mjs` lists what reruns the
    verify: the workspace, ledger-core's crate, `lib/atomic-file.js` and every
    local module the build script and the differential tests load (the
    isolation preload included). Fast `validate` reads that list, and both CI
    steps print it as their pull-request filter. The build script's contract
    test follows the imports and fails when one is missing from the list.
  - **CI** runs the verify on every push and on pull requests that change an
    input: in the `static` job on Ubuntu (Linux code, the JavaScript on CI's
    Electron or Node), and in the `native-1` macOS lane after its suites
    (the macOS code, the sync chain and the system-call traces). The macOS
    step adds a Rust install and the verify, a few minutes, only when an input
    changed.
- **The differential tests** compare the JavaScript (`lib/atomic-file.js`)
  with the Rust:
  - The shared specification (`scripts/ledger-native/atomic-spec.mjs`)
    restates as data the 10 cases of `lib/atomic-file.test.js` that concern
    these three functions. It lists the 5 it leaves out: Windows,
    `writeFileAtomicSync`, `readJsonGuarded`. It adds 31 edge cases, among
    them the 24-hour cutoff at its exact boundary, names that only look like
    temporaries, `ENOTDIR` for a file or a dangling link in the middle of a
    path, `ERR_FS_EISDIR`, a lock naming a process this user may not signal
    (`EPERM`, alive), a lock file of ill-formed UTF-8, and a dead owner
    rewritten with the same token before the re-read. Results, errors (code,
    errno, syscall, path, dest and message), file-system call traces,
    progress, observations and the tree after every run must be equal, and
    the probe's tree must be the one Node reads.
  - Lock bytes are checked against the documented format.
  - JavaScript and Rust processes contend on one counter: 4 of each, 25
    cycles each, 200 in all (the design asked for 2,000; the tenth keeps the
    gate short).
  - A SIGKILLed holder of each language is reclaimed by the other, and a live
    holder is never stolen.
  - On macOS, system-call sequences are compared: `writeFileAtomic`, lock
    publication and the sync chain with each fallback forced; a forced
    `fsync` failure must fail both writes alike and leave no temporary.
    `copyfile` is compared by outcome, mode (one the umask would clip), times,
    bytes and its `EEXIST` failure.
  - Stamps are compared with the reference Node's bigint stats, and the
    system error table with its `util.getSystemErrorMap()`.
  - `scripts/build-ledger-native.test.mjs`, which needs no Rust, runs the
    specification against the JavaScript alone on every lane, and checks the
    workspace's files, lockfile, probe and `unsafe` placement.
- **Known defects carried over.** The Rust reproduces these defects of
  today's JavaScript, because the lock is shared with it; any fix belongs to
  both at once (an owner decision):
  - A dangling symbolic link at the lock path makes the lock spin forever:
    `link` gives `EEXIST`, reading the lock gives `ENOENT`, and that retries
    at once, before the timeout is checked, so it never waits and never
    times out. No test reproduces it, because it would hang.
  - A lock is left behind if the temporary cannot be removed after a
    successful link (the error skips the release), and a failed release turns
    a callback that finished into a failure.
  - A lock naming a pid above 2^31 - 1 is reclaimed at once (`process.kill`
    refuses it, which counts as dead).
  - libuv's `copyfile` loops forever if the source shrinks during the copy.
- **Packaging.** Nothing ships: `packages/electron/package.json` excludes
  `native/ledger`, and the packaged-app check forbids it.
- **The native acceptance digest** hashes this package's `.rs` files, so every
  workspace edit changes it, as for ledger-core.

### The object database

`ledger-io/src/git/odb/` (plan package L3a) reads the ledger repository
in-process and writes its loose objects as `lib/session-changes-trees.js`
writes them. Nothing in the product calls it yet; `update-ref`, `init`,
`repack`, `prune`, `count-objects` and every Git command on a user's project
keep spawning Git (research file 28, section 5).

- **What it reads.** Loose objects (zlib, the `<type> <size>\0` header checked
  as Git's `parse_loose_header` checks it: a known type, no leading zeros, the
  stream ending at the declared size with nothing after it); packs of
  version 2 with indexes of version 2 (fan-out, binary search, the 64-bit
  offset table, OFS and REF deltas, chains followed without recursion, every
  base looked up only in its delta's own pack, as Git resolves it: a REF base
  elsewhere, loose or in another pack, asks Git (`corrupt_pack`), since Git
  reports such an object missing), sha1 and sha256
  repositories. Type and size come from headers alone: a loose header, a pack
  entry header, a delta's own header and its chain's entry headers. An object
  not found makes it list `objects/pack` again before it says "absent", and
  packs already open stay readable after `repack` deletes them.
- **Refs.** A loose ref file holding exactly one lowercase id (and a newline),
  otherwise `packed-refs` (a directory at the ref's path reads past to it, as
  Git does); `for-each-ref` with and without a plain pattern.
- **Names and listings.** `<id>` and `<tree>:<path>` as `cat-file --batch`
  resolves them (`<id> submodule` for a gitlink whose commit is absent), and
  the rows of `ls-tree -r -l -z <tree> [-- <prefix>/]` in Git's order: the
  JavaScript's `listTreeRows` and paged `listDirectPrefix`, with its rule
  that a tree not strictly in Git's order, or repeating a name, is not
  answered here. It is stricter in one place: any mode outside Git's five
  (`40000`, `100644`, `100755`, `120000`, `160000`) in a tree it reads asks
  Git.
- **Fail closed.** Every answer is found, absent (only when every object
  source was read and understood) or "ask Git" with a reason
  (`odb::Reason`): `repository_format` (not a directory, no `objects`, a
  linked worktree's `commondir`, a format version other than 0 or 1, a
  configuration it cannot parse), `extension` (any `extensions.*` but
  `objectFormat` sha1 or sha256 in version 1: reftable, partial clone, a
  compatibility format, anything in version 0), `alternates`, `promisor`,
  `replace_refs` (checked on every read; with `OdbOptions::snapshot`, the
  persistent reader's, replace refs and the alternates file are read once,
  at the first name that is an id, as one long-lived Git reads them),
  `multi_pack_index`,
  `unindexed_pack`, `unstable_packs`, `pack_version`, `index_version`
  (version 1 included), `corrupt_index`, `corrupt_pack`, `corrupt_object`,
  `too_large`, `delta_depth`, `delta_cycle`, `delta_budget`, `id_mismatch`
  (when ids are checked), `io`, `ref_format`, `ref_name`, `tree_order`,
  `tree_mode`, `tree_missing`, `tree_format`, `tree_limit`, `name_syntax` and
  `peel` (`<commit>:<path>`). The bounds (`OdbOptions`) default to 256 MiB per
  object, 10,000 deltas per chain, 1 GiB produced per chain, 4,096 tree levels
  and ten million rows; output buffers are never larger than a declared size
  plus one byte.
- **Not seen by the reader.** Inputs that change what Git answers but that
  the reader does not read: the environment variables `GIT_REPLACE_REF_BASE`
  and `GIT_NO_REPLACE_OBJECTS`, a `remote.*.promisor` set in global or
  included configuration, and `safe.directory` (where Git refuses a
  repository another user owns, the reader answers). None can make it say
  "absent" for a private ledger the product created; they are out of scope
  here, and the caller that replaces a Git spawn with the reader decides
  whether to clear or check them, as `gitEnvironment` in
  `lib/session-changes-git.js` clears others today.
- **Errors.** The reader returns `odb::AskGit` with its `Reason`, and the
  writer returns the system error with its Node errno code (`ENOENT`,
  `EACCES`, …), as `writeLooseObject` throws it. The Git runner (below, "The
  Git runner and the store") hands every "ask Git" name to the reader's own
  `cat-file`, so the ledger's codes are Git's own answers, classified as the
  JavaScript's reader classifies them.
- **Writes.** `write_loose_object` is `writeLooseObject` call for call:
  freshen with `utimes`, else up to five attempts of recursive `mkdir`,
  `stat`, `tmp_obj_<uuid>` written `wx` with mode 0o444, `link` (`EEXIST`
  is success), and always `unlink` of the temporary; `ENOENT`, or `EINVAL`
  when the fan-out directory was removed or replaced, retries. Never synced.
  The zlib bytes are `miniz_oxide` at level 6 and differ from Node's zlib for
  most objects; **identity is the object id**, and the tests compare objects
  by content and id, never as files.
- **Dependencies.** `sha1` 0.11.0 and `sha2` 0.11.1 (MIT or Apache-2.0; with
  `digest`, `block-buffer`, `crypto-common`, `hybrid-array`, `typenum`,
  `cfg-if`, `cpufeatures`, all MIT or Apache-2.0), `miniz_oxide` 0.9.1 (MIT,
  Zlib or Apache-2.0; with `adler2`, 0BSD, MIT or Apache-2.0). The workspace
  builds these three optimized in its development profile, so the debug probe
  inflates and hashes at release speed; release builds are unaffected.
- **Tests.** Unit tests in `git/odb/tests.rs` (handcrafted packs for delta
  cycles, huge declared sizes, external bases and large offsets; seeded
  fuzzing of the delta, index, pack, tree and configuration parsers; the
  writer's call sequence). The differential tests,
  `scripts/ledger-native/odb-differential.mjs`, drive the test-only
  `odb-probe` with Git as the oracle ([testing](../../docs/TESTING.md#native-ledger-module-tests)).
  The extended run, `node scripts/build-ledger-native.mjs --verify --extended`,
  adds the full fuzz rounds and `scripts/ledger-native/odb-real-ledgers.mjs`,
  which reads the aged-profile corpus and every ledger the dual-run scenarios
  write; `scripts/ledger-native/odb-planted.mjs` checks that twenty-one
  planted bugs are each caught.

## Native ledger process

The second crate of the native ledger workspace (research file 28, plan
package L3d), `native/ledger/ledger-native`, builds the binary
`devryan-ledger`: the ledger worker's stdio protocol, its execution context
and its I/O pool, with **no ledger method implemented** (the Git runner and
the store are ported, "The Git runner and the store" below, and no method
calls them yet). Nothing starts it:
there is no switch, the binary is built only in the verify's scratch, and
`native/ledger` is excluded from packaging (above).

- **What it is.** One process speaking the protocol of
  `lib/session-mutation-worker.js` over stdin and stdout (stderr is free
  text), with the line codec of `scripts/ledger-dual-run/dual-run-codec.mjs`
  and the markers of `lib/session-mutation-wire.js` (`src/codec.rs`,
  `src/wire.rs`, `src/proto.rs`). The first message is
  `init {protocol?, workerData}`; a `protocol` other than 1 is refused. It
  answers `ready {methods, protocol: 1, build}`, where `methods` is the
  product runtime's method list (`src/methods.rs`, generated from the
  product by `scripts/ledger-native/generate-methods.mjs` and checked by the
  build script's contract test) and `build` is `unported+<source digest>`
  (`unported+hooks+<source digest>` for a test-hooks build, so a host can
  refuse either by identity).
  Every method fails with `mutation_method_unimplemented`, so this build
  cannot serve the product. The options in `workerData` are checked as
  `createSessionMutationRuntime` checks them (an absolute `directory`,
  positive integer batches, ordered complexity limits; a `stallClock` that
  injects a clock or timer), and a refusal exits 70 before `ready`, as the
  worker's failed import does.
- **Calls.** Each call starts at once as its own task and runs in place up
  to its first suspension, as the worker's handler does; there is no queue,
  cap, throttle or delay. Inputs, callbacks (`callback`, `callback-result`),
  observers (`observe`, observer callbacks with their cause), aborts, result
  streams (`pull`, `chunk`, `stream-return`), reports, summary steps and
  progress have the worker's shapes and key order. Natively an error carries
  no `stack` (the host keeps its own). Tags for `Map`, `Set`, `Date` and
  `BigInt` are refused with `mutation_wire_type`; the JavaScript would take
  them, and no recording ever saw one.
- **Execution context** (`src/ctx.rs`, `src/stall.rs`, `src/iopool.rs`):
  `runInRemoteExecutionContext` and what the ledger calls of
  `lib/execution-admission.js` (deadline, cancellation, reports, the meter
  and the meters it follows, summaries of at most 32 steps, `executionPhase`,
  `quietExecutionPhase`, `timedExecutionStep`, `withExecutionMeter`,
  `withoutExecutionDeadline`, `waitForExecutionQueue`, `executionCleanup`),
  the stall clock of `lib/host-stall-clock.js` (a shared 250 ms ticker
  started on first use, 1 s stalls, `DEVRYAN_STALL_AWARE_DEADLINES`), and the
  per-root pool of `lib/execution-io-pool.js` (8, or
  `DEVRYAN_EXECUTION_IO_CAP` from 1 to 64, read per use). The context is
  passed explicitly instead of through `AsyncLocalStorage`. Timers are the
  event loop's (below); the slow-phase timer, the cleanup and progress
  tickers and the stall clock's ticker are unrefed, as in the JavaScript.
- **JavaScript's job order** (`src/js.rs`, `src/host.rs`; the contract
  every later ledger package runs on). The process replaces a worker thread
  with no JavaScript to fall back to, and the identifiers a call draws and
  the order of what it reports reach disk and the host, which the dual-run
  harness compares exactly. So it reproduces JavaScript's job order exactly
  for everything the language and Node's loop define; only the arrival
  order of independent outside events (input lines, I/O completions,
  signals) is left free, as JavaScript leaves it.
  - *Jobs* (`src/js.rs`, no ledger type in it). A promise is
    single-threaded: pending with its reactions in registration order, or
    settled; settling queues the reactions as jobs, reacting to a settled
    promise queues the job at once. Resolving with a plain value fulfils at
    once; resolving with a promise takes the specification's two jobs more
    (the thenable job, then the reaction). One microtask queue and Node's
    tick queue, drained at every checkpoint as `processTicksAndRejections`
    drains them: every tick, then every microtask, again until both are
    empty, then the unhandled rejections. An async function call
    (`js::async_fn`) runs its body at once up to its first `await`; what it
    returns resolves its promise by those steps (`return promise` is two
    jobs later than `return await promise`). `await` (`promise.await`,
    `js::value(v).await`) always suspends: one job for a settled promise or
    a plain value. `then`, `catch`, `finally`, `Promise.all`, `allSettled`,
    `race`, `resolve`, `reject`, `new Promise`, `queueMicrotask` and
    `process.nextTick` follow the specification's and Node's steps.
  - *Unhandled rejections.* As the worker: reported, not fatal. A rejection
    nothing handled by the end of a checkpoint's ticks and microtasks is
    reported (`observe onDiagnostic {phase: 'ledger_worker', state:
    'failed', code}`, when the host has that observer) in the async context
    of the code that rejected, so its `cause` is that call's id.
  - *Units of work.* One inbound message (a stdin line, `init` included);
    one timer callback; one immediate; one completion of blocking work
    (`host::blocking`, or `host::submit` whose callback runs in the unit,
    on four threads as libuv's pool); one delivery of a long-lived source
    (`host::open_source`: a child process's output reader, its exit
    waiter, a write in flight), run in the frame the source was opened in.
    `js::checkpoint_epoch()` counts the checkpoints that have ended, so
    everything one unit and its checkpoint run sees one value. Another thread reaches the loop only by posting a unit
    to its inbox; a promise, a task or a job never leaves the loop's
    thread. After each unit comes the checkpoint; only then does the next
    unit start. Two lines of one write are two units, so a callback's
    answer and an abort right behind it end the call as the worker ends it.
  - *Iterations.* libuv's (`EventLoop::iterate`): poll (inbound units, at
    most the larger of those queued and 1,000 per pass, as a `MessagePort`
    delivers them; a unit that arrives during the pass is part of it),
    check (`processImmediate`: the immediates queued before the phase),
    timers (`processTimers`), with a checkpoint between any two callbacks
    of a phase and after it.
  - *Timers.* Node's `lib/internal/timers.js` and `lib/timers.js`, ported
    by object identity with synchronous callbacks: the delay coerced
    (`after *= 1`; outside [1, 2^31 - 1], NaN included, it is 1 ms) and
    truncated for its list (2.5 ms is in the 2 ms list); timers of one
    duration in one list in creation order; lists by expiry, then list id;
    a list visited before its head is due re-arms with a new id; a timer
    starts at the loop time read when it is created, an interval re-arms
    from the time read just before its callback; a timer the checkpoint
    between two timers cleared is skipped, the next one still runs;
    clearing the last timer of a list deletes the list only for a refed
    timer. The loop time is a monotonic millisecond clock; `Date.now()` is
    the epoch clock.
  - *Iteration* (`src/agen.rs`, no ledger type in it): async generators,
    `for await`, `yield*` and the async-from-sync iterator by ECMA-262's
    steps. A generator's call runs nothing; its body starts inside the
    first `next()`, synchronously, in the caller's frame. `next`, `return`
    and `throw` made before the first settles are queued and answered in
    order (AsyncGeneratorEnqueue, Resume, CompleteStep, DrainQueue,
    AwaitReturn). `yield v` awaits `v` first; a return received at a
    `yield` awaits its value, then passes through the body's `finally`
    code (where a `yield` may stand); `return v` awaits `v`. `return(v)` at
    the start or after the end awaits `v` once; `throw(e)` at the start
    completes the generator with a rejection. `yield*` does not await the
    inner values again; a return it forwards to an inner iterator that has
    `return` is not awaited again either (one without awaits it). A return
    received at a `yield*` awaits its value first; when that value
    rejects, V8 (both Nodes) sends the reason to the inner iterator as
    `next(reason)` and goes on delegating, where the specification's text
    makes it a throw: the layer follows V8. `for
    await` is one `Await(next())` per iteration; `break`, `return` and a
    throw close the iterator (AsyncIteratorClose: `return()` called and
    awaited; its failure replaces a `break` or `return`, never a throw); a
    rejected `next()` closes nothing. Over an array or another sync
    iterable it goes through the async-from-sync iterator: one more await
    per value (two jobs a value and at the end), a rejected value closes
    the sync iterator, and `throw` on one without `throw` closes it and
    throws a `TypeError`. A generator suspended at a `yield` and dropped is
    freed without running its `finally` (as JavaScript collects it), a
    chain of any depth without recursion; so is one dropped while it
    executes, with the promise its body awaits (the body's task is held by
    that await, not by the generator). A request made with the stack
    budget spent is rejected with a `RangeError`. Thenables are not built:
    a `Resolution` is a value or a promise, and no ledger site yields,
    returns or awaits a thenable (V8 keeps the frame after a yielded
    thenable and takes two jobs more to resolve one).
    *Electron's V8 frame rule:* after `yield v` with a request already
    queued, the code the body runs in that job, and every await it makes
    until it next suspends with an empty queue, run in the **empty** async
    context frame exactly when `v` is a primitive (`bigint` included) or
    an ordinary object whose prototype is `Object.prototype`, with no own
    `then` and no accessor property, held by V8 in fast mode: Electron's
    V8 awaits such a value on a path whose job carries no frame. Every
    other value keeps the caller's frame: an array, a `Buffer` or typed
    array, an `Error`, a function, a class instance, a `Map`, `Set` or
    `Date`, a generator object, a boxed primitive, `Object.create(null)`,
    a promise, a thenable; so does a plain object V8 holds in dictionary
    mode (128 or more literal or `JSON.parse` properties, 20 or more added
    by computed keys, a deleted property), which the layer cannot tell: it
    treats a `W::Object` as fast. Node 26's V8 keeps the frame for every
    value; every other await of a generator keeps it on both. The layer
    decides by value (`agen::YieldFrame`; for `W`, `Undefined`, `Null`,
    `Bool`, `Number`, `String`, a bigint and an `Object` without a `then`
    key lose the frame; `Bytes`, `Array`, `Function`, `Stream`, `Error`, a
    date, a map and a set keep it), and the job differential pins each
    kind. A port that yields a primitive or a plain object while a request
    is queued, and reads an `AsyncLocalStorage` before its next await,
    sees no store, as the worker would; one that yields an array
    (`pagesOf`) or a `Buffer` (`byteStream`, a stream's chunks) keeps the
    caller's frame. No ledger generator is pulled with a request queued
    today (each is pulled by `for await`, `yield*` or the host's
    serialised pulls): a port must not pull one ahead.
  - *Emitters* (`src/emitter.rs`): Node 24.22's `events.js` as ports reach
    it: `on`, `prependListener`, `once`, `prependOnceListener`,
    `removeListener`, `removeAllListeners`, `emit`, `listenerCount`.
    Listeners run inside `emit`, in its caller's job and frame, in
    registration order, over the list as `emit` found it (one added during
    it does not run, one removed during it still runs: the opposite of the
    abort signal's dispatch); a throw leaves `emit` at once; `once` removes
    itself before its call and runs at most once; `removeListener` removes
    the last match (a listener or a `once` wrapper of it); `emit('error')`
    with no listener throws (`ERR_UNHANDLED_ERROR` with the value as
    `context`, or the value itself when it is an `Error`, by the emitter's
    maker). Not built, because no site uses them: the `newListener` and
    `removeListener` events, `errorMonitor`, `captureRejections`,
    `listeners`, `rawListeners`, `eventNames`, `events.once`/`events.on`,
    and the max-listeners warning (a tick that only writes to stderr). The
    ledger itself calls only `on` (and `once` on a path the worker never
    reaches); streams and child processes (O2d, O2e) are its users.
  - *Node's library on the loop* (`src/node/`; design file 32, packages
    O2f and O2d, in the reduced form research file 33 decided): what the
    worker calls of `fs.promises`, its `FileHandle`, `fs.createReadStream`
    and `promisify(zlib.deflate)`, over `ledger-io`'s system calls. What the
    language defines stays exact (above); of what Node's library decides on
    top of the loop only three rules are kept:
    1. *A completion never settles in the checkpoint that started it.*
       Every call that does I/O runs its system calls on the pool
       (`host::submit`, libuv's four threads) and settles in a unit of its
       own, so the awaiting code resumes in a later loop turn, never inline.
       The guard is where no call can go around it: `node::submit`, the
       module's only way to the pool (the porting lint refuses
       `host::submit` elsewhere in `src/node/`), records
       `js::checkpoint_epoch()` (how many checkpoints have ended) where the
       work is submitted and panics, in every build, when it finds the same
       value where the result is delivered; `io`, the read stream's open,
       reads and close and a handle's deferred close all go through it.
       Every `fs.promises` call and `FileHandle` method also panics when its
       promise is already settled as it returns, and a method's completion
       checks the epoch again. A call Node answers without I/O settles as
       Node's does, in its own checkpoint, on an explicit path: a read or
       write of no bytes, an operation on a closed `FileHandle` (`EBADF`,
       `file closed`), a `close` of a handle already closed or whose close
       is under way (at once, as 24.22's `kFd === -1` does; only a close
       deferred behind operations in flight gives its pending promise to a
       second call), a path with a NUL byte (`ERR_INVALID_ARG_VALUE`, with
       `inspect`'s quoting and its 128-character cut), a `utimes` time that
       is not finite (`ERR_INVALID_ARG_TYPE`). A read stream's descriptor
       is never closed while its `read(2)` is in flight (asserted where it
       closes), and a pool job that panics panics again on the loop thread,
       so its promise is never left unsettled.
    2. *The events of one source keep their order*: a read stream's `open`,
       `ready`, its values in read order, then `end` or `error`, then
       `close`, and nothing after; a `for await` over it ends after the
       `close` (its end-of-stream callback waits for it, as Node 24.22's
       iterator does).
    3. *The receipt's read cut*: `_read(highWaterMark)` reads that many
       bytes at the descriptor's offset (short only at the end of a regular
       file), one read in flight, the next asked for while fewer than
       `highWaterMark` bytes are buffered; `for await` takes all that is
       buffered (24.22's `read()` in paused mode, one read for a regular
       file that does not change). `session-mutations.js`'s receipt byte
       stream (128 KiB) hands each read to the host as one message, so its
       cut is proven byte for byte; elsewhere chunk boundaries are free.

    Free (research file 33): how many jobs and loop round trips Node spends
    inside a call. A composite call (`readFile`, `writeFile`, `appendFile`,
    `rm`, a recursive `mkdir`, `readdir` with types) is one piece of pool
    work and one unit here (`readFile` is four round trips in 24.22), so its
    continuation may come before an immediate queued ahead of it, as a
    one-trip call's can in Node. The order of independent completions is
    free too. The system calls of a call and their order are Node's:
    libuv's `copyfile`, Node's `MKDirpAsync`, rimraf, `readFileHandle`
    (one read of a regular file's size, 512 KiB reads above it or with an
    encoding, 64 KiB reads of a file of unknown size) and `writeFileHandle`
    (512 KiB writes).

    Threading: pool work only computes (system calls and copies) and gives
    back plain data; a promise, a task, a job or a `W` never leaves the loop
    thread, and only the loop thread settles a promise. A request's
    callback runs in its unit, in the async context frame the request was
    made in, as a libuv request's does (a stream's listeners run in the
    frame of the `on('data')` call).

    Errors are Node's objects (`node::error_value`; `node::code_of(e)` is
    `cause.code`): a libuv error is an `Error` with `errno` (negative),
    `code`, `syscall`, `path`, `dest` and the message `<code>: <text>,
    <syscall> '<path>' -> '<dest>'`; Node's own are a `SystemError`
    (`ERR_FS_EISDIR`, positive `errno`), a `RangeError`
    (`ERR_FS_FILE_TOO_LARGE`) and a `TypeError` (`ERR_INVALID_ARG_VALUE`).

    Built, from the census of the worker's import closure (the calls
    reachable on darwin and Linux): `access`, `appendFile`, `chmod`,
    `copyFile`, `link`, `lstat`, `mkdir`, `open` (a string flag or
    `fs.constants` bits) and the `FileHandle`'s `read`, `write`,
    `writeFile`, `stat`, `chmod`, `sync` and `close`, `readFile` (bytes and
    `'utf8'`), `readdir` (names and `withFileTypes`), `readlink` (`'utf8'`
    and `{ encoding: 'buffer' }`, `session-mutation-files.js`'s
    observation), `realpath`, `rename`, `rm`, `rmdir`, `stat` (number and
    bigint), `statfs`, `symlink` (a string target, and a `Buffer` one:
    `session-mutations.js` writes a blob's bytes as a link's target),
    `unlink`, `utimes`, `writeFile`; `lstatSync` and
    `readdirSync` with types, inline; `createReadStream` with
    `highWaterMark`, consumed by `for await` or by `data`, `end`, `error`,
    `close`, `open` and `ready` listeners; `zlib.deflate`, whose bytes are
    `miniz_oxide`'s (they inflate to the same input; objects are compared by
    content and id). Not built, because no reachable site calls them:
    `mkdtemp`, `opendir`, `truncate`, `cp`, `readv` and `writev`, `lchmod`,
    `lutimes`, `chown`, `watch`, a handle's `readFile`, `truncate`,
    `utimes`, `datasync` and `readLines`; a stream from a handle or a
    descriptor, `start` and `end`, encodings, object mode, `unshift`,
    `pipe`, `pause` and `resume` by hand, and a stream consumed both by
    `for await` and by listeners (it panics); Writable streams,
    `pipeline` and `finished`; every other `zlib` function. Not reproduced:
    a handle whose operation failed and whose close fails too reports the
    operation's error (Node aggregates the two); rimraf removes a
    directory's children in parallel and reports the first to fail, here
    they go one at a time and the first listed is reported; a stat has no
    `birthtime` (no site reads it).

    *Child processes* (`node::child`, `node::net`; design file 32, package
    O2e, in the same reduced form): `child_process.spawn(file, args, { cwd,
    env, stdio })` as `session-changes-git.js` calls it (`start()` serves
    `git` and `gitTokens`; the persistent `cat-file` reader's shapes too),
    Node 24.22's `ChildProcess` ported by identity (`spawn`, `onexit`,
    `maybeClose`, `flushStdio`, `kill`), its stdio `net.Socket`s (a `Duplex`
    that does not allow half-open, `emitClose: false`) on the read stream's
    `Readable` core and Node's `Writable` (`write`, `onwrite`,
    `afterWrite`, `clearBuffer` as one `writev`, `end`, `finishMaybe`,
    `finish`), and `pipeline(source, child.stdin)` for the sites' sources
    (`Readable.from([string | Buffer])`, `Readable.from([])`, an async
    generator). The rules above, for a child:
    1. No completion settles in the checkpoint that started it: an
       output's reads, the exit, a write that had to wait, a shutdown and a
       handle's close are units (`node::source`, beside `node::submit`, is
       the module's only way to `host::open_source`, with the same epoch
       guard, renewed at each `readStart`). Node's own ticks stay ticks:
       the `spawn` event, a run-time spawn error (`EACCES`, `EAGAIN`,
       `EMFILE`, `ENFILE`, `ENOENT`: an `error` event, its `ErrnoException`
       with `errno`, `code`, `syscall` `spawn <file>`, `path`, `spawnargs`;
       any other spawn error is thrown, `syscall` `spawn`), and the
       callback of a write that went at once (`uv_try_write`; Node calls it
       synchronously and `afterWrite` on a tick).
    2. One source's events in Node's order: an output's `data` in read
       order, `end`, `finish` (its writable side ends, `allowHalfOpen`
       false), `close` (from its handle, `hadError`); `error`, then `close`;
       the stdin's `finish` or `error`, then `close`; the child's `spawn` or
       `error`, `exit` (`[code, signal]`, the stdin already destroyed; a
       death by a signal Node's `signo_string` does not name, such as
       `SIGEMT` on macOS or a real-time one on Linux, is exit code 0 and no
       signal, as in Node),
       `close` at the last of the exit and every piped output's close
       (inside that socket's `close`: `maybeClose` is its first listener).
       On a run-time spawn error the outputs are still sockets whose peers
       are closed: they read their end, and `close` waits for them, as in
       Node. A `for await` over an output ends at its `end` (end-of-stream
       with `willEmitClose` false) and destroys it.
    3. Independent sources (stdout against stderr, the exit against an
       output's end, writes against reads) and where reads split are
       arrival's; consumers must not depend on chunk boundaries.

    Threads, per child: one reader per piped output (a blocking `read(2)` of
    up to 64 KiB into a buffer of its own, each result copied out at its
    exact length, so a chunk holds only its bytes, and delivered as a unit;
    gated by `readStart`/`readStop`, so past the 64 KiB high-water mark
    nothing is read, and by the loop taking each delivery: the thread reads
    again only after the loop ran the unit of its last read, so while the
    loop is busy at most one read waits in the inbox and the child blocks on
    a full socket, as under Node, where libuv reads only while the loop
    polls). The socket pairs ask for 64 KiB send and receive buffers, as a
    child of Node's sees them on macOS (the macOS default is 8 KiB; measured)
    and, inferred from CI, on Linux too (which reports the request doubled;
    a default Linux pair holds 208 KiB). The sizes decide how much one
    `write(2)` takes, so what `write()` returns, and how far a child runs
    ahead of its reader; an outcome case compares the child's sizes with
    Node's on each platform. An exit waiter in `waitid(P_PID, pid, WEXITED | WNOWAIT)`,
    which sees the exit **without reaping**; the loop thread reaps
    (`waitpid(WNOHANG)`) in that unit, right before `onexit`, so until then
    the pid is the child or its zombie and a `kill` (an abort listener, a
    timer, a `finally`) cannot reach another process; after the reap the
    handle is gone and `kill` is Node's no-op (`false`, no system call).
    Writes are tried inline (non-blocking, as `uv_try_write`); only the rest
    of a write goes to a writer thread that waits for the socket to be
    writable. A completion posted once the handle began to close is
    `ECANCELED` (libuv cancels a write still queued at `uv_close`; the check
    and the post are one step under the writer's lock). When the child exits
    while a write waits, the exit waiter first lets the writer make its next
    attempt if the socket is ready (the child's end is gone): libuv runs a
    poll batch's socket events before its signal events, so the failed
    write's `EPIPE` comes before the exit, as under Node. Shutdown and close run on the pool, and a handle's close
    callback always runs in a unit of its own. A descriptor is closed only
    when no thread uses it: a blocked reader is woken by
    `shutdown(SHUT_RDWR)` and its last unit releases it. The spawn is
    `posix_spawn` (`ledger_io::process`) searching the child's own `PATH`
    the way libuv's child does on each platform (`process::Search`). On
    macOS libuv's own search before its `posix_spawn`: `ENOENT` and
    `ENOTDIR` try the next entry, an `EACCES` is kept if nothing else is
    found, any other error (`ENOEXEC` included) is the spawn's, no `PATH` is
    `/usr/bin:/bin`; every signal at its default, none blocked,
    `POSIX_SPAWN_CLOEXEC_DEFAULT`, so a child gets descriptors 0 to 2 only.
    On Linux libuv forks and calls glibc's `execvp`, so glibc's search: a
    file the kernel does not run (`ENOEXEC`) is run as `/bin/sh <the path
    tried> <the arguments after the first>`, `ESTALE`, `ENODEV` and
    `ETIMEDOUT` try the next entry too, no `PATH` is `/bin:/usr/bin`;
    signals 1 to 31 at their default, none blocked, and the child keeps
    every descriptor this process holds without close-on-exec (the port
    holds none it was not started with: every descriptor it opens is
    close-on-exec when made). Socket pairs as libuv's (`AF_UNIX` stream,
    close-on-exec); `'ignore'` is `/dev/null`; `SIGCHLD` is set to its
    default at the first spawn.
    `node::net::live_threads()` and `node::child::live_children()` count
    the helper threads and the unreaped children (the tests' census). After
    a child's `close` (and a socket's) nothing is emitted, so their
    listeners are let go: a listener may hold its child, a cycle
    JavaScript's collector frees and `Rc` would not.

    Built: `stdio` `'pipe'` and `'ignore'` per stream; `cwd` (an empty one
    is none, as in Node), `env` in its order (`node::child::env_pairs` builds
    it from an object's entries as JavaScript orders them: array-index keys
    first, ascending, a key given again in its first place with its last
    value, an `undefined` value left out); at the descriptor limit an
    `EMFILE` or `ENFILE`, of a socket pair or of the spawn, sets up no stdio
    at all (`stdin`, `stdout` and `stderr` are none, as Node returns before
    it makes them); `kill(signal)` (`SIGKILL`, `SIGTERM`, `SIGINT`, `SIGHUP`, 0);
    `pid`, `exitCode`, `signalCode`, `killed`; the events above; a socket's
    `on` (`data`, `end`, `finish`, `drain`, `error`, `close`), `for await`,
    `write(chunk, cb)` (`false` past the high-water mark, then `drain`),
    `end`, `destroy`. `pipeline` fulfils once the stdin has finished, on a
    tick, and rejects with the first error (a failed write such as `EPIPE`
    or `ENOTCONN`, the generator's throw; at the stdin's close its
    `errored` first, such as the `ECANCELED` of a write the exit's destroy
    cancelled, else `ERR_STREAM_PREMATURE_CLOSE` when it closed before it
    finished; a stdin ended with nothing left to write that is then closed
    counts as finished, as Node's end-of-stream has it), destroying the
    stdin with it. Which of `EPIPE`, `ECANCELED` and `ENOTCONN` a child that
    dies with a write waiting gives is arrival's in Node as here; the tests
    accept, per situation and platform, exactly the codes Electron's Node
    gives there (macOS measured; Linux inferred, without `ENOTCONN`, and
    printed by every run until measured). Not built, because no reachable site
    uses them: `shell`, `detached`, `uid`/`gid`, `timeout`, `killSignal`,
    `signal`, `maxBuffer`, `encoding`, `windowsHide` and the Windows
    options, IPC and `serialization`, `'inherit'` and stream or descriptor
    stdio (`gitToFile`'s `fd` stdout is unreachable), `ref`/`unref` (the
    persistent reader's: the native process does not exit when its loop is
    idle, and the reader is replaced by the in-process object database),
    `exec`, `execFile` and the sync forms, `setEncoding`, `pause`/`resume`
    by hand, `cork`. A NUL byte in the file, an argument, the working
    directory or an environment pair, and an empty file, throw Node's
    `ERR_INVALID_ARG_VALUE` `TypeError` from `spawn`, in Node's order and
    with its message (`util.inspect` of the value, split past 76
    characters, cut at 128). Not reproduced: Node's job
    and tick counts inside a write, a pipeline and a socket's end (file
    33); where reads split (up to 64 KiB, whatever the kernel hands over).
  - *Left free:* which of two ready units from different sources runs
    first: a line and a pool completion, a line and a timer that falls due
    while the loop waits. In Node that depends on when the loop wakes and,
    when both are pending at once, on the order libuv registered their
    handles (a `MessagePort` and the thread pool's async handle are separate
    handles of one poll phase), not on which arrived first; here both come
    through one inbox in arrival order, which is one of the orders Node can
    give, and no ledger code depends on it. Also free: how many timers fall
    due together, so how many progress ticks or stall observations a
    stretch of wall time holds.
- **The porting rule.** One JavaScript async function is one
  `js::async_fn`; one `await` is one `.await` of a `js::Promise` (a plain
  value through `js::value`); a function that returns a promise without
  being async returns it as it is (`Resolution::Promise`), and one that
  returns a value returns `Resolution::Value`; a throw is `Err`, before any
  await when the JavaScript throws synchronously. A ported function contains
  no `join!`, no `select!`, no `.await` on a plain Rust future across which
  another task could run, and no hand-written poll; an inline `async` block
  or helper is allowed only when its awaits are the function's own (the
  JavaScript awaits at those points, no more and no fewer). Callbacks
  (`then` handlers, timers, immediates, abort listeners) are synchronous
  closures run where Node runs them. `AsyncLocalStorage` is a
  `static S: js::Store<T>` (`S.run(v, f)`, `S.exit(f)`, `S.get()`),
  `AsyncLocalStorage.snapshot()` is `js::snapshot()` replayed with
  `js::run_in_frame`; an abort listener is `signal.add_listener(f)` (`once`)
  or `add_listener_with(once, f)`, removed with `remove_listener(id)`;
  `AbortSignal.any` is `Signal::any` (`AbortSignal.timeout` has no site and
  is not built). The layer enforces what it can: a task that suspends on
  anything but an await, or on two at once, panics. Four mistakes change the
  order without any panic, so the rule names them and a check refuses them:
  - *A JavaScript async helper ported as a Rust `async fn`*, as in
    `async fn read(p) -> Result<W, W> { open(p).await }` awaited by its
    caller: the helper's own promise and the jobs of its resolution vanish
    (Node: `j0 j1 after:x`, the Rust: `j0 after:x j1`). Write it as
    `fn read(p) -> WPromise { async_fn(async move { … }) }`.
  - *`std::future::ready(x).await` for `await x`*: no suspension at all
    (Node: `j0 after:x j1`, the Rust: `after:x j0 j1`). Write
    `js::value(x).await`.
  - *A `Drop` guard used as `finally`*: a task whose await never settles is
    dropped when the last reference to that promise goes, and its
    destructors run there; JavaScript never runs that `finally`. Write every
    `finally` as code after the awaited result, on both paths.
  - *An await that never settles, held in a cycle with its own task* (an
    async function awaiting a promise only it, or another such task, can
    settle): JavaScript's collector frees both, `Rc` never does. Drop the
    references to a promise no one will settle; where the JavaScript keeps
    one in a cycle, the port keeps a `Weak`.
  The first three are refused by `scripts/ledger-native/porting-lint.mjs`
  (run by the verify; also `node --test` on it alone), a search over every
  ported module (all of the crate's Rust but the layer: `js.rs`, `host.rs`,
  `agen.rs`, `emitter.rs` and `node/`): an
  `async fn` without the comment `// port: inline await` on the line above
  (allowed only for a helper that is one JavaScript await, or a coroutine's
  body), an `async` block that is neither an `async_fn`, `agen::async_gen`
  or `Coroutine::new` body nor awaited where it stands, `ready(`,
  `std::future::`, `futures::`, `poll_fn`, `join!`/`select!`, a
  hand-written `impl Future`, and any `impl Drop`; and the iteration
  mistakes below. The fourth is no text pattern: `js::live_tasks()` counts
  live tasks, and the job differential prints a census of the tasks each
  program leaves alive in such cycles (reported, not compared: the random
  programs make them on purpose). A `RefCell` borrow held across an await
  is loud only when another task borrows meanwhile: never hold one across
  an `.await`. Every rejection type registers its `TypeError` and
  `RangeError` maker with `js::register_errors` before use (`host::install`
  does it for `W`).
  - *Depth.* The loop runs on a thread of 64 MiB of stack
    (`process::LOOP_STACK`); an async function started with all but 8 MiB
    of it in use returns a promise rejected with JavaScript's `RangeError`
    ("Maximum call stack size exceeded"), which each caller's await
    rethrows (JavaScript throws it at the call, one job sooner). That is
    37,835 nested starts on the debug build and 159,566 on the release
    build, against Node's 5,000 to 10,000 and the ledger's own recursions,
    which go a directory tree deep. A pending chain of any length is freed
    without recursion (a dropped promise's reactions are freed one list at
    a time), and settles one job per link.
  - *Iteration and emitters.* Each JavaScript form has one Rust form
    (`agen`, `emitter`; `Co`, `Abrupt`, `Listener` below are theirs):

    | JavaScript | Port |
    |---|---|
    | `async function* g(a) { … }` | `fn g(a: A) -> AsyncGen<W, W> { agen::async_gen(move \|co: Co<W, W>\| async move { …; Ok(()) }) }` |
    | `yield v` (`yield p`) | `co.yield_(Resolution::Value(v)).await?` (`Resolution::Promise(p)`); its `Ok` is what `next(x)` sent |
    | `yield* it` | `co.delegate(it).await?` (an array: `agen::from_sync(agen::array(items))`); its `Ok` is `it`'s return value |
    | `return v` in a generator; the end | `return Err(co.ret(Resolution::Value(v)).await);` (an explicit `return undefined;` below `// port: return undefined`); `Ok(())` |
    | `return;` in a generator: no value, no job | `return Err(Abrupt::Return(W::Undefined));` (at the top level of the body, `return Ok(());` is the same) |
    | `try { … } finally { f }` in a generator | `let body = async { …; Ok(()) }.await; f; body?;` |
    | `try { yield v } catch (e) { h }` | `// port: yield outcome handled` above `match co.yield_(…).await { Err(Abrupt::Throw(e)) => h, other => { other?; } }` |
    | `for await (const x of it) { … }` | `let rows = agen::for_await(it); while let Some(x) = rows.next().await? { … }` |
    | `break`, `return v` in it | `rows.close().await?; break;`, `rows.close().await?; return …;` |
    | `break` (or `continue` of an outer loop) out of a loop body written as the inline block in a generator | the block gives a flag (`Ok(true)` for break), then outside it `if broke { rows.close().await?; break; }`: Rust cannot `break` out of an `async {}` block, and that arm is where a close is forgotten |
    | a throw `e` out of its body | `return Err(rows.close_throw(e).await);` (in a generator, any abrupt `a`: `return Err(rows.exit(a).await);`) |
    | `it.next(v)`, `it.return(v)`, `it.throw(e)` | `it.next(v)`, `it.return_(Resolution::Value(v))`, `it.throw_(e)`: each a `Promise<Step<W>, W>` (awaited by hand only below `// port: manual next`) |
    | `new EventEmitter()`; `e.on(ev, f)`; `e.emit(ev, a)` | `Emitter::new(unhandled)`; `let f = Listener::new(\|a\| { …; Ok(()) }); e.on(ev, &f);` (kept for `remove_listener`); `e.emit(ev, &a)?` |
    | `await fs.promises.lstat(p, { bigint: true })` (any built call) | `node::fs::lstat(&p, true).await?`; options are typed (`MkdirOptions`, `RmOptions`, `WriteOptions`, `Flags::Str("wx")` or `Flags::Bits(constants::O_RDONLY \| constants::O_NOFOLLOW)`, `Time::Date(ms)`) |
    | `await fs.x(p).catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause; })` | `node::fs::x(&p).then(\|v\| Ok(Resolution::Value(Some(v))), \|cause\| if node::code_of(&cause) == "ENOENT" { Ok(Resolution::Value(None)) } else { Err(cause) }).await?` |
    | `fs.lstatSync(p, { bigint: true })`, `fs.readdirSync(d, { withFileTypes: true })` | `node::fs::lstat_sync(&p, true)?`, `node::fs::readdir_with_file_types_sync(&d)?`: inline, no promise |
    | `const h = await fs.open(p, 'r'); try { … await h.read(b, 0, n, null) … } finally { await h.close(); }` | `let h = node::fs::open(&p, Flags::Str("r"), None).await?; let body = async { … h.read(n, None).await? … }.await; h.close().await?; body?;` (`read` gives `{ bytes_read, bytes }`) |
    | `for await (const chunk of createReadStream(f, { highWaterMark: 128 * 1024 })) { … }` | `let chunks = agen::for_await(node::stream::create_read_stream(&f, ReadStreamOptions { high_water_mark: 128 * 1024 })); while let Some(chunk) = chunks.next().await? { … }` (`createReadStream(f)`: `ReadStreamOptions::DEFAULT`); chunks are `W::Bytes`; leaving the loop closes the iterator, which destroys the stream |
    | `stream.on('data', (chunk) => …)`, `'end'`, `'error'`, `'close'` | `stream.on("data", &Listener::new(\|chunk\| { …; Ok(()) }))`, and so on (a `data` listener starts the flow) |
    | `await promisify(zlib.deflate)(bytes)` | `node::zlib::deflate(&bytes).await?` |
    | `const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })` | `let child = node::child::spawn(Spawn { file, args, cwd: Some(cwd), env, stdio: [Stdio::Pipe; 3] })?;` (`env` is `node::child::env_pairs` of the object's entries as `gitEnvironment` builds it: JavaScript's key order, a key given again in its first place with its last value, `undefined` values left out; `Err` is a thrown spawn error) |
    | `child.on('error', reject); child.on('close', (code, signal) => …)` | `child.on("error", &Listener::new(…)); child.on("close", &Listener::new(\|status\| …))` (`status` is `W::Array([code, signal])`, each a number or string, else `null`) |
    | `child.kill('SIGKILL')` | `child.kill(Signal::Kill)?` (`Ok(false)` once reaped; there is no kill by pid) |
    | `child.stderr.on('data', (chunk) => …)` | `child.stderr().expect("piped").on("data", &Listener::new(\|chunk\| …))` (`W::Bytes`) |
    | `for await (const chunk of process.child.stdout) { … }` | `let stdout = child.stdout().expect("piped"); let chunks = agen::for_await(&stdout); while let Some(chunk) = chunks.next().await? { … }` (it ends at the stdout's `end`; leaving it destroys the stdout) |
    | `pipeline(Readable.from([input]), child.stdin)`; `Readable.from([])`; a generator | `node::net::pipeline(PipeInput::Bytes(bytes), &stdin)`; `PipeInput::Empty`; `PipeInput::Generator(rows())` (a `Promise<(), W>`; the `.catch` of `EPIPE` and `ERR_STREAM_PREMATURE_CLOSE` is `then(…, \|e\| …)` on `node::code_of(&e)`) |
    | `child.stdin.write(text)`; `stdin.end()` | `stdin.write(bytes, None)` (or `Some(Box::new(\|error\| …))`); `stdin.end()` |

    For example `for await (const row of entries(prefix)) { if (row.key
    === key) return row; check(row); }` (`check` may throw) is:

    ```rust
    let rows = agen::for_await(entries(prefix));
    while let Some(row) = rows.next().await? {
        if row.get("key") == key {
            rows.close().await?;
            return Ok(Resolution::Value(row));
        }
        if let Err(error) = check(&row) {
            return Err(rows.close_throw(error).await);
        }
    }
    ```

    and a generator that loops is written with its loop body as an inline
    block, so a received return or throw at its `yield` closes the loop:

    ```rust
    // async function* rows() { for await (const row of treeRows()) { if (pending.has(row.key)) continue; yield row; } }
    fn rows(pending: Rc<Pending>) -> AsyncGen<W, W> {
        agen::async_gen(move |co: Co<W, W>| async move {
            let tree = agen::for_await(tree_rows());
            while let Some(row) = tree.next().await? {
                let step: Result<(), Abrupt<W, W>> = async {
                    if !pending.has(&row) {
                        co.yield_(Resolution::Value(row)).await?;
                    }
                    Ok(())
                }
                .await;
                if let Err(abrupt) = step {
                    return Err(tree.exit(abrupt).await);
                }
            }
            Ok(())
        })
    }
    ```

    The execution receipt's byte stream (`session-mutations.js:3115`) is:

    ```rust
    // async function* () { const hash = createHash('sha256');
    //   for await (const chunk of createReadStream(file, { highWaterMark: 128 * 1024 })) { hash.update(chunk); yield chunk; }
    //   if (hash.digest('hex') !== entry.hash) throw changeError('invalid_change_record'); }
    fn byte_stream(file: String, expected: String) -> AsyncGen<W, W> {
        agen::async_gen(move |co: Co<W, W>| async move {
            let mut hash = Sha256::new();
            let options = ReadStreamOptions { high_water_mark: 128 * 1024 };
            let chunks = agen::for_await(node::stream::create_read_stream(&file, options));
            while let Some(chunk) = chunks.next().await? {
                let step: Result<(), Abrupt<W, W>> = async {
                    hash.update(chunk.bytes());
                    co.yield_(Resolution::Value(chunk)).await?;
                    Ok(())
                }
                .await;
                if let Err(abrupt) = step {
                    return Err(chunks.exit(abrupt).await);
                }
            }
            if hash.hex() != expected {
                return Err(Abrupt::Throw(change_error("invalid_change_record")));
            }
            Ok(())
        })
    }
    ```

    The layer refuses loudly what it can see: a `for await` loop dropped
    while open by its own task (an early `?` or `return` without `close`)
    panics, as does `next()` after its end or a second `close`; a loop
    dropped with an abandoned task (an await that never settles) is not
    closed, as JavaScript never closes it. The porting lint refuses the
    shapes that compile and change the order silently: a generator
    hand-rolled on `Coroutine::new`/`suspend()`; a `yield_` or `delegate`
    whose outcome is not passed on with `?` (a received return or throw
    dropped), unless marked `// port: yield outcome handled`; a Rust `for`
    loop over an awaited collection standing in for `for await` (the body
    would run after every item was produced, not between them), unless
    marked `// port: for-of over an awaited value`; a generator pumped by
    `.next(v).await` instead of `for await`, unless marked
    `// port: manual next`; a Rust stream (`poll_next`, `StreamExt`,
    `async-stream`, `std::async_iter`); a Rust `for` over a binding the
    same function awaited into (`let rows = collect(…).await?; for row in
    rows`, `&rows`, `rows.iter()`), unless marked as a for-of; a
    `co.ret(v)` whose outcome is not the body's `Err`; and `co.ret` of
    `undefined`, which is JavaScript's `return undefined;` (one job), not
    `return;` (none), unless marked `// port: return undefined`. For
    Node's library: a blocking file-system call made directly
    (`ledger_io::…`, `std::fs::…`, or a `use` of them; an `fs.xSync` of
    the JavaScript is marked `// port: sync call`), which would settle
    inside the starting checkpoint; I/O settled outside the facade
    (`host::blocking`, `host::submit`), which skips rule 1's guard and
    Node's errors; and a read cut of the port's own: a `create_read_stream`
    whose `high_water_mark` is not written as the JavaScript's number
    (`ReadStreamOptions::DEFAULT` for `createReadStream(file)`; a test
    that takes it from its input marks `// port: read cut given by the
    caller`), or a `FileHandle` read loop or `.chunks(` re-cut in a
    generator's body standing in for the stream (marked
    `// port: handle read loop` where the JavaScript loops on a handle
    itself). The `node` module's own files are the layer, not ported
    modules. A long-lived source of units outside the `node` module
    (`host::open_source`) is refused as I/O settled outside the facade, and
    a child is signalled or reaped only through `node::child` (the system
    calls are `ledger_io::fs::sys`, refused with every `ledger_io` call).
- **Process.** A reader thread splits stdin into lines and posts each to the
  loop; a writer thread drains an unbounded queue to stdout (one line on
  stderr past 64 MiB queued); a watchdog thread checks every 250 ms that
  the parent is the one it started with and is not init, outside the timer
  lists so it cannot change their order. At start it raises its soft limit
  on open files as Node does (`ledger_io::fs::raise_open_file_limit`). It
  exits without unwinding: 0 when stdin closes (from the moment the reader
  sees the end, nothing more runs, not even lines already read, as a
  terminated worker runs nothing more) and when its parent is gone; 70 for
  a line that is not JSON or a known tag, deeper than 512 levels or longer
  than 256 MiB, for a refused `init`, a failed write, and a panic. A panic
  is a broken invariant of the process, not one call's error (a method's
  failure is a `result`, as a rejection is in the worker): like an uncaught
  error in the worker thread, it ends the process, and the host fails every
  call in flight with `worker_exit`; answering only the panicking call would
  leave shared state (the lock queue, the pools) half-changed. The profiles
  set `panic = "abort"` and the process's hook exits 70 first. Lines
  already emitted get up to 2 s to reach stdout on the way out.
- **Dependencies** (tracked `Cargo.lock`): none outside the repository's
  crates (`ledger-core`, and `ledger-io` with what it locks: `libc`, and the
  object database's `sha1`, `sha2`, `miniz_oxide` and their dependencies).
  tokio,
  which the design named for the loop, was removed: its scheduler queues
  woken tasks behind the next message and timer, so reproducing Node's order
  meant replacing it, and stdin, stdout, the blocking pool and child
  processes (`node::child`) are threads that post units, which needs no reactor.
  `--verify` refuses any package
  whose licence expression is not, as a whole, in
  `scripts/ledger-native/licences.mjs`, and checks RustSec advisories with
  `cargo deny check advisories` when `cargo-deny` is on `PATH` (it prints one
  line when it is not).
- **Test hooks.** The `test-hooks` feature adds the stub methods
  `stubRun` and `stubEcho` (`src/stub.rs`, a program interpreter that is the
  twin of `scripts/ledger-native/stub-interpreter.mjs`), a virtual clock
  (`src/virtual_host.rs`), a test line limit (`LEDGER_NATIVE_TEST_MAX_LINE`)
  and the `ledger-native-probe` binary. The verify builds `devryan-ledger`
  without it (the product's shape) and with it.
- **Tests** (run by `node scripts/build-ledger-native.mjs --verify`;
  [testing](../../docs/TESTING.md#native-ledger-module-tests)):
  - `scripts/ledger-native/jobs-differential.mjs`: the job layer against
    JavaScript. Programs (`jobs-programs.mjs`: async functions, awaits,
    `return` against `return await`, the combinators, ticks and microtasks,
    timers that make and clear timers, immediates, try and catch, unhandled
    rejections, messages in the poll phase, two `AsyncLocalStorage` stores
    tagging every entry with its frame, `run`/`exit`/`snapshot`, abort
    controllers, listeners added and removed during a dispatch,
    `AbortSignal.any`, `throwIfAborted`) run on V8 with Node's own task
    queue, timers and immediates under a virtual libuv clock
    (`jobs-js-arm.mjs`, on Electron's Node and on the Node running the
    test) and on the Rust (`ledger-native-probe jobs`); every trace must be
    equal entry for entry. Iteration programs add compiled functions
    (async functions and async generators whose JavaScript is real source:
    `await`, `yield`, `yield*`, `for await` with `break`, `continue`,
    `return` and throws, `try`/`catch`/`finally`), manual `next`, `return`
    and `throw` calls several at once, arrays and sync iterables of
    promises, and event emitters whose listeners add, remove, emit again
    and throw, async iterators without `return` or `throw`, and values of
    every kind the frame rule tells apart. The gate runs 180 named
    programs (one per rule, the second review's B1 and B2 cases, the third
    review's abort and frame cases and its escaped promise bugs, one per
    row of the generator and emitter behaviour relied on, one per ledger
    call shape, the frame rule kind by kind, `return(v)` at a `yield*`)
    and 400 seeded random ones plus 300 iteration ones; `--extended` runs
    20,000 and 10,000 over five seeds. Electron's Node is the reference.
    The Node running the test is compared with it frame tags aside, and
    exactly, frames included, with the Rust run under Node 26's frame rule
    (`ledger-native-probe jobs node26`, test-only); the named programs
    marked `electronOnly` are the ones whose frames differ between the two
    Nodes, and a test pins that they do.
  - `scripts/ledger-native/fs-differential.mjs`: the `node` module against
    Node's own on Electron's Node, the Node running the test and the Rust
    ([testing](../../docs/TESTING.md#native-ledger-module-tests)): 31
    outcome cases (every built call and its failures, field by field, a
    stat and a `statfs` against Node's own of the same path, what a
    write's continuation finds on disk, the tree afterwards with link
    targets as bytes, the descriptor count unchanged by every case; link
    targets that are not UTF-8, the sync calls, default modes under
    umask 0, and names that are not UTF-8 on Linux only); the read cut at 128
    and 64 KiB over ten sizes, byte for byte, and over files that change
    between two reads; the read stream's lifecycle (ends after its close;
    leaving it closes the descriptor, a read in flight first); and I/O
    programs (`fs-programs.mjs`: 21 named and 60 random; `--extended`
    2,000 over five seeds; a handle's open, read, stat and close are each
    their own awaited call). Node's job and round-trip counts inside a call
    are not reproduced, so programs are compared by constraints every
    arm's trace must meet: Electron's pure part, and for the Rust
    Electron's I/O strands (what descends from one completion), entry for
    entry, times and frames included (the system Node's strands are
    information: its stream iterator's `return()` takes other jobs); every call continued in a later checkpoint than its start and
    after that checkpoint's last entry (rule 1; the Rust prints its
    measured checkpoint epoch); each stream's events in order (rule 2). How
    strands interleave with each other and with the pure part is arrival's.
    `scripts/ledger-native/fs-planted.mjs` (by hand) plants 33 bugs in a
    copy of the workspace, each caught by a named test; with `--gate` it
    also plants the independent review's 25 and runs each bug against the
    whole of `cargo test` and `fs-differential.mjs`, then the extended run
    for a survivor.
  - `scripts/ledger-native/child-differential.mjs`: child processes
    against Node's own on Electron's Node, the Node running the test
    (information) and the Rust (`ledger-native-probe child-cases`,
    `child-programs`; the JavaScript arm is `child-js-arm.mjs`): 52
    outcome cases (`child-spec.mjs`: the Git runner's shapes of design file
    32 section 3.2, spawn errors and their objects (a file without an
    interpreter line: `ENOEXEC` on macOS, run by `/bin/sh` on Linux), the
    descriptor limit (on a second pair of arms started under `ulimit -n
    256`), the `PATH` search (order, a remembered `EACCES`, an empty entry,
    no `PATH`), kill before and after the exit, a signal Node does not name,
    `'ignore'`, the environment's order (JavaScript's key order too), `cwd`
    (empty, and a relative `PATH` entry), the child's inherited descriptors
    (checked per arm against libuv's rule: 0 to 2 only on macOS, where the
    Rust arm holds one descriptor without close-on-exec that no child may
    see; on Linux also what the arm holds without close-on-exec, and the
    Rust holds none it was not started with), the stdio sockets' buffer
    sizes, writes (and the `writev` of writes buffered behind one),
    string, generator and throwing pipelines, 1 MiB each way, the stdin
    pipeline's outcome when its child goes away (a code Electron's Node
    gives in that situation on that platform and Node's error object:
    exits, kills, a closed stdin, a grandchild holding it, a row that waits
    for the exit; every run prints each arm's code),
    output nobody reads, backpressure (a slow consumer holds its child
    within a stated bound in reads of Node's size; an unread output stops
    being read at the high-water mark; a reader parked there stops when
    destroyed)), each source's events in order exactly
    and the cross-source rules, the records field by field (fields left to
    arrival compared as sets), and around every case the descriptors, live
    children, helper threads and open sources back and no zombie (`ps`, no
    signal); that an `error` nobody listens to ends the process (the
    worker dies of it); programs (`child-programs.mjs`: 21 named, 40 random;
    `--extended` 1,000 over five seeds) compared as the file programs are,
    each event of each child a strand of its own, rule 1 per event source
    (the `spawn` event, a spawn error and the callback of a write that went
    at once on a tick of the starting checkpoint, every other event later)
    and rule 2 per child. An arm that times out once fails its later cases
    at once and a program arm stops at its first stuck program, so a hang
    costs one deadline. `scripts/ledger-native/child-planted.mjs` (by hand)
    plants 36 bugs (the builder's, the review's that had escaped, the fix
    round's), each caught by a named test. CI runs this file on Ubuntu and
    on macOS (the verify); the Linux behaviour of the spawn search, the
    socket buffers, the inherited descriptors and the stdin pipeline's
    codes is established by CI's Ubuntu run, which prints them, not by a
    run on a Mac (the glibc search itself is also unit-tested on macOS,
    through `ledger_io::process::spawn_with`).
  - `scripts/ledger-native/porting-lint.mjs`: the porting rule's silent
    mistakes, refused in the ported modules (above), with a planted case of
    each.
  - `scripts/ledger-native/proto-differential.mjs`: 33 scripted host
    transcripts on three arms, the product's worker on a real worker thread
    driven through `postMessage` (the true reference for ordering), the same
    worker as a stdio process (both with the stub runtime put in by a module
    hook), and the test-hooks build; 17 against the worker with its real
    runtime and the plain build (only what needs no method: `ready`, unknown
    methods, `init` refusals); 5 timed scripts under one virtual clock, the
    worker on Node's own timers against the Rust's event loop, every message
    compared with its time (progress cadence exactly, call start order,
    truncated delays and list order, an unrefed list kept, slow phases and
    the cleanup ticker); a
    lower bound on progress messages under real time on all three arms;
    then what only the native process does (epoch time included) and its
    lifecycle (SIGTERM, SIGINT, SIGHUP, stdin EOF mid-call with nothing
    written after, EOF with large calls queued, a panic after and before a
    call's first suspension, the parent's death with stdin still open, no
    child process).
  - `scripts/ledger-native/codec-differential.mjs`: 8,000 seeded values
    encoded by one side and decoded and re-encoded by the other, 3,000
    random and mutated lines, malformed tags and the decoder's quirks.
  - `scripts/ledger-native/ctx-differential.mjs`: 49 scenarios of the
    context, the pool and the stall clock under one virtual clock: the
    JavaScript on Node's own timer code with only libuv's loop time replaced
    (`scripts/ledger-native/node-virtual-clock.mjs`, `--expose-internals`),
    the Rust on the binary's event loop with only its clock replaced
    (`src/virtual_host.rs`), so no rule of either is restated by the test,
    every event compared in order with its time;
    18 of the 23 tests of the three JavaScript modules are restated, the
    other 5 test host-side functions the worker never runs.
  - `cargo test`: the codec, wire, value and signal units (the EventTarget
    dispatch, `any`, kept composites); the event loop's timer lists,
    immediates, blocking completions, one iteration's phase order, the poll
    phase's batch (above 1,000 units too), an interval cleared in its own
    callback, the second review's B1 programs, and the porting rule's
    panics; the depth bound and chains of a million links; a queue wait's
    listener removed, an idle pool forgotten, an abort between a slot's
    grant and its turn, the stall clock's start; generators 2,000 deep in
    `yield*` and past the stack budget, a suspended generator and a chain of
    100,000 dropped without running their `finally`, a generator abandoned
    mid-`for await`, one abandoned while it executes, one holding its own
    handle (a counted cycle), the close guard; the emitter's removal,
    re-entrant `once` and refused `newListener`/`removeListener`; the
    `node` module's units (a completion in a later checkpoint, the guard's
    panic, a read stream's cut and close before its `for await` ends, a
    closed handle's `EBADF`; a child's events per source, a spawn error's
    tick and close, `kill` before and after the reap, the zombie kept until
    the loop reaps, `for await` over stdout with a 180 KB pipeline, the
    child's `close` before the stdin's, a reader that reads no further
    while the loop has not taken its last read, chunks that hold only their
    own bytes (16 MiB collected holds 16 MiB), the exit waiter letting a
    ready writer's attempt go first, the environment in JavaScript's key
    order); and
    20,000 random or mutated lines that must never panic.
- **What the comparison leaves free**, and why each is fair. Every message
  of one call (reports, callbacks, observations, its result) is compared in
  order; a transcript's `ordered` messages are compared in order across
  calls on all three arms; under the virtual clock every message is compared
  with its time. Left loose: the interleaving of different calls' messages
  in a real-time run (each waits for the message it depends on, and what
  falls between is wall time); how many `progress` ticks a real-time call
  sends (wall time decides how many ticks fall due; the sequence of states
  is compared with repeats collapsed, the last one must precede the result,
  and a lower bound holds on every arm, while the virtual clock compares the
  exact count); how many worker stalls are observed (machine load);
  and background observations, as a multiset (no call orders them). Under
  the virtual clock nothing is loose: every message is compared in order
  with its time, across calls too.
- **Codec quirk not reproduced:** a `bytes` tag whose `base64` is an
  `{type:'Buffer',data}` or `{length}` object decodes in JavaScript
  (`Buffer.from`) and is a corrupt line natively; no host sends one.
- **Known JavaScript behaviour carried over** (not fixed here): a callback
  whose arguments cannot be encoded consumes its id and leaves its entry
  behind; a result that fails to encode after a stream was met still
  registers that stream; old stalls are pruned only when a new one is kept,
  so a stall older than 30 minutes keeps counting until then; an I/O cap
  raised while callers queue admits new callers ahead of them.

### The Git runner and the store

`ledger-native/src/git.rs`, `store.rs` and `durability.rs` (plan package
L3b) port `lib/session-changes-git.js`, `lib/session-changes-store.js` (with
`commitTreeChanges` of `lib/session-changes-trees.js`) and the off-Windows
part of `lib/object-durability.js` onto the job layer, by the porting rule:
one async function one `async_fn`, one async generator one
`agen::async_gen`, one `await` one `.await`, the execution context passed
explicitly. **Nothing calls them**: no method of the process is wired to
them, and the product is unchanged.

- **The runner.** `start` (the abort listener, the `timeoutMs` timer, the
  stderr head and tail and their classes, `done` classified into
  `capture_timeout`, `storage_unavailable`, `capture_not_git`,
  `capture_git_failed` with `command` and `failure`, `writing` with `EPIPE`
  and `ERR_STREAM_PREMATURE_CLOSE` swallowed), `git`, `gitTokens`,
  `gitRecords`, `createOwnedGitRunner`, `changeError`, `gitFailure`. The
  failure classes' regular expressions are matched by hand over UTF-16 code
  units, as JavaScript's non-unicode `/i` folds (ASCII letters only).
  Today's defects are kept: a raw `ECANCELED` or `ENOTCONN` from the stdin
  pipeline rejects `git()` before its classified failure (O2e's F1); at the
  descriptor limit `start` throws a `TypeError` (no stderr to listen to) and
  the spawn's `EMFILE`, which nobody listens to, then ends the process
  (F2); `pin` on a store with no tree passes `null` to `update-ref` as the
  text `null`. Not ported: `gitToFile` (a descriptor as stdout; no worker
  method reaches it).
- **The persistent reader.** `readGitObject` answers from the ledger
  repository in-process (`node::odb::ObjectReader`, over the object database
  above) where the JavaScript keeps a long-lived `cat-file --batch` and
  `--batch-check` per repository: the same answers (`null` when absent;
  `{ oid, type, size }` and, unless checked, `data`), settled in request
  order per reader, and a reader closed, failing every request still pending
  on it, where the JavaScript's closes: a gitlink's `<id> submodule` (the
  defect of `session-changes-git.js:221-226`, kept where the installed Git
  prints it), a malformed header, a `cat-file` that died. A reader lives as
  the JavaScript's does: its database (opened on a thread of its own, so a
  read stuck in a system call never holds the I/O pool) and every pack it
  has opened, a pack a repack deleted included, as Git keeps them, last until
  it closes; it closes 15 s after its last read settles, and its watchdog
  (each second, `Date.now()`) fails it with `capture_timeout` (503) once its
  oldest pending read is older than 30 s, killing its Git and failing every
  pending read. What Git loads once per process is read once, at the first
  name that is an id: replace refs or `objects/info/alternates` present then
  send every later name to Git, after they are gone too; absent then, ones
  made later are not read (the installed Git reads its alternates file once
  per process; a Git that read it again on a miss would find what such a
  reader answers missing). A name the database cannot answer exactly ("ask
  Git") is handed back to the reader's own Git: one long-lived `cat-file
  --batch` or `--batch-check`, the JavaScript reader's process (its
  arguments, the environment of the reader's open, stderr ignored), started
  at the reader's first hand-back and killed at its close, its names written
  in order and its output parsed as the reader parses it. So a reader whose
  every name goes to Git (replace refs, alternates, `GIT_REPLACE_REF_BASE`,
  a repository it cannot open) starts what the JavaScript's starts and gets
  that process's answers for its whole life, a pack a repack deleted
  included. Every gitlink is asked (Git's answer there is its version's).
  What differs: a reader that answered in-process before its first hand-back
  (a gitlink, a corrupt or unusual object) starts its Git then, so where the
  repository changed in between in what Git loads once (a replace ref or the
  alternates file made or removed, its configuration, a pack the
  JavaScript's process had mapped and a repack deleted), that hand-back's
  answer is a fresh Git's; the JavaScript's spawn errors at a reader's open
  (`ENOENT` without Git, `EMFILE` at the descriptor limit, which ends the
  JavaScript's worker: its `stdout` is `null` and the spawn's `error` has no
  listener yet) come at the first hand-back instead, and fail the reads
  pending then with `capture_git_failed`; a NUL in the arguments or the
  directory is thrown at once, before a reader exists, as the JavaScript's
  `spawn` throws it. Files that are not regular (a FIFO at an object's path,
  a pack index or `config`) are opened without blocking and asked of Git,
  which then
  blocks as it would. Not ported: `ref`/`unref` (the native process does not
  exit when its loop is idle). `DEVRYAN_LEDGER_PERSISTENT_READER=0`, read
  when a store opens, gives the reader-less paths (`cat-file --batch` per
  read, `gitRecords`, `rev-parse`, `ls-tree` identities), as in the
  JavaScript.
- **The store.** Every export of `openChangeStore` (`get`, `set`, `remove`,
  `entries`, `records`, `list`, `setList`, `writeList`, `setListObjects`,
  `commit`, `committedRows`, `readRows`, `stage`, `leaseRef`, `pin`,
  `release`, `importPrefix`, `prefixIdentity`, `prefixIdentities`,
  `committedIdentity`, `staged`, `tree`, `exists`, `pendingCount`), with the
  same Git processes in the same order: the loose-ref read (trimmed, as
  today: leading whitespace Git refuses is accepted, a directory at the ref's
  path is `EISDIR`), `for-each-ref` and `rev-parse --show-object-format` at
  open; whole listings with `ls-tree -r -l -z`, cached two per process and,
  past `listingLimitBytes`, paged for the rest of the process; paged
  listings read tree by tree through the persistent reader as
  `listDirectPrefix` and `listTreeRows` read them
  (`DEVRYAN_LEDGER_DIRECT_LISTINGS`, read per use), a failed read (an
  aborted execution) leaving the listing to Git; commits as direct trees or through Git's index
  (`DEVRYAN_LEDGER_DIRECT_TREES`, `DEVRYAN_LEDGER_PERSISTENT_INDEX`, read per
  use); every ref move an `update-ref` compare-and-swap, a guard revoked
  after it undone by a second one (`ledger_guard_rollback_failed`,
  `committed`, `rollbackFailed` when that fails); `syncObjects(cwd)` before
  every commit that stages anything. The process-wide blob cache (8 MiB,
  4,096 values), listing cache and oversized stores are thread-locals of the
  loop thread. Differs on purpose: staged keys are sorted by code unit where
  the JavaScript calls `localeCompare` (D25; the host refuses the native
  ledger where they disagree, "The locale check"); a `JSON.parse` failure is
  a `SyntaxError` with a message of its own; a record nested deeper than
  512 levels (the line codec's fail-closed bound, L1a) is refused with
  `ledger_record_too_deep` (503) where the JavaScript reads it (no ledger
  record is deeper than a few levels); a custom `gitRunner` is not taken (only an inline
  JavaScript ledger has one).
- **What a run spawns.** The Git commands are the JavaScript's, argument
  for argument and in order (the differential compares them as a multiset
  and in order, `hash-object` and concurrent steps aside, in every
  repository it builds, ones the database leaves to Git included), the
  persistent readers' processes aside: the JavaScript starts one `cat-file
  --batch` or `--batch-check` per reader at its open, the Rust one per reader
  at its first hand-back, none for a reader it answers in-process. Where
  every name goes to Git the readers' processes are the JavaScript's too (the
  differential compares them, as a multiset where two readers start
  together), never more than one per reader alive at a time.
- **Tests.** `scripts/ledger-native/store-differential.mjs` (in the verify;
  [testing](../../docs/TESTING.md#native-ledger-module-tests)) runs every
  request on the product's modules under Electron's Node and on the Rust
  (`ledger-native-probe store`): results and errors field by field, the Git
  commands each arm started (a `git` shim first on `PATH` logs them), and
  after each store scenario the refs, every object by id and content,
  `git fsck --strict --full` on both arms, every file outside `objects/`, and
  each arm's ledger read back by the other; the reader's deadline (a clock
  run ahead on both arms), its life and census, deleted packs, the
  environment it honours, a fake Git printing random bytes, what its one Git
  loads once (deleted loose objects and packs, replace refs and alternates
  made or removed while it lives), the environment of its open, an ignored
  stderr, FIFOs at a pack index and `config`, one `cat-file` alive at a
  time (a `PATH` shim counts them), the spawn's refusals and the descriptor
  limit, and the object
  directory's sync (a counting shim with injected faults on both arms, and
  on macOS the interposed system calls per installed object and per
  commit). Eight named programs of `child-differential.mjs` call the
  runner and the direct tree commit at the trace level (the product's
  `git()`, `gitTokens()` and `commitTreeChanges` against their port, beside
  chains of every length). `cargo test` adds the runner's own: progress
  recorded on success only, the failure classes, the command name, blocked
  reads failing at the reader's deadline without the I/O pool, the
  deadline's exact tick and its oldest read, a hand-back whose spawn throws,
  the refusals at the open, the idle close; and the database's snapshot
  (`git::odb::tests`). `scripts/ledger-native/store-planted.mjs` (by hand) plants 131 bugs
  (the builder's, the review's and one undoing each fix of its first round)
  and reports the named test that catches each.
- **Not done.** No method calls the runner or the store (L3e onwards); the
  native process does not start; nothing is packaged. CI runs the verify on
  Linux and on macOS; every failing comparison of the store differential
  prints the platform, the installed Git and both arms' raw values.

### The content object store

`ledger-native/src/objects.rs` (plan package L3c) ports
`lib/session-mutation-files.js` (`inspectMutationFile`, `mutationFileStamp`,
`mutationStatStamp`, `requireMutationSpace`, `createViewMaterializer`,
`copyMutationObject`, `resetVerifiedMutationObjects`, the verified-objects
record), `hasDirectoryAncestors` of `lib/session-changes-snapshot.js` and
`bytesFor` of `lib/session-mutations.js` onto the job layer, by the same
porting rule, beside `durability.rs`. **Nothing calls it**: no method of the
process is wired to it, and the product is unchanged.

- **Install.** The file is read once to hash it (a stable observation: its
  bigint lstat stamp checked against its handle before and after the reads,
  and by path afterwards; a link's target read as raw bytes); content already
  present by name and size is reused, its directory marked pending when it
  may be younger than this process's last directory sync. Otherwise
  `objects/` is made (`0o700`), the space probed (`statfs`, 1 MiB spare), and
  the file read again into `.pending-<uuid>` (`wx`, `0o600`), checked again,
  synced, closed, linked to `objects/<sha256>` (`EEXIST` means present), the
  directory marked pending, the temporary unlinked and the identity appended
  to `verified-objects.v1`; the `finally` closes and unlinks again.
  `ENOSPC` and `EDQUOT` are `storage_unavailable` (503); a changed or
  vanished file is `observation_changed`. The text classifier is the fatal
  streaming UTF-8 decoder with the NUL and 8 MiB rules.
- **Verification and views.** An object is re-hashed (its read stream) unless
  its identity (`dev:ino:size:mtimeNs:ctimeNs`) was verified in this process
  or in `verified-objects.v1` (loaded once per root, compacted past 1,024
  lines and twice the live count, `DEVRYAN_PERSISTENT_OBJECT_VERIFY=0` read
  per use); a mismatch is `invalid_change_record`. The materializer creates
  each directory once (a failure stays its answer, a link where a directory
  should be is `unsupported_path`) and copies with `copyFile(COPYFILE_EXCL |
  COPYFILE_FICLONE)`, which is libuv's copy (`node::fs`; a clone only on
  Linux), so a copy's modification time is the copy's for any content and the
  object's for empty content; an existing entry or a link entry is `null`.
  `copyMutationObject` copies disposable views with `copyFile` (unless
  `DEVRYAN_VIEW_CLONE=0`) and otherwise reads, hashes and writes
  `<target>.devryan-<uuid>`, synced when durable, then renames.
- **Defects kept** (the JavaScript's, reproduced on purpose): an object of
  the right name and size is reused without a hash, so a same-size corrupt
  object is trusted at install time; the installed temporary is unlinked
  twice (the second an `ENOENT`); a `close` failing in the `finally` replaces
  the call's outcome and leaves `.pending-<uuid>` behind; a crash between
  write and unlink leaves `.pending-<uuid>` forever (nothing removes stale
  ones); `verified-objects.v1` lines with a negative device number never
  load; the appends are not synced.
- **Not ported.** The Windows branches, and `putBytes` of
  `session-mutations.js`, which writes through `writeFileAtomic` (not on the
  job layer yet).
- **Tests.** `scripts/ledger-native/object-differential.mjs` (in the verify)
  runs the product's modules under Electron's Node and the Rust
  (`ledger-native-probe objects`) on the inputs and views suites' shapes
  (empty, small, large, binary, invalid and split UTF-8, links, duplicate
  and concurrent content, vanished and corrupt objects, refusals), a file
  changed at each of the six stamp checks (a hook on both arms), a 32 KiB
  file-size limit, a sync shim on the object directory's, the temporaries'
  and the copies' handles with injected faults, settle orders against job
  chains where no I/O intervenes, the system calls of each install, sync and
  copy (macOS, interposed), and the dual-run crash points
  `content-object-link:{before,after}` and `directory-sync:before`, which
  the probe honours (`LEDGER_DUAL_RUN_CRASH`): after each crash the disk is
  the JavaScript's, and the next run recovers identically. Compared: results
  and errors field by field, and every entry under the scenario (names with
  their UUIDs masked, types, permission bits, sizes, hashes, a view file's
  modification-time class, `verified-objects.v1` as a set). The extended run
  adds seeded files. `scripts/ledger-native/object-planted.mjs` (by hand)
  plants 40 bugs and reports the named test that catches each.

## Registered host-dependent operations

`lib/registered-host-operations.js` loads the private administrator file
`<selected bundle controlRoot>/host-operations.json` once per controller boot.
An absent file means no operations. It must be a regular, single-link, owner-only
file owned by the server user, outside all registered projects; linked paths,
unknown fields, mutable registrations and mismatched SHA-256 pins fail closed.
The model cannot create registrations, choose argv/environment, or mint grants.

Each registration fixes an operation ID, project/cwd, executable and its SHA-256,
argv, purpose (`verification` or `deployment`), timeout, explicit content-file
SHA-256 pins, allowed host environment names and exact local capabilities. The
host checks both logical source and prepared execution-view bytes immediately
before launch, plus the registry and executable identity. Administrators must pin
all executable project entrypoints and dependencies used by the operation;
registrations are approvals of those exact bytes, not standing approval of new
workspace code. Configuration changes require a controller restart.

The native `devryan_operation` tool accepts only `operationID`. It uses the normal
execution lease, private project view, supervised termination, publication and
verification observer. Plan mode denies it before capability resolution. A
registered operation on macOS may reach only its named canonical Unix sockets
and the named OpenDirectory identity services; ordinary shells still cannot reach
Docker or ssh-agent. Other Mach services, generic socket grants and non-macOS
production capability execution remain unsupported. Scratch writes, process
ownership and cleanup stay confined. Selected host HOME/Docker/SSH context is
passed only to that registered process and never returned in tool metadata.

Deployment registrations require nonempty `prerequisites` check names. The native
owner pins the current root objective, projects its authoritative checks, and
requires each configured name exactly once with `passed` or an existing user
`waived` result. It checks again immediately before launch. Unrelated objectives
cannot supply evidence; absent, ambiguous, stale or pending checks block launch.
Registration itself never proves deployment readiness or a successful check.

Example administrator file (replace paths and SHA-256 placeholders with reviewed
values; save with mode 0600):

```json
{
  "version": 1,
  "operations": [{
    "id": "host_database_rehearsal",
    "description": "Run the approved isolated database rehearsal",
    "purpose": "verification",
    "directory": "/absolute/project",
    "cwd": "/absolute/project",
    "command": "/absolute/node",
    "executableSha256": "<64 lowercase hex characters>",
    "args": ["scripts/approved-rehearsal.mjs"],
    "contentFiles": [{"path": "scripts/approved-rehearsal.mjs", "sha256": "<64 lowercase hex characters>"}],
    "requiredCapabilities": {"unixSockets": ["/absolute/host/docker.sock"], "machServices": []},
    "environment": ["HOME", "PATH", "DOCKER_HOST", "DOCKER_CONTEXT"],
    "timeoutMs": 300000
  }]
}
```

Declare the corresponding required-check command as
`devryan_operation host_database_rehearsal`, and invoke the typed tool rather
than executing that marker in a shell. Deployment operations additionally name
`prerequisites`. Supported environment names are HOME, PATH, USER, LOGNAME, LANG,
LC_ALL, DOCKER_HOST, DOCKER_CONTEXT, DOCKER_CONFIG and SSH_AUTH_SOCK; values come
from the host, not the registration or tool input. The only identity-service
names accepted are `com.apple.system.opendirectoryd.libinfo` and
`com.apple.system.opendirectoryd.membership`. No credentials belong in this file.

Finite failures distinguish an unregistered operation, untrusted/changed registry,
changed content or socket identity, absent/unavailable host socket, unsupported
platform, pending prerequisites and deadline. A missing execution socket does
not assert that the host Docker daemon is stopped. Tests use a synthetic daemon
to prove a registered grant works while ordinary shell access stays denied.

Session changes expose a cached display projection at `GET .../changes?summary=1`.
The authenticated read validates its root and directory, then returns
`projectionState` (`missing`, `refreshing`, `ready`), `generatedAt`, and
`restoreEligibility` (`unknown`, `unavailable` with reasons, or `candidate` with
Undo/Redo direction). A candidate is permission to attempt preview, never restore
authority. Cached rows omit live content verification and proofs. Up to 32
requested roots retain projections; refreshes share the bounded read pool, merge
hints into one trailing refresh, and refresh on the next read after five seconds.
Runtime change notifications invalidate matching project projections. Reconciliation
and observation settlement run outside the display request; failures retain rows
with unknown eligibility. The existing full GET and revision/diff routes remain.
`POST .../changes/preview` requires the displayed revision and direction, performs
current reconciliation and existing exact proof generation, and rejects changed
revision/direction. Existing Undo/Redo still revalidate proof and current content
at the mutation boundary. Preview is read-only; it does not create a restore fence.
