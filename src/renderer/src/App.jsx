import React, { useEffect, useMemo, useState } from 'react'
import { t, useLang } from './i18n.js'

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
// Short reset-window label (5h / wk / mo), localized. Mirrors the period keys in
// core/subscriptions.js's RESET_PERIODS (renderer can't import from main).
const resetLabel = (period) => t('reset.' + period)
// Coarse duration for the reset countdown — minute granularity is plenty, and
// it keeps the label from jittering on every tick.
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}${t('unit.d')} ${h}${t('unit.h')}`
  if (h) return `${h}${t('unit.h')} ${m}${t('unit.m')}`
  return m ? `${m}${t('unit.m')}` : t('unit.lt1m')
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
  if (s < 60) return t('unit.sAgo', { n: s })
  if (s < 3600) return t('unit.mAgo', { n: Math.round(s / 60) })
  if (s < 86400) return t('unit.hAgo', { n: Math.round(s / 3600) })
  return t('unit.dAgo', { n: Math.round(s / 86400) })
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
// SVG path for a pie wedge from 12 o'clock, sweeping clockwise by `frac` of a
// full turn. Used to "drain" the clock face as a window counts down.
function pieSlice(cx, cy, r, frac) {
  const f = Math.max(0, Math.min(1, frac))
  if (f <= 0) return ''
  if (f >= 1) return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r} Z`
  const a = f * 2 * Math.PI
  const ex = cx + r * Math.sin(a)
  const ey = cy - r * Math.cos(a)
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${ex.toFixed(3)} ${ey.toFixed(3)} Z`
}
// Clock glyph. With `frac` (0..1) it becomes a dial filled proportionally to the
// time REMAINING in the window, tinted with the subscription's own color; the
// wedge shrinks as the countdown runs down. Without `frac` it's the plain clock.
const ClockIcon = ({ frac = null, color = 'currentColor' }) => {
  if (frac == null)
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    )
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
      <path d={pieSlice(12, 12, 8, frac)} fill={color} />
    </svg>
  )
}
const BillIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18" />
  </svg>
)

// Dedicated headroom gradient for the quota bars — green (ample) → yellow → red
// (nearly gone). Its own HSL scale, deliberately unrelated to the CLI accent
// colors used for the card wash / model segments, so a bar's color always means
// "how much is left", never "which tool".
function levelColor(frac) {
  const h = Math.max(0, Math.min(1, frac)) * 130 // 0=red, 65=yellow, 130=green
  return `hsl(${Math.round(h)} 72% 47%)`
}

const MONTH_MS = 30 * 86400000
// What the plan's monthly fee works out to over one quota window — the fee is
// billed monthly, the window is 5h/weekly/monthly, so it has to be prorated
// before "usage worth vs what you pay" means anything. The real length of the
// current billing month (from `renewal`) is used where known, so a 31-day month
// isn't priced as 30.
const proratedFee = (plan, periodMs) => {
  const monthMs = plan.renewal?.periodMs || MONTH_MS
  if (!(plan.monthlyUsd > 0) || !(periodMs > 0)) return 0
  return (plan.monthlyUsd * periodMs) / monthMs
}
// Above 100% the window's usage is worth more than its slice of the fee — the
// plan is paying off. Below, it isn't (yet).
const valueClass = (pct) => (pct >= 100 ? 'good' : pct >= 50 ? 'ok' : 'bad')

// The plan's LIVE quota — the card's centerpiece. Estimated windows are not
// shown at all. Each live window gets two headroom bars: usage remaining (流量)
// and time-to-reset, both on the green→red scale, plus a value line: the tokens
// and pay-as-you-go cost actually spent INSIDE that same window against the
// share of the subscription fee covering it. Billing renewal is a slim line
// below. Returns null if the plan has no live window.
function QuotaBig({ plan, now, color }) {
  const cells = []
  for (const w of plan.windows) {
    if (w.source !== 'live') continue
    const fee = proratedFee(plan, w.periodMs)
    const pct = fee > 0 ? (w.cost / fee) * 100 : null
    const left = w.end ? Math.max(0, w.end - now) : 0
    // Fraction of the window's length still remaining — drives the clock dial.
    const tFrac = w.end && w.periodMs ? Math.min(1, Math.max(0, left / w.periodMs)) : 0
    const uFrac = Math.min(1, Math.max(0, (w.remainingPercent || 0) / 100))
    const uPct = Math.round(uFrac * 100)
    const next = w.end ? (w.periodMs >= WEEK_MS ? atTime(w.end, w.periodMs) : dur(left)) : '—'
    cells.push(
      <React.Fragment key={w.period}>
        <span className="qwk">{resetLabel(w.period)}</span>
        <span className="qbar" title={t('app.usedLeft', { used: Math.round(w.usedPercent), left: uPct })}>
          <i style={{ width: `${Math.max(3, uPct)}%`, background: levelColor(uFrac) }} />
        </span>
        <span className="qnum">{uPct}%</span>
        {/* time is a rounded countdown chip, NOT a bar, so it never reads as a
            second usage meter */}
        <span className="qtime" title={w.end ? t('app.nextCycle', { time: atTime(w.end, w.periodMs), dur: dur(left) }) : t('app.noResetTime')}>
          <ClockIcon frac={tFrac} color={color} />
          <b>{next}</b>
        </span>
        {/* Value line — spans the grid: what this window's usage would have
            cost pay-as-you-go, against the fee slice covering the same span. */}
        {w.tokens > 0 && (
          <span
            className="qrate"
            title={
              pct == null
                ? t('app.noFee', { tokens: compact(w.tokens), cost: usd(w.cost) })
                : t('app.rateTip', {
                    period: resetLabel(w.period),
                    tokens: compact(w.tokens),
                    cost: usd(w.cost),
                    fee: usd(fee),
                    pct: Math.round(pct),
                  })
            }
          >
            <b>{compact(w.tokens)}</b>
            <span className="qsep">·</span>${usd(w.cost)}
            {pct != null && (
              <>
                <span className="qsep">{t('app.vsFee')}</span>${usd(fee)}
                <em className={valueClass(pct)}>{Math.round(pct)}%</em>
              </>
            )}
          </span>
        )}
      </React.Fragment>
    )
  }
  if (!cells.length) return null
  const away = plan.renewal ? Math.max(0, plan.renewal.end - now) : 0
  return (
    <div className="qwrap">
      <div className="qb">{cells}</div>
      {plan.renewal && plan.monthlyUsd > 0 && (
        <div className="billrow" title={t('app.renewsTip', { time: atTime(plan.renewal.end, plan.renewal.periodMs), usd: usd(plan.monthlyUsd) })}>
          <BillIcon />
          {t('app.renews')} <b>{dur(away)}</b> · ${usd(plan.monthlyUsd)}{t('app.perMo')}
          {/* The billing cycle's own value ratio: this month's usage worth
              against this month's fee. Independent of the quota windows above. */}
          {plan.renewal.cost > 0 && (
            <span
              className="cyval"
              title={t('app.cycleValueTip', {
                cost: usd(plan.renewal.cost),
                usd: usd(plan.monthlyUsd),
                pct: Math.round((plan.renewal.cost / plan.monthlyUsd) * 100),
              })}
            >
              {t('app.cycleValue', { cost: usd(plan.renewal.cost) })}
              <em className={valueClass((plan.renewal.cost / plan.monthlyUsd) * 100)}>
                {Math.round((plan.renewal.cost / plan.monthlyUsd) * 100)}%
              </em>
            </span>
          )}
        </div>
      )}
    </div>
  )
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
  useLang() // re-render whole popup on language switch
  const [snap, setSnap] = useState(null)
  const [scope, setScope] = useState('day')
  const [shotMenu, setShotMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const [resets, setResets] = useState([])
  const [subs, setSubs] = useState([]) // for the monthly subscription total
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Quota windows only change when time passes (handled by the ticker below)
    // or when new usage lands — which is exactly when a snapshot arrives. So
    // refetch on snapshot rather than polling, and the popup stays quiet while
    // hidden.
    const loadResets = () => window.api.subsResets().then(setResets)
    const loadSubs = () => window.api.subsList().then((r) => setSubs(r || []))
    window.api.getSnapshot().then(setSnap)
    loadResets()
    loadSubs()
    return window.api.onSnapshot((s) => {
      setSnap(s)
      loadResets()
      loadSubs()
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

  // Total monthly fee of currently-active subscriptions (task: top-right badge).
  const monthlyTotal = subs.reduce((a, s) => a + (s.active ? Number(s.monthlyUsd) || 0 : 0), 0)

  if (!snap) return <div className="loading">{t('app.scanning')}</div>

  const per = scope === 'day' ? snap.todayPerCli : scope === 'week' ? snap.weekPerCli : snap.monthPerCli || snap.perCli
  const perModelSrc = scope === 'day' ? snap.todayPerModel : scope === 'week' ? snap.weekPerModel : snap.monthPerModel || snap.perModel
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
  // Cards only for CLIs with usage in this scope (a subscription with zero usage
  // in the range is hidden). Live-quota plans sort first, then by total.
  const hasLive = (c) => (planByCli.get(c)?.windows || []).some((w) => w.source === 'live')
  const cliOrder = ORDER.filter((c) => (per[c]?.total || 0) > 0).sort((a, b) => {
    const d = (hasLive(b) ? 1 : 0) - (hasLive(a) ? 1 : 0)
    return d || (per[b]?.total || 0) - (per[a]?.total || 0)
  })
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
          {/* Calendar-aligned scopes (day / week / month), so what a card shows
              lines up with the cycles a subscription is actually counted in. */}
          <div className="seg">
            <button className={scope === 'day' ? 'on' : ''} title={t('app.scopeDay')} onClick={() => setScope('day')}>{t('common.day')}</button>
            <button className={scope === 'week' ? 'on' : ''} title={t('app.scopeWeek')} onClick={() => setScope('week')}>{t('common.week')}</button>
            <button className={scope === 'month' ? 'on' : ''} title={t('app.scopeMonth')} onClick={() => setScope('month')}>{t('common.month')}</button>
          </div>
          <button className="ghost" title={t('app.reportTitle')} onClick={() => window.api.openReport()}>▤</button>
          <button className="ghost" title={t('app.settingsTitle')} onClick={() => window.api.openSettings()}>⚙</button>
          <div className="shot">
            <button className="ghost" title={t('app.screenshot')} onClick={() => setShotMenu((v) => !v)}>⎙</button>
            {shotMenu && (
              <div className="shot-menu">
                <button onClick={() => screenshot('copy')}>{t('app.copyClipboard')}</button>
                <button onClick={() => screenshot('save')}>{t('app.savePng')}</button>
              </div>
            )}
            {copied && <div className="shot-toast">{t('app.copied')}</div>}
          </div>
          <button className="ghost" title={t('app.refresh')} onClick={() => window.api.getSnapshot().then(setSnap)}>⟳</button>
          <button className="ghost" title={t('app.hide')} onClick={() => window.api.hide()}>—</button>
        </div>
      </header>

      <div className="scroll">
        <div className="sum">
          <b>{compact(totalTok)}</b>
          <span className="u">{t('common.tokens')}</span>
          <span className="c">${usd(totalCost)} {t('common.est')}</span>
          {monthlyTotal > 0 && (
            <span className="mo" title={t('app.subsTip')}>
              {t('app.subsPerMo')} <b>${usd(monthlyTotal)}</b>{t('app.perMo')}
            </span>
          )}
        </div>

        <div className="cards">
          {cliOrder.length === 0 && <div className="empty">{t('app.noUsageRange')}</div>}
          {cliOrder.map((c) => {
            const d = per[c] || { total: 0, cost: 0, count: 0 }
            const meta = CLI[c] || FALLBACK_META(c)
            const plan = planByCli.get(c)
            const live = !!(plan && plan.windows.some((w) => w.source === 'live'))
            const ms = (modelsByCli.get(c) || []).slice(0, 4)
            return (
              <div
                className="pcard"
                key={c}
                style={{ '--ac': meta.color }}
                onClick={() => window.api.openDataDir(c)}
                title={t('app.openDataFolder')}
              >
                <div className="ptop">
                  <span className="pdot" />
                  <span className="pnm">
                    <b>{meta.label}</b>
                    {plan && <span className="pplan">{plan.name}</span>}
                  </span>
                  {live && (
                    <span className="src live" title={t('app.liveQuotaTip', { label: meta.label })}>
                      {t('app.live')}
                    </span>
                  )}
                  <span className="ptot">
                    <b>{compact(d.total)}</b>
                    <span className="pc">${usd(d.cost)}</span>
                  </span>
                </div>
                {live && <QuotaBig plan={plan} now={now} color={meta.color} />}
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
          <span className="muted">{t('app.noActivity')}</span>
        )}
        <span className="muted small build" title={t('app.built', { time: __BUILD_TIME__ })}>v{__APP_VERSION__}</span>
        <button className="ghost" onClick={() => window.api.quit()} title={t('app.quit')}>⏻</button>
      </footer>
    </div>
  )
}
