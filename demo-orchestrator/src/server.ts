/**
 * Demo-orchestrator HTTP/WS server.
 *
 *   GET  /health              → bootstrap readiness, issuer balance, funding address
 *   POST /run                 → enqueue a demo run (single-concurrency FIFO), returns { jobId }
 *   GET  /run/:id             → final JSON result (or current status)
 *   GET  /run/:id/stream (WS) → live progress events, then the result/error
 *   GET  /                    → the one-click demo page (public/)
 *
 * A Bitcoin wallet cannot safely build two transfers from the same UTXO set at once, so runs are
 * strictly serialized (concurrency = 1) with a bounded queue + a per-IP cooldown.
 */
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { WebSocket } from 'ws'
import { config } from './config.ts'
import { bootstrap, issuerFunds, issuerAddress, type BootstrapResult } from './rgb.ts'
import { runDemo, type ProgressEvent, type DemoArtifacts } from './demo.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

type JobStatus = 'queued' | 'running' | 'done' | 'error'
interface Job {
  id: string
  status: JobStatus
  events: ProgressEvent[]
  result?: DemoArtifacts
  error?: string
  sockets: Set<WebSocket>
  createdAt: number
}

const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? '5')
const IP_COOLDOWN_MS = Number(process.env.IP_COOLDOWN_MS ?? '15000')

const jobs = new Map<string, Job>()
const queue: string[] = []
const lastRunByIp = new Map<string, number>()
let working = false
let boot: BootstrapResult = { ready: false, totalSats: 0, reason: 'starting' }

function emit(job: Job, e: ProgressEvent) {
  job.events.push(e)
  broadcast(job, { type: 'progress', event: e })
}
function broadcast(job: Job, msg: unknown) {
  const s = JSON.stringify(msg)
  for (const ws of job.sockets) {
    try {
      ws.send(s)
    } catch {
      /* ignore */
    }
  }
}

async function pump() {
  if (working) return
  const id = queue.shift()
  if (!id) return
  const job = jobs.get(id)
  if (!job) return void setImmediate(pump)
  working = true
  job.status = 'running'
  emit(job, { step: 'start', status: 'ok' })
  try {
    job.result = await runDemo(id, (e) => emit(job, e))
    job.status = 'done'
    broadcast(job, { type: 'result', result: job.result })
  } catch (err) {
    job.status = 'error'
    job.error = (err as Error)?.message ?? String(err)
    broadcast(job, { type: 'error', error: job.error })
  } finally {
    working = false
    setImmediate(pump)
  }
}

/** Re-attempt bootstrap if not ready yet (picks up newly-arrived funding without a restart). */
async function ensureBoot(): Promise<BootstrapResult> {
  if (boot.ready) return boot
  try {
    boot = await bootstrap()
  } catch (e) {
    boot = { ready: false, totalSats: 0, reason: (e as Error).message }
  }
  return boot
}

async function main() {
  const app = Fastify({ logger: true })
  await app.register(websocket)
  await app.register(fastifyStatic, { root: resolve(__dirname, '..', 'public'), prefix: '/' })

  app.get('/health', async () => {
    await ensureBoot()
    let funds = { totalSats: boot.totalSats, outpoint: null as string | null }
    let fundingAddress = boot.fundingAddress
    try {
      funds = await issuerFunds()
      if (!boot.ready) fundingAddress = await issuerAddress()
    } catch {
      /* ignore */
    }
    return {
      ready: boot.ready,
      reason: boot.reason,
      network: config.network,
      relay: config.relay,
      explorer: config.explorerTx,
      contract: boot.state,
      issuerSats: funds.totalSats,
      lowBalance: funds.totalSats < config.lowBalanceSats,
      fundingAddress: boot.ready ? undefined : fundingAddress,
      queueDepth: queue.length,
      busy: working,
    }
  })

  app.post('/run', async (req, reply) => {
    await ensureBoot()
    if (!boot.ready) {
      return reply.code(503).send({ error: 'demo not ready', reason: boot.reason, fundingAddress: boot.fundingAddress })
    }
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip
    const now = Date.now()
    const last = lastRunByIp.get(ip) ?? 0
    if (now - last < IP_COOLDOWN_MS) {
      return reply.code(429).send({ error: 'slow down', retryAfterMs: IP_COOLDOWN_MS - (now - last) })
    }
    if (queue.length >= MAX_QUEUE) {
      return reply.code(429).send({ error: 'demo is busy, try again shortly', queueDepth: queue.length })
    }
    lastRunByIp.set(ip, now)
    const id = randomUUID()
    jobs.set(id, { id, status: 'queued', events: [], sockets: new Set(), createdAt: now })
    queue.push(id)
    void pump()
    return reply.code(202).send({ jobId: id, queuePosition: queue.length })
  })

  app.get<{ Params: { id: string } }>('/run/:id', async (req, reply) => {
    const job = jobs.get(req.params.id)
    if (!job) return reply.code(404).send({ error: 'unknown job' })
    return { id: job.id, status: job.status, result: job.result, error: job.error, events: job.events }
  })

  app.get<{ Params: { id: string } }>('/run/:id/stream', { websocket: true }, (socket, req) => {
    const job = jobs.get((req.params as { id: string }).id)
    if (!job) {
      socket.send(JSON.stringify({ type: 'error', error: 'unknown job' }))
      socket.close()
      return
    }
    // replay buffered progress, then live-stream
    for (const e of job.events) socket.send(JSON.stringify({ type: 'progress', event: e }))
    if (job.status === 'done') socket.send(JSON.stringify({ type: 'result', result: job.result }))
    else if (job.status === 'error') socket.send(JSON.stringify({ type: 'error', error: job.error }))
    job.sockets.add(socket)
    socket.on('close', () => job.sockets.delete(socket))
  })

  await ensureBoot()
  await app.listen({ host: '0.0.0.0', port: config.port })
  app.log.info(`parcel21 demo-orchestrator on :${config.port} — ready=${boot.ready} relay=${config.relay}`)
  if (!boot.ready) app.log.warn(`NOT READY: ${boot.reason}; fund issuer at ${boot.fundingAddress ?? '(unknown)'}`)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
