# DevRyan local Bot database: pinned PostgreSQL with a reviewed, read-only
# socket/peer-authentication configuration. Built from the repository root.
FROM postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641

COPY packages/bot-db/docker/database/postgresql.conf /etc/devryan-bot-database/postgresql.conf
COPY packages/bot-db/docker/database/pg_hba.conf /etc/devryan-bot-database/pg_hba.conf
COPY packages/bot-db/docker/database/pg_ident.conf /etc/devryan-bot-database/pg_ident.conf
COPY packages/bot-db/docker/database/entrypoint.sh /usr/local/bin/devryan-bot-database-entrypoint

RUN chown -R root:root /etc/devryan-bot-database /usr/local/bin/devryan-bot-database-entrypoint \
    && chmod 0555 /etc/devryan-bot-database /usr/local/bin/devryan-bot-database-entrypoint \
    && chmod 0444 /etc/devryan-bot-database/*

ENV PGDATA=/var/lib/postgresql/data
USER 999:999
STOPSIGNAL SIGINT
HEALTHCHECK --interval=2s --timeout=5s --start-period=60s --retries=30 \
  CMD ["pg_isready", "--quiet", "--host=/var/run/postgresql", "--dbname=postgres", "--username=postgres"]
ENTRYPOINT ["/usr/local/bin/devryan-bot-database-entrypoint"]
CMD []
