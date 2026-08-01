import React, { useEffect, useMemo, useState } from 'react'
import { t, useLang } from './i18n.js'

const compact = (n) => {
  n = Number(n) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const usd = (n) => (Number(n) || 0).toFixed(2)
const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const cycleLabel = (cycle) => `${dayLabel(cycle.start)} – ${dayLabel(cycle.end - 1)}`
const valueRatio = (cost, fee) => (fee > 0 ? Math.round((100 * cost) / fee) : null)

function Metric({ label, value, sub, tone }) {
  return (
    <div className="cycle-metric">
      <span>{label}</span>
      <b className={tone || ''}>{value}</b>
      <small>{sub}</small>
    </div>
  )
}

function CompareBars({ fee, cost }) {
  const max = Math.max(fee, cost, 1e-9)
  const row = (label, value, kind) => (
    <div className="cycle-bar-row">
      <span>{label}</span>
      <i><em className={kind} style={{ width: `${(100 * value) / max}%` }} /></i>
      <b>${usd(value)}</b>
    </div>
  )
  return (
    <div className="cycle-bars">
      {row(t('cyc.subscriptionFee'), fee, 'fee')}
      {row(t('cyc.tokenCost'), cost, 'worth')}
    </div>
  )
}

function CycleCard({ plan }) {
  const cycle = plan.currentCycle || plan.cycles?.[0]
  if (!cycle) return null
  const peak = plan.peakCycle
  const ratio = valueRatio(cycle.cost, cycle.fee)
  const ratioTone = ratio != null && ratio >= 100 ? 'good' : 'pending'

  return (
    <section className="cycle-card">
      <div className="cycle-card-head">
        <div>
          <h2>{plan.name}</h2>
          <span>{plan.active ? t('cyc.currentCycle') : t('cyc.lastCycle')} · {cycleLabel(cycle)}</span>
        </div>
        <span className={'sub-status' + (plan.active ? ' on' : '')}>
          {plan.active ? t('cyc.active') : t('cyc.ended')}
        </span>
      </div>

      <div className="cycle-metrics">
        <Metric label={t('cyc.tokensUsed')} value={compact(cycle.tokens)} sub={t('cyc.tokens')} />
        <Metric label={t('cyc.tokenCost')} value={'$' + usd(cycle.cost)} sub={t('cyc.paygEstimate')} tone="worth" />
        <Metric label={t('cyc.subscriptionFee')} value={'$' + usd(cycle.fee)} sub={t('cyc.forCycle')} />
        <Metric
          label={t('cyc.valueRatio')}
          value={ratio == null ? '—' : ratio + '%'}
          sub={ratio == null ? t('cyc.noFee') : t('cyc.costDivFee')}
          tone={ratioTone}
        />
      </div>

      <CompareBars fee={cycle.fee} cost={cycle.cost} />

      {peak && (
        <div className="cycle-peak">
          <span>{t('cyc.peakCycle')}</span>
          <b>{compact(peak.tokens)} {t('cyc.tokens')}</b>
          <span>${usd(peak.cost)}</span>
          <small>{cycleLabel(peak)}</small>
        </div>
      )}
    </section>
  )
}

export default function Cycles() {
  useLang()
  const [stats, setStats] = useState(null)
  async function load() {
    setStats((await window.api.subsStats()) || [])
  }
  useEffect(() => { load() }, [])
  useEffect(() => window.api.onReportUpdated(() => load()), [])

  const plans = useMemo(
    () => (stats || []).filter((plan) => plan.currentCycle || plan.cycles?.length).sort((a, b) => Number(b.active) - Number(a.active)),
    [stats],
  )
  const summary = useMemo(() => {
    const active = plans.filter((plan) => plan.active && plan.currentCycle)
    return {
      count: active.length,
      fee: active.reduce((sum, plan) => sum + plan.currentCycle.fee, 0),
      cost: active.reduce((sum, plan) => sum + plan.currentCycle.cost, 0),
      tokens: active.reduce((sum, plan) => sum + plan.currentCycle.tokens, 0),
    }
  }, [plans])
  const ratio = valueRatio(summary.cost, summary.fee)

  return (
    <div className="report cycles-view">
      <header className="rep-head">
        <div className="rep-title"><span className="logo" /> {t('cyc.title')}</div>
        <span className="card-sub">{t('cyc.subtitle')}</span>
      </header>

      {stats === null ? (
        <div className="empty">{t('common.loading')}</div>
      ) : plans.length === 0 ? (
        <div className="empty">{t('cyc.empty')}</div>
      ) : (
        <>
          <div className="tiles cycle-summary">
            <Metric label={t('cyc.activePlans')} value={String(summary.count)} sub={t('cyc.currentCycles')} />
            <Metric label={t('cyc.totalTokens')} value={compact(summary.tokens)} sub={t('cyc.activeCycleUsage')} />
            <Metric label={t('cyc.totalCost')} value={'$' + usd(summary.cost)} sub={t('cyc.paygEstimate')} tone="worth" />
            <Metric label={t('cyc.overallValue')} value={ratio == null ? '—' : ratio + '%'} sub={t('cyc.costDivFee')} tone={ratio != null && ratio >= 100 ? 'good' : 'pending'} />
          </div>
          <div className="cycle-card-grid">
            {plans.map((plan) => <CycleCard key={plan.id} plan={plan} />)}
          </div>
        </>
      )}

      <footer className="rep-foot">{t('cyc.footer', { ver: __APP_VERSION__, built: __BUILD_TIME__ })}</footer>
    </div>
  )
}
