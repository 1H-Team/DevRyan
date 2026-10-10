# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [2.0.6] - 2026-10-10

- Fix startup preparation when a sealed runtime manifest exceeds 4 MiB, using the shared 32 MiB limit while retaining integrity checks. Keep the original failure and Retry visible when startup settings cannot be read. Isolated packaged evidence is recorded in [the runtime preparation audit](docs/audits/2026-10-10/runtime-preparation/README.md).
- Route Sign in with ChatGPT primary turns through HTTP, including requests prepared for WebSocket transport, and record sanitized provider refusal reasons. Transport regression and isolated startup evidence are recorded in [the primary transport audit](docs/audits/2026-10-10/siwc-primary-transport/README.md).
- Repair Sign in with ChatGPT responses when the provider omits the SSE content type, while retaining stream validation and completion checks. Prevent concurrent xAI requests from racing the same credential refresh, and restore inspection of ordinary Claude accounts.
- Add an optional Codex connection for OpenAI usage without changing the selected inference sign-in. Show usage source and account identity, weekly windows, and reset-credit expiry; distinguish unavailable inventory from a confirmed zero balance.
- Preserve useful provider failure reasons in live and restored sessions, and redact sensitive provider metadata from diagnostics.
- Add startup phase timings and renderer readiness diagnostics. About keeps the app version and OpenCode update status together. Startup import experiments remain unapplied; no launch-speed improvement is claimed.

Provider verification and limitations are recorded in [the provider repair audit](docs/audits/2026-10-10/provider-repairs/README.md). Startup diagnostics are recorded in [the startup import evaluation](docs/audits/2026-10-10/startup-imports/README.md). Original release qualification is recorded in [the v2.0.6 release evidence](docs/audits/2026-10-10/release-2.0.6/README.md); replacement qualification is recorded in [the replacement release evidence](docs/audits/2026-10-10/rerelease-2.0.6/README.md).

## [2.0.5] - 2026-10-10

- Restore usage details for Claude, OpenAI, xAI and OpenCode Go under the native runtime. Usage now reads the selected account from the native credential store instead of a credential file that no longer exists. xAI usage is read-only and may lag until the next xAI request renews the sign-in. A connected provider whose usage cannot be read shows a short reason with a retry instead of nothing, and usage discovery retries within seconds after a slow start.
- With Sign in with ChatGPT, Settings → Providers lists and counts only the OpenAI models the account can use. A saved default that needs an API key resolves to a usable OpenAI model. API-key accounts keep their full list when a ChatGPT account lookup fails or the project directory is not a reviewed location.
- Accept xAI sign-in rows when reading provider credential metadata.

Source verification is recorded in [the usage and model list record](docs/audits/2026-10-10/usage-models/README.md); real-account verification is pending.

- Recover a stale background-service owner immediately, report native startup health and preparation phases, and stop renderer polling when startup fails. Manual Retry starts a fresh attempt. Native catalog failures now record sanitized failure stages. Three isolated packaged launches and three first launches after a 2.0.20 → 2.0.26 upgrade reached usable chat. Scope, measurements and limitations are recorded in [the startup reliability audit](docs/audits/2026-10-09/startup-reliability/README.md).
- Let startup finish when a saved OpenAI login uses a retired authentication method. Reconnect through Sign in with ChatGPT before using that provider. Deliver repaired native host code even when the OpenCode version stays the same, retaining the previous bundle for rollback. Defer optional agent/chat warmup until the app is usable and automatic update discovery until its normal interval. Isolated startup and same-version delivery checks are recorded in [the model catalog repair audit](docs/audits/2026-10-10/model-catalog/README.md).
- Expand isolated startup, model-catalog and retained-bundle upgrade verification, including packaged headless service launches.
- Remove old disposable QA and synthetic benchmark payloads while preserving source, retained evidence and installed-app data. Details are in [the storage cleanup record](docs/audits/2026-10-09/storage-cleanup/README.md).
- Remove generated codemaps, finished plans and unreferenced audit evidence, and make `docs:validate` reject codemaps and unretained audit files. Details are in [the documentation cleanup record](docs/audits/2026-10-09/docs-cleanup/README.md).
- Accept a retained native runtime bundle of any OpenCode 2.x release for rollback, running its own controller, instead of only the listed 2.0.20, 2.0.24 and 2.0.26 releases. Cross-release clones still require a reviewed release pair.

Release verification for the current candidate is recorded in [the usage repair release evidence](docs/audits/2026-10-10/rerelease-usage-2.0.5/README.md). Prior release verification is recorded in [the replacement v2.0.5 release evidence](docs/audits/2026-10-10/rerelease-2.0.5/README.md); [the earlier publication evidence](docs/audits/2026-10-10/release-2.0.5/README.md) is retained as history.

## [2.0.4] - 2026-10-09

- OpenCode Storage (Settings → About → Data & Storage) is now read-only and says so. A native OpenCode 2 database is reported as needing no cleanup instead of as an unknown layout. Compact Now and the "Cleanup runs before every OpenCode launch" notice are removed: DevRyan runs OpenCode 2, and since the move to the native runtime the OpenCode 1 cleanup no longer ran, because nothing called its pre-launch hook. For an OpenCode 1 database, Dry Run still reports what a cleanup would remove. Details are in [the storage audit](docs/audits/2026-10-09/opencode-storage-v2/README.md).

- Upgrade a retained native runtime at startup when a DevRyan update pins a newer OpenCode version, instead of failing with "Native runtime is not ready: version_mismatch". The selected bundle is cloned onto the shipped runtime before any controller starts, and the previous bundle stays as the rollback target. Clones now also qualify fresh-install databases, which never carry the legacy migration table. A runtime that still misses the pin is refused before launch with the version pair and the recorded upgrade failure. Evidence is in [the startup upgrade audit](docs/audits/2026-10-09/startup-bundle-upgrade/README.md).

- Upgrade the bundled native runtime and Bot image to OpenCode 2.0.26. Retained 2.0.24 and 2.0.20 bundles keep their own controller; a 2.0.26 database never clones into an older release. The bundled runtime keeps the 2.0.24 external-directory permission prompt that OpenCode 2.0.26 removed from agent defaults, and still loads OpenCode's configuration policy plugin. Qualification is recorded in [the runtime upgrade evidence](docs/audits/2026-10-09/opencode-2.0.26/README.md).
- Add Check for Updates to the OpenCode section of Settings → About. It reports the latest upstream stable 2.x release on request; bundled runtime updates still arrive through DevRyan updates.
- Reduce mutation ledger storage by sharing untouched file baselines with existing content objects, compacting older baseline records, and reclaiming unreachable Git objects. Existing Revert and Redo history is preserved; older hosts refuse the compacted records. Measurements and retention limits are recorded in [the ledger evidence](docs/audits/2026-10-09/ledger-retention/README.md).
- Avoid verifying the same harness ledger twice during runtime startup while retaining verification for every launch, and enable the reviewed provider recovery policy for OpenCode 2.0.26.
- Keep development Electron QA on Chromium's mock keychain so its private profile cannot trigger a macOS login-keychain reset dialog.
- Start standalone web/Electron QA through the verified private native bundle and synthetic wire facade used by matrix QA, replacing retired external-runtime flags that caused startup rejection. Missing native artifacts fail before an app launches.

Release verification is recorded in [the release evidence](docs/audits/2026-10-09/release-2.0.4/README.md) and [the re-release evidence](docs/audits/2026-10-09/rerelease-2.0.4/README.md).

## [2.0.3] - 2026-10-08

- Ship the bundled native runtime once in the desktop app while keeping the web server files available outside the application archive.
- Clean up disposable QA, test and benchmark runtime payloads after successful or interrupted runs, with isolated profiles and shared dependency caches.
- Add cache reporting and pruning with retention rules that preserve cited evidence, pinned runs, active packages and required build inputs. Preview scans tolerate entries removed during enumeration.

Release verification is recorded in [the release evidence](docs/audits/2026-10-08/release-2.0.3/README.md).

## [2.0.2] - 2026-10-08

Candidate qualification is tracked in [the release evidence](docs/audits/2026-10-05-release-2.0.2/README.md). This entry does not establish publication or installed-platform acceptance.

- Upgrade the bundled native runtime to OpenCode 2.0.24. Retained 2.0.20 bundles keep their own controller and guarded credential recovery. Additional qualification and remaining live acceptance are recorded in [the runtime upgrade evidence](docs/audits/2026-10-07-opencode-2.0.24/README.md).
- Import hosted Bot configuration and current avatars into the local catalog while preserving local history and files. Imported Bots, routines and integrations stay inactive until their local resources and credentials are ready; interrupted transfers can resume.
- Show local Bot hosting and Docker status in About, restore admitted account authentication through background-service tunnels, and make ChatGPT enrollment recoverable when the first saved credential is selected before completion.
- Add DevRyan-owned Sign in with ChatGPT for eligible plan usage, with separate OpenAI API-key authentication. Saved registrations remain distinct across workspaces; sign-in without plan permission stays signed in and requires explicit reauthorization before subscription inference. Legacy Codex OAuth requires reconnect.
- Use the selected native credential for account-specific OpenAI model discovery. Unavailable discovery no longer implies model entitlement. SIWC Responses requests preserve local tools, reject unsupported capabilities before sending, and require a completed stream; API-key requests retain their existing behavior.
- Image generation uses an explicitly selected OpenAI API key with API billing. SIWC image requests refuse before token refresh or network traffic; account changes invalidate an in-flight image request.
- Runtime settings show when packaged agent instructions conflict with your edits. Restore is explicit, preserves a backup, and refuses a file changed since inspection. Planning and implementation guidance now follows the saved plan and keeps incomplete work visible.
- Skills use their human names in tool rows, permission requests and restored history. Generic reviewed skills remain available; bundled Superpowers integration is retired.
- Dedicated Claude enrollment preserves healthy accounts when another enrollment is interrupted. Recover and Use settles the original verified credential without repeating sign-in. Read-only account inspection remains access-only.
- Runtime updates and recovery retain the original owner, credential checkpoint and durable execution evidence. A completed update recovers even when its caller disconnects, and an uncertain shutdown keeps the runtime held for reconciliation.
- In-app macOS updates use verified, resumable DMG downloads, installation preflight, owned runtime drain and durable rollback state. The app retains its current ad-hoc signing class.
- Prepare unsigned Windows x64/ARM64 NSIS packaging, native file ownership and updater recovery. Core execution remains disabled until native safety, namespace durability and actual installer/update qualification pass on both architectures; no qualified Windows release is claimed.
- Release preparation reuses Bot images only after verifying identical build inputs and signed image evidence. Dry runs prohibit publication, tags and other external writes; release assets must match their packaging digests and exact names.
- Add durable diagnostics for provider sends, ledger waits, bridge calls, first output and first answer text. No performance improvement is claimed.

## [2.0.1] - 2026-10-05

- Fix the first launch after upgrading to 2.0. The one-time setup import no longer reads saved version 1 plans under `~/.config/openchamber/projects/<id>/plans` or Finder metadata, and imports only the top-level project records. Saved version 1 plans and conversations stay where they are and are not imported. The bundled runtime can now finish importing saved provider sign-ins; before, it could not start on any upgraded install with saved credentials.
- A failed or interrupted first launch now recovers on the next start. An unfinished setup copy is redone from your current settings, an unfinished or out-of-date runtime preparation is discarded before anything is selected, and the temporary setup copy is removed in one step. A second app instance starting at the same time waits for the first instead of failing.
- Ordinary setups no longer stop the import. Symlinked skills, agents and configuration folders inside your home folder are followed, while credential, token, browser and DevRyan's own secret stores are never copied. Git and dependency folders, oversized, unreadable or special files, and unusual `auth.json` or Meridian profile entries are skipped and logged instead of failing the launch. Startup errors now name the file that caused them.
- Login-shell variables that the 2.x desktop runtime does not support (`OPENCODE_BINARY`, `OPENCODE_HOST`, `OPENCODE_SKIP_START=true` and similar) are ignored and logged instead of blocking startup.
- Local account owners are restored once from the upgrade snapshot, so a later owner change no longer blocks startup. A background runtime left running by an older version is stopped and replaced instead of being reused.
- Releases now publish only the Apple silicon DMG. DevRyan 2.0.0 and earlier cannot update to 2.0.1 in the app: download `DevRyan-2.0.1-arm64.dmg` from the release page, quit DevRyan and replace it in Applications. If background Bots are on, turn the background runtime off first in Settings > Bots; if 2.0.0 does not open, switch DevRyan off under System Settings > General > Login Items & Extensions > Allow in the Background, then turn background Bots back on after 2.0.1 starts. Updating to 2.0.2 is also a manual install: from 2.0.1 the Update button stops the background runtime and opens the verified DMG download. In-app updates resume from 2.0.2.
- Bot images are rebuilt as usual. Exact live-provider journeys, complete diagnostic journal qualification and the performance comparison remain open.

## [2.0.0] - 2026-10-05

- This release ships the macOS Apple silicon desktop app only. Web/npm, Intel macOS, Linux and Windows distributions await native runtime qualification.
- Upgrade the bundled agent runtime to native OpenCode 2.0.20, with pinned, verified runtime assets and reviewed Slim, Ponytail, Claude, browser, document and image integrations.
- Add explicit runtime bundle setup, update, resume and rollback controls. Existing configuration and project files are preserved; version 1 conversations remain in their original data store, and version 2 starts a separate conversation store.
- Preserve managed task ownership, cancellation, recovery and conversation Undo/Redo through the native runtime, with stricter admission and retained recovery state across restarts.
- Improve provider and model availability, saved effort selection, queued-message handling and dedicated Claude enrollment. Shared Claude CLI accounts remain access-only and require reconnecting when their grant expires.
- Refine mobile chat and settings layouts, replace sidebar spinners with status dots, and improve startup and runtime recovery feedback.
- Expand deterministic, compiled-runtime and isolated UI verification. Exact live-provider journeys and the full performance comparison remain unqualified; no performance improvement is claimed.

## [1.2.22] - 2026-09-30

- Saved plans now support versioned edits from Plan View and the managed agent, with conflict detection, serialized saves and current ownership checks. Switching chats preserves each plan's draft, and implementation uses the selected saved revision.
- Sequential edits and Undo/Redo retain exact mutation order. Stopping or restarting a terminal cleans up owned descendants, including children that resist graceful termination, and Electron waits for pending cleanup before quitting or restarting.
- Provider authentication recovery handles long-lived OAuth refresh responses and keeps bounded diagnostics. New successful turns clear superseded failure notifications while retaining current failures through reload.
- Agent guidance clarifies saved-plan access, verification and supervised server cleanup. Status animation retains its appearance with one accessible label.

## [1.2.21] - 2026-09-30

- Local execution deadlines now account for host event-loop stalls while retaining wall-clock caps. Finished tools return after durable publication without waiting for private-view cleanup, and diagnostics distinguish tool execution, publication, cleanup and host stalls.
- Confined macOS commands can stop the detached child process groups they started. An idle-process watchdog cleans up stuck commands, and cancelled executions record that their private edits were discarded.
- Managed tasks that stop between tool steps now settle with recoverable output instead of waiting for their full deadline. Finished task history defaults to 14 days, with uncollected results retained while their conversation still has active or recent work.
- Enable automatic provider recovery and managed continuation on the verified OpenCode 1.18.33 companion. Advisory recovery hooks tolerate temporary host transport failures while preserving host rejections and guarded sessions, and unchanged recovery records poll less often.
- Desktop startup registers a missing background runtime service before waiting for it. Hidden and minimized windows pause animations and visibility-dependent work, and database maintenance resolves the active companion or standard OpenCode database.
- Agent language servers default to off unless explicitly enabled, avoiding repeated cold starts for confined edits. A live, idle OpenCode process must fail three consecutive health probes before it is restarted.
- Managed task cards place pending dispatches in their expected wave and show model details for model recovery rather than ordinary same-model deadline resumes. Plan implementation prompts allow independent phases to run together with bounded specialist assignments.

## [1.2.20] - 2026-09-29

- Orchestrator no longer sees Oh My OpenCode Slim's background-job tools (`task_status`, `task_reply` and the rest). They work only for Slim's own jobs, which DevRyan never creates, so it now delegates and follows up only through DevRyan's managed tasks.
- Orchestrator starts Librarian beside Explorer whenever a task depends on current external or version-specific facts, including single-area tasks, and answers stable, general programming questions without a web lookup.
- Agent routing evaluations now allow at most one same-owner review follow-up and require every implementing specialist to complete its own edit, so a retry after a child worked in the wrong project no longer passes. New cases cover a direct typo fix (no specialist) and real Plan mode followed by "implement plan" (Fixer keeps ownership), and the documentation case checks the documented default value. Routing docs now describe the narrower direct-edit rule.
- `read`, `glob`, `grep` and `skill` no longer wait behind other sessions in the same project. Each call's result was held until three bookkeeping steps finished one after another, all queued behind every session's work in that project; with about seven sessions on one project these tools took a median of 21–35 seconds. A read-only call now waits only for the one ledger commit that protects Revert and cancellation (`DEVRYAN_DIRECT_LEDGER_ONLY=0` restores the previous bookkeeping). The diagnostic journal now records a `direct_finish` timing summary for slow calls, which separates tool run time, queue waiting and commits.

## [1.2.19] - 2026-09-29

- Orchestrator delegates implementation to specialists again. After Explorer discovery, every bug fix and non-design code change goes to Fixer, every visual change (including fully specified tweaks and approved plans) goes to Designer, and current external documentation goes to Librarian, alongside Explorer when a task depends on it. Orchestrator edits directly only mechanical typo, comment or wording fixes. Plan mode dispatches Explorer and Librarian, and plan approval keeps specialist ownership.
- Update Oh My OpenCode Slim to 2.2.25. It brings a sturdier `apply_patch`, web-fetch security fixes and fewer injected reminders; DevRyan's agent prompts and the disabled foreground fallback are unchanged.
- Agent routing evaluations now expect Fixer and Designer for natural bug-fix and visual requests, add a Librarian documentation case, and accept one Explorer per subsystem for broad discovery and same-owner review remediation for unprompted cases. Orchestrator briefs now name files by absolute workspace path.
- The Git sparkles button (commit message) and PR Generate now use DeepSeek V4.1 Flash on OpenCode Zen at low reasoning effort instead of rotating free Zen models. Those free models kept timing out, so the button waited about 45 seconds and then fell back to a generic local draft. In live checks, commit drafts took 5–8 seconds and a small PR description about 15 seconds. The model is paid, so an OpenCode Zen API key with credit is required. If it fails, commit generation still produces a local draft whose warning names the reason, and PR generation still falls back to the Builder model.
- Claude (`anthropic/*`) requests now run in the requesting session's project. Previously they ran in the project OpenCode was launched from, so concurrent projects shared one Claude transcript store and the model could be told another project's working directory. A request whose session directory cannot be verified is refused instead of running elsewhere.
- Skills called by their folder name (for example `accessibility` or `1health-vitest`) now load the registered skill (`Accessibility`, `1Health Vitest`) on the first try instead of failing and being retried. The skill name matcher never received the skill list, because it expected a newer OpenCode client method than the one plugins get. Unknown skill names now fail with a list that pairs each folder name with its skill name.

## [1.2.18] - 2026-09-28

- Electron recovers a stale background runtime owner after a reboot or PID reuse while preserving live-owner protection.
- Settings groups session defaults and agent runtime controls under Agents, refreshes navigation and field layouts, and improves passkey, retention, behavior, and user management screens.
- Bots show Docker and catalog availability directly instead of waiting indefinitely. Retry refreshes Docker capability state, and the macOS app can open Docker Desktop on request.
- Bot catalog and event handling recover more reliably after disconnects, preserve loaded entries, and present clearer status in the sidebar and gallery.
- Update the managed OpenCode companion to 2.1.2 on OpenCode 1.18.33, with matching SDK and QA pins. Duplicate-output profiles await requalification; automatic provider recovery remains disabled for this unqualified runtime version.
- Refresh Appearance settings and previews, and make Bot catalog import an explicit owner action while Supabase is disconnected.
- Update Agent Browser control and recording support, including the packaged FFmpeg assets and browser inspection checks.

## [1.2.17] - 2026-09-27

- Managed child Stop and handoff now retain recoverable output through transient status or transcript failures, fence cancelled attempts before submission, and avoid aborting a newer user turn after an authentication failure.
- Agent Runtime settings report the desired and applied language-server state separately, preserve pending saves across reloads, and only clear restart notices after managed runtime readiness confirms the setting.
- Bot and agent catalog views recover from connection changes without losing loaded entries. Provider catalog refreshes have bounded, shared reads and reject late results after shutdown.
- Compaction anchors preserve incomplete task scope, and the updated Electron and QA fixtures exercise runtime settings, managed cancellation, and ledger preparation with clearer evidence boundaries.
- Stopping a session now records where the abort came from, settles stopped turns and managed children without automatic continuation, and keeps pending questions available after a turn ends.
- Managed OpenCode crashes now leave diagnostic evidence and reconcile sessions that the restarted runtime reports idle. Session archive and unarchive operations retry temporary restart failures.
- Provider sign-in failures surface promptly. Confined Claude workers receive the current access token while refresh credentials stay with the host.
- Confined execution keeps a session-scoped temporary directory and allows ignored output folders to write through on macOS while preserving read-only dependency inputs.
- Orchestrator starts unfamiliar task discovery with Explorer, with direct handling for scoped work and follow-ups.

## [1.2.16] - 2026-09-27

- Settings now groups usage with each provider, with a separate usage view for accounts that cannot manage providers. MCP, plugin, skill, and provider settings share clearer navigation and empty states.
- Electron waits through cold runtime-service startup before falling back, while still surfacing other connection failures promptly.
- OpenCode routes and managed settings handle provider, session, and request failures more consistently; Git commit text and Free Zen generation received related fixes.

- Bot management now retries temporary catalog startup and connection failures, keeps loaded Bots visible during refresh failures, and reports failed catalog reads in the diagnostic journal. Hosted Bot discovery shows its progress and failures without blocking local Bots.

- Bots, their history and their encrypted files now live in a local Bot catalog on this computer (PostgreSQL plus a loopback-only REST view, shipped as two new signed runtime images). The workstation owner keeps Bot access while Supabase is off, unreachable or revoked; shared users still need current Supabase authorization. Bot storage is backed up daily and before every update, restore or import, and Bot Settings adds Restore, Start Empty, Resume Bots and a one-time, owner-confirmed import of hosted Bots that keeps the Bots already on this computer.

- Managed Remote works with Supabase Off through a private, expiring owner link. The link grants the authenticated local owner access on the managed tunnel, can be renewed from tunnel settings, and is revoked with its session when the tunnel or owner state changes. Bot-only sharing continues to require its existing authorization.
- Managed plugins: upgrade Oh My OpenCode Slim from 2.2.18 to 2.2.24. Slim's `apply_patch` pre-check no longer rejects patches whose context lines differ from the file only by leading indentation ("apply_patch verification failed: Failed to find expected lines"). OpenCode already accepted these patches, and agents no longer need to re-read and retry. Genuinely missing context is still rejected. The real-package upgrade checker covers both cases.
- DevRyan-managed OpenCode runtimes now disable Oh My OpenCode Slim's foreground model fallback in the generated runtime config. When a model chain was configured, that fallback could move a parent session's task waiter to the background and abort the child outside DevRyan's orchestration. Your own Slim config file is unchanged.
- Confined macOS executions can host their own short-lived Unix sockets for browser automation while keeping host sockets denied. Project dependency caches use a writable execution overlay, and stale private socket directories are cleaned after crashes.
- Plan and turn completion wait for active managed children. Open todos defer completion only for agents that the runtime automatically continues, so other agents can finish with blocked items.
- The bundled browser skill guides agents to an already running local preview and stores screenshots inside the workspace.

## [1.2.15] - 2026-09-26

- Fixed "DevRyan could not connect to OpenCode" at launch for profiles where open-cursor's installer had symlinked `plugin/cursor-acp.js`, which is its default. The legacy-plugin migration now retires that symlink without touching the installed package. A copy it cannot retire safely no longer blocks OpenCode: DevRyan starts, warns, and offers **Retire Plugin**, which keeps a backup.
- When OpenCode cannot start, the startup screen names the server's reason, and **Retry** also reruns workspace sync, so a recovered runtime no longer stays behind a stale error. Deterministic profile-provisioning failures are no longer retried.

- Managed Cursor profiles retire the known legacy standalone `cursor-acp.js` plugin at startup, preserving verified backups and reporting conflicts for modified or unsafe files. The maintained Cursor adapter remains available.
- Orchestrator handles bounded implementation and visual changes directly when specialist work adds no clear value. Explorer uses a focused navigation brief and stops after two unsuccessful search rounds; specialist requests and Plan restrictions remain authoritative.
- Execution diagnostics record bounded tool origin, execution tier and fallback reason so native reads and confined calls can be distinguished without changing admission decisions.
- Chat message headers and comparison rendering preserve the intended presentation during thinking and result transitions.
- Expanded deterministic and packaged verification for profile migration, native tool routing, agent evaluation and mounted chat behavior. The simple-task latency pilot was inconclusive because specialist providers rejected some runs; no speedup claim is made.
- Updated package and desktop metadata to 1.2.15. The release workflow verifies hosted migration history and the Production Bots schema marker before publication.

## [1.2.14] - 2026-09-25

- Fixed the launch freeze and first-tool-call stalls in projects with large gitignored folders: gitignored directories without tracked files are now read-only dependency inputs and are never copied into the confined execution ledger, which also became much faster on large projects.
- Added companion 2.1.0 (direct receipts for built-in read, glob and grep, owning-plugin-only tool workers, shared TypeScript language server, 404 for unknown OpenCode routes) and qualified duplicate outputs for four xAI/OpenAI routes (about 26-29% less primary-request input).
- Fixed session-change receipt conflicts, hidden-model reset after about 20 models, agent-name validation for managed delegation, and the bundled Open Cursor plugin replacing OpenCode's own tools; the model picker now groups models by provider.

## [1.2.12] - 2026-09-24

- Added companion 2.0.0, versioned on its own: built-in read, glob and grep run natively, tool workers start lighter, and DevRyan falls back to plain OpenCode instead of blocking prompts when the companion is unavailable (Revert can adopt such conversations).
- Claude via Meridian runs from the real project directory, confined processes resolve host names again, duplicate outputs were requalified for the OpenAI route, and QA profiles isolate HOME, Meridian and Claude state.

## [1.2.11] - 2026-09-24

- Managed runtime: remove the bundled Context Mode integration and its worker stack, simplify prompt tool routing, and update agent guidance and QA fixtures for native tools.
- Orchestration and recovery: improve specialist review and prompt budgets, provider tool discovery, session admission, reconnect reconciliation, and tool activity reporting.
- Desktop and Bots: add an administrator control for the background runtime service, strengthen service startup and ownership recovery, and update the OpenCode companion to `1.18.31-devryan.13`.
- Security and diagnostics: scan raw configuration layers for credential exposure, tighten tool input and document reading, and improve diagnostic sanitization and journal coverage.
- Quality: expand deterministic coverage across runtime, server, UI, Electron, and agent evaluation paths; update all package and desktop metadata to 1.2.11.
- Database: apply pending repository migrations and verify the Production Bots schema marker before release publication.

## [1.2.10] - 2026-09-23

- Recovery and orchestration: improve provider failure handling, collection of completed sub-agent results, runtime restart reconciliation, and execution admission diagnostics.
- Chat and context: anchor native compaction summaries to the active objective, render compaction turns clearly, and preserve authoritative activity across reconnects.
- Concurrent Revert and runtime durability: store immutable captured objects safely, recover interrupted mutations, strengthen host ownership, and update the bundled OpenCode companion to `1.18.31-devryan.12`, and build the macOS spawn adapter for arm64e system tools.
- Web and desktop: bound event-stream work, improve Git and worktree discovery, refine Supabase connection and Bot-schema reporting, and harden packaged runtime lifecycle checks.
- Quality and release: expand deterministic coverage across these paths and update DevRyan package and desktop metadata to 1.2.10.
- macOS releases now ship Apple silicon (arm64) only. Intel Macs no longer receive desktop builds or updates, and the npm package no longer bundles the Intel native runtime.
- Faster releases: reuse the verified OpenCode companion build, compress handoff archives with zstd, and skip duplicate install-time web builds.
- OpenCode Zen usage tracking now connects through OpenCode Console sign-in, refreshes credentials automatically, and guides existing cookie-based connections to reconnect.

## [1.2.9] - 2026-09-21

- Sessions and runtime: add configurable automatic cleanup, improve long-session efficiency, preserve execution ownership through recovery and revert flows, and make failure states actionable across web and Electron.
- Desktop and terminal: ship the in-tree Ghostty terminal adapter, strengthen managed SSH reuse and shutdown cleanup, and keep packaged runtime behavior aligned across supported macOS architectures.
- Git and worktrees: serialize repository mutations, validate hunk operations, preserve managed branch ancestry, and harden status, push, and concurrent revert behavior.
- Settings and integrations: improve provider connection state, retention controls, MCP navigation, mobile/PWA web-package updates, and secure local session handling.
- Quality: expand deterministic coverage for execution admission, recovery, skill presentation, session lists, file editing, terminal rendering, storage policy, packaged artifacts, and runtime parity.
- Database: verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.2.9 and publish branded web and macOS artifacts.

## [1.2.8] - 2026-09-21

- Runtime efficiency: bound SSE and WebSocket queues by count and bytes, batch contiguous streaming deltas, enforce a protected renderer history budget, compress journal rotations asynchronously, and replace offset-based vector scans with keyset retrieval and bounded top-k ranking.
- Harness context: deduplicate repeated skill and tool payloads without changing canonical messages, persist source-aware fingerprints and execution admission, and add deterministic and optional native comparison tooling while keeping experimental policies disabled by default.
- Reliability and recovery: preserve execution ownership through lifecycle and persistence races, surface actionable session failures, strengthen primary-model recovery classification, and retain conflict-safe Concurrent Revert behavior across delayed or interrupted mutations.
- Desktop and settings: park inactive manual browser tabs with background throttling while preserving agent surfaces, make OpenCode and tunnel status failures authoritative, and tighten revocable tunnel access around supported Bot routes and local ownership.
- Quality: expand event-stream overload, history-budget, batching, browser-parking, duplicate-output, failure-notice, orchestration, QA, and performance regression coverage with retained audit evidence.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.2.8.

## [1.2.7] - 2026-09-20

- Concurrent Revert: isolate captured executions in verified private views, preserve unrelated session and file contributions through Revert/Redo, durably recover interrupted mutations, and ship the pinned companion and native supervisor artifacts for both macOS release architectures.
- Session ownership: add immutable execution ledgers, ancestry-aware publication, conflict-safe projection for text, binary, rename, permission, and descendant changes, plus deterministic runtime, route, UI, and artifact-integrity coverage.
- Settings: render navigation, Home, Back, and compact content loading states synchronously while lazily loading feature sections and managed/full data boundaries across web and Electron.
- Supabase connection and tunnels: preserve authoritative connection failures in Settings, support secure local-owner enrollment, and add revocable, expiring Bot-only tunnel grants that fail closed around host capabilities and non-Bot routes.
- Cache efficiency: add provenance-aware usage observation and retained-journal reporting, bounded final-wire QA and serializer fixtures, and default-off experiment scaffolding without changing inference policy.
- Production Bot readiness: validate the existing Bot schema, RLS, SQL suites, repository consumers, encrypted files, private access, backup/restore, and ARM64 container path against disposable PostgreSQL/PostgREST and Supabase environments; retain local backend rollout as a separate future change.
- Release: build, verify, and stage architecture-specific Revert runtimes for both Electron and the published web package, and update all DevRyan package and desktop metadata to 1.2.7.

## [1.2.6] - 2026-09-19

- Managed orchestration: accept finite implementation-deadline renewals without treating them as task identity changes, preserve the latest deadline across stale events and snapshots, and allow renewed Designer and Fixer attempts to settle without remounting.
- Provider recovery: classify Grok personal-team spending-limit failures as usage exhaustion so managed backup recovery can proceed.
- Recovery bridge: retry one failed read-only scope transport or body read while keeping host rejections and mutating requests single-attempt and fail-closed.
- Chat: identify primary-recovery bridge transport failures as retryable local runtime errors instead of attributing them to the model provider.
- Parent recovery: collect a completed, user-recovered child after a proven parent transport failure, with durable admission fencing and an explicit manual fallback when automatic collection is unsafe.
- Session changes: single-flight summary reconciliation through bounded read pools, suppress unchanged invalid-history loops, and cancel abandoned reads without weakening mutation or revision guarantees.
- Runtime reliability: add bounded Electron memory/work diagnostics and crash-memory verification while keeping runtime-service startup ownership explicit.
- Desktop recovery: automatically reload an unexpectedly exited renderer once, bound repeated recovery attempts behind a native prompt, and keep View → Reload Window available without renderer IPC.
- Production Bot memory: include the versioned automatic-recovery migration for compatible failed and legacy extraction jobs.
- Quality: add deterministic orchestration-store, mounted UI, retry-policy, scheduler, and packaged recovery-plugin coverage for the renewed recovery paths.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.2.6.

## [1.2.5] - 2026-09-14

- OpenCode: update the managed host runtime, SDK, packaged plugin, provider-recovery compatibility, and QA target to 1.18.31 while retaining the independently pinned Production Bot runtime image.
- Managed orchestration: revalidate backup model configuration before recovery, bound unknown availability deferrals, and preserve deterministic retry and cancellation ownership.
- Cursor SDK: settle nested and unfinished tool projections conservatively, preserve partial output, and prevent late task events from reopening terminal tool states.
- Agent evaluation: accept consistent native exit metadata and runner-owned fixture directory prefixes while continuing to fail closed on missing or conflicting evidence.
- Quality: retain deterministic and isolated live coverage across OpenAI, xAI, Composer, and Fable Builder and Orchestrator paths, including recovery races and cleanup evidence.
- Database: verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.2.5.

## [1.2.4] - 2026-09-14

- Managed orchestration: surface first-attempt provider authentication failures as actionable Model Recovery, including failures restored from snapshots or reloads.
- Recovery safety: preserve terminal authentication failures and recovery controls when stale startup activity arrives afterward.
- Managed continuations: preserve the complete delegated assignment across recovery, model switches, turn-budget prompts, and retained project-history retrieval.
- Task reliability: renew active Fixer and Designer deadlines only from durable transcript progress, while fencing stale timers, shutdown, and persistence races.
- Question handling: remove confirmed replies immediately and prevent delayed bootstrap or reconnect snapshots from resurrecting answered questions.
- Cursor SDK: include a non-reversible credential identity in Agent cache keys so credential changes cannot reuse stale authenticated agents.
- Context retrieval: label shared search results as project-index context and explicitly prevent treating retrieved history as the current assignment.
- Quality: add deterministic store and mounted UI coverage for authentication recovery and retry acknowledgment.
- Release: update all DevRyan package and desktop metadata to 1.2.4.

## [1.2.3] - 2026-09-12

- Supabase connection: parse reconnect requests at the system route boundary, preserve the accepted connection state across overlapping status polls, and surface actionable server errors in Settings.
- Claude runtime: upgrade the managed Claude Code candidate to `2.1.251` for Claude Fable 5.1 compatibility while preserving the historical control tuple and explicit user overrides.
- Quality: add deterministic reconnect authorization, managed-runtime upgrade, stale-install repair, and compatibility-selection coverage.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.2.3.

## [1.2.2] - 2026-09-11

- Supabase connection: add a host-scoped administrator control for secure disconnect and reconnect, preserve local projects and preferences while offline, coordinate idle Electron/runtime restarts, expose bounded local traffic estimates, and reduce idle Telegram, principal, session, and Bot polling traffic.
- Harness configuration: replace stale project copies of standard roles with the maintained packaged definitions, preserve project-owned overrides and model choices, and record resolved runtime, role, catalog, and plugin-load fingerprints for diagnosis.
- Managed orchestration: add durable root-scoped wait-any collection, bounded dispatch briefs, compact result headers, authoritative required-check observation, and task/project context checkpoints with explicit retrieval and recovery contracts.
- Continuation safety: retain real-user objective identity, monotonic progress and recovery accounting, require current native TODO evidence for Builder continuation, and bound repeated deterministic input failures without replaying uncertain writes.
- Provider recovery and UI: strengthen shared failure classification, scheduled-recovery state, retry ownership, and managed-task presentation while keeping unresolved or ambiguous outcomes manual.
- Diagnostics and evaluation: add bounded sanitized trace export, retention and timing metadata, a deterministic 30-case golden catalog, paired evaluation support, and stricter admission/reporting for inconclusive measurements.
- Quality: expand orchestration, harness, web, UI, evaluation, performance-protocol, and responsive QA coverage; optional retrieval, wait-any, compact-result, and context-projection policies remain disabled pending complete native promotion gates.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.2.2.

## [1.2.1] - 2026-09-10

- Session changes: reconcile delayed and interrupted capture evidence, retain stronger exact receipts and native Cursor task diffs, and keep incomplete or conflicting changes unavailable for Undo while recoverable states remain retryable.
- Internal groundwork: add an unexported concurrent-revert mutation engine and disposable tests. Production Revert, Undo, and Redo retain their existing contracts; private execution isolation and conversation rollback integration are not enabled.
- Provider recovery: recognize verified OpenAI and Anthropic upstream-timeout envelopes, reconcile finalized assistant errors that arrive without a session error, keep unresolved tool outcomes manual, and extend isolated runtime conformance to OpenCode 1.18.30. Automatic Claude recovery remains disabled pending production transport and tool conformance.
- Context Mode: preserve indexed failure output, separate command crashes from indexing failures, isolate explicit Node heap limits, and add deterministic recovery coverage for execute, execute-file, and batch paths.
- Orchestration: hold parent autoresume while delegated children are active, deduplicate streamed subtask dispatches, and reset resume budgets only at real work-cycle boundaries.
- Managed orchestration: preserve write-once child progress across delayed snapshots and reconcile latest and recoverable child attempts deterministically without replacing unaffected state.
- Chat: suppress duplicate assistant headers for empty managed-task rows, promote the header to the first visible assistant row, and refine session-change recovery and provider-error presentation.
- Settings and tools: keep agent catalog and override responses scoped to their originating project, preserve unchanged catalog references, and hide generic Context Mode sandbox descriptions that do not explain the active operation.
- Quality: add focused package, runtime, native Cursor, web, Electron, and visual evidence for recovery, concurrent revert, assistant-row, and context-worker behavior.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.2.1.

## [1.2.0] - 2026-09-09

- Session changes: attribute files to exact execution receipts and verified descendants, exclude independent and external writes, preserve recorded edit segments, and keep conflict-safe Undo and Redo available only when evidence is complete.
- Production Bot memory: add versioned extraction diagnostics, automatic recovery for compatible failed and legacy jobs, conversation-aware deferral, manager-facing recovery detail, and a schema-gated migration with service-role-only control functions.
- Managed plugins: upgrade Oh My OpenCode Slim to 2.2.18, Open Cursor to 2.5.8, and GPT Image Generation to 0.1.12 while preserving user-owned models, prompts, permissions, MCP choices, and rollback compatibility.
- Image generation: default managed host and Bot image requests to GPT-6 Astra with medium reasoning through an exact-source, atomic compatibility patch.
- Runtime reliability: harden Context Mode worker liveness, timeouts, diagnostics, and recovery; retain reviewed Meridian compatibility; and improve tool-state placeholders, Bot questions, notifications, summarization, and Git-generated text handling.
- Quality: expand deterministic package, migration, receipt-attribution, plugin-upgrade, Context Mode, and responsive web/Electron visual coverage with retained audit evidence.
- Database: deploy and verify migration `20260908182901` and the matching Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.2.0.

## [1.1.16] - 2026-09-08

- Production Bots: simplify the catalog and conversation surfaces, add cached and validated custom avatars, consolidate computer status and controls, and keep catalog visibility and navigation authoritative across roles and lifecycle states.
- Bot runtime: harden admission, event replay, channel delivery, provider errors, and warm-runtime lease recovery while preserving scoped state and explicit terminal outcomes.
- Plans: stream actionable plan content progressively across Grok and Meridian, preserve plan identity through partial output, cancellation, reload, and continuation, and keep implementation controls tied to complete revisions.
- Session changes: split Git capture, snapshots, and durable storage into focused modules; preserve turn-scoped change summaries and diffs; and bound work for large repositories and histories.
- Provider QA: add deterministic Claude quota and cancellation fixtures, Meridian prefix and continuity coverage, native pointer verification, and expanded responsive Production Bot visual evidence.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.1.16.

## [1.1.15] - 2026-09-07

- Chat: preserve Markdown when copying messages, keep question context visible, narrow prompt-history subscriptions, and bound large tool-diff rendering with downloadable full patches.
- Session changes: keep incomplete, failed, loading, and undone summaries actionable after a session tree becomes idle, including a scoped Retry path for failed reads.
- Desktop and server: extract Electron settings, menus, notifications, harness-skill discovery, and HTTP compression into focused modules while preserving web/Electron contracts.
- Release pipeline: compile web assets once, overlap architecture-specific native preparation with Bot image builds, verify commit-bound artifact handoffs, and package installable web releases with their private runtime closure.
- Repository quality: strengthen scoped validation, documentation reference checks, release workflow tests, runtime/performance guidance, and retained visual/audit evidence.
- Dependencies and CI: align workspace dependency ownership and compatible package versions, keep established pins intact, and move applicable pull-request and macOS jobs to the supported Node runtime.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.1.15.

## [1.1.14] - 2026-09-07

- Managed orchestration: resolve dispatch cards to the latest same-child recovery attempt after earlier attempts are pruned, keeping current status, model, navigation, and retry controls authoritative across reloads; refine packaged guidance for small reversible frontend corrections discovered during verification.
- Plans: fold provider-recovery wakes into the originating human Plan revision so recovered plans persist as one complete actionable card without borrowing intent across later implementation or ordinary user turns.
- Session titles: summarize exact generated Explorer and Designer child placeholders from their task briefs, persist the result only when idle, and protect meaningful or manually renamed titles from late placeholder snapshots.
- Meridian continuity: settle complete passthrough tool boundaries through the reviewed SDK handoff path, with exact persisted-checkpoint verification for narrowly classified interrupt and max-turn exits and unchanged rejection behavior for incomplete, cancelled, or ambiguous runs.
- Model controls: replace the effort menu with one native-level thinking slider, support damped pointer detents and keyboard selection, keep Fast independent, and preserve explicit, default, queued, recovered, and historical thinking choices across provider hydration.
- Git safety: expose authoritative branch/detached/unborn and merge/rebase state, block remote actions from unsafe states, keep conflict and empty-commit decisions explicit, and make rebase continuation non-interactive without silently skipping work.
- Quality tooling: add deterministic web and Electron recovery-card acceptance, narrow-layout evidence, child-title coverage, thinking-control interaction and visual verification, Git rebase fixtures, and an isolated live Meridian continuity comparison.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.1.14.

## [1.1.13] - 2026-09-06

- Plans and drafts: restore authoritative Plan mode across delayed history, reloads, session switches, draft promotion, queued sends, and native compaction without letting maintenance turns or later approvals rewrite earlier execution policy.
- Managed orchestration: carry complete Plan instructions into automatic continuations, validate the actual parent authority with bounded history retrieval, preserve saved revisions, and keep maintenance output from creating actionable Plan cards or notifications.
- Model controls: preserve explicit agent, model, and effort choices through catalog hydration, delayed canonical parts, optimistic messages, failures, and session round trips; add an explicit Default effort choice on desktop and mobile.
- Chat presentation: persist reasoning disclosure choices, keep active empty reasoning visible without blank completed sections, improve mobile controls and session-row interactions, and preserve history anchors during pagination.
- Runtime compatibility: update the managed OpenCode runtime, SDK, packaged plugin, and provider recovery to 1.18.29; add scoped Meridian cancellation compatibility, managed Slim descriptor support, and Spark reasoning-summary compatibility.
- Performance: remove avoidable streaming-reducer and assistant-image scans, move automatic package-manager discovery off the event loop, isolate hot UI subscriptions, and keep the measured web startup graph within its existing bundle limits.
- Quality tooling: add reproducible web/Electron QA, performance protocols, source and package evidence checks, responsive visual coverage, and a reusable cleanup audit procedure.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.1.13.

## [1.1.12] - 2026-09-04

- Sessions: replace the changes footer with a full changed-files card, tree-scoped Undo controls, durable change summaries, and reliable queued send-now interruption.
- Plans and drafts: keep plan mode scoped to each draft, render implementation-plan turns without treating them as future plan sources, and preserve actionable plan revisions.
- Managed orchestration: group parallel dispatches into one card per wave, remove the sub-agent launch cap and memory-pressure hold, and clarify packaged agent deviation guidance.
- OpenCode storage: add database maintenance and Storage settings with process-liveness protection, strict path validation, and a quiet fallback when the SQLite driver is unavailable.
- Performance and diagnostics: strip diff patch bodies from live SSE traffic and add a session-pipeline profiler for tool, skill, and token usage across a session tree.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.1.12.

## [1.1.11] - 2026-09-04

- Sessions: add tree-scoped revert and redo with durable change summaries, an Undo footer, and consistent recovery across web and Electron.
- Managed orchestration: persist automatic resume plans for provider limits, add per-agent backup models, bound concurrent subagents under memory pressure, and improve continuation, task-status, and plan-deviation guidance.
- Processes and settings: add the Processes view with opt-in session attribution, automatic cleanup controls, and heavy-check slots; add a language-server switch for managed agent sessions.
- OpenCode: update the managed host runtime, SDK, packaged plugin, and verified provider-recovery compatibility to 1.18.27 while retaining the independently pinned Production Bot runtime image.
- Production Bots: refuse cross-installation runtime mutations, reduce idle sweep work, cache status reads, and lower managed OpenCode serve noise.
- Git and sessions: make generated pull-request titles and descriptions reliable, prefer derived session titles before one model upgrade, and remove automatic free-Zen rotation.
- Reliability: resolve branch previews before browser lease acquisition, interpret legacy short shell timeouts correctly, and keep the full lint/type-check contract green.
- Database: deploy and verify all repository migrations and the required Production Bots schema marker before release publication.
- Release: update all DevRyan package and desktop metadata to 1.1.11.

## [1.1.10] - 2026-09-02

- Bot startup: reuse warm runtimes between turns, bound concurrent cold starts, safely retry failures before execution, and distinguish runtime startup failures from provider errors.
- Bot memory: extract on the completed run's active runtime when available, defer to interactive conversations, repair malformed classifier responses, and report precise extraction failure reasons.
- Bot computer: preserve shared browser sessions across recovery, prevent agent-driven browser closure, and improve managed session restoration and timeout handling.
- Runtime diagnostics: show Docker memory warnings, preserve startup failure stages in Bot Audit, and support provider recovery on the pinned OpenCode 1.18.26 runtime.
- Database: add terminal failure-stage auditing and service-role-only inline memory extraction claims, advancing the required Bot schema marker to `20260903110000`; add a standalone migration workflow.
- Release: update all DevRyan package and desktop metadata to 1.1.10.

## [1.1.9] - 2026-09-02

- Production Bots: repair strict OpenCode structured memory/routine requests, expose terminal extraction diagnostics, and let Managers re-run all failed extractions sequentially.
- Bot computer: replace origin-only sign-in heuristics with privacy-masked navigation trails, sticky/decaying loop detection, handled dialogs, and a bounded popup target stack followed by screen viewing and input.
- Bot audit: aggregate successful human input once per control lease, omit heartbeat noise, log rejected gateway requests safely, align 30-day review controls, and display generalized resolution evidence.
- Retry safety: settle startup-race Stop requests as cancelled and preserve same-run retry after only settled, known-outcome read actions; add migration `20260902120000` for the matching transactional retry and audit-resolution rules.

- OpenCode: update the managed runtime, bundled SDK, packaged plugin, and Production Bots image to 1.18.26.
- Production Bots chat: add Bot-authored quick-reply questions, split tool acknowledgments from final answers, keep member drafts intact, and expose typing or “Needs you” status across channels.
- Bot reliability: recover lost pre-output reasoning sessions once, preserve queued-run wakeups, retry transient claims and terminal persistence, and periodically repair aged queues and expired leases.
- Attachments and computer: add bounded parallel uploads with HEIC conversion and image downscaling, fail blocked Shared copies visibly, simplify screen-first controls, and expose scoped Shared, workspace, or administrator container file views.
- Memory: select pinned people facts plus request-relevant context, retry optimistic extraction conflicts, isolate undecryptable rows, and let Managers re-run terminal extraction jobs.
- Retry safety: allow same-run retry only when durable evidence confirms no visible output, tool activity, or governed action, clearing stale execution identity before replay.
- Database: add service-role-only memory extraction requeue and evidence-based retry contracts, advancing the required Production Bots schema marker to `20260901230000`.
- Release: bump the DevRyan workspace, Electron, web, runtime packages, and legacy desktop metadata to 1.1.9.

## [1.1.8] - 2026-08-31

- Production Bots gained optional Telegram pairing and transport, speech settings, inline computer controls with human-control leases, editable Soul/Standing Role/Objectives, and branch previews with host-vaulted Cloudflare Access credentials.
- Reliability work covered cancellable session creation, OpenAI OAuth refresh coordination between host and Bots, provider recovery, Bot startup retries and recovery, a background runtime registered through an in-process `SMAppService` bridge, and the matching database migrations.

## [1.1.7] - 2026-08-26

- OpenCode: update the managed runtime, bundled SDK, packaged plugin, and Production Bots image to 1.18.25.
- Production Bots: give global administrators a restricted read-only computer-root browser while keeping other Managers scoped to the Bot workspace.
- Production Bots: add write-only Bot environment secrets backed by a host-encrypted vault and materialized only for newly admitted reasoning runs.
- Production Bots: add OAuth-only ChatGPT image generation with verified automatic encrypted-object publication and inline chat attachments independent of the Shared-folder copy.
- Production Bots: add a private, policy-gated Bot workspace with durable channels, queued runs, approvals, scoped browser actions, management views, and a focused Test Lab.
- Bot runtime: ship confined Docker services for scoped OpenCode execution, model-only egress, persistent reviewed-command Chromium, and disposable local retrieval with host-managed encryption and credentials.
- Bot knowledge and automation: add layered automatic memory, curated Library sources, private artifacts, structured local routines, continuous-channel access controls, and durable scheduling and recovery contracts.
- Recovery: add encrypted recovery exports, granular resumable cleanup, and full retired-Bot purge flows that preserve required audit history and shared-memory provenance.
- Database: add the service-role-only Supabase Production Bots control plane, forced RLS, immutable revision and audit protections, atomic queue and routine RPCs, and migration-gated runtime startup.
- Authentication: align managed-account password validation and hosted Auth policy synchronization with Supabase's supported six-character minimum.
- Release: publish signed multi-architecture Bot runtime images with SBOM/provenance attestations and a DevRyan-branded immutable manifest consumed by Electron release builds.
- Reliability: consolidate startup and session-state transitions, remove transient loading flashes, stabilize session titles and sidebar age updates, and strengthen Bot API failure reporting.
- Bot profiles and publishing: separate durable names, titles, summaries, and encrypted avatars from immutable revisions; add race-safe Save Draft and Publish Draft flows with structured readiness gates.
- Bot management: add live provider/model/thinking choices, ordered fallbacks, profile-first Details editing, clearer lifecycle boundaries, and shared Skills/MCP capability navigation across desktop and mobile.
- Database: migrate Bot profiles, private profile-image objects, schema readiness, and exact-version publish RPCs with optimistic concurrency and compatibility-safe activation behavior.
- Sessions: project generated titles immediately across web and Electron, persist them at provider-safe lifecycle points, and prevent delayed placeholder snapshots from erasing meaningful titles.
- Release: bump the DevRyan application and signed Production Bot runtime image set, workspace, Electron, web, runtime packages, and legacy desktop metadata to 1.1.7.

## [1.1.6] - 2026-08-20

- Chat: render completed assistant PNG, JPEG, GIF, and WebP references in one lazy responsive gallery, with secure message-scoped local-file authorization, bounded generated-file grants, and matching web/Electron parsing rules.
- Scheduling: claim due occurrences under a cross-process lock before execution, advance one-time and recurring schedules atomically, and retry terminal-state persistence to prevent duplicate runs across server processes and restarts.
- Sessions: preserve canonical message ordering through out-of-order updates, improve missing-directory recovery and project naming, and keep live completion, queued input, and window-title state aligned without broad render fanout.
- Providers: share OpenCode Go quota normalization across web, verify duplicate xAI tool aliases by matching catalog schemas before disabling them, and preserve JSONC configuration comments during runtime updates.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.21 and the packaged Claude Code runtime to 2.1.215.
- UI: refine overlay scrollbar behavior, image and activity presentation, project selectors, provider credentials, sidebar status, and the Grok waiting state with focused regression coverage.
- Runtime parity: harden filesystem, Git, proxy keepalive, configuration, quota, and image-asset contracts across web and Electron.
- Sessions: never name a session after the prompt that started it — titles are now persisted only from a real model-generated summary, title summarization retries transient provider failures and falls back to a second free model before giving up, and the UI treats placeholder or generated titles as untitled until that summary exists.
- Startup: bound OpenCode user-plugin installs with a timeout and degrade a failed install to a warning instead of aborting boot, and surface bootstrap progress on the Electron startup splash instead of a bare logo.
- Providers: warm the xAI tool-catalog dedupe overrides on a cold start under a dedicated timeout so the first Grok prompt no longer ships the duplicated MCP tool catalog, and render provisional parts for buffered streaming deltas using durable part-type hints.
- Chat: keep the provider waiting state from overriding the normal status ladder once a turn has streamed any activity, and detect plan-card sentinels that models emit with backticks or internal spaces so structured plans still render as plan cards.
- Release: bump DevRyan workspace, Electron, web, shared runtimes, and legacy desktop metadata to 1.1.6.

## [1.1.5] - 2026-08-19

- Sessions: add adaptive first-page history loading, stale-while-revalidate snapshots, bounded intent prefetch, focused session subscriptions, and opt-in first-visible performance metrics across web and Electron.
- Chat: throttle only visible streaming Markdown projections, preserve canonical transcript state, pause presentation animations while hidden or reduced-motion, and reduce status, skeleton, and sidebar render work.
- Orchestration: classify structured provider usage limits, coalesce matching status reads, and expose paged references for large managed-task results with scoped, parity-tested web contracts.
- Desktop: warn on quit only for active tunnels, running work, or future pending schedules; fail closed when background risk cannot be verified; and keep Electron and legacy Tauri behavior aligned.
- Performance: add a deterministic Electron resource benchmark with loopback streaming fixtures, Chromium traces, memory sampling, and baseline acceptance gates.
- Release: bump DevRyan workspace, Electron, web, runtime packages, and legacy desktop metadata to 1.1.5.

## [1.1.4] - 2026-08-18

- Harness: enforce four-minute shell defaults with a one-hour ceiling, persist privacy-bounded exact-call deadlines, and reconcile overdue commands safely across web and Electron without replaying them.
- Orchestration: resolve managed-dispatch assistant and parent messages directly by ID so Oracle and Fixer launches remain reliable in long turns while preserving fail-closed policy checks.
- Bug reports: classify confirmed browser-target, web-fetch 404, and discovery-buffer outcomes as expected, with a forensic-preserving Supabase backfill.

- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.18 across web, UI, and the workspace lockfile.
- UI: remove the Work status control and its live-operations context panel.
- Orchestration: add bounded same-child recovery for terminal provider transport failures, preserve resumable timed-out work, and expose explicit recovery actions consistently across web and Electron.
- Configuration: add a shared, revisioned apply coordinator for agents, providers, commands, skills, MCP, behavior, and runtime settings, with authoritative idle checks, retryable failures, administrator-authorized force apply, and web parity.
- Quota: unify z.ai, Kimi, Codex, xAI, and DeepSeek adapters across web; add xAI OAuth refresh and DeepSeek balance reporting; and improve value-only usage presentation.
- Worktrees: run effective Git `post-checkout` hooks during new worktree bootstrap with bounded output, durable receipts, explicit retry behavior, and cross-runtime Git support.
- Skills: harden ClawdHub archive installation with bounded streaming, metadata preflight, staged extraction, transactional replacement, stable rejection codes, and shared web enforcement.
- Chat: add selection-to-composer Markdown handling, stabilize tool-output scrolling and terminal transcript rendering, and improve duration/status timing without broad render fanout.
- UI: add a focused Work panel and status control, refine settings and provider navigation, and preserve configuration-apply state through managed runtime transitions.
- Runtime: introduce `@openchamber/shared-runtime`, update `adm-zip` to 0.6.0, and keep web and Electron contracts aligned.
- Release: bump DevRyan workspace, Electron, web, shared runtime, and legacy desktop metadata to 1.1.4.

## [1.1.3] - 2026-08-11

- Bug reports: add managed-user submissions, administrator review and status controls, sanitized error-log views, service-only Supabase storage, and database policy coverage.
- Shared hosting: project content-free session, tool, and managed-task failures into the administrator activity feed with bounded context and diagnostic sanitization.
- Analytics: retain bounded, sanitized copied text for administrator-only user analytics with preview and on-demand detail views.
- Diagnostics: harden journal export and sanitization behavior across web and Electron runtimes; classify managed runtime failures by impact and failure class; correlate recovery outcomes; and retain administrator clear controls.
- Managed Remote: use direct Supabase-backed account login instead of tunnel bootstrap tokens, and expose clearer readiness and account-configuration states.
- Sessions: preserve exact JSON request bodies through the OpenCode proxy, mark transient session creation and prompt transport failures as retryable, restore submitted attachments safely after failures, and present pending questions directly in the composer.
- Settings: add Bug Reports navigation and permissions, refine managed settings access, improve authentication recovery and tunnel status presentation, and add searchable hierarchical Skills navigation.
- Agents: refine packaged designer, fixer, and orchestrator guidance, including deterministic design-task routing and tool-recovery coverage.
- OpenCode: update the bundled SDK dependency and managed runtime target through 1.18.16 across web, UI, and the workspace lockfile.
- Release: bump DevRyan workspace, Electron, web, and legacy desktop metadata to 1.1.3.

## [1.1.2] - 2026-08-05

- Shared hosting: allow capability-gated Browser runtime mutations for authenticated users while keeping host Browser configuration restricted to administrators.
- Analytics: show the newest activity day first in the scrollable ribbon while preserving chronological chart ordering.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.14 across web, UI, and the workspace lockfile.
- Release: bump DevRyan workspace, Electron, web, and legacy desktop metadata to 1.1.2.

## [1.1.1] - 2026-08-05

- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.13 across web, UI, and the workspace lockfile.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.12 across web, UI, and the workspace lockfile.
- Shared hosting: let administrators reassign managed GitHub accounts safely, with database migration coverage and authenticated runtime enforcement.
- Shared hosting: add a Supabase-backed multi-user control plane with opaque app sessions, role and user policies, managed project and branch assignments, session ownership, live revocation, and administrator user management.
- Security: enforce CSRF protection, host-path opacity, owner-filtered HTTP/SSE/WebSocket/terminal access, encrypted token storage, scoped notifications and previews, and content-safe actor audit records across managed hosts.
- Desktop browser: move Electron browsing into native managed surfaces that preserve one live page between inline, pop-out, and parked states, with navigation, DevTools, element inspection, and agent cursor support.
- Git and GitHub: scope credentials, accounts, repositories, remotes, branches, worktrees, and mutations to the active managed assignment while preserving unrestricted local-admin behavior.
- UI and reliability: harden browser storage access, authentication bootstrap, settings navigation, lazy view loading, session chrome, and streamed reasoning presentation across web and Electron.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.11 across web, UI, and the workspace lockfile.

## [1.1.0] - 2026-07-29

- Harness: add durable worktree operation receipts, diagnostic journals, lifecycle correlation, and optional turn-evidence capture across web and Electron.
- Worktrees: make creation resumable and idempotent, expose bootstrap progress and failure recovery, and support source-repository selection with safer cross-runtime Git behavior.
- Agents: bundle DevRyan-managed Superpowers integration, tighten managed plugin policy, and preserve agent and skill behavior across packaged runtimes.
- Reliability: classify transient provider transport failures for bounded recovery while keeping authentication, model, certificate, cancellation, and user-action failures explicit.
- UI: add turn-evidence controls and transcript access, improve plugin and settings presentation, and surface updater repository diagnostics.
- Release: point Electron updates at `1H-Team/DevRyan`, include the harness runtime in validation and packaging, and require DevRyan-branded public assets.

## [1.0.12] - 2026-07-26

- Orchestration: recover provider-limited managed subtasks even when the original parent tool wait detaches, using durable retry lineage and a restart-safe one-shot parent continuation.
- Orchestration: continue a managed subtask once in the same child after a terminal model timeout, with idempotent cross-runtime delivery and restart-safe bounded recovery.
- Chat: keep recovered child activity, model recovery controls, and primary-session state synchronized through retry-in-place completion without duplicate wakes or stale working indicators.
- Runtime parity: expose provider-recovery continuations across web/Electron bridges, with packaged-agent guidance and focused scheduler, plugin, store, sync, and sidebar regression coverage.

## [1.0.11] - 2026-07-20

- Sessions: add mobile swipe actions for pinning and archiving, and stabilize sidebar indicator and row layout.
- Context usage: show every related subagent session and use title-cased section headings in the token details window.
- Orchestration: require manual model recovery for provider usage, session, quota, and rate-limit failures, while preserving canonical child sessions and explicit retry-in-place selections across web.
- Reliability: keep managed tasks active through transient runtime port transitions and retry restart reconciliation under the original lease and deadline.
- Sessions: align managed-task, plan, and sidebar lifecycle indicators so user-recoverable failures remain visible and settled plans clear consistently.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.4 across web, UI, and the workspace lockfile.

## [1.0.10] - 2026-07-15

- Sessions: harden deletion cleanup, reconnect recovery, sidebar hydration, optimistic reconciliation, and queued-message delivery across web runtimes.
- Orchestration: strengthen managed task launch ownership, lease recovery, pending-start cleanup, and result payload projection.
- OpenCode: deduplicate managed runtime plugin registration, preserve legacy plugin discovery, and bound stalled OpenAI response-header retries.

## [1.0.9] - 2026-07-13

- Sessions: show the active session's net diff summary in the header.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.17.19 across web, UI, and the workspace lockfile.

## [1.0.8] - 2026-07-11

- Sync: stop deterministic unavailable-model retry loops after the first provider model-resolution failure, surface the error once, and keep transient provider retries such as rate limits on the normal OpenCode path.
- Docs: add reliability audit and stabilization planning notes for the next DevRyan hardening pass.
- Release: keep managed orchestration runtime metadata covered by version bumping and release-tag verification.
- Release: run hosted asset packaging on Node.js 22 to keep native dependency installation compatible with current GitHub runners.

## [1.0.7] - 2026-07-10

- Release: bump DevRyan workspace, Electron, web, and legacy desktop metadata to 1.0.7.
- OpenCode: update the bundled SDK dependency to 1.17.18 across web, UI, and the workspace lockfile.
- Desktop: hide desktop edge chrome action clusters while settings are open, preserving the draggable titlebar filler.

## [1.0.6] - 2026-07-07

- OpenCode: update the bundled SDK and managed runtime target to 1.17.14, launch managed servers in pure mode, and filter ambient plugins/MCP servers from the managed runtime surface.
- Quota: add OpenCode Go usage reporting, surface Codex reset credits, and keep web quota providers aligned.
- Git: add a finish-current-branch flow that can stash local changes, merge into `main`, delete the source branch, and restore the stash.
- UI: extract the header usage panel into focused components, preserve exact user prompt text rendering, refine settings/back navigation, and smooth empty sidebar group states.
- Sessions: tighten live working-state detection when a prior assistant/tool turn is still streaming behind a trailing assistant shell.

## [1.0.5] - 2026-07-05

- Providers: add GitHub Copilot as a normalized provider option, including `copilot` alias handling, auth/config lookup parity, and removal cleanup across provider storage locations.
- Git: generate commit messages directly into the commit input, preserving selected-file safety checks and optional user guidance without starting a separate chat session.
- Sessions: tighten live working-state detection around tool-call finishes, in-flight tool parts, settled plan turns, and sidebar ordering so completed sessions stop appearing active.
- UI: skip hidden models when cycling favorites, add archived-session quick delete, remove the PWA install prompt surface, and allow builder agents to ask structured questions when blocked.

## [1.0.4] - 2026-07-02

- Release: bump DevRyan workspace, Electron, web, and legacy desktop metadata to 1.0.4.
- OpenCode: update the bundled SDK dependency to 1.17.13 across web, UI, and the workspace lockfile.

## [1.0.3] - 2026-07-02

- Event stream: add a replayable global SSE endpoint and route synthetic UI events through the global hub so reconnecting clients can recover missed message updates.
- OpenCode: ignore synthetic global events in the watcher path to prevent locally published updates from triggering duplicate upstream handling.
- Chat: keep assistant status and streaming indicators attached to the latest assistant turn with renderable context instead of empty trailing assistant shells.
- Sessions: smooth sidebar collapse and archive animations with grid-track row transitions and rotating disclosure chevrons.

## [1.0.2] - 2026-07-01

- OpenCode: update the bundled SDK dependency to 1.17.12 across web, UI, and the workspace lockfile.
- Desktop: keep Electron directory and file permission requests on the OpenCode approval path while preserving native picker behavior for legacy Tauri installs.
- Chat: prevent stale completion indicators from appearing after a session starts working again, and settle stale busy/retry status only after terminal assistant turns.
- Permissions: improve auto-accept and external-directory permission handling for child sessions and resync flows with focused regression coverage.

## [1.0.1] - 2026-06-27

- OpenCode Slim: add Slim install/config helpers, managed plugin defaults, and runtime lifecycle integration so Slim-managed agents and overlays are available consistently.
- Agents: improve runtime agent overlay generation, harness preflight checks, and settings helper coverage for managed OpenCode configurations.
- Plugins: expand plugin settings state, persistence, and UI controls for installed plugin handling.
- Chat: refine retry visibility, assistant status handling, and plan lifecycle behavior with focused regression coverage.
- Model settings: strengthen model preference autosave, synchronization, hidden-model persistence, and queued-send behavior across UI state stores.

## [1.0.0] - 2026-06-27

- Release baseline: reset DevRyan versioning and release history so the current repository state is published as the new v1.0.0 starting point.
