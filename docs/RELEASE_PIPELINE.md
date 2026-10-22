# Release pipeline

A release is one tag push. `.github/workflows/release.yml` checks the commit, builds `DevRyan-<version>-arm64.dmg` (or reuses the DMG already built at that SHA), qualifies it, stages it on a draft GitHub Release, deploys the backend and then publishes the draft with a single write. A manual run of the same workflow is a dry run: it packages and qualifies on its ref and writes nothing.

The public release carries exactly one asset, `DevRyan-<version>-arm64.dmg` (Apple silicon, ad-hoc signed, not notarized). The allowlist is `RELEASE_SCOPES` in `packages/electron/release-assets.mjs`, enforced by `scripts/verify-release-assets.mjs`. Intel and Windows builds are not released. `@devryan/web` on npm belongs to upstream; DevRyan never publishes to npm.

**Supported upgrades.** In-app updates are supported from v2.1.9 on (`SUPPORTED_UPGRADE_FLOOR` in `scripts/qa/release-upgrade-lane.mjs`). Each release is qualified as an upgrade from the previous supported release only. Older installs reinstall from the DMG; the 2.0.x upgrade lanes are retired.

## Releasing a version

1. `node scripts/bump-version.mjs X.Y.Z` updates every package manifest, the legacy Tauri files and the workspace versions in `bun.lock`.
2. Add a `## [X.Y.Z]` section to `CHANGELOG.md`; it becomes the release notes.
3. Run `bun run validate` and `bun run release:preflight`, then commit with explicit paths. Do not run `supabase-migrate.yml`: `deploy-backend` deploys migrations and verifies migration history and authentication configuration.
4. Optional: run a dry run of the commit (`gh workflow run release.yml --ref <branch>`). The tag run reuses the DMG it built.
5. Create the release tag and push the commit and tag together: `git tag vX.Y.Z && git push --atomic origin main vX.Y.Z`. Main CI and release preparation then start concurrently.

Only tags matching `vX.Y.Z` trigger a release.

## Graph

```text
main push ── CI (ci.yml): static, build, two portable + three native test workers ──┐
                                                                                    │
tag push ── preflight ──┬─ trusted-ci (waits for main CI and its re-runs) ──────────┤
                        ├─ web ── electron-package ──┬─ final-dmg-smoke (quarantined)┤
                        │  (skipped: DMG reused)     │                               │
                        └─ upgrade-check: previous release → wait for DMG → qualify ─┤
                                                                                    ▼
                         stage (lock: draft + upload + discovery) ── deploy-backend ── publish (lock: one PATCH)
```

| Job | What it does |
| --- | --- |
| `preflight` | `scripts/release-preflight.mjs` (also `bun run release:preflight` locally; `--local-only` skips the GitHub checks). Version files and `bun.lock`, the CHANGELOG section, `bun install --frozen-lockfile --dry-run`, the vendored shipped-updater copies against their tags, the same-version state and ledger (`admit` in `scripts/release.mjs`), latest ordering and build reuse. A published version routes to `verify-published`. A dry run reports what a tag push would decide without failing on it. |
| `trusted-ci` | Polls the canonical repository's main-push `ci.yml` run at the exact SHA for up to 25 minutes. A red result does not end the wait: the log names the run to re-run (`gh run rerun <id> --failed`) and the job keeps polling while the run is re-run or a newer run for the SHA appears. A newer main push cannot substitute for this commit. |
| `web` | Builds release web assets once on Ubuntu with `VITE_ENABLE_REACT_SCAN=false`, checks bundle budgets and describes every file digest. Skipped when the DMG is reused. |
| `electron-package` | On macOS: installs dependencies, builds and verifies the native runtime, prepares helpers, bundles main, rebuilds native bindings, stages this run's web artifact and packages. Checks Cursor binaries, orchestration config, retired Bot resources and Info.plist descriptions. `scripts/release-candidate.mjs` writes `candidate.json` (bytes bound to source, run and attempt) and `release-manifest.json`. **Build reuse:** when preflight finds a retained DMG built at the same SHA by any earlier attempt or run (including a dry run), the job runs on Ubuntu and `release-candidate.mjs adopt` downloads it, verifies it against the producer's identity and manifest, and rebinds it to this run. |
| `upgrade-check` | Starts from preflight without waiting for packaging. `release-preaged-upgrades.mjs` prepares a fresh profile with the previous supported release's own source and shipped runtime, creating retained and deleted history. It then polls this run's package job and candidate artifacts (15-minute deadline), verifies identity and DMG digest, extracts once and runs the candidate hop, data-root migration, history checks and held recovery. Failures are classified (see Qualification). |
| `final-dmg-smoke` | Observes the unchanged final DMG: visible composer, native input, loopback-provider round-trip, rendered response, screenshots and owned-process shutdown. Quarantined as a tracked defect (see Final-DMG smoke). |
| `stage` | Under the publication lock, writes drafts only: see Stage. Writes `staged.json`. |
| `deploy-backend` | Its own job, after `stage` and before `publish`: links Supabase, syncs the authentication password policy, `db push` (idempotent) and checks migration history. Re-run it alone after a Supabase outage; no draft or DMG is touched. |
| `publish` | Under the publication lock: rechecks exact-source CI and the tag, checks the draft is unchanged since `staged.json`, then one `PATCH {draft:false, make_latest:true}`. Records the ledger and verifies discovery and the public download (see Publish). |
| `verify-published` | Only for an already published version: downloads the original retained DMG artifact and verifies published bytes, ledger, shipped discovery and the public download, read-only. |

The release uses at most two macOS runners at once (package plus qualification, then smoke plus qualification); a reused DMG needs none for packaging. With three native CI workers the combined peak is five macOS jobs, the GitHub Free limit. The seven CI jobs plus at most five concurrent release jobs stay below the 20-job total. `release-cache.yml` is manual-only because native CI already verifies these inputs on every main push.

Main CI concurrency includes its commit SHA and does not cancel main-push runs; superseded pull requests still cancel. Every deterministic test remains covered by `validate:full`; `test-ci-lanes.mjs` splits portable and native files and the case shards, and suite contracts prove the inventory and disjoint shard union.

`scripts/release.mjs` owns admission, stage, publish and published-byte verification; `release-github.mjs` the GitHub client; `release-state.mjs` the same-version states, the ledger marker and the shipped-discovery contract; `release-preflight.mjs` preflight; `release-candidate.mjs` candidate identity, the release manifest and build reuse; `release-ci-wait.mjs` the CI wait; `release-ci.mjs` web handoffs (its prepared-tree and Bot image commands remain for legacy tooling only).

## GitHub client and retries

`scripts/release-github.mjs` bounds every request (30 seconds; uploads 10 minutes per attempt). GET, PATCH, PUT and DELETE retry up to four attempts with 1-2-4-8 second backoff on 5xx, 429, rate-limited 403 (honouring `retry-after`), timeouts and connection resets; POST is never blindly repeated. Listings follow pages, so more than 100 releases or runs are read. Every write passes `assertReleaseWritesAllowed` for the repository in its URL.

| Step | Retry | Bound |
| --- | --- | --- |
| GitHub REST | 4 attempts, backoff with jitter | 30 s per request |
| Asset upload | 3 attempts, reconciled by digest between attempts | 10 min per attempt |
| Late asset digest | polled every 2 s | 30 s |
| trusted-ci | keeps polling through CI re-runs | 25 min |
| Qualification `infra` failure | 1 automatic retry | job timeout |
| Qualification `product` failure | none | — |
| Post-publish discovery and download | 5 s polls | 60 s, then rerun `publish` or `verify-published` |

## Stage

Inside the publication lock, `release.mjs stage`:

1. Checks the local DMG against `release-manifest.json` (name, size, sha256, version, source).
2. Re-checks the tag, the same-version state (below) and that no newer release is latest.
3. Creates or reconciles the one draft for the version (notes plus a `devryan-release:` marker comment naming the bytes, source and run) and deletes stale drafts.
4. Deletes only assets that are not exactly the candidate, then uploads the DMG streamed from disk. Before each attempt the asset list is reconciled: an uploaded asset with the manifest digest and size is kept; a partial `starter` upload or different bytes are deleted. A 422 `already_exists` reconciles instead of failing.
5. Waits for a late GitHub digest, verifies the exact one-asset set, and runs every shipped `discoverDesktopUpdate` (this checkout's and each supported release's, vendored verbatim under `scripts/fixtures/shipped-updater/`) against the draft as installed apps will see it once published. Nothing is public yet.
6. Writes `staged.json` (release and asset IDs, digest, size, both `updated_at` values and the marker) as a job output, an artifact and the step summary.

## Publish

`release.mjs publish` re-reads the draft and refuses if anything differs from `staged.json`: release or asset ID, tag, target, marker, asset count, name, state, size, digest or `updated_at`. It then sends one `PATCH {draft:false, make_latest:true}`; nothing else about the release changes. Afterwards it records the ledger and, within 60 seconds, requires `/releases/latest` to be discovered by every shipped discovery with exactly the staged bytes and the unauthenticated public download to hash to them. A rerun after promotion only records a missing ledger entry and verifies.

## Same-version retries

A version is used up only once it is published. `admit` (preflight) and `stage` apply `releaseState` in `scripts/release-state.mjs`:

| Observed state | Action |
| --- | --- |
| No release, no ledger entry | Full path |
| Draft from this source with the manifest digest | Keep the asset; stage re-records the draft |
| Draft from another source (moved tag) or other bytes | Replace the asset (allowed while unpublished) |
| Published from this source, digest matches ledger and manifest | Verify only |
| Published from another source or with other bytes | Refuse: bump the patch version |
| Published bytes differ from the ledger | Refuse: bytes were replaced outside the pipeline |
| Ledger entry but no published release (deleted, or re-created as a draft) | Refuse: bump the patch version |

**Published-bytes ledger.** After promotion, `publish` writes an annotated tag `devryan-release/vX.Y.Z` whose message is `devryan-release: version=… sha256=… size=… source=… run=…/…`. It is write-once: an existing entry must name the same bytes. Because it outlives the release object, deleting and re-creating a published release (the v2.1.5 case) is refused. Releases up to v2.1.9 predate the ledger; `verify-published` warns when an entry is missing. Never run `gh release delete`, upload or edit assets by hand, or delete a `devryan-release/` tag: a published version is final.

Retrying:

- **Infrastructure flake or red CI:** re-run the failed jobs (`gh run rerun <run-id> --failed`). If main CI failed, re-run CI; the waiting `trusted-ci` job picks up the re-run. Do not move the tag for a flaky test.
- **Code fix before publication:** commit the fix, then move and atomically push the main commit and tag: `git tag -f vX.Y.Z <fixed-sha> && git push --atomic origin main +refs/tags/vX.Y.Z`. The new run cancels obsolete build jobs for that tag (never the lock-holding jobs) and `stage` replaces the draft's asset.
- **Re-run at the same SHA:** the retained DMG is adopted instead of rebuilt (90-day artifact retention; intermediate web artifacts keep 14 days).
- **Published but verification failed:** rerun `publish` (it only verifies and records a missing ledger entry) or the whole workflow, which routes to `verify-published` with the original retained DMG. Missing or expired artifacts or differing bytes fail clearly; published bytes are never rebuilt.

For recovery beyond Actions retention, keep an authorized offline copy of the exact original DMG with its tag, source SHA, size, SHA-256 and original run URL. With that file in `RELEASE_ASSET_DIRECTORY`, the original `GITHUB_REF`/`GITHUB_SHA`, the canonical `GITHUB_REPOSITORY` and a read-only `GITHUB_TOKEN`, `node scripts/release.mjs verify-published` verifies without writes. Do not add backup files as public release assets.

Stage and publish share the global `devryan-production-publication` lock with cancellation disabled; `deploy-backend` has its own non-cancelling group. GitHub concurrency is not a durable FIFO queue: a newer pending job may replace an older pending one; rerun a superseded unpublished release deliberately.

## Qualification

Setup failures in `upgrade-check` are classified by `scripts/qa/release-qualification-failure.mjs`. `infra` (a failed `gh`, `git`, `tar`, `ditto`, `bun` or `hdiutil` command, network errors and timeouts, a busy disk image, a corrupt baseline download) is retried once inside the job. `product` (candidate hop, migration, history or held-recovery failure, a changed candidate runtime, a failed producer) and anything unknown is never retried. The job log and each lane report carry the class and bounded error text (run paths replaced, opaque tokens removed). Details: [QA](QA.md#release-upgrade-lane).

## Final-DMG smoke

The smoke is quarantined as a tracked defect. It failed in every release run from v2.1.8 through v2.1.9 and passed only for v2.1.7 (`rendererResponse`, `toolRoundTrip`, `screenshot`). The v2.1.9 run 39735194056 report shows the cause: the composer never submitted (`release_dmg_renderer_submit_failed`, "Timed out: UI-created session", zero provider requests) because it resolved Builder's shipped model `openai/gpt-5.5` and showed "Configured model openai/gpt-5.5 is unavailable". The smoke's `settings.json` `agentModelSelections` apply only to managed non-admin users (`useConfigStore`), and the packaged Builder agent's model wins over the smoke's `opencode.json` agent entry. Fixing it needs the smoke to pin Builder's model the way the owner's UI does, verified on a macOS GUI runner.

While quarantined, the smoke step has `continue-on-error`, so the job is green, and the summary step posts a warning annotation with the failure and its reason. Once three distinct Actions runs produce passing `release-final-dmg-smoke/report.json` reports for their exact DMG hashes, a maintainer confirms each has `rendererSubmitted: true` and `rendererResponse: true`, inspects `first-ready.png` and `conversation.png`, and sets the repository variable `DEVRYAN_FINAL_DMG_SMOKE_GATE=qualified-3-runs`. From then on a failed or unavailable smoke blocks `stage`. This is an explicit rollout decision, not an automatic claim.

The smoke checks packaged startup, the first usable document, native keyboard and pointer input through the composer and Send control, a visible rendered final response, and a deterministic loopback-provider tool round-trip through ordinary imported custom-provider configuration. It does not claim updater replacement, launchd migration, OS-keychain access or paid-provider behaviour. A prerequisite failure is reported as a failure, never a passing skip. Reports export before scratch cleanup and upload on failure; private homes, credentials and raw subprocess logs are not uploaded.

## Dry runs

`gh workflow run release.yml --ref <branch>` runs preflight, packaging and qualification with `RELEASE_DRY_RUN=true` and stops; `stage`, `deploy-backend` and `publish` run only on a tag push. A dry run cannot write releases: `RELEASE_DRY_RUN` derives from the event name, and every GitHub write goes through `assertReleaseWritesAllowed` (`scripts/release-artifacts.mjs`), which refuses any dry run and any repository but this one. `scripts/release-workflow.test.mjs` checks the workflow side of this contract.

## Release visual QA

Run on an isolated macOS user or VM, never on the developer's running app or data, with one screenshot per step attached to the release run.

- **V1 Fresh install.** Download the public DMG and check its sha256 against the release digest. Mounting shows the "DevRyan X.Y.Z" window with DevRyan.app and an Applications link. Drag to /Applications. Record the Gatekeeper first-open prompt and path (right-click Open, or `xattr`) for the ad-hoc signed, quarantined app.
- **V2 First launch.** Splash, then the main window. The composer is visible and focused. A prompt to the loopback provider gets a rendered response. No error toasts. A clean quit leaves no `DevRyan` or `opencode` processes.
- **V3 About.** About shows exactly `X.Y.Z`, matching the tag and `CFBundleShortVersionString`.
- **V5 Update from 2.1.9 to the candidate** (the published release). The prompt shows the new version and its notes; the download reaches 100 %; "Restart to update" lands on X.Y.Z; sessions, settings and the `~/.config/devryan` link are kept.
- **V6 Updater states.** On the latest version the check says up to date. Offline or rate-limited shows the "Release discovery is unavailable. Retry later." message. An interrupted download resumes from the partial file; a corrupt partial is discarded.
- **V7 Rollback.** Kill the installer mid-swap. The next launch recovers to the previous or the new version without data loss (installer intent phases in `packages/electron/desktop-update-install.mjs`).
- **V8 Release page.** Exactly one asset with the contract name, marked Latest, notes equal to the CHANGELOG section, no drafts left.

## Timing acceptance

The interim target is **13–15 minutes** and the final target is **at most 10 minutes**, measured from the exact main-push CI workflow's `created_at` through successful updater discovery, including queues, publication and cleanup. Neither is demonstrated yet. For each of the next three routine releases, keep the main CI and release run IDs, the SHA, CI creation time, the `[release] updater-discovery-verified-at` log timestamp, total elapsed time, job queue and run times and qualification phase reports. Claim the final target only if all three totals meet it. Dry runs do not count.

Qualification reports contain baseline identities and phase durations for downloads, installation, historical hops, candidate hops, held recovery, report writing and scratch deletion. Cleanup is measured, including on failure; private homes and raw process logs never become artifacts.

## Retired Bots

Bots are disabled by the shared product capability at UI, web runtime/API and Electron/IPC boundaries. The release has no Bot image jobs, manifest handoffs, packaged Bot runtime resources or Bot-schema marker requirement. Authentication configuration and migration-history verification remain required; existing migrations are retained. Previously installed Bot data, volumes, configuration and credentials are preserved; legacy Bot image tooling remains in source but is not part of the release graph.

## Build notes

- Release installs set `DEVRYAN_SKIP_INSTALL_PREPARE=1`. Without it, Bun runs the Electron workspace `prepare` script (a full web build plus native helpers) on every install.
- `release-cache.yml` is an optional manual verification workflow; it does not export a reusable cache.
- Do not cache the Bun package store: on 2026-09-23 restoring it (~800 MB) was slower than a fresh install.
- Every job has a timeout, so a stalled native build fails instead of holding the release open.

## Local commands

| Command | Outcome |
| --- | --- |
| `bun run release:preflight` | Release preflight; `-- --local-only` without GitHub |
| `bun run build` | Web assets and the Electron main bundle; no native build |
| `bun run --cwd packages/electron prepare` | Web staging, native helpers, main bundle, native ABI rebuild |
| `bun run electron:build` | Full local preparation and packaging |
| `bun run --cwd packages/electron package:prepared --publish=never` | Package prepared inputs |
| `bun run pack:web` | Locally installable web tarball (not released) |

## Updater contract

Installed apps read `https://api.github.com/repos/1H-Team/DevRyan/releases/latest`. They need a published, non-prerelease release tagged `vX.Y.Z` with exactly one uploaded `DevRyan-X.Y.Z-arm64.dmg`, whose GitHub-computed `digest` and size they verify after download. Nothing else (no `latest-mac.yml`, ZIP or blockmaps) is used. The installer then requires a single-arch arm64 `DevRyan.app` whose `CFBundleShortVersionString` equals the tag, `CFBundleExecutable` is `DevRyan`, `CFBundleIdentifier` is one the installed version accepts, and whose signing mode matches the installed app. `scripts/release-packaging.test.mjs` and `scripts/release-state.test.mjs` check the packaging configuration and the bundle identifier against every supported shipped installer. Installs older than v2.1.9 are not supported for in-app updates; apps from 2.0.1 and earlier always need a manual DMG install.
