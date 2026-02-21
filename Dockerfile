FROM node:20-slim

# Install unzip (full-update pipeline), curl, and ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends unzip curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Optional build-time proxy for npm/GitHub downloads inside RUN commands.
# Uses custom arg name to avoid BuildKit intercepting HTTP_PROXY for image pulls.
# Docker daemon's own proxy handles image pulls separately.
ARG BUILD_PROXY
ENV http_proxy=${BUILD_PROXY} https_proxy=${BUILD_PROXY}

# Install backend dependencies (postinstall downloads curl-impersonate for Linux)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build frontend (Vite → public/)
RUN cd web && npm ci && npm run build

# Build backend (TypeScript → dist/)
RUN npx tsc

# Prune dev dependencies
RUN npm prune --omit=dev

# Clear build-time proxy from image
ENV http_proxy= https_proxy=

# Persistent data mount point
VOLUME /app/data

EXPOSE 8080

CMD ["node", "dist/index.js"]
