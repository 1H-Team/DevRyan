#!/bin/sh
# DevRyan local Bot database entrypoint. Runs as the image's postgres user
# under a read-only root filesystem with no capabilities.
#
#   devryan-bot-database-entrypoint                    serve an existing cluster
#   devryan-bot-database-entrypoint --initialize-only  create a cluster, then exit
#
# Only the host lifecycle runs the one-off initialization, after it has
# verified that the data volume is new and owned by this installation. The
# long-lived service never creates a cluster, so a volume the host expects to
# hold data can never be silently re-initialized.
set -eu
umask 077

if [ "$(id -u)" != "999" ]; then
  echo "devryan-bot-database: refusing to run as uid $(id -u)" >&2
  exit 64
fi

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
CONFIG=/etc/devryan-bot-database/postgresql.conf

if [ "${1:-}" = "--initialize-only" ]; then
  if [ "${DEVRYAN_BOT_DATABASE_INITIALIZE:-refuse}" != "allow" ]; then
    echo "devryan-bot-database: initialization was not requested by the host" >&2
    exit 65
  fi
  if [ -s "$PGDATA/PG_VERSION" ] || [ -n "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
    echo "devryan-bot-database: refusing to initialize a non-empty data directory" >&2
    exit 66
  fi
  initdb \
    --pgdata="$PGDATA" \
    --username=postgres \
    --auth-local=peer \
    --auth-host=reject \
    --encoding=UTF8 \
    --locale-provider=builtin \
    --builtin-locale=C.UTF-8 \
    --data-checksums \
    >/dev/null
  echo "devryan-bot-database: cluster initialized"
  exit 0
fi

if [ "$#" -ne 0 ]; then
  echo "devryan-bot-database: unsupported arguments" >&2
  exit 64
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "devryan-bot-database: no cluster found; the host must initialize or restore it" >&2
  exit 67
fi

exec postgres -c "config_file=$CONFIG"
