import { HeadContent, Scripts, createRootRoute, Link } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { Package, Send, Inbox, Home } from 'lucide-react'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Parcel21 — RGB consignment exchange over Nostr' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function NavLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
      activeProps={{
        className:
          'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm bg-slate-800 text-amber-400',
      }}
      activeOptions={{ exact: to === '/' }}
    >
      {icon}
      {label}
    </Link>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-slate-950 text-slate-100 antialiased">
        <header className="border-b border-slate-800 bg-slate-900/50">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <Package className="size-5 text-amber-400" />
              <span>Parcel21</span>
              <span className="hidden text-xs font-normal text-slate-500 sm:inline">
                RGB consignment exchange over Nostr
              </span>
            </Link>
            <div className="flex items-center gap-1">
              <NavLink to="/" icon={<Home className="size-4" />} label="Home" />
              <NavLink to="/send" icon={<Send className="size-4" />} label="Send" />
              <NavLink to="/receive" icon={<Inbox className="size-4" />} label="Receive" />
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
        <TanStackDevtools
          config={{ position: 'bottom-right' }}
          plugins={[{ name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> }]}
        />
        <Scripts />
      </body>
    </html>
  )
}
