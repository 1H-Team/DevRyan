# Mutation ledger retention and compaction (2026-10-09)

Scope: the session mutation ledger at
`<web-data>/harness/session-mutations/<sha256(project)>/` (`refs/devryan/state`,
`packages/harness-runtime/lib/session-mutations.js`). The user's ledger was only
read. Measurements used APFS clones under
`.cache/sessions/2026-10-09-ledger-retention/`; project file names are omitted.

## Findings (one project, ledger 14 days old, sequence 2722)

| Prefix or object class | Keys | Bytes |
|---|---:|---:|
| `runs/` | 12,481 | 147,575,710 |
| of which untouched baselines (11,994 documents) | | 124,512,376 |
| of which edited documents (278; 4,057,805 raw bytes of tombstones) | | 23,063,334 |
| `files/` | 12,458 | 5,181,123 |
| `revisions/` (12,970 revisions; 12,173 documents have one) | 12,458 | 3,059,077 |
| `leases/` + `operations/` + `calls/` | 7,116 | 3,702,490 |
| Unreachable loose Git objects (2,619 trees, 5,372 blobs) | 7,991 | 732 MiB (381 MiB on disk) |

- No record of `runs/`, `files/` or `revisions/` was ever removed. The
  collection in `docs/SESSION_CHANGES.md` and `session-changes-scale.test.js`
  belongs to the separate `harness/session-changes/` store.
- `maintainLedger` pruned only after a consolidating repack at 12 packs; the
  ledger had 4, so superseded trees (each commit rewrites the 0.8–1.2 MB
  `files/`, `runs/` and `revisions/` trees) stayed loose.
- `runs/` size followed the project size: every text file's first observation
  was stored as base64 JSON although the bytes were already in `objects/`.

## Change

- Untouched baselines are stored as one `{ baseline, size }` page naming the
  content object. Older hosts fail closed on it (`invalid_change_record`).
- Maintenance converts existing inline baselines in batches of 1024 under the
  owner lock, only while each document's `runs/<id>` subtree matches the
  snapshot it was read from, and prunes unreachable loose objects (two-hour
  grace) after every loose repack.

## Measurement on a clone of the ledger

| | Before | After maintenance |
|---|---:|---:|
| `git/` directory | 497,291,264 B | 84,000,768 B |
| `runs/` blobs | 147,575,710 B | 24,155,043 B |
| Loose objects | 8,093 | 22 |
| Whole-ledger `records()` parse | 159,755,497 B, 1,417 ms | 36,334,830 B, 869 ms |

- 11,990 documents converted; each referenced object's bytes equal the
  concatenated inline text from the pre-compaction tree (0 mismatches).
- One maintenance run took 30.3 s: 12 compaction batches holding the project
  lock 1.2–2.4 s each, then repack and prune. Batches of 256 gave 47 holds with
  median 1.1 s, maximum 1.4 s and 47.9 s total, so 1024 was kept.
- Previously packed inline pages become unreachable and leave the packs at the
  next consolidating repack.

## Not changed

Tombstones, deleted-file documents, operations, leases and calls still have no
retention horizon. Each can be needed by Revert, Redo, execution outcomes or
child lineage while its session exists; a safe collector needs a session
retirement signal. Sharding the top-level trees would cut per-commit tree
writes and needs a key-layout migration.
