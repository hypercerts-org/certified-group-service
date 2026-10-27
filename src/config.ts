import { z } from 'zod'

const hexKey64 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')

export const configSchema = z
  .object({
    port: z.coerce.number().default(3000),
    serviceUrl: z.string().url(),
    serviceDid: z.string().optional(), // did:web DID for this service; derived from serviceUrl if omitted
    dataDir: z.string().default('./data'),
    encryptionKey: hexKey64, // 32-byte hex (256-bit)
    // Rotation target. While set, boot re-encrypts stored credentials from
    // encryptionKey to this key and all encrypt/decrypt then uses it (see
    // activeEncryptionKey). Unset outside a rotation; the procedure is in
    // docs/deployment.md (Rotating ENCRYPTION_KEY).
    encryptionKeyNext: hexKey64.optional(),
    groupPdsUrl: z.string().url(), // PDS where group accounts are created
    groupPdsInviteCode: z.string().optional(), // invite code for account creation on the group PDS
    // enables HTTP Basic admin endpoints (user "admin"); disabled if unset.
    // Require a non-trivial secret since it gates owner reassignment.
    adminPassword: z
      .string()
      .refine(
        (v) => v.trim().length >= 16,
        'CGS_ADMIN_PASSWORD must be at least 16 non-whitespace characters',
      )
      .optional(),
    plcUrl: z.string().url().default('https://plc.directory'),
    didCacheTtlMs: z.coerce.number().default(600_000), // 10 minutes
    maxBlobSize: z.coerce.number().default(5 * 1024 * 1024), // 5MB
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  })
  // Hex digits are case-insensitive, so 'AAAA...' and 'aaaa...' are the same key.
  .refine(
    (c) =>
      c.encryptionKeyNext === undefined ||
      c.encryptionKeyNext.toLowerCase() !== c.encryptionKey.toLowerCase(),
    {
      path: ['encryptionKeyNext'],
      message:
        'ENCRYPTION_KEY_NEXT must differ from ENCRYPTION_KEY. If rotation is complete, remove ENCRYPTION_KEY_NEXT.',
    },
  )
  .transform((c) => ({
    ...c,
    serviceDid: c.serviceDid || `did:web:${new URL(c.serviceUrl).hostname}`,
  }))

export type Config = z.infer<typeof configSchema>

/**
 * The one key every encrypt and decrypt uses at runtime: `ENCRYPTION_KEY_NEXT`
 * during a rotation, otherwise `ENCRYPTION_KEY`. Boot has re-keyed the stored
 * secrets to it before the server listens, so request paths never need the old
 * key. Resolve the key here rather than repeating the fallback at call sites.
 */
export function activeEncryptionKey(
  config: Pick<Config, 'encryptionKey' | 'encryptionKeyNext'>,
): Buffer {
  return Buffer.from(config.encryptionKeyNext ?? config.encryptionKey, 'hex')
}

let cachedConfig: Config | undefined

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig
  const env = process.env
  cachedConfig = configSchema.parse({
    port: env.PORT,
    serviceUrl: env.SERVICE_URL,
    dataDir: env.DATA_DIR,
    encryptionKey: env.ENCRYPTION_KEY,
    encryptionKeyNext: env.ENCRYPTION_KEY_NEXT,
    serviceDid: env.SERVICE_DID,
    groupPdsUrl: env.GROUP_PDS_URL,
    groupPdsInviteCode: env.GROUP_PDS_INVITE_CODE,
    adminPassword: env.CGS_ADMIN_PASSWORD,
    plcUrl: env.PLC_URL,
    didCacheTtlMs: env.DID_CACHE_TTL_MS,
    maxBlobSize: env.MAX_BLOB_SIZE,
    logLevel: env.LOG_LEVEL,
  })
  return cachedConfig
}
