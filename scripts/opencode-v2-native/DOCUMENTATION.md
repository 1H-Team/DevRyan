# OpenCode 2 native verification scripts

Contract notes for the compiled-package qualification run by `node scripts/verify-opencode-v2-package.mjs`. Commands and the build step are in [QA](../../docs/QA.md#opencode-2-compiled-package); the case implementations live in the lane modules in this directory (`package-*-lane.mjs`) and in `scripts/verify-opencode-v2-package.mjs`.

## Compiled package lanes

Package qualification uses the compiled controller and writer with the real
web admission owner, scheduler, ledger and supervisor. Only HTTP model responses
are fixture data. Separate assertions cover asset initialization and full server
execution while the supervisor denies reads of the repository's `packages`,
`scripts` and `node_modules`. The importer works on consistent disposable copies,
with relocated projects and private configuration/data roots. The runtime payload is deleted on pass (`--keep-artifacts` /
`DEVRYAN_KEEP_ARTIFACTS=1` keeps it); `result.json` and logs are retained, and
failed attempts keep everything, under `.cache/v2-validation/package-*/result.json`; incomplete
mandatory lanes, changed source or incomplete cleanup keep the exit nonzero.
This command does not activate a bundle in the installed app.

Every compiled host (the package process, each fresh lifecycle driver and the
parent-death owner) also writes the production web diagnostic journal into its
descriptor's `web-data/harness/journal`; the in-memory diagnostic arrays are a
tee of the same records. Case `compiled-durable-journal-roots` grades the
selected candidate, the baseline and the SIGKILLed parent-death candidate, and
passes only at 3/3. A missing root or one without chunks is unavailable, never
passed. A present root needs sealed chunks (the parent-death root is sealed by
the next owner's journal recovery), at least one `lifecycle` record, an empty
`node scripts/journal.mjs --dir <root> gaps --verify` run recorded under
`package-*/journal-gaps/`, and every record reconciled to the writer that
accepted it. Case `compiled-seeded-credential-first-boot` prepares a fresh
initialization whose `native-setup-credentials.json` (one fake API key) is
present at first boot, then proves the controller started, unlinked the seed
after stamping its digest, restarted, and holds the imported credential.

## Upgrade qualification against a retained baseline

Bundle A then runs the baseline controller and bundle B the candidate. Clones
cover both reviewed source layouts:

- **Legacy.** The main lane imports the legacy fixture, which keeps
  `__drizzle_migrations`. Case `compiled-clone-layout-legacy` checks it.
- **Fresh install.** A separate control root under `fresh-install-upgrade/`
  starts from the production empty source, as every real 2.x install does: a
  zero-byte `empty.db` with no legacy journal and an identity workspace map.
  Case `compiled-clone-layout-fresh-install` checks it. The baseline importer
  and controller create and run A. Then:
  - `compiled-fresh-install-clone`: the clone gate admits the A→B clone of the
    closed database. The clone captures A's credentials through A's own
    controller, which may drain pending WAL frames into `opencode.db`. So this
    case compares A's database by schema and rows, and every other file byte
    for byte. `sourceWalCheckpointed` reports whether a drain happened.
  - `compiled-fresh-install-rollback`: B's controller runs its own work, then
    rolls back. A's original controller receives B's credentials. A's history and
    migration IDs are unchanged, and A's controller restarts the rolled-back
    database.

The exact reviewed layout and release pair are asserted only when the versions
differ. A same-release run checks only that each kind has or lacks the legacy
journal, and its gate result says so.

The migration fixture contains two independent relocated Git projects, exact
conversation/tool IDs, compaction dispositions, attachment bytes, ordered
permissions, and separate web/native configuration trees. A lost import
acknowledgement must recover from the real persisted importer receipt on an
exact preparation retry. Rollback first quiesces the actual candidate; its
synthetic-copy reconciliation requires unchanged independent baseline roots
and retains the complete candidate and project work. The selected baseline
then launches the accepted generation-one companion through the production
lifecycle, with offline model fetch and automatic update disabled, and reads
all fixture sessions through real HTTP routes.

The package also exercises the configured command executor, native manual
compaction, formatter subprocess, per-location read boundaries, and a tracked
primary background notice resumed after controller replacement. The latter
requires the original objective and saved selection, a fresh runtime handshake,
exactly one canonical continuation, and another real writer after replacement.
The separate parent-death fixture waits for a real confined shell, kills only
its owned Node process, and checks every observed descendant plus both real
controller and worker termination receipts before requiring no publication.
Its explicit constructor-owned local grant is smoke-test policy; it does not
substitute for production authentication contract tests. Release signing and
other-platform support remain separate qualification gates.

## Synthetic provider catalog preflight

Preflight also seeds active synthetic OpenAI, Cursor and GitHub Copilot
credentials through the baseline's compiled SDK, preserves them across the
clone, and asserts their model rows in both locations on both releases.
Copilot discovery uses a fixture HTTP server restricted to loopback;
no external credential or provider is used by this check.
