import './env.js'
import express from 'express'
import session from 'express-session'
import cors from 'cors'
import authRoutes from './routes/auth.js'
import proxyRoutes from './routes/proxy.js'
import uploadRoutes from './routes/upload.js'
import registerRoutes from './routes/register.js'

const app = express()
const PORT = parseInt(process.env.BFF_PORT || '3001', 10)

const sessionSecret = process.env.SESSION_SECRET
if (!sessionSecret) throw new Error('SESSION_SECRET must be set')

app.use(cors({ origin: true, credentials: true }))
app.use(express.json())

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
app.use('/api/upload-blob', uploadRoutes)
app.use('/api/register', registerRoutes)

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }))

app.listen(PORT, () => {
  console.log(`BFF server running on http://localhost:${PORT}`)
  console.log(`Group Service URL: ${process.env.GROUP_SERVICE_URL || 'http://localhost:3000'}`)
  console.log(`OAuth Client ID: ${process.env.OAUTH_CLIENT_ID || 'not set'}`)
})
