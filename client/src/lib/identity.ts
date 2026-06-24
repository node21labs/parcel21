/**
 * Client identity for the demo.
 *
 * For now this generates and persists an in-app key (the "wallet" keypair) in localStorage.
 * NIP-07 (window.nostr) is *detected* and surfaced in the UI, but signing/sealing still uses
 * the in-app key this iteration — full NIP-07 support requires refactoring the protocol library
 * (client/src/lib/parcel21.ts) to a signer interface (sign + nip44 encrypt/decrypt) instead of
 * raw secret keys, since NIP-07 never exposes the secret key. Tracked as a follow-up.
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'

const SK_KEY = 'parcel21.sk'

export interface Identity {
  sk: Uint8Array
  pub: string
  npub: string
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Load the persisted identity, or create + persist a new one. Browser-only. */
export function loadOrCreateIdentity(): Identity {
  let skHex = typeof localStorage !== 'undefined' ? localStorage.getItem(SK_KEY) : null
  let sk: Uint8Array
  if (skHex && skHex.length === 64) {
    sk = fromHex(skHex)
  } else {
    sk = generateSecretKey()
    if (typeof localStorage !== 'undefined') localStorage.setItem(SK_KEY, toHex(sk))
  }
  const pub = getPublicKey(sk)
  return { sk, pub, npub: npubEncode(pub) }
}

export function resetIdentity(): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(SK_KEY)
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { nostr?: unknown }).nostr)
}
