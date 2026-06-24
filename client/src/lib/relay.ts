/** Relay connection + config (browser-only). */
import { SimplePool } from 'nostr-tools/pool'

let _pool: SimplePool | null = null

/** Lazily create one SimplePool for the whole app (client-side). */
export function getPool(): SimplePool {
  if (!_pool) _pool = new SimplePool()
  return _pool
}

const RELAY_KEY = 'parcel21.relay'
// Build-time default (set VITE_DEFAULT_RELAY to the deployed relay's wss:// URL); falls back to local.
export const DEFAULT_RELAY =
  (import.meta.env.VITE_DEFAULT_RELAY as string | undefined) ?? 'ws://127.0.0.1:7777'

export function getRelayUrl(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_RELAY
  return localStorage.getItem(RELAY_KEY) ?? DEFAULT_RELAY
}

export function setRelayUrl(url: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(RELAY_KEY, url)
}
