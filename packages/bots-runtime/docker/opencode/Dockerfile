FROM node:22.13.1-bookworm-slim

WORKDIR /opt/devryan

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash=5.2.15-2+b13 \
      ca-certificates=20250419~deb12u1 \
      git=1:2.39.5-0+deb12u3 \
      ripgrep=13.0.0-4+b2 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --omit=dev --no-audit --no-fund --save-exact \
      opencode-ai@1.18.25 @opencode-ai/plugin@1.18.25 opencode-gpt-imagegen@0.1.10 \
    && npm cache clean --force \
    && groupadd --gid 10001 devryan \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin devryan \
    && mkdir -p /data/opencode /workspace /runtime-config \
    && chown -R 10001:10001 /opt/devryan /data/opencode /workspace /runtime-config

COPY --chown=10001:10001 packages/bots-runtime/opencode/devryan-bot-tools.mjs /opt/devryan/devryan-bot-tools.mjs
COPY --chown=10001:10001 packages/web/server/default-config/plugins/devryan-openai-oauth.mjs /opt/devryan/devryan-openai-oauth.mjs
COPY --chown=10001:10001 packages/bots-runtime/docker/opencode/launch-opencode.mjs /opt/devryan/launch-opencode.mjs
COPY --chown=10001:10001 packages/bots-runtime/docker/opencode/entrypoint.sh /opt/devryan/entrypoint.sh

RUN chmod 0555 /opt/devryan/entrypoint.sh /opt/devryan/launch-opencode.mjs \
    && test "$(node -p "require('opencode-ai/package.json').version")" = "1.18.25" \
    && test "$(node -p "JSON.parse(require('node:fs').readFileSync('/opt/devryan/node_modules/opencode-gpt-imagegen/package.json','utf8')).version")" = "0.1.10"

ENV NODE_ENV=production

USER 10001:10001
EXPOSE 4096

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4096/global/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/opt/devryan/entrypoint.sh"]
CMD ["serve"]
