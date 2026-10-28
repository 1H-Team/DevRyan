# Agents core

`@devryan/agents-core` is DevRyan's built-in agent orchestration: the
orchestrator and its specialists, presets and model routing, the task board,
commands (`/deepwork`, `/loop`, `/reflect`, `/interview`), web fetch and AST
search. It is owned source derived from Oh My OpenCode Slim v3.0.4 (MIT, see
`NOTICE`). It is not a plugin and is always active; users never see the Slim
name. `UPSTREAM.md` records the base, what was removed, DevRyan's behaviour
changes and every ported upstream fix.

## Boundary

- `src/devryan/index.ts` is the only entry point. The native build bundles it
  from source into the controller and the Node configuration asset
  (`runtime-host/reviewed-configuration-entry.ts`).
- `index.d.ts` is the declared surface the runtime host compiles against.
  `src/devryan/surface-check.ts` proves at compile time that the implementation
  is assignable to it. The default export's `setup` is the exception: it is
  written against upstream's structural v2 context types (`src/v2/types.ts`),
  and the host's restricted context plus the native agents-core lanes verify it
  at runtime.
- Change a declaration and its implementation together; `bun run type-check`
  fails when they drift.

## Authority

The package performs no ambient I/O. `src/devryan/owners.ts` holds every seam,
and each fails closed when unbound:

- `bindReviewedSlimHost`: per location, the v1 hook factory, log sink and
  interview bridge. `utils/logger.ts` writes only to these sinks (never a file
  or stderr), after redaction.
- `bindReviewedSlimConfiguration`: the frozen, already merged
  `devryan-agents.json[c]` configuration and active preset. The loader reads
  nothing from disk or the environment.
- `withReviewedSlimPathOwner`: invocation-local stat/realpath/read for the
  apply-patch, path-rescue and search-path hooks.
- `withReviewedWebfetchOwner`: network, grant-scoped cache, DOM loading,
  binary publication and the secondary model call for one web fetch.
- `bindReviewedAstGrepAsset` / `bindReviewedSlimImageWorker`: confined worker
  only, after manifest verification, with the private view as process cwd.

`formatReviewedSlimTaskBoard` renders the host's managed children in
`devryan_task` mode. Rows are addressed by task ID, guidance names only the real
actions (wait/wait_any, read_result, continue, retry/resume/abandon), and each
row shows its label, never the delegated prompt. `now` only filters aged rows;
the rendered text holds no time. Slim's own `task`/`subagent` wording is unchanged.

Interview documents are written only by the original document functions inside
the host's confined worker; the service reaches them through
`InterviewDocuments` (`src/interview/owned-documents.ts`).

## MCP elicitation questions

`src/v2/event-adapter.ts` synthesizes v1 `question.asked/replied/rejected`
for a `global` MCP elicitation form only under the session DevRyan's host
stamped in `metadata.devryan.sessionID`, so the input-wait tracker and the
orchestrator see the turn waiting. The attribution is remembered per form
(bounded, consumed on resolution) because the settled events carry only the
`global` owner. Unattributed forms stay unsynthesized.

## System parts and compaction

The v2 shim passes the host's system parts to the v1 system transform as both
strings and `parts` (`applySystemTransform` in `src/v2/setup.ts`). A transform
that keeps them in step keeps each part's `cache` and `metadata`; any other edit
falls back to bare text parts. The compaction bridge applies the same transform
as the context hook, so the summary request keeps the normal request's cached
system prefix. `collapseSystemPartsInPlace` joins only neighbouring parts with
the same cache marker. The runtime host owns the kill switch
(`runtime-host/DOCUMENTATION.md`, "Prompt cache through compaction").

The stable phase reminder requires Orchestrator to verify changed behavior before
accepting child work and to continue its objective and unfinished checks through
host-owned automatic compaction. It does not delegate acceptance to Designer or
create another compaction/continuation loop.

## Bundled skills

Only `src/skills/deepwork/SKILL.md` is compiled in (the `/deepwork` prompt
inlines it). The other skill directories are retained upstream data: nothing
registers them, because DevRyan's skill owner, not this package, decides which
skills agents see.

## Tests

`bun test` runs the upstream algorithm tests that apply plus DevRyan's owner
tests. `test/preload.ts` installs filesystem/fetch test owners and points the
XDG and OpenCode directories at a temporary root, so no test touches the real
user configuration. `bun run validate` type-checks and tests the package when it
changes and re-checks the web package that depends on it.

## Porting upstream fixes

See "Porting upstream agent fixes" in `docs/PLUGIN_UPGRADES.md`.
