# Web Harness Host

The web harness host is initialized from the resolved `DEVRYAN_DATA_DIR`.
It records sanitized canonical and synthetic OpenCode events, prompt/control
records, lifecycle transitions, worktree receipts, and evidence transitions.
The control journal is mounted before primary recovery (which answers a primary
abort itself) and hands each journaled control to the server's single
`setControlObserver` callback with its response. The separate awaited
`setControlPreparation` persists an explicit managed user Stop before forwarding
the native abort. The response accepts the exact pending receipt on2xx or
withdraws it on non-2xx; only acceptance establishes user-stop provenance.
Lost responses expire as uncertain explicit recovery through the scheduler abort bound. Observer failures never block controls,
while preparation failures return a fixed503 response.
The control journal also keeps each abort's `X-DevRyan-Abort-Source` in a
bounded per-session registry (`readAbortSource(sessionID)`, 60-second TTL). A
non-2xx abort withdraws its own entry and an accepted prompt clears it, so the
gen-2 event projector can attach the source to the interrupt it causes as
`MessageAbortedError` `data.source`.
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

## Native integration tests

`native-integration/` holds harness-runtime behaviour tests that need web-host
modules (native admission, the native consumer fixture, orchestration private
host, Claude stderr diagnostics). They run under Bun from the web `test` script
and are excluded from Vitest, so `@devryan/harness-runtime` tests never
import the web server.

`setControlPreparation` is mandatory, awaited control admission. Failure returns fixed `control_preparation_failed` HTTP503 before forwarding. It is separate from advisory `setControlObserver`; managed operator Stops persist request-scoped intent through preparation before native abort.
