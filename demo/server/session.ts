export interface SessionData {
  did: string
  handle: string
}

declare module 'express-session' {
  interface SessionData {
    user?: import('./session.js').SessionData
  }
}
