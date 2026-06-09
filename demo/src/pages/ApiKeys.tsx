import { useEffect, useState } from 'react'
import { useGroup } from '../App'
import {
  createApiKey,
  listApiKeys,
  deleteApiKey,
  callWithApiKey,
  type ApiKeySummary,
  type CreatedApiKey,
} from '../api'
import { JsonEditor } from '../components/JsonEditor'
import { HandleId } from '../components/HandleId'
import { COLLECTIONS, recordTemplate } from '../collections'

// The service binds the `aud` for rpc: scopes, so clients pass the friendly
// `rpc:<method>` form. repo:/blob: scopes carry no aud and are sent as-is.
const READ_SCOPES = [
  { value: 'rpc:app.certified.group.member.list', label: 'Read members (member.list)' },
  { value: 'rpc:app.certified.group.audit.query', label: 'Read audit log (audit.query)' },
] as const

const REPO_ACTIONS = ['create', 'update', 'delete'] as const
type RepoAction = (typeof REPO_ACTIONS)[number]

// --- "Use a key" method catalog ---------------------------------------------
// The XRPC methods an API key can actually authenticate, with the form fields
// each one needs. This is the *key-accessible* subset of the CGS surface:
//
//   - `rpc:` query methods (member.list, audit.query) — gated by an rpc: scope.
//   - `repo:` write procedures (create/put/deleteRecord) — gated by a
//     repo:<collection>?action=… scope; the role still decides own-vs-any.
//
// Owner-only methods (keys.*, role.set, member.add/remove, group.register) have
// no key scope and would always 403, so they are omitted. uploadBlob is omitted
// too: it takes a raw binary stream, not a JSON body, so it can't be driven from
// this form (the Upload page covers blobs).
//
// `repo` is not a user-editable field here — it is always the active group. It
// rides the querystring (the BFF adds it, for auth) and, for the POST repo.*
// procedures, is ALSO injected into the body: their lexicon marks `repo`
// required, so the XRPC validator rejects a body without it; the service then
// checks the two agree. The fields below are the per-method extras only.
type TryField = 'collection' | 'rkey' | 'record' | 'auditFilters'

interface TryMethod {
  nsid: string
  label: string
  method: 'GET' | 'POST'
  /** Which extra inputs to render + collect into the call. */
  fields: TryField[]
  /** One-line reminder of the scope a key needs to pass authorization. */
  scopeHint: string
}

const TRY_METHODS: TryMethod[] = [
  {
    nsid: 'app.certified.group.member.list',
    label: 'member.list — list members (GET)',
    method: 'GET',
    fields: [],
    scopeHint: 'needs rpc:app.certified.group.member.list',
  },
  {
    nsid: 'app.certified.group.audit.query',
    label: 'audit.query — query the audit log (GET)',
    method: 'GET',
    fields: ['auditFilters'],
    scopeHint: 'needs rpc:app.certified.group.audit.query',
  },
  {
    nsid: 'app.certified.group.repo.createRecord',
    label: 'repo.createRecord — create a record (POST)',
    method: 'POST',
    fields: ['collection', 'record'],
    scopeHint: 'needs repo:<collection>?action=create',
  },
  {
    nsid: 'app.certified.group.repo.putRecord',
    label: 'repo.putRecord — create/replace a record (POST)',
    method: 'POST',
    fields: ['collection', 'rkey', 'record'],
    scopeHint: 'needs repo:<collection>?action=update',
  },
  {
    nsid: 'app.certified.group.repo.deleteRecord',
    label: 'repo.deleteRecord — delete a record (POST)',
    method: 'POST',
    fields: ['collection', 'rkey'],
    scopeHint: 'needs repo:<collection>?action=delete',
  },
]

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: 14,
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: '#1a1a2e',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
}

const dangerBtn: React.CSSProperties = { ...btnStyle, background: '#e74c3c' }

export function ApiKeys() {
  const { group } = useGroup()
  const groupDid = group?.did || ''

  const [name, setName] = useState('')
  const [readScopes, setReadScopes] = useState<string[]>([READ_SCOPES[0].value])
  const [repoCollection, setRepoCollection] = useState('')
  const [repoActions, setRepoActions] = useState<RepoAction[]>([])
  const [blobMime, setBlobMime] = useState('')

  const [minted, setMinted] = useState<CreatedApiKey | null>(null)
  const [keys, setKeys] = useState<ApiKeySummary[]>([])
  const [includeRevoked, setIncludeRevoked] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  // "Use a key" demo state
  const [tryKey, setTryKey] = useState('')
  const [tryNsid, setTryNsid] = useState(TRY_METHODS[0].nsid)
  const [tryCollection, setTryCollection] = useState('')
  const [tryRkey, setTryRkey] = useState('')
  const [tryRecord, setTryRecord] = useState('{\n  "$type": ""\n}')
  const [tryAuditFilters, setTryAuditFilters] = useState('{}')
  const [tryResult, setTryResult] = useState<{ status: number; data: any } | null>(null)
  const [tryError, setTryError] = useState('')
  const [trying, setTrying] = useState(false)

  const tryMethod = TRY_METHODS.find((m) => m.nsid === tryNsid) ?? TRY_METHODS[0]

  // Pick a collection for the write methods: set the collection field and, when
  // the method carries a record body, prefill it with that collection's
  // lexicon-valid template so the user edits a correct skeleton instead of
  // hand-writing one. Takes the method explicitly so it is safe to call from the
  // method-change handler, where `tryMethod` still reflects the previous render.
  const selectTryCollectionFor = (method: TryMethod, collection: string) => {
    setTryCollection(collection)
    if (collection && method.fields.includes('record')) {
      const template = recordTemplate(collection, new Date().toISOString())
      if (template) setTryRecord(JSON.stringify(template, null, 2))
    }
  }
  const selectTryCollection = (collection: string) => selectTryCollectionFor(tryMethod, collection)

  // Assemble the scope list from the picker selections.
  const scopes: string[] = [
    ...readScopes,
    ...(repoCollection.trim() && repoActions.length
      ? repoActions.map((a) => `repo:${repoCollection.trim()}?action=${a}`)
      : []),
    ...(blobMime.trim() ? [`blob:${blobMime.trim()}`] : []),
  ]

  const refresh = async () => {
    if (!groupDid) return
    setError('')
    try {
      const res = await listApiKeys(groupDid, includeRevoked)
      setKeys(res.keys)
    } catch (err: any) {
      setError(err.message)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupDid, includeRevoked])

  const toggle = <T,>(list: T[], v: T, set: (l: T[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  const mint = async () => {
    setError('')
    setMinted(null)
    setCopied(false)
    if (!name.trim()) return setError('Give the key a name.')
    if (!scopes.length) return setError('Select at least one scope.')
    setLoading(true)
    try {
      const created = await createApiKey(groupDid, name.trim(), scopes)
      setMinted(created)
      setTryKey(created.key) // prefill the "use a key" box with the fresh key
      setName('')
      await refresh()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const revoke = async (keyRef: string) => {
    setError('')
    try {
      await deleteApiKey(groupDid, keyRef)
      await refresh()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const copyKey = async () => {
    if (!minted) return
    // navigator.clipboard is only available in secure contexts and can reject;
    // fail gracefully (the key is shown in full above, so the user can select it).
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(minted.key)
        setCopied(true)
      } else {
        setError('Clipboard unavailable — select the key above and copy manually.')
      }
    } catch {
      setError('Could not copy to clipboard — select the key above and copy manually.')
    }
  }

  // Call the chosen XRPC with the key — no owner session involved, proving the
  // key stands on its own. A key whose scopes don't cover the method gets a 403.
  // `repo` rides the querystring (the BFF adds it); the body carries only the
  // method's own fields, never `repo`.
  const useKey = async () => {
    setTryError('')
    setTryResult(null)
    if (!tryKey.trim()) return setTryError('Paste a key (the cgsk_… value shown at creation).')

    // Build the request from the selected method's declared fields. POST inputs
    // go in `body`; GET filters go in `params` (the BFF appends them to the
    // querystring). Parse the JSON inputs up front so a typo surfaces here, not
    // as an opaque upstream error.
    // collection + rkey are required wherever the method declares them; catch a
    // blank here so the user sees a clear message rather than an upstream 400.
    if (tryMethod.fields.includes('collection') && !tryCollection.trim()) {
      return setTryError('Collection is required for this method.')
    }
    if (tryMethod.fields.includes('rkey') && !tryRkey.trim()) {
      return setTryError('Record key (rkey) is required for this method.')
    }

    let body: Record<string, any> | undefined
    let params: Record<string, any> | undefined
    try {
      if (tryMethod.method === 'POST') {
        // `repo` rides the querystring (for auth) AND the body: the repo.*
        // procedures declare `repo` as required in their lexicon input schema,
        // so the XRPC validator rejects the body without it before the handler
        // runs. The service checks the body `repo` matches the querystring one.
        body = { repo: groupDid }
        if (tryMethod.fields.includes('collection')) body.collection = tryCollection.trim()
        if (tryMethod.fields.includes('rkey')) body.rkey = tryRkey.trim()
        if (tryMethod.fields.includes('record')) body.record = JSON.parse(tryRecord)
      } else if (tryMethod.fields.includes('auditFilters')) {
        const filters = JSON.parse(tryAuditFilters)
        // Empty object = unfiltered; send nothing extra in that case.
        if (filters && typeof filters === 'object' && Object.keys(filters).length) params = filters
      }
    } catch (err: any) {
      return setTryError(`Invalid JSON: ${err.message}`)
    }

    setTrying(true)
    try {
      const res = await callWithApiKey({
        key: tryKey.trim(),
        nsid: tryMethod.nsid,
        repo: groupDid,
        method: tryMethod.method,
        body,
        params,
      })
      setTryResult(res)
    } catch (err: any) {
      setTryError(err.message)
    } finally {
      setTrying(false)
    }
  }

  if (!group) {
    return <p>Select or register a group first.</p>
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ marginBottom: 4 }}>API keys</h2>
      <div style={{ marginBottom: 12 }}>
        <HandleId did={group.did} handle={group.handle} layout="stacked" style={{ fontSize: 16 }} />
      </div>
      <p style={{ color: '#555', fontSize: 14 }}>
        Mint a long-lived, scope-limited key an external backend can use via the{' '}
        <code>X-API-Key</code> header — no owner session, no 2-minute JWT refresh. The plaintext is
        shown <strong>once</strong>.
      </p>

      {error && <div style={{ color: '#c0392b', margin: '12px 0' }}>{error}</div>}

      {/* Show-once banner */}
      {minted && (
        <div
          style={{
            border: '2px solid #27ae60',
            background: '#eafaf1',
            borderRadius: 6,
            padding: 16,
            margin: '16px 0',
          }}
        >
          <strong>Key created — copy it now, it is never shown again.</strong>
          <div
            style={{
              fontFamily: 'monospace',
              wordBreak: 'break-all',
              background: '#fff',
              padding: 10,
              borderRadius: 4,
              margin: '8px 0',
            }}
          >
            {minted.key}
          </div>
          <button style={btnStyle} onClick={copyKey}>
            {copied ? 'Copied ✓' : 'Copy key'}
          </button>
          <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>
            keyRef <code>{minted.keyRef}</code> · scopes: {minted.scopes.join(', ')}
          </div>
        </div>
      )}

      {/* Mint form */}
      <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: 16, margin: '12px 0' }}>
        <h3 style={{ marginTop: 0 }}>Mint a key</h3>
        <label style={{ display: 'block', marginBottom: 12 }}>
          Name
          <br />
          <input
            style={{ ...inputStyle, width: '100%', marginTop: 4 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. analytics backend"
          />
        </label>

        <fieldset style={{ border: '1px solid #eee', borderRadius: 4, marginBottom: 12 }}>
          <legend>Read scopes (rpc:)</legend>
          {READ_SCOPES.map((s) => (
            <label key={s.value} style={{ display: 'block', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={readScopes.includes(s.value)}
                onChange={() => toggle(readScopes, s.value, setReadScopes)}
              />{' '}
              {s.label}
            </label>
          ))}
        </fieldset>

        <fieldset style={{ border: '1px solid #eee', borderRadius: 4, marginBottom: 12 }}>
          <legend>Record write scopes (repo:)</legend>
          <label style={{ fontSize: 14 }}>
            Collection{' '}
            <input
              style={inputStyle}
              value={repoCollection}
              onChange={(e) => setRepoCollection(e.target.value)}
              placeholder="app.bsky.feed.post"
            />
          </label>
          <div style={{ marginTop: 6 }}>
            {REPO_ACTIONS.map((a) => (
              <label key={a} style={{ fontSize: 14, marginRight: 12 }}>
                <input
                  type="checkbox"
                  checked={repoActions.includes(a)}
                  onChange={() => toggle(repoActions, a, setRepoActions)}
                />{' '}
                {a}
              </label>
            ))}
          </div>
          <small style={{ color: '#777' }}>
            Own-vs-any follows your role — a member-issued key only touches its own records.
          </small>
        </fieldset>

        <fieldset style={{ border: '1px solid #eee', borderRadius: 4, marginBottom: 12 }}>
          <legend>Blob upload scope (blob:)</legend>
          <label style={{ fontSize: 14 }}>
            Accept{' '}
            <input
              style={inputStyle}
              value={blobMime}
              onChange={(e) => setBlobMime(e.target.value)}
              placeholder="image/* or */*"
            />
          </label>
        </fieldset>

        <div style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
          Will request {scopes.length} scope{scopes.length === 1 ? '' : 's'}:{' '}
          <code style={{ wordBreak: 'break-all' }}>{scopes.join('  ') || '(none)'}</code>
        </div>

        <button style={btnStyle} onClick={mint} disabled={loading}>
          {loading ? 'Minting…' : 'Mint key'}
        </button>
      </div>

      {/* Use a key */}
      <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: 16, margin: '12px 0' }}>
        <h3 style={{ marginTop: 0 }}>Use a key</h3>
        <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>
          Call any key-accessible XRPC with the key via the <code>X-API-Key</code> header — no owner
          session. The call succeeds only if the key's scopes cover the method; otherwise the group
          service returns <code>403</code>.
        </p>
        <input
          style={{ ...inputStyle, width: '100%', fontFamily: 'monospace', marginBottom: 8 }}
          value={tryKey}
          onChange={(e) => setTryKey(e.target.value)}
          placeholder="cgsk_…"
        />

        <label style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
          Method
          <br />
          <select
            style={{ ...inputStyle, width: '100%', marginTop: 4 }}
            value={tryNsid}
            onChange={(e) => {
              const nsid = e.target.value
              setTryNsid(nsid)
              setTryResult(null)
              setTryError('')
              // When switching to a collection method with nothing chosen yet,
              // default to the first hypercerts collection (and prefill its
              // record template) so the form starts from a valid example.
              const next = TRY_METHODS.find((m) => m.nsid === nsid)
              if (next?.fields.includes('collection') && !tryCollection) {
                selectTryCollectionFor(next, COLLECTIONS[0])
              }
            }}
          >
            {TRY_METHODS.map((m) => (
              <option key={m.nsid} value={m.nsid}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div style={{ fontSize: 12, color: '#777', marginBottom: 8 }}>{tryMethod.scopeHint}</div>

        {tryMethod.fields.includes('collection') && (
          <label style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
            Collection
            <br />
            <select
              style={{ ...inputStyle, width: '100%', marginTop: 4 }}
              // A known hypercerts collection selects itself; anything else (a
              // typed custom NSID, or the cleared default) shows the custom row.
              value={(COLLECTIONS as readonly string[]).includes(tryCollection) ? tryCollection : '__custom__'}
              onChange={(e) =>
                selectTryCollection(e.target.value === '__custom__' ? '' : e.target.value)
              }
            >
              {COLLECTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
            {!(COLLECTIONS as readonly string[]).includes(tryCollection) && (
              <input
                style={{ ...inputStyle, width: '100%', marginTop: 6 }}
                value={tryCollection}
                onChange={(e) => setTryCollection(e.target.value)}
                placeholder="your.custom.collection"
              />
            )}
            {tryMethod.fields.includes('record') && (
              <small style={{ display: 'block', color: '#777', marginTop: 4 }}>
                Picking a hypercerts collection prefills a valid record template below.
              </small>
            )}
          </label>
        )}

        {tryMethod.fields.includes('rkey') && (
          <label style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
            Record key (rkey)
            <br />
            <input
              style={{ ...inputStyle, width: '100%', marginTop: 4 }}
              value={tryRkey}
              onChange={(e) => setTryRkey(e.target.value)}
              placeholder="3abc001"
            />
          </label>
        )}

        {tryMethod.fields.includes('record') && (
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 14 }}>Record JSON</label>
            <div style={{ marginTop: 4 }}>
              <JsonEditor value={tryRecord} onChange={setTryRecord} rows={8} />
            </div>
          </div>
        )}

        {tryMethod.fields.includes('auditFilters') && (
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 14 }}>
              Filters (JSON — optional; e.g.{' '}
              <code>{'{ "action": "createRecord", "limit": 10 }'}</code>)
            </label>
            <div style={{ marginTop: 4 }}>
              <JsonEditor value={tryAuditFilters} onChange={setTryAuditFilters} rows={5} />
            </div>
          </div>
        )}

        <button style={btnStyle} onClick={useKey} disabled={trying}>
          {trying ? 'Calling…' : `Call ${tryMethod.nsid.replace('app.certified.group.', '')} with this key`}
        </button>
        {tryError && <div style={{ color: '#c0392b', marginTop: 8 }}>{tryError}</div>}
        {tryResult && (
          <div style={{ marginTop: 8 }}>
            <strong>HTTP {tryResult.status}</strong>
            <pre
              style={{
                background: '#1a1a2e',
                color: '#9fe',
                padding: 10,
                borderRadius: 4,
                overflowX: 'auto',
                fontSize: 12,
              }}
            >
              {JSON.stringify(tryResult.data, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Key list */}
      <div style={{ margin: '16px 0' }}>
        <h3>
          Keys{' '}
          <label style={{ fontSize: 13, fontWeight: 400, marginLeft: 12 }}>
            <input
              type="checkbox"
              checked={includeRevoked}
              onChange={(e) => setIncludeRevoked(e.target.checked)}
            />{' '}
            include revoked
          </label>
        </h3>
        {keys.length === 0 ? (
          <p style={{ color: '#777' }}>No keys yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
                <th>Name</th>
                <th>keyRef</th>
                <th>Scopes</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr
                  key={k.keyRef}
                  style={{ borderBottom: '1px solid #eee', opacity: k.revokedAt ? 0.5 : 1 }}
                >
                  <td>{k.name}</td>
                  <td>
                    <code>{k.keyRef}</code>
                  </td>
                  <td style={{ maxWidth: 280, wordBreak: 'break-all' }}>{k.scopes.join(', ')}</td>
                  <td>{k.createdAt?.slice(0, 10)}</td>
                  <td>{k.lastUsedAt?.slice(0, 10) ?? '—'}</td>
                  <td>
                    {k.revokedAt ? (
                      <span style={{ color: '#999' }}>revoked</span>
                    ) : (
                      <button style={dangerBtn} onClick={() => revoke(k.keyRef)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
