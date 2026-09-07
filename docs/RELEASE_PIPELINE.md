# Release builds and artifact handoffs

The release workflow builds one web artifact, six Bot images with at most three
image jobs running concurrently, and two architecture-specific Electron
preparations. Final Electron packaging waits for all three verified inputs.
Native bindings are never shared between ARM and Intel builds.

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
2. In parallel, validate UI types and compile web assets once, prepare ARM/Intel native dependencies and
   helpers, and build the six multi-platform images. Image jobs use individual
   GitHub Actions cache scopes with full intermediate-layer export.
3. Each image job signs its index and both platform digests and emits one result.
   The aggregation job requires six distinct results for the same version,
   revision, repository, OpenCode/schema versions and plugin hash. It validates
   platform/attestation completeness, anonymous pull access and production
   topology health before exposing the complete manifest.
4. npm consumes the web artifact, bundles private workspace runtime packages, and publishes the exact verified tarball.
   Electron consumes web assets, prepared native files, and the complete Bot
   manifest, then runs all existing packaged artifact gates.
5. Merge update metadata and finalize the release only after every gate succeeds.

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

Prepared Electron artifacts use a tar archive to preserve executable permissions
and relative symlinks. Metadata binds the archive checksum to commit, lockfile,
release and target architecture. The archive contains installed workspace
dependencies, compiled helpers and the main bundle. It contains no user profile
or build credentials. Packaging restores it into a fresh checkout without running
another dependency installation that could replace rebuilt native binaries.

`scripts/release-ci.mjs` is the fixed-operation CI adapter. `RELEASE_OPERATION`
selects `image-plan`, `image-sign`, `image-assemble`, `web-describe`, `web-stage`,
`web-pack`, `prepare-export` or `prepare-import`. Artifact verification remains in reusable
core functions. Internal handoff artifacts are not public release assets.

`packages/electron/scripts/package-prepared.mjs` is the production packaging
boundary. Bot-manifest validation is mandatory there, including local builds;
plain main-process compilation does not require a release manifest. The manual
macOS workflow's Electron build requires a ref with a matching published Bot
manifest and fails on a revision mismatch. Test-only QA shells remain separate.

## Ownership and maintenance

Workspace consumers declare their own dependencies. Root dependencies cover root
scripts and repository visual fixtures; root development dependencies cover
shared tooling. The root retains `ghostty-web@0.3.0` as the existing patch-package
target, while the UI's separately resolved version is unchanged. Package ownership
cleanup must not change resolved dependency versions or container-local lockfiles.

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

The five runs inspected on 2026-09-07 took approximately 20–24 minutes. The latest
run took 20m08s: Bot image publication 13m14s, followed by roughly six minutes for
the slower Electron job. Workflow steps now report image build, signing,
verification, native preparation and packaging timings separately. Compare total
duration and step timings across subsequent authorized warm- and cold-cache
releases. A 30% warm-cache reduction is a target, not a verified result.

Do not use the existing release `dry_run` to test without publication: it still
creates/uploads some external artifacts. Local fixture verification does not
publish; a real release requires the normal authorized release process.
