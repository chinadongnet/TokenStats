# TokenStatus

A Windows **system-tray** app that tracks token usage across your local AI coding
tools — **Claude Code**, **Codex**, **Gemini**, **Antigravity**, and **Cursor** — and
shows it at a glance.

It reads the transcript/log files each tool already writes to disk, watches them live,
and surfaces per-CLI / per-model / per-day token counts plus rough cost estimates in a
little popup that drops down from the tray icon. No accounts, no API keys, no network —
**except for Cursor**, whose local files carry no real usage data; see
[Cursor usage](#cursor-usage-the-one-network-exception) below.

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
  (`~/.tokenstatus/usage.sqlite`) that records usage at hourly granularity per model.

## Data sources

| CLI         | Location                                              | Token data |
|-------------|------------------------------------------------------|-----------|
| Claude Code | `~/.claude/projects/<cwd>/<session>.jsonl`           | per-message `usage` (input/output/cache) |
| Codex       | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`       | `token_count` events (`last_token_usage`) |
| Gemini      | `~/.gemini/tmp/<project>/chats/session-*.jsonl` (and older `.json`) | per-message `tokens` |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<uuid>.db` (SQLite) | per-turn usage decoded from a protobuf blob |
| Cursor      | cursor.com usage export (see below) — **not** local files | per-request token counts |

## Cursor usage (the one network exception)

Cursor's local chat database (`state.vscdb`) writes every message's token count as
zeros in current versions — real usage is tracked **server-side only**, on the
cursor.com dashboard. So instead of parsing local files, TokenStatus:

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

## Multiple devices

Token usage for Claude Code, Codex, Gemini, and Antigravity lives only in each
device's local files — those CLIs don't expose a per-account usage API to pull from
the cloud. To include usage from **other machines**, copy that machine's CLI data
folder over (sync drive, network share, or manual copy) and point TokenStatus at it.
Right-click the tray → **Edit data sources…**, or edit `~/.tokenstatus/config.json`:

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
work). Restart TokenStatus after editing. Don't add your own local folders here — that
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
- Cursor is the only tool tracked over the network rather than from local files — see
  [Cursor usage](#cursor-usage-the-one-network-exception) above.
- See `CLAUDE.md` for architecture details and how to add another CLI.
