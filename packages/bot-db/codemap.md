# Local Bot catalog codemap

`@openchamber/bot-db` is the reviewed, versioned definition of the local Bot
catalog database: which SQL runs, in what order, and how a hosted catalog is
imported. It contains no runtime process; Electron applies it and the web
server renders import SQL from it.

## Entry points

- `index.js` — public exports for Electron and the web server.
- `src/inventory.js` — the append-only migration inventory. Every file in
  `supabase/migrations` is classified (`supporting`, `bot`, `excluded`) with
  its SHA-256; local additions (`sql/local/*.sql`) follow. A database is current
  only when its recorded history equals this list exactly.
  `REVIEWED_SOURCE_SCHEMAS` names the hosted schema markers an import accepts.
- `src/schema.js` — loads and checksum-verifies the SQL
  (`loadBotDatabaseSql`), classifies recorded history (current, pending,
  newer, drifted), renders one migration transaction, and validates the
  database names used for live, candidate, source and retired databases.
- `src/import-plan.js` — hosted-catalog import planning and SQL rendering:
  dependency order (with extra ordering for channel/ACL tables and deferred
  cyclic keys), raw JSON page loading, regenerated audit ids and run queue
  sequences, avatar restore, the two triggers disabled during a load, and
  merge finalization (uncertain deliveries, released leases, owner mappings,
  disconnected integrations).
- `sql/bootstrap-cluster.sql`, `sql/bootstrap-database.sql` — roles, schemas
  and the history table created before any migration.
- `docker/database/`, `docker/rest/` — the pinned PostgreSQL and PostgREST
  images (built from the repository root) with the socket-only, peer-auth
  configuration and the host-requested `--initialize-only` entrypoint.

## Where to change things

- New hosted migration: classify it in `src/inventory.js` with its checksum;
  never edit, reorder or remove a released entry.
- Local-only schema: add a new `sql/local/NNNN_*.sql` file and inventory entry.
- Import behavior: `src/import-plan.js`, exercised end to end by
  `packages/electron/tests/bot-catalog.docker.test.mjs`.
- Runtime lifecycle, backups and recovery live in
  `packages/electron/bot-database-manager.mjs` and `bot-catalog-backup.mjs`;
  server-side transport and import orchestration live in
  `packages/web/server/lib/bots/`.

## Tests

`bun run --cwd packages/bot-db test` (deterministic). Docker coverage is opt-in;
see `docs/TESTING.md`.
