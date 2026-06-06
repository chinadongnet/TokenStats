# TokenStatus

A Windows **system-tray** app that tracks token usage across your local AI coding
CLIs — **Claude Code**, **Codex**, and **Gemini** — and shows it at a glance.

It reads the transcript/log files each CLI already writes to disk, watches them live,
and surfaces per-CLI / per-model / per-day token counts plus rough cost estimates in a
little popup that drops down from the tray icon. No accounts, no API keys, no network.

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
- ⚡ **Live** — watches `~/.claude`, `~/.codex`, `~/.gemini` and updates within a second
  of each CLI turn (via file watching, debounced).
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

## Multiple devices

Token usage lives only in each device's local files — the CLIs don't expose a
per-account usage API to pull from the cloud. To include usage from **other machines**,
copy that machine's CLI data folder over (sync drive, network share, or manual copy) and
point TokenStatus at it. Right-click the tray → **Edit data sources…**, or edit
`~/.tokenstatus/config.json`:

```json
{
  "extraRoots": {
    "claude": [],
    "codex":  ["D:/from-laptop/.codex/sessions"],
    "gemini": ["D:/from-laptop/.gemini/tmp"]
  }
}
```

These folders are scanned and merged into the totals (forward or back slashes both
work). Restart TokenStatus after editing. Don't add your own local folders here — that
would double-count. Session files are uniquely named per device, so genuine cross-device
data merges cleanly.

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
- See `CLAUDE.md` for architecture details and how to add another CLI.
