import { describe, it, expect } from 'vitest'
import { configSchema } from '../src/config.js'

const VALID_BASE = {
  publicHostname: 'test.com',
  encryptionKey: 'a'.repeat(64),
  groupPdsUrl: 'https://pds.example.com',
}

describe('configSchema', () => {
  it('applies all defaults', () => {
    const config = configSchema.parse(VALID_BASE)
    expect(config.port).toBe(3000)
    expect(config.dataDir).toBe('./data')
    expect(config.plcUrl).toBe('https://plc.directory')
    expect(config.didCacheTtlMs).toBe(600_000)
    expect(config.maxBlobSize).toBe(5 * 1024 * 1024)
    expect(config.logLevel).toBe('info')
  })

  it('rejects missing publicHostname', () => {
    const { publicHostname, ...rest } = VALID_BASE
    expect(() => configSchema.parse(rest)).toThrow()
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
})
