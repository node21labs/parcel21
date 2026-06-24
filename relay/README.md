# Relay

A Nostr relay.

## Setup

Install dependencies:

```bash
vp install
```

Copy the env template and start Postgres:

```bash
cp .env.example .env
docker compose up -d
```

Apply database migrations:

```bash
vp run db:migrate
```

## Running the relay

Start the WebSocket server with file-watch (development):

```bash
vp run relay
```

The relay listens on `ws://localhost:8080` by default. Override the port with `PORT=3000 vp run relay`, or the database connection with `DATABASE_URL=...`.

Start without file-watch (production-ish):

```bash
vp run relay:start
```

Quick health check:

```bash
curl http://localhost:8080/health
```

## Development

- Check everything is ready (format, lint, typecheck, test, build):

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo:

```bash
vp run -r build
```

## Database

Postgres runs locally via Docker Compose (`docker-compose.yml` at the repo root). The schema lives in [`packages/db`](packages/db/) and uses Drizzle ORM.

Root-level shortcuts:

| Command              | Purpose                                          |
| -------------------- | ------------------------------------------------ |
| `vp run db:generate` | Generate a new SQL migration from schema changes |
| `vp run db:migrate`  | Apply pending migrations to the database         |
| `vp run db:studio`   | Open Drizzle Studio to inspect the database      |

Stop the database:

```bash
docker compose down
```

Wipe the database (destroys data):

```bash
docker compose down -v
```

## Production deployment

Production runs on **[Railway](https://railway.com)** — a `relay` service built from the root [`Dockerfile`](Dockerfile) and a managed **Railway Postgres** instance, in the `relay` project.

### How it works

- **Build**: Railway's GitHub integration watches `master`. On every push it auto-detects the root `Dockerfile` (builder pinned in [`railway.json`](railway.json)) and rolls the service. Configure "Wait for CI" on the service so it only deploys after this repo's CI passes.
- **Migrations**: `railway.json`'s `preDeployCommand` runs [`bun packages/db/migrate.ts`](packages/db/migrate.ts) before each new container takes traffic — a Bun-native drizzle-orm migrator (no `node`/drizzle-kit needed in the runtime image). Idempotent.
- **Database**: `DATABASE_URL` is a Railway reference variable → `${{ Postgres.DATABASE_URL }}` (private network). The app pools via postgres.js (`prepare: false`).
- **Config**: service env vars set `RELAY_PUBLIC_URL` (for NIP-42), `TRUST_PROXY=true` (Railway terminates TLS and forwards `X-Forwarded-For`), `PORT=8080`, the `RELAY_*` info-doc fields, and optionally `WRITE_ALLOWLIST_PUBKEYS`.
- **Write allowlist**: a `write_allowlist` Postgres table restricts who may publish — reads stay open, only listed authors' events are accepted. Empty table = open writes. Gated by event signature, so writers don't need NIP-42 AUTH. The relay reads the table live (LISTEN/NOTIFY + a poll fallback), so changes apply without a restart. `WRITE_ALLOWLIST_PUBKEYS` (comma/space-separated hex) seeds the table once on first boot for backward compatibility; after that the table is authoritative and managed via the **admin UI** ([`apps/admin`](apps/admin/)). This is how the blog and contract relays enforce "public read, team write."
- **CI**: GitHub Actions ([`ci.yml`](.github/workflows/ci.yml)) runs the test suite on every push and PR. It does not deploy — Railway does. Optionally enable "Wait for CI" on the Railway service to gate deploys on the run.

### Versioning

No release tooling. The NIP-11 `version` field reads `apps/relay/package.json`; bump it by hand when you cut a release worth advertising. Everything is private (nothing publishes to npm), so package versions are otherwise cosmetic.

### Provisioning a fresh environment

1. Create a Railway project, add the **PostgreSQL** template.
2. Create a service from the GitHub repo (`Resolvr-io/relay`, branch `master`) — Railway auto-detects the root `Dockerfile`.
3. Set service vars: `TRUST_PROXY=true`, `PORT=8080`, `NODE_ENV=production`, the `RELAY_*` info-doc vars, and `WRITE_ALLOWLIST_PUBKEYS` if this relay is team-write (seeds the `write_allowlist` table on first boot; thereafter manage it via the admin UI).
4. Add reference var `DATABASE_URL=${{ Postgres.DATABASE_URL }}`.
5. Generate a domain, then set `RELAY_PUBLIC_URL=wss://<domain>`.
6. Push to `master` — Railway builds, migrates (pre-deploy), and serves.

> The relay previously ran on AWS ECS Express Mode + Neon (Terraform under `infra/terraform`). That stack has been torn down and the Terraform removed; see git history if you need it.

## Workspaces

- [`packages/db`](packages/db/) — `@relay/db`, Drizzle schema + client
- [`packages/relay`](packages/relay/) — `@relay/core`, NIP-01 implementation (transport-agnostic)
- [`apps/relay`](apps/relay/) — `@relay/app`, WebSocket server wiring the core to `ws` + Node `http`
- [`apps/admin`](apps/admin/) — TanStack Start admin UI for managing the write allowlist and admin operators (TanStack Query + shadcn/ui, NIP-07 login). Admins live in an `admins` table seeded once from `ADMIN_PUBKEYS`, then managed in the UI (last admin can't be removed). Runs **outside** the Vite+ workspace with its own toolchain (standard Vite 8); see [`apps/admin/.env.example`](apps/admin/.env.example) for config.
