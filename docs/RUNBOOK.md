# Runbook

Exact, click-by-click steps. You don't need to know how to code to follow
these — just follow the numbers in order. Whenever a step says "Apps
Script editor", that's the code-editing screen you reach from your Google
Sheet.

---

## A. Phase 0 setup (do this once to get the new backend running)

1. Open the Google Sheet that has your tasks in it.
2. Menu bar → **Extensions → Apps Script**. This opens the Apps Script
   editor in a new tab.
3. *(Optional but recommended)* Before changing anything, copy the existing
   code somewhere safe (a new Google Doc, or a text file on your computer)
   as a backup. Just select all the text in the current `Code.gs` tab and
   paste it somewhere.
4. In the Apps Script editor, open the file named `Code.gs` on the left.
   Select all of its contents and delete them, then paste in the entire
   contents of this repo's `apps-script/Code.gs` file.
5. On the left sidebar, click the gear icon (**Project Settings**).
6. Tick the checkbox **"Show 'appsscript.json' manifest file in editor"**.
7. Go back to the editor (left sidebar, the `<>` icon). You should now see
   an `appsscript.json` file. Open it, select all, delete, and paste in the
   contents of this repo's `apps-script/appsscript.json` file. Save
   (Ctrl+S / Cmd+S).
8. At the top of the editor there's a function dropdown (it may say
   `doPost` or similar). Click it and choose **`setup`**.
9. Click **Run** (the play-button icon next to the dropdown).
10. The first time you run anything, Google will ask you to **authorise**
    the script. Click through: "Review permissions" → pick your Google
    account → you may see an "unverified app" warning because this is your
    own script — click **Advanced** → **Go to (project name) (unsafe)** →
    **Allow**. This is expected for a script only you use.
11. Once it finishes, go to **View → Logs** (or **Execution log** at the
    bottom). You'll see a long random string of letters and numbers — that
    is your **device key**.
12. **Copy that device key into your password manager right now.** It is
    only shown this once. You'll paste it into the app on each device you
    use it from.
13. Back in the Apps Script editor: click **Deploy → New deployment**.
14. Click the gear icon next to "Select type" and choose **Web app**.
15. Set:
    - **Execute as:** Me (your Google account)
    - **Who has access:** Anyone
16. Click **Deploy**. Authorise again if asked.
17. Copy the URL shown (it ends in `/exec`). This is your **prod** URL.
    Paste it into `config.js` in this repo, replacing
    `PASTE_PROD_EXEC_URL_HERE`.

**Why "Who has access: Anyone"?** A browser page on GitHub Pages calling
this script cannot log in to Google first — there's no cross-origin way for
it to prove "this is really you" via a Google login. So the script has to
accept anonymous requests. That sounds alarming, but it's fine **because**
the script itself checks the device key on every single request and refuses
anything without the right one (see `docs/00-what-we-built-security.md`).
"Anyone can reach the door" is fine when the door is locked and only you
have the key.

---

## B. Archive the old leaked deployment

The previous version of this app had its Apps Script URL sitting in a
public GitHub repository with **no password check at all**. That old URL
must be shut off.

**Already done if you shipped the new code with "New version" on the
existing deployment** — that keeps the same URL but the new code behind it
refuses anything without the device key, which is what matters. Only follow
the steps below if you created a *separate* new deployment.

1. In the Apps Script editor: **Deploy → Manage deployments**.
2. Find the **old** deployment (the one whose URL matches what used to be
   in `index.html`).
3. Click the pencil/edit icon on that old deployment, and change its state
   to **Archived** (or use the trash icon if archive isn't offered for your
   editor version — either removes it from serving traffic).
4. Save.

**Important:** the old URL still exists in this repo's git history forever
(that's how git works — old commits don't disappear just because a file
changed). Anyone who dug through the repo's history before this fix could
have already seen it and copied the data behind it. Treat the data that was
reachable through the old URL (all tasks that existed before today) as
**potentially exposed** — it's not secret going forward.

---

## C. Shipping a code change later

Once you've made edits to `Code.gs` and pasted them into the Apps Script
editor:

1. **Deploy → Manage deployments.**
2. Find your **prod** deployment (the one whose URL is in `config.js`).
3. Click the **pencil/edit icon** next to it.
4. Where it says **Version**, change the dropdown to **New version**.
5. Click **Deploy**.

This keeps the **same URL** — nothing in `config.js` needs to change.

**The classic trap:** if you instead click **Deploy → New deployment**
(step 13 from section A) again, Google gives you a **brand new, different
URL**. Your app would then be pointing at the old code forever, quietly,
with no error — because the old deployment doesn't automatically pick up
new code, and the app doesn't know a new URL exists. If Ping suddenly stops
showing your latest `CODE_VERSION` after a change, this is almost always
why — go back and check you used "New version" on the *existing*
deployment, not "New deployment".

---

## D. Staging (optional, later)

For testing changes without risking your real data:

1. Make a copy of your Google Sheet (File → Make a copy). This gives you a
   separate spreadsheet with its own ID.
2. In the Apps Script editor, **Project Settings → Script Properties →
   Add script property**: name `SHEET_ID`, value = the new copy's
   spreadsheet ID (the long string in its URL between `/d/` and `/edit`).
   *(Only add this to a **second, separate** Apps Script project bound to
   or targeting the staging sheet — not your main prod script.)*
3. Deploy that second script as its own Web App (same steps as section A,
   steps 13–17) to get a **staging** URL.
4. Paste that URL into `config.js`'s `stagingUrl`.
5. Visit the app with `?api=staging` on the end of the address (e.g.
   `https://yoursite.github.io/spike.html?api=staging`), or set it once and
   it's remembered via the app's own "use staging" option if one is added
   later.

---

## E. Rotate the device key

Do this if you think the key leaked (e.g. it ended up in a screenshot, a
chat message, or committed to git by mistake).

1. In the Apps Script editor, function dropdown → choose **`rotateDeviceKey`**.
2. Click **Run**.
3. Open **Execution log**, copy the new key into your password manager.
4. On **every device** where you use the app, open it, click **Forget key**,
   then paste and save the new key.

The old key stops working the instant you run this — so do step 4 promptly
on each device, or you'll see "invalid_token" errors until you do.

---

## F. Test checklist (Phase 0)

Open `https://thedarkknightcodes.github.io/spike.html` and repeat on each
device: **Windows, Mac, iPad, Pixel (Android)**.

- [ ] Paste the device key, click **Save on this device** → shows
      "Key saved ✓".
- [ ] Click **Ping** → shows a version number, server time, and timezone.
- [ ] Click **List tasks** → shows **74** as the task count (or whatever
      your current row count is), plus the first few task titles.
- [ ] Click **Forget key**, type an obviously wrong key, save it, click
      **Ping** → shows an error (not a crash, not a silent success).
- [ ] Open the **old** (now-archived) exec URL directly in a browser tab →
      it should no longer return any task data.

If every box is ticked on every device, Phase 0 is done.

---

## G. Phase 1: migrate your tasks into the new data model

The new app reads from a new tab called `Tasks2` (with real dates, ids that
can't collide, and so on). Your old tab is **never changed** — it stays as
a backup.

1. In the Apps Script editor, replace the contents of `Code.gs` with the
   latest `apps-script/Code.gs` from this repo, and save.
2. Function dropdown → choose **`runTests`** → **Run**. The Execution log
   should end with "All … tests passed."
3. Function dropdown → choose **`migrate`** → **Run**. Authorise again if
   asked. The log should say something like "Migrated 74 tasks … The legacy
   tab was not changed."
4. Go back to the Google Sheet tab in your browser. You should now see three
   new tabs at the bottom: **Tasks2** (with your tasks), **Log** and
   **Reviews** (empty apart from a header row). Old tasks marked Done in the
   original tab are carried over as done but hidden from the app.
5. Ship the new code: **Deploy → Manage deployments → pencil icon → Version:
   New version → Deploy** (section C — same URL, no config change).
6. Open `spike.html`, click **Ping** → version should now read `0.2.0`.
   Click **List tasks** → the count should match your active tasks.

Running `migrate` a second time does nothing (it refuses if Tasks2 already
has rows), so it's safe if you click it twice by mistake.

---

## H. Install on your devices

As of Phase 3 the app can be installed like a normal app, instead of
staying a browser tab. See `docs/02-what-we-built-pwa.md` for what that
means and why.

**Pixel (Android, Chrome):**

1. Open `https://thedarkknightcodes.github.io/` in Chrome.
2. Tap the **⋮** menu (top right) → **Install app** (or **Add to Home
   screen** on older Chrome versions). You may instead see a banner
   offering this automatically — either way works.
3. Confirm. The icon appears on your home screen and opens in its own
   window, no address bar.

**iPad (Safari):**

1. Open `https://thedarkknightcodes.github.io/` in Safari (it must be
   Safari — Chrome/Firefox on iOS can't do this).
2. Tap the **Share** icon (square with an arrow, in the toolbar).
3. Scroll down and tap **Add to Home Screen** → **Add**.

**After a code push:** the app checks for a new version over the network
each time you open it, and falls back to the last saved copy only when
there's no signal. If you've pushed a change and the installed app still
looks old, **close it fully and reopen it once** — that's normally enough
to pick up the update. A small "Update ready — tap to reload" message
appears if a new version was already downloading in the background.

**If you change the manifest or icons specifically:** an already-installed
copy won't notice on its own — you need to remove it from the home screen
and add it again. This doesn't apply to ordinary code changes, only to
`manifest.webmanifest` or the files in `icons/`.

---

## I. Phase 4: turn on AI capture

This turns the capture box into a "brain-dump" box: type or paste a messy
ramble, and Gemini (a Google AI model) splits it into separate tasks for
you. If Gemini is ever unreachable, nothing is lost — the whole ramble is
saved as one task in your Inbox instead, ready to sort by hand later. See
`docs/03-what-we-built-ai-capture.md` for the plain-English "why".

1. **Get a Gemini API key.** Go to
   [aistudio.google.com](https://aistudio.google.com), sign in with your
   Google account, and create an API key (it's free to start, with a
   generous daily limit — see the caveat at the end of this section).
   Copy the key somewhere safe for a moment.
2. In the Apps Script editor: **Project Settings** (gear icon) → **Script
   Properties** → **Add script property**.
   - Name: `GEMINI_API_KEY`, Value: the key you just copied.
3. *(Optional)* Add a second Script Property, `GEMINI_MODEL`, if you ever
   want to point at a different Gemini model than the one this code
   defaults to. Most people can skip this — leave it unset.
4. Replace the contents of `Code.gs` with the latest
   `apps-script/Code.gs` from this repo (same as any other code update —
   see section C), and save.
5. Function dropdown → choose **`runTests`** → **Run**. The Execution log
   should end with "All … tests passed." (these are all local checks —
   they don't call Gemini or spend any quota).
6. Function dropdown → choose **`test_gemini`** → **Run**. This sends one
   sample ramble to Gemini for real. Open **Execution log**:
   - If you see "Success — Gemini split it into N task(s)" followed by
     some JSON, the key works. You're done.
   - If you see "callGemini_ failed", read the error line under it — it's
     usually a copy-paste mistake in the key, or the key not having access
     to the model yet (Google can take a minute to activate a brand new
     key).
7. Ship it: **Deploy → Manage deployments → pencil icon → Version: New
   version → Deploy** (section C — same URL, no config change).
8. Open the app, click **Ping** in Settings → version should now read
   `0.3.0`.

**About that re-authorisation prompt:** this is the first phase where the
script talks to something outside your own Google account (Gemini's API),
so the very next time you run anything from the Apps Script editor, Google
will ask you to re-authorise the script for a new permission ("Connect to
an external service"). This is expected — click through it the same way
you did in section A, step 10.

**A caveat on the free tier:** Google's free Gemini API tier is generous
for one person's brain-dumps, but it comes with daily/per-minute request
limits and its terms note that free-tier prompts may be used to improve
Google's models. If that matters to you, read Google AI Studio's current
terms before relying on this for anything sensitive — a paid tier removes
both concerns.

---

## J. Phase 5: share from any Android app

As of this phase, the app can be the *target* of Android's normal Share
button — from any app, not just a browser. This only works once the app is
**installed** (see section H) — a share target has to be registered with
the phone, and that registration is part of installing the app, not
something a plain browser tab offers.

**If the app was already installed before this phase shipped:** Android
read the share-target setup from `manifest.webmanifest` at install time, so
an older install won't know about it. Remove it from your home screen and
add it again (same as the "if you change the manifest or icons" note in
section H) — that's what makes Android re-read the manifest.

1. Ship the latest code (frontend files + `apps-script/Code.gs` — section
   C) so `share_target` in the manifest and the share-handling code in
   `js/app.js` are both live.
2. On your Pixel: if Task Planner is already installed, remove it from the
   home screen, then reinstall it (section H). If it isn't installed yet,
   just install it fresh — you're already covered.
3. Try it from a few different apps, since they don't all fill in the same
   fields:
   - **Chrome:** open any page → **Share** → **Task Planner**. Usually
     shares the page title and its URL.
   - **Google Keep:** open a note → **⋮** → **Send** → **Task Planner**.
   - **A voice recorder / transcription app (e.g. Rambler)**, or any notes
     app: share its text the same way.
   - **Recorder** (Pixel's built-in one): share a transcript.
4. Each time, the app should open straight to Today, show a brief "Got it
   ✓" toast, and a "Sorting…" row while it's being split into tasks — the
   exact same feeling as typing something into the capture box yourself.
5. Check the address bar (or Settings → app info, if you want to be
   thorough) afterwards — the `?title=...&text=...` should be gone from the
   URL. If you reload the page right after sharing, nothing should be
   captured a second time.

**iPad:** iOS/iPadOS has no share-target support for web apps at all — this
is an Android-only feature. On iPad, just use dictation (the microphone key
on the keyboard) straight into the capture box instead; it gets you to the
same place.

---

## K. Phase 6: reminders + nightly tidy + morning digest

This turns due dates into real notifications: every dated task gets an
event (with a popup reminder) in its own **"Tasks"** Google Calendar — a
separate calendar this app creates and manages, never your main one. Once a
day it also quietly tidies up (nothing is ever deleted — see
`docs/04-what-we-built-share-and-reminders.md`), and rebuilds a single
07:30 "here's today" event each morning.

1. Replace the contents of `Code.gs` with the latest
   `apps-script/Code.gs` from this repo (section C), and do the same for
   `appsscript.json` (it now lists the extra permissions this phase needs —
   see step 6 in section A for how to open/replace that file), and save.
2. Function dropdown → **`runTests`** → **Run**. Should end with "All …
   tests passed" (all local checks — no Calendar access yet).
3. Function dropdown → **`installTriggers`** → **Run**. This is the first
   time the script touches Google Calendar, so you'll likely be asked to
   **re-authorise** it (same click-through as section A, step 10 — this
   time for the added Calendar/trigger permissions). Check the Execution
   log: "Installed the nightly tidy trigger…".
4. Function dropdown → **`resync_calendar`** → **Run**. This creates
   calendar events for every dated task you already have (so Phase 6
   doesn't only apply to tasks you add from now on). Check the log for how
   many rows it checked/changed.
5. Function dropdown → **`nightlyTidy`** → **Run**. This runs the whole
   nightly job once, by hand, right now — check the log for what it did,
   then open your Google Calendar and look for a **"Today: …"** event at
   07:30 in the **Tasks** calendar. That's the digest.
6. Ship it: **Deploy → Manage deployments → pencil icon → Version: New
   version → Deploy** (section C — same URL, no config change).
7. Open the app, click **Ping** in Settings → version should now read
   `0.4.0`.
8. On your **Pixel** and **iPad**, open the Google Calendar app and check:
   - The **Tasks** calendar is ticked visible (Settings → your account →
     make sure "Tasks" isn't hidden).
   - Notifications are turned on for it (Google Calendar app → Settings →
     Tasks calendar → make sure event notifications aren't muted).

**Changing the fade window (how long an untouched task waits before
quietly moving to Someday):** edit the `FADE_DAYS` constant near the top of
`Code.gs` (it's currently `21`), then ship the change (section C). No other
setting needs to change — `planNightlyTidy_` and its tests all read from
this one constant.

**Changing the digest time:** the 07:30–07:40 event time is set in
`buildDigestEvent_` (look for `parseDateTime_(today, "07:30")` and
`"07:40"`). Edit those two strings (24-hour `HH:mm`), ship the change. The
*trigger* that runs the nightly tidy itself (which is what rebuilds the
digest) is separate — see the next paragraph if you also want to move that.

**Changing when the nightly tidy runs:** it's currently `atHour(3)` in
`installTriggers()` (see that function's comment for why it's "roughly
3am", not exactly). To change it, edit that number, then run
**`installTriggers`** again from the editor — it always removes the old
trigger first, so this is safe to re-run any time. **`removeTriggers`**
turns the whole nightly job off if you ever want to pause it.

**A note on `TASKS_CALENDAR_ID` and `DIGEST_EVENT_ID`:** these are Script
Properties the code manages for you automatically (same idea as
`DEVICE_KEY` — Project Settings → Script Properties, if you're curious).
You shouldn't normally need to touch them by hand.

### If you see "The script does not have permission … calendar"

Google only asks for permissions the first time you run something. If the
script was authorised before the calendar code existed, it keeps the OLD
set of permissions and every calendar call fails with this message. Fix:

1. In the editor, open `appsscript.json` and check it contains the
   `oauthScopes` list from the repo (with a `calendar` line). If not, paste
   the repo's version in and save.
2. Go to https://myaccount.google.com/permissions, find the Apps Script
   project (it's named after your spreadsheet or "Untitled project"), and
   click **Remove access**.
3. Back in the editor, run `installTriggers`. Google will ask you to
   authorise again — this time the list includes Google Calendar. Allow.
4. Run `resync_calendar`, then `nightlyTidy`. The log should now show a
   digest event being created.

---

## L. Phase 7: weekly review

Once a week, a short, warm review of the week just gone: 1–3 concrete
wins, a small handful of tasks worth doing this week, a few that could
rest in Someday, and a couple that look stale enough to drop — never a
count of everything still undone. It's written either by Gemini
automatically (Monday mornings, as a safety net) or by Claude (via a
local scheduled task you set up yourself, using your own Claude Max
subscription — see `tools/weekly-review/README.md`), and Claude's review
always wins if both exist for the same week. See
`docs/05-what-we-built-weekly-review.md` for the plain-English "why".

No new Google permissions are needed for this phase — it reuses the same
Sheets/Calendar/external-request/trigger scopes Phase 4 and Phase 6
already asked for.

1. Replace the contents of `Code.gs` with the latest
   `apps-script/Code.gs` from this repo (section C), and save. (If you
   haven't turned on Phase 4's AI capture yet, `GEMINI_API_KEY` also needs
   to be set — see section I — since the same key powers the Monday
   safety-net review.)
2. Function dropdown → **`runTests`** → **Run**. Should end with "All …
   tests passed." (this now also covers `validateReview_`, `mondayOf_`
   and `isReviewFresh_` — all local checks, no network).
3. Function dropdown → **`installTriggers`** → **Run**. Safe to re-run any
   time (it always removes old triggers first) — this is what turns on
   BOTH the nightly tidy (Phase 6) and the new weekly review trigger.
   Check the Execution log for "Installed the nightly tidy trigger … and
   the weekly review trigger …".
4. Ship it: **Deploy → Manage deployments → pencil icon → Version: New
   version → Deploy** (section C — same URL, no config change).
5. Open the app, click **Ping** in Settings → version should now read
   `0.5.0`.
6. *(Optional, but recommended)* Set up the Claude scheduled task per
   `tools/weekly-review/README.md` — a few minutes, one time, and it's
   what gets you the better (Claude-written) review each week instead of
   only Gemini's Monday-morning fallback.
7. Try it now, rather than waiting for Monday: function dropdown →
   **`weeklyGeminiReview`** → **Run**. Check the Execution log — it should
   say either "saved a Gemini review for week …" or, if you already ran
   the Claude scheduled task this week, "skipped (claude_review_exists)".
8. Open the app (or reload it) — you should see a **"Your week, reviewed"**
   card at the top of Today, tagged "by Gemini" (or "by Claude", if that's
   the one that saved). Tick/untick as you like and try **Apply ticked**
   and **Not now** — either one should make the card disappear.

**If the review card never shows up:** check that `weeklyGeminiReview` (or
the Claude scheduled task) actually ran and logged a save — a review more
than `REVIEW_FRESH_DAYS` (10) days old auto-expires and `review_get` just
returns null, same as if none was ever written (see `isReviewFresh_` in
`Code.gs`).

**Changing how many suggestions each list holds:** edit
`REVIEW_MAX_SUGGESTED` / `REVIEW_MAX_SOMEDAY` / `REVIEW_MAX_DROP` near the
top of `Code.gs`, then ship the change (section C). `validateReview_` and
its tests all read from these same constants, so nothing else needs to
change.

**Changing when the weekly review trigger fires:** it's currently
`onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8)` in `installTriggers()`.
Edit that line, then run **`installTriggers`** again (always safe — see
step 3 above). **`removeTriggers`** turns off both the nightly tidy and
the weekly review if you ever want to pause either.

---

## M. Phase 8: secretary mode

The capture box is now the way to do everything, not just add tasks: type
or dictate a brain-dump as before, or a command ("move the dentist to
Friday", "I did the recycling", "put the photo albums in someday"), or a
plain question ("what's due this week?", "how many things are in
someday?"). One new backend action, `assist`, decides which it was and
replies underneath the box — see `docs/06-what-we-built-secretary-mode.md`
for the plain-English "why". Nothing it does is one-way: every change is
an ordinary task update, so a misread command is one **Undo** away (in the
reply card itself) and, as always in this app, nothing is ever deleted.

1. Replace the contents of `Code.gs` with the latest `apps-script/Code.gs`
   from this repo (section C), and save.
2. *(Optional)* If you want to point at a different Gemini model than this
   version's default, the `GEMINI_MODEL` Script Property still works
   exactly as before (section I) — set it under **Project Settings →
   Script Properties**. Most people can leave this alone: this version
   defaults to `gemini-3.8-flash` instead of the older, lighter
   `gemini-3.5-flash-lite`, because deciding "is this a new task, a change
   to something that already exists, or just a question" needs a bit more
   reasoning than plain brain-dump splitting did.
3. Function dropdown → **`runTests`** → **Run**. Should end with "All …
   tests passed." (this now also covers `parseAssistResult_` and its
   helpers — all local checks, no network).
4. Function dropdown → **`test_assist`** → **Run**. This sends one sample
   line to Gemini against your REAL tasks, in a **dry run** — it reads
   your data for context but writes nothing to Tasks2 or Log either way.
   Open **Execution log** and check the parsed intent/reply/new_tasks/ops
   look sensible. (If you want to try your own wording, edit `sampleRaw`
   near the top of `test_assist()` in `Code.gs` first.)
5. Ship it: **Deploy → Manage deployments → pencil icon → Version: New
   version → Deploy** (section C — same URL, no config change).
6. Open the app, click **Ping** in Settings → version should now read
   `0.6.0`.
7. Try a few things in the capture box for real:
   - A command: **"move the dentist to Friday"**, **"I did the
     recycling"**, **"put the photo albums in someday"**, **"drop the
     spanish thing"**, **"make brushing teeth a 5 min task in health"**,
     **"schedule the car insurance for tomorrow at 9"**.
   - A question: **"what's due this week?"**, **"what should I do in the
     next 20 minutes?"**, **"what did I get done today?"**.
   - A mix: **"I did the rubbish, and remind me to call mum sunday"**.
   Each one should show "Thinking…" briefly on the box, then either new
   tasks appearing (a capture), or a short reply card underneath the box
   (a command or a question) with an **Undo** button if anything actually
   changed. A command it couldn't confidently match to a task instead asks
   in the reply card — try answering it, or just rephrasing more like the
   task's real title.
8. The first time `assist` succeeds on a device, a small first-run hint
   under the box ("Type or dictate anything…") disappears for good on that
   device — nothing to do here, it's just `localStorage`, and Settings
   always has the same tip as a permanent one-liner if you want it back.

**If a command didn't do what you expected:** open the reply card's
**Undo** (if it's still showing) — it restores every task that command
touched to exactly how it was before. If the card's already gone, the
change is still just an ordinary task edit — open the task from Today or
Week and fix it by hand the normal way; nothing `assist` does is special
or harder to undo than a tap would have been.

**Why `capture` still exists as its own action:** the Android share-target
flow (section J) still uses it — a share is always just a brain-dump, with
no box to type a command or question into, so there's nothing `assist`
would add there. Everything typed or dictated into the capture box itself
goes through `assist`.

---

## N. Phase 9: calendar two-way sync + voice via Google Tasks

Two things, both running quietly in the background every ~10 minutes, no
new screen to learn:

- **Calendar two-way sync:** until now, editing a task's due date only ever
  showed up as a calendar event — never the other way round. From this
  phase on, dragging an event to a new day in your **Tasks** calendar moves
  the task's due date to match; deleting an event just removes the task's
  due date (the task itself is never deleted, same as everywhere else in
  this app); and adding a brand new event to the Tasks calendar by hand
  creates a new task for it.
- **Voice, via Google Tasks:** "Hey Google, add *renew passport* to my
  tasks" lands here, sorted by the same AI as typing it into the capture
  box, and "Hey Google, what's on my task list?" reads out today's plan —
  by using two ordinary Google Tasks lists this app manages, since Google
  Assistant/Gemini has no idea this app exists otherwise.

See `docs/07-what-we-built-two-way-sync-and-voice.md` for the plain-English
"why".

1. **Turn on the Tasks Advanced Service** — this is the one extra click
   Phase 9 needs that earlier phases didn't: the manifest listing it in
   `appsscript.json` is not always enough on its own the first time.
   - In the Apps Script editor, left sidebar → **Services** (the **+** next
     to it).
   - Find **Google Tasks API** in the list, leave the identifier as
     `Tasks`, and click **Add**.
   - If you don't do this and only paste the updated `appsscript.json`,
     you'll see an error like `Tasks is not defined` the first time
     `syncGoogleTasks` runs — coming back to this step fixes it.
2. Replace the contents of `Code.gs` with the latest `apps-script/Code.gs`
   from this repo, and do the same for `appsscript.json` (section A, step 6
   shows how to open it) — save both.
3. Function dropdown → **`runTests`** → **Run**. Should end with "All …
   tests passed." (all local checks — no Calendar or Google Tasks access
   yet).
4. Function dropdown → **`installTriggers`** → **Run**. This now also
   installs the two new every-~10-minutes triggers, so you'll likely be
   asked to **re-authorise** the script (same click-through as section A,
   step 10) — this time for the added Google Tasks permission. Check the
   Execution log for "…and the calendar sync + Google Tasks voice bridge
   triggers…".
5. Function dropdown → **`syncFromCalendar`** → **Run**. Safe to run
   straight away — with nothing moved or added yet, the log should just say
   "0 updated, 0 unlinked, 0 created."
6. Function dropdown → **`syncGoogleTasks`** → **Run**. This is what
   **creates** the two Google Tasks lists the first time — check the log,
   then open the **Google Tasks** app (or the Tasks panel in the sidebar of
   Gmail/Calendar on desktop) and confirm you now see two lists:
   **"Planner Inbox"** and **"Planner Today"** (the second one already
   mirroring whatever's in today's plan right now).
7. Ship it: **Deploy → Manage deployments → pencil icon → Version: New
   version → Deploy** (section C — same URL, no config change).
8. Open the app, click **Ping** in Settings → version should now read
   `0.7.0`. Settings also now has two new lines explaining both halves of
   this phase in plain English, in case you forget the wording later.
9. Try the calendar side: open your **Tasks** calendar (Google Calendar
   app or web), drag any dated task's event to a different day. Wait up to
   10 minutes (or run `syncFromCalendar` by hand to see it immediately) —
   the task's due date in the app should follow. Try deleting an event too
   — the task stays, just without a due date.
10. Try the voice side, on your phone or a Google Home/Nest device: say
    **"Hey Google, add buy milk to my Planner Inbox list."** Within about
    10 minutes (or run `syncGoogleTasks` by hand), it should appear as a
    real task in the app, sorted into a category by the same AI as typing
    it — and disappear from the Planner Inbox list itself, since that list
    is only ever a mailbox on the way in. Then try **"Hey Google, what's on
    my Planner Today list?"** — it should read out whatever's on today's
    plan. Tick one off from the Google Tasks app directly and, within 10
    minutes, it shows as done in the app too.

**Phrases that work with Google Assistant/Gemini for lists** (exact wording
varies a little by device and by how Google's voice models are doing that
day — if one doesn't work, try a close variant):
- "Hey Google, add *[thing]* to my Planner Inbox list."
- "Hey Google, what's on my Planner Today list?"
- "Hey Google, add *[thing]* to my Planner Today list" also works, but
  there's no reason to — anything added there directly (rather than through
  the app) will just get quietly removed the next time the mirror runs,
  since it isn't a real task. Always add new things via **Planner Inbox**.

**The ambiguous-name caveat:** if you have other Google Tasks lists with
similar names (e.g. a personal "Today" list from some other app), Google
Assistant can sometimes pick the wrong one, or ask you to disambiguate.
Keeping these two lists named exactly **"Planner Inbox"** and **"Planner
Today"** — not renaming them — is what keeps that confusion to a minimum;
if you ever do rename one by hand, update the `GTASKS_INBOX_LIST_TITLE` /
`GTASKS_TODAY_LIST_TITLE` constants near the top of `Code.gs` to match, or
the app will just create a fresh list under the old name next time it runs.

**If you see "The script does not have permission … Tasks":** same fix as
the Calendar version of this in section K — go to
https://myaccount.google.com/permissions, remove access for this Apps
Script project, then run `installTriggers` again and authorise fresh (this
time the prompt should list Google Tasks).

**Changing how often either trigger runs:** both are
`.timeBased().everyMinutes(10)` in `installTriggers()`. Edit the number (10
is close to the shortest Apps Script allows), then run `installTriggers`
again — always safe, it removes old triggers first. `removeTriggers` turns
every trigger this app manages off, including these two, the nightly tidy
and the weekly review.


---

## O. If the AI is "experiencing high demand"

Google sometimes returns a 503 "high demand" error for a popular model.
From v0.7.1 the script retries once, then tries backup models in order
(`gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite`). To change the
backups, add a Script Property `GEMINI_FALLBACK_MODELS` with a
comma-separated list of model names from AI Studio. Questions asked while
every model is down get a polite "try again in a moment" reply instead of
being filed as a task.
