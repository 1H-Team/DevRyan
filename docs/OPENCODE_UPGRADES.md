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
