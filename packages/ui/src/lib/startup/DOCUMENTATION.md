# Startup readiness

`readiness.ts` owns the health, provider, agent, initialization, sync, session,
response-style, acknowledged native event-stream and worktree readiness gates. `App.tsx` applies them without
weakening the usable-chat predicate.

During initial startup, App emits bounded `devryan-startup-gate-<phase>-<status>`
performance marks once per phase/status pair. They contain fixed labels only;
timestamps are elapsed milliseconds since renderer navigation. The packaged
benchmark reads these marks together with its existing composer, catalog,
sessions and event-stream acknowledgment checks. Marks stop after initial
readiness and never control readiness or retry behavior.

Native health is authoritative before initial directory/global requests begin.
Integrity failure details are parsed through the shared diagnostic allowlist and
shown with Retry and Copy Diagnostics. Retry aborts the previous initialization;
late health/bootstrap results cannot publish into its replacement. The event
pipeline reports its actual global subscription ACK separately from HTTP health
or heartbeat connectivity. Compatibility hosts retain their connection gate.
