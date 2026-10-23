# Release pipeline

A release is one tag push. `.github/workflows/release.yml` checks the commit, builds `DevRyan-<version>-arm64.dmg` (or reuses the DMG already built at that SHA), qualifies it and deploys the backend. Then one locked `release` job stages the DMG on a draft GitHub Release and publishes the draft with a single write. A read-only `post-publish-verify` job confirms what installed apps see. A manual run of the same workflow is a dry run: it packages and qualifies on its ref, simulates the release against an in-memory GitHub, runs the non-gating visual QA and writes nothing.

The public release carries exactly one asset, `DevRyan-<version>-arm64.dmg` (Apple silicon, ad-hoc signed, not notarized). The allowlist is `RELEASE_SCOPES` in `packages/electron/release-assets.mjs`, enforced by `scripts/verify-release-assets.mjs`. Intel and Windows builds are not released. `@devryan/web` on npm belongs to upstream; DevRyan never publishes to npm.

**Supported upgrades.** In-app updates are supported from v2.1.9 on (`SUPPORTED_UPGRADE_FLOOR` in `scripts/qa/release-upgrade-lane.mjs`). Each release is qualified as an upgrade from the previous supported release only. Older installs reinstall from the DMG; the 2.0.x upgrade lanes are retired.

## Releasing a version

1. `node scripts/bump-version.mjs X.Y.Z` updates every package manifest, the legacy Tauri files and the workspace versions in `bun.lock`.
2. Add a `## [X.Y.Z]` section to `CHANGELOG.md`; it becomes the release notes (at most 64 KiB with the marker, which is what installed updaters keep).
3. Run `bun run validate`, then commit with explicit paths. Because a version file, `CHANGELOG.md` or `bun.lock` changed, validate runs `release:preflight --local-only`. Locally, `bun run release:preflight` always runs in a temporary `git worktree` of the commit as `git add -A` would record it, with no `node_modules` or ignored files, exactly as a fresh runner checks it. Add `RELEASE_DRY_RUN=true` to include the GitHub checks without failing on them. Do not run `supabase-migrate.yml`: `deploy-backend` deploys migrations and verifies migration history and authentication configuration.
4. Optional: run a dry run of the commit (`gh workflow run release.yml --ref <branch>`). The tag run reuses the DMG it built.
5. Create the release tag and push the commit and tag together: `git tag vX.Y.Z && git push --atomic origin main vX.Y.Z`. Main CI and release preparation then start concurrently.
6. At any point, `bun run release:status vX.Y.Z` prints where the release stands and the single next action (see Release status).

Only tags matching `vX.Y.Z` trigger a release.

## Graph

```text
main push ── CI (ci.yml): static, build, two portable + three native test workers ──┐
                                                                                    │
tag push ── preflight ──┬─ trusted-ci (waits for main CI and its re-runs) ──────────┤
                        ├─ web ── electron-package ─────────────────────────────────┤
                        │  (skipped: DMG reused)                                    │
                        └─ upgrade-check: previous release → wait for DMG → qualify ─┤
                                                                                    ▼
                  deploy-backend (own lock) ── release (publication lock: stage → CI recheck → one PATCH → ledger)
                                                   └── post-publish-verify (read-only, nothing waits for it)

dispatch (dry run) ── preflight, web, electron-package, upgrade-check
                        └─ electron-package ──┬─ simulate-release (in-memory GitHub, real DMG)
                                              └─ visual-qa (non-gating, macOS)
```

| Job | What it does |
| --- | --- |
| `preflight` | `scripts/release-preflight.mjs` (also `bun run release:preflight` locally, in a clean temporary worktree; `--local-only` skips the GitHub checks). Version files and `bun.lock`, the CHANGELOG section and its 64 KiB budget, `bun install --frozen-lockfile --dry-run --ignore-scripts`, the vendored shipped-updater copies against their tags, the same-version state and ledger (`admit` in `scripts/release.mjs`), latest ordering and build reuse. A published version routes to `verify-published`. A dry run reports what a tag push would decide without failing on it. |
| `trusted-ci` | Polls the canonical repository's main-push `ci.yml` run at the exact SHA for up to 25 minutes. A red result does not end the wait: the log names the run to re-run (`gh run rerun <id> --failed`) and the job keeps polling while the run is re-run or a newer run for the SHA appears. A newer main push cannot substitute for this commit. |
| `web` | Builds release web assets once on Ubuntu with `VITE_ENABLE_REACT_SCAN=false`, checks bundle budgets and describes every file digest. Skipped when the DMG is reused. |
| `electron-package` | On macOS: installs dependencies, builds and verifies the native runtime, prepares helpers, bundles main, rebuilds native bindings, stages this run's web artifact and packages. Checks Cursor binaries, orchestration config, retired Bot resources and Info.plist descriptions. `scripts/release-candidate.mjs` writes `candidate.json` (bytes bound to source, run and attempt) and `release-manifest.json`. **Build reuse:** when preflight finds a retained DMG built at the same SHA by any earlier attempt or run (including a dry run), the job runs on Ubuntu and `release-candidate.mjs adopt` downloads it, verifies it against the producer's identity and manifest, and rebinds it to this run. |
| `upgrade-check` | Starts from preflight without waiting for packaging. `release-preaged-upgrades.mjs` prepares a fresh profile with the previous supported release's own source and shipped runtime, creating retained and deleted history. It then polls this run's package job and candidate artifacts (15-minute deadline), verifies identity and DMG digest, extracts once and runs the candidate hop, data-root migration, history checks and held recovery. Failures are classified (see Qualification). |
| `deploy-backend` | Before the publication lock, after trusted CI, packaging and qualification pass: links Supabase, syncs the authentication password policy, `db push` (idempotent) and checks migration history, in its own non-cancelling group. Migrations must stay backward-compatible because installed apps keep running. Re-run it alone after a Supabase outage; no release or DMG is touched. |
| `release` | The only job with `contents: write` and the only holder of the publication lock. `node scripts/release.mjs release` runs stage, the exact-source CI recheck and publish in one process with the staged state in memory (see Stage and Publish). It writes `staged.json` as an artifact for audit and resume. Success is promotion plus the ledger. |
| `post-publish-verify` | Read-only (`contents: read`), after `release`: `scripts/release-verify-public.mjs vX.Y.Z` (see Post-publish verification). A failure means "published, verification pending; rerun post-publish-verify", never a failed publication. |
| `verify-published` | Only for an already published version: downloads the original retained DMG artifact and verifies published bytes, ledger, shipped discovery and the public download, read-only. |
| `simulate-release` | Dry runs only: `node scripts/release.mjs release --simulate` runs the unchanged stage, promotion, ledger and post-publish verifier against the in-memory GitHub of `scripts/release-github-fake.mjs` with this run's real DMG and manifest, so the publishing code path runs on every dry run. It holds no token. |
| `visual-qa` | Dry runs only and non-gating (`continue-on-error`; nothing needs it): `scripts/qa/release-visual-qa.mjs` on the candidate DMG (see Release visual QA). |

The release uses at most two macOS runners at once (package plus qualification; on a dry run visual QA replaces package); a reused DMG needs none for packaging. With three native CI workers the combined peak is five macOS jobs, the GitHub Free limit. The seven CI jobs plus at most five concurrent release jobs stay below the 20-job total. `release-cache.yml` is manual-only because native CI already verifies these inputs on every main push.

Main CI concurrency includes its commit SHA and does not cancel main-push runs; superseded pull requests still cancel. Every deterministic test remains covered by `validate:full`; `test-ci-lanes.mjs` splits portable and native files and the case shards, and suite contracts prove the inventory and disjoint shard union.

`scripts/release.mjs` owns admission, stage, publish, the combined `release` operation, `--simulate` and published-byte verification; `release-github.mjs` the GitHub client (with an anonymous read-only mode); `release-github-fake.mjs` the stateful in-memory GitHub used by the tests and `--simulate`; `release-state.mjs` the same-version states, the ledger marker, the shipped-discovery contract, the payload budgets and the shipped release identity; `release-verify-public.mjs` the read-only post-publish verifier and the ledger reader; `release-status.mjs` the status report; `release-preflight.mjs` preflight and its clean-worktree runner; `release-candidate.mjs` candidate identity, the release manifest and build reuse; `release-ci-wait.mjs` the CI wait; `release-ci.mjs` the web handoff and the legacy prepared-tree archive.

## GitHub client and retries

`scripts/release-github.mjs` bounds every request (30 seconds; uploads 10 minutes per attempt). GET, PATCH, PUT and DELETE retry up to four attempts with 1-2-4-8 second backoff on 5xx, 429, rate-limited 403 (honouring `retry-after`), timeouts and connection resets; POST is never blindly repeated. Listings follow pages, so more than 100 releases or runs are read. Every write passes `assertReleaseWritesAllowed` for the repository in its URL; an anonymous client refuses every write.

| Step | Retry | Bound |
| --- | --- | --- |
| GitHub REST | 4 attempts, backoff with jitter | 30 s per request |
| Asset upload | 3 attempts, reconciled by digest between attempts | 10 min per attempt |
| Late asset digest | polled every 2 s | 30 s |
| trusted-ci | keeps polling through CI re-runs | 25 min |
| Qualification `infra` failure | 1 automatic retry | job timeout |
| Qualification `product` failure | none | — |
| Post-publish discovery | 15 s polls | 10 min; the 60 s target is logged as a metric |
| Post-publish download | resumes a dropped connection with `Range` (3 attempts) | 60 s plus size at 5 MB/s (about 148 s for 438 MB) |

A crash at any request is safe. `scripts/release-convergence.test.mjs` aborts the `release` operation at every request index (connection failure before sending, effect committed with the response lost, and 502), reruns it from a fresh process against the same fake GitHub state, and requires exactly one published latest release with one asset carrying the manifest digest, one ledger tag, no drafts, no duplicated release, upload, promotion or ledger effect, and never a release published with zero assets.

## Stage

Inside the publication lock, `release.mjs stage` (the first part of `release`):

1. Checks the local DMG against `release-manifest.json` (name, size, sha256, version, source), the manifest's identity against what installed apps accept (see Updater contract), and the release-notes budget. A dry run stops here.
2. Re-checks the tag, the same-version state (below) and that no newer release is latest.
3. Creates or reconciles the one draft for the version (notes plus a `devryan-release:` marker comment naming the bytes, source and run) and deletes stale drafts.
4. Deletes only assets that are not exactly the candidate, then uploads the DMG streamed from disk. Before each attempt the asset list is reconciled: an uploaded asset with the manifest digest and size is kept; a partial `starter` upload or different bytes are deleted. A 422 `already_exists` reconciles instead of failing.
5. Waits for a late GitHub digest, verifies the exact one-asset set, checks that the projected payload stays under 2 MiB, and runs every shipped `discoverDesktopUpdate` (this checkout's and each supported release's, vendored verbatim under `scripts/fixtures/shipped-updater/`) against the draft as installed apps will see it once published. Nothing is public yet.
6. Writes `staged.json` (release and asset IDs, digest, size, both `updated_at` values and the marker) as an artifact and the step summary, and keeps it in memory for publish.

## Publish

`release` then rechecks exact-source CI (`requireTrustedCI`) and runs `publish`, which re-reads the draft and refuses if anything differs from the staged state: release or asset ID, tag, target, marker, asset count, name, state, size, digest or `updated_at`. It then sends one `PATCH {draft:false, make_latest:true}`; nothing else about the release changes. It records the ledger and removes any other draft of the version. That is the success point: the job does not wait for the CDN. A rerun after promotion only records a missing ledger entry. `release.mjs publish` still runs alone with `RELEASE_STAGED` (a `staged.json`) for a manual resume.

## Post-publish verification

`scripts/release-verify-public.mjs vX.Y.Z` is read-only and needs no retained artifact: the expected bytes come from the ledger tag. It works anonymously (as installed apps do); a token only raises the rate limit. It checks:

- `/releases/latest` (or the tag's release, when a newer version is already latest): tag, `html_url`, exactly one asset with the contract name, state, size, digest and download URL, and the 2 MiB payload budget;
- every shipped discovery offers exactly the ledger bytes;
- the body marker names the ledger bytes and the notes equal the `CHANGELOG.md` section of this checkout;
- no draft of the version is visible (drafts are visible only to a writer's token; the `release` job removes them);
- the unauthenticated public download hashes to the ledger bytes within its size-scaled deadline.

It logs `[release] updater-discovery-verified-at=…` and `[release] updater-discovery-latency-ms=… target-ms=60000 met|missed`, measured from the release's `published_at`. Missing the 60-second target is a metric, not a failure. A failure reports `vX.Y.Z is published (promotion and the ledger are recorded); verification pending: …` and how to retry. Run it by hand at any time, for example after a CDN incident.

## Release status

`bun run release:status vX.Y.Z` (`scripts/release-status.mjs`) is read-only. It uses `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` only to read, and runs anonymously without one, though it cannot then see drafts. It prints:

- the same-version state;
- the ledger tag;
- the release, with its draft and asset;
- `/releases/latest`;
- the main CI run and the release run at the tag's commit, with each job's result;
- the retained artifacts;
- the single next action: `push-tag`, `wait`, `rerun-ci`, `rerun-failed-jobs`, `rerun-release` (a missing ledger), `rerun-post-publish-verify`, `bump-version`, `investigate` or `done`, with its command.

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

**Published-bytes ledger.** After promotion, the `release` job writes an annotated tag `devryan-release/vX.Y.Z` whose message is `devryan-release: version=… sha256=… size=… source=… run=…/…`. It is write-once: an existing entry must name the same bytes. Because it outlives the release object, deleting and re-creating a published release (the v2.1.5 case) is refused. Releases up to v2.1.9 predate the ledger; `verify-published` warns when an entry is missing. Never run `gh release delete`, upload or edit assets by hand, or delete a `devryan-release/` tag: a published version is final.

Retrying (`bun run release:status vX.Y.Z` names the right one):

- **Infrastructure flake or red CI:** re-run the failed jobs (`gh run rerun <run-id> --failed`). If main CI failed, re-run CI; the waiting `trusted-ci` job picks up the re-run. Do not move the tag for a flaky test.
- **Code fix before publication:** commit the fix, then move and atomically push the main commit and tag: `git tag -f vX.Y.Z <fixed-sha> && git push --atomic origin main +refs/tags/vX.Y.Z`. The new run cancels obsolete build jobs for that tag (never the locked `release` job) and stage replaces the draft's asset.
- **Re-run at the same SHA:** the retained DMG is adopted instead of rebuilt (90-day artifact retention; intermediate web artifacts keep 14 days).
- **Published, verification pending:** rerun `post-publish-verify` (`gh run rerun <run-id> --job <job-id>`) or run `node scripts/release-verify-public.mjs vX.Y.Z`. A rerun of the whole workflow routes to `verify-published` with the original retained DMG. Missing or expired artifacts or differing bytes fail clearly; published bytes are never rebuilt.
- **Published without a ledger entry** (the `release` job stopped right after promotion): rerun the `release` job; it only records the ledger and removes stale drafts.

For recovery beyond Actions retention, keep an authorized offline copy of the exact original DMG with its tag, source SHA, size, SHA-256 and original run URL. With that file in `RELEASE_ASSET_DIRECTORY`, the original `GITHUB_REF`/`GITHUB_SHA`, the canonical `GITHUB_REPOSITORY` and a read-only `GITHUB_TOKEN`, `node scripts/release.mjs verify-published` verifies without writes. Do not add backup files as public release assets.

Only the `release` job holds the global `devryan-production-publication` lock, with cancellation disabled; `deploy-backend` has its own non-cancelling group. GitHub concurrency is not a durable FIFO queue: a newer pending job may replace an older pending one. Because stage and publish run in one job, a replaced pending job never strands a staged draft between them; rerun a superseded unpublished release deliberately.

## Qualification

Setup failures in `upgrade-check` are classified by `scripts/qa/release-qualification-failure.mjs`. `infra` (a failed `gh`, `git`, `tar`, `ditto`, `bun` or `hdiutil` command, network errors and timeouts, a busy disk image, a corrupt baseline download) is retried once inside the job. `product` (candidate hop, migration, history or held-recovery failure, a changed candidate runtime, a failed producer) and anything unknown is never retried. The job log and each lane report carry the class and bounded error text (run paths replaced, opaque tokens removed). Details: [QA](QA.md#release-upgrade-lane).

## Final-DMG smoke (retired from the workflow)

The `final-dmg-smoke` job was removed. It failed in every release run from v2.1.8 through v2.1.10 (and passed only for v2.1.7): the composer never submitted (`release_dmg_renderer_submit_failed`, zero provider requests) because Builder's shipped model `openai/gpt-5.5` was unavailable in the private profile. The smoke's `settings.json` `agentModelSelections` apply only to managed non-admin users, and the packaged Builder agent's model wins over the smoke's `opencode.json` entry. `scripts/qa/release-final-dmg-smoke.mjs` stays as a library and a manual tool for that fix (it pins Builder's model the way the owner's UI does); no GUI or DMG check gates publication. The non-gating visual QA below replaces it in the workflow.

## Dry runs

`gh workflow run release.yml --ref <branch>` runs preflight, packaging and qualification with `RELEASE_DRY_RUN=true`, then `simulate-release` and `visual-qa`, and stops; `deploy-backend`, `release` and `post-publish-verify` run only on a tag push. A dry run cannot write releases: `RELEASE_DRY_RUN` derives from the event name, every GitHub write goes through `assertReleaseWritesAllowed` (`scripts/release-artifacts.mjs`), which refuses any dry run and any repository but this one, and the simulation's in-memory GitHub refuses every network host. `scripts/release-workflow.test.mjs` checks the workflow side of this contract.

Locally, `RELEASE_ASSET_DIRECTORY=<dir with the DMG> RELEASE_MANIFEST_PATH=<release-manifest.json> node scripts/release.mjs release --simulate` does the same. `stage --simulate` and `publish --simulate` run separately share the simulated GitHub through `RELEASE_SIMULATION_STATE` (a file path that `publish` removes).

## Release visual QA

`scripts/qa/release-visual-qa.mjs (--dmg <absolute DMG> | --version X.Y.Z) --report <absolute report.json> [--manifest <release-manifest.json>] [--upgrade-from vA.B.C] [--isolated-host] [--keep-artifacts]` is non-gating. It never runs beside the owner's app, because launchd labels live in the real `gui/<uid>` domain whatever HOME says. It requires a GitHub Actions runner or `--isolated-host` (a separate macOS user or VM), and it refuses while any `DevRyan` process runs for the user. Each step writes a screenshot next to the report, and `report.json` records their SHA-256:

- **DMG.** The sha256 matches the manifest and, once published, the release digest. The DMG mounts read-only with `DevRyan.app` and an Applications link. The app is `ditto`'d into the run root, never `/Applications`.
- **First launch.** The app starts on a private HOME/XDG profile with a mock keychain and CDP. The report captures `splash.png`, then `ready.png` once OpenCode is ready, with no error toast.
- **About.** It shows exactly `X.Y.Z`, matching `CFBundleShortVersionString` (`about.png`).
- **Update check.** Against the real feed it offers exactly what `/releases/latest` implies, which is nothing while the candidate is newest (`update-check.png`).
- **Update path** (`--upgrade-from v2.1.9`). Once X.Y.Z is the published latest, the older public DMG is installed the same way. It must be offered X.Y.Z, download it, restart into it and keep its settings (`upgrade-*.png`). Before publication this step reports `skipped`, because there is no feed override: an environment-selected feed would be a self-authorizing update source.
- **Quit.** No process is left running from the run root.

The run root is removed on success, failure and interruption. The workflow runs it on every dry run (`visual-qa`) and uploads `release-visual-qa`. Manual checks that remain for an isolated host:

- the Finder mount window and the Gatekeeper first-open path of the quarantined ad-hoc app;
- the offline or rate-limited "Release discovery is unavailable. Retry later." state;
- an interrupted download resuming;
- killing the installer mid-swap (installer intent phases in `packages/electron/desktop-update-install.mjs`);
- the release page showing exactly one asset, marked Latest, with no drafts (`release-verify-public.mjs` checks this too).

## Owner decisions

- **Immutable Releases** (repository setting, currently off: `GET /repos/1H-Team/DevRyan/immutable-releases` → `{"enabled":false}`). Turning it on makes published bytes final at the platform level and adds release attestations. It is compatible with the draft-first upload: assets are attached while the release is a draft. The ledger stays as the cross-check. The pipeline never changes repository settings.
- **When visual QA runs.** Today it runs on every dry run (dispatch) only, non-gating. Running the 2.1.9 → X.Y.Z update path automatically after every publication would need a post-publish macOS job; that is the owner's call.
- **Supabase before the lock.** `deploy-backend` now runs before `release`, so a release that fails after deployment leaves the new migrations applied. They must stay backward-compatible with installed apps, as they already had to.

## Timing acceptance

The interim target is **13–15 minutes** and the final target is **at most 10 minutes**, measured from the exact main-push CI workflow's `created_at` through successful updater discovery, including queues, publication and cleanup. Neither is demonstrated yet. For each of the next three routine releases, keep the main CI and release run IDs, the SHA, CI creation time, the `[release] updater-discovery-verified-at` log timestamp (now in `post-publish-verify`), total elapsed time, job queue and run times and qualification phase reports. Claim the final target only if all three totals meet it. Dry runs do not count.

Qualification reports contain baseline identities and phase durations for downloads, installation, historical hops, candidate hops, held recovery, report writing and scratch deletion. Cleanup is measured, including on failure; private homes and raw process logs never become artifacts.

## Retired Bots

Bots are disabled by the shared product capability at UI, web runtime/API and Electron/IPC boundaries. The release has no Bot image jobs or commands, manifest handoffs, packaged Bot runtime resources or Bot-schema marker requirement. Authentication configuration and migration-history verification remain required; existing migrations are retained. Previously installed Bot data, volumes, configuration and credentials are preserved; the Bot image build and verification modules remain in source for the Bot runtime tooling but are not part of the release.

## Build notes

- Release installs set `DEVRYAN_SKIP_INSTALL_PREPARE=1`. Without it, Bun runs the Electron workspace `prepare` script (a full web build plus native helpers) on every install.
- `release-cache.yml` is an optional manual verification workflow; it does not export a reusable cache.
- Do not cache the Bun package store: on 2026-09-23 restoring it (~800 MB) was slower than a fresh install.
- Every job has a timeout, so a stalled native build fails instead of holding the release open.
- `dmg.sign` is `false` in `packages/electron/package.json`, matching the release build's `-c.dmg.sign=false`; the app inside is signed ad hoc by `afterPack`.

## Local commands

| Command | Outcome |
| --- | --- |
| `bun run release:preflight` | Release preflight in a clean temporary worktree; `-- --local-only` without GitHub, `-- --in-place` in this checkout |
| `bun run release:status vX.Y.Z` | Read-only state, ledger, draft, asset, artifacts, CI and the next action |
| `node scripts/release-verify-public.mjs vX.Y.Z` | Read-only post-publish verification of a published version |
| `node scripts/release.mjs release --simulate` | Stage, publish and verify against the in-memory GitHub (`RELEASE_ASSET_DIRECTORY`, `RELEASE_MANIFEST_PATH`) |
| `bun run build` | Web assets and the Electron main bundle; no native build |
| `bun run --cwd packages/electron prepare` | Web staging, native helpers, main bundle, native ABI rebuild |
| `bun run electron:build` | Full local preparation and packaging |
| `bun run --cwd packages/electron package:prepared --publish=never` | Package prepared inputs |
| `bun run pack:web` | Locally installable web tarball (not released) |

## Updater contract

Installed apps read `https://api.github.com/repos/1H-Team/DevRyan/releases/latest`. They need a published, non-prerelease release tagged `vX.Y.Z` with exactly one uploaded `DevRyan-X.Y.Z-arm64.dmg`, whose GitHub-computed `digest` and size they verify after download, and a response under 2 MiB (they keep 64 KiB of the body). Nothing else (no `latest-mac.yml`, ZIP or blockmaps) is used. The installer then requires a single-arch arm64 `DevRyan.app` whose `CFBundleShortVersionString` equals the tag, `CFBundleExecutable` is `DevRyan`, `CFBundleIdentifier` is one the installed version accepts, and whose signing mode matches the installed app (ad hoc).

The repository name, the `html_url` and download URL formats, the tag format and the ad-hoc signing mode are compared literally by every installed 2.1.9+ app. `SHIPPED_RELEASE_IDENTITY` in `scripts/release-state.mjs` records them. `scripts/release-convergence.test.mjs` checks them against the vendored v2.1.9 updater and the packaging configuration, and stage refuses a manifest that breaks them. Do not rename or transfer the repository or organization, change the tag format, or move to Developer ID signing or notarization: each needs a bridge release that installed apps accept first. Installed updaters are unauthenticated (60 requests per hour per IP); a shared NAT can show "Release discovery is unavailable". `scripts/release-packaging.test.mjs` and `scripts/release-state.test.mjs` check the packaging configuration and the bundle identifier against every supported shipped installer, and golden API fixtures (`scripts/fixtures/github-api/`) keep the discovery projection honest to GitHub's real field shapes. Installs older than v2.1.9 are not supported for in-app updates; apps from 2.0.1 and earlier always need a manual DMG install.
