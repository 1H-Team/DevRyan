# Release pipeline

A release is one tag push of a commit that is already proven: `bun run release:tag` pushes the tag only after main CI and a dry run passed at that commit. `.github/workflows/release.yml` then checks the commit, adopts the dry run's `DevRyan-<version>-arm64.dmg`, qualifies it and deploys the backend when it changed. Then one locked `release` job stages the DMG on a draft GitHub Release and publishes the draft with a single write. A read-only job confirms public discovery and the public download. A manual dry run packages once, qualifies the runtime, simulates publication, and requires visual QA of the candidate DMG before tagging. It writes no releases.

The public release carries exactly one asset, `DevRyan-<version>-arm64.dmg` (Apple silicon, ad-hoc signed, not notarized). The allowlist is `RELEASE_SCOPES` in `packages/electron/release-assets.mjs`, enforced by `scripts/verify-release-assets.mjs`. Intel and Windows builds are not released. `@devryan/web` on npm belongs to upstream; DevRyan never publishes to npm.

**Supported installs.** The supported install is the latest DMG. On 2026-10-26 the owner made in-app upgrades from older installs best-effort: no release job qualifies them and nothing refuses a release for them. `scripts/qa/release-installed-upgrades.mjs` remains a manual tool, and preflight's installer-pin check reports, without failing, which installs would refuse an update. **History reset (2026-10-27):** the owner deleted every release from v2.0.0 through v2.2.0 and republished the v2.2.0 code as v2.0.0. In-app updates are supported from v2.0.0 on (`SUPPORTED_UPGRADE_FLOOR` in `scripts/qa/release-upgrade-lane.mjs`, `SUPPORTED_INSTALLED_FLOOR` in `scripts/release-state.mjs`). Apps that installed a deleted 2.0.1–2.2.0 release compare versions numerically and are not offered the new 2.0.0 or later releases until one exceeds their version; they reinstall from the DMG. The runtime history/migration lane uses the previous supported release; for v2.0.0 itself there is none, so the lane records `skipped: first-supported-release` and visual QA skips its update path.

## Releasing a version

1. `node scripts/bump-version.mjs X.Y.Z` updates every package manifest, the legacy Tauri files and the workspace versions in `bun.lock`.
2. Add a `## [X.Y.Z]` section to `CHANGELOG.md`; it becomes the release notes (at most 64 KiB with the marker, which is what installed updaters keep).
3. Run `bun run validate`, then commit with explicit paths. Because a version file, `CHANGELOG.md` or `bun.lock` changed, validate runs `release:preflight --local-only`. Locally, `bun run release:preflight` always runs in a temporary `git worktree` of the commit as `git add -A` would record it, with no `node_modules` or ignored files, exactly as a fresh runner checks it. Add `RELEASE_DRY_RUN=true` to include the GitHub checks without failing on them. Do not run `supabase-migrate.yml`: `deploy-backend` deploys migrations and verifies migration history and authentication configuration.
4. Push the commit to `main` and let main CI pass. A red CI is fixed (or re-run) now, before any tag exists.
5. Required: run a dry run of that commit (`gh workflow run release.yml --ref main`) and wait until preflight, `electron-package`, `upgrade-check`, `simulate-release` and `visual-qa` pass. Missing or failed visual qualification refuses tagging and tag-run preflight, even when release pipeline code is unchanged.
6. `bun run release:tag` pushes `vX.Y.Z` at `HEAD`, and only the tag. It refuses a dirty working tree, an `origin` other than the canonical repository, a published or superseded version and a tag at another commit (`--move` re-points an unpublished version's tag for a code fix). It also refuses unless the canonical main CI passed at the commit (`requireTrustedCI`), a green dry run of the commit exists with its DMG retained, and `release:preflight --local-only` passes in a clean checkout. `-- --check` runs the same checks and prints the push command instead. The tag run adopts the dry run's DMG through build reuse, which verifies it against the dry run's manifest, so the published bytes are the ones the dry run checked.
7. At any point, `bun run release:status vX.Y.Z` prints where the release stands and the single next action (see Release status).

Only tags matching `vX.Y.Z` trigger a release.

## Graph

```text
main push ── CI (ci.yml): static, build, two portable + three native test workers
   └── dispatch (dry run) ── preflight, web, electron-package, upgrade-check
                               └─ electron-package ──┬─ simulate-release (in-memory GitHub, real DMG)
                                                     └─ visual-qa (macOS, required)
   └── bun run release:tag (local: main CI green + dry run green + preflight) ── pushes vX.Y.Z

tag push ── preflight ──┬─ trusted-ci (rechecks main CI; returns at once) ──────────┐
                        ├─ electron-package (adopts the dry run's DMG on Ubuntu) ───┤
                        └─ upgrade-check: previous release → wait for DMG → qualify ─┤
                                                                                    ▼
                  deploy-backend (own lock; skipped when no backend input changed)
                     └── release (publication lock: stage + ledger object → CI recheck → one PATCH → ledger ref → no drafts)
                            └── post-publish-verify (read-only)
```

| Job | What it does |
| --- | --- |
| `preflight` | `scripts/release-preflight.mjs` (also `bun run release:preflight` locally, in a clean temporary worktree; `--local-only` skips the GitHub checks). Version files and `bun.lock`, the CHANGELOG section and its 64 KiB budget, `bun install --frozen-lockfile --dry-run --ignore-scripts`, the vendored shipped-updater copies against their tags, the shipped installer candidate pins (`candidate-pins.json` against the tags, and this checkout's Bun and reviewed assets against every supported pinned installer; see Installer candidate verification), the same-version state and ledger (`admit` in `scripts/release.mjs`), latest ordering, the pipeline-change gate, build reuse and the backend-deploy decision. **Pipeline-change gate:** when the release workflow, a `scripts/release*.mjs` or `scripts/qa/release-*.mjs` script, `scripts/verify-release-assets.mjs` or `packages/electron/release-assets.mjs` (tests excluded) differs from the previous published release's tag, a green dry run at this exact commit is required. **Backend deploy:** `deploy_backend` is `false` when `supabase/migrations`, `supabase/config.toml` and `scripts/sync-supabase-auth-password-policy.mjs` are unchanged since the previous version's `devryan-release/` ledger tag; with no earlier ledger tag, or when the comparison fails, it deploys. A published version routes to `verify-published`. A dry run reports what a tag push would decide without failing on it. |
| `trusted-ci` | Rechecks the canonical repository's main-push `ci.yml` run at the exact SHA; `release:tag` already required it to pass, so this normally returns at once. It polls for up to 25 minutes. A red result does not end the wait: the log names the run to re-run (`gh run rerun <id> --failed`) and the job keeps polling while the run is re-run or a newer run for the SHA appears. A newer main push cannot substitute for this commit. |
| `web` | Builds release web assets once on Ubuntu with `VITE_ENABLE_REACT_SCAN=false`, checks bundle budgets and describes every file digest. Skipped when the DMG is reused. |
| `electron-package` | On macOS: installs dependencies, builds and verifies the native runtime, prepares helpers, bundles main, rebuilds native bindings, stages this run's web artifact and packages; `afterPack` fails the package on forbidden content or size growth (`scripts/check-packaged-app.mjs`, see [Electron packaging](../packages/electron/DOCUMENTATION.md)). Checks Cursor binaries, orchestration config and Info.plist descriptions. `scripts/release-candidate.mjs` writes `candidate.json` (bytes bound to source, run and attempt) and `release-manifest.json`. **Build reuse:** when preflight finds a retained DMG built at the same SHA, the job runs on Ubuntu and `release-candidate.mjs adopt` downloads it, verifies its bytes against the producer's identity and manifest (sha256 and size), and rebinds it to this run. The green dry run's DMG is preferred (`findGreenDryRun` in `scripts/release-candidate.mjs`); without one, the newest retained DMG of any earlier attempt or run at the SHA. |
| `upgrade-check` | Skipped on a tag push that adopts the green dry run's DMG: that dry run already qualified the same bytes at the same commit, and `deploy-backend` and `release` accept only that skip. Otherwise it starts from preflight without waiting for packaging. `release-preaged-upgrades.mjs` prepares a fresh profile with the previous supported release's own source and shipped runtime, creating retained and deleted history. It then polls this run's package job and candidate artifacts (shared 60-minute producer deadline), verifies identity and DMG digest, extracts once and runs the candidate hop, data-root migration, history checks and held recovery. Failures are classified (see Qualification). |
| `deploy-backend` | Before the publication lock, after trusted CI, packaging and qualification pass, and only when preflight's `deploy_backend` is `true`: links Supabase, syncs the authentication password policy, `db push` (idempotent) and checks migration history, in its own non-cancelling group. When no backend input changed it is skipped, so a Supabase outage cannot block a DMG-only release; `release` accepts that skip and no other. Migrations must stay backward-compatible because installed apps keep running. Re-run it alone after a Supabase outage; no release or DMG is touched. |
| `release` | The only job with `contents: write` and the only holder of the publication lock. `node scripts/release.mjs release` runs stage, the exact-source CI recheck and publish in one process with the staged state in memory (see Stage and Publish). It writes `staged.json` as an artifact for audit and resume. Success is promotion plus the ledger, and the hard check, with this writer token, that no draft of the version remains. |
| `post-publish-verify` | Read-only (`contents: read`), after `release`: `scripts/release-verify-public.mjs vX.Y.Z` (see Post-publish verification). A failure means "published, verification pending; rerun post-publish-verify", never a failed publication. It cannot see drafts, so its draft line is informational. |
| `verify-published` | Only for an already published version: downloads the original retained DMG artifact and verifies published bytes, ledger, shipped discovery and the public download, read-only. |
| `simulate-release` | Dry runs only: `node scripts/release.mjs release --simulate` runs the unchanged stage, promotion, ledger and post-publish verifier against the in-memory GitHub of `scripts/release-github-fake.mjs` with this run's real DMG and manifest, so the publishing code path runs on every dry run. It holds no token. |
| `visual-qa` | Required on dry runs: `scripts/qa/release-visual-qa.mjs` on the candidate DMG (see Release visual QA). |

The release uses at most two macOS runners at once (package plus runtime qualification; visual QA runs after package); a reused DMG needs none for packaging. With three native CI workers the combined peak is five macOS jobs, the GitHub Free limit. `release-cache.yml` is manual-only because native CI already verifies these inputs on every main push.

Main CI concurrency includes its commit SHA and does not cancel main-push runs; superseded pull requests still cancel. Every deterministic test remains covered by `validate:full`; `test-ci-lanes.mjs` splits portable and native files and the case shards, and suite contracts prove the inventory and disjoint shard union.

Each ready runtime-history hop opens its private workspace through `/api/opencode/directory` before listing or creating sessions. This registers the project and prepares its native location through the production path; an unregistered request directory cannot authorize session creation.

Installed QA explicitly selects a private Electron profile because macOS app-data paths do not follow `HOME`. On the admitted disposable host, the upgrade lane temporarily sets the same private HOME/XDG/profile values in its launchd context so the production LaunchServices relaunch retains isolation. Cleanup restores every previous value, including after partial setup or interruption; no account credentials or workflow tokens are included.

Visual and installed-upgrade QA use the read-only workflow token for GitHub release metadata to avoid shared-runner anonymous API limits. The candidate's own update check reads the exact `/releases/latest` status and body that QA fetched with that token from a loopback feed mirror: a test-process inspector redirects only the canonical feed URL, and the installed updater, its anonymous request and its parsing are unchanged (an anonymous check on a shared runner IP failed with "Release discovery is unavailable"). Public DMG downloads remain anonymous, the app environment does not inherit the token, and the post-publication public matrix still uses the real anonymous feed.

Installed-upgrade reports retain fixture discovery/download counters on failure. Inspected launches start with `--inspect-brk`, which also holds every `worker_threads` Worker until a debugger releases it (the session-mutation host is one, so 2.1.14+ apps and the candidate never became ready); the injection session stays open and releases each new worker. An attached debugger also keeps the owner from exiting, so QA closes its sessions once installer preparation has returned and before the owner quits for the installer.

**Shipped update-quit defect (deleted releases only).** Some deleted pre-reset apps bound update cleanup to 10 seconds while their web server waited up to 10 seconds for the renderer's live streams, so Restart to Update logged `update_cleanup_timeout` and kept running. Installed QA sent SIGTERM (the same `performConfirmedQuit` as Quit Now) for those baselines. No supported install (2.0.0 on) has the defect (`SHIPPED_UPDATE_CLEANUP_TIMEOUT_BEFORE`), so any baseline that logs the timeout fails. The web server ends live streams one second after `server.close()` (`shutdown-runtime.js`), and `finishQuitAfterCleanup` runs `afterCleanup` only when cleanup finished within its bound.

A failed installer stage records the owner's `ps` state and start time, its output tail and the Electron log tail, bounded and redacted, in `error.detail`. A baseline that never becomes ready reports its process state, page origins, health phase, last error and a bounded log tail, with a native screenshot. A test-process main inspector observes the real privileged download handler and forwards every IPC call and native progress notification unchanged, so renderer reloads cannot erase completion. The download observer requires advancing native byte-progress events and fails after 90 seconds without progress within its overall 20-minute transfer budget. After download it invokes the unchanged restart/install path and observes that IPC call in main too: installer preparation (candidate bundle, signature and native-runtime verification) runs inside it, and a refusal fails the lane at once with its product code and sanitized diagnostic rather than as a missing receipt. It then waits for the sealed production installer receipt to reach `complete`, and verifies the exact source/target versions, DMG digest, original owner, replacement process identity, installed bundle signature and runtime manifest, ready health and retained settings. LaunchServices does not preserve debugger flags, so post-install screenshots use native screen capture on the isolated host rather than requiring a debug port in the relaunched app.

`scripts/release.mjs` owns admission, stage, publish, the combined `release` operation, `--simulate` and published-byte verification; `release-github.mjs` the GitHub client (with an anonymous read-only mode); `release-github-fake.mjs` the stateful in-memory GitHub used by the tests and `--simulate`; `release-state.mjs` the same-version states, the ledger marker, the shipped-discovery contract, the payload budgets and the shipped release identity; `release-verify-public.mjs` the read-only post-publish verifier and the ledger reader; `release-status.mjs` the status report; `release-tag.mjs` gated tagging (`bun run release:tag`); `release-preflight.mjs` preflight, the pipeline-change gate, the backend-deploy decision and its clean-worktree runner; `release-candidate.mjs` candidate identity, the release manifest, the green dry-run lookup and build reuse; `release-ci-wait.mjs` the CI wait; `release-ci.mjs` the web handoff and the legacy prepared-tree archive.

## GitHub client and retries

`scripts/release-github.mjs` bounds every request (30 seconds; uploads 10 minutes per attempt). GET, PATCH, PUT and DELETE retry up to four attempts, including failures while consuming response bodies, with 1-2-4-8 second backoff on 5xx, 429, rate-limited 403 (honouring `retry-after`), timeouts and connection resets; POST is never blindly repeated. Listings follow pages, so more than 100 releases or runs are read. Every write passes `assertReleaseWritesAllowed` for the repository in its URL; an anonymous client refuses every write.

| Step | Retry | Bound |
| --- | --- | --- |
| GitHub REST | 4 attempts, backoff with jitter | 30 s per request |
| Asset upload | 3 attempts, reconciled by digest between attempts | 10 min per attempt |
| Late asset digest | polled every 2 s; an uploaded asset of the expected size without a digest is pending, never deleted | 10 min, then the job stops with the asset kept for a rerun |
| trusted-ci | keeps polling through CI re-runs | 25 min |
| Qualification `infra` failure | 1 automatic retry | job timeout |
| Qualification `product` failure | none | — |
| Post-publish discovery | 15 s polls | 10 min; the 60 s target is logged as a metric |
| Post-publish download | resumes a dropped connection with `Range` (3 attempts) | 60 s plus size at 5 MB/s (about 148 s for 438 MB) |

A crash at any request is safe. `scripts/release-convergence.test.mjs` aborts the `release` operation at every request index (connection failure before sending, effect committed with the response lost, 502, and truncated response bodies), reruns it from a fresh process against the same fake GitHub state, and requires exactly one published latest release with one asset carrying the manifest digest, one ledger tag, no drafts, no duplicated release, upload, promotion or ledger effect, and never a release published with zero assets.

## Stage

Inside the publication lock, `release.mjs stage` (the first part of `release`):

1. Checks the local DMG against `release-manifest.json` (name, size, sha256, version, source), the manifest's identity against what installed apps accept (see Updater contract), and the release-notes budget. A dry run stops here.
2. Re-checks the tag, the same-version state (below) and that no newer release is latest.
3. Creates or reconciles the one draft for the version (notes plus a `devryan-release:` marker comment naming the bytes, source and run) and deletes stale drafts.
4. Deletes only assets that are not exactly the candidate, then uploads the DMG streamed from disk. Before each attempt the asset list is reconciled: an uploaded asset with the manifest digest and size is kept; an uploaded asset of the manifest size whose digest GitHub has not computed yet is waited for (up to 10 minutes), never deleted; a partial `starter` upload, another size or another digest is deleted. A 422 `already_exists` reconciles instead of failing.
5. Verifies the exact one-asset set, checks that the projected payload stays under 2 MiB, and runs every shipped `discoverDesktopUpdate` (this checkout's and each supported release's whose discovery differs, vendored verbatim under `scripts/fixtures/shipped-updater/`; none since the 2.0.0 reset) against the draft as installed apps will see it once published: a fresh app and every installed version from 2.0.0 up to the previous published release must be offered exactly this DMG, and an app already on this version nothing. Nothing is public yet.
6. Writes the ledger's annotated tag object (`POST /git/tags`, see the published-bytes ledger). Nothing references it, so it is inert if the version is never published.
7. Writes `staged.json` (release and asset IDs, digest, size, both `updated_at` values, the marker and the ledger tag object) as an artifact and the step summary, and keeps it in memory for publish.

## Publish

`release` then rechecks exact-source CI (`requireTrustedCI`) and runs `publish`, which re-reads the draft and refuses if anything differs from the staged state: release or asset ID, tag, target, marker, asset count, name, state, size, digest or `updated_at`. It also checks that the staged ledger tag object names this version, marker and source. It then sends one `PATCH {draft:false, make_latest:true}`; nothing else about the release changes. The only write after it is the ledger ref (`POST /git/refs` to the staged object). It removes any other draft of the version and then asserts, with its writer token, that none remains. That is the success point: the job does not wait for the CDN. A rerun after promotion only records a missing ledger ref (its stage writes a fresh object). `release.mjs publish` still runs alone with `RELEASE_STAGED` (a `staged.json`) for a manual resume.

## Post-publish verification

`scripts/release-verify-public.mjs vX.Y.Z` is read-only and needs no retained artifact: the expected bytes come from the ledger tag. It works anonymously (as installed apps do); a token only raises the rate limit. It checks:

- `/releases/latest` (or the tag's release, when a newer version is already latest): tag, `html_url`, exactly one asset with the contract name, state, size, digest and download URL, and the 2 MiB payload budget;
- every shipped discovery offers exactly the ledger bytes, to a fresh app and to every installed version from 2.0.0 up to the previous published release;
- the body marker names the ledger bytes and the notes equal the `CHANGELOG.md` section of this checkout;
- no draft of the version is visible. Drafts are visible only to a writer's token, so for this read-only job the line is informational; the hard check is in the `release` job, which removes drafts and then asserts none remains;
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
- the single next action: `push-tag` (`bun run release:tag`), `wait`, `rerun-ci`, `rerun-failed-jobs`, `rerun-release` (a missing ledger), `rerun-post-publish-verify`, `rerun-installed-upgrades`, `bump-version`, `investigate` or `done`, with its command. `done` requires successful public discovery verification, and a successful installed-public-upgrade job when that job exists in the run. Failed installed checks name their read-only job for retry; skipped checks require investigation. Historical workflows without an installed-upgrade job retain their original discovery verification contract.

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

**Published-bytes ledger.** Stage writes an annotated tag object `devryan-release/vX.Y.Z`, and after promotion the `release` job writes only its ref. The message is `devryan-release: version=… sha256=… size=… source=… run=…/…`. It is write-once: an existing entry must name the same bytes. Because it outlives the release object, deleting and re-creating a published release (the v2.1.5 case) is refused. Releases up to v2.1.9 predate the ledger; `verify-published` warns when an entry is missing. Never run `gh release delete`, upload or edit assets by hand, or delete a `devryan-release/` tag: a published version is final.

Retrying (`bun run release:status vX.Y.Z` names the right one):

- **Infrastructure flake or red CI:** re-run the failed jobs (`gh run rerun <run-id> --failed`). If main CI failed, re-run CI; the waiting `trusted-ci` job picks up the re-run. Do not move the tag for a flaky test.
- **Code fix before publication:** commit and push the fix to `main`, wait for its CI, run a dry run of it, then `bun run release:tag -- --move`, which re-points the unpublished version's tag (`git tag -f vX.Y.Z <fixed-sha> && git push origin +refs/tags/vX.Y.Z`) after the same checks. The new run cancels obsolete build jobs for that tag (never the locked `release` job) and stage replaces the draft's asset.
- **Re-run at the same SHA:** the retained DMG is adopted instead of rebuilt (90-day artifact retention; intermediate web artifacts keep 14 days).
- **Published, verification pending:** rerun `post-publish-verify` (`gh run rerun <run-id> --job <job-id>`) or run `node scripts/release-verify-public.mjs vX.Y.Z`. A rerun of the whole workflow routes to `verify-published` with the original retained DMG. Missing or expired artifacts or differing bytes fail clearly; published bytes are never rebuilt.
- **Published without a ledger entry** (the `release` job stopped right after promotion): rerun the original `release` job named by `release:status`, which resolves the published marker to its run and searches all attempts for the actual writer. It only records the ledger and removes stale drafts. A whole-workflow rerun routes to read-only verification and cannot repair the missing ledger. If the original writer cannot be identified, status reports `investigate` instead of recommending a whole-workflow rerun.

For recovery beyond Actions retention, keep an authorized offline copy of the exact original DMG with its tag, source SHA, size, SHA-256 and original run URL. With that file in `RELEASE_ASSET_DIRECTORY`, the original `GITHUB_REF`/`GITHUB_SHA`, the canonical `GITHUB_REPOSITORY` and a read-only `GITHUB_TOKEN`, `node scripts/release.mjs verify-published` verifies without writes. Do not add backup files as public release assets.

Only the `release` job holds the global `devryan-production-publication` lock, with cancellation disabled; `deploy-backend` has its own non-cancelling group. GitHub concurrency is not a durable FIFO queue: a newer pending job may replace an older pending one. Because stage and publish run in one job, a replaced pending job never strands a staged draft between them; rerun a superseded unpublished release deliberately.

## Qualification

Setup failures in `upgrade-check` are classified by `scripts/qa/release-qualification-failure.mjs`. `infra` (a failed `gh`, `git`, `tar`, `ditto`, `bun` or `hdiutil` command, network errors and timeouts, a busy disk image, a corrupt baseline download) is retried once inside the job. `product` (candidate hop, migration, history or held-recovery failure, a changed candidate runtime, a failed producer) and anything unknown is never retried. The producer wait shares one 60-minute deadline across baseline preparation and acquisition retries: it covers the cold 20-minute web plus 35-minute package budgets with five minutes for queues. A failed web prerequisite or package job stops the wait immediately; the qualification job has an 85-minute cap for the producer wait, downloads, qualification and cleanup. These are failure bounds, not timing targets. The job log and each lane report carry the class and bounded error text (run paths replaced, opaque tokens removed). Details: [QA](QA.md#release-upgrade-lane).

## Final-DMG smoke (retired from the workflow)

The `final-dmg-smoke` job was removed. It failed in every release run from v2.1.8 through v2.1.10 (and passed only for v2.1.7): the composer never submitted (`release_dmg_renderer_submit_failed`, zero provider requests) because Builder's shipped model `openai/gpt-5.5` was unavailable in the private profile. The smoke's `settings.json` `agentModelSelections` apply only to managed non-admin users, and the packaged Builder agent's model wins over the smoke's `opencode.json` entry. `scripts/qa/release-final-dmg-smoke.mjs` stays as a library and a manual tool. Required visual and installed-upgrade checks now cover packaged startup and update behavior; they do not claim a live-provider composer test.

## Dry runs

A dry run is required before tagging: both `bun run release:tag` and tag-run preflight refuse a commit without a green one. `gh workflow run release.yml --ref main` runs preflight, packaging and runtime qualification with `RELEASE_DRY_RUN=true`, then simulation and visual QA, and stops; production deployment, publication and public verification run only on a tag push. Its DMG (90-day retention) is the one the tag run adopts, so a dry run must be of the exact commit to be tagged. Candidate description verifies the packaged native runtime's full artifact inventory before publishing candidate identity. A dry run cannot write releases: every GitHub write goes through `assertReleaseWritesAllowed`, which refuses dry runs and noncanonical repositories. The simulation uses only its in-memory GitHub; installed qualification uses public baseline downloads plus the manifest-pinned candidate transport fixture. `scripts/release-workflow.test.mjs` checks the workflow side of this contract.

Locally, `RELEASE_ASSET_DIRECTORY=<dir with the DMG> RELEASE_MANIFEST_PATH=<release-manifest.json> node scripts/release.mjs release --simulate` does the same. `stage --simulate` and `publish --simulate` run separately share the simulated GitHub through `RELEASE_SIMULATION_STATE` (a file path that `publish` removes).

## Release visual QA

`scripts/qa/release-installed-upgrades.mjs` owns baseline selection, serial installed qualification and aggregate reports. `scripts/qa/release-updater-fixture.mjs` owns the loopback candidate transport and inspector injection expression; `release-visual-qa.mjs` owns inspected process launch, UI checks, installer restart and private-profile cleanup. These are QA-only entrypoints and are never imported by the packaged app.

`scripts/qa/release-visual-qa.mjs (--dmg <absolute DMG> | --version X.Y.Z) --report <absolute report.json> [--manifest <release-manifest.json>] [--upgrade-from vA.B.C] [--candidate-upgrade] [--isolated-host] [--keep-artifacts]` is required in dry runs. It never runs beside the owner's app, because launchd labels live in the real `gui/<uid>` domain whatever HOME says. It requires a GitHub Actions runner or `--isolated-host` (a separate macOS user or VM), and it refuses while any `DevRyan` process runs for the user. Each step writes a screenshot next to the report, and `report.json` records their SHA-256:

- **DMG.** The sha256 matches the manifest and, once published, the release digest. The DMG mounts read-only with `DevRyan.app` and an Applications link. The app is `ditto`'d into the run root, never `/Applications`.
- **First launch.** The app starts on a private HOME/XDG profile with a mock keychain and CDP. The report captures `splash.png`, then `ready.png` once OpenCode is ready, with no error toast.
- **About.** It shows exactly `X.Y.Z`, matching `CFBundleShortVersionString` (`about.png`).
- **Update check.** Against the real `/releases/latest` bytes, served by the loopback feed mirror, it offers exactly what that release implies, which is nothing while the candidate is newest (`update-check.png`); the mirror must have been asked.
- **Update path** (`--upgrade-from v2.0.0`). Skipped (`status: skipped`) when the baseline does not predate X.Y.Z, as for v2.0.0 itself. Otherwise the older public DMG is installed under the private HOME's `Applications` directory, an actual installer-supported application root. It must be offered X.Y.Z, download it, restart into it and retain the private port, directory and LAN settings (`upgrade-*.png`). Public mode requires X.Y.Z to be latest. Candidate mode additionally requires the local DMG and manifest; a test-only main-process inspector redirects only the two exact canonical GitHub fetch URLs to a loopback fixture pinned to the candidate digest and size. The installed updater and installer remain unchanged. No feed override enters production code, settings or environment. Inspector setup is verified with a real isolated Node process; full Electron execution still requires the isolated macOS runner. A required matrix lane treats every skipped upgrade as failure.
- **Quit.** No process is left running from the run root.

The run root is removed on success, failure and interruption. The workflow runs it on every dry run (`visual-qa`) and uploads `release-visual-qa`. Manual checks that remain for an isolated host:

- the Finder mount window and the Gatekeeper first-open path of the quarantined ad-hoc app;
- the offline or rate-limited "Release discovery is unavailable. Retry later." state;
- an interrupted download resuming;
- killing the installer mid-swap (installer intent phases in `packages/electron/desktop-update-install.mjs`);
- the release page showing exactly one asset, marked Latest, with no drafts (`release-verify-public.mjs` checks this too).

## Owner decisions

- **Immutable Releases** (repository setting, currently off: `GET /repos/1H-Team/DevRyan/immutable-releases` → `{"enabled":false}`). Turning it on makes published bytes final at the platform level and adds release attestations. It is compatible with the draft-first upload: assets are attached while the release is a draft. The ledger stays as the cross-check. The pipeline never changes repository settings.
- **Installed QA cost.** Installed in-app upgrade QA is no longer run by the workflow (owner decision 2026-10-26). Record visual QA durations separately from tag-to-discovery latency.
- **Supabase before the lock.** `deploy-backend` now runs before `release`, so a release that fails after deployment leaves the new migrations applied. They must stay backward-compatible with installed apps, as they already had to.

## Timing acceptance

The interim target is **13–15 minutes** and the final target is **at most 10 minutes**, measured from the tag-push release run's `created_at` through successful updater discovery (the `[release] updater-discovery-verified-at` log timestamp in `post-publish-verify`), including queues, publication and cleanup. Main CI and the required dry run now finish before the tag exists, so they are not part of this window; record them separately as the pre-tag time (main CI `created_at` to the dry run's completion), because that is what the owner waits for before `release:tag`. Neither target is demonstrated yet. For each of the next three routine releases, keep the main CI, dry run and release run IDs, the SHA, each run's creation and completion times, the discovery timestamp, both totals, job queue and run times and qualification phase reports. Claim the final target only if all three tag-to-discovery totals meet it.

Qualification reports contain baseline identities and phase durations for downloads, installation, historical hops, candidate hops, held recovery, report writing and scratch deletion. Cleanup is measured, including on failure; private homes and raw process logs never become artifacts.

## Removed Bots

Bots were removed from the app: there is no Bot code, Docker use, Bot image build or packaged Bot resource. Existing Supabase migrations, including the Bot tables, are kept unchanged so migration history stays valid; `deploy-backend` still verifies migration history and authentication configuration.

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
| `bun run release:tag` | Push `vX.Y.Z` at `HEAD` once main CI, a dry run and preflight passed at it; `-- --check` checks only, `-- --move` re-points an unpublished version's tag |
| `node scripts/release-verify-public.mjs vX.Y.Z` | Read-only post-publish verification of a published version |
| `node scripts/release.mjs release --simulate` | Stage, publish and verify against the in-memory GitHub (`RELEASE_ASSET_DIRECTORY`, `RELEASE_MANIFEST_PATH`) |
| `bun run build` | Web assets and the Electron main bundle; no native build |
| `bun run --cwd packages/electron prepare` | Web staging, native helpers, main bundle, native ABI rebuild |
| `bun run electron:build` | Full local preparation and packaging |
| `bun run --cwd packages/electron package:prepared --publish=never` | Package prepared inputs |
| `bun run app:check` | Packaged content and size check of `packages/electron/dist/mac-arm64/DevRyan.app` (`-- --app <path>` for another, `--arch x64` for an Intel build) |
| `bun run pack:web` | Locally installable web tarball (not released) |

## Updater contract

Installed apps read `https://api.github.com/repos/1H-Team/DevRyan/releases/latest`. They need a published, non-prerelease release tagged `vX.Y.Z` with exactly one uploaded `DevRyan-X.Y.Z-arm64.dmg`, whose GitHub-computed `digest` and size they verify after download, and a response under 2 MiB (they keep 64 KiB of the body). Nothing else (no `latest-mac.yml`, ZIP or blockmaps) is used. The installer then requires a single-arch arm64 `DevRyan.app` whose `CFBundleShortVersionString` equals the tag, `CFBundleExecutable` is `DevRyan`, `CFBundleIdentifier` is one the installed version accepts, and whose signing mode matches the installed app (ad hoc).

The repository name, the `html_url` and download URL formats, the tag format and the ad-hoc signing mode are compared literally by every installed 2.0.0+ app. `SHIPPED_RELEASE_IDENTITY` in `scripts/release-state.mjs` records them. `scripts/release-convergence.test.mjs` checks them against this checkout's updater and installer (what every supported install runs since the 2.0.0 reset) and the packaging configuration, and stage refuses a manifest that breaks them. Do not rename or transfer the repository or organization, change the tag format, or move to Developer ID signing or notarization: each needs a bridge release that installed apps accept first. Installed updaters are unauthenticated (60 requests per hour per IP); a shared NAT can show "Release discovery is unavailable". `scripts/release-packaging.test.mjs` and `scripts/release-state.test.mjs` check the packaging configuration and the bundle identifier against the current installer and every vendored shipped installer, and golden API fixtures (`scripts/fixtures/github-api/`) keep the discovery projection honest to GitHub's real field shapes. When a future release changes discovery or the installer, vendor the previous shipped copies under `scripts/fixtures/shipped-updater/<tag>/` and list the tag in `SHIPPED_DISCOVERY_TAGS`.

## Installer candidate verification

Before an installed app stops for an update, its own installer verifies the mounted candidate. Every supported installer (2.0.0 on, `PIN_FREE_INSTALLER_SINCE`) uses `verifyUpdateCandidateArtifacts`: manifest digest and schema, inventory, per-file digest, size and mode, macOS signatures and the launcher, plus bundle identity, architecture, ad-hoc signing match and DMG digest; the candidate's own startup verification enforces its Bun and reviewed-asset pins. Toolchain and provider upgrades therefore stay installable. Deleted pre-reset installers pinned the candidate's Bun and reviewed asset digests (`verifyNativeRuntimeArtifacts`), which stranded some of them at "Restart to update".

`scripts/fixtures/shipped-updater/candidate-pins.json` records the Bun version and the four reviewed asset digests of every pinned installer from the floor; it is empty because no supported installer is pinned. Preflight re-reads pins from each tag in range (`git show`), requires the record to equal them, and reports, without failing, each recorded installer this checkout's `NATIVE_BUNDLE_BUN_VERSION` and reviewed asset constants would strand. Do not reintroduce a pinned installer.
