import React, { useEffect, useState } from 'react'

const CLI = {
  claude: { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'Codex', color: '#10a37f' },
  gemini: { label: 'Gemini', color: '#4285f4' },
  agy: { label: 'Antigravity', color: '#a142f4' },
}
const ORDER = ['claude', 'codex', 'gemini', 'agy']

const compact = (n) => {
  if (!n) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const usd = (n) => '$' + (n || 0).toFixed(2)
const ago = (ts) => {
  if (!ts) return ''
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}

export default function App() {
  const [snap, setSnap] = useState(null)
  const [scope, setScope] = useState('today') // 'today' | 'all'

  useEffect(() => {
    window.api.getSnapshot().then(setSnap)
    return window.api.onSnapshot(setSnap)
  }, [])

  if (!snap) return <div className="loading">Scanning CLI logs…</div>

  const per = scope === 'today' ? snap.todayPerCli : snap.perCli
  const models = (scope === 'today' ? snap.todayPerModel : snap.perModel) || []
  const totalTok = ORDER.reduce((a, c) => a + (per[c]?.total || 0), 0)
  const totalCost = ORDER.reduce((a, c) => a + (per[c]?.cost || 0), 0)
  const maxTok = Math.max(1, ...ORDER.map((c) => per[c]?.total || 0))

  return (
    <div className="app">
      <header className="drag">
        <div className="brand">
          <span className="logo" />
          <span>TokenStatus</span>
        </div>
        <div className="hwin">
          <button className="ghost" title="Usage report" onClick={() => window.api.openReport()}>▤</button>
          <button className="ghost" title="Refresh" onClick={() => window.api.getSnapshot().then(setSnap)}>⟳</button>
          <button className="ghost" title="Hide" onClick={() => window.api.hide()}>—</button>
        </div>
      </header>

      <div className="tabs">
        <button className={scope === 'today' ? 'on' : ''} onClick={() => setScope('today')}>Today</button>
        <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All time</button>
      </div>

      <div className="hero">
        <div className="hero-num">{compact(totalTok)}</div>
        <div className="hero-sub">tokens · <span className="cost">{usd(totalCost)}</span> est.</div>
      </div>

      <section className="bars">
        {ORDER.map((c) => {
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
        <h3>Top models</h3>
        {models.slice(0, 5).map((m) => (
          <div className="line" key={m.model}>
            <span className="dot sm" style={{ background: CLI[m.cli]?.color }} />
            <span className="ellipsis">{m.model}</span>
            <span className="num">{compact(m.total)}</span>
          </div>
        ))}
      </section>

      <section className="block">
        <h3>Recent sessions</h3>
        {snap.recentSessions.slice(0, 6).map((s) => (
          <div className="line" key={s.cli + s.sessionId}>
            <span className="dot sm" style={{ background: CLI[s.cli]?.color }} />
            <span className="ellipsis">{s.project}</span>
            <span className="muted small">{ago(s.lastTs)}</span>
            <span className="num">{compact(s.total)}</span>
          </div>
        ))}
      </section>

      <footer>
        {snap.live ? (
          <span className="live">
            <span className="pulse" style={{ background: CLI[snap.live.cli]?.color }} />
            {CLI[snap.live.cli]?.label} · {snap.live.model} · {ago(snap.live.ts)}
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
