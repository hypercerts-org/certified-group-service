import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { buildDidDocument, GROUP_SERVICE_TYPE, SERVICE_ID_FRAGMENT } from '../src/did-document.js'
import { serviceScopeAud } from '../src/auth/scopes.js'

const SERVICE_DID = 'did:web:groups.example.com'
const SERVICE_URL = 'https://groups.example.com'

describe('buildDidDocument', () => {
  it('builds a did:web doc whose id matches the service DID', () => {
    const doc = buildDidDocument(SERVICE_DID, SERVICE_URL)
    expect(doc.id).toBe(SERVICE_DID)
    expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1')
  })

  it('publishes the #certified_group_service service entry pointing at the service URL', () => {
    const doc = buildDidDocument(SERVICE_DID, SERVICE_URL)
    expect(doc.service).toHaveLength(1)
    const svc = doc.service[0]
    expect(svc.id).toBe(`#${SERVICE_ID_FRAGMENT}`)
    expect(svc.type).toBe(GROUP_SERVICE_TYPE)
    expect(svc.serviceEndpoint).toBe(SERVICE_URL)
  })

  it('service id fragment matches the scope aud fragment (consistency guard)', () => {
    const doc = buildDidDocument(SERVICE_DID, SERVICE_URL)
    // The scope aud is `${serviceDid}#${fragment}`; the doc entry id is
    // `#${fragment}`. They must agree or rpc: scopes reference a missing entry.
    // scopes.ts imports SERVICE_ID_FRAGMENT from did-document.ts, so this can't
    // drift — the guard asserts the two stay wired together.
    const scopeAud = serviceScopeAud(SERVICE_DID)
    expect(scopeAud.endsWith(doc.service[0].id)).toBe(true)
  })

  it('strips a trailing slash from the service endpoint', () => {
    const doc = buildDidDocument(SERVICE_DID, 'https://groups.example.com/')
    expect(doc.service[0].serviceEndpoint).toBe('https://groups.example.com')
  })
})

describe('GET /.well-known/did.json', () => {
  function appWithDidRoute() {
    const app = express()
    const doc = buildDidDocument(SERVICE_DID, SERVICE_URL)
    app.get('/.well-known/did.json', (_req, res) => res.json(doc))
    return app
  }

  it('serves 200 with a resolvable did document', async () => {
    const res = await request(appWithDidRoute()).get('/.well-known/did.json')
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(SERVICE_DID)
    expect(res.body.service[0].id).toBe(`#${SERVICE_ID_FRAGMENT}`)
  })
})
