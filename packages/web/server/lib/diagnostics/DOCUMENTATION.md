# Diagnostics

The diagnostics module exposes the always-on local harness journal without
uploading it. `GET /api/diagnostics/status` reports bounded storage health,
including `sessionCount`; `DELETE /api/diagnostics?range=24h|7d|14d|all`
removes records in the selected recent window (or every session/runtime bucket
plus legacy segments for `all`) while leaving chat history untouched;
`POST /api/diagnostics/export` streams a branded task- or runtime-scoped ZIP;
and `POST /api/diagnostics/sanitize` lets existing support text use the same
redactor.

Version 2 exports contain a manifest, redaction report, one sanitized NDJSON
file per included session, `runtime.ndjson`, `sessions/index.json`, correlated
durable worktree receipts, optional turn-evidence records, decompressed
plain-text sanitized blobs, and a sharing warning. Task scope includes the
requested session and descendants discovered from canonical session events.
Every textual export entry receives a second deny-pattern pass.

Electron owns the native save dialog and streams the local HTTP response into a
private sibling temporary file before fsync and rename. VS Code builds the same
ZIP in the extension host and uses `showSaveDialog`. Browser web downloads the
streamed response through the browser download surface. Native hosts remove
abandoned diagnostics temporary files after 24 hours.

The administrator Error Logs surface is a separate multi-user audit contract,
not the local harness journal. Its `DELETE /api/error-logs` snapshot clear uses
the durable audit outbox barrier and the
`20260810182541_clear_managed_error_diagnostics` Supabase migration; clearing
either store never implicitly clears the other.
