# Release pipeline

A release is one tag push. `.github/workflows/release.yml` builds `DevRyan-<version>-arm64.dmg`, attaches it to a draft GitHub Release and publishes it. A manual run of the same workflow is a dry run: it builds everything on its ref and publishes nothing.

The public release carries exactly one asset, `DevRyan-<version>-arm64.dmg` (Apple silicon, ad-hoc signed, not notarized). The allowlist is `RELEASE_SCOPES` in `packages/electron/release-assets.mjs`, enforced by `scripts/verify-release-assets.mjs`. Intel and Windows builds are not released. `@openchamber/web` on npm belongs to upstream; DevRyan never publishes to npm.

## Releasing a version

1. `node scripts/bump-version.mjs X.Y.Z` updates every package manifest, the legacy Tauri files and the workspace versions in `bun.lock`.
2. Add a `## [X.Y.Z]` section to `CHANGELOG.md`; it becomes the release notes.
3. Run `bun run validate`, commit with explicit paths, and push `main`.
4. Optional: dry-run the workflow on `main` (`gh workflow run release.yml --ref main`).
5. `git tag vX.Y.Z && git push origin vX.Y.Z`.

Only tags matching `vX.Y.Z` trigger a release.

## Graph

```
admit ──┬─ web ─────────────────────────────────────────┐
        ├─ electron-prepare ────────────────────────────┼─ electron-package ── publish
        └─ bot-resolve ── bot-build (changed only) ── bot-publish ─┘
```

| Job | What it does |
| --- | --- |
| `admit` | Checks that the tag, every version file and `bun.lock` agree, and that `CHANGELOG.md` has notes for the version. Fails if `vX.Y.Z` is already published. Otherwise it creates the draft, or reuses an unpublished draft for the same tag (retargeted, notes rewritten, earlier assets removed). Dry runs make no writes. |
| `web` | `type-check:ui`, `build:web`, `bundle:check`, then hands `packages/web/dist` to packaging. |
| `electron-prepare` | Installs darwin dependencies, restores the reviewed Claude executable (`scripts/hydrate-reviewed-claude.mjs`), builds the native v2 runtime, native helpers and the main bundle, rebuilds native bindings, and exports the prepared tree. |
| `bot-resolve` | Hashes each Bot image's inputs and reuses the signed `:in-<digest>` image when it exists and verifies. Lists the images that need building. |
| `bot-build` | One job per changed image: multi-platform build, push, keyless cosign signature, and the `:in-<digest>` input tag. Skipped when nothing changed. |
| `bot-publish` | Assembles `DevRyan-bot-runtime-images-<version>.json`, checks anonymous pulls, and smokes the isolated production topology. |
| `electron-package` | Packages the app with the Bot manifest and runs static checks: Cursor SDK binaries, packaged orchestration config, packaged Bot manifest, and Info.plist usage descriptions. Uploads the DMG. |
| `publish` | Checks the DMG against the allowlist and that the tag still points at this run's commit, then uploads it to the draft. Deploys and verifies the hosted Supabase configuration and migrations, publishes the draft, and polls `/releases/latest` until the shipped `discoverDesktopUpdate` (`packages/electron/desktop-updater.mjs`) finds the DMG with the uploaded size and SHA-256. |

That is 7 checks plus one per changed Bot image. A release with unchanged Bot inputs takes about 10 minutes.

`scripts/release.mjs` holds the GitHub Release steps (`admit`, `upload`, `publish`). `scripts/release-ci.mjs` holds the artifact handoffs (`web-describe`, `web-stage`, `prepare-export`, `prepare-import`) and the Bot image steps (`image-resolve`, `image-plan`, `image-sign`, `image-assemble`). Every failure throws with its real message, so the job log names the cause.

## Retrying a failed release

A version is used only once it is published. Until then:

- **Infrastructure flake:** `gh run rerun <run-id> --failed`.
- **Code fix:** push the fix to `main`, then move the tag with `git tag -f vX.Y.Z <fixed-sha> && git push -f origin vX.Y.Z`. The new run cancels the old one (`concurrency: release-<tag>`). `admit` reuses the draft, and `upload` refuses to attach bytes from a commit the tag no longer points at.
- A published version is final. Bump the patch version instead.

## Dry runs

`gh workflow run release.yml --ref main` runs the whole graph with `RELEASE_DRY_RUN=true`. `admit` prints instead of drafting, `upload` only checks the local DMG, and the Supabase and publish steps are skipped.

A dry run never publishes Bot images. If Bot image inputs changed since the last tag-push release, `bot-resolve` stops the dry run with a message that names the images. Push the release tag instead: it builds them, and a failure is retried on the same version.

## Bot images

`scripts/bot-runtime-image-inputs.mjs` hashes each image's Dockerfile, `.dockerignore` files, `COPY`/`ADD` sources (with the package `version` field removed) and the build recipe. It probes `ghcr.io/1h-team/devryan-bot-<key>:in-<digest>` and checks the cosign signature, which must come from this repository's `release.yml` at a `v*` tag (`botRuntimeImageSignerIdentity`). Only tag-push releases create `in-` tags. To force a rebuild, delete the image's `in-` tag in GHCR.

The app pins every image by digest in `Contents/Resources/bot-runtime/images.release.json`; nothing resolves tags at runtime. The `docker/build-push-action` inputs must match `BOT_RUNTIME_IMAGE_BUILD_RECIPE`; `scripts/test-runner-utils.test.mjs` checks this.

## Build notes

- Release installs set `DEVRYAN_SKIP_INSTALL_PREPARE=1`. Without it, Bun runs the Electron workspace `prepare` script (a full web build plus native helpers) on every install.
- `release-cache.yml` rebuilds the native-runtime companion on `main` when its inputs change, so the tag run restores it from cache.
- Do not cache the Bun package store: on 2026-09-23 restoring it (~800 MB) was slower than a fresh install.
- Every job has a timeout, so a stalled native build fails instead of holding the release open.

## Local commands

| Command | Outcome |
| --- | --- |
| `bun run build` | Web assets and the Electron main bundle; no native build |
| `bun run --cwd packages/electron prepare` | Web staging, native helpers, main bundle, native ABI rebuild |
| `bun run electron:build` | Full local preparation and packaging |
| `bun run --cwd packages/electron package:prepared --publish=never` | Package prepared inputs with a staged Bot manifest |
| `bun run pack:web` | Locally installable web tarball (not released) |

## Updater contract

Installed 2.0.2 and later apps read `https://api.github.com/repos/1H-Team/DevRyan/releases/latest`. They need a published, non-prerelease release tagged `vX.Y.Z` with exactly one uploaded `DevRyan-X.Y.Z-arm64.dmg`, whose GitHub-computed `digest` and size they verify after download. Nothing else (no `latest-mac.yml`, ZIP or blockmaps) is used. Apps from 2.0.1 and earlier need a manual DMG install.
