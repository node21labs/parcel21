import { nullLogger } from "@relay/core";
import { createDb, deletedAddressable, deletedEvents, eventTags, events } from "@relay/db";
import { sql } from "drizzle-orm";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";
import { WebSocket } from "ws";
import { startRelay, type RunningServer } from "../src/server.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://relay:relay@localhost:5432/relay";

let running: RunningServer;
let wsUrl: string;

const direct = createDb(DATABASE_URL);

beforeAll(async () => {
  running = await startRelay({
    port: 0,
    databaseUrl: DATABASE_URL,
    logger: nullLogger,
  });
  wsUrl = `ws://localhost:${running.port}`;
});

afterAll(async () => {
  await running.stop();
  await direct.client.end();
});

beforeEach(async () => {
  await direct.db.execute(
    sql`TRUNCATE TABLE ${events}, ${eventTags}, ${deletedEvents}, ${deletedAddressable} RESTART IDENTITY CASCADE`,
  );
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function recv(ws: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const received: unknown[] = [];
    const onMessage = (data: Buffer) => {
      const parsed = JSON.parse(data.toString()) as unknown[];
      // The server now proactively issues an AUTH challenge on every
      // connection (NIP-42). Tests that don't exercise auth should skip it.
      if (Array.isArray(parsed) && parsed[0] === "AUTH") return;
      received.push(parsed);
      if (received.length >= count) {
        ws.off("message", onMessage);
        resolve(received);
      }
    };
    ws.on("message", onMessage);
    ws.once("error", reject);
  });
}

function sign(template: {
  kind?: number;
  content?: string;
  created_at?: number;
  tags?: string[][];
}) {
  const sk = generateSecretKey();
  const signed = finalizeEvent(
    {
      kind: template.kind ?? 1,
      created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      tags: template.tags ?? [],
      content: template.content ?? "hello",
    },
    sk,
  );
  // nostr-tools attaches a Symbol(verified) that breaks deep equality after JSON roundtrip
  return JSON.parse(JSON.stringify(signed)) as typeof signed;
}

test("EVENT → OK, REQ → stored event + EOSE", async () => {
  const event = sign({ content: "from smoke test" });

  const ws = await connect();
  const wait = recv(ws, 1);
  ws.send(JSON.stringify(["EVENT", event]));
  const [ok] = await wait;
  expect(ok).toEqual(["OK", event.id, true, ""]);

  const wait2 = recv(ws, 2);
  ws.send(JSON.stringify(["REQ", "sub1", { kinds: [1] }]));
  const [ev, eose] = await wait2;
  expect(ev).toEqual(["EVENT", "sub1", event]);
  expect(eose).toEqual(["EOSE", "sub1"]);

  ws.close();
});

test("two clients: one subscribes, other publishes, sub receives broadcast", async () => {
  const listener = await connect();
  const sender = await connect();

  const eose = recv(listener, 1);
  listener.send(JSON.stringify(["REQ", "sub1", { kinds: [1] }]));
  expect(await eose).toEqual([["EOSE", "sub1"]]);

  const broadcast = recv(listener, 1);
  const event = sign({ content: "broadcast" });
  const ok = recv(sender, 1);
  sender.send(JSON.stringify(["EVENT", event]));

  expect(await ok).toEqual([["OK", event.id, true, ""]]);
  expect(await broadcast).toEqual([["EVENT", "sub1", event]]);

  listener.close();
  sender.close();
});

test("health endpoint returns 200", async () => {
  const res = await fetch(`http://localhost:${running.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("NIP-11 relay info document served on GET / with application/nostr+json", async () => {
  const res = await fetch(`http://localhost:${running.port}/`, {
    headers: { Accept: "application/nostr+json" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/nostr+json");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");

  const info = (await res.json()) as {
    supported_nips: number[];
    software: string;
    version: string;
    limitation: {
      default_limit: number;
      max_message_length?: number;
      max_subscriptions?: number;
    };
  };
  expect(info.supported_nips).toContain(1);
  expect(info.supported_nips).toContain(9);
  expect(info.supported_nips).toContain(11);
  expect(info.supported_nips).toContain(40);
  expect(info.supported_nips).toContain(42);
  expect(info.supported_nips).toContain(70);
  expect(info.software).toBeTypeOf("string");
  expect(info.version).toBeTypeOf("string");
  expect(info.limitation.default_limit).toBeGreaterThan(0);
  expect(info.limitation.max_message_length).toBeGreaterThan(0);
  expect(info.limitation.max_subscriptions).toBeGreaterThan(0);
});

test("root without nostr+json Accept returns the plain upgrade hint", async () => {
  const res = await fetch(`http://localhost:${running.port}/`);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("nostr relay");
});

test("OPTIONS preflight returns CORS headers", async () => {
  const res = await fetch(`http://localhost:${running.port}/`, { method: "OPTIONS" });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("access-control-allow-methods")).toContain("GET");
});

test("per-IP connection cap rejects the third socket with HTTP 429", async () => {
  const capped = await startRelay({
    port: 0,
    databaseUrl: DATABASE_URL,
    logger: nullLogger,
    maxConnectionsPerIp: 2,
  });
  try {
    const url = `ws://localhost:${capped.port}`;
    const w1 = new WebSocket(url);
    const w2 = new WebSocket(url);
    await Promise.all(
      [w1, w2].map(
        (w) =>
          new Promise<void>((res, rej) => {
            w.once("open", () => res());
            w.once("error", rej);
          }),
      ),
    );

    const w3 = new WebSocket(url);
    const err = await new Promise<Error>((res) => w3.once("error", res));
    expect(err.message).toMatch(/429/);

    w1.close();
    w2.close();
  } finally {
    await capped.stop();
  }
});

test("NIP-70 protected event from unauthed client is rejected with auth-required", async () => {
  const event = sign({ content: "secret", tags: [["-"]] });

  const ws = await connect();
  const wait = recv(ws, 1);
  ws.send(JSON.stringify(["EVENT", event]));
  const [ok] = await wait;
  expect(ok).toBeInstanceOf(Array);
  const arr = ok as unknown[];
  expect(arr[0]).toBe("OK");
  expect(arr[2]).toBe(false);
  expect(arr[3]).toMatch(/^auth-required:/);

  ws.close();
});

test("write allowlist: team pubkey accepted, others rejected with restricted", async () => {
  const teamSk = generateSecretKey();
  const teamPubkey = getPublicKey(teamSk);
  const gated = await startRelay({
    port: 0,
    databaseUrl: DATABASE_URL,
    logger: nullLogger,
    writeAllowlist: new Set([teamPubkey]),
  });
  try {
    const url = `ws://localhost:${gated.port}`;

    // A team-signed event is accepted (gated by signature, no AUTH needed).
    const teamEvent = JSON.parse(
      JSON.stringify(
        finalizeEvent(
          { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "team" },
          teamSk,
        ),
      ),
    );
    const wsTeam = new WebSocket(url);
    const teamRes = await new Promise<unknown[]>((resolve, reject) => {
      wsTeam.once("open", () => wsTeam.send(JSON.stringify(["EVENT", teamEvent])));
      wsTeam.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString()) as unknown[];
        if (m[0] === "OK") resolve(m);
      });
      wsTeam.once("error", reject);
    });
    expect(teamRes[2]).toBe(true);
    wsTeam.close();

    // A non-team signer is rejected with `restricted`.
    const outsider = sign({ content: "outsider" });
    const wsOut = new WebSocket(url);
    const outRes = await new Promise<unknown[]>((resolve, reject) => {
      wsOut.once("open", () => wsOut.send(JSON.stringify(["EVENT", outsider])));
      wsOut.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString()) as unknown[];
        if (m[0] === "OK") resolve(m);
      });
      wsOut.once("error", reject);
    });
    expect(outRes[2]).toBe(false);
    expect(outRes[3]).toMatch(/^restricted:/);
    wsOut.close();
  } finally {
    await gated.stop();
  }
});

test("server issues a NIP-42 AUTH challenge on connection open", async () => {
  // Register the message listener BEFORE the open event to avoid racing
  // the server's immediate AUTH emit.
  const ws = new WebSocket(wsUrl);
  const firstFrame = await new Promise<unknown[]>((resolve, reject) => {
    ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString()) as unknown[]));
    ws.once("error", reject);
  });
  expect(firstFrame[0]).toBe("AUTH");
  expect(typeof firstFrame[1]).toBe("string");
  expect((firstFrame[1] as string).length).toBeGreaterThan(10);
  ws.close();
});

test("scheduled sweeper removes expired events", async () => {
  const short = await startRelay({
    port: 0,
    databaseUrl: DATABASE_URL,
    logger: nullLogger,
    expiredSweepMs: 50,
  });
  try {
    // Publish an event that's already expired relative to the real clock.
    // save() will reject it, so instead we insert one that will expire within
    // a couple of ticks of the sweeper.
    const url = `ws://localhost:${short.port}`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // Insert a row directly with expires_at just ahead of now so the sweeper
    // catches it on its next tick.
    const pastExpiration = Math.floor(Date.now() / 1000) - 1;
    await direct.db.execute(
      sql`INSERT INTO ${events} (id, pubkey, created_at, kind, content, sig, expires_at) VALUES (
        ${"f".repeat(64)}, ${"a".repeat(64)}, 1, 1, '', ${"0".repeat(128)}, ${pastExpiration}
      )`,
    );

    // Wait a few sweep ticks.
    await new Promise((r) => setTimeout(r, 200));

    const remaining = await direct.db
      .select({ id: events.id })
      .from(events)
      .where(sql`${events.id} = ${"f".repeat(64)}`);
    expect(remaining).toHaveLength(0);

    ws.close();
  } finally {
    await short.stop();
  }
});

test("server sends periodic pings to keep connections alive", async () => {
  const fast = await startRelay({
    port: 0,
    databaseUrl: DATABASE_URL,
    heartbeatMs: 50,
    logger: nullLogger,
  });
  try {
    const ws = new WebSocket(`ws://localhost:${fast.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const gotPing = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 500);
      ws.once("ping", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    expect(gotPing).toBe(true);
    ws.close();
  } finally {
    await fast.stop();
  }
});

test("db-backed write allowlist: loads table at startup and refreshes on NOTIFY", async () => {
  await direct.db.execute(sql`TRUNCATE TABLE write_allowlist`);
  const now = Math.floor(Date.now() / 1000);
  const teamSk = generateSecretKey();
  const teamPubkey = getPublicKey(teamSk);
  // Seed one author before the relay boots → loaded by the source on init.
  await direct.db.execute(
    sql`INSERT INTO write_allowlist (pubkey, added_at) VALUES (${teamPubkey}, ${now})`,
  );

  // No `writeAllowlist` option → the relay uses the live DB-backed source.
  const gated = await startRelay({ port: 0, databaseUrl: DATABASE_URL, logger: nullLogger });
  try {
    const url = `ws://localhost:${gated.port}`;
    const publish = (sk: Uint8Array): Promise<unknown[]> => {
      const ev = JSON.parse(
        JSON.stringify(
          finalizeEvent(
            { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "x" },
            sk,
          ),
        ),
      );
      return new Promise<unknown[]>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once("open", () => ws.send(JSON.stringify(["EVENT", ev])));
        ws.on("message", (d: Buffer) => {
          const m = JSON.parse(d.toString()) as unknown[];
          if (m[0] === "OK") {
            ws.close();
            resolve(m);
          }
        });
        ws.once("error", reject);
      });
    };

    const newSk = generateSecretKey();
    const newPubkey = getPublicKey(newSk);

    // The initial load is async; poll until the gate is active (a non-listed
    // author is rejected). Before the load lands, the set is empty = open.
    let gateActive = false;
    for (let i = 0; i < 40 && !gateActive; i++) {
      await new Promise((r) => setTimeout(r, 50));
      gateActive = (await publish(newSk))[2] === false;
    }
    expect(gateActive).toBe(true);
    // The seeded author is accepted.
    expect((await publish(teamSk))[2]).toBe(true);

    // Add the new author live + NOTIFY; the source refreshes and accepts it.
    await direct.db.execute(
      sql`INSERT INTO write_allowlist (pubkey, added_at) VALUES (${newPubkey}, ${now})`,
    );
    await direct.db.execute(sql`SELECT pg_notify('write_allowlist_changed', '')`);

    let accepted = false;
    for (let i = 0; i < 40 && !accepted; i++) {
      await new Promise((r) => setTimeout(r, 50));
      accepted = (await publish(newSk))[2] === true;
    }
    expect(accepted).toBe(true);
  } finally {
    await gated.stop();
    await direct.db.execute(sql`TRUNCATE TABLE write_allowlist`);
  }
});
