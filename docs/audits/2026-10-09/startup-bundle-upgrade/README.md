# Startup bundle upgrade (2026-10-09)

## Incident

After installing DevRyan 2.0.4, launch failed with
"DevRyan could not connect to OpenCode: Native runtime is not ready: version_mismatch".

- The app shipped OpenCode 2.0.26 (`revert-runtime/darwin-arm64/native-bundle.json`,
  manifest `8a951a7d…`).
- The selected bundle `default-native` (selection revision 1, prepared 2026-10-05)
  still pointed at the retained OpenCode 2.0.20 artifacts (manifest `0420e391…`).
- `/health` reported `openCodeVersion: "2.0.20"`, and `main.log` recorded
  `deferred OpenCode startup failed … version_mismatch`.

Cause:

1. Provisioning reused an existing selection unchanged.
2. `startOpenCode` accepted 2.0.20 because it is in `SUPPORTED_NATIVE_OPENCODE_VERSIONS`
   and launched its controller.
3. The readiness probe then required the 2.0.26 route pin.

The only upgrade path, Settings → Providers → Bundled runtime update, needs a connected
runtime, so it could not be reached. Every OpenCode bump since 2.0.2 had the same gate.

A second defect blocked even that path. The reviewed cross-release clone layout
(`REVIEWED_NATIVE_CLONE_LAYOUT`) was qualified only on databases imported from a legacy
v1 source, which keep `__drizzle_migrations`. Every 2.x install creates its database from
an empty source and has no such table, so `inspectNativeCloneLayout` threw and the clone
was refused with `bundle_v2_upgrade_compatibility_required`.

## Change

- `native-bundle-startup-upgrade.js` drives the existing lifecycle `upgrade` during
  provisioning, inside the bootstrap lock and before any data owner or controller
  starts. It runs only when:
  - the selected OpenCode version misses the pin,
  - the shipped artifacts carry exactly the pinned version,
  - the selected version is not newer than the pin.
- The cold owner is `neverStarted`. Every held step re-proves that no other process owns
  the source bundle: there is no live owner or controller in its managed-process
  registry, and no live holder of its orchestration owner lock.
- An unsealed candidate left by a killed attempt is moved aside before retrying.
- Failures keep the selection unchanged and are recorded. `startOpenCode` then refuses a
  below-pin runtime before launch with `bundle_upgrade_required`, naming the version
  pair and the recorded code.
- The old bundle becomes `previousBundleID`.
- POSIX only.
- `REVIEWED_NATIVE_FRESH_CLONE_LAYOUT` admits the fresh-install layout: no
  `__drizzle_migrations` table, schema `32957fae…`, `user_version` 0. All other gates are
  unchanged: reviewed core digests, contracts and migration level.

## Evidence

`fresh-layout.jsonl` compares two fresh databases:

- A read-only copy of the owner's real 2.0.20 database, created by the actual compiled
  2.0.20 controller.
- A fresh 2.0.26 database from the `@opencode/core` 2.0.26 migration mode.

They have identical DDL. The 48 migration IDs of 2.0.20 are an exact prefix of the
49 IDs of 2.0.26; the only addition is the data-only
`20261007190000_azure_cli_external_credential`.

`isolated-upgrade.jsonl` records two lanes in private HOME/XDG profiles outside the
repository. Both used the real artifact verifier, compiled controllers and credential
process. The owner's installed app and data were only read.

1. **Provision-twice.** Provisioning with the retained 2.0.20 artifacts selected a real
   2.0.20 bundle (10.6 s). A second provisioning with the shipped 2.0.26 artifacts
   upgraded it in 19.4 s:
   - revision 2, `native-8a951a7d49661c8df4e27886-r1`,
   - `previousBundleID: default-native`,
   - no recorded failure.
2. **Server boot.** `node server/index.js` (this change) started on a fresh 2.0.20 profile
   with `DEVRYAN_EXECUTION_ARTIFACTS` pointing at the shipped 2.0.26 artifacts.
   - It logged `upgraded the selected runtime from OpenCode 2.0.20 to 2.0.26`.
   - `/health` reported `isOpenCodeReady: true` and `openCodeVersion: 2.0.26` after 42 s.
   - The selected database had 49 migration rows: the 2.0.26 controller applied the Azure
     migration on boot. The rollback target stayed at 48.
   - Shutdown was graceful, with no leftover processes.

## Deterministic tests

- `runtime-bundle.test.js` runs real store clones through `provisionDefaultNativeBundle`
  and covers:
  - upgrading with data preserved, the rollback target kept, and a second launch as a
    no-op;
  - refusing while an orchestration lock holder or registry owner is live;
  - no downgrade and no unpinned target;
  - replacing an interrupted unsealed candidate.
- `runtime-bundle-lifecycle.test.js` covers the never-started owner and owner-proof
  refusal.
- `lifecycle.test.js` covers `bundle_upgrade_required` before launch.
- `native-bundle-compatibility.test.js` covers the fresh layout and inspection.
- `scripts/opencode-v2-native/migration-fixture.test.mjs` covers the fresh-install
  source. `package-bundle-upgrade-lane.test.mjs` covers the per-kind layout
  assertion and the WAL-aware source snapshot.

## Validation

`bun run validate:full` ran while other repositories' test runs and a concurrent package
qualification held load averages of 40–136 on 8 cores.

- **Passed:** lint, type-check (every package), docs and the script, native `bun test` and
  bot package suites.
- **Stopped at `harness-runtime`:** one Git batch test took 121.7 s against a 120 s
  limit. That file passes alone (4/4).
- **Remaining packages, run separately:** `ui` passed (4067 tests). `web` passed 6526 of
  6545. Its 19 failures were 5 s default timeouts and one bounded exit deadline, in Git,
  retention, removal, harness and process files this change does not touch. One more was
  this change's no-downgrade test, which now has an explicit 60 s limit like the file's
  other fixture-heavy tests.
- **Reruns:** the failing files, rerun one by one at load ~136, failed further on timeouts
  alone. This change's suites pass under that load: four startup tests, and 60 lifecycle,
  bundle-lifecycle and compatibility tests.
- **Not established:** a clean full `web` run awaits an idle machine.

## Compiled package qualification of both layouts

Until this change the package qualification cloned only legacy-imported
baselines. Even `createEmptyRuntimeFixture` writes `__drizzle_migrations`, so the
fresh layout was never qualified. A new fresh-install lane
(`scripts/opencode-v2-native/package-fresh-install-upgrade-lane.mjs`) starts
from the production empty source: a zero-byte `empty.db` and an identity
workspace map.

The command, with a 2.0.26 candidate built from the current sources:

```sh
node scripts/verify-opencode-v2-package.mjs --artifact-root .cache/bundle-upgrade-fresh/candidate-2.0.26-darwin-arm64 --baseline-artifact-root .cache/opencode-upgrade/2.0.20/darwin-arm64
```

Attempt 7 passed 52/52 cases in 8 min 43 s: the earlier 48 plus the four below.
It left no remaining mandatory gates or cleanup failures, and the source cohort
was unchanged. Parent-death and the durable journal roots (3/3) passed.
`package-clone-layouts.jsonl` holds its sanitized rows:

- `compiled-clone-layout-legacy`: schema `86eba4fd…` with the legacy journal
  (`b0c489f7…`), checked against the reviewed layout for 2.0.20 → 2.0.26.
- `compiled-clone-layout-fresh-install`: schema `32957fae…`, no legacy
  journal. This is the layout that the actual 2.0.20 importer produced from
  `empty.db`.
- `compiled-fresh-install-clone`: the reviewed clone gate admitted the A→B clone.
- `compiled-fresh-install-rollback`: A's 2.0.20 controller first ran its own
  work. Then:
  - the 2.0.26 controller ran B; B reached 49 migrations while A stayed at 48;
  - rollback reached revision 3, with credentials projected through A's
    original controller and history not merged;
  - the 2.0.20 controller restarted the rolled-back database.

The clone captures A's credentials through A's own controller, and that process
drains pending WAL frames into `opencode.db` when it closes. A reproduction on a
retained bundle confirmed this: the WAL went from 8272 bytes to 0. In three of
the four package runs that reached the clone (attempts 1, 5 and 7), A's WAL
still held frames, so the fresh lane
compares A by schema and rows and requires any byte change to be exactly that
drain (`sourceWalCheckpointed`). The legacy lane keeps its byte-exact check,
which assumes the baseline's WAL is empty at clone time.

Attempt 7 ran at a load average of about 5. Earlier attempts ran while other
workloads held the 8-core host at 18 to more than 100. Each stopped in a
timing-bound lane, or in a check this change then replaced:

| Attempt | Stopped at |
| --- | --- |
| 1 | the byte-exact source check, replaced by the WAL-aware comparison above |
| 2 | the 120 s legacy rollback lifecycle |
| 3 | `compiled_human_queue_timeout` |
| 4 | `native_process_boot_timeout` |
| 5, 6 | the existing nested parent-death run's 120 s deadline, after all 50 earlier cases passed (the four new ones included) |

## Not covered

- The `--reviewed-setup` package variant and the 2.0.24 → 2.0.26 pair were not
  run with the fresh-install lane.
- The packaged Electron app with this change was not built or launched. The owner's
  install upgrades when a release containing this change is installed.
- Windows keeps the previous behavior, plus the clearer refusal.
- A rollback to an older-version bundle is upgraded again at the next start, because the
  application cannot run below its pin.
- A runtime newer than the application (an app downgrade) is refused with
  `bundle_runtime_newer_than_application`.
