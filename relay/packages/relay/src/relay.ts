import {
  authMessage,
  closedMessage,
  eoseMessage,
  eventMessage,
  noticeMessage,
  okMessage,
  parseClientMessage,
  prefixed,
  type RelayMessage,
} from "./domain/messages.ts";
import type { Filter } from "./domain/filter.ts";
import { ConnectionAuth, KIND_AUTH, validateAuthEvent } from "./domain/auth.ts";
import type { SubscriptionRegistry } from "./domain/subscription.ts";
import { type NostrEvent, validateEvent } from "./domain/validate.ts";
import { nullLogger, type Logger } from "./logger.ts";
import { nullMetrics, type Metrics } from "./metrics.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { EventStore, SaveOutcome } from "./store.ts";

export interface OutgoingMessage {
  connId: string;
  message: RelayMessage;
}

export interface Relay {
  /**
   * Called by the transport when a new WebSocket connection is established.
   * Yielded messages are sent to this connection — typically the initial
   * NIP-42 AUTH challenge when auth is enabled.
   */
  handleConnectionOpen(connId: string): AsyncIterable<OutgoingMessage>;
  handleClientMessage(connId: string, raw: unknown): AsyncIterable<OutgoingMessage>;
  handleDisconnect(connId: string): void;
}

/** Decision returned by an optional `AuthPolicy` hook. */
export type PolicyDecision =
  | { ok: true }
  | { ok: false; kind: "auth-required" | "restricted"; message?: string };

export interface AuthPolicy {
  /** Gate REQ messages. Return `{ ok: false, kind: "auth-required" }` to require AUTH first. */
  canRead?: (ctx: {
    connId: string;
    filters: Filter[];
    authenticatedPubkeys: ReadonlySet<string>;
  }) => PolicyDecision;
  /** Gate EVENT writes. */
  canWrite?: (ctx: {
    connId: string;
    event: NostrEvent;
    authenticatedPubkeys: ReadonlySet<string>;
  }) => PolicyDecision;
}

export interface RelayDeps {
  store: EventStore;
  registry: SubscriptionRegistry;
  logger?: Logger;
  /**
   * Optional per-connection EVENT rate limiter. When present, each incoming
   * EVENT consumes a token; empty-bucket responses are rejected with
   * OK(false, "rate-limited: …").
   */
  eventRateLimiter?: RateLimiter;
  /** Metrics sink. Defaults to `nullMetrics`. */
  metrics?: Metrics;
  /**
   * NIP-42 auth policy hook. Leave unset for an unrestricted public relay
   * (default). When set, the orchestrator gates reads/writes per `canRead`/
   * `canWrite`. AUTH plumbing (challenge issuance, validation, session state)
   * is always active so policies can rely on it.
   */
  authPolicy?: AuthPolicy;
  /**
   * This relay's public URL, used to verify the `relay` tag on AUTH events.
   * Required for NIP-42; if unset, AUTH events that pass signature validation
   * will still be rejected with "restricted: relay url not configured".
   */
  relayUrl?: string;
  /** Clock in unix seconds — overridable for tests. */
  now?: () => number;
}

export function createRelay({
  store,
  registry,
  logger = nullLogger,
  eventRateLimiter,
  metrics = nullMetrics,
  authPolicy,
  relayUrl,
  now = () => Math.floor(Date.now() / 1000),
}: RelayDeps): Relay {
  const baseLog = logger.child({ component: "relay" });
  const auth = new ConnectionAuth();

  async function* handleConnectionOpen(connId: string): AsyncIterable<OutgoingMessage> {
    // Always issue a challenge — announces NIP-42 support and lets clients
    // authenticate proactively. Policy gating is independent: an
    // unrestricted relay still speaks AUTH.
    const challenge = auth.challengeFor(connId);
    yield { connId, message: authMessage(challenge) };
  }

  async function* handleClientMessage(
    connId: string,
    raw: unknown,
  ): AsyncIterable<OutgoingMessage> {
    const log = baseLog.child({ connId });
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      metrics.increment("messages_parse_errors");
      log.warn({ reason: parsed.reason }, "parse error");
      yield { connId, message: noticeMessage(prefixed("error", parsed.reason)) };
      return;
    }

    switch (parsed.message.type) {
      case "EVENT":
        metrics.increment("events_received");
        yield* handleEvent(connId, parsed.message.event, log);
        return;
      case "REQ":
        metrics.increment("subscriptions_opened");
        yield* handleReq(connId, parsed.message.subscriptionId, parsed.message.filters, log);
        return;
      case "CLOSE":
        metrics.increment("subscriptions_closed");
        registry.remove(connId, parsed.message.subscriptionId);
        log.debug({ subId: parsed.message.subscriptionId }, "close");
        return;
      case "AUTH":
        metrics.increment("auth_received");
        yield* handleAuth(connId, parsed.message.event, log);
        return;
    }
  }

  async function* handleAuth(
    connId: string,
    rawEvent: unknown,
    log: Logger,
  ): AsyncIterable<OutgoingMessage> {
    const validation = validateEvent(rawEvent);
    if (!validation.ok) {
      log.warn({ reason: validation.reason }, "auth event invalid");
      metrics.increment("auth_invalid");
      yield {
        connId,
        message: okMessage(extractId(rawEvent), false, prefixed("invalid", validation.reason)),
      };
      return;
    }
    const event = validation.event;

    if (!relayUrl) {
      log.error({}, "auth received but RELAY_PUBLIC_URL is not configured");
      metrics.increment("auth_misconfigured");
      yield {
        connId,
        message: okMessage(event.id, false, prefixed("restricted", "relay url not configured")),
      };
      return;
    }

    const challenge = auth.challengeFor(connId);
    const result = validateAuthEvent(event, {
      challenge,
      relayUrl,
      now: now(),
    });
    if (!result.ok) {
      // Rotate the challenge so a single captured value can't be attacked
      // repeatedly. The client should read the next AUTH message (or ask
      // again) to get the new one.
      const next = auth.rotateChallenge(connId);
      log.warn({ reason: result.reason, pubkey: event.pubkey }, "auth rejected");
      metrics.increment("auth_rejected");
      yield {
        connId,
        message: okMessage(event.id, false, prefixed("restricted", result.reason)),
      };
      yield { connId, message: authMessage(next) };
      return;
    }

    auth.authenticate(connId, result.pubkey);
    log.info({ pubkey: result.pubkey }, "auth ok");
    metrics.increment("auth_ok");
    yield { connId, message: okMessage(event.id, true, "") };
  }

  async function* handleEvent(
    connId: string,
    rawEvent: unknown,
    log: Logger,
  ): AsyncIterable<OutgoingMessage> {
    // Check the rate limit BEFORE signature validation — schnorr verify is
    // CPU-heavy, and we don't want an attacker to be able to spam forged
    // events at unlimited rate just by tripping `invalid` every time.
    if (eventRateLimiter && !eventRateLimiter.allow(connId)) {
      metrics.increment("events_rate_limited");
      log.warn({}, "event rate limited");
      yield {
        connId,
        message: okMessage(
          extractId(rawEvent),
          false,
          prefixed("rate-limited", "too many events, slow down"),
        ),
      };
      return;
    }

    const validation = validateEvent(rawEvent);
    if (!validation.ok) {
      log.warn({ reason: validation.reason }, "event validation failed");
      yield {
        connId,
        message: okMessage(extractId(rawEvent), false, prefixed("invalid", validation.reason)),
      };
      return;
    }
    const event = validation.event;

    // NIP-42: kind 22242 events must never be stored or broadcast, and
    // belong in the AUTH message type, not EVENT. Reject with accepted=false
    // so clients don't cache a "stored" state and skip retrying via AUTH.
    if (event.kind === KIND_AUTH) {
      yield {
        connId,
        message: okMessage(
          event.id,
          false,
          prefixed("invalid", "kind 22242 must be sent via AUTH message, not EVENT"),
        ),
      };
      return;
    }

    const writeDecision = authPolicy?.canWrite?.({
      connId,
      event,
      authenticatedPubkeys: auth.authenticatedPubkeys(connId),
    });
    if (writeDecision && !writeDecision.ok) {
      const message =
        writeDecision.message ??
        (writeDecision.kind === "auth-required"
          ? "authentication required"
          : "not authorized to write this event");
      metrics.increment(
        `events_${writeDecision.kind === "auth-required" ? "auth_required" : "restricted"}`,
      );
      log.warn({ eventId: event.id, decision: writeDecision.kind }, "event blocked by policy");
      yield {
        connId,
        message: okMessage(event.id, false, prefixed(writeDecision.kind, message)),
      };
      return;
    }

    let outcome: SaveOutcome;
    try {
      outcome = await store.save(event);
    } catch (err) {
      log.error(
        { eventId: event.id, err: err instanceof Error ? err.message : String(err) },
        "store.save threw",
      );
      yield {
        connId,
        message: okMessage(
          event.id,
          false,
          prefixed("error", err instanceof Error ? err.message : "could not save event"),
        ),
      };
      return;
    }

    const broadcasts: OutgoingMessage[] = [];
    if (shouldBroadcast(outcome)) {
      for (const sub of registry.matching(event)) {
        broadcasts.push({
          connId: sub.connId,
          message: eventMessage(sub.subId, event),
        });
      }
    }
    if (broadcasts.length > 0) metrics.increment("broadcasts_sent", broadcasts.length);

    log.info(
      {
        eventId: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
        outcome: outcome.type,
        broadcastCount: broadcasts.length,
      },
      "event",
    );

    yield {
      connId,
      message: okForOutcome(event.id, outcome, broadcasts.length),
    };

    for (const b of broadcasts) yield b;
  }

  async function* handleReq(
    connId: string,
    subscriptionId: string,
    filters: import("./domain/filter.ts").Filter[],
    log: Logger,
  ): AsyncIterable<OutgoingMessage> {
    const readDecision = authPolicy?.canRead?.({
      connId,
      filters,
      authenticatedPubkeys: auth.authenticatedPubkeys(connId),
    });
    if (readDecision && !readDecision.ok) {
      const message =
        readDecision.message ??
        (readDecision.kind === "auth-required"
          ? "authentication required"
          : "not authorized to read these events");
      metrics.increment(
        `subscriptions_${readDecision.kind === "auth-required" ? "auth_required" : "restricted"}`,
      );
      log.warn({ subId: subscriptionId, decision: readDecision.kind }, "req blocked by policy");
      yield {
        connId,
        message: closedMessage(subscriptionId, prefixed(readDecision.kind, message)),
      };
      return;
    }

    if (!registry.add(connId, subscriptionId, filters)) {
      metrics.increment("subscriptions_rejected");
      log.warn({ subId: subscriptionId }, "subscription cap reached");
      yield {
        connId,
        message: closedMessage(subscriptionId, prefixed("rate-limited", "too many subscriptions")),
      };
      return;
    }

    let sent = 0;
    try {
      for await (const event of store.query(filters)) {
        yield { connId, message: eventMessage(subscriptionId, event) };
        sent++;
      }
    } catch (err) {
      registry.remove(connId, subscriptionId);
      log.error(
        {
          subId: subscriptionId,
          err: err instanceof Error ? err.message : String(err),
        },
        "req query failed",
      );
      yield {
        connId,
        message: closedMessage(
          subscriptionId,
          prefixed("error", err instanceof Error ? err.message : "query failed"),
        ),
      };
      return;
    }

    log.info({ subId: subscriptionId, filterCount: filters.length, sent }, "req");

    yield { connId, message: eoseMessage(subscriptionId) };
  }

  function handleDisconnect(connId: string): void {
    const removed = registry.removeAll(connId);
    eventRateLimiter?.forget(connId);
    auth.forget(connId);
    baseLog.debug({ connId, subsRemoved: removed }, "disconnect");
  }

  return { handleConnectionOpen, handleClientMessage, handleDisconnect };
}

function shouldBroadcast(outcome: SaveOutcome): boolean {
  switch (outcome.type) {
    case "stored":
    case "replaced":
    case "ephemeral":
      return true;
    case "duplicate":
    case "outdated":
    case "blocked":
    case "expired":
    case "invalid":
      return false;
  }
}

function okForOutcome(eventId: string, outcome: SaveOutcome, deliveredCount: number): RelayMessage {
  switch (outcome.type) {
    case "stored":
    case "replaced":
      return okMessage(eventId, true, "");
    case "duplicate":
      return okMessage(eventId, true, prefixed("duplicate", "already have this event"));
    case "outdated":
      return okMessage(eventId, true, prefixed("duplicate", "have a newer version"));
    case "ephemeral":
      return deliveredCount > 0
        ? okMessage(eventId, true, "")
        : okMessage(
            eventId,
            true,
            prefixed("mute", "no one was listening to your ephemeral event"),
          );
    case "blocked":
      return okMessage(eventId, false, prefixed("blocked", outcome.reason));
    case "expired":
      return okMessage(eventId, false, prefixed("invalid", "event is expired"));
    case "invalid":
      return okMessage(eventId, false, prefixed("invalid", outcome.reason));
  }
}

function extractId(raw: unknown): string {
  if (typeof raw === "object" && raw !== null) {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return "";
}
