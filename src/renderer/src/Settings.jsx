import React, { useEffect, useState } from 'react'
import { t, useLang, LANGS } from './i18n.js'

// Mirrors paths.js's LITELLM_DEFAULT_COLOR / parsers/litellm.js's DEFAULT_SYNC_MINUTES —
// the renderer can't import from the main process, so these literals stay in sync by hand.
const DEFAULT_COLOR = '#f59e0b'
const DEFAULT_SYNC_MINUTES = 15

// The 5 fixed built-in CLIs a subscription can bind to (mirrors Report.jsx's FIXED_CLI).
const FIXED_SOURCES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'agy', label: 'Antigravity' },
  { id: 'cursor', label: 'Cursor' },
]

// Quick-add templates for the common plans; Mimo binds to a LiteLLM provider
// (picked by the user, with a key-alias + model filter) so it has no preset clis.
const SUB_PRESETS = [
  { key: 'claude', name: 'Claude', clis: ['claude'] },
  { key: 'chatgpt', name: 'ChatGPT', clis: ['codex'] },
  { key: 'google', name: 'Google AI', clis: ['gemini', 'agy'] },
  { key: 'cursor', name: 'Cursor', clis: ['cursor'] },
  { key: 'mimo', name: 'Mimo Token Plan', clis: [] },
]

const emptyDraft = () => ({
  id: null,
  name: '',
  baseUrl: '',
  apiKey: '',
  color: DEFAULT_COLOR,
  syncMinutes: DEFAULT_SYNC_MINUTES,
  enabled: true,
})

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Mirrors core/subscriptions.js's RESET_PERIODS — the renderer can't import from
// the main process, so these stay in sync by hand. A plan takes any SUBSET: Claude
// caps 5h + weekly, Cursor/Mimo only have a monthly allowance.
// `anchor` mirrors core/subscriptions.js's ANCHORED_PERIODS: 5h is rolling (its
// start is decided by usage, nothing to configure), weekly/monthly are pinned to
// a user-set date — weekly with a time of day, monthly by day-of-month.
const RESET_OPTIONS = [
  { value: '5h', labelKey: 'set.reset5h', hintKey: 'set.hintRolling' },
  { value: 'weekly', labelKey: 'set.resetWeekly', hintKey: 'set.hintFixedTime', anchor: 'datetime-local', anchorLabelKey: 'set.weeklyResetsAt' },
  { value: 'monthly', labelKey: 'set.resetMonthly', hintKey: 'set.hintFixedDay', anchor: 'date', anchorLabelKey: 'set.monthlyResetsOn' },
]
const resetLabel = (v) => { const o = RESET_OPTIONS.find((o) => o.value === v); return o ? t(o.labelKey) : v }
// A `datetime-local` input needs 'YYYY-MM-DDTHH:mm'; a bare start date has no time.
const defaultAnchor = (period, startDate) =>
  period === 'weekly' ? `${startDate}T00:00` : startDate

const emptySubDraft = () => ({
  id: null,
  name: '',
  monthlyUsd: '',
  startDate: todayIso(),
  active: true,
  endDate: '',
  bindings: [],
  resetPeriods: [],
  resetAnchors: {},
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
  const { lang, setLang } = useLang() // re-render on language switch
  const [providers, setProviders] = useState(null) // null = loading
  const [editingId, setEditingId] = useState(null) // null | 'new' | providerId
  const [draft, setDraft] = useState(emptyDraft())
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // {ok, count} | {ok:false, error}
  const [expanded, setExpanded] = useState(null) // providerId whose model list is shown
  const [modelsByProvider, setModelsByProvider] = useState({}) // id -> {loading, error, rows}

  // Antigravity (agy) live-quota integration state
  const [agy, setAgy] = useState(null) // null = loading; else getAgyQuotaState()
  const [agyBusy, setAgyBusy] = useState(false)

  // subscription plans
  const [subs, setSubs] = useState(null) // null = loading
  const [subStats, setSubStats] = useState({}) // id -> stats
  const [subEditing, setSubEditing] = useState(null) // null | 'new' | subId
  const [subDraft, setSubDraft] = useState(emptySubDraft())
  const [subSaving, setSubSaving] = useState(false)

  async function load() {
    const rows = await window.api.litellmListProviders()
    setProviders(rows)
  }
  useEffect(() => { load() }, [])

  async function loadSubs() {
    const [rows, stats] = await Promise.all([window.api.subsList(), window.api.subsStats()])
    setSubs(rows)
    setSubStats(Object.fromEntries((stats || []).map((s) => [s.id, s])))
  }
  useEffect(() => { loadSubs() }, [])

  useEffect(() => { window.api.agyGetState().then(setAgy) }, [])
  async function toggleAgy(on) {
    setAgyBusy(true)
    try {
      const res = await window.api.agySetEnabled(on)
      // enable/disable returns the fresh state (minus the leading ok flag)
      setAgy(res && res.agyFound !== undefined ? res : await window.api.agyGetState())
    } finally {
      setAgyBusy(false)
    }
  }

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
    if (!window.confirm(t('set.deleteProviderConfirm', { name: p.name }))) return
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

  // ---- subscription plan actions ----

  function startAddSub() {
    setSubDraft(emptySubDraft())
    setSubEditing('new')
  }
  function startEditSub(s) {
    setSubDraft({
      id: s.id,
      name: s.name,
      monthlyUsd: String(s.monthlyUsd ?? ''),
      startDate: s.startDate,
      active: s.active,
      endDate: s.endDate || '',
      bindings: (s.bindings || []).map((b) => ({ ...b })),
      resetPeriods: [...(s.resetPeriods || [])],
      resetAnchors: { ...(s.resetAnchors || {}) },
    })
    setSubEditing(s.id)
  }
  function cancelEditSub() {
    setSubEditing(null)
  }

  async function saveSubDraft() {
    if (!subDraft.name.trim() || !subDraft.startDate) return
    setSubSaving(true)
    try {
      await window.api.subsSave({
        id: subDraft.id || undefined,
        name: subDraft.name.trim(),
        monthlyUsd: Number(subDraft.monthlyUsd) || 0,
        startDate: subDraft.startDate,
        active: subDraft.active,
        endDate: subDraft.active ? null : subDraft.endDate || todayIso(),
        resetPeriods: subDraft.resetPeriods,
        // Each anchored period falls back to the billing start date only if the
        // user never touched its field; db.js drops anchors for unticked periods.
        resetAnchors: Object.fromEntries(
          RESET_OPTIONS.filter((o) => o.anchor && subDraft.resetPeriods.includes(o.value)).map((o) => [
            o.value,
            subDraft.resetAnchors[o.value] || defaultAnchor(o.value, subDraft.startDate),
          ])
        ),
        bindings: subDraft.bindings.map((b) => ({
          cli: b.cli,
          keyAlias: b.keyAlias?.trim() || null,
          // empty selection means "all models" — store as null, not []
          models: Array.isArray(b.models) && b.models.length ? b.models : null,
        })),
      })
      await loadSubs()
      setSubEditing(null)
    } finally {
      setSubSaving(false)
    }
  }

  async function deleteSub(s) {
    if (!window.confirm(t('set.deletePlanConfirm', { name: s.name }))) return
    await window.api.subsDelete(s.id)
    if (subEditing === s.id) setSubEditing(null)
    await loadSubs()
  }

  // Deactivate = stop billing after today; reactivate resumes monthly billing.
  async function toggleSubActive(s) {
    await window.api.subsSave({ ...s, active: !s.active, endDate: s.active ? todayIso() : null })
    await loadSubs()
  }

  const sourceLabel = (cli) => {
    const fixed = FIXED_SOURCES.find((f) => f.id === cli)
    if (fixed) return fixed.label
    if (cli.startsWith('litellm:')) {
      const p = (providers || []).find((p) => 'litellm:' + p.id === cli)
      return p ? p.name : t('common.deletedProvider')
    }
    return cli
  }

  // Human-readable status line under the agy toggle.
  const agyStatus = (() => {
    if (!agy) return ''
    if (!agy.agyFound) return t('set.agyNotFound')
    if (agy.foreign && !agy.enabled) return t('set.agyForeign')
    if (!agy.enabled) return t('set.agyQuotaHint')
    if (agy.mirrorAgeMs == null) return t('set.agyEnabledWaiting')
    const mins = Math.max(0, Math.round(agy.mirrorAgeMs / 60000))
    return t(mins > 60 ? 'set.agyEnabledStale' : 'set.agyEnabledFresh', { mins })
  })()
  const agyDisabled = agyBusy || !agy || !agy.agyFound || (agy.foreign && !agy.enabled)

  return (
    <div className="report">
      <header className="rep-head">
        <div className="rep-title"><span className="logo" /> {t('set.title')}</div>
      </header>

      {/* ---------------- App / language ---------------- */}
      <div className="group-head">
        <h2>{t('set.appSection')}</h2>
      </div>
      <section className="card">
        <div className="field-row" style={{ alignItems: 'center' }}>
          <div className="field shrink" style={{ width: 200 }}>
            <label>{t('set.language')}</label>
            <select className="sel" value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label>&nbsp;</label>
            <div className="muted small" style={{ marginTop: 7 }}>{t('set.languageHint')}</div>
          </div>
        </div>
        <div className="field-row" style={{ alignItems: 'flex-start', marginTop: 4 }}>
          <div className="field shrink" style={{ width: 200 }}>
            <label>{t('set.agyQuota')}</label>
            <label className="check" style={{ marginTop: 7 }}>
              <input
                type="checkbox"
                checked={!!(agy && agy.enabled)}
                disabled={agyDisabled}
                onChange={(e) => toggleAgy(e.target.checked)}
              />
              {t('set.agyQuotaOn')}
            </label>
          </div>
          <div className="field grow">
            <label>&nbsp;</label>
            <div className="muted small" style={{ marginTop: 7 }}>{agyStatus}</div>
          </div>
        </div>
      </section>

      {/* ---------------- Subscription plans ---------------- */}
      <div className="group-head">
        <h2>{t('set.tokenPlans')}</h2>
        <button className="btn primary" onClick={startAddSub} disabled={subEditing === 'new'}>{t('set.addPlan')}</button>
      </div>

      {subEditing === 'new' && (
        <section className="card">
          <SubForm
            draft={subDraft} setDraft={setSubDraft} providers={providers || []}
            onSave={saveSubDraft} onCancel={cancelEditSub} saving={subSaving}
          />
        </section>
      )}

      {subs === null && <div className="empty">{t('common.loading')}</div>}
      {subs !== null && subs.length === 0 && subEditing !== 'new' && (
        <div className="empty">{t('set.noPlans')}</div>
      )}

      {(subs || []).map((s) => (
        <section className="card" key={s.id}>
          {subEditing === s.id ? (
            <SubForm
              draft={subDraft} setDraft={setSubDraft} providers={providers || []}
              onSave={saveSubDraft} onCancel={cancelEditSub} saving={subSaving}
            />
          ) : (
            <>
              <div className="card-head">
                <div className="provider-title">
                  {s.name}
                  <span className="muted small">${usd(s.monthlyUsd)}{t('set.perMo')}</span>
                  {!s.active && <span className="muted small">{t('set.ended', { date: s.endDate || '—' })}</span>}
                </div>
                <div className="rep-actions">
                  <button className="btn" onClick={() => toggleSubActive(s)}>{s.active ? t('set.deactivate') : t('set.reactivate')}</button>
                  <button className="btn" onClick={() => startEditSub(s)}>{t('common.edit')}</button>
                  <button className="btn danger" onClick={() => deleteSub(s)}>{t('common.delete')}</button>
                </div>
              </div>
              <div className="provider-meta">
                {t('set.since', { date: s.startDate })}
                {' · '}
                {(s.bindings || []).length === 0
                  ? t('set.noSources')
                  : (s.bindings || []).map((b) => sourceLabel(b.cli) + (b.keyAlias ? ` (${b.keyAlias})` : '')).join(', ')}
                {s.active && (s.resetPeriods || []).length > 0 && (
                  <>{' · '}{t('set.quotaResets', { list: s.resetPeriods.map(resetLabel).join(' + ') })}</>
                )}
              </div>
              {subStats[s.id] && (
                <div className="provider-meta">
                  {t('set.billed', { n: subStats[s.id].monthsBilled, unit: subStats[s.id].monthsBilled === 1 ? t('common.month') : t('common.months') })}
                  {' · '}{t('set.paid', { usd: usd(subStats[s.id].totalPaid) })}
                  {' · '}{t('set.usageWorth', { usd: usd(subStats[s.id].totalCost) })}
                  {subStats[s.id].totalPaid > 0 && (
                    <> ({Math.round((100 * subStats[s.id].totalCost) / subStats[s.id].totalPaid)}%)</>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      ))}

      {/* ---------------- LiteLLM providers ---------------- */}
      <div className="group-head">
        <h2>{t('set.litellmProviders')}</h2>
        <button className="btn primary" onClick={startAdd} disabled={editingId === 'new'}>{t('set.addProvider')}</button>
      </div>

      {editingId === 'new' && (
        <section className="card">
          <ProviderForm
            draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={cancelEdit}
            saving={saving} onTest={testConnection} testing={testing} testResult={testResult}
          />
        </section>
      )}

      {providers === null && <div className="empty">{t('common.loading')}</div>}
      {providers !== null && providers.length === 0 && editingId !== 'new' && (
        <div className="empty">{t('set.noProviders')}</div>
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
                  {!p.enabled && <span className="muted small"> {t('set.disabled')}</span>}
                </div>
                <div className="rep-actions">
                  <button className="btn" onClick={() => toggleExpanded(p)}>{expanded === p.id ? t('set.hideModels') : t('set.modelsBtn')}</button>
                  <button className="btn" onClick={() => toggleEnabled(p)}>{p.enabled ? t('set.disable') : t('set.enable')}</button>
                  <button className="btn" onClick={() => startEdit(p)}>{t('common.edit')}</button>
                  <button className="btn danger" onClick={() => deleteProvider(p)}>{t('common.delete')}</button>
                </div>
              </div>
              <div className="provider-meta">{t('set.syncsEvery', { url: p.baseUrl, min: p.syncMinutes })}</div>

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
        {t('set.footer', { ver: __APP_VERSION__ })}
      </footer>
    </div>
  )
}

// Add/edit form for one subscription plan: name, monthly USD fee, start date,
// active toggle (+ end date when inactive), and source bindings. A LiteLLM
// binding can additionally filter to one key alias and a subset of models —
// how a token plan (e.g. Mimo) that shares a proxy with other keys is isolated.
function SubForm({ draft, setDraft, providers, onSave, onCancel, saving }) {
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  const canSave = draft.name.trim() && draft.startDate
  // cli id -> {loading, error, rows:[model...]} for the per-binding model picker
  const [modelsState, setModelsState] = useState({})

  const sources = [
    ...FIXED_SOURCES,
    ...providers.filter((p) => p.enabled).map((p) => ({ id: 'litellm:' + p.id, label: p.name, provider: p })),
  ]

  const bindingFor = (cli) => draft.bindings.find((b) => b.cli === cli)

  function toggleReset(period) {
    setDraft((d) => ({
      ...d,
      resetPeriods: d.resetPeriods.includes(period)
        ? d.resetPeriods.filter((p) => p !== period)
        : [...d.resetPeriods, period],
    }))
  }

  function setResetAnchor(period, value) {
    setDraft((d) => ({ ...d, resetAnchors: { ...d.resetAnchors, [period]: value } }))
  }

  function toggleSource(cli) {
    setDraft((d) => {
      const has = d.bindings.some((b) => b.cli === cli)
      return { ...d, bindings: has ? d.bindings.filter((b) => b.cli !== cli) : [...d.bindings, { cli }] }
    })
  }

  function setBindingField(cli, key, value) {
    setDraft((d) => ({ ...d, bindings: d.bindings.map((b) => (b.cli === cli ? { ...b, [key]: value } : b)) }))
  }

  function applyPreset(e) {
    const preset = SUB_PRESETS.find((p) => p.key === e.target.value)
    if (!preset) return
    setDraft((d) => ({ ...d, name: preset.name, bindings: preset.clis.map((cli) => ({ cli })) }))
    e.target.value = ''
  }

  async function loadModelsFor(src) {
    const cli = src.id
    setModelsState((m) => ({ ...m, [cli]: { loading: true, error: null, rows: m[cli]?.rows || [] } }))
    try {
      const res = await window.api.litellmListModels({ baseUrl: src.provider.baseUrl, apiKey: src.provider.apiKey })
      if (!res.ok) {
        setModelsState((m) => ({ ...m, [cli]: { loading: false, error: res.error, rows: [] } }))
        return
      }
      setModelsState((m) => ({ ...m, [cli]: { loading: false, error: null, rows: res.models.map((mo) => mo.model) } }))
    } catch (e2) {
      setModelsState((m) => ({ ...m, [cli]: { loading: false, error: String(e2), rows: [] } }))
    }
  }

  function toggleModel(cli, model) {
    const b = bindingFor(cli)
    const cur = Array.isArray(b?.models) ? b.models : []
    const next = cur.includes(model) ? cur.filter((m) => m !== model) : [...cur, model]
    setBindingField(cli, 'models', next)
  }

  return (
    <div>
      <div className="field-row">
        <div className="field grow">
          <label>{t('set.name')}</label>
          <input type="text" value={draft.name} onChange={set('name')} placeholder={t('set.namePlaceholderPlan')} />
        </div>
        <div className="field shrink" style={{ width: 150 }}>
          <label>{t('set.preset')}</label>
          <select className="sel" defaultValue="" onChange={applyPreset}>
            <option value="" disabled>{t('set.pick')}</option>
            {SUB_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        </div>
        <div className="field shrink">
          <label>{t('set.usdMonth')}</label>
          <input type="number" min="0" step="0.01" value={draft.monthlyUsd} onChange={set('monthlyUsd')} placeholder="20" />
        </div>
      </div>
      <div className="field-row">
        <div className="field shrink" style={{ width: 150 }}>
          <label>{t('set.startDate')}</label>
          <input type="date" value={draft.startDate} onChange={set('startDate')} />
        </div>
        <div className="field shrink" style={{ width: 150 }}>
          <label>{t('set.status')}</label>
          <label className="check" style={{ marginTop: 7 }}>
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
            />
            {t('set.activeBills')}
          </label>
        </div>
        {!draft.active && (
          <div className="field shrink" style={{ width: 150 }}>
            <label>{t('set.endDate')}</label>
            <input type="date" value={draft.endDate || todayIso()} onChange={set('endDate')} />
          </div>
        )}
      </div>
      {draft.active && (
        <>
          <div className="field" style={{ marginTop: 4 }}>
            <label>{t('set.quotaPick')}</label>
          </div>
          <div className="field-row" style={{ alignItems: 'center', gap: 14 }}>
            {RESET_OPTIONS.map((o) => (
              <label className="check" key={o.value}>
                <input
                  type="checkbox"
                  checked={draft.resetPeriods.includes(o.value)}
                  onChange={() => toggleReset(o.value)}
                />
                {t(o.labelKey)}
                <span className="muted small">{t(o.hintKey)}</span>
              </label>
            ))}
          </div>
          {RESET_OPTIONS.filter((o) => o.anchor && draft.resetPeriods.includes(o.value)).map((o) => (
            <div className="field-row" key={o.value}>
              <div className="field shrink" style={{ width: o.value === 'weekly' ? 210 : 160 }}>
                <label>{t(o.anchorLabelKey)}</label>
                <input
                  type={o.anchor}
                  value={draft.resetAnchors[o.value] || defaultAnchor(o.value, draft.startDate)}
                  onChange={(e) => setResetAnchor(o.value, e.target.value)}
                />
              </div>
              <div className="field grow">
                <label>&nbsp;</label>
                <div className="muted small" style={{ marginTop: 7 }}>
                  {o.value === 'weekly' ? t('set.weeklyHint') : t('set.monthlyHint')}
                </div>
              </div>
            </div>
          ))}
          {draft.resetPeriods.length > 0 && (
            <div className="muted small" style={{ marginBottom: 8 }}>
              {t('set.quotaNote')}
            </div>
          )}
        </>
      )}

      <div className="field">
        <label>{t('set.countsFrom')}</label>
      </div>
      {sources.map((src) => {
        const b = bindingFor(src.id)
        const ms = modelsState[src.id]
        const selected = Array.isArray(b?.models) ? b.models : []
        return (
          <div className={'src-box' + (b ? ' on' : '')} key={src.id}>
            <label className="check">
              <input type="checkbox" checked={!!b} onChange={() => toggleSource(src.id)} />
              {src.label}
              {src.provider && <span className="muted small">{t('set.litellmTag')}</span>}
            </label>
            {b && src.provider && (
              <div className="src-litellm">
                <div className="field-row" style={{ marginBottom: 6 }}>
                  <div className="field grow">
                    <label>{t('set.keyAliasLabel')}</label>
                    <input
                      type="text"
                      value={b.keyAlias || ''}
                      onChange={(e) => setBindingField(src.id, 'keyAlias', e.target.value)}
                      placeholder={t('set.keyAliasPlaceholder')}
                    />
                  </div>
                </div>
                <div className="field-row" style={{ alignItems: 'center', marginBottom: 6 }}>
                  <button className="btn" onClick={() => loadModelsFor(src)} disabled={ms?.loading}>
                    {ms?.loading ? t('set.loadingModels') : ms?.rows?.length ? t('set.reloadModels') : t('set.loadModelsFilter')}
                  </button>
                  <span className="muted small">
                    {selected.length ? t('set.modelsSelected', { n: selected.length, unit: selected.length === 1 ? t('common.model') : t('common.models') }) : t('set.allModelsCounted')}
                  </span>
                </div>
                {ms?.error && <div className="reqclip small">{t('set.failed', { error: ms.error })}</div>}
                {ms?.rows?.length > 0 && (
                  <div className="model-picker">
                    {ms.rows.map((model) => (
                      <label className="check" key={model}>
                        <input type="checkbox" checked={selected.includes(model)} onChange={() => toggleModel(src.id, model)} />
                        <span className="mname" title={model}>{model}</span>
                      </label>
                    ))}
                  </div>
                )}
                {/* models picked earlier but list not loaded this session */}
                {!ms?.rows?.length && selected.length > 0 && (
                  <div className="muted small">{t('set.filteredTo', { list: selected.join(', ') })}</div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <div className="field-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={onSave} disabled={saving || !canSave}>{saving ? t('common.saving') : t('common.save')}</button>
        <button className="btn" onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>
      </div>
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
          <label>{t('set.name')}</label>
          <input type="text" value={draft.name} onChange={set('name')} placeholder={t('set.namePlaceholderProvider')} />
        </div>
        <div className="field shrink">
          <label>{t('set.color')}</label>
          <input type="color" value={draft.color} onChange={set('color')} />
        </div>
        <div className="field shrink">
          <label>{t('set.syncMin')}</label>
          <input type="number" min="1" value={draft.syncMinutes} onChange={set('syncMinutes')} />
        </div>
      </div>
      <div className="field-row">
        <div className="field grow">
          <label>{t('set.baseUrl')}</label>
          <input type="text" value={draft.baseUrl} onChange={set('baseUrl')} placeholder="https://litellm.example.com" />
        </div>
      </div>
      <div className="field-row">
        <div className="field grow">
          <label>{t('set.adminKey')}</label>
          <input type="password" value={draft.apiKey} onChange={set('apiKey')} placeholder="sk-..." />
        </div>
      </div>
      <div className="field-row" style={{ alignItems: 'center' }}>
        <button className="btn" onClick={onTest} disabled={testing || !canTest}>
          {testing ? t('set.testing') : t('set.testConn')}
        </button>
        {testResult && (
          <span className={testResult.ok ? 'muted small' : 'reqclip'}>
            {testResult.ok ? t('set.testOk', { count: testResult.count, unit: testResult.count === 1 ? t('common.model') : t('common.models') }) : t('set.failed', { error: testResult.error })}
          </span>
        )}
      </div>
      <div className="field-row">
        <button className="btn primary" onClick={onSave} disabled={saving || !canSave}>{saving ? t('common.saving') : t('common.save')}</button>
        <button className="btn" onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

function ModelList({ state, onReload, onToggle, onRename, onCommitRename }) {
  if (!state || state.loading) return <div className="empty mini">{t('set.loadingModels')}</div>
  if (state.error) {
    return (
      <div className="empty mini">
        {t('set.failedLoadModels', { error: state.error })} <button className="btn" onClick={onReload}>{t('set.retry')}</button>
      </div>
    )
  }
  return (
    <div className="models" style={{ marginTop: 10 }}>
      <div className="card-head">
        <span className="card-sub">{t('set.modelsSeen', { n: state.rows.length, unit: state.rows.length === 1 ? t('common.model') : t('common.models') })}</span>
        <button className="btn" onClick={onReload}>{t('set.refresh')}</button>
      </div>
      {state.rows.length === 0 && <div className="empty">{t('set.noProviderUsage')}</div>}
      {state.rows.map((r) => (
        <div className={'model-row' + (r.visible ? '' : ' hidden')} key={r.model}>
          <input
            type="checkbox"
            checked={r.visible}
            onChange={(e) => onToggle(r.model, e.target.checked)}
            title={t('set.showInApp')}
          />
          <span className="mname" title={r.model}>{r.model}</span>
          <span className="mtok">{compact(r.total)}</span>
          <span className="mcost">{usd(r.cost)}</span>
          <input
            type="text"
            placeholder={t('set.displayNamePlaceholder')}
            value={r.displayName}
            onChange={(e) => onRename(r.model, e.target.value)}
            onBlur={() => onCommitRename(r.model)}
          />
        </div>
      ))}
    </div>
  )
}
