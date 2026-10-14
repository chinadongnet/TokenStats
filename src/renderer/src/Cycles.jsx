import React, { useEffect, useRef, useState } from 'react'
import { t, useLang } from './i18n.js'

const compact = (n) => {
  n = Number(n) || 0
  for (const [unit, scale] of [['B', 1e9], ['M', 1e6], ['K', 1e3]]) if (n >= scale) return (n / scale).toFixed(2) + unit
  return Math.round(n).toLocaleString()
}
const money = (n) => '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ratio = (cost, fee) => fee > 0 ? (cost / fee).toFixed(2) + '×' : '—'
const date = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const range = (c) => `${date(c.start)} — ${date(c.end - 1)}`
const cycleKey = (c) => `${c.periodId}:${c.start}`
const colors = ['#78dfbc', '#849aff', '#f2c779', '#bb9cff', '#6dcce9', '#ee94b0']

function Metric({ label, value, sub, accent }) {
  return <div className={'cd-metric' + (accent ? ' accent' : '')}><span>{label}</span><strong title={String(value)}>{value}</strong><small>{sub}</small></div>
}

function Models({ models, total, labels = {} }) {
  const [expanded, setExpanded] = useState(false)
  if (!models.length) return <div className="cd-empty">{t('cd.noUsage')}</div>
  return <div className="cd-models">{(expanded ? models : models.slice(0, 6)).map((m, i) => <div className="cd-model" key={JSON.stringify([m.cli, m.model])}>
    <div><span title={m.model}>{m.model || '—'}</span><small>{labels[m.cli] || (m.cli.startsWith('litellm:') ? t('common.deletedProvider') : m.cli)} · {compact(m.turns)} {t('cd.requests')}</small></div>
    <b title={m.total.toLocaleString()}>{compact(m.total)} <small>{total > 0 ? (m.total / total * 100).toFixed(1) : 0}%</small></b>
    <div className="cd-track"><i style={{ width: `${total > 0 ? m.total / total * 100 : 0}%`, background: colors[i % colors.length] }} /></div><small>{money(m.cost)}</small>
  </div>)}{models.length > 6 && <button className="cd-text-button" onClick={() => setExpanded(!expanded)}>{t(expanded ? 'cd.lessModels' : 'cd.allModels', { count: models.length })}</button>}</div>
}

function UsageChart({ cycles, selected, onSelect }) {
  const max = Math.max(...cycles.map((c) => c.tokens), 1)
  return <div className="cd-history-bars" role="group" aria-label={t('cd.cycleTrend')}>
    {[...cycles].reverse().map((c) => <button key={cycleKey(c)} className={selected === cycleKey(c) ? 'selected' : ''}
      title={`${range(c)} · ${c.tokens.toLocaleString()} Token · ${ratio(c.cost, c.fee)}`}
      aria-label={`${range(c)} · ${compact(c.tokens)} Token`} aria-pressed={selected === cycleKey(c)} onClick={() => onSelect(cycleKey(c))}>
      <i style={{ height: `${Math.max(2, c.tokens / max * 100)}%` }} />
    </button>)}
  </div>
}

function Detail({ plan, asOf, labels, onBack }) {
  const [chosen, setChosen] = useState(null)
  const cycle = plan.cycles.find((c) => cycleKey(c) === chosen) || plan.cycles[0]
  return <>
    <button className="cd-text-button cd-back" onClick={onBack}>← {t('cd.back')}</button>
    <section className="cd-hero cd-detail-hero"><div className="cd-eyebrow">{t('cd.subscriptionDetail')}</div>
      <h1>{plan.name}</h1><p>{plan.purchaseCount} {t('cd.purchases')} · {plan.monthsBilled} {t('cd.cycles')} · {plan.isCurrent ? t('cyc.active') : t('cd.noCurrent')}</p>
      <div className="cd-hero-stats"><Metric label={t('cd.allTokens')} value={compact(plan.totalTokens)} sub={plan.totalTokens.toLocaleString() + ' Token'} accent />
        <Metric label={t('cd.paid')} value={money(plan.totalPaid)} sub={t('cd.billedFees')} /><Metric label={t('cd.worth')} value={money(plan.totalCost)} sub={t('cyc.paygEstimate')} />
        <Metric label={t('cyc.valueRatio')} value={ratio(plan.totalCost, plan.totalPaid)} sub={t('cyc.costDivFee')} /></div>
    </section>
    {!cycle ? <div className="cd-panel cd-empty">{t('cd.notStarted')}</div> : <>
      <section className="cd-panel"><div className="cd-section-head"><h2>{t('cd.cycleTrend')}</h2><span>{t('cd.barHint')}</span></div>
        <UsageChart cycles={plan.cycles} selected={cycleKey(cycle)} onSelect={setChosen} />
        <div className="cd-chart-labels"><span>{date(plan.cycles.at(-1).start)}</span><span>{date(plan.cycles[0].start)}</span></div>
      </section>
      <div className="cd-two-column cd-detail-columns"><section className="cd-panel cd-cycle-focus">
        <div className="cd-section-head"><h2>{t('cd.selectedCycle')}</h2><span className="cd-badge">{cycle.end > asOf ? t('cyc.active') : t('cd.completed')}</span></div>
        <select className="cd-cycle-select" aria-label={t('cd.selectedCycle')} value={cycleKey(cycle)} onChange={(e) => setChosen(e.target.value)}>
          {plan.cycles.map((c) => <option key={cycleKey(c)} value={cycleKey(c)}>{range(c)} · {money(c.fee)}</option>)}
        </select>
        <div className="cd-focus-grid"><Metric label={t('cyc.tokensUsed')} value={compact(cycle.tokens)} sub={cycle.tokens.toLocaleString() + ' Token'} accent />
          <Metric label={t('cyc.valueRatio')} value={ratio(cycle.cost, cycle.fee)} sub={t('cyc.costDivFee')} />
          <Metric label={t('cyc.subscriptionFee')} value={money(cycle.fee)} sub={t('cd.fullFee')} /><Metric label={t('cd.worth')} value={money(cycle.cost)} sub={`${compact(cycle.turns)} ${t('cd.requests')}`} /></div>
        <div className="cd-cost-compare">{[[t('cyc.subscriptionFee'), cycle.fee], [t('cd.worth'), cycle.cost]].map(([label, value], i) =>
          <div key={label}><span>{label}</span><div className="cd-track"><i style={{ width: `${value / Math.max(cycle.fee, cycle.cost, 1) * 100}%`, background: colors[i] }} /></div><b>{money(value)}</b></div>)}</div>
      </section><section className="cd-panel"><div className="cd-section-head"><h2>{t('cd.cycleModels')}</h2><span>{cycle.models.length} {t('cd.models')}</span></div>
        <Models key={cycleKey(cycle)} models={cycle.models} total={cycle.tokens} labels={labels} /></section></div>
      <section className="cd-panel"><div className="cd-section-head"><h2>{t('cd.fullHistory')}</h2><span>{plan.cycles.length} {t('cd.cycles')}</span></div>
        <div className="cd-table-wrap"><table className="cd-table"><thead><tr>{['cd.period', 'cyc.tokensUsed', 'cyc.subscriptionFee', 'cd.worth', 'cyc.valueRatio', 'cd.topModel'].map((k) => <th key={k}>{t(k)}</th>)}</tr></thead>
          <tbody>{plan.cycles.map((c) => <tr key={cycleKey(c)} className={cycleKey(c) === cycleKey(cycle) ? 'selected' : ''}>
            <td><button className="cd-text-button" onClick={() => { setChosen(cycleKey(c)); document.querySelector('.cd-cycle-focus')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}>{range(c)}</button></td>
            <td title={c.tokens.toLocaleString()}>{compact(c.tokens)}</td><td>{money(c.fee)}</td><td className="cd-green">{money(c.cost)}</td><td>{ratio(c.cost, c.fee)}</td><td title={c.models[0]?.model}>{c.models[0]?.model || '—'}</td>
          </tr>)}</tbody></table></div>
      </section>
    </>}
  </>
}

function Overview({ data, onSelect }) {
  const { plans, summary: s, models } = data
  const best = plans.find((p) => p.id === s.bestValueId)
  const longest = plans.find((p) => p.id === s.mostCyclesId)
  const ranking = data.ranking.map((id) => plans.find((p) => p.id === id))
  const maxRatio = Math.max(...ranking.map((p) => p.ratio), 1)
  return <>
    <section className="cd-hero"><div className="cd-eyebrow">TOKENSTATS / {t('cd.overview')}</div><h1>{t('cd.headline')}</h1><p>{t('cd.scopeNote')}</p>
      <div className="cd-hero-stats"><Metric label={t('cd.allTokens')} value={compact(s.totalTokens)} sub={`${s.monthsBilled} ${t('cd.cycles')} · ${compact(s.totalTurns)} ${t('cd.requests')}`} accent />
        <Metric label={t('cd.paid')} value={money(s.totalPaid)} sub={t('cd.billedFees')} /><Metric label={t('cd.worth')} value={money(s.totalCost)} sub={t('cyc.paygEstimate')} />
        <Metric label={t('cyc.overallValue')} value={ratio(s.totalCost, s.totalPaid)} sub={t('cyc.costDivFee')} /></div>
    </section>
    <div className="cd-highlights"><Metric label={t('cd.currentAndPeak')} value={`${s.currentCount} / ${s.peakCount}`} sub={s.peakAt ? t('cd.peakOn', { date: date(s.peakAt) }) : t('cd.noHistory')} />
      <button className="cd-highlight-link" disabled={!best} onClick={() => onSelect(best.id)}><Metric label={t('cd.bestValue')} value={best ? ratio(best.totalCost, best.totalPaid) : '—'} sub={best?.name || t('cyc.noFee')} accent /></button>
      <button className="cd-highlight-link" disabled={!longest} onClick={() => onSelect(longest.id)}><Metric label={t('cd.mostCycles')} value={longest ? `${longest.monthsBilled} ${t('cd.cycles')}` : '—'} sub={longest?.name || t('cd.noHistory')} /></button>
      <Metric label={t('cd.topModel')} value={models[0]?.model || '—'} sub={models[0] ? `${compact(models[0].total)} Token · ${t('cd.byTokens')}` : t('cd.noUsage')} /></div>
    <div className="cd-two-column"><section className="cd-panel"><div className="cd-section-head"><h2>{t('cd.valueRanking')}</h2><span>{t('cd.allTime')}</span></div>
      {!ranking.length ? <div className="cd-empty">{t('cyc.noFee')}</div> : <div className="cd-ranking">{ranking.map((p, i) => <button key={p.id} onClick={() => onSelect(p.id)}>
        <span className="cd-rank-number">{String(i + 1).padStart(2, '0')}</span><div><div className="cd-rank-title"><b>{p.name}</b><strong>{ratio(p.totalCost, p.totalPaid)}</strong></div>
          <div className="cd-track"><i style={{ width: `${p.ratio / maxRatio * 100}%`, background: colors[i % colors.length] }} /></div>
          <small>{money(p.totalCost)} / {money(p.totalPaid)} · {compact(p.totalTokens)} Token</small></div><span className="cd-arrow">↗</span>
      </button>)}</div>}<p className="cd-note">{t('cd.ratioNote')}</p>
    </section><section className="cd-panel"><div className="cd-section-head"><h2>{t('cd.modelMix')}</h2><span>{t('cd.byTokens')}</span></div><Models models={models} total={s.totalTokens} labels={data.cliLabels} /></section></div>
    <div className="cd-section-head"><h2>{t('cd.allSubscriptions')}</h2><span>{plans.length} {t('cd.plans')} · {t('cd.clickDetail')}</span></div>
    <div className="cd-plan-grid">{plans.map((p, i) => <button className="cd-plan-card" key={p.id} onClick={() => onSelect(p.id)} style={{ '--plan-color': colors[i % colors.length] }}>
      <div className="cd-plan-title"><h3>{p.name}</h3><span className={'cd-badge' + (p.isCurrent ? ' live' : '')}>{p.isCurrent ? t('cyc.active') : p.cycles.length ? t('cd.noCurrent') : t('cd.notStarted')}</span></div>
      <div className="cd-plan-tokens" title={p.totalTokens.toLocaleString()}>{compact(p.totalTokens)} <small>Token</small></div>
      <div className="cd-plan-numbers"><span>{t('cd.paid')}<b>{money(p.totalPaid)}</b></span><span>{t('cd.worth')}<b>{money(p.totalCost)}</b></span><span>{t('cyc.valueRatio')}<b className="cd-green">{ratio(p.totalCost, p.totalPaid)}</b></span></div>
      <div className="cd-plan-foot"><span>{p.purchaseCount} {t('cd.purchases')} · {p.monthsBilled} {t('cd.cycles')}</span><span>{t('cd.detail')} →</span></div>
    </button>)}</div>
  </>
}

// Shared by the dedicated cycle window and the report's subscription tab.
export function SubscriptionDashboard({ embedded = false, renderOverviewExtra }) {
  useLang()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const view = useRef(null)
  useEffect(() => {
    let alive = true, request = 0
    const load = async () => {
      const sequence = ++request
      try { const result = await window.api.subsCycles(); if (alive && sequence === request) { setData(result); setError(null) } }
      catch (e) { if (alive && sequence === request) setError(e.message) }
    }
    load()
    const unsubscribe = window.api.onReportUpdated(load)
    const timer = setInterval(load, 30000)
    return () => { alive = false; unsubscribe(); clearInterval(timer) }
  }, [])
  const select = (id) => {
    setSelected(id)
    const scroller = embedded ? view.current?.closest('.report') : view.current
    scroller?.scrollTo({ top: 0 })
  }
  const plan = data?.plans.find((p) => p.id === selected)
  return <div className={embedded ? 'cycles-view cycles-embedded' : 'report cycles-view'} ref={view}>
    <header className="cd-header"><div className="rep-title"><span className="logo" /> {t(embedded ? 'rep.tokenPlans' : 'cyc.title')}</div><div><span>{data ? t('cd.updated', { time: new Date(data.asOf).toLocaleTimeString() }) : ''}</span><button className="cd-text-button" onClick={() => window.api.openSettings()}>{t('cd.manage')} ↗</button></div></header>
    {error && <div className="cd-error" role="alert">{t('cd.loadError')} {error}</div>}
    {!data ? <div className="empty">{t('common.loading')}</div> : !data.plans.length ? <div className="cd-panel cd-empty">{t('cyc.empty')}</div>
      : plan ? <Detail key={plan.id} plan={plan} asOf={data.asOf} labels={data.cliLabels} onBack={() => select(null)} /> : <><Overview data={data} onSelect={select} />{renderOverviewExtra?.(data)}</>}
    <p className="cd-note cd-scope-foot">{t('cd.methodNote')}</p>
    {!embedded && <footer className="rep-foot">{t('cyc.footer', { ver: __APP_VERSION__, built: __BUILD_TIME__ })}</footer>}
  </div>
}

export default function Cycles() {
  return <SubscriptionDashboard />
}
