/**
 * The CGS `did:web` DID document, served at `/.well-known/did.json`.
 *
 * A `did:web` DID resolves to a document at
 * `https://<host>/.well-known/did.json`; without one the DID is malformed and
 * unresolvable (issue #29 / HYPER-484). The document also carries the `service`
 * entry that the AT Protocol service-proxying flow and the API-key `rpc:` scope
 * `aud` reference by fragment.
 *
 * Two-fragment convention (intentional — do not collapse to one):
 *
 * - `#certified_group_service` (here) marks the **service's own** doc: "this is
 *   the certified group service endpoint." It is the proxy target for the
 *   migrated `aud = serviceDid` path and the fragment in the API-key `rpc:`
 *   scope `aud` (`did:web:host#certified_group_service`).
 * - `certified_group` marks a **group's** doc (written by `register` /
 *   `import`): "this account is a group; route group-service traffic here." It
 *   is the proxy target for the legacy `aud = groupDid` path.
 *
 * DID-doc service ids are scoped per-document (DID-core), so the two fragments
 * could collide-free share a name — but they are deliberately distinct so a doc
 * inspected in isolation says which role it plays (provider vs group-subject).
 * The fragment is owned here, in the identity layer; consumers such as
 * `src/auth/scopes.ts` (API-key scope `aud`) import `SERVICE_ID_FRAGMENT` from
 * this module rather than the reverse.
 *
 * Identity-only: no `verificationMethod`. CGS does not sign anything with this
 * DID (proxied service-auth JWTs are signed by the *caller's* key; CGS verifies,
 * never signs). A verification method can be added later if CGS needs to issue
 * its own signed artifacts.
 */

/**
 * Service-id fragment for the CGS service entry in its own `did:web` document.
 * Owned here (identity layer); imported by the API-key scope layer.
 */
export const SERVICE_ID_FRAGMENT = 'certified_group_service'

export interface DidDocument {
  '@context': string[]
  id: string
  service: Array<{
    id: string
    type: string
    serviceEndpoint: string
  }>
}

/** AT Protocol service type for a group service endpoint. */
export const GROUP_SERVICE_TYPE = 'CertifiedGroupService'

export function buildDidDocument(serviceDid: string, serviceUrl: string): DidDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: serviceDid,
    service: [
      {
        id: `#${SERVICE_ID_FRAGMENT}`,
        type: GROUP_SERVICE_TYPE,
        // No trailing slash — match how the endpoint is referenced elsewhere.
        serviceEndpoint: serviceUrl.replace(/\/$/, ''),
      },
    ],
  }
}
