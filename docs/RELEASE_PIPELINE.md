# Release builds and artifact handoffs

Candidate preparation builds one web artifact, verifies eight Bot images (six execution
images plus the local catalog's `database` and `rest`) with at most three
image jobs running concurrently, and one Apple silicon (arm64) Electron
preparation. Final Electron packaging waits for all three verified inputs.
Intel (x64) macOS builds were dropped in 1.2.10 to shorten the release; the
local `--x64` packaging paths remain but are not released.

Version 2.0.0 ships the macOS Apple silicon desktop app only. Tag-triggered
releases default to `desktop-macos-arm64`; manual runs expose the same scope
choice. This scope skips web/npm publication and its tarball requirement while
retaining every desktop, updater, signed Bot image, packaging and hosted
migration gate. A manual `full` release retains the universal web platform
requirements and refuses admission before heavy work while those native artifacts are missing.
Discord announcements require the explicit manual `announce` input; releases
do not dispatch updates to an upstream website.

Since 2.0.1 the public release carries exactly one asset for the desktop scope,
`DevRyan-<version>-arm64.dmg`; `full` adds the web tarball.
`scripts/verify-release-assets.mjs` enforces that exact allowlist. Packaging
produces only the DMG; ZIP, blockmaps, updater metadata and `electron-updater`
are removed. The Bot image manifest remains an internal workflow artifact.
Installed 2.0.0 and earlier apps require a manual DMG install. The shipped
2.0.1 Update action opens the release download. The 2.0.2 installer owner
discovers the exact published asset with size and SHA-256, supports verified
resume, stages a read-only mounted DMG, and preserves the original app until
startup is acknowledged. Path, signing class, native runtime, service bridge
and disk checks precede runtime drain. Rollback requires candidate cleanup and
process-exit evidence; ambiguous settlement preserves both copies and intent.
macOS remains ad-hoc signed, without notarization.

Release install steps set `DEVRYAN_SKIP_INSTALL_PREPARE=1`. Without it, Bun runs
the Electron workspace `prepare` script (a full web build plus native helpers)
during every install, duplicating the shared web artifact and the explicit
native steps. Explicit `bun run prepare` invocations are unaffected.

## Commands

| Command | Outcome |
| --- | --- |
| `bun run build` | Web assets and Electron JavaScript bundle; no native build or publication |
| `bun run type-check:ui` | Source-only UI validation |
| `bun run build:ui` | Compatibility alias for UI type checking |
| `bun run pack:web` | Compile web and create a locally installable tarball with private runtime closure |
| `bun run build:electron` | Electron main JavaScript bundle |
| `bun run --cwd packages/electron prepare` | Web staging, native helpers, main bundle, native ABI rebuild |
| `bun run --cwd packages/electron package:prepared --publish=never` | Require/stage the release Bot manifest, package prepared inputs, verify runtime-service artifacts |
| `bun run electron:build` | Full local preparation and packaging convenience command |
| `bun run desktop:build` | Existing legacy Tauri sidecar and native build |

Package-local UI `build` remains a compatibility type-check alias. New automation
uses `type-check`. Root build deliberately names its outputs rather than invoking
every workspace's build script. Full validation remains separate from compilation.

## Release graph

1. Validate frozen package metadata, supported scope and the exact tag source. Admit the first source SHA into the draft and retain its release ID before heavy work. A version cannot be retagged or reused for another source, even after draft removal. Stable version writers share one non-cancelling concurrency owner.
2. Candidate runs, and supported full-scope web packaging, validate UI types and compile web assets once, prepare arm64 native dependencies and
   helpers, and resolve all eight image inputs once. Image builds use individual
   GitHub Actions cache scopes with full intermediate-layer export.
3. The read-only resolver computes each input digest (`scripts/bot-runtime-image-inputs.mjs`).
   When `<repository>:in-<digest>` exists, passes `cosign verify` for `release.yml` at a
   `refs/tags/v*` ref, has complete SBOM/provenance attestations and pulls anonymously,
   the job emits that image as its result without building. Otherwise it builds,
   signs its index and both platform digests, emits one result and, on tag-triggered
   runs only, tags the signed index `:in-<digest>`. The manual `rebuild_bot_images`
   input rebuilds every image; base images are pinned by digest, so a base refresh
   is a reviewed Dockerfile change.
   The aggregation job requires eight distinct results for the same version,
   revision, repository, OpenCode/schema versions and plugin hash. It validates
   platform/attestation completeness, anonymous pull access and production
   anonymous access before exposing the complete manifest. Packaging and the
   topology smoke then run independently; final publication requires both.
   The topology smoke
   runs in an isolated `devryan-smoke-<hex>` namespace, creates, initializes and
   migrates the catalog volume the way Electron does, and waits for the fixed services,
   `database` and `database-rest` to become healthy.
4. The full-scope npm packaging job consumes the web artifact and bundles private workspace runtime packages. Publication belongs to the finalizer after qualification.
   Electron consumes web assets, prepared native files, and the complete Bot
   manifest, then runs all existing packaged artifact gates.
5. Each packaging job records the actual installer/tarball SHA-256. Three fresh
   `macos-26` candidate jobs consume the same retained DMG from the exact intended
   tag SHA. A separate pre-tag job uses the frozen published baseline tag SHA and
   DMG digest with the existing compiled native package acceptance, including
   real clone, candidate work and rollback. A PR merge SHA cannot qualify another
   source SHA. Stable admission requires the complete successful candidate run.
6. Stable desktop-only runs skip unused UI/native preparation and download the exact admitted candidate DMG; they never
   rebuilds or repackages it. Expired candidate artifacts fail admission rather
   than falling back to a build. The exact final tag DMG runs one mandatory short GUI smoke, including the first
   hotfix. It extracts the unchanged app, launches the ordinary native backend,
   sends one local HTTP model prompt and reopens its persisted history. The
   eleven-scenario runner remains separate; its historical approximately
   40-minute receipt is neither shortened nor substituted for the short smoke.
7. The existing finalizer is the sole stable public asset uploader. It verifies
   staged scope assets and the short receipt before hosted deployment. Uploads
   require the admitted draft ID and immutable source; an identical digest is
   reused on retry and conflicting bytes fail without replacement. The complete
   exact allowlist is checked before and after promotion. A published retry is
   read only and needs the original successful finalization/deployment attempt
   and its frozen asset digests in the original immutable finalization workflow
   artifact. Docs source is a workflow artifact only.

Before deployment or npm publication, the finalizer reads the exact final JSON,
digest witness and external I/O observation and checks their source/version,
run/attempt, retained DMG/app/manifest identity and every frozen phase allowance.
The final smoke retains its qualified identity and budgets in a separate
90-day workflow artifact. The same read-only validator runs again before public
asset finalization; a missing, foreign or changed receipt fails before external
deployment/publication writes.

The `candidate=true` workflow mode derives version from checked-out metadata and
forces `RELEASE_DRY_RUN=true`. It prohibits every external writer, including
GitHub release/tag writes, image signing/tagging/publication, npm, hosted
migrations and announcements. Changed Bot inputs must first use the existing
immutable inputs-only tag lane; its `release.yml@refs/tags/v*` cosign trust is
unchanged. Candidate and final DMGs are retained for 14 days; admission, packaging, GUI
attempt, frozen budget and compiled upgrade/rollback receipts are retained for 90 days.
Tag admission must fit within that candidate retention window. Expiry requires a
new qualified cohort; it never permits replacing a conflicting asset or rebuilding
bytes as proof of the expired candidate. The candidate workflow freezes and checks
its feasible budget after all three rehearsals and upgrade/rollback. Stable source
admission repeats that resolver before creating a draft, including read-only
pre-tag checks; promotion repeats the retained final receipt/budget validation.

The rehearsal caps are 150/120/60/30/90/30/60/30 seconds for inspection, first
readiness, chat, stop, reopen, history, cleanup and receipt. Final limits are
`ceil(3 × slowest of three green rehearsals)`, with 10-second I/O and 30-second
readiness floors. The three rehearsals require distinct original hosted runner
IDs; copied successful siblings retain their original producer's ID. Their sum
must fit 570 seconds after GUI prerequisites.
Preflight hashes, retained attempts and GUI admission share a separate 180-second
setup allowance, recorded as `setup.limitSeconds`, `setup.elapsedMs` and
`setup.status`. The allowance reserves time for installer hashing, bounded GitHub
inventory and GUI compilation on a fresh runner; setup expiry is an evidence failure and
grants no GUI retry. GUI cleanup retains its independent five-second stop attempt,
and pre-app receipt I/O has its own 30-second bound. After GUI admission, smoke
operations share the remaining absolute deadline and reserve cleanup/receipt
time. Deadline and cancellation flow into the original QA owners; phases await
settlement before cleanup. A JSON receipt alone is pending proof: its
post-rename `.receipt-io` witness binds exact bytes. The outer receipt owner then
measures settled JSON and witness I/O in a required `.receipt-observation`, bound
to both files' digests. This measurement explicitly excludes the observation's
own commit; that commit remains bounded by the same captured receipt and absolute
deadline. Qualification requires all three files. The qualification ordinal and
numeric hosted runner identity are bound into the receipt and both I/O witnesses;
GitHub's global run attempt remains a separate correlation value. Late or failed writes remove
qualifying JSON, witness and observation files and retain a failed
partial artifact. The initial executed qualification plus at most two fresh-runner
retries may reuse the same run/source/sample and retained DMG after typed pre-app
GUI unavailability. Skipped jobs and positively proven queued cancellations do not consume this allowance;
a queued GitHub job may have `started_at` despite empty steps and an explicit null/zero runner.
Actual steps, an assigned runner or an original receipt prove execution. Missing
fields alone cannot excuse a failure. A receipt-proven execution consumes its
qualification ordinal even when the API omits the runner; any assigned API runner
must agree with the original receipt. Copied successful siblings from **Re-run
failed jobs** reuse the original producer only when their name, runner, execution
timestamps and complete nonempty steps match; they do not consume an execution
ordinal or require a new artifact.

An initial gate at global workflow attempt 8 is still qualification 1. Every earlier receipt must
prove no app start, zero fixture attempts and safe cleanup. Product, boot,
fixture, journal, evidence and cleanup failures cannot be erased by a retry or
new version. Earlier candidate, final and legacy job attempts are checked,
including the current run. Retry admission is inside the smoke receipt boundary,
so refusals retain failed evidence without starting the application. Each retry
must match the actual previous job, ordinal and runner ID, and use a different
GitHub-hosted runner. A failed prior-artifact download reaches that same guard;
missing proof never excuses an executed job. Two unexplained gate failures across the last ten
distinct prior stable versions block the next write admission. Every unexplained
failed gate job/attempt counts, including two candidate failures in one run.
Read-only correction rehearsals remain available for a new source/version under
the source reuse guards. Write admission then requires a newer, exact-source
candidate run started after the unresolved failures: all three actual green
startup receipts, their common installer/app/manifest identities, derived phase
budgets, frozen packaging metadata and upgrade/rollback proof must qualify. The
same candidate resolver owns ordinary and repaired admission; no override flag
or failure pardon is stored. Failed same-source/version product retries remain
forbidden. Version identity comes
from the immutable admission artifact (or exact-source retained legacy gate
receipt), including candidate dispatches from branches such as `main`; changing
source or dispatch branch cannot discard those failures. Legacy `workflow_dispatch`
branches also use `package.json` at the exact source SHA, after trusted repository,
workflow path and event checks. This establishes identity only; it grants no
failure pardon. The scan classifies the bounded run inventory first, then reads
jobs for the ten most recent versions with executed gates, all older runs of those
versions, and the intended source/version. Admission-only versions do not consume
that window. Pagination is capped at ten pages per inventory, source metadata at
600 distinct SHAs, job inventories at 650 and total JSON API/artifact reads at 900
per invocation. Exhaustion or malformed evidence stops admission with a retained
`complete: false` classification and request count. Completed scans retain
`complete: true`; identity metadata is reused only within the invocation.
For local GET-only diagnosis, the existing CI entrypoint accepts
`RELEASE_OPERATION=history-read` with the exact `GITHUB_SHA` and canonical
`GITHUB_REPOSITORY`. It uses the saved gh owner without reading credentials,
refuses non-GET requests, caps the diagnostic at 120 API/artifact reads and
writes `history-classification.json` to `RELEASE_ARTIFACT_DIR`. Incomplete history
returns nonzero with its request count and last route; a partial failure count
never qualifies admission. Exact-source release admission markers and the compact
identity inventory carried forward inside the existing immutable admission
artifact can identify old cohorts after their attempt payload expires. These
inventories contain no failure pardon: missing, partial, corrupt or expired attempt
evidence counts an executed failed job as unexplained without aborting the whole
trusted history scan. It cannot qualify a successful candidate. Skipped gates and
cancelled jobs proved never started are excluded. Executed legacy gates remain in
history; an exact stable push tag may establish their identity only after its
current commit is checked against the historical source. Unknown identity still
fails closed. Admission-only runs retain their source/version fence and identity
inventory but do not displace executed gates in the ten-version failure window.
Successful qualification requires all retained original evidence.
Expired evidence outside the ten-version window does not block future tags once
its version/source identity is authoritative. Unknown historical identity fails
closed. Candidate source and budget qualification precede stable draft creation. All workflow attempts
for each selected version are inspected; successful no-op dispatches cannot
evict earlier failures or displace the tenth prior version with the current run.
The current run is excluded only from the rolling window. Source admission
separately checks its earlier gate attempts before heavy work or image writers,
using the retained installer metadata and exact-source attempt receipts. Only
typed pre-app GUI failures with zero fixtures and safe cleanup permit up to two
fresh-runner retries of the failed gate jobs. Use GitHub Actions **Re-run failed
jobs**, retaining the original successful admission and packaging jobs. A
whole-workflow retry after retained admission or candidate packaging receives the bounded
`release_retry_failed_gate_jobs_only` refusal before heavy work or image writers,
so immutable admission/packaging artifacts are never rebuilt or re-uploaded.
Missing retained identity/evidence refuses admission. A published retry first
verifies the original finalization/deployment artifact and remains read only even
if that run had earlier GUI failures. It reuses a same-run admission artifact
only after exact source/version/scope/release-ID verification and skips its
immutable upload; a fresh no-op run retains its own admission artifact.

After promotion, the finalizer retains the original source/release ID, asset
digests and verified deployment proof before discovery. It passes the actual
`/releases/latest` response through the desktop updater's `discoverDesktopUpdate`
parser, retrying only these read-only requests at most six times within one
30-second interval. Version, release ID, installer name, SHA-256, byte size and
canonical URL must match. The workflow uploads the small original finalization
proof even when discovery fails. A later no-op may recover that specifically
retained pending discovery after checking its original deployment/publish job,
release ID and exact asset inventory; missing original proof still requires
review and permits no asset writes. Successful publication retains verified
discovery. Recovery from retained pending discovery uses the same six-read,
30-second parser interval; it never repeats deployment or asset writes. An older
published release verifies its own original parser/proof and
release ID; it must be latest unless the latest published stable release has a
strictly newer version and a different release ID. Windows append/full-scope
proof remain separate.

The manual Developer-ID Electron lane stages
`DevRyan-manual-Developer-ID-<version>-<macos>-arm64.dmg`, distinct from the
canonical stable installer. The retained legacy Tauri lane stages
`DevRyan-legacy-tauri-<macos>-arm64.dmg`. Both direct-download artifact containers
use `DevRyan-` names, retain DMGs for 14 days and perform no stable release writes.

The [release rectification regressions](audits/2026-10-14/release-rectification.json)
record the deterministic history, retry, receipt and updater checks; they do not
qualify hosted GUI behavior or a public release.

macOS preparation builds and verifies the pinned native v2 runtime with Bun
1.3.14. `release-cache.yml` now verifies those same inputs from `main`, without
restoring an old companion. Fresh checkouts first restore the oversized Claude
executable through `scripts/hydrate-reviewed-claude.mjs`, which checks the exact
npm archive and executable digests before installation. Do not cache the Bun
package store: on 2026-09-23, restoring the ~800 MB
archive took longer than downloading packages (ARM 163s before, 62s restore +
188s install after). Jobs have timeouts, so a stalled native fixture fails the
release instead of holding it open.

Fresh native builds compile the confined execution launcher when no accepted
launcher exists. Its `--verify` acceptance suite runs with Node even when Bun
invokes the builder, because the suite uses `node:test` hooks. The acceptance
marker is written only after that suite succeeds.

Failed image jobs can be rerun within the same workflow run; successful results
remain available. Image artifacts use stable per-image names with overwrite on a
rerun. Missing, duplicate, stale or incomplete results fail aggregation. Cache
misses rebuild normally; no validation gate depends on a cache hit.

## Artifact contracts

`scripts/release-artifacts.mjs` owns internal version-1 web/native handoff checks.
Web metadata records release version, full commit, lockfile SHA-256, production
build options and checksums for every output file. All HTML entrypoints, service
worker, static files and `.vite/manifest.json` travel together. Consumers reject
stale or corrupt input without an implicit rebuild.

Prepared Electron artifacts use a multithreaded zstd tar archive
(`prepared.tar.zst`) to preserve executable permissions and relative symlinks. Metadata binds the archive checksum to commit, lockfile,
release and target architecture. The archive contains installed workspace
dependencies, compiled helpers and the main bundle. It contains no user profile
or build credentials. Packaging restores it into a fresh checkout without running
another dependency installation that could replace rebuilt native binaries.

`scripts/release-ci.mjs` is the fixed-operation CI adapter. `RELEASE_OPERATION`
selects `asset-describe`, `image-plan`, `image-resolve`, `image-sign`, `image-assemble`, `web-describe`, `web-stage`,
`web-pack`, `prepare-export` or `prepare-import`, plus the fixed admission,
candidate resolution, smoke budget and finalization operations.
`scripts/release-publication.mjs` owns draft admission and the existing finalizer's
GitHub checks; it is not another publication workflow. Artifact verification remains in reusable
core functions. Internal handoff artifacts are not public release assets.

`packages/electron/scripts/package-prepared.mjs` is the production packaging
boundary. Bot-manifest validation is mandatory there, including local builds;
plain main-process compilation does not require a release manifest. The manual
macOS workflow's Electron build downloads the internal Bot manifest from an
explicit successful immutable inputs-only run, checks the exact source and
workflow identity, and preserves signature verification. Its packaged input uses
`DevRyan-<version>-arm64.dmg`; the downloadable manual artifact is staged as
`DevRyan-manual-Developer-ID-<version>-<macos>-arm64.dmg`. Test-only QA shells
remain separate.

## Ownership and maintenance

Workspace consumers declare their own dependencies. Root dependencies cover root
scripts and repository visual fixtures; root development dependencies cover
shared tooling. The terminal adapter, pinned WASM and symbols font are vendored
under `packages/ui/src/lib/ghostty`; normal builds consume checked-in artifacts.
The former terminal package, patch and ambient types were removed together.
Rebuild instructions and license/provenance records live beside the adapter.

`scripts/pack-web-release.mjs` stages the npm package with its five private runtime
workspaces bundled under their existing identities and versions. It removes
workspace protocols from published dependency metadata and promotes the bundled
runtimes' existing external requirements to normal installable dependencies. This
prevents npm's `EUNSUPPORTEDPROTOCOL` outside the monorepo. Conflicting external
ranges or unknown workspace references fail packaging rather than choosing a
new version. Source manifests keep workspace references for development.

Electron settings/host/window persistence lives in `desktop-settings.mjs`; menu
construction and dispatch in `desktop-menu.mjs`; OS notifications in
`native-notifications.mjs`. Factories receive native services and live accessors.
Main retains runtime ownership, IPC authorization and startup/shutdown order.
Server harness skill discovery and HTTP compression policy are similarly
dependency-injected modules, leaving registration order in the server entrypoint.

## Verification and performance

Run full validation, root build, bundle checks, docs validation, isolated web and
Electron QA, and packaged native checks before release. Handoff tests cover stale
identity, altered/missing bytes, architecture mismatch, incomplete image results,
signing failure and packaging failure propagation.

Packaged runtime-service verification checks the unpacked app and read-only
mounted DMG one after another. Keep it serial: running the previous three deep
codesign checks and x64 Rosetta probes concurrently raised x64 packaging from
326s to 776s on 2026-09-23.

The five runs inspected on 2026-09-07 took approximately 20–24 minutes. The latest
run took 20m08s: Bot image publication 13m14s, followed by roughly six minutes for
the slower Electron job. Workflow steps now report image build, signing,
verification, native preparation and packaging timings separately. Compare total
duration and step timings across subsequent authorized warm- and cold-cache
releases. A 30% warm-cache reduction is a target, not a verified result.

`dry_run` prohibits GitHub release/tag creation and uploads, registry publication
and input tags, npm publication, database deployment and notifications. It keeps
internal workflow handoffs and checks staged assets locally against packaging
digests. Signed-image and native/package gates remain mandatory: if an image's
inputs changed and no verified signed image exists, the dry run refuses that
image lane before publication rather than manufacturing development evidence.
Bot build/sign/tag functions also enforce this prohibition in core code. Local
fixture verification uses fake registry commands and makes no external writes.

When changed image inputs prevent a dry run, `prepare_bot_inputs_only` prepares
the eight signed inputs and runs anonymous-access and topology checks without
creating a GitHub Release, app assets, npm publication, database changes or
notifications. Dispatch `release.yml` manually from an immutable
`v<version>-bot-inputs-<first 12 commit SHA characters>` tag, with the package
version as `version` and `prepare_bot_inputs_only=true`. Pushing that purpose
tag does not trigger the ordinary release workflow. The preflight requires the
exact tag/source/version and workflow identity; the CI adapter refuses every
non-image operation in this mode. Images receive source and input-digest tags,
without advancing the release-version image tags. The existing `refs/tags/v*`
keyless signer trust remains unchanged. A dry run in this mode still cannot
publish missing images. After successful preparation, run the read-only release
qualification from the final source and require all original release gates.

`windows.yml` provides separate `windows-2022` x64 and `windows-11-arm` ARM64
qualification jobs with Bun 1.3.14, native MSVC environments, compiled supervisor
acceptance, controller/writer checks, pinned-runtime stdio probes and per-user NSIS
installation/update recovery. It has only read permissions. Native namespace
durability, supervision and runtime compatibility must pass before installer
scenarios run. These jobs do not open runtime admission or publish a release.
See [Windows port](WINDOWS_PORT_PLAN.md).

Each release keeps one frozen tag/source for all platforms. Windows qualification
and append derive the version from matching root and Electron package versions.
Publish the qualified macOS DMG first, then use `windows-release-append.yml` with
that full source SHA, the original macOS publication run ID, and the successful two-architecture
Windows qualification run ID. Its default `dry_run=true` verifies without uploads.
The read-only preflight requires actual native, compiled acceptance and NSIS
installation/update outcomes on both architectures, plus the completed macOS
publication gates. Startup diagnostics and boot-refusal receipts cannot satisfy
those gates. The implemented `Qualify per-user NSIS installation and updater recovery`
stage records blockers explicitly; both native Windows runs remain required.
The macOS publication verifier requires the unique ARM64 matrix job identity,
`build-desktop-electron-macos (aarch64-apple-darwin, arm64, darwin-aarch64)`.
Source fixes after publication require a new version and qualified source; do not
move the published tag or append installers from a different source.

The macOS packaging job retains its source/version/name/size/SHA-256 receipt
as `DevRyan-macos-arm64-packaging` for 90 days. Windows qualification must retain
`DevRyan-windows-installer-{x64,arm64}` with the exact installer and
`qualification.json` and its digest-bound `evidence.json`. The append owner requires
explicit acceptance, matching source and installer identities, passing prerequisites
and all five installation/update/refusal/interruption/rollback scenarios. It compares
those receipts with held local bytes and verifies the downloaded macOS digest before any upload. It creates no
release or tag, preserves the existing macOS asset ID, uploads only the two
Windows installers and requires the exact existing `desktop` allowlist. A retry
may reuse an already uploaded Windows asset only when its packaging digest
matches. Unknown assets or uncertain integrity stop the append without deleting
the existing release.

## Windows compatibility preview

The separate `windows-preview.yml` lane builds per-user x64 and ARM64 NSIS
installers against stock OpenCode 2.0.20. It selects the packaged
`standard-preview` mode before native bootstrap, uses a distinct application
identity/data directory, and has no automatic-update feed. It does not change
stable version parsing, native acceptance or published `v2.0.2`.

Windows preview tags are excluded from the stable release workflow; its version
parser and production acceptance checks remain unchanged.
Docs-source automation also excludes preview tags, including manual tag inputs,
so it cannot append an archive or dispatch website docs sync for this lane.

The initial prerelease is `v2.0.3-windows-preview.1`; its exact public inventory is
`DevRyan-2.0.3-windows-preview.1-win-x64.exe` and
`DevRyan-2.0.3-windows-preview.1-win-arm64.exe`. Runtime archive integrity and PE
architecture are verified independently of filenames. Checksums, signing status,
Windows smoke results and limitations are recorded in the release notes.
The [Windows plan](WINDOWS_PORT_PLAN.md) defines supported capabilities, bounded
fixture tests, publication gates and preservation/branch cleanup requirements.
