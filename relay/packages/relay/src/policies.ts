import type { AuthPolicy, PolicyDecision } from "./relay.ts";

/** NIP-70 marker tag. */
const PROTECTED_TAG = "-";

/** True when an event carries the NIP-70 `["-"]` protected marker. */
export function isProtectedEvent(event: { tags: readonly (readonly string[])[] }): boolean {
  return event.tags.some((t) => t[0] === PROTECTED_TAG);
}

/**
 * NIP-70: only the author may publish events tagged with `["-"]`. Returns a
 * `canWrite` fragment suitable for plugging into an `AuthPolicy`.
 *
 * Per spec: a relay that doesn't support NIP-70 MUST reject all `["-"]`
 * events outright; a relay that does must require NIP-42 AUTH and a matching
 * pubkey. Returning `auth-required` (not `restricted`) on rejection matches
 * the spec's example flow and prompts compliant clients to AUTH and retry.
 */
export function protectedEventsPolicy(): NonNullable<AuthPolicy["canWrite"]> {
  return ({ event, authenticatedPubkeys }) => {
    if (!isProtectedEvent(event)) return { ok: true };
    if (authenticatedPubkeys.has(event.pubkey)) return { ok: true };
    return {
      ok: false,
      kind: "auth-required",
      message: "this event may only be published by its author",
    };
  };
}

/**
 * Restrict writes to a set of author pubkeys ("team write" relays). An event
 * is accepted only if its `pubkey` is on the list — and since the event is
 * already signature-verified upstream, that proves a holder of that key
 * authored it (no NIP-42 AUTH round-trip needed for writers). Republishing an
 * existing allowed event is harmless (the store dedups it).
 *
 * An empty set disables the gate (open writes), so this is opt-in per
 * deployment. Pass a `Set` for a static list, or a getter for a live source
 * (e.g. the DB-backed allowlist the admin UI manages) — the getter is read on
 * every write, so updates take effect without restarting the relay.
 */
export function writeAllowlistPolicy(
  allowed: ReadonlySet<string> | (() => ReadonlySet<string>),
): NonNullable<AuthPolicy["canWrite"]> {
  const current = typeof allowed === "function" ? allowed : () => allowed;
  return ({ event }) => {
    const set = current();
    if (set.size === 0) return { ok: true };
    if (set.has(event.pubkey)) return { ok: true };
    return {
      ok: false,
      kind: "restricted",
      message: "not authorized to publish to this relay",
    };
  };
}

/**
 * Restrict writes to an allowed set of event kinds. Useful for special-purpose
 * relays — e.g. a Parcel21 consignment relay that only carries NIP-59 gift
 * wraps (kind 1059). An empty set disables the gate, so this is opt-in per
 * deployment (wire it from an env var).
 */
export function kindAllowlistPolicy(
  allowed: ReadonlySet<number>,
): NonNullable<AuthPolicy["canWrite"]> {
  return ({ event }) => {
    if (allowed.size === 0) return { ok: true };
    if (allowed.has(event.kind)) return { ok: true };
    return {
      ok: false,
      kind: "restricted",
      message: `event kind ${event.kind} is not accepted by this relay`,
    };
  };
}

/**
 * Combine multiple `canWrite` policies into one. The first policy that
 * returns a non-ok decision short-circuits the chain. Useful for wiring
 * NIP-70 alongside operator-specific gates (whitelists, paywalls, etc.).
 */
export function composeWritePolicies(
  ...policies: Array<NonNullable<AuthPolicy["canWrite"]>>
): NonNullable<AuthPolicy["canWrite"]> {
  return (ctx) => {
    for (const policy of policies) {
      const decision: PolicyDecision = policy(ctx);
      if (!decision.ok) return decision;
    }
    return { ok: true };
  };
}
