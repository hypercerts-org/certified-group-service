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

// The service binds the `aud` for rpc: scopes, so clients pass the friendly
// `rpc:<method>` form. repo:/blob: scopes carry no aud and are sent as-is.
const READ_SCOPES = [
  { value: 'rpc:app.certified.group.member.list', label: 'Read members (member.list)' },
  { value: 'rpc:app.certified.group.audit.query', label: 'Read audit log (audit.query)' },
] as const

const REPO_ACTIONS = ['create', 'update', 'delete'] as const
type RepoAction = (typeof REPO_ACTIONS)[number]

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
  const [tryResult, setTryResult] = useState<{ status: number; data: any } | null>(null)
  const [tryError, setTryError] = useState('')
  const [trying, setTrying] = useState(false)

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

  // Call member.list with the key — no owner session involved, proving the key
  // stands on its own. A key without the member.list scope gets a 403 here.
  const useKeyForMemberList = async () => {
    setTryError('')
    setTryResult(null)
    if (!tryKey.trim()) return setTryError('Paste a key (the cgsk_… value shown at creation).')
    setTrying(true)
    try {
      const res = await callWithApiKey({
        key: tryKey.trim(),
        nsid: 'app.certified.group.member.list',
        repo: groupDid,
        method: 'GET',
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
      <h2>API keys</h2>
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
          Calls <code>member.list</code> with the key via the <code>X-API-Key</code> header — no
          owner session. A key without the <code>member.list</code> scope returns <code>403</code>.
        </p>
        <input
          style={{ ...inputStyle, width: '100%', fontFamily: 'monospace', marginBottom: 8 }}
          value={tryKey}
          onChange={(e) => setTryKey(e.target.value)}
          placeholder="cgsk_…"
        />
        <button style={btnStyle} onClick={useKeyForMemberList} disabled={trying}>
          {trying ? 'Calling…' : 'Call member.list with this key'}
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
