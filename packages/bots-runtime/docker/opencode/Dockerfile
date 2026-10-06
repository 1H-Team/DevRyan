FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-runtime
FROM node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /opt/devryan

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash=5.2.15-2+b13 \
      ca-certificates=20250419~deb12u1 \
      git=1:2.39.5-0+deb12u3 \
      ripgrep=13.0.0-4+b2 \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --omit=dev --no-audit --no-fund --save-exact \
      @opencode/server@2.0.20 @opencode/core@2.0.20 @opencode/ai@2.0.20 \
      @opencode/schema@2.0.20 @opencode/plugin@2.0.20 effect@4.0.0-rc.112 \
      @opencode-ai/plugin@1.18.33 opencode-gpt-imagegen@0.1.12 \
    && npm cache clean --force \
    && groupadd --gid 10001 devryan \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin devryan \
    && mkdir -p /data/opencode /workspace /runtime-config \
    && chown -R 10001:10001 /opt/devryan /data/opencode /workspace /runtime-config

COPY --chown=10001:10001 packages/bots-runtime/opencode/devryan-bot-tools.mjs /opt/devryan/devryan-bot-tools.mjs
COPY --chown=10001:10001 packages/bots-runtime/opencode/devryan-bot-tools.mjs /opt/devryan/packages/bots-runtime/opencode/devryan-bot-tools.mjs
COPY --chown=10001:10001 packages/web/server/default-config/plugins/devryan-openai-oauth.mjs /opt/devryan/devryan-openai-oauth.mjs
COPY --chown=10001:10001 packages/web/server/default-config/plugins/devryan-openai-oauth.mjs /opt/devryan/packages/web/server/default-config/plugins/devryan-openai-oauth.mjs
COPY --chown=10001:10001 packages/web/server/lib/bots/native-server.mjs /opt/devryan/packages/web/server/lib/bots/native-server.mjs
COPY --chown=10001:10001 packages/web/server/lib/bots/native-image-tool.mjs /opt/devryan/packages/web/server/lib/bots/native-image-tool.mjs
COPY --chown=10001:10001 packages/web/server/lib/bots/native-tool-policy.js /opt/devryan/packages/web/server/lib/bots/native-tool-policy.js
COPY --chown=10001:10001 packages/web/server/lib/opencode/runtime-host/native-image-generation.js /opt/devryan/packages/web/server/lib/opencode/runtime-host/native-image-generation.js
COPY --chown=10001:10001 packages/web/server/lib/opencode/runtime-host/native-read-paths.js /opt/devryan/packages/web/server/lib/opencode/runtime-host/native-read-paths.js
COPY --chown=10001:10001 packages/web/server/lib/opencode/runtime-host/reviewed-imagegen-transform.js /opt/devryan/reviewed-imagegen-transform.mjs
COPY --chown=10001:10001 packages/web/server/lib/opencode/runtime-host/native-setup-credential-data.js /opt/devryan/packages/web/server/lib/opencode/runtime-host/native-setup-credential-data.js
COPY --chown=10001:10001 packages/web/server/lib/opencode/chatgpt-siwc.js /opt/devryan/packages/web/server/lib/opencode/chatgpt-siwc.js
COPY --chown=10001:10001 packages/web/server/lib/opencode/runtime-host/native-model-catalog.ts /opt/devryan/packages/web/server/lib/opencode/runtime-host/native-model-catalog.ts
COPY --chown=10001:10001 packages/web/runtime/reviewed-inputs/model-catalog/DevRyan-model-catalog.json /opt/devryan/packages/web/runtime/reviewed-inputs/model-catalog/DevRyan-model-catalog.json
COPY --chown=10001:10001 packages/web/server/lib/opencode/imagegen-model-hotfix.js /opt/devryan/imagegen-model-hotfix.mjs
COPY --chown=10001:10001 packages/bots-runtime/docker/opencode/launch-opencode.mjs /opt/devryan/launch-opencode.mjs
COPY --chown=10001:10001 packages/bots-runtime/docker/opencode/entrypoint.sh /opt/devryan/entrypoint.sh

RUN node --input-type=module -e "import fs from 'node:fs'; import { rewriteReviewedImagegen } from './reviewed-imagegen-transform.mjs'; fs.writeFileSync('node_modules/opencode-gpt-imagegen/dist/devryan.js',rewriteReviewedImagegen(fs.readFileSync('node_modules/opencode-gpt-imagegen/dist/index.js')).contents);" \
    && node --input-type=module -e "import { applyImagegenModelHotfix } from './imagegen-model-hotfix.mjs'; const result = applyImagegenModelHotfix({ configDirectory: '/opt/devryan' }); if (!result.ok) throw new Error(result.error);" \
    && chmod 0555 /opt/devryan/entrypoint.sh /opt/devryan/launch-opencode.mjs \
    && test "$(node -p "JSON.parse(require('node:fs').readFileSync('/opt/devryan/node_modules/@opencode/server/package.json','utf8')).version")" = "2.0.20" \
    && test "$(node -p "JSON.parse(require('node:fs').readFileSync('/opt/devryan/node_modules/opencode-gpt-imagegen/package.json','utf8')).version")" = "0.1.12"

ENV NODE_ENV=production

USER 10001:10001
EXPOSE 4096

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4096/devryan/ready',{headers:{authorization:'Bearer '+process.env.DEVRYAN_BOT_RUNTIME_TOKEN}}).then(async r=>{const v=await r.json();if(!r.ok||!v.ready||v.generation!==2||v.opencode.version!=='2.0.20')process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/opt/devryan/entrypoint.sh"]
CMD ["serve"]
