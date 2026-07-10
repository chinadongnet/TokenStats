import React, { useEffect, useState } from 'react'

// Mirrors paths.js's LITELLM_DEFAULT_COLOR / parsers/litellm.js's DEFAULT_SYNC_MINUTES —
// the renderer can't import from the main process, so these literals stay in sync by hand.
const DEFAULT_COLOR = '#f59e0b'
const DEFAULT_SYNC_MINUTES = 15

const emptyDraft = () => ({
  id: null,
  name: '',
  baseUrl: '',
  apiKey: '',
  color: DEFAULT_COLOR,
  syncMinutes: DEFAULT_SYNC_MINUTES,
  enabled: true,
})

const compact = (n) => {
  n = Number(n) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const usd = (n) => (Number(n) || 0).toFixed(2)

export default function Settings() {
  const [providers, setProviders] = useState(null) // null = loading
  const [editingId, setEditingId] = useState(null) // null | 'new' | providerId
  const [draft, setDraft] = useState(emptyDraft())
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // {ok, count} | {ok:false, error}
  const [expanded, setExpanded] = useState(null) // providerId whose model list is shown
  const [modelsByProvider, setModelsByProvider] = useState({}) // id -> {loading, error, rows}

  async function load() {
    const rows = await window.api.litellmListProviders()
    setProviders(rows)
  }
  useEffect(() => { load() }, [])

  function startAdd() {
    setDraft(emptyDraft())
    setTestResult(null)
    setEditingId('new')
  }
  function startEdit(p) {
    setDraft({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, color: p.color, syncMinutes: p.syncMinutes, enabled: p.enabled })
    setTestResult(null)
    setEditingId(p.id)
  }
  function cancelEdit() {
    setEditingId(null)
    setTestResult(null)
  }

  async function saveDraft() {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.apiKey.trim()) return
    setSaving(true)
    try {
      const saved = await window.api.litellmSaveProvider({
        id: draft.id || undefined,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
        apiKey: draft.apiKey.trim(),
        color: draft.color,
        syncMinutes: Number(draft.syncMinutes) > 0 ? Number(draft.syncMinutes) : DEFAULT_SYNC_MINUTES,
        enabled: draft.enabled,
      })
      await load()
      setEditingId(null)
      if (saved) {
        setExpanded(saved.id)
        loadModels(saved)
      }
    } finally {
      setSaving(false)
    }
  }

  async function deleteProvider(p) {
    if (!window.confirm(`Delete provider "${p.name}"? TokenStats will stop tracking its usage.`)) return
    await window.api.litellmDeleteProvider(p.id)
    if (editingId === p.id) setEditingId(null)
    if (expanded === p.id) setExpanded(null)
    await load()
  }

  async function toggleEnabled(p) {
    await window.api.litellmSaveProvider({ ...p, enabled: !p.enabled })
    await load()
  }

  async function testConnection() {
    const baseUrl = draft.baseUrl.trim().replace(/\/+$/, '')
    const apiKey = draft.apiKey.trim()
    if (!baseUrl || !apiKey) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.litellmListModels({ baseUrl, apiKey })
      setTestResult(res.ok ? { ok: true, count: res.models.length } : { ok: false, error: res.error })
    } finally {
      setTesting(false)
    }
  }

  async function loadModels(p) {
    setModelsByProvider((m) => ({ ...m, [p.id]: { loading: true, error: null, rows: m[p.id]?.rows || [] } }))
    try {
      const [res, settings] = await Promise.all([
        window.api.litellmListModels({ baseUrl: p.baseUrl, apiKey: p.apiKey }),
        window.api.litellmGetModelSettings(p.id),
      ])
      if (!res.ok) {
        setModelsByProvider((m) => ({ ...m, [p.id]: { loading: false, error: res.error, rows: [] } }))
        return
      }
      const settingsMap = new Map(settings.map((s) => [s.model, s]))
      const rows = res.models.map((mo) => ({
        model: mo.model,
        total: mo.total,
        cost: mo.cost,
        visible: settingsMap.get(mo.model)?.visible ?? true,
        displayName: settingsMap.get(mo.model)?.displayName || '',
      }))
      setModelsByProvider((m) => ({ ...m, [p.id]: { loading: false, error: null, rows } }))
    } catch (e) {
      setModelsByProvider((m) => ({ ...m, [p.id]: { loading: false, error: String(e), rows: [] } }))
    }
  }

  function toggleExpanded(p) {
    if (expanded === p.id) {
      setExpanded(null)
      return
    }
    setExpanded(p.id)
    if (!modelsByProvider[p.id]) loadModels(p)
  }

  async function setModelVisible(p, model, visible) {
    let displayName = ''
    setModelsByProvider((m) => {
      const rows = m[p.id].rows.map((r) => {
        if (r.model !== model) return r
        displayName = r.displayName
        return { ...r, visible }
      })
      return { ...m, [p.id]: { ...m[p.id], rows } }
    })
    await window.api.litellmSaveModelSetting({ providerId: p.id, model, visible, displayName: displayName || null })
  }

  function setModelDisplayNameLocal(p, model, displayName) {
    setModelsByProvider((m) => ({
      ...m,
      [p.id]: { ...m[p.id], rows: m[p.id].rows.map((r) => (r.model === model ? { ...r, displayName } : r)) },
    }))
  }

  async function commitModelDisplayName(p, model) {
    const row = modelsByProvider[p.id]?.rows.find((r) => r.model === model)
    if (!row) return
    await window.api.litellmSaveModelSetting({ providerId: p.id, model, visible: row.visible, displayName: row.displayName || null })
  }

  return (
    <div className="report">
      <header className="rep-head">
        <div className="rep-title"><span className="logo" /> LiteLLM Providers</div>
        <div className="rep-actions">
          <button className="btn primary" onClick={startAdd} disabled={editingId === 'new'}>+ Add provider</button>
        </div>
      </header>

      {editingId === 'new' && (
        <section className="card">
          <ProviderForm
            draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={cancelEdit}
            saving={saving} onTest={testConnection} testing={testing} testResult={testResult}
          />
        </section>
      )}

      {providers === null && <div className="empty">Loading…</div>}
      {providers !== null && providers.length === 0 && editingId !== 'new' && (
        <div className="empty">No LiteLLM providers configured yet. Click "+ Add provider" to track a proxy's usage.</div>
      )}

      {(providers || []).map((p) => (
        <section className="card" key={p.id}>
          {editingId === p.id ? (
            <ProviderForm
              draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={cancelEdit}
              saving={saving} onTest={testConnection} testing={testing} testResult={testResult}
            />
          ) : (
            <>
              <div className="card-head">
                <div className="provider-title">
                  <span className="dot" style={{ background: p.color }} />
                  {p.name}
                  {!p.enabled && <span className="muted small"> (disabled)</span>}
                </div>
                <div className="rep-actions">
                  <button className="btn" onClick={() => toggleExpanded(p)}>{expanded === p.id ? 'Hide models' : 'Models'}</button>
                  <button className="btn" onClick={() => toggleEnabled(p)}>{p.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="btn" onClick={() => startEdit(p)}>Edit</button>
                  <button className="btn danger" onClick={() => deleteProvider(p)}>Delete</button>
                </div>
              </div>
              <div className="provider-meta">{p.baseUrl} · syncs every {p.syncMinutes} min</div>

              {expanded === p.id && (
                <ModelList
                  state={modelsByProvider[p.id]}
                  onReload={() => loadModels(p)}
                  onToggle={(model, v) => setModelVisible(p, model, v)}
                  onRename={(model, v) => setModelDisplayNameLocal(p, model, v)}
                  onCommitRename={(model) => commitModelDisplayName(p, model)}
                />
              )}
            </>
          )}
        </section>
      ))}

      <footer className="rep-foot">
        TokenStats v{__APP_VERSION__} · provider keys stored locally in ~/.tokenstats/usage.sqlite
      </footer>
    </div>
  )
}

function ProviderForm({ draft, setDraft, onSave, onCancel, saving, onTest, testing, testResult }) {
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  const canTest = draft.baseUrl.trim() && draft.apiKey.trim()
  const canSave = draft.name.trim() && draft.baseUrl.trim() && draft.apiKey.trim()
  return (
    <div>
      <div className="field-row">
        <div className="field grow">
          <label>Name</label>
          <input type="text" value={draft.name} onChange={set('name')} placeholder="e.g. Work LiteLLM" />
        </div>
        <div className="field shrink">
          <label>Color</label>
          <input type="color" value={draft.color} onChange={set('color')} />
        </div>
        <div className="field shrink">
          <label>Sync (min)</label>
          <input type="number" min="1" value={draft.syncMinutes} onChange={set('syncMinutes')} />
        </div>
      </div>
      <div className="field-row">
        <div className="field grow">
          <label>Base URL</label>
          <input type="text" value={draft.baseUrl} onChange={set('baseUrl')} placeholder="https://litellm.example.com" />
        </div>
      </div>
      <div className="field-row">
        <div className="field grow">
          <label>Admin API key</label>
          <input type="password" value={draft.apiKey} onChange={set('apiKey')} placeholder="sk-..." />
        </div>
      </div>
      <div className="field-row" style={{ alignItems: 'center' }}>
        <button className="btn" onClick={onTest} disabled={testing || !canTest}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {testResult && (
          <span className={testResult.ok ? 'muted small' : 'reqclip'}>
            {testResult.ok ? `OK — ${testResult.count} model${testResult.count === 1 ? '' : 's'} found` : `Failed: ${testResult.error}`}
          </span>
        )}
      </div>
      <div className="field-row">
        <button className="btn primary" onClick={onSave} disabled={saving || !canSave}>{saving ? 'Saving…' : 'Save'}</button>
        <button className="btn" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  )
}

function ModelList({ state, onReload, onToggle, onRename, onCommitRename }) {
  if (!state || state.loading) return <div className="empty mini">Loading models…</div>
  if (state.error) {
    return (
      <div className="empty mini">
        Failed to load models: {state.error} <button className="btn" onClick={onReload}>Retry</button>
      </div>
    )
  }
  return (
    <div className="models" style={{ marginTop: 10 }}>
      <div className="card-head">
        <span className="card-sub">{state.rows.length} model{state.rows.length === 1 ? '' : 's'} seen in the last 35 days</span>
        <button className="btn" onClick={onReload}>Refresh</button>
      </div>
      {state.rows.length === 0 && <div className="empty">No usage found for this provider yet.</div>}
      {state.rows.map((r) => (
        <div className={'model-row' + (r.visible ? '' : ' hidden')} key={r.model}>
          <input
            type="checkbox"
            checked={r.visible}
            onChange={(e) => onToggle(r.model, e.target.checked)}
            title="Show in TokenStats"
          />
          <span className="mname" title={r.model}>{r.model}</span>
          <span className="mtok">{compact(r.total)}</span>
          <span className="mcost">{usd(r.cost)}</span>
          <input
            type="text"
            placeholder="display name (optional)"
            value={r.displayName}
            onChange={(e) => onRename(r.model, e.target.value)}
            onBlur={() => onCommitRename(r.model)}
          />
        </div>
      ))}
    </div>
  )
}
