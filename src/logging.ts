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
const CREDENTIAL_HEADERS = ['authorization', '["x-api-key"]', 'cookie', '["proxy-authorization"]']
const header = (name: string) => (name.startsWith('[') ? name : `.${name}`)
const REDACT_PATHS = ['headers', '*.headers', '*.config.headers'].flatMap((prefix) =>
  CREDENTIAL_HEADERS.map((name) => `${prefix}${header(name)}`),
)

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[Redacted]' } }, destination)
}

type SerializedReq = { headers?: Record<string, unknown>; raw?: { ip?: string } } & Record<
  string,
  unknown
>

function allowlistHeaders(req: SerializedReq): SerializedReq {
  const headers: Record<string, unknown> = {}
  for (const name of LOGGED_REQUEST_HEADERS) {
    if (req.headers?.[name] !== undefined) headers[name] = req.headers[name]
  }
  // remoteAddress is the socket peer (Railway's proxy). req.ip honours
  // `trust proxy`, so it is the actual client; x-forwarded-for itself stays
  // off the allowlist to avoid logging the full proxy chain.
  return { ...req, headers, ip: req.raw?.ip }
}

export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({ logger, serializers: { req: allowlistHeaders } })
}
