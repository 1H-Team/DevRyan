# Web Harness Host

The web harness host is initialized from the resolved `OPENCHAMBER_DATA_DIR`.
It records sanitized canonical and synthetic OpenCode events, prompt/control
records, lifecycle transitions, worktree receipts, and evidence transitions.
Shell tool calls are registered with the shared deadline controller without
persisting command text. Its host adapter performs authenticated, directory-
scoped exact-message reconciliation, one session abort, and a managed-runtime
restart only when that session is the sole active operation. External runtimes
and concurrent work are preserved and reported as unresolved recovery state.
Prompt routes return `503` with `Retry-After` until initialization finishes and
after bounded shutdown draining begins. Health and static routes remain
available.

Diagnostics are always enabled and remain local until the user explicitly
exports a bundle.
# Primary provider recovery host

`provider-recovery.js` composes the shared harness controller, managed-task
barriers, session-token reauthorization and Express request middleware.
`runtime.js` feeds canonical events before journal trimming and drains the
controller with the host. Electron inherits this in-process backend. The private
orchestration bridge carries the bundled plugin handshake and execution guard.
See `docs/PROVIDER_RECOVERY.md` for policy and release gates.
