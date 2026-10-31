import React, { useEffect, useMemo, useRef, useState } from 'react'
import { fmtCount, t, useLang } from './i18n.js'
import { SubscriptionDashboard, DeviceSwitchSeg } from './Cycles.jsx'

// The 5 fixed built-in CLIs. LiteLLM providers are NOT listed here — they're
// dynamic, DB-backed entries (`litellm:<providerId>`) fetched via
// window.api.litellmListProviders() and merged in at render time, so N of
// them can appear alongside these 5 without any code change per provider.
const FIXED_CLI = {
  claude: { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'Codex', color: '#10a37f' },
  gemini: { label: 'Gemini', color: '#4285f4' },
  agy: { label: 'Antigravity', color: '#a142f4' },
  cursor: { label: 'Cursor', color: '#6366f1' },
}
const FIXED_ORDER = ['claude', 'codex', 'gemini', 'agy', 'cursor']
// The hourly SQLite table can carry a `cli` for a provider deleted since it
// was ingested — never let a lookup render `undefined`.
const FALLBACK_META = (id) => ({ label: id?.startsWith?.('litellm:') ? t('common.deletedProvider') : id, color: '#5b6172' })
const metaFor = (CLI, id) => CLI[id] || FALLBACK_META(id)

const DAY = 86400000
const floorDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
const compact = (n) => fmtCount(n)
const compactUsd = (n) => {
  n = Number(n) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const usd = (n) => (Number(n) || 0).toFixed(2)
const usd4 = (n) => (Number(n) || 0).toFixed(4)
const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const num = (n) => (Number(n) || 0).toLocaleString()
const timeLabel = (ms) => {
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function Report() {
  useLang() // re-render whole report on language switch
  const [view, setView] = useState('charts') // charts | hour | requests | subs
  const [breakdown, setBreakdown] = useState('plan') // plan | model | project
  const [range, setRange] = useState('30d') // 7d | 30d | all
  // Seed from the fixed built-ins only — the dynamic provider list resolves
  // asynchronously (this window has no live snapshot subscription), and a
  // useEffect below adds newly-discovered provider ids as they arrive so a
  // provider added after this window opened still defaults to "shown".
  const [brands, setBrands] = useState(() => new Set(FIXED_ORDER))
  const [providers, setProviders] = useState([]) // dynamic LiteLLM providers
  const [today, setToday] = useState(() => floorDay(Date.now()))
  const [day, setDay] = useState(() => floorDay(Date.now()))
  const prevTodayRef = useRef(today)
  const [dayBreakdown, setDayBreakdown] = useState('model') // model | project
  const [span, setSpan] = useState({ min: null, max: null })
  const [hourly, setHourly] = useState([])
  const [daily, setDaily] = useState([])
  const [models, setModels] = useState([])
  const [projects, setProjects] = useState([])
  const [planBd, setPlanBd] = useState(null) // subs:breakdown for the charts range
  const [dayModels, setDayModels] = useState([])
  const [dayProjects, setDayProjects] = useState([])
  const [reqCli, setReqCli] = useState('all') // 'all' | cli
  const [requests, setRequests] = useState({ rows: [], count: 0 })
  const [exporting, setExporting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [deviceView, setDeviceView] = useState(null)

  const isLocalDeviceView =
    !deviceView?.hasCloudData ||
    deviceView.selectedDevice === 'local' ||
    Boolean(deviceView.currentKeyId && deviceView.selectedDevice === deviceView.currentKeyId)

  useEffect(() => {
    if (!isLocalDeviceView) {
      if (view === 'requests') setView('charts')
      if (breakdown === 'project') setBreakdown('model')
      if (dayBreakdown === 'project') setDayBreakdown('model')
    }
  }, [isLocalDeviceView, view, breakdown, dayBreakdown])

  function syncToday() {
    const nextToday = floorDay(Date.now())
    if (nextToday !== prevTodayRef.current) {
      const prevToday = prevTodayRef.current
      prevTodayRef.current = nextToday
      setToday(nextToday)
      setDay((curDay) => (curDay === prevToday ? nextToday : curDay))
      return true
    }
    return false
  }

  useEffect(() => {
    const h = setInterval(syncToday, 30000)
    window.addEventListener('focus', syncToday)
    return () => {
      clearInterval(h)
      window.removeEventListener('focus', syncToday)
    }
  }, [])

  const { fromMs, toMs } = useMemo(() => {
    const to = today + DAY
    if (range === '7d') return { fromMs: today - 6 * DAY, toMs: to }
    if (range === '30d') return { fromMs: today - 29 * DAY, toMs: to }
    return { fromMs: span.min != null ? floorDay(span.min) : 0, toMs: to }
  }, [range, span.min, today])

  async function load() {
    const [sp, h, d, m, p, dm, dp, bd] = await Promise.all([
      window.api.reportSpan(),
      window.api.reportHourly(day),
      window.api.reportDaily(fromMs, toMs),
      window.api.reportModels(fromMs, toMs),
      window.api.reportProjects(fromMs, toMs),
      window.api.reportModels(day, day + DAY),
      window.api.reportProjects(day, day + DAY),
      window.api.subsBreakdown(fromMs, toMs),
    ])
    setSpan(sp)
    setHourly(h)
    setDaily(d)
    setModels(m)
    setProjects(p)
    setDayModels(dm)
    setDayProjects(dp)
    setPlanBd(bd)
  }

  useEffect(() => {
    window.api.devicesGet?.().then((v) => v && setDeviceView(v))
  }, [])
  useEffect(() => { load() }, [day, fromMs, toMs])
  useEffect(() => window.api.onReportUpdated(() => {
    window.api.devicesGet?.().then((v) => v && setDeviceView(v))
    if (!syncToday()) load()
  }), [day, fromMs, toMs])
  useEffect(() => (window.api.onDeviceView ? window.api.onDeviceView((v) => {
    if (v) setDeviceView(v)
    if (!syncToday()) load()
    loadProviders()
  }) : () => {}), [day, fromMs, toMs])

  async function loadProviders() {
    const [localList, snap] = await Promise.all([
      window.api.litellmListProviders(),
      window.api.getSnapshot ? window.api.getSnapshot() : Promise.resolve(null),
    ])
    const byId = new Map()
    for (const p of localList || []) {
      const cliId = String(p.id || '').startsWith('litellm:') ? p.id : 'litellm:' + p.id
      byId.set(cliId, { id: cliId, label: p.name || p.label || cliId, color: p.color || '#f59e0b' })
    }
    for (const p of snap?.providers || []) {
      const cliId = String(p.id || '').startsWith('litellm:') ? p.id : 'litellm:' + p.id
      if (!byId.has(cliId)) {
        byId.set(cliId, { id: cliId, label: p.label || p.name || cliId, color: p.color || '#f59e0b' })
      }
    }
    setProviders([...byId.values()])
  }
  useEffect(() => { loadProviders() }, [])
  useEffect(() => window.api.onReportUpdated(() => loadProviders()), [])

  // 5 fixed built-in CLIs + local & remote LiteLLM providers + any dynamic CLI
  // present in the active device view's usage rows.
  const { CLI, ORDER } = useMemo(() => {
    const dynMap = new Map()
    for (const p of providers) {
      const cliId = String(p.id || '').startsWith('litellm:') ? p.id : 'litellm:' + p.id
      dynMap.set(cliId, { id: cliId, label: p.label || p.name || cliId, color: p.color || '#f59e0b' })
    }
    for (const row of [...daily, ...hourly, ...models, ...dayModels]) {
      const cliId = row?.cli
      if (cliId && !FIXED_CLI[cliId] && !dynMap.has(cliId)) {
        dynMap.set(cliId, { id: cliId, label: FALLBACK_META(cliId).label, color: '#f59e0b' })
      }
    }
    const dyn = [...dynMap.values()]
    return {
      CLI: { ...FIXED_CLI, ...Object.fromEntries(dyn.map((p) => [p.id, { label: p.label, color: p.color }])) },
      ORDER: [...FIXED_ORDER, ...dyn.map((p) => p.id)],
    }
  }, [providers, daily, hourly, models, dayModels])

  // A provider added after this window opened should default to "shown".
  useEffect(() => {
    setBrands((prev) => {
      const missing = ORDER.filter((c) => !prev.has(c))
      if (missing.length === 0) return prev
      const next = new Set(prev)
      for (const c of missing) next.add(c)
      return next
    })
  }, [ORDER.join(',')])

  async function loadRequests() {
    const res = await window.api.reportRequests({ dayStartMs: day, cli: reqCli === 'all' ? null : reqCli })
    setRequests(res || { rows: [], count: 0 })
  }
  useEffect(() => { if (view === 'requests') loadRequests() }, [view, day, reqCli])
  useEffect(() => window.api.onReportUpdated(() => { if (view === 'requests') loadRequests() }), [view, day, reqCli])

  function toggleBrand(c) {
    setBrands((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      // never allow an empty selection — reset to all instead of a blank report
      return next.size ? next : new Set(ORDER)
    })
  }

  // ---- shape data for charts (filtered by active brands) ----
  const hourData = useMemo(() => {
    const arr = Array.from({ length: 24 }, (_, h) => ({ label: h, segs: { claude: 0, codex: 0, gemini: 0, agy: 0, cursor: 0 }, total: 0 }))
    for (const r of hourly) {
      if (!brands.has(r.cli)) continue
      const h = new Date(r.hour).getHours()
      arr[h].segs[r.cli] = (arr[h].segs[r.cli] || 0) + r.total
      arr[h].total += r.total
    }
    return arr
  }, [hourly, brands])

  const dayData = useMemo(() => {
    const map = new Map()
    for (let t = fromMs; t < toMs; t += DAY) map.set(floorDay(t), { label: floorDay(t), segs: { claude: 0, codex: 0, gemini: 0, agy: 0, cursor: 0 }, total: 0 })
    for (const r of daily) {
      if (!brands.has(r.cli)) continue
      const k = floorDay(r.day)
      const b = map.get(k)
      if (!b) continue
      b.segs[r.cli] = (b.segs[r.cli] || 0) + r.total
      b.total += r.total
    }
    return [...map.values()].sort((a, b) => a.label - b.label)
  }, [daily, fromMs, toMs, brands])

  const shownModels = useMemo(() => models.filter((m) => brands.has(m.cli)), [models, brands])

  const summary = useMemo(() => {
    let total = 0, cost = 0, turns = 0
    for (const m of shownModels) { total += m.total; cost += m.cost; turns += m.turns }
    const activeDays = dayData.filter((d) => d.total > 0).length
    const peakDay = dayData.reduce((best, d) => (d.total > (best?.total || 0) ? d : best), null)
    const dailyAvg = activeDays > 0 ? total / activeDays : 0
    return { total, cost, turns, activeDays, peakDay, dailyAvg }
  }, [shownModels, dayData])

  const shownProjects = useMemo(() => projects.filter((p) => brands.has(p.cli)), [projects, brands])

  // Actual subscription money charged inside the visible range (all plans).
  const rangeFees = useMemo(
    () => (planBd?.plans || []).reduce((a, p) => a + p.fees, 0),
    [planBd]
  )

  const shownDayModels = useMemo(() => dayModels.filter((m) => brands.has(m.cli)), [dayModels, brands])
  const shownDayProjects = useMemo(() => dayProjects.filter((p) => brands.has(p.cli)), [dayProjects, brands])

  const daySummary = useMemo(() => {
    let total = 0, cost = 0, turns = 0
    for (const m of shownDayModels) { total += m.total; cost += m.cost; turns += m.turns }
    const activeHours = hourData.filter((h) => h.total > 0).length
    const peakHour = hourData.reduce((best, h) => (h.total > (best?.total || 0) ? h : best), null)
    return { total, cost, turns, activeHours, peakHour }
  }, [shownDayModels, hourData])

  async function doExport(mode) {
    setExporting(true)
    try {
      const res = await window.api.exportPng({ which: 'report', mode })
      if (res?.copied) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    } finally { setExporting(false) }
  }

  const scopeBadge = view === 'charts' ? fmtRange(fromMs, toMs) : view === 'subs' ? null : dayLabel(day)

  return (
    <div className="report">
      <header className="rep-head">
        <div className="rep-brand">
          <div className="rep-title"><span className="logo" /> {t('rep.title')}</div>
          {scopeBadge && <span className="rep-scope-badge">{scopeBadge}</span>}
        </div>
        <nav className="seg rep-view-tabs">
          <button className={view === 'charts' ? 'on' : ''} onClick={() => setView('charts')}>{t('rep.charts')}</button>
          <button className={view === 'hour' ? 'on' : ''} onClick={() => setView('hour')}>{t('rep.byHour')}</button>
          {isLocalDeviceView && <button className={view === 'requests' ? 'on' : ''} onClick={() => setView('requests')}>{t('rep.logs')}</button>}
          <button className={view === 'subs' ? 'on' : ''} onClick={() => setView('subs')}>{t('rep.tokenPlans')}</button>
        </nav>
        <div className="rep-actions">
          <button className="btn" disabled={exporting} onClick={() => doExport('copy')}>
            {copied ? t('rep.copied') : t('rep.copy')}
          </button>
          <button className="btn primary" disabled={exporting} onClick={() => doExport('save')}>
            {exporting ? t('rep.exporting') : t('rep.exportPng')}
          </button>
        </div>
      </header>

      {view !== 'subs' && (
        <div className="rep-toolbar">
          <div className="rep-toolbar-left">
            <DeviceSwitchSeg />
            {(view === 'charts' || view === 'hour') && (
              <Legend
                brands={brands}
                onToggle={toggleBrand}
                onReset={() => setBrands(new Set(ORDER))}
                CLI={CLI}
                ORDER={ORDER}
              />
            )}
            {view === 'requests' && (
              <select className="sel" value={reqCli} onChange={(e) => setReqCli(e.target.value)}>
                <option value="all">{t('rep.allProviders')}</option>
                {ORDER.map((c) => <option key={c} value={c}>{metaFor(CLI, c).label}</option>)}
              </select>
            )}
          </div>
          <div className="rep-toolbar-right">
            {view === 'charts' && (
              <div className="seg">
                {['7d', '30d', 'all'].map((r) => (
                  <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
                    {r === 'all' ? t('common.all') : t('rep.last', { r })}
                  </button>
                ))}
              </div>
            )}
            {(view === 'hour' || view === 'requests') && (
              <div className="daynav">
                <button className="btn" onClick={() => setDay(day - DAY)}>‹</button>
                <span className="daynav-cur">{dayLabel(day)}</span>
                <button className="btn" onClick={() => setDay(today)} disabled={day === today}>{t('common.today')}</button>
                <button className="btn" onClick={() => setDay(Math.min(today, day + DAY))} disabled={day >= today}>›</button>
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'subs' && <SubsView CLI={CLI} />}

      {view === 'requests' && (
        <RequestLog
          rows={requests.rows}
          count={requests.count}
          day={day}
          CLI={CLI}
        />
      )}

      {view === 'hour' && (
      <>
      <div className="tiles tiles-4">
        <Tile
          label={day === today ? t('rep.todaysTokens') : t('rep.tokens')}
          value={compact(daySummary.total)}
          title={num(daySummary.total)}
          sub={dayLabel(day)}
          primary
        />
        <Tile label={t('rep.estCost')} value={'$' + usd(daySummary.cost)} sub={t('rep.roughEstimate')} accent="#7ee0b8" />
        <Tile label={t('rep.turns')} value={daySummary.turns.toLocaleString()} sub={t('rep.modelResponses')} />
        <Tile label={t('rep.activeHours')} value={String(daySummary.activeHours)} sub={t('rep.withUsage')} />
      </div>

      <section className="card">
        <div className="card-head">
          <h3>{t('rep.byHourTitle', { label: dayLabel(day) })}</h3>
          {daySummary.peakHour && daySummary.peakHour.total > 0 && (
            <div className="card-badges">
              <span className="card-badge">
                {t('rep.peakHour')} <b>{daySummary.peakHour.label}:00</b> · <b>{compact(daySummary.peakHour.total)}</b>
              </span>
            </div>
          )}
        </div>
        <StackedBars
          data={hourData}
          xLabel={(h) => (h % 3 === 0 ? h + ':00' : '')}
          tipLabel={(h) => `${h}:00`}
          height={250}
          CLI={CLI}
          ORDER={ORDER}
        />
      </section>

      <Breakdown
        mode={dayBreakdown}
        setMode={setDayBreakdown}
        models={shownDayModels}
        projects={shownDayProjects}
        CLI={CLI}
        label={dayLabel(day)}
        allowProjects={isLocalDeviceView}
      />
      </>
      )}

      {view === 'charts' && (
      <>
      <div className="tiles tiles-5">
        <Tile
          label={t('rep.tokensRange')}
          value={compact(summary.total)}
          title={num(summary.total)}
          sub={fmtRange(fromMs, toMs)}
          primary
        />
        <Tile label={t('rep.estCost')} value={'$' + usd(summary.cost)} sub={t('rep.usageWorthEst')} accent="#7ee0b8" />
        <Tile
          label={t('rep.planFees')}
          value={'$' + usd(rangeFees)}
          sub={t('rep.subsBilledRange')}
          accent={FEE_COLOR}
        />
        <Tile label={t('rep.turns')} value={summary.turns.toLocaleString()} sub={t('rep.modelResponses')} />
        <Tile label={t('rep.activeDays')} value={String(summary.activeDays)} sub={t('rep.withUsage')} />
      </div>

      <section className="card">
        <div className="card-head">
          <h3>{t('rep.dailyTrend', { label: fmtRange(fromMs, toMs) })}</h3>
          {summary.activeDays > 0 && (
            <div className="card-badges">
              <span className="card-badge">
                {t('rep.dailyAvg')} <b>{compact(summary.dailyAvg)}</b>
              </span>
              {summary.peakDay && summary.peakDay.total > 0 && (
                <span className="card-badge">
                  {t('rep.peakDay')} <b>{compact(summary.peakDay.total)}</b> ({dayLabel(summary.peakDay.label)})
                </span>
              )}
            </div>
          )}
        </div>
        <StackedBars
          data={dayData}
          xLabel={(d, i) => (dayData.length <= 14 || i % Math.ceil(dayData.length / 12) === 0 ? dayLabel(d) : '')}
          tipLabel={(d) => dayLabel(d)}
          height={210}
          CLI={CLI}
          ORDER={ORDER}
        />
      </section>

      <Breakdown
        mode={breakdown}
        setMode={setBreakdown}
        models={shownModels}
        projects={shownProjects}
        CLI={CLI}
        label={fmtRange(fromMs, toMs)}
        plans={planBd}
        allowProjects={isLocalDeviceView}
      />
      </>
      )}

      <footer className="rep-foot">
        {t('rep.footer', { ver: __APP_VERSION__, built: __BUILD_TIME__, span: span.min ? t('rep.spanSince', { date: new Date(span.min).toLocaleDateString() }) : t('rep.spanEmpty') })}
      </footer>
    </div>
  )
}

function Tile({ label, value, title, sub, accent, primary }) {
  return (
    <div className={'tile' + (primary ? ' primary' : '')}>
      <div className="tile-label">{label}</div>
      <div className="tile-value" title={title || String(value)} style={accent ? { color: accent } : null}>{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  )
}

// By-plan / by-model / by-project token+cost breakdown, shared by the Charts
// and By-hour tabs. `plans` (subs:breakdown data) is only passed on the Charts
// tab — plan fees are monthly, so a per-day plan grouping isn't meaningful.
function Breakdown({ mode, setMode, models, projects, CLI, label, plans, allowProjects = true }) {
  const maxModel = Math.max(1, ...models.map((m) => m.total))
  const totalModelTokens = Math.max(1, models.reduce((a, m) => a + m.total, 0))
  const maxProject = Math.max(1, ...projects.map((p) => p.total))
  const totalProjectTokens = Math.max(1, projects.reduce((a, p) => a + p.total, 0))
  const countBadge =
    mode === 'model'
      ? t('rep.modelsCount', { n: models.length })
      : mode === 'project'
        ? t('rep.projectsCount', { n: projects.length })
        : null
  return (
    <section className="card">
      <div className="card-head">
        <div className="seg">
          {plans && <button className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>{t('rep.byPlan')}</button>}
          <button className={mode === 'model' ? 'on' : ''} onClick={() => setMode('model')}>{t('rep.byModel')}</button>
          {allowProjects && <button className={mode === 'project' ? 'on' : ''} onClick={() => setMode('project')}>{t('rep.byProject')}</button>}
        </div>
        <div className="card-badges">
          {countBadge && <span className="card-badge">{countBadge}</span>}
          <span className="card-sub">{label}</span>
        </div>
      </div>
      {mode === 'plan' && plans ? (
        <PlanBreakdown bd={plans} CLI={CLI} />
      ) : mode !== 'project' ? (
        <div className="models">
          {models.length === 0 ? (
            <div className="empty">{t('rep.noUsageRange')}</div>
          ) : (
            <>
              <div className="mrow mhead">
                <span />
                <span>{t('rep.modelCol')}</span>
                <span>{t('rep.shareCol')}</span>
                <span className="r">{t('rep.shareCol')}</span>
                <span className="r">{t('rep.tokensCol')}</span>
                <span className="r">{t('rep.estCost')}</span>
              </div>
              {models.map((m) => {
                const meta = metaFor(CLI, m.cli)
                const pct = (100 * m.total) / totalModelTokens
                return (
                  <div className="mrow" key={m.cli + m.model}>
                    <span className="dot" style={{ background: meta.color }} />
                    <div className="mname-wrap">
                      <span className="mname" title={m.model}>{m.model}</span>
                      <span className="mmeta">{meta.label} · {m.turns.toLocaleString()} {t('rep.turns')}</span>
                    </div>
                    <div className="mtrack"><div className="mfill" style={{ width: (100 * m.total) / maxModel + '%', background: meta.color }} /></div>
                    <span className="mpct">{pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%</span>
                    <span className="mtok" title={num(m.total)}>{compact(m.total)}</span>
                    <span className="mcost">${usd(m.cost)}</span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      ) : (
        <div className="models">
          {projects.length === 0 ? (
            <div className="empty">{t('rep.noUsageRange')}</div>
          ) : (
            <>
              <div className="mrow mhead">
                <span />
                <span>{t('rep.projectCol')}</span>
                <span>{t('rep.shareCol')}</span>
                <span className="r">{t('rep.shareCol')}</span>
                <span className="r">{t('rep.tokensCol')}</span>
                <span className="r">{t('rep.estCost')}</span>
              </div>
              {projects.slice(0, 15).map((p) => {
                const meta = metaFor(CLI, p.cli)
                const pct = (100 * p.total) / totalProjectTokens
                return (
                  <div className="mrow" key={p.cli + p.project}>
                    <span className="dot" style={{ background: meta.color }} />
                    <div className="mname-wrap">
                      <span className="mname" title={p.project}>{p.project}</span>
                      <span className="mmeta">{meta.label} · {p.turns.toLocaleString()} {t('rep.turns')}</span>
                    </div>
                    <div className="mtrack"><div className="mfill" style={{ width: (100 * p.total) / maxProject + '%', background: meta.color }} /></div>
                    <span className="mpct">{pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%</span>
                    <span className="mtok" title={num(p.total)}>{compact(p.total)}</span>
                    <span className="mcost">${usd(p.cost)}</span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </section>
  )
}

// Usage in the range grouped by the token plan that covers it. Per plan:
// actual fees billed in the range, usage worth, value % (worth ÷ fees), a
// share-of-total-worth bar, and the plan's models underneath. Records no plan
// covers land in a trailing "No plan" bucket, so the list always sums to the
// whole range.
function PlanBreakdown({ bd, CLI }) {
  const buckets = [...(bd.plans || [])].sort((a, b) => b.cost - a.cost)
  if (bd.unplanned && (bd.unplanned.cost > 0 || bd.unplanned.tokens > 0)) buckets.push(bd.unplanned)
  const shown = buckets.filter((b) => b.cost > 0 || b.tokens > 0 || b.fees > 0)
  if (shown.length === 0) return <div className="empty">{t('rep.noUsageAddPlans')}</div>
  const totalCost = Math.max(bd.totalCost, 1e-9)
  const maxModel = Math.max(1, ...shown.flatMap((b) => b.models.map((m) => m.total)))
  return (
    <div className="plans">
      {shown.map((b) => {
        const isPlan = b.id != null
        const color = isPlan ? metaFor(CLI, b.bindings?.[0]?.cli).color : '#5b6172'
        const share = Math.round((100 * b.cost) / totalCost)
        const val = isPlan && b.fees > 0 ? Math.round((100 * b.cost) / b.fees) : null
        const bucketTokens = Math.max(1, b.models.reduce((a, m) => a + m.total, 0))
        return (
          <div className="plan-block" key={b.id || 'unplanned'}>
            <div className="prow">
              <span className="dot" style={{ background: color }} />
              <span className="pname">
                {isPlan ? b.name : t('rep.noPlanPayg')}
                {isPlan && !b.active && <span className="muted small"> {t('rep.endedTag')}</span>}
              </span>
              <span className="pmeta">
                <b title={num(b.tokens || 0)}>{compact(b.tokens || 0)}</b> ·{' '}
                {isPlan && <>{t('rep.fees')} <b>${usd(b.fees)}</b> · </>}
                {t('rep.worth')} <b className="mcost">${usd(b.cost)}</b>
                {val != null && <> · {t('rep.value')} <b style={{ color: val >= 100 ? '#7ee0b8' : '#e0c97e' }}>{val}%</b></>}
                {isPlan && b.fees === 0 && b.monthlyUsd > 0 && <> · <span title={t('rep.noChargeTip')}>{t('rep.noChargeRange')}</span></>}
              </span>
              <div className="ptrack" title={t('rep.shareOfWorth', { share })}>
                <div className="pfill" style={{ width: share + '%', background: color }} />
              </div>
              <span className="pshare">{share}%</span>
            </div>
            <div className="models pmodels">
              {b.models.length === 0 && <div className="empty mini">{t('rep.noUsageRange')}</div>}
              {b.models.map((m) => {
                const meta = metaFor(CLI, m.cli)
                const pct = (100 * m.total) / bucketTokens
                return (
                  <div className="mrow" key={m.cli + m.model}>
                    <span className="dot sm" style={{ background: meta.color }} />
                    <div className="mname-wrap">
                      <span className="mname" title={m.model}>{m.model}</span>
                      <span className="mmeta">{meta.label} · {m.turns.toLocaleString()} {t('rep.turns')}</span>
                    </div>
                    <div className="mtrack"><div className="mfill" style={{ width: (100 * m.total) / maxModel + '%', background: meta.color }} /></div>
                    <span className="mpct">{pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%</span>
                    <span className="mtok" title={num(m.total)}>{compact(m.total)}</span>
                    <span className="mcost">${usd(m.cost)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Legend({ brands, onToggle, onReset, CLI, ORDER }) {
  const isFiltered = brands.size < ORDER.length
  return (
    <div className="legend">
      {isFiltered && onReset && (
        <button type="button" className="leg leg-reset" onClick={onReset}>
          {t('rep.resetFilter')} ({brands.size}/{ORDER.length})
        </button>
      )}
      {ORDER.map((c) => {
        const on = brands.has(c)
        const meta = metaFor(CLI, c)
        return (
          <button
            key={c}
            type="button"
            className={'leg' + (on ? '' : ' off')}
            onClick={() => onToggle(c)}
            title={on ? t('rep.clickHide', { label: meta.label }) : t('rep.clickShow', { label: meta.label })}
          >
            <span className="dot" style={{ background: meta.color }} />{meta.label}
          </button>
        )
      })}
    </div>
  )
}

// Subscription plans share the cycle window's all-history dashboard and data.
// These extra charts retain the report's calendar-month and timeline views.
// Chart series colors (fee = reference, worth = the point) — validated as a
// 2-slot categorical pair on the dark panel surface (CVD ΔE ≥ 52, ≥3:1
// contrast), distinct from every CLI brand color used elsewhere in the window.
const FEE_COLOR = '#6478cf'
const WORTH_COLOR = '#1fa87c'

function SubsView({ CLI }) {
  return <SubscriptionDashboard embedded renderOverviewExtra={(data) => <SubscriptionAnalysis stats={data.plans} CLI={CLI} />} />
}

// Preserve the report's existing time-window exploration below the shared
// all-cycle overview. Both use the same grouped purchase/ownership rules.
function SubscriptionAnalysis({ stats, CLI }) {
  const monthly = useMemo(() => {
    const map = new Map()
    for (const s of stats) for (const m of s.months || []) {
      const bucket = map.get(m.month) || { month: m.month, monthStart: m.monthStart, paid: 0, cost: 0 }
      bucket.paid += m.paid
      bucket.cost += m.cost
      map.set(m.month, bucket)
    }
    return [...map.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-12)
  }, [stats])
  return <details className="cd-extra-analysis">
    <summary>{t('cd.moreAnalysis')}</summary>
    <div className="cd-extra-content">
      <PlanTimeline CLI={CLI} />
      <PlanCompare stats={stats} />
      {monthly.length > 0 && <section className="card">
        <div className="card-head"><h3>{t('rep.feesVsWorthMonth')}</h3>
          <div className="legend" style={{ margin: 0 }}>
            <span className="leg"><span className="dot" style={{ background: FEE_COLOR }} />{t('rep.feePaid')}</span>
            <span className="leg"><span className="dot" style={{ background: WORTH_COLOR }} />{t('rep.usageWorthLegend')}</span>
          </div>
        </div>
        <PairedBars data={monthly} />
      </section>}
    </div>
  </details>
}

// Zoomable subscription timeline (stock-chart interaction: wheel = zoom around
// the cursor, drag = pan). Top: one Gantt lane per plan, one segment per
// billing cycle (alternating opacity marks cycle boundaries) labeled with its
// fee. Middle: stacked per-day token usage colored by owning plan. Bottom:
// the visible window's usage re-grouped by plan/model (reuses PlanBreakdown).
// Data is re-fetched (debounced) from subs:timeline whenever the window moves.
const TL_MIN_WINDOW = 2 * DAY

function PlanTimeline({ CLI }) {
  const [range, setRange] = useState(() => {
    const now = Date.now()
    return { t0: now - 90 * DAY, t1: now + DAY }
  })
  const [data, setData] = useState(null)
  const [dragging, setDragging] = useState(false)
  const wrapRef = useRef(null)
  const spanRef = useRef(null) // overall data span, for zoom/pan clamping
  const dragRef = useRef(null)
  const rangeRef = useRef(range)
  rangeRef.current = range

  const clampRange = (t0, t1) => {
    const span = spanRef.current
    if (!span) return { t0, t1 }
    const lo = span.min - 3 * DAY
    const hi = span.max + 3 * DAY
    const w = Math.min(Math.max(t1 - t0, TL_MIN_WINDOW), hi - lo)
    let a = t0
    if (a < lo) a = lo
    if (a + w > hi) a = hi - w
    return { t0: a, t1: a + w }
  }

  useEffect(() => {
    let dead = false
    const h = setTimeout(async () => {
      const d = await window.api.subsTimeline(range.t0, range.t1)
      if (!dead && d) {
        spanRef.current = d.span
        setData(d)
      }
    }, 120)
    return () => { dead = true; clearTimeout(h) }
  }, [range])
  useEffect(
    () =>
      window.api.onReportUpdated(async () => {
        const r = rangeRef.current
        const d = await window.api.subsTimeline(r.t0, r.t1)
        if (d) { spanRef.current = d.span; setData(d) }
      }),
    []
  )

  // ---- geometry ----
  const W = 920, padL = 120, padR = 12
  const laneH = 30, usageH = 140, axisH = 26, padT = 10, gap = 16
  const plans = data?.plans || []
  const lanesH = Math.max(1, plans.length) * laneH
  const H = padT + lanesH + gap + usageH + axisH
  const innerW = W - padL - padR
  const { t0, t1 } = range
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * innerW

  // client px -> chart time (svg scales with the card, so convert first)
  const toTime = (clientX) => {
    const rect = wrapRef.current.getBoundingClientRect()
    const xv = ((clientX - rect.left) / rect.width) * W
    const frac = Math.min(1, Math.max(0, (xv - padL) / innerW))
    return t0 + frac * (t1 - t0)
  }

  // wheel zoom must be a non-passive native listener (React's synthetic
  // onWheel is passive, so preventDefault would be ignored and the page
  // would scroll instead of zooming)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const r = rangeRef.current
      const anchor = (() => {
        const rect = el.getBoundingClientRect()
        const xv = ((e.clientX - rect.left) / rect.width) * W
        const frac = Math.min(1, Math.max(0, (xv - padL) / innerW))
        return r.t0 + frac * (r.t1 - r.t0)
      })()
      const k = e.deltaY > 0 ? 1.25 : 0.8
      const w = (r.t1 - r.t0) * k
      const frac = (anchor - r.t0) / (r.t1 - r.t0)
      setRange(clampRange(anchor - frac * w, anchor + (1 - frac) * w))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e) => {
    dragRef.current = { x: e.clientX, t0, t1 }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const rect = wrapRef.current.getBoundingClientRect()
    const dt = -(((e.clientX - d.x) / rect.width) * W / innerW) * (d.t1 - d.t0)
    setRange(clampRange(d.t0 + dt, d.t1 + dt))
  }
  const onPointerUp = () => { dragRef.current = null; setDragging(false) }

  const preset = (days) => {
    const now = Date.now()
    if (days == null) {
      const span = spanRef.current
      if (span) setRange(clampRange(span.min - DAY, span.max + DAY))
      return
    }
    setRange(clampRange(now - days * DAY, now + DAY))
  }

  // ---- derived drawing data ----
  const planColor = (p) => (p.id ? metaFor(CLI, p.bindings?.[0]?.cli).color : '#5b6172')
  const days = data?.days || []
  const stackOrder = [...plans.map((p) => p.id), 'un']
  const colorOf = Object.fromEntries(plans.map((p) => [p.id, planColor(p)]))
  colorOf.un = '#5b6172'
  const nameOf = Object.fromEntries(plans.map((p) => [p.id, p.name]))
  nameOf.un = t('rep.noPlan')
  const dayMax = Math.max(1, ...days.map((d) => Object.values(d.perPlan).reduce((a, s) => a + s.tokens, 0)))
  const usageY = padT + lanesH + gap
  const yTok = (v) => usageY + (usageH - 14) * (1 - v / dayMax) + 14
  const pxPerDay = (innerW * DAY) / (t1 - t0)
  const bw = Math.max(1, Math.min(pxPerDay - 1.5, 30))
  const ticks = timeTicks(t0, t1)
  const now = Date.now()

  const inViewFees = plans.reduce((a, p) => a + p.fees, 0)
  const rangeLabel = dayLabel(t0) + ' – ' + dayLabel(t1 - 1)

  return (
    <section className="card">
      <div className="card-head">
        <h3>{t('rep.subTimeline', { label: rangeLabel })}</h3>
        <div className="rep-actions">
          <span className="card-sub">{t('rep.wheelZoom')}</span>
          <div className="seg">
            <button onClick={() => preset(30)}>1M</button>
            <button onClick={() => preset(90)}>3M</button>
            <button onClick={() => preset(180)}>6M</button>
            <button onClick={() => preset(null)}>{t('common.all')}</button>
          </div>
        </div>
      </div>

      {data && plans.length === 0 && (
        <div className="empty">{t('rep.noPlansTimeline')}</div>
      )}

      <div
        ref={wrapRef}
        className={'tl-wrap' + (dragging ? ' dragging' : '')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg className="chart tl" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
          {/* vertical gridlines + x labels */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={padT} y2={usageY + usageH} className="grid" />
              <text x={x(t)} y={H - 7} className="xtick" textAnchor="middle">{dayLabel(t)}</text>
            </g>
          ))}

          {/* plan lanes: one segment per billing cycle */}
          {plans.map((p, i) => {
            const laneY = padT + i * laneH
            const color = planColor(p)
            return (
              <g key={p.id}>
                <text x={padL - 8} y={laneY + laneH / 2 + 5} className="tl-label" textAnchor="end">
                  {p.name.length > 15 ? p.name.slice(0, 14) + '…' : p.name}
                </text>
                <line x1={padL} x2={W - padR} y1={laneY + laneH - 2} y2={laneY + laneH - 2} className="grid" opacity="0.4" />
                {p.cycles.map((c, ci) => {
                  const sx = Math.max(x(c.start), padL)
                  const ex = Math.min(x(c.end), W - padR)
                  const w = ex - sx - 1
                  if (w <= 0) return null
                  const val = c.fee > 0 ? Math.round((100 * c.cost) / c.fee) : null
                  return (
                    <g key={(c.periodId || p.id) + ':' + c.start}>
                      <rect x={sx} y={laneY + 4} width={w} height={laneH - 9} rx="2.5" fill={color} opacity={ci % 2 ? 0.5 : 0.85}>
                        <title>
                          {p.name + '\n' + dayLabel(c.start) + ' – ' + dayLabel(c.end - 1) + '\n' + t('rep.feeWord') + ' $' + usd(c.fee) +
                            ' · ' + t('rep.usageWorthWord') + ' $' + usd(c.cost) + (val != null ? ' (' + val + '%)' : '') +
                            '\n' + compact(c.tokens) + ' ' + t('common.tokens')}
                        </title>
                      </rect>
                      {w > 52 && (
                        <text x={sx + w / 2} y={laneY + laneH / 2 + 4.5} className="tl-fee" textAnchor="middle">
                          ${usd(c.fee)}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            )
          })}

          {/* per-day stacked token usage, colored by owning plan */}
          {[dayMax, dayMax / 2].map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={yTok(v)} y2={yTok(v)} className="grid" />
              <text x={padL - 8} y={yTok(v) + 4} className="ytick" textAnchor="end">{compact(v)}</text>
            </g>
          ))}
          {days.map((d) => {
            const bx = x(d.day + DAY / 2) - bw / 2
            if (bx + bw < padL || bx > W - padR) return null
            let yCur = yTok(0)
            const total = Object.values(d.perPlan).reduce((a, s) => a + s.tokens, 0)
            const tip = dayLabel(d.day) + ' — ' + compact(total) + ' ' + t('common.tokens') + '\n' +
              stackOrder.filter((k) => d.perPlan[k]).map((k) => nameOf[k] + ': ' + compact(d.perPlan[k].tokens) + ' ($' + usd(d.perPlan[k].cost) + ')').join('\n')
            return (
              <g key={d.day}>
                {stackOrder.map((k) => {
                  const s = d.perPlan[k]
                  if (!s || s.tokens <= 0) return null
                  const h = (usageH - 14) * (s.tokens / dayMax)
                  yCur -= h
                  return <rect key={k} x={bx} y={yCur} width={bw} height={h} fill={colorOf[k]} rx="1" />
                })}
                <rect x={bx} y={yTok(total)} width={bw} height={Math.max(1, yTok(0) - yTok(total))} fill="transparent">
                  <title>{tip}</title>
                </rect>
              </g>
            )
          })}

          {/* today marker */}
          {now >= t0 && now <= t1 && (
            <line x1={x(now)} x2={x(now)} y1={padT} y2={usageY + usageH} className="tl-now" />
          )}
          <line x1={padL} x2={W - padR} y1={yTok(0)} y2={yTok(0)} className="grid" />
        </svg>
      </div>

      {data && (
        <>
          <div className="sub-totals" style={{ margin: '10px 0' }}>
            <span>{t('rep.inViewFees')} <b>${usd(inViewFees)}</b></span>
            <span>{t('rep.usageWorthInline')} <b className="mcost">${usd(data.totalCost)}</b></span>
            <span><b>{compact(plans.reduce((a, p) => a + p.tokens, 0) + (data.unplanned?.tokens || 0))}</b> {t('common.tokens')}</span>
          </div>
          <PlanBreakdown bd={data} CLI={CLI} />
        </>
      )}
    </section>
  )
}

// Adaptive day-aligned x-axis ticks for the timeline.
function timeTicks(t0, t1) {
  const w = t1 - t0
  const stepDays = w <= 8 * DAY ? 1 : w <= 20 * DAY ? 2 : w <= 45 * DAY ? 5 : w <= 100 * DAY ? 10 : w <= 240 * DAY ? 20 : 45
  const out = []
  const d = new Date(t0)
  d.setHours(0, 0, 0, 0)
  let t = d.getTime()
  while (t <= t1) {
    if (t >= t0) out.push(t)
    t += stepDays * DAY
  }
  return out
}

// Side-by-side plan comparison over all billed history: per plan, fees paid
// vs usage worth as horizontal bars on ONE shared USD scale, value %, token
// consumption on its own token scale, and the effective price actually paid
// per million tokens — the row set that answers "which plan is worth it".
function PlanCompare({ stats }) {
  const rows = stats
    .filter((s) => s.monthsBilled > 0 || s.totalTokens > 0)
    .sort((a, b) => b.totalCost - a.totalCost)
  if (rows.length === 0) return null
  const usdMax = Math.max(1e-9, ...rows.flatMap((s) => [s.totalPaid, s.totalCost]))
  const tokMax = Math.max(1, ...rows.map((s) => s.totalTokens))
  const hbar = (v, max, color, label, cls = '') =>
    (
      <div className="cmp-bar">
        <div className="cmp-track">
          {v > 0 && <div className="cmp-fill" style={{ width: (100 * v) / max + '%', background: color }} />}
        </div>
        <span className={'cmp-num ' + cls}>{label}</span>
      </div>
    )
  return (
    <section className="card">
      <div className="card-head">
        <h3>{t('rep.planComparison')}</h3>
        <div className="legend" style={{ margin: 0 }}>
          <span className="leg"><span className="dot" style={{ background: FEE_COLOR }} />{t('rep.feesPaid')}</span>
          <span className="leg"><span className="dot" style={{ background: WORTH_COLOR }} />{t('rep.usageWorthLegend')}</span>
        </div>
      </div>
      <div className="cmp-row cmp-head">
        <span>{t('rep.plan')}</span>
        <span>{t('rep.feesVsWorthUsd')}</span>
        <span className="cmp-r">{t('rep.valueLabel')}</span>
        <span>{t('rep.tokensCol')}</span>
        <span className="cmp-r" title={t('rep.paidPer1MTip')}>{t('rep.paidPer1M')}</span>
      </div>
      {rows.map((s) => {
        const val = s.totalPaid > 0 ? Math.round((100 * s.totalCost) / s.totalPaid) : null
        const unit = s.totalTokens > 0 && s.totalPaid > 0 ? s.totalPaid / (s.totalTokens / 1e6) : null
        return (
          <div className="cmp-row" key={s.id}>
            <span className="cmp-name" title={s.name + ' · ' + (s.purchaseCount > 1 ? t('set.purchaseCount', { n: s.purchaseCount }) : '$' + usd(s.monthlyUsd) + '/mo') + ' · ' + s.startDate}>
              {s.name}
              {!s.isCurrent && <span className="muted small"> {t('cd.noCurrent')}</span>}
            </span>
            <div className="cmp-bars">
              {hbar(s.totalPaid, usdMax, FEE_COLOR, '$' + usd(s.totalPaid))}
              {hbar(s.totalCost, usdMax, WORTH_COLOR, '$' + usd(s.totalCost), 'mcost')}
            </div>
            <span className="cmp-r" style={{ color: val != null && val >= 100 ? '#7ee0b8' : '#e0c97e' }}>
              {val != null ? val + '%' : '—'}
            </span>
            <div className="cmp-bar">
              <div className="cmp-track">
                {s.totalTokens > 0 && <div className="cmp-fill" style={{ width: (100 * s.totalTokens) / tokMax + '%', background: '#8b90a0' }} />}
              </div>
              <span className="cmp-num">{compact(s.totalTokens)}</span>
            </div>
            <span className="cmp-r muted">{unit != null ? '$' + (unit < 0.01 ? unit.toFixed(4) : unit.toFixed(2)) : '—'}</span>
          </div>
        )
      })}
    </section>
  )
}

// Paired vertical bars per calendar month: fee paid (reference, blue) next to
// usage worth (the point, green). Same unit (USD) → one shared axis. Each bar
// carries a native <title> tooltip; the newest month is direct-labeled.
function PairedBars({ data, height = 220 }) {
  const W = 920, H = height
  const padL = 54, padR = 14, padT = 20, padB = 28
  const innerW = W - padL - padR, innerH = H - padT - padB
  const max = Math.max(1, ...data.map((d) => Math.max(d.paid, d.cost)))
  const ticks = niceTicks(max, 4)
  const top = ticks[ticks.length - 1]
  const n = data.length || 1
  const slot = innerW / n
  const bw = Math.max(3, Math.min(slot * 0.3, 26))
  const y = (v) => padT + innerH * (1 - v / top)
  const monthName = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short' })
  const monthFull = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  const xLabel = (d) => (new Date(d.monthStart).getMonth() === 0 ? monthName(d.monthStart) + ' ' + new Date(d.monthStart).getFullYear() : monthName(d.monthStart))

  const bar = (x, v, fill, label) => {
    if (v <= 0) return null
    const h = Math.max(1.5, (innerH * v) / top)
    return (
      <rect x={x} y={y(0) - h} width={bw} height={h} fill={fill} rx="2">
        <title>{label}</title>
      </rect>
    )
  }

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="grid" />
          <text x={padL - 8} y={y(t) + 4} className="ytick" textAnchor="end">${compactUsd(t)}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + slot * i + slot / 2
        const isLast = i === data.length - 1
        const mf = monthFull(d.monthStart)
        const ratio = d.paid > 0 ? Math.round((100 * d.cost) / d.paid) + '%' : '—'
        return (
          <g key={d.month}>
            {bar(cx - bw - 1, d.paid, FEE_COLOR, `${mf} — ${t('rep.feesPaidWord')} $${usd(d.paid)}`)}
            {bar(cx + 1, d.cost, WORTH_COLOR, `${mf} — ${t('rep.usageWorthWord')} $${usd(d.cost)} (${ratio} ${t('rep.ofFees')})`)}
            {isLast && d.paid > 0 && (
              <text x={cx} y={y(Math.max(d.paid, d.cost)) - 6} className="blabel" textAnchor="middle">{ratio}</text>
            )}
            <text x={cx} y={H - 9} className="xtick" textAnchor="middle">{xLabel(d)}</text>
          </g>
        )
      })}
      <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="grid" />
    </svg>
  )
}

// Per-request log table for a single local day, optionally filtered by CLI.
function RequestLog({ rows, count, day, CLI }) {
  const totals = useMemo(() => {
    let total = 0, noCache = 0, cost = 0
    for (const r of rows) { total += r.total; noCache += r.total - r.cacheRead; cost += r.cost }
    return { total, noCache, cost }
  }, [rows])

  return (
    <>
      <div className="tiles tiles-4">
        <Tile
          label={t('rep.logsTitle', { label: dayLabel(day) })}
          value={count.toLocaleString()}
          sub={count === 1 ? t('rep.request') : t('rep.requestsWord')}
          primary
        />
        <Tile
          label={t('rep.total')}
          value={compact(totals.total)}
          title={num(totals.total)}
          sub={t('common.tokens')}
        />
        <Tile
          label={t('rep.totalMinusR')}
          value={compact(totals.noCache)}
          title={num(totals.noCache)}
          sub={t('rep.totalMinusRTip')}
          accent="#e0c97e"
        />
        <Tile
          label={t('rep.estCost')}
          value={'$' + usd(totals.cost)}
          sub={t('rep.roughEstimate')}
          accent="#7ee0b8"
        />
      </div>

      <section className="card">
        <div className="card-head">
          <h3>{t('rep.logsTitle', { label: dayLabel(day) })}</h3>
          <div className="reqsum" style={{ margin: 0 }}>
            {t('rep.requests', { count: count.toLocaleString(), unit: count === 1 ? t('rep.request') : t('rep.requestsWord'), tokens: compact(totals.total), noCache: compact(totals.noCache), cost: '$' + usd(totals.cost) })}
            {rows.length < count && <span className="reqclip"> {t('rep.showingFirst', { n: rows.length.toLocaleString() })}</span>}
          </div>
        </div>

        <div className="reqwrap">
          <table className="reqtable">
            <thead>
              <tr>
                <th>{t('rep.time')}</th>
                <th>{t('rep.provider')}</th>
                <th>{t('rep.modelCol')}</th>
                <th>{t('rep.session')}</th>
                <th className="r">{t('rep.input')}</th>
                <th className="r">{t('rep.output')}</th>
                <th className="r">{t('rep.total')}</th>
                <th className="r" title={t('rep.totalMinusRTip')}>{t('rep.totalMinusR')}</th>
                <th className="r">{t('rep.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={9} className="empty">{t('rep.noRequestsDay')}</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{timeLabel(r.ts)}</td>
                  <td><span className="dot" style={{ background: metaFor(CLI, r.cli).color }} /> {metaFor(CLI, r.cli).label}</td>
                  <td className="mono" title={r.model}>{r.model}</td>
                  <td className="sess" title={(r.project || '') + ' · ' + (r.sessionId || '')}>
                    {r.project || (r.sessionId ? r.sessionId.slice(0, 8) : '—')}
                  </td>
                  <td className="r" title={num(r.input)}>
                    {compact(r.input)}
                    {(r.cacheRead > 0 || r.cacheCreate > 0) && (
                      <div className="rwsub">R{compact(r.cacheRead)}·W{compact(r.cacheCreate)}</div>
                    )}
                  </td>
                  <td className="r" title={num(r.output)}>{compact(r.output)}</td>
                  <td className="r tot" title={num(r.total)}>{compact(r.total)}</td>
                  <td className="r nocache" title={num(r.total - r.cacheRead)}>{compact(r.total - r.cacheRead)}</td>
                  <td className="r cost">${usd4(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

// Stacked vertical bar chart (SVG). data: [{label, segs:{cli:val}, total}].
function StackedBars({ data, xLabel = () => '', tipLabel = (l) => String(l), height = 210, CLI, ORDER }) {
  const W = 920, H = height
  const padL = 64, padR = 14, padT = 14, padB = 28
  const innerW = W - padL - padR, innerH = H - padT - padB
  const max = Math.max(1, ...data.map((d) => d.total))
  const ticks = niceTicks(max, 4)
  const top = ticks[ticks.length - 1]
  const n = data.length || 1
  const slot = innerW / n
  const bw = Math.max(2, Math.min(slot * 0.68, 42))
  const y = (v) => padT + innerH * (1 - v / top)

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="grid" />
          <text x={padL - 8} y={y(t) + 4} className="ytick" textAnchor="end">{compact(t)}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + slot * i + slot / 2
        let yCursor = y(0)
        const activeClis = ORDER.filter((cli) => (d.segs[cli] || 0) > 0)
        const tip = d.total > 0
          ? `${tipLabel(d.label, i)} — ${compact(d.total)} (${num(d.total)})\n` +
            activeClis.map((cli) => `${metaFor(CLI, cli).label}: ${compact(d.segs[cli])}`).join('\n')
          : null
        return (
          <g key={i}>
            {ORDER.map((cli) => {
              const v = d.segs[cli] || 0
              if (v <= 0) return null
              const h = (innerH * v) / top
              yCursor -= h
              return <rect key={cli} x={cx - bw / 2} y={yCursor} width={bw} height={h} fill={metaFor(CLI, cli).color} rx="1.5" />
            })}
            {tip && (
              <rect x={cx - slot / 2} y={padT} width={slot} height={innerH} fill="transparent">
                <title>{tip}</title>
              </rect>
            )}
            <text x={cx} y={H - 9} className="xtick" textAnchor="middle">{xLabel(d.label, i)}</text>
          </g>
        )
      })}
    </svg>
  )
}

function niceTicks(max, count) {
  const step = niceNum(max / count, true)
  const niceMax = Math.ceil(max / step) * step
  const out = []
  for (let v = 0; v <= niceMax + 1e-9; v += step) out.push(v)
  return out
}
function niceNum(x, round) {
  const exp = Math.floor(Math.log10(x))
  const f = x / Math.pow(10, exp)
  let nf
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return nf * Math.pow(10, exp)
}
function fmtRange(fromMs, toMs) {
  return dayLabel(fromMs) + ' – ' + dayLabel(toMs - DAY)
}
