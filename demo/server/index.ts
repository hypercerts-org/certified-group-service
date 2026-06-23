import './env.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import express from 'express'
import session from 'express-session'
import cors from 'cors'
import authRoutes from './routes/auth.js'
import proxyRoutes from './routes/proxy.js'
import uploadRoutes from './routes/upload.js'
import resolveRoutes from './routes/resolve.js'
import registerRoutes from './routes/register.js'
import keysRoutes from './routes/keys.js'

const app = express()
// PORT is Railway's convention; BFF_PORT is the local dev override; 3001 default.
const PORT = parseInt(process.env.PORT || process.env.BFF_PORT || '3001', 10)

const sessionSecret = process.env.SESSION_SECRET
if (!sessionSecret) throw new Error('SESSION_SECRET must be set')

app.use(cors({ origin: true, credentials: true }))

// Session must come before any route that reads req.session — including the
// raw upload route below, which authenticates the caller. Session does not
// consume the request body, so mounting it before express.json() is fine.
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // set true in production behind HTTPS
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  }),
)

// Mount upload route before express.json() to preserve raw stream access
app.use('/api/upload-blob', uploadRoutes)

app.use(express.json())

// Serve OAuth client metadata (ePDS fetches this to verify the client)
app.get('/client-metadata.json', (_req, res) => {
  const clientId = process.env.OAUTH_CLIENT_ID
  const redirectUri = process.env.OAUTH_REDIRECT_URI
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'OAuth not configured' })
  }
  res.json({
    client_id: clientId,
    client_name: 'Group Service Demo',
    client_uri: clientId.replace('/client-metadata.json', ''),
    redirect_uris: [redirectUri],
    scope: 'atproto transition:generic',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  })
})

// Routes
app.use('/api', authRoutes)
app.use('/api/proxy', proxyRoutes)
app.use('/api/register', registerRoutes)
app.use('/api/keys', keysRoutes)
app.use('/api/resolve', resolveRoutes)

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// Serve the built SPA in production. In dev, Vite serves the client (port 5173)
// and proxies /api here, so this block is inactive. On a single-process deploy
// (e.g. Railway) the BFF serves both the API and the built client. The client
// dist defaults to ../dist relative to the compiled server (dist-server/),
// overridable with CLIENT_DIST.
if (process.env.NODE_ENV === 'production') {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const clientDist = process.env.CLIENT_DIST || join(here, '..', 'dist')
  app.use(express.static(clientDist))
  // SPA fallback: any non-API route returns index.html so client-side routing
  // (react-router) works on deep links / refresh. Exclude both `/api` and
  // `/api/*` so unknown API paths return a real 404 instead of the SPA shell.
  app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
    res.sendFile(join(clientDist, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`BFF server running on http://localhost:${PORT}`)
  console.log(`Group Service URL: ${process.env.GROUP_SERVICE_URL || 'http://localhost:3000'}`)
  console.log(`OAuth Client ID: ${process.env.OAUTH_CLIENT_ID || 'not set'}`)
})
