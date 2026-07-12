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
        ┌─────────────────────────┐
        │ Today   1.2M tokens     │
        │ Claude    820K ▆▆▆▆▆     │
        │ Codex     310K ▆▆        │
        │ Gemini     70K ▁         │
        │ ─────────────────────── │
        │ ● live: opus-4.8 · 12s  │
        └─────────────────────────┘
```

## Features

- 🟢 **Tray icon + popup** — click the icon to see today / all-time tokens, broken down
  by CLI with bars, top models, and recent sessions.
- ⚡ **Live** — watches `~/.claude`, `~/.codex`, `~/.gemini`, `~/.gemini/antigravity-cli`
  and updates within a second of each turn (via file watching, debounced).
- 💲 **Cost estimates** — rough USD figures from an editable price table (`pricing.js`).
- 🎨 Tray icon recolors to the most recently active CLI.
- 📊 **Usage report** — a full window with **hour-by-hour** and daily charts, per-model
  breakdown, and a one-click **Export PNG**. Backed by a local **SQLite** database
  (`~/.TokenStats/usage.sqlite`) that records usage at hourly granularity per model.
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
- Fetches are cached and throttled to at most once every 15 minutes.
- If your Cursor session expires, log into the Cursor IDE again to refresh it.
- Cursor's own official **Admin/Analytics API** (`cursor.com/docs/api`) does expose
  proper usage endpoints, but only to **Team/Organization** API keys — an individual
  account's personal API key can't reach them, which is why this endpoint is used
  instead.

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
`~/.TokenStats/usage.sqlite`, never sent anywhere except to the proxy you configured.

## Multiple devices

Token usage for Claude Code, Codex, Gemini, and Antigravity lives only in each
device's local files — those CLIs don't expose a per-account usage API to pull from
the cloud. To include usage from **other machines**, copy that machine's CLI data
folder over (sync drive, network share, or manual copy) and point TokenStats at it.
Right-click the tray → **Edit data sources…**, or edit `~/.TokenStats/config.json`:

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
```

## Build a Windows installer

```bash
npm run package        # -> dist/  (NSIS .exe installer)
```

## Notes

- Cost numbers are **estimates** — they depend on your plan and current list prices.
  Edit `src/main/core/pricing.js` to match your rates.
- Claude's totals include cache-read tokens, which accumulate fast on long sessions;
  that's why its token count dwarfs the others. The breakdown is preserved per record.
- Cursor and LiteLLM are the only tools tracked over the network rather than from
  local files — see [Cursor usage](#cursor-usage-the-one-network-exception) and
  [LiteLLM providers](#litellm-providers) above.
- See `CLAUDE.md` for architecture details and how to add another CLI.
