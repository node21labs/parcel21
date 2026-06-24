# syntax=docker/dockerfile:1.7

# ─── Build stage ─────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json bun.lock ./
COPY packages/db/package.json ./packages/db/
COPY packages/relay/package.json ./packages/relay/
COPY apps/relay/package.json ./apps/relay/
COPY apps/website/package.json ./apps/website/

RUN bun install --frozen-lockfile --ignore-scripts

# Copy sources and build the workspace libs @relay/app depends on
COPY packages ./packages
COPY apps/relay ./apps/relay

RUN cd packages/db && bun run build
RUN cd packages/relay && bun run build

# ─── Runtime stage ──────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/relay ./apps/relay
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER bun
CMD ["bun", "apps/relay/src/index.ts"]
