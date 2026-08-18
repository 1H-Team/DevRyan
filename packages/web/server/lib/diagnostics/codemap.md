# packages/web/server/lib/diagnostics/

## Responsibility

Status, time-range or full clear, and streaming ZIP export routes for the
always-on sanitized local diagnostic journal.

## Files

- `routes.js`: status (including context-mode and command-deadline recovery
  state), clear, export, and support-text sanitization HTTP contracts.
- `DOCUMENTATION.md`: privacy, scope, and platform save behavior.
