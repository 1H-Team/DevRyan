# Supabase connection and local traffic measurements

Settings → About contains the Supabase connection switch for an authenticated
administrator accessing this host directly. It is shared by all windows using
that runtime, including Electron's background service. Other installations using
the same Supabase project have their own switch and still contribute traffic.

## Modes and access

The private `supabase-connection.json` file in the configured DevRyan data root
stores `{ "version": 1, "enabled": false }` when disconnected. Missing preference
files retain the existing configured behavior. Supabase credentials stay in their
original location. No database schema or cloud records are removed.

The first local administrator change enrolls an encrypted local-owner identity
and an HttpOnly, SameSite=Strict cookie. A loopback socket alone never grants
access. The local boundary also checks Host, Origin and forwarding headers.
External HTTP, SSE and WebSocket access is closed while disconnected, including
through tunnels. Ordinary local chats, projects, files and diagnostics remain
available. Bots, Telegram, managed-user scheduled execution, shared-user access
and cloud audit delivery are unavailable. Existing actor-audit records remain in
the durable outbox; disconnected diagnostics do not enter that outbox.

The switch closes new work admission and persists the requested mode immediately.
The effective mode changes only after an idle restart. Active chat status must be
verified through OpenCode; active Bot runs, routines, Telegram jobs, memory
extraction, managed task launches, scheduled tasks and mutation requests hold the
restart pending. Queued cloud work remains persisted. Finishing, approving and
cancelling admitted work remain possible. Cancelling a pending change rearms
admission. A failed restart requires an explicit retry.

Electron drains the owned server and releases its runtime-service owner lock.
App-bound mode relaunches the app. Service mode exits with the unsuccessful status
used by both existing launchd KeepAlive definitions; the foreground app refreshes
its local bootstrap after the service generation changes. This does not
re-register the LaunchAgent or create another runtime owner.

Standalone web reports **restart required** unless its owner supplied
`onRestartHost`. A process manager configured to restart unsuccessful exits may
explicitly set `DEVRYAN_SUPERVISED_RESTART=1`; the server then drains and exits with
status 1 once idle. Do not set that flag for an unsupervised process. Restart that
process manually after its listed blockers clear.

An explicit reconnect probes the saved owner's active administrator role and the
required Bot schema before opening access. The new process repeats that check
before initializing workers. Failure persists Off and leaves remote access
closed; quota failures never trigger automatic reconnect attempts. Normal worker
startup retains the existing durable claims, missed-run policies and idempotency
keys.

## Local continuity and recovery

Before disconnecting, the host retains managed project paths in local settings
and preserves the owner's personal theme, model selections, favorites and
notification templates where present. The authenticated owner's user ID stays the
same, so browser state continues to use that identity. Local settings and cloud
ownership records are retained. Local `session.created` events record explicit
owner provenance in the encrypted vault; reconnect reconciliation restores cloud
ownership only for that still-active administrator, without replacing an existing
owner. Local projects remain visible to the authenticated direct-local owner.

Local-owner cookies expire after 30 days. Native Electron startup or the private,
OS-authenticated service bootstrap can mint a replacement for the enrolled owner.
Different local browser sessions coexist. Logging out clears the current local
cookie. A standalone browser that loses its cookie cannot recover administrator
access merely by visiting localhost. With filesystem-owner access, stop the
standalone server, set the private preference's `enabled` value to `true`, and
restart; reconnect validation and normal managed authentication still apply.
Keep the preference private (mode 600). Do not remove the encrypted vault or
Supabase credentials as a recovery shortcut.

## API and measurement

`GET /api/system/supabase-connection` returns configured status, desired and
effective modes, one of `connected`, `disconnecting`, `disconnected`, `connecting`
or `connection_failed`, a safe error code, restart availability and current
blockers. `PATCH` accepts exactly `{ "enabled": boolean }` and requires
`X-DevRyan-CSRF: 1` plus local-owner authorization. Runtime capability
`supabaseConnection` exposes these operations to shared UI.

The GET response also contains `traffic`: request counts, response-body bytes,
status counts, failures, avoided requests and locally blocked calls, ranked by
response bytes. Operation names exclude query values, object paths, user IDs,
credentials and bodies. Counters stay in memory, reset at runtime restart and are
bounded to 129 operation groups including overflow. Their measurement label is
`decoded-response-body-estimate`. They are diagnostic estimates, not billed bytes;
Supabase's dashboard remains the billing authority. Cache avoidance counts are
conservative and do not attribute every downstream avoided query.

Connected-mode changes include:

- Shared, paginated Telegram discovery at most once per idle minute; local
  configuration changes invalidate immediately. Known connections continue long
  polling, and fresh admission/delivery authorization and leases remain intact.
- Idle Telegram drain phases, empty memory claims and empty approval-expiry sweeps
  back off to one minute. Incoming Telegram work, local delivery retries, settled
  runs and new approvals wake relevant work early. Active jobs retain existing
  cancellation and duplicate-delivery safeguards.
- Concurrent principal refreshes coalesce without extending the five-second
  authorization freshness window. Revocation invalidates in-flight refreshes.
  Offline-grace principals cannot populate remote authorization results.
- Session `last_seen_at` writes occur at most once per minute. Hot identity reads
  use narrow projections; authentication omits personal settings payloads until
  a settings request needs them. Bot list projections validate column names and
  retain cursor columns; full records remain available for execution and details.

## Validation and rollout

The deterministic tests cover disconnected transport and runtime initialization,
owner authentication, native recovery proof, persistent mode changes, restart
blockers/failures, concurrent refreshes, idle discovery/backoff and projected
pagination. Existing Bot, auth, audit, scheduling and recovery suites remain the
regression gate. Visual checks use isolated fixtures, not the installed app.

After deployment, capture local counters during representative idle and active
usage, and compare Supabase dashboard increments for 24–72 hours. Calculate the
monthly projection from billed daily increments and compare it with the 4 GB
budget. The 90% idle-request reduction and 4 GB monthly usage are targets, not
claims established by unit tests. Previously consumed egress cannot be reversed.
