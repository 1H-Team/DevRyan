# Release builds and artifact handoffs

The release workflow builds one web artifact, eight Bot images (six execution
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
requirements and refuses publication while those native artifacts are missing.
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

1. Validate release metadata and create the draft release.
2. In parallel, validate UI types and compile web assets once, prepare arm64 native dependencies and
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
4. npm consumes the web artifact, bundles private workspace runtime packages, and publishes the exact verified tarball.
   Electron consumes web assets, prepared native files, and the complete Bot
   manifest, then runs all existing packaged artifact gates.
5. Each packaging job records its actual installer/tarball SHA-256. Finalize
   only after every gate succeeds; finalization verifies the exact asset
   allowlist, uploaded state, non-empty size, and those packaging digests.

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
`web-pack`, `prepare-export` or `prepare-import`. Artifact verification remains in reusable
core functions. Internal handoff artifacts are not public release assets.

`packages/electron/scripts/package-prepared.mjs` is the production packaging
boundary. Bot-manifest validation is mandatory there, including local builds;
plain main-process compilation does not require a release manifest. The manual
macOS workflow's Electron build requires a ref with a matching published Bot
manifest and fails on a revision mismatch. Releases from 2.0.1 no longer publish
that manifest, so the manual workflow cannot package them. Test-only QA shells remain separate.

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

`windows.yml` provides separate `windows-2022` x64 and `windows-11-arm` ARM64
qualification jobs with Bun 1.3.14, native MSVC environments, compiled supervisor
acceptance and controller/writer/package checks. It has only read permissions.
These jobs expose unported Windows contracts as failures and do not open runtime
admission or publish an installer. See [Windows port](WINDOWS_PORT_PLAN.md).
