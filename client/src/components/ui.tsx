/** Small presentational helpers shared across routes. */
import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-800 bg-slate-900/40 p-5 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h2>}
      {children}
    </section>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  type = 'button',
  id,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost' | 'danger' | 'ok'
  type?: 'button' | 'submit'
  id?: string
}) {
  const styles: Record<string, string> = {
    primary: 'bg-amber-500 text-slate-950 hover:bg-amber-400',
    ghost: 'border border-slate-700 text-slate-200 hover:bg-slate-800',
    danger: 'bg-rose-600 text-white hover:bg-rose-500',
    ok: 'bg-emerald-600 text-white hover:bg-emerald-500',
  }
  return (
    <button
      type={type}
      id={id}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]}`}
    >
      {children}
    </button>
  )
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-xs text-slate-300">{children}</span>
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
    >
      {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export function StatusPill({ state }: { state: 'ACK' | 'NACK' | 'pending' | 'idle' }) {
  const map: Record<string, string> = {
    ACK: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    NACK: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    pending: 'bg-amber-500/15 text-amber-400 border-amber-500/30 animate-pulse',
    idle: 'bg-slate-700/30 text-slate-400 border-slate-600/40',
  }
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${map[state]}`}>{state}</span>
  )
}

export function LogPanel({ lines }: { lines: string[] }) {
  return (
    <pre className="max-h-56 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-400">
      {lines.length === 0 ? <span className="text-slate-600">— no activity yet —</span> : lines.join('\n')}
    </pre>
  )
}
