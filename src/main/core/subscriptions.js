import { costFor } from './pricing.js'

// Subscription-plan cost tracking. A subscription row (db.js `subscriptions`)
// describes a monthly flat fee (USD) the user pays for one or more usage
// sources — e.g. "Claude" -> claude, "Google AI" -> gemini+agy, or a "Mimo
// Token Plan" -> one LiteLLM provider filtered down to a single key alias and
// a set of models. This module turns those rows plus the store's deduped
// records into per-billing-cycle fee-vs-actual-usage-cost stats.
//
// Billing model: one charge at the start of every monthly cycle, anchored to
// the subscription's start date (day-of-month clamped to short months, so a
// Jan 31 start bills Feb 28/29, Mar 31, ...). While `active`, cycles keep
// accruing up to "now"; a deactivated subscription bills only cycles that
// started on or before its `endDate`, and its coverage (usage ownership,
// timeline lane) is clipped to the endDate too — see billedCycles.

const MAX_CYCLES = 1200 // hard cap (100 years) so a bad date can't loop forever

// Quota-reset windows (subscriptions.reset_periods). Separate from BILLING:
// billing is the monthly fee anchored to startDate, this is the provider's
// allowance window that the token quota resets on. A plan holds a SET of these,
// not one — Claude Pro/Max caps both a 5-hour and a weekly window, while Cursor
// and a Mimo token plan only have a monthly allowance.
//
// Two different shapes, because real plans work two different ways:
//   '5h'      — ROLLING, opening on first use after the last one expired
//               (Claude's rate limit; see rollingWindow). No anchor: where it
//               starts is decided by usage, so there is nothing to configure.
//   'weekly'  — ANCHORED to a date+time, repeating every 7d
//   'monthly' — ANCHORED to a calendar day, like a billing-date quota
// Anchored periods read their anchor from the plan's `resetAnchors` map, one
// entry per period — weekly and monthly reset on unrelated dates, so a single
// shared anchor would be wrong.
export const RESET_PERIODS = ['5h', 'weekly', 'monthly']
export const ANCHORED_PERIODS = ['weekly', 'monthly']
export const ROLLING_PERIOD_MS = { '5h': 5 * 3600 * 1000 }
const WEEK_MS = 7 * 86400 * 1000

const _monthInfoCache = new Map()
function monthInfoLocal(ms) {
  const q = Math.floor(ms / 900000)
  let info = _monthInfoCache.get(q)
  if (info !== undefined) return info
  const d = new Date(ms)
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  info = { key, monthStart }
  if (_monthInfoCache.size > 50000) _monthInfoCache.clear()
  _monthInfoCache.set(q, info)
  return info
}

const _dayStartSubCache = new Map()
function dayStartLocalMs(ms) {
  const q = Math.floor(ms / 900000)
  let ds = _dayStartSubCache.get(q)
  if (ds !== undefined) return ds
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  ds = d.getTime()
  if (_dayStartSubCache.size > 50000) _dayStartSubCache.clear()
  _dayStartSubCache.set(q, ds)
  return ds
}

// 'YYYY-MM-DD' -> local midnight ms (matches the app's local-day convention).
function parseDateLocal(s) {
  if (typeof s !== 'string') return NaN
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return NaN
  return new Date(y, m - 1, d).getTime()
}

// Cycle N's start: startDate + N months, keeping the original anchor
// day-of-month and clamping to the target month's length (no drift).
function cycleStart({ y, m0, d }, n) {
  const total = m0 + n
  const ty = y + Math.floor(total / 12)
  const tm = ((total % 12) + 12) % 12
  const lastDay = new Date(ty, tm + 1, 0).getDate()
  return new Date(ty, tm, Math.min(d, lastDay)).getTime()
}

// One binding = { cli, keyAlias?, models? }. keyAlias narrows LiteLLM records
// to one API key (record.project carries the key_alias); models narrows to a
// set of model ids (matched against the raw LiteLLM id and the display name,
// so a Settings rename doesn't silently unbind a plan).
function makeMatcher(bindings) {
  const map = new Map()
  for (const b of bindings || []) {
    if (!b || !b.cli) continue
    map.set(b.cli, {
      keyAlias: typeof b.keyAlias === 'string' && b.keyAlias.trim() ? b.keyAlias.trim() : null,
      models: Array.isArray(b.models) && b.models.length ? new Set(b.models) : null,
    })
  }
  return (r) => {
    let b = map.get(r.cli)
    if (!b && Array.isArray(r.cliAliases)) {
      for (const alt of r.cliAliases) {
        b = map.get(alt)
        if (b) break
      }
    }
    if (!b) return false
    if (b.keyAlias && (r.project || '') !== b.keyAlias) return false
    if (b.models && !b.models.has(r.rawModel || r.model) && !b.models.has(r.model)) return false
    return true
  }
}

// Every billed cycle for one subscription: billing stops accruing at "now"
// while active, or at the end of the local endDate day once deactivated (a
// cycle starting on the end date still bills). A deactivated plan's COVERAGE
// also stops on its endDate — the final cycle keeps its full fee (the money
// was spent) but its `end` is clipped to the day after endDate, so the
// timeline lane, cycle labels, and usage ownership all cut off at the date
// the user said the subscription ended instead of running to the paid
// period's natural end.
function billedCycles(sub, nowMs) {
  const startMs = parseDateLocal(sub.startDate)
  if (!Number.isFinite(startMs)) return []
  const fee = Number(sub.monthlyUsd) || 0
  let billedThrough = nowMs
  let coverageCutoff = Infinity
  if (!sub.active) {
    const endMs = parseDateLocal(sub.endDate)
    if (Number.isFinite(endMs)) {
      const nextDay = new Date(endMs)
      nextDay.setDate(nextDay.getDate() + 1)
      coverageCutoff = nextDay.getTime() // local midnight, including DST changes
      billedThrough = Math.min(nowMs, coverageCutoff - 1)
    }
  }
  const sd = new Date(startMs)
  const anchor = { y: sd.getFullYear(), m0: sd.getMonth(), d: sd.getDate() }
  const cycles = []
  for (let i = 0; i < MAX_CYCLES; i++) {
    const cs = cycleStart(anchor, i)
    if (cs > billedThrough) break
    const end = Math.min(cycleStart(anchor, i + 1), coverageCutoff)
    cycles.push({ start: cs, end, fee, cost: 0, tokens: 0, turns: 0 })
  }
  return cycles
}

// Stats for one subscription against the full deduped record set.
export function computeSubscriptionStats(sub, records, nowMs = Date.now(), { fullHistory = false, includeModels = false } = {}) {
  const startMs = parseDateLocal(sub.startDate)
  const base = {
    id: sub.id,
    groupId: sub.groupId || sub.id,
    name: sub.name,
    monthlyUsd: Number(sub.monthlyUsd) || 0,
    startDate: sub.startDate,
    active: !!sub.active,
    endDate: sub.endDate || null,
    bindings: sub.bindings || [],
  }
  if (!Number.isFinite(startMs)) {
    return { ...base, invalid: true, monthsBilled: 0, totalPaid: 0, totalCost: 0, totalTokens: 0, totalTurns: 0, currentCycle: null, peakCycle: null, cycles: [], months: [] }
  }

  const cycles = billedCycles(sub, nowMs)
  if (includeModels) for (const c of cycles) c.models = new Map()

  // Calendar-month buckets alongside the billing cycles — the report's
  // fee-vs-worth chart wants months that align across plans, which billing
  // cycles (anchored to arbitrary start days) don't. Fees land in the month
  // their cycle starts (when the charge happens); usage in its record's month.
  const months = new Map() // 'YYYY-MM' -> {month, paid, cost, tokens}
  const monthBucket = (ms) => {
    const { key, monthStart } = monthInfoLocal(ms)
    let b = months.get(key)
    if (!b) {
      b = { month: key, monthStart, paid: 0, cost: 0, tokens: 0 }
      months.set(key, b)
    }
    return b
  }
  for (const c of cycles) monthBucket(c.start).paid += c.fee

  if (cycles.length) {
    const match = makeMatcher(base.bindings)
    const firstStart = cycles[0].start
    const lastEnd = cycles[cycles.length - 1].end
    for (const r of records) {
      if (r.ts < firstStart || r.ts >= lastEnd || r.ts > nowMs) continue
      if (!match(r)) continue
      // binary search: greatest cycle whose start <= r.ts
      let lo = 0, hi = cycles.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (cycles[mid].start <= r.ts) lo = mid
        else hi = mid - 1
      }
      const c = cycles[lo]
      const cost = costFor(r)
      c.cost += cost
      c.tokens += r.total
      c.turns += r.turns || 1
      if (includeModels) {
        const key = `${r.cli}|${r.model}`
        const m = c.models.get(key) || { cli: r.cli, model: r.model, total: 0, cost: 0, turns: 0 }
        m.total += r.total
        m.cost += cost
        m.turns += r.turns || 1
        c.models.set(key, m)
      }
      const mb = monthBucket(r.ts)
      mb.cost += cost
      mb.tokens += r.total
    }
  }

  let totalCost = 0, totalTokens = 0, totalTurns = 0, peakCycle = null
  for (const c of cycles) {
    if (includeModels) c.models = [...c.models.values()].sort((a, b) => b.total - a.total)
    totalCost += c.cost
    totalTokens += c.tokens
    totalTurns += c.turns
    if (!peakCycle || c.tokens > peakCycle.tokens) peakCycle = c
  }

  return {
    ...base,
    monthsBilled: cycles.length,
    totalPaid: cycles.length * base.monthlyUsd,
    totalCost,
    totalTokens,
    totalTurns,
    // Active plans expose their currently-open billing cycle directly so
    // compact consumers (notably Settings) do not have to infer it from the
    // newest-first history array.
    currentCycle: base.active && cycles.length ? cycles[cycles.length - 1] : null,
    // True all-history maximum, computed before the UI history is capped to 24.
    peakCycle,
    // newest-first, capped — the UI shows recent cycles; totals above cover all
    cycles: (fullHistory ? cycles : cycles.slice(-24)).reverse(),
    // chronological calendar months (capped), for the fee-vs-worth chart
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-24),
  }
}

// Gives each record exactly ONE owning plan. A plan owns a record when its
// bindings match AND the record's timestamp falls inside the plan's billed
// coverage (first cycle start → last billed cycle end). When coverages overlap
// — e.g. an ended "Pro" whose last paid cycle runs past the start of its
// replacement "Plus" — the most recently STARTED plan wins, matching the
// "I switched plans on that date" expectation. Without the time bound, two
// plans over the same sources (Pro → Plus upgrades) would both match forever
// and creation order would starve the newer plan.
function planAssigner(subs, nowMs) {
  const entries = (subs || []).map((sub) => {
    const cycles = billedCycles(sub, nowMs)
    return {
      sub,
      cycles,
      match: makeMatcher(sub.bindings),
      covStart: cycles.length ? cycles[0].start : Infinity,
      covEnd: cycles.length ? cycles[cycles.length - 1].end : -Infinity,
    }
  })
  const order = [...entries].sort((a, b) => b.covStart - a.covStart)
  const pick = (r) => order.find((e) => r.ts >= e.covStart && r.ts < e.covEnd && e.match(r)) || null
  return { entries, pick }
}

let _planIndexMemo = null

function forEachInRange(sortedRs, fromMs, toMs, fn) {
  if (!sortedRs || !sortedRs.length) return
  let lo = 0
  let hi = sortedRs.length
  if (fromMs != null) {
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sortedRs[mid].ts < fromMs) lo = mid + 1
      else hi = mid
    }
  }
  for (let i = lo; i < sortedRs.length; i++) {
    const r = sortedRs[i]
    if (toMs != null && r.ts >= toMs) break
    fn(r)
  }
}

function hasPlanRecordBetween(idx, aMs, bMs) {
  if (aMs === bMs) return false
  const lo = Math.min(aMs, bMs)
  const hi = Math.max(aMs, bMs)
  if (idx.tsMax <= lo || idx.tsMin > hi) return false
  for (const rs of idx.byPlan.values()) {
    let l = 0
    let r = rs.length
    while (l < r) {
      const mid = (l + r) >> 1
      if (rs[mid].ts <= lo) l = mid + 1
      else r = mid
    }
    if (l < rs.length && rs[l].ts <= hi) return true
  }
  return false
}

// ONE pass over the records that both computeResetWindows() and
// mergeLiveLimits() can share: the exclusively-assigned records per plan
// (sorted by ts, ready for usageIn) plus the same per CLI, which is what a
// live window belonging to no plan needs. Callers that build it once and hand
// it to both avoid a second full planAssigner sweep per popup refresh.
export function planRecordIndex(subs, records, nowMs = Date.now()) {
  const recs = records || []
  const len = recs.length
  const first = len ? recs[0] : null
  const last = len ? recs[len - 1] : null
  const dayStart = dayStartLocalMs(nowMs)
  const subsJson = JSON.stringify(subs || [])
  if (
    _planIndexMemo &&
    _planIndexMemo.recs === recs &&
    _planIndexMemo.len === len &&
    _planIndexMemo.first === first &&
    _planIndexMemo.last === last &&
    _planIndexMemo.dayStart === dayStart &&
    _planIndexMemo.subsJson === subsJson &&
    (!_planIndexMemo.sample || _planIndexMemo.sample.every((r, i) => r === recs[i]))
  ) {
    return _planIndexMemo.value
  }
  const { entries, pick } = planAssigner(subs, nowMs)
  const byPlan = new Map((subs || []).map((s) => [s.id, []]))
  const byCli = new Map()
  const unplanned = []
  let tsMin = Infinity
  let tsMax = -Infinity
  for (const r of recs) {
    if (r.ts < tsMin) tsMin = r.ts
    if (r.ts > tsMax) tsMax = r.ts
    const e = pick(r)
    if (e) byPlan.get(e.sub.id).push(r)
    else unplanned.push(r)
    const clis = Array.isArray(r.cliAliases) && r.cliAliases.length ? r.cliAliases : [r.cli]
    for (const c of clis) {
      if (!byCli.has(c)) byCli.set(c, [])
      byCli.get(c).push(r)
    }
  }
  for (const rs of byPlan.values()) rs.sort((a, b) => a.ts - b.ts)
  for (const rs of byCli.values()) rs.sort((a, b) => a.ts - b.ts)
  unplanned.sort((a, b) => a.ts - b.ts)
  const value = { entries, byPlan, byCli, unplanned, tsMin, tsMax }
  const sample = len <= 256 ? recs.slice() : null
  _planIndexMemo = { recs, len, first, last, sample, dayStart, subsJson, value }
  return value
}

let _allSubStatsMemo = null
export function computeAllSubscriptionStats(subs, records, nowMs = Date.now()) {
  // Pre-assign records so overlapping plans never double-count the same usage
  // (each plan's stats only see the records it owns).
  const idx = planRecordIndex(subs, records, nowMs)
  if (
    _allSubStatsMemo &&
    _allSubStatsMemo.idx === idx &&
    !hasPlanRecordBetween(idx, _allSubStatsMemo.nowMs, nowMs)
  ) {
    return _allSubStatsMemo.result
  }
  const result = groupSubscriptionStats((subs || []).map((s) => computeSubscriptionStats(s, idx.byPlan.get(s.id) || [], nowMs)))
  _allSubStatsMemo = { idx, nowMs, result }
  return result
}

function bindingKey(binding) {
  return JSON.stringify([binding.cli, binding.keyAlias?.trim() || null,
    binding.models?.length ? [...new Set(binding.models)].sort() : null])
}

let _cycleDashMemo = null
// All-history cycle dashboard. Every purchase retains its own anchor, fee and
// clipped coverage; grouping never fills gaps or duplicates overlapping usage.
export function computeCycleDashboard(subs, records, nowMs = Date.now()) {
  const idx = planRecordIndex(subs, records, nowMs)
  if (
    _cycleDashMemo &&
    _cycleDashMemo.idx === idx &&
    !hasPlanRecordBetween(idx, _cycleDashMemo.nowMs, nowMs)
  ) {
    return { ..._cycleDashMemo.result, asOf: nowMs }
  }
  const { entries, byPlan } = idx
  const stats = entries.map((e) => computeSubscriptionStats(e.sub, byPlan.get(e.sub.id) || [], nowMs,
    { fullHistory: true, includeModels: true }))
  const combineModels = (cycles) => {
    const models = new Map()
    for (const c of cycles) for (const m of c.models || []) {
      const key = JSON.stringify([m.cli, m.model])
      const sum = models.get(key) || { ...m, total: 0, cost: 0, turns: 0 }
      for (const k of ['total', 'cost', 'turns']) sum[k] += m[k]
      models.set(key, sum)
    }
    return [...models.values()].sort((a, b) => b.total - a.total)
  }
  const plans = groupSubscriptionStats(stats).map((p) => {
    const cycles = p.periods.flatMap((s) => s.cycles.map((c) => ({ ...c, periodId: s.id })))
      .sort((a, b) => b.start - a.start || a.periodId.localeCompare(b.periodId))
    const current = cycles.filter((c) => c.start <= nowMs && c.end > nowMs)
    return { ...p, cycles, current, isCurrent: current.length > 0,
      models: combineModels(cycles), ratio: p.totalPaid > 0 ? p.totalCost / p.totalPaid : null,
      tokenPerDollar: p.totalPaid > 0 ? p.totalTokens / p.totalPaid : null }
  }).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.totalTokens - a.totalTokens)

  // Union coverage within each group before counting concurrent subscriptions.
  // Process simultaneous starts/ends together; adjacent periods aren't a spike.
  const events = new Map()
  for (const p of plans) {
    const spans = p.cycles.map((c) => [c.start, Math.min(c.end, nowMs + 1)]).sort((a, b) => a[0] - b[0])
    const merged = []
    for (const span of spans) {
      const last = merged.at(-1)
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
      else merged.push([...span])
    }
    for (const [start, end] of merged) {
      events.set(start, (events.get(start) || 0) + 1)
      events.set(end, (events.get(end) || 0) - 1)
    }
  }
  let count = 0, peakCount = 0, peakAt = null
  for (const [at, change] of [...events].sort((a, b) => a[0] - b[0])) {
    count += change
    if (count > peakCount) { peakCount = count; peakAt = at }
  }
  const ranking = plans.filter((p) => p.ratio != null).sort((a, b) => b.ratio - a.ratio || b.totalTokens - a.totalTokens)
  const mostCycles = [...plans].filter((p) => p.monthsBilled > 0).sort((a, b) => b.monthsBilled - a.monthsBilled)[0] || null
  const models = combineModels(plans.flatMap((p) => p.cycles))
  const summary = Object.fromEntries(['totalTokens', 'totalPaid', 'totalCost', 'totalTurns', 'monthsBilled'].map((k) =>
    [k, plans.reduce((n, p) => n + p[k], 0)]))
  const result = { asOf: nowMs, plans, ranking: ranking.map((p) => p.id), models,
    summary: { ...summary, currentCount: plans.filter((p) => p.isCurrent).length,
      peakCount, peakAt, bestValueId: ranking[0]?.id || null, mostCyclesId: mostCycles?.id || null } }
  _cycleDashMemo = { idx, nowMs, result }
  return result
}

// Purchases keep their own billing anchors, prices and ownership. Only the
// presentation is grouped: no continuous coverage is invented across gaps.
export function groupSubscriptionStats(stats) {
  const groups = new Map()
  for (const s of stats) {
    const id = s.groupId || s.id
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(s)
  }
  return [...groups].map(([id, periods]) => {
    periods.sort((a, b) => a.startDate.localeCompare(b.startDate))
    const active = periods.filter((p) => p.active)
    const representative = active[active.length - 1] || periods[periods.length - 1]
    const months = new Map()
    for (const p of periods) for (const m of p.months || []) {
      const sum = months.get(m.month) || { ...m, paid: 0, cost: 0, tokens: 0 }
      for (const key of ['paid', 'cost', 'tokens']) sum[key] += m[key] || 0
      months.set(m.month, sum)
    }
    const cycles = periods.flatMap((p) => (p.cycles || []).map((c) => ({ ...c, periodId: p.id })))
      .sort((a, b) => b.start - a.start)
    const current = active.filter((p) => p.currentCycle).map((p) => ({ ...p.currentCycle, periodId: p.id }))
    const currentCycle = current.length > 1 ? current.reduce((sum, c) => ({
      start: Math.min(sum.start, c.start), end: Math.max(sum.end, c.end),
      ...Object.fromEntries(['fee', 'cost', 'tokens', 'turns'].map((k) => [k, (sum[k] || 0) + (c[k] || 0)])),
    }), { start: Infinity, end: -Infinity }) : current[0] || null
    return {
      ...representative, id, groupId: id, periods, purchaseCount: periods.length,
      startDate: periods[0].startDate,
      endDate: active.length ? null : periods.map((p) => p.endDate || '').sort().at(-1),
      active: active.length > 0,
      monthlyUsd: active.length ? active.filter((p) => p.currentCycle).reduce((n, p) => n + p.monthlyUsd, 0) : representative.monthlyUsd,
      bindings: [...new Map(periods.flatMap((p) => p.bindings).map((b) => [bindingKey(b), b])).values()],
      ...Object.fromEntries(['monthsBilled', 'totalPaid', 'totalCost', 'totalTokens', 'totalTurns'].map((k) => [k, periods.reduce((n, p) => n + (p[k] || 0), 0)])),
      currentCycle, peakCycle: periods.map((p) => p.peakCycle).filter(Boolean).sort((a, b) => b.tokens - a.tokens)[0] || null,
      cycles: cycles.slice(0, 24), months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-24),
    }
  })
}

function groupPlanBuckets(plans) {
  const groups = new Map()
  for (const p of plans) {
    const id = p.groupId || p.id
    let g = groups.get(id)
    if (!g) {
      g = { ...p, id, bindings: [], models: new Map(), cycles: [], active: false, monthlyUsd: 0, fees: 0, cost: 0, tokens: 0, turns: 0 }
      groups.set(id, g)
    }
    for (const key of ['fees', 'cost', 'tokens', 'turns']) g[key] += p[key] || 0
    if (p.active) { g.active = true; g.monthlyUsd += p.monthlyUsd || 0 }
    g.bindings.push(...p.bindings)
    g.cycles.push(...(p.cycles || []).map((c) => ({ ...c, periodId: p.id })))
    for (const m of p.models || []) {
      const key = m.cli + '|' + m.model
      const sum = g.models.get(key) || { ...m, total: 0, cost: 0, turns: 0 }
      for (const field of ['total', 'cost', 'turns']) sum[field] += m[field] || 0
      g.models.set(key, sum)
    }
  }
  return [...groups.values()].map((g) => ({ ...g,
    bindings: [...new Map(g.bindings.map((b) => [bindingKey(b), b])).values()],
    cycles: g.cycles.sort((a, b) => a.start - b.start),
    models: [...g.models.values()].sort((a, b) => b.total - a.total),
  }))
}

// Everything the report's zoomable plan timeline needs for one visible window
// [fromMs, toMs): per plan, the billing-cycle segments overlapping the window
// (each with its fee and the usage cost/tokens that landed in it), in-window
// totals + per-model breakdown (same shape PlanBreakdown consumes), a per-
// local-day stacked usage series, and the overall data span for zoom clamping.
export function computePlanTimeline(subs, records, fromMs, toMs, nowMs = Date.now()) {
  const idx = planRecordIndex(subs, records, nowMs)
  const { entries, byPlan, unplanned: unplannedRecs, tsMin, tsMax } = idx
  const buckets = new Map()
  const plans = entries.map((e) => {
    const cycles = e.cycles
      .filter((c) => c.end > fromMs && c.start < toMs)
      .map((c) => ({ start: c.start, end: c.end, fee: c.fee, cost: 0, tokens: 0 }))
    const p = {
      id: e.sub.id,
      groupId: e.sub.groupId || e.sub.id,
      name: e.sub.name,
      active: !!e.sub.active,
      monthlyUsd: Number(e.sub.monthlyUsd) || 0,
      startDate: e.sub.startDate,
      endDate: e.sub.endDate || null,
      bindings: e.sub.bindings || [],
      cycles,
      // money actually charged inside the window (cycle STARTS in range),
      // matching computePlanBreakdown's `fees` semantics
      fees: e.cycles.reduce((a, c) => a + (c.start >= fromMs && c.start < toMs ? c.fee : 0), 0),
      cost: 0,
      tokens: 0,
      turns: 0,
      models: new Map(),
    }
    buckets.set(e.sub.id, p)
    return p
  })
  const unplanned = { id: null, name: null, active: true, monthlyUsd: 0, bindings: [], fees: 0, cost: 0, tokens: 0, turns: 0, models: new Map() }

  const days = new Map() // dayMs -> { day, perPlan: {id|'un': {tokens, cost}} }
  const addRec = (r, e, b, pk) => {
    const cost = costFor(r)
    b.cost += cost
    b.tokens += r.total
    b.turns += r.turns || 1
    const mkey = r.cli + '|' + r.model
    let m = b.models.get(mkey)
    if (!m) {
      m = { cli: r.cli, model: r.model, total: 0, cost: 0, turns: 0 }
      b.models.set(mkey, m)
    }
    m.total += r.total
    m.cost += cost
    m.turns += r.turns || 1
    if (e) {
      const cy = b.cycles.find((c) => r.ts >= c.start && r.ts < c.end)
      if (cy) {
        cy.cost += cost
        cy.tokens += r.total
      }
    }
    const dayKey = dayStartLocalMs(r.ts)
    let day = days.get(dayKey)
    if (!day) {
      day = { day: dayKey, perPlan: {} }
      days.set(dayKey, day)
    }
    const slot = day.perPlan[pk] || (day.perPlan[pk] = { tokens: 0, cost: 0 })
    slot.tokens += r.total
    slot.cost += cost
  }
  for (const e of entries) {
    const b = buckets.get(e.sub.id)
    const pk = e.sub.groupId || e.sub.id
    forEachInRange(byPlan.get(e.sub.id), fromMs, toMs, (r) => addRec(r, e, b, pk))
  }
  forEachInRange(unplannedRecs, fromMs, toMs, (r) => addRec(r, null, unplanned, 'un'))

  // Overall span (records + every billed cycle, clipped to now+7d) so the UI
  // can clamp zoom-out to where data actually exists.
  let spanMin = Number.isFinite(tsMin) ? tsMin : nowMs
  let spanMax = Number.isFinite(tsMax) ? tsMax : nowMs
  for (const e of entries) {
    if (e.cycles.length) {
      spanMin = Math.min(spanMin, e.cycles[0].start)
      spanMax = Math.max(spanMax, e.cycles[e.cycles.length - 1].end)
    }
  }
  spanMax = Math.min(Math.max(spanMax, nowMs), nowMs + 7 * 86400000)

  const finish = ({ models, ...b }) => ({
    ...b,
    models: [...models.values()].sort((a, x) => x.total - a.total),
  })
  return {
    span: { min: spanMin, max: spanMax },
    totalCost: plans.reduce((a, p) => a + p.cost, 0) + unplanned.cost,
    plans: groupPlanBuckets(plans.map(finish)),
    unplanned: finish(unplanned),
    days: [...days.values()].sort((a, b) => a.day - b.day),
  }
}

// ---- quota reset windows --------------------------------------------------

// Claude-style ROLLING window: it opens on the first request made after the
// previous one expired and resets `periodMs` later. It is NOT a clock-aligned
// schedule, so it cannot be derived from the wall clock — the chain has to be
// replayed forward from the plan's first request, because where window N ends
// decides where N+1 can start. Go idle long enough and there is simply no open
// window until the next request opens one.
//
// Returns the currently-open window as {start, end, from, to} — indices into
// `sortedTs` — or null when every window has expired.
function rollingWindow(sortedTs, periodMs, nowMs) {
  let i = 0
  while (i < sortedTs.length) {
    const start = sortedTs[i]
    const end = start + periodMs
    let j = i
    while (j < sortedTs.length && sortedTs[j] < end) j++
    if (end > nowMs) return { start, end, from: i, to: j }
    i = j
  }
  return null
}

// Anchors accept 'YYYY-MM-DD' (monthly) or 'YYYY-MM-DDTHH:mm' (weekly, which
// carries a time of day) -> local ms.
function parseWhenLocal(s) {
  if (typeof s !== 'string') return NaN
  const [datePart, timePart] = s.split('T')
  const [y, m, d] = (datePart || '').split('-').map(Number)
  if (!y || !m || !d) return NaN
  const [hh, mm] = (timePart || '').split(':').map(Number)
  return new Date(y, m - 1, d, hh || 0, mm || 0).getTime()
}

// The WEEKLY window is anchored to a date+time and repeats every 7 days, so the
// user can pin it to when their provider actually resets. Fixed-ms stepping
// means a DST change shifts the local time by an hour until the anchor is
// re-set — acceptable for a countdown, and a non-issue in non-DST locales.
function weeklyWindow(anchorMs, nowMs) {
  const k = Math.floor((nowMs - anchorMs) / WEEK_MS) // negative if the anchor is in the future
  const start = anchorMs + k * WEEK_MS
  return { start, end: start + WEEK_MS }
}

// The MONTHLY window is anchored, not rolling: it runs anchor-day to anchor-day
// like a billing-date quota (Cursor, a Mimo token plan), reusing cycleStart's
// short-month clamping. Unlike a rolling window there is always a current one,
// and its length varies (28-31d), so callers take `periodMs` from end - start.
function monthlyWindow(anchorMs, nowMs) {
  const a = new Date(anchorMs)
  const anchor = { y: a.getFullYear(), m0: a.getMonth(), d: a.getDate() }
  const n = new Date(nowMs)
  let k = (n.getFullYear() - anchor.y) * 12 + (n.getMonth() - anchor.m0)
  // now may sit either side of THIS month's anchor day (and the anchor itself
  // may be in the future), so step k until the window actually contains now.
  if (cycleStart(anchor, k) > nowMs) k -= 1
  else if (cycleStart(anchor, k + 1) <= nowMs) k += 1
  return { start: cycleStart(anchor, k), end: cycleStart(anchor, k + 1) }
}

// Sums the records in [start, end) — `rs` must be sorted by ts.
function usageIn(rs, start, end) {
  let tokens = 0
  let cost = 0
  let turns = 0
  let lo = 0
  let hi = rs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rs[mid].ts < start) lo = mid + 1
    else hi = mid
  }
  for (let i = lo; i < rs.length; i++) {
    const r = rs[i]
    if (r.ts >= end) break
    tokens += r.total
    cost += costFor(r)
    turns += r.turns || 1
  }
  return { tokens, cost, turns }
}

// Per-plan state for the tray popup. Two INDEPENDENT clocks come back per plan,
// anchored to different dates and computed separately — conflating them is the
// easy mistake here:
//   `windows`  — token QUOTA resets, anchored to `resetAnchor` (monthly) or to
//                actual usage (rolling 5h/weekly). About tokens.
//   `renewal`  — the subscription's BILLING renewal, anchored to `startDate`:
//                when the monthly fee is charged again. About money. Same shape
//                as a monthly window, and identical to the current cycle that
//                billedCycles() would produce.
// A plan's quota can reset on the 20th while its fee bills on the 5th; both are
// reported, neither derives from the other.
//
// Only ACTIVE plans with at least one reset period are returned — the section is
// primarily about quota, so a plan tracking no window stays hidden even though
// it does have a renewal date. Each comes back as
// { id, name, monthlyUsd, bindings, windows: [...], renewal }, windows in
// RESET_PERIODS order (5h, weekly, monthly).
//
// Records are assigned through the same exclusive planAssigner the billing
// stats use, so two plans over the same sources never double-count a request.
let _resetWindowsMemo = null
export function computeResetWindows(subs, records, nowMs = Date.now(), index = null) {
  const tracked = (subs || []).filter((s) => s.active && (s.resetPeriods || []).length)
  if (!tracked.length) return []

  const idx = index || planRecordIndex(subs, records, nowMs)
  if (
    _resetWindowsMemo &&
    _resetWindowsMemo.idx === idx &&
    _resetWindowsMemo.nowMs === nowMs
  ) {
    return _resetWindowsMemo.result
  }

  const result = tracked.map((sub) => {
    const rs = idx.byPlan.get(sub.id) || []
    // A rolling window can't be OPENED by a record in the future. LiteLLM has no
    // per-request timestamps and stamps a whole day at noon UTC, so its "today"
    // bucket legitimately sits ahead of now. Anchored windows don't care — such a
    // record still falls inside the current week/month, and dropping it would
    // undercount exactly the plans (Mimo) that use a monthly quota.
    let past = null
    let pastTs = null
    const anchors = sub.resetAnchors || {}

    const windows = []
    for (const period of RESET_PERIODS) {
      if (!(sub.resetPeriods || []).includes(period)) continue

      if (ANCHORED_PERIODS.includes(period)) {
        // Each anchored period has its OWN anchor; falling back to startDate
        // keeps a plan saved before the anchor existed from rendering nothing.
        const anchorMs = parseWhenLocal(anchors[period] || sub.startDate)
        if (!Number.isFinite(anchorMs)) continue // unparseable: skip rather than render NaN
        const { start, end } = period === 'weekly' ? weeklyWindow(anchorMs, nowMs) : monthlyWindow(anchorMs, nowMs)
        windows.push({
          period, open: true, start, end, periodMs: end - start,
          msToReset: Math.max(0, end - nowMs), ...usageIn(rs, start, end),
        })
        continue
      }

      if (!past) {
        past = rs.length && rs[rs.length - 1].ts <= nowMs ? rs : rs.filter((r) => r.ts <= nowMs)
        pastTs = past.map((r) => r.ts)
      }
      const periodMs = ROLLING_PERIOD_MS[period]
      const w = rollingWindow(pastTs, periodMs, nowMs)
      if (!w) {
        // idle: the next request opens a fresh window
        windows.push({ period, open: false, start: null, end: null, periodMs, msToReset: null, tokens: 0, cost: 0, turns: 0 })
        continue
      }
      windows.push({
        period, open: true, start: w.start, end: w.end, periodMs,
        msToReset: Math.max(0, w.end - nowMs), ...usageIn(past, w.start, w.end),
      })
    }

    // Billing renewal — deliberately off `startDate`, NOT `resetAnchor`: the fee
    // date and the quota date are unrelated, so this is the one place startDate
    // is allowed to drive a countdown.
    const startMs = parseDateLocal(sub.startDate)
    let renewal = null
    if (Number.isFinite(startMs)) {
      const { start, end } = monthlyWindow(startMs, nowMs)
      // Usage inside the CURRENT billing cycle, so the popup can put what the
      // month's usage is worth next to what the month actually costs.
      renewal = { start, end, periodMs: end - start, msToRenew: Math.max(0, end - nowMs), ...usageIn(rs, start, end) }
    }

    return {
      id: sub.id,
      groupId: sub.groupId || sub.id,
      name: sub.name,
      monthlyUsd: Number(sub.monthlyUsd) || 0,
      bindings: sub.bindings || [],
      windows,
      renewal,
    }
  })
  _resetWindowsMemo = { idx, nowMs, result }
  return result
}

// ---- live CLI limits overlay ------------------------------------------------

// Some CLIs report their OWN plan quota (currently just Codex, from the
// `rate_limits` snapshot in its logs) — real used%/reset numbers, no estimate.
// Convert one such window into the same display shape computeResetWindows()
// emits, tagged `source:'live'` so the UI can badge it and swap the ring from
// time-based to usage-based.
// `rs` (the owning plan's records, ts-sorted) fills the window's real token/cost
// usage. The CLI reports only a reset time and a used%, never a window start, so
// the range is reconstructed as [end - periodMs, end) — the exact span the quota
// number covers — and clamped to `now` so a not-yet-elapsed remainder can't
// swallow future-stamped records. Without records the counters stay 0, which is
// what the pre-usage callers still get.
function toLiveWindow(w, nowMs, rs = null) {
  const periodMs = (w.windowMinutes || 0) * 60000
  const end = w.resetsAt ?? null
  let usage = { tokens: 0, cost: 0, turns: 0 }
  if (rs && rs.length && periodMs > 0) {
    const wEnd = end != null ? end : nowMs
    usage = usageIn(rs, wEnd - periodMs, Math.min(wEnd, nowMs))
  }
  return {
    period: w.label,
    source: 'live',
    open: end == null || end > nowMs,
    // Derived, not reported — kept so the UI can say what range the usage covers.
    start: end != null && periodMs > 0 ? end - periodMs : null,
    end,
    periodMs,
    msToReset: end != null ? Math.max(0, end - nowMs) : null,
    usedPercent: w.usedPercent,
    remainingPercent: w.remainingPercent,
    ...usage,
  }
}

// Overlay live per-CLI quota onto the estimated reset windows. For a plan bound
// to a CLI that reports live data, each live window REPLACES that plan's
// same-period estimate (unmatched live windows are appended); the plan's other
// windows stay estimates. Plans bound to no live-capable CLI come back unchanged
// with every window tagged `source:'estimate'`. Live data for a CLI that no plan
// covers becomes its own synthetic entry so it still shows even before the user
// configures a subscription. Billing `renewal` is never touched.
//
//   liveByCli — { <cli>: [ window, … ] } as returned by e.g. codexResetWindows()
//   labels    — { <cli>: 'Display Name' } for the synthetic entries' names
//   index     — optional planRecordIndex(), which fills each live window's real
//               tokens/cost over its own span (see toLiveWindow); omit and the
//               live windows come back with zeroed counters as before.
export function mergeLiveLimits(entries, liveByCli = {}, nowMs = Date.now(), labels = {}, index = null) {
  const covered = new Set()
  const out = (entries || []).map((e) => {
    const rs = index?.byPlan?.get(e.id) || null
    const live = []
    for (const b of e.bindings || []) {
      const ws = b.cli && liveByCli[b.cli]
      if (ws && ws.length) {
        live.push(...ws)
        covered.add(b.cli)
      }
    }
    if (!live.length) {
      return { ...e, windows: (e.windows || []).map((w) => ({ ...w, source: 'estimate' })), source: 'estimate' }
    }
    const byPeriod = new Map(live.map((w) => [w.label, w]))
    const windows = (e.windows || []).map((w) =>
      byPeriod.has(w.period) ? toLiveWindow(byPeriod.get(w.period), nowMs, rs) : { ...w, source: 'estimate' }
    )
    const estPeriods = new Set((e.windows || []).map((w) => w.period))
    for (const w of live) if (!estPeriods.has(w.label)) windows.push(toLiveWindow(w, nowMs, rs))
    windows.sort((a, b) => (a.periodMs || 0) - (b.periodMs || 0))
    return { ...e, windows, source: 'live' }
  })
  for (const [cli, ws] of Object.entries(liveByCli)) {
    if (!ws || !ws.length || covered.has(cli)) continue
    out.push({
      id: `live:${cli}`,
      name: labels[cli] || cli,
      monthlyUsd: 0,
      bindings: [{ cli }],
      windows: ws.map((w) => toLiveWindow(w, nowMs, index?.byCli?.get(cli) || null)),
      renewal: null,
      source: 'live',
      live: true,
    })
  }
  return out
}

// Usage in [fromMs, toMs) grouped by the plan that covers it — the report's
// "By plan" breakdown. Ownership is time-aware via planAssigner (bindings must
// match AND the record must fall inside the plan's billed coverage; overlaps
// go to the most recently started plan); anything no plan owns lands in the
// `unplanned` bucket (pay-as-you-go / unbound / pre-subscription usage).
// `fees` is the actual subscription money charged in the range (cycle starts
// falling inside it).
export function computePlanBreakdown(subs, records, fromMs, toMs, nowMs = Date.now()) {
  const mkBucket = (p, cycles) => ({
    id: p?.id ?? null,
    groupId: p?.groupId || p?.id,
    name: p?.name ?? null,
    active: p ? !!p.active : true,
    monthlyUsd: p ? Number(p.monthlyUsd) || 0 : 0,
    bindings: p?.bindings || [],
    fees: (cycles || []).reduce((a, c) => a + (c.start >= fromMs && c.start < toMs ? c.fee : 0), 0),
    cost: 0,
    tokens: 0,
    turns: 0,
    models: new Map(),
  })
  const { entries, byPlan, unplanned: unplannedRecs } = planRecordIndex(subs, records, nowMs)
  const buckets = new Map(entries.map((e) => [e.sub.id, mkBucket(e.sub, e.cycles)]))
  const unplanned = mkBucket(null, [])

  let totalCost = 0
  const addRec = (r, b) => {
    const cost = costFor(r)
    b.cost += cost
    b.tokens += r.total
    b.turns += r.turns || 1
    totalCost += cost
    const key = r.cli + '|' + r.model
    let m = b.models.get(key)
    if (!m) {
      m = { cli: r.cli, model: r.model, total: 0, cost: 0, turns: 0 }
      b.models.set(key, m)
    }
    m.total += r.total
    m.cost += cost
    m.turns += r.turns || 1
  }
  for (const e of entries) {
    const b = buckets.get(e.sub.id)
    forEachInRange(byPlan.get(e.sub.id), fromMs, toMs, (r) => addRec(r, b))
  }
  forEachInRange(unplannedRecs, fromMs, toMs, (r) => addRec(r, unplanned))

  const finish = ({ models, ...b }) => ({
    ...b,
    models: [...models.values()].sort((a, x) => x.total - a.total),
  })
  return {
    totalCost,
    plans: groupPlanBuckets([...buckets.values()].map(finish)),
    unplanned: finish(unplanned),
  }
}
