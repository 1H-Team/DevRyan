# Agent runtime verification

Use this runbook for live multi-user checks and runtime incident investigation. Deterministic test guidance lives in [TESTING.md](TESTING.md).

## Multi-user visual verification (agent-test accounts)

The Supabase multi-user control plane reserves two fixture accounts exclusively
for AI agents doing visual verification. They are `account_kind = 'agent_test'`
in `user_profiles`, are deliberately hidden from the Users settings page and
`GET /api/admin/users`, and pass through the exact same authentication, policy,
assignment, ownership, and audit enforcement as human accounts:

- **Test Administrator** — `admin@1health.ae` (role `admin`; verifies admin
  flows: host-path pass-through, project registration, user management).
- **Test Developer** — `developer@1health.ae` (role `developer`; verifies the
  restricted experience: path aliasing, out-of-scope 403s, hidden settings).

**Agents must never type, store, or transmit passwords.** Instead use the
loopback-only, password-free login endpoint (`handleAgentTestSession` in
`packages/web/server/lib/multi-user/runtime.js`, mounted at
`POST /auth/agent-test-session` in `server/lib/opencode/core-routes.js`). It
only accepts active `agent_test` profiles, only from 127.0.0.1, and mints a
normal 12-hour app session (audited as `auth.agent_test_login`). From the
app's own browser tab:

```js
await fetch('/auth/agent-test-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
  body: JSON.stringify({ email: 'developer@1health.ae' }),
});
location.reload();
```

Calling it again with the other email switches roles; `POST /auth/logout`
(with the CSRF header) ends the session.

**Verification server recipe.** Only one DevRyan runtime may own managed
OpenCode orchestration per data directory. If the user's own app is running,
do not fight it — start a second server against an isolated data directory
(copy `supabase.json` into it so multi-user mode is enabled) on a spare port:

```bash
mkdir -p ~/.config/openchamber-verify
cp ~/.config/openchamber/supabase.json ~/.config/openchamber-verify/
OPENCHAMBER_DATA_DIR=~/.config/openchamber-verify bun packages/web/server/index.js --port 3101
```

Build first (`bun run build:ui && bun run build:web`) so the served UI matches
the working tree. Prefer the in-app browser preview tooling over raw shells
for the server so logs stay inspectable.

## Diagnostic journal (check it before theorizing)

Whenever the user reports a DevRyan runtime issue — stuck or hung sessions, missing or duplicated events, failed/rejected prompts, aborts that did not take effect, streaming or sync anomalies, worktree or evidence lifecycle issues — inspect the journal before forming a code-only theory. Start from the repository root:

```bash
bun scripts/journal.mjs list
bun scripts/journal.mjs show <sessionID> --tail 200
bun scripts/journal.mjs gaps
```

When the report starts with an Error Log event UUID, treat that UUID as a durable administrative locator, not as the detailed execution record:

1. Resolve the UUID through the administrator Error Log detail surface/API first. Capture the `sessionId`, timestamp, action/kind, and every available `callId`, `toolId`, `messageId`, or `taskId`.
2. Use the session plus the strongest correlation identifier to inspect the corresponding local journal, for example `bun scripts/journal.mjs show <sessionID> --grep <callId>`. Fall back to `toolId`, `messageId`, `taskId`, or a bounded `--since`/`--until` timestamp window when no call ID exists.
3. Run `bun scripts/journal.mjs gaps` before drawing conclusions.
4. Do not expect the Error Log UUID itself to appear in journal records. Error Logs and the journal are separate stores correlated through session and tool/message/task identifiers: Error Logs provide durable administrative indexing, classification, and bounded sanitized summaries; the journal is the source for prompts, tool output, lifecycle ordering, recovery behavior, and detailed failure evidence.
5. If the relevant host journal is unavailable, expired, or contains a qualifying gap, report that limitation instead of reconstructing missing detail.

- Location (web/Electron): `~/.config/openchamber/harness/journal/` (data-root override: `$OPENCHAMBER_DATA_DIR`). Pass `--dir <journal-dir>` to the CLI for either host.
- Layout: `index.json` summarizes `sessions/<sessionID>/manifest.json`; closed chunks are `*.ndjson.gz`, the active crash-safe chunk is plain `*.ndjson.open`, large strings are `blobs/<sha256>.txt.gz`, and records without a resolvable session are under `runtime/`. The directory's generated `README.md` is the self-describing format guide.
- Legacy root `*.ndjson` segments coexist during the transition. They remain readable, are listed as `legacy`, are pruned before session buckets, and are removed by Clear All Data; they are never regrouped.
- `message.part.delta` is intentionally absent. Repeated `message.part.updated` and `session.updated` records are last-write-wins; `coalesced` reports how many source events a stored record represents. These trims are not data-loss gaps. `gap` still means queue overflow, sanitization failure, or parse failure and must qualify conclusions.
- Record types remain `open_code_event`, `prompt`, `control`, `lifecycle`, `worktree_transition`, `evidence_transition`, `connection`, `timing`, `log`, and `gap`. Resolved session IDs are stamped at the top level before storage.
- Runtime health: `GET /api/diagnostics/status` (default port 3000; `dev:server` uses `${OPENCHAMBER_PORT:-3001}`) reports `sessionCount`, bytes, queue/write/gap counts, segment count, and the last error.
- Caveats: records and manifests are sanitized before disk (secrets redacted, home/worktree paths rewritten to `<WORKTREE_…>` placeholders); retention is 7 days / 1 GiB total. Absence of an expected non-delta record is itself evidence — the runtime never saw it.
- Deep contracts: `packages/harness-runtime/DOCUMENTATION.md` (journal, sanitizer, export, storage limits) and `packages/web/server/lib/diagnostics/DOCUMENTATION.md` (HTTP status/clear/export/sanitize).

## Context Mode worker liveness

For `ctx_*` stalls, correlate the native tool part's
`metadata.contextModeWorkerCallID` with `context_mode.*` lifecycle records and
its session/message identity. Inspect `worker_started`/`worker_reused`,
`dispatched`, `initializing`, `executing` and
`storage_contended`/`storage_acquired` phases before
deciding whether indexing itself ran. Current workers have no command queue;
`queued` or `queue_timeout` identifies an older runtime revision. Check normal
managed provisioning status rather than restarting a busy runtime. Use the
per-call sequence/source timestamp when delivery order differs. Run the journal
gap check, including `context_mode.diagnostics_gap`; unavailable final telemetry
must qualify conclusions. Queue expiry and unavailable-worker errors mean the
call did not execute. Active timeout/cancellation errors mean the outcome is
unknown; inspect current state and never replay the command automatically.

The disposable `bun scripts/verify-context-mode-workers.mjs
.cache/context-mode-worker-check` check uses a pinned local Context Mode install
inside `.cache`, isolated HOME/config/data/temp directories, and no provider
credentials. It exercises thirty concurrent calls from fifteen sessions within one project
and across projects, repeated bursts, all permitted tools against local fixtures,
shared-source replacement, initiating-session JSON/SessionDB statistics and index reopening. A real
index call is deliberately held at its storage transaction for 31.1 seconds while
sibling reads/commands complete. It also covers deadlines, shared batch budgets,
same-project cancellation, background ownership, compiled-host worker startup
and repeated indexing across the maintenance boundary. Workers use separate
processes to contain native faults. Cold/warm latency, summed parent/worker RSS
and host event-loop delay are recorded in `verification.json` under the supplied
disposable package root; run fixtures and child processes are cleaned up. Only
idle workers are capped (four, expiring after thirty seconds). It does not touch the
installed app. Activate updated helpers only through normal managed provisioning;
do not patch or restart a busy runtime to run this check.
