# Release pipeline

A release is one tag push. `.github/workflows/release.yml` builds `DevRyan-<version>-arm64.dmg`, qualifies it, then creates or reconciles a draft GitHub Release under the production publication lock and publishes it. A manual run of the same workflow is a dry run: it builds everything on its ref and publishes nothing.

The public release carries exactly one asset, `DevRyan-<version>-arm64.dmg` (Apple silicon, ad-hoc signed, not notarized). The allowlist is `RELEASE_SCOPES` in `packages/electron/release-assets.mjs`, enforced by `scripts/verify-release-assets.mjs`. Intel and Windows builds are not released. `@devryan/web` on npm belongs to upstream; DevRyan never publishes to npm.

## Releasing a version

1. `node scripts/bump-version.mjs X.Y.Z` updates every package manifest, the legacy Tauri files and the workspace versions in `bun.lock`.
2. Add a `## [X.Y.Z]` section to `CHANGELOG.md`; it becomes the release notes.
3. Run `bun run validate`, then commit with explicit paths. Do not run `supabase-migrate.yml`: `publish` deploys migrations and verifies migration history and authentication configuration.
4. Optional: run packaging and qualification manually (`gh workflow run release.yml --ref main`). A dry run does not establish push-to-publication timing.
5. Create the release tag and push the commit and tag together: `git tag vX.Y.Z && git push --atomic origin main vX.Y.Z`. Main CI and release preparation then start concurrently. The release waits for the canonical main-push CI run at the exact SHA before publication; it polls every 10 seconds for up to 15 minutes, allowing missing registration and pending execution but failing on failed or cancelled CI.

Only tags matching `vX.Y.Z` trigger a release.

## Graph

```text
main push ── CI checks (Ubuntu) ── four portable + two native test workers ──┐
                                                                          │
tag push ── admit ──┬─ trusted-ci (wait outside publication lock) ──────────┤
                    ├─ web (Ubuntu) ── electron-package ── final-dmg-smoke ┤
                    └─ upgrade-check: pre-age → wait for DMG → qualify ───┤
                                                                          └─ publish (locked)
```

| Job | What it does |
| --- | --- |
| `admit` | Read-only version, tag/source and changelog checks. Published versions route to retained-original-candidate verification; unpublished releases remain untouched until locked upload. |
| `trusted-ci` | Polls the canonical repository, workflow path, main-push event and exact source SHA outside the publication lock. A newer main push cannot substitute for this commit. |
| `web` | Builds release web assets once on Ubuntu with `VITE_ENABLE_REACT_SCAN=false`, checks bundle budgets and describes every file digest. The handoff binds source SHA, version, lockfile and workflow run ID. It never consumes CI's build artifact. |
| `electron-package` | On one macOS runner, installs dependencies, verifies and builds the native runtime, prepares helpers, bundles main, rebuilds native bindings, stages this run's web artifact and packages. Checks Cursor binaries, orchestration config, retired Bot resources and Info.plist descriptions. Uploads the unchanged DMG plus a separate private identity artifact; there is no prepared dependency-tree transfer. |
| `upgrade-check` | Starts from admission without waiting for packaging. `release-preaged-upgrades.mjs` pins verified baseline installers and source revisions, shares baseline inputs within this run, and creates three fresh local profiles: newest-three aging, direct v2.0.2 and direct v2.0.15. Historical starts create retained/deleted history. After pre-aging it polls this run's package job and candidate artifacts, aborting on producer failure or a 15-minute deadline. It verifies the run/source/producer identity and DMG digest, extracts once, then runs each candidate hop, migration/history checks and held recovery sequentially. A before/after tree digest protects the shared candidate. Profiles are never cached or uploaded. |
| `final-dmg-smoke` | Runs beside candidate qualification after packaging. Observes the unchanged final DMG, visible composer, native input, loopback-provider round-trip, rendered response, screenshots and owned-process shutdown. The existing qualification-controlled blocking policy remains unchanged. |
| `publish` | Under the global publication lock, rechecks exact-source CI and tag identity, reconciles/uploads the single DMG, deploys and verifies Supabase migrations/authentication, rechecks CI, and promotes. The shipped updater must discover the expected metadata, and the public download is checked by the shipped integrity verifier. Published bytes remain immutable. |

The release uses at most two macOS runners at once: package plus qualification, then smoke plus qualification. With two native CI workers, the combined peak is **four macOS jobs**. Four portable CI workers plus the CI-wait job bring the combined peak to **nine total jobs**, below the plan's GitHub Free defaults of 20 total and five macOS jobs. The fifth macOS slot is headroom, not a reservation; organization contention and custom limits remain unverified. `release-cache.yml` is manual-only because native CI already verifies these inputs on every main push.

Main CI concurrency includes its commit SHA and does not cancel main-push runs; superseded pull requests still cancel. Every deterministic test remains covered by `validate:full`; `test-ci-lanes.mjs` splits portable and native files, four session-mutation case shards and two native-stream case shards. Suite contracts prove the inventory and disjoint shard union. Cold native qualification starts never overlap, preserving the released 2.0.2 startup budget.

Qualification reports contain baseline identities and phase durations for downloads, installation, historical hops, candidate hops, held recovery, report writing and scratch deletion. The coordinator records shared-input deletion and logs total process-exit time. Cleanup is part of the measured path, including failure paths; private homes and raw process logs never become artifacts. Read-only baseline inputs are shared only within one run, with no prepared-profile or passing-result cache.

`scripts/release.mjs` owns admission/upload/promotion and published-byte recovery. `release-ci.mjs` owns web handoffs; its old prepared-tree and Bot image commands remain available for legacy tooling but the release workflow no longer invokes them. `release-ci-wait.mjs` owns bounded CI qualification and `release-candidate.mjs` owns exact-run candidate handoff verification.

## Timing acceptance

Upgrade preparation starts with v2.0.2 before the heavier newest-three aging
inputs. Every lane still uses its unmodified released server and runtime and
must preserve history. Candidate retries resolve GitHub's copied successful job
records to the original execution with matching start and completion times;
the source, producing attempt and exact DMG bytes must still match.

The interim target is **13–15 minutes** and the final target is **at most 10 minutes**, measured from the exact main-push CI workflow's `created_at` through successful updater discovery, including queues, publication and cleanup. Neither target is demonstrated by this implementation. The earlier 70.7-second post-report gap included report writing and synchronous scratch deletion; cleanup is a hypothesis until the new phase measurements establish its cost.

For each of the next three authorized routine releases, retain the main CI/release run IDs, their SHA, main CI creation time, `[release] updater-discovery-verified-at` log timestamp, total elapsed time, job queue/run times and qualification phase reports. Report the interim result first. Claim the final target only if all three totals meet it; otherwise identify the measured remaining bottleneck before proposing more capacity. Manual dry runs validate packaging/qualification only and do not count toward these three observations. Ubuntu execution compatibility still needs its hosted CI run; local macOS tests do not prove it.

## Retrying a failed release

A version is used only once it is published. Until then:

- **Infrastructure flake:** `gh run rerun <run-id> --failed` within the artifact retention window (90 days for the original DMG, 14 for intermediate build inputs). After intermediate expiry, rerun the producing jobs as well; a published version must never be rebuilt to replace its bytes.
- **Published but verification failed:** rerun the failed publish job while its original DMG artifact remains available. Upload verifies the published tag, source, exact one-asset set, size and digest, then skips upload and Supabase deployment. Publication only verifies discovery and public download integrity; if a newer stable release superseded it, verification reports that without changing latest. A full workflow rerun routes published admission to `verify-published`: it locates a retained candidate from this repository's tag-push release workflow at the exact tag/SHA, downloads that original Actions artifact, verifies it against the public asset, and skips every heavy build and deployment job. Missing/expired artifacts or differing source/bytes fail clearly; published bytes are never reconstructed.
- **Code fix:** commit the fix, then move and atomically push the main commit and tag with `git tag -f vX.Y.Z <fixed-sha> && git push --atomic origin main +refs/tags/vX.Y.Z`. The new run cancels obsolete web/native/package/upgrade build jobs for that tag. Workflow-wide cancellation is disabled so it cannot interrupt production publication. `admit` qualifies without writes, locked `upload` reuses the draft, and upload refuses to attach bytes from a commit the tag no longer points at.
- A published version is final. Changed bytes or source require a new patch version.

If promotion succeeded but public download verification fails, the release stays published and its bytes remain immutable. Retry the verification job with the original candidate; do not delete/reupload the public asset or rebuild it. Download failures, truncated bodies, excess bytes and hash mismatches fail verification. Discovery and public-byte verification share a 60-second post-publication deadline, with five-second polls and each metadata/download request bounded by the remaining time. Timeout reports that publication succeeded but verification failed. Superseded-release offline recovery retains its separate three-minute download bound. Owned scratch is removed on success, failure and interruption.

For recovery beyond Actions retention, keep an authorized offline copy of the exact original DMG together with its tag, source SHA, byte size, SHA-256 and original Actions run URL before expiry. Do not add backup files as public release assets. With that original file in `RELEASE_ASSET_DIRECTORY`, the original `GITHUB_REF`/`GITHUB_SHA`, canonical `GITHUB_REPOSITORY` and a read-only `GITHUB_TOKEN`, `node scripts/release.mjs verify-published` verifies source, remote metadata, discovery and public bytes without writes. It also supports superseded published releases without changing latest. Without original trusted bytes, recovery fails closed; publish changed bytes only under a new patch version.

Draft creation/reconciliation, asset deletion/upload, hosted migration deployment and promotion share the global `devryan-production-publication` job lock with cancellation disabled. Different versions may build concurrently. GitHub concurrency is not a durable FIFO queue: a newer pending job may replace an older pending job; rerun any superseded unpublished release deliberately. Source/tag checks repeat before upload and promotion, and an older candidate cannot replace a newer latest release.

## Final-DMG smoke rollout

The smoke is observational until three **distinct Actions runs** produce passing `release-final-dmg-smoke/report.json` reports for their exact DMG hashes. A maintainer must confirm each report has `rendererSubmitted: true` and `rendererResponse: true`, inspect its `first-ready.png` and `conversation.png` screenshots, and confirm cleanup/prerequisites before setting the repository variable `DEVRYAN_FINAL_DMG_SMOKE_GATE=qualified-3-runs`. This is an explicit rollout decision, not an automatic claim that three executions passed. Once enabled, a failed or unavailable smoke blocks publication. Leave the variable unset during initial qualification. No live GUI runs were performed merely by adding this lane.

This bounded smoke checks packaged startup, the first usable document, native keyboard/pointer input through the composer and Send control, a visible rendered final response, and a deterministic loopback-provider tool round-trip through ordinary imported custom-provider configuration. API reads correlate the UI-created session and verify tool state; API writes do not submit the prompt. It saves `first-ready.png` before submission and `conversation.png` after completion. The renderer submission/response path requires fresh qualification in three distinct Actions runs; previous backend-only smoke reports do not qualify this revised path. No gate variable is enabled by this change; it does not claim updater replacement, launchd migration, OS-keychain access or paid-provider behavior. The direct native upgrade lanes cover separate state/history contracts. A smoke prerequisite failure is reported as a failure, never a passing skip.

Intermediate build artifacts have 14-day retention; the original final DMG and upgrade/final-DMG qualification artifacts have 90-day retention for newly uploaded artifacts (subject to repository retention policy; existing artifacts retain their original expiry). Reports export before scratch cleanup and upload on failure; setup failures produce an incomplete report. Private homes, credentials and raw subprocess logs are not uploaded. Local QA still removes scratch unless explicitly retained.

## Dry runs

`gh workflow run release.yml --ref main` runs the whole graph with `RELEASE_DRY_RUN=true`. `admit` prints instead of drafting, `upload` only checks the local DMG, and the Supabase and publish steps are skipped.

## Retired Bots

Bots are disabled by the shared product capability at UI, web runtime/API and Electron/IPC boundaries. Administrator settings cannot re-enable them. The release has no Bot image jobs, manifest handoffs, packaged Bot runtime resources or Bot-schema marker requirement. Authentication configuration and migration-history verification remain required; existing migrations are retained.

Previously installed Bot data, volumes, configuration and credentials are preserved. After ordinary desktop startup is accepted, bounded best-effort cleanup disables restarts and stops only containers carrying this installation's existing DevRyan deployment identity. Docker/keychain failure does not block startup, updater acceptance or ordinary chat. The shared runtime service and ordinary scheduled tasks remain available. Legacy Bot image tooling and its unit tests remain in source for compatibility; it is not part of the product release graph.

## Build notes

- Release installs set `DEVRYAN_SKIP_INSTALL_PREPARE=1`. Without it, Bun runs the Electron workspace `prepare` script (a full web build plus native helpers) on every install.
- `release-cache.yml` is an optional manual verification workflow; main CI already verifies native inputs on its two macOS workers. It does not export a reusable cache. Tag runs build and verify their own native runtime.
- Do not cache the Bun package store: on 2026-09-23 restoring it (~800 MB) was slower than a fresh install.
- Every job has a timeout, so a stalled native build fails instead of holding the release open.

## Local commands

| Command | Outcome |
| --- | --- |
| `bun run build` | Web assets and the Electron main bundle; no native build |
| `bun run --cwd packages/electron prepare` | Web staging, native helpers, main bundle, native ABI rebuild |
| `bun run electron:build` | Full local preparation and packaging |
| `bun run --cwd packages/electron package:prepared --publish=never` | Package prepared inputs; retired builds require no Bot manifest |
| `bun run pack:web` | Locally installable web tarball (not released) |

## Updater contract

Installed 2.0.2 and later apps read `https://api.github.com/repos/1H-Team/DevRyan/releases/latest`. They need a published, non-prerelease release tagged `vX.Y.Z` with exactly one uploaded `DevRyan-X.Y.Z-arm64.dmg`, whose GitHub-computed `digest` and size they verify after download. Nothing else (no `latest-mac.yml`, ZIP or blockmaps) is used. Apps from 2.0.1 and earlier need a manual DMG install.
