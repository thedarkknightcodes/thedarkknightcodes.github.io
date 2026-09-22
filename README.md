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

## Current status: Phase 8 — secretary mode

Phase 8 turns the one capture box into the way to do everything, not just
add tasks — the goal (the user's own words): "the less I need to fiddle
with the app and the more I can just use natural language/voice to let AI
do the manipulation, the better." Type or dictate a brain-dump as before,
or a command ("move the dentist to Friday", "I did the recycling", "put
the photo albums in someday"), or a plain question ("what's due this
week?"), or a mix of any of those in one go. A new backend action,
`assist`, decides which it was — new tasks go through the same rules as a
plain capture; changes to existing tasks are validated against the exact
task ids Gemini was actually shown, so a hallucinated id or an
unrecognised instruction can never touch your data. A short reply shows
under the box, with an Undo for anything it changed. See
`docs/06-what-we-built-secretary-mode.md` for what changed and why, and
`docs/RUNBOOK.md` section M for how to turn it on.

Phase 7 adds a weekly review: once a week, a short, warm summary of the
week just gone (1–3 concrete wins, never a count of what's undone), plus a
small handful of suggestions — what's worth doing this week, what could
rest in Someday, what looks stale enough to drop. It's written by an
outside reviewer, not the app itself: Gemini automatically every Monday
morning as a safety net, or Claude via a local scheduled task you set up
yourself (the better writer, and it always wins if both exist for the same
week). Every review is checked by `validateReview_` before it can touch
the sheet, so a hallucinated task id or an overlong list can never reach
what you see. See `docs/05-what-we-built-weekly-review.md` for what
changed and why, `docs/RUNBOOK.md` section L for how to turn it on, and
`tools/weekly-review/README.md` for setting up the Claude side of it.

That was the last of the phases from the original plan — a second round
started after real daily use, of which Phase 8 (secretary mode, above) is
the first. The app now covers capture, natural-language commands and
questions, scheduling, AI sorting, install-to-home-screen, sharing from
other apps, calendar reminders, and a weekly review, all on a Google Sheet
you can always open and read directly.

Phase 6 adds real calendar reminders: every task with a due date gets an
event (with a popup notification) in its own "Tasks" Google Calendar,
never your main one. A nightly job quietly unschedules anything left on a
day that's passed and fades long-untouched tasks to Someday — nothing is
ever deleted — then rebuilds one calm 07:30 "here's today" digest event
instead of a pile of separate reminders. See
`docs/04-what-we-built-share-and-reminders.md` for what changed and why,
and `docs/RUNBOOK.md` section K for how to turn it on.

Phase 5 made the app a **share target** on Android: once installed, you
can share text straight into it from any app (Chrome, Keep, a voice
recorder, whatever) instead of having to open the app and retype it. See
`docs/04-what-we-built-share-and-reminders.md` and `docs/RUNBOOK.md`
section J.

Phase 4 turns the capture box into a "brain-dump" box: type or paste a
messy ramble, and Gemini (a Google AI model) splits it into separate,
tidy tasks for you. Your raw text is always logged before the AI is ever
called, and if Gemini fails for any reason the whole ramble is saved as
one Inbox task instead of being lost. See
`docs/03-what-we-built-ai-capture.md` for what changed and why, and
`docs/RUNBOOK.md` section I for how to turn it on.

Phase 3 made the app installable: a manifest and icons so "Install app" /
"Add to Home Screen" works on Pixel and iPad, plus a service worker that
caches the app shell (the screen itself, not your tasks) so it still opens
with no signal. See `docs/02-what-we-built-pwa.md` for what changed and
why, and `docs/RUNBOOK.md` section H for install steps per device.

Phase 2 replaced the old drag-and-drop, weekday-based screen with a
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
| `js/ui.js` | All DOM rendering: task rows, the undo toast, the key/main screens. |
| `js/app.js` | Wires the above together: what happens when you tap something. |
| `js/sheets.js` | The action sheet, edit form and settings sheet (the three popups). |
| `js/review.js` | The weekly review card (Phase 7): summary, wins, and the tickable suggestion lists. |
| `test/logic.test.mjs` | Runs with plain `node test/logic.test.mjs` — no install needed. |
| `spike.html` / `spike.js` | Phase 0 connection-test page: save a device key, Ping the server, List tasks. Kept for reference. |
| `config.js` | Public config — the Apps Script URL(s). Safe to commit (see comment in the file for why). |
| `manifest.webmanifest` | PWA manifest: name, icons, colours, install behaviour, share target. |
| `sw.js` | Service worker: caches the app shell so it works offline; bump `CACHE_VERSION` per release. |
| `icons/` | App icons (192/512/maskable/Apple touch), built by `tools/make-icons.mjs`. |
| `tools/make-icons.mjs` | Generates the icon PNGs from scratch, no dependencies — run with `node tools/make-icons.mjs`. |
| `apps-script/Code.gs` | The Google Apps Script backend (paste into the Apps Script editor). |
| `apps-script/appsscript.json` | The Apps Script project manifest (timezone, web app settings). |
| `docs/RUNBOOK.md` | Exact click-by-click steps: setup, deploying changes, rotating the device key, testing, installing on devices. |
| `docs/00-what-we-built-security.md` | Plain-English explanation of what Phase 0 fixed and why. |
| `docs/01-what-we-built-data-and-ui.md` | Plain-English explanation of what Phase 2 built and why. |
| `docs/02-what-we-built-pwa.md` | Plain-English explanation of what Phase 3 built and why. |
| `docs/03-what-we-built-ai-capture.md` | Plain-English explanation of what Phase 4 built and why. |
| `docs/04-what-we-built-share-and-reminders.md` | Plain-English explanation of what Phases 5 and 6 built and why. |
| `docs/05-what-we-built-weekly-review.md` | Plain-English explanation of what Phase 7 built and why. |
| `docs/06-what-we-built-secretary-mode.md` | Plain-English explanation of what Phase 8 built and why. |
| `tools/weekly-review/` | The Claude-side weekly review kit: `export.ps1`/`save.ps1` (PowerShell, call the backend), `PROMPT.md` (the scheduled task's exact instructions), `README.md` (setup steps). |

## Getting started

Follow `docs/RUNBOOK.md`, section A, from the top. It assumes no prior
Apps Script experience.

## A note on secrets

Nothing in this repo should ever be a real secret. The device key lives
only in Script Properties (server side) and in each device's local
storage — never in a committed file. If you ever see a device key,
password, or other credential in a file in this repo, treat it as
compromised and rotate it (see `docs/RUNBOOK.md`, section E).
