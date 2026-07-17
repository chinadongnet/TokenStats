# How TokenStats gets each source's usage data

TokenStats normalizes usage from several CLIs into one hourly SQLite table. Most
sources are read from **local log files**; two (Cursor, LiteLLM) are fetched over
the **network** because the real numbers only live server-side. This document
records exactly how each source is obtained, with the Cursor path in full detail,
plus a feasibility assessment for pulling authoritative **quota / rate-limit**
data the way each tool's own `/usage` (or `/status`) command does.

Code lives in `src/main/core/parsers/*.js`; the store/watch/poll plumbing is in
`src/main/core/store.js`.

## Summary table

| Source      | Transport   | Where the data comes from                                   | Token counts | Quota / limits |
|-------------|-------------|-------------------------------------------------------------|--------------|----------------|
| Claude Code | local files | `~/.claude/projects/**/*.jsonl` per-message `usage`         | ✅ accurate  | see below |
| Codex       | local files | `~/.codex/sessions/**/rollout-*.jsonl` `token_count` events | ✅ accurate  | ✅ **already in the logs** (`rate_limits`) |
| Gemini      | local files | `~/.gemini/tmp/**/chats/session-*.jsonl`                    | ✅ accurate  | ❌ not present |
| Antigravity | local files | `~/.gemini/antigravity-cli/conversations/<uuid>.db`         | ✅ accurate  | ❌ not present |
| Cursor      | **network** | cursor.com dashboard CSV export (real usage is server-only) | ✅ accurate  | n/a (usage only) |
| LiteLLM     | **network** | your proxy's admin API                                      | ✅ actual $  | n/a |

---

## Cursor — how usage is fetched (the one CLI that must go over the network)

Implementation: `src/main/core/parsers/cursor.js`.

### Why the network is required
Cursor's local chat DB (`state.vscdb`, table `cursorDiskKV`) writes every message's
`tokenCount` as `{0,0}` and leaves composer `usageData` empty in current versions
(verified 2026-07 by raw-scanning the whole DB + WAL for token fields). The real
per-request usage is tracked **server-side only** and shown on the cursor.com
dashboard. So the Cursor parser does **not** read local chat data at all — it is the
one deliberate exception to this codebase's "no network" rule.

### Step 1 — get the session token locally
From `state.vscdb`'s `ItemTable`, read the value of key `cursorAuth/accessToken` —
the session JWT the Cursor IDE itself stores after you log in. No separate API key
is needed; you just have to be logged into Cursor on this machine.

- `userId` = the JWT `sub` claim's trailing segment after `|`.
- If the JWT is expired (`exp` in the past), the parser returns nothing — log into
  the Cursor IDE again to refresh it.

### Step 2 — call the dashboard's CSV export endpoint
Undocumented, reverse-engineered from the dashboard's own network traffic (it is
**not** in the public `cursor.com/docs/api`):

```
GET https://cursor.com/api/dashboard/export-usage-events-csv
    ?startDate=0&endDate=<now_ms>&strategy=tokens
Cookie: WorkosCursorSessionToken=<userId>::<jwt>
Accept: text/csv,*/*
```

Returns CSV, one row per request. Columns consumed:

| CSV column                 | Normalized field |
|----------------------------|------------------|
| `Date`                     | `ts` (`Date.parse`) |
| `Model`                    | `model` (defaults to `auto`) |
| `Input (w/o Cache Write)`  | `input` |
| `Input (w/ Cache Write)`   | `cacheCreate` |
| `Cache Read`               | `cacheRead` |
| `Output Tokens`            | `output` |
| `Total Tokens`             | `total` |

- Rows with a blank/absent `Total Tokens` (errored / "no charge" requests) are
  skipped.
- `startDate=0` pulls **full history** every call. The response carries no
  conversationId/project, so all Cursor records are attributed to one synthetic
  `project=cursor` / `session=cloud` bucket.
- A sibling JSON endpoint (`get-filtered-usage-events`) also returns
  `conversationId`, but only accepts ~7-day ranges and began returning `403` under
  rapid calls during testing; the CSV export tolerated a full-history call, so it's
  what's used.

### Caching and throttle
Results are cached per account (keyed by `userId`, since usage is identical
regardless of which device's token fetched it). The actual HTTP call is throttled
to **at most once every 15 minutes** to stay clear of the rate limit that produced
the 403s above. On any error (rate-limit / expired session / network) the previous
cache is kept rather than cleared.

### When a refresh actually happens
The Cursor parser is a **file-watched** parser (`kind: 'binary'`, matches
`state.vscdb`) but its data is network-backed, so it is also marked `network: true`
and re-run on a timer. It refreshes on:

1. **App startup** — the initial `store.scanAll()`.
2. A **5-minute timer** — `store.refreshNetworkParsers()`, which force-reingests
   `network: true` parsers by clearing the cached mtime/size so `ingestFile` doesn't
   short-circuit. (The parser's own 15-min HTTP throttle still bounds real calls.)
3. The tray's **"Refresh now"** menu item.

> History note: before the 5-minute timer existed, Cursor usage refreshed **only**
> when `state.vscdb` changed on disk or at app startup. Once the IDE went idle that
> file stopped changing, so requests made after launch were never picked up and the
> totals silently went stale. The `network: true` flag + `refreshNetworkParsers()`
> timer fixed that.

### Why not Cursor's official API
Cursor's official Admin/Analytics API (`cursor.com/docs/api`) does expose proper
usage endpoints, but only to **Team/Organization** API keys — an individual
account's personal key can't reach them, which is why the dashboard export endpoint
is used instead.

---

## Syncing quota / rate-limit data from each tool's `/usage`

Unlike Cursor, the local logs for Claude / Codex / Gemini / Antigravity already
contain **accurate per-request token counts**, so there is nothing to "fix" there.
The open question is the *other* thing those tools' `/usage` (Claude) and `/status`
(Codex) screens show: **plan quota consumption and reset windows** (e.g. the 5-hour
and weekly rate-limit windows), which are NOT derivable from token logs alone.
Feasibility per CLI:

### Codex — feasible with zero network (data is already local) ✅
Codex writes its rate-limit snapshot straight into the rollout jsonl that TokenStats
already parses. Each `token_count` event carries a `rate_limits` object, e.g.:

```json
"rate_limits": {
  "limit_id": "codex",
  "primary":   { "used_percent": 73.0, "window_minutes": 10080, "resets_at": 1784786968 },
  "secondary": null,
  "credits":   { "has_credits": false, "unlimited": false }
}
```

`window_minutes: 10080` is the weekly window; `used_percent` and `resets_at` are the
same numbers Codex's `/status` shows. The current codex parser only reads the token
fields and ignores `rate_limits`. **Plan:** extend `parsers/codex.js` to also surface
the newest `rate_limits` snapshot per account, and show it in the Report's quota
section. No network, no auth handling — just read a field we already stream past.

### Gemini — not feasible from local data ❌
`gemini --help` exposes no usage/quota subcommand, and the session jsonl carries no
quota/limit/reset fields. The only account-level material on disk is raw OAuth
credentials (`~/.gemini/oauth_creds.json`, `google_accounts.json`). Getting Google
account quota would mean reverse-engineering an authenticated Google endpoint with
those creds — fragile, and Google's free-tier quota isn't cleanly exposed the way
Cursor's dashboard export is. Not pursued.

### Antigravity — not feasible ❌
Antigravity stores per-conversation SQLite DBs (token usage decoded from a protobuf
blob) but exposes no usage/quota surface and isn't even on `PATH` as a CLI. No
accessible `/usage`-style source. Not pursued.

### Claude Code — not feasible via any documented/authorized path ❌
Token counts are already accurate from the local jsonl, so nothing there needs a
sync. The extra thing `/usage` shows — Pro/Max **5-hour and weekly window**
consumption and reset times — is subscription-plan state on Anthropic's servers and
is **not** reachable non-interactively:

- `/usage` is **interactive-only**; there is no `claude usage --json` / `--print`
  subcommand.
- The Agent SDK exposes only client-side `total_cost_usd` estimates (documented as
  non-authoritative), not plan limits.
- The **Analytics API** (`/v1/organizations/usage_report/claude_code`), **Usage/Cost
  API**, and **Rate Limits API** all require an Admin API key and return historical
  consumption or *configured* TPM/RPM limits — **none** return the 5-hour/weekly
  rolling-window allocations, remaining balance, or reset times that `/usage` shows.
- OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) streams token/cost events —
  same limitation, consumption only.
- Credentials exist on disk (`~/.claude/.credentials.json`, or the macOS Keychain;
  also `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` env vars), but there is **no
  documented endpoint** that `/usage` calls to fetch the window data, so there is
  nothing to authorize against — unlike Cursor's dashboard export.

Conclusion: no Cursor-style sync is possible today. If Anthropic later ships a
non-interactive `/usage` flag or a public subscription-limits endpoint, revisit.

## Verdict

Only **Codex** can gain real value from a `/usage`-style sync, and it needs **no
network** — the `rate_limits` snapshot is already in the rollout logs we parse.
Claude / Gemini / Antigravity already report accurate token counts from local files,
and their plan-quota data has no accessible source, so there is nothing to sync for
them.
