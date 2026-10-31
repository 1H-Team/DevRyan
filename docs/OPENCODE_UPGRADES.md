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
| Native plugin IDs | Update `native-plugin-registry.ts`. Compare `plugin/internal.js` pre/post order by hand. |
| Git reads outside the controller policy | Only read-only commands that reach the controller helper belong in `execution-helper-policy.js`; keep the previous forms for retained bundles. |
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

## Seams in 2.2.2 → 2.2.5

- `opencode.provider.claude-agent` is declared through a constant (`id: ID2`); the report
  now follows such constants. It drives the local `claude` CLI through the optional
  `@anthropic-ai/claude-agent-sdk` peer, which DevRyan does not install: the build stubs
  the `#claude-agent-sdk` entry and `INERT_NATIVE_PLUGIN_IDS` activates the provider
  without running it. An unreviewed builtin fails the native `agent` catalog read.
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
