// One-off: render an SVG file to PNG via Electron so it can be eyeballed.
//   electron scripts/rasterize.mjs <in.svg> <out.png>
import fs from 'node:fs'
import { app, BrowserWindow } from 'electron'

const [inPath, outPath] = process.argv.slice(2)
const svg = fs.readFileSync(inPath, 'utf8')
const w = Number((svg.match(/width="(\d+)"/) || [])[1] || 500)
const h = Number((svg.match(/height="(\d+)"/) || [])[1] || 400)

app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true })
  const html = `<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 300))
  const img = await win.capturePage()
  fs.writeFileSync(outPath, img.toPNG())
  console.log('wrote', outPath)
  app.quit()
})
