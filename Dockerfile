FROM node:20-slim

# Install unzip (full-update pipeline) and ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends unzip ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (postinstall downloads curl-impersonate for Linux)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source and build
COPY . .
RUN npm run build

# Persistent data mount point
VOLUME /app/data

EXPOSE 8080

CMD ["node", "dist/index.js"]
