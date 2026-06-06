import React, { useEffect, useMemo, useState } from 'react'

const CLI = {
  claude: { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'Codex', color: '#10a37f' },
  gemini: { label: 'Gemini', color: '#4285f4' },
}
const ORDER = ['claude', 'codex', 'gemini']

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
const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export default function Report() {
  const [range, setRange] = useState('30d') // 7d | 30d | all
  const [day, setDay] = useState(floorDay(Date.now()))
  const [span, setSpan] = useState({ min: null, max: null })
  const [hourly, setHourly] = useState([])
  const [daily, setDaily] = useState([])
  const [models, setModels] = useState([])
  const [exporting, setExporting] = useState(false)

  const today = floorDay(Date.now())
  const { fromMs, toMs } = useMemo(() => {
    const to = today + DAY
    if (range === '7d') return { fromMs: today - 6 * DAY, toMs: to }
    if (range === '30d') return { fromMs: today - 29 * DAY, toMs: to }
    return { fromMs: span.min != null ? floorDay(span.min) : 0, toMs: to }
  }, [range, span.min, today])

  async function load() {
    const [sp, h, d, m] = await Promise.all([
      window.api.reportSpan(),
      window.api.reportHourly(day),
      window.api.reportDaily(fromMs, toMs),
      window.api.reportModels(fromMs, toMs),
    ])
    setSpan(sp)
    setHourly(h)
    setDaily(d)
    setModels(m)
  }

  useEffect(() => { load() }, [day, fromMs, toMs])
  useEffect(() => window.api.onReportUpdated(() => load()), [day, fromMs, toMs])

  // ---- shape data for charts ----
  const hourData = useMemo(() => {
    const arr = Array.from({ length: 24 }, (_, h) => ({ label: h, segs: { claude: 0, codex: 0, gemini: 0 }, total: 0 }))
    for (const r of hourly) {
      const h = new Date(r.hour).getHours()
      arr[h].segs[r.cli] = (arr[h].segs[r.cli] || 0) + r.total
      arr[h].total += r.total
    }
    return arr
  }, [hourly])

  const dayData = useMemo(() => {
    const map = new Map()
    for (let t = fromMs; t < toMs; t += DAY) map.set(floorDay(t), { label: floorDay(t), segs: { claude: 0, codex: 0, gemini: 0 }, total: 0 })
    for (const r of daily) {
      const k = floorDay(r.day)
      const b = map.get(k)
      if (!b) continue
      b.segs[r.cli] = (b.segs[r.cli] || 0) + r.total
      b.total += r.total
    }
    return [...map.values()].sort((a, b) => a.label - b.label)
  }, [daily, fromMs, toMs])

  const summary = useMemo(() => {
    let total = 0, cost = 0, turns = 0
    for (const m of models) { total += m.total; cost += m.cost; turns += m.turns }
    const activeDays = dayData.filter((d) => d.total > 0).length
    return { total, cost, turns, activeDays }
  }, [models, dayData])

  const maxModel = Math.max(1, ...models.map((m) => m.total))

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
            {['7d', '30d', 'all'].map((r) => (
              <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
                {r === 'all' ? 'All' : 'Last ' + r.replace('d', 'd')}
              </button>
            ))}
          </div>
          <button className="btn primary" disabled={exporting} onClick={doExport}>
            {exporting ? 'Exporting…' : '⤓ Export PNG'}
          </button>
        </div>
      </header>

      <div className="tiles">
        <Tile label="Tokens (range)" value={compact(summary.total)} sub={fmtRange(fromMs, toMs)} />
        <Tile label="Est. cost" value={usd(summary.cost)} sub="rough estimate" accent="#7ee0b8" />
        <Tile label="Turns" value={summary.turns.toLocaleString()} sub="model responses" />
        <Tile label="Active days" value={String(summary.activeDays)} sub="with usage" />
      </div>

      <Legend />

      <section className="card">
        <div className="card-head">
          <h3>By hour — {dayLabel(day)}</h3>
          <div className="daynav">
            <button className="btn" onClick={() => setDay(day - DAY)}>‹</button>
            <button className="btn" onClick={() => setDay(today)} disabled={day === today}>Today</button>
            <button className="btn" onClick={() => setDay(Math.min(today, day + DAY))} disabled={day >= today}>›</button>
          </div>
        </div>
        <StackedBars data={hourData} xLabel={(h) => (h % 3 === 0 ? h + ':00' : '')} height={210} />
      </section>

      <section className="card">
        <div className="card-head"><h3>Daily trend — {fmtRange(fromMs, toMs)}</h3></div>
        <StackedBars
          data={dayData}
          xLabel={(d, i) => (dayData.length <= 14 || i % Math.ceil(dayData.length / 12) === 0 ? dayLabel(d) : '')}
          height={210}
        />
      </section>

      <section className="card">
        <div className="card-head"><h3>By model</h3></div>
        <div className="models">
          {models.length === 0 && <div className="empty">No usage in this range.</div>}
          {models.slice(0, 12).map((m) => (
            <div className="mrow" key={m.cli + m.model}>
              <span className="dot" style={{ background: CLI[m.cli]?.color }} />
              <span className="mname" title={m.model}>{m.model}</span>
              <div className="mtrack"><div className="mfill" style={{ width: (100 * m.total) / maxModel + '%', background: CLI[m.cli]?.color }} /></div>
              <span className="mtok">{compact(m.total)}</span>
              <span className="mcost">{usd(m.cost)}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="rep-foot">
        SQLite · {span.min ? 'data since ' + new Date(span.min).toLocaleDateString() : 'no data yet'} · ~/.tokenstatus/usage.sqlite
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

function Legend() {
  return (
    <div className="legend">
      {ORDER.map((c) => (
        <span key={c} className="leg"><span className="dot" style={{ background: CLI[c].color }} />{CLI[c].label}</span>
      ))}
    </div>
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
