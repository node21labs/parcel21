/**
 * Parcel21 protocol library — RGB consignment exchange over Nostr.
 *
 * Implements the client side of ../../spec/nip-XX-rgb-consignment-exchange.md against
 * nostr-tools 2.23.x. Framework-agnostic (no TanStack imports) so it can be unit-tested
 * and reused. The TanStack Start UI imports these functions.
 *
 * SECURITY (NIP §2.1): nostr-tools `unwrapEvent` performs ONLY two NIP-44 decryptions and
 * NO authentication. Because the rumor is unsigned, a forged gift wrap could otherwise
 * inject a consignment — or forge an ACK to the payer's reply mailbox and trigger a
 * Bitcoin broadcast. We therefore unwrap MANUALLY via `verifiedUnwrap`, which verifies the
 * seal's signature, binds seal.pubkey === rumor.pubkey, and recomputes rumor.id.
 */

import { generateSecretKey, getPublicKey, getEventHash, verifyEvent } from 'nostr-tools/pure'
import type { Event, UnsignedEvent } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'
import { GiftWrap, Seal } from 'nostr-tools/kinds'
import * as nip44 from 'nostr-tools/nip44'
import { decode as nip19decode, neventEncode } from 'nostr-tools/nip19'
import { SimplePool } from 'nostr-tools/pool'
import type { Filter } from 'nostr-tools/filter'

// --- Provisional Parcel21 inner-rumor kinds (NIP §4). Only ever appear encrypted inside a seal. ---
export const CONSIGNMENT_KIND = 1517
export const ACK_KIND = 1518
export const MEDIA_KIND = 1519

/** NIP-44 v2 hard plaintext ceiling (bytes) at EACH layer. */
const NIP44_PLAINTEXT_MAX = 65535
/**
 * Max raw consignment that may ride inline. base64 inflates ~33% and the payload is wrapped
 * twice, so we stay well under {@link NIP44_PLAINTEXT_MAX} (NIP §6). Larger → Blossom.
 */
export const INLINE_MAX_RAW_BYTES = 32 * 1024

export type Rumor = UnsignedEvent & { id: string }

export interface RgbNostrEndpoint {
  /** Payee public key (hex) to address consignments to and to verify ACK seals against. */
  payeePubHex: string
  /** Relays the payer publishes consignments to AND subscribes to for the ACK (NIP §8). */
  relays: string[]
}

export interface BlobRef {
  servers: string[]
  /** sha256 of the CIPHERTEXT blob (content address). */
  sha256: string
  size: number
  encryption: { algo: 'nip44' }
}

export interface ConsignmentPayload {
  recipient_id: string
  txid: string
  vout?: number
  /** sha256 of the CLEARTEXT consignment bytes — the immutability anchor (NIP §9). */
  sha256: string
  /** Per-transfer ephemeral pubkey (hex) — the anonymous ACK mailbox (NIP §8). */
  reply_to: string
  mode: 'inline' | 'blossom'
  consignment_b64?: string
  blob?: BlobRef
}

export interface AckPayload {
  recipient_id: string
  ack: boolean
  /** Binds the ACK to the exact consignment it answers (NIP §4.1). */
  consignment_sha256: string
  reason?: string
}

export type AckState = 'ACK' | 'NACK' | 'pending'

// --------------------------------------------------------------------------------------
// Endpoint parsing
// --------------------------------------------------------------------------------------

/** Parse an invoice transport endpoint: `rgbnostr:<npub>?relay=wss://…&relay=wss://…` (NIP §5). */
export function parseRgbNostrEndpoint(endpoint: string): RgbNostrEndpoint {
  const scheme = 'rgbnostr:'
  if (!endpoint.startsWith(scheme)) {
    throw new Error(`not an rgbnostr endpoint: ${endpoint}`)
  }
  const body = endpoint.slice(scheme.length)
  const qIdx = body.indexOf('?')
  const npub = qIdx === -1 ? body : body.slice(0, qIdx)
  const query = qIdx === -1 ? '' : body.slice(qIdx + 1)

  const decoded = nip19decode(npub)
  if (decoded.type !== 'npub') {
    throw new Error(`expected an npub in rgbnostr endpoint, got ${decoded.type}`)
  }
  const relays = new URLSearchParams(query).getAll('relay')
  if (relays.length === 0) {
    throw new Error('rgbnostr endpoint has no relay= parameter')
  }
  return { payeePubHex: decoded.data, relays }
}

// --------------------------------------------------------------------------------------
// Verified unwrap (NIP §2.1) — the security-critical path
// --------------------------------------------------------------------------------------

export interface VerifiedRumor {
  rumor: Rumor
  /** The authenticated seal author (true sender), only known after verification. */
  author: string
}

/**
 * Unwrap a NIP-59 gift wrap WITH authentication. Throws on any failure; callers MUST treat
 * a throw as "discard this event". Do NOT substitute nostr-tools `unwrapEvent` — it skips
 * every check below.
 */
export function verifiedUnwrap(wrap: Event, recipientSk: Uint8Array): VerifiedRumor {
  // Layer 2 (gift wrap)
  const sealJson = nip44.decrypt(wrap.content, nip44.getConversationKey(recipientSk, wrap.pubkey))
  const seal = JSON.parse(sealJson) as Event
  if (seal.kind !== Seal) {
    throw new Error(`expected seal kind ${Seal}, got ${seal.kind}`)
  }
  // Verify the seal's Schnorr signature under seal.pubkey (also checks seal.id == hash).
  if (!verifyEvent(seal)) {
    throw new Error('seal signature verification failed')
  }
  // Layer 1 (seal)
  const rumorJson = nip44.decrypt(seal.content, nip44.getConversationKey(recipientSk, seal.pubkey))
  const rumor = JSON.parse(rumorJson) as Rumor
  // Bind the unsigned rumor to the authenticated seal author.
  if (rumor.pubkey !== seal.pubkey) {
    throw new Error('rumor.pubkey does not match seal.pubkey (impersonation)')
  }
  // Recompute the rumor id over its canonical serialization.
  if (getEventHash(rumor) !== rumor.id) {
    throw new Error('rumor id mismatch')
  }
  return { rumor, author: seal.pubkey }
}

// --------------------------------------------------------------------------------------
// PAYER side — consignment.post + ack.get
// --------------------------------------------------------------------------------------

export interface PostConsignmentArgs {
  endpoint: RgbNostrEndpoint
  recipient_id: string
  txid: string
  vout?: number
  /** Already-produced, RGB-validated consignment bytes. */
  consignmentBytes: Uint8Array
}

export interface PostConsignmentResult {
  /** Per-transfer ephemeral reply key — keep it to subscribe for the ACK. */
  replyToSk: Uint8Array
  replyToPub: string
  /** sha256 of the cleartext consignment — used to match the ACK. */
  sha256: string
  /** The gift wrap that was published (kind 1059). */
  wrap: Event
}

/**
 * consignment.post — gift-wrap a consignment to the payee and publish to the payee's relays.
 * Generates a fresh per-transfer seal key (unlinkable across transfers, NIP "Privacy") and a
 * per-transfer reply key R for the anonymous ACK return path.
 */
export async function postConsignment(
  pool: SimplePool,
  args: PostConsignmentArgs,
): Promise<PostConsignmentResult> {
  const sealSk = generateSecretKey() // ephemeral per-transfer seal identity
  const replyToSk = generateSecretKey() // anonymous ACK mailbox
  const replyToPub = getPublicKey(replyToSk)
  const sha256 = await sha256hex(args.consignmentBytes)

  const payload: ConsignmentPayload = {
    recipient_id: args.recipient_id,
    txid: args.txid,
    sha256,
    reply_to: replyToPub,
    mode: 'inline',
  }
  if (args.vout !== undefined) payload.vout = args.vout

  if (args.consignmentBytes.length <= INLINE_MAX_RAW_BYTES) {
    payload.consignment_b64 = toBase64(args.consignmentBytes)
  } else {
    // NIP §6: encrypt, upload ciphertext to Blossom, reference {servers, sha256, size} here.
    payload.mode = 'blossom'
    payload.blob = await uploadCiphertextToBlossom(args.consignmentBytes, args.endpoint.payeePubHex)
  }

  const rumorTemplate = {
    kind: CONSIGNMENT_KIND,
    created_at: nowSeconds(),
    tags: [] as string[][],
    content: JSON.stringify(payload),
  }
  assertSealable(rumorTemplate)

  const wrap = wrapEvent(rumorTemplate, sealSk, args.endpoint.payeePubHex)
  await Promise.all(pool.publish(args.endpoint.relays, wrap))
  return { replyToSk, replyToPub, sha256, wrap }
}

export interface SubscribeAckArgs {
  relays: string[]
  replyToSk: Uint8Array
  replyToPub: string
  /** The invoice payee pubkey (hex) — the only author whose ACK we trust. */
  expectedPayeePubHex: string
  /** sha256 returned by postConsignment — the ACK must reference it. */
  expectedConsignmentSha256: string
}

/**
 * ack.get — subscribe (not poll) for the ACK on the anonymous reply mailbox, on the PAYEE's
 * relays (NIP §8). Invokes onResult once with the first VALID ACK/NACK; later flips are
 * ignored by closing the subscription. Returns a closer.
 */
export function subscribeAck(
  pool: SimplePool,
  args: SubscribeAckArgs,
  onResult: (state: Exclude<AckState, 'pending'>, reason?: string) => void,
): { close: () => void } {
  let settled = false
  const filter: Filter = { kinds: [GiftWrap], '#p': [args.replyToPub] }
  const sub = pool.subscribeMany(args.relays, filter, {
    onevent(wrap) {
      if (settled) return
      try {
        const { rumor, author } = verifiedUnwrap(wrap, args.replyToSk)
        if (author !== args.expectedPayeePubHex) return // only the invoice payee
        if (rumor.kind !== ACK_KIND) return
        const ack = JSON.parse(rumor.content) as AckPayload
        if (ack.consignment_sha256 !== args.expectedConsignmentSha256) return
        settled = true
        sub.close()
        onResult(ack.ack ? 'ACK' : 'NACK', ack.reason)
      } catch {
        // unverifiable / malformed — discard (NIP §2.1)
      }
    },
  })
  return sub
}

// --------------------------------------------------------------------------------------
// PAYEE side — consignment.get + ack.post
// --------------------------------------------------------------------------------------

export interface InboundConsignment {
  payload: ConsignmentPayload
  /** Authenticated payer seal author (per-transfer, unlinkable). */
  author: string
}

/**
 * consignment.get — subscribe for inbound gift-wrapped consignments addressed to the payee.
 * The caller RGB-validates the bytes and applies first-VALIDATED-wins per recipient_id (NIP §9)
 * before pinning; this function only authenticates and decodes the transport layer.
 */
export function subscribeInbound(
  pool: SimplePool,
  relays: string[],
  payeeSk: Uint8Array,
  payeePubHex: string,
  onConsignment: (c: InboundConsignment) => void,
): { close: () => void } {
  const filter: Filter = { kinds: [GiftWrap], '#p': [payeePubHex] }
  return pool.subscribeMany(relays, filter, {
    onevent(wrap) {
      try {
        const { rumor, author } = verifiedUnwrap(wrap, payeeSk)
        if (rumor.kind !== CONSIGNMENT_KIND) return
        onConsignment({ payload: JSON.parse(rumor.content) as ConsignmentPayload, author })
      } catch {
        // discard
      }
    },
  })
}

export interface PostAckArgs {
  relays: string[]
  /** The payee's REAL identity secret key (the invoice npub) — the payer verifies this author. */
  payeeSk: Uint8Array
  /** reply_to from the consignment rumor — the payer's anonymous mailbox. */
  replyToPub: string
  recipient_id: string
  consignment_sha256: string
  ack: boolean
  reason?: string
}

/**
 * ack.post — gift-wrap an ACK/NACK to the payer's reply mailbox and publish to the PAYEE's
 * relays (the only relay set both parties share; NIP §8). The seal is signed by the payee's
 * real key so the payer can bind it to the invoice. Write-once is the caller's responsibility
 * (do not emit the opposite value for a recipient_id; NIP §9).
 */
export async function postAck(pool: SimplePool, args: PostAckArgs): Promise<Event> {
  const payload: AckPayload = {
    recipient_id: args.recipient_id,
    ack: args.ack,
    consignment_sha256: args.consignment_sha256,
  }
  if (args.reason !== undefined) payload.reason = args.reason

  const rumorTemplate = {
    kind: ACK_KIND,
    created_at: nowSeconds(),
    tags: [] as string[][],
    content: JSON.stringify(payload),
  }
  const wrap = wrapEvent(rumorTemplate, args.payeeSk, args.replyToPub)
  await Promise.all(pool.publish(args.relays, wrap))
  return wrap
}

// --------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function assertSealable(rumor: { content: string; kind: number; created_at: number; tags: string[][] }): void {
  // Conservative: the seal's plaintext is the full rumor JSON; keep it under the NIP-44 ceiling.
  const serialized = JSON.stringify(rumor)
  if (serialized.length >= NIP44_PLAINTEXT_MAX) {
    throw new Error(
      `rumor too large to seal inline (${serialized.length} >= ${NIP44_PLAINTEXT_MAX}); use Blossom`,
    )
  }
}

export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * TODO (Milestone 3): Blossom upload of the NIP-44-encrypted consignment ciphertext.
 *  1. NIP-44-encrypt `bytes` to `payeePubHex` (per-blob random symmetric key wrapped in the rumor);
 *  2. PUT the ciphertext to the uploader's kind:10063 servers via BUD-02 `PUT /upload`,
 *     authorized by a fresh kind:24242 token (t=upload, x=ciphertext sha256);
 *  3. mirror to >=2 servers and return { servers, sha256: <ciphertext hash>, size, encryption }.
 * The recipient MUST recompute+compare the ciphertext sha256 before decrypting (NIP §6).
 */
export function uploadCiphertextToBlossom(_bytes: Uint8Array, _payeePubHex: string): Promise<BlobRef> {
  return Promise.reject(
    new Error('Blossom upload not yet implemented (Milestone 3)'),
  )
}

/** A fresh relay pool. Re-exported so non-UI callers (e.g. the demo orchestrator) need no
 * direct nostr-tools dependency and share this module's single nostr-tools instance. */
export function createPool(): SimplePool {
  return new SimplePool()
}

/**
 * Build a NIP-19 `nevent` for a published gift wrap, with relay hints in the TLV so anonymous
 * viewers (njump.me, nostr.guru) can locate it. Returns the bare `nevent1…` string.
 */
export function giftWrapNevent(wrap: Event, relays: string[]): string {
  return neventEncode({ id: wrap.id, relays, author: wrap.pubkey, kind: GiftWrap })
}
