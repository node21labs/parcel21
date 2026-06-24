/**
 * Standalone migration runner, used as the Railway pre-deploy command
 * (`bun packages/db/migrate.ts`). Unlike `drizzle-kit migrate`, this runs
 * natively under Bun with no `node` binary or dev-dependency in the runtime
 * image — it uses drizzle-orm's own migrator against the SQL files in
 * `./migrations` (copied into the container alongside this file).
 *
 * Idempotent: drizzle tracks applied migrations in `__drizzle_migrations`,
 * so re-running on an up-to-date database is a no-op.
 */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required to run migrations");
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
const sql = postgres(url, { max: 1, prepare: false });

try {
  await migrate(drizzle(sql), { migrationsFolder });
  console.log("migrations applied");
} catch (err) {
  console.error("migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await sql.end();
}
