# TokenStats

A Windows **system-tray** app that tracks token usage across your local AI coding
tools — **Claude Code**, **Codex**, **Gemini**, **Antigravity**, and **Cursor** — plus
any number of self-hosted **LiteLLM** proxies, and shows it at a glance.

It reads the transcript/log files each tool already writes to disk, watches them live,
and surfaces per-CLI / per-model / per-day token counts plus rough cost estimates in a
little popup that drops down from the tray icon. No accounts, no API keys, no network —
**except for Cursor and LiteLLM**, neither of which has real usage data sitting in a
local file; see [Cursor usage](#cursor-usage-the-one-network-exception) and
[LiteLLM providers](#litellm-providers) below.

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
  quota actually resets on.
- ⚡ **Live** — watches `~/.claude`, `~/.codex`, `~/.gemini`, `~/.gemini/antigravity-cli`
  and updates within a second of each turn (via file watching, debounced).
- 💲 **Cost estimates** — rough USD figures from an editable price table (`pricing.js`).
- 🎨 Tray icon recolors to the most recently active CLI.
- 📊 **Usage report** — a full window with **hour-by-hour** and daily charts, per-model
  breakdown, and a one-click **Export PNG**. Backed by a local **SQLite** database
  (`~/.tokenstats/usage.sqlite`) that records usage at hourly granularity per model.
- 💳 **Subscription plans & live quota windows** — enter your monthly plans (Claude,
  ChatGPT, Google AI, Cursor, a LiteLLM token plan…) and each plan's card shows its
  **remaining quota + reset countdown** per window (5h / weekly / monthly). Where a
  tool reports its own quota this is **live** — Claude, Codex, Cursor, and
  **Antigravity** (see [Antigravity live quota](#antigravity-live-quota)) — otherwise
  it's an estimate. Hover a quota bar for the tokens and cost actually spent inside
  that window.
- 📈 **Is the plan worth it?** — a monthly fee is compared against what the same usage
  would have cost pay-as-you-go, **prorated to whatever scope you're looking at**
  (month = the fee, week = fee ÷ 4, day = fee ÷ 28). Each card shows that ratio for
  its plan, the billing row shows it for the current billing cycle, and the top line
  shows all active plans' share for the selected scope. Above 100% the plan is paying
  for itself.
- 🌐 **English / 简体中文** — switch the whole UI language in **Settings → App**
  (amounts stay in USD). The tray menu follows too, and token counts switch counting
  systems with it: **万 / 千万 / 亿** in Chinese, K / M / B in English.
- ⚙️ **LiteLLM Settings** — track any number of self-hosted LiteLLM proxies, each with
  its own name, color, sync frequency, and per-model show/hide + rename. See
  [LiteLLM providers](#litellm-providers) below.

## Data sources

| CLI         | Location                                              | Token data |
|-------------|------------------------------------------------------|-----------|
| Claude Code | `~/.claude/projects/<cwd>/<session>.jsonl`           | per-message `usage` (input/output/cache) |
| Codex       | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`       | `token_count` events (`last_token_usage`) |
| Gemini      | `~/.gemini/tmp/<project>/chats/session-*.jsonl` (and older `.json`) | per-message `tokens` |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<uuid>.db` (SQLite) | per-turn usage decoded from a protobuf blob |
| Cursor      | cursor.com usage export (see below) — **not** local files | per-request token counts |
| LiteLLM     | your proxy's admin API (see below) — **not** local files | real spend + per-model token counts, polled |

## Cursor usage (the one network exception)

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
- This is the only tool here that makes a network call, and it uses an
  **undocumented, reverse-engineered endpoint** — it can break or change without
  notice on a Cursor update.
- Cursor doesn't expose which project/conversation each request belongs to via this
  endpoint, so all Cursor usage is shown under one combined bucket rather than broken
  out per project.
- Fetches are cached and throttled to at most once every 15 minutes, and are
  re-run on app startup, on a 5-minute timer, and from the tray's **Refresh now**
  (so new Cursor usage shows up without needing the Cursor IDE to touch its files).
- If your Cursor session expires, log into the Cursor IDE again to refresh it.
- Cursor's own official **Admin/Analytics API** (`cursor.com/docs/api`) does expose
  proper usage endpoints, but only to **Team/Organization** API keys — an individual
  account's personal API key can't reach them, which is why this endpoint is used
  instead.

For the full technical mechanism (exact endpoint, CSV columns, caching, refresh
cadence) and how the other CLIs compare — including whether their `/usage` quota
data can be synced — see [`docs/usage-data-sources.md`](docs/usage-data-sources.md).

## LiteLLM providers

If you run a self-hosted [LiteLLM](https://docs.litellm.ai/) proxy, TokenStats can
track its usage too — unlike the other tools, LiteLLM has no local footprint at all
(it's a server, not a CLI), so this polls its admin API instead of watching files.

Open **Settings** — the gear icon ⚙ in the tray popup's header, or **Settings…** from
the tray's right-click menu — to add a provider:

- **Name** and **color**, shown as its own row in the popup and Report, just like a
  built-in CLI.
- **Base URL** and an **admin/management API key** (not a per-user key).
- **Sync frequency** (minutes) — how often TokenStats polls that proxy.
- Per-model **show/hide** and **rename** — use "Load models" to see every model the
  key has usage for, then hide ones you don't want counted or give one a friendlier
  display name.

You can add multiple providers (e.g. one per team, or per proxy instance); each shows
up as its own independent row everywhere the built-in CLIs do. Unlike every other
source here, LiteLLM's admin API reports **actual spend**, not a `pricing.js` estimate.

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

## Multiple devices

Token usage for Claude Code, Codex, Gemini, and Antigravity lives only in each
device's local files — those CLIs don't expose a per-account usage API to pull from
the cloud. To include usage from **other machines**, copy that machine's CLI data
folder over (sync drive, network share, or manual copy) and point TokenStats at it.
Right-click the tray → **Edit data sources…**, or edit `~/.tokenstats/config.json`:

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

## Develop

```bash
npm install
npm run dev            # launch with hot reload
npm run test:parsers   # parse your real local data and print totals (no GUI)
npm run test:db        # ingest into a temp SQLite db and run the report queries
```

Quit the installed TokenStats from the tray before `npm run dev` — both share one
`userData` directory, so they share the single-instance lock and dev would exit while
the *installed* window pops up instead.

## Build a Windows installer

```bash
npm run release                 # bump patch, build, NSIS installer, silent reinstall, relaunch
npm run release -- -NoInstall   # same, but stop after writing dist/TokenStats-Setup-*.exe
npm run package                 # unpacked build in dist/win-unpacked (debug aid, NOT an installer)
```

`npm run release` refuses to run on a dirty tree and tags the commit it builds, so every
installer maps to exactly one commit. `dev`/`build` only refresh `out/` — they never
touch the installed copy Windows autostarts. The running version and its **build time**
are shown in the tray tooltip and the popup/report footers.

## Notes

- Cost numbers are **estimates** — they depend on your plan and current list prices.
  Edit `src/main/core/pricing.js` to match your rates.
- Claude's totals include cache-read tokens, which accumulate fast on long sessions;
  that's why its token count dwarfs the others. The breakdown is preserved per record.
- Cursor and LiteLLM are the only tools tracked over the network rather than from
  local files — see [Cursor usage](#cursor-usage-the-one-network-exception) and
  [LiteLLM providers](#litellm-providers) above.
- See `CLAUDE.md` for architecture details and how to add another CLI.
