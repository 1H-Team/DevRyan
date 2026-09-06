# Clean-user OpenCode Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the approved sanitized OpenCode profile for every new managed DevRyan user and keep Slim controls off unrelated plugin pages.

**Architecture:** Add a focused user-profile provisioning runtime beside the existing OpenCode configuration modules. It merges a repository-owned baseline into the real user config, synchronizes managed files with hashes, installs missing packages idempotently, and is called before managed OpenCode starts; VS Code receives equivalent startup wiring. Generic plugin details remain read-only, while Slim status/actions render only for Slim selections or the empty setup surface.

**Tech Stack:** Bun/Node.js, JavaScript and TypeScript, React, Zustand, Vitest, Express, Electron managed OpenCode hosts.

## Global Constraints

- Do not install MCP definitions or Slim `mcps` fields.
- Do not copy credentials, tokens, secrets, authentication files, caches, logs, backups, generated overlays, lockfiles, OS metadata, or machine-specific paths.
- Preserve unrelated user configuration and user-modified managed files.
- Do not mutate local files for external OpenCode mode.
- Add no new dependency unless the existing Bun/package installation path cannot satisfy the contract.
- Preserve the unrelated working-tree changes already present.

---

### Task 1: Sanitized packaged baseline and provisioning runtime

**Files:**
- Create: `packages/web/server/default-config/user-profile/opencode.json`
- Create: `packages/web/server/default-config/user-profile/package.json`
- Create: `packages/web/server/default-config/user-profile/oh-my-opencode-slim.json`
- Create: `packages/web/server/default-config/user-profile/skills/**`
- Create: `packages/web/server/lib/opencode/user-profile-provisioning.js`
- Create: `packages/web/server/lib/opencode/user-profile-provisioning.test.js`
- Modify: `packages/web/server/default-config/codemap.md`
- Modify: `packages/web/server/lib/opencode/index.js`

**Interfaces:**
- Produces: `createUserProfileProvisioningRuntime(options)` with `provision(): Promise<{ ok, changed, conflicts, written, updated, removed, install }>`.
- Consumes: repository-owned baseline directory, injected `fs`, `path`, `homedir`, and `runCommand` dependencies.

- [ ] **Step 1: Write failing clean-profile and safety tests**

Create tests that provision a temporary home and assert the exact plugin list, pinned Slim dependency, wrapper/agent/skill files, sanitized Slim config, and absence of `mcp`, `mcps`, auth, lockfile, backup, cache, log, generated overlay, `.DS_Store`, and absolute source-profile paths.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun run --cwd packages/web test -- user-profile-provisioning.test.js`

Expected: FAIL because `user-profile-provisioning.js` and the packaged baseline do not exist.

- [ ] **Step 3: Implement deterministic merge and managed-file synchronization**

Implement configuration merging by plugin spec, preserve unrelated top-level fields, force only the approved safe defaults, and maintain `.openchamber/user-profile-manifest.json` with SHA-256 hashes. Write missing files, update only files matching their previous managed hash, and return conflicts for user-modified files.

- [ ] **Step 4: Add idempotent package installation**

Declare `oh-my-opencode-slim: "2.0.5"` and the approved safe package dependencies. Run `bun install --ignore-scripts` only when the managed dependency declarations changed or installed packages are missing. Return command failure details as `ok: false` without marking the profile ready.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `bun run --cwd packages/web test -- user-profile-provisioning.test.js`

Expected: all clean-profile, no-op, merge, conflict, update, and install-failure cases pass.

### Task 2: Managed startup integration and runtime parity

**Files:**
- Modify: `packages/web/server/lib/opencode/lifecycle.js`
- Modify: `packages/web/server/lib/opencode/lifecycle.test.js`
- Modify: `packages/web/server/index.js`
- Modify: `packages/web/server/lib/opencode/DOCUMENTATION.md`

**Interfaces:**
- Consumes: `provisionUserProfile(): Promise<ProvisionResult>` before packaged agents and runtime overlays.
- Produces: identical baseline configuration inputs and managed-startup behavior in web/Electron; external runtimes skip provisioning.

- [ ] **Step 1: Write failing lifecycle tests**

Add web lifecycle tests proving provisioning runs before agent/overlay sync and does not run for external/skip-start modes. Add VS Code tests proving its managed startup invokes the equivalent provisioning adapter before overlay generation.

- [ ] **Step 2: Run lifecycle tests and verify RED**


Expected: FAIL because startup has no provisioning dependency.

- [ ] **Step 3: Wire provisioning into managed startup**

Inject the web runtime from `packages/web/server/index.js`; call it at the start of managed runtime synchronization and throw an actionable startup error on package-install failure. Add the equivalent VS Code call using its user-config paths and packaged baseline resolution. Keep external mode read-only.

- [ ] **Step 4: Run lifecycle tests and verify GREEN**


Expected: all targeted startup and provisioning tests pass.

### Task 3: Slim-specific Settings surface

**Files:**
- Create: `packages/ui/src/components/sections/plugins/PluginsPage.test.tsx`
- Modify: `packages/ui/src/components/sections/plugins/PluginsPage.tsx`
- Modify: `packages/ui/src/components/sections/plugins/codemap.md`

**Interfaces:**
- Consumes: existing `SlimSetupStatus` and `usePluginsStore` actions.
- Produces: `isSlimPlugin(item)` selection predicate and status-aware Slim action rendering.

- [ ] **Step 1: Write failing UI tests**

Test that ordinary config and file details do not render Slim controls, the Slim wrapper selection does, ready status hides `Install Slim`, and missing setup exposes install from the unselected setup surface.

- [ ] **Step 2: Run the UI test and verify RED**

Run: `bun test packages/ui/src/components/sections/plugins/PluginsPage.test.tsx`

Expected: FAIL because generic details currently mount `SlimStatusPanel`.

- [ ] **Step 3: Implement selection-scoped, status-aware actions**

Remove `SlimStatusPanel` from generic `EntryDetails` and `FileDetails`. Render it for Slim config/file selections and the no-selection setup state only. Render Install only when status is missing/incomplete; retain Repair for an installed or diagnosable setup.

- [ ] **Step 4: Run the UI tests and verify GREEN**

Run: `bun test packages/ui/src/components/sections/plugins/PluginsPage.test.tsx packages/ui/src/stores/usePluginsStore.test.ts`

Expected: all plugin page and store tests pass.

### Task 4: Documentation, packaging, and verification

**Files:**
- Modify: `packages/web/server/default-config/codemap.md`
- Modify: `packages/web/server/lib/opencode/DOCUMENTATION.md`
- Modify: `packages/ui/src/components/sections/plugins/codemap.md`
- Modify: `codemap.md` only if an ownership/entrypoint changed.

**Interfaces:**
- Consumes: completed implementation and test evidence.
- Produces: documented clean-profile contract and verified distributable assets.

- [ ] **Step 1: Run secret and exclusion scans**

Run targeted searches over `packages/web/server/default-config/user-profile` for `mcp`, `mcps`, token/secret/auth keys, `/Users/`, `.DS_Store`, backups, caches, logs, lockfiles, and generated overlay names. Expected: no prohibited artifacts or values.

- [ ] **Step 2: Run affected validation**

Run: `bun run validate:affected`

Expected: exit code 0.

- [ ] **Step 3: Run the web server test suite**

Run: `bun run --cwd packages/web test`

Expected: exit code 0 with zero failed tests.

- [ ] **Step 4: Run the packaging-sensitive build**

Run: `bun run build`

Expected: exit code 0 and packaged default-config assets remain available to web/Electron resolution paths.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only task files plus the pre-existing unrelated user changes are present.
