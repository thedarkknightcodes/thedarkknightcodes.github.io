# Handover — Task Planner (for the next build, in a fresh chat)

Written 2026-09-22 at the end of the first build. Read this before touching code. The owner is a non-coder with ADHD who is learning; keep explanations plain, keep the app calm, and never ask them for the device key or the Gemini key.

## 1. What exists

A personal task planner. Static PWA on GitHub Pages → Google Apps Script web app → Google Sheet. Everything AI goes through Gemini from the script; a weekly review can also be written by Claude from the owner's laptop.

| Thing | Where |
|---|---|
| Repo (public) | github.com/thedarkknightcodes/thedarkknightcodes.github.io — local clone `C:\Users\nayee\Documents\Claude\task-planner` |
| Live app | https://thedarkknightcodes.github.io/ — demo mode `?mock=1` (no key, fake data, all UI states; `&review=1`, `&fallback=1`) |
| Connection test page | `/spike.html` (Ping shows deployed backend version) |
| Backend source | `apps-script/Code.gs` (single file, ~4.8k lines, v0.7.0) + `apps-script/appsscript.json`. The owner pastes these into the Apps Script editor by hand — there is no clasp. |
| Backend URL | in `config.js` (`prodUrl`). Same URL as the original leaked deployment: the owner shipped the token-gated code with "New version" on the existing deployment, which is fine. |
| Data | one Google Sheet: tabs `Tasks2` (live), `Log` (every raw capture, written before any AI call), `Reviews`, plus the untouched legacy tab as backup |
| Google side | "Tasks" calendar (id in Script Property `TASKS_CALENDAR_ID`), Google Tasks lists "Planner Inbox" / "Planner Today" (Phase 9), triggers: `nightlyTidy` 03:00, `weeklyGeminiReview` Mon 08:00, `syncFromCalendar` + `syncGoogleTasks` every 10 min |
| Secrets | Script Properties only: `DEVICE_KEY`, `GEMINI_API_KEY`, optional `GEMINI_MODEL` (default `gemini-3.8-flash`), `SHEET_ID` (optional), calendar/list ids. Never in the repo. |
| Docs | `docs/RUNBOOK.md` (click-by-click, sections A–N), `docs/0N-what-we-built-*.md` (one per phase, plain English), original plan at `C:\Users\nayee\.claude\plans\system-reminder-the-user-started-soft-sprout.md` |
| Claude weekly review kit | `tools/weekly-review/` (PowerShell + prompt for a local scheduled task in the Claude desktop app; device key read from `%USERPROFILE%\.task-planner\device_key.txt`) |

Frontend files: `index.html` (shell, strict CSP — no inline JS/CSS/handlers), `styles.css` (tokens, light/dark), `js/app.js` (wiring, optimistic queue, assist/capture handling), `js/api.js` (`api()` + mock backend), `js/store.js`, `js/logic.js` (pure, tested by `test/logic.test.mjs`), `js/ui.js`, `js/sheets.js` (action sheet, edit, settings), `js/review.js`, `sw.js`, `manifest.webmanifest`, `icons/`, `tools/make-icons.mjs`.

## 2. How it works (the parts you must not break)

- **Transport**: every call is `POST` with `Content-Type: text/plain` and a JSON body `{token, action, op_id, ...}` in normal CORS mode. That is a CORS "simple request" (no preflight — Apps Script can't answer one) and the redirect to `script.googleusercontent.com` is followed so the JSON is readable. `doPost` is wrapped in try/catch and ALWAYS returns JSON; an uncaught exception would return HTML with no CORS headers and the browser would only see "Failed to fetch".
- **Auth**: 64-char device key compared constant-time against `DEVICE_KEY`; global bad-token counter in CacheService locks out wrong keys for 10 min (the correct key always works). The exec URL is safe to be public because of this.
- **Idempotency**: the client makes the UUID for every new task and an `op_id` for every op; `add`/`capture`/`assist` return the earlier result on a repeated `op_id` (assist stores its result in Log's `op_id`/`result` columns). This is what makes the offline queue and retries safe.
- **Sheet hygiene**: all dates are plain text (`YYYY-MM-DD`, `HH:mm`, ISO timestamps); Tasks2 is number-formatted `@` so Sheets never turns them into Date objects. Columns are looked up by header name, rows by id; `ensureTab_` backfills new header columns on existing tabs. LockService wraps sheet read-modify-write only; Gemini and calendar calls stay outside the lock where possible.
- **AI calls**: `callGemini_`/`callGeminiAssist_` use `generateContent` with `responseMimeType: application/json` + a `responseSchema`; results go through pure parsers (`parseGeminiTasks_`, `parseAssistResult_`, `validateReview_`) that drop unknown ids and clamp lengths. Any AI failure degrades to "save the raw text as one Inbox task" — capture never fails and never blocks the UI.
- **Calendar**: dated active tasks → event in the Tasks calendar (`syncTaskEvent_`); reverse direction via `syncFromCalendar` with a last-updated comparison to avoid ping-pong. The digest is a 07:30 event rebuilt nightly. A calendar failure never fails a task write.
- **Design rules** (from the owner's brief, deliberate): no red, no "overdue", no counts of waiting work (a count is allowed only for *new* or *done* things), nothing is ever deleted (drop = hidden status), every mutation has Undo instead of confirm(), all targets ≥44px, works by tap alone, home screen shows only Today.

## 3. Landmines already stepped on

1. "Deploy → New deployment" creates a NEW URL; shipping code is "Manage deployments → pencil → New version". RUNBOOK C.
2. Adding a Google service to the script does not re-prompt for permission if it was authorised earlier. Fix: https://myaccount.google.com/permissions → Remove access → run a function again. RUNBOOK K. Expect this again for any new scope (Gmail, Drive…).
3. CalendarApp rate-limits bursts ("Service invoked too many times"); sleep between writes and never touch the calendar for rows that don't need it.
4. All-day event popup reminders count back from midnight (0 min = 00:00 buzz). We use 900 = 09:00 the day before.
5. Apps Script time triggers fire within ±15 min of the hour.
6. Android: the manifest is cached; after changing `share_target`/colours the app must be uninstalled and reinstalled. Bump `CACHE_VERSION` in `sw.js` on every deploy of frontend files.
7. Gemini free tier: UK terms are a grey area; enabling billing costs pennies and gives no-training data handling. The owner was told; their call.
8. The very first repo commit leaked the exec URL; the old rows are treated as exposed. Don't put a new secret anywhere in the repo.

## 4. Where things stood at handover

Owner had: migrated tasks, deployed ≥0.4.x, re-authorised Calendar, Gemini key working, digest event created, and given feedback after a day's use. Not yet confirmed: paste of v0.7.0 + Google Tasks API enablement (RUNBOOK N), Claude scheduled task set up. Ask, don't assume; `spike.html` Ping shows the deployed version.

## 5. The next build — brief from the owner (verbatim intent, lightly ordered)

The owner's words: "one of my biggest barriers in life is the intention-action gap and I've spent all my life beating myself for it." Everything below serves that, and nothing built may add to the self-criticism.

**Vision**: upgrade from passive secretary to "an MBB-trained chief of staff with a bias to action". Much more agentic. Generates first drafts for the owner to react to, and executes other things. An ongoing conversation, with the chief of staff able to reach out (notifications), not only answer. Reference point the owner gave: the capabilities of the newly released Meta "Muse" AI agent (check what that is; don't assume).

**Wanted, in the owner's priority language**:
1. **Delegation and low-stakes decisions**: take intelligent low-stakes decisions without asking (day, order, category, estimate, first step, when to fade, which three today); draft outward-facing actions (emails, bookings, messages) for one-tap approval; execute where safe.
2. **Goals and priorities as inputs**: the owner states goals/priorities in natural language; prioritisation, Pick-3 and reviews weigh tasks against them and explain why.
3. **Memory**: it gets to know the owner — who they are, what works and what doesn't — and adapts to strengths and weaknesses over time. Everything it believes must be visible and editable (an "About me" screen); no hidden profile.
4. **Learning loop / Insights**: infer and *test* what's working from data; assess patterns, strengths, weaknesses (time of day, task size, category, response to nudges, planned-vs-done as a pattern never a score); run one small experiment a week and keep/drop it. Insights tab = "what we've learned about you" with charts of what was done (never of what's open), a morning brief (exists: the digest) and an evening reflection. Streaks: current/best only, never "broken".
5. **Open loops / decisions tab**: an explicit place to log open decisions and open loops, and to brainstorm each with the AI (structured: options, what would decide it, a default if nothing happens by a date).
6. Earlier list still wanted: recurring tasks; custom categories with colours (a Categories tab read by app + AI); global search; Upcoming/reminders list; month view (calm, weekend shading, no counts); Pomodoro/focus timer logging minutes; Insights tab.
7. **Intention-action gap tools** (recommended by the first build): rewrite tasks into a two-minute first step; attach when-and-where; nudge at the owner's good hours; body-double focus timer.

**Backend rethink (owner's explicit ask)**: don't shoehorn everything into Google Sheets; use more capable/appropriate storage and runtime per feature. First-build steer, to be decided in plan mode with the owner:
- Tasks/log can stay in Sheets for now (it works, it's free, the owner can see it). Memory, conversation history, decisions and experiment results want a real document/relational store: Firestore or Supabase (Postgres) are the obvious free-tier options; both have HTTP APIs callable from Apps Script *and* from a proper runtime.
- An agent that converses, reaches out and drafts needs somewhere to run longer than a 6-minute Apps Script execution and to be triggered by messages: Cloud Run / Cloudflare Workers / a small VPS, or Claude Agent SDK / managed agents on the Claude platform (the owner has Claude Max; note API billing is separate). Gemini via the API is the cheap default for high-volume calls; Claude for judgement-heavy ones (reviews, decisions).
- Conversation + notifications surface: the PWA can't reliably push (no server to send Web Push from today; iOS PWA push is limited). A messaging bot (Telegram is the least friction; WhatsApp is possible) gives two-way chat *and* notifications on every device with zero install, and voice notes for free. Google Calendar/Tasks remain the "Hey Google" bridge.
- Keep the constraints that made the first build succeed: no build step for the frontend, secrets never in the repo, every AI output validated before it touches data, every action reversible, and the owner able to run/paste/deploy without a terminal.

**Open questions the next chat should ask the owner before designing** (in plan mode):
- Autonomy boundary: what may it do unasked, what needs one tap, what is off-limits (spending, sending, cancelling)?
- Memory boundary: what may it remember (health, family, finances are in the task data), how long, and how does the owner delete a memory?
- Notification appetite: how many nudges a day is welcome before it becomes another source of guilt? Quiet hours?
- Channel: Telegram/WhatsApp bot vs in-app chat vs both.
- Budget: is a few pounds a month of API/hosting acceptable (it unlocks a real runtime), or must it stay £0?
- Decisions tab: what does a "good" decision entry look like to them (they're MBB-fluent — options/criteria/default/deadline?).

## 6. Working agreements that held

- Fable/strongest model plans and reviews; Sonnet sub-agents implement one phase each from a written brief; the reviewer checks the diff, tests in demo mode in the browser pane at phone width, then pushes.
- Every phase ships something the owner uses that day, with a `docs/0N-what-we-built-*.md` note and a RUNBOOK section of exact clicks.
- Commits as author `thedarkknightcodes`; push via Git Credential Manager (no `gh`). Windows; PowerShell 5.1; `curl.exe -L` without `-X POST` for Apps Script.
- Verification floor before any push: `node --check` on every JS file and a temp copy of Code.gs, `node test/logic.test.mjs`, the pure Apps Script helpers extracted and run under node, no `innerHTML` with data, no alert/confirm, no inline handlers.
