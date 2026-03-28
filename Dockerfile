# ── Stage 1: Build native TLS addon (Rust → NAPI-RS .node binary) ──
FROM node:20-slim AS native-builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install Rust via rustup
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app/native
COPY native/package*.json native/Cargo.toml native/Cargo.lock native/build.rs ./
COPY native/src/ src/

# Install NAPI-RS CLI and build the addon
RUN npm ci && npx napi build --platform --release

# ── Stage 2: Application build ──
FROM node:20-slim

# curl: needed by setup-curl.ts and full-update.ts
# unzip: needed by full-update.ts to extract Codex.app
# gosu: needed by entrypoint to drop from root to node user
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates gosu && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Backend deps (postinstall runs tsx scripts/infra/setup-curl.ts)
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

# 4) Copy native addon from builder stage (overwrites source-only native/ from step 3)
COPY --from=native-builder /app/native/ native/

# 5) Build frontend (Vite → public/) + backend (tsc → dist/)
RUN cd web && npm run build && cd .. && npx tsc

# 6) Prune dev deps, re-add tsx (needed at runtime by update-checker fork())
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
