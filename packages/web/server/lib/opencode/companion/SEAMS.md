# DevRyan companion seams and execution audits

The companion patch changes OpenCode only where DevRyan needs a hook. This file
records the evidence behind each execution-tier decision, so an upstream bump
can re-check it against the new source.

## Control-process (native) built-ins

A tool runs in the control process only when every step of its built-in
implementation has no workspace side effect. The rule is keyed by object
identity in `tool/registry.ts`, so a custom or plugin tool with the same id
stays confined. Audited against OpenCode 1.18.31 (`014614d3`):

| Tool | Side effects in its execution path | Decision |
| --- | --- | --- |
| `read` | File and directory reads; `instruction.resolve` reads instruction files; LSP `touchFile` warm-up, which the patch disables in the control process (`tool/read.ts`) | Control |
| `glob` | Ripgrep file listing through the ripgrep service | Control |
| `grep` | Ripgrep content search through the ripgrep service | Control |
| `edit`, `write`, `apply_patch` | Writes, then formatter subprocess (`format.file`), file events, LSP diagnostics | Confined worker |
| `bash`/`shell`, `skill`, `lsp` | Arbitrary processes; skill scripts; language servers may execute project code | Confined worker |
| `webfetch`, `websearch`, `task`, `todo`, `question`, `plan` | Network or conversation state only | Control (unchanged) |

Re-check each row when the base changes. In particular, check any new
background work that `read` starts, and whether glob or grep gain a writer. An
added side effect moves the tool back to the confined worker.

## Worker boot

Worker input carries the control process's resolved configuration, so plugin
`config` hooks are already applied. Plugin `tool.execute.*` hooks run in the
control process around the dispatch. A worker for a built-in tool therefore
boots with `plugin: []`. Only a plugin-defined tool loads plugins, to resolve
its definition. No bundled or managed plugin uses `shell.env` (checked for the
1.18.31 profile); if one does, built-in shell workers must load it again.

## Deferred prototypes (measured decisions)

**Native (in-process) writes: not pursued.** After workers stopped loading
plugins, a confined `apply_patch`/`edit` worker boots in about 0.3–0.4 s at the
median (live OpenAI and xAI runs, 2026-09-24). Moving writes in-process would
save at most that. It would also require:
- a filesystem and publication contract for formatter subprocesses, which run
  unconfined in the control process;
- a contract for LSP diagnostics and file events;
- proof that in-process work has stopped writing, replacing the native
  termination receipt.

The risk outweighs the gain; revisit only if boot time regresses.

**Warm per-session views: not pursued yet.** On a 5,662-file repository, copying
view files is about 1 s of a confined call. The rest is ledger bookkeeping.
After lazy base runs and the adaptive index, the numbers are:

| Phase | Before | After |
| --- | --- | --- |
| Prepare | ~15–19 s | ~6.7 s |
| Publish | ~8–10 s | ~4.3 s |

Of the remaining prepare time, the pre-call observation is about 2 s:
- reading every file record, about 0.5 s;
- stamp checks and install, about 1.4 s.

A warm view would not remove that bookkeeping. Next measured targets, in order:
1. Cache parsed file records per immutable ledger tree ID; they are read up to
   three times per call.
2. Make observation event-driven, so an unchanged project skips the walk.
3. Only after 1 and 2, delta-advance a per-session view.

Benchmark: clone a repository into a temporary directory and time
`begin`/`finish` with `createSessionMutationRuntime`. The script used is in the
2026-09-24 session notes.
