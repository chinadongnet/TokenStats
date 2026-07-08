# Repository Guidelines

## Project Structure & Module Organization

TokenStats is an Electron/Vite desktop app. Main-process code lives in `src/main`, with core logic in `src/main/core` and CLI parsers in `src/main/core/parsers`. The preload bridge is `src/preload/index.js`. The React renderer is in `src/renderer/src`, including `App.jsx`, `Report.jsx`, `Settings.jsx`, `main.jsx`, and `styles.css`. Static app resources belong in `resources`. Build output is generated in `out` and packaged artifacts in `dist`; do not edit either by hand.

## Build, Test, and Development Commands

- `npm run dev` starts the Electron app with Vite hot reload for local development.
- `npm run build` compiles the app into `out`.
- `npm start` previews the built app.
- `npm run test:parsers` runs parser checks against local CLI transcript data and prints totals.
- `npm run test:db` exercises the local SQLite/sql.js database flow.
- `npm run package` builds an unpacked Electron package in `dist`; `npm run package:nsis` builds the Windows installer.

## Coding Style & Naming Conventions

Use JavaScript ES modules and React JSX, matching the existing code. Prefer two-space indentation, `const`/`let`, descriptive camelCase identifiers, and small modules grouped by responsibility. Parser modules should be named after their CLI, for example `claude.js` or `codex.js`, and keep CLI-specific parsing isolated from shared storage and pricing logic. There is no configured linter or formatter, so follow nearby style.

## Testing Guidelines

There is no full unit-test framework configured. Before submitting parser or persistence changes, run `npm run test:parsers` and `npm run test:db`. For UI or tray behavior, run `npm run dev` and manually verify the tray popup, report window, filters, and export behavior. When adding a parser, extend `scripts/test-parsers.mjs` or a comparable script.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries, such as `Add brand filter to usage report` and `Show only today's models under the popup's Today tab`. Follow that style: one focused subject line, capitalized, no trailing period. Pull requests should describe the user-visible change, list verification commands run, mention affected CLIs or data paths, and include screenshots or short notes for UI changes.

## Security & Configuration Tips

The app reads local CLI logs and writes configuration/database files under `~/.tokenstatus`. Do not commit personal transcript data, generated databases, installers, or machine-specific paths. Keep pricing changes in `src/main/core/pricing.js` explicit because cost values are estimates. One exception to "local files only": `parsers/cursor.js` calls an undocumented cursor.com endpoint using the session token the Cursor IDE already stores locally, since Cursor's local files no longer carry real token counts — see the header comment in that file before changing it.
