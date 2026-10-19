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

Interview documents are written only by the original document functions inside
the host's confined worker; the service reaches them through
`InterviewDocuments` (`src/interview/owned-documents.ts`).

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
