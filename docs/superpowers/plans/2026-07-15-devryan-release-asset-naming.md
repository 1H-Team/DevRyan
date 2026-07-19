# DevRyan Release Asset Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public GitHub Release artifact use the DevRyan brand while preserving internal compatibility package and extension identities.

**Architecture:** Keep build and marketplace package identities unchanged, then copy their outputs into deterministic DevRyan-named staging files for GitHub uploads. Enforce the public naming boundary in the release verifier and document it as repository policy.

**Tech Stack:** GitHub Actions YAML, Node.js ESM, Node test runner, GitHub CLI/API.

## Global Constraints

- Brand-bearing public release filenames use `DevRyan`; compatibility identifiers and tool-mandated neutral metadata filenames such as `latest-mac.yml` remain unchanged.
- Do not rename npm scopes, CLI commands, VS Code extension IDs, IPC events, protocols, config directories, or updater identity.
- Preserve unrelated working-tree changes.
- Validate release work with `bun run validate:full`.

---

### Task 1: Lock the public release naming contract

**Files:**
- Modify: `scripts/verify-release-assets.test.mjs`
- Modify: `scripts/verify-release-assets.mjs`

**Interfaces:**
- Consumes: the GitHub asset-name array already fetched by `fetchReleaseAssetNames()`.
- Produces: `requiredReleaseAssetNames(version)`, `legacyBrandedReleaseAssetNames(assetNames)`, and deterministic failures for missing or legacy-branded assets.

- [ ] **Step 1: Write failing verifier tests**

Update expected required assets from `openchamber-web-1.1.1.tgz` to `DevRyan-web-1.1.1.tgz`, import `legacyBrandedReleaseAssetNames`, and add:

```js
it('rejects public release assets with the legacy product prefix', () => {
  assert.deepEqual(
    legacyBrandedReleaseAssetNames([
      'DevRyan-1.1.1-arm64.dmg',
      'openchamber-web-1.1.1.tgz',
      'OpenChamber_1.1.1_arm64.dmg',
      'latest-mac.yml',
    ]),
    ['openchamber-web-1.1.1.tgz', 'OpenChamber_1.1.1_arm64.dmg'],
  );
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test scripts/verify-release-assets.test.mjs`

Expected: FAIL because the required web tarball still has the legacy filename and `legacyBrandedReleaseAssetNames` is not exported.

- [ ] **Step 3: Implement the verifier contract**

Change the required tarball to:

```js
`DevRyan-web-${version}.tgz`
```

Add:

```js
export function legacyBrandedReleaseAssetNames(assetNames) {
  return assetNames.filter((name) => /^(?:openchamber|OpenChamber)[_-]/.test(name));
}
```

After checking missing assets in `main()`, fail when legacy assets are present:

```js
const legacyBranded = legacyBrandedReleaseAssetNames(assetNames);
if (legacyBranded.length > 0) {
  throw new Error(`Release ${tag} contains legacy-branded public assets:\n${legacyBranded.map((name) => `- ${name}`).join('\n')}`);
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `node --test scripts/verify-release-assets.test.mjs`

Expected: all release-asset verifier tests pass.

### Task 2: Stage branded GitHub Release artifacts

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/vscode-extension.yml`
- Modify: `.github/workflows/build-macos-arm64-dmg.yml`
- Modify: `.github/workflows/docs-source.yml`
- Modify: `packages/docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: npm's `openchamber-web-<version>.tgz`, VSCE's `openchamber-<version>.vsix`, and generated desktop DMGs.
- Produces: `artifacts/DevRyan-web-<version>.tgz`, `artifacts/DevRyan-<version>.vsix`, and `DevRyan_*` manual DMG artifacts.

- [ ] **Step 1: Stage the npm tarball under the public brand**

In `release.yml`, add a step after `npm pack` that validates exactly one tarball and copies it to `artifacts/DevRyan-web-${VERSION}.tgz`. Change the GitHub Release upload to `artifacts/*.tgz`; leave `npm publish` unchanged.

- [ ] **Step 2: Stage the VSIX under the public brand**

In `vscode-extension.yml`, add a step after packaging that reads `packages/vscode/package.json` version, validates exactly one VSIX, and copies it to `artifacts/DevRyan-${VERSION}.vsix`. Keep Marketplace/Open VSX publication pointed at the original VSIX and point workflow/GitHub Release uploads at the staged artifact.

- [ ] **Step 3: Rename manual macOS workflow outputs**

Change `OpenChamber_${{ inputs.macos_version }}_arm64.dmg` to `DevRyan_${{ inputs.macos_version }}_arm64.dmg` and `OpenChamber_Electron_${{ inputs.macos_version }}_arm64.dmg` to `DevRyan_Electron_${{ inputs.macos_version }}_arm64.dmg`.

- [ ] **Step 4: Rename docs-source distribution artifacts**

Change `openchamber-docs-source-<sha>.tar.gz` to `DevRyan-docs-source-<sha>.tar.gz`, brand the downloadable workflow artifact as `DevRyan-docs-source`, and update `packages/docs/DEPLOYMENT.md`.

- [ ] **Step 5: Inspect the workflow diff**

Run: `git diff --check && git diff -- .github/workflows/release.yml .github/workflows/vscode-extension.yml .github/workflows/build-macos-arm64-dmg.yml .github/workflows/docs-source.yml packages/docs/DEPLOYMENT.md`

Expected: no whitespace errors; GitHub upload paths use only staged DevRyan filenames.

### Task 3: Record durable policy and correct the published release

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-07-15-devryan-release-asset-naming-design.md`
- Modify remotely: GitHub release `zoubenr/DevRyan@v1.0.10`

**Interfaces:**
- Consumes: the canonical repository instructions and GitHub release asset IDs.
- Produces: a durable release-branding rule and corrected current release filenames.

- [ ] **Step 1: Add the repository policy**

Add a release branding section to `AGENTS.md` stating that all public GitHub Release asset filenames must use `DevRyan`, while `@openchamber/*`, `openchamber`, `OPENCHAMBER_*`, protocols, config paths, IPC events, and extension IDs are compatibility identifiers that remain unchanged unless an explicit migration is requested.

- [ ] **Step 2: Align the design note with workflow sequencing**

Clarify that the main release verifier requires the branded web tarball and rejects legacy-prefixed assets, while the follow-up VSIX workflow deterministically stages its branded filename after the main release completes.

- [ ] **Step 3: Rename existing v1.0.10 assets through the GitHub API**

Resolve asset IDs from `gh api repos/zoubenr/DevRyan/releases/tags/v1.0.10`, then PATCH:

```text
openchamber-1.0.10.vsix     -> DevRyan-1.0.10.vsix
openchamber-web-1.0.10.tgz  -> DevRyan-web-1.0.10.tgz
```

- [ ] **Step 4: Verify the canonical release**

Run: `gh release view v1.0.10 --repo zoubenr/DevRyan --json assets --jq '.assets[].name'`

Expected: no output begins with `openchamber-` or `OpenChamber_`; the two renamed assets use `DevRyan`.

### Task 4: Full validation and final review

**Files:**
- Review all task files; do not modify unrelated UI files.

**Interfaces:**
- Consumes: completed implementation.
- Produces: validation evidence and a clean scoped diff.

- [ ] **Step 1: Run full validation**

Run: `bun run validate:full`

Expected: type-check, lint, and full tests pass.

- [ ] **Step 2: Run final release checks**

Run: `node --test scripts/verify-release-assets.test.mjs && git diff --check`

Expected: tests pass and no whitespace errors are reported.

- [ ] **Step 3: Review scoped status and diff**

Run: `git status --short && git diff -- AGENTS.md .github/workflows/release.yml .github/workflows/vscode-extension.yml .github/workflows/build-macos-arm64-dmg.yml .github/workflows/docs-source.yml packages/docs/DEPLOYMENT.md scripts/verify-release-assets.mjs scripts/verify-release-assets.test.mjs docs/superpowers/specs/2026-07-15-devryan-release-asset-naming-design.md`

Expected: only release-naming changes plus the pre-existing unrelated UI modifications appear in status.
