# Managed plugin upgrade runbook

DevRyan's repository owns reviewed package versions, packaged agents and runtime
adapters. A newer npm release is a candidate, not evidence of compatibility.
Personal models, variants, prompts, permissions and MCP choices remain user-owned.

## Sources of truth and boundaries

- The managed plugin registry is [managed-plugins.js](../packages/web/server/lib/opencode/managed-plugins.js).
  Keep it consistent with the sanitized profile manifest, installed entrypoints
  and package tests.
- Claude is not a managed plugin. OpenCode's built-in `claude-agent` provider runs
  the user's own Claude Code through `@anthropic-ai/claude-agent-sdk`, pinned to
  the exact peer version `@opencode/core` declares; it moves with OpenCode host
  upgrades ([OpenCode upgrade runbook](OPENCODE_UPGRADES.md)). The former
  `opencode-with-claude`/Meridian plugin specs are retired in the registry.
- The agent orchestration derived from Oh My OpenCode Slim is not a plugin: it
  is DevRyan-owned source in [packages/agents-core](../packages/agents-core/DOCUMENTATION.md),
  built into the native runtime. Port upstream fixes with the section below,
  never by upgrading a package. Its former adapter and package specs are
  retired in the registry.
- Preserve compatibility names and the separate Cursor SDK runtime. Do not use
  these names as permission to inspect upstream OpenChamber/OpenCode checkouts.
  Do not refresh legacy Tauri assets or unrelated installed skill collections.

## Inventory before changing anything

1. Record the current commit, existing dirty files, exact package versions and
   hashes. Never reset or stage someone else's work to obtain a clean baseline.
2. Inspect only authorized non-secret configuration. Compare repository defaults,
   personal JSON/JSONC, project overrides, agent prompt files and managed markers.
   JSONC can take precedence over JSON. Do not regenerate a personal profile.
3. Compare installed package files against the exact published tarball. Verify
   registry integrity and record intentional local patches. Move required local
   behavior into a reproducible repository adapter or source-gated patch before
   replacing an installation. Keep credentials and provider transcripts out of
   repository evidence.
4. Save sanitized baseline evidence and an upgrade matrix in a dated audit. Use
   disposable profiles under repository `.cache` for installs and verification.
   Use a private package cache/temp directory if the host cache is unavailable.

## Review, preservation and migration

Review manifests, exports, source, schemas and prompts—not just release numbers.
For each upstream agent change record **adopt**, **already covered**, or **defer**,
with its reason and behavioral evidence. Preserve primary/specialist roles,
explicit model/variant routing, permission boundaries, dispatch/collection rules
and user-selected MCP restrictions. Avoid blanket prompt
replacement, automatic model inheritance, new agents or higher concurrency.

Provisioning preserves a modified managed file or a differing file with no prior
tracking marker. Matching files can be tracked; unknown files are not silently
claimed. Provisioning drops the retired Claude proxy dependencies and the Claude
overrides only at the exact versions DevRyan pinned. Managed package pins for other bundled plugins follow the reviewed registry; reconcile
any intentional package fork before upgrading, rather than treating it as an
ordinary preset customization.

Agent/preset conflicts remain preserved and reported. Repeated provisioning must
be idempotent.

For a source-patched plugin, use exact version, entrypoint and original SHA-256
gates. Keep unknown or partially patched input rejected. Install helpers before
atomically replacing the entrypoint. Remove a patch only after the unpatched
candidate passes the behavior it protected.

## Required verification

Run focused owning-package tests from that package with its documented runner.
The web suite uses Vitest; invoking its files through `bun test` is not equivalent.
Cover modified and untracked presets, JSONC precedence, custom prompts, retired
Claude overrides, stale installed packages, partial install failure, adapter
conflicts, repeated provisioning and rollback.

The opt-in real-package checker uses synthetic image responses and a disposable
profile. It does not submit provider requests:

```bash
bun scripts/qa/plugin-upgrades.mjs /absolute/private/node_modules /absolute/repo/.cache/plugin-checks
```

Check actual provider streaming and
tool contracts separately; an import check does not establish authenticated
Cursor execution or image model availability.

Complete `bun run validate:full`, `bun run build` and `bun run bundle:check`.
The full gate includes documentation checks. Add isolated web/Electron
verification when applicable; distinguish unavailable prerequisites from
failed behavior. Never weaken assertions to obtain a passing report.

## Promotion and rollback

Promote independent accepted plugins separately. Preserve the running app during tests; activate through the
normal reviewed installation at the next OpenCode run. A restart is needed for
an already running process to load the new packages.

Rollback restores the previous exact package tuple and any source patch, plus only
provisioning metadata changed by this upgrade. Preserve
newer user-owned edits and never rewrite native session transcripts. Rehearse in
a disposable profile first. Merely reverting the package version or installing an
older DevRyan release does not reverse an unknown installed source patch safely.

Retain the version/integrity matrix, agent-change dispositions, commands, sanitized
results, source hashes, platform limits and final accepted/held/failed statuses in
the audit. Update this runbook when ownership or gates change.

## Image request model default

DevRyan applies `packages/web/server/lib/opencode/imagegen-model-hotfix.js` during managed provisioning. The reviewed 0.1.12 executable (also byte-identical in 0.1.10 for degraded installs) requests `gpt-6-astra` with `reasoning.effort: medium`. This selects the model invoking the hosted image tool; it does not pin a separate hosted image renderer. Unknown versions, modified source and partial patches fail closed. Re-review the source digest and rerun installed image checks whenever upgrading this plugin.

The installed-package fixture copies and patches the image package privately, asserting model/effort along with references, output and auth behavior. The live image acceptance script was removed in app cleanup. [OpenAI documents Astra support for medium reasoning and image-generation tools](https://developers.openai.com/api/docs/models/gpt-6-astra).

## Porting upstream agent fixes

`packages/agents-core` started from Slim v3.0.4 and is maintained by selective
ports, never by replacing the tree.

1. Read the upstream release notes or commit. Decide **adopt**, **already
   covered** or **defer** against DevRyan's owners: managed tasks, Council,
   compaction, permissions/providers and the continuation gate stay
   authoritative. Upstream fallback, background-default delegation and
   `/implement` are deferred.
2. Apply the change by hand to the matching files. Keep every authority seam in
   `src/devryan/owners.ts`: no direct file, network, process, environment or
   console access, and no new built-in MCP, updater or marketplace code.
3. Port the upstream tests that cover the change. When a declared export
   changes, update `index.d.ts` with it; the type check proves they agree.
4. Record the upstream commit SHA and a one-line summary under "Ported upstream
   commits" in `UPSTREAM.md`, and add any behaviour DevRyan keeps different to
   its "DevRyan behaviour changes".
5. Run `bun run validate`, then the native build and the agents-core lanes
   (`scripts/opencode-v2-native/package-agents-core-lane.mjs`,
   `package-agents-core-tools-lane.mjs`) before a release.
