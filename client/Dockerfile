# TanStack Start builds a web-standard { fetch } SSR handler (dist/server/server.js) plus
# static client assets (dist/client). serve.mjs serves both on Node via srvx.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite inlines VITE_* at build time. Railway passes the service variable as a build arg;
# the default points at the deployed relay so the image is correct even without it.
ARG VITE_DEFAULT_RELAY=wss://relay-production-1664.up.railway.app
ENV VITE_DEFAULT_RELAY=$VITE_DEFAULT_RELAY
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/serve.mjs ./serve.mjs
COPY --from=build /app/package.json ./package.json
# Nitro/srvx server listens on $PORT; Railway injects it.
EXPOSE 3000
CMD ["node", "serve.mjs"]
