# OpenCode 2.0.26 qualification

Workstation qualification on 2026-10-09 for the 2.0.24 → 2.0.26 patch upgrade
of the web/Electron native runtime and the Bot image, plus the About
"Check for Updates" action. The registry was read once (all `@opencode/*`
packages at `latest` = 2.0.26, published 2026-10-08) and the candidate frozen.
No release was published and the installed application was not changed.

## What changed upstream

Evidence: `core-source-changes.txt` (47 core modules, compared after
normalizing chunk names and minifier symbol numbering) and
`openapi-operation-diff.txt`.

- Every core chunk was renamed (`repository-*` → `location-services-*`). The
  two pinned build inputs are unchanged apart from names: the PTY resolver is
  byte-identical, and the compaction source differs only in symbol numbering.
  Build pins now name `location-services-dajrwvna.js` and
  `location-services-qhaz1dgr.js` (source SHA-256 `f87bbbf9…`). The Windows
  candidate PTY resolver hash moved because only its import path changed.
- One new route, `POST /api/integration/{integrationID}/connect/external`
  (external credential sources such as Azure CLI). The route policy denies it,
  like the command-based connect routes. 142 operations in total.
- A data-only migration, `20261007190000_azure_cli_external_credential`,
  rewrites Azure CLI OAuth credentials into a new `external` credential type.
  There is no DDL change. Older releases cannot decode `external` values.
- `@opencode/schema` removed `external_directory: * → ask` from every agent's
  defaults, and core removed the matching tmp/config/tool-output allow rules.
  Packaged agents set `external_directory: { "*": ask }` explicitly, but the
  native `build` agent, custom agents and Slim rescue reads relied on the
  default (`slim-reviewed-resource.graph.test.ts` lost its single native
  permission). A pinned build transform (`rewriteNativeAgentDefaults`, source
  SHA-256 `0327d721…`) re-inserts the rule directly after `*: allow`, its 2.0.24
  position, so later agent rules still win. The read root and writer root were
  unaffected; attempt 1's database shows that read refused by
  `native_read_root_denied`.
- Config policy actions changed from `permission` to `tool.use` and
  `integration.use`. DevRyan writes no `experimental.policies`.
- The `opencode.config.policy` plugin now registers MCP and skill catalog
  transforms that remove servers or skills denied by `integration.use`. The
  sealed MCP catalog refused that transform, so the whole policy plugin failed
  to load (`controller-startup-cold.graph.test.ts` caught it during full
  validation). `remote-mcp.ts` now admits the reviewed policy origin for `list`,
  `get` and `remove` only; `set`/`update` stay sealed and other origins still
  cannot remove. Package acceptance attempts 1–5 ran the earlier build, where
  this plugin did not load.

## Compatibility decision

`clone-layout.jsonl` inspects the 2.0.24 baseline and 2.0.26-migrated candidate
databases from the same acceptance run. Both match the reviewed schema,
`__drizzle_migrations` and user-version layout; the candidate additionally
records the Azure CLI migration (49 vs 48 `migration` rows), which the layout
hash does not cover. The 2.0.26 core digest
`9f5a227676de99f375459ba7b5be9f78a9c215ca62e8d7ffe9cfe920b24ea808` was admitted
with a migration-level rule: 2.0.20/2.0.24 → 2.0.26 clones are allowed, and a
database never clones from 2.0.26 into an older release. Rollback keeps using the
retained bundle's own database and controller. A captured `external` credential
cannot be projected into 2.0.24 (its own schema refuses it), and DevRyan denies
the route that would create one.

## Artifact identity

| Artifact | Evidence |
| --- | --- |
| Native candidate | `.cache/opencode-upgrade/2.0.26/candidate3-darwin-arm64` |
| Retained baseline | `.cache/opencode-upgrade/2.0.24/recovery-darwin-arm64` (build `d1a8580f…`, identical to the superseded production output) |
| Native build ID | `496d76c192ed12392ab138b8b96443d4290aec6de5e08fcfe38a9348b4488419` (policy-origin and agent-default fixes; attempts 1–5 used `ab165de8…`) |
| Native manifest SHA-256 | `e6dd569fc72999ea85ff95383c35b69192e145f955b8cda8f90e4ecedb784241` |
| Core digest | `9f5a227676de99f375459ba7b5be9f78a9c215ca62e8d7ffe9cfe920b24ea808` |
| Bot image (local, unpushed) | `devryan/bot-opencode:task-upgrade-2.0.26` |
| Bot image ID | `sha256:59c8f2406f1fc76fcece1cda955f8cd3ea54f814a737fdffb2476c7a4b98b210` |

`native-candidate-identity.json` records the pinned OpenCode transforms. The
rebuilt production output in `packages/web/runtime/darwin-arm64` has the same
build ID and core digest and passed `bun run verify:revert-runtime`. Bot release
manifests are generated from pushed digests at release time; this local image ID
is not a release digest.

## Completed checks

- Bot image build with exact `@opencode/server` and `@opencode/core` 2.0.26
  install assertions and the 2.0.26 health check. Offline OAuth acceptance with
  the baked image passed (`bot-offline-oauth.json`): 11 text/structured requests,
  three coordinated refreshes, attachments, cancellation, restart and host
  events; SIWC image requests refused; internet disabled; no leftover containers.
- `DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full` passed (exit 0,
  19.6 min): workspace lint/types, script and package suites, 4,065 UI tests
  in 589 files and 6,534 web tests in 535 files. Earlier runs caught the
  policy-plugin, agent-default and control-copy defects fixed above.
  Evidence: `.cache/opencode-upgrade/2.0.26/validate-full.log`.
- Final `bun run build` and `bun run bundle:check` passed. Web entry: 4,886,251
  raw bytes against 4,962,877 allowed; 1,440,629 gzip bytes against 1,456,388.
  `bun run verify:revert-runtime` passed on the rebuilt production output.

## Native package acceptance

Both runs use the retained 2.0.24 baseline against the final 2.0.26 candidate
(`qualified_release_pair` 2.0.24 → 2.0.26):

```sh
node scripts/verify-opencode-v2-package.mjs --artifact-root .cache/opencode-upgrade/2.0.26/candidate3-darwin-arm64 --baseline-artifact-root .cache/opencode-upgrade/2.0.24/recovery-darwin-arm64
node scripts/verify-opencode-v2-package.mjs --reviewed-setup --artifact-root .cache/opencode-upgrade/2.0.26/candidate3-darwin-arm64 --baseline-artifact-root .cache/opencode-upgrade/2.0.24/recovery-darwin-arm64
```

- Default lane: 48/48 passed, no remaining mandatory gates, no cleanup failures
  (4 min 48 s). Evidence: `.cache/v2-validation/package-9nVFLd/result.json`.
- Reviewed-setup lane: 84/84 passed, the same case inventory as the 2.0.24
  qualification, no remaining gates or cleanup failures (12 min 58 s). It covers
  remote MCP in two locations, Slim AST/webfetch and interview, ordered Council,
  documents, API-key/SIWC image handling, forward clone, credential rollback
  reconciliation, candidate-work retention, the selected rollback lifecycle,
  seeded-credential first boot, parent-death drain and all three durable journal
  roots (3/3). `second-location-read-isolation` again requested exactly one
  native `external_directory` permission before the read-root refusal. No
  plugin-load failures were logged. Evidence:
  `.cache/v2-validation/package-q1s0p8/result.json`.

Earlier attempts against intermediate builds remain failed evidence. Attempt 1
stopped at the removed external-directory prompt. Attempts 2–5 hit wall-clock
lane limits while unrelated workloads held load averages of 10–147 on 8 cores;
the nested parent-death run took 178 s versus 74 s for 2.0.24, with pre-runtime
phases equally slowed. Logs: `native-package-attempt*.log` and
`native-package-attempt1-result.json` in `.cache/opencode-upgrade/2.0.26/`.

## About visual check

An isolated host from the native profile factory (synthetic private profile,
final candidate, workspace selected through the profile's own settings) showed
the bundled runtime as 2.0.26 and ready. Against the live registry, Check for
Updates reported "Up to date · latest upstream release 2.0.26" in the desktop
and compact layouts (`about-desktop-up-to-date.jpg`, `about-compact-up-to-date.png`).
"Update available: 2.0.27" and the failure state were rendered by overriding the
page's `fetch` for that one endpoint (`about-desktop-update-available-simulated.png`,
`about-desktop-failure-simulated.png`). The OpenCode button is named
"Check for OpenCode Runtime Updates" for assistive technology because About also
has a DevRyan update button. The host stopped cleanly (diagnostic status passed).
The "OpenCode Storage … layout is not the one DevRyan knows" notice predates this
upgrade: maintenance requires a `session_context_epoch` table that the native v2
schema does not have, and the 2.0.24 and 2.0.26 DDL hashes are identical.

## Pending acceptance

- Packaged Electron build and its About check were not run; the section is the
  shared UI component verified above.
- The skill-data lane (`--skill-data`) was not run.
- Live-provider, attended sign-in and Windows candidate checks were not run.
  Legacy Tauri and the Windows compatibility preview were unchanged.
- The Bot image is local and unpushed; release manifests take pushed digests.
