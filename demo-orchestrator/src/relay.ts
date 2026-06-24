/**
 * The Parcel21 hop: deliver an RGB consignment as a NIP-59 gift wrap over the relay, then verify the
 * ACK. Reuses the vendored protocol library (client/src/lib/parcel21.ts) unchanged — same code path
 * as the client, including verifiedUnwrap. Returns the published kind-1059 event as an nevent.
 */
import { writeFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  createPool,
  giftWrapNevent,
  postConsignment,
  subscribeInbound,
  postAck,
  subscribeAck,
  sha256hex,
  fromBase64,
  type InboundConsignment,
} from './_vendor/parcel21.ts'
import { config } from './config.ts'

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface DeliverResult {
  nevent: string
  eventId: string
  sha256: string
}

/**
 * Post the consignment, receive it on a fresh payee identity, run `rgb validate`, ACK, and confirm
 * the authenticated ACK on the payer side. Resolves once the payer has a verified ACK (the point at
 * which a real sender would broadcast). `validate` is injected so this module stays RGB-agnostic.
 */
export function deliverOverRelay(opts: {
  consignmentBytes: Uint8Array
  deliveredPath: string
  validate: (path: string) => Promise<boolean>
  onPhase: (e: { step: string; status: 'running' | 'ok' | 'error'; data?: Record<string, unknown> }) => void
}): Promise<DeliverResult> {
  const { consignmentBytes, deliveredPath, validate, onPhase } = opts
  const pool = createPool()
  const relays = [config.relay]
  const payeeSk = generateSecretKey()
  const payeePub = getPublicKey(payeeSk)
  const recipient_id = `utxob1${randomHex(16)}`
  const txid = randomHex(32) // payload field only; the witness tx isn't built until after the ACK

  return new Promise<DeliverResult>((resolve, reject) => {
    let settled = false
    let inbound: { close: () => void } | undefined
    let ackSub: { close: () => void } | undefined
    let result: DeliverResult | undefined

    const timer = setTimeout(() => finish(new Error('relay round-trip timed out')), config.runTimeoutMs)
    function cleanup() {
      settled = true
      clearTimeout(timer)
      inbound?.close()
      ackSub?.close()
      try {
        pool.close(relays)
      } catch {
        /* ignore */
      }
    }
    function finish(err?: Error) {
      if (settled) return
      cleanup()
      if (err) reject(err)
      else resolve(result as DeliverResult)
    }

    async function onConsignment(c: InboundConsignment) {
      if (c.payload.recipient_id !== recipient_id) return
      onPhase({ step: 'received', status: 'ok', data: { author: c.author.slice(0, 16), mode: c.payload.mode } })
      if (c.payload.mode !== 'inline' || !c.payload.consignment_b64) {
        await postAckSafe(c, false, 'blossom mode unsupported in demo')
        return finish(new Error('consignment arrived in blossom mode (unsupported in demo)'))
      }
      const received = fromBase64(c.payload.consignment_b64)
      const sha = await sha256hex(received)
      if (sha !== c.payload.sha256) {
        await postAckSafe(c, false, 'sha256 mismatch')
        return finish(new Error('consignment sha256 mismatch over relay'))
      }
      writeFileSync(deliveredPath, received)
      onPhase({ step: 'validate', status: 'running' })
      let valid = false
      try {
        valid = await validate(deliveredPath)
      } catch {
        valid = false
      }
      onPhase({ step: 'validate', status: valid ? 'ok' : 'error' })
      await postAckSafe(c, valid, valid ? undefined : 'rgb validate failed')
      if (!valid) finish(new Error('relayed consignment failed rgb validate'))
    }

    async function postAckSafe(c: InboundConsignment, ok: boolean, reason?: string) {
      try {
        await postAck(pool, {
          relays,
          payeeSk,
          replyToPub: c.payload.reply_to,
          recipient_id: c.payload.recipient_id,
          consignment_sha256: c.payload.sha256,
          ack: ok,
          reason,
        })
      } catch (e) {
        finish(e as Error)
      }
    }

    inbound = subscribeInbound(pool, relays, payeeSk, payeePub, (c) => void onConsignment(c))

    onPhase({ step: 'deliver', status: 'running' })
    void postConsignment(pool, {
      endpoint: { payeePubHex: payeePub, relays },
      recipient_id,
      txid,
      consignmentBytes,
    })
      .then((res) => {
        const nevent = giftWrapNevent(res.wrap, relays)
        result = { nevent, eventId: res.wrap.id, sha256: res.sha256 }
        onPhase({ step: 'deliver', status: 'ok', data: { eventId: res.wrap.id, nevent } })
        ackSub = subscribeAck(
          pool,
          {
            relays,
            replyToSk: res.replyToSk,
            replyToPub: res.replyToPub,
            expectedPayeePubHex: payeePub,
            expectedConsignmentSha256: res.sha256,
          },
          (state) => {
            if (state === 'ACK') {
              onPhase({ step: 'ack', status: 'ok' })
              finish()
            } else {
              onPhase({ step: 'ack', status: 'error' })
              finish(new Error('receiver NACKed the consignment'))
            }
          },
        )
      })
      .catch((e) => finish(e as Error))
  })
}
