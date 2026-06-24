# Parcel21 demo-orchestrator image. Build context is this directory (demo-orchestrator/).
# The protocol library is vendored at src/_vendor/parcel21.ts (committed; refresh with
# `npm run vendor` — source of truth is ../client/src/lib/parcel21.ts).
#
#   docker build -t parcel21-orchestrator demo-orchestrator/

# ── stage 1: compile rgb-cmd + bp-wallet for linux (no pre-built binaries are published) ──
FROM rust:1.82-bookworm AS rgb-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config clang libssl-dev \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install rgb-cmd  --version 0.11.1-rc.7  --locked --root /opt/rgb \
 && cargo install bp-wallet --version 0.11.1-alpha.2 --locked --features=cli,hot --root /opt/rgb
# /opt/rgb/bin now holds: rgb, bp, bp-hot

# ── stage 2: node runtime ──
FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rgb-builder /opt/rgb/bin/rgb     /usr/local/bin/rgb
COPY --from=rgb-builder /opt/rgb/bin/bp      /usr/local/bin/bp
COPY --from=rgb-builder /opt/rgb/bin/bp-hot  /usr/local/bin/bp-hot

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

ENV NODE_ENV=production
# binaries are on PATH; wallet/stash state persists on a mounted volume
ENV RGB_BIN=rgb BP_HOT_BIN=bp-hot DATA_DIR=/data
EXPOSE 8080
CMD ["npm", "start"]
