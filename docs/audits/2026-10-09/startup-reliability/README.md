# Startup reliability investigation — 2026-10-09

The stale-owner wait, startup health reporting, renderer polling and native
diagnostics were implemented on this date. The original installed model-catalog
HTTP 500 was not reproduced or repaired during that investigation.

The [2026-10-10 follow-up](../../2026-10-10/model-catalog/README.md) now reproduces
the exact selected controller failure with a synthetic retired OpenAI
`chatgpt-browser` credential and repairs catalog startup without changing stored
credentials. Diagnostics identify `openai_method_unsupported` when the repair is
omitted. Runtime preparation also activates repaired host artifacts at the same
OpenCode version. The follow-up records current validation and packaged timing;
this document retains the original observations below.

## Observed incident

Read-only inspection of the installed DevRyan 2.0.4 startup log showed:

- 21:13:52.966 Asia/Dubai: foreground startup.
- 21:14:58.388: ownership recovery established `process_absent`.
- 21:14:58.421: guarded app-bound fallback after
  `runtime_service_owner_stale` and `not_registered`.
- 21:15:31.868: native bundle upgraded from 2.0.20 to 2.0.26.
- 21:15:37.835: web listener ready.
- 21:15:50.501: native model catalog failed with
  `native_catalog_read_failed_model_http_500_cause_unavailable`.

The installed health endpoint confirmed native startup was not ready. The
diagnostic status/gap check reported zero gaps but no recorded startup events;
it could not explain this failure. The selected installed native core/host
digests matched the repository's original 2.0.26 candidate. The installed app,
selection, conversations and credentials were not changed.

## Implemented behavior

- A stale service descriptor triggers an immediate zero-timeout ownership
  inspection. Only positively stopped ownership ends retries early. Live,
  replaced and unverifiable owners retain the existing protections, including
  rechecks before recovery and transactional acquisition.
- Bootstrap and lease HTTP requests use bounded signals within the connection
  deadline. Lease acceptance schedules native startup without awaiting it;
  refreshing the lease does not silently retry a terminal startup failure.
- `/health` adds `openCodeStartup` with state, attempt and sanitized code.
  Shared lifecycle transitions reject superseded results. Manual Retry cancels
  the previous UI attempt before restarting.
- One deduplicated health poll runs at a one-second cadence with a three-second
  request timeout and a 120-second overall limit. A reported terminal failure
  ends polling immediately. Older servers remain supported; provider loading
  still precedes agent loading.
- Native construction/catalog requests have isolated error reporters and fixed
  failure-stage categories. Startup failures before binding, bound/ready times
  and controller exits are journaled without raw errors or configuration data.
- Electron and bundle-upgrade logs expose phase durations. The splash describes
  active preparation, connection and recovery operations.

## Catalog investigation

[Model-shape evidence](model-shape.json) records successful compiled startup
with all 282 sanitized Cursor model rows, explicitly checking that every model
was present and the provider connected. Both the original and diagnostic-enabled
2.0.26 builds passed. Labels, endpoints, prompts and credentials were excluded
from the captured fixture.

[Compiled upgrade evidence](compiled-upgrade.json) records active synthetic
OpenAI, Cursor and Copilot accounts across a real 2.0.20 → 2.0.26 clone/selection
path, with model catalogs verified in two directories. Discovery used a local
HTTP fixture; the test fetch boundary refused external HTTP/HTTPS.

The first run passed all 35 functional cases but failed its source-cohort guard
because the startup-upgrade timing file changed during execution. The frozen
rerun passed startup/catalog and 28 cases, then timed out in an unrelated
interview-state request. Neither run is claimed as a fully passing composition
preflight. Both cleaned their owned processes successfully.

These results rule out the tested configuration shapes and healthy synthetic
account upgrade path. They do not establish parity with installed account state
or a live provider's model-discovery response. The next incident needs the new
fixed-stage diagnostic; manufacturing malformed fixture data would not prove
the original cause.

## Validation

`bun run validate:full` was run and completed in segments after corrections:
workspace lint, type checks, script tests, visual fixtures and all package suites
were exercised. The initial command was not a clean exit-zero run.

- Added the diagnostics helper and its refusal dependency to the Bot image copy
  list after the closure test exposed the missing packaging inputs; all 50 Bot
  runtime tests passed on rerun.
- Updated two Electron source-contract assertions for the timing wrapper and
  active splash text; their 13-test rerun passed. The other 386 Electron tests
  passed in the full run.
- Two unchanged legacy Tauri tests exceeded their short readiness windows;
  both passed serially without code changes. The other 37 passed initially.
- UI's main batch passed 4,077 tests, plus the separately isolated UI batches.
- Web Vitest passed 6,551 tests initially; three unchanged five-second fixtures
  timed out. All three passed in a focused serial rerun with unchanged limits.
  The remaining 14 Bun native tests also passed.
- `bun run build`, native controller builds and `bun run bundle:check` passed.
  Packaged Electron SQLite and PTY smoke checks passed.

No dependency, legacy Tauri feature, installed-app update or release was made.
The Docker image itself, signing/notarization and live-provider calls were not
verified.

## Packaged measurements

Three [app-bound launches](app-bound.json) passed: 16.820, 13.724 and 14.192
seconds to usable chat (median 14.192 seconds). Each observed the renderer's
actual global-ready WebSocket acknowledgment and exact fixture selection.
The [retained screenshot](app-bound.png) was visually inspected.

Three [first launches after upgrade](first-upgrade.json) passed: 32.095, 31.174
and 31.170 seconds (median 31.174 seconds). Each used the production empty-source
initialization, upgraded the actual selected 2.0.20 bundle to the exact packaged
2.0.26 manifest, changed revision 1 to 2, preserved the previous bundle and
reached usable chat. The [upgrade screenshot](first-upgrade.png) was visually
inspected. The fixture correction passed 20 focused tests.

Three [direct headless service launches](headless-service.json) passed with
listener times of 4.799, 4.850 and 4.935 seconds (median 4.850 seconds). Each
rejected unauthenticated bootstrap/handshake requests, made zero model-provider
requests and physically stopped its owned process tree. These numbers do not
measure foreground attachment or native-model readiness.

All final timing runs were sequential and separate from builds, validation and
cache scans. They are fresh-process measurements with ordinary operating-system
caches; the earlier installed failure is not a comparable successful baseline.
The Bun runner emitted a `tsconfig.json` directory-mismatch diagnostic at exit;
the runs themselves exited zero, completed all assertions and cleaned their
owned processes. No success is inferred from that diagnostic.

The [initial measurement attempts](measurement-attempts.json) are retained
separately: one invalid artifact location, one incomplete transport observer,
and an upgrade fixture rejected for its legacy database layout. They are not
included in passing launch statistics. The observer was corrected to cover
the real renderer WebSocket acknowledgment and the private app's log path;
12 focused tests passed.

The harness uses fresh processes and private profiles with a local model
fixture. It requires native health, the exact model/agent selection, sessions,
an enabled composer and the renderer's global event-stream readiness acknowledgment.
It never reloads the first document to obtain a passing result.

Foreground warm-service, cold-service and stale-owner launches remain
unavailable: the isolated package deliberately disables OS service registration,
and the production macOS service label is shared with the installed app. The
deterministic ownership/retry tests cover these branches, but do not supply
packaged timing measurements. Direct headless service startup is a separate,
narrower check and does not establish usable chat or desktop-lease readiness.

## Cleanup

Sanitized JSON and two inspected screenshots are retained here. Superseded QA
packages, preliminary native builds, failed upgrade retries and failed benchmark
fixtures were removed. No worktree was created. The final QA package remains
available for reproduction; no installed application was replaced.

`cache:report` and preview-only `cache:prune` were run. The preview was not
applied to unrelated artifacts. The report initially showed 55.58 GiB; after
task-owned cleanup the preview measured 50.02 GiB before removal of the remaining
failed benchmark fixtures. Existing worktrees, native donors and other tasks'
artifacts were preserved.
