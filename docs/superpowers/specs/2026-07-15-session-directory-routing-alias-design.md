# Session directory routing alias design

## Problem

OpenCode can return a filesystem alias that differs textually from the directory
used to create a session. On macOS, a request made with `/tmp/project` can return
`/private/tmp/project`. DevRyan currently records the returned directory as the
session routing key and the sidebar also reads that raw value directly.

That creates two child stores for one runtime directory:

- the active chat remains in the authoritative requested `/tmp/project` store;
- the sidebar creates a passive `/private/tmp/project` store;
- the passive store has no live status, so sidebar activity falls back to
  historical incomplete-assistant state and can remain active after a manual
  abort.

## Decision

Keep the server-returned directory on the session record as metadata, but make an
explicit creation directory authoritative for DevRyan routing:

1. `createSessionRecord` records `directoryOverride` before `session.directory`
   in both the sync routing index and the per-session UI hint.
2. `SessionNodeItem` reads its narrow per-session routing hint before the raw
   session directory, then falls back to its group directory.

The sidebar selector returns one primitive value for one session. It does not
subscribe rows to the child-store registry or any broad live collection.

## Rejected alternatives

- Canonicalizing all child-store keys with `realpath`: this changes API directory
  identity, persistence, eviction, and bootstrap ownership, and can incorrectly
  merge paths with intentionally distinct runtime meaning.
- Treating equivalent-looking strings as aliases globally: textual rules cannot
  safely resolve symlinks or platform-specific filesystem aliases.
- Removing the historical activity fallback: it would hide useful recovery state
  without fixing the split source of truth.

## Verification

- A creation regression test must prove `/tmp/project` wins when OpenCode returns
  `/private/tmp/project`.
- A pure sidebar resolver test must prove the routing hint wins over raw session
  metadata and that both fallback paths remain intact.
- The existing 429/retry visual fixture must show one idle composer and one idle
  sidebar row after Stop, including after the DevRyan API process restarts while
  upstream still reports retry.
