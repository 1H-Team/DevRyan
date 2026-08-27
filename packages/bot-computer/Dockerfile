FROM node:22.13.1-bookworm-slim

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    DEVRYAN_BOT_COMPUTER_PORT=43122

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 devryan \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin devryan \
    && mkdir -p /opt/devryan /data/chromium /workspace \
    && chown -R 10001:10001 /opt/devryan /data/chromium /workspace

WORKDIR /opt/devryan
COPY --chown=10001:10001 packages/bot-computer/package.json ./package.json
COPY --chown=10001:10001 packages/bot-computer/src ./src

USER 10001:10001
EXPOSE 43122

HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:43122/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "./src/server.js"]
