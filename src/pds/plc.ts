/**
 * Custom PLC operation helpers — why we don't use @did-plc/lib
 *
 * The canonical library for PLC operations is @did-plc/lib, which exports
 * signOperation, addSignature, createUpdateOp, and friends. We reimplement
 * the small subset we need here (~30 lines) for the following reasons:
 *
 * 1. The latest npm release (@did-plc/lib@0.0.4, April 2023) pins
 *    @atproto/crypto@0.1.0. This project and the rest of the @atproto
 *    ecosystem use @atproto/crypto@0.4.x. Installing the published lib
 *    would pull two copies of @atproto/crypto into the dependency tree,
 *    risking type mismatches when Secp256k1Keypair instances cross package
 *    boundaries (e.g. `instanceof` checks, .sign() return types).
 *
 * 2. An updated version (@did-plc/lib@0.1.0) exists on the did-method-plc
 *    GitHub main branch targeting @atproto/crypto@0.4.3, but it has never
 *    been published to npm. Depending on a git commit is fragile and harder
 *    to audit.
 *
 * 3. The reimplemented surface is trivial: DAG-CBOR encode → SHA-256 hash
 *    → secp256k1 sign → base64url. The PLC spec is stable and unlikely to
 *    change in a way that would diverge from this implementation.
 *
 * If @did-plc/lib is ever published with @atproto/crypto >=0.4.x compat,
 * these helpers can be replaced with direct imports.
 */
import { Secp256k1Keypair } from '@atproto/crypto'
import * as dagCbor from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

const DAG_CBOR_CODE = 0x71

export interface PlcServiceEntry {
  type: string
  endpoint: string
}

export interface UnsignedPlcOperation {
  type: 'plc_operation'
  rotationKeys: string[]
  verificationMethods: Record<string, string>
  alsoKnownAs: string[]
  services: Record<string, PlcServiceEntry>
  prev: string | null
}

/**
 * Generate a new Secp256k1 keypair suitable for use as a PLC rotation key.
 */
export async function generateRecoveryKey(): Promise<Secp256k1Keypair> {
  return Secp256k1Keypair.create({ exportable: true })
}

/**
 * Fetch the CID of the most recent PLC operation for a DID.
 */
export async function getLatestPlcCid(plcUrl: string, did: string): Promise<string> {
  const res = await fetch(`${plcUrl}/${encodeURIComponent(did)}/log/audit`)
  if (!res.ok) {
    throw new Error(`Failed to fetch PLC audit log for ${did}: ${res.status}`)
  }
  const entries = (await res.json()) as { cid: string }[]
  if (entries.length === 0) {
    throw new Error(`No PLC operations found for ${did}`)
  }
  return entries[entries.length - 1].cid
}

/**
 * Sign a PLC operation using the given rotation key.
 *
 * The operation is DAG-CBOR encoded (without `sig`), SHA-256 hashed,
 * then signed with the keypair. The signature is appended as base64url.
 */
export async function signPlcOperation(
  op: UnsignedPlcOperation,
  key: Secp256k1Keypair,
): Promise<Record<string, unknown>> {
  // DAG-CBOR encode the unsigned operation
  const encoded = dagCbor.encode(op)

  // key.sign() internally SHA-256 hashes before signing
  const sig = await key.sign(encoded)

  // Return the full signed operation
  return {
    ...op,
    sig: Buffer.from(sig).toString('base64url'),
  }
}

/**
 * Submit a signed PLC operation directly to the PLC directory.
 */
export async function submitPlcOperation(
  plcUrl: string,
  did: string,
  operation: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${plcUrl}/${encodeURIComponent(did)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(operation),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PLC operation submission failed (${res.status}): ${body}`)
  }
}

/**
 * Build the CID for a signed PLC operation (DAG-CBOR + SHA-256, CIDv1).
 */
export async function computeOperationCid(op: Record<string, unknown>): Promise<CID> {
  const encoded = dagCbor.encode(op)
  const hash = await sha256.digest(encoded)
  return CID.createV1(DAG_CBOR_CODE, hash)
}
