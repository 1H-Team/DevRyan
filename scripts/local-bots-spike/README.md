# Local Bot database feasibility spike

This is a disposable experiment, not the application's local Bot backend. It
does not connect to a cloud project, read installed-app credentials or mount
installed-app volumes. Do not run `supabase link`, `--linked`, global Docker
cleanup, or a database reset against the repository's normal Supabase project.

The tested toolchain is Supabase CLI **2.117.0**, Docker Engine **29.5.2**, Node
**26.0.0**, and Bun **1.3.14** on ARM64 macOS. PostgreSQL **17.9** and PostgREST
**14.5** are pinned by multi-platform digest in `fixtures.mjs`. The comparison
uses the CLI's disposable Supabase PostgreSQL **17.6.1.167** / PostgREST **16.2**
stack. Both image indexes include Linux ARM64 and AMD64; AMD64 execution was not
tested on this ARM64 host.

## Prerequisites and isolation

Install the CLI using `brew install supabase/tap/supabase`, as documented by
[Supabase](https://github.com/supabase/cli#installation). A browser login is
unnecessary for local parity tests. Docker must respond to a bounded engine
version probe. Allow at least 10 GiB free disk for first-time image downloads;
do not free space by deleting unrelated images, containers, or volumes.

Owned resources use `devryan-bots-spike-local-20260920` and
`devryan-bots-spike-parity-20260920`. Evidence and generated fixture credentials
live in ignored `.cache/local-bots-spike/`; credential files are mode 0600.
The fixed ports are 56321, 56322 and 56330. An occupied port is a failure, not
permission to stop its owner. Use a fresh disposable fixture for a new migration
set. `replay.mjs` refuses an initialized database instead of resetting it.

The local database has no TCP listener. PostgREST connects over a private Unix
socket as UID 65534; PostgreSQL peer mapping permits only `authenticator`, which
can assume `service_role`. It cannot assume the database administrator's role.
PostgREST requires a server-only signed JWT and publishes HTTP only on loopback.
The database stays on an internal network. PostgREST's separate host bridge is
needed for Docker Desktop port forwarding. No Bot-authored workload joins it.

The CLI leaves Docker's `HostIp` empty. Docker Desktop 29 ignored the network's
default binding in this experiment, exposing the test ports on all interfaces.
`start-parity.mjs` addresses this before container creation through a private,
invocation-scoped Docker Unix proxy that forces explicit 127.0.0.1 bindings for
this fixture's labeled containers, then verifies every listener. It neither
changes Docker's global configuration nor exposes the Docker API over TCP.

## Reproduce

Run these commands from the repository root, in order. Do not run restart or
backup checks concurrently with repository tests, SQL tests, or each other.

```sh
node scripts/local-bots-spike/prepare.mjs
node scripts/local-bots-spike/replay.mjs
node scripts/local-bots-spike/secure-local.mjs
node scripts/local-bots-spike/start-parity.mjs
```

Save only this disposable instance's generated credentials privately:

```sh
umask 077
supabase status --workdir .cache/local-bots-spike/supabase-parity -o json \
  > .cache/local-bots-spike/parity-credentials.json
```

Run the identical contracts against both backends, under both server runtimes:

```sh
node scripts/local-bots-spike/database-tests.mjs local supabase
node scripts/local-bots-spike/repository-contract.mjs
bun scripts/local-bots-spike/repository-contract.mjs
node scripts/local-bots-spike/backup-restore.mjs
node scripts/local-bots-spike/measure.mjs
supabase test db --local \
  --workdir .cache/local-bots-spike/supabase-parity \
  --network-id devryan-bots-spike-parity-20260920
supabase db lint --local \
  --workdir .cache/local-bots-spike/supabase-parity \
  --network-id devryan-bots-spike-parity-20260920
supabase db advisors --local --type security --level warn --fail-on error \
  --workdir .cache/local-bots-spike/supabase-parity \
  --network-id devryan-bots-spike-parity-20260920
```

## What is reused

The local environment replays all thirty `supabase/migrations/*bot*.sql` files
unchanged, preceded by the original multi-user/profile migrations
`20260802195944_devryan_multi_user.sql` and
`20260803112512_classify_agent_test_users.sql`. `bootstrap.sql` supplies the four
database roles, private identity-reference and bucket-metadata schemas, pgcrypto,
and test-only pgTAP. Identity references cannot log in. The shared profile and
Bot business rules are not copied into a second migration history.

`migration-manifest.json` records each applied file's SHA-256. The catalog has
37 Bot tables and two audit views; all 37 tables force RLS and deny browser-role
access. Only the service role accesses Bot data. The three unchanged repository
consumers are `bots/store.js`, `bots/telegram/store.js` and `bots/audit-query.js`.
The only transport adaptation strips Kong's `/rest/v1` prefix for bare PostgREST.

The contract covers every declared Bot projection, schema markers, atomic Bot
creation, rollback, optimistic updates, channel permissions, concurrent sequence
allocation, run admission/replay, exclusive run and Telegram leases, audit
pagination/hydration, encrypted objects and missing/forged credentials. Concurrent
duplicate admission can return SQLSTATE 23505 in both backends; a subsequent
replay must return the same message, acknowledgment and run without duplicates.

Real PostgREST timestamps exposed an existing audit-cursor defect: the server
issued offset timestamps but only accepted a `Z` suffix when reading its cursor.
The shared reader now accepts a validated offset without losing microseconds.
The live repository contract and unit regression cases cover this fix.

## Storage and recovery evidence

`encrypted-files.mjs` is a test adapter beneath the existing AES-GCM blob store.
Files keep opaque names and ciphertext bytes. Exclusive creation, private modes,
bounded reads, symlink/traversal rejection and fsync protect the experiment.
It introduces no new JavaScript dependencies or alternate encryption format.

The snapshot check stops the fixture's sole HTTP writer, creates a PostgreSQL
custom-format dump, copies and checksums the complete active object inventory,
then restores into a fresh logical database. It compares fingerprints for every
Bot table, decrypts the retained recovery fixture, rejects a wrong key and a corrupted byte,
and only then marks the snapshot usable. Failed snapshots and their source are
preserved. This verifies a mechanism, not production scheduling, writer fencing,
upgrade rollback or owner-facing recovery UX.

## Cleanup

Stop only the named disposable environments; preserve their volumes and evidence
until the report is reviewed:

```sh
supabase stop --project-id devryan-bots-spike-parity-20260920 \
  --workdir .cache/local-bots-spike/supabase-parity
docker compose -f .cache/local-bots-spike/compose.json down
```

Never use `--all`, `--no-backup`, `down -v`, `docker system prune` or installed-app
resource names as part of these commands. The cold-start probe owns a temporary,
networkless, tmpfs-only container and removes only that container itself.
