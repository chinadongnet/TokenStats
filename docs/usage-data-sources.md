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
| Claude Code | local files | `~/.claude/projects/**/*.jsonl` per-message `usage`         | ✅ accurate  | ✅ live via `claude -p /usage` |
| Codex       | local files | `~/.codex/sessions/**/rollout-*.jsonl` `token_count` events | ✅ accurate  | ✅ live from the logs (`rate_limits`) |
| Gemini      | local files | `~/.gemini/tmp/**/chats/session-*.jsonl`                    | ✅ accurate  | ❌ CLI deprecated for individuals |
| Antigravity | local files | `~/.gemini/antigravity-cli/conversations/<uuid>.db`         | ✅ accurate  | ✅ live via statusLine mirror hook (opt-in) |
| Cursor      | **network** | cursor.com dashboard CSV export (real usage is server-only) | ✅ accurate  | ✅ live via `/api/usage-summary` |
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

### Monthly quota (Spending page) — live overlay
Separately from the token CSV, Cursor's **Spending** page
(`cursor.com/dashboard/spending`) shows the plan's included-usage quota, and it is
backed by a clean authenticated endpoint:

```
GET https://cursor.com/api/usage-summary
Cookie: WorkosCursorSessionToken=<userId>::<jwt>
```

```json
{
  "billingCycleStart": "2026-07-04T15:50:55Z",
  "billingCycleEnd":   "2026-08-04T15:50:55Z",
  "membershipType": "pro",
  "individualUsage": { "plan": {
    "autoPercentUsed": 7.36,      // "First-Party" on the page
    "apiPercentUsed": 100,        // "API" on the page
    "totalPercentUsed": 19.84     // "Total" on the page
  } }
}
```

`parseUsageSummary()` in `cursor.js` maps `totalPercentUsed` → used%, and
`billingCycleEnd` → reset, into a `monthly` live window. It's fetched on the same
15-min cadence as the CSV (piggybacked in `getCloudRecords`) and exposed via
`cursorResetWindows()`, so the **Cursor** plan's monthly Quota window shows live (e.g.
"80% left, resets Aug 4") instead of the token estimate. This is a plain GET, so
unlike the POST dashboard endpoints it needs no `Origin` header.

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

### Codex — done, zero network (data is already local) ✅
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
same numbers Codex's `/status` shows. `parsers/codex.js` keeps the newest snapshot
module-side (NOT as a usage record — it's live account state, not per-request usage)
and exposes it via `codexResetWindows()`.

**How it surfaces — live overlay on the plan's Quota window.** The popup's
*Quota windows* section prefers this live data over the token-based estimate:

- `mergeLiveLimits()` (in `subscriptions.js`) overlays live per-CLI windows onto the
  estimated ones from `computeResetWindows()`. For a plan **bound to** a live-capable
  CLI, each live window **replaces** the plan's same-period estimate (`source:'live'`);
  the plan's other windows and its billing `renewal` are untouched. A plan bound to no
  live source keeps its estimate (`source:'estimate'`). Live data for a CLI no plan
  covers becomes its own synthetic entry so it still shows.
- The UI badges each plan **live** (real numbers from the CLI's own report) vs
  **manual** (estimate against the configured plan). For a live window the ring shows
  **usage** remaining (100 − used_percent) and the label shows **time** to reset; for
  an estimate window the ring stays time-based as before.
- Codex is local, so this is effectively real-time (refreshed whenever its logs change
  and the popup re-fetches on the next snapshot). A future network-backed live source
  would self-throttle the way Cursor does (≤ once / 15 min).

Concretely: a "Chat GPT Plus" plan bound to `codex` shows its **weekly** window straight
from Codex's report (e.g. "24% left, resets Jul 23") with a **live** badge, while its
$20 billing renewal countdown is unchanged.

### Claude Code — done, via the CLI's own `/usage` in print mode ✅
Token counts are already accurate from the local jsonl. The extra thing `/usage`
shows — Pro/Max **5-hour session** and **weekly** window consumption + reset times —
is server-side plan state, and there is no documented API for it (the Analytics /
Usage-Cost / Rate-Limits APIs need an Admin key and return historical consumption or
*configured* TPM/RPM, not the rolling-window balance). **But** the CLI's own built-in
is reachable non-interactively: piping `/usage` into `claude -p` runs it and prints
text (verified empirically — this corrects an earlier "not feasible" reading based on
docs alone):

```
$ printf '/usage\n' | claude -p --output-format text
Current session: 20% used · resets Jul 18, 2:20am (Asia/Singapore)
Current week (all models): 11% used · resets Jul 22, 4pm (Asia/Singapore)
Current week (Fable): 12% used · resets Jul 22, 4pm (Asia/Singapore)
```

`src/main/core/claudeLimits.js` shells out to that (finding the binary at
`~/.local/bin/claude[.exe]` or on `PATH`), parses "session" → 5h and "week (all
models)" → weekly into the standard window shape, and feeds `mergeLiveLimits()` under
`liveByCli.claude`. So a plan bound to `claude` (e.g. "Claude Max 5X") shows its 5h +
weekly windows **live**. Because each call spawns the CLI and hits the network, it's
throttled to once / 15 min and the accessor returns cached data while a stale refresh
runs in the background (the IPC handler stays synchronous). Per-model weekly lines
(e.g. Fable) are skipped to avoid clutter.

### Gemini — CLI deprecated for individuals ❌
`gemini --help` has no usage subcommand, and driving it now fails auth outright:
`IneligibleTierError: This client is no longer supported for Gemini Code Assist for
individuals — migrate to the Antigravity suite`. So the old Gemini CLI is a dead end;
its successor is Antigravity (below).

### Antigravity (`agy`) — done, via a statusLine mirror hook ✅
`agy` **is** a real CLI (`%LOCALAPPDATA%\agy\bin\agy.exe`), the successor to the Gemini
CLI. It has no local quota file and no usable public API — the numbers live only in the
running CLI's memory, rendered by its interactive `/usage` view. Two dead ends first:

- `agy -p "/usage"` (print mode) does **not** run the built-in — it treats the slash
  command as an *agent prompt* (given `/status` it went and ran `git status`). So unlike
  Claude, print mode can't surface the usage view.
- Driving the **interactive TUI** over a pty needs a fresh ~30 s sign-in plus
  alternate-screen scraping across dozens of model lines — too fragile to poll.

The clean route is agy's **statusLine hook**. Like Claude Code, agy pipes its live
session-state JSON to a user-configured command's stdin on every render — including a
`quota` map of per-model-pool `{remaining_fraction, reset_time, reset_in_seconds}`
(inspired by [Ranteck/agy-statusline](https://github.com/Ranteck/agy-statusline)).
`src/main/agyQuota.js` registers (opt-in, from **Settings → App → Track agy quota**) a
tiny hook as agy's `statusLine.command` that mirrors that JSON to
`~/.tokenstats/agy_status.json`, then prints a compact status line back so the user still
gets a useful agy status bar. `agyResetWindows()` reads the mirror and surfaces the
**Gemini** pools (driven by the most-consumed one) as a weekly live window through
`mergeLiveLimits()` under `liveByCli.agy`, so the popup shows an **Antigravity**
live-quota card. It refreshes for free whenever the user runs the `agy` CLI — no OAuth,
no spawning agy, no quota spent — and never overwrites a statusLine the user set
themselves (the toggle cleanly removes it).

Gotchas worth recording:
- agy executes `statusLine.command` by **naive space-splitting with no shell and no quote
  handling** (verified on Windows), so the installed command must be **unquoted**
  (`node C:/Users/…/.tokenstats/agyStatusHook.cjs`); a quoted path is passed to node
  literally and never runs. A hook path containing a space is therefore unsupported.
- The mirror only refreshes on `agy` **CLI** use — the Antigravity **IDE** doesn't
  trigger it. And this agy version (1.1.4) exposed only ~7-day (weekly) per-pool windows,
  no separate 5-hour bucket.
- There's an alternate, OAuth-based source — `POST daily-cloudcode-pa.googleapis.com/
  v1internal:retrieveUserQuotaSummary`, which agy's `quota_manager` polls — but it needs
  the account token and a `v1internal` request shape, so the token-free statusLine mirror
  is preferred.

## Verdict

**Codex**, **Claude**, **Cursor**, and **Antigravity** now drive live overlays on their
plans' Quota windows — Codex from the `rate_limits` in its local logs (real-time, no
network), Claude by shelling out to `claude -p /usage`, Cursor from `/api/usage-summary`
(both throttled ~15 min), and Antigravity via the opt-in statusLine mirror hook
(`src/main/agyQuota.js`, refreshed on `agy` CLI use). **Gemini** is deprecated and stays
on the manual estimate (badged **manual**). Any future clean source plugs into
`mergeLiveLimits()` as another `liveByCli` entry — the UI already handles it.
