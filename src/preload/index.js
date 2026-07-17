const { contextBridge, ipcRenderer } = require('electron')

// Minimal, explicit bridge between the renderer UI and the main process.
contextBridge.exposeInMainWorld('api', {
  // popup
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  onSnapshot: (cb) => {
    const handler = (_e, snap) => cb(snap)
    ipcRenderer.on('snapshot', handler)
    return () => ipcRenderer.removeListener('snapshot', handler)
  },
  openDataDir: (cli) => ipcRenderer.invoke('open-data-dir', cli),
  hide: () => ipcRenderer.send('hide-window'),
  quit: () => ipcRenderer.send('quit-app'),
  openReport: () => ipcRenderer.send('open-report'),
  openSettings: () => ipcRenderer.send('open-settings'),

  // report window
  reportHourly: (dayStartMs) => ipcRenderer.invoke('report:hourly', dayStartMs),
  reportDaily: (fromMs, toMs) => ipcRenderer.invoke('report:daily', fromMs, toMs),
  reportModels: (fromMs, toMs) => ipcRenderer.invoke('report:models', fromMs, toMs),
  reportRequests: (opts) => ipcRenderer.invoke('report:requests', opts),
  reportProjects: (fromMs, toMs) => ipcRenderer.invoke('report:projects', fromMs, toMs),
  reportSpan: () => ipcRenderer.invoke('report:span'),
  // opts: { which: 'report' | 'popup', mode: 'save' | 'copy' }
  exportPng: (opts) => ipcRenderer.invoke('export-png', opts),
  onReportUpdated: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('report-updated', handler)
    return () => ipcRenderer.removeListener('report-updated', handler)
  },

  // settings window — multi-provider LiteLLM configuration
  litellmListProviders: () => ipcRenderer.invoke('litellm:list-providers'),
  litellmSaveProvider: (provider) => ipcRenderer.invoke('litellm:save-provider', provider),
  litellmDeleteProvider: (id) => ipcRenderer.invoke('litellm:delete-provider', id),
  litellmListModels: (conn) => ipcRenderer.invoke('litellm:list-models', conn),
  litellmGetModelSettings: (providerId) => ipcRenderer.invoke('litellm:get-model-settings', providerId),
  litellmSaveModelSetting: (setting) => ipcRenderer.invoke('litellm:save-model-setting', setting),

  // subscription plans — monthly flat fees vs actual usage cost
  subsList: () => ipcRenderer.invoke('subs:list'),
  subsSave: (sub) => ipcRenderer.invoke('subs:save', sub),
  subsDelete: (id) => ipcRenderer.invoke('subs:delete', id),
  subsStats: () => ipcRenderer.invoke('subs:stats'),
  // rolling quota-reset windows (popup countdown)
  subsResets: () => ipcRenderer.invoke('subs:resets'),
  // Codex's own reported plan-quota windows (used %, reset time) from its logs
  codexLimits: () => ipcRenderer.invoke('codex:limits'),
  subsBreakdown: (fromMs, toMs) => ipcRenderer.invoke('subs:breakdown', fromMs, toMs),
  subsTimeline: (fromMs, toMs) => ipcRenderer.invoke('subs:timeline', fromMs, toMs),
})
