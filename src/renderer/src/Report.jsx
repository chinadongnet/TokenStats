import React, { useEffect, useMemo, useState } from 'react'

const CLI = {
  claude: { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'Codex', color: '#10a37f' },
  gemini: { label: 'Gemini', color: '#4285f4' },
  agy: { label: 'Antigravity', color: '#a142f4' },
}
const ORDER = ['claude', 'codex', 'gemini', 'agy']

const DAY = 86400000
const floorDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
const compact = (n) => {
  n = Number(n) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const usd = (n) => '$' + (Number(n) || 0).toFixed(2)
const usd4 = (n) => '$' + (Number(n) || 0).toFixed(4)
const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const num = (n) => (Number(n) || 0).toLocaleString()
const timeLabel = (ms) => {
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function Report() {
  const [view, setView] = useState('charts') // charts | hour | requests
  const [breakdown, setBreakdown] = useState('model') // model | project
  const [range, setRange] = useState('30d') // 7d | 30d | all
  const [brands, setBrands] = useState(() => new Set(ORDER)) // active CLIs
  const [day, setDay] = useState(floorDay(Date.now()))
  const [span, setSpan] = useState({ min: null, max: null })
  const [hourly, setHourly] = useState([])
  const [daily, setDaily] = useState([])
  const [models, setModels] = useState([])
  const [projects, setProjects] = useState([])
  const [reqCli, setReqCli] = useState('all') // 'all' | cli
  const [requests, setRequests] = useState({ rows: [], count: 0 })
  const [exporting, setExporting] = useState(false)

  const today = floorDay(Date.now())
  const { fromMs, toMs } = useMemo(() => {
    const to = today + DAY
    if (range === '7d') return { fromMs: today - 6 * DAY, toMs: to }
    if (range === '30d') return { fromMs: today - 29 * DAY, toMs: to }
    return { fromMs: span.min != null ? floorDay(span.min) : 0, toMs: to }
  }, [range, span.min, today])

  async function load() {
    const [sp, h, d, m, p] = await Promise.all([
      window.api.reportSpan(),
      window.api.reportHourly(day),
      window.api.reportDaily(fromMs, toMs),
      window.api.reportModels(fromMs, toMs),
      window.api.reportProjects(fromMs, toMs),
    ])
    setSpan(sp)
    setHourly(h)
    setDaily(d)
    setModels(m)
    setProjects(p)
  }

  useEffect(() => { load() }, [day, fromMs, toMs])
  useEffect(() => window.api.onReportUpdated(() => load()), [day, fromMs, toMs])

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
    const arr = Array.from({ length: 24 }, (_, h) => ({ label: h, segs: { claude: 0, codex: 0, gemini: 0, agy: 0 }, total: 0 }))
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
    for (let t = fromMs; t < toMs; t += DAY) map.set(floorDay(t), { label: floorDay(t), segs: { claude: 0, codex: 0, gemini: 0, agy: 0 }, total: 0 })
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
    return { total, cost, turns, activeDays }
  }, [shownModels, dayData])

  const maxModel = Math.max(1, ...shownModels.map((m) => m.total))

  const shownProjects = useMemo(() => projects.filter((p) => brands.has(p.cli)), [projects, brands])
  const maxProject = Math.max(1, ...shownProjects.map((p) => p.total))

  async function doExport() {
    setExporting(true)
    try { await window.api.exportPng() } finally { setExporting(false) }
  }

  return (
    <div className="report">
      <header className="rep-head">
        <div className="rep-title"><span className="logo" /> Usage Report</div>
        <div className="rep-actions">
          <div className="seg">
            <button className={view === 'charts' ? 'on' : ''} onClick={() => setView('charts')}>Charts</button>
            <button className={view === 'hour' ? 'on' : ''} onClick={() => setView('hour')}>By hour</button>
            <button className={view === 'requests' ? 'on' : ''} onClick={() => setView('requests')}>Request log</button>
          </div>
          {view === 'charts' && (
            <div className="seg">
              {['7d', '30d', 'all'].map((r) => (
                <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
                  {r === 'all' ? 'All' : 'Last ' + r.replace('d', 'd')}
                </button>
              ))}
            </div>
          )}
          <button className="btn primary" disabled={exporting} onClick={doExport}>
            {exporting ? 'Exporting…' : '⤓ Export PNG'}
          </button>
        </div>
      </header>

      {view === 'requests' && (
        <RequestLog
          rows={requests.rows}
          count={requests.count}
          day={day}
          today={today}
          setDay={setDay}
          reqCli={reqCli}
          setReqCli={setReqCli}
        />
      )}

      {view === 'hour' && (
      <>
      <Legend brands={brands} onToggle={toggleBrand} />
      <section className="card">
        <div className="card-head">
          <h3>By hour — {dayLabel(day)}</h3>
          <div className="daynav">
            <button className="btn" onClick={() => setDay(day - DAY)}>‹</button>
            <button className="btn" onClick={() => setDay(today)} disabled={day === today}>Today</button>
            <button className="btn" onClick={() => setDay(Math.min(today, day + DAY))} disabled={day >= today}>›</button>
          </div>
        </div>
        <StackedBars data={hourData} xLabel={(h) => (h % 3 === 0 ? h + ':00' : '')} height={260} />
      </section>
      </>
      )}

      {view === 'charts' && (
      <>
      <div className="tiles">
        <Tile label="Tokens (range)" value={compact(summary.total)} sub={fmtRange(fromMs, toMs)} />
        <Tile label="Est. cost" value={usd(summary.cost)} sub="rough estimate" accent="#7ee0b8" />
        <Tile label="Turns" value={summary.turns.toLocaleString()} sub="model responses" />
        <Tile label="Active days" value={String(summary.activeDays)} sub="with usage" />
      </div>

      <Legend brands={brands} onToggle={toggleBrand} />

      <section className="card">
        <div className="card-head"><h3>Daily trend — {fmtRange(fromMs, toMs)}</h3></div>
        <StackedBars
          data={dayData}
          xLabel={(d, i) => (dayData.length <= 14 || i % Math.ceil(dayData.length / 12) === 0 ? dayLabel(d) : '')}
          height={210}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <div className="seg">
            <button className={breakdown === 'model' ? 'on' : ''} onClick={() => setBreakdown('model')}>By model</button>
            <button className={breakdown === 'project' ? 'on' : ''} onClick={() => setBreakdown('project')}>By project</button>
          </div>
          <span className="card-sub">{fmtRange(fromMs, toMs)}</span>
        </div>
        {breakdown === 'model' ? (
          <div className="models">
            {shownModels.length === 0 && <div className="empty">No usage in this range.</div>}
            {shownModels.slice(0, 15).map((m) => (
              <div className="mrow" key={m.cli + m.model}>
                <span className="dot" style={{ background: CLI[m.cli]?.color }} />
                <span className="mname" title={m.model}>{m.model}</span>
                <div className="mtrack"><div className="mfill" style={{ width: (100 * m.total) / maxModel + '%', background: CLI[m.cli]?.color }} /></div>
                <span className="mtok">{compact(m.total)}</span>
                <span className="mcost">{usd(m.cost)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="models">
            {shownProjects.length === 0 && <div className="empty">No usage in this range.</div>}
            {shownProjects.slice(0, 15).map((p) => (
              <div className="mrow" key={p.cli + p.project}>
                <span className="dot" style={{ background: CLI[p.cli]?.color }} />
                <span className="mname" title={p.project + ' · ' + (CLI[p.cli]?.label || p.cli) + ' · ' + p.turns + ' turns'}>{p.project}</span>
                <div className="mtrack"><div className="mfill" style={{ width: (100 * p.total) / maxProject + '%', background: CLI[p.cli]?.color }} /></div>
                <span className="mtok">{compact(p.total)}</span>
                <span className="mcost">{usd(p.cost)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      </>
      )}

      <footer className="rep-foot">
        TokenStatus v{__APP_VERSION__} · built {__BUILD_TIME__} · SQLite {span.min ? 'since ' + new Date(span.min).toLocaleDateString() : '(empty)'} · ~/.tokenstatus/usage.sqlite
      </footer>
    </div>
  )
}

function Tile({ label, value, sub, accent }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value" style={accent ? { color: accent } : null}>{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  )
}

function Legend({ brands, onToggle }) {
  return (
    <div className="legend">
      {ORDER.map((c) => {
        const on = brands.has(c)
        return (
          <button
            key={c}
            type="button"
            className={'leg' + (on ? '' : ' off')}
            onClick={() => onToggle(c)}
            title={on ? 'Click to hide ' + CLI[c].label : 'Click to show ' + CLI[c].label}
          >
            <span className="dot" style={{ background: CLI[c].color }} />{CLI[c].label}
          </button>
        )
      })}
    </div>
  )
}

// Per-request log table for a single local day, optionally filtered by CLI.
function RequestLog({ rows, count, day, today, setDay, reqCli, setReqCli }) {
  const DAY = 86400000
  const totals = useMemo(() => {
    let total = 0, noCache = 0, cost = 0
    for (const r of rows) { total += r.total; noCache += r.total - r.cacheRead; cost += r.cost }
    return { total, noCache, cost }
  }, [rows])

  return (
    <section className="card">
      <div className="card-head">
        <h3>Request log — {dayLabel(day)}</h3>
        <div className="rep-actions">
          <select className="sel" value={reqCli} onChange={(e) => setReqCli(e.target.value)}>
            <option value="all">All providers</option>
            {ORDER.map((c) => <option key={c} value={c}>{CLI[c].label}</option>)}
          </select>
          <div className="daynav">
            <button className="btn" onClick={() => setDay(day - DAY)}>‹</button>
            <button className="btn" onClick={() => setDay(today)} disabled={day === today}>Today</button>
            <button className="btn" onClick={() => setDay(Math.min(today, day + DAY))} disabled={day >= today}>›</button>
          </div>
        </div>
      </div>

      <div className="reqsum">
        {count.toLocaleString()} request{count === 1 ? '' : 's'} · {compact(totals.total)} tokens · {compact(totals.noCache)} excl. cache read · {usd(totals.cost)}
        {rows.length < count && <span className="reqclip"> (showing first {rows.length.toLocaleString()})</span>}
      </div>

      <div className="reqwrap">
        <table className="reqtable">
          <thead>
            <tr>
              <th>Time</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Session</th>
              <th className="r">Input</th>
              <th className="r">Output</th>
              <th className="r">Total</th>
              <th className="r" title="Total minus cache-read tokens — closer to how CC Switch counts">Total −R</th>
              <th className="r">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} className="empty">No requests on this day.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="mono">{timeLabel(r.ts)}</td>
                <td><span className="dot" style={{ background: CLI[r.cli]?.color }} /> {CLI[r.cli]?.label || r.cli}</td>
                <td className="mono" title={r.model}>{r.model}</td>
                <td className="sess" title={(r.project || '') + ' · ' + (r.sessionId || '')}>
                  {r.project || (r.sessionId ? r.sessionId.slice(0, 8) : '—')}
                </td>
                <td className="r">
                  {num(r.input)}
                  {(r.cacheRead > 0 || r.cacheCreate > 0) && (
                    <div className="rwsub">R{compact(r.cacheRead)}·W{compact(r.cacheCreate)}</div>
                  )}
                </td>
                <td className="r">{num(r.output)}</td>
                <td className="r tot">{num(r.total)}</td>
                <td className="r nocache">{num(r.total - r.cacheRead)}</td>
                <td className="r cost">{usd4(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// Stacked vertical bar chart (SVG). data: [{label, segs:{cli:val}, total}].
function StackedBars({ data, xLabel = () => '', height = 210 }) {
  const W = 920, H = height
  const padL = 54, padR = 14, padT = 12, padB = 28
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
        return (
          <g key={i}>
            {ORDER.map((cli) => {
              const v = d.segs[cli] || 0
              if (v <= 0) return null
              const h = (innerH * v) / top
              yCursor -= h
              return <rect key={cli} x={cx - bw / 2} y={yCursor} width={bw} height={h} fill={CLI[cli].color} rx="1.5" />
            })}
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
