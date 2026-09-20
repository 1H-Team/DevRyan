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
keeps UTF-8 characters intact; binary content is owned as complete revisions.

## Execution and persistence

`packages/harness-runtime/lib/session-mutations.js` owns immutable file versions,
execution bases, operation identities, publication order and projection. Git
subdirectories share one canonical worktree ledger; separate worktrees remain
separate. Non-Git projects use their canonical directory. Git ignore rules do
not hide project file contributions. Dependency directories and Git metadata
are inputs rather than published mutations. Private views preserve HEAD and the
index for inspection; commits and branch changes inside those views do not
change the original repository metadata.

The companion dispatches native and custom file tools in private views. Context
Mode shares its logical project cache across those views. Native task and managed
orchestration dispatches register parent call identities before starting children.
Cursor uses one confined process per turn, mirrors canonical conversation
records, and awaits publication before completion. Claude through Meridian uses
passthrough tools and a separate read-only provider transport. Provider API
credentials are not diagnostic evidence or execution ownership.

Native enforcement, not a working directory convention, prevents writes to the
original project, dependencies and ownership store. macOS uses Seatbelt and a
supervised process group; a spawn adapter preserves that group for Bun. Linux
requires [Landlock ABI 9](https://docs.kernel.org/userspace-api/landlock.html), private user/mount/PID/IPC namespaces, read-only mounts
and seccomp. Windows uses restricted tokens, private ACLs, an isolated desktop
and an owned job object. Commands inherit only their explicit standard handles.
The supervisor acknowledges completion after all descendants stop, including
background children. Long-running unrelated executions keep their immutable
bases; their eventual publication cannot resurrect reverted contributions.

External MCP servers and command-template shell substitutions cannot currently
provide this ownership contract and are refused in captured execution mode.
Native Context Mode tools remain supported. Legacy V2 execution is refused in
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

Only successful acceptance writes the runtime manifest. The host verifies both
capability versions, platform, architecture and artifact digests before enabling
capture. Artifacts live under `packages/web/runtime/<platform>-<arch>`; Electron
ships them under `Resources/revert-runtime`. An explicit
`DEVRYAN_EXECUTION_ARTIFACTS` directory supports isolated verification. Electron
packaging verifies artifacts before signing, refreshes digests after its owned
ad-hoc signing operation, and reseals/verifies the application. Release jobs
build and test each shipped macOS architecture on a native runner. The npm
package includes those same artifacts.
Its release staging restores executable permissions after verifying downloaded
artifact hashes, so normalized CI download modes cannot make the runtime fail
to start.

The real dispatcher journey is `scripts/verify-concurrent-revert-execution.mjs`.
Set `DEVRYAN_TEST_REVERT_UI=1` to additionally exercise the actual web and Electron
Revert control, restored composer, concurrent command and late publication.
Supply `DEVRYAN_TEST_ELECTRON_BINARY` from `scripts/qa/package-electron.mjs` for
the packaged Electron journey. Its isolated bootstrap uses a mock OS keychain,
private profile and home, and disables background Bots and protocol registration.
Verification results and platform availability are recorded in the
[implementation audit](audits/2026-09-20-concurrent-revert/README.md).

## Execution admission deadlines

The private execution bridge applies one 25-second budget to admission reads,
project queue waiting, reconciliation and lease preparation. Queue cancellation
cannot release an active owner's lock or launch an expired request later. Git
children are killed and reaped on cancellation; filesystem preparation checks
the budget between operations. Accepted publication and recovery commits retain
ownership until they settle, even when a caller has stopped waiting. This is not
a hard deadline for an uninterruptible operating-system call or durable commit.

Failed preparation uses an independent five-second cleanup budget. The companion
preserves the original error if its cancellation receipt cannot be confirmed;
a failed begin has not launched the tool. Errors after launch still require the
native receipt before claiming a known outcome. No timeout causes automatic replay.

`session_execution` journal records include bounded session/message/call IDs,
phase, outcome and elapsed milliseconds. Phases distinguish admission, queue
waiting, reconciliation, lease preparation and cleanup. They contain no tool
arguments, contents, credentials or project paths. The shared chat keeps a
sanitized failure notice even when no assistant exists or provider recovery is
unavailable. Viewed state does not hide it; a newer authoritative successful
completion resolves it. Sanitized classifications survive reload in the bounded
notification store. Failed grouped tools are labelled as failures.
