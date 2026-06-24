import {
  createDb,
  type DB,
  type DbClient,
  deletedAddressable,
  deletedEvents,
  eventTags,
  events,
} from "@relay/db";
import { sql } from "drizzle-orm";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "../src/domain/validate.ts";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://relay:relay@localhost:5432/relay";

// Explicit return type: inferring it inlines @relay/db's whole schema
// namespace, which declaration emit can't name (TS4058).
export function makeDb(): { client: DbClient; db: DB } {
  return createDb(DATABASE_URL);
}

export async function truncate(db: DB): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE ${events}, ${eventTags}, ${deletedEvents}, ${deletedAddressable} RESTART IDENTITY CASCADE`,
  );
}

export interface EventTemplate {
  kind?: number;
  created_at?: number;
  tags?: string[][];
  content?: string;
  secretKey?: Uint8Array;
}

export function freshKey() {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}

export function sign(template: EventTemplate): NostrEvent {
  const sk = template.secretKey ?? generateSecretKey();
  return finalizeEvent(
    {
      kind: template.kind ?? 1,
      created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      tags: template.tags ?? [],
      content: template.content ?? "hello",
    },
    sk,
  ) as NostrEvent;
}

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}
