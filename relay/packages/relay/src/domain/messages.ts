import type { Filter } from "./filter.ts";
import type { NostrEvent } from "./validate.ts";

// ─── Client → Relay ──────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "EVENT"; event: unknown }
  | { type: "REQ"; subscriptionId: string; filters: Filter[] }
  | { type: "CLOSE"; subscriptionId: string }
  | { type: "AUTH"; event: unknown };

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; reason: string };

const MAX_SUB_ID_LEN = 64;

export function parseClientMessage(raw: unknown): ParseResult {
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "invalid json" };
    }
  } else {
    parsed = raw;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: "message must be a non-empty array" };
  }

  const [kind, ...rest] = parsed as [unknown, ...unknown[]];
  if (typeof kind !== "string") {
    return { ok: false, reason: "message type must be a string" };
  }

  switch (kind) {
    case "EVENT":
      return parseEvent(rest);
    case "REQ":
      return parseReq(rest);
    case "CLOSE":
      return parseClose(rest);
    case "AUTH":
      return parseAuth(rest);
    default:
      return { ok: false, reason: `unknown message type: ${kind}` };
  }
}

function parseAuth(rest: unknown[]): ParseResult {
  if (rest.length !== 1) {
    return { ok: false, reason: "AUTH message must have exactly one payload" };
  }
  const event = rest[0];
  if (typeof event !== "object" || event === null) {
    return { ok: false, reason: "AUTH payload must be an object" };
  }
  return { ok: true, message: { type: "AUTH", event } };
}

function parseEvent(rest: unknown[]): ParseResult {
  if (rest.length !== 1) {
    return { ok: false, reason: "EVENT message must have exactly one payload" };
  }
  const event = rest[0];
  if (typeof event !== "object" || event === null) {
    return { ok: false, reason: "EVENT payload must be an object" };
  }
  return { ok: true, message: { type: "EVENT", event } };
}

function parseReq(rest: unknown[]): ParseResult {
  if (rest.length < 2) {
    return {
      ok: false,
      reason: "REQ message must have a subscription id and at least one filter",
    };
  }
  const [subId, ...rawFilters] = rest;
  if (!isValidSubscriptionId(subId)) {
    return { ok: false, reason: "invalid subscription id" };
  }

  const filters: Filter[] = [];
  for (let i = 0; i < rawFilters.length; i++) {
    const result = parseFilter(rawFilters[i]);
    if (!result.ok) {
      return { ok: false, reason: `filter ${i}: ${result.reason}` };
    }
    filters.push(result.filter);
  }

  return {
    ok: true,
    message: { type: "REQ", subscriptionId: subId, filters },
  };
}

function parseClose(rest: unknown[]): ParseResult {
  if (rest.length !== 1) {
    return { ok: false, reason: "CLOSE message must have exactly one payload" };
  }
  const subId = rest[0];
  if (!isValidSubscriptionId(subId)) {
    return { ok: false, reason: "invalid subscription id" };
  }
  return { ok: true, message: { type: "CLOSE", subscriptionId: subId } };
}

function isValidSubscriptionId(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= MAX_SUB_ID_LEN;
}

type FilterParseResult = { ok: true; filter: Filter } | { ok: false; reason: string };

function parseFilter(raw: unknown): FilterParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "filter must be an object" };
  }
  const filter: Filter = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case "ids":
      case "authors": {
        if (!isStringArray(value))
          return { ok: false, reason: `${key} must be an array of strings` };
        filter[key] = value;
        break;
      }
      case "kinds": {
        if (!isIntArray(value)) return { ok: false, reason: "kinds must be an array of integers" };
        filter.kinds = value;
        break;
      }
      case "since":
      case "until":
      case "limit": {
        if (!isNonNegativeInt(value)) {
          return { ok: false, reason: `${key} must be a non-negative integer` };
        }
        filter[key] = value;
        break;
      }
      default: {
        if (key.startsWith("#")) {
          if (!isStringArray(value))
            return { ok: false, reason: `${key} must be an array of strings` };
          (filter as Record<string, unknown>)[key] = value;
        }
        // unknown keys are ignored for forward compatibility
      }
    }
  }
  return { ok: true, filter };
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function isIntArray(x: unknown): x is number[] {
  return Array.isArray(x) && x.every((v) => typeof v === "number" && Number.isInteger(v));
}

function isNonNegativeInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

// ─── Relay → Client ──────────────────────────────────────────────────────────

export type OkPrefix =
  | "duplicate"
  | "pow"
  | "blocked"
  | "rate-limited"
  | "invalid"
  | "restricted"
  | "mute"
  | "error"
  | "auth-required";

export type RelayMessage =
  | { type: "EVENT"; subscriptionId: string; event: NostrEvent }
  | { type: "OK"; eventId: string; accepted: boolean; message: string }
  | { type: "EOSE"; subscriptionId: string }
  | { type: "CLOSED"; subscriptionId: string; message: string }
  | { type: "NOTICE"; message: string }
  | { type: "AUTH"; challenge: string };

export function serializeRelayMessage(msg: RelayMessage): string {
  switch (msg.type) {
    case "EVENT":
      return JSON.stringify(["EVENT", msg.subscriptionId, msg.event]);
    case "OK":
      return JSON.stringify(["OK", msg.eventId, msg.accepted, msg.message]);
    case "EOSE":
      return JSON.stringify(["EOSE", msg.subscriptionId]);
    case "CLOSED":
      return JSON.stringify(["CLOSED", msg.subscriptionId, msg.message]);
    case "NOTICE":
      return JSON.stringify(["NOTICE", msg.message]);
    case "AUTH":
      return JSON.stringify(["AUTH", msg.challenge]);
  }
}

// ─── Constructors ────────────────────────────────────────────────────────────

export function eventMessage(subscriptionId: string, event: NostrEvent): RelayMessage {
  return { type: "EVENT", subscriptionId, event };
}

export function okMessage(eventId: string, accepted: boolean, message = ""): RelayMessage {
  return { type: "OK", eventId, accepted, message };
}

export function eoseMessage(subscriptionId: string): RelayMessage {
  return { type: "EOSE", subscriptionId };
}

export function closedMessage(subscriptionId: string, message: string): RelayMessage {
  return { type: "CLOSED", subscriptionId, message };
}

export function noticeMessage(message: string): RelayMessage {
  return { type: "NOTICE", message };
}

export function authMessage(challenge: string): RelayMessage {
  return { type: "AUTH", challenge };
}

export function prefixed(prefix: OkPrefix, message: string): string {
  return `${prefix}: ${message}`;
}
