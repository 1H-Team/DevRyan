# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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

- OpenCode: update the managed runtime, bundled SDK, packaged plugin, VS Code recommendation, and Production Bots image to 1.18.26.
- Production Bots chat: add Bot-authored quick-reply questions, split tool acknowledgments from final answers, keep member drafts intact, and expose typing or “Needs you” status across channels.
- Bot reliability: recover lost pre-output reasoning sessions once, preserve queued-run wakeups, retry transient claims and terminal persistence, and periodically repair aged queues and expired leases.
- Attachments and computer: add bounded parallel uploads with HEIC conversion and image downscaling, fail blocked Shared copies visibly, simplify screen-first controls, and expose scoped Shared, workspace, or administrator container file views.
- Memory: select pinned people facts plus request-relevant context, retry optimistic extraction conflicts, isolate undecryptable rows, and let Managers re-run terminal extraction jobs.
- Retry safety: allow same-run retry only when durable evidence confirms no visible output, tool activity, or governed action, clearing stale execution identity before replay.
- Database: add service-role-only memory extraction requeue and evidence-based retry contracts, advancing the required Production Bots schema marker to `20260901230000`.
- Release: bump the DevRyan workspace, Electron, VS Code, web, runtime packages, and legacy desktop metadata to 1.1.9.


## [1.1.8] - 2026-08-31

- Sessions: keep draft creation in one cancellable, bounded attempt, preserve captured input through delayed acknowledgements, and show immediate progress without automatically replaying ambiguous failures.
- Runtime performance: isolate compatible Context Mode execution in bounded, project-scoped workers so indexing does not block session creation.
- OpenAI OAuth: coordinate managed host and Bot token refresh, bind Bot credentials to the intended host account, and surface explicit reconnection or runtime-update requirements without replaying accepted prompts.
- Production Bots: add optional Telegram pairing and transport, speech settings, inline computer controls, and persistent composer drafts while keeping transport credentials private to the host.
- Bot reliability: add safe startup retries, clearer failure diagnostics, bounded shared-file and transcript loading, and deterministic held-input cleanup when human control ends.
- Provider recovery: coordinate stalled primary-provider recovery in the host runtime across web, Electron, and VS Code.
- UI performance: isolate live Bot activity and defer unused sidebar panels, preserving message identity and reducing unnecessary chat renders.
- Database: add retained-ledger Bot Audit clearing, transactional safe-run retry with required schema marker `20260830210000`, and optional service-role-only Telegram transport tables and RPCs.

- Bot recovery: serialize channel-summary commits, rebase bounded revision-conflict retries, and keep asynchronous memory extraction failures separate from completed run outcomes.
- Bot computer: persist human-control waits, resume the same action attempt after control returns, and improve browser diagnostics, display handling, and managed browser policy enforcement.
- Bot images: expose the dedicated image tool to eligible OAuth primary agents and preserve encrypted assistant attachments independently of optional Shared-folder publication.
- Session deletion: improve partial-failure feedback and idempotent recovery while enforcing current ownership grants and analytics retention.
- Database: add durable `waiting_control` states and advance the required Bot schema marker to `20260830150000`, preserving active computer-scope exclusivity and service-role-only RPC access.
- Production Bots chat: admit one pending assistant response atomically with each user message, let simple conversations answer directly, and promote only a request-specific, Soul-authored pre-tool sentence into a durable acknowledgment before the natural final answer.
- Bot computer: replace the passive MJPEG image viewer with bounded canvas decoding and Operator-only pointer, keyboard, text, paste, and wheel control tied to the active human-control lease; coalesce continuous input and remove container inspection and audit delivery from the click-response hot path without retaining frames or input content.
- Runtime safety: keep warm-run credentials provisional until admission, clean every staged secret and capability on lease teardown, and harden model credential selection, fallback, and response sanitization around failed or empty runs.
- Chat questions: support multiline custom answers with stable keyboard navigation and responsive editor actions across desktop and mobile.
- Database: atomically persist the Bot's pending assistant response through a service-role-only, security-invoker RPC and advance the required Bot schema marker to `20260829130000`.
- Branch previews: let administrators configure an HTTPS preview per user, project, and branch, keep Cloudflare Access credentials in the host-encrypted vault, and inject them only into the matching Electron browser lease.
- Browser security: resolve managed preview ownership authoritatively, isolate preview partitions by owner and origin, and preserve exact branch scope across browser discovery and lease creation.
- Production Bots: expose Soul/personality, Standing Role, and Objectives in the Overview editor, preserve draft identity edits across tabs, and publish changes only to future runs through immutable revision activation.
- Background runtime: replace the detached macOS service-control helper with an in-process N-API `SMAppService` bridge, automate safe first-launch registration, and strengthen ownership recovery and packaged-artifact verification.
- Release packaging: strengthen macOS runtime-service and archive verification while permanently preserving the established unsigned artifact path with signing and notarization disabled in CI.
- Database: add the forced-RLS, service-role-only branch preview metadata migration with cascading cleanup and opaque host-vault references.
- Release: bump the DevRyan workspace, Electron, VS Code, web, runtime packages, and legacy desktop metadata to 1.1.8.

## [1.1.7] - 2026-08-26

- OpenCode: update the managed runtime, bundled SDK, packaged plugin, VS Code recommendation, and Production Bots image to 1.18.25.
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
- Sessions: project generated titles immediately across web, Electron, and VS Code, persist them at provider-safe lifecycle points, and prevent delayed placeholder snapshots from erasing meaningful titles.
- Release: bump the DevRyan application and signed Production Bot runtime image set, workspace, Electron, VS Code, web, runtime packages, and legacy desktop metadata to 1.1.7.

## [1.1.6] - 2026-08-20

- Chat: render completed assistant PNG, JPEG, GIF, and WebP references in one lazy responsive gallery, with secure message-scoped local-file authorization, bounded generated-file grants, and matching web/Electron/VS Code parsing rules.
- Scheduling: claim due occurrences under a cross-process lock before execution, advance one-time and recurring schedules atomically, and retry terminal-state persistence to prevent duplicate runs across server processes and restarts.
- Sessions: preserve canonical message ordering through out-of-order updates, improve missing-directory recovery and project naming, and keep live completion, queued input, and window-title state aligned without broad render fanout.
- Providers: share OpenCode Go quota normalization across web and VS Code, verify duplicate xAI tool aliases by matching catalog schemas before disabling them, and preserve JSONC configuration comments during runtime updates.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.21 and the packaged Claude Code runtime to 2.1.215.
- UI: refine overlay scrollbar behavior, image and activity presentation, project selectors, provider credentials, sidebar status, and the Grok waiting state with focused regression coverage.
- Runtime parity: harden filesystem, Git, proxy keepalive, configuration, quota, and image-asset contracts across web, Electron, and VS Code.
- Sessions: never name a session after the prompt that started it — titles are now persisted only from a real model-generated summary, title summarization retries transient provider failures and falls back to a second free model before giving up, and the UI treats placeholder or generated titles as untitled until that summary exists.
- Startup: bound OpenCode user-plugin installs with a timeout and degrade a failed install to a warning instead of aborting boot, and surface bootstrap progress on the Electron startup splash instead of a bare logo.
- Providers: warm the xAI tool-catalog dedupe overrides on a cold start under a dedicated timeout so the first Grok prompt no longer ships the duplicated MCP tool catalog, and render provisional parts for buffered streaming deltas using durable part-type hints.
- Chat: keep the provider waiting state from overriding the normal status ladder once a turn has streamed any activity, and detect plan-card sentinels that models emit with backticks or internal spaces so structured plans still render as plan cards.
- Release: bump DevRyan workspace, Electron, VS Code, web, shared runtimes, and legacy desktop metadata to 1.1.6.

## [1.1.5] - 2026-08-19

- Sessions: add adaptive first-page history loading, stale-while-revalidate snapshots, bounded intent prefetch, focused session subscriptions, and opt-in first-visible performance metrics across web, Electron, and VS Code.
- Chat: throttle only visible streaming Markdown projections, preserve canonical transcript state, pause presentation animations while hidden or reduced-motion, and reduce status, skeleton, and sidebar render work.
- Orchestration: classify structured provider usage limits, coalesce matching status reads, and expose paged references for large managed-task results with scoped, parity-tested web and VS Code contracts.
- Desktop: warn on quit only for active tunnels, running work, or future pending schedules; fail closed when background risk cannot be verified; and keep Electron and legacy Tauri behavior aligned.
- Performance: add a deterministic Electron resource benchmark with loopback streaming fixtures, Chromium traces, memory sampling, and baseline acceptance gates.
- Release: bump DevRyan workspace, Electron, VS Code, web, runtime packages, and legacy desktop metadata to 1.1.5.

## [1.1.4] - 2026-08-18

- Harness: enforce four-minute shell defaults with a one-hour ceiling, persist privacy-bounded exact-call deadlines, and reconcile overdue commands safely across web, Electron, and VS Code without replaying them.
- Orchestration: resolve managed-dispatch assistant and parent messages directly by ID so Oracle and Fixer launches remain reliable in long turns while preserving fail-closed policy checks.
- Bug reports: classify confirmed browser-target, web-fetch 404, and discovery-buffer outcomes as expected, with a forensic-preserving Supabase backfill.

- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.18 across web, UI, VS Code, and the workspace lockfile.
- UI: remove the Work status control and its live-operations context panel.
- Orchestration: add bounded same-child recovery for terminal provider transport failures, preserve resumable timed-out work, and expose explicit recovery actions consistently across web, Electron, and VS Code.
- Configuration: add a shared, revisioned apply coordinator for agents, providers, commands, skills, MCP, behavior, and runtime settings, with authoritative idle checks, retryable failures, administrator-authorized force apply, and web/VS Code parity.
- Quota: unify z.ai, Kimi, Codex, xAI, and DeepSeek adapters across web and VS Code; add xAI OAuth refresh and DeepSeek balance reporting; and improve value-only usage presentation.
- Worktrees: run effective Git `post-checkout` hooks during new worktree bootstrap with bounded output, durable receipts, explicit retry behavior, and cross-runtime Git support.
- Skills: harden ClawdHub archive installation with bounded streaming, metadata preflight, staged extraction, transactional replacement, stable rejection codes, and shared web/VS Code enforcement.
- Chat: add selection-to-composer Markdown handling, stabilize tool-output scrolling and terminal transcript rendering, and improve duration/status timing without broad render fanout.
- UI: add a focused Work panel and status control, refine settings and provider navigation, and preserve configuration-apply state through managed runtime transitions.
- Runtime: introduce `@openchamber/shared-runtime`, update `adm-zip` to 0.6.0, and keep web, Electron, and VS Code contracts aligned.
- Release: bump DevRyan workspace, Electron, VS Code, web, shared runtime, and legacy desktop metadata to 1.1.4.

## [1.1.3] - 2026-08-11

- Bug reports: add managed-user submissions, administrator review and status controls, sanitized error-log views, service-only Supabase storage, and database policy coverage.
- Shared hosting: project content-free session, tool, and managed-task failures into the administrator activity feed with bounded context and diagnostic sanitization.
- Analytics: retain bounded, sanitized copied text for administrator-only user analytics with preview and on-demand detail views.
- Diagnostics: harden journal export and sanitization behavior across web, Electron, and VS Code runtimes; classify managed runtime failures by impact and failure class; correlate recovery outcomes; and retain administrator clear controls.
- Managed Remote: use direct Supabase-backed account login instead of tunnel bootstrap tokens, and expose clearer readiness and account-configuration states.
- Sessions: preserve exact JSON request bodies through the OpenCode proxy, mark transient session creation and prompt transport failures as retryable, restore submitted attachments safely after failures, and present pending questions directly in the composer.
- Settings: add Bug Reports navigation and permissions, refine managed settings access, improve authentication recovery and tunnel status presentation, and add searchable hierarchical Skills navigation.
- Agents: refine packaged designer, fixer, and orchestrator guidance, including deterministic design-task routing and tool-recovery coverage.
- OpenCode: update the bundled SDK dependency and managed runtime target through 1.18.16 across web, UI, VS Code, and the workspace lockfile.
- Release: bump DevRyan workspace, Electron, VS Code, web, and legacy desktop metadata to 1.1.3.

## [1.1.2] - 2026-08-05

- Shared hosting: allow capability-gated Browser runtime mutations for authenticated users while keeping host Browser configuration restricted to administrators.
- Analytics: show the newest activity day first in the scrollable ribbon while preserving chronological chart ordering.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.14 across web, UI, VS Code, and the workspace lockfile.
- Release: bump DevRyan workspace, Electron, VS Code, web, and legacy desktop metadata to 1.1.2.

## [1.1.1] - 2026-08-05

- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.13 across web, UI, VS Code, and the workspace lockfile.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.12 across web, UI, VS Code, and the workspace lockfile.
- Shared hosting: let administrators reassign managed GitHub accounts safely, with database migration coverage and authenticated runtime enforcement.
- Shared hosting: add a Supabase-backed multi-user control plane with opaque app sessions, role and user policies, managed project and branch assignments, session ownership, live revocation, and administrator user management.
- Security: enforce CSRF protection, host-path opacity, owner-filtered HTTP/SSE/WebSocket/terminal access, encrypted token storage, scoped notifications and previews, and content-safe actor audit records across managed hosts.
- Desktop browser: move Electron browsing into native managed surfaces that preserve one live page between inline, pop-out, and parked states, with navigation, DevTools, element inspection, and agent cursor support.
- Git and GitHub: scope credentials, accounts, repositories, remotes, branches, worktrees, and mutations to the active managed assignment while preserving unrestricted local-admin behavior.
- UI and reliability: harden browser storage access, authentication bootstrap, settings navigation, lazy view loading, session chrome, and streamed reasoning presentation across web, Electron, and VS Code.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.11 across web, UI, VS Code, and the workspace lockfile.

## [1.1.0] - 2026-07-29

- Harness: add durable worktree operation receipts, diagnostic journals, lifecycle correlation, and optional turn-evidence capture across web, Electron, and VS Code.
- Worktrees: make creation resumable and idempotent, expose bootstrap progress and failure recovery, and support source-repository selection with safer cross-runtime Git behavior.
- Agents: bundle DevRyan-managed Superpowers integration, tighten managed plugin policy, and preserve agent and skill behavior across packaged runtimes.
- Reliability: classify transient provider transport failures for bounded recovery while keeping authentication, model, certificate, cancellation, and user-action failures explicit.
- UI: add turn-evidence controls and transcript access, improve plugin and settings presentation, and surface updater repository diagnostics.
- Release: point Electron updates at `1H-Team/DevRyan`, include the harness runtime in validation and packaging, and require DevRyan-branded public assets.

## [1.0.12] - 2026-07-26

- Orchestration: recover provider-limited managed subtasks even when the original parent tool wait detaches, using durable retry lineage and a restart-safe one-shot parent continuation.
- Orchestration: continue a managed subtask once in the same child after a terminal model timeout, with idempotent cross-runtime delivery and restart-safe bounded recovery.
- Chat: keep recovered child activity, model recovery controls, and primary-session state synchronized through retry-in-place completion without duplicate wakes or stale working indicators.
- Runtime parity: expose provider-recovery continuations across web/Electron and VS Code bridges, with packaged-agent guidance and focused scheduler, plugin, store, sync, and sidebar regression coverage.

## [1.0.11] - 2026-07-20

- Sessions: add mobile swipe actions for pinning and archiving, and stabilize sidebar indicator and row layout.
- Context usage: show every related subagent session and use title-cased section headings in the token details window.
- Orchestration: require manual model recovery for provider usage, session, quota, and rate-limit failures, while preserving canonical child sessions and explicit retry-in-place selections across web and VS Code.
- Reliability: keep managed tasks active through transient runtime port transitions and retry restart reconciliation under the original lease and deadline.
- Sessions: align managed-task, plan, and sidebar lifecycle indicators so user-recoverable failures remain visible and settled plans clear consistently.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.18.4 across web, UI, VS Code, and the workspace lockfile.

## [1.0.10] - 2026-07-15

- Sessions: harden deletion cleanup, reconnect recovery, sidebar hydration, optimistic reconciliation, and queued-message delivery across web and VS Code runtimes.
- Orchestration: strengthen managed task launch ownership, lease recovery, pending-start cleanup, and result payload projection.
- OpenCode: deduplicate managed runtime plugin registration, preserve legacy plugin discovery, and bound stalled OpenAI response-header retries.

## [1.0.9] - 2026-07-13

- Sessions: show the active session's net diff summary in the header.
- OpenCode: update the bundled SDK dependency and managed runtime target to 1.17.19 across web, UI, VS Code, and the workspace lockfile.

## [1.0.8] - 2026-07-11

- Sync: stop deterministic unavailable-model retry loops after the first provider model-resolution failure, surface the error once, and keep transient provider retries such as rate limits on the normal OpenCode path.
- Docs: add reliability audit and stabilization planning notes for the next DevRyan hardening pass.
- Release: keep managed orchestration runtime metadata covered by version bumping and release-tag verification.
- Release: run hosted asset packaging on Node.js 22 to keep native dependency installation compatible with current GitHub runners.

## [1.0.7] - 2026-07-10

- Release: bump DevRyan workspace, Electron, VS Code, web, and legacy desktop metadata to 1.0.7.
- OpenCode: update the bundled SDK dependency to 1.17.18 across web, UI, VS Code, and the workspace lockfile.
- Desktop: hide desktop edge chrome action clusters while settings are open, preserving the draggable titlebar filler.

## [1.0.6] - 2026-07-07

- OpenCode: update the bundled SDK and managed runtime target to 1.17.14, launch managed servers in pure mode, and filter ambient plugins/MCP servers from the managed runtime surface.
- Quota: add OpenCode Go usage reporting, surface Codex reset credits, and keep web and VS Code quota providers aligned.
- Git: add a finish-current-branch flow that can stash local changes, merge into `main`, delete the source branch, and restore the stash.
- UI: extract the header usage panel into focused components, preserve exact user prompt text rendering, refine settings/back navigation, and smooth empty sidebar group states.
- Sessions: tighten live working-state detection when a prior assistant/tool turn is still streaming behind a trailing assistant shell.

## [1.0.5] - 2026-07-05

- Providers: add GitHub Copilot as a normalized provider option, including `copilot` alias handling, auth/config lookup parity, and removal cleanup across provider storage locations.
- Git: generate commit messages directly into the commit input, preserving selected-file safety checks and optional user guidance without starting a separate chat session.
- Sessions: tighten live working-state detection around tool-call finishes, in-flight tool parts, settled plan turns, and sidebar ordering so completed sessions stop appearing active.
- UI: skip hidden models when cycling favorites, add archived-session quick delete, remove the PWA install prompt surface, and allow builder agents to ask structured questions when blocked.

## [1.0.4] - 2026-07-02

- Release: bump DevRyan workspace, Electron, VS Code, web, and legacy desktop metadata to 1.0.4.
- OpenCode: update the bundled SDK dependency to 1.17.13 across web, UI, VS Code, and the workspace lockfile.

## [1.0.3] - 2026-07-02

- Event stream: add a replayable global SSE endpoint and route synthetic UI events through the global hub so reconnecting clients can recover missed message updates.
- OpenCode: ignore synthetic global events in the watcher path to prevent locally published updates from triggering duplicate upstream handling.
- Chat: keep assistant status and streaming indicators attached to the latest assistant turn with renderable context instead of empty trailing assistant shells.
- Sessions: smooth sidebar collapse and archive animations with grid-track row transitions and rotating disclosure chevrons.

## [1.0.2] - 2026-07-01

- OpenCode: update the bundled SDK dependency to 1.17.12 across web, UI, VS Code, and the workspace lockfile.
- Desktop: keep Electron directory and file permission requests on the OpenCode approval path while preserving native picker behavior for legacy Tauri installs.
- Chat: prevent stale completion indicators from appearing after a session starts working again, and settle stale busy/retry status only after terminal assistant turns.
- Permissions: improve auto-accept and external-directory permission handling for child sessions and resync flows with focused regression coverage.

## [1.0.1] - 2026-06-27

- OpenCode Slim: add Slim install/config helpers, managed plugin defaults, and runtime lifecycle integration so Slim-managed agents and overlays are available consistently.
- Agents: improve runtime agent overlay generation, harness preflight checks, and settings helper coverage for managed OpenCode configurations.
- Plugins: expand plugin settings state, persistence, and UI controls for installed plugin handling.
- Chat: refine retry visibility, assistant status handling, and plan lifecycle behavior with focused regression coverage.
- Model settings: strengthen model preference autosave, synchronization, hidden-model persistence, and queued-send behavior across UI state stores.
- VS Code: align OpenCode configuration handling with the web runtime and add coverage for config updates.

## [1.0.0] - 2026-06-27

- Release baseline: reset DevRyan versioning and release history so the current repository state is published as the new v1.0.0 starting point.
- Runtime: includes the current web, Electron desktop, legacy Tauri compatibility, and VS Code extension code from the former v1.2.0 tree.

## [1.1.12] - 2026-06-27

- OpenCode Slim: surface Slim-managed agents in Settings by composing installed agent prompts with active Slim preset/root model metadata.
- Agents: route Slim-managed model and variant overrides back to `oh-my-opencode-slim` config instead of DevRyan's sidecar.
- Runtime: preserve active plugin registrations, copy Slim config into managed overlays, and pass the active Slim preset/background-subagent flag to managed OpenCode.
- VS Code: mirror the Slim agent catalog, override routing, and runtime overlay behavior for extension-host sessions.

## [1.1.11] - 2026-06-27

- Cursor: report ripgrep usability and resolved source in runtime diagnostics, with stronger path resolution coverage.
- Chat: recover more streamed message, reasoning, reconnect, and idle-plan edge cases so transcript state settles correctly after partial or delayed events.
- Chat: strip leaked skill-announcement reasoning fragments, including orphan headings, from assistant reasoning output.
- Agents: add harness preflight checks for skill-announcement policy conflicts and refresh packaged agent defaults to use the platform tool-activity policy.
- UI: keep notification settings controls and sidebar footer/button content aligned with the current compact layout.

## [1.1.10] - 2026-06-27

- Sessions: preserve the leading status and pin gutter in animated sidebar rows so active, pinned, and child-session indicators remain visible.
- Settings: normalize hidden model references across display and execution provider IDs so split-provider models stay hidden or visible consistently in pickers and provider settings.
- Chat: show visible transcript summaries for each text-like local attachment while still sending file contents as hidden synthetic context.
- Agents: preserve selected agent instructions in Cursor plan mode while layering no-mutation constraints, and sharpen Orchestrator ambiguity and delegation guidance.

## [1.1.9] - 2026-06-25

- Sessions: hydrate sidebar child sessions for visible projects so nested sessions remain discoverable after refresh or partial sync.
- Sessions: keep child sessions without their own directory attached to the visible parent project while avoiding unrelated project bleed-through.
- Chat: refine turn and plan completion indicators so active-session completion state is preserved and stale plan indicators clear predictably.
- Settings: protect first-run model favorite and hidden-model changes from being overwritten by stale desktop settings sync.

## [1.1.8] - 2026-06-25

- Chat: improve streaming follow behavior, timeline restoration, assistant error handling, and submit/interrupt state with expanded regression coverage.
- Sessions: tighten lifecycle indicators, active-state rendering, and queued send handling so sidebar and chat state stay aligned.
- Git and files: add shared runtime file caching, richer file API contracts, and root-aware Git/file operations across web and VS Code.
- OpenCode: add managed process registries for web and VS Code startup paths and improve managed lifecycle cleanup.
- CLI and agents: strengthen command coverage and refresh orchestrator guidance for delegated specialist workflows.

## [1.1.7] - 2026-06-25

- OpenCode: update the bundled SDK dependency and external runtime recommendation to 1.17.11 across web, UI, and VS Code diagnostics.
- Chat: improve markdown file-reference rendering by extracting reference parsing helpers and adding coverage for file reference handling.
- Sessions: refine sidebar row interactions, archive hydration, and reflow animation behavior with additional regression coverage.
- Git and files: add primary worktree root routing, richer file API contracts, and cross-runtime filesystem handling for web and VS Code.
- Agents: refresh packaged explorer and orchestrator defaults plus auto-resume coverage.

## [1.1.6] - 2026-06-24

- Desktop: clear packaged Electron HTTP and code caches on startup without deleting app storage such as cookies, localStorage, or IndexedDB.
- Reliability: force dynamic local API reads to bypass browser HTTP cache from both the server and shared OpenCode client, preventing stale session, chat, git, and preview state after updates.

## [1.1.5] - 2026-06-24

- Cursor: prewarm draft sessions and worker agents before send, with expanded turn-timing marks for prewarm, provider send, and first-delta diagnostics.
- Chat: add local branch choices to the new-session project target selector and safely stash/restore uncommitted changes when checking out a branch for the draft.
- Git: reuse checkout safety logic across branch operations and improve stash dialog copy for checkout, merge, and rebase flows.
- Attachments: inline text-like data URL attachments as synthetic text so source files, configs, logs, and SVGs remain readable to providers.
- OpenCode: update the bundled SDK dependency and external runtime recommendation to 1.17.10 across web, UI, and VS Code diagnostics.

## [1.1.4] - 2026-06-21

- OpenCode: update the bundled SDK dependency and external runtime recommendation to 1.17.9 across web, UI, and VS Code diagnostics.
- Cursor: improve first-token latency by warming persistent worker authentication, prewarming the Cursor SDK worker during startup checks, and preserving late stream events before applying final results.
- Chat: reduce noisy assistant output by hiding redundant plan tool rows, filtering orphan narration fragments, and stripping repeated self-referential reasoning status lines.
- Skills: exclude Claude skill roots from DevRyan discovery, install location UI, and route-level skill source handling while keeping OpenCode and Agents skills available.
- Agents: tighten packaged default agent guidance for delegated specialist handoffs.

## [1.1.3] - 2026-06-18

- Chat: retry session materialization when buffered streamed part deltas remain orphaned after a server fetch, preventing text from staying hidden until the turn goes idle.
- OpenCode: update the bundled SDK dependency and external runtime recommendation to 1.17.8 across web, UI, and VS Code diagnostics.

## [1.6.8] - 2026-05-21

- Chat: fixed draft model and agent keyboard selection so explicit draft choices survive shortcut-driven agent changes.
- Agents: tightened delegated agent completion markers and auto-resume rules to avoid repeating already-completed work.

## [1.6.7] - 2026-05-21

- Chat: preserved draft model, agent, variant, and plan-mode selections when starting a new session.
- Chat: kept explicit draft send settings through directory config activation so defaults do not overwrite pending sends.

## [1.6.6] - 2026-05-21

- Git: added a generated commit workflow to the Git view.
- Chat: preserved queued auto-send snapshots while honoring live model settings for explicit sends.
- Sync: recover from message-stream replay gaps and back off repeated reconnect failures.
- Notifications: clean up deleted-session timers and cap permission notification dedupe state.
- Git: fixed full unstaged diff loading when no individual file is selected.

## [1.6.5] - 2026-05-21

- Chat: preserved manually selected draft models when changing agents from either desktop controls or the keyboard cycle shortcut.
- Sessions: ignored untrusted session-list diff totals and recomputed chat-owned diff summaries from cached user messages.

## [1.6.4] - 2026-05-20

- Cursor: improved plan-mode handling so structured plans render as plan cards even when the SDK emits the plan without an explicit marker.
- Cursor: fixed assistant streaming/status handling for multi-part responses, reasoning fragments, tool parts, and idle state after terminal messages.
- Sessions: repaired Cursor-generated titles from completed plan output instead of leaving raw prompts or placeholder titles.
- Agents: tightened orchestrator/fixer delegation rules and auto-resume behavior so delegated specialists finish with explicit terminal status.
- Skills: applied visible-skill policy to runtime agent overlays so hidden skills do not remain allowed through generated managed configs.

## [1.5.5] - 2026-01-23

- Navigation: URLs now sync the active session, tab, settings, and diff state for shareable links and reliable back/forward (thanks to @TaylorBeeston).
- Settings: agent and command overrides now prefer plural directories while still honoring legacy singular folders.
- Skills: installs now target plural directories while still recognizing legacy singular folders.
- Web: push notifications no longer fire when a window is visible, avoiding duplicate alerts.
- Web: improved push subscription handling across multiple windows for more reliable delivery.
- Reliability: prompt requests now keep their JSON body when passing through the OpenCode proxy.


## [1.5.4] - 2026-01-22

- Chat: new Apply Patch tool UI with diff preview for patch-based edits.
- Files: refreshed attachment cards and related file views for clearer context.
- Settings: manage provider configuration files directly from the UI.
- UI: updated header and sidebar layout for a cleaner, tighter workspace fit (thanks to @TheRealAshik).
- Diff: large diffs now lazy-load to avoid freezes (thanks to @Jovines).
- Web: added Background notifications for PWA.
- Reliability: connect to external OpenCode servers without auto-start and fixed subagent crashes (thanks to @TaylorBeeston).


## [1.5.3] - 2026-01-20

- Files: edit files inline with syntax highlighting, draft protection, and save/discard flow.
- Files: toggles to show hidden/dotfiles and gitignored entries in file browsers and pickers (thanks to @syntext).
- Settings: new memory limits controls for session message history.
- Chat: smoother session switching with more stable scroll anchoring.
- Chat: new Activity view in collapsed state, now shows latest 6 tools by default.
- Chat: fixed message copy on Firefox for macOS (thanks to @syntext).
- Appearance: new corner radius control and restored input bar offset setting (thanks to @TheRealAshik).
- Git: generated commit messages now auto-pick a gitmoji when enabled (thanks to @TheRealAshik).
- Performance: faster filesystem/search operations and general stability improvements (thanks to @TheRealAshik).


## [1.5.2] - 2026-01-17

- Sessions: added branch picker dialog to start new worktree sessions from local branches (thanks to @nilskroe).
- Sessions: added project header worktree button, active-session loader, and right-click context menu in the sessions sidebar (thanks to @nilskroe).
- Sessions: improved worktree delete dialog with linked session details, dirty-change warnings, and optional remote branch removal.
- Git: added gitmoji picker in commit message composer with cached emoji list (thanks to @TaylorBeeston).
- Chat: optimized message loading for opening sessions.
- UI: added one-click diagnostics copy in the About dialog.
- VSCode: tuned layout breakpoint and server readiness timeout for steadier startup.
- Reliability: improved OpenCode process cleanup to reduce orphaned servers.


## [1.5.1] - 2026-01-16

- Desktop: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Opencode: fixed issue with reloading configuration was killing the app


## [1.5.0] - 2026-01-16

- UI: added a new Files tab to browse workspace files directly from the interface.
- Diff: enhanced the diff viewer with mobile support and the ability to ask the agent for comments on changes.
- Git Identities: added "default identity" setting with one-click set/unset and automatic local identity detection.
- VSCode: improved server management to ensure it initializes within the workspace directory with context-aware readiness checks.
- VSCode: added responsive layout with sessions sidebar + chat side-by-side when wide, compact header, and streamlined settings.
- Web/VSCode: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Web: the server now automatically resolves and uses an available port if the default is occupied.
- Stability: fixed heartbeat race condition causing session stalls during long tasks (thanks to @tybradle).
- Desktop: fixed commands for worktree setup access to PATH.


## [1.4.9] - 2026-01-14

- VSCode: added session editor panel to view sessions alongside files.
- VSCode: improved server connection reliability with multiple URL candidate support.
- Diff: added stacked/inline diff mode toggle in settings with sidebar file navigation (thanks to @nelsonPires5).
- Mobile: fixed iOS keyboard safe area padding for home indicator bar (thanks to @Jovines).
- Upload: increased attachment size limit to 50MB with automatic image compression to 2048px for large files.


## [1.4.8] - 2026-01-14

- Git Identities: added token-based authentication support with ~/.git-credentials discovery and import.
- Settings: consolidated Git settings and added opencode zen model selection for commit generation (thanks to @nelsonPires5).
- Web Notifications: added configurable native web notifications for assistant completion (thanks to @vio1ator).
- Chat: sidebar sessions are now automatically sorted by last updated date (thanks to @vio1ator).
- Chat: fixed edit tool output and added turn duration.
- UI: todo lists and status indicators now hide automatically when all tasks are completed (thanks to @vio1ator).
- Reliability: improved project state preservation on validation failures (thanks to @vio1ator) and refined server health monitoring.
- Stability: added graceful shutdown handling for the server process (thanks to @vio1ator).


## [1.4.7] - 2026-01-10

- Skills: added ClawdHub integration as built-in market for skills.
- Web: fixed issues in terminal


## [1.4.6] - 2026-01-09

- VSCode/Web: switch opencode cli management to SDK.
- Input: removed auto-complete and auto-correction.
- Shortcuts: switched agent cycling shortcut from Shift + TAB to TAB again.
- Chat: added question tool support with a rich UI for interaction.


## [1.4.5] - 2026-01-08

- Chat: added support for model variants (thinking effort).
- Shortcuts: Switched agent cycling shortcut from TAB to Shift + TAB.
- Skills: added autocomplete for skills on "/" when it is not the first character in input.
- Autocomplete: added scope badges for commands/agents/skills.
- Compact: changed /summarize command to be /compact and use sdk for compaction.
- MCP: added ability to dynamically enabled/disabled configured MCP.
- Web: refactored project adding UI with autocomplete.


## [1.4.4] - 2026-01-08

- Agent Manager / Multi Run: select agent per worktree session (thanks to @wienans).
- Agent Manager / Multi Run: worktree actions to delete group or individual worktrees, or keep only selected one (thanks to @wienans).
- Agent Manager: added "Copy Worktree Path" action in the more menu (thanks to @wienans).
- Worktrees: added session creation flow with loading screen, auto-create worktree setting, and setup commands management.
- Session sidebar: refactoring with unified view for sessions in worktrees.
- Settings: added ability to create new session in worktree by default
- Git view: added branch rename for worktree.
- Chat: fixed IME composition for CJK input to prevent accidental send (thanks to @madebyjun).
- Projects: added multi-project support with per-project settings for agents/commands/skills.
- Event stream: improved SSE with heartbeat management, permission bootstrap on connect, and reconnection logic.
- Tunnel: added QR code and password URL for Cloudflare tunnel (thanks to @martindonadieu).
- Model selector: fixed dropdowns not responding to viewport size.


## [1.4.3] - 2026-01-04

- VS Code extension: added Agent Manager panel to run the same prompt across up to 5 models in parallel (thanks to @wienans).
- Added permission prompt UI for tools configured with "ask" in opencode.json, showing requested patterns and "Always Allow" options (thanks to @aptdnfapt).
- Added "Open subAgent session" button on task tool outputs to quickly navigate to child sessions (thanks to @aptdnfapt).
- VS Code extension: improved activation reliability and error handling.


## [1.4.2] - 2026-01-02

- Added timeline dialog (`/timeline` command or Cmd/Ctrl+T) for navigating, reverting, and forking from any point in the conversation (thanks to @aptdnfapt).
- Added `/undo` and `/redo` commands for reverting and restoring messages in a session (thanks to @aptdnfapt).
- Added fork button on user messages to create a new session from any point (thanks to @aptdnfapt).
- Desktop app: keyboard shortcuts now use Cmd on macOS and Ctrl on web/other platforms (thanks to @sakhnyuk).
- Migrated to OpenCode SDK v2 with improved API types and streaming.


## [1.4.1] - 2026-01-02

- Added the ability to select the same model multiple times in multi-agent runs for response comparison.
- Model selector now includes search and keyboard navigation for faster model selection.
- Added revert button to all user messages (including first one).
- Added HEIC image support for file attachments with automatic MIME type normalization for text format files.
- VS Code extension: added git backend integration for UI to access (thanks to @wienans).
- VS Code extension: Only show the main Worktree in the Chat Sidebar (thanks to @wienans).
- Web app: terminal backend now supports a faster Bun-based PTY when Bun is available, with automatic fallback for existing Node-only setups.
- Terminal: improved terminal performance and stability by switching to the Ghostty-based terminal renderer, while keeping the existing terminal UX and per-directory sessions.
- Terminal: fixed several issues with terminal session restore and rendering under heavy output, including switching directories and long-running TUI apps.


## [1.4.0] - 2026-01-01

- Added the ability to run multiple agents from a single prompt, with each agent working in an isolated worktree.
- Git view: improved branch publishing by detecting unpublished commits and automatically setting the upstream on first push.
- Worktrees: new branch creation can start from a chosen base; remote branches are only created when you push.
- VS Code extension: default location is now the right secondary sidebar in VS Code, and the left activity bar in Cursor/Windsurf; navigation moved into the title bar (thanks to @wienans).
- Web app: added Cloudflare Quick Tunnel support for simpler remote access (thanks to @wojons and @aptdnfapt).
- Mobile: improved keyboard/input bar behavior (including Android fixes and better keyboard avoidance) and added an offset setting for curved-screen devices (thanks to @auroraflux).
- Chat: now shows clearer error messages when agent messages fail.
- Sidebar: improved readability for sticky headers with a dynamic background.


## [1.3.9] - 2025-12-30

 - Added skills management to settings with the ability to create, edit, and delete skills (make sure you have the latest OpenCode version for skills support).
- Added Skills catalog functionality for discovering and installing skills from external sources.
- VS Code extension: added right-click context menu with "Add to Context," "Explain," and "Improve Code" actions (thanks to @wienans).


## [1.3.8] - 2025-12-29

- Added Intel Mac (x86_64) support for the desktop application (thanks to @rothnic).
- Build workflow now generates separate builds for Apple Silicon (arm64) and Intel (x86_64) Macs (thanks to @rothnic).
- Improved dev server HMR by reusing a healthy OpenCode process to avoid zombie instances.
- Added queued message mode with chips, batching, and idle auto‑send (including attachments).
- Added queue mode toggle to OpenChamber settings (chat section) with persistence across runtimes.
- Fixed scroll position persistence for active conversation turns across session switches.
- Refactored Agents/Commands management with ability to configure project/user scopes.


## [1.3.7] - 2025-12-28

- Redesigned Settings as a full-screen view with tabbed navigation.
- Added mobile-friendly drill-down navigation for settings.
- ESC key now closes settings; double-ESC abort only works on chat tab without overlays.
- Added responsive tab labels in settings header (icons only at narrow widths).
- Improved session activity status handling and message step completion logic.
- Introduced enchanced VSCode extension settings with dynamic layout based on width.


## [1.3.6] - 2025-12-27

- Added the ability to manage (connect/disconnect) providers in settings.
- Adjusted auto-summarization visuals in chat.


## [1.3.5] - 2025-12-26

- Added Nushell support for operations with Opencode CLI.
- Improved file search with fuzzy matching capabilities.
- Enhanced mobile responsiveness in chat controls.
- Fixed workspace switching performance and API health checks.
- Improved provider loading reliability during workspace switching.
- Fixed session handling for non-existent worktree directories.
- Added Discord links in the about section.
- Added settings for choosing the default model/agent to start with in a new session.


## [1.3.4] - 2025-12-25

- Diff view now loads reliably even with large files and slow networks.
- Fixed getting diffs for worktree files.
- VS Code extension: improved type checking and editor integration.


## [1.3.3] - 2025-12-25

- Updated OpenCode SDK to 1.0.185 across all app versions.
- VS Code extension: fixed startup, more reliable OpenCode CLI/API management, and stabilized API proxying/streaming.
- VS Code extension: added an animated loading screen and introduced command for status/debug output.
- Fixed session activity tracking so it correctly handles transitions through states (including worktree sessions).
- Fixed directory path handling (including `~` expansion) to prevent invalid paths and related Git/worktree errors.
- Chat UI: improved turn grouping/activity rendering and fixed message metadata/agent selection propagation.
- Chat UI: improved agent activity status behavior and reduced image thumbnail sizes for better readability.


## [1.3.2] - 2025-12-22

- Fixed new bug session when switching directories
- Updated Opencode SDK to the latest version


## [1.3.1] - 2025-12-22

- New chats no longer create a session until you send your first message.
- The app opens to a new chat by default.
- Fixed mobile and VSCode sessions handling
- Updated app identity with new logo and icons across all platforms.


## [1.3.0] - 2025-12-21

- Added revert functionality in chat for user messages.
- Polished mobile controls in chat view.
- Updated user message layout/styling.
- Improved header tab responsiveness.
- Fixed bugs with new session creation when the VSCode extension initialized for the first time.
- Adjusted VSCode extension theme mapping and model selection view.
- Polished file autocomplete experience.


## [1.2.9] - 2025-12-20

- Session auto‑cleanup feature with configurable retention for each app version including VSCode extension.
- Ability to update web package from mobile/PWA view in setting.
- A lot of different optimization for a long sessions.


## [1.2.8] - 2025-12-19

- Introduced update mechanism for web version that doesn't need any cli interaction.
- Added installation script for web version with package managed detection.
- Update and restart of web server now support automatic pick-up of previously set parameters like port or password.


## [1.2.7] - 2025-12-19

- Comprehensive macOS native menu bar entries.
- Redesigned directory selection view for web/mobile with improved layout.
- Improved theme consistency across dropdown menus, selects, and command palette.
- Introduced keyboard shortcuts help menu and quick actions menu.


## [1.2.6] - 2025-12-19

- Added write/create tool preview in permission cards with syntax highlighting.
- More descriptive assistant status messages with tool-specific and varied idle phrases.
- Polished Git view layout


## [1.2.5] - 2025-12-19

- Polished chat expirience for longer session.
- Fixed file link from git view to diff.
- Enhancements to the inactive state management of the desktop app.
- Redesigned Git tab layout with improved organization.
- Fixed untracked files in new directories not showing individually.
- Smoother session rename experience.


## [1.2.4] - 2025-12-18

- MacOS app menu entries for Check for update and for creating bug/request in Help section.
- For Mobile added settings, improved terminal scrolling, fixed app layout positioning.


## [1.2.3] - 2025-12-17

- Added image preview support in Diff tab (shows original/modified images instead of base64 code).
- Improved diff view visuals and alligned style among different widgets.
- Optimized git polling and background diff+syntax pre-warm for instant Diff tab open.
- Optomized reloading unaffected diffs.


## [1.2.2] - 2025-12-17

- Agent Task tool now renders progressively with live duration and completed sub-tools summary.
- Unified markdown rendering between assistant messages and tool outputs.
- Reduced markdown header sizes for better visual balance.


## [1.2.1] - 2025-12-16

- Todo task tracking: collapsible status row showing AI's current task and progress.
- Switched "Detailed" tool output mode to only open the 'task', 'edit', 'multiedit', 'write', 'bash' tools for better performance.


## [1.2.0] - 2025-12-15

- Favorite & recent models for quick access in model selection.
- Tool call expansion settings: collapsed, activity, or detailed modes.
- Font size & spacing controls (50-200% scaling) in Appearance Settings.
- Settings page access within VSCode extension.
Thanks to @theblazehen for contributing these features!


## [1.1.6] - 2025-12-15

- Optimized diff view layout with smaller fonts and compact hunk separators.
- Improved mobile experience: simplified header, better diff file selector.
- Redesigned password-protected session unlock screen.


## [1.1.5] - 2025-12-15

- Enhanced file attachment features performance.
- Added fuzzy search feature for file mentioning with @ in chat.
- Optimized input area layout.


## [1.1.4] - 2025-12-15

- Flexoki themes for Shiki syntax highlighting for consistency with the app color schema.
- Enchanced VSCode extension theming with editor themes.
- Fixed mobile view model/agent selection.


## [1.1.3] - 2025-12-14

- Replaced Monaco diff editor with Pierre/diffs for better performance.
- Added line wrap toggle in diff view with dynamic layout switching (auto-inline when narrow).


## [1.1.2] - 2025-12-13

- Moved VS Code extension to activity bar (left sidebar).
- Added feedback messages for "Restart API Connection" command.
- Removed redundant VS Code commands.
- Enhanced UserTextPart styling.


## [1.1.1] - 2025-12-13

- Adjusted model/agent selection alignment.
- Fixed user message rendering issues.


## [1.1.0] - 2025-12-13

- Added assistant answer fork flow so users can start a new session from an assistant plan/response with inherited context.
- Added OpenChamber VS Code extension with editor integration: file picker, click-to-open in tool parts.
- Improved scroll performance with force flag and RAF placeholder.
- Added git polling backoff optimization.


## [1.0.9] - 2025-12-08

- Added directory picker on first launch to reduce macOS permission prompts.
- Show changelog in update dialog from current to new version.
- Improved update dialog UI with inline version display.
- Added macOS folder access usage descriptions.


## [1.0.8] - 2025-12-08

- Added fallback detection for OpenCode CLI in ~/.opencode/bin.
- Added window focus after app restart/update.
- Adapted traffic lights position and corner radius for older macOS versions.


## [1.0.7] - 2025-12-08

- Optimized Opencode binary detection.
- Adjusted app update experience.


## [1.0.6] - 2025-12-08

- Enhance shell environment detection.


## [1.0.5] - 2025-12-07

- Fixed "Load older messages" incorrectly scrolling to bottom.
- Fixed page refresh getting stuck on splash screen.
- Disabled devtools and page refresh in production builds.


## [1.0.4] - 2025-12-07

- Optimized desktop app start time


## [1.0.3] - 2025-12-07

- Updated onboarding UI.
- Updated sidebar styles.


## [1.0.2] - 2025-12-07

- Updated MacOS window design to the latest one.


## [1.0.1] - 2025-12-07

- Initial public release of OpenChamber web and desktop packages in a unified monorepo.
- Added GitHub Actions release pipeline with macOS signing/notarization, npm publish, and release asset uploads.
- Introduced OpenCode agent chat experience with section-based navigation, theming, and session persistence.
