import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Omit<NostrEvent, "id" | "sig">;

export type InvalidReason =
  | "not_object"
  | "bad_id"
  | "bad_pubkey"
  | "bad_sig"
  | "bad_created_at"
  | "bad_kind"
  | "bad_tags"
  | "bad_content"
  | "id_mismatch"
  | "invalid_signature";

export type ValidationResult =
  | { ok: true; event: NostrEvent }
  | { ok: false; reason: InvalidReason };

const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_128 = /^[a-f0-9]{128}$/;
const utf8 = new TextEncoder();

export function serializeEvent(event: UnsignedEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export function computeEventId(event: UnsignedEvent): string {
  return bytesToHex(sha256(utf8.encode(serializeEvent(event))));
}

export function validateEvent(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "not_object" };
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.id !== "string" || !HEX_64.test(e.id)) {
    return { ok: false, reason: "bad_id" };
  }
  if (typeof e.pubkey !== "string" || !HEX_64.test(e.pubkey)) {
    return { ok: false, reason: "bad_pubkey" };
  }
  if (typeof e.sig !== "string" || !HEX_128.test(e.sig)) {
    return { ok: false, reason: "bad_sig" };
  }
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at) || e.created_at < 0) {
    return { ok: false, reason: "bad_created_at" };
  }
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind) || e.kind < 0 || e.kind > 65535) {
    return { ok: false, reason: "bad_kind" };
  }
  if (typeof e.content !== "string") {
    return { ok: false, reason: "bad_content" };
  }
  if (!Array.isArray(e.tags)) {
    return { ok: false, reason: "bad_tags" };
  }
  for (const tag of e.tags) {
    if (!Array.isArray(tag)) {
      return { ok: false, reason: "bad_tags" };
    }
    for (const v of tag) {
      if (typeof v !== "string") {
        return { ok: false, reason: "bad_tags" };
      }
    }
  }

  const event = e as unknown as NostrEvent;

  if (computeEventId(event) !== event.id) {
    return { ok: false, reason: "id_mismatch" };
  }

  let sigValid: boolean;
  try {
    sigValid = schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  if (!sigValid) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true, event };
}
