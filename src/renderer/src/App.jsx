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
const DETAIL_TABS = [
  { id: 'today-models', label: 'Today Models', scope: 'today', detail: 'models', title: 'Today models' },
  { id: 'today-sessions', label: 'Today Sessions', scope: 'today', detail: 'sessions', title: 'Today sessions' },
  { id: 'all-models', label: 'All Models', scope: 'all', detail: 'models', title: 'All-time models' },
  { id: 'all-sessions', label: 'All Sessions', scope: 'all', detail: 'sessions', title: 'All-time sessions' },
]

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
// Minimal ratio icon: a ring showing how much of a quota window is LEFT. The
// popup is only 380px wide, so this replaces a full-width progress bar.
function Ring({ frac, color, size = 12 }) {
  const r = (size - 2.5) / 2
  const c = 2 * Math.PI * r
  const mid = size / 2
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--panel2)" strokeWidth="2.5" />
      <circle
        cx={mid} cy={mid} r={r} fill="none" stroke={color} strokeWidth="2.5"
        strokeDasharray={`${frac * c} ${c}`}
        transform={`rotate(-90 ${mid} ${mid})`}
      />
    </svg>
  )
}

const ago = (ts) => {
  if (!ts) return ''
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}

export default function App() {
  const [snap, setSnap] = useState(null)
  const [tab, setTab] = useState('today-models')
  const [shotMenu, setShotMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const [resets, setResets] = useState([])
  const [codexLimits, setCodexLimits] = useState([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Quota windows only change when time passes (handled by the ticker below)
    // or when new usage lands — which is exactly when a snapshot arrives. So
    // refetch on snapshot rather than polling, and the popup stays quiet while
    // hidden.
    const loadResets = () => {
      window.api.subsResets().then(setResets)
      window.api.codexLimits().then(setCodexLimits)
    }
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

  const activeTab = DETAIL_TABS.find((t) => t.id === tab) || DETAIL_TABS[0]
  const scope = activeTab.scope
  const per = scope === 'today' ? snap.todayPerCli : snap.perCli
  const models = ((scope === 'today' ? snap.todayPerModel : snap.perModel) || [])
    .filter((m) => scope !== 'today' || (m.total || 0) > 0)
  const sessions = (scope === 'today' ? snap.todayRecentSessions : snap.recentSessions) || []
  const visibleCliOrder = scope === 'today'
    ? ORDER.filter((c) => (per[c]?.total || 0) > 0)
    : ORDER
  const totalTok = ORDER.reduce((a, c) => a + (per[c]?.total || 0), 0)
  const totalCost = ORDER.reduce((a, c) => a + (per[c]?.cost || 0), 0)
  const maxTok = Math.max(1, ...visibleCliOrder.map((c) => per[c]?.total || 0))

  return (
    <div className="app">
      <header className="drag">
        <div className="brand">
          <span className="logo" />
          <span>TokenStats</span>
        </div>
        <div className="hwin">
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

      <div className="tabs detail-tabs">
        {DETAIL_TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="scroll">
      <div className="hero">
        <div className="hero-num">{compact(totalTok)}</div>
        <div className="hero-sub">tokens · <span className="cost">{usd(totalCost)}</span> est.</div>
      </div>

      {(resets.length > 0 || codexLimits.length > 0) && (
        <section className="block resets">
          <h3>Quota windows</h3>
          {codexLimits.length > 0 && (
            <div className="reset" key="codex-live">
              <span className="dot sm" style={{ background: (CLI.codex || FALLBACK_META('codex')).color }} />
              <span className="ellipsis">Codex</span>
              <span className="rwins">
                {codexLimits.map((w) => {
                  // Real provider-reported numbers: the ring shows USAGE left
                  // (100 − used_percent), the label shows TIME left to reset.
                  const color = (CLI.codex || FALLBACK_META('codex')).color
                  const frac = Math.min(1, Math.max(0, w.remainingPercent / 100))
                  const left = w.resetsAt ? Math.max(0, w.resetsAt - now) : null
                  return (
                    <span
                      className="rwin"
                      key={w.label}
                      title={
                        `Codex · ${w.label} limit\n` +
                        `${Math.round(w.usedPercent)}% used — ${Math.round(w.remainingPercent)}% left\n` +
                        (w.resetsAt ? `resets ${atTime(w.resetsAt, (w.windowMinutes || 0) * 60000)} (${dur(left)})` : 'no reset time reported')
                      }
                    >
                      <Ring frac={frac} color={color} />
                      <span className="rwin-p">{w.label}</span>
                      <span className="rwin-t">{left != null ? dur(left) : `${Math.round(w.remainingPercent)}%`}</span>
                    </span>
                  )
                })}
              </span>
            </div>
          )}
          {resets.map((r) => {
            const cli = r.bindings?.[0]?.cli
            const color = cli ? (CLI[cli] || FALLBACK_META(cli)).color : '#5b6172'
            return (
              <div className="reset" key={r.id}>
                <span className="dot sm" style={{ background: color }} />
                <span className="ellipsis">{r.name}</span>
                <span className="rwins">
                  {r.windows.map((w) => {
                    // `open` came from main at fetch time; re-check against the
                    // live clock so an expiry mid-tick shows without a refetch.
                    const open = w.open && w.end > now
                    const left = open ? w.end - now : 0
                    const frac = open ? Math.min(1, Math.max(0, left / w.periodMs)) : 0
                    return (
                      <span
                        className="rwin"
                        key={w.period}
                        title={
                          open
                            ? `${r.name} · ${RESET_FULL[w.period]} quota\n` +
                              `${dur(left)} left — resets ${atTime(w.end, w.periodMs)}\n` +
                              `${compact(w.tokens)} tokens · $${usd(w.cost)} · ${w.turns} turns this window`
                            : `${r.name} · ${RESET_FULL[w.period]} quota\nno open window — your next request starts one`
                        }
                      >
                        <Ring frac={frac} color={open ? color : '#5b6172'} />
                        <span className="rwin-p">{RESET_LABEL[w.period] || w.period}</span>
                        <span className="rwin-t">{open ? dur(left) : 'idle'}</span>
                      </span>
                    )
                  })}
                  {/* Subscription renewal — a separate clock off startDate (when
                      the fee is charged), not a token quota. */}
                  {r.renewal && r.monthlyUsd > 0 && (
                    <span
                      className="rwin"
                      title={
                        `${r.name} · subscription renewal\n` +
                        `$${usd(r.monthlyUsd)} bills again ${atTime(r.renewal.end, r.renewal.periodMs)}\n` +
                        `${dur(Math.max(0, r.renewal.end - now))} away — billing date, not a token quota`
                      }
                    >
                      <Ring
                        frac={Math.min(1, Math.max(0, (r.renewal.end - now) / r.renewal.periodMs))}
                        color={FEE_COLOR}
                      />
                      <span className="rwin-p">bill</span>
                      <span className="rwin-t">{dur(Math.max(0, r.renewal.end - now))}</span>
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </section>
      )}

      <section className="bars">
        {visibleCliOrder.map((c) => {
          const d = per[c] || { total: 0, cost: 0, count: 0 }
          return (
            <div className="row" key={c} onClick={() => window.api.openDataDir(c)} title="Open data folder">
              <div className="row-head">
                <span className="dot" style={{ background: CLI[c].color }} />
                <span className="name">{CLI[c].label}</span>
                <span className="tok">{compact(d.total)}</span>
              </div>
              <div className="track">
                <div className="fill" style={{ width: (100 * (d.total || 0)) / maxTok + '%', background: CLI[c].color }} />
              </div>
              <div className="row-meta">
                <span>{usd(d.cost)} est.</span>
                <span>{d.count} turns</span>
              </div>
            </div>
          )
        })}
      </section>

      <section className="block">
        <h3>{activeTab.title}</h3>
        {activeTab.detail === 'models' ? (
          <>
            {models.length === 0 && <div className="empty mini">No model usage in this range.</div>}
            {models.slice(0, 8).map((m) => (
              <div className="line" key={m.cli + m.model}>
                <span className="dot sm" style={{ background: (CLI[m.cli] || FALLBACK_META(m.cli)).color }} />
                <span className="ellipsis">{m.model}</span>
                <span className="num">{compact(m.total)}</span>
              </div>
            ))}
          </>
        ) : (
          <>
            {sessions.length === 0 && <div className="empty mini">No sessions in this range.</div>}
            {sessions.slice(0, 8).map((s) => (
              <div className="line" key={s.cli + s.sessionId}>
                <span className="dot sm" style={{ background: (CLI[s.cli] || FALLBACK_META(s.cli)).color }} />
                <span className="ellipsis">{s.project}</span>
                <span className="muted small">{ago(s.lastTs)}</span>
                <span className="num">{compact(s.total)}</span>
              </div>
            ))}
          </>
        )}
      </section>
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
