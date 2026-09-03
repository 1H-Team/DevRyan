# OpenCode 1.18.27 upgrade

DevRyan's web/Electron host recommendation and VS Code runtime target move from
1.18.26 to 1.18.27. All four workspace SDK declarations use `^1.18.27`, and
`bun.lock` resolves that exact release. The managed profile, document-reader
dependency manifest, and packaged-config smoke gate pin the matching plugin.

The Bot container remains on its independently released and verified 1.18.26
image. Legacy Tauri profile dependencies remain frozen. This repository change
does not replace or restart an installed OpenCode process.

## Compatibility evidence

- Published [runtime](https://registry.npmjs.org/opencode-ai/1.18.27),
  [SDK](https://registry.npmjs.org/@opencode-ai/sdk/1.18.27), and
  [plugin](https://registry.npmjs.org/@opencode-ai/plugin/1.18.27) metadata were
  checked on September 3, 2026. SDK exports and its `cross-spawn` dependency are
  unchanged; the plugin's SDK dependency advances to 1.18.27.
- Exact source comparisons between the two official release tags found no
  changes in `packages/plugin/src/index.ts`,
  `packages/opencode/src/session/llm/request.ts`,
  `packages/opencode/src/tool/registry.ts`, or
  `packages/opencode/src/session/processor.ts`.
- The [release comparison](https://github.com/anomalyco/opencode/compare/v1.18.26...v1.18.27)
  changes provider header/chunk timeout defaults to 300,000 ms, handles SSE
  reader-cancellation rejections, and adjusts Anthropic thinking binding.
  The SDK now permits `chunkTimeout: false`. DevRyan's configured timeout
  values are not changed by this upgrade.
- Recovery retains support for 1.18.25 and 1.18.26 while adding 1.18.27.
  Unknown versions remain ineligible. Observe remains the shipping default.
- The isolated conformance fixture now uses the actual `headerTimeout` option
  and checks the existing native-retry fence explicitly: a retryable failure
  may require user attention, but must produce no second provider request and
  consume no automatic recovery attempt. Successful automatic recovery still
  requires exactly two requests, one attempt, and completed state.

## Validation

- `bun run type-check`, `bun run lint`, and `bun run build`: passed across
  workspaces. Existing large-chunk/eval build warnings remain.
- Harness suite: 136 passed. VS Code version/update bridge suite: 20 passed.
- Web suite: 3,283 passed and four timing failures across scoped-revert and
  Cursor SDK tests while other checks were running. An isolated rerun of both
  files passed all 92 tests. All changed web tests passed in the full web run.
- All five real-runtime conformance cases passed their explicit assertions:

  | Fault | Provider requests | Recovery attempts | Outcome |
  | --- | --- | --- | --- |
  | Heartbeat-only SSE | 2 | 1 | Recovery completed |
  | Missing headers | 1 | 0 | Native retry fenced; user attention |
  | Silent SSE | 1 | 0 | Native retry fenced; user attention |
  | Stalled non-SSE body | 1 | 0 | Native retry fenced; user attention |
  | Semantic progress cutoff | 1 | 0 | Progress timeout; user attention |

- `bun run test:full` stops in the existing agent-evaluation script suite:
  `completes terminal inspect and repair turns when orchestration is unavailable
  and empty` exceeds its 200 ms timeout during the aggregate run. Running
  `scripts/agent-evals/client.test.mjs` independently passes all 27 tests. The
  aggregate gate is not green; later workspace tests are not covered by it.

The fixture used a separately downloaded OpenCode 1.18.27 binary and temporary
configuration, with no user credentials or running application state. These
checks do not claim packaged native-shell acceptance or a rebuilt Bot image.
