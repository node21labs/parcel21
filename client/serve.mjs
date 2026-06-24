import { serve } from 'srvx'
import { serveStatic } from 'srvx/static'
import app from './dist/server/server.js'

const port = Number(process.env.PORT) || 3000
const staticMw = serveStatic({ dir: './dist/client' })

// Serve built client assets from dist/client; fall through to TanStack Start SSR.
serve({
  port,
  hostname: '0.0.0.0',
  fetch: (req) => staticMw(req, () => app.fetch(req)),
})
console.log('parcel21 client listening on', port)
