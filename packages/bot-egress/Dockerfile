FROM node:22.13.1-alpine

WORKDIR /app

RUN addgroup -S -g 10001 devryan \
    && adduser -S -D -H -u 10001 -G devryan devryan

COPY --chown=10001:10001 packages/bot-egress/package.json ./package.json
COPY --chown=10001:10001 packages/bot-egress/src ./src

ENV NODE_ENV=production \
    DEVRYAN_BOT_EGRESS_PORT=43121

USER 10001:10001
EXPOSE 43121

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:43121/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "./src/server.js"]
