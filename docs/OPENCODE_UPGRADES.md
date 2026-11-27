# OpenCode host upgrades

How to move the bundled native OpenCode host to a new release. Managed plugins
follow [plugin upgrades](PLUGIN_UPGRADES.md) instead. Read package tarballs and
installed `node_modules` only; never an upstream checkout (see `AGENTS.md`).

## 1. Install the candidate

1. Set every `@opencode/{ai,core,plugin,schema,simulation,util}` pin in
   `package.json` and `@opencode/{ai,core,plugin,schema,sdk,server,util,simulation}`
   in `packages/web/package.json` to the candidate, then `bun install`.
2. Run the review list. It compares the installed candidate with the current pin,
   packs the previous release into the OS temp dir, and edits nothing:

   ```bash
   bun scripts/opencode-upgrade-report.mjs
   ```

   `--write-openapi` also vendors `packages/web/server/lib/opencode/v2/openapi-<candidate>.json`.
   `--json` prints the same data for tooling.

## 2. Work through the report

Each section names its owner. Resolve every `action`; decide every `review`.

| Section | What to change |
| --- | --- |
| Pinned core sources | `scripts/native-core-sources.mjs` finds the chunks by content, so renamed chunk files need no edit. A changed sha means reviewing the body diff against the previous release, then updating the sha (and anchor) in `scripts/native-runtime-assets.mjs` or the `scripts/native-*-observation-transform.mjs` owner. |
| Package exports and imports | Removed export subpaths break the native build; move imports to the new public entry points. New peer or dependency ranges need a decision. |
| New database migrations | Raise `REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL`, measure the fresh layout with `scripts/opencode-v2-native/native-clone-layout.graph.test.ts`, revert the migrations in `startupUpgradeFixture` (`runtime-bundle.test.js`), and check host SQL for dropped or renamed tables. |
| HTTP routes | Classify every added route in `v2/route-policy.js` (deny unless DevRyan needs it), add it to the independent rules in `route-policy.test.js`, set `OPENCODE_V2_OPENAPI_VERSION`, and run `node scripts/generate-opencode-v2-routes.mjs`. |
| ChatGPT allow-list catalog coverage | Core's ChatGPT plugin shows only allow-listed models that have a row in the reviewed catalog. Run `bun run catalog:refresh`, review its diff and rebuild; `scripts/model-catalog-refresh.test.mjs` enforces the coverage. |
| Native plugin IDs | Update `native-plugin-registry.ts`. Compare `plugin/internal.js` pre/post order by hand. |
| Git reads outside the controller policy | Only read-only commands that reach the controller helper belong in `execution-helper-policy.js`; keep the previous forms for retained bundles. |
| Built-in instruction text | `bootstrap.test.ts` checks that core's `core/environment` instruction still carries the `global.tmp` advice `configuration.ts` replaces. If it fails, update `GLOBAL_TMP_ADVICE` to the new sentence (or drop the override if core no longer points the model at a protected folder). |
| Literal version occurrences | Retained-version lists (provider recovery, clone tables, migration receipts) keep the old version and add the new one; current-pin fixtures move to the candidate. |

Then set `TARGET_OPENCODE_VERSION` (`version-policy.js`) and the compiled pins in
`scripts/build-native-runtime.mjs`, `bootstrap.ts`, `migration-mode.ts` and the
package lanes.

## 3. Build and qualify

1. `bun scripts/build-native-runtime.mjs` builds `packages/web/runtime/darwin-arm64`.
   Record its `inputs.coreDigest` in `REVIEWED_NATIVE_CLONE_RELEASES`.
2. `bun run --cwd packages/web type-check`, then the native host graph suite,
   which catches most behavior changes:

   ```bash
   bun run --cwd packages/web test:native-host
   ```

3. `bun run validate`.

## 4. Predict the packaged app

Host and dependency upgrades are what outgrow the packaged-app ceilings: 2.2.2, the
claude-agent provider and 2.2.6 each failed only at packaging in the macOS release dry
run. Before pushing an upgrade, or any change to `bun.lock`, a workspace manifest or the
`build` field of `packages/electron/package.json`:

1. On an Apple Silicon Mac, after step 3.1 (the native runtime), `bun run build` (web
   output and the Electron main bundle) and
   `bun run --cwd packages/electron build:native-helpers`, run the predictor:

   ```bash
   node scripts/predict-packaged-app.mjs
   ```

   It runs electron-builder's own file selection (its matchers, Bun dependency collector,
   `node_modules` filter, `package.json` transformer and smart unpack) over the installed
   tree for the darwin-arm64 app, packages nothing, and checks the result against
   `scripts/packaged-app.config.mjs`: forbidden content fails, and so does an estimated
   `asarBytes`, `unpackedBytes` or `resourcesBytes` over its ceiling. With those inputs
   built it predicts all three sizes; this is the run this step asks for. `--verbose`
   adds a per-directory size breakdown. Files the package takes from the repository
   count only when git tracks them (or they are a known build output), as in a clean
   release checkout. It refuses to run against another app-builder-lib than the one it
   was calibrated against (`CALIBRATED_BUILDER_VERSION`).

   Anywhere an input is missing, each size it affects is printed as a lower bound on its
   own line (`ok (lower bound: <what is missing>)`): build outputs, the native runtime,
   the macOS Electron install, or darwin-arm64 platform packages a Linux host does not
   install. A lower bound over its ceiling still fails. Packages restricted to the host's
   own OS (Linux ones in CI) are left out, as the macOS packaging host never has them.

   Its test, `scripts/predict-packaged-app.test.mjs`, runs in CI's Linux scripts lanes on
   every push and in `bun run validate` whenever `bun.lock`, a manifest or the packaging
   config (`build` in `packages/electron/package.json`, `scripts/packaged-app.config.mjs`)
   changes. Those lanes build neither `dist-bundle` nor the native runtime and install no
   darwin-arm64 binaries, so there the sizes are lower bounds and the test's teeth are the
   forbidden-content rules: a CI pass does not replace the Mac run above.
2. For the authoritative answer before a dry run, on an Apple Silicon Mac with the Xcode
   command line tools and the native runtime of step 3.1:

   ```bash
   bun run electron:build
   bun run app:check
   ```

   `electron:build` prepares (web assets, native helpers, main bundle, native rebuild) and
   packages `packages/electron/dist/mac-arm64/DevRyan.app`; its `afterPack` hook already
   fails on forbidden content or a size over its ceiling, and `app:check` repeats that
   check on the built app. Its `rebuild:native` step rebuilds `node-pty` and
   `better-sqlite3` in `node_modules` for Electron's ABI, which breaks Node-side tests
   that load them: package in a checkout you are not testing in, or reinstall its
   dependencies before testing there again.

Calibration of the predictor (2026-11-10, on `20a2abeb`) against the last green dry run,
42803641451 at `e344e123`, whose lockfile and manifests are the same:

| Size | Predicted | Dry run | Difference |
| --- | --- | --- | --- |
| `asarBytes` | 158,644,044 | 158,643,772 | +272 B (+0.0002%) |
| `unpackedBytes` | 48,174,536 | 48,175,945 | −1,409 B (−0.003%) |
| `resourcesBytes` | 552,314,173 | 552,404,382 | −90,209 B (−0.016%) |

Each is within 2%, so each fails over its ceiling (`FAILING_SIZE_KEYS`). Re-calibrate
after an electron-builder upgrade; a size that drifts past 2% moves out of
`FAILING_SIZE_KEYS` and is printed only.

Replaying the three packaging failures with the pre-fix `build.files` on the current tree:

| Failure | Mac with inputs built | CI Linux lane |
| --- | --- | --- |
| 2.2.6, no `node-gyp` exclusion | asar 160,410,156 B (dry run 160,409,884 B), over; `build-tool` content | asar 159.22 MB lower bound, passes; caught only by the `build-tool` content rule |
| claude-agent provider, no SDK exclusions | asar 160.5 MB and unpacked 298.7 MB, both over | asar 159.30 MB lower bound, passes; the darwin-arm64 SDK binary is not installed, so unpacked passes too: not caught |
| 2.2.2, Resources 836.6 MB | caught when the native runtime and web assets are built (overrun 0.19%, calibration error 0.016%) | Resources lacks about 300 MB of runtime: not caught |

## Seams in 2.2.5 → 2.2.6

- `@opencode/*` 2.2.6 depends on `effect` 4.1.0; the root and web `effect` pins moved with it.
  Effect 4.1 command arguments and environment values may be `Redacted`. Core spawns none,
  and the native spawner refuses them (`native_spawn_redacted_unavailable`) rather than
  unwrapping a secret into a controller request.
- `@opencode/ai` reworked its request API. `LLMRequest` and `HttpOptions` are plain
  interfaces (edit a request by spread or `ai.request`); generation knobs such as
  `maxTokens` sit at the top level (`GENERATION_KEYS`); the header wait is
  `timeout.headers` (`timeoutConfig`), merged per phase over the model's
  `options.timeout`; route options are merged into `model.options`; `LLMClientShape` is
  gone (use `Context.Service.Shape<typeof LLMClientService>`); `./experimental/testing`
  is removed. Provider stanza `headerTimeout`/`chunkTimeout` settings are unchanged.
- There is no `provider-error` stream event: provider failures fail the stream as an
  `AIError`. Only a content-filter `step-finish` precedes later output.
- Text attachments lose `metadata.attachment`; core's `\n\nAttached file: <name>` header
  is the only marker (`native-document-plugin.ts`).
- `Mcp.Interface` gains `awaitStartup`; wrappers that spread `inner` pass it through.
- `McpTool.flush`, run before every step's tool snapshot, now reloads the whole tool
  registry when `mcp.tools()` returns any object it has not seen. `remote-mcp.ts` keeps one
  projection per native tool so an unchanged catalog never reloads; a fresh projection per
  call would replace every executor and expire concurrent steps' snapshots. A server's
  connect still publishes `mcp.tools.changed`, which reloads once more after a 100 ms
  debounce; graph tests snapshot after that reload.
- Effect 4.1's `NodeWS` is `export * from "ws"`. `ws` is a Bun built-in, so it stays an
  external import, and Bun 1.4.4 bundles a star re-export of a built-in to nothing
  (`ws3`/`exports_NodeWS` is not defined). `reviewedNativeInputPlugin` replaces the pinned
  source with the built-in's named exports (`EFFECT_NODE_WS_SOURCE_SHA256`).
- `GET /api/experimental/job` (cross-session job listing) is new and denied.
- The OpenCode Console plugin can inject its organization library's instructions and download
  its skills. Core allows that when `Config.integration` is absent, so DevRyan's config
  services define the hook and never store the document (`configuration.ts`); the Console
  plugin also needs `InstructionDiscovery`, `SharedCache` and `Skill` in test fixtures.
- `experimental.part_rows` moves assistant content into `session_part` rows. DevRyan's
  config never sets it; enabling it would break host SQL readers of
  `session_message.data.content`.
- No migration: clone level 7 is unchanged, and the shipped 2.2.5 rebuild clones into 2.2.6.
  Photon worker and Windows PTY resolver changed only in chunk paths. Compaction now
  precomputes a fixed lead before the ceiling and skips a stale prompt cache; finalization
  routes pre-output overflow through the publisher. Neither moves an observation anchor.

## Seams in 2.2.2 → 2.2.5

- `opencode.provider.claude-agent` is declared through a constant (`id: ID2`); the report
  now follows such constants. It drives the user's own `claude` through the
  `@anthropic-ai/claude-agent-sdk` peer; DevRyan pins the SDK to core's peer version and
  rebuilds the plugin over host-relayed IO (`runtime-host/claude-agent-io.ts`). On an
  upgrade, recheck `ClaudeIO.Interface`, the SDK's argv against `assertClaudeAgentArgs`,
  and the `rate_limit_event` shape. An unreviewed builtin fails the native `agent` catalog read.
- `@opencode/ai/effect` exports `LLM` as a type only; use `ai.request`. The `Tool`,
  `Image`, `Video`, `Speech`, `Transcription` and `Decision` namespaces are gone.
- New interface members: `Permission.allows` (scoped like `assertNotDenied`; the writer
  worker answers `false`), `Tool.check` (Code Mode schedule checks, refused),
  `PersistentPty.rename`, and the plugin context's `experimental.artifact` (withheld from Slim).
- The `job` table replaces the `kv` `job.background/*` markers (clone level 7); the
  package restart lanes read it.
- Compaction `buffer` may be a percentage string; the observation contract accepts it.
- `@opencode/pty` 0.4.0 changes only the binary; its JS API matches 0.3.3. The PTY
  resolver chunk, Photon worker, Windows PTY resolver and finalization source changed
  only in chunk paths and identifiers; compaction now takes `min(input, context)` as its
  window and percent buffers, without moving the observation anchor.
- `session_part` is still written only where part rows already exist.

## Seams in 2.2.1 → 2.2.2

- `@opencode/*` 2.2.2 depends on `effect` 4.0.6; DevRyan's root and web `effect` pins must
  match or type-check and the native host graph fail on duplicate Effect types.
- The PTY package moved from `@opencode-ai/pty` 0.3.1 to `@opencode/pty` 0.3.3; the core
  source signature, build resolution and the PTY binary SHA-256 moved with it.
- `session_part` exists and is read, but nothing writes it yet; assistant content still
  lives in `session_message.data`. Check the writer before the next upgrade: once it
  writes parts, every host SQL reader of `session_message` content must join parts.
- `session_v2.time_busy` changes the session row on each execution start without
  touching `time_updated`.
- Core sources, Photon worker and Windows PTY resolver changed only in chunk paths
  and minified identifiers.

## Seams in 2.2.0 → 2.2.1

- All four pinned core sources changed only in chunk import paths and minified
  identifiers; their bodies matched, so only the SHA-256 pins moved.
- `@opencode/ai` moved Vertex and Bedrock Mantle subpaths under
  `providers/google-vertex/*` and `providers/amazon-bedrock/mantle/*`.
- `Permission.Interface` gained `assertNotDenied`; every hand-built or wrapped
  permission service must implement or scope it.
- New builtin plugins (`goal`, `tool.image-generate`, `tool.schedule`) must be
  registered or the host refuses their activation (`native_plugin_unreviewed`).

## Seams that broke in 2.1.4 → 2.2.0

A first look for the next upgrade:

- `@opencode/ai` moved its Effect API to `@opencode/ai/effect` and dropped `./*`.
- `FileAccess.resolve` probes `<dir>/.git` and `<dir>/.hg` up to `/` for external
  reads; the read guard answers refused probes as not found (`execution-routing.ts`).
- The response schema middleware logs encode failures and returns 500 instead of
  failing with 400; startup diagnostics read the log (`native-catalog-diagnostics.ts`).
- `Credential.lock` keeps an OAuth refresh running after its caller is interrupted.
- Image resizing moved to a worker thread; the build keeps the main-thread path.
- The configuration policy plugin's MCP transform now reaches DevRyan's MCP seal;
  test fixtures must approve the same origins as `controller-startup.ts`.
