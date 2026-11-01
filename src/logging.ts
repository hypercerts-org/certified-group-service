import pino, { type DestinationStream, type Logger } from 'pino'
import { pinoHttp, type HttpLogger } from 'pino-http'

/**
 * Request headers that may appear in the HTTP access log. Everything else is
 * dropped, so a credential header added later (or one a client sends that we
 * never anticipated) cannot leak by default. Extend deliberately.
 */
export const LOGGED_REQUEST_HEADERS: readonly string[] = [
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'atproto-proxy',
  'x-request-id',
]

/**
 * Backstop for non-request log calls (e.g. an error object that carries the
 * headers of an outbound request). Path-based, so it only catches what is
 * listed — the access-log allowlist above is the primary control.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  '*.headers.authorization',
  '*.headers["x-api-key"]',
  '*.headers.cookie',
  '*.headers["proxy-authorization"]',
  '*.config.headers.authorization',
]

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[Redacted]' } }, destination)
}

type SerializedReq = { headers?: Record<string, unknown> } & Record<string, unknown>

function allowlistHeaders(req: SerializedReq): SerializedReq {
  const headers: Record<string, unknown> = {}
  for (const name of LOGGED_REQUEST_HEADERS) {
    if (req.headers?.[name] !== undefined) headers[name] = req.headers[name]
  }
  return { ...req, headers }
}

export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({ logger, serializers: { req: allowlistHeaders } })
}
