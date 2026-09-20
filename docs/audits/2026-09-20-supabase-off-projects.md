# Supabase Off: implementation and acceptance evidence

Date: 2026-09-20. This report separates the About fix, tunnel authentication, and
the local-bot feasibility gate. Changes are in the working tree; no installed
application, cloud configuration or release was changed. Existing user volumes
were preserved; recovering the already-stopped Docker Engine resumed its existing
containers. No import reads were made.

## 1. About control

Implemented independently of Bots and tunnels:

- The web adapter distinguishes 401, 403, 404, temporary HTTP failure, malformed
  status and network failure. It no longer converts authorization failures to null.
- The mounted control remains visible while loading or failing, with an
  explanation and Retry. Only authoritative, configured status enables changes.
  Missing capabilities and older adapters returning null display an unsupported
  runtime explanation. No Tauri native feature was added.
- A never-configured host returns a fixed, redacted Not configured status only
  for a strict direct-local GET. That request neither enrolls an owner nor enables
  PATCH. Configured-Off hosts retain existing owner authentication.
- Saved configuration and connection preference are retained. Failed On startup
  retains the managed authentication policy, independently of cloud availability.

The earlier installed-app observation was GET connection status 403, session
status 200 with local-admin, and health control-plane state disabled. Disposable
Express tests reproduce the 403 adapter failure and separately verify the
unconfigured redacted GET and configured-Off owner path. The installed application
has not been rebuilt or replaced as part of this task.

Acceptance files:

- `packages/web/src/api/supabaseConnection.test.ts`
- `packages/ui/src/components/sections/openchamber/SupabaseConnectionSettings.mounted.test.tsx`
- `packages/web/server/lib/multi-user/connection-routes.test.js`
- `packages/web/server/lib/multi-user/supabase-connection.test.js`

## 2. Bot-only tunnel authentication

The production authority is `server/lib/tunnels/access-control.js`, initialized
before private capabilities, the disconnected boundary and feature routes. It
shares the raw socket/Host/Origin locality check with owner authentication. Any
Forwarded, X-Forwarded-* or CF-* header excludes direct-local authority.

Grants carry explicit non-administrator principals, selected Bot IDs and a fixed
expiry. Route authorization defaults to denial; allowed Bot routes still require
membership and channel access. Catalogs, action/run reads and SSE intersect these
permissions. Host sessions, terminals, filesystem/Git, imports, credentials,
previews, tunnel control, authentication administration and native capabilities
are excluded. Bot computer viewing uses its existing opaque viewer IDs and channel
authorization, not the host preview proxy.

GET link previews consume nothing. An explicit Connect action POSTs a fragment
token with same-origin and CSRF checks. Links expire within 15 minutes; hashed
session credentials persist for seven fixed days in the private encrypted vault.
Authorization binds owner, hostname, durable profile and generation. Ordinary
restart resumes the saved managed connector and sessions; Stop, revocation,
global authentication reset, ownership/authentication policy changes (including
local password protection being enabled or disabled) and hostname changes revoke access and
close active streams. Installation/tunnel rate buckets do not trust forwarded IPs.
Invalid or incomplete authorization storage fails closed.

Electron's authenticated native bootstrap enrolls a never-configured owner.
Standalone web uses `openchamber enroll-owner --port <port>` with the matching
data directory, followed by a two-minute loopback-only exchange. Subsequent CLI
tunnel commands prove filesystem ownership without implicitly enrolling an owner;
their cookie stays in memory. Merely visiting localhost grants neither owner
enrollment nor tunnel control.

The shared UI has Bot selection, new-link creation and grant revocation. Tunnel
guests mount the Bot interface and use a grant-specific browser storage namespace.
The previous source-text tests asserting that missing Supabase must disable Start
were replaced by a route behavior regression proving both managed-account and
enrolled-owner starts.

Acceptance is exercised in
`packages/web/server/lib/tunnels/access-control.test.js`,
`packages/web/server/lib/tunnels/routes.test.js`, and
`packages/web/server/lib/multi-user/local-owner-bootstrap.test.js`:

| Boundary/lifecycle | Evidence |
| --- | --- |
| HTTP API and SSE | On/Off/absent installations; forged/missing credentials, raw-Host and forwarded-header spoofing, foreign origins, restricted catalog/channel access, active SSE closed on revocation |
| Terminal WebSocket | Real terminal upgrade handler behind the early boundary; password-free local auth cannot mint remote authority |
| OpenCode WebSocket | Real event-stream upgrade handler; guest, missing, forged and revoked credentials denied |
| Preview HTTP/WebSocket | Real preview proxy registration; host preview requests rejected before upstream access |
| Private capabilities | Desktop and runtime-service paths reject before handlers; admitted Bot HTTP does not require a native service cookie |
| Link lifecycle | GET preview, explicit POST, origin/CSRF, single use/replay, finite expiry, bounded rate limiting |
| Persistence | Vault reload after restart, connector suspension/recovery, fixed session expiry, hostname/Stop/owner/auth-mode invalidation, malformed state rejection |
| Enrollment | No implicit localhost enrollment, filesystem proof expiry/replay, native bootstrap reuse, missing key/vault rejection, CLI owner proof |
| Outage | Failed On startup remains On; remote access fails closed until policy is explicitly changed and restarted |

An isolated loopback fixture serving the built web bundle was opened in a browser.
Its Bot guest page rendered only the Bot workspace sidebar and conversation area,
without host navigation. After authentication, its request trace contained only
Bot API/event traffic and session rechecks; legacy pre-authentication reads of
themes, session folders and passkey status were rejected. This checks the shared web UI, not live Cloudflare or
Docker execution. Native Electron enrollment and a legacy Tauri binary were not
exercised on the installed app.

## 3. Local Bots: feasibility gate passed after prerequisite repair

The initial attempt stopped because Docker did not respond and the Supabase CLI
was absent. The follow-up installed Supabase CLI **2.117.0** through the official
Homebrew tap and recovered Docker Desktop's stale control processes. The Docker
VM had already shut down gracefully before recovery; its logs and absence of a
virtualization process established that no running Engine was stopped. No Docker
reset, prune, user-volume deletion or installed-app configuration change occurred.
The existing containers resumed when the Engine started.

The isolated spike is reproducible from
[`scripts/local-bots-spike/README.md`](../../scripts/local-bots-spike/README.md).
It used fresh fixture identities and separate Docker projects. Supabase remained
Off in the application. No cloud project, Chrome login, production credentials or
import reads were needed.

| Gate | Evidence |
| --- | --- |
| Supporting schema and identity prerequisites | Four roles (`anon`, `authenticated`, `service_role`, `authenticator`), pgcrypto, private identity references and bucket metadata; test-only pgTAP; two unchanged profile migrations |
| Existing business rules | All 30 Bot migrations replayed byte for byte on PostgreSQL 17.9; per-file SHA-256 recorded in `migration-manifest.json`; 37 Bot tables and two audit views, all 37 tables force RLS |
| Existing SQL tests | Same 10 Bot SQL files passed on both PostgreSQL/PostgREST and disposable Supabase: **584 assertions per backend** |
| Supabase baseline | `supabase test db --local` passed all **13 files / 655 assertions** in the disposable project; no linked project |
| Three repository consumers | Identical live contract imports `bots/store.js`, `bots/telegram/store.js` and `bots/audit-query.js`; 11 groups per backend passed under Node 26.0.0 and Bun 1.3.14, including every declared Bot projection, concurrent writes, run/Telegram leases, ACLs and audit pagination |
| Encrypted files | Existing AES-GCM blob implementation uploaded/decrypted through the local directory adapter and real Supabase Storage; opaque identities and ciphertext unchanged; traversal, symlink, overwrite and size-bound tests passed |
| Private access | PostgreSQL has no TCP listener; kernel-verified Unix peer mapping authenticates only the unprivileged PostgREST identity; administrator impersonation rejected; signed server-only JWT required; all HTTP test listeners explicitly bound to 127.0.0.1 |
| Images and architectures | Digest-pinned PostgreSQL 17.9 and PostgREST 14.5 manifests include Linux ARM64 and AMD64; execution verified on ARM64; comparison CLI stack uses Supabase PostgreSQL 17.6.1.167 and PostgREST 16.2 |
| Startup and resources | One cached-image sample: fresh PostgreSQL initialization **3,966 ms**, warm database/API restart **7,140 ms** with records preserved; observed PostgreSQL **40.57 MiB**, PostgREST **10.52 MiB**; not a production capacity guarantee |
| Backup and restore | Quiesced writer, PostgreSQL custom dump, complete encrypted-object inventory and checksums; restored into a fresh database, verified fingerprints for **all 37 Bot tables** and ciphertext for all three fixture objects, decrypted the retained recovery fixture, rejected wrong key/corruption, then marked backup usable |
| Database diagnostics | Local Supabase security advisors: **no issues**; SQL lint: no errors, four existing unused-parameter/variable warnings |

Supabase startup revealed that Docker Desktop ignored the bridge's default
host binding when the CLI left `HostIp` empty. The affected fixture
listeners were stopped, and the runner now sets explicit loopback bindings at
container creation through an invocation-scoped private Unix proxy. It verifies
all listeners before continuing. This does not change Docker's global settings.

The live contract exposed and fixed an existing audit pagination bug: issued
cursors contained PostgREST offset timestamps while the cursor reader accepted
only `Z`. The reader now accepts validated offsets and retains microseconds.
Thirteen audit-query regression tests pass. Concurrent duplicate message admission
can return SQLSTATE 23505 with the existing RPCs in either backend; the contract
verifies one commit and an idempotent subsequent replay, without changing SQL.

All disposable stacks were stopped after verification; their named volumes,
verified snapshot and private evidence remain available for review. No installed
app containers or volumes were removed. The experiment adds no JavaScript
dependencies and makes no SQLite substitution.

This clears the feasibility decision for PostgreSQL/PostgREST. The experiment is
not the production local backend: startup backend selection, imports, cache
rebuilding, Telegram host locking, scheduled verified backups, upgrades and
owner-facing recovery remain the next implementation stage. Existing Bot UUIDs,
host volumes and Chromium profiles were not changed or imported.

Evidence under `.cache/local-bots-spike/` includes `database-tests-final.log`,
`supabase-test-db.log`, `repository-contract.log`, `repository-contract-bun.log`,
`encrypted-files-tests.log`, `secure-local.log`, `backup-restore-result.json`,
`measurements.json`, `supabase-db-lint.log` and `supabase-advisors.log`. Generated
fixture credentials are private and must not be committed or included in reports.

## Validation record

The pre-change 4-file/69-test baseline from the plan establishes old behavior,
not the security of these changes. Targeted post-change commands include:

```sh
bun run --cwd packages/web test \
  src/api/supabaseConnection.test.ts \
  server/lib/multi-user/connection-routes.test.js \
  server/lib/multi-user/supabase-connection.test.js
bun run --cwd packages/ui test src/components/sections/openchamber/SupabaseConnectionSettings.mounted.test.tsx
bun run --cwd packages/web test \
  server/lib/tunnels/access-control.test.js \
  server/lib/multi-user/local-owner-bootstrap.test.js \
  server/lib/tunnels/routes.test.js
bun run validate:full
bun run build
bun run bundle:check
bun run docs:validate
```

About/tunnel implementation results recorded before the feasibility follow-up:

| Check | Result |
| --- | --- |
| About project full validation | Passed before tunnel implementation; `.cache/supabase-off-about-validation.log` |
| Final `bun run validate:full` | Exit 0; workspace lint, type checks and deterministic suites passed, including Electron and legacy desktop checks; web suite: 386 files, 4,164 tests; `.cache/supabase-off-release-validation.log` |
| Final `bun run build` | Exit 0; web production bundle and Electron main bundle built; `.cache/supabase-off-release-build.log` |
| Final `bun run bundle:check` | Exit 0; web startup gzip 1,390,915 bytes within the 1,456,388-byte budget; `.cache/supabase-off-release-bundle-validation.log` |
| `bun run docs:validate` | Passed, with existing repository warnings about generated or missing historical references |
| `git diff --check` | Passed |
| Browser fixture | Final Bot-only layout verified; temporary tab and both fixture servers closed |
| Local database feasibility | Passed in the isolated follow-up; see section 3 and the reproducible spike runner |

Live Cloudflare reachability, native enrollment and installed Tauri runtime checks
remain unperformed. Docker and disposable database parity were subsequently
verified by the isolated feasibility spike; that evidence does not establish
production local-backend integration or installed-app acceptance.

### Feasibility follow-up validation

The follow-up adds the disposable spike and the shared audit cursor fix. The
database feasibility checks pass, but **the working tree's full validation is
not green**. No assertions or timeouts were relaxed.

The first full run passed lint/type checks but hit the two-second child-readiness
timeout in `scripts/dev.test.mjs`; that suite then passed all 11 tests. A second
default-concurrency run hit a 200 ms evaluation deadline in
`scripts/agent-evals/client.test.mjs`. With the runner's supported single-worker
setting, all 644 script tests passed. That attempt then encountered an aborted
connection in the private gateway relay fixture; the complete egress suite
subsequently passed all 32 tests.

The last full attempt passed lint, type checks, all 644 script tests and the
gateway suite, but failed one test outside the spike changes:
`packages/harness-runtime/lib/session-mutations.test.js:363`,
"publication preserves private permissions and later permission changes retain
ownership". The execution-view file had mode `0644` instead of `0600`.
The harness result was 359 passed / 1 failed. Running that one test in isolation
then passed; this does not turn the failed full run into a pass.

```sh
DEVRYAN_SCRIPT_TEST_CONCURRENCY=1 bun run validate:full
bun test packages/harness-runtime/lib/session-mutations.test.js \
  --test-name-pattern 'publication preserves private permissions'
```

Full-run evidence is `.cache/local-bots-spike/validate-full-final-serial.log`;
the isolated permission result is `permissions-retry.log` in the same directory.
The audit cursor suite passed 13 tests and encrypted-file checks passed 3 tests.
The spike and cursor fix change no runtime packaging inputs. The full-run
permission failure remains a release-validation limitation, separate from the
successful database feasibility decision.

The remaining `test:full` package commands were then run sequentially and exited
0: `orchestration-runtime`, `cursor-sdk-runtime`, `electron`, legacy `desktop`,
`ui`, and `web`. The UI's main suite passed 3,691 tests; the web suite passed
**387 files / 4,167 tests**. Partial command-output captures are retained as
`remaining-tests-*.log`; the final web result is in `remaining-tests-07.log`.
`bun run docs:validate` passed with existing historical-reference warnings, and
`git diff --check` passed. No production backend, import, installed-app update or
cloud login was performed by this follow-up.
