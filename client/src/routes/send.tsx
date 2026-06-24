import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Send as SendIcon } from 'lucide-react'
import { getPool } from '../lib/relay'
import { postConsignment, subscribeAck } from '../lib/parcel21'
import { parseInvoice, randomTxid } from '../lib/invoice'
import { useLog } from '../lib/hooks'
import { Button, Card, LogPanel, Mono, StatusPill } from '../components/ui'

export const Route = createFileRoute('/send')({ component: Send })

type Status = 'idle' | 'pending' | 'ACK' | 'NACK'

function Send() {
  const { lines, push } = useLog()
  const [invoiceText, setInvoiceText] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState<{ recipient_id: string; txid: string; sha256: string } | null>(null)
  const subRef = useRef<{ close: () => void } | null>(null)

  useEffect(() => () => subRef.current?.close(), [])

  async function send() {
    setError('')
    setInfo(null)
    let parsed
    try {
      parsed = parseInvoice(invoiceText)
    } catch (e) {
      setError((e as Error).message)
      return
    }
    setBusy(true)
    setStatus('pending')
    push(`parsed invoice → payee ${parsed.endpoint.payeePubHex.slice(0, 12)}… via ${parsed.endpoint.relays.join(', ')}`)

    const pool = getPool()
    const txid = randomTxid()
    const bytes = new TextEncoder().encode(`demo consignment ${new Date().toISOString()}`)
    try {
      const res = await postConsignment(pool, {
        endpoint: parsed.endpoint,
        recipient_id: parsed.recipient_id,
        txid,
        consignmentBytes: bytes,
      })
      setInfo({ recipient_id: parsed.recipient_id, txid, sha256: res.sha256 })
      push(`→ posted consignment (sha256 ${res.sha256.slice(0, 12)}…); waiting for ACK…`)

      subRef.current?.close()
      let settled = false
      const sub = subscribeAck(
        pool,
        {
          relays: parsed.endpoint.relays,
          replyToSk: res.replyToSk,
          replyToPub: res.replyToPub,
          expectedPayeePubHex: parsed.endpoint.payeePubHex,
          expectedConsignmentSha256: res.sha256,
        },
        (state) => {
          settled = true
          setStatus(state)
          setBusy(false)
          push(`← received ${state} (authenticated to payee) ✓`)
        },
      )
      subRef.current = sub
      setTimeout(() => {
        if (!settled) {
          push('timed out waiting for ACK — is the receiver online and on the same relay?')
          setBusy(false)
        }
      }, 15000)
    } catch (e) {
      setError((e as Error).message)
      setStatus('idle')
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <SendIcon className="size-6 text-amber-400" /> Send
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Paste an invoice from the Receive page, then deliver a (simulated) consignment over Nostr
          and watch for the ACK.
        </p>
      </div>

      <Card title="Invoice">
        <textarea
          value={invoiceText}
          onChange={(e) => setInvoiceText(e.target.value)}
          rows={3}
          placeholder="rgbnostr:npub1…?relay=ws://127.0.0.1:7777&recipient_id=utxob1…"
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={() => void send()} disabled={busy || invoiceText.trim() === ''}>
            <span className="flex items-center gap-2">
              <SendIcon className="size-4" /> {busy ? 'Sending…' : 'Send consignment'}
            </span>
          </Button>
          <StatusPill state={status} />
        </div>
        {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
      </Card>

      {info && (
        <Card title="This transfer">
          <dl className="space-y-1 text-xs">
            <div>
              <dt className="inline text-slate-500">recipient_id: </dt>
              <dd className="inline"><Mono>{info.recipient_id}</Mono></dd>
            </div>
            <div>
              <dt className="inline text-slate-500">txid: </dt>
              <dd className="inline"><Mono>{info.txid}</Mono></dd>
            </div>
            <div>
              <dt className="inline text-slate-500">consignment sha256: </dt>
              <dd className="inline"><Mono>{info.sha256}</Mono></dd>
            </div>
          </dl>
        </Card>
      )}

      <Card title="Activity">
        <LogPanel lines={lines} />
      </Card>
    </div>
  )
}
