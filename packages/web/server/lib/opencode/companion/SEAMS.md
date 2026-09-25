# DevRyan companion seams and execution audits

The companion patch changes OpenCode only where DevRyan needs a hook. This file
records the evidence behind each execution-tier decision, so an upstream bump
can re-check it against the new source.

## Control-process (native) built-ins

A tool runs in the control process only when every step of its built-in
implementation has no workspace side effect. The rule is keyed by object
identity in `tool/registry.ts`, so a custom or plugin tool with the same id
stays confined. Audited against OpenCode 1.18.31 (`014614d3`) and re-checked
against 1.18.32 (`545f51d2`): between those tags the only runtime changes are an
import refactor in `core/src/filesystem/search.ts` (ripgrep/fff entry types; no
new side effect in `glob`/`grep`), a Bedrock attachment check in
`session/message-v2.ts`, a Node-only resolver fix in `core/src/npm.ts` (the
companion runs on Bun) and a togetherai dependency bump:

| Tool | Side effects in its execution path | Decision |
| --- | --- | --- |
| `read` | File and directory reads; `instruction.resolve` reads instruction files; LSP `touchFile` warm-up, which the patch disables in the control process (`tool/read.ts`) | Control |
| `glob` | Ripgrep file listing through the ripgrep service | Control |
| `grep` | Ripgrep content search through the ripgrep service | Control |
| `edit`, `write`, `apply_patch` | Writes, then formatter subprocess (`format.file`), file events, LSP diagnostics | Confined worker |
| `skill` | Reads the selected skill Markdown, checks permission and lists at most ten supporting files with ripgrep; does not execute skill scripts | Control (companion 2.1.1) |
| `bash`/`shell`, `lsp` | Arbitrary processes; language servers may execute project code | Confined worker |
| `webfetch`, `websearch`, `task`, `todo`, `question`, `plan` | Network or conversation state only | Control (unchanged) |

Re-check each row when the base changes. In particular, check any new
background work that `read` starts, and whether glob or grep gain a writer. An
added side effect moves the tool back to the confined worker.

### Direct receipts (companion 2.1.0)

Because the control-tier `read`, `glob`, `grep` and built-in `skill` have no workspace side
effect, they skip the reserved-lease protocol (`begin`, `prepare-poll`,
`claim`, `finish`: four host round trips and four ledger commits). The
companion asks for a lock-free `direct-admit` (a snapshot read: session not
reverting, call not cancelled, generation), runs the tool in-process, and
withholds its result until `direct-finish` records the reservation and its
publication in one locked commit. That commit is fenced by the admitted
generation (a revert in between discards the result) and by cancellation, and
is idempotent per session and call. Nothing is recorded before the read, so a
crash in between leaves the call `uncertain` for provider recovery, exactly as
a missing lease does. Any admission failure falls back to the reserved-lease
protocol, which stays the authority for every refusal. Selection is by
built-in object identity (`DevRyanExecution.direct`); the host also checks the
tool name. Kill switch: `DEVRYAN_DIRECT_CONTROL_RECEIPTS=0` on the host.

### Skill loading (companion 2.1.1)

The previous audit grouped loading skill Markdown with executing its scripts.
The pinned `tool/skill.ts` only resolves a catalog entry, asks for `skill`
permission, and lists support files using `rg --no-config --files` without
following symlinks. Loading therefore uses the same native/direct path as the
other audited readers. A custom tool named `skill` remains confined by object
identity; later shell commands from a skill remain confined too.

The native loader rereads only the selected Markdown after permission, using
OpenCode's frontmatter parser and rejecting a changed name. This preserves the
worker's fresh content on explicit reload without rediscovering the catalog.
The built-in embedded skill keeps its embedded content. Plugin hooks, agent
visibility, permission decisions and logical support-file paths remain native.
`DEVRYAN_NATIVE_READ_TOOLS=0` restores confined loading;
`DEVRYAN_DIRECT_CONTROL_RECEIPTS=0` falls back to a reserved control lease.
Completion still waits for the cancellation/generation-fenced durable receipt.

## Worker boot

Worker input carries the control process's resolved configuration, so plugin
`config` hooks are already applied. Plugin `tool.execute.*` hooks run in the
control process around the dispatch. A worker for a built-in tool therefore
boots with `plugin: []`. Only a plugin-defined tool loads plugins, to resolve
its definition, and since companion 2.1.0 only its owning plugin plus plugins
that register a worker-side hook (`shell.env` or `auth`); a tool file loads just
the latter (`DevRyanExecution.workerPlugins`; `DEVRYAN_WORKER_OWNING_PLUGIN=0`
loads every plugin again). Audit (2026-09-24): no bundled plugin registers
`shell.env`; `devryan-openai-oauth.mjs` registers `auth`; `event`, `chat.*`,
`experimental.*` and `tool.execute.*` hooks run in the control process around
the dispatch. If a bundled or managed plugin adds `shell.env`, built-in shell
workers must load it again.

### Language servers in workers (companion 2.1.0)

With OpenCode `lsp` enabled, `edit`, `write` and `apply_patch` open the file in
every matching language server and wait up to 5 s for its diagnostics. The
worker's cache is its scratch home, empty on every call, so before 2.1.0 each
edit of a JS/TS file in a project that resolves `eslint` downloaded the
vscode-eslint `main` branch from GitHub and ran its `npm install` and
`npm run compile` (install scripts included), and reinstalled
`typescript-language-server` from npm. Measured on a one-file TypeScript
fixture: p50 27.8 s per edit, against 0.53 s for a warm unconfined server and
1.6 s with LSP disabled.

- The host sets `OPENCODE_DISABLE_LSP_DOWNLOAD=true` for every confined worker
  (`session-execution.js`). Download-backed servers (ESLint, and others whose
  binary is not already on `PATH` or in the project) no longer start in a
  worker. Host kill switch: `DEVRYAN_WORKER_LSP_DOWNLOAD=1`.
- The control process installs `typescript-language-server` once with
  OpenCode's npm service, which runs with `ignoreScripts`, so nothing downloaded
  executes outside the sandbox. The worker links that package into its scratch
  cache and executes it confined; the sandbox leaves it read-only. Only built-in
  edits of JS/TS files (and `apply_patch`/`lsp`) with the default `typescript`
  server request it, and the handoff waits for a first install for at most 20 s.
  Companion kill switch: `DEVRYAN_WORKER_LSP_SHARED=0`.

TypeScript diagnostics are unchanged: the worker still starts `tsserver` from
the project's own `typescript`, cold, for each edit. A persistent confined
language server per project would remove that cold start but needs a design
for views that change per call; it is not built.

### Unmatched routes (companion 2.1.0)

A DevRyan-managed server sets `DEVRYAN_OPENCODE_UI_DISABLED=1`, and the
catch-all `uiRoute` then answers 404 instead of proxying the path to
app.opencode.ai (or serving `index.html` with status 200 when a web UI is
embedded). The host's `/api` route guard (`opencode-routes.js`) rejects unknown
paths before they reach OpenCode; this closes the gap for any other caller.
Host kill switch: `DEVRYAN_OPENCODE_UI_BLOCK=0`.

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

**Warm per-session views: not pursued.** The earlier estimate attributed
the per-call cost on a 5,662-file repository to per-file bookkeeping. A
per-phase Git-spawn profile (2026-09-24) showed otherwise: every ledger commit
ran `git read-tree` over a store of about 27,700 **loose** objects (nothing
ever packed it), at about 0.6 s each and about ten commits per call, and
`ls-tree -l`/`cat-file` paid one filesystem lookup per object too. Packing the
store (`git repack`) cut `read-tree` to about 40 ms. The ledger now:
- packs its Git objects in the background once 1,000 are loose (and right
  after a first build), consolidates packs and prunes unreachable objects older
  than two hours; never under the ledger lock (`DEVRYAN_LEDGER_PACK=0`);
- skips listing a just-created document's empty prefixes, so a first build no
  longer spawns about three `git ls-tree` per file, and carries its parsed
  state across install batches while no other writer commits
  (`DEVRYAN_LEDGER_FAST_INGEST=0`);
- caches parsed file and operation records by immutable subtree identity
  (`DEVRYAN_LEDGER_RECORD_CACHE=0`), shared with the snapshot listing
  (`DEVRYAN_LEDGER_SNAPSHOT_REUSE=0`), and reads records in fewer, larger
  batches;
- memoizes symlink checks of ancestor directories within one observation pass
  (`DEVRYAN_LEDGER_ANCESTOR_MEMO=0`); the install step re-stamps changed files
  without the memo;
- builds a missing ledger in the background when a project opens
  (`DEVRYAN_LEDGER_PREWARM=0`).

Measured on a clone of this repository (5,677 files, `scripts/perf/ledger-benchmark.mjs`,
alternating arms):

| Phase | Before | After |
| --- | --- | --- |
| First confined call (ledger build) | 174-206 s | about 70 s, or none after a background build |
| Warm call: prepare (`begin`) | 6.0-6.7 s | 1.8-2.0 s |
| Warm call: publish (`finish`) | 3.5-3.6 s | 0.8-0.9 s |
| Control call (four RPCs) | 3.5-3.7 s | about 0.7 s |

Watcher-driven observation stays a design gate: Node's `fs.watch` cannot
report dropped FSEvents, so silence cannot prove an unchanged workspace. A
warm per-session view would now save well under a second and is not pursued.
