import { useState } from 'react'
import { useGroup } from '../App'
import { proxyPost } from '../api'
import { JsonEditor } from '../components/JsonEditor'

const COLLECTIONS = [
  'org.hypercerts.claim.activity',
  'org.hypercerts.context.attachment',
  'org.hypercerts.context.measurement',
  'org.hypercerts.context.evaluation',
] as const

const TEMPLATES: Record<string, object> = {
  'org.hypercerts.claim.activity': {
    $type: 'org.hypercerts.claim.activity',
    title: '',
    description: '',
    workScope: [],
    workTimeframe: { start: '', end: '' },
    impactScope: [],
    contributors: [],
    createdAt: new Date().toISOString(),
  },
  'org.hypercerts.context.attachment': {
    $type: 'org.hypercerts.context.attachment',
    claim: 'at://...',
    title: '',
    description: '',
    blob: null,
    createdAt: new Date().toISOString(),
  },
  'org.hypercerts.context.measurement': {
    $type: 'org.hypercerts.context.measurement',
    claim: 'at://...',
    metric: '',
    value: 0,
    unit: '',
    description: '',
    measuredAt: '',
    createdAt: new Date().toISOString(),
  },
  'org.hypercerts.context.evaluation': {
    $type: 'org.hypercerts.context.evaluation',
    claim: 'at://...',
    evaluator: '',
    rating: '',
    summary: '',
    methodology: '',
    evaluatedAt: '',
    createdAt: new Date().toISOString(),
  },
}

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

type Tab = 'create' | 'update' | 'delete'

export function Records() {
  const { group } = useGroup()
  const groupDid = group?.did || ''
  const [tab, setTab] = useState<Tab>('create')
  const [collection, setCollection] = useState<string>(COLLECTIONS[0])
  const [customCollection, setCustomCollection] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [json, setJson] = useState(JSON.stringify(TEMPLATES[COLLECTIONS[0]], null, 2))
  const [rkey, setRkey] = useState('')
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const activeCollection = useCustom ? customCollection : collection

  const selectCollection = (c: string) => {
    setCollection(c)
    setUseCustom(false)
    if (TEMPLATES[c]) {
      setJson(JSON.stringify(TEMPLATES[c], null, 2))
    }
  }

  const createRecord = async () => {
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const record = JSON.parse(json)
      const res = await proxyPost('app.certified.group.repo.createRecord', {
        groupDid,
        repo: groupDid,
        collection: activeCollection,
        record,
      })
      setResult(res)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const updateRecord = async () => {
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const record = JSON.parse(json)
      const res = await proxyPost('app.certified.group.repo.putRecord', {
        groupDid,
        repo: groupDid,
        collection: activeCollection,
        rkey,
        record,
      })
      setResult(res)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const deleteRecord = async () => {
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const res = await proxyPost('app.certified.group.repo.deleteRecord', {
        groupDid,
        repo: groupDid,
        collection: activeCollection,
        rkey,
      })
      setResult(res)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '8px 16px',
    background: tab === t ? '#1a1a2e' : '#eee',
    color: tab === t ? '#fff' : '#333',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    borderRadius: '6px 6px 0 0',
  })

  if (!group) {
    return (
      <div>
        <h2 style={{ marginBottom: 16 }}>Records</h2>
        <div style={{ color: '#999', textAlign: 'center', padding: 40 }}>
          Select or register a group to manage records.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Records</h2>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 0 }}>
        <button style={tabStyle('create')} onClick={() => setTab('create')}>Create</button>
        <button style={tabStyle('update')} onClick={() => setTab('update')}>Update</button>
        <button style={tabStyle('delete')} onClick={() => setTab('delete')}>Delete</button>
      </div>

      <div style={{ background: '#fff', padding: 16, borderRadius: '0 6px 6px 6px', border: '1px solid #ddd' }}>
        {/* Collection selector */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Collection</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            {COLLECTIONS.map((c) => (
              <button
                key={c}
                onClick={() => selectCollection(c)}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
                  borderRadius: 12,
                  border: '1px solid #ccc',
                  background: !useCustom && collection === c ? '#e3f2fd' : '#fff',
                  cursor: 'pointer',
                }}
              >
                {c}
              </button>
            ))}
            <button
              onClick={() => setUseCustom(true)}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                borderRadius: 12,
                border: '1px solid #ccc',
                background: useCustom ? '#e3f2fd' : '#fff',
                cursor: 'pointer',
              }}
            >
              Custom
            </button>
          </div>
          {useCustom && (
            <input
              style={{ ...inputStyle, width: '100%', marginTop: 8 }}
              value={customCollection}
              onChange={(e) => setCustomCollection(e.target.value)}
              placeholder="your.custom.collection"
            />
          )}
        </div>

        {/* Rkey for update/delete */}
        {(tab === 'update' || tab === 'delete') && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Record Key (rkey)</label>
            <input
              style={{ ...inputStyle, width: '100%', marginTop: 4 }}
              value={rkey}
              onChange={(e) => setRkey(e.target.value)}
              placeholder="3abc001"
            />
          </div>
        )}

        {/* JSON editor for create/update */}
        {tab !== 'delete' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Record JSON</label>
            <div style={{ marginTop: 4 }}>
              <JsonEditor value={json} onChange={setJson} />
            </div>
          </div>
        )}

        {error && <div style={{ color: '#e74c3c', marginBottom: 12, fontSize: 13 }}>{error}</div>}
        {result && (
          <pre style={{ background: '#e8f5e9', padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 12, overflow: 'auto' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          {tab === 'create' && (
            <button onClick={createRecord} disabled={loading} style={btnStyle}>
              {loading ? 'Creating...' : 'Create Record'}
            </button>
          )}
          {tab === 'update' && (
            <button onClick={updateRecord} disabled={loading} style={btnStyle}>
              {loading ? 'Updating...' : 'Update Record'}
            </button>
          )}
          {tab === 'delete' && (
            <button onClick={deleteRecord} disabled={loading} style={dangerBtn}>
              {loading ? 'Deleting...' : 'Delete Record'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
