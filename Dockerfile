FROM node:20-slim

# curl: needed by setup-curl.ts and full-update.ts
# unzip: needed by full-update.ts to extract Codex.app
# gosu: needed by entrypoint to drop from root to node user
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates gosu && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Backend deps (postinstall runs tsx scripts/setup-curl.ts)
COPY package*.json tsconfig.json ./
COPY scripts/ scripts/
RUN npm ci

# Fail fast if curl-impersonate wasn't downloaded
RUN test -f bin/curl-impersonate || \
    (echo "FATAL: curl-impersonate not downloaded. Check network." && exit 1)

# 2) Web deps (separate layer for cache efficiency)
COPY web/package*.json web/
RUN cd web && npm ci

# 3) Copy source
COPY . .

# 4) Build frontend (Vite → public/) + backend (tsc → dist/)
RUN cd web && npm run build && cd .. && npx tsc

# 5) Prune dev deps, re-add tsx (needed at runtime by update-checker fork())
RUN npm prune --omit=dev && npm install --no-save tsx

EXPOSE 8080

# Ensure data dir exists in the image (bind mount may override at runtime)
RUN mkdir -p /app/data

COPY docker-entrypoint.sh /
RUN chmod +x /docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fs http://localhost:8080/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
