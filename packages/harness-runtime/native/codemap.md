# Native execution boundary

`session-execution.c` supervises one private command and its descendants. macOS
uses an inherited Seatbelt profile. The Linux implementation uses Landlock ABI 3
and seccomp, but has not passed platform acceptance and is not approved for
production admission. Artifact verification returns false for Linux until
metadata and IPC escape mediation is complete. Windows support remains
unimplemented. The remaining metadata restriction gap is documented in the
[kernel Landlock API](https://docs.kernel.org/userspace-api/landlock.html#filesystem-flags).

The supervisor closes inherited descriptors, retains the leader until its group
contains no live writers, and fsyncs a termination receipt outside writable
execution roots. JavaScript owns output delivery and ledger publication. An
abort request, process exit without a receipt, or an empty host map cannot prove
termination.

Build with `scripts/build-session-execution.mjs`; run the explicit native suite
with `scripts/verify-session-execution.mjs`. These checks use disposable roots.
The source and helper are internal implementation work, not enabled in the
production host or shipped native artifacts.
