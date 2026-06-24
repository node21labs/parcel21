/**
 * Demo invoice helpers.
 *
 * A real RGB invoice carries the blinded-UTXO `recipient_id` plus an `endpoints=` list. For the
 * demo we encode the Nostr transport endpoint (NIP §5) and the recipient_id in one pasteable line:
 *
 *   rgbnostr:<npub>?relay=<wss-url>&recipient_id=<id>
 *
 * `parseRgbNostrEndpoint` ignores the extra `recipient_id` param, so the line round-trips cleanly.
 */
import { parseRgbNostrEndpoint, type RgbNostrEndpoint } from './parcel21'

export interface DemoInvoice {
  recipient_id: string
  endpoint: RgbNostrEndpoint
  raw: string
}

export function buildInvoice(npub: string, relays: string[], recipient_id: string): string {
  const params = relays.map((r) => `relay=${encodeURIComponent(r)}`).join('&')
  return `rgbnostr:${npub}?${params}&recipient_id=${recipient_id}`
}

export function parseInvoice(raw: string): DemoInvoice {
  const trimmed = raw.trim()
  const endpoint = parseRgbNostrEndpoint(trimmed)
  const query = trimmed.split('?')[1] ?? ''
  const recipient_id = new URLSearchParams(query).get('recipient_id') ?? ''
  if (!recipient_id) throw new Error('invoice is missing recipient_id')
  return { recipient_id, endpoint, raw: trimmed }
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fake blinded-UTXO style recipient id, for the demo. */
export function randomRecipientId(): string {
  return `utxob1${randomHex(16)}`
}

/** A fake 32-byte txid, for the demo. */
export function randomTxid(): string {
  return randomHex(32)
}
