import type { JsonWebKey } from 'node:crypto'

export interface SessionData {
  did: string
  handle: string
  pdsUrl: string
  accessToken: string
  refreshToken?: string
  dpopPrivateJwk: JsonWebKey
}

/** Temporary OAuth state stored in session during the login flow. */
export interface OAuthFlowState {
  codeVerifier: string
  state: string
  dpopPrivateJwk: JsonWebKey
}

declare module 'express-session' {
  interface SessionData {
    user?: import('./session.js').SessionData
    oauthFlow?: import('./session.js').OAuthFlowState
  }
}
