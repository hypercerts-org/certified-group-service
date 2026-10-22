import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configSchema } from '../src/config.js'

const VALID_BASE = {
  serviceUrl: 'https://group-service.example.com',
  encryptionKey: 'a'.repeat(64),
  groupPdsUrl: 'https://pds.example.com',
}

describe('configSchema', () => {
  it('applies all defaults', () => {
    const config = configSchema.parse(VALID_BASE)
    expect(config.port).toBe(3000)
    expect(config.dataDir).toBe('./data')
    expect(config.serviceDid).toBe('did:web:group-service.example.com')
    expect(config.plcUrl).toBe('https://plc.directory')
    expect(config.didCacheTtlMs).toBe(600_000)
    expect(config.maxBlobSize).toBe(5 * 1024 * 1024)
    expect(config.logLevel).toBe('info')
  })

  it('accepts explicit serviceDid', () => {
    const config = configSchema.parse({
      ...VALID_BASE,
      serviceDid: 'did:web:custom.example.com',
    })
    expect(config.serviceDid).toBe('did:web:custom.example.com')
  })

  it('rejects missing serviceUrl', () => {
    const { serviceUrl, ...rest } = VALID_BASE
    expect(() => configSchema.parse(rest)).toThrow()
  })

  it('rejects invalid serviceUrl', () => {
    expect(() => configSchema.parse({ ...VALID_BASE, serviceUrl: 'not-a-url' })).toThrow()
  })

  it('rejects missing encryptionKey', () => {
    const { encryptionKey, ...rest } = VALID_BASE
    expect(() => configSchema.parse(rest)).toThrow()
  })

  it('rejects short encryptionKey', () => {
    expect(() => configSchema.parse({ ...VALID_BASE, encryptionKey: 'abcd' })).toThrow('64 hex')
  })

  it('rejects non-hex encryptionKey', () => {
    expect(() => configSchema.parse({ ...VALID_BASE, encryptionKey: 'g'.repeat(64) })).toThrow()
  })

  it('coerces string port to number', () => {
    const config = configSchema.parse({ ...VALID_BASE, port: '8080' })
    expect(config.port).toBe(8080)
  })

  it('rejects invalid plcUrl', () => {
    expect(() => configSchema.parse({ ...VALID_BASE, plcUrl: 'not-a-url' })).toThrow()
  })

  it('rejects invalid logLevel', () => {
    expect(() => configSchema.parse({ ...VALID_BASE, logLevel: 'verbose' })).toThrow()
  })

  it('accepts all valid logLevels', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      const config = configSchema.parse({ ...VALID_BASE, logLevel: level })
      expect(config.logLevel).toBe(level)
    }
  })

  it('rejects missing groupPdsUrl', () => {
    const { groupPdsUrl, ...rest } = VALID_BASE
    expect(() => configSchema.parse(rest)).toThrow()
  })

  it('leaves adminPassword undefined by default', () => {
    const config = configSchema.parse(VALID_BASE)
    expect(config.adminPassword).toBeUndefined()
  })

  it('accepts an adminPassword of at least 16 non-whitespace chars', () => {
    const config = configSchema.parse({ ...VALID_BASE, adminPassword: 'a-strong-secret-1234' })
    expect(config.adminPassword).toBe('a-strong-secret-1234')
  })

  it('rejects an empty adminPassword', () => {
    expect(() => configSchema.parse({ ...VALID_BASE, adminPassword: '' })).toThrow()
  })

  it('rejects a too-short adminPassword', () => {
    expect(() => configSchema.parse({ ...VALID_BASE, adminPassword: 's3cret' })).toThrow(
      'at least 16',
    )
  })

  it('rejects a whitespace-padded short adminPassword', () => {
    expect(() => configSchema.parse({ ...VALID_BASE, adminPassword: '   short   ' })).toThrow(
      'at least 16',
    )
  })

  it('leaves encryptionKeyNext undefined by default', () => {
    const config = configSchema.parse(VALID_BASE)
    expect(config.encryptionKeyNext).toBeUndefined()
  })

  it('accepts an encryptionKeyNext that differs from encryptionKey', () => {
    const config = configSchema.parse({ ...VALID_BASE, encryptionKeyNext: 'b'.repeat(64) })
    expect(config.encryptionKeyNext).toBe('b'.repeat(64))
  })

  it.each([
    ['empty', ''],
    ['too short', 'abcd'],
    ['not hex', 'g'.repeat(64)],
  ])('rejects an encryptionKeyNext that is %s', (_label, encryptionKeyNext) => {
    expect(() => configSchema.parse({ ...VALID_BASE, encryptionKeyNext })).toThrow('64 hex')
  })

  it('rejects an encryptionKeyNext equal to encryptionKey', () => {
    expect(() =>
      configSchema.parse({ ...VALID_BASE, encryptionKeyNext: VALID_BASE.encryptionKey }),
    ).toThrow(
      'ENCRYPTION_KEY_NEXT must differ from ENCRYPTION_KEY. If rotation is complete, remove ENCRYPTION_KEY_NEXT.',
    )
  })

  it('rejects an encryptionKeyNext that differs from encryptionKey only by letter case', () => {
    expect(() =>
      configSchema.parse({
        ...VALID_BASE,
        encryptionKey: 'abcdef01'.repeat(8),
        encryptionKeyNext: 'ABCDEF01'.repeat(8),
      }),
    ).toThrow('must differ')
  })
})

// The other variables loadConfig reads. They are cleared so that a value from
// the developer's shell or CI (LOG_LEVEL=verbose, a short CGS_ADMIN_PASSWORD)
// cannot fail the test.
const OTHER_ENV_VARS = [
  'PORT',
  'DATA_DIR',
  'SERVICE_DID',
  'ENCRYPTION_KEY_NEXT',
  'GROUP_PDS_INVITE_CODE',
  'CGS_ADMIN_PASSWORD',
  'PLC_URL',
  'DID_CACHE_TTL_MS',
  'MAX_BLOB_SIZE',
  'LOG_LEVEL',
]

describe('loadConfig', () => {
  beforeEach(() => {
    vi.resetModules() // loadConfig memoises its result at module level
    for (const name of OTHER_ENV_VARS) vi.stubEnv(name, undefined)
    vi.stubEnv('SERVICE_URL', VALID_BASE.serviceUrl)
    vi.stubEnv('GROUP_PDS_URL', VALID_BASE.groupPdsUrl)
    vi.stubEnv('ENCRYPTION_KEY', VALID_BASE.encryptionKey)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads encryptionKeyNext from ENCRYPTION_KEY_NEXT', async () => {
    vi.stubEnv('ENCRYPTION_KEY_NEXT', 'b'.repeat(64))
    const { loadConfig } = await import('../src/config.js')
    expect(loadConfig().encryptionKeyNext).toBe('b'.repeat(64))
  })
})
