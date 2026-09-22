# Task Planner

A personal task planner: capture tasks in one place, see what's relevant
today, and stop losing things in a giant backlog. Backed by a Google Sheet
(so the data is always yours and easy to look at directly) via a small
Google Apps Script backend, with a plain HTML/JS frontend on GitHub Pages —
no build step, no frameworks, no third-party scripts.

This is a rebuild-in-progress. The original version worked but had real
security and reliability problems (see `docs/00-what-we-built-security.md`
for the first one fixed). It's being replaced a phase at a time, with each
phase actually used for a while before the next one starts.

## Current status: Phase 2 — touch-first UI

Phase 2 replaces the old drag-and-drop, weekday-based screen with a
touch-first app: a Today view (capture box + a handful of tasks + "Pick 3
for me"), a Week view, and a Someday list — all built with real dates, an
offline-safe save queue, and no build step. See
`docs/01-what-we-built-data-and-ui.md` for what changed and why.

Try it without a device key or a real backend by adding `?mock=1` to the
URL — the app runs entirely against an in-memory fake with realistic
sample tasks.

See the full phase list and architecture in the project plan (kept outside
this repo, with the person driving the rebuild).

## File map

| Path | What it is |
|---|---|
| `index.html` | The app shell — markup only, no inline scripts or styles (strict CSP). |
| `styles.css` | All styling: CSS custom properties, light/dark via `prefers-color-scheme`, no framework. |
| `js/api.js` | Talks to the server (`api()`, lifted from spike.js) plus a `?mock=1` in-memory fake backend. |
| `js/store.js` | App state, the localStorage task cache, and the outgoing-changes queue. |
| `js/logic.js` | Pure functions only — capture parsing, "Pick 3", date helpers, grouping. No DOM, so it's fully unit-tested. |
| `js/ui.js` | All DOM rendering: task rows, the action sheet, the edit form, the undo toast. |
| `js/app.js` | Wires the above together: what happens when you tap something. |
| `test/logic.test.mjs` | Runs with plain `node test/logic.test.mjs` — no install needed. |
| `spike.html` / `spike.js` | Phase 0 connection-test page: save a device key, Ping the server, List tasks. Kept for reference. |
| `config.js` | Public config — the Apps Script URL(s). Safe to commit (see comment in the file for why). |
| `apps-script/Code.gs` | The Google Apps Script backend (paste into the Apps Script editor). |
| `apps-script/appsscript.json` | The Apps Script project manifest (timezone, web app settings). |
| `docs/RUNBOOK.md` | Exact click-by-click steps: setup, deploying changes, rotating the device key, testing. |
| `docs/00-what-we-built-security.md` | Plain-English explanation of what Phase 0 fixed and why. |
| `docs/01-what-we-built-data-and-ui.md` | Plain-English explanation of what Phase 2 built and why. |

## Getting started

Follow `docs/RUNBOOK.md`, section A, from the top. It assumes no prior
Apps Script experience.

## A note on secrets

Nothing in this repo should ever be a real secret. The device key lives
only in Script Properties (server side) and in each device's local
storage — never in a committed file. If you ever see a device key,
password, or other credential in a file in this repo, treat it as
compromised and rotate it (see `docs/RUNBOOK.md`, section E).
