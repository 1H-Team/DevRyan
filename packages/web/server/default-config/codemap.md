# packages/web/server/default-config/

## Responsibility
Default server-scaffolded OpenCode configuration and bundled agent role templates shipped for fresh runtime setup.

## Canonical asset boundary
- This directory is the sole source for distributable orchestration defaults. `lib/opencode/default-config-assets.js` inventories only root `opencode.json`, `agents/**`, runtime plugin files in `plugins/**`, and sanitized `user-profile/**`.
- Never ship auth, credentials, secrets, logs, caches, backups, lockfiles, generated manifests, `node_modules`, or test/spec/declaration files. Source-adjacent test fixtures are intentionally excluded from packaged assets.
- Clean-user profile provisioning is conflict-tracked and managed-runtime-only. Project runtime overlays separately copy/register plugins and preserve source-owned local plugin collision behavior; external runtimes are not mutated.

## Design
- `opencode.json` defines baseline agent/plugin constraints for embedded runtime startup, including the reviewed pinned `opencode-with-claude@1.6.18` proxy plugin.
- `agents/*.md` provides canned role instructions (builder/fixer/orchestrator/etc.) copied or referenced during bootstrap flows.
- `plugins/*.js` / `plugins/*.mjs` provides bundled OpenCode plugins copied into the active managed runtime config overlay. `devryan-managed-orchestration.mjs` exposes one scoped multi-action tool backed by DevRyan's private scheduler host, uses 25-second wait polling slices without collecting live snapshots, recovers pre-execution start registrations at the authoritative `session.idle` boundary, and compacts matching terminal payload fields out of the task copy before serializing parent-model tool output; the authoritative result envelope remains complete. `devryan-builder-todo-continuation.mjs` resumes a successfully settled Builder turn on the same model when authoritative todos still contain pending work, coalesces duplicate idle edges, and stops after bounded stagnant attempts so a premature 3/N response is not terminal. `devryan-file-write-metadata.mjs` records whether an `oc_write` target existed before execution so shared UI can distinguish creates from edits without filesystem heuristics. `openai-gpt-5-6-models.mjs` defaults advertised reasoning options and variants from `reasoningSummary: "auto"` to `"detailed"` and enforces `"detailed"` again at request time for every reasoning-capable OpenAI turn, including agent/model overrides, while preserving unrelated options, explicit `reasoningEffort: "none"`, non-reasoning models, and other providers. `devryan-oh-my-opencode-slim.mjs` is the DevRyan-preserving wrapper for `oh-my-opencode-slim` and intentionally strips Slim agent prompt/system-transform ownership while preserving Slim runtime hooks.
- `user-profile/` is the sanitized, repository-owned clean-user baseline. It declares approved user plugins and preinstalls the pinned Claude proxy (`1.6.18`) plus Slim (`2.0.5`) dependencies, ships Slim presets without MCP fields, and bundles the approved skills. The OpenAI tool schema sanitizer remains a packaged runtime file copied and registered by managed overlays. The profile contains no auth material, generated state, lockfiles, or machine-specific paths.
- `.gitignore` keeps generated/localized artifacts out of source control.

## Flow
1. Server bootstrap checks for user/project config presence.
2. Missing config is initialized from this directory defaults.
3. Agent templates become available to orchestration tooling as default personas; only Orchestrator can call `devryan_task` directly.
4. Bundled plugins become available as runtime tools for managed OpenCode launches.
5. Managed startup provisions missing clean-user files and dependencies into `~/.config/opencode` while preserving user-modified managed files through a hash manifest.

## Integration
- Used by web server initialization paths that provision OpenCode-compatible defaults.
- Influences out-of-box behavior of agent execution, plugin loading, and prompt-role availability.
- Council fanout uses the managed bridge when injected so its children share the same durable lifecycle and unbounded immediate admission; the direct path remains only when no managed bridge exists.
