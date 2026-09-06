# OpenCode 1.17.20 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align DevRyan's recommended OpenCode runtime and shared `@opencode-ai/sdk` dependency on stable version 1.17.20.

**Architecture:** Keep the current cross-runtime policy structure: web each expose the same recommended external runtime version, while all SDK-consuming workspaces share the same caret dependency range. Regenerate the root Bun lockfile and make no API changes unless compilation proves they are necessary.

**Tech Stack:** Bun workspaces, Node.js, `@opencode-ai/sdk`, Vitest/Bun tests, TypeScript, JavaScript.

## Global Constraints

- Update the supported OpenCode baseline from 1.17.19 to exactly 1.17.20.
- Keep SDK manifest ranges as `^1.17.20`; do not introduce exact SDK pins.
- Preserve explicit user and environment OpenCode binary choices.
- Do not update unrelated dependencies or refactor OpenCode API consumers without a demonstrated 1.17.20 incompatibility.
- Preserve the user's existing working-tree changes.

---

### Task 1: Update the external runtime policy

**Files:**
- Modify: `packages/web/server/lib/opencode/opencode-resolution-runtime.test.js`
- Modify: `packages/web/server/lib/opencode/version-policy.js`
- Modify: `packages/web/server/lib/opencode/DOCUMENTATION.md`

**Interfaces:**
- Consumes: Existing `TARGET_OPENCODE_VERSION` and `OPENCODE_TARGET_INSTALL_COMMAND` exports in web.
- Produces: The same exports with `TARGET_OPENCODE_VERSION === "1.17.20"` and install commands containing `--version 1.17.20`.

- [x] **Step 1: Change policy test expectations to 1.17.20**

Replace the expected target, detected fixture, and install-command versions in both test files:

```js
version: '1.17.20'
targetVersion: '1.17.20'
detectedVersion: '1.17.20'
installCommand: 'curl -fsSL https://opencode.ai/install | bash -s -- --version 1.17.20 --no-modify-path'
```

- [x] **Step 2: Run focused tests and verify the new expectations fail**

Run:

```bash
bunx vitest run server/lib/opencode/opencode-resolution-runtime.test.js --no-file-parallelism --maxWorkers=1
bunx vitest run --config vitest.config.mjs src/bridge-config-runtime.test.js
```

Expected: failures showing the implementation still returns target/install version 1.17.19.

- [x] **Step 3: Update both runtime policy constants**

Use the existing export shape in both policy modules:

```js
export const TARGET_OPENCODE_VERSION = '1.17.20';
```

Keep each existing interpolated `OPENCODE_TARGET_INSTALL_COMMAND` declaration unchanged apart from the constant value.

- [x] **Step 4: Update runtime policy documentation**

Change current-baseline references from `v1.17.19` or `1.17.19` to `v1.17.20` or `1.17.20` in the two module documentation files. In the web runtime-overlay compatibility paragraph, describe the transport headers as required by the supported 1.17.20 baseline; do not change behavior.

- [x] **Step 5: Re-run focused tests**

Run:

```bash
bunx vitest run server/lib/opencode/opencode-resolution-runtime.test.js --no-file-parallelism --maxWorkers=1
bunx vitest run --config vitest.config.mjs src/bridge-config-runtime.test.js
```

Expected: both files pass.

### Task 2: Update the shared SDK dependency

**Files:**
- Modify: `package.json`
- Modify: `packages/ui/package.json`
- Modify: `packages/web/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: Existing workspace dependency ranges for `@opencode-ai/sdk`.
- Produces: Four manifest declarations at `^1.17.20` and a lockfile resolving `@opencode-ai/sdk@1.17.20`.

- [x] **Step 1: Update all SDK manifest declarations**

Set the dependency in every listed manifest to:

```json
"@opencode-ai/sdk": "^1.17.20"
```

- [x] **Step 2: Regenerate the Bun lockfile**

Run:

```bash
bun install
```

Expected: `bun.lock` resolves `@opencode-ai/sdk@1.17.20` and does not introduce unrelated manifest changes.

- [x] **Step 3: Verify version consistency**

Run:

```bash
```

Expected: all four manifests show `^1.17.20`, the lockfile shows 1.17.20, and no current policy/test/documentation reference remains at 1.17.19.

### Task 3: Verify the cross-runtime dependency update

**Files:**
- Verify only: all files changed in Tasks 1 and 2.

**Interfaces:**
- Consumes: OpenCode 1.17.20 runtime policy and SDK declarations.
- Produces: Evidence that tests, workspace validation, and bundle builds remain green.

- [x] **Step 1: Run full repository validation**

Run:

```bash
bun run validate:full
```

Expected: exit code 0.

- [x] **Step 2: Run all builds**

Run:

```bash
bun run build
```

Expected: exit code 0 for all workspace builds.

- [x] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; the OpenCode diff is limited to version declarations, generated lock data, policy expectations, and documentation, while the user's pre-existing session-store edits remain unmodified.

- [x] **Step 4: Commit only the upgrade files**

Stage the plan and the files listed in Tasks 1 and 2, excluding all pre-existing unrelated changes, then commit:

```bash
git commit -m "chore: update OpenCode to 1.17.20"
```
