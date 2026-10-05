# Native execution boundary

`session-execution.c` supervises one private command and its descendants. macOS
uses an inherited Seatbelt profile. The Linux implementation uses Landlock ABI 3
and seccomp, but has not passed platform acceptance and is not approved for
production admission. Artifact verification returns false for Linux until
metadata and IPC escape mediation is complete. Windows execution remains
unqualified. The remaining metadata restriction gap is documented in the
[kernel Landlock API](https://docs.kernel.org/userspace-api/landlock.html#filesystem-flags).

The supervisor closes inherited descriptors, retains the leader until its group
contains no live writers, and fsyncs a termination receipt outside writable
execution roots. JavaScript owns output delivery and ledger publication. An
abort request, process exit without a receipt, or an empty host map cannot prove
termination.

`session-spawn-darwin.c` is the macOS spawn adapter inserted into confined
processes. It implements `posix_spawn` file actions (including the macOS 26
`posix_spawn_file_actions_addchdir`/`addfchdir` names) with fork/exec under
the same profile and process group. A detached spawn starts in that supervised
group; creating a new process group or session remains denied.

`session-group-darwin.h` gives such a child a virtual group, so the process
that started it can stop it. The child carries the group it asked for in
`DEVRYAN_SPAWN_GROUP` (named after its pid by the adapter, `n<pid>.<n>` by the
Node preload), and `kill(-pid)`/`killpg` deliver the signal to the members of
the supervised group that carry the name. macOS hides the environment of system
binaries, so the starter also names the leader: the leader and its descendants
without a readable name belong to the group. Node processes started through
`/usr/bin/env` or `/bin/sh` have no adapter; their preload asks the launcher
(`--signal-group <signal> <leader|0> <name>...`, exit 0 delivered, 3 no such
group, 125 malformed), which runs under the same profile. Nothing leaves the
supervised group and no process outside the sandbox can be signalled.
`DEVRYAN_WORKER_GROUP_SIGNALS=0` restores the kernel's answer (`ESRCH`).

Build with `scripts/build-session-execution.mjs`; run the explicit native suite
with `scripts/verify-session-execution.mjs`. These checks use disposable roots.
The source and helper are internal implementation work, not enabled in the
production host or shipped native artifacts.

`session-execution-windows.c` is the Windows SDK supervisor draft. Its standalone
identity operations query a no-follow file handle for volume/file ID, reparse
state, hard-link count, owner and protected ACL. Inspection requests read access
so an exclusive file lock refuses the identity; attribute-only access would
bypass that sharing boundary. Inspection and creation anchor the canonical
path's parents and refuse a reparse parent, even when the leaf itself has an
ordinary file identity. Exclusive private-directory and bounded private-file
creation hold every ancestor against write/delete
sharing and refuse reparse parents, traversal, device aliases and alternate
streams. Files explicitly name the current user as owner, use a protected ACL,
flush before reporting identity, and preserve a partial file on failed input.
The operations never replace a file or repair an existing ACL. Process probes query
creation time, liveness and containing-job membership from one held handle.
The supervisor retains its original parent handle only after comparing parent
and supervisor creation times, so a recycled parent PID cannot become an owner.
`verify-windows-host-boundary.mjs` and `verify-windows-filesystem-boundary.mjs`
exercise these native operations on each architecture. These are independent
prerequisites: they do not attest read confinement, descendant containment,
cancellation, runtime admission or the complete acceptance inventory.
