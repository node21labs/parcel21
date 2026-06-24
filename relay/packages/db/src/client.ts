import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export interface CreateDbOptions {
  /** Max pool size. Default 10. */
  max?: number;
}

export function createDb(databaseUrl: string, options: CreateDbOptions = {}) {
  const client = postgres(databaseUrl, {
    max: options.max ?? 10,
    // Neon's pooled endpoint runs PgBouncer in transaction mode, which does
    // not support prepared statements. Disabling gives a single behavior that
    // works against local Postgres, Neon direct, and Neon pooled.
    prepare: false,
  });
  const db = drizzle(client, { schema });
  return { client, db };
}

export type DB = ReturnType<typeof createDb>["db"];
/** The underlying postgres.js client (for LISTEN/NOTIFY, raw SQL, etc.). */
export type DbClient = ReturnType<typeof createDb>["client"];
