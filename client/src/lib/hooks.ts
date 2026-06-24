/** React hooks for client-only identity + relay config (SSR-safe: read in effects). */
import { useCallback, useEffect, useState } from 'react'
import { loadOrCreateIdentity, resetIdentity, hasNip07, type Identity } from './identity'
import { getRelayUrl, setRelayUrl, DEFAULT_RELAY } from './relay'

export function useIdentity() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [nip07, setNip07] = useState(false)

  useEffect(() => {
    setIdentity(loadOrCreateIdentity())
    setNip07(hasNip07())
  }, [])

  function regenerate() {
    resetIdentity()
    setIdentity(loadOrCreateIdentity())
  }

  return { identity, nip07, regenerate }
}

export function useRelay(): [string, (url: string) => void] {
  const [url, setUrl] = useState(DEFAULT_RELAY)
  useEffect(() => {
    setUrl(getRelayUrl())
  }, [])
  function update(next: string) {
    setRelayUrl(next)
    setUrl(next)
  }
  return [url, update]
}

/** Append-only log helper for the demo UIs. `push`/`clear` are stable (safe in effect deps). */
export function useLog() {
  const [lines, setLines] = useState<string[]>([])
  const push = useCallback((line: string) => {
    const t = new Date().toLocaleTimeString()
    setLines((prev) => [...prev, `${t}  ${line}`])
  }, [])
  const clear = useCallback(() => setLines([]), [])
  return { lines, push, clear }
}
