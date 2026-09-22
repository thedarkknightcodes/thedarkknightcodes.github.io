# Weekly review — Claude local scheduled task

Phase 7 adds a weekly review: once a week, a short, warm summary of the
week just gone, plus a small handful of suggestions (what's worth doing
this week, what could rest in Someday, what looks stale enough to drop —
never a count of everything still undone). It's written by whichever of
two writers gets there first for a given week:

- **Claude**, via a local scheduled task in the Claude desktop app that
  you set up once, using this folder — this is the better writer, since
  it's your own subscription and it's what this README is about.
- **Gemini**, automatically, every Monday at roughly 08:00, as a safety
  net — see `docs/RUNBOOK.md` section L. If Claude already wrote this
  week's review, Gemini's run quietly does nothing (see `doReviewSave`'s
  Claude-beats-Gemini rule in `Code.gs`). If your laptop was asleep on
  Sunday evening and Claude's task never ran, Gemini's Monday-morning run
  fills in instead — so there's always a review by Monday morning either
  way, it just might not be Claude's.

## What the scheduled task actually does

Every Sunday evening, Claude:

1. Runs `export.ps1`, which fetches this week's tasks and recent captures
   from the backend (the same data Gemini's fallback review uses).
2. Writes a warm, specific review from that data (see `PROMPT.md` for the
   exact instructions it follows, and the JSON shape it writes).
3. Runs `save.ps1` to post that review back to the backend, tagged
   `source: "claude"`.
4. Reports back to you in one line, e.g. "Weekly review saved: A calm
   week, 5 things suggested for the days ahead."

Next time you open the app, if there's a saved review that hasn't been
dismissed and isn't more than 10 days old, you'll see a "Your week,
reviewed" card at the top of Today, tagged "by Claude" or "by Gemini"
depending on which one wrote it.

## One-time setup

### 1. Create your device key file

The scripts in this folder need the same device key the app itself uses
(Settings screen → paste it in on each device) — but as a **file on this
machine**, outside the repo, so it's never something `git` could
accidentally commit.

1. Open PowerShell.
2. Create the folder and file:
   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.task-planner" | Out-Null
   notepad "$env:USERPROFILE\.task-planner\device_key.txt"
   ```
3. Paste in your device key (the same long random string from your
   password manager — see `docs/RUNBOOK.md` section A/E if you need to
   find or rotate it), save, and close Notepad.
4. Nothing else needs to know this file exists — `export.ps1` and
   `save.ps1` both read it automatically from
   `%USERPROFILE%\.task-planner\device_key.txt`.

### 2. Set up the scheduled task in the Claude desktop app

1. Open the Claude desktop app (the one with your Claude Max
   subscription).
2. Create a new scheduled task (however the app currently labels that —
   look for "Schedule" or a clock icon near where you'd start a new
   conversation).
3. Set it to run **weekly, Sunday, 19:00** (or whatever time suits you —
   any time before Monday 08:00 leaves Gemini's safety-net run with
   nothing to do, which is the point).
4. Give it access to this repo (`task-planner`) as its working directory,
   and to run PowerShell commands in it.
5. Paste in the contents of `PROMPT.md` in this folder as the task's
   prompt.
6. Save it. That's it — no code changes, nothing to deploy.

### 3. Try it once by hand

Before waiting for Sunday, you can run the same thing manually to check
it all works:

```powershell
cd task-planner
.\tools\weekly-review\export.ps1
```

You should see one line of JSON print out (tasks + recent captures). If
that works, the scheduled task's first step will too. You can also just
start a new conversation in the Claude desktop app and paste in
`PROMPT.md` yourself to run the whole thing once, right now, instead of
waiting for the schedule.

## A note on `curl.exe -L` and no `-X POST`

Both `export.ps1` and `save.ps1` call:

```
curl.exe -sL -H "Content-Type: text/plain" --data-binary @body.json <url>
```

Two things about that are deliberate:

- **`-L`** — an Apps Script `/exec` URL always responds with a redirect to
  where the actual content is served from; `-L` makes curl follow it.
- **No `-X POST`** — `--data-binary` already makes the request a POST on
  its own. Adding `-X POST` explicitly changes how curl behaves across
  that redirect and the request comes back **405 Method Not Allowed**
  instead of your JSON. If you're ever tempted to "fix" one of these
  scripts by adding `-X POST` back in — don't; that's what breaks it.

## If something goes wrong

- **"No device key found"** — you haven't done step 1 above yet, or typed
  the path wrong. The file must be at exactly
  `%USERPROFILE%\.task-planner\device_key.txt`.
- **A 405 or a non-JSON response** — almost always someone added
  `-X POST` back into one of the scripts (see above), or `config.js`'s
  `prodUrl` is stale (check it matches your current Apps Script
  deployment — see `docs/RUNBOOK.md` section C).
- **The review card never shows up** — check `review_get` isn't seeing a
  review that's already 10+ days old (it auto-expires — see
  `isReviewFresh_` in `Code.gs`), or that Sunday's task actually ran (the
  Claude desktop app should show you its scheduled task history).
