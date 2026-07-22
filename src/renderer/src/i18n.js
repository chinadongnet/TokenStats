import { useEffect, useState } from 'react'

// Lightweight, dependency-free i18n for the three renderer windows (popup,
// report, settings). The renderer can't import from the main process, so this
// is self-contained. Language is stored in localStorage for instant, no-flash
// switching; the three BrowserWindows share one origin, so a `storage` event
// syncs them, and the main process is told too (window.api.setLanguage) so the
// native tray menu follows along. Currency stays USD in every language.

const STORE_KEY = 'tokenstats.lang'
export const LANGS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '简体中文' },
]

const en = {
  // shared
  'common.today': 'Today',
  'common.7d': '7d',
  'common.all': 'All',
  'common.day': 'Day',
  'common.week': 'Week',
  'common.month': 'Month',
  'common.tokens': 'tokens',
  'common.est': 'est',
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.cancel': 'Cancel',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.models': 'models',
  'common.model': 'model',
  'common.months': 'months',
  'common.month': 'month',
  'common.deletedProvider': '(deleted provider)',
  'unit.d': 'd',
  'unit.h': 'h',
  'unit.m': 'm',
  'unit.lt1m': '<1m',
  'unit.sAgo': '{n}s ago',
  'unit.mAgo': '{n}m ago',
  'unit.hAgo': '{n}h ago',
  'unit.dAgo': '{n}d ago',
  'reset.5h': '5h',
  'reset.weekly': 'wk',
  'reset.monthly': 'mo',

  // popup (App.jsx)
  'app.scanning': 'Scanning CLI logs…',
  'app.reportTitle': 'Token report',
  'app.settingsTitle': 'Settings',
  'app.screenshot': 'Screenshot',
  'app.refresh': 'Refresh',
  'app.hide': 'Hide',
  'app.quit': 'Quit',
  'app.copyClipboard': 'Copy to clipboard',
  'app.savePng': 'Save as PNG…',
  'app.copied': 'Copied ✓',
  'app.subsPerMo': 'subs',
  'app.subsTip': 'Total monthly fee of active subscriptions',
  'app.perMo': '/mo',
  'app.noUsageRange': 'No usage in this range yet.',
  'app.live': 'live',
  'app.liveQuotaTip': "Live quota from {label}'s own usage report",
  'app.noActivity': 'No activity yet',
  'app.openDataFolder': 'Open data folder',
  'app.built': 'built {time}',
  'app.usedLeft': '{used}% used — {left}% left',
  'app.noResetTime': 'no reset time',
  'app.nextCycle': 'next cycle {time} ({dur})',
  'app.renews': 'renews',
  'app.renewsTip': 'Renews {time} · ${usd}/mo',
  'app.scopeDay': 'Today (since midnight)',
  'app.scopeWeek': 'This week (since Monday)',
  'app.scopeMonth': 'This calendar month',
  'app.rateTip':
    '{tokens} tokens in this {period} window · ${cost} of usage at pay-as-you-go rates vs ${fee} of the plan fee covering the same span — {pct}% of what it costs you',
  'app.noFee': '{tokens} tokens · ${cost} of usage in this window (no fee to compare)',
  'app.vsFee': 'vs',
  'app.cycleValue': 'used ${cost}',
  'app.cycleValueTip':
    'This billing cycle: ${cost} of usage at pay-as-you-go rates against the ${usd} fee — {pct}% of what you pay',

  // settings (Settings.jsx)
  'set.title': 'Settings',
  'set.appSection': 'App',
  'set.language': 'Language',
  'set.languageHint': 'Interface language (currency stays in USD)',
  'set.agyQuota': 'Antigravity (agy) live quota',
  'set.agyQuotaOn': 'Track agy quota',
  'set.agyQuotaHint': "Adds a statusLine hook to agy that mirrors its /usage quota into TokenStats, so the popup can show a live Gemini quota card. Refreshes whenever you run agy. Doesn't touch a statusLine you set yourself.",
  'set.agyNotFound': 'agy CLI not detected — no ~/.gemini/antigravity-cli/settings.json.',
  'set.agyForeign': 'agy already has a custom statusLine — TokenStats won’t overwrite it.',
  'set.agyEnabledWaiting': 'Enabled — run agy once to populate the quota.',
  'set.agyEnabledFresh': 'Enabled — quota updated {mins} min ago.',
  'set.agyEnabledStale': 'Enabled — last quota update {mins} min ago (run agy to refresh).',
  'set.tokenPlans': 'Token plans',
  'set.addPlan': '+ Add plan',
  'set.noPlans': 'No token plans yet. Add your monthly plans (Claude, ChatGPT, Google AI, Cursor, a LiteLLM token plan…) to compare what you pay with what your usage is actually worth.',
  'set.perMo': '/mo',
  'set.ended': '(ended {date})',
  'set.deactivate': 'Deactivate',
  'set.reactivate': 'Reactivate',
  'set.since': 'since {date}',
  'set.noSources': 'no sources bound',
  'set.quotaResets': 'quota resets {list}',
  'set.billed': 'billed {n} {unit}',
  'set.paid': 'paid ${usd}',
  'set.usageWorth': 'usage worth ${usd}',
  'set.deletePlanConfirm': 'Delete token plan "{name}"? Its billing history stats will disappear.',
  'set.litellmProviders': 'LiteLLM providers',
  'set.addProvider': '+ Add provider',
  'set.noProviders': 'No LiteLLM providers configured yet. Click "+ Add provider" to track a proxy\'s usage.',
  'set.disabled': '(disabled)',
  'set.hideModels': 'Hide models',
  'set.modelsBtn': 'Models',
  'set.disable': 'Disable',
  'set.enable': 'Enable',
  'set.syncsEvery': '{url} · syncs every {min} min',
  'set.deleteProviderConfirm': 'Delete provider "{name}"? TokenStats will stop tracking its usage.',
  'set.footer': 'TokenStats v{ver} · provider keys stored locally in ~/.tokenstats/usage.sqlite',
  // sub form
  'set.name': 'Name',
  'set.namePlaceholderPlan': 'e.g. Claude Max',
  'set.preset': 'Preset',
  'set.pick': 'Pick…',
  'set.usdMonth': 'USD / month',
  'set.startDate': 'Start date',
  'set.status': 'Status',
  'set.activeBills': 'active (bills monthly)',
  'set.endDate': 'End date',
  'set.quotaPick': 'Token quota resets (pick any that apply)',
  'set.reset5h': '5 hours',
  'set.resetWeekly': 'Weekly',
  'set.resetMonthly': 'Monthly',
  'set.hintRolling': 'rolling',
  'set.hintFixedTime': 'fixed time',
  'set.hintFixedDay': 'fixed day',
  'set.weeklyResetsAt': 'Weekly resets at',
  'set.monthlyResetsOn': 'Monthly resets on',
  'set.weeklyHint': 'Repeats every 7 days from this moment — set it to when your provider actually resets.',
  'set.monthlyHint': 'Only the day-of-month matters; clamped in short months (a 31st anchor resets Feb 28).',
  'set.quotaNote': 'These are token quota resets — separate from the billing date above, and each is counted on its own clock. 5h is rolling: it opens on your first request after the previous one expires (Claude\'s rate limit), so there\'s nothing to set.',
  'set.countsFrom': 'Counts usage from',
  'set.litellmTag': 'LiteLLM',
  'set.keyAliasLabel': 'Key alias filter (single token key; empty = all keys)',
  'set.keyAliasPlaceholder': 'e.g. mimo-plan',
  'set.loadingModels': 'Loading models…',
  'set.reloadModels': 'Reload models',
  'set.loadModelsFilter': 'Load models to filter',
  'set.modelsSelected': '{n} {unit} selected',
  'set.allModelsCounted': 'all models counted',
  'set.failed': 'Failed: {error}',
  'set.filteredTo': 'filtered to: {list}',
  // provider form
  'set.namePlaceholderProvider': 'e.g. Work LiteLLM',
  'set.color': 'Color',
  'set.syncMin': 'Sync (min)',
  'set.baseUrl': 'Base URL',
  'set.adminKey': 'Admin API key',
  'set.testConn': 'Test connection',
  'set.testing': 'Testing…',
  'set.testOk': 'OK — {count} {unit} found',
  // model list
  'set.modelsSeen': '{n} {unit} seen in the last 35 days',
  'set.refresh': 'Refresh',
  'set.noProviderUsage': 'No usage found for this provider yet.',
  'set.failedLoadModels': 'Failed to load models: {error}',
  'set.retry': 'Retry',
  'set.showInApp': 'Show in TokenStats',
  'set.displayNamePlaceholder': 'display name (optional)',

  // report (Report.jsx)
  'rep.title': 'Token Report',
  'rep.charts': 'Charts',
  'rep.byHour': 'By hour',
  'rep.logs': 'Logs',
  'rep.tokenPlans': 'Token Plans',
  'rep.last': 'Last {r}',
  'rep.copy': '⧉ Copy',
  'rep.copied': 'Copied ✓',
  'rep.exportPng': '⤓ Export PNG',
  'rep.exporting': 'Exporting…',
  'rep.footer': 'TokenStats v{ver} · built {built} · SQLite {span} · ~/.tokenstats/usage.sqlite',
  'rep.spanSince': 'since {date}',
  'rep.spanEmpty': '(empty)',
  // tiles
  'rep.todaysTokens': "Today's tokens",
  'rep.tokens': 'Tokens',
  'rep.estCost': 'Est. cost',
  'rep.roughEstimate': 'rough estimate',
  'rep.turns': 'Turns',
  'rep.modelResponses': 'model responses',
  'rep.activeHours': 'Active hours',
  'rep.withUsage': 'with usage',
  'rep.tokensRange': 'Tokens (range)',
  'rep.usageWorthEst': 'usage worth, rough estimate',
  'rep.planFees': 'Plan fees',
  'rep.subsBilledRange': 'subscriptions billed in range',
  'rep.activeDays': 'Active days',
  // charts / breakdown
  'rep.byHourTitle': 'By hour — {label}',
  'rep.dailyTrend': 'Daily trend — {label}',
  'rep.byPlan': 'By plan',
  'rep.byModel': 'By model',
  'rep.byProject': 'By project',
  'rep.noUsageRange': 'No usage in this range.',
  'rep.noUsageAddPlans': 'No usage in this range. Add token plans in Settings to group usage by plan.',
  'rep.noPlanPayg': 'No plan · pay-as-you-go',
  'rep.endedTag': '(ended)',
  'rep.fees': 'fees',
  'rep.worth': 'worth',
  'rep.value': 'value',
  'rep.noChargeRange': 'no charge in range',
  'rep.noChargeTip': 'no billing cycle started inside this range',
  'rep.shareOfWorth': '{share}% of all usage worth in this range',
  'rep.clickHide': 'Click to hide {label}',
  'rep.clickShow': 'Click to show {label}',
  // subs view
  'rep.noPlansAdd': 'No token plans yet — add them in Settings (tray menu → Settings… → Token plans).',
  'rep.activePlans': 'Active plans',
  'rep.usdPerMonth': 'USD / month',
  'rep.totalPaid': 'Total paid',
  'rep.allBilledMonths': 'all billed months',
  'rep.usageWorth': 'Usage worth',
  'rep.estApiCost': 'est. API cost of covered usage',
  'rep.valueLabel': 'Value',
  'rep.worthDivPaid': 'usage worth ÷ paid',
  'rep.feesVsWorthMonth': 'Fees paid vs usage worth — by month, all plans',
  'rep.feePaid': 'Fee paid',
  'rep.usageWorthLegend': 'Usage worth',
  'rep.active': 'active',
  'rep.endedOn': 'ended {date}',
  'rep.moSince': '${usd}/mo · since {date}',
  'rep.noSourcesBound': 'no sources bound',
  'rep.billedMonths': 'billed',
  'rep.paidLabel': 'paid',
  'rep.usageWorthInline': 'usage worth',
  'rep.tokensParen': '({tokens} tokens)',
  'rep.valueInline': 'value',
  'rep.billingCycle': 'Billing cycle',
  'rep.fee': 'Fee',
  'rep.usageWorthCol': 'Usage worth',
  'rep.tokensCol': 'Tokens',
  'rep.valueCol': 'Value',
  'rep.current': '(current)',
  'rep.valueTickTip': 'usage worth is {cr}% of the fee (tick = 100%)',
  'rep.worthFootnote': 'Usage worth is the pricing.js estimate (real spend for LiteLLM sources). Older cycles may be incomplete — only locally available history is counted (LiteLLM syncs the last 35 days).',
  // timeline
  'rep.subTimeline': 'Subscription timeline — {label}',
  'rep.wheelZoom': 'wheel = zoom · drag = pan',
  'rep.noPlansTimeline': 'No token plans yet — add them in Settings to see their timeline.',
  'rep.inViewFees': 'in view: fees',
  'rep.noPlan': 'No plan',
  'rep.feeWord': 'fee',
  'rep.usageWorthWord': 'usage worth',
  'rep.feesPaidWord': 'fees paid',
  'rep.ofFees': 'of fees',
  // plan compare
  'rep.planComparison': 'Plan comparison — tokens & money, all billed history',
  'rep.feesPaid': 'Fees paid',
  'rep.plan': 'Plan',
  'rep.feesVsWorthUsd': 'Fees paid vs usage worth (USD)',
  'rep.paidPer1M': 'Paid $/1M',
  'rep.paidPer1MTip': 'what you actually paid per million tokens on this plan — lower is cheaper',
  // request log
  'rep.logsTitle': 'Logs — {label}',
  'rep.allProviders': 'All providers',
  'rep.requests': '{count} {unit} · {tokens} tokens · {noCache} excl. cache read · {cost}',
  'rep.request': 'request',
  'rep.requestsWord': 'requests',
  'rep.showingFirst': '(showing first {n})',
  'rep.time': 'Time',
  'rep.provider': 'Provider',
  'rep.modelCol': 'Model',
  'rep.session': 'Session',
  'rep.input': 'Input',
  'rep.output': 'Output',
  'rep.total': 'Total',
  'rep.totalMinusR': 'Total −R',
  'rep.totalMinusRTip': 'Total minus cache-read tokens — closer to how CC Switch counts',
  'rep.cost': 'Cost',
  'rep.noRequestsDay': 'No requests on this day.',
}

const zh = {
  // shared
  'common.today': '今天',
  'common.7d': '7天',
  'common.all': '全部',
  'common.day': '日',
  'common.week': '周',
  'common.month': '月',
  'common.tokens': 'tokens',
  'common.est': '预估',
  'common.loading': '加载中…',
  'common.save': '保存',
  'common.saving': '保存中…',
  'common.cancel': '取消',
  'common.edit': '编辑',
  'common.delete': '删除',
  'common.models': '个模型',
  'common.model': '个模型',
  'common.months': '个月',
  'common.month': '个月',
  'common.deletedProvider': '（已删除的提供方）',
  'unit.d': '天',
  'unit.h': '时',
  'unit.m': '分',
  'unit.lt1m': '<1分',
  'unit.sAgo': '{n}秒前',
  'unit.mAgo': '{n}分钟前',
  'unit.hAgo': '{n}小时前',
  'unit.dAgo': '{n}天前',
  'reset.5h': '5时',
  'reset.weekly': '周',
  'reset.monthly': '月',

  // popup
  'app.scanning': '正在扫描 CLI 日志…',
  'app.reportTitle': '用量报表',
  'app.settingsTitle': '设置',
  'app.screenshot': '截图',
  'app.refresh': '刷新',
  'app.hide': '隐藏',
  'app.quit': '退出',
  'app.copyClipboard': '复制到剪贴板',
  'app.savePng': '保存为 PNG…',
  'app.copied': '已复制 ✓',
  'app.subsPerMo': '订阅',
  'app.subsTip': '生效中订阅的每月总费用',
  'app.perMo': '/月',
  'app.noUsageRange': '此时间范围内暂无用量。',
  'app.live': '实时',
  'app.liveQuotaTip': '来自 {label} 自身用量报告的实时配额',
  'app.noActivity': '暂无活动',
  'app.openDataFolder': '打开数据文件夹',
  'app.built': '构建于 {time}',
  'app.usedLeft': '已用 {used}% — 剩余 {left}%',
  'app.noResetTime': '无重置时间',
  'app.nextCycle': '下次重置 {time}（{dur}）',
  'app.renews': '续订',
  'app.renewsTip': '续订时间 {time} · ${usd}/月',
  'app.scopeDay': '今天（从零点起）',
  'app.scopeWeek': '本周（从周一起）',
  'app.scopeMonth': '本自然月',
  'app.rateTip':
    '本{period}周期内 {tokens} tokens · 按量计费约 ${cost}，对应订阅费摊销 ${fee}——相当于所付费用的 {pct}%',
  'app.noFee': '本周期 {tokens} tokens · 按量计费约 ${cost}（无订阅费可对比）',
  'app.vsFee': '对比',
  'app.cycleValue': '已用 ${cost}',
  'app.cycleValueTip': '本计费周期：按量计费约 ${cost}，订阅费 ${usd}——相当于所付费用的 {pct}%',

  // settings
  'set.title': '设置',
  'set.appSection': '应用',
  'set.language': '语言',
  'set.languageHint': '界面语言（货币仍以美元计）',
  'set.agyQuota': 'Antigravity (agy) 实时配额',
  'set.agyQuotaOn': '跟踪 agy 配额',
  'set.agyQuotaHint': '向 agy 添加一个 statusLine 钩子，把它的 /usage 配额镜像到 TokenStats，弹窗即可显示实时 Gemini 配额卡片。每次运行 agy 时刷新。不会覆盖你自己设置的 statusLine。',
  'set.agyNotFound': '未检测到 agy CLI——找不到 ~/.gemini/antigravity-cli/settings.json。',
  'set.agyForeign': 'agy 已设置了自定义 statusLine——TokenStats 不会覆盖它。',
  'set.agyEnabledWaiting': '已启用——运行一次 agy 以填充配额。',
  'set.agyEnabledFresh': '已启用——配额于 {mins} 分钟前更新。',
  'set.agyEnabledStale': '已启用——上次配额更新于 {mins} 分钟前（运行 agy 可刷新）。',
  'set.tokenPlans': '订阅计划',
  'set.addPlan': '+ 添加计划',
  'set.noPlans': '还没有订阅计划。添加你的每月计划（Claude、ChatGPT、Google AI、Cursor、LiteLLM token 计划…），对比你的支出与用量的实际价值。',
  'set.perMo': '/月',
  'set.ended': '（已于 {date} 结束）',
  'set.deactivate': '停用',
  'set.reactivate': '重新启用',
  'set.since': '始于 {date}',
  'set.noSources': '未绑定来源',
  'set.quotaResets': '配额重置 {list}',
  'set.billed': '已计费 {n} {unit}',
  'set.paid': '已付 ${usd}',
  'set.usageWorth': '用量价值 ${usd}',
  'set.deletePlanConfirm': '删除订阅计划“{name}”？其计费历史统计将消失。',
  'set.litellmProviders': 'LiteLLM 提供方',
  'set.addProvider': '+ 添加提供方',
  'set.noProviders': '还没有配置 LiteLLM 提供方。点击“+ 添加提供方”来跟踪某个代理的用量。',
  'set.disabled': '（已禁用）',
  'set.hideModels': '隐藏模型',
  'set.modelsBtn': '模型',
  'set.disable': '禁用',
  'set.enable': '启用',
  'set.syncsEvery': '{url} · 每 {min} 分钟同步',
  'set.deleteProviderConfirm': '删除提供方“{name}”？TokenStats 将停止跟踪其用量。',
  'set.footer': 'TokenStats v{ver} · 提供方密钥本地保存在 ~/.tokenstats/usage.sqlite',
  // sub form
  'set.name': '名称',
  'set.namePlaceholderPlan': '例如 Claude Max',
  'set.preset': '预设',
  'set.pick': '选择…',
  'set.usdMonth': '美元 / 月',
  'set.startDate': '开始日期',
  'set.status': '状态',
  'set.activeBills': '生效中（按月计费）',
  'set.endDate': '结束日期',
  'set.quotaPick': 'Token 配额重置（勾选适用项）',
  'set.reset5h': '5 小时',
  'set.resetWeekly': '每周',
  'set.resetMonthly': '每月',
  'set.hintRolling': '滚动',
  'set.hintFixedTime': '固定时间',
  'set.hintFixedDay': '固定日期',
  'set.weeklyResetsAt': '每周重置于',
  'set.monthlyResetsOn': '每月重置于',
  'set.weeklyHint': '从这一刻起每 7 天重复一次——设置为你的提供方实际重置的时间。',
  'set.monthlyHint': '只看每月的第几天；短月份会被截断（锚定 31 号时 2 月按 28 号重置）。',
  'set.quotaNote': '这些是 token 配额重置——与上面的计费日期相互独立，各自按自己的时钟计算。5h 是滚动的：它在上一个窗口过期后你的第一次请求时开启（Claude 的速率限制），所以无需设置。',
  'set.countsFrom': '统计以下来源的用量',
  'set.litellmTag': 'LiteLLM',
  'set.keyAliasLabel': 'Key 别名过滤（单个 token key；留空 = 所有 key）',
  'set.keyAliasPlaceholder': '例如 mimo-plan',
  'set.loadingModels': '加载模型中…',
  'set.reloadModels': '重新加载模型',
  'set.loadModelsFilter': '加载模型以过滤',
  'set.modelsSelected': '已选 {n} {unit}',
  'set.allModelsCounted': '统计所有模型',
  'set.failed': '失败：{error}',
  'set.filteredTo': '已过滤为：{list}',
  // provider form
  'set.namePlaceholderProvider': '例如 Work LiteLLM',
  'set.color': '颜色',
  'set.syncMin': '同步（分钟）',
  'set.baseUrl': 'Base URL',
  'set.adminKey': 'Admin API 密钥',
  'set.testConn': '测试连接',
  'set.testing': '测试中…',
  'set.testOk': '成功 — 找到 {count} {unit}',
  // model list
  'set.modelsSeen': '最近 35 天内出现 {n} {unit}',
  'set.refresh': '刷新',
  'set.noProviderUsage': '该提供方暂无用量记录。',
  'set.failedLoadModels': '加载模型失败：{error}',
  'set.retry': '重试',
  'set.showInApp': '在 TokenStats 中显示',
  'set.displayNamePlaceholder': '显示名称（可选）',

  // report
  'rep.title': '用量报表',
  'rep.charts': '图表',
  'rep.byHour': '按小时',
  'rep.logs': '日志',
  'rep.tokenPlans': '订阅计划',
  'rep.last': '近 {r}',
  'rep.copy': '⧉ 复制',
  'rep.copied': '已复制 ✓',
  'rep.exportPng': '⤓ 导出 PNG',
  'rep.exporting': '导出中…',
  'rep.footer': 'TokenStats v{ver} · 构建于 {built} · SQLite {span} · ~/.tokenstats/usage.sqlite',
  'rep.spanSince': '自 {date}',
  'rep.spanEmpty': '（空）',
  // tiles
  'rep.todaysTokens': '今日 tokens',
  'rep.tokens': 'Tokens',
  'rep.estCost': '预估费用',
  'rep.roughEstimate': '粗略估算',
  'rep.turns': '轮次',
  'rep.modelResponses': '模型回复数',
  'rep.activeHours': '活跃小时',
  'rep.withUsage': '有用量',
  'rep.tokensRange': 'Tokens（范围）',
  'rep.usageWorthEst': '用量价值，粗略估算',
  'rep.planFees': '计划费用',
  'rep.subsBilledRange': '范围内计费的订阅',
  'rep.activeDays': '活跃天数',
  // charts / breakdown
  'rep.byHourTitle': '按小时 — {label}',
  'rep.dailyTrend': '每日趋势 — {label}',
  'rep.byPlan': '按计划',
  'rep.byModel': '按模型',
  'rep.byProject': '按项目',
  'rep.noUsageRange': '此范围内暂无用量。',
  'rep.noUsageAddPlans': '此范围内暂无用量。在设置中添加订阅计划以按计划分组用量。',
  'rep.noPlanPayg': '无计划 · 按量付费',
  'rep.endedTag': '（已结束）',
  'rep.fees': '费用',
  'rep.worth': '价值',
  'rep.value': '价值比',
  'rep.noChargeRange': '范围内无计费',
  'rep.noChargeTip': '此范围内没有开始的计费周期',
  'rep.shareOfWorth': '占此范围内全部用量价值的 {share}%',
  'rep.clickHide': '点击隐藏 {label}',
  'rep.clickShow': '点击显示 {label}',
  // subs view
  'rep.noPlansAdd': '还没有订阅计划——在设置中添加（托盘菜单 → 设置… → 订阅计划）。',
  'rep.activePlans': '生效中计划',
  'rep.usdPerMonth': '美元 / 月',
  'rep.totalPaid': '累计已付',
  'rep.allBilledMonths': '所有已计费月份',
  'rep.usageWorth': '用量价值',
  'rep.estApiCost': '所覆盖用量的预估 API 费用',
  'rep.valueLabel': '价值比',
  'rep.worthDivPaid': '用量价值 ÷ 已付',
  'rep.feesVsWorthMonth': '费用支出 vs 用量价值 — 按月，所有计划',
  'rep.feePaid': '已付费用',
  'rep.usageWorthLegend': '用量价值',
  'rep.active': '生效中',
  'rep.endedOn': '已于 {date} 结束',
  'rep.moSince': '${usd}/月 · 始于 {date}',
  'rep.noSourcesBound': '未绑定来源',
  'rep.billedMonths': '已计费',
  'rep.paidLabel': '已付',
  'rep.usageWorthInline': '用量价值',
  'rep.tokensParen': '（{tokens} tokens）',
  'rep.valueInline': '价值比',
  'rep.billingCycle': '计费周期',
  'rep.fee': '费用',
  'rep.usageWorthCol': '用量价值',
  'rep.tokensCol': 'Tokens',
  'rep.valueCol': '价值比',
  'rep.current': '（当前）',
  'rep.valueTickTip': '用量价值是费用的 {cr}%（刻度 = 100%）',
  'rep.worthFootnote': '用量价值是 pricing.js 的估算（LiteLLM 来源为实际支出）。较早的周期可能不完整——仅统计本地可用的历史（LiteLLM 同步最近 35 天）。',
  // timeline
  'rep.subTimeline': '订阅时间线 — {label}',
  'rep.wheelZoom': '滚轮 = 缩放 · 拖动 = 平移',
  'rep.noPlansTimeline': '还没有订阅计划——在设置中添加以查看其时间线。',
  'rep.inViewFees': '视图内：费用',
  'rep.noPlan': '无计划',
  'rep.feeWord': '费用',
  'rep.usageWorthWord': '用量价值',
  'rep.feesPaidWord': '费用支出',
  'rep.ofFees': '占费用',
  // plan compare
  'rep.planComparison': '计划对比 — tokens 与金额，全部计费历史',
  'rep.feesPaid': '费用支出',
  'rep.plan': '计划',
  'rep.feesVsWorthUsd': '费用支出 vs 用量价值（美元）',
  'rep.paidPer1M': '每百万付费$',
  'rep.paidPer1MTip': '此计划下你每百万 tokens 实际支付的金额——越低越划算',
  // request log
  'rep.logsTitle': '日志 — {label}',
  'rep.allProviders': '所有提供方',
  'rep.requests': '{count} {unit} · {tokens} tokens · {noCache} 不含缓存读取 · {cost}',
  'rep.request': '个请求',
  'rep.requestsWord': '个请求',
  'rep.showingFirst': '（显示前 {n} 条）',
  'rep.time': '时间',
  'rep.provider': '提供方',
  'rep.modelCol': '模型',
  'rep.session': '会话',
  'rep.input': '输入',
  'rep.output': '输出',
  'rep.total': '总计',
  'rep.totalMinusR': '总计 −R',
  'rep.totalMinusRTip': '总计减去缓存读取的 tokens——更接近 CC Switch 的计数方式',
  'rep.cost': '费用',
  'rep.noRequestsDay': '这一天没有请求。',
}

const dicts = { en, zh }

let hadStored = false
function detect() {
  try {
    const s = localStorage.getItem(STORE_KEY)
    if (s === 'en' || s === 'zh') {
      hadStored = true
      return s
    }
  } catch {
    // ignore
  }
  return 'en'
}

let current = detect()
const listeners = new Set()

function notify() {
  for (const fn of listeners) fn(current)
}

export function getLang() {
  return current
}

export function setLang(l) {
  if ((l !== 'en' && l !== 'zh') || l === current) return
  current = l
  try {
    localStorage.setItem(STORE_KEY, l)
  } catch {
    // ignore
  }
  // Tell the main process so the native tray menu follows (best-effort).
  try {
    window.api?.setLanguage?.(l)
  } catch {
    // ignore
  }
  notify()
}

// t('key', { param: value }) — falls back to English, then the raw key.
export function t(key, params) {
  let s = dicts[current]?.[key] ?? en[key] ?? key
  if (params) {
    for (const k in params) s = s.split('{' + k + '}').join(String(params[k]))
  }
  return s
}

// Cross-window sync: the three BrowserWindows share one localStorage origin, so
// a change in one fires `storage` in the others.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY && (e.newValue === 'en' || e.newValue === 'zh') && e.newValue !== current) {
      current = e.newValue
      notify()
    }
  })
  // Backup path: main broadcasts the change to every window (in case a
  // storage event is missed).
  try {
    window.api?.onLanguage?.((l) => {
      if ((l === 'en' || l === 'zh') && l !== current) {
        current = l
        try {
          localStorage.setItem(STORE_KEY, l)
        } catch {
          // ignore
        }
        notify()
      }
    })
  } catch {
    // ignore
  }
  // First load with no local choice yet: adopt the language persisted in
  // config.json (what the tray menu uses) so all surfaces start in step.
  if (!hadStored) {
    try {
      // The invoke can reject if main hasn't registered the handler yet (it
      // registers before loading the window, but a rejection here must never
      // become an unhandled one — and one retry costs nothing).
      const adopt = (l) => {
        if ((l === 'en' || l === 'zh') && l !== current) {
          current = l
          try {
            localStorage.setItem(STORE_KEY, l)
          } catch {
            // ignore
          }
          notify()
        }
      }
      const ask = () => window.api.getLanguage()
      ask()
        .then(adopt)
        .catch(() => {
          setTimeout(() => {
            try {
              ask().then(adopt).catch(() => {})
            } catch {
              // ignore
            }
          }, 500)
        })
    } catch {
      // ignore
    }
  }
}

// Subscribe a component to language changes; returns the current lang, the
// setter, and a bound t() so the whole tree re-renders on switch.
export function useLang() {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])
  return { lang: current, setLang, t }
}
