# Concurrent conversation Revert

With the verified DevRyan OpenCode companion, Revert rewinds the selected
conversation and disables its file contributions from the selected user message
onward. Descendants are selected by their dispatch ancestry, including hidden
children. Unrelated conversations and commands continue running. Redo enables
the same operations again.

The durable operation history preserves edits from other contributors. For
example, reverting `a=1 → a=3` after another chat changes `b=2 → b=4` on the same
line produces `a=1; b=4`. A later `x=2 → x=3` replacement survives reverting the
earlier `x=1 → x=2` change. Repeated text, file creation/deletion, rename ancestry,
executable modes, POSIX permissions and binary revisions share the same ledger. Text projection
keeps UTF-8 characters intact. Text up to 8 MiB uses granular ownership; larger
text and binary files use streamed whole-content revisions. Content and file
permissions have separate ownership. A concurrent whole-content conflict keeps
the current foreign bytes and stores the proposed bytes outside normal revision
history. Nonconflicting paths still publish. Tool results, Cursor completion and
conversation Revert/Redo report a partial outcome with the conflicting paths.

## Execution and persistence

`packages/harness-runtime/lib/session-mutations.js` owns immutable file versions,
execution bases, operation identities, publication order and projection. Git
subdirectories share one canonical worktree ledger; separate worktrees remain
separate. Non-Git projects use their canonical directory. Git ignore rules do
not hide project file contributions. Dependency directories and Git metadata
are inputs rather than published mutations. Private views preserve HEAD and the
index for inspection; commits and branch changes inside those views do not
change the original repository metadata.

Trusted host control operations reserve the same identities and cancellation
fences in an empty private directory without reconciling or copying the project.
Their leases cannot claim process execution. Skills and file tools still use
confined views; there is no exemption based on a tool's name.

The companion dispatches native and custom file tools in private views. Each
dispatch names the tool's origin (built-in or custom), so a plugin tool that
reuses a built-in id such as `read` never replaces the built-in in the worker;
duplicate ids within one origin fail explicitly. The host resolves ripgrep,
including its download into the real cache, and passes that executable to the
worker (the sandbox has no DNS and an empty cache). Resolution is best effort:
without it only ripgrep-based tools such as grep and skill fail. Built-in web fetch and web search have no workspace effects and run as
trusted control operations. Native task and managed
orchestration dispatches register parent call identities before starting children.
Cursor uses one confined process per turn, mirrors canonical conversation
records, and awaits publication before completion. Claude through Meridian uses
passthrough tools and a separate read-only provider transport. Provider API
credentials are not diagnostic evidence or execution ownership.

Native enforcement, not a working directory convention, prevents writes to the
original project, dependencies and ownership store. macOS uses Seatbelt and a
supervised process group; a spawn adapter preserves that group for Bun. On
Apple silicon the adapter is universal `arm64`/`arm64e`, so arm64e system
tools such as `/bin/cat` can load it. Linux
requires [Landlock ABI 9](https://docs.kernel.org/userspace-api/landlock.html), private user/mount/PID/IPC namespaces, read-only mounts
and seccomp. Windows uses restricted tokens, private ACLs, an isolated desktop
and an owned job object. Commands inherit only their explicit standard handles.
The supervisor acknowledges completion after all descendants stop, including
background children. Long-running unrelated executions keep their immutable
bases; their eventual publication cannot resurrect reverted contributions.

External MCP servers and command-template shell substitutions cannot currently
provide this ownership contract and are refused in captured execution mode.
Legacy V2 execution is refused in
this mode because its message store is a different contract. Ordinary runtimes
without verified artifacts retain their previous execution behavior.

## Transaction and recovery

`session-revert-coordinator.js` fences only the affected tree, then cancels its
provider admissions and awaits native termination. It records previous
conversation markers before calling the companion with `files: false`. That
mode persists through repeated Revert, Redo, cleanup and runtime restart.
Direct requests cannot trigger the companion's broad filesystem restore while
captured execution is enabled.

Before the file decision, a failure restores conversation markers. After the
decision, restart recovery continues the recorded operation projection. Recovery
never replaces unexpected newer foreign bytes; ambiguous recovery keeps its
fence and returns `mutation_recovery_required`. The host retries pending
transactions during startup. No project transaction spans a command, generation
or cancellation wait. File-card Undo/Redo uses the same ownership coordinator.

The UI sends Revert before attempting cancellation, so the coordinator can keep
earlier descendant dispatches running. Only a legacy `session_busy` response
triggers the previous tree-abort retry. Optimistic hiding and acknowledged
composer restoration are retained; activity follows authoritative events.

Each reconciled execution base has a durable Git ref while preparation, execution
or recovery consumes it. Cleanup requires a terminal lease, proof that native
writers have stopped and no active consumers. It removes the private view while
preserving termination receipts, publication history and conflict objects. Snapshot ref identity commits before pin installation. Terminal leases carry durable pending cleanup; recovery also discovers older uncleaned terminal records and isolates each lease failure. Cleanup failures are reported separately from a successful publication and retried on recovery. Private read-only directories can be removed after these guards pass without following symlinks to project or dependency inputs.
Captured content is stored as immutable content-addressed objects. An observed
file is hashed first; content already in the store is not copied or synced
again. New object data is synced before its hard link, and the objects
directory is synced once before the next ledger commit that can reference it.
Observation treats a path under a file or symlink ancestor as absent. The
ancestor is observed instead and is never followed, so replacing a tracked
directory does not block later executions. Writes into the project still refuse
such paths. Symlink targets are captured and restored as raw bytes.
Execution views are disposable, since a crash cancels their lease and a view is
never published after one. View files are copied without sync, while writes
into the project stay synced. Reconciliation and view preparation overlap
per-file I/O (eight at a time, results in order) and install observed files in
batches of 128 per ledger transaction.
Host ownership is proven by the native supervisor's OS lifetime lock. An empty
in-memory map, heartbeat expiry or a reused PID cannot establish writer death. Failed keeper initialization remains single-flight and becomes retryable only after the failed child is reaped; unconfirmed termination blocks replacement. Independent shutdown paths still drain when keeper initialization fails.

Historical snapshots alone do not establish ownership. Missing exact execution
evidence returns `mutation_history_unavailable` before changing messages or
files. Runtime incompatibility, cancellation failure and recovery failure have
distinct errors. Bounded journal events carry request, transaction, session,
message, phase and error identifiers without file contents or tool arguments.

## Build and rollout

The [companion manifest](../packages/web/server/lib/opencode/companion/manifest.json)
pins OpenCode 1.18.31 at `014614d35b397775e5d397a490fc72368c894ec2`, the full patch
digest and every changed source file. `bun run build:revert-runtime` prepares the
pinned checkout inside `.cache`, verifies source, checks types and regression
tests, builds the companion and native supervisor, and runs real execution
acceptance. It uses frozen dependency fixtures and no live provider credentials.
An authorized existing checkout may be supplied with `--source`; it is never
reset. No installed runtime or user profile is changed by this build.

A companion that passed its type and regression checks is cached under
`.cache/revert-runtime-companion`. The cache key covers the pinned commit, patch
digest, runtime version, platform and Bun version, and the entry is reused only
when its recorded digest matches. The native supervisor build and DevRyan
execution acceptance always run. `DEVRYAN_REVERT_COMPANION_ONLY=1` stops after
the companion step; the `Warm release caches` workflow uses this on `main`,
because caches saved by a tag-triggered release are visible only to that tag.

Only successful acceptance writes the runtime manifest. The current paired
companion is `1.18.31-devryan.13`, with execution preparation protocol 2 and
retention protocol 1. The host verifies the required
capability versions, platform, architecture and artifact digests before enabling
capture. Artifacts live under `packages/web/runtime/<platform>-<arch>`; Electron
ships them under `Resources/revert-runtime`. An explicit
`DEVRYAN_EXECUTION_ARTIFACTS` directory supports isolated verification. Electron
packaging verifies artifacts before signing, refreshes digests after its owned
ad-hoc signing operation, and reseals/verifies the application. Releases ship
Apple silicon only (`supportedArtifacts: ["darwin-arm64"]`), built and tested on
a native macOS arm64 runner. The npm package includes those same artifacts.
Packing verifies every declared supported architecture before staging and
verifies the staged copies. Intel Macs are no longer a supported artifact
target, so the host there runs managed sessions without native capture, as on
other unsupported platforms.
Its release staging restores executable permissions after verifying downloaded
artifact hashes, so normalized CI download modes cannot make the runtime fail
to start.

Supported bundled modes require the expected artifacts even when files are
missing. Startup records `required_unavailable`, keeps the server and `GET /api/diagnostics/execution-runtime` accessible, and returns `execution_artifacts_unavailable` (503) for affected execution. Managed runtime spawn, prompt/command/shell routes, the private tool bridge and Cursor starts enforce this state. There is no uncaptured fallback. Explicitly
external or unsupported runtime modes retain their documented ordinary behavior.
Deploy or roll back the host and companion together. A preparation rollback must
retain a host that can read whole-content revisions and retained conflict objects;
do not point a pre-migration ledger implementation at new history.

The real dispatcher journey is `scripts/verify-concurrent-revert-execution.mjs`.
Set `DEVRYAN_TEST_REVERT_UI=1` to additionally exercise the actual web and Electron
Revert control, restored composer, concurrent command and late publication.
Supply `DEVRYAN_TEST_ELECTRON_BINARY` from `scripts/qa/package-electron.mjs` for
the packaged Electron journey. Its isolated bootstrap uses a mock OS keychain,
private profile and home, and disables background Bots and protocol registration.
Verification results and platform availability are recorded in the
[implementation audit](audits/2026-09-20-concurrent-revert/README.md).

## Execution admission deadlines

Protocol 2 separates the 25-second admission reservation from project preparation.
Authenticated polls wait at most 20 seconds and return `preparing`, `ready` or a
typed failure without replaying the tool. Preparation has a 15-minute overall
budget and a 60-second progress watchdog; waiting for one of the four fair
per-root I/O slots counts toward the overall budget, without being classified as
a stalled file operation. Waiting callers share the producer's real progress while retaining their own cancellation and overall deadlines. A poller absent for 60 seconds cancels its preparation and attempts guarded cleanup after all owned I/O settles.

Observation must start at or after reservation. A fresh fence pins the reconciled
base before materialization outside the project lock. Immutable base listings
are shared through a bounded cache; observation retries at most four passes across both file-stamp changes and concurrent ledger publication. Continued changes return retryable `workspace_changing` without installing a stale or incomplete base. Both installation guards remain enforced; stat caches are hints, while publication
checks fresh contents. The cache does not eliminate every per-execution map.
Cancellation waits for owned I/O and cannot release another owner's lock or
launch an expired request later. Git children are killed and reaped. Accepted
publication and recovery commits retain ownership until they settle, even when
a caller stops waiting. These budgets are not hard deadlines for an
uninterruptible operating-system call or durable commit.

Failed preparation uses an independent five-second cleanup budget. The companion
preserves the original error if its cancellation receipt cannot be confirmed;
a failed begin has not launched the tool. Errors after launch still require the
native receipt before claiming a known outcome. No timeout causes automatic replay.

Companion tool-worker and owned Cursor prompt/title requests are frozen and checked against a 16 MiB UTF-8 limit before
admission and again after view-specific expansion. Oversized requests fail with
`payload_too_large`; conversation history is never truncated to fit. Cursor resolves and checks the final view-specific wire input before spawning, and its worker reader enforces the same bound. The companion checks cancellation again immediately before spawn and records cancel-before-start if it has already been aborted. Selected
skills carry their canonical source and digest of the mapped bytes. Workers
validate that binding, use one explicit skill directory and do not refetch URL
skills or discover unrelated sources.

`session_execution` journal records include bounded session/message/call IDs,
phase, outcome and elapsed milliseconds. Phases distinguish admission, queue
waiting, reconciliation, lease preparation and cleanup. Host requests and
preparations are summarized: one `admission` record carries per-phase counts and
time in `steps` (`phase:count/ms`). Host requests write it only when they failed
or took at least 250 ms; each preparation writes one. A phase is journaled on its
own when it fails, or as started/completed once it runs for 2 s, so a hang stays
visible while it happens. They contain no tool arguments, contents, credentials or
project paths. The shared chat keeps a
sanitized failure notice even when no assistant exists or provider recovery is
unavailable. Viewed state does not hide it; a newer authoritative successful
completion resolves it. Sanitized classifications survive reload in the bounded
notification store. Failed grouped tools are labelled as failures.

See the [2026-09-21 implementation report](audits/2026-09-21-plan-implementation/README.md)
for current validation, platform limits and rollback guidance.

Preparation polling spends the same request budget on identity checks, lease lookup and waiting. Poll waits reserve one second for the response and return `preparing` when the remaining budget is exhausted. Completed enumeration, unchanged-file checks and reconciliation batches advance the progress meter. Bounded `identity_lookup`, `lease_lookup` and `poll_wait` diagnostic phases distinguish polling overhead from reconciliation. Cleanup failures are reported separately without replacing the preparation error. Compact skill rows retain the skill name and show loaded or failed outcomes, including sanitized preparation errors.
