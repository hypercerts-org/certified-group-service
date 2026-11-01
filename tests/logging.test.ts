import { describe, it, expect } from 'vitest'
import { Writable } from 'node:stream'
import express from 'express'
import request from 'supertest'
import { createHttpLogger, createLogger, LOGGED_REQUEST_HEADERS } from '../src/logging.js'

const SENTINELS = {
  authorization: 'Bearer SENTINEL_AUTHORIZATION',
  'x-api-key': 'cgsk_SENTINEL_API_KEY',
  cookie: 'session=SENTINEL_COOKIE',
  'proxy-authorization': 'Basic SENTINEL_PROXY',
  // Not on the redact backstop list, so only the allowlist can drop it.
  'x-unanticipated-secret': 'SENTINEL_UNLISTED',
}

function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString())
      cb()
    },
  })
  return { lines, logger: createLogger('info', stream) }
}

function buildApp(logger: ReturnType<typeof createLogger>) {
  const app = express()
  app.use(createHttpLogger(logger))
  app.get('/ok', (_req, res) => {
    res.json({ ok: true })
  })
  app.get('/boom', () => {
    throw new Error('boom')
  })
  return app
}

describe.each([
  ['success', '/ok', 200],
  ['error', '/boom', 500],
])('HTTP access log (%s path)', (_label, path, status) => {
  it('logs only allowlisted request headers', async () => {
    const { lines, logger } = capture()
    await request(buildApp(logger))
      .get(path)
      .set(SENTINELS)
      .set('user-agent', 'sentinel-agent')
      .expect(status)

    const output = lines.join('')
    expect(output).not.toContain('SENTINEL_')

    const accessLines = lines.map((l) => JSON.parse(l)).filter((l) => l.req)
    expect(accessLines.length).toBeGreaterThan(0)
    for (const line of accessLines) {
      const names = Object.keys(line.req.headers)
      expect(names.every((n) => LOGGED_REQUEST_HEADERS.includes(n))).toBe(true)
      expect(line.req.headers['user-agent']).toBe('sentinel-agent')
    }
  })
})

describe('createLogger redaction backstop', () => {
  it('censors listed credential headers one level below a logged field', () => {
    const { lines, logger } = capture()
    logger.error(
      { err: { config: { headers: { authorization: 'Bearer SENTINEL_OUTBOUND' } } } },
      'outbound failed',
    )
    logger.error({ err: { headers: SENTINELS } }, 'error with headers')
    logger.info({ req: { headers: SENTINELS } }, 'raw req')
    const output = lines.join('')
    for (const value of [
      'SENTINEL_OUTBOUND',
      'SENTINEL_AUTHORIZATION',
      'SENTINEL_API_KEY',
      'SENTINEL_COOKIE',
      'SENTINEL_PROXY',
    ]) {
      expect(output).not.toContain(value)
    }
    expect(output).toContain('[Redacted]')
  })
})
