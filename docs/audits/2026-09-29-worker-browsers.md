# Headless Chromium in confined workers (2026-09-29)

## Trigger

The diagnostic journal for 2026-09-28 (session `ses_f1726c239ffe…`) shows a project's `npm run verify:page` failing inside a confined shell call:

- `browserType.launch: Executable doesn't exist`, because the worker's `HOME` is its per-call scratch directory, so Playwright never looked in `~/Library/Caches/ms-playwright`.
- An agent then downloaded Chromium (about 179 MiB) into `.artifacts/`. That browser aborted with `GPU process launch failed: error_code=1003 … GPU process isn't usable. Goodbye.`
- The abort matches `~/Library/Logs/DiagnosticReports/chrome-headless-shell-2026-09-28-204632.ips` (SIGTRAP).

## Probe

Headless shell `chromium_headless_shell-1243` from the host cache ran under the real native launcher, through `/bin/sh -c 'exec node …'` (the way `npm run` starts scripts), using both an attached and a detached Node spawn.

| Stage | Launcher / profile | Result |
| --- | --- | --- |
| 1. Current | 2026-09-28 adapter, current profile | The spawn adapter was missing after `/bin/sh`, which strips `DYLD_*`. Chromium's `posix_spawn` of its helpers was denied, and it aborted with `error_code=1003` (SIGTRAP), reproducing the journal. |
| 2. Adapter restored | Adapter returns `ENOSYS` for new process groups and sessions, and handles `addchdir`/`addfchdir`; `NODE_OPTIONS` preload added | Helpers started, including from a detached spawn. They then failed at `bootstrap_look_up org.chromium.Chromium.MachPortRendezvousServer.<pid>: Permission denied (1100)`. |
| 3. Rendezvous allowed | Stage 2 plus one `(allow mach-lookup (global-name-regex …MachPortRendezvousServer…))` | `--dump-dom` rendered the marker (attached and detached). The CDP pipe answered `Browser.getVersion` with `HeadlessChrome`. |

**Text rendering:** screenshots of `AAAA` and `BBBB` taken inside the sandbox were byte-identical to the same renders taken outside it. Text draws without the `com.apple.fonts` service, so that service stays denied.

## Acceptance

`DEVRYAN_TEST_EXECUTION_LAUNCHER=<candidate> node --test scripts/verify-session-execution.mjs` passed 13 of 13 tests with the candidate adapter, including three new or tightened ones:

- the detached-spawn child now starts and is still stopped before the receipt;
- Node started through `/bin/sh` regains the adapter and keeps its child's working directory;
- the headless Chromium CDP and text probe.

## Boundary

- **New permission:** the only one added is the Chromium rendezvous lookup, and only for session-scoped macOS executions; provider transports never get it.
- **Browser cache:** it stays unwritable.
- **Adapter:** it adds no authority, and still fails closed if it is removed.
- **Process groups:** `setsid`/`setpgid` stay denied, so the supervisor still owns every descendant.
- **Kill switch:** `DEVRYAN_WORKER_BROWSERS=0` restores the previous environment and profile.
- **Unsupported:** WebKit, Firefox, the Google Chrome channel, headed mode and `chromiumSandbox: true`.
