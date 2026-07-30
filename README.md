# TokenStats

A Windows **system-tray** app that tracks token usage across your local AI coding
tools — **Claude Code**, **Codex**, **Gemini**, **Antigravity**, and **Cursor** — plus
any number of self-hosted **LiteLLM** proxies, and shows it at a glance.

It reads the transcript/log files each tool already writes to disk, watches them live,
and surfaces per-CLI / per-model / per-day token counts, cost, and live quota windows
in a popup that drops down from the tray icon.

**Local-first**: everything comes from files on your machine, with four deliberate
exceptions — [Cursor](#cursor-usage-network-fetched) and [LiteLLM](#litellm-providers)
have no usable local usage data at all, [Claude's live quota](#live-quota-windows) is
read by asking the Claude CLI itself, and [cloud sync](#cloud-sync-optional) is opt-in
and off by default.

```
System tray:  [▮ AI] ◄ click
        ┌────────────────────────────────────────┐
        │ TokenStats            [Day|Week|Month] │
        │ 250.67M tokens        plan day share $9│
        │ ┌────────────────────────────────────┐ │
        │ │ ● Claude Code  Claude Max   82.1M  │ │
        │ │   plan day share $4.46      9712%  │ │
        │ │   5h  ▆▆▆▆▆▆▁▁▁▁ 61%     ◷ 3h 12m  │ │
        │ │   wk  ▆▆▆▆▁▁▁▁▁▁ 38%     ◷ Jul 29  │ │
        │ │   ▤ renews 13d · $125.00/mo  3077% │ │
        │ └────────────────────────────────────┘ │
        │ ● live: opus-4.8 · 12s ago             │
        └────────────────────────────────────────┘
```

## Features

- 🟢 **Tray icon + popup** — click the icon for a **Day / Week / Month** breakdown, one
  card per CLI with its top models. The scopes are **calendar-aligned** (since midnight
  / since Monday / since the 1st) so they line up with the cycles a subscription's
  quota actually resets on. The icon recolors to the most recently active CLI.
- ⚡ **Live** — watches `~/.claude`, `~/.codex`, `~/.gemini`,
  `~/.gemini/antigravity-cli` and updates within a second of each turn (file watching,
  debounced); network-backed sources are polled on their own schedules.
- 💳 **Live quota windows** — remaining quota + reset countdown per window
  (5h / weekly / monthly). See [Live quota windows](#live-quota-windows).
- 📈 **Is the plan worth it?** — every monthly plan's fee is compared against what the
  same usage would have cost pay-as-you-go. See
  [Plans and worth](#subscription-plans-and-worth).
- 📊 **Usage report** — a full window with hourly/daily charts, per-plan / per-model /
  per-project breakdowns, a request log, a zoomable plan timeline, and **Export PNG**.
  See [Usage report](#usage-report).
- ⚙️ **LiteLLM providers** — track any number of self-hosted proxies, each with its own
  name, color, sync frequency, and per-model show/hide + rename.
  See [LiteLLM providers](#litellm-providers).
- ☁️ **Cloud sync (opt-in)** — push hourly totals and the popup's status to your own
  [tokenstat-web](#cloud-sync-optional) instance to see several machines in one place.
- ⬆️ **In-app updates** — check, download and install new versions from GitHub
  releases. See [Updates](#updates).
- 💲 **Cost estimates** — USD figures from an editable price table
  (`src/main/core/pricing.js`). LiteLLM is the exception: it reports **real spend**.
- 🌐 **English / 简体中文** — switch the whole UI (and the tray menu) in
  **Settings → App**; amounts stay in USD.

## Data sources

| Source      | Location                                              | Token data | How |
|-------------|-------------------------------------------------------|------------|-----|
| Claude Code | `~/.claude/projects/<cwd>/<session>.jsonl`            | per-message `usage` (input/output/cache) | watched |
| Codex       | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`        | per-turn delta of the cumulative `total_token_usage` | watched |
| Gemini      | `~/.gemini/tmp/<project>/chats/session-*.jsonl` (and older `.json`) | per-message `tokens` | watched |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<uuid>.db` (SQLite) | per-turn usage decoded from a protobuf blob | watched |
| Cursor      | cursor.com usage export — **not** local files         | per-request token counts | fetched, ≤ 1× / 15 min |
| LiteLLM     | your proxy's admin API — **not** local files          | real spend + per-model tokens and request counts | polled, per-provider interval |

Token totals are made comparable across tools: Claude's includes cache creation +
cache reads, Codex uses the authoritative cumulative counter's delta (summing
`last_token_usage` over-counts badly), Gemini uses the message's own total. Claude and
Gemini both write the same usage row to disk repeatedly — roughly **1.8× inflation** if
counted naively — so records carry a dedup key and are de-duplicated before any
aggregation.

## Live quota windows

A plan can declare any subset of **5h / weekly / monthly** quota windows. Only windows
the tool itself reports — **live** ones — get a headroom bar and a draining-clock
countdown:

| Tool | How its live window is obtained |
|------|--------------------------------|
| Codex | rate-limit fields already present in its local logs — free |
| Claude Code | runs `claude -p /usage` and parses the CLI's own usage view, throttled to once every 15 min (spawns the CLI, so it does hit the network) |
| Cursor | a **second** request alongside the usage export (`/api/usage-summary`), which can fail independently — usage numbers may be current while the quota window is stale |
| Antigravity | opt-in statusLine hook — see [Antigravity live quota](#antigravity-live-quota) |

Windows with **no** live source are deliberately **not drawn at all** — an estimated
headroom bar would look authoritative while being guesswork. A plan bound only to such
sources still shows its usage, worth, and billing countdown, just no quota bars. Hover a
live bar for the tokens and cost actually spent inside that window.

**5h is rolling** (it opens on the first request after the previous window expired —
Claude's rate limit — so there is nothing to configure), while **weekly/monthly are
anchored** to a date (and, for weekly, a time) you set per plan.

The billing renewal countdown below the bars is a **separate clock**: quota can reset on
the 20th while the fee bills on the 5th, and neither is derived from the other.

## Subscription plans and worth

Enter your monthly plans in **Settings → Token plans** (presets for Claude, ChatGPT,
Google AI, Cursor, and a LiteLLM token plan), bind each to the sources it covers, and
TokenStats compares the fee against what that usage would have cost pay-as-you-go:

- **Prorated to the scope you're looking at** — month = the fee, week = fee ÷ 4,
  day = fee ÷ 28. Above 100% the plan is paying for itself.
- **Time-aware, exclusive ownership** — a plan only owns usage inside the cycles it
  actually billed, and when an upgrade chain overlaps (an ended "Pro" whose last paid
  cycle runs past the start of its replacement) the more recently started plan wins, so
  nothing is double-counted.
- **Fine-grained bindings** — a LiteLLM binding can be narrowed to one **key alias**
  and to specific models, which is how a token plan sharing a proxy with other keys
  stays isolated. Model filters match the raw model id, so renaming a model in Settings
  never unbinds it.
- Deactivating a plan stamps its end date and stops accruing fees, while keeping its
  history.

## Usage report

Open it from the popup's chart button or the tray menu. It's backed by a local
**SQLite** database (`~/.tokenstats/usage.sqlite`) holding one row per
(hour, CLI, model), re-aggregated from the parsers on every ingest so it can't drift.

- **Charts** — daily trend (7d / 30d / all) as stacked bars, summary tiles including
  actual **plan fees** billed in the range, and a breakdown card with **By plan**
  (default), **By model**, or **By project**.
- **By hour** — hour-by-hour stacked bars for a chosen day.
- **Logs** — the per-request table. LiteLLM is the exception: its admin API has no
  per-request timestamps, so its rows are (day, model, key alias) **aggregates** stamped
  at noon UTC, not individual requests.
- **Token plans** — active $/mo, total paid, usage worth and value %; a **zoomable
  timeline** (a Gantt lane per plan with one fee-labeled segment per billing cycle, a
  per-day usage band colored by owning plan, wheel to zoom / drag to pan); a per-plan
  comparison of fees paid vs usage worth with an effective $/1M-token unit price; a
  fees-vs-worth-by-month chart; and a per-cycle table per plan.
- **Export PNG** — captures the whole scrollable report, not just the visible part.

## Cursor usage (network-fetched)

Cursor's local chat database (`state.vscdb`) writes every message's token count as
zeros in current versions — real usage is tracked **server-side only**, on the
cursor.com dashboard. So instead of parsing local files, TokenStats:

1. Reads the session token the Cursor **IDE itself already stores** after you log in
   (from `state.vscdb`) — no separate API key needed, just be logged into Cursor on
   this machine.
2. Uses that token to call the same (undocumented) usage-export endpoint the
   cursor.com dashboard's **Usage** tab uses, and gets back real per-request token
   counts.

Trade-offs worth knowing:
- It's an **undocumented, reverse-engineered endpoint** — it can break or change
  without notice on a Cursor update.
- Cursor doesn't expose which project/conversation each request belongs to via this
  endpoint, so all Cursor usage is shown under one combined bucket rather than broken
  out per project.
- Fetches are cached and throttled to at most once every 15 minutes, and are re-run on
  app startup, on a 5-minute timer, and from the tray's **Refresh now** (so new Cursor
  usage shows up without needing the Cursor IDE to touch its files).
- If your Cursor session expires, log into the Cursor IDE again to refresh it.
- Cursor's own official **Admin/Analytics API** (`cursor.com/docs/api`) does expose
  proper usage endpoints, but only to **Team/Organization** API keys — an individual
  account's personal API key can't reach them, which is why this endpoint is used
  instead.

For the full technical mechanism (exact endpoint, CSV columns, caching, refresh
cadence) and how the other CLIs compare — including whether their `/usage` quota data
can be synced — see [`docs/usage-data-sources.md`](docs/usage-data-sources.md).

## LiteLLM providers

If you run a self-hosted [LiteLLM](https://docs.litellm.ai/) proxy, TokenStats can
track its usage too — unlike the other tools, LiteLLM has no local footprint at all
(it's a server, not a CLI), so this polls its admin API instead of watching files.

Open **Settings** — the gear icon ⚙ in the tray popup's header, or **Settings…** from
the tray's right-click menu — to add a provider:

- **Name** and **color**, shown as its own row in the popup and report, just like a
  built-in CLI.
- **Base URL** and an **admin/management API key** (not a per-user key).
- **Sync frequency** (minutes) — how often TokenStats polls that proxy.
- Per-model **show/hide** and **rename** — "Models" lists every model the key has
  usage for, including ones the proxy no longer registers (tagged **retired**) so a
  removed model's rows can still be hidden or renamed. That listing comes from recorded
  usage, and LiteLLM usage is only fetched for the **last 35 days**, so a retired model
  drops off the list once its last usage falls outside that window.

Add as many providers as you like (e.g. one per team or per proxy instance); each shows
up as its own independent row everywhere the built-in CLIs do — no code changes needed.
Unlike every other source here, LiteLLM's admin API reports **actual spend**, not a
`pricing.js` estimate, and real request counts. Usage arrives as
(day, model, key-alias) buckets — the API has no per-request timestamps — and the key
alias becomes the record's "project".

Provider configuration (including the API key) is stored locally in
`~/.tokenstats/usage.sqlite`, never sent anywhere except to the proxy you configured.

## Antigravity live quota

Antigravity (`agy`) keeps its remaining quota only in memory — its interactive
`/usage` view is the only place it's shown, and there's no local file or public API to
read it from. To surface it anyway, TokenStats uses agy's **statusLine hook** (the same
mechanism as [Ranteck/agy-statusline](https://github.com/Ranteck/agy-statusline)): agy
pipes its live session state — including per-model-pool quota — as JSON to a configured
command on every render.

Turn it on in **Settings → App → "Track agy quota"**. TokenStats then installs a tiny
hook into agy's own `settings.json` that mirrors that JSON to
`~/.tokenstats/agy_status.json`, and shows the **Gemini** weekly quota (remaining % +
reset countdown) as a live **Antigravity** card in the popup. Notes:

- It refreshes **for free whenever you run the `agy` CLI** — no OAuth, no extra network
  calls, and no quota spent. It won't touch a statusLine you configured yourself, and
  un-checking the toggle removes it cleanly.
- The mirror updates on **`agy` CLI** use, not the Antigravity IDE. The current agy
  version reports weekly (~7-day) pools only, no separate 5-hour window.

## Cloud sync (optional)

**Off by default.** If you run a [tokenstat-web](https://token.chinadong.net) instance,
**Settings → Cloud sync** pushes this machine's usage to it so you can see several
devices in one dashboard: enter the endpoint and a per-device key created on the site,
pick a sync interval, and use **Test connection**, **Sync now**, or **Full resync**.

What leaves the machine is a deliberately narrow contract:

- **Hourly usage rows** — (hour, CLI, model, token component sums, cost, request
  count).
- **A status snapshot** — CLI names/colors, live quota windows, and per plan its
  name, fee, renewal date and **bindings** (which CLIs it covers, plus its model
  allowlist if it has one). The bindings are what let the website redraw the same
  per-card "usage worth vs fee share" line the app popup shows.
- **Never** project paths, session ids, prompt/response content, or **key aliases** —
  a binding's key-alias filter is stripped before the snapshot is sent, and the uploaded
  rows carry no key dimension to apply it to anyway.

Each sync re-pushes a rolling 7-day window (recent hours keep changing) and tells the
server to drop its copy of that window first, so rows that disappear locally — a model
rename, an edited data source — don't linger in the cloud.

## Multiple devices

Two ways to combine machines:

1. **Cloud sync** (above) — each machine pushes to one tokenstat-web instance.
2. **Extra roots** — copy another machine's CLI data folder over (sync drive, network
   share, manual copy) and point TokenStats at it. Right-click the tray → **Edit data
   sources…**, or edit `~/.tokenstats/config.json`:

```json
{
  "extraRoots": {
    "claude": [],
    "codex":  ["D:/from-laptop/.codex/sessions"],
    "gemini": ["D:/from-laptop/.gemini/tmp"],
    "agy":    [],
    "cursor": []
  }
}
```

These folders are scanned and merged into the totals (forward or back slashes both
work). Restart TokenStats after editing. Don't add your own local folders here — that
would double-count. Session files are uniquely named per device, so genuine cross-device
data merges cleanly.

Cursor is the exception: since its usage is fetched from your cursor.com account
(server-side), adding another device's `state.vscdb` as an extra root only matters if
that device is logged into a **different** Cursor account — copying one logged into
the same account just re-fetches identical data (harmless, but redundant).

## Updates

TokenStats ships through its **GitHub releases**. **Settings → App** shows the running
version and build time, and does the update in three explicit, user-driven steps:
check the latest release, download its installer with a progress bar, then install —
which hands off to the (silent) installer and reopens the app on the new version. The
install button is hidden for unpackaged dev builds.

## Architecture

Split into a **pure-Node parsing engine** and an **Electron shell**, so the engine is
testable without a GUI (`src/main/core/**` never imports `electron`).

```
src/main/core/          engine — no electron
  parsers/{claude,codex,gemini,antigravity,cursor}.js   one module per CLI
  parsers/litellm.js    poller factory (no files to watch)
  store.js              file index, incremental tailing, watchers, snapshot()
  db.js                 sql.js (WASM) persistence — hourly usage, providers, plans
  subscriptions.js      billing math, plan ownership, quota windows
  pricing.js            USD-per-million price table (editable)
  paths.js              data roots, config.json, CLI display metadata
  cloudSync.js          push to tokenstat-web
  claudeLimits.js       `claude -p /usage` live-quota probe
src/main/               shell — tray, windows, IPC, updater, agy hook, autostart
src/renderer/src/       React + Vite: App.jsx (popup), Report.jsx, Settings.jsx
```

Every parser emits the same **normalized record**, so aggregation is CLI-agnostic:

```
{ cli, ts, model, sessionId, project,
  input, output, cacheRead, cacheCreate, reasoning, total,
  dedupKey?, cost?, turns?, rawModel? }
```

The optional fields carry what a plain per-request row can't: `dedupKey` for sources
that write the same usage twice, `cost` to override the price-table estimate with real
spend, `rawModel` so a renamed model keeps its identity for plan filters, and `turns`
for **aggregate** sources — one LiteLLM record covers a whole (day, model, key) bucket,
so it reports that bucket's real request count. A record without `turns` counts as one
request, which is why a bucketed source that omits it would silently undercount.

Key points:

- **Two ingestion styles.** File-backed CLIs are watched: JSONL is tailed
  incrementally from the last byte offset, whole-file formats (Gemini's older `.json`,
  Antigravity's SQLite) are re-parsed on change. Sources with nothing on disk
  (LiteLLM) are **pollers** instead, each throttling its own network calls, and their
  records land in the same index so everything downstream is identical.
- **De-duplication is accuracy-critical** — see [Data sources](#data-sources).
  `store.dedupedRecords()` is what feeds the snapshot, the database, and all plan math;
  the raw record list is never aggregated directly.
- **One snapshot object** drives the **tray popup and icon**: per-CLI / per-model
  buckets for day, week, month and all-time, recent sessions, the current live model,
  and the active LiteLLM providers' names/colors. The report and Settings windows do
  *not* consume it — the report reads the hourly SQLite table (plus the live store for
  the request log and per-project totals, which the hourly table has no dimension for),
  and both windows have their own plan / provider / cloud / updater IPC. Don't add
  report or Settings state to the snapshot.
- **LiteLLM providers are dynamic pseudo-CLIs** (`litellm:<id>`), built from database
  rows at runtime rather than hardcoded, and rendered anywhere a built-in CLI is.
- **Schema changes need an explicit migration** — `db.js` only ever
  `CREATE TABLE IF NOT EXISTS`, so new columns are added by an additive, idempotent
  migration step.

See `CLAUDE.md` for the full details, including how to add another CLI.

## Develop

```bash
npm install
npm run dev            # launch with hot reload
npm run test:parsers   # parse your real local data and print totals (no GUI)
npm run test:db        # ingest into a temp SQLite db and run the report queries
```

`npm run test:parsers` is the fastest feedback loop for engine changes. Quit the
installed TokenStats from the tray before `npm run dev` — both share one `userData`
directory, so they share the single-instance lock and dev would exit while the
*installed* window pops up instead.

## Build a Windows installer

```bash
npm run release                 # bump patch, build, NSIS installer, publish to GitHub, reinstall, relaunch
npm run release -- -NoInstall   # same, but stop after writing dist/TokenStats-Setup-*.exe
npm run release -- -NoPublish   # keep it local (no push, no GitHub release)
npm run package                 # unpacked build in dist/win-unpacked (debug aid, NOT an installer)
```

`npm run release` refuses to run on a dirty tree and tags the commit it builds, so every
installer maps to exactly one commit. It also **publishes the GitHub release**, which is
the channel [in-app updates](#updates) read — an unpublished version is invisible to
every other install. `dev`/`build` only refresh `out/`; they never touch the installed
copy Windows autostarts. The running version and its **build time** are shown in the
tray tooltip and the popup/report footers.

## Notes

- Cost numbers are **estimates** — they depend on your plan and current list prices.
  Edit `src/main/core/pricing.js` to match your rates. LiteLLM is exempt: it reports
  real spend.
- Claude's totals include cache-read tokens, which accumulate fast on long sessions;
  that's why its token count dwarfs the others. The breakdown is preserved per record.
- Parsers are written against **observed on-disk shapes** and a CLI update can change
  them (Gemini already moved from `.json` to `.jsonl`). Cursor's endpoint and LiteLLM's
  admin API are undocumented. Re-validate with `npm run test:parsers` after updating a
  CLI.
- All data — usage database, plans, provider keys, config — stays in `~/.tokenstats/`.
