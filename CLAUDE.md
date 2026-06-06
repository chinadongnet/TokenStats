# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TokenStatus is a Windows system-tray app that tracks token usage across three local
AI coding CLIs — **Claude Code**, **Codex**, and **Gemini** — by parsing the
transcript/log files each CLI writes to disk. It watches those files live and shows
per-CLI / per-model / per-day token counts and rough cost estimates in a tray popup.

There is no network, account, or API involved: all data comes from reading local files.

## Commands

```bash
npm install            # install deps (electron, vite, react, chokidar)
npm run dev            # electron-vite dev server with HMR (launches the app)
npm run build          # bundle main + preload + renderer into out/
npm start              # preview the production build
npm run test:parsers   # HEADLESS: parse real local CLI data, print a snapshot to stdout
npm run test:db        # HEADLESS: ingest real data into a temp .sqlite, run report queries
npm run package        # build + electron-builder -> Windows NSIS installer
```

`npm run test:parsers` is the fastest feedback loop — it runs the entire parsing/
aggregation engine against the real `~/.claude`, `~/.codex`, `~/.gemini` data with no
Electron/GUI, and prints totals. Use it after any change to `src/main/core/**`.

To smoke-test the actual app headlessly (boots Electron, then exits): launch
`node_modules/electron/dist/electron.exe . --no-sandbox`, wait a few seconds, confirm
the process stays alive and stderr is empty, then kill it.

## Architecture

The codebase is split into a **pure-Node parsing engine** and an **Electron shell**.
Keep them separate: `src/main/core/**` must not import `electron`, so it stays unit-
testable via `npm run test:parsers`.

### Parsing engine — `src/main/core/`

- **`parsers/{claude,codex,gemini}.js`** — one module per CLI. Each declares its
  `roots` array (from `CLI_ROOTS`), a `kind` (`'jsonl'` append-only, or `'json'`
  whole-file), a `match(file)` predicate, and either `parseLine(line, state, file)`
  (jsonl) or `parseFile(text, file)` (json). Each returns *normalized records* (below).
  Gemini ships two parser objects (`geminiJsonl` + `geminiJson`) sharing one root.
- **`store.js`** — the engine core. Walks each root, reads files, and holds an
  in-memory index `Map<path, {parser, size, mtimeMs, state, records[]}>`.
  - JSONL files (Claude, Codex) are **tailed incrementally** from the last byte
    offset; if a file shrinks it re-reads from 0. `state` persists across lines of one
    file (Codex needs it to carry the current model/cwd between turns).
  - Gemini ships **two** chat formats: current `chats/session-*.jsonl` (append-only,
    tailed like the others) and older `chats/session-*.json` (whole-file, re-parsed on
    change). Both are registered as separate parsers sharing the Gemini root.
  - `snapshot()` aggregates all records into per-CLI / per-model / per-day buckets,
    today-vs-all-time, recent sessions, and the current "live" model. This is the only
    object the UI consumes.
  - `start()` does the initial scan, then sets up `chokidar` watchers and emits
    debounced `'update'` events (400ms) carrying a fresh snapshot.
- **`pricing.js`** — rough USD-per-million-token table, matched by model-id substring.
  Cost figures are **estimates**, clearly labelled in the UI; edit the table freely.
- **`db.js`** — SQLite (via `sql.js` WASM, no native build) persistence of **hourly**
  usage buckets at `~/.tokenstatus/usage.sqlite`. `UsageDb.ingest(records)` re-aggregates
  the full record set into one row per `(local-hour, cli, model)` and **replaces** the
  table (so it never drifts from the parsers), then exports the DB to disk. Query helpers
  `hourly(dayStart)`, `daily(from,to)`, `models(from,to)`, `span()` feed the report.
  Stays pure-Node (loads the wasm via `wasmBinary`), so it's testable with
  `node scripts/test-db.mjs`.
- **`paths.js`** — resolves the data roots and reads user config. Each CLI has an
  array of roots (`CLI_ROOTS[cli]`): the local dir first (overridable via `AIMON_*_ROOT`
  env vars), then any **extra dirs** listed under `extraRoots` in
  `~/.tokenstatus/config.json` (override path via `AIMON_CONFIG`). Extra roots are how
  **other devices' usage is merged** — copy another machine's `.codex/.gemini/.claude`
  data folder locally and add its path. `ensureConfigFile()` writes a template on first
  run. Also exposes per-CLI display metadata (label, color, primary root).

### Normalized record

Every parser emits records of this exact shape so aggregation is CLI-agnostic:

```
{ cli, ts, model, sessionId, project,
  input, output, cacheRead, cacheCreate, reasoning, total }
```

`total` is the headline token count and is computed per-CLI to be comparable:
- Claude: `input + output + cache_creation + cache_read`
- Codex: the event's `total_tokens` (already includes cached input + reasoning)
- Gemini: the message's `tokens.total`

`input` is stored as the *non-cached* portion for Codex/Gemini so the components don't
double-count `cacheRead`.

### Electron shell — `src/main/`

- **`index.js`** — app entry. Creates the frameless, `skipTaskbar`, always-on-top
  popup `BrowserWindow` (hidden until the tray is clicked, hides on blur), the `Tray`,
  and wires `store` `'update'` events to `webContents.send('snapshot', …)` and tray
  tooltip/color. IPC handlers are registered **before** `store.start()` so the renderer
  never races a missing `get-snapshot` handler during the initial scan.
- **`trayIcon.js`** — renders the tray icon at runtime as a raw BGRA bitmap
  (`nativeImage.createFromBitmap`) so no image asset files are needed; recolored by the
  most recently active CLI.
- **`src/preload/index.js`** — CommonJS (`require`) contextBridge exposing
  `window.api`: `getSnapshot`, `onSnapshot`, `openDataDir`, `hide`, `quit`. Built to
  `out/preload/index.cjs`; `index.js` references it by the `.cjs` extension.

  Main also owns the **SQLite ingest** (throttled to ≤ once / 4s via `scheduleIngest`,
  forced on report open and manual refresh), the **report window** (`openReport` — a
  normal resizable window loading the renderer with `#report`), and **PNG export**
  (`exportReportPng` grows the window to full content height, `capturePage()`, then a
  save dialog). Set `AIMON_AUTO_REPORT=1` to auto-open the report on launch for testing.

### Renderer — `src/renderer/`

React + Vite, two views selected by URL hash in `main.jsx`:
- **`App.jsx`** — the tray popup. Reads the snapshot via `window.api`, subscribes to live
  updates, renders the hero total, per-CLI bars, top models, recent sessions, live
  indicator. Header has a Report button (`window.api.openReport()`).
- **`Report.jsx`** (`#report`) — the usage report window. Pulls hourly/daily/model data
  from the SQLite DB via IPC and draws hand-rolled **SVG stacked-bar charts** (no chart
  lib): by-hour for a chosen day, daily trend over a range (7d/30d/all), per-model
  breakdown, summary tiles. The **Export PNG** button calls `window.api.exportPng()`.
No router, no state library.

## Conventions and gotchas

- **`"type": "module"`** — the whole project is ESM. The standalone test script is
  `.mjs`; the preload is emitted as CommonJS `.cjs` (sandbox requires `require`).
- **Adding a CLI**: add `parsers/<cli>.js` implementing the parser contract, register
  it in `store.js`'s `PARSERS` array, add metadata in `paths.js` and `App.jsx`'s `CLI`/
  `ORDER`, and a pricing row. Nothing else needs to change.
- **Data formats are version-specific**: these parsers were written against observed
  on-disk shapes (Claude `message.usage`, Codex `event_msg`/`token_count`
  `last_token_usage`, Gemini `gemini`-type messages' `tokens`). A CLI update can change
  them — e.g. Gemini switched chat logs from `.json` to `.jsonl`, which is why both are
  parsed. Validate with `npm run test:parsers` against real data after any CLI update.
- Codex token math uses `last_token_usage` (per-turn delta), **not**
  `total_token_usage` (cumulative), to avoid double-counting across the session's events.
- "Today" uses the **local** calendar day so it matches the user's wall clock.
