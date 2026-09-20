# Concurrent Revert implementation and verification

The concurrent Revert path is integrated with the verified DevRyan OpenCode
companion and native execution supervisor. Revert removes the selected chat's
contributions and affected descendants while unrelated chats continue. Redo
reactivates the same operations. Existing installations without accepted runtime
artifacts retain the legacy path; incomplete confinement cannot enable capture.

The retained incident journal contained no matching failure and reported no gaps.
The original false busy incident remains unconfirmed. The legacy admission path
now validates live session identity and canonical project boundaries instead of
trusting every entry in the runtime's status map.

## Integrated implementation

- The pinned OpenCode **1.18.31-devryan.2** companion accepts legacy
  `files: false`, persists `fileRestore: false`, and preserves that decision
  through repeated Revert, Redo, cleanup, restart and V2 marker interoperability.
  Captured executions cannot invoke broad native filesystem restoration.
- The shared harness ledger persists immutable execution bases, prompt and call
  identities, dispatch ancestry, publication order, file revisions and operation
  decisions. Projection preserves foreign contributions, including independent
  edits on one line, successive replacements, repeated text, UTF-8 characters,
  creation/deletion, rename ancestry, binary revisions and POSIX permissions.
  A private `0600` file remains private through publication and Revert.
- Native Write/Edit and other dispatched tools, Context Mode, native tasks,
  managed descendants and Cursor executions use confined private views. Context
  Mode retains its logical project identity. Claude's Meridian passthrough uses
  a separate confined provider transport with read-only project access. Root and
  nested dependency directories are read-only inputs.
- The coordinator fences only the selected dispatch tree, cancels its admissions
  and requires authoritative process-tree termination. Conversation markers and
  operation decisions are durable before materialization. Recovery either
  completes the recorded phase or retains the fence with a specific error; it
  never overwrites unexpected newer foreign bytes. Canonical worktree locking is
  shared by requests, startup recovery and file-card Undo/Redo.
- The existing routes and response envelopes remain connected to optimistic
  hiding, composer restoration and failure reconciliation. The UI lets the
  coordinator choose cancellation scope; only legacy `session_busy` falls back
  to the old tree-abort retry. Unrelated status entries do not block capture.
- Journal events contain bounded transaction, session, message, phase and error
  identities. Missing ownership evidence, incompatible runtime, cancellation
  failure and recovery failure have distinct outcomes. Historical snapshots
  alone never authorize attribution or modification.
- Build and packaging provision the pinned companion, native supervisor and
  accepted artifact manifest together. Host admission verifies source identity,
  capabilities, platform, architecture and binary hashes. macOS release jobs
  build and test each shipped architecture natively. Electron copies the same
  artifacts and verifies them before and after its owned signing operation.
  Downloaded CI artifacts regain executable permissions only after hash
  verification. Packaged Electron resolves its resource directory when the
  development flag is explicitly `0`.

The [runtime contract](../../CONCURRENT_REVERT.md) documents compatibility and
recovery. The [companion patch](../../../packages/web/server/lib/opencode/companion/README.md)
records the upstream commit, patch digest and all 28 changed source hashes.

## Verification evidence

- Companion type checking and **48 regression tests passed**, covering legacy
  markers, cleanup, HTTP session routes and workspace routing. The compiled
  runtime reports `1.18.31-devryan.2`. Applying the patch to an independent clean
  checkout reproduced every recorded source hash.
- **8 macOS native acceptance tests passed**, including absolute paths,
  symlinks, hardlinks, inherited handles, metadata mutations, detached and
  background descendants, cancellation and late publication across Revert.
- The real compiled runtime journey passed concurrent Revert/Redo and late
  command publication; native Write/Edit; attachment expansion; Context Mode
  execution and retrieval; native and managed descendants; active target
  cancellation; and Cursor publication, cancellation and a new prompt.
- The compiled-Bun Claude transport probe passed its read-only project and
  unchanged stdin/stdout checks. Both reviewed Meridian bundle versions
  (1.62.6 and 1.68.0) passed patch application and idempotence checks.
- Isolated **web and actual packaged Electron** journeys passed the real Revert
  control, acknowledged composer restoration and unrelated command publication.
  Electron used its bundled runtime artifacts, real preload and in-process web
  backend, a disposable profile/home, mock OS keychain and disabled background
  Bots. SQLite and PTY native-module smoke checks passed. No live provider
  credentials or installed-app state were used.
- A direct execution probe from the packaged Electron process resolved its
  bundled supervisor, wrote inside the private view, rejected an outside write
  and returned an authoritative termination receipt.
- Ownership, coordinator, route, UI and artifact-integrity suites cover retries,
  earlier boundaries, hidden descendants, other projects, stale/deleted status,
  independent file Undo, crash phases and refused unsafe recovery. Full
  validation caught a permission comparison on deletion markers; the corrected
  projection passes the existing shadowed-creation/deletion regression.
- Final `DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full` **passed**:
  workspace lint, type checks, documentation checks and every deterministic
  suite, including 644 repository script tests and 4,168 web server tests.
- Final `bun run build` **passed** for web and Electron. `bun run bundle:check`
  **passed** with 4,727,716 raw startup bytes and 1,391,110 gzip bytes, both below
  their budgets. Runtime artifact verification and `git diff --check` passed.

## Availability and limits

Linux and Windows native acceptance is **unavailable on this macOS host**.
Their launcher implementations are present, but no accepted artifacts are
produced here. The available Linux VM lacks the required Landlock ABI 9 and
compiler. Windows restricted-token/job behavior and macOS Intel native behavior
were not exercised locally. These platforms must pass native acceptance before
concurrent capture can be enabled; source implementation is not a platform pass.

The Electron QA package is unsigned. Release signing/notarization, updater
installation, OS keychain integration and live provider services were not
exercised. External MCP execution, command-template shell substitutions and the
different V2 execution store are explicitly unsupported in captured mode.

Earlier verification attempts exposed an unchanged short-timeout script test
under concurrent build load and rejected QA packages whose source changed
during packaging. Script tests can run serially with
`DEVRYAN_SCRIPT_TEST_CONCURRENCY=1`; assertions and timeouts were not weakened.
The package source-identity guard remains enforced.

Local logs and UI screenshots are retained under `.cache/concurrent-revert/`;
isolated package manifests are under `.cache/qa/`. They document local acceptance,
not release signing evidence. The user's running runtime was not stopped and
the implementation was not deployed into their installed application.

The final run records are `validate-full-bundled.log`, `build-bundled.log`,
`bundle-bundled.log`, `ui-bundled-journeys.log` and
`packaged-native-execution.log`. The retained packaged application and source
manifest are in `.cache/qa/packaged-electron-KoFXAP/`. Obsolete owned QA app
copies were removed while retaining their evidence records.
