/**
 * De-risk: does the Parcel21 relay serve kind-1059 gift wraps to ANONYMOUS readers?
 *
 * NIP-59/NIP-17 say relays SHOULD restrict kind:1059 to the marked recipient via NIP-42 AUTH.
 * Public Nostr viewers (njump.me, nostr.guru) connect anonymously — so if our relay enforces
 * recipient-only AUTH, a public "view the gift wrap" link shows nothing and we must fall back to
 * rendering the event JSON inline. This script settles that empirically:
 *
 *   1. publish a signed kind-1059 event over one connection (observe OK)
 *   2. open a SECOND fresh connection, send NO AUTH, REQ the event by id
 *   3. report whether the event comes back, and whether the relay demanded AUTH
 *
 * Usage: PARCEL21_RELAY=wss://relay-production-1664.up.railway.app npx tsx scripts/relay-anon-read.ts
 */
import WebSocket from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const RELAY = process.env.PARCEL21_RELAY ?? 'wss://relay-production-1664.up.railway.app'
const T = 12_000

const open = (url: string) =>
  new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(url)
    ws.once('open', () => res(ws))
    ws.once('error', rej)
  })

async function main() {
  console.log(`relay: ${RELAY}\n`)

  // a realistic-looking gift wrap: ephemeral author, p-tagged to a random recipient
  const sk = generateSecretKey()
  const recipient = getPublicKey(generateSecretKey())
  const evt = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipient]],
      content: 'AnonReadTest-ciphertext-placeholder',
    },
    sk,
  )
  console.log(`built kind-1059 event id ${evt.id.slice(0, 16)}…  author ${evt.pubkey.slice(0, 16)}…`)

  // ---- 1. publish -----------------------------------------------------------
  const pub = await open(RELAY)
  const published = await new Promise<boolean>((resolve) => {
    const to = setTimeout(() => resolve(false), T)
    pub.on('message', (d) => {
      const m = JSON.parse(d.toString()) as any[]
      if (m[0] === 'OK' && m[1] === evt.id) {
        clearTimeout(to)
        console.log(`publish → OK accepted=${m[2]} ${m[3] ? `(${m[3]})` : ''}`)
        resolve(m[2] === true)
      } else if (m[0] === 'AUTH') {
        console.log(`publish → relay sent AUTH challenge (write may need auth)`)
      }
    })
    pub.send(JSON.stringify(['EVENT', evt]))
  })
  pub.close()
  if (!published) {
    console.log('\nRESULT: event was NOT accepted for publish — cannot test anon read. Check the relay/policy.')
    process.exit(2)
  }

  // ---- 2. anonymous read on a fresh connection ------------------------------
  const rd = await open(RELAY)
  const sub = 'anon-' + Math.random().toString(36).slice(2, 8)
  let sawAuthChallenge = false
  let sawClosedAuth = false
  const got = await new Promise<boolean>((resolve) => {
    const to = setTimeout(() => resolve(false), T)
    rd.on('message', (d) => {
      const m = JSON.parse(d.toString()) as any[]
      if (m[0] === 'AUTH') {
        sawAuthChallenge = true
        console.log(`read → relay sent AUTH challenge (did NOT authenticate)`)
      } else if (m[0] === 'EVENT' && m[1] === sub && m[2]?.id === evt.id) {
        clearTimeout(to)
        console.log(`read → EVENT returned to an ANONYMOUS client ✓`)
        resolve(true)
      } else if (m[0] === 'CLOSED' && m[1] === sub) {
        sawClosedAuth = /auth/i.test(m[2] ?? '')
        console.log(`read → CLOSED ${m[2] ? `(${m[2]})` : ''}`)
        clearTimeout(to)
        resolve(false)
      } else if (m[0] === 'EOSE' && m[1] === sub) {
        clearTimeout(to)
        console.log(`read → EOSE with no event`)
        resolve(false)
      }
    })
    rd.send(JSON.stringify(['REQ', sub, { ids: [evt.id] }]))
  })
  rd.close()

  console.log('\n────────────────────────────────────────')
  if (got) {
    console.log('RESULT ✓  Anonymous readers CAN fetch kind-1059.')
    console.log('         → njump.me / nostr.guru links will resolve. Use the clickable Nostr link.')
    process.exit(0)
  } else {
    console.log('RESULT ✗  Anonymous readers CANNOT fetch kind-1059.')
    console.log(`         → ${sawAuthChallenge || sawClosedAuth ? 'relay enforces NIP-42 AUTH for 1059' : 'event not returned (reason above)'}.`)
    console.log('         → Fall back to rendering the gift-wrap JSON inline in the demo UI.')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('error:', e?.message ?? e)
  process.exit(2)
})
