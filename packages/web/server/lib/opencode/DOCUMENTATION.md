# OpenCode Module Documentation

## Purpose
This module provides OpenCode server integration utilities for the web server runtime, including configuration management, packaged/project agent discovery, packaged agent runtime sync, and provider authentication.

## Entrypoints and structure
- `packages/web/server/lib/opencode/index.js`: public entrypoint (currently baseline placeholder).
- `packages/web/server/lib/opencode/auth.js`: provider authentication file operations.
- `packages/web/server/lib/opencode/auth-state-runtime.js`: managed OpenCode server auth password/header runtime.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/cli-entry-runtime.js`: CLI entrypoint runtime that detects direct execution, parses CLI options, and starts server bootstrap.
- `packages/web/server/lib/opencode/routes.js`: OpenCode/provider settings and auth-related route registration.
- `packages/web/server/lib/opencode/cursor-session-title-runtime.js`: Cursor-only session title coordination for intercepted SDK prompts, including eligibility checks, in-flight deduplication, compare-before-update rename protection, and retryable failure handling.
- `packages/web/server/lib/opencode/providers.js`: provider source detection, Anthropic OAuth proxy config helpers, and default Cursor provider bootstrap.
- `packages/web/server/lib/opencode/provider-integrations.js`: canonical provider metadata helpers for DevRyan-managed provider aliases such as GitHub Copilot, plus auth alias synchronization between `github-copilot` and legacy `copilot` auth keys.
- `packages/web/server/lib/opencode/github-copilot-models.js`: account-specific GitHub Copilot model discovery using stored OpenCode Copilot auth, success-only in-memory caching, and emergency fallback model metadata. Discovery prefers `model_picker_enabled` models when present, otherwise keeps usable chat models (limits + tool_calls, excluding embeddings), and enriches entries with runnable `api` metadata for OpenCode.
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring).
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime.
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/OpenChamber route wiring.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime.
- `packages/web/server/lib/opencode/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/opencode/config-entity-routes.js`: route registration for agent/command/MCP config orchestration and reload semantics.
- `packages/web/server/lib/opencode/mcp.js`: MCP config CRUD, source layering, and explicit recovery. Active user MCP detection reads only official config files under `~/.config/opencode` (`config.json`, `opencode.json`, `opencode.jsonc`) so ambient home-folder `~/.opencode/opencode.json*` entries do not leak into DevRyan. Project MCP writes default to `<project>/.opencode/opencode.json` while root-level project `opencode.json` and `.jsonc` remain readable. Recovery remains available through the explicit recovery API and is not part of normal MCP listing.
- `packages/web/server/lib/opencode/mcp-sources.js`: MCP source metadata for active and recoverable config locations using the same official user/project path precedence as `mcp.js`; home-folder `~/.opencode` files are intentionally excluded from active MCP sources.
- `packages/web/server/lib/opencode/agents.js`: packaged/project/Slim agent discovery, config resolution, and model override routing. Packaged agents are read directly from `packages/web/server/default-config/agents`; project agents are read from `.opencode/agents`; raw Slim plugin mode can expose Slim-installed global `agents/*.md` prompt files plus active Slim preset/root model config as the agent catalog. DevRyan Slim wrapper mode keeps DevRyan packaged/project markdown authoritative for prompts, permissions, descriptions, and plan-mode behavior while applying only Slim model/variant/modelRefs metadata and exposing non-colliding Slim-only custom agents. Non-Slim model/variant overrides are stored in DevRyan's sidecar under `openchamber.agentOverrides`; Slim runtime overrides are written into `oh-my-opencode-slim` config. `listManagedRuntimeAgentModelOverrides(workingDirectory, options?)` resolves the effective managed-runtime model map, layering wrapper-mode Slim preset/root values over sidecar overrides only for matching DevRyan packaged/project agents.
- `packages/web/server/lib/opencode/slim-config.js`: OpenCode Slim (`oh-my-opencode-slim`) config adapter. Reads user/project Slim JSON/JSONC configs with active preset + root agent override merging, normalizes Slim JSON agent model metadata for Settings, and distinguishes `slimRuntimeEnabled` wrapper/raw plugin loading from `slimAgentCatalogEnabled` raw-Slim agent catalog mode.
- `packages/web/server/lib/opencode/slim-install.js`: manual Settings/API installer for DevRyan-managed `oh-my-opencode-slim@2.0.5`. It inspects status, backs up touched `~/.config/opencode` files, merges plugin/provider/MCP config, replaces raw Slim entries with the DevRyan wrapper plugin, writes the pinned package dependency, installs bundled Slim skills when available, writes generated Slim defaults without wildcard MCP grants, runs `bun install --ignore-scripts`, and exposes `GET /api/config/slim/status`, `POST /api/config/slim/install`, and `POST /api/config/slim/repair`.
- Managed OpenCode startup passes Slim's active preset as `OH_MY_OPENCODE_SLIM_PRESET`, enables `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, and copies the active `oh-my-opencode-slim.json/jsonc` into DevRyan's generated `OPENCODE_CONFIG_DIR` overlay so Slim's plugin can resolve the same preset/model defaults shown in Settings. In wrapper mode, startup does not exclude DevRyan packaged agents.
- `packages/web/server/lib/opencode/packaged-agents.js`: packaged default agent reader for release-bundled markdown agents.
- `packages/web/server/lib/opencode/packaged-agent-sync.js`: materializes release-bundled packaged agents into DevRyan-managed OpenCode runtime agent files so managed OpenCode can execute them natively. Startup uses this as a stable packaged baseline and does not inject project-specific skill visibility or user model defaults into the global packaged files.
- `packages/web/server/lib/opencode/runtime-agent-overlays.js`: materializes user-scoped agent model/variant overrides, including effective Slim wrapper preset/root values, project-specific visible-skill policy, active project/worktree external-directory permissions, allowlisted active plugin registrations, bundled runtime plugin files, bundled plugin registrations, Anthropic OAuth proxy bootstrap config, managed runtime MCP timeout overlays, and blocked ambient MCP tombstones into a DevRyan-managed high-precedence OpenCode config directory for managed runtimes. Project/package markdown remains the prompt/behavior source; generated overlay files replace only user-owned model fields and runtime-only permission policy, and use an empty-string variant sentinel to clear inherited project variants because OpenCode rejects YAML null and deep-merges omitted fields. Wrapper-mode override resets rematerialize the active Slim preset values on the next sync, so existing Slim configuration requires no migration. User-scoped remote MCP servers without an explicit timeout receive a generated runtime-only timeout so unavailable global MCP servers cannot hold first-turn tool resolution for the full OpenCode fallback delay. Bundled plugin test/type files are excluded, while bundled runtime plugins are copied into `plugins/` and registered as local `./plugins/*` entries. Active config plugins are filtered through DevRyan's managed-runtime allowlist so broad tool-surface plugins such as Context7/GitHub grep do not leak into managed OpenCode by default. When the active merged config contains a valid `opencode-with-claude` setup, the overlay also carries that plugin/provider bootstrap into managed OpenCode so the plugin can start Meridian and rewrite the Anthropic proxy URL at runtime. Direct OpenAI model availability and capability metadata remain authoritative to the active provider/runtime catalog; DevRyan does not manufacture GPT-5.6 model rows in these overlays.
- `packages/web/server/lib/opencode/runtime-surface-policy.js`: central managed-runtime tool-surface policy for allowed plugin specs, blocked MCP tombstones, and forbidden live tool IDs used by overlay generation and harness preflight diagnostics.
- `packages/web/server/lib/opencode/skill-policy.js`: shared visible-skill policy helpers used by settings routes and packaged-agent runtime sync so hidden/removed skills cannot remain allowed through managed agent configs.
- `packages/web/server/lib/opencode/agent-runtime-warmup.js`: non-fatal startup warmup runtime for read-only OpenCode health/config/status/agent/skill/MCP/command checks, optional Cursor SDK worker prewarm, and capped visible skill reads.
- `packages/web/server/lib/opencode/turn-timing.js`: in-memory first-turn timing diagnostics for client/proxy marks, Cursor SDK bridge marks, and observed OpenCode session/message/part events.
- `packages/web/server/lib/opencode/harness-result.js`: additive response-envelope helpers for diagnostics and low-risk runtime endpoints. Helpers preserve existing payload keys and add harness metadata with status, summary, next actions, artifacts, and recovery guidance.
- `packages/web/server/lib/opencode/harness-preflight.js`: read-only harness preflight diagnostics for agents, skills, MCP/tool manifest state, forbidden managed-runtime tool/MCP exposure, latest warmup state, and packaged prompt context-budget audit.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/core-routes.js`: server status/system routes, auth/access guard routes, and settings utility route registration.
- `packages/web/server/lib/opencode/shutdown-runtime.js`: graceful shutdown orchestration runtime for watcher/session/terminal/process/server teardown.
- `packages/web/server/lib/opencode/server-startup-runtime.js`: server listen/startup tunnel flow and process/signal handler orchestration runtime.
- `packages/web/server/lib/opencode/static-routes-runtime.js`: static asset/SPA fallback route registration and manifest route wiring.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: feature route composition runtime for dynamic import-backed config/skill/provider route registration.
- `packages/web/server/lib/opencode/opencode-resolution-runtime.js`: OpenCode binary resolution snapshot runtime for settings routes and diagnostics.
- `packages/web/server/lib/opencode/version-policy.js`: Target external OpenCode runtime policy. DevRyan recommends `anomalyco/opencode` v1.17.16 and surfaces the upstream install command while still using the user/system `opencode` binary.
- `packages/web/server/lib/opencode/tunnel-wiring-runtime.js`: tunnel service/routes composition runtime and active-port wiring for main server startup.
- `packages/web/server/lib/opencode/startup-pipeline-runtime.js`: server startup tail orchestration runtime for terminal/proxy/static/start-listen flow.
- `packages/web/server/lib/opencode/server-utils-runtime.js`: shared server runtime utilities for OpenCode proxy wiring, OpenCode port/readiness helpers, and snapshot fetchers.
- `packages/web/server/lib/opencode/openchamber-routes.js`: OpenChamber update and models metadata route registration.
- `packages/web/server/lib/opencode/pwa-manifest-routes.js`: PWA manifest route registration with recent-session shortcut resolution and short-lived caching.
- `packages/web/server/lib/opencode/project-icon-routes.js`: project icon upload/read/discovery route registration and icon storage orchestration.
- `packages/web/server/lib/opencode/skill-routes.js`: route registration for skill config CRUD, supporting files, and skills catalog scan/install flows.
- `packages/web/server/lib/opencode/plugins-readonly.js`: read-only OpenCode plugin discovery for Settings. Lists top-level `plugin` config entries and user/project plugin files without mutating plugin lists. The neighboring Slim setup routes are explicit Settings actions and do not make the plugin list itself editable.
- `packages/web/server/lib/opencode/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization).
- `packages/web/server/lib/opencode/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep.
- `packages/web/server/lib/opencode/settings-normalization-runtime.js`: path/settings/tunnel normalization and sanitization helpers runtime used by settings/routes/config wiring.
- `packages/web/server/lib/opencode/theme-runtime.js`: custom theme JSON validation and theme directory loading runtime for settings utility routes.
- `packages/web/server/lib/opencode/proxy.js`: OpenCode API/SSE forwarding and readiness-gate route registration. MCP connect/disconnect actions are forwarded explicitly before the generic proxy so upstream empty-body failures and network errors return structured JSON diagnostics to the UI. The proxy also records first-reply send/accept timing for `prompt_async` without reading or logging prompt bodies.
- `packages/web/server/lib/opencode/session-scoped-revert.js`: OpenChamber-owned safe session revert route that scopes filesystem restoration to the clicked chat session while preserving unrelated worktree changes.
- `packages/web/server/lib/opencode/session-runtime.js`: session status/attention/activity runtime for OpenCode SSE events.
- `packages/web/server/lib/opencode/watcher.js`: global SSE watcher runtime for push/session event fanout.
- `packages/web/server/lib/opencode/shared.js`: shared utilities for config, markdown, skills, and git helpers.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI session authentication runtime (outside OpenCode module).
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: UI passkey storage and WebAuthn registration/authentication helpers (outside OpenCode module).

## Public exports (auth.js)
- `readAuthFile()`: Reads and parses `~/.local/share/opencode/auth.json`.
- `writeAuthFile(auth)`: Writes auth file with automatic backup.
- `removeProviderAuth(providerId)`: Removes a provider's auth entry.
- `getProviderAuth(providerId)`: Returns auth for a specific provider or null.
- `listProviderAuths()`: Returns list of provider IDs with configured auth.
- `AUTH_FILE`: Auth file path constant.
- `OPENCODE_DATA_DIR`: OpenCode data directory path constant.

## Public exports (shared.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`, `CUSTOM_CONFIG_FILE`: Path constants.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants. Agents use PACKAGED and PROJECT; commands/skills still support USER and PROJECT.
- `ensureDirs()`: Creates required OpenCode directories.
- `parseMdFile(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom).
- `writeConfig(config, filePath)`: Writes config with automatic backup.
- `getJsonEntrySource(layers, sectionKey, entryName)`: Resolves which config layer provides an entry.
- `getJsonWriteTarget(layers, preferredScope)`: Determines write target for config updates.
- Agent identity, prompt, mode, permissions, description, and other markdown-owned fields are read-only through the server. Project agent changes are made by editing `.opencode/agents/*.md` directly; packaged agents are not user-authored config, but managed local OpenCode startups materialize the stable packaged baseline into `~/.config/opencode/agents/*.md` and track ownership plus a top-level applied packaged-set hash in `~/.config/opencode/.openchamber/packaged-agents.json`. User config may only store model/variant overrides, plus Council councillor model rows, under `openchamber.agentOverrides`; managed runtime overlays apply those effective model fields and project-specific visible-skill policy without rewriting the global packaged baseline.
- Command/skill project-scoped creates/writes default to `.opencode/` paths when a working directory is available; user config is the fallback only when no project directory exists or user scope is explicitly requested.
- `getAncestors(startDir, stopDir)`, `findWorktreeRoot(startDir)`: Git worktree helpers.
- `isPromptFileReference(value)`, `resolvePromptFilePath(reference)`, `writePromptFile(filePath, content)`: Prompt file reference handling.
- `walkSkillMdFiles(rootDir)`: Recursively finds all SKILL.md files.
- `addSkillFromMdFile(skillsMap, skillMdPath, scope, source)`: Parses and indexes a skill file.
- `resolveSkillSearchDirectories(workingDirectory)`: Returns skill search path order (config, project, home, custom).
- `listSkillSupportingFiles(skillDir)`, `readSkillSupportingFile(skillDir, relativePath)`, `writeSkillSupportingFile(skillDir, relativePath, content)`, `deleteSkillSupportingFile(skillDir, relativePath)`: Skill supporting file management.

## Public exports (routes.js)
- `registerOpenCodeRoutes(app, dependencies)`: Registers OpenCode-owned HTTP routes and internal module runtime:
  - `GET /api/config/settings`
  - `PUT /api/config/settings`
  - `GET /api/config/opencode-resolution`
  - `POST /api/opencode/directory`
- `GET /api/provider/:providerId/source`
- `GET /api/provider/anthropic/claude-cli`
- `POST /api/provider/anthropic/check-oauth`
- `POST /api/provider/cursor-acp/configure`
- `GET /api/provider/cursor-acp/runtime-status`
- `DELETE /api/provider/:providerId/auth`
- Owns lazy auth library loading for provider auth checks/removal.
- Keeps route behavior independent from composition root; `index.js` now supplies dependencies only.
- `POST /api/provider/anthropic/check-oauth` verifies Claude CLI OAuth with a bounded non-interactive Claude command, writes the `opencode-with-claude` proxy config to the active project config when possible (user config otherwise), and refreshes OpenCode only when it changes config.
- `POST /api/provider/cursor-acp/configure` verifies Cursor SDK auth/model discovery without writing OpenCode bridge config.
- `GET /api/provider/cursor-acp/runtime-status` reports Cursor SDK execution auth and dashboard usage-token status independently as `sdkAuthConfigured` and `usageAuthConfigured`, plus Cursor worker mode/readiness/restart diagnostics.
- `GET /api/session/status` merges Cursor SDK runtime busy/idle status into the proxied OpenCode session status payload, falling back to Cursor-only status when upstream status is unavailable.
- Intercepted `cursor-acp` prompts schedule a non-blocking Cursor Auto title request after acceptance. Only default, generated, provider-error, or legacy raw-prompt titles are eligible, and the upstream session is re-read before PATCH so manual names are never overwritten.
- `GET /api/config/providers` normalizes GitHub Copilot aliases to `github-copilot`, preserves upstream OpenCode model metadata when present, discovers account-specific Copilot models when upstream omits or empties them, and exposes a minimal fallback model list only when authenticated discovery is unavailable.

## Public exports (session-runtime.js)
- `createSessionRuntime({ writeSseEvent, getNotificationClients, broadcastEvent? })`: creates runtime-owned state machine and APIs for session status.
- Returned API:
  - `processOpenCodeSsePayload(payload)`
  - `getSessionActivitySnapshot()`
  - `getSessionStateSnapshot()`
  - `getSessionAttentionSnapshot()`
  - `getSessionState(sessionId)`
  - `getSessionAttentionState(sessionId)`
  - `markSessionViewed(sessionId, clientId)`
  - `markSessionUnviewed(sessionId, clientId)`
  - `markUserMessageSent(sessionId)`
  - `resetAllSessionActivityToIdle()`
  - `dispose()`

## Public exports (lifecycle.js)
- `createOpenCodeLifecycleRuntime(dependencies)`: creates lifecycle runtime for managed/external OpenCode process orchestration.
- Returned API:
  - `startOpenCode()`
  - `restartOpenCode()`
  - `waitForOpenCodeReady(timeoutMs?, intervalMs?)`
  - `waitForAgentPresence(agentName, timeoutMs?, intervalMs?)`
  - `refreshOpenCodeAfterConfigChange(reason, options?)`
  - `bootstrapOpenCodeAtStartup()`
  - `startHealthMonitoring(healthCheckIntervalMs)`
  - `waitForPortRelease(port, timeoutMs, hostname?)`
  - `killProcessOnPort(port)`

## Public exports (packaged-agent-sync.js)
- `syncPackagedAgents(options?)`: synchronizes release-bundled packaged agent markdown into the managed OpenCode runtime agent directory. It writes missing files, updates files that still match the last managed hash, removes stale managed files, supports explicit model/variant, skill-policy, and excluded-agent options for tests/migrations, and reports conflicts instead of overwriting user-modified same-name files. Normal startup passes empty overrides so the global packaged baseline stays stable across projects. When OpenCode Slim is active, startup excludes stale DevRyan workflow agents so Slim's plugin-provided agents/prompts own those names. Clean boots short-circuit from the manifest's applied packaged-set hash after cheap target existence checks, avoiding per-agent target-file reads.
- `formatPackagedAgentSyncConflicts(conflicts)`: formats sync conflicts for startup errors and logs.

## Public exports (runtime-agent-overlays.js)
- `syncRuntimeAgentOverlays(options?)`: synchronizes user-scoped agent model/variant overrides, packaged-agent visible-skill policy, active project/worktree external-directory allows, allowlisted active plugin registrations, bundled runtime plugin files/registrations (including the GitHub Copilot models picker-fallback plugin), Anthropic OAuth proxy bootstrap config, Cursor provider bootstrap config, GitHub Copilot auth alias synchronization plus account-discovered `github-copilot` provider models with runnable `api` metadata (using `auth.readAuthFile` when callers omit an explicit reader), runtime-only user remote MCP timeouts, and blocked ambient MCP tombstones into a managed high-precedence OpenCode config directory. It preserves explicit agent model overrides without synthesizing direct OpenAI provider availability around them.
- `getRuntimeAgentOverlayConfigDirectory(workingDirectory, options?)`: resolves the managed overlay config directory for a project directory.

## Public exports (skill-policy.js)
- `normalizeSkillPath(skillPath)`: resolves skill paths for stable hidden-skill comparisons.
- `filterVisibleSkills(skills, hiddenSkills)`: filters discovered skills against persisted hidden/removed skill paths.
- `buildVisibleSkillPolicy({ skills, hiddenSkills, runtimeExternalDirectories? })`: builds the allowed skill names/directories used to sanitize managed packaged-agent permissions, optionally carrying runtime-only project/worktree directories for overlay generation.
- `sanitizeAgentSkillPolicy(frontmatter, policy)`: rewrites an agent frontmatter permission block so `permission.skill` defaults to deny; skill-capable agents without an explicit wildcard deny get all visible skills, explicitly restricted agents keep only their previous visible allows, and runtime external directories are added as `external_directory` allow patterns while preserving the fallback action.

## Public exports (agent-runtime-warmup.js)
- `createAgentRuntimeWarmup(dependencies)`: creates a read-only warmup runtime. Returned API:
  - `warm({ directory?, timeoutMs?, commandTimeoutMs?, mcpTimeoutMs? })`: runs health, directory-scoped config/provider/agent/session-status/OpenCode skill/MCP/command fetches, optional Cursor SDK worker prewarm, and capped visible-skill file read tasks; returns per-task ready/error/timeout results and never starts prompts, command execution, or sessions. MCP status and command discovery have their own longer timeouts because cold OpenCode MCP/runtime loading can sit on the first-prompt critical path.
  - `getLatestResult()`: returns the latest in-memory warmup diagnostics, including timestamp, directory, task statuses, errors, timeout state, and additive harness metadata.
- `registerAgentRuntimeWarmupRoute(app, warmupRuntime)`: registers `POST /api/startup/agent-runtime-warmup` for startup readiness.

## Public exports (harness-result.js)
- `createHarnessSuccess(options?)`, `createHarnessWarning(options?)`, `createHarnessError(options?)`: build deterministic harness envelopes.
- `withHarnessResult(payload, envelope)`: adds `harness` metadata and only fills top-level envelope fields that do not already exist on the payload.

## Public exports (harness-preflight.js)
- `lintAgentHarness(options?)`: read-only linting for unavailable delegated agents, invalid permission keys, hidden skills still allowed by agents, stale model overrides, duplicate skill names by path, malformed skill frontmatter, and latest warmup failures.
- Skill-capable agent linting also verifies the platform skill-announcement policy is present and flags prompt conflicts when an allowed skill explicitly requires visible announcements.
- Permission-key linting accepts DevRyan's canonical tool aliases, including the edit/write/patch/apply_patch group, `webfetch`, and documented MCP-style wildcard denies such as `supabase_*`.
- `auditPackagedPromptContext(options?)`: report-only prompt context budget audit for packaged agents. It measures byte count, repeated routing rules, duplicated tool-safety text, and extraction candidates without mutating prompt content.
- `createHarnessPreflight(dependencies?)`: composes lint/audit/tool manifest/warmup diagnostics into a preflight result.
- `registerHarnessPreflightRoute(app, preflight)`: registers `GET` and `POST /api/diagnostics/harness/preflight`.

## Public exports (turn-timing.js)
- `createTurnTimingRuntime(options?)`: creates an in-memory capped timing store. Returned API:
  - `recordClientMark({ sessionId, messageId?, mark, directory?, metadata? })`
  - `processOpenCodeEvent(payload)`
  - `getRecentTimings({ sessionId?, limit? })`: returns timing marks/durations plus send metadata and diagnostic counters for provider/model/agent/variant, Cursor worker/run/stream timing, repeated text frames, malformed tool-call diagnostics, loop-guard diagnostics, and mutation evidence without exposing prompt or response text.
- `registerTurnTimingRoutes(app, runtime)`: registers internal diagnostic routes:
  - `POST /api/diagnostics/turn-timing/mark`
  - `GET /api/diagnostics/turn-timing/recent`

## Public exports (env-runtime.js)
- `createOpenCodeEnvRuntime(dependencies)`: creates runtime that owns OpenCode CLI environment and binary discovery state.
- Returned API:
  - `applyLoginShellEnvSnapshot()`
  - `getLoginShellEnvSnapshot()`
  - `ensureOpencodeCliEnv()`
  - `applyOpencodeBinaryFromSettings()`
  - `resolveOpencodeCliPath()`
  - `resolveManagedOpenCodeLaunchSpec(opencodePath)`: resolves the effective managed OpenCode launch target, unwrapping Windows package-manager shims to a direct native binary or explicit runtime+script when possible.
  - `resolveGitBinaryForSpawn()`
  - `resolveWslExecutablePath()`
  - `buildWslExecArgs(execArgs, distroOverride?)`
  - `isExecutable(filePath)`
  - `searchPathFor(binaryName)`
  - `clearResolvedOpenCodeBinary()`

## Public exports (env-config.js)
- `resolveOpenCodeEnvConfig(options?)`: resolves and validates OpenCode host/port/hostname environment configuration.
- Returned object fields:
  - `configuredOpenCodePort`
  - `configuredOpenCodeHost`
  - `effectivePort`
  - `configuredOpenCodeHostname`

## Public exports (hmr-state-runtime.js)
- `createHmrStateRuntime(dependencies)`: creates runtime for HMR state container initialization and runtime<->HMR state synchronization.
- Returned API:
  - `getOrCreateHmrState()`
  - `ensureUserProvidedOpenCodePassword(hmrState)`
  - `getUserProvidedOpenCodePassword(hmrState)`
  - `resolveOpenCodeAuthFromState({ hmrState, userProvidedOpenCodePassword })`
  - `syncStateFromRuntime(hmrState, runtime)`
  - `restoreRuntimeFromState({ hmrState, userProvidedOpenCodePassword })`

## Public exports (bootstrap-runtime.js)
- `createBootstrapRuntime(dependencies)`: creates runtime for base app route bootstrap and UI auth controller initialization.
- Returned API:
  - `setupBaseRoutes(app, options)`

## Public exports (network-runtime.js)
- `createOpenCodeNetworkRuntime(dependencies)`: creates runtime for OpenCode network and URL concerns.
- Returned API:
  - `waitForReady(url, timeoutMs?)`
  - `normalizeApiPrefix(prefix)`
  - `setDetectedOpenCodeApiPrefix()`
  - `buildOpenCodeUrl(path, prefixOverride?)`
  - `ensureOpenCodeApiPrefix()`
  - `scheduleOpenCodeApiDetection()`

## Public exports (settings-runtime.js)
- `createSettingsRuntime(dependencies)`: creates settings lifecycle runtime for read/migrate/persist concerns.
- Returned API:
  - `readSettingsFromDisk()`
  - `readSettingsFromDiskMigrated()`
  - `writeSettingsToDisk(settings)`
  - `persistSettings(changes)`

## Public exports (settings-helpers.js)
- `createSettingsHelpers(dependencies)`: creates settings helper runtime for settings request/response shaping.
- Returned API:
  - `normalizePwaAppName(value, fallback?)`
  - `sanitizeSettingsUpdate(payload)`
  - `mergePersistedSettings(current, changes)`
  - `formatSettingsResponse(settings)`

## Public exports (settings-normalization-runtime.js)
- `createSettingsNormalizationRuntime(dependencies)`: creates normalization/sanitization runtime for shared settings and tunnel helper logic.
- Returned API:
  - `normalizeDirectoryPath(value)`
  - `normalizePathForPersistence(value)`
  - `normalizeSettingsPaths(input)`
  - `normalizeTunnelBootstrapTtlMs(value)`
  - `normalizeTunnelSessionTtlMs(value)`
  - `normalizeManagedRemoteTunnelHostname(value)`
  - `normalizeManagedRemoteTunnelPresets(value)`
  - `normalizeManagedRemoteTunnelPresetTokens(value)`
  - `isUnsafeSkillRelativePath(value)`
  - `sanitizeTypographySizesPartial(input)`
  - `normalizeStringArray(input)`
  - `sanitizeModelRefs(input, limit)`
  - `sanitizeSkillCatalogs(input)`
  - `sanitizeProjects(input)`

## Public exports (theme-runtime.js)
- `createThemeRuntime(dependencies)`: creates custom theme runtime for on-disk theme discovery and JSON normalization/validation.
- Returned API:
  - `normalizeThemeJson(raw)`
  - `readCustomThemesFromDisk()`

## Public exports (project-directory-runtime.js)
- `createProjectDirectoryRuntime(dependencies)`: creates runtime for request/project directory candidate normalization and validation.
- Returned API:
  - `resolveDirectoryCandidate(value)`
  - `validateDirectoryPath(candidate)`: validates that the candidate exists as a directory and returns its filesystem realpath so request-scoped OpenCode calls use the same canonical directory key as session records.
  - `resolveProjectDirectory(req)`
  - `resolveOptionalProjectDirectory(req)`

## Public exports (config-entity-routes.js)
- `registerConfigEntityRoutes(app, dependencies)`: registers configuration entity routes:
  - Agents: `/api/config/agents`, `/api/config/agent-overrides`, `/api/config/agents/:name`, `/api/config/agents/:name/config`, and `/api/config/agents/:name/override`. Agent reads resolve project `.opencode/agents/<name>.md` first, then packaged defaults, then overlay user model overrides. Agent create/update/delete routes return 405 because markdown-owned mutation is filesystem-owned; the override route only accepts model, variant, and Council councillor model rows. Override save/reset persists first, then refreshes managed OpenCode with `{ agentName }`; if refresh fails, the route returns persisted success plus `reloadFailed`/`warning` metadata.
  - Commands: `/api/config/commands/:name`
  - MCP servers: `/api/config/mcp` and `/api/config/mcp/:name`

## Public exports (auth-state-runtime.js)
- `createOpenCodeAuthStateRuntime(dependencies)`: creates runtime for managed OpenCode auth password state and request headers.
- Returned API:
  - `getOpenCodeAuthHeaders()`
  - `isOpenCodeConnectionSecure()`
  - `ensureLocalOpenCodeServerPassword(options?)`

## Public exports (core-routes.js)
- `registerServerStatusRoutes(app, dependencies)`: registers status/system endpoints:
  - `GET /health`
  - `POST /api/system/shutdown`
  - `GET /api/system/info`
 - `registerAuthAndAccessRoutes(app, dependencies)`: registers browser auth/session exchange and API access middleware:
   - `GET /auth/session`
   - `POST /auth/session`
   - `GET /auth/passkey/status`
   - `POST /auth/passkey/authenticate/options`
   - `POST /auth/passkey/authenticate/verify`
   - `POST /auth/passkey/register/options`
   - `POST /auth/passkey/register/verify`
   - `GET /api/passkeys`
   - `DELETE /api/passkeys/:id`
   - `POST /api/auth/reset`
   - `GET /connect`
   - `app.use('/api', ...)` auth/tunnel guard
- `registerSettingsUtilityRoutes(app, dependencies)`: registers small settings utility endpoints:
  - `GET /api/config/themes`
  - `POST /api/config/reload`
- `registerCommonRequestMiddleware(app, dependencies)`: registers shared request middleware stack:
  - conditional JSON body parser behavior for `/api/*` vs non-API requests
  - URL-encoded parser setup
  - request logging middleware

## Public exports (cli-options.js)
- `parseServeCliOptions(options)`: parses serve CLI flags and environment-derived defaults:
  - Port/host/ui-password
  - Tunnel provider/mode/config/token/hostname
  - Legacy `--tunnel` shorthand normalization

## Public exports (cli-entry-runtime.js)
- `runCliEntryIfMain(dependencies)`: detects direct CLI execution and runs server startup with parsed CLI options.

## Public exports (server-utils-runtime.js)
- `createServerUtilsRuntime(dependencies)`: creates server utility runtime for OpenCode orchestration helpers.
- Returned API:
  - `setOpenCodePort(port)`
  - `waitForOpenCodePort(timeoutMs?)`
  - `buildAugmentedPath()`
  - `parseSseDataPayload(block)`
  - `fetchAgentsSnapshot()`
  - `fetchProvidersSnapshot()`
  - `fetchModelsSnapshot()`
  - `setupProxy(app)`

## Public exports (shutdown-runtime.js)
- `createGracefulShutdownRuntime(dependencies)`: creates graceful shutdown runtime for managed OpenCode and web server teardown sequencing.
- Returned API:
  - `gracefulShutdown(options?)`

## Public exports (server-startup-runtime.js)
- `createServerStartupRuntime(dependencies)`: creates runtime for server bind/startup tunnel and process handler wiring.
- Returned API:
  - `resolveBindHost(host)`
  - `startListeningAndMaybeTunnel(options)`
  - `attachProcessHandlers(options)`

## Public exports (static-routes-runtime.js)
- `createStaticRoutesRuntime(dependencies)`: creates runtime for static dist resolution and static route registration.
- Returned API:
  - `registerStaticRoutes(app)`

## Public exports (feature-routes-runtime.js)
- `createFeatureRoutesRuntime(dependencies)`: creates runtime for main feature route registration orchestration.
- Returned API:
  - `registerRoutes(app, routeDependencies)`

## Public exports (opencode-resolution-runtime.js)
- `createOpenCodeResolutionRuntime(dependencies)`: creates runtime for OpenCode binary/source snapshot resolution.
- Returned API:
  - `getOpenCodeResolutionSnapshot(settings)`: returns configured/resolved OpenCode binary details, target version policy, install command, any already-detected runtime version, and effective managed-launch fields (`launchBinary`, `launchArgs`, `launchWrapperType`) when applicable.

## Public exports (tunnel-wiring-runtime.js)
- `createTunnelWiringRuntime(dependencies)`: creates runtime for tunnel service construction and tunnel route registration.
- Returned API:
  - `initialize(app, initialPort)`

## Public exports (startup-pipeline-runtime.js)
- `createStartupPipelineRuntime(dependencies)`: creates runtime for terminal wiring, proxy/bootstrap scheduling, static route registration, and server startup/listen flow.
- Returned API:
  - `run(options)`

## Public exports (openchamber-routes.js)
- `registerOpenChamberRoutes(app, dependencies)`: registers OpenChamber endpoints:
  - `GET /api/openchamber/update-check`
  - `POST /api/openchamber/update-install`
  - `GET /api/openchamber/models-metadata`
  - `GET /api/zen/models`

## Public exports (pwa-manifest-routes.js)
- `registerPwaManifestRoute(app, dependencies)`: registers PWA manifest endpoint with dynamic app-name resolution and recent-session shortcuts:
  - `GET /manifest.webmanifest`

## Public exports (project-icon-routes.js)
- `registerProjectIconRoutes(app, dependencies)`: registers project icon routes and owns icon storage/discovery flow:
  - `GET /api/projects/:projectId/icon`
  - `PUT /api/projects/:projectId/icon`
  - `DELETE /api/projects/:projectId/icon`
  - `POST /api/projects/:projectId/icon/discover`

## Public exports (skill-routes.js)
- `registerSkillRoutes(app, dependencies)`: registers skills-related routes:
  - Skills config CRUD and metadata under `/api/config/skills*`
  - Skills catalog listing/source pagination, scan, and install routes
  - Supporting skill file read/write/delete routes

## Public exports (proxy.js)
- `registerOpenCodeProxy(app, dependencies)`: registers OpenCode proxy routes and middleware.
- Owns:
  - SSE forwarders: `GET /api/global/event`, `GET /api/event`
  - Scoped session revert: `POST /api/openchamber/session/:sessionID/scoped-revert`
  - Session message forwarder: `POST /api/session/:sessionId/message`
  - Generic `/api/*` forwarding with hop-by-hop header filtering
  - Windows `/session` merge fallback path behavior
  - OpenCode readiness gate for proxied `/api` requests

## Public exports (watcher.js)
- `createOpenCodeWatcherRuntime(dependencies)`: creates global event watcher runtime backed by the shared upstream SSE reader.
- Returned API:
  - `start()`
  - `stop()`
- Behavior:
  - Waits for OpenCode readiness before attaching the watcher.
  - In production wiring, subscribes to the shared global message-stream hub instead of opening its own `/global/event` connection.
  - Can still create its own `/global/event` reader when no shared hub is provided, which keeps module tests and isolated reuse simple.
  - Reuses event-stream parsing, `Last-Event-ID`, stall timeout, and reconnect behavior.
  - Forwards unwrapped global event payloads into notification/session side effects.

## Storage and configuration
- Provider auth: `~/.local/share/opencode/auth.json`.
- User config: `~/.config/opencode/opencode.json`.
- Project config: `<workingDirectory>/.opencode/opencode.json` or `opencode.json`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Rate limit config: `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars.

## Notes for contributors
- This module serves as foundation for OpenCode-related server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
- Tunnel auth treats `host.docker.internal` as local-only when the socket remote IP is private/loopback.
