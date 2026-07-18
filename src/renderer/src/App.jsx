import React, { useEffect, useMemo, useState } from 'react'

// The 5 fixed built-in CLIs. LiteLLM providers are NOT listed here — they're
// dynamic, DB-backed entries (`litellm:<providerId>`) merged in at render time
// from the snapshot's `providers` field (see the useMemo below), so N of them
// can appear alongside these 5 without any code change per provider.
const FIXED_CLI = {
  claude: { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'Codex', color: '#10a37f' },
  gemini: { label: 'Gemini', color: '#4285f4' },
  agy: { label: 'Antigravity', color: '#a142f4' },
  cursor: { label: 'Cursor', color: '#6366f1' },
}
const FIXED_ORDER = ['claude', 'codex', 'gemini', 'agy', 'cursor']
// Cheap insurance for the rare case a snapshot references a provider that was
// just deleted (stale-by-one-tick), so a lookup never renders `undefined`.
const FALLBACK_META = (id) => ({ label: id.startsWith('litellm:') ? '(deleted provider)' : id, color: '#5b6172' })

const compact = (n) => {
  if (!n) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const usd = (n) => (n || 0).toFixed(2)
// Mirrors core/subscriptions.js's RESET_PERIODS (renderer can't import from main).
const RESET_LABEL = { '5h': '5h', weekly: 'wk', monthly: 'mo' }
const RESET_FULL = { '5h': '5-hour', weekly: 'weekly', monthly: 'monthly' }
// The billing-renewal ring is money, not tokens, so it gets the report's fee
// color rather than the plan's brand color — the two clocks are unrelated and
// shouldn't read as the same thing.
const FEE_COLOR = '#6478cf'
// Coarse duration for the reset countdown — minute granularity is plenty, and
// it keeps the label from jittering on every tick.
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return m ? `${m}m` : '<1m'
}
// Wall-clock time the window resets at; weekly windows need the date too.
const atTime = (ts, periodMs) => {
  const d = new Date(ts)
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return periodMs >= 86400000 ? `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}` : t
}

const ago = (ts) => {
  if (!ts) return ''
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}

// Trim a model id to something legible in a tight legend.
function shortModel(m) {
  let s = String(m || '')
    .replace(/\s*\([^)]*\)\s*$/, '') // drop trailing "(High)" etc.
    .replace(/^claude-/, '')
    .replace(/^cursor-/, '')
    .replace(/-(thinking|high|low|xhigh|fast)(-|$).*/i, '')
  return s.trim() || 'model'
}

// Tints of a hex color from the base (i=0) toward white, to shade the stacked
// model segments within one plan's own color.
function tints(hex, n) {
  const h = String(hex).replace('#', '')
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return Array.from({ length: n }, (_, i) => {
    const t = n <= 1 ? 0 : (i / (n - 1)) * 0.58
    return '#' + rgb.map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0')).join('')
  })
}

const WEEK_MS = 7 * 86400000
const ClockIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)
const BillIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18" />
  </svg>
)

// The plan's live quota — the card's centerpiece. Per window: a bold usage-
// remaining ratio (流量, colored by headroom) on a wide bar, and the NEXT reset
// cycle (clock). Billing renewal is a slim sub-row. Cells render straight into
// the grid so the columns line up across windows.
function QuotaBig({ plan, now }) {
  const cells = []
  for (const w of plan.windows) {
    const live = w.source === 'live'
    const open = live ? w.end == null || w.end > now : w.open && w.end > now
    const left = w.end ? Math.max(0, w.end - now) : 0
    const frac = live
      ? Math.min(1, Math.max(0, (w.remainingPercent || 0) / 100))
      : open
        ? Math.min(1, Math.max(0, left / w.periodMs))
        : 0
    const pct = Math.round(frac * 100)
    const fill = !live ? 'var(--faint)' : pct > 50 ? 'var(--ok)' : pct > 20 ? 'var(--warn)' : 'var(--crit)'
    const next = w.end ? (w.periodMs >= WEEK_MS ? atTime(w.end, w.periodMs) : dur(left)) : '—'
    const title = live
      ? `${RESET_FULL[w.period] || w.period} quota (live) · ${Math.round(w.usedPercent)}% used — ${pct}% left` +
        (w.end ? `\nnext cycle ${atTime(w.end, w.periodMs)} (${dur(left)})` : '')
      : `${RESET_FULL[w.period] || w.period} quota (estimate)` + (w.end ? `\nnext cycle ${atTime(w.end, w.periodMs)} (${dur(left)})` : '')
    cells.push(
      <React.Fragment key={w.period}>
        <span className="qwk">{RESET_LABEL[w.period] || w.period}</span>
        <span className="qbar" title={title}>
          <i style={{ width: `${Math.max(3, pct)}%`, background: fill }} />
        </span>
        <span className="qnum">
          {live ? <b>{pct}%</b> : <span className="qk">est</span>}
          <span className="qlab">left</span>
        </span>
        <span className="qnext" title={title}>
          <ClockIcon />
          <b>{next}</b>
        </span>
      </React.Fragment>
    )
  }
  if (plan.renewal && plan.monthlyUsd > 0) {
    const away = Math.max(0, plan.renewal.end - now)
    cells.push(
      <React.Fragment key="bill">
        <span className="qwk bill">bill</span>
        <span className="qbar" title={`Renewal · $${usd(plan.monthlyUsd)} bills ${atTime(plan.renewal.end, plan.renewal.periodMs)} (${dur(away)})`}>
          <i style={{ width: `${Math.round(100 * (away / plan.renewal.periodMs))}%`, background: FEE_COLOR }} />
        </span>
        <span className="qnum billamt">${usd(plan.monthlyUsd)}</span>
        <span className="qnext">
          <BillIcon />
          <b>{dur(away)}</b>
        </span>
      </React.Fragment>
    )
  }
  return <div className="qb">{cells}</div>
}

// One plan's models as a segmented bar (widths ∝ tokens, shaded in the plan's
// color) plus a compact legend — the current-period breakdown, grouped in place.
function ModelBar({ models, color }) {
  const total = models.reduce((a, m) => a + (m.total || 0), 0) || 1
  const cols = tints(color, models.length)
  return (
    <div className="models">
      <div className="segbar">
        {models.map((m, i) => (
          <span key={m.cli + m.model} style={{ width: `${(100 * (m.total || 0)) / total}%`, background: cols[i] }} title={`${m.model} · ${compact(m.total)}`} />
        ))}
      </div>
      <div className="pleg">
        {models.map((m, i) => (
          <span key={m.cli + m.model}>
            <i style={{ background: cols[i] }} />
            {shortModel(m.model)} <b>{compact(m.total)}</b>
          </span>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  const [snap, setSnap] = useState(null)
  const [scope, setScope] = useState('today')
  const [shotMenu, setShotMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const [resets, setResets] = useState([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Quota windows only change when time passes (handled by the ticker below)
    // or when new usage lands — which is exactly when a snapshot arrives. So
    // refetch on snapshot rather than polling, and the popup stays quiet while
    // hidden.
    const loadResets = () => window.api.subsResets().then(setResets)
    window.api.getSnapshot().then(setSnap)
    loadResets()
    return window.api.onSnapshot((s) => {
      setSnap(s)
      loadResets()
    })
  }, [])

  // Keeps the countdown moving between snapshots. Remaining time is derived
  // locally from each window's `end`, so a window expiring while idle flips to
  // "no open window" on its own without another IPC round-trip.
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(h)
  }, [])

  // Screenshot the popup itself. The menu must be gone from the frame first,
  // so give React a beat to re-render before asking main to capture.
  async function screenshot(mode) {
    setShotMenu(false)
    await new Promise((r) => setTimeout(r, 60))
    const res = await window.api.exportPng({ which: 'popup', mode })
    if (res?.copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  // 5 fixed built-in CLIs + whatever LiteLLM providers are currently active
  // (from the live snapshot), so each shows up as its own labeled/colored row.
  const { CLI, ORDER } = useMemo(() => {
    const dyn = snap?.providers || []
    return {
      CLI: { ...FIXED_CLI, ...Object.fromEntries(dyn.map((p) => [p.id, { label: p.label, color: p.color }])) },
      ORDER: [...FIXED_ORDER, ...dyn.map((p) => p.id)],
    }
  }, [snap?.providers])

  if (!snap) return <div className="loading">Scanning CLI logs…</div>

  const per = scope === 'today' ? snap.todayPerCli : scope === '7d' ? snap.weekPerCli : snap.perCli
  const perModelSrc = scope === 'today' ? snap.todayPerModel : scope === '7d' ? snap.weekPerModel : snap.perModel
  // Models grouped by CLI (biggest first) for each plan's in-place breakdown.
  const modelsByCli = new Map()
  for (const m of perModelSrc || []) {
    if (!(m.total > 0)) continue
    if (!modelsByCli.has(m.cli)) modelsByCli.set(m.cli, [])
    modelsByCli.get(m.cli).push(m)
  }
  for (const arr of modelsByCli.values()) arr.sort((a, b) => b.total - a.total)
  // First plan bound to each CLI, so a card can show its quota + live/manual.
  const planByCli = new Map()
  for (const r of resets) for (const b of r.bindings || []) if (b.cli && !planByCli.has(b.cli)) planByCli.set(b.cli, r)
  // Cards for every CLI with usage this scope, PLUS any CLI that has a plan (so
  // its live quota shows even with no usage in the selected range), biggest first.
  const cliOrder = [...new Set([...ORDER.filter((c) => (per[c]?.total || 0) > 0), ...planByCli.keys()])]
    .filter((c) => CLI[c])
    .sort((a, b) => (per[b]?.total || 0) - (per[a]?.total || 0))
  const totalTok = ORDER.reduce((a, c) => a + (per[c]?.total || 0), 0)
  const totalCost = ORDER.reduce((a, c) => a + (per[c]?.cost || 0), 0)

  return (
    <div className="app">
      <header className="drag">
        <div className="brand">
          <span className="logo" />
          <span>TokenStats</span>
        </div>
        <div className="hwin">
          <div className="seg">
            <button className={scope === 'today' ? 'on' : ''} onClick={() => setScope('today')}>Today</button>
            <button className={scope === '7d' ? 'on' : ''} onClick={() => setScope('7d')}>7d</button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All</button>
          </div>
          <button className="ghost" title="Token report" onClick={() => window.api.openReport()}>▤</button>
          <button className="ghost" title="Settings" onClick={() => window.api.openSettings()}>⚙</button>
          <div className="shot">
            <button className="ghost" title="Screenshot" onClick={() => setShotMenu((v) => !v)}>⎙</button>
            {shotMenu && (
              <div className="shot-menu">
                <button onClick={() => screenshot('copy')}>Copy to clipboard</button>
                <button onClick={() => screenshot('save')}>Save as PNG…</button>
              </div>
            )}
            {copied && <div className="shot-toast">Copied ✓</div>}
          </div>
          <button className="ghost" title="Refresh" onClick={() => window.api.getSnapshot().then(setSnap)}>⟳</button>
          <button className="ghost" title="Hide" onClick={() => window.api.hide()}>—</button>
        </div>
      </header>

      <div className="scroll">
        <div className="sum">
          <b>{compact(totalTok)}</b>
          <span className="u">tokens</span>
          <span className="c">${usd(totalCost)} est</span>
        </div>

        <div className="cards">
          {cliOrder.length === 0 && <div className="empty">No usage in this range yet.</div>}
          {cliOrder.map((c) => {
            const d = per[c] || { total: 0, cost: 0, count: 0 }
            const meta = CLI[c] || FALLBACK_META(c)
            const plan = planByCli.get(c)
            const ms = (modelsByCli.get(c) || []).slice(0, 4)
            return (
              <div
                className="pcard"
                key={c}
                style={{ '--ac': meta.color }}
                onClick={() => window.api.openDataDir(c)}
                title="Open data folder"
              >
                <div className="ptop">
                  <span className="pdot" />
                  <span className="pnm">
                    <b>{meta.label}</b>
                    {plan && <span className="pplan">{plan.name}</span>}
                  </span>
                  {plan && (
                    <span
                      className={`src ${plan.source === 'live' ? 'live' : 'man'}`}
                      title={
                        plan.source === 'live'
                          ? `Live quota from ${meta.label}'s own usage report`
                          : 'Estimated from tracked usage against your manual plan'
                      }
                    >
                      {plan.source === 'live' ? 'live' : 'manual'}
                    </span>
                  )}
                  <span className="ptot">
                    <b>{compact(d.total)}</b>
                    <span className="pc">${usd(d.cost)}</span>
                  </span>
                </div>
                {plan && plan.windows.length > 0 && <QuotaBig plan={plan} now={now} />}
                {ms.length > 0 && <ModelBar models={ms} color={meta.color} />}
              </div>
            )
          })}
        </div>
      </div>

      <footer>
        {snap.live ? (
          <span className="live">
            <span className="pulse" style={{ background: (CLI[snap.live.cli] || FALLBACK_META(snap.live.cli)).color }} />
            {(CLI[snap.live.cli] || FALLBACK_META(snap.live.cli)).label} · {snap.live.model} · {ago(snap.live.ts)}
          </span>
        ) : (
          <span className="muted">No activity yet</span>
        )}
        <span className="muted small build" title={`built ${__BUILD_TIME__}`}>v{__APP_VERSION__}</span>
        <button className="ghost" onClick={() => window.api.quit()} title="Quit">⏻</button>
      </footer>
    </div>
  )
}
