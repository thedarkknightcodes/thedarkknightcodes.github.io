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
