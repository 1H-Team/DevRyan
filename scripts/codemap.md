# scripts/

## Responsibility
Repository automation entrypoint for developer workflows: validation planning, local dev orchestration, release/build smoke checks, and utility tooling.

## Design

- **Release writes and assets**: `release-artifacts.mjs` owns the core dry-run
  write prohibition used by Bot build/sign/input-tag owners. `release-ci.mjs`
  resolves all images once, records packaging digests, and refuses new unsigned
  image evidence in dry runs. `verify-release-assets.mjs` takes exact scope
  allowlists from Electron's shared asset table and checks uploaded state, size
  and packaging SHA-256; `--directory` verifies staged dry-run assets. The
  release graph separates manifest assembly from topology qualification so
  packaging and isolated topology checks run independently and gate finalization.
  `prepare_bot_inputs_only` permits only image operations under a manual,
  version/source-bound `v<version>-bot-inputs-<SHA12>` tag. It retains the same
  keyless tag trust, skips every app/publication owner, and publishes no image
  version tag; dry-run write refusal still applies.
  `windows.yml` runs native x64/ARM64 qualification on `main` and the release
  and Windows implementation branches separately, with read-only
  repository permissions and no runtime-admission bypass.
  Protocol-2 job diagnostics retain the actual OS build, SDK UI mask and every
  available restriction. The supervisor requires exact kernel readback before
  command creation; it never retries with fewer restrictions.
  `diagnose-windows-supervisor-startup.mjs` compiles an exact-source disposable
  policy-3 LPAC helper and probes trusted Node/Bun startup with its bound binary
  lease policy. It preserves source/binary/output hashes and partial receipts.
  Its binary receives no accepted manifest, never enters a runtime bundle,
  and cannot satisfy any of the eleven required Windows outcomes. The seven
  historical restriction variants remain evidence; the current probe neither
  lowers UI/token restrictions nor changes inherited UI-object ACLs.
  `diagnose-windows-runtime-compatibility.mjs` independently tests original
  Node/Bun binary stdin/stdout/stderr and nested spawn APIs through confined
  `LOCAL` stdio. Its sixteen actual cells still grant no admission; both Windows
  workflows require the result instead of treating it as an optional probe.
  `qualify-windows-installer.mjs` checks native namespace durability first and
  records every independent native/acceptance blocker before packaging. Only a
  disposable hosted Windows runner with all prerequisites can build and execute
  real per-user NSIS installation, update, refusal, interruption and rollback.
  Installed app health/readiness, exact process cleanup and HKCU/shortcut
  preservation enter source/artifact-bound evidence. A same-source/version
  baseline fixture is explicitly distinguished from shipped continuity.
  `qualification.json` binds sibling `evidence.json`; private fixture profiles
  are excluded from both downloaded installer and native evidence artifacts.
  `build-windows-reviewed-libsql.mjs` attempts the original libsql 0.5.29 source
  commit with an unchanged Cargo lock on each native Windows host. It verifies
  compiler and resource PE architecture, executes the original database ABI
  through Node/Bun, and retains source/build receipts. Those candidate resources
  cannot supply runtime admission or replace the controller/writer safety gate.
  `build-windows-reviewed-executables.mjs` restores pinned AST/Claude Windows
  archives without changing the original reviewed closure. Archive SRI, binary
  SHA-256, size and PE architecture precede native version probes in an isolated
  home. Changed files and aliased output directories refuse; publication is
  exclusive. Its candidate receipt also cannot grant execution admission.
  `build-windows-git.mjs` provisions the complete official MinGit
  `v2.56.0.windows.2` archive for x64 or ARM64. Published archive hashes and
  fixed path/size/content inventories bind every runtime and license file;
  existing caches are reverified against those source pins. Native qualification
  executes only `git/cmd/git.exe` in an isolated home and records its actual
  version. The candidate builder requires this qualification, inventories all
  Git files, and records the exact seven-field `windowsGit` manifest contract.
  Git qualification does not grant runtime admission.
  `qa/macos-gui-prerequisites.mjs` and its AppKit probe run only on an ephemeral
  GitHub-hosted ARM64 macOS runner. They check console ownership, GUI bootstrap,
  WindowServer login, a visible owned window and actual PNG capture. Missing
  prerequisites remain unavailable; this check installs no app and cannot
  qualify shipped-version continuity. The read-only workflow retains hashes and
  the disposable window screenshot before an installed continuity run is allowed.
  `readWindowsReviewedLibsqlAsset` rechecks the fixed source/toolchain inputs,
  both actual-host ABI probe identities and exact unaliased PE bytes before
  supplying the sealed compilation candidate.
  Its source checkout preserves pinned LF bytes on Windows; finite stage and
  public input-hash receipts retain identity failures before compilation.

- **Compiled native package** (`build-native-runtime.mjs`,
  `native-runtime-assets.mjs`, `verify-opencode-v2-package.mjs`): builds branded
  controller/writer executables with pinned SDK, dependency, source and asset
  digests. Exact hash-guarded asset rewrites cover dynamic package resolution
  and the image WASM read; the accepted supervisor is copied unchanged.
  `.gitattributes` disables checkout text conversion only for the byte-pinned
  reviewed closure and the reviewed document/browser plugin sources. Imported
  Windows build helpers also participate in macOS native build identities.
  `--windows-candidate` builds only on the actual x64/ARM64 Windows host into
  an immutable owned cache root. It reuses the reviewed source closure, selects
  previously qualified Windows executable/database inputs, denies persistent
  PTY resolution before I/O, and executes both compiled empty-input refusals.
  `native-candidate.json` explicitly denies admission and never substitutes
  for `native-bundle.json` or an accepted launcher. Production Windows builds
  remain unavailable pending complete platform safety qualification.
  Failed Windows compilations/boot probes retain their source/file digests and
  compiled outputs in `runtime-candidate-failed-*`, with bounded error evidence.
  They remain diagnostic artifacts without a bundle manifest or admission.
  `native-compaction-observation-transform.mjs` inserts a read-only observation
  immediately after the pinned SDK's original budget calculation. Its private
  settings have no exported read API. Exact original/transformed hashes enter
  the artifact manifest; a mismatch refuses the build, and diagnostics cannot
  change the native compaction decision. Build-only helper paths use native
  absolute-path validation on macOS and Windows; SDK byte guards remain exact.
  The separate package verifier uses relocated disposable bundles, the actual
  offline importer and an ordinary local HTTP provider. Its fixture responses
  drive real compiled tools, supervisor receipts and publication.
  `package-cold-recovery.mjs` observes the application's original durable pending
  rollback intent and crashes only that exact host. A fresh production entry
  must expose held recovery without feature owners; actual CLI calls verify
  stale, missing and changed proof refusals, then resume unchanged B. Its optional
  desktop hook inspects the same retained transition before resume. Negative
  controls restore the original proof inode, bytes and mode.
  The compiled credential rollback lane drains the verifier's B owners before
  starting a separate selected-B lifecycle host. That host publishes the actual
  lost-ACK rollback proof, refuses a held retry and same-host Resume, then exits
  naturally. The parent resumes unchanged stopped B only after the original host
  and controller identities are gone. A newly composed B host performs the
  compatible rollback using the original SDK's persisted projection intent.
  Full stopped B bytes are compared through Resume and within each checkpoint;
  canonical A/B history, credential/lifecycle/refresh state, configuration, home,
  immutable bundle metadata and project bytes are compared across fresh owners.
  Asset initialization under source-read denial and full controller/tool execution
  are recorded as separate assertions. `package-prompt-lanes.mjs` verifies the
  prepared command executor and native manual compaction over HTTP;
  opt-in `--browser` uses `package-browser-lane.mjs` and its isolated Electron
  host and private HTTPS page to run the original Rust CLI against production CDP/surface and lease
  owners, with compiled writer receipts and a published PNG. It requires the
  reviewed repository-owned browser installation and an available desktop.
  `package-document-lane.mjs` uploads two real DOCX attachments and exercises
  the compiled original parser, cache, bounded reads and search through owned
  control calls. Parser termination checks remain in the production owner.
  `package-mcp-lane.mjs` supplies a private loopback MCP server, then requires
  the compiled native registry, physical HTTP calls, canonical tool results and
  host control receipts in both owned locations. OAuth remains a separate graph
  and saved-account qualification.
  `package-image-lane.mjs` refuses a selected synthetic SIWC credential without
  refresh, provider traffic or publication, then explicitly creates native API
  keys for public Responses generation, account switching, versioned PNG
  publication and owned cancellation. Billing must remain `api-key`; original
  Codex image-plugin/parser fixtures remain separate and unchanged.
  `package-slim-tools-lane.mjs` checks original AST search, default preview and
  replacement with exact worker receipts and workspace bytes, then original
  webfetch over local text/HTML with its HTTPS fallback and owned control calls.
  Its exact native permission rules use the verifier's constructor-owned
  `admission.create` callback before primary enrollment; public session creation
  continues to refuse permission and metadata configuration.
  `package-restart-lane.mjs` preserves the tracked primary objective across
  pending background recovery and a fresh controller handshake.
  `package-todo-lane.mjs` loses a real queued TODO acknowledgement while
  holding its old runner admission, then requires the same reserved continuation
  to finish once through compiled startup recovery, preserving the objective,
  model/effort, continuation budget and exact TODO revisions.
  `package-recovered-input-lane.mjs` leaves real ordinary prompts queued across
  controller death, then checks inert startup, exact inspection and explicit
  same-ID resume. Multiple retained inputs require exact discard of the older
  input before the current owner can resume. Losing the real native cancellation
  acknowledgement exercises the existing owner's durable discard recovery.
  The reviewed setup's two local models also drive a real HTTP 429 through the
  original Slim retry hook: the existing host reserves its read-only fallback,
  and replacement must retain that same input and one-attempt budget until the
  explicit resume. Exact fallback discard also survives a fresh ordinary
  admission and another replacement. Each completed case and controller exit
  is retained if a later case fails. Fixture-owned model replies remain the
  only simulated part.
  `package-recovered-shell-lane.mjs` holds a real, acknowledged shell completion
  notification in the native queue before controller death. Its sealed lease
  and confined receipt must restore that same notification automatically;
  another restart must preserve execution/publication counts, messages, lease,
  receipt and file bytes. A bounded read-only query checks that the SDK did not
  persist an enqueue event; no native rows are manufactured.
  `recovered-input-publication.graph.test.ts` exercises the original native
  Inbox, Bus and projector: whole-batch refusal precedes mutation, exact cancel
  reads the pending snapshot without reacquiring the inbox mutex, and clearing
  the startup fence preserves live queue and steer behavior. It also checks
  atomic receipt rollback, both native event-persistence settings, strict
  cancellation command fields and receipt cleanup during session deletion.
  `package-failure-events.mjs` observes the actual initial controller's SSE
  before commands. Bounded failure records retain native identities/times and
  safe error codes; generic text is represented only by its hash and byte size.
  Cleanup aborts and awaits the observer, and unexpected stream failures fail
  the run. The observer closes after interview acceptance, before later
  controller-replacement lanes; failed interviews retain the same cleanup.
  `package-rollback-lane.mjs` retains the quiesced candidate and launches the
  selected previous generation-two bundle through its real constructor-owned lifecycle, canonical inspection, kill/restart and confined exit receipts. Baseline and candidate are independently migrated from the same unchanged offline legacy data; no generation-one executable is selected.
  `package-parent-death.mjs` kills only a fresh owned Node fixture and checks
  the complete observed descendant tree plus independent supervisor receipts.
  The production application lifecycle lane retains
  `application-composition/application-lifecycle-evidence.json` after its owned
  profile closes, including actual child exits and bounded upstream provider
  request metadata on failure. Those buffered responder observations do not
  establish downstream transport cancellation or native Stop settlement.
  Failed drivers retain partial Stop identities, times and acknowledgement;
  cleanup failures preserve the original nonzero assertion. Historical A and
  candidate B each use the same canonical physical-stream Stop assertions after
  an exact real text prefix. `package-application-stop-stream.mjs` observes the
  authenticated production global SSE stream before submission and binds live
  text deltas to the exact session, assistant and text part. A fresh REST read
  independently requires that same current parent assistant to be unfinished
  and busy; durable REST text may remain empty until completion. The observer
  does not replace the canonical abort, interrupted-idle or provider assertions.
  Early-handoff cancellation is a separate original
  HTTP graph regression with strict refusal, interrupted idle and released-claim
  checks, gated in new compiled artifacts by `devryan.primary-step-stop/1`.
  Current linked build inputs and the broader web/auth source cohort are
  checked separately from portable artifact verification; incomplete gates remain explicit.
  `--preflight --reviewed-setup` reuses the same fresh bundle and owners for
  both-location catalog/model/effort checks and existing read/write,
  Council/managed, MCP, original Ponytail/Slim commands and the owned interview
  notification/publication probe, followed by the ordinary/fallback retained-input
  restart checks, before expensive
  browser/document lanes.
  Its `preflight-passed` result keeps full package qualification outstanding;
  skill bodies, compaction, recovery and all other
  default gates remain required. `package-preflight.mjs` owns the finite
  catalog oracle; registered presence alone does not establish behavior.

- **Native OpenCode acceptance** (`verify-opencode-v2-native.mjs`,
  `opencode-v2-native/`): starts the pinned Bun host against the existing Node
  execution owner, ledger and private bridge in repository-owned directories.
  Drive simulates model responses while native tools and the accepted Darwin
  supervisor produce real results and termination evidence. Failed attempts
  and process cleanup remain in the report. `writer-edge-cases.mjs` checks
  byte preservation, real formatter output, foreign edits and concurrent
  same-file publication; `managed-fixture.mjs` composes the existing primary
  and task owners for actual child completion. `fixture-journal.mjs` composes
  the production web harness journal on a compiled fixture's descriptor web
  data and tees each diagnostic source with its application mapping, counting
  accepted/refused records per writer label; `journal-evidence.mjs` grades those
  roots (missing/empty = unavailable, sealed chunks, required records, the
  original `journal.mjs --dir <root> gaps --verify` run validated by
  `qa/final-evidence-rules.mjs`, exact or crash-bounded tee reconciliation) into
  `compiled-durable-journal-roots`, which passes only at 3/3.
  `package-seeded-credential-lane.mjs` boots a fresh bundle whose setup
  credential seed is present at first boot; distinct constructor-owned
  never-started checkpoints fence source preparation and prepared-bundle
  selection. `removal-lanes.mjs` uses the
  production removal coordinator, independent native row checks, real writer
  cancellation and retained commit recovery; published workspace bytes stay
  intact. Optional `--managed-wake-attribution` adds the finite same-runtime
  event-hint comparison from `perf/managed-wake-attribution.mjs`, with actual
  authenticated SSE, HTTP/RPC counts and owned process samples; missing causal
  timing or resource evidence remains inconclusive. Native host unit tests declare
  `bun:test` and are discovered by `test-scripts.mjs`; process acceptance is
  a separate opt-in command documented in `docs/QA.md`.
  `package-managed-interval-lane.mjs` accepts locationless native success only
  for the exact arm parent after its reply; explicit foreign directories and
  other sessions cannot settle that wait. Attribution deadlines stay unchanged.
  `verify-opencode-v2-package.mjs --managed-correctness
  --event-reconcile-interval-ms 750|1500` selects three focused compiled cases:
  dropped projected hints with a real writer receipt, explicit managed
  cancellation, and the original nonrenewable oracle deadline. The independent
  interval option also reaches the regular package fixture without selecting
  a performance arm; the default remains 750 ms. The adverse provider-only
  children run no executable tools, and the original abort acknowledgement,
  native interrupted idle, runner release and durable task disposition are
  checked before completion is claimed. Deadline qualification uses the real
  fifteen-minute minimum and bounded real text progress through an opt-in
  HTTP fixture stream. Only the missed-hint case withholds projected events;
  cancel and deadline cases deliver the original native projector output to
  the managed activity registry. The native assistant completion timestamp
  must reach the original deadline. Default buffered replies and saved roles
  are unchanged.
  This focused result does not replace full package or performance qualification.

- **Local storage and `.cache` retention** (`storage.mjs`, `storage-policy.mjs`; `bun run cache:report`, `bun run cache:prune`, `bun run clean`): dependency-free, preview-first. `report` sizes every top-level `.cache` family with owner and class; `clean`/`audit` classify units (scratch, run evidence, rebuildable, session, unowned, worktrees, report-only), strip heavy payloads and keep light evidence, and `--apply` (optionally with a `--manifest` file) re-audits and rechecks identity before deleting. Never selects anything under 24 hours old, cited `.cache/...` files (collected from tracked docs and code), pinned or failure-capped runs, code-read inputs such as the pinned ripgrep, or registered worktrees (report only, with `git worktree` advice). `--max-size` sets the budget (default 50G); `--evict-evidence` additionally evicts the oldest uncited evidence runs. Also keeps the QA package and Cargo cache rules. `validate:full` warns on budget or low disk. See `docs/STORAGE_CLEANUP.md`.
- **Local Bot database feasibility** (`local-bots-spike/`): disposable, pinned PostgreSQL/PostgREST and isolated Supabase parity checks; unchanged migration replay, the three production repositories, encrypted-file storage, verified snapshot restoration and resource measurements. The runner fences project names and loopback listeners and never links a cloud project. Usage and limits: [local-bots-spike/README.md](local-bots-spike/README.md).
- **Typecheck diagnostics** (`typecheck-diagnostics.mjs`): runs the UI or web TypeScript CLI in a measured Node process with a fresh disposable incremental cache. Reports compiler/runtime versions, effective heap limit, compiler diagnostics, duration and peak RSS without dumping environment values. Normal workspace checks run sequentially with separate persistent UI/web caches.
- **Orchestrator scripts** (`*.mjs`) spawn and supervise child processes with graceful shutdown (`SIGINT` → `SIGTERM` → `SIGKILL`) and detached-group handling on macOS. Group shutdown remains active after a wrapper leader exits, so nested watchers can finish reaping their owned runtimes before the orchestrator returns.
- **Development data isolation** (`dev-data-directory.mjs`): derives a stable temporary `OPENCHAMBER_DATA_DIR` from the checkout path and launcher mode while preserving any explicit override. The web-stack, HMR, full-web, direct server watcher, and Electron launchers pass that value to every process that shares their runtime so development cannot silently reuse an installed app's production ledger.
- **Validation planner** (`validate.mjs`): computes changed-file impact via git diff, maps files to package scopes, and selects quick/affected/full command sets. Cursor and Production Bots contract/supervisor/egress/computer changes run their package suites; affected mode also expands to their host dependents. Rust source changes select the locked desktop Cargo suite; manifests and lockfiles require the full gate. Shared-runtime changes select its suite and the web dependent. Markdown runtime prompts select their owning contract tests instead of being treated as documentation-only. Current documentation references are checked by `docs/repository-links.mjs`, with historical and generated targets reported separately.
- **Windows host boundary** (`verify-windows-host-boundary.mjs`): native-only read-only supervisor probes bind parent/child PID liveness and Windows creation `FILETIME` to the actual compiled helper, including its retained original-parent handle. Records containing host-job membership and physical owned-child exit without granting confinement or admission; each architecture retains its own evidence in CI.
- **Windows filesystem boundary** (`verify-windows-filesystem-boundary.mjs`): actual SDK file identity and exclusive private ACL creation checks, including mode-bit refusal, Unicode/case paths, hard links, no-follow junctions, anchored reparse/traversal refusal and locked files. Each architecture retains source/binary/manifest digests; these are prerequisites, not complete execution qualification.
- **Full-suite discovery** (`test-scripts.mjs`, `test-electron.mjs`, `test-ui.mjs`): recursively discovers deterministic tests for runner-owned surfaces, including repository scripts and project-owned `.opencode` agent/plugin contracts. The script runner passes explicit Bun file paths in separate processes: substring matching cannot admit files outside its inventory, and native fixtures do not share resolver/loader state. `test-suite-contract.test.mjs` rejects undiscovered files, skipped/todo declarations, omitted test-owning workspaces, and stale feature-matrix paths. `feature-test-matrix.mjs` is the checked coverage index; usage and fixture policy live in `docs/TESTING.md`. Electron reports the actual macOS DMG helper/atomic-bridge inventory as a separate explicit `DEVRYAN_RUN_DMG_INSTALLER_NATIVE_TESTS=1` acceptance gate; unsupported platforms fail that gate rather than declaring skipped tests.
- **Bundle budget checker** (`check-bundle-budgets.mjs` + `bundle-budgets.config.mjs`): reads existing web Vite manifests, traverses entry static imports, then resolves explicitly configured immediate dynamic roots in order across the graph accumulated so far. This permits an explicitly measured render root beneath an earlier app root without treating sibling lazy imports as startup. It sums unique raw/default-gzip JavaScript bytes and rejects `.bun` output chunks, configured exact emitted startup chunk identities, or budget regressions with stable report/JSON output. Proven lazy view/dialog boundaries are guarded by their stable Vite manifest names, while byte budgets retain 5% headroom over the measured graph without exceeding historical baselines. It does not infer source-module or worker exclusion from generic chunk labels.
- **Agent evaluation harness** (`agent-evals/`): external-dependency-free, non-interactive schema-v1 runner for pinned loopback DevRyan/OpenCode sessions, deterministic inspect/repair/managed-change cases, bounded focused/deep Oracle review cases with safe semantic graders, exact Git fixture restoration, whitelist-only aggregate reports, shared provider prompt-tool policy, and the macOS Electron process-tree retry-memory profile. See [agent-evals/codemap.md](agent-evals/codemap.md).
- **Electron resource benchmark** (`perf/`): launches a packaged Electron build against a deterministic loopback OpenCode parent/three-child fixture and isolated data/profile directories. It uses CDP for fixed-window renderer control and Chromium traces, samples `/api/debug/memory` every 500 ms after a 5-second warm-up, discards the first CPU sample, and writes three-run metrics/traces under ignored `.cache/perf/` output. An optional baseline summary applies the CPU and working-set acceptance gates.
- **Native loopback timings** (`perf/native-upgrade-benchmark.mjs`, `opencode-v2-native/performance-fixture.mjs`): retain the existing three warmup receipts along with measured receipts. The first call of a fresh one-stream/burst fixture supplies cold-path attribution; subsequent calls supply warm-path attribution. Long-history and multi-session conditioning remain explicit in the original workloads. Actual native provider observations, ledger locks, bridge RPCs and projected typed output feed the production turn-timing owner and durable fixture journal. Cleanup seals it for original gap verification. These engineering diagnostics do not replace the seven-scenario calibration/comparison gates or measure Chromium rendering, paid providers or compaction.
- **Dual-mode release testing** (`test-release-build.sh`): native macOS build path plus optional `act` workflow simulation. Local native bundles remain testable without release secrets by disabling updater artifacts and code signing only when `TAURI_SIGNING_PRIVATE_KEY` is absent; release CI retains the signed updater path.
- **Signed Bot image release** (`build-bot-runtime-images.mjs`, `verify-bot-runtime-images.mjs`, `smoke-bot-runtime-images.mjs`): builds the eight fixed runtime images—including the sole-socket `bot-engine-proxy` and the local catalog's `database`/`rest`—for `linux/amd64` and `linux/arm64`, publishes lowercase GHCR tags with BuildKit max-provenance and SBOM attestations, extracts immutable platform/attestation digests, keylessly signs the image index and platform manifests, and emits the branded versioned manifest consumed by Electron. Dry-run planning never invokes Docker or cosign; verification rejects incomplete platforms, mutable references, metadata drift, and non-DevRyan image identities. Before release artifacts are exposed, the architecture-matched supervisor, engine proxy, egress, indexer, database and database-rest topology must also reach Docker `healthy` under the production Compose contract, in an isolated `devryan-smoke-<hex>` namespace whose catalog volume is created and initialized the way Electron does.
- **Bot image reuse** (`bot-runtime-image-inputs.mjs`): computes each image's input digest over its Dockerfile, `.dockerignore` files, the release build recipe and every copied repository file (mode and content; the root `version` of `package.json`/`package-lock.json` is ignored), and fails closed on unpinned bases, remote/glob/heredoc/escaping sources, bind mounts and symlinks. `release-ci.mjs image-resolve` reuses `<repo>:in-<digest>` only after cosign verification against tag-triggered `release.yml`, attestation completeness and anonymous pulls, emitting an `image-sign`-shaped result; `image-sign` tags newly signed images with their input digest.
- **Bot UI recovery soak** (`bot-upgrade-soak.ts`): one-hour dependency-free synthetic Bun harness for concurrent delayed transcript/Shared reads, principal resets, finalized-message protection, cache limits, and prewarm release/reacquire. Writes aggregate progress every 30 seconds under `.tmp/bot-upgrade-soak.jsonl`; never connects to providers, Telegram, browsers, or a live app.
- **Production Bots visual gate** (`capture-production-bots-visuals.mjs`, `package-production-bots-visual-shell.mjs`, `tests/visual-production-bots/`): builds a test-only Vite fixture from real Bot UI components and drives it with either the repository Electron runtime or a separately packaged, test-only Electron CDP shell. The 38-case matrix writes screenshots plus bounds, focus, keyboard, dialog, secret-sentinel, console, rejection, and feature-scope visibility assertions; network states must keep the real policy controls inside the captured viewport. No fixture code enters production bundles and cross-machine pixel equality is not enforced. The release-candidate acceptance command pairs that packaged matrix with the packaged DevRyan CoreGraphics pointer smoke; both use isolated data/profile roots and loopback fixtures.
- **Bot memory recovery smoke** (`smoke-bot-memory-recovery.mjs`): targets either the web server or a packaged Electron app's loopback web origin, signs in through the loopback-only administrator fixture, and waits for at least two concurrently completed recoverable run IDs to show a later extraction success, resolved immutable failures, persisted memory provenance, and exactly one source per run/logical key.
- **Small focused utilities**: per-purpose scripts for web watcher startup, version/theme/build helper tasks, and the narrowly scoped hosted Supabase Auth password-policy sync used by release CI and operators.
- **Browser-parity fixture** (`fixtures/browser-parity-app.mjs`): zero-dependency loopback app used for multi-user visual checks of relative assets, API/cookie traffic, console levels, selectable DOM metadata, navigation, and a WebSocket/HMR-like connection.
- **Diagnostic journal inspector** (`journal.mjs`): zero-dependency list/show/gaps/blob/path CLI for session manifests, gzip/open chunks, runtime records, and transitional legacy segments.
- **Packaged default-config gates**: `verify-default-config-artifact.mjs` SHA-verifies the canonical asset inventory and rejects prohibited files in managed roots. `smoke-packaged-orchestration-config.mjs` provisions a temporary clean user and runtime overlay from an extracted artifact, checking dependencies, agents, manifests, plugin bytes, and the absence of bundled user-profile skills without touching user configuration.

## Flow

- `build-session-execution.mjs` builds the dependency-free native supervisor and
  its digest manifest in an explicit output directory. It does not install it.
- `verify-session-execution.mjs` verifies native write confinement and process
  termination in disposable roots, plus the spawn adapter through `/bin/sh` and
  a headless Chromium launch (CDP pipe and text rendering) that is skipped when
  no Playwright `chromium_headless_shell` is installed. Native package acceptance
  owns real HTTP restart, prompt cleanup, selective Revert/Redo and held writer
  proofs. The compatibility concurrent-Revert commands require a compiled native
  artifact root and are separate from deterministic unit suites.
1. Developer invokes a script via `bun run` or shell.
2. Script resolves repo paths/env, validates prerequisites, and builds an execution plan.
3. It runs one or more child commands (watchers/builds/checks), forwarding output and handling lifecycle events.
4. On failure or interrupt, script tears down subprocess trees and exits with explicit status.

## Integration
- **Depends on**: Bun, Node runtime, git CLI, and platform build toolchains (Rust/Tauri for legacy desktop release checks).
- **Invokes package scripts** across `packages/*` (especially web/electron/desktop).
- **Used by CI and local development** for consistent validation and release smoke behavior.
- **Full-gate contract**: `bun run test:full` includes every test-owning workspace, including locked Cargo tests for legacy Tauri; PR CI installs the Tauri v2 Linux toolchain prerequisites and caches Cargo inputs.
- **Bundle-check contract**: `bun run bundle:check` reads existing `dist` manifests only and writes no source artifact; unit tests use temporary manifests/files, so normal test runs do not require a prior build.
- **Agent-eval contract**: `bun run agent:eval -- --config <path>` accepts no other flags, never infers credentials, and writes schema-v1 reports only to the configured directory. Live provider execution is an explicit operator action; unit tests use temporary Git fixtures and fake loopback servers.
- **Artifact-gate contract**: release workflows unpack npm, Electron `app.asar`, and the legacy Tauri app resource artifacts before release/publish, then run both default-config gates. The smoke requires the exact manifest-owned local plugin registrations, reviewed dependency versions and installed entrypoints, curated skills, bundled runtime plugins, and no duplicate profile-owned registration in the runtime overlay. Electron relies on packaged `@openchamber/web` defaults; Tauri stages the canonical filtered tree because its compiled sidecar cannot rely on adjacent package files.
- **Bot image artifact contract**: release CI builds at most three images concurrently with per-image persistent caches. Electron preparation runs in parallel; final packaging waits for the aggregated signed image manifest. The six GHCR packages, including `devryan-bot-engine-proxy`, are public because installed apps carry no registry credential; the image job probes each exact index and platform digest with an empty Docker credential directory before exposing its manifest. Each Electron job downloads the workflow-owned manifest, stages it through the bounded verifier, bundles the identical bytes as `bot-runtime/images.release.json`, and re-verifies the packaged resource. Since 2.0.1 the manifest is internal only (workflow artifact `bot-runtime-images`) and is not a public release asset; generated local `images.release.json` files are never source-controlled.

- **Isolated web/Electron QA** (`qa/`): actual host/shared UI journeys and responsive captures against the loopback fixture, bounded CDP inspection, owned process cleanup, sanitized evidence/journal preservation, and an explicit real-provider HTTP smoke. See `qa/codemap.md` and `docs/QA.md` for coverage limits.

- Release asset verification rejects extension packages and artifacts before publication.

- **Release handoffs**: `release-artifacts.mjs` verifies web files and native archive identity/checksums; `release-ci.mjs` adapts fixed workflow operations. Image planning and prepared import run before dependency installation; runtime packaging imports are scoped to the operations that need them. Web assets build once, and native tar handoffs preserve permissions/symlinks per architecture. See [release pipeline](../docs/RELEASE_PIPELINE.md) for commands, failure semantics and timing acceptance.
- **Windows compatibility preview** (`windows-preview-opencode.mjs`, `package-windows-preview.mjs`, `windows-preview-installer-smoke.mjs`, `windows-preview-session-smoke.mjs`, `windows-preview-release.mjs`): pins official stock OpenCode archives, verifies PE architecture, builds separate per-user NSIS packages, exercises isolated provider/session fixtures through the installed app, and verifies the exact two preview installers plus source/hash/signing evidence. This lane neither grants native confinement admission nor changes stable version parsing or published assets.
- **Windows release append** (`append-windows-release.mjs`, `windows-release-append.yml`): manual, dry-run-by-default append to the published 2.0.2 release. Requires the unchanged tag/source, original macOS publication gates and both complete native/installer jobs. Derives digests from their packaging receipts, hashes the downloaded macOS DMG, pins both installer files, and uploads only missing qualified Windows assets. The existing macOS asset ID is preserved and the final `desktop` allowlist must match exactly. Incomplete qualification, changed receipts/assets or dry runs cannot authorize publication.

- **npm runtime closure**: `pack-web-release.mjs` stages private runtime workspaces as bundled dependencies and preserves their external ranges in published metadata. `release-ci.mjs` invokes it after verified web staging; npm publishes the exact checked tarball, not a second pack.

- `qa/session-changes.mjs`: deterministic file execution/private Git capture setup and production web/Electron session attribution, recorded diff, and restore visual journeys.

- `verify-crash-memory.mjs` runs synthetic Electron history reconciliation in isolated app-bound and service ownership modes. The `--workload snapshots` option measures a large synthetic managed ledger separately. It writes numerical samples and synthetic allocation profiles beneath `.cache/`, with a default 95-minute soak; it never registers launchd, connects providers or reads installed-app state.

- `build-native-runtime.mjs` builds the sealed native v2 controller/writer/assets plus accepted execution launcher into `packages/web/runtime/<platform>-<arch>`. The accepted build is Bun 1.3.14 on Darwin ARM64; Windows has a separate unqualified `--windows-candidate` cache output with no production manifest or admission grant. Its output is created exclusively, the candidate receipt is written last after verification, and failed files remain in place. The writer uses an explicit executable entry. Default Darwin output replaces the platform directory atomically; explicit output roots are immutable. `build-revert-runtime.mjs` is a compatibility command alias and never builds a v1 executable.

- `hydrate-reviewed-claude.mjs` restores the oversized reviewed Claude executable from the exact public npm archive before native CI builds. Archive SHA-512 and executable SHA-256/size must match; changed existing files are preserved and rejected. The executable stays outside Git, while its metadata, licenses and checksum inventory remain committed.

- `verify-revert-runtime-artifacts.mjs` is a compatibility filename for exact native manifest/hash/mode/registration/signature verification. Unmanifested files, old executable names and unavailable platform verification refuse packaging. `pack-web-release.mjs` additionally blocks universal publication while the other required native platforms lack reviewed artifacts; current-host acceptance does not satisfy that release gate. Desktop prepared exports include only the verified current-platform payload.

- `verify-concurrent-revert-{runtime,execution}.mjs` are explicit `--artifact-root` aliases to full compiled native package acceptance. They are not additional deterministic-suite jobs. Old per-case runtime launchers, `qa/revert-ui.mjs`, `companion-upstream-check.mjs` and `perf/skill-loading-benchmark.mjs` are retired; no case-for-case equivalence or old performance improvement is claimed. The native package and generation-two UI journeys own live Revert and skill behavior qualification.
