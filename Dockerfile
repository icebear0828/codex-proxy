FROM node:20-slim

# Install unzip (full-update pipeline), curl, and ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends unzip curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy everything first (postinstall needs scripts/setup-curl.ts)
COPY . .

# Install backend dependencies (postinstall downloads curl-impersonate)
RUN npm ci

# Build frontend (Vite → public/)
RUN cd web && npm ci && npm run build

# Build backend (TypeScript → dist/)
RUN npx tsc

# Prune dev dependencies
RUN npm prune --omit=dev

# Persistent data mount point
VOLUME /app/data

EXPOSE 8080

CMD ["node", "dist/index.js"]
