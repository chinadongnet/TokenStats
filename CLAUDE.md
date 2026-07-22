# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TokenStats is a Windows system-tray app that tracks token usage across five local
AI coding tools — **Claude Code**, **Codex**, **Gemini**, **Antigravity** (`agy`), and the
**Cursor** IDE — plus any number of self-hosted **LiteLLM** proxies, by parsing the
transcript/log files each local tool writes to disk (and, for LiteLLM, polling its
admin API). It watches those files live and shows per-CLI / per-model / per-day token
counts and cost in a tray popup.

All data comes from reading local files, with **two exceptions**:
- Cursor's local files carry no real token counts (see below), so `parsers/cursor.js`
  calls an undocumented cursor.com dashboard endpoint using the session token the
  Cursor IDE already stores locally.
- LiteLLM has no local footprint at all — it's a proxy server, not a local tool — so
  `parsers/litellm.js` polls its admin API for usage instead. Unlike every other
  source, this one reports **real spend** (not a `pricing.js` estimate); see below.
Both were added at the user's explicit request/approval after confirming the
local-only approach returns no data; every other CLI stays fully offline.

Unlike the 5 fixed built-in CLIs, LiteLLM is **multi-instance**: the Settings window
(`Settings.jsx`, opened via the tray popup's gear icon or right-click menu) lets a
user configure any number of LiteLLM "providers" (name, base URL, admin key, UI
color, sync-minutes, per-model show/hide + rename), stored in `usage.sqlite` (not
`config.json`). Each enabled provider becomes its own dynamic pseudo-CLI
(`litellm:<providerId>`) and shows up as its own row everywhere a built-in CLI would
— see "Dynamic LiteLLM providers" under Conventions below.

The Settings window also manages **subscription plans** — user-entered monthly flat
fees (Claude, ChatGPT, Google AI, Cursor, a LiteLLM token plan, …) compared against
what the covered usage would actually have cost. See `core/subscriptions.js` below
and the report window's "Subscriptions" tab. An active plan can also declare **token
quota resets** — any subset of 5h / weekly / monthly, since Claude caps a 5h and a
weekly window while Cursor and Mimo only have a monthly allowance — which the tray
popup surfaces as live countdowns. A plan therefore carries **several independent
clocks**: each quota window has its own user-set anchor, and the *billing* renewal
runs off the plan's start date. They are unrelated (quota can reset on the 20th while
the fee bills on the 5th) and must never be derived from one another.

## Commands

```bash
npm install            # install deps (electron, vite, react, chokidar)
npm run dev            # electron-vite dev server with HMR (launches the app)
npm run build          # bundle main + preload + renderer into out/
npm start              # preview the production build
npm run test:parsers   # HEADLESS: parse real local CLI data, print a snapshot to stdout
npm run test:db        # HEADLESS: ingest real data into a temp .sqlite, run report queries
npm run package        # build + electron-builder --dir -> UNPACKED dir in dist/win-unpacked (debug aid, not an installer)
npm run release        # bump + build + NSIS installer + silent reinstall + relaunch  (see below)
npm run release -- -NoInstall   # same, but stop after writing the installer to dist/
```

`npm run test:parsers` is the fastest feedback loop — it runs the entire parsing/
aggregation engine against the real `~/.claude`, `~/.codex`, `~/.gemini` data with no
Electron/GUI, and prints totals. Use it after any change to `src/main/core/**`.

To smoke-test the actual app headlessly (boots Electron, then exits): launch
`node_modules/electron/dist/electron.exe . --no-sandbox`, wait a few seconds, confirm
the process stays alive and stderr is empty, then kill it.

### Releasing (and why dev changes don't reach the tray)

- `npm run dev` and `npm run build` only refresh `out/`. The tray icon you see after a
  reboot is the **installed** copy at `%LOCALAPPDATA%\Programs\tokenstats\TokenStats.exe`,
  which is replaced only by running the NSIS installer. **`npm run release` is the only
  thing that closes that loop.** There is no auto-update.
- **Quit the installed TokenStats from the tray before `npm run dev`.** Dev and the
  installed build share `userData` (`%APPDATA%\tokenstats` — package.json `name` is
  `tokenstats` and `productName` lives only under the `build` key, so `app.getName()`
  resolves the same in both), so they share the single-instance lock. Dev will exit and
  the *installed* app's window will pop up instead — looking exactly like "my changes
  didn't load". The lock is correct: two instances would both ingest into one
  `usage.sqlite`, and sql.js rewrites the whole file. `index.js` logs before quitting.
- Ground truth for what's running: version **and build time**, in the tray tooltip /
  popup footer / report footer. **Version alone is not enough** — dev iterates without
  bumping, so two different builds routinely share one version number.
- `release.ps1` refuses to run on a dirty tree and auto-bumps the patch version, so every
  installer maps to one tagged commit. Don't build installers any other way.

## Architecture

The codebase is split into a **pure-Node parsing engine** and an **Electron shell**.
Keep them separate: `src/main/core/**` must not import `electron`, so it stays unit-
testable via `npm run test:parsers`.

### Parsing engine — `src/main/core/`

- **`parsers/{claude,codex,gemini,antigravity,cursor}.js`** — one module per CLI. Each
  declares its `roots` array (from `CLI_ROOTS`), a `kind` (`'jsonl'` append-only,
  `'json'` whole-file text, or `'binary'` whole-file buffer), a `match(file)`
  predicate, and either `parseLine(line, state, file)` (jsonl) or
  `parseFile(textOrBuffer, file)` (json/binary, may be async). Each returns
  *normalized records* (below).
  Gemini ships two parser objects (`geminiJsonl` + `geminiJson`) sharing one root.
  `parsers/litellm.js` is the odd one out — it has no roots/files at all (see below)
  and isn't in `PARSERS` at all: it exports a `createLitellmPoller({id, name, baseUrl,
  apiKey, color, syncMinutes, getModelSettings})` factory (one call per configured
  provider, made by `index.js`'s `refreshLitellmPollers()`) plus a throttle-free
  `listModels({baseUrl, apiKey})` used by the Settings UI's "load models"/"test
  connection" actions. `store.js` holds the resulting pollers in an instance field
  (`this.pollers`), not a static array — see "Pollers" below.
- **`store.js`** — the engine core. Walks each root, reads files, and holds an
  in-memory index `Map<path, {parser, size, mtimeMs, state, records[]}>`.
  - JSONL files (Claude, Codex) are **tailed incrementally** from the last byte
    offset; if a file shrinks it re-reads from 0. `state` persists across lines of one
    file (Codex needs it to carry the current model/cwd between turns).
  - Gemini ships **two** chat formats: current `chats/session-*.jsonl` (append-only,
    tailed like the others) and older `chats/session-*.json` (whole-file, re-parsed on
    change). Both are registered as separate parsers sharing the Gemini root.
  - Antigravity (`agy`, Google's newer agentic CLI) logs conversations as **SQLite
    databases** at `~/.gemini/antigravity-cli/conversations/<uuid>.db`. The parser
    opens each db with sql.js and decodes per-turn token usage from protobuf blobs
    in the `gen_metadata` table (field map documented in `parsers/antigravity.js` —
    reverse-engineered, so re-validate after Antigravity updates). Whole-file
    re-parse on change.
  - Cursor's local chat db (`%APPDATA%/Cursor/User/globalStorage/state.vscdb`)
    writes every message's `tokenCount` as zeros in current Cursor versions —
    confirmed by raw-scanning the whole db + WAL, real usage is server-side only.
    So `parsers/cursor.js` only reads that db to extract the `cursorAuth/accessToken`
    JWT the IDE already stores after login, then calls the **undocumented** CSV
    export the cursor.com dashboard's Usage tab uses
    (`GET cursor.com/api/dashboard/export-usage-events-csv?startDate=0&endDate=<now>&strategy=tokens`,
    with a forged `WorkosCursorSessionToken` cookie) to get real per-request token
    counts. No conversationId is included, so all Cursor records land in one
    synthetic `cursor`/`cloud` project/session rather than per-conversation.
    Fetches are cached per-account and throttled to once per 15 minutes — the
    endpoint 403'd after a handful of rapid calls to a sibling JSON endpoint during
    testing. This is reverse-engineered and **can break or disappear without
    notice**; re-validate the endpoint and CSV column names (looked up by header
    name, not position) after Cursor updates. Full investigation and rationale are
    in the header comment of `parsers/cursor.js`.
  - **LiteLLM** providers are polled, not file-watched — see "Pollers" below.
  - `snapshot()` aggregates all records into per-CLI / per-model / per-day buckets,
    recent sessions, and the current "live" model, over
    `[...CLIS, ...dynamicIds]` (the 5 fixed CLIs plus every currently-active LiteLLM
    provider's `litellm:<id>`) so a dynamic id never hits a missing accumulator. It
    also returns a `providers: [{id, label, color}]` field — the only way the
    renderer learns provider names/colors, since it has no other route to the DB.
    The scope buckets are **calendar-aligned, not rolling**: `todayPerCli/Model`
    (since local midnight), `weekPerCli/Model` (since **Monday**), `monthPerCli/Model`
    (since the 1st), plus all-time `perCli/perModel`, with the boundaries echoed in
    `ranges: {dayStart, weekStart, monthStart}`. Calendar alignment is deliberate —
    the popup's 日/周/月 tabs have to line up with the cycles a subscription quota
    actually resets on; a rolling "last 7 days" never would.
    This is the only object the UI consumes.
  - `start()` does the initial scan, then sets up `chokidar` watchers and emits
    debounced `'update'` events (400ms) carrying a fresh snapshot.
  - **Pollers** (`this.pollers`, an **instance field**, not a static array) are usage
    sources with nothing on disk to watch — currently only LiteLLM providers, one
    poller per enabled provider row. `index.js`'s `refreshLitellmPollers()` rebuilds
    this array from `db.listLitellmProviders()` on startup and after any Settings CRUD
    (`store.setPollers()` — purges `poller:<cli>` file entries for removed/disabled
    providers immediately so they stop contributing right away). `pollAll()` calls
    each poller's `poll()` and stores the returned records under a synthetic
    `poller:<cli>` key in the same `this.files` map file entries use, so
    `allRecords()`/`dedupedRecords()` pick them up unchanged. `start()` always runs a
    60s poll-check timer regardless of whether any pollers exist yet (a provider can
    be added later via Settings); each poller throttles its own network calls to its
    configured `syncMinutes` (default 15) so the timer firing often is cheap.
    `store.forcePoll(cli)` / `store.reapplyPoller(cli)` let `index.js` push an
    immediate update after a Settings change — `forcePoll` bypasses the fetch
    throttle (new/edited provider), `reapplyPoller` re-runs visibility/rename against
    already-cached data with **no network call** (model show/hide/rename edits).
- **`pricing.js`** — rough USD-per-million-token table, matched by model-id substring.
  Cost figures are **estimates**, clearly labelled in the UI, for every source except
  LiteLLM — `costFor(rec)` returns `rec.cost` directly when a record carries one
  (LiteLLM's admin API reports actual spend, so its records aren't estimated at all).
  Edit the table freely.
- **`db.js`** — SQLite (via `sql.js` WASM, no native build) persistence at
  `~/.TokenStats/usage.sqlite`, split across three concerns:
  - **hourly usage** — `UsageDb.ingest(records)` re-aggregates the full record set
    into one row per `(local-hour, cli, model)` in `usage_hourly` and **replaces** the
    table (so it never drifts from the parsers), then exports the DB to disk. Query
    helpers `hourly(dayStart)`, `daily(from,to)`, `models(from,to)`, `span()` feed the
    report.
  - **LiteLLM provider config** — `litellm_providers` (id, name, base_url, api_key,
    color, sync_minutes, enabled) — the DB-backed replacement for the old single
    `config.json` `litellm` block. CRUD: `listLitellmProviders()`,
    `getLitellmProvider(id)`, `upsertLitellmProvider({id?, ...})` (id absent →
    `crypto.randomUUID()`), `deleteLitellmProvider(id)` (cascades to its model
    settings).
  - **per-model visibility/rename** — `litellm_model_settings` (provider_id, model,
    visible, display_name), one row per model a user has explicitly hidden or
    renamed (unlisted models default to visible, no rename). CRUD:
    `listModelSettings(providerId)`, `getModelSettingsMap(providerId)` (hot path —
    called on every poller `poll()`/`reapplySettings()`), `saveModelSetting({...})`
    (upsert via `ON CONFLICT`).
  - **subscription plans** — `subscriptions` (id, name, monthly_usd, start_date,
    active, end_date, bindings-as-JSON, reset_period). CRUD: `listSubscriptions()`,
    `getSubscription(id)`, `upsertSubscription({id?, ...})`,
    `deleteSubscription(id)`. A binding is `{cli, keyAlias?, models?}` — see
    `subscriptions.js` below. `reset_periods` (JSON **subset** of `RESET_PERIODS`,
    filtered + canonically ordered on both read and write, empty → NULL) and
    `reset_anchors` (JSON per-period map, e.g.
    `{"weekly":"2026-07-13T09:00","monthly":"2026-06-05"}`, kept only for ticked
    `ANCHORED_PERIODS` so a stale anchor can't resurface) are the **quota**-reset
    windows, unrelated to the monthly *billing* anchor — see `subscriptions.js`.
    `reset_anchor` (singular) is dead — migrated into `reset_anchors.monthly`.
  Every mutating method ends with `persist()` (whole-file re-export + write, same as
  `ingest()` — no WAL). Stays pure-Node (loads the wasm via `wasmBinary`), so it's
  testable with `node scripts/test-db.mjs`.
  **Schema changes need an explicit migration**: `SCHEMA` only `CREATE TABLE IF NOT
  EXISTS`, so a column added to a table an existing install already has is invisible
  to it. `migrateSchema(db)` (run from `open()` right after `SCHEMA`) does the
  `ALTER TABLE ADD COLUMN`s, guarded by `PRAGMA table_info`. Additive-only and
  idempotent — add to it rather than editing `SCHEMA` alone. It also back-fills where
  a shape changed (single-select `reset_period` → `reset_periods`; single
  `reset_anchor` → `reset_anchors.monthly`), leaving the superseded columns in place
  as dead weight — SQLite can't reliably drop a column on older versions. Back-fill
  SQL uses string concat, not `json_object()`: the JSON1 extension isn't guaranteed
  in this sql.js build.
- **`subscriptions.js`** — pure billing math for subscription plans, no Electron/DB
  imports. `computeAllSubscriptionStats(subs, records, now)` turns DB subscription
  rows plus the store's **deduped records** (must be deduped — this re-aggregates
  token cost) into per-plan stats: billed monthly cycles anchored to the start date
  (day-of-month clamped in short months, so a Jan 31 start bills Feb 28), total
  paid (one charge per cycle start; while `active` cycles accrue to "now",
  deactivated plans bill only cycles starting on/before `end_date`, and their
  final cycle's coverage — usage ownership, timeline lane, cycle labels — is
  clipped to the `end_date` day while keeping its full fee), and the
  actual cost of covered usage per cycle (`costFor()`, so LiteLLM's real spend is
  used where present), plus a calendar-month series (`months`: fee lands in the
  month its cycle starts, usage in its record's month) that the report's
  fee-vs-worth chart uses so months align across plans with different anchors.
  `computePlanBreakdown(subs, records, fromMs, toMs)` groups a time range's
  usage by the plan covering it, with per-plan in-range fees, usage worth,
  tokens, and a per-model breakdown — served via the `subs:breakdown` IPC for
  the report's "By plan" view and its "Plan fees" tile. **Record→plan
  ownership is time-aware and exclusive** (`planAssigner`): a plan owns a
  record only when its bindings match AND the record falls inside the plan's
  billed coverage (first cycle start → last billed cycle end); when coverages
  overlap — an ended "Pro" whose last paid cycle runs past the start of its
  replacement "Plus" over the same sources — the most recently *started* plan
  wins, so upgrade chains split at the switch date instead of the older plan
  starving the newer one. `computeAllSubscriptionStats` pre-assigns records
  through the same assigner, so overlapping plans never double-count usage in
  the Token Plans tab either; records no plan owns land in `unplanned`.
  `computePlanTimeline(subs, records, fromMs, toMs)` (IPC `subs:timeline`)
  feeds the report's zoomable timeline: per plan the billing-cycle segments
  overlapping the window (each with fee + the usage cost/tokens inside it),
  in-window totals + models (PlanBreakdown-compatible shape), a per-local-day
  stacked usage series keyed by owning plan (`'un'` = unplanned), and the
  overall data span for zoom clamping. A plan's `bindings` select which records count: each is
  `{cli}` (a fixed CLI or `litellm:<providerId>`) optionally narrowed by
  `keyAlias` (matches `record.project`, i.e. the LiteLLM key alias — how a token
  plan like Mimo sharing a proxy with other keys is isolated) and `models` (a
  model-id allowlist, matched against `rawModel` first so Settings renames don't
  unbind it; null = all models). Stats are served live via the `subs:stats` IPC
  from `store.dedupedRecords()` — not the hourly DB, which lacks the project/key
  dimension the keyAlias filter needs.
  `computeResetWindows(subs, records, now, index?)` (IPC `subs:resets`) covers the **quota**
  windows — orthogonal to all the billing math above. A plan declares a **set** of
  them (`resetPeriods`, any subset of `RESET_PERIODS` = `['5h','weekly','monthly']`),
  because real plans differ: Claude caps 5h *and* weekly, Cursor and a Mimo token
  plan only have a monthly allowance. Returns
  `{id, name, monthlyUsd, bindings, windows[], renewal}` per active plan, windows in
  canonical order. `renewal` carries the current billing cycle's own
  `{tokens, cost, turns}` so the popup can put what the month's usage is worth
  next to what the month costs. `mergeLiveLimits(entries, liveByCli, now, labels,
  index?)` fills the same counters for a **live** window: the CLI reports only a
  used% and a reset time, so the span is reconstructed as `[end - periodMs, end)`
  (clamped to now) and summed from the plan's own records — that's what makes the
  popup's "usage worth vs prorated fee" line cover exactly the window it sits
  under. `planRecordIndex(subs, records, now)` is the one shared pass over the
  records (owned-per-plan + per-CLI, ts-sorted) that both functions take, so
  `subs:resets` doesn't sweep the record set twice. The two window kinds are **not** the same shape:
  - **`5h` is ROLLING** (`ROLLING_PERIOD_MS`), modelling Claude's rate limit: the
    window opens on the first request made *after the previous one expired* and
    resets 5h later — **not** a clock-aligned schedule, so it can't be derived from
    the wall clock and has no anchor to configure. `rollingWindow()` replays the
    chain forward from the plan's first record (where window N ends decides where
    N+1 may open). Idle past the last window's end = no open window (`open: false`)
    until the next request.
  - **`weekly`/`monthly` are ANCHORED** (`ANCHORED_PERIODS`), each reading its **own**
    entry from the plan's `resetAnchors` map (falling back to `startDate`) — they
    reset on unrelated dates, so one shared anchor would be wrong. Weekly repeats
    every 7d from a date+**time** (`parseWhenLocal` accepts `YYYY-MM-DDTHH:mm`;
    fixed-ms stepping means DST shifts it an hour until re-set). Monthly runs
    anchor-day to anchor-day via `cycleStart`'s short-month clamping. Both are always
    open, and monthly's length varies, so `periodMs` is `end - start`, not a constant.
  **`renewal` is a third, independent clock**: the plan's BILLING cycle off
  `startDate` (when the fee is charged again) — the one place startDate drives a
  countdown. A plan's quota can reset on the 20th while its fee bills on the 5th;
  both are reported and neither derives from the other. Don't conflate them.
  Future-stamped records (LiteLLM's noon-UTC day buckets) can't *open* a rolling
  window, but **do** still count toward anchored ones — dropping them would
  undercount exactly the plans (Mimo) that use a monthly quota. Only **active** plans
  with at least one period are returned (a plan tracking no window stays hidden even
  though it has a renewal date), and ownership goes through the same exclusive
  `planAssigner`, so overlapping plans never double-count. Consumed by the tray
  popup, not the report.
- **`paths.js`** — resolves the data roots and reads user config. Each of the 5 fixed
  CLIs has an array of roots (`CLI_ROOTS[cli]`): the local dir first (overridable via
  `AIMON_*_ROOT` env vars), then any **extra dirs** listed under `extraRoots` in
  `~/.TokenStats/config.json` (override path via `AIMON_CONFIG`). Extra roots are how
  **other devices' usage is merged** — copy another machine's `.codex/.gemini/.claude`
  data folder locally and add its path. `ensureConfigFile()` writes a template on first
  run. Also exposes per-CLI display metadata (label, color, primary root) as
  `CLI_META`/`CLIS` — **LiteLLM is deliberately absent from both**, since it's no
  longer a fixed CLI (see `migrateLitellm.js` below). `LITELLM_CONFIG`/
  `loadLitellmConfig()` (the old single-provider `config.litellm.{baseUrl,apiKey}`
  reader) and `LITELLM_DEFAULT_COLOR` are kept, but **only** for the one-time
  migration and as the Settings UI's new-provider color default — nothing in the live
  poller path reads `LITELLM_CONFIG` anymore. `loadLanguage()`/`saveLanguage()` persist
  the UI language (`'en'`|`'zh'`) in `config.json` so the native tray menu can read it
  (the renderer keeps its own `localStorage` copy for instant switching — see
  `renderer/src/i18n.js`).
- **`migrateLitellm.js`** — `migrateLegacyLitellmConfig(db)`, called once from
  `index.js`'s `init()` right after opening the DB. If a legacy `config.json`
  `litellm` block exists and the DB has zero providers yet, creates one provider row
  from it (named "LiteLLM"); a no-op on every startup after that, or if the user never
  had one. The old `config.json` block is left in place untouched (harmless dead
  config) — kept only so this migration stays possible if the DB is ever wiped.

### Normalized record

Every parser emits records of this exact shape so aggregation is CLI-agnostic:

```
{ cli, ts, model, sessionId, project,
  input, output, cacheRead, cacheCreate, reasoning, total }
```

`total` is the headline token count and is computed per-CLI to be comparable:
- Claude: `input + output + cache_creation + cache_read`
- Codex: the per-turn **delta** of the cumulative `total_token_usage.total_tokens`
  (already includes cached input + reasoning)
- Gemini: the message's `tokens.total`
- LiteLLM: the admin API's `total_tokens` for that model/key/day

`input` is stored as the *non-cached* portion for Codex/Gemini/LiteLLM so the
components don't double-count `cacheRead`.

Records may also carry an optional **`dedupKey`** — see de-duplication below — and an
optional **`cost`**, which overrides the `pricing.js` estimate with a real dollar
figure (currently only LiteLLM sets this). A LiteLLM record whose model was renamed
via Settings additionally carries **`rawModel`** (the original API model id) so
identity-based matching (subscription model filters) survives the rename.

### Electron shell — `src/main/`

- **`index.js`** — app entry. Creates the frameless, `skipTaskbar`, always-on-top
  popup `BrowserWindow` (hidden until the tray is clicked, hides on blur), the `Tray`,
  and wires `store` `'update'` events to `webContents.send('snapshot', …)` and tray
  tooltip/color. IPC handlers are registered **before** `store.start()` so the renderer
  never races a missing `get-snapshot` handler during the initial scan.
  The popup targets a fixed `POPUP_W × POPUP_H` (380×600) **content** size (`useContentSize`),
  but `sizeWindow()` **caps the height to the current display's work area** so a
  low-resolution / high-DPI screen can never push the window off-screen; the renderer
  scrolls internally when content is taller (see `App.jsx`). `sizeWindow()` +
  `positionWindow()` run on every `showWindow()` and on `screen`'s
  `'display-metrics-changed'`, so a live resolution/DPI switch re-fits the popup.

  Also owns the **Settings window** (`openSettings` — a resizable window loading the
  renderer with `#settings`, mirroring `openReport`'s pattern), opened via the tray
  popup's gear icon or the tray right-click menu's "Settings…" item. All
  `litellm:*` IPC handlers (`list-providers`, `save-provider`, `delete-provider`,
  `list-models`, `get-model-settings`, `save-model-setting`) live here; a save/delete
  calls `refreshLitellmPollers()` to rebuild `store.pollers` from the DB, then either
  `store.forcePoll()` (new/edited connection — bypasses the fetch throttle) or
  `store.reapplyPoller()` (model visibility/rename — no network call), then
  `broadcastSnapshot()` to push the change to the popup/tray/DB immediately instead of
  waiting for the next poll timer tick. The `subs:*` IPC handlers (`list`, `save`,
  `delete`, `stats`, `resets`) also live here — `subs:stats`/`subs:resets` compute
  live from `store.dedupedRecords()` (see `core/subscriptions.js`), and a
  save/delete pings the report window (`report-updated`) so its Subscriptions tab
  refreshes. `subs:resets` also overlays `agy` live windows (`agyResetWindows()` from
  `agyQuota.js`) into `liveByCli` alongside Codex/Claude/Cursor. The **language** IPC
  (`get-language`/`set-language`) persists to `config.json`, rebuilds the (translated)
  native tray menu — `TRAY_STRINGS`/`tray_t()`, the only main-process strings — and
  broadcasts `language` to every window; the **`agy:*`** IPC (`get-state`/`set-enabled`)
  installs/removes the statusLine hook and `broadcastSnapshot()`s so the popup's
  Antigravity card appears/disappears at once. `ensureAgyHook()` runs on startup to
  re-assert the hook file if the user left the integration enabled. `dynamicCliMeta`
  (module-level, kept in sync by `refreshLitellmPollers()`) is consulted alongside the
  static `CLI_META` wherever a lookup needs to resolve a `litellm:<id>` (tray recolor in
  `updateTray()`, `open-data-dir`'s `shell.openExternal(provider.baseUrl)` fallback).
- **`trayIcon.js`** — renders the tray icon at runtime as a raw BGRA bitmap
  (`nativeImage.createFromBitmap`) so no image asset files are needed; recolored by the
  most recently active CLI (built-in or dynamic LiteLLM provider).
- **`autoLaunch.js`** — the "Start at login" tray checkbox, plus `migrateLegacyRunKeys()`
  (one-time removal of the pre-rename `com.tokenstatus.app` Run value). Sits here rather
  than in `core/` because it imports `electron`. On Windows `getLoginItemSettings`
  matches by path+args while `setLoginItemSettings` writes by registry value name, so
  both go through one `loginItemOpts()` — when they disagreed, the checkbox reported a
  state the app had never written and autostart couldn't be turned off.
- **`agyQuota.js`** — the opt-in **Antigravity (`agy`) live-quota** integration. agy has
  no local quota file or usable API — the numbers live only in the running CLI's memory
  (its `/usage` view). But agy, like Claude Code, pipes its live session-state JSON —
  including a `quota` map of per-model-pool `{remaining_fraction, reset_time,
  reset_in_seconds}` — to a configured **statusLine command** on every render. So
  `enableAgyQuota()` writes a tiny hook script (`~/.tokenstats/agyStatusHook.cjs`) and
  points agy's `settings.json` `statusLine.command` at it; the hook mirrors that JSON to
  `~/.tokenstats/agy_status.json`. `agyResetWindows()` reads the mirror and returns the
  **Gemini** pools (driven by the most-consumed one) as a weekly live window in the same
  shape `codexResetWindows()` uses, fed into `mergeLiveLimits()` under `liveByCli.agy` so
  the popup shows an **Antigravity** live card. Refreshes for free on `agy` **CLI** use
  (not the IDE) — no OAuth, no spawning agy, no quota spent. `getAgyQuotaState()` /
  `disableAgyQuota()` back the **Settings → App** toggle; it never clobbers a statusLine
  the user set themselves. **Gotcha**: agy runs `statusLine.command` by naive
  space-splitting with **no shell/quote handling**, so the installed command must be
  **unquoted** (`node C:/…/agyStatusHook.cjs`) — a quoted path is passed to node
  literally and never runs (space-containing paths therefore unsupported). Imports only
  `node:*`, no `electron`.
- **`src/preload/index.js`** — CommonJS (`require`) contextBridge exposing
  `window.api`: `getSnapshot`, `onSnapshot`, `openDataDir`, `hide`, `quit`,
  `openSettings`, the `litellm*` and `subs*` methods (incl. `subsResets`), the
  **language** methods (`getLanguage`/`setLanguage`/`onLanguage`), and the **agy**
  quota toggle (`agyGetState`/`agySetEnabled`) — all mirroring the IPC handlers above.
  Built to `out/preload/index.cjs`; `index.js` references it by the `.cjs` extension.

  Main also owns the **SQLite ingest** (throttled to ≤ once / 4s via `scheduleIngest`,
  forced on report open and manual refresh), the **report window** (`openReport` — a
  normal resizable window loading the renderer with `#report`), and **PNG export**
  (`exportReportPng` grows the window to full content height, `capturePage()`, then a
  save dialog). Set `AIMON_AUTO_REPORT=1` to auto-open the report on launch for testing.

### Renderer — `src/renderer/`

React + Vite, three views selected by URL hash in `main.jsx`:
- **`i18n.js`** — a dependency-free **English / 简体中文** layer for all three windows
  (renderer can't import from main). Exports `t(key, params)`, a `useLang()` hook, and
  `setLang()`. The choice lives in `localStorage` for instant, no-flash switching; the
  three windows share one origin so a `storage` event syncs them, and `setLang()` also
  calls `window.api.setLanguage()` so the **native tray menu** follows (main persists it
  to `config.json` via `paths.js`'s `saveLanguage`, and rebroadcasts `onLanguage`).
  Currency stays USD in both languages. A top-level `useLang()` in each view re-renders
  the whole tree on switch, so nested components can call the module-level `t()` directly.
- **`App.jsx`** — the tray popup. Reads the snapshot via `window.api`, subscribes to
  live updates, and renders a hero total, one **card per CLI** with usage in the
  selected scope, and a live-activity footer. The hero row also shows the **active
  subscriptions' total `$/mo`** (summed from `subsList()`, active only) right-aligned.
  Header has the scope tabs plus Report/Settings buttons.
  - **Scope tabs are 日 / 周 / 月** (`scope` = `'day'|'week'|'month'`), reading the
    snapshot's calendar-aligned buckets (`todayPerCli` / `weekPerCli` / `monthPerCli`
    and their `*PerModel` twins). Calendar, not rolling, so a scope matches the
    cycle a plan's quota resets on — see `store.snapshot()` above. There is no
    "all-time" tab; that view is the report window's job.
  - Both the hero badge and every plan-bound card compare the scope's usage cost
    against the subscription fee **prorated to that same span** (`SCOPE_DIV`:
    month = the fee, week = fee/4, day = fee/28 — a month is treated as 4×7 days
    so the week and day divisors stay consistent with each other), ending in a
    value % on the same `valueClass` scale (the hero shows only the fee, no %). A plan bound to several CLIs shows
    its whole share on each of their cards; the fee is not split, since there's
    no meaningful way to attribute it.
  - Token counts go through `fmtCount()` (i18n.js), which switches counting
    systems with the language: 万 / 千万 / 亿 in Chinese, K / M / B in English.
    "250.67M" is not a number a Chinese reader parses at a glance. The hero line
    shows tokens plus the scope-prorated subscription fee only — no estimated
    cost, no value % (the per-card rows carry the comparison).
  - Every live window is ONE row — label · headroom bar · % · countdown chip.
    What the window actually spent (tokens/cost, filled by `mergeLiveLimits`)
    lives in the bar's `title`, not on screen: a line per window was the widest
    element in a 380px card and shoved the layout around.
  - The scope tab labels use `scope.day/week/month`, NOT `common.month` — that
    key already means "个月" (a count of months, used by the report), and since
    `i18n.js` is one flat object literal a duplicate key silently wins.
  - Each card carries its plan's **live quota** (`QuotaBig`, fed by
    `window.api.subsResets()`); windows still on an *estimate* are not drawn at all.
    Per live window: a headroom bar on a green→red scale (`levelColor`, deliberately
    unrelated to the CLI brand colors — it means "how much is left", never "which
    tool"), a countdown chip whose clock (`ClockIcon`/`pieSlice`) is a dial draining
    with the time remaining, and a **value line** — tokens spent inside that window,
    what they'd cost pay-as-you-go, and the slice of the monthly fee covering the
    same span (`proratedFee`, prorated off the real billing-month length from
    `renewal.periodMs`), ending in a value % (`valueClass`: ≥100% green, ≥50% amber,
    else red). The window's tokens/cost come from `mergeLiveLimits` filling the
    live window's own `[end - periodMs, end)` span, so the numbers and the bar
    above them always describe the same period.
  - The billing row below (shown only when `monthlyUsd > 0`) is the **other**,
    unrelated clock: renewal countdown + fee, with the current cycle's usage worth
    and value % from `renewal.{cost,tokens}`. Quota and billing must never read as
    the same thing.
  - Refetched on each **snapshot** (usage is the only thing besides time that moves
    a window) rather than polled, so a hidden popup stays quiet; a 30s `setInterval`
    re-renders countdowns, and remaining time is derived locally from each window's
    `end` so an expiry mid-tick needs no IPC round-trip. Space is the constraint at
    380px wide — exact turns and wall-clock reset/bill times live in `title`
    tooltips. Header, tabs and footer are pinned; the middle sits in a `.scroll`
    region (`flex:1; min-height:0; overflow-y:auto`) so content is never clipped
    when the window is shorter than the content — which is what makes the
    height-capping in `index.js` safe.
- **`Report.jsx`** (`#report`) — the "Token Report" window. Pulls hourly/daily/model
  data from the SQLite DB via IPC and draws hand-rolled **SVG stacked-bar charts** (no
  chart lib): by-hour for a chosen day, daily trend over a range (7d/30d/all),
  summary tiles (incl. a "Plan fees" tile — actual subscription money billed in the
  range, from `subs:breakdown`), and a breakdown card with **By plan** (default —
  usage grouped under the token plan covering it, each plan showing in-range fees vs
  worth, value %, and a share-of-total bar; unmatched usage lands in a "No plan"
  bucket) / By model / By project modes. Tab labels: Charts, By hour, **Logs** (the
  per-request table), **Token Plans**. The **Export PNG** button calls
  `window.api.exportPng()`.
  The **Token Plans** tab (`SubsView`) renders `window.api.subsStats()` — summary
  tiles (active $/mo, total paid, usage worth, value %), a **zoomable
  subscription timeline** (`PlanTimeline`: Gantt lane per plan with one fee-
  labeled segment per billing cycle, alternating opacity marking cycle
  boundaries; a per-day stacked token-usage band colored by owning plan; a
  today marker; and the visible window's per-plan/model breakdown underneath,
  reusing `PlanBreakdown`. Stock-chart interaction — wheel zooms around the
  cursor via a NON-passive native listener (React's synthetic onWheel is
  passive, preventDefault would be ignored), pointer-drag pans, both clamped
  to the data span; every window move re-fetches `subs:timeline` debounced
  120ms), a **plan comparison**
  card (`PlanCompare`: per plan, fees-paid vs usage-worth horizontal bars on one
  shared USD scale, value %, token consumption on its own scale, and the
  effective paid-$/1M-tokens unit price), a paired-bar chart of
  fees-paid vs usage-worth per calendar month merged across all plans
  (`PairedBars`; fee `#6478cf` / worth `#1fa87c`, a CVD-validated 2-slot pair
  distinct from every CLI brand color), and a per-plan card with a
  per-billing-cycle fee-vs-usage table whose Value column carries an inline
  ratio bar with a tick at 100% (break-even). The `.report` container scrolls
  internally (`height: 100vh; overflow-y: auto` — body is `overflow: hidden`),
  which is what makes long Settings/Report pages reachable; `exportPng` in
  `index.js` therefore measures `.report`'s `scrollHeight`, not body's.
- **`Settings.jsx`** (`#settings`) — two sections. **Subscription plans**:
  add/edit/delete plan cards (name, USD/month, start date, active toggle — deactivating
  stamps `endDate` = today, reactivating clears it) with preset templates
  (Claude/ChatGPT/Google AI/Cursor/Mimo) and per-source binding checkboxes; a LiteLLM
  binding additionally offers a key-alias input and a load-models checkbox picker for
  the model filter. An active plan also ticks any subset of **token quota resets**
  (`RESET_OPTIONS` — 5h / weekly / monthly), which drives the popup's Quota windows
  section; the control is hidden for inactive plans since only active ones are
  tracked. Each ticked *anchored* period (`o.anchor` — weekly, monthly) reveals its
  own input: weekly a `datetime-local` (it needs a time of day), monthly a `date`,
  both defaulting to the start date via `defaultAnchor()`. 5h shows none — it's
  rolling, so there is nothing to set. **LiteLLM providers**: add/edit/delete
  provider cards (name, color, base URL, admin key, sync minutes), a "Test
  connection"/"Models" action that calls `litellmListModels()` (throttle-free, works
  for an unsaved draft), and per-model checkboxes (visible) + rename inputs that call
  `litellmSaveModelSetting()` on change/blur.

Both `App.jsx` and `Report.jsx` merge the 5 fixed built-in CLIs with the currently
active LiteLLM providers into local `CLI`/`ORDER` — see "Dynamic LiteLLM providers"
below. No router, no state library.

## Conventions and gotchas

- **`"type": "module"`** — the whole project is ESM. The standalone test script is
  `.mjs`; the preload is emitted as CommonJS `.cjs` (sandbox requires `require`).
- **Adding a fixed CLI**: add `parsers/<cli>.js` implementing the parser contract,
  register it in `store.js`'s `PARSERS` array, add metadata in `paths.js`'s
  `CLI_META` and `App.jsx`'s `FIXED_CLI`/`FIXED_ORDER` (and `Report.jsx`'s, which
  duplicates them), and a pricing row. Nothing else needs to change. This path is for
  CLIs with local files to watch; it's how the 5 built-ins (claude/codex/gemini/
  agy/cursor) work.
- **Adding a LiteLLM provider** is a *user* action, not a code change: the Settings
  UI writes a row to `usage.sqlite`'s `litellm_providers` table, and it becomes a
  dynamic pseudo-CLI (`litellm:<providerId>`) automatically — see "Dynamic LiteLLM
  providers" below. Only touch `parsers/litellm.js`/`db.js` when changing behavior
  that applies to *every* provider (e.g. the admin API shape, or what a "model
  setting" can control), never per-provider.
- **Dynamic LiteLLM providers**: unlike the 5 fixed CLIs, LiteLLM providers aren't
  hardcoded anywhere — `store.snapshot()` returns a `providers: [{id, label, color}]`
  field built from `this.pollers` (each `litellm:<id>`), and `App.jsx`/`Report.jsx`
  merge that onto their `FIXED_CLI`/`FIXED_ORDER` constants in a `useMemo` to build
  the `CLI`/`ORDER` used for rendering (`Report.jsx` has no live snapshot, so it
  fetches `window.api.litellmListProviders()` directly instead). Both files pass
  `CLI`/`ORDER` down as props to their `Legend`/`StackedBars`/`RequestLog` helper
  components rather than reading module-level constants. Because the hourly SQLite
  table can outlive a deleted provider, every `CLI[id]` lookup outside an
  `ORDER`-driven loop goes through a `FALLBACK_META(id)`/`metaFor()` helper instead
  of risking `undefined`.
- **Data formats are version-specific**: these parsers were written against observed
  on-disk shapes (Claude `message.usage`, Codex `event_msg`/`token_count`
  `total_token_usage`, Gemini `gemini`-type messages' `tokens`). A CLI update can change
  them — e.g. Gemini switched chat logs from `.json` to `.jsonl`, which is why both are
  parsed. Validate with `npm run test:parsers` against real data after any CLI update.
- **De-duplication (accuracy-critical)**: two CLIs write the *same* usage row to disk
  multiple times, which would massively inflate totals if counted naively:
  - **Claude** emits one JSONL line per assistant *content block* (thinking / text /
    each tool_use), all sharing one `message.usage`; the same `(message.id, requestId)`
    also reappears across files on session resume. Measured inflation ≈ **1.8×**.
  - **Gemini** re-writes the running conversation on each save, re-appending earlier
    messages (identical `id` + `tokens`) to the `.jsonl`. Measured inflation ≈ **1.8×**.
  Both parsers therefore set a **`dedupKey`** on each record; `store.dedupedRecords()`
  (used by `snapshot()` and the DB ingest) keeps one record per key. Keyless records
  (Codex, Antigravity) always pass through. `allRecords()` stays raw — never aggregate
  token counts off it directly.
- **Codex token math** uses the per-turn **delta of the cumulative
  `total_token_usage`**, *not* the sum of `last_token_usage`. `total_token_usage` is
  monotonic and authoritative; summing `last_token_usage` over-counts in practice
  (a measured 31-turn session summed to 347k vs a true cumulative of 183k). `state.cum`
  carries the previous cumulative per file; a counter reset (compaction) is treated as a
  fresh zero baseline.
- "Today" uses the **local** calendar day so it matches the user's wall clock.
- **LiteLLM** (`parsers/litellm.js`) polls `{baseUrl}/user/daily/activity`, an
  internal/undocumented admin endpoint (not the documented public LiteLLM API) —
  re-validate its response shape after LiteLLM upgrades. Quirks to know:
  - Its `page`/`total_pages` pagination is **not day-aligned** — a single date's
    per-model rows can be split across adjacent pages. The parser just flattens
    every per-model/per-key leaf across every page it fetches (35-day lookback,
    capped at 40 pages/poll); leaves don't repeat across pages in practice, and
    `dedupKey` (`litellm:<providerId>:<date>:<model>:<keyHash>` — namespaced by
    provider since the multi-provider Settings feature, so two providers can never
    collide on the same date/model/keyHash) makes it harmless if they did.
  - It has no per-request timestamps, only a day + model + API-key breakdown, so
    one record = one (day, model, key) bucket, timestamped at noon UTC for that day
    (keeps it inside the same local calendar day everywhere, for "today" bucketing).
    `key_alias` (e.g. a per-device key name) becomes the record's `project`, which
    is the closest analog to per-project/session grouping this data supports.
  - Buckets with zero `total_tokens` (a model that only ever failed) are dropped
    entirely, so models with no real usage never show up in the model breakdown —
    intentional per user request, not a bug if you see registered models missing.
  - Per-provider **model visibility/rename** (`litellm_model_settings` in `db.js`) is
    applied as the *last* step, in `applyModelSettings()`, after `dedupKey` is
    computed from the raw API model id — so renaming a model's display name never
    perturbs dedup/grouping identity, and hiding a model drops its records entirely
    (same "zero-usage dropped" precedent as above). This is safe against
    `pricing.js`'s cost estimate table too: `costFor()` prefers a record's real
    `cost` over any model-name lookup, and LiteLLM records always carry one.
  - `test:parsers`/`test:db` (the headless scripts) don't wire any LiteLLM pollers —
    they only exercise `PARSERS` (file-based CLIs). LiteLLM pollers are built
    exclusively by `index.js`'s `refreshLitellmPollers()` from DB provider rows, so
    testing LiteLLM changes requires the real Electron app (`npm run dev`) with at
    least one provider configured via Settings.
