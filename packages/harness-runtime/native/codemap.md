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
`--inspect-job-boundary` reads the containing job's limit flags without changing
that job. It repeats the draft UI-limit call on a new empty job and records the
actual error and read-back flags. The probe creates no child, permits no
breakaway, and grants no confinement or admission authority. The host verifier
retains this diagnostic in `host-boundary-evidence.json` for each architecture;
collecting a failed UI-limit result is distinct from accepting that UI policy.
The supervisor retains its original parent handle only after comparing parent
and supervisor creation times, so a recycled parent PID cannot become an owner.
`verify-windows-host-boundary.mjs` and `verify-windows-filesystem-boundary.mjs`
also exercise private SDK creation and the retained byte-range host-owner lock:
live ownership, ordinary close and abrupt keeper death are independent probes.
`.github/workflows/windows-lpac.yml` runs those probes and exact Node/Bun startup
on both native architectures without installing the workspace. It cannot
satisfy the complete Windows acceptance inventory or grant admission.
The host verifier also executes early cancellation and a running descendant,
requires the private flushed receipt and observes no later heartbeat writes.
Wrong creation identities and unrelated event names refuse while the real
supervisor stays alive. Cancellation retains the target process handle,
compares its creation time and actual parent with the calling host, and derives
the private event name from that exact supervisor identity. No bare PID can
signal an event. These remain independent prerequisites: they do not attest
complete read confinement, runtime admission or the full acceptance inventory.

The policy-3 draft creates a unique Less-Privileged AppContainer identity,
opts out of ambient All Application Packages access, and keeps the complete
job/UI/handle boundary. `windowsSessionExecutionProfile` binds the view, scratch
and cache through a bounded UTF-16 policy. The cache cannot contain the private
runtime root. The selected executable is copied through a pinned no-follow
handle into a read-only sibling; its installed ACL is untouched. Scoped data
grants exclude ACL ownership, and OWNER RIGHTS suppresses implicit WRITE_DAC.
The startup diagnostic now runs the exact production source with Node and Bun;
the seven historical restriction variants remain retained evidence. Successful
termination also requires LPAC profile settlement. Native startup, private read
denial, complete resource projection, abrupt-death profile recovery and all
existing safety cases must qualify before this draft receives acceptance.
The fixed capability set keeps the existing three network grants and adds only
Windows `registryRead` for LPAC system/DLL initialization. It uses the SDK's
`DeriveCapabilitySidsFromName` through `onecoreuap.lib`; it grants no registry
writes or file access outside the scoped package ACLs. Both native runtimes
still require actual startup and complete safety qualification.
New private desktops and child process/thread defaults use their own generic
object descriptor, rather than reusing file data access bits. No inherited
desktop or station ACL is changed; file grants still exclude ACL ownership.
`--read-private-file` holds the no-follow file and its ancestors through the
bounded read, rejects non-private ACLs and hard links, and returns the identity
before binary bytes. Windows termination receipts are created with a protected
current-user/SYSTEM descriptor and write-through handle; their ancestors remain
pinned until the termination receipt flush finishes.
Execution layout checks hold all parent paths, require one private parent for
view, scratch, binary policy and receipt, and reject cache/runtime overlap by
native volume/file identities. Case or short-path aliases cannot bypass those
checks. The identities remain retained through drain and receipt publication.
