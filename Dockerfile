FROM node:20-slim

# curl: needed by setup-curl.ts and full-update.ts
# unzip: needed by full-update.ts to extract Codex.app
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Backend deps (postinstall downloads curl-impersonate for Linux)
COPY package*.json ./
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

VOLUME /app/data
EXPOSE 8080
CMD ["node", "dist/index.js"]
