# ── Stage 1: Build native TLS addon (Rust → .node) ──────────────────
FROM rust:1-slim AS native-builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential python3 curl ca-certificates gnupg && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (needed by napi-rs CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /native

# Cache Cargo deps first
COPY native/Cargo.toml native/Cargo.lock native/build.rs ./
RUN mkdir src && echo '#[allow(dead_code)] fn main(){}' > src/lib.rs && \
    cargo build --release 2>/dev/null || true

# Build real addon
COPY native/ ./
RUN npm ci && npm run build

# ── Stage 2: Application ────────────────────────────────────────────
FROM node:20-slim

# curl: needed by full-update.ts
# unzip: needed by full-update.ts to extract Codex.app
# gosu: needed by entrypoint to drop from root to node user
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates gosu && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Backend deps
COPY package*.json tsconfig.json ./
COPY scripts/ scripts/
RUN npm ci

# 2) Web deps (separate layer for cache efficiency)
COPY web/package*.json web/
RUN cd web && npm ci

# 3) Copy source
COPY . .

# 4) Copy native addon from builder stage (overwrite macOS .node if present)
COPY --from=native-builder /native/codex-tls.linux-*.node /app/native/

# 5) Build frontend (Vite → public/) + backend (tsc → dist/)
RUN cd web && npm run build && cd .. && npx tsc

# 6) Stamp build time for update-checker (COPY . invalidates cache, so this is always fresh)
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/.docker-build-time

# 7) Prune dev deps, re-add tsx (needed at runtime by update-checker fork())
RUN npm prune --omit=dev && npm install --no-save tsx

EXPOSE 8080

# Ensure data dir exists in the image (bind mount may override at runtime)
RUN mkdir -p /app/data

# Backup default configs so entrypoint can seed empty bind mounts
RUN cp -r /app/config /defaults

COPY docker-entrypoint.sh /
COPY docker-healthcheck.sh /
RUN chmod +x /docker-entrypoint.sh /docker-healthcheck.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD /docker-healthcheck.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
