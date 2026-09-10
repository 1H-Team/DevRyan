# Concurrent prompt revert: implementation checkpoint

## Status

The requested user-facing fix is **not enabled**. The existing scoped Revert,
Redo, file Undo, and execution adapters still use their existing contracts.
The new modules are internal, unexported implementation work, exercised only by
disposable tests. They must not be treated as an execution sandbox or connected
to production routes before the remaining contracts are established.

## Implemented foundation

- `packages/harness-runtime/lib/session-mutation-text.js` implements byte-preserving
  text operations anchored to immutable content runs, with insertion ownership,
  deletion ownership, and replacement ancestry.
- `packages/harness-runtime/lib/session-mutations.js` captures private execution
  views, stores immutable file objects and operation records using the existing
  private Git metadata store, and publishes attributed text changes.
- Prompt boundaries and recorded descendant relationships select revert operations
  by publication sequence. Generation fences reject existing late publications;
  callers must carry the dispatch parent's generation for new descendants.
- Revert and Redo toggle recorded operations. Repeated reverts accumulate the
  operation set for Redo. Materialization intent precedes filesystem changes and
  supports idempotent recovery from interruption.
- Filename and executable-mode ownership are independent of later content edits.
  Deletion tombstones prevent shadowed file creations from reappearing.

## Runtime contracts still required

The repository-local OpenCode 1.18.29 fixture was inspected without accessing an
upstream repository or the sibling OpenCode checkout. Its native revert routine
calls snapshot restoration and patch-file restoration before setting the session
revert marker. Its session-update payload exposes title, metadata, permission,
and archive time, but not the revert marker.

No supported integration has yet been verified that changes the native
conversation boundary independently of shared-file restoration. Temporarily
rewriting stored patch parts is not an established replacement contract: it
introduces observable intermediate history and additional recovery races.

Likewise, existing tool hooks are observation hooks, not complete write
confinement. A private `cwd` or rewritten path cannot confine absolute paths,
symlinks, and arbitrary subprocesses. The dependency symlink in a captured view
is writable unless a launcher enforces isolation. The new runtime must not be
exposed as a general command launcher in its current form.

The next work requires a verified provider/runtime boundary for:

1. Private physical execution paths with stable logical project identity,
   enforced write confinement, cancellation, and acknowledgement after writers
   stop and publication completes.
2. Authoritative conversation rollback without native writes to the shared
   checkout, including interruption and restart recovery.
3. Durable dispatch identity across native tasks, Context Mode, provider-native
   execution, retries, reused children, and UI mutations.
4. Explicit rename evidence when an execution renames and atomically rewrites a
   file. Inode comparison alone does not establish identity for that case.

Access to the sibling OpenCode checkout has been requested because the
repository's agent instructions explicitly require permission. It has not been
accessed as part of this work.

## Remaining integration and acceptance work

- Integrate every supported mutation adapter before switching Revert/Redo or
  removing the directory-wide guard.
- Add transaction recovery spanning native conversation state and file state,
  and migrate only exact surviving historical evidence.
- Unify conversation revert and file-only Undo/Redo operation selection.
- Establish cancellation/background-process, rename/rewrite, symlink, provider,
  and platform confinement acceptance coverage and performance budgets.
- Complete isolated web/Electron verification after integration. Unit tests of
  the new internal modules do not establish these runtime guarantees.

## Verification

- New module tests: 17 passed, 0 failed, 2,038 assertions. A subsequent focused
  test for invalidating Redo on a new prompt also passed (18 tests total).
- `bun run validate:full`: lint, type checks, and documentation validation passed.
  The scripts suite failed before package suites ran: 580 passed and 2 failed.
  Failures were in `scripts/qa/host-readiness.test.mjs` and
  `scripts/qa/initial-bootstrap.test.mjs`, which do not import the new modules.
- A focused retry of those two files passed 11 tests and failed 1. Host readiness
  passed; the bootstrap request-count assertion still observed 4 requests instead
  of 3. No unrelated QA assertions were changed.
- `bun run build`: passed for web and Electron.
- `bun run bundle:check`: passed.
- Live web/Electron and native confinement acceptance checks have not been run:
  the new execution and revert adapters are not integrated.

Local logs are in `.cache/concurrent-revert-verification/` (ignored build/test
output, not release evidence).
