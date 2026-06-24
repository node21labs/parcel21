# Admin UI (TanStack Start). Isolated from the vp workspace — its own bun.lock.
# Build context is apps/admin (Railway rootDirectory or `railway up` from here).
FROM oven/bun:1.3.13

WORKDIR /app

# Install deps first for layer caching. .dockerignore keeps the host
# node_modules/dist out so this layer is the source of truth.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

ENV NODE_ENV=production

# vite reads PORT (and binds all interfaces) from preview config in vite.config.ts.
EXPOSE 3000
CMD ["bun", "run", "preview"]
