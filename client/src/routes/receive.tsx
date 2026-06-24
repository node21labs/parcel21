import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Inbox, Ticket, Check, X } from 'lucide-react'
import { getPool } from '../lib/relay'
import { subscribeInbound, postAck, type InboundConsignment } from '../lib/parcel21'
import { buildInvoice, randomRecipientId } from '../lib/invoice'
import { useIdentity, useRelay, useLog } from '../lib/hooks'
import { Button, Card, CopyButton, LogPanel, Mono, StatusPill } from '../components/ui'

export const Route = createFileRoute('/receive')({ component: Receive })

function Receive() {
  const { identity } = useIdentity()
  const [relay] = useRelay()
  const { lines, push } = useLog()
  const [invoice, setInvoice] = useState('')
  const [inbound, setInbound] = useState<InboundConsignment[]>([])
  const [acked, setAcked] = useState<Record<string, 'ACK' | 'NACK'>>({})

  // Subscribe for inbound gift-wrapped consignments addressed to our key.
  useEffect(() => {
    if (!identity) return
    const sub = subscribeInbound(getPool(), [relay], identity.sk, identity.pub, (c) => {
      push(`← consignment for ${c.payload.recipient_id.slice(0, 18)}… (${c.payload.mode})`)
      setInbound((prev) =>
        prev.some(
          (p) =>
            p.payload.recipient_id === c.payload.recipient_id &&
            p.payload.sha256 === c.payload.sha256,
        )
          ? prev
          : [...prev, c],
      )
    })
    return () => sub.close()
  }, [identity, relay, push])

  function generateInvoice() {
    if (!identity) return
    const rid = randomRecipientId()
    setInvoice(buildInvoice(identity.npub, [relay], rid))
    push(`generated invoice for ${rid.slice(0, 18)}…`)
  }

  async function decide(c: InboundConsignment, ok: boolean) {
    if (!identity) return
    await postAck(getPool(), {
      relays: [relay],
      payeeSk: identity.sk,
      replyToPub: c.payload.reply_to,
      recipient_id: c.payload.recipient_id,
      consignment_sha256: c.payload.sha256,
      ack: ok,
    })
    setAcked((a) => ({ ...a, [c.payload.recipient_id]: ok ? 'ACK' : 'NACK' }))
    push(`→ ${ok ? 'ACK' : 'NACK'} for ${c.payload.recipient_id.slice(0, 18)}…`)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Inbox className="size-6 text-amber-400" /> Receive
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Generate an invoice, hand it to a sender, then validate and ACK what arrives.
        </p>
      </div>

      <Card title={<span className="flex items-center gap-2"><Ticket className="size-4" /> Invoice</span>}>
        <Button onClick={generateInvoice} disabled={!identity}>
          Generate invoice
        </Button>
        {invoice && (
          <div className="mt-3 space-y-2">
            <div className="rounded-md border border-slate-800 bg-slate-950 p-3">
              <Mono>{invoice}</Mono>
            </div>
            <CopyButton text={invoice} />
            <p className="text-xs text-slate-500">
              Paste this into the <strong>Send</strong> page (another tab or device) to deliver a
              consignment here.
            </p>
          </div>
        )}
      </Card>

      <Card title={`Incoming consignments (${inbound.length})`}>
        {inbound.length === 0 ? (
          <p className="text-sm text-slate-500">Waiting for consignments addressed to your key…</p>
        ) : (
          <ul className="space-y-3">
            {inbound.map((c) => {
              const state = acked[c.payload.recipient_id]
              return (
                <li
                  key={`${c.payload.recipient_id}:${c.payload.sha256}`}
                  className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-xs text-slate-500">recipient_id</div>
                      <Mono>{c.payload.recipient_id}</Mono>
                      <div className="text-xs text-slate-500">
                        txid <Mono>{c.payload.txid.slice(0, 24)}…</Mono> · sha256{' '}
                        <Mono>{c.payload.sha256.slice(0, 16)}…</Mono>
                      </div>
                      <div className="text-xs text-slate-500">
                        from <Mono>{c.author.slice(0, 16)}…</Mono>
                      </div>
                    </div>
                    {state ? (
                      <StatusPill state={state} />
                    ) : (
                      <div className="flex shrink-0 gap-2">
                        <Button variant="ok" onClick={() => void decide(c, true)}>
                          <span className="flex items-center gap-1">
                            <Check className="size-3.5" /> Accept
                          </span>
                        </Button>
                        <Button variant="danger" onClick={() => void decide(c, false)}>
                          <span className="flex items-center gap-1">
                            <X className="size-3.5" /> Reject
                          </span>
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card title="Activity">
        <LogPanel lines={lines} />
      </Card>
    </div>
  )
}
