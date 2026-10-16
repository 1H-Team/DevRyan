# OpenCode 2.0.30 update

The host and Bot image source pins move from OpenCode 2.0.26 to 2.0.30,
with the matching Effect 4.0.1 dependency and stable HTTP/process/socket imports.
The compiled native runtime, asset hashes, built-in plugin registration inventory,
migration receipt type, generated OpenAPI routes, CLI version text, and
qualification fixtures follow the same release. Compatibility SDK identities
remain unchanged.

The new project archive migration raises the clone migration level to 2.
Reviewed older source graphs can upgrade; a migrated 2.0.30 database cannot
clone backwards. Qualification covered the exact later 2.0.26 graph
`287c56936f4c31fdff506e655a599a7ef277e384c144c1548ec48ba9e918b464`
and candidate graph
`fe5b54bf9ab3a5e3d1f5bc952bdff00f81d8ff6635c9ca83fef1c669af4f47e1`.
The fresh-install candidate applied migration 50 while rollback restarted
the original 49-migration database and retained candidate work.

All 53 compiled package qualification cases passed against frozen source,
including signed assets, tamper refusal, source-read confinement, both clone
layouts, credential reconciliation, rollback, parent death and durable journal
coverage. The run retained no cleanup failures or source changes.
Full validation, the web/Electron build, native macOS ARM64 build, and startup
bundle budgets passed. The final run includes 4,161 UI tests, 7,105 server tests
and 34 final native-host tests. Documentation validation also passed.
Sanitized case identifiers and final validation results are in
[evidence.json](evidence.json).

The update also preserves startup schema diagnostics when Effect's general
reporter ignores HTTP schema errors. A fixture diagnostic write now completes
before its assertions. WebSocket source and compiled tests assert the new
15-minute HTTP chunk default while retaining the independent 30-minute
WebSocket idle limit, explicit timeout overrides and Stop checks.
Historical cold-start unit fixtures restore the older project schema after
using the current importer; all 76 startup/bundle tests pass without changing
the production compatibility gate.

No live account, installed-app data, deployment or release installer was used.
Docker image and Windows native builds remain unverified. The Bot image
requires rebuilding before deployment.
