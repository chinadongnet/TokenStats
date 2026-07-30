import React, { useEffect, useMemo, useState } from 'react'
import { fmtCount, t, useLang } from './i18n.js'

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

// Token counts follow the reader's counting system — 万/千万/亿 in Chinese,
// K/M/B in English (see fmtCount in i18n.js). "250.67M" means nothing at a
// glance to a Chinese reader; "2.5亿" does.
const compact = (n) => fmtCount(n)
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

// Header-toolbar icons — one shared line-icon idiom (24-grid, round caps/joins,
// currentColor stroke) so every button reads as part of the same set. Sized via
// the `.ghost svg` rule, not per-icon, so they all align to one box.
const IconBase = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const ReportIcon = () => (
  <IconBase><path d="M4 20V10M10 20V4M16 20v-7M4 20h16" /></IconBase>
)
// A real cog — one closed 6-tooth outline plus a hub. The earlier version drew
// detached radial rays around a circle, which reads as a sun, not a gear.
const SettingsIcon = () => (
  <IconBase>
    <path d="M9.5 2.7L14.5 2.7L14.7 5.6L16.2 6.5L18.8 5.2L21.3 9.5L18.8 11.2L18.8 12.8L21.3 14.5L18.8 18.8L16.2 17.5L14.7 18.4L14.5 21.3L9.5 21.3L9.3 18.4L7.8 17.5L5.2 18.8L2.7 14.5L5.2 12.8L5.2 11.2L2.7 9.5L5.2 5.2L7.8 6.5L9.3 5.6Z" />
    <circle cx="12" cy="12" r="3.1" />
  </IconBase>
)
// A camera, so the screenshot button reads as "capture" at a glance.
const CameraIcon = () => (
  <IconBase>
    <path d="M4 8h3l1.6-2h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
    <circle cx="12" cy="13" r="3.2" />
  </IconBase>
)
const RefreshIcon = () => (
  <IconBase><path d="M20 11a8 8 0 1 0-.6 4M20 5v6h-6" /></IconBase>
)
const MinimizeIcon = () => (
  <IconBase><path d="M6 12h12" /></IconBase>
)

// Dedicated headroom gradient for the quota bars — green (ample) → yellow → red
// (nearly gone). Its own HSL scale, deliberately unrelated to the CLI accent
// colors used for the card wash / model segments, so a bar's color always means
// "how much is left", never "which tool".
function levelColor(frac) {
  const h = Math.max(0, Math.min(1, frac)) * 130 // 0=red, 65=yellow, 130=green
  return `hsl(${Math.round(h)} 72% 47%)`
}

// A subscription is billed monthly, so comparing it against a day's or a week's
// usage means splitting the fee over the same span. A month is treated as 4
// weeks of 7 days — so week = fee/4 and day = fee/28 stay consistent with each
// other (a "/30 day" against a "/4 week" would not add up).
const SCOPE_DIV = { day: 28, week: 4, month: 1 }
const scopeFee = (monthlyUsd, scope) => (Number(monthlyUsd) || 0) / SCOPE_DIV[scope]
const scopeLabel = (scope) => t('scope.' + scope)

// "M/D - M/D" over [start, end) — end is exclusive everywhere in subscriptions.js,
// so the last covered day is end-1ms.
const md = (ms) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
const spanText = (start, end) => `${md(start)} - ${md(end - 1)}`

// The week/month period THIS plan actually runs on — every plan is anchored
// differently, so there is no global range to show. Month uses the plan's own
// billing cycle (that's what the fee on this line is), week its weekly quota
// window; a plan that declares neither falls back to the calendar scope the
// numbers on the card are bucketed by.
const planSpan = (scope, plan, ranges) => {
  if (scope === 'day') return ''
  const w = (plan?.windows || []).find(
    (x) => x.period === (scope === 'week' ? 'weekly' : 'monthly') && x.open && x.start != null,
  )
  const own = scope === 'month' ? plan?.renewal || w : w
  if (own && own.start != null && own.end != null) return spanText(own.start, own.end)
  if (!ranges) return ''
  if (scope === 'week') {
    if (!ranges.weekStart) return ''
    return spanText(ranges.weekStart, ranges.weekStart + 7 * 864e5)
  }
  if (!ranges.monthStart) return ''
  const s = new Date(ranges.monthStart)
  return spanText(ranges.monthStart, new Date(s.getFullYear(), s.getMonth() + 1, 1).getTime())
}

// Above 100% the window's usage is worth more than its slice of the fee — the
// plan is paying off. Below, it isn't (yet).
const valueClass = (pct) => (pct >= 100 ? 'good' : pct >= 50 ? 'ok' : 'bad')

// The plan's LIVE quota — the card's centerpiece. Estimated windows are not
// shown at all. Each live window is one row: period label, a headroom bar on the
// green→red scale, its %, and a countdown chip. What the window actually spent
// (tokens / cost) lives in the bar's tooltip — a line per window was the widest
// thing in a 380px card and pushed the layout around. Billing renewal is a slim
// line below. Returns null if the plan has no live window.
function QuotaBig({ plan, now, color }) {
  const cells = []
  for (const w of plan.windows) {
    if (w.source !== 'live') continue
    const left = w.end ? Math.max(0, w.end - now) : 0
    // Fraction of the window's length still remaining — drives the clock dial.
    const tFrac = w.end && w.periodMs ? Math.min(1, Math.max(0, left / w.periodMs)) : 0
    const uFrac = Math.min(1, Math.max(0, (w.remainingPercent || 0) / 100))
    const uPct = Math.round(uFrac * 100)
    const next = w.end ? (w.periodMs >= WEEK_MS ? atTime(w.end, w.periodMs) : dur(left)) : '—'
    cells.push(
      <React.Fragment key={w.period}>
        <span className="qwk">{resetLabel(w.period)}</span>
        <span
          className="qbar"
          title={
            t('app.usedLeft', { used: Math.round(w.usedPercent), left: uPct }) +
            (w.tokens > 0 ? ' · ' + t('app.spentIn', { tokens: compact(w.tokens), cost: usd(w.cost) }) : '')
          }
        >
          <i style={{ width: `${Math.max(3, uPct)}%`, background: levelColor(uFrac) }} />
        </span>
        <span className="qnum">{uPct}%</span>
        {/* time is a rounded countdown chip, NOT a bar, so it never reads as a
            second usage meter */}
        <span className="qtime" title={w.end ? t('app.nextCycle', { time: atTime(w.end, w.periodMs), dur: dur(left) }) : t('app.noResetTime')}>
          <ClockIcon frac={tFrac} color={color} />
          <b>{next}</b>
        </span>
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
            <button className={scope === 'day' ? 'on' : ''} title={t('app.scopeDay')} onClick={() => setScope('day')}>{t('scope.day')}</button>
            <button className={scope === 'week' ? 'on' : ''} title={t('app.scopeWeek')} onClick={() => setScope('week')}>{t('scope.week')}</button>
            <button className={scope === 'month' ? 'on' : ''} title={t('app.scopeMonth')} onClick={() => setScope('month')}>{t('scope.month')}</button>
          </div>
          <button className="ghost ico" title={t('app.reportTitle')} onClick={() => window.api.openReport()}><ReportIcon /></button>
          <button className="ghost ico" title={t('app.settingsTitle')} onClick={() => window.api.openSettings()}><SettingsIcon /></button>
          <div className="shot">
            <button className={'ghost ico' + (shotMenu ? ' on' : '')} title={t('app.screenshot')} onClick={() => setShotMenu((v) => !v)}><CameraIcon /></button>
            {shotMenu && (
              <div className="shot-menu">
                <button onClick={() => screenshot('copy')}>{t('app.copyClipboard')}</button>
                <button onClick={() => screenshot('save')}>{t('app.savePng')}</button>
              </div>
            )}
            {copied && <div className="shot-toast">{t('app.copied')}</div>}
          </div>
          <button className="ghost ico" title={t('app.refresh')} onClick={() => window.api.getSnapshot().then(setSnap)}><RefreshIcon /></button>
          <button className="ghost ico" title={t('app.hide')} onClick={() => window.api.hide()}><MinimizeIcon /></button>
        </div>
      </header>

      <div className="scroll">
        <div className="sum">
          <b>{compact(totalTok)}</b>
          <span className="u">{t('common.tokens')}</span>
          {/* The subscription side of the same scope: what all active plans cost
              over the selected span (monthly fee ÷ 4 for a week, ÷ 28 for a day),
              and what this scope's usage is worth against it. */}
          {monthlyTotal > 0 && (
            <span
              className="mo"
              title={t('app.scopeRateTip', {
                scope: scopeLabel(scope),
                cost: usd(totalCost),
                fee: usd(scopeFee(monthlyTotal, scope)),
                usd: usd(monthlyTotal),
                div: SCOPE_DIV[scope],
                pct: Math.round((totalCost / scopeFee(monthlyTotal, scope)) * 100),
              })}
            >
              {t('app.scopeFee', { scope: scopeLabel(scope) })} <b>${usd(scopeFee(monthlyTotal, scope))}</b>
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
                {/* This CLI's usage in the selected scope against the covering
                    plan's fee for the SAME span. A plan bound to several CLIs
                    shows its full share on each of their cards — the fee is not
                    split, since there's no meaningful way to attribute it. */}
                {plan && plan.monthlyUsd > 0 && (() => {
                  const fee = scopeFee(plan.monthlyUsd, scope)
                  const pct = (d.cost / fee) * 100
                  const span = planSpan(scope, plan, snap.ranges)
                  return (
                    <div
                      className="scoperate"
                      title={t('app.scopeRateTip', {
                        scope: scopeLabel(scope),
                        cost: usd(d.cost),
                        fee: usd(fee),
                        usd: usd(plan.monthlyUsd),
                        div: SCOPE_DIV[scope],
                        pct: Math.round(pct),
                      })}
                    >
                      {t('app.scopeFee', { scope: scopeLabel(scope) })} <b>${usd(fee)}</b>
                      {span && <span className="span">({span})</span>}
                      <em className={valueClass(pct)}>{Math.round(pct)}%</em>
                    </div>
                  )
                })()}
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
