FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
WORKDIR /opt/herdgate
COPY package.json package-lock.json ./
COPY scripts/patch-ssh2.mjs ./scripts/
RUN npm ci --omit=dev --omit=optional --ignore-scripts && node scripts/patch-ssh2.mjs && npm cache clean --force
COPY runtime/ ./runtime/
ENV NODE_ENV=production HERDGATE_BIND=0.0.0.0 HERDGATE_PORT=8787 HERDGATE_STATE=/data/state.json
USER node
EXPOSE 8787
CMD ["node", "runtime/cloud/main.js"]
