# Managed plugin upgrade runbook

DevRyan's repository owns reviewed package versions, packaged agents and runtime
adapters. A newer npm release is a candidate, not evidence of compatibility.
Personal models, variants, prompts, permissions and MCP choices remain user-owned.

## Sources of truth and boundaries

- The managed plugin registry is [managed-plugins.js](../packages/web/server/lib/opencode/managed-plugins.js).
  Keep it consistent with the sanitized profile manifest, installed entrypoints
  and package tests.
- [Claude runtime compatibility](../packages/web/server/lib/opencode/claude-runtime-compatibility.js)
  owns the selected Claude proxy/Meridian/Agent SDK/Claude Code tuple and provenance.
  Update those four components together after acceptance. An exact source patch
  being available does not mean its runtime tuple has passed acceptance.
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
claimed. Explicit Claude dependency/override pins remain user-managed. Managed
package pins for other bundled plugins follow the reviewed registry; reconcile
any intentional package fork before upgrading, rather than treating it as an
ordinary preset customization.

Agent/preset conflicts remain preserved and reported. Repeated provisioning must
be idempotent.

For Meridian, use exact version, entrypoint and original SHA-256 gates in
[the hotfix installer](../packages/web/server/lib/opencode/meridian-http-hotfix.js).
Keep unknown or partially patched input rejected. Preserve upstream session
publication/recovery protections when porting a patch. Install helpers before
atomically replacing the entrypoint. Remove a patch only after the unpatched
candidate passes the behavior it protected.

## Required verification

Run focused owning-package tests from that package with its documented runner.
The web suite uses Vitest; invoking its files through `bun test` is not equivalent.
Cover modified and untracked presets, JSONC precedence, custom prompts, explicit
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

For Claude, run [the real-binary prefix probe](../scripts/qa/meridian-prefix.mjs)
in streaming and non-streaming modes. Use `--arm candidate` for **both corrected
versions**, putting their output in separate directories. The old `control` arm
intentionally removes the September 7 correction and must not be used as the
upgrade baseline.

```bash
bun scripts/qa/meridian-prefix.mjs --modules /absolute/private/node_modules --claude /absolute/private/claude --arm candidate --steps 6 --parallel 2 --stream true --output /absolute/repo/.cache/prefix-new
```

Require stable system/tool prefixes and historical messages, retained actual
client tool results, zero hidden inference, ordinary warm continuation, verified
checkpoint lineage and cancellation rejection. Include Git edits and parallel
tools. Synthetic token values cannot establish real cache or quota performance.
Do not disable process-identity or lock checks to accommodate a restricted host.
Linux evidence is supplemental to unavailable macOS/native acceptance.

Only after those checks pass, use the existing isolated quota-study tools. For an upgrade
comparison adapt their version-specific preparation and entrypoints, retaining
the corrected baseline patch. Keep the same model, effort, prompt mode and
authored editing workload across arms. Require independently verified completed
work and fresh post-work quota readings; alternate arm order and seek three
accepted pairs. Do not compare different completion outcomes as equal-work cost.

For the September 8 upgrade the authorized ceiling is **10 percentage points** of
the five-hour window, including failures/retests, with **4 points reserved** before
admitting work. It is not a fresh allowance per process, arm, or quota reset.
Stop on stale evidence, resets, interference, functional regression or exhausted
headroom. Delayed quota reporting prevents an exact spending guarantee. Future
upgrade runs require their own budget authorization.

Cache acceptance defaults: candidate median cache-read fraction may decline by
at most **2 percentage points**; median cache-write tokens per completed brief may
increase by at most **10%**. Record prefix size, request count, uncached input,
latency and quota separately. Below-resolution quota deltas do not prove parity.
Incomplete acceptance means **held**, not validated.

Complete `bun run validate:full`, `bun run build` and `bun run bundle:check`.
The full gate includes documentation checks. Add isolated web/Electron
verification when applicable; distinguish unavailable prerequisites from
failed behavior. Never weaken assertions to obtain a passing report.

## Promotion and rollback

Promote independent accepted plugins separately. Promote Claude/Meridian only as
one accepted tuple. Preserve the running app during tests; activate through the
normal reviewed installation at the next OpenCode run. A restart is needed for
an already running process to load the new packages.

Rollback restores the previous exact package tuple, native binary and **corrected**
Meridian patch, plus only provisioning metadata changed by this upgrade. Preserve
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
