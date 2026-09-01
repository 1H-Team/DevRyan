FROM node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc AS build

ENV NODE_ENV=production \
    DEVRYAN_BOT_MODEL_CACHE=/opt/devryan/model-cache \
    DEVRYAN_BOT_MODEL_MANIFEST=/opt/devryan/model-cache-manifest.json \
    DEVRYAN_BOT_SBOM_PATH=/opt/devryan/sbom.cdx.json

WORKDIR /opt/devryan/app
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY packages/bot-indexer/package.json packages/bot-indexer/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY packages/bot-indexer/scripts ./scripts
RUN node ./scripts/prefetch-model.mjs \
    && npm cache clean --force

FROM node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc

ENV NODE_ENV=production \
    DEVRYAN_BOT_INDEXER_PORT=43123 \
    DEVRYAN_BOT_INDEX_PATH=/var/lib/devryan-bot-index/index.sqlite \
    DEVRYAN_BOT_MODEL_CACHE=/opt/devryan/model-cache \
    DEVRYAN_BOT_MODEL_MANIFEST=/opt/devryan/model-cache-manifest.json

RUN groupadd --gid 10001 devryan \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin devryan \
    && mkdir -p /opt/devryan/app /var/lib/devryan-bot-index \
    && chown -R 10001:10001 /opt/devryan/app /var/lib/devryan-bot-index

WORKDIR /opt/devryan/app
COPY --from=build --chown=10001:10001 /opt/devryan/app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /opt/devryan/model-cache /opt/devryan/model-cache
COPY --from=build --chown=10001:10001 /opt/devryan/model-cache-manifest.json /opt/devryan/model-cache-manifest.json
COPY --from=build --chown=10001:10001 /opt/devryan/sbom.cdx.json /opt/devryan/sbom.cdx.json
COPY --chown=10001:10001 packages/bot-indexer/package.json ./package.json
COPY --chown=10001:10001 \
  packages/bot-indexer/src/chunker.js \
  packages/bot-indexer/src/embeddings.js \
  packages/bot-indexer/src/index-store.js \
  packages/bot-indexer/src/search.js \
  packages/bot-indexer/src/server.js \
  ./src/

USER 10001:10001
VOLUME ["/var/lib/devryan-bot-index"]
EXPOSE 43123

HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:43123/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "./src/server.js"]
