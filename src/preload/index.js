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

  // report window
  reportHourly: (dayStartMs) => ipcRenderer.invoke('report:hourly', dayStartMs),
  reportDaily: (fromMs, toMs) => ipcRenderer.invoke('report:daily', fromMs, toMs),
  reportModels: (fromMs, toMs) => ipcRenderer.invoke('report:models', fromMs, toMs),
  reportRequests: (opts) => ipcRenderer.invoke('report:requests', opts),
  reportProjects: (fromMs, toMs) => ipcRenderer.invoke('report:projects', fromMs, toMs),
  reportSpan: () => ipcRenderer.invoke('report:span'),
  exportPng: () => ipcRenderer.invoke('export-png'),
  onReportUpdated: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('report-updated', handler)
    return () => ipcRenderer.removeListener('report-updated', handler)
  },
})
