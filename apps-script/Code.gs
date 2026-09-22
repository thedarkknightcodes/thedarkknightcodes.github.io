/**
 * Task Planner — backend (Google Apps Script)
 *
 * WHY THIS FILE EXISTS
 * The old version of this script had no password check at all — anyone who
 * found the URL (and it was sitting in a public GitHub repo) could read or
 * change every task. Phase 0 added a "device key" check. This version
 * (Phase 1) adds the real data model: a new `Tasks2` tab with proper dates,
 * a client-generated id on every task (so retrying a failed save can never
 * create a duplicate), and `add`/`update` actions that validate what comes
 * in before it touches the sheet.
 *
 * The OLD tab (whatever it's called) is never written to by this file. It
 * stays exactly as it is, as a backup, until you run `migrate()` by hand.
 *
 * Phase 4 adds `capture`: you type/paste a messy "brain-dump" and Gemini
 * (a Google AI model) splits it into separate tasks for you, instead of
 * you having to tidy it into one task per line yourself. The raw text is
 * always logged to the Log tab BEFORE we even try calling Gemini, so a
 * brain-dump can never be lost — and if Gemini is unreachable or sends
 * back something we can't use, the whole thing is saved as one task in
 * your Inbox instead of failing silently.
 *
 * Phase 6 adds reminders and an automatic nightly tidy. Every task with a
 * due date gets a real event (with a popup notification) in its own
 * "Tasks" Google Calendar, never your main calendar, so a deadline can
 * actually reach you instead of only living inside the app. Once a day, a
 * time-based trigger quietly unschedules anything you didn't get to and
 * fades anything untouched for weeks into Someday (never deleted, never
 * scolded — see planNightlyTidy_'s comment), then rebuilds one calm 07:30
 * "here's today" event instead of a wall of separate reminders. A
 * calendar hiccup of any kind must never stop a task from saving — see
 * syncTaskEvent_'s comment for how that's guaranteed.
 *
 * Phase 7 adds a weekly review: once a week, a short, warm, ALWAYS-KIND
 * summary of the week just gone, plus a small handful of suggestions
 * (what's worth doing this week, what could rest in Someday, what looks
 * stale enough to drop) — never a count of everything still undone. It's
 * written either by Gemini (automatically, Monday mornings, as a safety
 * net) or by Claude (via a local scheduled task the owner sets up
 * themselves — see tools/weekly-review/README.md — which is the better
 * writer and always wins if both exist for the same week). The review
 * lives in the Reviews tab as one JSON blob per week; see review_export,
 * review_save, review_get, review_dismiss and review_apply below for the
 * whole flow, and validateReview_ for the one rule that keeps a
 * hallucinated task id or an overlong list from ever reaching the sheet.
 *
 * Phase 8 ("secretary mode") turns the ONE capture box into the way to do
 * everything, so there's as little screen-fiddling as possible between
 * "I thought of something" and it being handled — the whole point of a
 * text/voice box over a form. Typing (or dictating) a brain-dump still
 * creates tasks as before, but a command ("move the dentist to Friday",
 * "I did the recycling") now changes existing tasks, and a plain question
 * ("what's due this week?") gets a short spoken-style answer — all through
 * one new action, `assist`. It works the same defensive way `capture`
 * does (raw text logged FIRST, a safe one-Inbox-task fallback if Gemini is
 * ever unreachable or sends back nonsense) but additionally shows Gemini a
 * compact list of existing tasks and lets it emit `ops` against them —
 * see doAssistInternal_'s comment for the full flow, and parseAssistResult_
 * for the one rule that keeps a hallucinated task id or an unrecognised
 * op from ever reaching the sheet. Nothing an op does is one-way: every
 * change it makes is an ordinary task update, so the app's own Undo (and
 * the fact that this app never deletes anything) covers a misread command
 * exactly the same as a mis-tap would.
 */

// Bump this whenever you deploy a meaningfully different version. `ping`
// returns it, so the phone/browser can show you which code it's talking to.
const CODE_VERSION = "0.6.0";

// The app's own URL, used in calendar event descriptions ("Open: ...") so
// a reminder always has a one-tap way back into the app.
const APP_URL = "https://thedarkknightcodes.github.io/";

// ---------------------------------------------------------------------------
// DATA MODEL CONSTANTS
// ---------------------------------------------------------------------------

// The 10 categories carried over from the old app, in the same order they
// used to appear in its dropdown. "Inbox" is also the default for a task
// with no category at all.
const CATEGORIES = [
  "Career & Learning",
  "Finances & Subscriptions",
  "Health & Personal Care",
  "Household & Chores",
  "Shopping & Groceries",
  "Holidays & Travel",
  "Leisure & Pending Experiences",
  "Admin & Organization",
  "Relationship & Family",
  "Inbox",
];

// A task's lifecycle. "inbox" = just captured, not sorted yet. "active" =
// on a list somewhere. "someday" = parked, not deleted. "done"/"dropped" =
// finished or abandoned.
const STATUSES = ["inbox", "active", "someday", "done", "dropped"];

const TASKS2_SHEET_NAME = "Tasks2";
const LOG_SHEET_NAME = "Log";
const REVIEWS_SHEET_NAME = "Reviews";

// Column order matters for new sheets we create, but once a sheet exists we
// always look up columns BY NAME (see headerIndex_/getHeaders_) — never by
// a hardcoded number — so inserting a column later doesn't break anything.
const TASKS2_HEADERS = [
  "id", "title", "notes", "category", "est_min", "status",
  "do_date", "due_date", "due_time", "sort",
  "created_at", "updated_at", "completed_at", "last_touched_at",
  "calendar_event_id", "source", "raw_input", "op_id",
];
// Phase 8: `op_id` lets an `assist` retry find its own earlier result
// instead of asking Gemini (and the sheet) to redo the same work — see
// findStoredAssistResult_. ensureTab_ adds this column to an EXISTING Log
// tab automatically the first time this version runs (see that function's
// comment) — older rows just show blank in it, which is fine, they were
// never retried against.
const LOG_HEADERS = ["at", "source", "raw_text", "result", "op_id"];
const REVIEWS_HEADERS = ["week_start", "source", "created_at", "json", "dismissed_at"];

// Only these Tasks2 fields can be changed by an `update` request. Anything
// else in the payload (id, created_at, calendar_event_id, ...) is ignored —
// this is what stops a buggy or malicious client from rewriting history.
const UPDATABLE_FIELDS = [
  "title", "notes", "category", "est_min", "status",
  "do_date", "due_date", "due_time", "sort",
];

// A completed task keeps showing up in `list` for this many days, so you
// still see "done today" style feedback for a bit — then it quietly drops
// out instead of piling up forever.
const DONE_VISIBLE_DAYS = 7;

// How many days of no activity (no edit, no touch of any kind) before
// nightlyTidy() quietly moves a task to Someday. See planNightlyTidy_'s
// comment for the full rule — this is a fade, not a deletion, and nothing
// about it is ever shown as a countdown or a warning.
const FADE_DAYS = 21;

// ---------------------------------------------------------------------------
// GEMINI CAPTURE CONSTANTS (Phase 4)
// ---------------------------------------------------------------------------

// Which Gemini model to call — used by both `capture` and `assist`. This
// is just a starting point — Google renames/retires model names
// occasionally, so the GEMINI_MODEL Script Property (if set) always wins
// over this default. See docs/RUNBOOK.md section I (and section M for
// `assist`, which is what actually needs the extra reasoning a bigger
// model like this gives you — deciding "is this a new task, a change to
// an old one, or a question" is a harder job than just splitting a
// brain-dump into lines).
const GEMINI_MODEL_DEFAULT = "gemini-3.8-flash";

// A brain-dump longer than this is trimmed before it's sent anywhere. This
// isn't really about Gemini's limits (it can handle far more) — it's a
// sanity cap so a giant paste can't blow up the Log tab or the request.
const GEMINI_MAX_RAW_CHARS = 4000;

// However chatty someone's brain-dump is, we only ever ask for this many
// tasks back. Keeps the list from turning into its own overwhelming wall
// of text — the whole point of Phase 4 is to make things LESS overwhelming.
const GEMINI_MAX_TASKS = 15;

// The shape we force Gemini's reply into (via generationConfig.responseSchema
// in callGemini_). Asking for structured JSON like this means we never have
// to guess-parse free-form text — either the model gives us this shape, or
// the call fails cleanly and we fall back (see doCapture).
const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    tasks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          notes: { type: "STRING" },
          category: { type: "STRING", enum: CATEGORIES },
          est_min: { type: "INTEGER" },
          do_date: { type: "STRING" },
          due_date: { type: "STRING" },
          due_time: { type: "STRING" },
        },
        required: ["title", "category"],
      },
    },
  },
  required: ["tasks"],
};

// ---------------------------------------------------------------------------
// ASSIST / SECRETARY MODE CONSTANTS (Phase 8)
// ---------------------------------------------------------------------------

// The full list of changes an `assist` op can make to an EXISTING task.
// Anything Gemini sends that isn't one of these exact words is dropped by
// parseAssistResult_ — never guessed at, never partially applied.
const ASSIST_OPS = [
  "complete", "uncomplete", "drop", "someday", "restore",
  "schedule", "unschedule", "set_due", "clear_due", "edit",
];

// The full list of "meanings" one thing typed/dictated into the box can
// have. "mixed" covers a single ramble that's part brain-dump, part
// command ("I did the rubbish, and remind me to call mum sunday").
const ASSIST_INTENTS = ["capture", "command", "question", "mixed"];

// How many existing tasks get shown to Gemini as context for one `assist`
// call — see selectAssistContextTasks_. A cap, not a target: most days
// every visible task fits comfortably under this, and this only starts
// trimming once the list is genuinely long.
const ASSIST_MAX_CONTEXT_TASKS = 150;

// However many things one ramble asks to change, we only ever act on this
// many — same "keep it from turning into its own overwhelming wall of
// changes" reasoning as GEMINI_MAX_TASKS.
const ASSIST_MAX_OPS = 20;

// A reply longer than this is trimmed — `reply` is meant to be at most a
// few short sentences (see buildAssistPrompt_), this is just a backstop.
const ASSIST_REPLY_MAX_CHARS = 600;

// The shape we force Gemini's `assist` reply into. `new_tasks` reuses the
// exact same per-task shape as a plain capture (see GEMINI_RESPONSE_SCHEMA
// above); `ops` is the new bit — a change to something that already
// exists, named by the exact id parseAssistResult_ was shown.
const ASSIST_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { type: "STRING", enum: ASSIST_INTENTS },
    reply: { type: "STRING" },
    new_tasks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          notes: { type: "STRING" },
          category: { type: "STRING", enum: CATEGORIES },
          est_min: { type: "INTEGER" },
          do_date: { type: "STRING" },
          due_date: { type: "STRING" },
          due_time: { type: "STRING" },
        },
        required: ["title", "category"],
      },
    },
    ops: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          op: { type: "STRING", enum: ASSIST_OPS },
          id: { type: "STRING" },
          do_date: { type: "STRING" },
          due_date: { type: "STRING" },
          due_time: { type: "STRING" },
          title: { type: "STRING" },
          notes: { type: "STRING" },
          category: { type: "STRING", enum: CATEGORIES },
          est_min: { type: "INTEGER" },
        },
        required: ["op", "id"],
      },
    },
  },
  required: ["intent", "reply", "new_tasks", "ops"],
};

// ---------------------------------------------------------------------------
// WEEKLY REVIEW CONSTANTS (Phase 7)
// ---------------------------------------------------------------------------

// How many tasks a review is allowed to suggest in each list. Kept small on
// purpose — the whole point of a review is a handful of calm suggestions,
// not a second backlog to feel bad about. validateReview_ enforces these no
// matter what Gemini or Claude actually sent back.
const REVIEW_MAX_SUGGESTED = 5;
const REVIEW_MAX_SOMEDAY = 5;
const REVIEW_MAX_DROP = 3;
const REVIEW_MAX_WINS = 3;

// A safety cap on the summary's length — not really a limit Gemini/Claude
// should ever hit (they're asked for ≤3 sentences), just a backstop so one
// runaway response can't bloat the Reviews sheet.
const REVIEW_SUMMARY_MAX_CHARS = 900;

// review_get treats a review as expired once its week_start is this many
// days in the past — see isReviewFresh_. 10 days covers "the review from
// last Monday, still unopened by the following Wednesday" without ever
// showing a review for a week from a month ago.
const REVIEW_FRESH_DAYS = 10;

// The shape we ask Gemini for when writing a weekly review — mirrors the
// shape validateReview_ expects (see that function's comment for the full
// contract). generated_by isn't part of the schema; doReviewSave/
// weeklyGeminiReview stamp that on afterwards, since it's not something
// worth asking the model to get right.
const REVIEW_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    wins: { type: "ARRAY", items: { type: "STRING" } },
    suggested: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, reason: { type: "STRING" } },
        required: ["id", "reason"],
      },
    },
    someday: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, reason: { type: "STRING" } },
        required: ["id", "reason"],
      },
    },
    drop: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, reason: { type: "STRING" } },
        required: ["id", "reason"],
      },
    },
  },
  required: ["summary", "wins", "suggested", "someday", "drop"],
};

// ---------------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------------

/**
 * Every action this phase supports, as plain functions. Adding a new action
 * later is just adding a new entry here — nothing else about the routing
 * needs to change.
 */
const ACTIONS = {
  ping: doPing,
  list: doList,
  list_legacy: doListLegacy,
  add: doAdd,
  update: doUpdate,
  capture: doCapture,
  assist: doAssist,
  digest_preview: doDigestPreview,
  review_export: doReviewExport,
  review_save: doReviewSave,
  review_get: doReviewGet,
  review_dismiss: doReviewDismiss,
  review_apply: doReviewApply,
};

/**
 * doPost is the ONLY thing GitHub Pages talks to. Google Apps Script always
 * responds to a plain fetch() with a normal HTTP response, but if our code
 * throws an uncaught error, Apps Script's default error page is HTML, not
 * JSON — and it has no CORS headers. A browser fetch() call against a
 * cross-origin URL with no CORS headers doesn't get to see the error body
 * at all; it just reports "Failed to fetch" with zero explanation. That is
 * why EVERYTHING below is wrapped in one big try/catch: no matter what goes
 * wrong, we still send back valid JSON that the page can read and show.
 */
function doPost(e) {
  try {
    const request = parseRequest_(e);

    const authResult = checkAuth_(request.token);
    if (!authResult.ok) {
      return jsonResponse_({ ok: false, error: authResult.error });
    }

    const action = ACTIONS[request.action];
    if (!action) {
      return jsonResponse_({ ok: false, error: "unknown_action" });
    }

    const result = action(request);
    return jsonResponse_(result);
  } catch (err) {
    // Whatever broke — bad JSON, a missing sheet, a typo in our own code —
    // this is the safety net that turns it into readable JSON instead of a
    // blank "Failed to fetch" in the browser.
    return jsonResponse_({ ok: false, error: "server_error: " + errorMessage_(err) });
  }
}

/**
 * We don't support GET at all (a GET can be triggered just by typing the
 * URL in a browser address bar, with no way to attach a device key). This
 * reply is intentionally boring — it doesn't confirm or deny anything about
 * what the script can do.
 */
function doGet(e) {
  return jsonResponse_({ ok: false, error: "use_post" });
}

// ---------------------------------------------------------------------------
// ACTIONS — reads
// ---------------------------------------------------------------------------

/**
 * Simple "is the server alive and is my key correct" check. Also reports
 * the code version and current server time, which is handy for debugging
 * (e.g. spotting timezone mismatches).
 */
function doPing(request) {
  const now = new Date();
  return {
    ok: true,
    version: CODE_VERSION,
    time: now.toISOString(),
    tz: Session.getScriptTimeZone(),
  };
}

/**
 * The main list the app uses from Phase 1 onward. Reads the Tasks2 tab, and
 * hides the two kinds of task nobody wants cluttering the screen forever:
 * `dropped` tasks (gone for good, visually) and `done` tasks older than
 * DONE_VISIBLE_DAYS (so "done today" feels good without the list growing
 * without end).
 *
 * If Tasks2 doesn't exist yet, or exists but has no data rows, that means
 * `migrate()` hasn't been run — we say so explicitly rather than just
 * returning an empty list, so the app can point you at the runbook instead
 * of looking like all your tasks vanished.
 */
function doList(request) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(TASKS2_SHEET_NAME);
  const today = todayString_();
  const serverTime = nowIso_();

  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, tasks: [], needs_migration: true, server_time: serverTime, today: today };
  }

  const headers = getHeaders_(sheet);
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

  const tasks = filterVisibleTasks_(rowsToTasks_(headers, values), serverTime);

  return { ok: true, tasks: tasks, server_time: serverTime, today: today };
}

/**
 * Pure function: turns Tasks2 rows into task objects and applies the
 * "what should the app ever see" rule described in doList's comment.
 * Pulled apart from doList so it can be unit-tested without a real sheet.
 */
function filterVisibleTasks_(tasks, nowIso) {
  return tasks.filter(function (t) {
    if (!t.id) return false;
    if (t.status === "dropped") return false;
    if (t.status === "done") return isWithinLastNDays_(t.completed_at, DONE_VISIBLE_DAYS, nowIso);
    return true;
  });
}

/**
 * The old Phase 0 behaviour: read whatever the legacy tab is, as-is, with
 * no filtering. Kept around under its own action name so you can always
 * double check the original data is intact, and so `migrate()` has
 * something to read from.
 */
function doListLegacy(request) {
  const ss = getSpreadsheet_();
  const sheet = findLegacySheet_(ss);
  if (!sheet) return { ok: true, tasks: [] };
  return { ok: true, tasks: readLegacySheetAsObjects_(sheet) };
}

/**
 * Finds the legacy tab robustly: it's whichever sheet is NOT one of our
 * three new tabs. This means it keeps working even if you rename the old
 * tab, or if it isn't the first sheet in the spreadsheet.
 */
function findLegacySheet_(ss) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    if (name !== TASKS2_SHEET_NAME && name !== LOG_SHEET_NAME && name !== REVIEWS_SHEET_NAME) {
      return sheets[i];
    }
  }
  return null;
}

/**
 * Returns what the 07:30 digest event would say right now, without
 * touching Calendar at all — handy for checking buildDigestText_'s output
 * from a spike page or a quick manual test, without waiting for the
 * nightly trigger or creating a real event.
 */
function doDigestPreview(request) {
  const ss = getSpreadsheet_();
  const sheet = ensureTabs_(ss);
  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  const tasks = lastRow < 2
    ? []
    : rowsToTasks_(headers, sheet.getRange(2, 1, lastRow - 1, headers.length).getValues());

  const today = todayString_();
  const text = buildDigestText_(tasks, today);
  return { ok: true, today: today, title: text.title, description: text.description };
}

// ---------------------------------------------------------------------------
// ACTIONS — writes
// ---------------------------------------------------------------------------

/**
 * Adds one new task. The CLIENT makes up the id (a UUID) before calling
 * this — that's what makes retries safe: if a save times out and the app
 * retries with the same id, we just find the existing row and say
 * `duplicate: true` instead of creating a second copy.
 *
 * Validation happens in the pure function validateNewTask_ BEFORE we touch
 * the sheet, so a bad request never gets anywhere near the lock.
 */
function doAdd(request) {
  const payload = request.payload || {};
  const nowIso = nowIso_();

  const validated = validateNewTask_(payload.task, nowIso);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSpreadsheet_();
    const sheet = ensureTabs_(ss);
    const headers = getHeaders_(sheet);
    const idIndex = buildIdIndex_(sheet, headers);

    const existingRowNum = idIndex[validated.row.id];
    if (existingRowNum) {
      const existingValues = sheet.getRange(existingRowNum, 1, 1, headers.length).getValues()[0];
      return { ok: true, task: rowToTask_(headers, existingValues), duplicate: true };
    }

    const row = validated.row;
    row.op_id = String(payload.op_id || "");
    const values = taskToRowValues_(headers, row);
    sheet.appendRow(values);
    const rowNum = sheet.getLastRow();

    // Calendar sync happens AFTER the row is safely saved — see
    // syncTaskEvent_'s comment for why a Calendar failure here can never
    // undo or block the save that just happened above.
    row.calendar_event_id = syncTaskEvent_(sheet, headers, rowNum, row);

    return { ok: true, task: rowToTask_(headers, taskToRowValues_(headers, row)) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Changes an existing task's editable fields. Looks the row up by id every
 * time (never a cached row number — another request could have inserted or
 * moved rows since we last looked). Unknown id is a normal, expected
 * outcome (e.g. two devices editing offline), not a crash.
 */
function doUpdate(request) {
  const payload = request.payload || {};
  const id = String(payload.id || "");
  const fields = (payload.fields && typeof payload.fields === "object") ? payload.fields : {};
  const nowIso = nowIso_();

  if (!id) return { ok: false, error: "missing_id" };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSpreadsheet_();
    const sheet = ensureTabs_(ss);
    const headers = getHeaders_(sheet);
    const idIndex = buildIdIndex_(sheet, headers);

    const rowNum = idIndex[id];
    if (!rowNum) return { ok: false, error: "not_found" };

    const rowValues = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
    const existingTask = rowToTask_(headers, rowValues);

    const result = applyUpdate_(existingTask, fields, nowIso);
    if (!result.ok) return result;

    const newValues = taskToRowValues_(headers, result.task);
    sheet.getRange(rowNum, 1, 1, headers.length).setValues([newValues]);

    // Same rule as doAdd: sync the calendar only after the sheet write has
    // already succeeded, and never let a Calendar problem undo it.
    result.task.calendar_event_id = syncTaskEvent_(sheet, headers, rowNum, result.task);

    return { ok: true, task: rowToTask_(headers, taskToRowValues_(headers, result.task)) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Turns one messy "brain-dump" of text into one or more Tasks2 rows, using
 * Gemini to do the splitting. This is the one action in the whole app that
 * calls out to another service, so it's written defensively at every step:
 *
 *   1. The raw text is logged to the Log tab FIRST, before anything that
 *      could possibly fail — so even a total Gemini/network outage never
 *      loses what you typed.
 *   2. The Gemini call happens OUTSIDE the script lock, because it can take
 *      several seconds and we don't want every other request queued up
 *      behind it.
 *   3. If Gemini fails for ANY reason (down, bad key, sent back nonsense),
 *      we don't show an error — we save the whole brain-dump as one task in
 *      the Inbox instead, so nothing is ever lost, it just needs sorting.
 *   4. op_id makes a retried request safe: if the app sends this exact
 *      capture twice (e.g. the first response timed out but actually
 *      succeeded), we just hand back what's already saved instead of
 *      duplicating it.
 */
function doCapture(request) {
  const payload = request.payload || {};
  const rawInput = String(payload.raw || "").trim();
  const opId = String(payload.op_id || "");
  // Phase 5: the app sends "share" when this capture came in through
  // Android's share sheet rather than the capture box, purely so the Log
  // tab can tell the two apart later. It changes nothing else — the same
  // Gemini call, the same ai/fallback rules, the same raw_input. Anything
  // other than exactly "share" is treated as the ordinary typed case.
  const sourceHint = payload.source_hint === "share" ? "share" : "typed";
  const nowIso = nowIso_();
  const today = todayString_();

  if (!rawInput) return { ok: false, error: "missing_text" };
  const raw = rawInput.slice(0, GEMINI_MAX_RAW_CHARS);

  const ss = getSpreadsheet_();
  const tasks2 = ensureTabs_(ss);
  const tasks2Headers = getHeaders_(tasks2);

  const existing = findTasksByOpId_(tasks2, tasks2Headers, opId);
  if (existing.length) {
    const dupSource = existing[0].source === "fallback" ? "fallback" : "ai";
    return { ok: true, tasks: existing, source: dupSource, duplicate: true };
  }

  const logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  const logHeaders = getHeaders_(logSheet);
  const logRow = appendLogRow_(logSheet, logHeaders, nowIso, "capture:" + sourceHint, raw, "pending", opId);

  let geminiTasks = null;
  let failureReason = "";
  try {
    geminiTasks = callGemini_(raw, today);
  } catch (err) {
    failureReason = errorMessage_(err);
  }

  let rows;
  let source;
  if (geminiTasks && geminiTasks.length) {
    source = "ai";
    rows = geminiTasks.map(function (t) {
      const validated = validateNewTask_(
        Object.assign({}, t, { id: Utilities.getUuid(), status: "active", source: "ai", raw_input: raw }),
        nowIso
      );
      // Every field here already came out of parseGeminiTasks_ clean, so
      // validateNewTask_ should never reject it — but if it ever does
      // (e.g. a title that somehow ended up empty), fall back to the
      // whole-brain-dump-as-one-task safety net rather than losing it.
      return validated.ok ? validated.row : null;
    }).filter(function (row) { return row !== null; });
    if (rows.length === 0) {
      source = "fallback";
      failureReason = failureReason || "gemini_rows_failed_validation";
      rows = [buildFallbackTask_(raw, Utilities.getUuid(), nowIso)];
    }
  } else {
    source = "fallback";
    failureReason = failureReason || "no_tasks_returned";
    rows = [buildFallbackTask_(raw, Utilities.getUuid(), nowIso)];
  }

  const sheet = ensureTabs_(ss);
  const headers = getHeaders_(sheet);
  // Writing the new rows (and syncing each one's calendar event) is shared
  // with doAssist's fallback path — see writeNewTaskRows_'s comment.
  const savedTasks = writeNewTaskRows_(sheet, headers, rows, opId);

  const resultText = source === "ai" ? "ok:" + savedTasks.length + " tasks" : "fallback: " + failureReason;
  updateLogResult_(logSheet, logHeaders, logRow, resultText);

  const response = { ok: true, tasks: savedTasks, source: source };
  if (source === "fallback") response.reason = failureReason;
  return response;
}

/**
 * Appends already-validated Tasks2 rows to the sheet in one batch, syncs
 * each new row's calendar event, and returns the saved task objects. Shared
 * by doCapture and doAssistInternal_'s fallback/new_tasks paths — this is
 * the "60 lines duplicated between capture and assist" the Phase 8 brief
 * asked to avoid. The caller must already hold the script lock (see
 * writeNewTaskRows_ below for the version that takes its own).
 */
function appendTaskRows_(sheet, headers, rows, opId) {
  if (!rows.length) return [];
  const values = rows.map(function (row) {
    row.op_id = opId;
    return taskToRowValues_(headers, row);
  });
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, values.length, headers.length).setValues(values);

  // One calendar sync per new task, same "after the sheet write, never
  // lets Calendar block the save" rule as doAdd/doUpdate.
  return values.map(function (rowValues, i) {
    const task = rowToTask_(headers, rowValues);
    task.calendar_event_id = syncTaskEvent_(sheet, headers, startRow + i, task);
    return task;
  });
}

/** appendTaskRows_, wrapped in its own script lock — what doCapture (and
 * doAssistInternal_'s fallback, which doesn't need to coordinate its write
 * with anything else) use. doAssistInternal_'s AI-result path calls
 * appendTaskRows_ directly instead, because it needs the SAME lock to also
 * cover its `ops` updates — see applyAssistWrites_. */
function writeNewTaskRows_(sheet, headers, rows, opId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return appendTaskRows_(sheet, headers, rows, opId);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// AI CAPTURE HELPERS (Phase 4) — sheet/network access, not pure
// ---------------------------------------------------------------------------

/**
 * Calls Gemini with one brain-dump and returns the parsed task list (see
 * parseGeminiTasks_). Throws a short, readable error on any failure — a
 * missing key, a non-200 response, or a reply we can't make sense of —
 * which doCapture catches and turns into the one-task fallback.
 */
function callGemini_(raw, todayStr) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("missing_gemini_key");

  const model = PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL") || GEMINI_MODEL_DEFAULT;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
  const prompt = buildGeminiPrompt_(raw, todayStr);

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  };

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": apiKey },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true, // so a Gemini error comes back as text we can read, not a thrown exception with no detail
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error("gemini_http_" + status + ": " + response.getContentText().slice(0, 200));
  }

  let envelope;
  try {
    envelope = JSON.parse(response.getContentText());
  } catch (err) {
    throw new Error("gemini_bad_json_envelope");
  }

  const text = envelope && envelope.candidates && envelope.candidates[0] &&
    envelope.candidates[0].content && envelope.candidates[0].content.parts &&
    envelope.candidates[0].content.parts[0] && envelope.candidates[0].content.parts[0].text;
  if (!text) throw new Error("gemini_no_text_in_response");

  return parseGeminiTasks_(text);
}

/** Appends one row to the Log tab and returns its 1-based sheet row number,
 * so the caller can come back later and fill in the `result` column.
 * `opId` is optional (doCapture's early callers before Phase 8 didn't have
 * one to pass) — it's what findStoredAssistResult_ later searches on. */
function appendLogRow_(sheet, headers, at, source, rawText, result, opId) {
  const row = headers.map(function (h) {
    if (h === "at") return at;
    if (h === "source") return source;
    if (h === "raw_text") return rawText;
    if (h === "result") return result;
    if (h === "op_id") return opId || "";
    return "";
  });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

/** Fills in the `result` column of a Log row written earlier by appendLogRow_. */
function updateLogResult_(sheet, headers, rowNum, result) {
  const resultCol = headers.indexOf("result");
  if (resultCol === -1) return;
  sheet.getRange(rowNum, resultCol + 1).setValue(result);
}

/**
 * Looks for Tasks2 rows that already carry this op_id — the idempotency
 * check that makes a retried `capture` request safe. An empty op_id never
 * matches anything (it would otherwise match every never-retried row).
 */
function findTasksByOpId_(sheet, headers, opId) {
  if (!opId) return [];
  const opIdCol = headers.indexOf("op_id");
  const lastRow = sheet.getLastRow();
  if (opIdCol === -1 || lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const matches = [];
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][opIdCol] || "") === opId) matches.push(rowToTask_(headers, values[i]));
  }
  return matches;
}

// ---------------------------------------------------------------------------
// SECRETARY MODE / `assist` (Phase 8) — sheet/network access, not pure
// ---------------------------------------------------------------------------
//
// The whole flow, end to end (see doAssistInternal_):
//   1. Log the raw text FIRST, same never-lose-it rule as capture — with
//      the op_id, so a retry can find its own earlier result (step 2).
//   2. Idempotency: if this exact op_id already finished once, hand back
//      that same stored result instead of doing it all again.
//   3. Build a compact list of existing tasks (selectAssistContextTasks_)
//      and ask Gemini what the person meant — new tasks, changes to
//      existing ones (by id, copied verbatim from that list), an answer,
//      or some mix — via callGeminiAssist_ + parseAssistResult_.
//   4. Apply it: new tasks the same way a plain capture does; each `op`
//      mapped to an ordinary applyUpdate_ field bag (mapAssistOpToFields_)
//      and written the same way a hand-edit would be, all under one lock
//      (applyAssistWrites_) so the response is never half-applied.
//   5. On any Gemini failure, fall back EXACTLY like doCapture does: the
//      whole raw text saved as one Inbox task, nothing lost.

/**
 * Action `assist`: the one thing the capture box sends for everything now
 * (see js/app.js's handleCapture) — a brain-dump, a command like "move the
 * dentist to Friday", a question like "what's due this week?", or a mix.
 * Thin wrapper around doAssistInternal_ so test_assist() can run the exact
 * same logic in a dry run (no writes) from the Apps Script editor.
 */
function doAssist(request) {
  return doAssistInternal_(request, false);
}

/**
 * Run this by hand (function dropdown → `test_assist` → Run) any time you
 * want to see how `assist` would read a real ramble against your ACTUAL
 * tasks, without writing anything — see docs/RUNBOOK.md section M. Logs
 * the parsed intent/reply/new_tasks/ops to the Execution log. Edit
 * `sampleRaw` below to try your own wording.
 */
function test_assist() {
  const sampleRaw =
    "I did the recycling, move the dentist thing to friday, and what's due this week?";
  Logger.log("test_assist: DRY RUN — nothing will be written to Tasks2 or Log.");
  doAssistInternal_({ payload: { raw: sampleRaw, op_id: "", today_hint: todayString_() } }, true);
}

/**
 * The real implementation behind both doAssist (dryRun=false, writes for
 * real) and test_assist() (dryRun=true, reads your real tasks for context
 * but never writes a row). See this section's header comment for the
 * numbered flow.
 */
function doAssistInternal_(request, dryRun) {
  const payload = request.payload || {};
  const rawInput = String(payload.raw || "").trim();
  const opId = String(payload.op_id || "");
  // Same idea as doCapture's source_hint: purely so the Log tab can tell a
  // typed ramble apart from a shared one later — changes nothing else.
  const sourceHint = payload.source_hint === "share" ? "share" : "typed";
  const nowIso = nowIso_();
  const today = todayString_();

  if (!rawInput) return { ok: false, error: "missing_text" };
  const raw = rawInput.slice(0, GEMINI_MAX_RAW_CHARS);

  const ss = getSpreadsheet_();
  const tasksSheet = ensureTabs_(ss);
  const tasksHeaders = getHeaders_(tasksSheet);
  const logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  const logHeaders = getHeaders_(logSheet);

  let logRowNum = null;
  if (!dryRun) {
    // Idempotency: a retried request with the SAME op_id (e.g. the first
    // reply timed out on the way back but actually succeeded) gets back
    // exactly what happened the first time, instead of possibly applying
    // the same command twice.
    if (opId) {
      const previous = findStoredAssistResult_(logSheet, logHeaders, opId);
      if (previous) return previous;
    }
    logRowNum = appendLogRow_(logSheet, logHeaders, nowIso, "assist:" + sourceHint, raw, "pending", opId);
  }

  const lastRow = tasksSheet.getLastRow();
  const allTasks = lastRow < 2
    ? []
    : rowsToTasks_(tasksHeaders, tasksSheet.getRange(2, 1, lastRow - 1, tasksHeaders.length).getValues());
  // Same "what would the app itself show you" rule as doList — a dropped
  // task, or one done more than a week ago, isn't worth Gemini's attention
  // (or the prompt's space) either.
  const visibleTasks = filterVisibleTasks_(allTasks, nowIso);
  const contextTasks = selectAssistContextTasks_(visibleTasks, ASSIST_MAX_CONTEXT_TASKS);
  const knownIds = contextTasks.map(function (t) { return t.id; });

  let assistResult = null;
  let failureReason = "";
  try {
    const responseText = callGeminiAssist_(raw, today, contextTasks);
    assistResult = parseAssistResult_(responseText, knownIds);
  } catch (err) {
    failureReason = errorMessage_(err);
  }

  if (dryRun) {
    if (assistResult) {
      Logger.log("test_assist: intent=" + assistResult.intent + "  reply=" + JSON.stringify(assistResult.reply));
      Logger.log("test_assist: new_tasks =\n" + JSON.stringify(assistResult.new_tasks, null, 2));
      Logger.log("test_assist: ops =\n" + JSON.stringify(assistResult.ops, null, 2));
    } else {
      Logger.log(
        "test_assist: Gemini call/parse failed (" + failureReason + ") — real traffic would fall " +
        "back to one Inbox task with the raw text. Nothing was written either way."
      );
    }
    return { ok: true, dryRun: true, intent: assistResult ? assistResult.intent : "capture", reply: assistResult ? assistResult.reply : "" };
  }

  let response;
  if (assistResult) {
    response = applyAssistWrites_(tasksSheet, tasksHeaders, assistResult, raw, nowIso, opId);
  } else {
    // Exactly doCapture's fallback: the whole raw text, saved as one task
    // in the Inbox, so a Gemini outage never loses what was typed/said.
    const fallbackRow = buildFallbackTask_(raw, Utilities.getUuid(), nowIso);
    const savedTasks = writeNewTaskRows_(tasksSheet, tasksHeaders, [fallbackRow], opId);
    response = { ok: true, intent: "capture", reply: "", tasks: savedTasks, updated: [], source: "fallback", reason: failureReason || "no_usable_result" };
  }

  const resultText = "done:" + JSON.stringify(response).slice(0, 45000);
  updateLogResult_(logSheet, logHeaders, logRowNum, resultText);
  return response;
}

/**
 * Looks in the Log tab for a previous `assist` call with this exact op_id
 * that finished and stored a real result (its `result` column starts with
 * "done:") — see doAssistInternal_ writing that after updateLogResult_. A
 * row that's still "pending" (the process died mid-request) or failed some
 * other way is NOT treated as a duplicate: it just runs again, same as if
 * it had never been tried, since nothing was ever returned to the caller
 * for it. Scans from the most recent row backwards since a duplicate, if
 * one exists, is almost always near the end of the tab.
 */
function findStoredAssistResult_(sheet, headers, opId) {
  if (!opId) return null;
  const opIdCol = headers.indexOf("op_id");
  const resultCol = headers.indexOf("result");
  const lastRow = sheet.getLastRow();
  if (opIdCol === -1 || resultCol === -1 || lastRow < 2) return null;

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][opIdCol] || "") !== opId) continue;
    const result = String(values[i][resultCol] || "");
    if (result.indexOf("done:") !== 0) continue;
    try {
      const parsed = JSON.parse(result.slice("done:".length));
      return Object.assign({}, parsed, { duplicate: true });
    } catch (err) {
      return null; // corrupt/truncated stored JSON — treat as "no match", just run it again
    }
  }
  return null;
}

/**
 * Calls Gemini for one `assist` request and returns the raw JSON text
 * reply (NOT yet parsed — that's parseAssistResult_'s job, kept separate
 * and pure so it can be unit-tested without a network call, same split as
 * callGemini_/parseGeminiTasks_ above). Throws a short, readable error on
 * any failure, which doAssistInternal_ treats exactly like a capture
 * failure: fall back to one Inbox task.
 */
function callGeminiAssist_(raw, todayStr, contextTasks) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("missing_gemini_key");

  const model = PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL") || GEMINI_MODEL_DEFAULT;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
  const prompt = buildAssistPrompt_(raw, todayStr, contextTasks);

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: ASSIST_RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  };

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": apiKey },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error("gemini_http_" + status + ": " + response.getContentText().slice(0, 200));
  }

  let envelope;
  try {
    envelope = JSON.parse(response.getContentText());
  } catch (err) {
    throw new Error("gemini_bad_json_envelope");
  }

  const text = envelope && envelope.candidates && envelope.candidates[0] &&
    envelope.candidates[0].content && envelope.candidates[0].content.parts &&
    envelope.candidates[0].content.parts[0] && envelope.candidates[0].content.parts[0].text;
  if (!text) throw new Error("gemini_no_text_in_response");

  return text;
}

/**
 * Applies one parsed, already-validated assist result to the sheet: new
 * tasks (validateNewTask_, same as a plain capture) and ops (each mapped
 * to an applyUpdate_ field bag by mapAssistOpToFields_, then written and
 * calendar-synced exactly like a hand-edit) — all under ONE lock, so the
 * response can never come back describing a change that only half-applied.
 * An op whose id has since vanished (dropped, or from a stale context) is
 * quietly skipped, never fails the whole request.
 */
function applyAssistWrites_(sheet, headers, assistResult, raw, nowIso, opId) {
  // Every new task here already came out of parseAssistResult_ clean, so
  // validateNewTask_ should never reject one — but if it somehow does
  // (e.g. a title that ended up empty), drop just that one rather than
  // failing the whole assist.
  const newRows = assistResult.new_tasks.map(function (t) {
    const validated = validateNewTask_(
      Object.assign({}, t, { id: Utilities.getUuid(), status: "active", source: "ai", raw_input: raw }),
      nowIso
    );
    return validated.ok ? validated.row : null;
  }).filter(function (row) { return row !== null; });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let created = [];
  const updated = [];
  try {
    created = appendTaskRows_(sheet, headers, newRows, opId);

    if (assistResult.ops.length) {
      const idIndex = buildIdIndex_(sheet, headers);
      for (let i = 0; i < assistResult.ops.length; i++) {
        const op = assistResult.ops[i];
        const rowNum = idIndex[op.id];
        if (!rowNum) continue; // unknown/stale id — skip, never fail the whole assist over one

        const rowValues = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
        const existingTask = rowToTask_(headers, rowValues);
        const fields = mapAssistOpToFields_(op, existingTask);
        if (!fields) continue; // e.g. a "schedule" with no date to schedule to

        const result = applyUpdate_(existingTask, fields, nowIso);
        if (!result.ok) continue;

        sheet.getRange(rowNum, 1, 1, headers.length).setValues([taskToRowValues_(headers, result.task)]);
        result.task.calendar_event_id = syncTaskEvent_(sheet, headers, rowNum, result.task);
        updated.push(rowToTask_(headers, taskToRowValues_(headers, result.task)));
      }
    }
  } finally {
    lock.releaseLock();
  }

  return { ok: true, intent: assistResult.intent, reply: assistResult.reply, tasks: created, updated: updated, source: "ai" };
}

// --- Phase 8 `assist` — pure helpers ---------------------------------------
// Like buildGeminiPrompt_/parseGeminiTasks_, these are kept free of any
// Apps Script-only API so they can be copied into a plain .mjs file and run
// under plain `node` — see the verification steps for this phase.

/**
 * PURE: picks which existing tasks to show Gemini for one `assist` call.
 * Most days this is just "all of them" — the cap (ASSIST_MAX_CONTEXT_TASKS)
 * only matters once the list is genuinely long, and even then it's better
 * for Gemini to see the tasks a command is most likely to be about (open
 * work, and anything with a real deadline) than to lose those to make room
 * for old someday/done items.
 */
function selectAssistContextTasks_(tasks, max) {
  if (tasks.length <= max) return tasks;
  const priority = tasks.filter(function (t) { return t.status === "active" || t.status === "inbox" || t.due_date; });
  const rest = tasks.filter(function (t) { return !(t.status === "active" || t.status === "inbox" || t.due_date); });
  return priority.concat(rest).slice(0, max);
}

/** PURE: one compact line per task, in the exact shape buildAssistPrompt_
 * tells Gemini to copy ids from VERBATIM. */
function formatAssistContextLine_(t) {
  const est = (t.est_min === "" || t.est_min === null || t.est_min === undefined) ? "" : String(t.est_min);
  return [
    t.id,
    t.title,
    t.status,
    t.category,
    est,
    "do:" + (t.do_date || ""),
    "due:" + (t.due_date || ""),
    "touched:" + String(t.last_touched_at || "").slice(0, 10),
  ].join(" | ");
}

/** PURE: joins formatAssistContextLine_ over a whole list, one per line. */
function buildAssistContextText_(tasks) {
  return tasks.map(formatAssistContextLine_).join("\n");
}

/**
 * PURE: builds the single text prompt sent to Gemini for an `assist` call —
 * today's date, the rules for splitting new tasks (mirrors
 * buildGeminiPrompt_), and the extra rules for deciding when something is
 * instead a change to an existing task or a question. Pure, so it's
 * testable the same way buildGeminiPrompt_ is.
 */
function buildAssistPrompt_(raw, todayStr, contextTasks) {
  const parts = String(todayStr).split("-").map(Number);
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekday = weekdayNames[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];

  return (
    "You are the one text box a person with ADHD uses for EVERYTHING in their task planner, " +
    "typed or dictated. Today's date is " + todayStr + " (" + weekday + "), timezone Europe/London.\n\n" +
    "Decide what they mean:\n" +
    "- If they describe NEW things to do, put them in new_tasks: keep their own words for titles, " +
    "short (≤80 chars), imperative; put extra detail in notes; estimate minutes realistically " +
    "(5-120); resolve relative dates ('Friday', 'next week', 'tomorrow') to YYYY-MM-DD using today's " +
    "date; due_date for deadlines, do_date only when they say when they'll DO it; leave blank when " +
    "unsure; category from the list, Inbox if unclear.\n" +
    "- If they refer to an EXISTING task (by rough title — match generously, e.g. 'the dentist' means " +
    "'Book dentist check-up'), emit an op using the id copied EXACTLY, character for character, from " +
    "the list below. NEVER invent an id or guess one that isn't in the list. If you can't tell which " +
    "task they mean, ask in `reply` and emit no op for it.\n" +
    "- For a question, answer in `reply` in at most 3 short, warm, plain sentences, using the task " +
    "data below. Never mention how many things are undone, overdue or in the backlog unless they ask " +
    "for a number directly.\n" +
    "- For a command, `reply` is a short confirmation, e.g. \"Done — dentist moved to Friday.\" " +
    "`reply` can be left blank for a plain capture with nothing else going on.\n\n" +
    "intent is exactly one of: capture (only new things), command (only changes to existing tasks), " +
    "question (only an answer, no changes), mixed (both new things and changes/an answer).\n\n" +
    "Categories: " + CATEGORIES.join(", ") + "\n\n" +
    "ops you can use: complete, uncomplete, drop, someday, restore, " +
    "schedule (needs do_date), unschedule, set_due (needs due_date and/or due_time), clear_due, " +
    "edit (any of title/notes/category/est_min).\n\n" +
    "Existing tasks — one per line, exactly (id | title | status | category | est | do: | due: | touched:):\n" +
    (contextTasks.length ? buildAssistContextText_(contextTasks) : "(none yet — everything is new_tasks)") + "\n\n" +
    "What they just said:\n" + raw
  );
}

/**
 * PURE: turns Gemini's raw JSON text reply for an `assist` call into a
 * clean, safe result. Same "structural failure throws, everything else is
 * best-effort" split as parseGeminiTasks_/validateReview_ above: not-JSON
 * or not-an-object throws (doAssistInternal_ treats that exactly like a
 * Gemini outage and falls back to one Inbox task); everything else
 * degrades gracefully — an unrecognised op name, or an id Gemini wasn't
 * actually shown (not in `knownIds`), is just dropped from `ops`, never
 * allowed to touch a task it was never shown or invent a change nobody
 * asked for.
 */
function parseAssistResult_(jsonText, knownIds) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error("assist_bad_json: " + (err && err.message ? err.message : String(err)));
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("assist_bad_shape");
  }

  const knownIdSet = knownIds instanceof Set ? knownIds : new Set(Array.isArray(knownIds) ? knownIds : []);

  const intent = ASSIST_INTENTS.indexOf(parsed.intent) !== -1 ? parsed.intent : "capture";
  const reply = String(parsed.reply || "").trim().slice(0, ASSIST_REPLY_MAX_CHARS);

  const rawNewTasks = Array.isArray(parsed.new_tasks) ? parsed.new_tasks : [];
  const newTasks = [];
  for (let i = 0; i < rawNewTasks.length && newTasks.length < GEMINI_MAX_TASKS; i++) {
    const t = rawNewTasks[i];
    if (!t || typeof t !== "object") continue;
    const title = String(t.title || "").trim().slice(0, 80);
    if (!title) continue; // no usable title — not something we can call a task

    newTasks.push({
      title: title,
      notes: t.notes ? String(t.notes) : "",
      category: CATEGORIES.indexOf(t.category) !== -1 ? t.category : "Inbox",
      est_min: clampEstMin_(t.est_min),
      do_date: validDate_(t.do_date) ? t.do_date : "",
      due_date: validDate_(t.due_date) ? t.due_date : "",
      due_time: validTime_(t.due_time) ? t.due_time : "",
    });
  }

  const rawOps = Array.isArray(parsed.ops) ? parsed.ops : [];
  const ops = [];
  for (let i = 0; i < rawOps.length && ops.length < ASSIST_MAX_OPS; i++) {
    const o = rawOps[i];
    if (!o || typeof o !== "object") continue;

    const opName = ASSIST_OPS.indexOf(o.op) !== -1 ? o.op : "";
    if (!opName) continue; // unrecognised op name — dropped, never guessed at

    const id = String(o.id || "").trim();
    if (!id || !knownIdSet.has(id)) continue; // no id, or one Gemini was never shown — dropped, never invented

    const clean = { op: opName, id: id };
    if (validDate_(o.do_date)) clean.do_date = o.do_date;
    if (validDate_(o.due_date)) clean.due_date = o.due_date;
    if (validTime_(o.due_time)) clean.due_time = o.due_time;
    if (typeof o.title === "string" && o.title.trim()) clean.title = o.title.trim().slice(0, 300);
    if (typeof o.notes === "string") clean.notes = o.notes;
    if (CATEGORIES.indexOf(o.category) !== -1) clean.category = o.category;
    if (o.est_min !== undefined) clean.est_min = clampEstMin_(o.est_min);

    ops.push(clean);
  }

  return { intent: intent, reply: reply, new_tasks: newTasks, ops: ops };
}

/**
 * PURE: maps one already-validated assist op onto the same whitelist-only
 * field bag applyUpdate_ expects from a normal edit — this is what makes
 * an op just an ordinary task update under the hood, with all of
 * applyUpdate_'s own safety (bad dates ignored, empty title rejected) for
 * free. Returns null for an op that, once you look at what it's actually
 * asking for, has nothing sensible to do (e.g. "schedule" with no date) —
 * the caller skips it rather than guessing.
 */
function mapAssistOpToFields_(op, existingTask) {
  const o = op.op;
  if (o === "complete") return { status: "done" };
  if (o === "uncomplete") return { status: "active" };
  if (o === "drop") return { status: "dropped" };
  if (o === "someday") return { status: "someday" };
  if (o === "restore") return { status: "active" };

  if (o === "schedule") {
    if (!op.do_date) return null; // nothing to schedule it TO
    const fields = { do_date: op.do_date };
    // A schedule command is also a decision that this thing is happening —
    // bump it out of Inbox/Someday onto the active list, same as tapping
    // "Today"/"Pick a day" on it by hand would (see app.js's
    // withSortedStatus for the equivalent client-side rule).
    if (existingTask && (existingTask.status === "inbox" || existingTask.status === "someday")) {
      fields.status = "active";
    }
    return fields;
  }

  if (o === "unschedule") return { do_date: "" };

  if (o === "set_due") {
    if (!op.due_date && !op.due_time) return null; // nothing to set
    const fields = {};
    if (op.due_date !== undefined) fields.due_date = op.due_date;
    if (op.due_time !== undefined) fields.due_time = op.due_time;
    return fields;
  }

  if (o === "clear_due") return { due_date: "", due_time: "" };

  if (o === "edit") {
    const fields = {};
    if (op.title !== undefined) fields.title = op.title;
    if (op.notes !== undefined) fields.notes = op.notes;
    if (op.category !== undefined) fields.category = op.category;
    if (op.est_min !== undefined) fields.est_min = op.est_min;
    return Object.keys(fields).length ? fields : null; // nothing to edit
  }

  return null;
}

// ---------------------------------------------------------------------------
// CALENDAR REMINDERS (Phase 6)
// ---------------------------------------------------------------------------

/**
 * Finds the dedicated "Tasks" Google Calendar this app uses for reminders,
 * creating it once (the first time any task needs an event) if it doesn't
 * exist yet. The calendar's id is remembered in the Script Property
 * TASKS_CALENDAR_ID so we always find the SAME calendar again — this app
 * only ever reads or writes events inside that one calendar, never your
 * main "Home"/personal calendar.
 */
function getTasksCalendar_() {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty("TASKS_CALENDAR_ID");

  if (existingId) {
    const existing = CalendarApp.getCalendarById(existingId);
    if (existing) return existing;
    // The id we had saved doesn't resolve to a real calendar any more
    // (e.g. it was deleted by hand in Google Calendar) — fall through and
    // make a fresh one rather than throwing.
  }

  const created = CalendarApp.createCalendar("Tasks");
  props.setProperty("TASKS_CALENDAR_ID", created.getId());
  return created;
}

/**
 * PURE: decides whether a task should currently have a calendar reminder,
 * and if so what it should say. No CalendarApp access here at all — that's
 * what makes this the part runTests() can actually check, since the
 * Calendar-touching half (syncTaskEvent_) needs a real Apps Script project
 * to run against.
 *
 * Only an open task (active or inbox — i.e. not done/dropped/someday) with
 * a due_date wants an event. do_date alone ("I plan to do this on...")
 * never creates a calendar event — only a real due_date does, because a
 * calendar reminder is for something with an actual deadline, not every
 * plan.
 */
function desiredEventState_(task) {
  const isOpenStatus = task && (task.status === "active" || task.status === "inbox");
  if (!isOpenStatus || !task.due_date) return null;

  return {
    title: String(task.title || ""),
    dueDate: task.due_date,
    dueTime: task.due_time || "",
    description: String(task.notes || "") + "\n\nOpen: " + APP_URL,
  };
}

/**
 * Makes one task's calendar event match desiredEventState_'s answer:
 * creates it, updates it, or deletes it, then writes the (possibly
 * changed) calendar_event_id straight into that task's row and returns it.
 *
 * Wrapped in one big try/catch on purpose: Calendar being briefly
 * unavailable, a quota hiccup, or any other Calendar-side problem must
 * NEVER stop a task from having already been saved to the sheet a moment
 * ago (see doAdd/doUpdate/doCapture, which all call this AFTER their own
 * sheet write). On any failure we just log it and hand back whatever
 * calendar_event_id the task already had, unchanged.
 */
function syncTaskEvent_(sheet, headers, rowNum, task) {
  const existingId = task.calendar_event_id || "";

  try {
    const desired = desiredEventState_(task);

    // Most tasks have no due date and no event — nothing to do, so don't
    // touch the Calendar service at all. (Google rate-limits calendar
    // calls, and resync_calendar walks every row.)
    if (!desired && !existingId) return "";

    const cal = getTasksCalendar_();
    let event = existingId ? cal.getEventById(existingId) : null;

    if (!desired) {
      if (event) event.deleteEvent();
      return writeCalendarEventId_(sheet, headers, rowNum, "", existingId);
    }

    const wantsAllDay = !desired.dueTime;

    // An existing event can't be converted between timed and all-day in
    // place (CalendarApp only allows setTime on a timed event and
    // setAllDayDate on an all-day one) — simplest correct fix is to drop
    // it and create a fresh one that matches what's wanted now.
    if (event && event.isAllDayEvent() !== wantsAllDay) {
      event.deleteEvent();
      event = null;
    }

    if (!event) {
      event = wantsAllDay
        ? cal.createAllDayEvent(desired.title, parseDateOnly_(desired.dueDate), { description: desired.description })
        : cal.createEvent(
            desired.title,
            parseDateTime_(desired.dueDate, desired.dueTime),
            addMinutes_(parseDateTime_(desired.dueDate, desired.dueTime), 30),
            { description: desired.description }
          );
    } else {
      event.setTitle(desired.title);
      event.setDescription(desired.description);
      if (wantsAllDay) {
        event.setAllDayDate(parseDateOnly_(desired.dueDate));
      } else {
        const start = parseDateTime_(desired.dueDate, desired.dueTime);
        event.setTime(start, addMinutes_(start, 30));
      }
    }

    // Reminders are set fresh every time (remove, then re-add) rather than
    // trying to detect "did the reminder already match" — simple and
    // idempotent beats clever here. A timed task gets two nudges (an hour
    // before, and right at the time); an all-day task gets one, at the
    // simplest moment that actually notifies.
    event.removeAllReminders();
    if (wantsAllDay) {
      // For an all-day event, "minutes before" counts back from MIDNIGHT,
      // so 0 would buzz the phone at 00:00. 900 minutes = 09:00 the day
      // before: a calm "this is due tomorrow" heads-up. The 07:30 digest
      // event covers the day itself.
      event.addPopupReminder(900);
    } else {
      event.addPopupReminder(60);
      event.addPopupReminder(0);
    }

    return writeCalendarEventId_(sheet, headers, rowNum, event.getId(), existingId);
  } catch (err) {
    Logger.log("syncTaskEvent_ failed for task " + (task && task.id) + ": " + errorMessage_(err));
    return existingId;
  }
}

/** Writes a new calendar_event_id into one row, but only if it actually
 * changed — saves a write on the (common) case where syncTaskEvent_
 * updated an existing event in place. Returns the value written, so
 * callers can update their own in-memory copy of the task too. */
function writeCalendarEventId_(sheet, headers, rowNum, newValue, previousValue) {
  if (newValue === previousValue) return newValue;
  const col = headers.indexOf("calendar_event_id");
  if (col !== -1) sheet.getRange(rowNum, col + 1).setValue(newValue);
  return newValue;
}

function parseDateOnly_(dateStr) {
  const parts = String(dateStr).split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

/** YYYY-MM-DD plus N days, as YYYY-MM-DD (in the script's timezone). */
function addDaysString_(dateStr, days) {
  const d = parseDateOnly_(dateStr);
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function parseDateTime_(dateStr, timeStr) {
  const dateParts = String(dateStr).split("-").map(Number);
  const timeParts = String(timeStr).split(":").map(Number);
  return new Date(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0] || 0, timeParts[1] || 0);
}

function addMinutes_(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

/**
 * Run this by hand (function dropdown → `resync_calendar` → Run) any time
 * you want the Tasks calendar brought back in line with Tasks2 — e.g. right
 * after turning Phase 6 on for the first time (to create events for every
 * dated task that predates this feature), or if you ever deleted an event
 * by hand in Google Calendar and want it put back. Walks every row once and
 * runs the exact same create/update/delete decision syncTaskEvent_ uses for
 * a single task.
 */
function resync_calendar() {
  const ss = getSpreadsheet_();
  const sheet = ensureTabs_(ss);
  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    Logger.log("resync_calendar: Tasks2 has no data rows — nothing to do.");
    return;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  let changed = 0;
  for (let i = 0; i < values.length; i++) {
    const task = rowToTask_(headers, values[i]);
    if (!task.id) continue;
    const before = task.calendar_event_id;
    const touchesCalendar = !!before || !!desiredEventState_(task);
    const after = syncTaskEvent_(sheet, headers, i + 2, task);
    if (after !== before) changed++;
    // Google refuses "too many calendar calls in a short time", so pause
    // briefly after each row that actually talked to the calendar.
    if (touchesCalendar) Utilities.sleep(500);
  }

  Logger.log("resync_calendar: checked " + values.length + " row(s), " + changed + " calendar_event_id value(s) changed.");
}

// ---------------------------------------------------------------------------
// NIGHTLY TIDY + MORNING DIGEST (Phase 6)
// ---------------------------------------------------------------------------

/**
 * PURE: works out what nightlyTidy() should change, without touching the
 * sheet — this is what runTests() checks directly. Returns a list of
 * `{ id, fields }` updates, using the same "only these keys change" shape
 * doUpdate/applyUpdate_ already use, so nightlyTidy() can apply each one
 * the normal way.
 *
 * Three independent rules (checked in this order; a task only ever matches
 * one):
 *   1. An ACTIVE task whose do_date has already passed goes back to
 *      unscheduled (do_date cleared). Not "overdue" — this app has no
 *      overdue concept on purpose (see docs/01-what-we-built-data-and-ui.md)
 *      — it just quietly stops claiming you were going to do it on a day
 *      that's already gone, and last_touched_at is left exactly alone
 *      (this isn't "you touched it", it's the app tidying up after you).
 *   2. An ACTIVE task with no due_date that hasn't been touched in
 *      FADE_DAYS days fades to Someday. Nothing is deleted; it's simply
 *      out of the way until you're ready for it again.
 *   3. An INBOX task (a capture nobody has sorted yet) untouched for that
 *      same FADE_DAYS gets the same gentle fade, so an unsorted capture
 *      can't silently pile up in Inbox forever either.
 */
function planNightlyTidy_(tasks, todayStr, nowIso) {
  const updates = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || !t.id) continue;

    if (t.status === "active" && t.do_date && t.do_date < todayStr) {
      updates.push({ id: t.id, fields: { do_date: "" } });
      continue;
    }

    if (t.status === "active" && !t.due_date && isOlderThanNDays_(t.last_touched_at, FADE_DAYS, nowIso)) {
      updates.push({ id: t.id, fields: { status: "someday" } });
      continue;
    }

    if (t.status === "inbox" && isOlderThanNDays_(t.last_touched_at, FADE_DAYS, nowIso)) {
      updates.push({ id: t.id, fields: { status: "someday" } });
      continue;
    }
  }

  return updates;
}

/** The inverse of isWithinLastNDays_ — true when a timestamp is further
 * back than `days` days before `nowIso` (or missing/unparseable, which
 * counts as "old" here, though in practice every task always has a
 * last_touched_at from the moment it's created). */
function isOlderThanNDays_(isoTimestamp, days, nowIso) {
  return !isWithinLastNDays_(isoTimestamp, days, nowIso);
}

/**
 * Runs automatically once a day, roughly 3am (see installTriggers()). Reads
 * every Tasks2 row once, works out what should change with the pure
 * planNightlyTidy_ above, writes back only the rows that actually changed,
 * then rebuilds the 07:30 digest event so it reflects tonight's tidying.
 *
 * You can also run this by hand from the editor (function dropdown →
 * `nightlyTidy` → Run) any time you want to see it work without waiting for
 * 3am — see docs/RUNBOOK.md section K.
 */
function nightlyTidy() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSpreadsheet_();
    const sheet = ensureTabs_(ss);
    const headers = getHeaders_(sheet);
    const lastRow = sheet.getLastRow();

    if (lastRow < 2) {
      Logger.log("nightlyTidy: Tasks2 has no data rows — nothing to tidy.");
    } else {
      const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      const tasks = rowsToTasks_(headers, values);
      const today = todayString_();
      const nowIso = nowIso_();
      const updates = planNightlyTidy_(tasks, today, nowIso);

      const idToIndex = {};
      for (let i = 0; i < tasks.length; i++) idToIndex[tasks[i].id] = i;

      let unscheduledCount = 0;
      let fadedCount = 0;
      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        const idx = idToIndex[update.id];
        if (idx === undefined) continue; // shouldn't happen, but never crash the whole run over one row

        const merged = Object.assign({}, tasks[idx], update.fields);
        sheet.getRange(idx + 2, 1, 1, headers.length).setValues([taskToRowValues_(headers, merged)]);

        if ("do_date" in update.fields) unscheduledCount++;
        if ("status" in update.fields) fadedCount++;
      }

      Logger.log(
        "nightlyTidy: " + updates.length + " task(s) updated (" +
        unscheduledCount + " unscheduled, " + fadedCount + " faded to someday)."
      );
    }
  } finally {
    lock.releaseLock();
  }

  // Outside the lock: this does its own sheet read (of whatever the tidy
  // pass just left behind) and its own Calendar calls, and — like every
  // other Calendar-touching function here — never throws.
  buildDigestEvent_();
}

/**
 * PURE: builds the 07:30 digest event's title and description from
 * today's tasks. No CalendarApp access, so runTests() can check it
 * directly. Deliberately never mentions how many tasks are unscheduled or
 * sitting in the backlog — see docs/01-what-we-built-data-and-ui.md for why
 * this app never turns "stuff you haven't done" into a number to feel bad
 * about. It only ever talks about today.
 */
function buildDigestText_(tasks, todayStr) {
  const openLine = "Open: " + APP_URL;

  const todays = (tasks || []).filter(function (t) {
    return t && t.status === "active" && (t.do_date === todayStr || t.due_date === todayStr);
  });

  if (todays.length === 0) {
    return {
      title: "Today: a clean slate — pick 3 in the app",
      description: openLine,
    };
  }

  const withEstimate = todays.filter(function (t) { return typeof t.est_min === "number" && t.est_min > 0; });
  const pool = withEstimate.length ? withEstimate : todays;
  const shortest = pool.slice().sort(function (a, b) { return (a.est_min || 0) - (b.est_min || 0); })[0];

  const title = "Today: " + todays.length + " things — start with " + shortest.title;

  const shown = todays.slice(0, 8);
  const lines = shown.map(function (t) { return "• " + t.title; });
  if (todays.length > 8) lines.push("…and more");
  const description = lines.join("\n") + "\n\n" + openLine;

  return { title: title, description: description };
}

/**
 * Deletes the previous digest event (tracked by Script Property
 * DIGEST_EVENT_ID, so we always know exactly which event to remove even
 * across script restarts) and creates today's replacement: a 07:30–07:40
 * event in the Tasks calendar with one popup reminder at the time. Called
 * at the end of nightlyTidy() every night, and safe to call by hand too
 * (function dropdown → `buildDigestEvent_` → Run) if you want to see
 * today's digest appear without waiting for 3am.
 *
 * Same try/catch discipline as syncTaskEvent_: nightlyTidy()'s sheet
 * changes have already happened by the time this runs, and a Calendar
 * problem here must never look like the whole nightly tidy failed.
 */
function buildDigestEvent_() {
  try {
    const cal = getTasksCalendar_();
    const props = PropertiesService.getScriptProperties();
    const previousId = props.getProperty("DIGEST_EVENT_ID");
    if (previousId) {
      const previous = cal.getEventById(previousId);
      if (previous) previous.deleteEvent();
    }

    const ss = getSpreadsheet_();
    const sheet = ensureTabs_(ss);
    const headers = getHeaders_(sheet);
    const lastRow = sheet.getLastRow();
    const tasks = lastRow < 2
      ? []
      : rowsToTasks_(headers, sheet.getRange(2, 1, lastRow - 1, headers.length).getValues());

    // The nightly trigger runs around 03:00, so "today 07:30" is still
    // ahead. But if this is run by hand later in the day, a 07:30 event
    // would already be in the past — so aim at tomorrow morning instead.
    let target = todayString_();
    if (new Date() > parseDateTime_(target, "07:40")) {
      target = addDaysString_(target, 1);
    }
    const text = buildDigestText_(tasks, target);

    const start = parseDateTime_(target, "07:30");
    const end = parseDateTime_(target, "07:40");
    const event = cal.createEvent(text.title, start, end, { description: text.description });
    event.removeAllReminders();
    event.addPopupReminder(0);

    props.setProperty("DIGEST_EVENT_ID", event.getId());
    Logger.log("Digest event created for " + target + " 07:30 in the Tasks calendar: \"" + text.title + "\"");
  } catch (err) {
    Logger.log("buildDigestEvent_ failed: " + errorMessage_(err));
  }
}

// ---------------------------------------------------------------------------
// WEEKLY REVIEW (Phase 7)
// ---------------------------------------------------------------------------
//
// The whole flow, end to end:
//   1. review_export hands an outside reviewer (Gemini automatically, or
//      Claude via the owner's own local scheduled task — see
//      tools/weekly-review/) everything it needs to write a review: the
//      open/recently-done tasks and the last 20 captures.
//   2. review_save is how that review comes back and gets stored — always
//      through validateReview_ first, so nothing malformed or hallucinated
//      (an unknown task id, a 40-item list, a missing summary) ever reaches
//      the sheet. Claude's review always wins over Gemini's for the same
//      week — see the comment on doReviewSave for exactly how.
//   3. review_get is what the app reads on load: the latest review that
//      hasn't been dismissed and isn't stale (see isReviewFresh_).
//   4. review_apply is what "Apply ticked" on the review card calls: it
//      turns accepted suggestions into real task updates, the exact same
//      way editing a task by hand would (applyUpdate_ + syncTaskEvent_),
//      then dismisses the review so it doesn't show again.
//   5. review_dismiss is "Not now" — the review just goes away; nothing
//      about the tasks changes.

/**
 * Action `review_export`: everything an outside reviewer (Gemini or Claude)
 * needs to write this week's review, and nothing more. Tasks are trimmed to
 * just the fields a review might reasonably reason about (see the field
 * list below) — not the whole Tasks2 row, which also has bookkeeping like
 * calendar_event_id and op_id that a reviewer has no use for.
 */
function doReviewExport(request) {
  const ss = getSpreadsheet_();
  const sheet = ensureTabs_(ss);
  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  const today = todayString_();
  const weekStart = mondayOf_(today);
  const nowIso = nowIso_();

  const allTasks = lastRow < 2
    ? []
    : rowsToTasks_(headers, sheet.getRange(2, 1, lastRow - 1, headers.length).getValues());

  // Same "never show a dropped task" rule as doList, but done tasks get a
  // longer window here (14 days, not DONE_VISIBLE_DAYS' 7) — a review looks
  // back over the whole week, not just "what did I finish today".
  const tasks = allTasks
    .filter(function (t) {
      if (!t.id) return false;
      if (t.status === "dropped") return false;
      if (t.status === "done") return isWithinLastNDays_(t.completed_at, 14, nowIso);
      return true;
    })
    .map(function (t) {
      return {
        id: t.id,
        title: t.title,
        notes: t.notes,
        category: t.category,
        est_min: t.est_min,
        status: t.status,
        do_date: t.do_date,
        due_date: t.due_date,
        created_at: t.created_at,
        completed_at: t.completed_at,
        last_touched_at: t.last_touched_at,
      };
    });

  const logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  const logHeaders = getHeaders_(logSheet);
  const recentCaptures = lastLogRows_(logSheet, logHeaders, 20);

  return { ok: true, week_start: weekStart, today: today, tasks: tasks, recent_captures: recentCaptures };
}

/**
 * Action `review_save`: stores one week's review, keyed by week_start (one
 * row per week — a second save for the same week overwrites the first,
 * subject to the Claude-beats-Gemini rule below).
 *
 * Every review goes through validateReview_ FIRST, with the real list of
 * known task ids, before it touches the sheet — this is what stops a
 * reviewer's mistake (a made-up id, a list that's too long, a missing
 * summary) from ever reaching what the app shows you.
 *
 * Claude overwrites Gemini; Gemini never overwrites Claude. Claude is the
 * better writer (it's the owner's own subscription, prompted with the full
 * conversation this task came from), so if it already wrote this week's
 * review, the Monday-morning Gemini safety net backing off quietly is
 * exactly right — see weeklyGeminiReview's own "already exists" check for
 * the other half of this rule (it skips calling Gemini at all in that
 * case; this check is what protects the sheet even if that skip is ever
 * bypassed, e.g. a manual test run).
 */
function doReviewSave(request) {
  const payload = request.payload || {};
  const weekStart = String(payload.week_start || "").trim();
  const source = (payload.source === "claude" || payload.source === "gemini") ? payload.source : "";

  if (!validDate_(weekStart)) return { ok: false, error: "invalid_week_start" };
  if (!source) return { ok: false, error: "invalid_source" };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSpreadsheet_();
    const tasksSheet = ensureTabs_(ss);
    const tasksHeaders = getHeaders_(tasksSheet);
    const knownIds = collectIds_(tasksSheet, tasksHeaders);

    const validated = validateReview_(payload.review, knownIds);
    if (!validated.ok) return { ok: false, error: validated.error };

    const reviewsSheet = ss.getSheetByName(REVIEWS_SHEET_NAME);
    const reviewsHeaders = getHeaders_(reviewsSheet);
    const existingRowNum = findReviewRow_(reviewsSheet, reviewsHeaders, weekStart);

    if (existingRowNum) {
      const sourceCol = reviewsHeaders.indexOf("source");
      const existingSource = String(reviewsSheet.getRange(existingRowNum, sourceCol + 1).getValue() || "");
      if (existingSource === "claude" && source === "gemini") {
        return { ok: true, skipped: "claude_review_exists" };
      }
    }

    const rowObj = {
      week_start: weekStart,
      source: source,
      created_at: nowIso_(),
      json: JSON.stringify(validated.review),
      dismissed_at: "",
    };
    const values = reviewsHeaders.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ""; });

    if (existingRowNum) {
      reviewsSheet.getRange(existingRowNum, 1, 1, reviewsHeaders.length).setValues([values]);
    } else {
      reviewsSheet.appendRow(values);
    }

    return { ok: true, week_start: weekStart, source: source };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Action `review_get`: the review the app should show right now, or null.
 * "Right now" means the most recent (by week_start) row that hasn't been
 * dismissed AND isn't stale (see isReviewFresh_) — so a review you never
 * got round to opening quietly stops being offered after about a week and
 * a half, rather than an old "your week reviewed" card confusingly
 * reappearing a month later.
 */
function doReviewGet(request) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(REVIEWS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, review: null };

  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const weekStartCol = headers.indexOf("week_start");
  const sourceCol = headers.indexOf("source");
  const createdCol = headers.indexOf("created_at");
  const jsonCol = headers.indexOf("json");
  const dismissedCol = headers.indexOf("dismissed_at");
  const today = todayString_();

  let best = null;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const weekStart = String(row[weekStartCol] || "");
    if (!weekStart) continue;
    if (String(row[dismissedCol] || "")) continue; // dismissed — never offered again
    if (!isReviewFresh_(weekStart, today)) continue;
    if (!best || weekStart > best.weekStart) {
      best = {
        weekStart: weekStart,
        source: String(row[sourceCol] || ""),
        createdAt: String(row[createdCol] || ""),
        json: String(row[jsonCol] || ""),
      };
    }
  }
  if (!best) return { ok: true, review: null };

  let parsed;
  try {
    parsed = JSON.parse(best.json);
  } catch (err) {
    return { ok: true, review: null }; // corrupt row — treat exactly like "no review" rather than erroring the app
  }

  return {
    ok: true,
    review: Object.assign({}, parsed, {
      week_start: best.weekStart,
      source: best.source,
      created_at: best.createdAt,
    }),
  };
}

/** Action `review_dismiss`: "Not now" — marks this week's review row as
 * dismissed (review_get will never offer it again) without touching a
 * single task. Silently a no-op if that week's review doesn't exist any
 * more, since "dismiss something already gone" isn't really an error. */
function doReviewDismiss(request) {
  const payload = request.payload || {};
  const weekStart = String(payload.week_start || "").trim();
  if (!weekStart) return { ok: false, error: "missing_week_start" };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(REVIEWS_SHEET_NAME);
    if (!sheet) return { ok: true };
    const headers = getHeaders_(sheet);
    const rowNum = findReviewRow_(sheet, headers, weekStart);
    if (!rowNum) return { ok: true };
    const dismissedCol = headers.indexOf("dismissed_at");
    if (dismissedCol !== -1) sheet.getRange(rowNum, dismissedCol + 1).setValue(nowIso_());
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Action `review_apply`: "Apply ticked" on the review card. Turns whichever
 * suggestion ids the person actually ticked into real task changes — a
 * suggested task goes onto today, a someday one is parked, a drop one is
 * dropped — using the exact same applyUpdate_ + syncTaskEvent_ path a
 * normal edit uses, so a calendar reminder appears/disappears correctly
 * and nothing about "what counts as a valid update" is duplicated here.
 * Then dismisses the review, all under one lock, so the review can never
 * end up half-applied-and-still-showing if something goes wrong partway.
 */
function doReviewApply(request) {
  const payload = request.payload || {};
  const weekStart = String(payload.week_start || "").trim();
  const accept = (payload.accept && typeof payload.accept === "object") ? payload.accept : {};
  const suggestedIds = Array.isArray(accept.suggested) ? accept.suggested.map(String) : [];
  const somedayIds = Array.isArray(accept.someday) ? accept.someday.map(String) : [];
  const dropIds = Array.isArray(accept.drop) ? accept.drop.map(String) : [];

  const today = todayString_();
  const nowIso = nowIso_();
  const updatedTasks = [];

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSpreadsheet_();
    const sheet = ensureTabs_(ss);
    const headers = getHeaders_(sheet);
    const idIndex = buildIdIndex_(sheet, headers);

    function applyFields(id, fields) {
      const rowNum = idIndex[id];
      if (!rowNum) return; // unknown id (e.g. task dropped since the review was written) — skip, don't fail the whole apply

      const rowValues = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
      const existingTask = rowToTask_(headers, rowValues);
      const result = applyUpdate_(existingTask, fields, nowIso);
      if (!result.ok) return;

      sheet.getRange(rowNum, 1, 1, headers.length).setValues([taskToRowValues_(headers, result.task)]);
      result.task.calendar_event_id = syncTaskEvent_(sheet, headers, rowNum, result.task);
      updatedTasks.push(rowToTask_(headers, taskToRowValues_(headers, result.task)));
    }

    for (let i = 0; i < suggestedIds.length; i++) applyFields(suggestedIds[i], { status: "active", do_date: today });
    for (let i = 0; i < somedayIds.length; i++) applyFields(somedayIds[i], { status: "someday", do_date: "" });
    for (let i = 0; i < dropIds.length; i++) applyFields(dropIds[i], { status: "dropped" });

    if (weekStart) {
      const reviewsSheet = ss.getSheetByName(REVIEWS_SHEET_NAME);
      if (reviewsSheet) {
        const reviewsHeaders = getHeaders_(reviewsSheet);
        const reviewRowNum = findReviewRow_(reviewsSheet, reviewsHeaders, weekStart);
        if (reviewRowNum) {
          const dismissedCol = reviewsHeaders.indexOf("dismissed_at");
          if (dismissedCol !== -1) reviewsSheet.getRange(reviewRowNum, dismissedCol + 1).setValue(nowIso);
        }
      }
    }

    return { ok: true, tasks: updatedTasks };
  } finally {
    lock.releaseLock();
  }
}

// --- weekly review — sheet-access helpers (not pure) -----------------------

/** Finds the Reviews row for a given week_start, or null. There's meant to
 * be at most one row per week (doReviewSave always upserts), but this scans
 * rather than assumes, so a duplicate created by hand doesn't crash — it
 * just finds the first match. */
function findReviewRow_(sheet, headers, weekStart) {
  const lastRow = sheet.getLastRow();
  const weekStartCol = headers.indexOf("week_start");
  if (weekStartCol === -1 || lastRow < 2) return null;

  const values = sheet.getRange(2, weekStartCol + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || "") === weekStart) return i + 2;
  }
  return null;
}

/** Every non-blank id currently in Tasks2 — what validateReview_ checks a
 * reviewer's suggested/someday/drop ids against, so a hallucinated or
 * long-dropped id can never sneak into what the review card shows. */
function collectIds_(sheet, headers) {
  const idCol = headers.indexOf("id");
  const lastRow = sheet.getLastRow();
  if (idCol === -1 || lastRow < 2) return [];

  const values = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  const ids = [];
  for (let i = 0; i < values.length; i++) {
    const id = String(values[i][0] || "");
    if (id) ids.push(id);
  }
  return ids;
}

/** The last `n` rows of the Log tab (oldest of the n first), as plain
 * {at, raw_text} objects — what review_export hands a reviewer as "recent
 * captures", so it has a feel for what's been on your mind this week even
 * for stuff that never made it into Tasks2 as-is (e.g. a fallback capture
 * later dropped, or just extra context in a ramble). */
function lastLogRows_(sheet, headers, n) {
  const lastRow = sheet.getLastRow();
  if (!sheet || lastRow < 2) return [];

  const total = lastRow - 1;
  const count = Math.min(n, total);
  const startRow = lastRow - count + 1;
  const atCol = headers.indexOf("at");
  const rawCol = headers.indexOf("raw_text");

  const values = sheet.getRange(startRow, 1, count, headers.length).getValues();
  return values.map(function (row) {
    return {
      at: atCol !== -1 ? String(row[atCol] || "") : "",
      raw_text: rawCol !== -1 ? String(row[rawCol] || "") : "",
    };
  });
}

// --- weekly review — Gemini call (Monday-morning safety net) ---------------

/**
 * Builds the prompt sent to Gemini for the weekly review. Pure (no Apps
 * Script API calls) so it — like buildGeminiPrompt_ — is easy to reason
 * about and could be lifted into a plain-node test the same way that one's
 * tested, even though runTests() doesn't currently check its exact text.
 */
function buildReviewPrompt_(tasks, recentCaptures, weekStart, todayStr) {
  return (
    "You are a kind, practical weekly-review coach for someone with ADHD. " +
    "Today's date is " + todayStr + "; this review covers the week starting " + weekStart + ".\n\n" +
    "Given their tasks and recent captures, write a short warm summary of the past week " +
    "(mention 1-3 concrete wins from completed tasks), pick up to 5 tasks worth doing this " +
    "week (prefer: due soon, quick wins, things touched recently), up to 5 that could rest " +
    "in Someday, up to 3 that look stale or duplicated to drop. Never scold, never mention " +
    "how many tasks are open or overdue. Use only the ids given.\n\n" +
    "Respond with JSON matching the schema: summary (string, at most 3 sentences), " +
    "wins (array of short strings), suggested/someday/drop (arrays of {id, reason}, " +
    "reason is one short phrase).\n\n" +
    "Tasks (JSON):\n" + JSON.stringify(tasks) + "\n\n" +
    "Recent captures (JSON):\n" + JSON.stringify(recentCaptures)
  );
}

/**
 * Calls Gemini to write one weekly review. Same defensive shape as
 * callGemini_ (muteHttpExceptions so a Gemini-side error comes back as
 * readable text, a forced JSON responseSchema so there's no free-form text
 * to guess-parse) — throws a short error on any failure, which
 * weeklyGeminiReview catches and just logs (see that function's comment
 * for why there's no fallback review, unlike capture's fallback task).
 */
function callGeminiForReview_(tasks, recentCaptures, weekStart, todayStr) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) throw new Error("missing_gemini_key");

  const model = PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL") || GEMINI_MODEL_DEFAULT;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
  const prompt = buildReviewPrompt_(tasks, recentCaptures, weekStart, todayStr);

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: REVIEW_RESPONSE_SCHEMA,
      temperature: 0.3,
    },
  };

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": apiKey },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error("gemini_http_" + status + ": " + response.getContentText().slice(0, 200));
  }

  let envelope;
  try {
    envelope = JSON.parse(response.getContentText());
  } catch (err) {
    throw new Error("gemini_bad_json_envelope");
  }

  const text = envelope && envelope.candidates && envelope.candidates[0] &&
    envelope.candidates[0].content && envelope.candidates[0].content.parts &&
    envelope.candidates[0].content.parts[0] && envelope.candidates[0].content.parts[0].text;
  if (!text) throw new Error("gemini_no_text_in_response");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("gemini_bad_json_review");
  }

  return Object.assign({}, parsed, { generated_by: "gemini" });
}

/**
 * Runs automatically Monday mornings (see installTriggers()). If Claude
 * already wrote this week's review (via the owner's own local scheduled
 * task — see tools/weekly-review/), this is a deliberate no-op: Claude is
 * the better writer, and calling Gemini anyway would just waste a call and
 * risk doReviewSave's own Claude-beats-Gemini check silently discarding it.
 * Otherwise, builds the same export the app itself would ask for, asks
 * Gemini to review it, and saves the result with source "gemini" — going
 * through doReviewSave, so it gets exactly the same validateReview_ safety
 * check as any other save.
 *
 * On ANY failure (no API key, Gemini down, a reply that fails validation)
 * this just logs and stops — deliberately no fallback review. Unlike a
 * capture, where losing the raw text would be a real loss, a missing
 * review this week is just... no review this week. Next Monday tries
 * again, and the review card simply doesn't appear until then.
 *
 * You can also run this by hand from the editor (function dropdown →
 * `weeklyGeminiReview` → Run) to see it work without waiting for Monday —
 * see docs/RUNBOOK.md section L.
 */
function weeklyGeminiReview() {
  try {
    const today = todayString_();
    const weekStart = mondayOf_(today);

    const ss = getSpreadsheet_();
    const reviewsSheet = ensureTab_(ss, REVIEWS_SHEET_NAME, REVIEWS_HEADERS);
    const reviewsHeaders = getHeaders_(reviewsSheet);
    const existingRowNum = findReviewRow_(reviewsSheet, reviewsHeaders, weekStart);
    if (existingRowNum) {
      const sourceCol = reviewsHeaders.indexOf("source");
      const existingSource = String(reviewsSheet.getRange(existingRowNum, sourceCol + 1).getValue() || "");
      if (existingSource === "claude") {
        Logger.log("weeklyGeminiReview: a Claude review already exists for week " + weekStart + " — skipping.");
        return;
      }
    }

    const exportResult = doReviewExport({});

    let reviewJson;
    try {
      reviewJson = callGeminiForReview_(exportResult.tasks, exportResult.recent_captures, weekStart, today);
    } catch (err) {
      Logger.log("weeklyGeminiReview: Gemini call failed (" + errorMessage_(err) + ") — no fallback review is written.");
      return;
    }

    const saveResult = doReviewSave({ payload: { week_start: weekStart, source: "gemini", review: reviewJson } });
    if (!saveResult.ok) {
      Logger.log("weeklyGeminiReview: Gemini's review failed validation (" + saveResult.error + ") — not saved.");
      return;
    }
    Logger.log(
      "weeklyGeminiReview: " +
      (saveResult.skipped ? "skipped (" + saveResult.skipped + ")" : "saved a Gemini review") +
      " for week " + weekStart + "."
    );
  } catch (err) {
    Logger.log("weeklyGeminiReview failed: " + errorMessage_(err));
  }
}

// ---------------------------------------------------------------------------
// TRIGGER INSTALLATION (Phase 6/7 — run these by hand, once, from the editor)
// ---------------------------------------------------------------------------

/**
 * Turns on the nightly tidy AND the weekly review. Run once by hand
 * (function dropdown → `installTriggers` → Run) — see docs/RUNBOOK.md
 * sections K and L. Always removes any existing triggers of either kind
 * first, so running this twice by accident can never create a duplicate
 * (which would otherwise mean nightlyTidy, or the Gemini review call,
 * running twice).
 *
 * Apps Script time-based triggers don't fire at an exact minute:
 * `atHour(3)` means "some time in the 3:00–3:15am window", not "at exactly
 * 3:00am". That's normal and nothing to worry about.
 */
function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger("nightlyTidy").timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger("weeklyGeminiReview").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  Logger.log(
    "Installed the nightly tidy trigger (roughly 3:00–3:15am daily) and the " +
    "weekly review trigger (roughly 8:00–8:15am Mondays)."
  );
}

/** Turns the nightly tidy and the weekly review trigger back off. Run by
 * hand (function dropdown → `removeTriggers` → Run) if you ever want to
 * pause either. */
function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    const fn = triggers[i].getHandlerFunction();
    if (fn === "nightlyTidy" || fn === "weeklyGeminiReview") {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log("Removed " + removed + " existing trigger(s) (nightlyTidy/weeklyGeminiReview).");
}

// ---------------------------------------------------------------------------
// PURE VALIDATION / MUTATION FUNCTIONS
// (no sheet access — this is what runTests() exercises directly)
// ---------------------------------------------------------------------------

/**
 * Checks a proposed new task and returns either { ok:true, row: {...} }
 * (a full Tasks2 row, ready to write) or { ok:false, error: "..." }.
 *
 * Only `title` can fail the request outright. Every other field is
 * "best effort": an invalid category, status, date etc. is quietly
 * replaced with a safe default rather than rejecting the whole task — the
 * idea being that losing a scheduling detail is fine, losing the task
 * itself is not.
 */
function validateNewTask_(input, nowIso) {
  if (!input || typeof input !== "object") return { ok: false, error: "missing_task" };

  const id = String(input.id || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const title = String(input.title || "").trim();
  if (!title) return { ok: false, error: "missing_title" };
  if (title.length > 300) return { ok: false, error: "title_too_long" };

  const status = STATUSES.indexOf(input.status) !== -1 ? input.status : "active";
  const category = CATEGORIES.indexOf(input.category) !== -1 ? input.category : "Inbox";

  return {
    ok: true,
    row: {
      id: id,
      title: title,
      notes: input.notes ? String(input.notes) : "",
      category: category,
      est_min: validEstMin_(input.est_min),
      status: status,
      do_date: validDate_(input.do_date) ? input.do_date : "",
      due_date: validDate_(input.due_date) ? input.due_date : "",
      due_time: validTime_(input.due_time) ? input.due_time : "",
      sort: "",
      created_at: nowIso,
      updated_at: nowIso,
      completed_at: status === "done" ? nowIso : "",
      last_touched_at: nowIso,
      calendar_event_id: "",
      source: input.source ? String(input.source) : "typed",
      raw_input: input.raw_input ? String(input.raw_input) : "",
      op_id: "", // filled in by doAdd from the top-level payload
    },
  };
}

/**
 * Given an existing task (as a plain object keyed by header name) and a
 * whitelist-only bag of fields to change, returns either
 * { ok:true, task: updatedTask } or { ok:false, error: "..." }.
 *
 * The only field that can reject the update is `title` going empty — every
 * other field either applies cleanly or is quietly ignored (unknown status
 * values, bad dates, etc. leave the existing value alone rather than
 * corrupting the row).
 */
function applyUpdate_(existingTask, fields, nowIso) {
  const updated = Object.assign({}, existingTask);
  const wasDone = existingTask.status === "done";

  for (let i = 0; i < UPDATABLE_FIELDS.length; i++) {
    const key = UPDATABLE_FIELDS[i];
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const value = fields[key];

    if (key === "title") {
      const title = String(value || "").trim();
      if (!title) return { ok: false, error: "missing_title" };
      if (title.length > 300) return { ok: false, error: "title_too_long" };
      updated.title = title;
    } else if (key === "status") {
      if (STATUSES.indexOf(value) !== -1) updated.status = value;
    } else if (key === "category") {
      if (CATEGORIES.indexOf(value) !== -1) updated.category = value;
    } else if (key === "est_min") {
      updated.est_min = validEstMin_(value);
    } else if (key === "do_date" || key === "due_date") {
      updated[key] = validDate_(value) ? value : "";
    } else if (key === "due_time") {
      updated.due_time = validTime_(value) ? value : "";
    } else if (key === "notes") {
      updated.notes = String(value || "");
    } else if (key === "sort") {
      const n = Number(value);
      updated.sort = (value === "" || isNaN(n)) ? "" : n;
    }
  }

  const isDoneNow = updated.status === "done";
  if (isDoneNow && !wasDone) {
    updated.completed_at = nowIso;
  } else if (!isDoneNow && wasDone) {
    updated.completed_at = "";
  }

  updated.updated_at = nowIso;
  updated.last_touched_at = nowIso;

  return { ok: true, task: updated };
}

/**
 * Maps one legacy row (old id/task/category/subcategory/status/
 * scheduled_day/estimated_min shape) onto a brand new Tasks2 row. Pure —
 * takes the new id and "now" as arguments instead of generating them
 * itself, so a test can check the mapping without touching the clock or
 * Utilities.getUuid().
 */
function migrateLegacyRow_(legacyRow, newId, nowIso) {
  const title = String(legacyRow.task || "").trim() || "(untitled)";
  const category = CATEGORIES.indexOf(legacyRow.category) !== -1 ? legacyRow.category : "Inbox";
  const isDone = String(legacyRow.status || "").toLowerCase() === "done";

  // We don't know WHEN old tasks were finished. If we stamped them "now"
  // they'd all show up as "Done today" on first open, which is misleading —
  // so backdate them past the DONE_VISIBLE_DAYS window instead.
  const backdated = new Date(new Date(nowIso).getTime() - (DONE_VISIBLE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();

  return {
    id: newId,
    title: title,
    notes: legacyRow.subcategory ? String(legacyRow.subcategory) : "",
    category: category,
    est_min: validEstMin_(legacyRow.estimated_min),
    status: isDone ? "done" : "active",
    do_date: "", // old weekday names ("Tuesday") don't map to a real date
    due_date: "",
    due_time: "",
    sort: "",
    created_at: nowIso,
    updated_at: nowIso,
    completed_at: isDone ? backdated : "",
    last_touched_at: nowIso,
    calendar_event_id: "",
    source: "migrated",
    raw_input: legacyRow.id !== undefined ? String(legacyRow.id) : "",
    op_id: "",
  };
}

function validDate_(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function validTime_(s) {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}

/** Returns a clean number, or "" if the input isn't a usable estimate. */
function validEstMin_(v) {
  if (v === undefined || v === null || v === "") return "";
  const n = Number(v);
  if (isNaN(n) || n < 0) return "";
  return n;
}

// --- Gemini capture (Phase 4) — pure helpers ------------------------------
// These two functions are deliberately kept free of any Apps Script-only
// API (no Utilities, no SpreadsheetApp) so they can be copied into a plain
// .mjs file and run under plain `node` — see the verification steps in the
// PR/commit that added this comment for how that's done by hand.

/**
 * Builds the single text prompt sent to Gemini: today's date (so "Friday"
 * or "next week" can be resolved to a real YYYY-MM-DD), and instructions
 * for how to split a ramble into tasks. Pure — given the same raw text and
 * date, it always returns the same prompt, which is what makes it testable
 * without actually calling Gemini.
 */
function buildGeminiPrompt_(raw, todayStr) {
  const parts = String(todayStr).split("-").map(Number);
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekday = weekdayNames[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];

  return (
    "Today's date is " + todayStr + " (" + weekday + "), timezone Europe/London.\n\n" +
    "Split this brain-dump into separate, concrete, actionable tasks (max " + GEMINI_MAX_TASKS + "). " +
    "Keep the person's own words for titles, short (≤80 chars), imperative. " +
    "Put extra detail in notes. Estimate minutes realistically (5–120). " +
    "Resolve relative dates ('Friday', 'next week', 'end of month', 'tomorrow') to YYYY-MM-DD using " +
    "today's date; use due_date for deadlines, do_date only when they say when they'll DO it; leave " +
    "blank when unsure. due_time HH:mm only if a time is given. Category from the list; Inbox if " +
    "unclear. Do not invent tasks; a note or feeling that isn't a task can be dropped.\n\n" +
    "Categories: " + CATEGORIES.join(", ") + "\n\n" +
    "Brain-dump:\n" + raw
  );
}

/**
 * Turns Gemini's raw JSON text reply into a clean array of task-ish objects
 * (title/notes/category/est_min/do_date/due_date/due_time — NOT full Tasks2
 * rows yet, that's doCapture's job). Throws a short error for anything
 * unusable: not JSON, not the shape we asked for, or zero tasks left once
 * blank titles are dropped — doCapture treats any throw here as "Gemini
 * failed" and falls back to saving the whole brain-dump as one task.
 */
function parseGeminiTasks_(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error("gemini_bad_json: " + (err && err.message ? err.message : String(err)));
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
    throw new Error("gemini_bad_shape");
  }

  const tasks = [];
  for (let i = 0; i < parsed.tasks.length && tasks.length < GEMINI_MAX_TASKS; i++) {
    const t = parsed.tasks[i];
    if (!t || typeof t !== "object") continue;

    const title = String(t.title || "").trim().slice(0, 80);
    if (!title) continue; // no usable title — not something we can call a task

    tasks.push({
      title: title,
      notes: t.notes ? String(t.notes) : "",
      category: CATEGORIES.indexOf(t.category) !== -1 ? t.category : "Inbox",
      est_min: clampEstMin_(t.est_min),
      do_date: validDate_(t.do_date) ? t.do_date : "",
      due_date: validDate_(t.due_date) ? t.due_date : "",
      due_time: validTime_(t.due_time) ? t.due_time : "",
    });
  }

  if (tasks.length === 0) throw new Error("gemini_zero_usable_tasks");
  return tasks;
}

/**
 * Like validEstMin_, but also clamps into the 5–120 minute range Gemini was
 * asked for — a blank estimate stays blank (that's "unsure", not "zero"),
 * but a wild number like 5000 gets pulled back into something realistic
 * instead of just being accepted as-is.
 */
function clampEstMin_(v) {
  if (v === undefined || v === null || v === "") return "";
  const n = Number(v);
  if (isNaN(n)) return "";
  return Math.max(5, Math.min(120, Math.round(n)));
}

/**
 * Builds the "Gemini didn't work out" fallback: the WHOLE brain-dump saved
 * as one task, title-only from its first line, so nothing is ever lost —
 * it just needs manual sorting later. Pure (id and nowIso are passed in
 * rather than generated here) so it can be unit-tested directly.
 */
function buildFallbackTask_(raw, id, nowIso) {
  const rawStr = String(raw || "");
  const firstLine = rawStr.split("\n")[0].trim() || rawStr.trim();
  const title = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : (firstLine || "Untitled capture");

  return {
    id: id,
    title: title,
    notes: rawStr,
    category: "Inbox",
    est_min: "",
    status: "inbox",
    do_date: "",
    due_date: "",
    due_time: "",
    sort: "",
    created_at: nowIso,
    updated_at: nowIso,
    completed_at: "",
    last_touched_at: nowIso,
    calendar_event_id: "",
    source: "fallback",
    raw_input: rawStr,
    op_id: "", // filled in by doCapture from the top-level payload
  };
}

// --- Weekly review (Phase 7) — pure helpers ---------------------------------
// Like buildGeminiPrompt_/parseGeminiTasks_ above, these three are kept free
// of any Apps Script-only API (no Utilities, no SpreadsheetApp, no Date
// formatting that depends on the script's timezone) — that's what makes
// them the ones the verification steps for this phase can copy into a
// plain .mjs file and run under plain `node`, and what runTests() checks
// directly.

/**
 * PURE: the Monday (YYYY-MM-DD) of the week containing `dateStr`. This is
 * what "week_start" means everywhere in this app — review_export uses it to
 * label the current week, and doReviewSave/doReviewGet key every review row
 * by it. Works in local calendar terms (no Apps Script timezone API), which
 * is fine here because it's only ever called with a YYYY-MM-DD that's
 * already in the right timezone (todayString_()'s output).
 */
function mondayOf_(dateStr) {
  const parts = String(dateStr).split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day; // days to step back (or forward, for Sunday) to reach Monday
  d.setDate(d.getDate() + diff);

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dd;
}

/**
 * PURE: whether a review with this week_start should still be offered
 * today, or has quietly expired (see REVIEW_FRESH_DAYS' comment for why
 * that's a kindness, not a bug). A missing week_start or today is never
 * "fresh" — there's nothing to compare.
 */
function isReviewFresh_(weekStart, todayStr) {
  if (!weekStart || !todayStr) return false;
  const wsParts = String(weekStart).split("-").map(Number);
  const tParts = String(todayStr).split("-").map(Number);
  if (wsParts.length !== 3 || tParts.length !== 3) return false;

  const ws = new Date(wsParts[0], wsParts[1] - 1, wsParts[2]);
  const t = new Date(tParts[0], tParts[1] - 1, tParts[2]);
  const diffDays = Math.round((t - ws) / 86400000);
  return diffDays <= REVIEW_FRESH_DAYS;
}

/**
 * PURE: the one gate every review (Gemini's or Claude's) has to pass before
 * it can be saved. Only a missing/blank summary rejects the whole review
 * outright — everything else is "best effort", the same philosophy
 * validateNewTask_ uses for a task: an id that isn't in `knownIds` (a
 * hallucinated id, or one for a task that's since been dropped) is quietly
 * dropped from its list rather than failing the save, and every list is
 * clamped to its max length rather than rejected for being too long. This
 * is what makes it safe to trust an LLM's output directly, with no human
 * in the loop before it reaches the sheet.
 *
 * `knownIds` can be a plain array or a Set — either works, since this only
 * ever calls `.has()` on it after normalising.
 */
function validateReview_(review, knownIds) {
  if (!review || typeof review !== "object") return { ok: false, error: "missing_review" };

  const summary = String(review.summary || "").trim();
  if (!summary) return { ok: false, error: "missing_summary" };

  const knownIdSet = knownIds instanceof Set ? knownIds : new Set(Array.isArray(knownIds) ? knownIds : []);

  const wins = (Array.isArray(review.wins) ? review.wins : [])
    .map(function (w) { return String(w || "").trim(); })
    .filter(function (w) { return w.length > 0; })
    .slice(0, REVIEW_MAX_WINS);

  function cleanIdList(list, max) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length && out.length < max; i++) {
      const item = list[i];
      if (!item || typeof item !== "object") continue;
      const id = String(item.id || "").trim();
      if (!id || !knownIdSet.has(id)) continue; // drops an unknown/hallucinated/no-longer-real id
      out.push({ id: id, reason: String(item.reason || "").trim() });
    }
    return out;
  }

  const generatedBy = (review.generated_by === "claude" || review.generated_by === "gemini")
    ? review.generated_by
    : "gemini";

  return {
    ok: true,
    review: {
      summary: summary.slice(0, REVIEW_SUMMARY_MAX_CHARS),
      wins: wins,
      suggested: cleanIdList(review.suggested, REVIEW_MAX_SUGGESTED),
      someday: cleanIdList(review.someday, REVIEW_MAX_SOMEDAY),
      drop: cleanIdList(review.drop, REVIEW_MAX_DROP),
      generated_by: generatedBy,
    },
  };
}

/**
 * True if `isoTimestamp` is within the last `days` days of `nowIso`. Used
 * to decide whether a done task still belongs in the visible list. Bad or
 * missing timestamps count as "no, not recent" rather than throwing.
 */
function isWithinLastNDays_(isoTimestamp, days, nowIso) {
  if (!isoTimestamp) return false;
  const completedMs = new Date(isoTimestamp).getTime();
  if (isNaN(completedMs)) return false;
  const nowMs = new Date(nowIso).getTime();
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  return completedMs >= cutoffMs && completedMs <= nowMs;
}

// ---------------------------------------------------------------------------
// MIGRATION (run by hand from the Apps Script editor)
// ---------------------------------------------------------------------------

/**
 * One-off: copies every row from the legacy tab into Tasks2 with new UUIDs.
 * Refuses to run if Tasks2 already has data rows, so running it twice by
 * accident can't double up your tasks — if you genuinely need to redo it,
 * back up and clear Tasks2 by hand first.
 *
 * Writes every row in ONE setValues() call (much faster than one call per
 * row, and means you never end up with half a migration if something goes
 * wrong partway through a slow per-row loop).
 *
 * NEVER modifies the legacy tab — it reads it, nothing more.
 */
function migrate() {
  const ss = getSpreadsheet_();
  const tasks2 = ensureTabs_(ss);

  if (tasks2.getLastRow() > 1) {
    Logger.log(
      "Tasks2 already has data rows — refusing to migrate again, to avoid " +
      "duplicating tasks. If you really need to redo this, back up Tasks2 " +
      "and clear its data rows by hand first, then run migrate() again."
    );
    return;
  }

  const legacySheet = findLegacySheet_(ss);
  if (!legacySheet) {
    Logger.log("No legacy sheet found (every tab is already Tasks2/Log/Reviews) — nothing to migrate.");
    return;
  }

  const legacyRows = readLegacySheetAsObjects_(legacySheet);
  if (legacyRows.length === 0) {
    Logger.log("Legacy sheet '" + legacySheet.getName() + "' has no data rows — nothing to migrate.");
    return;
  }

  const nowIso = nowIso_();
  const headers = getHeaders_(tasks2);
  const doneCount = legacyRows.filter(function (r) {
    return String(r.status || "").toLowerCase() === "done";
  }).length;

  const newRows = legacyRows.map(function (legacyRow) {
    const migrated = migrateLegacyRow_(legacyRow, Utilities.getUuid(), nowIso);
    return taskToRowValues_(headers, migrated);
  });

  tasks2.getRange(2, 1, newRows.length, headers.length).setValues(newRows);

  Logger.log(
    "Migrated " + newRows.length + " tasks from '" + legacySheet.getName() + "' into Tasks2 " +
    "(" + doneCount + " marked done, " + (newRows.length - doneCount) + " active). " +
    "The legacy tab was not changed."
  );
}

// ---------------------------------------------------------------------------
// AUTH + RATE LIMITING
// ---------------------------------------------------------------------------

// Apps Script has no way for us to see the caller's IP address, so we can't
// do "lock out this one attacker". Instead, once there have been too many
// wrong keys in a row, ALL wrong keys are refused for a cool-down period.
// The correct key keeps working throughout (see checkAuth_ for why).
const LOCKOUT_BAD_TOKEN_LIMIT = 10;
const LOCKOUT_WINDOW_SECONDS = 10 * 60; // 10 minutes
const LOCKOUT_DURATION_SECONDS = 10 * 60; // 10 minutes
const CACHE_KEY_BAD_COUNT = "planner_bad_token_count";
const CACHE_KEY_LOCKED = "planner_locked_until";

/**
 * Checks the token from the request against the Script Property DEVICE_KEY.
 * Returns { ok: true } or { ok: false, error: "..." }.
 *
 * On purpose, the error messages never say whether a key is even configured
 * — "invalid_token" is returned either way — so a stranger poking at the
 * URL can't learn anything about the setup from the response text.
 */
function checkAuth_(token) {
  const cache = CacheService.getScriptCache();

  const deviceKey = PropertiesService.getScriptProperties().getProperty("DEVICE_KEY");

  // No key configured at all means the owner hasn't run setup() yet.
  // Refuse everything rather than silently allowing access.
  const isValid = !!deviceKey && constantTimeEquals_(String(token || ""), deviceKey);

  // The correct key ALWAYS works, even during a lockout. The key is far too
  // long to guess (~240 random bits), so the lockout isn't what keeps
  // strangers out — and if it blocked the real key too, anyone who knew the
  // URL could lock YOU out of your own tasks just by spamming wrong keys.
  if (isValid) {
    return { ok: true };
  }

  // During a lockout, wrong keys get a quick "locked" and nothing else.
  if (cache.get(CACHE_KEY_LOCKED)) {
    return { ok: false, error: "locked" };
  }

  registerBadToken_(cache);
  return { ok: false, error: "invalid_token" };
}

/**
 * Bumps the global "bad token" counter and, if it crosses the limit within
 * the time window, starts a lockout. CacheService counters expire on their
 * own, which is what gives us the "within 10 minutes" behaviour for free.
 */
function registerBadToken_(cache) {
  const countText = cache.get(CACHE_KEY_BAD_COUNT);
  const count = countText ? parseInt(countText, 10) + 1 : 1;

  cache.put(CACHE_KEY_BAD_COUNT, String(count), LOCKOUT_WINDOW_SECONDS);

  if (count >= LOCKOUT_BAD_TOKEN_LIMIT) {
    cache.put(CACHE_KEY_LOCKED, "1", LOCKOUT_DURATION_SECONDS);
    cache.remove(CACHE_KEY_BAD_COUNT);
  }
}

/**
 * Ordinary "===" string comparison can be exploited to guess a secret one
 * character at a time, because it can return slightly faster the moment it
 * finds a mismatched character (a "timing attack"). This version always
 * compares every character no matter where the difference is, which removes
 * that timing signal. It's "constant-time-ish" rather than a formal
 * guarantee — Apps Script doesn't give us low-level timing control — but it
 * is far better than a plain `===` check, and Apps Script's network jitter
 * over the internet already drowns out most timing differences.
 */
function constantTimeEquals_(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// REQUEST PARSING + RESPONSE HELPERS
// ---------------------------------------------------------------------------

/**
 * Apps Script hands us the raw POST body as text; we parse it as JSON
 * ourselves. Any malformed JSON throws here, which doPost's try/catch turns
 * into a clean {ok:false} response instead of a crash.
 */
function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("missing_body");
  }
  const body = JSON.parse(e.postData.contents);
  return {
    token: body.token,
    action: body.action,
    payload: body,
  };
}

/**
 * Wraps a plain object as a Content-Service JSON response. Apps Script Web
 * Apps can't set custom CORS headers, but a plain-text/JSON response to a
 * "simple" cross-origin POST (no custom headers beyond Content-Type) is
 * readable by the browser without needing them — see docs/00-what-we-built-security.md
 * for the one-paragraph version of why that is.
 */
function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function errorMessage_(err) {
  return err && err.message ? err.message : String(err);
}

function nowIso_() {
  return new Date().toISOString();
}

function todayString_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// ---------------------------------------------------------------------------
// SPREADSHEET ACCESS
// ---------------------------------------------------------------------------

/**
 * Finds the spreadsheet we should work against. If a Script Property
 * SHEET_ID is set, we open that spreadsheet by ID (this is what lets a
 * "staging" copy of the sheet work — see docs/RUNBOOK.md section D). If not
 * set, we fall back to the spreadsheet this script is bound to (the normal
 * case for a script created via Extensions > Apps Script from inside a
 * Sheet).
 */
function getSpreadsheet_() {
  const sheetId = PropertiesService.getScriptProperties().getProperty("SHEET_ID");

  if (sheetId) {
    const byId = SpreadsheetApp.openById(sheetId);
    if (byId) return byId;
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  throw new Error(
    "no_spreadsheet: set the SHEET_ID script property, or bind this script to a sheet"
  );
}

/**
 * Makes sure Tasks2/Log/Reviews all exist, creating any that are missing
 * with a frozen header row. Also (re)applies plain-text ("@") number
 * formatting to the whole Tasks2 sheet every time it runs — cheap, and it
 * means Sheets can never quietly turn one of our "2025-01-03" strings into
 * an actual Date object behind our back, which would break every date
 * comparison in the app.
 *
 * Safe to call on every request: if a tab already exists, insertSheet is
 * skipped for it and only the formatting line reapplies.
 */
function ensureTabs_(ss) {
  const tasks2 = ensureTab_(ss, TASKS2_SHEET_NAME, TASKS2_HEADERS);
  tasks2.getRange(1, 1, tasks2.getMaxRows(), tasks2.getMaxColumns()).setNumberFormat("@");

  ensureTab_(ss, LOG_SHEET_NAME, LOG_HEADERS);
  ensureTab_(ss, REVIEWS_SHEET_NAME, REVIEWS_HEADERS);

  return tasks2;
}

function ensureTab_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  // The tab already exists — but a later version of this file can add a
  // new column (e.g. Phase 8 adding `op_id` to the Log tab) that an
  // existing sheet was created without. Rather than a separate one-off
  // migration step, just append any header this version expects but the
  // sheet doesn't have yet, as a new column at the end. Existing rows get
  // a blank cell there (exactly as if that column had always existed and
  // they'd simply never filled it in) — nothing is reordered or removed.
  const lastCol = sheet.getLastColumn();
  const existingHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = headers.filter(function (h) { return existingHeaders.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, existingHeaders.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

/** Reads row 1 of a sheet as a plain array of header names. */
function getHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

/**
 * Builds a fresh id -> sheet row number map by reading the id column top to
 * bottom. Called at the start of every add/update — NEVER cached across
 * requests — because another request (or you, editing the sheet by hand)
 * could have inserted or deleted rows in between.
 */
function buildIdIndex_(sheet, headers) {
  const idCol = headers.indexOf("id");
  const lastRow = sheet.getLastRow();
  const map = {};
  if (lastRow < 2) return map;

  const idValues = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < idValues.length; i++) {
    const id = String(idValues[i][0] || "");
    if (id) map[id] = i + 2; // +2: row 1 is the header, arrays are 0-based
  }
  return map;
}

/**
 * Turns one Tasks2 row (a plain array, in header order) into a task object.
 * Every cell goes through String() except est_min/sort, which become
 * Number (or "" if blank) — this is what guarantees the client always sees
 * consistent types no matter what Sheets thinks a cell "really" is.
 */
function rowToTask_(headers, row) {
  const task = {};
  for (let c = 0; c < headers.length; c++) {
    const key = headers[c];
    const value = row[c];
    if (key === "est_min" || key === "sort") {
      task[key] = (value === "" || value === null || value === undefined) ? "" : Number(value);
    } else {
      task[key] = (value === null || value === undefined) ? "" : String(value);
    }
  }
  return task;
}

/** Same as rowToTask_, but for a whole block of rows at once. */
function rowsToTasks_(headers, rows) {
  return rows.map(function (row) {
    return rowToTask_(headers, row);
  });
}

/**
 * The inverse of rowToTask_: given a task object (keyed by header name) and
 * the sheet's current header order, produces a plain array ready for
 * setValues()/appendRow(). Missing keys become "" rather than throwing, so
 * an old task object that predates a newly-added column still writes fine.
 */
function taskToRowValues_(headers, task) {
  return headers.map(function (h) {
    return task[h] !== undefined && task[h] !== null ? task[h] : "";
  });
}

/**
 * Turns a sheet's rows into an array of plain objects keyed by the header
 * row (row 1). Blank rows (no value in column A) are skipped so leftover
 * empty rows at the bottom of the sheet don't show up as fake tasks.
 *
 * Pulled out as its own function (taking the header + rows as plain arrays,
 * not a live Sheet object) so it can be unit-tested from runTests() without
 * needing a real spreadsheet.
 */
function readLegacySheetAsObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) return [];

  const header = values[0];
  const rows = values.slice(1);
  return rowsToObjects_(header, rows);
}

/**
 * Pure function: given a header row and a list of data rows (both plain
 * arrays, as you'd get from Sheet.getValues()), returns an array of
 * objects. A row counts as blank (and is skipped) when its first cell is
 * empty — that's the `id` column in our legacy sheet.
 */
function rowsToObjects_(header, rows) {
  const objects = [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row[0] === "" || row[0] === null || row[0] === undefined) {
      continue; // blank row — skip it
    }

    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = row[c];
    }
    objects.push(obj);
  }

  return objects;
}

// ---------------------------------------------------------------------------
// ONE-TIME SETUP (run these by hand from the Apps Script editor)
// ---------------------------------------------------------------------------

/**
 * Run this ONCE, by hand, from the Apps Script editor (select "setup" in the
 * function dropdown at the top, then click Run). It creates your device key
 * if you don't already have one.
 *
 * It deliberately does NOT overwrite an existing key — running it again by
 * accident won't lock out devices that already have the old key saved.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty("DEVICE_KEY");

  if (existing) {
    Logger.log(
      "DEVICE_KEY already exists — leaving it alone. " +
        "If you need a new one, run rotateDeviceKey() instead."
    );
    return;
  }

  const key = generateDeviceKey_();
  props.setProperty("DEVICE_KEY", key);

  Logger.log(
    "Generated a new device key. COPY THIS INTO YOUR PASSWORD MANAGER NOW — " +
      "it will not be shown again by this function:\n\n" + key + "\n\n" +
      "You'll paste this into the spike/app page once, on each device you use."
  );
}

/**
 * Deliberately replaces the device key with a brand new one. Use this if a
 * key leaks (e.g. it ends up in a screenshot or a public repo). Every
 * device will need the new key re-entered — see docs/RUNBOOK.md section E.
 */
function rotateDeviceKey() {
  const props = PropertiesService.getScriptProperties();
  const key = generateDeviceKey_();
  props.setProperty("DEVICE_KEY", key);

  Logger.log(
    "Device key ROTATED. Old key no longer works. New key — copy it into " +
      "your password manager and re-enter it on every device:\n\n" + key
  );
}

/**
 * Run this by hand (function dropdown → `test_gemini` → Run) any time you
 * want to check the GEMINI_API_KEY Script Property actually works, without
 * going through the app. Logs the tasks Gemini split a sample ramble into,
 * or the raw error if the call failed — see docs/RUNBOOK.md section I.
 */
function test_gemini() {
  const sampleRaw =
    "need to book the dentist for a check up sometime next week, also must " +
    "pay the electric bill by friday, keep forgetting to call mum back, and " +
    "pick up milk on the way home today";

  Logger.log("Calling Gemini with a sample brain-dump...");
  try {
    const tasks = callGemini_(sampleRaw, todayString_());
    Logger.log("Success — Gemini split it into " + tasks.length + " task(s):");
    Logger.log(JSON.stringify(tasks, null, 2));
  } catch (err) {
    Logger.log("callGemini_ failed. Check GEMINI_API_KEY (and GEMINI_MODEL, if set) " +
      "in Project Settings > Script Properties. Raw error:");
    Logger.log(errorMessage_(err));
  }
}

/**
 * Two UUIDs joined together (dashes removed) gives a 64-character
 * hex-ish string — long and random enough that guessing it is not a
 * realistic attack, without needing any special crypto library.
 */
function generateDeviceKey_() {
  const a = Utilities.getUuid().replace(/-/g, "");
  const b = Utilities.getUuid().replace(/-/g, "");
  return a + b;
}

// ---------------------------------------------------------------------------
// TESTS — run `runTests` by hand from the Apps Script editor.
// These check the pure helper functions only (no real spreadsheet or
// network access needed), and log PASS/FAIL for each check.
// ---------------------------------------------------------------------------

function runTests() {
  const results = [];

  test_constantTimeEquals_matches_(results);
  test_constantTimeEquals_rejectsWrongLength_(results);
  test_constantTimeEquals_rejectsWrongValue_(results);
  test_rowsToObjects_basic_(results);
  test_rowsToObjects_skipsBlankRows_(results);

  test_validateNewTask_happyPath_(results);
  test_validateNewTask_rejectsMissingTitle_(results);
  test_validateNewTask_rejectsMissingId_(results);
  test_validateNewTask_rejectsTooLongTitle_(results);
  test_validateNewTask_defaultsBadCategory_(results);
  test_validateNewTask_defaultsBadStatus_(results);
  test_validateNewTask_blanksBadDate_(results);
  test_validateNewTask_setsCompletedAtWhenDone_(results);

  test_applyUpdate_changesTitle_(results);
  test_applyUpdate_rejectsEmptyTitle_(results);
  test_applyUpdate_ignoresUnknownFields_(results);
  test_applyUpdate_setsCompletedAtOnDone_(results);
  test_applyUpdate_clearsCompletedAtWhenUndone_(results);
  test_applyUpdate_ignoresBadCategory_(results);
  test_applyUpdate_alwaysBumpsUpdatedAt_(results);

  test_migrateLegacyRow_activeTask_(results);
  test_migrateLegacyRow_doneTask_(results);
  test_migrateLegacyRow_unknownCategoryBecomesInbox_(results);

  test_rowToTask_typesEstMinAsNumber_(results);
  test_rowToTask_blankEstMinStaysBlank_(results);
  test_taskToRowValues_matchesHeaderOrder_(results);

  test_isWithinLastNDays_recentIsVisible_(results);
  test_isWithinLastNDays_oldIsHidden_(results);
  test_isWithinLastNDays_blankIsHidden_(results);

  test_filterVisibleTasks_dropsDropped_(results);
  test_filterVisibleTasks_keepsActive_(results);

  test_validDate_acceptsIsoDate_(results);
  test_validDate_rejectsJunk_(results);
  test_validTime_acceptsHhMm_(results);
  test_validEstMin_rejectsNegative_(results);

  test_buildGeminiPrompt_includesTodayAndCategories_(results);
  test_parseGeminiTasks_happyPath_(results);
  test_parseGeminiTasks_rejectsJunk_(results);
  test_parseGeminiTasks_rejectsMissingTasksArray_(results);
  test_parseGeminiTasks_dropsBlankTitles_(results);
  test_parseGeminiTasks_capsAt15_(results);
  test_parseGeminiTasks_zeroUsableTasksThrows_(results);
  test_clampEstMin_clampsIntoRange_(results);
  test_clampEstMin_blankStaysBlank_(results);
  test_buildFallbackTask_usesFirstLineAsTitle_(results);
  test_buildFallbackTask_truncatesLongFirstLine_(results);

  test_desiredEventState_datedActiveIsWanted_(results);
  test_desiredEventState_doneIsNotWanted_(results);
  test_desiredEventState_noDueDateIsNotWanted_(results);
  test_desiredEventState_inboxWithDueDateIsWanted_(results);

  test_planNightlyTidy_rollsBackStaleDoDate_(results);
  test_planNightlyTidy_fadesUntouchedNoDueDate_(results);
  test_planNightlyTidy_keepsTasksWithDueDate_(results);
  test_planNightlyTidy_keepsRecentlyTouched_(results);
  test_planNightlyTidy_fadesUntouchedInbox_(results);
  test_planNightlyTidy_ignoresDoneAndSomeday_(results);

  test_buildDigestText_withTasks_(results);
  test_buildDigestText_empty_(results);
  test_buildDigestText_truncatesOverEight_(results);

  test_mondayOf_onAMonday_(results);
  test_mondayOf_midWeek_(results);
  test_mondayOf_onASunday_(results);

  test_isReviewFresh_withinWindow_(results);
  test_isReviewFresh_exactlyAtWindow_(results);
  test_isReviewFresh_expiredPastWindow_(results);
  test_isReviewFresh_blankWeekStartIsNotFresh_(results);

  test_validateReview_requiresSummary_(results);
  test_validateReview_happyPath_(results);
  test_validateReview_dropsUnknownIds_(results);
  test_validateReview_clampsListLengths_(results);
  test_validateReview_clampsWinsTo3_(results);
  test_validateReview_defaultsGeneratedBy_(results);
  test_validateReview_acceptsArrayOrSetForKnownIds_(results);

  test_parseAssistResult_validMixedResult_(results);
  test_parseAssistResult_dropsUnknownId_(results);
  test_parseAssistResult_junkThrows_(results);
  test_parseAssistResult_dropsInvalidOpName_(results);
  test_parseAssistResult_defaultsBadIntent_(results);
  test_parseAssistResult_capsOpsAtMax_(results);
  test_mapAssistOpToFields_scheduleActivatesInboxTask_(results);
  test_mapAssistOpToFields_scheduleWithoutDateIsSkipped_(results);
  test_mapAssistOpToFields_unrecognisedOpReturnsNull_(results);
  test_selectAssistContextTasks_prioritisesActiveAndDated_(results);
  test_selectAssistContextTasks_returnsAllWhenUnderCap_(results);

  const failed = results.filter(function (r) { return !r.pass; });
  Logger.log(results.map(function (r) {
    return (r.pass ? "PASS: " : "FAIL: ") + r.name;
  }).join("\n"));
  Logger.log(failed.length === 0
    ? "\nAll " + results.length + " tests passed."
    : "\n" + failed.length + " of " + results.length + " tests FAILED.");
}

function assert_(results, name, condition) {
  results.push({ name: name, pass: !!condition });
}

// --- Phase 0 tests (unchanged) ----------------------------------------------

function test_constantTimeEquals_matches_(results) {
  assert_(results, "constantTimeEquals_ matches equal strings",
    constantTimeEquals_("abc123", "abc123") === true);
}

function test_constantTimeEquals_rejectsWrongLength_(results) {
  assert_(results, "constantTimeEquals_ rejects different lengths",
    constantTimeEquals_("abc", "abcd") === false);
}

function test_constantTimeEquals_rejectsWrongValue_(results) {
  assert_(results, "constantTimeEquals_ rejects same length, different value",
    constantTimeEquals_("abc123", "abc124") === false);
}

function test_rowsToObjects_basic_(results) {
  const header = ["id", "task", "category", "subcategory", "status", "scheduled_day", "estimated_min"];
  const rows = [
    ["1", "Book dentist", "Health", "", "Backlog", "Backlog", 15],
  ];
  const objects = rowsToObjects_(header, rows);
  assert_(results, "rowsToObjects_ maps a single row correctly",
    objects.length === 1 &&
    objects[0].id === "1" &&
    objects[0].task === "Book dentist" &&
    objects[0].estimated_min === 15);
}

function test_rowsToObjects_skipsBlankRows_(results) {
  const header = ["id", "task"];
  const rows = [
    ["1", "Real task"],
    ["", ""],
    ["2", "Another real task"],
  ];
  const objects = rowsToObjects_(header, rows);
  assert_(results, "rowsToObjects_ skips rows with a blank id",
    objects.length === 2 && objects[0].id === "1" && objects[1].id === "2");
}

// --- validateNewTask_ ---------------------------------------------------

function test_validateNewTask_happyPath_(results) {
  const result = validateNewTask_({
    id: "abc-1", title: "Book dentist", category: "Health & Personal Care",
    est_min: 15, status: "active", do_date: "2026-01-05",
  }, "2026-01-01T00:00:00.000Z");
  assert_(results, "validateNewTask_ accepts a well-formed task",
    result.ok === true &&
    result.row.title === "Book dentist" &&
    result.row.category === "Health & Personal Care" &&
    result.row.est_min === 15 &&
    result.row.do_date === "2026-01-05");
}

function test_validateNewTask_rejectsMissingTitle_(results) {
  const result = validateNewTask_({ id: "abc-2", title: "   " }, "2026-01-01T00:00:00.000Z");
  assert_(results, "validateNewTask_ rejects a blank title",
    result.ok === false && result.error === "missing_title");
}

function test_validateNewTask_rejectsMissingId_(results) {
  const result = validateNewTask_({ title: "No id given" }, "2026-01-01T00:00:00.000Z");
  assert_(results, "validateNewTask_ rejects a missing id",
    result.ok === false && result.error === "missing_id");
}

function test_validateNewTask_rejectsTooLongTitle_(results) {
  const longTitle = new Array(302).join("x"); // 301 chars
  const result = validateNewTask_({ id: "abc-3", title: longTitle }, "2026-01-01T00:00:00.000Z");
  assert_(results, "validateNewTask_ rejects a title over 300 chars",
    result.ok === false && result.error === "title_too_long");
}

function test_validateNewTask_defaultsBadCategory_(results) {
  const result = validateNewTask_({ id: "abc-4", title: "Something", category: "Not A Real Category" }, "2026-01-01T00:00:00.000Z");
  assert_(results, "validateNewTask_ defaults an unknown category to Inbox",
    result.ok === true && result.row.category === "Inbox");
}

function test_validateNewTask_defaultsBadStatus_(results) {
  const result = validateNewTask_({ id: "abc-5", title: "Something", status: "not_a_status" }, "2026-01-01T00:00:00.000Z");
  assert_(results, "validateNewTask_ defaults an unknown status to active",
    result.ok === true && result.row.status === "active");
}

function test_validateNewTask_blanksBadDate_(results) {
  const result = validateNewTask_({ id: "abc-6", title: "Something", do_date: "next tuesday" }, "2026-01-01T00:00:00.000Z");
  assert_(results, "validateNewTask_ blanks an unparseable date instead of rejecting the task",
    result.ok === true && result.row.do_date === "");
}

function test_validateNewTask_setsCompletedAtWhenDone_(results) {
  const result = validateNewTask_({ id: "abc-7", title: "Already done", status: "done" }, "2026-01-01T00:00:00.000Z");
  assert_(results, "validateNewTask_ sets completed_at when status is done",
    result.ok === true && result.row.completed_at === "2026-01-01T00:00:00.000Z");
}

// --- applyUpdate_ --------------------------------------------------------

function baseTaskForTests_() {
  return {
    id: "t1", title: "Original title", notes: "", category: "Inbox",
    est_min: "", status: "active", do_date: "", due_date: "", due_time: "",
    sort: "", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: "", last_touched_at: "2026-01-01T00:00:00.000Z",
    calendar_event_id: "", source: "typed", raw_input: "", op_id: "",
  };
}

function test_applyUpdate_changesTitle_(results) {
  const result = applyUpdate_(baseTaskForTests_(), { title: "New title" }, "2026-01-02T00:00:00.000Z");
  assert_(results, "applyUpdate_ changes the title",
    result.ok === true && result.task.title === "New title");
}

function test_applyUpdate_rejectsEmptyTitle_(results) {
  const result = applyUpdate_(baseTaskForTests_(), { title: "   " }, "2026-01-02T00:00:00.000Z");
  assert_(results, "applyUpdate_ rejects clearing the title",
    result.ok === false && result.error === "missing_title");
}

function test_applyUpdate_ignoresUnknownFields_(results) {
  const result = applyUpdate_(baseTaskForTests_(), { id: "hacked-id", created_at: "hacked" }, "2026-01-02T00:00:00.000Z");
  assert_(results, "applyUpdate_ ignores fields outside the whitelist",
    result.ok === true && result.task.id === "t1" && result.task.created_at === "2026-01-01T00:00:00.000Z");
}

function test_applyUpdate_setsCompletedAtOnDone_(results) {
  const result = applyUpdate_(baseTaskForTests_(), { status: "done" }, "2026-01-02T00:00:00.000Z");
  assert_(results, "applyUpdate_ sets completed_at when status becomes done",
    result.ok === true && result.task.status === "done" && result.task.completed_at === "2026-01-02T00:00:00.000Z");
}

function test_applyUpdate_clearsCompletedAtWhenUndone_(results) {
  const doneTask = Object.assign(baseTaskForTests_(), { status: "done", completed_at: "2026-01-01T00:00:00.000Z" });
  const result = applyUpdate_(doneTask, { status: "active" }, "2026-01-02T00:00:00.000Z");
  assert_(results, "applyUpdate_ clears completed_at when status leaves done",
    result.ok === true && result.task.completed_at === "");
}

function test_applyUpdate_ignoresBadCategory_(results) {
  const result = applyUpdate_(baseTaskForTests_(), { category: "Not Real" }, "2026-01-02T00:00:00.000Z");
  assert_(results, "applyUpdate_ ignores an unknown category (keeps the old one)",
    result.ok === true && result.task.category === "Inbox");
}

function test_applyUpdate_alwaysBumpsUpdatedAt_(results) {
  const result = applyUpdate_(baseTaskForTests_(), { notes: "a note" }, "2026-01-02T00:00:00.000Z");
  assert_(results, "applyUpdate_ always bumps updated_at and last_touched_at",
    result.ok === true &&
    result.task.updated_at === "2026-01-02T00:00:00.000Z" &&
    result.task.last_touched_at === "2026-01-02T00:00:00.000Z");
}

// --- migrateLegacyRow_ ---------------------------------------------------

function test_migrateLegacyRow_activeTask_(results) {
  const legacy = { id: "TSK-1", task: "Book dentist", category: "Health & Personal Care", subcategory: "Checkup", status: "Backlog", estimated_min: 15 };
  const row = migrateLegacyRow_(legacy, "new-uuid-1", "2026-01-01T00:00:00.000Z");
  assert_(results, "migrateLegacyRow_ maps an active legacy task correctly",
    row.id === "new-uuid-1" && row.title === "Book dentist" && row.status === "active" &&
    row.category === "Health & Personal Care" && row.notes === "Checkup" &&
    row.do_date === "" && row.source === "migrated" && row.raw_input === "TSK-1");
}

function test_migrateLegacyRow_doneTask_(results) {
  const legacy = { id: "TSK-2", task: "Pay bill", category: "Finances & Subscriptions", status: "Done", estimated_min: 5 };
  const row = migrateLegacyRow_(legacy, "new-uuid-2", "2026-01-01T00:00:00.000Z");
  assert_(results, "migrateLegacyRow_ marks a Done legacy task as done, backdated so it is hidden",
    row.status === "done" && row.completed_at === "2025-12-24T00:00:00.000Z");
}

function test_migrateLegacyRow_unknownCategoryBecomesInbox_(results) {
  const legacy = { id: "TSK-3", task: "Mystery task", category: "Some Old Category", status: "Backlog" };
  const row = migrateLegacyRow_(legacy, "new-uuid-3", "2026-01-01T00:00:00.000Z");
  assert_(results, "migrateLegacyRow_ falls back to Inbox for an unrecognised category",
    row.category === "Inbox");
}

// --- row <-> task conversions ---------------------------------------------

function test_rowToTask_typesEstMinAsNumber_(results) {
  const headers = ["id", "title", "est_min", "sort"];
  const task = rowToTask_(headers, ["t1", "Title", 15, 2]);
  assert_(results, "rowToTask_ converts est_min/sort to Number",
    task.est_min === 15 && task.sort === 2 && typeof task.est_min === "number");
}

function test_rowToTask_blankEstMinStaysBlank_(results) {
  const headers = ["id", "title", "est_min"];
  const task = rowToTask_(headers, ["t1", "Title", ""]);
  assert_(results, "rowToTask_ leaves a blank est_min as an empty string, not 0",
    task.est_min === "");
}

function test_taskToRowValues_matchesHeaderOrder_(results) {
  const headers = ["id", "title", "notes"];
  const values = taskToRowValues_(headers, { id: "t1", title: "Title", notes: "" , extra: "ignored" });
  assert_(results, "taskToRowValues_ produces values in header order, ignoring extra keys",
    values.length === 3 && values[0] === "t1" && values[1] === "Title" && values[2] === "");
}

// --- visibility rules ------------------------------------------------------

function test_isWithinLastNDays_recentIsVisible_(results) {
  assert_(results, "isWithinLastNDays_ treats yesterday as within 7 days of today",
    isWithinLastNDays_("2026-01-05T00:00:00.000Z", 7, "2026-01-06T00:00:00.000Z") === true);
}

function test_isWithinLastNDays_oldIsHidden_(results) {
  assert_(results, "isWithinLastNDays_ treats 10 days ago as outside a 7-day window",
    isWithinLastNDays_("2026-01-01T00:00:00.000Z", 7, "2026-01-11T00:00:00.000Z") === false);
}

function test_isWithinLastNDays_blankIsHidden_(results) {
  assert_(results, "isWithinLastNDays_ treats a blank timestamp as not recent",
    isWithinLastNDays_("", 7, "2026-01-11T00:00:00.000Z") === false);
}

function test_filterVisibleTasks_dropsDropped_(results) {
  const tasks = [
    { id: "1", status: "dropped" },
    { id: "2", status: "active" },
  ];
  const visible = filterVisibleTasks_(tasks, "2026-01-01T00:00:00.000Z");
  assert_(results, "filterVisibleTasks_ always excludes dropped tasks",
    visible.length === 1 && visible[0].id === "2");
}

function test_filterVisibleTasks_keepsActive_(results) {
  const tasks = [
    { id: "1", status: "active" },
    { id: "2", status: "someday" },
    { id: "3", status: "inbox" },
  ];
  const visible = filterVisibleTasks_(tasks, "2026-01-01T00:00:00.000Z");
  assert_(results, "filterVisibleTasks_ keeps non-done, non-dropped statuses",
    visible.length === 3);
}

// --- format validators -------------------------------------------------

function test_validDate_acceptsIsoDate_(results) {
  assert_(results, "validDate_ accepts YYYY-MM-DD", validDate_("2026-03-05") === true);
}

function test_validDate_rejectsJunk_(results) {
  assert_(results, "validDate_ rejects a non-date string", validDate_("next friday") === false);
}

function test_validTime_acceptsHhMm_(results) {
  assert_(results, "validTime_ accepts HH:mm", validTime_("09:30") === true);
}

function test_validEstMin_rejectsNegative_(results) {
  assert_(results, "validEstMin_ blanks a negative number", validEstMin_(-5) === "");
}

// --- Gemini capture (Phase 4) ---------------------------------------------

function test_buildGeminiPrompt_includesTodayAndCategories_(results) {
  const prompt = buildGeminiPrompt_("buy milk", "2026-03-05");
  assert_(results, "buildGeminiPrompt_ mentions today's date and the category list",
    prompt.indexOf("2026-03-05") !== -1 && prompt.indexOf("Career & Learning") !== -1);
}

function test_parseGeminiTasks_happyPath_(results) {
  const json = JSON.stringify({ tasks: [
    { title: "Book dentist", category: "Health & Personal Care", est_min: 15, due_date: "2026-03-10" },
  ] });
  const tasks = parseGeminiTasks_(json);
  assert_(results, "parseGeminiTasks_ parses a well-formed response",
    tasks.length === 1 && tasks[0].title === "Book dentist" &&
    tasks[0].category === "Health & Personal Care" && tasks[0].due_date === "2026-03-10");
}

function test_parseGeminiTasks_rejectsJunk_(results) {
  let threw = false;
  try { parseGeminiTasks_("not json at all"); } catch (err) { threw = true; }
  assert_(results, "parseGeminiTasks_ throws on unparseable text", threw === true);
}

function test_parseGeminiTasks_rejectsMissingTasksArray_(results) {
  let threw = false;
  try { parseGeminiTasks_(JSON.stringify({ notTasks: [] })); } catch (err) { threw = true; }
  assert_(results, "parseGeminiTasks_ throws when there's no tasks array", threw === true);
}

function test_parseGeminiTasks_dropsBlankTitles_(results) {
  const json = JSON.stringify({ tasks: [
    { title: "   ", category: "Inbox" },
    { title: "Real task", category: "Inbox" },
  ] });
  const tasks = parseGeminiTasks_(json);
  assert_(results, "parseGeminiTasks_ drops a task with a blank title",
    tasks.length === 1 && tasks[0].title === "Real task");
}

function test_parseGeminiTasks_capsAt15_(results) {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ title: "Task " + i, category: "Inbox" });
  const tasks = parseGeminiTasks_(JSON.stringify({ tasks: many }));
  assert_(results, "parseGeminiTasks_ never returns more than 15 tasks", tasks.length === 15);
}

function test_parseGeminiTasks_zeroUsableTasksThrows_(results) {
  let threw = false;
  try { parseGeminiTasks_(JSON.stringify({ tasks: [{ title: "" }] })); } catch (err) { threw = true; }
  assert_(results, "parseGeminiTasks_ throws when every task has a blank title", threw === true);
}

function test_clampEstMin_clampsIntoRange_(results) {
  assert_(results, "clampEstMin_ clamps a huge estimate down to 120", clampEstMin_(500) === 120);
  assert_(results, "clampEstMin_ clamps a tiny estimate up to 5", clampEstMin_(1) === 5);
}

function test_clampEstMin_blankStaysBlank_(results) {
  assert_(results, "clampEstMin_ leaves a missing estimate blank", clampEstMin_("") === "");
}

function test_buildFallbackTask_usesFirstLineAsTitle_(results) {
  const row = buildFallbackTask_("Call the vet about Rex\nand check his food", "id-1", "2026-01-01T00:00:00.000Z");
  assert_(results, "buildFallbackTask_ uses the first line as the title, keeps the full text in notes",
    row.title === "Call the vet about Rex" &&
    row.notes === "Call the vet about Rex\nand check his food" &&
    row.status === "inbox" && row.category === "Inbox" && row.source === "fallback");
}

function test_buildFallbackTask_truncatesLongFirstLine_(results) {
  const longLine = new Array(101).join("x"); // 100 chars, no newline
  const row = buildFallbackTask_(longLine, "id-2", "2026-01-01T00:00:00.000Z");
  assert_(results, "buildFallbackTask_ truncates an overlong first line to 80 chars + an ellipsis",
    row.title.length === 81 && row.title.slice(-1) === "…");
}

// --- Phase 6: desiredEventState_ -------------------------------------------

function test_desiredEventState_datedActiveIsWanted_(results) {
  const state = desiredEventState_({
    id: "1", status: "active", title: "Renew passport", notes: "Check expiry first",
    due_date: "2026-02-01", due_time: "",
  });
  assert_(results, "desiredEventState_ wants an event for an active task with a due_date",
    state !== null && state.title === "Renew passport" && state.dueDate === "2026-02-01" &&
    state.description.indexOf("Check expiry first") !== -1 &&
    state.description.indexOf("Open: " + APP_URL) !== -1);
}

function test_desiredEventState_doneIsNotWanted_(results) {
  const state = desiredEventState_({
    id: "2", status: "done", title: "Old task", notes: "", due_date: "2026-02-01", due_time: "",
  });
  assert_(results, "desiredEventState_ never wants an event for a done task, even with a due_date",
    state === null);
}

function test_desiredEventState_noDueDateIsNotWanted_(results) {
  const state = desiredEventState_({
    id: "3", status: "active", title: "Someday-ish", notes: "", due_date: "", due_time: "",
  });
  assert_(results, "desiredEventState_ doesn't want an event when there's no due_date",
    state === null);
}

function test_desiredEventState_inboxWithDueDateIsWanted_(results) {
  const state = desiredEventState_({
    id: "4", status: "inbox", title: "Sort this later", notes: "", due_date: "2026-02-01", due_time: "09:00",
  });
  assert_(results, "desiredEventState_ also wants an event for an inbox task with a due_date",
    state !== null && state.dueTime === "09:00");
}

// --- Phase 6: planNightlyTidy_ ----------------------------------------------

function test_planNightlyTidy_rollsBackStaleDoDate_(results) {
  const tasks = [
    { id: "1", status: "active", do_date: "2026-01-01", due_date: "", last_touched_at: "2026-01-04T00:00:00.000Z" },
  ];
  const updates = planNightlyTidy_(tasks, "2026-01-05", "2026-01-05T03:00:00.000Z");
  assert_(results, "planNightlyTidy_ clears a do_date that's already in the past on an unfinished active task",
    updates.length === 1 && updates[0].id === "1" &&
    updates[0].fields.do_date === "" && !("status" in updates[0].fields));
}

function test_planNightlyTidy_fadesUntouchedNoDueDate_(results) {
  const tasks = [
    { id: "2", status: "active", do_date: "", due_date: "", last_touched_at: "2025-12-01T00:00:00.000Z" },
  ];
  const updates = planNightlyTidy_(tasks, "2026-01-05", "2026-01-05T03:00:00.000Z");
  assert_(results, "planNightlyTidy_ fades an active, due-date-less task untouched over 21 days to someday",
    updates.length === 1 && updates[0].fields.status === "someday");
}

function test_planNightlyTidy_keepsTasksWithDueDate_(results) {
  const tasks = [
    { id: "3", status: "active", do_date: "", due_date: "2026-03-01", last_touched_at: "2025-12-01T00:00:00.000Z" },
  ];
  const updates = planNightlyTidy_(tasks, "2026-01-05", "2026-01-05T03:00:00.000Z");
  assert_(results, "planNightlyTidy_ never fades a task that has a due_date, no matter how stale",
    updates.length === 0);
}

function test_planNightlyTidy_keepsRecentlyTouched_(results) {
  const tasks = [
    { id: "4", status: "active", do_date: "", due_date: "", last_touched_at: "2026-01-04T12:00:00.000Z" },
  ];
  const updates = planNightlyTidy_(tasks, "2026-01-05", "2026-01-05T03:00:00.000Z");
  assert_(results, "planNightlyTidy_ leaves a recently-touched task alone",
    updates.length === 0);
}

function test_planNightlyTidy_fadesUntouchedInbox_(results) {
  const tasks = [
    { id: "5", status: "inbox", do_date: "", due_date: "", last_touched_at: "2025-11-01T00:00:00.000Z" },
  ];
  const updates = planNightlyTidy_(tasks, "2026-01-05", "2026-01-05T03:00:00.000Z");
  assert_(results, "planNightlyTidy_ fades a long-untouched inbox capture to someday too",
    updates.length === 1 && updates[0].fields.status === "someday");
}

function test_planNightlyTidy_ignoresDoneAndSomeday_(results) {
  const tasks = [
    { id: "6", status: "done", do_date: "2026-01-01", due_date: "", last_touched_at: "2025-01-01T00:00:00.000Z" },
    { id: "7", status: "someday", do_date: "", due_date: "", last_touched_at: "2025-01-01T00:00:00.000Z" },
  ];
  const updates = planNightlyTidy_(tasks, "2026-01-05", "2026-01-05T03:00:00.000Z");
  assert_(results, "planNightlyTidy_ never touches done or someday tasks",
    updates.length === 0);
}

// --- Phase 6: buildDigestText_ ----------------------------------------------

function test_buildDigestText_withTasks_(results) {
  const tasks = [
    { id: "1", status: "active", title: "Water plants", do_date: "2026-01-05", due_date: "", est_min: 5 },
    { id: "2", status: "active", title: "Pay electric bill", do_date: "", due_date: "2026-01-05", est_min: 20 },
  ];
  const text = buildDigestText_(tasks, "2026-01-05");
  assert_(results, "buildDigestText_ names the count and the shortest task in the title",
    text.title.indexOf("2 things") !== -1 && text.title.indexOf("Water plants") !== -1);
  assert_(results, "buildDigestText_ lists every today task as a bullet, then the Open link",
    text.description.indexOf("• Water plants") !== -1 &&
    text.description.indexOf("• Pay electric bill") !== -1 &&
    text.description.indexOf("Open: " + APP_URL) !== -1);
}

function test_buildDigestText_empty_(results) {
  const text = buildDigestText_([], "2026-01-05");
  assert_(results, "buildDigestText_ gives a clean-slate title when nothing is due or scheduled today",
    text.title === "Today: a clean slate — pick 3 in the app");
  assert_(results, "buildDigestText_ never mentions unscheduled/backlog counts, even with tasks that exist but aren't today's",
    text.description.toLowerCase().indexOf("unscheduled") === -1 &&
    text.description.toLowerCase().indexOf("backlog") === -1);
}

function test_buildDigestText_truncatesOverEight_(results) {
  const tasks = [];
  for (let i = 0; i < 10; i++) {
    tasks.push({ id: String(i), status: "active", title: "Task " + i, do_date: "2026-01-05", due_date: "", est_min: 10 });
  }
  const text = buildDigestText_(tasks, "2026-01-05");
  const bulletLines = text.description.split("\n").filter(function (l) { return l.indexOf("•") === 0; });
  assert_(results, "buildDigestText_ shows at most 8 bullets even when more tasks are due today",
    bulletLines.length === 8);
  assert_(results, "buildDigestText_ adds an '…and more' line when truncating",
    text.description.indexOf("…and more") !== -1);
}

// --- Phase 7: mondayOf_ ------------------------------------------------

function test_mondayOf_onAMonday_(results) {
  assert_(results, "mondayOf_ of a Monday is itself",
    mondayOf_("2026-01-05") === "2026-01-05");
}

function test_mondayOf_midWeek_(results) {
  assert_(results, "mondayOf_ of a Thursday is that week's Monday",
    mondayOf_("2026-01-08") === "2026-01-05");
}

function test_mondayOf_onASunday_(results) {
  assert_(results, "mondayOf_ of a Sunday is the Monday that started that week (not next Monday)",
    mondayOf_("2026-01-11") === "2026-01-05");
}

// --- Phase 7: isReviewFresh_ --------------------------------------------

function test_isReviewFresh_withinWindow_(results) {
  assert_(results, "isReviewFresh_ treats a week_start well within the window as fresh",
    isReviewFresh_("2026-01-05", "2026-01-08") === true);
}

function test_isReviewFresh_exactlyAtWindow_(results) {
  assert_(results, "isReviewFresh_ treats exactly REVIEW_FRESH_DAYS days old as still fresh",
    isReviewFresh_("2026-01-01", "2026-01-11") === true);
}

function test_isReviewFresh_expiredPastWindow_(results) {
  assert_(results, "isReviewFresh_ treats more than REVIEW_FRESH_DAYS days old as expired",
    isReviewFresh_("2026-01-01", "2026-01-12") === false);
}

function test_isReviewFresh_blankWeekStartIsNotFresh_(results) {
  assert_(results, "isReviewFresh_ treats a blank week_start as not fresh",
    isReviewFresh_("", "2026-01-11") === false);
}

// --- Phase 7: validateReview_ -------------------------------------------

function test_validateReview_requiresSummary_(results) {
  const result = validateReview_({ summary: "   " }, ["t1"]);
  assert_(results, "validateReview_ rejects a blank/missing summary",
    result.ok === false && result.error === "missing_summary");
}

function test_validateReview_happyPath_(results) {
  const result = validateReview_({
    summary: "A calm, steady week — you kept on top of the essentials.",
    wins: ["Paid the electric bill", "Booked the dentist"],
    suggested: [{ id: "t1", reason: "due soon" }],
    someday: [{ id: "t2", reason: "not urgent" }],
    drop: [{ id: "t3", reason: "looks like a duplicate" }],
    generated_by: "claude",
  }, ["t1", "t2", "t3"]);
  assert_(results, "validateReview_ accepts a well-formed review as-is",
    result.ok === true &&
    result.review.summary.indexOf("calm, steady week") !== -1 &&
    result.review.wins.length === 2 &&
    result.review.suggested.length === 1 && result.review.suggested[0].id === "t1" &&
    result.review.someday.length === 1 && result.review.someday[0].id === "t2" &&
    result.review.drop.length === 1 && result.review.drop[0].id === "t3" &&
    result.review.generated_by === "claude");
}

function test_validateReview_dropsUnknownIds_(results) {
  const result = validateReview_({
    summary: "A quiet week.",
    suggested: [{ id: "known-1", reason: "due soon" }, { id: "made-up-id", reason: "hallucinated" }],
  }, ["known-1"]);
  assert_(results, "validateReview_ drops an id that isn't in the known task list",
    result.ok === true && result.review.suggested.length === 1 && result.review.suggested[0].id === "known-1");
}

function test_validateReview_clampsListLengths_(results) {
  function many(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ id: "id-" + i, reason: "r" });
    return out;
  }
  const knownIds = [];
  for (let i = 0; i < 10; i++) knownIds.push("id-" + i);

  const result = validateReview_({
    summary: "Plenty going on this week.",
    suggested: many(10),
    someday: many(10),
    drop: many(10),
  }, knownIds);
  assert_(results, "validateReview_ clamps suggested/someday to 5 and drop to 3",
    result.ok === true &&
    result.review.suggested.length === REVIEW_MAX_SUGGESTED &&
    result.review.someday.length === REVIEW_MAX_SOMEDAY &&
    result.review.drop.length === REVIEW_MAX_DROP);
}

function test_validateReview_clampsWinsTo3_(results) {
  const result = validateReview_({ summary: "Good week.", wins: ["a", "b", "c", "d", "e"] }, []);
  assert_(results, "validateReview_ clamps wins to 3",
    result.ok === true && result.review.wins.length === REVIEW_MAX_WINS);
}

function test_validateReview_defaultsGeneratedBy_(results) {
  const result = validateReview_({ summary: "Fine week.", generated_by: "not_a_real_value" }, []);
  assert_(results, "validateReview_ defaults an unrecognised generated_by to gemini",
    result.ok === true && result.review.generated_by === "gemini");
}

function test_validateReview_acceptsArrayOrSetForKnownIds_(results) {
  const viaArray = validateReview_({ summary: "Ok.", suggested: [{ id: "t1", reason: "r" }] }, ["t1"]);
  const viaSet = validateReview_({ summary: "Ok.", suggested: [{ id: "t1", reason: "r" }] }, new Set(["t1"]));
  assert_(results, "validateReview_ works with knownIds passed as a plain array or as a Set",
    viaArray.ok === true && viaArray.review.suggested.length === 1 &&
    viaSet.ok === true && viaSet.review.suggested.length === 1);
}

// --- Phase 8: parseAssistResult_ --------------------------------------------

function test_parseAssistResult_validMixedResult_(results) {
  const knownIds = ["task-1", "task-2"];
  const json = JSON.stringify({
    intent: "mixed",
    reply: "Done — dentist moved to Friday.",
    new_tasks: [{ title: "Buy soap", category: "Shopping & Groceries" }],
    ops: [{ op: "schedule", id: "task-1", do_date: "2026-09-25" }],
  });
  const result = parseAssistResult_(json, knownIds);
  assert_(results, "parseAssistResult_ accepts a valid mixed result (new task + op + reply)",
    result.intent === "mixed" &&
    result.reply === "Done — dentist moved to Friday." &&
    result.new_tasks.length === 1 && result.new_tasks[0].title === "Buy soap" &&
    result.ops.length === 1 && result.ops[0].op === "schedule" &&
    result.ops[0].id === "task-1" && result.ops[0].do_date === "2026-09-25");
}

function test_parseAssistResult_dropsUnknownId_(results) {
  const json = JSON.stringify({
    intent: "command",
    reply: "",
    new_tasks: [],
    ops: [
      { op: "complete", id: "known-1" },
      { op: "complete", id: "never-shown-to-gemini" },
    ],
  });
  const result = parseAssistResult_(json, ["known-1"]);
  assert_(results, "parseAssistResult_ drops an op whose id was never shown to Gemini, keeps a known one",
    result.ops.length === 1 && result.ops[0].id === "known-1");
}

function test_parseAssistResult_junkThrows_(results) {
  let threw = false;
  try {
    parseAssistResult_("not json at all", ["task-1"]);
  } catch (err) {
    threw = true;
  }
  assert_(results, "parseAssistResult_ throws on text that isn't parsable JSON", threw === true);

  let threwOnArray = false;
  try {
    parseAssistResult_("[1, 2, 3]", ["task-1"]);
  } catch (err) {
    threwOnArray = true;
  }
  assert_(results, "parseAssistResult_ throws on valid JSON that isn't an object", threwOnArray === true);
}

function test_parseAssistResult_dropsInvalidOpName_(results) {
  const json = JSON.stringify({
    intent: "command",
    reply: "",
    new_tasks: [],
    ops: [{ op: "delete_forever", id: "task-1" }],
  });
  const result = parseAssistResult_(json, ["task-1"]);
  assert_(results, "parseAssistResult_ drops an op with an unrecognised op name",
    result.ops.length === 0);
}

function test_parseAssistResult_defaultsBadIntent_(results) {
  const json = JSON.stringify({ intent: "sing_a_song", reply: "", new_tasks: [], ops: [] });
  const result = parseAssistResult_(json, []);
  assert_(results, "parseAssistResult_ defaults an unrecognised intent to capture",
    result.intent === "capture");
}

function test_parseAssistResult_capsOpsAtMax_(results) {
  const knownIds = [];
  const ops = [];
  for (let i = 0; i < ASSIST_MAX_OPS + 5; i++) {
    knownIds.push("id-" + i);
    ops.push({ op: "complete", id: "id-" + i });
  }
  const json = JSON.stringify({ intent: "command", reply: "", new_tasks: [], ops: ops });
  const result = parseAssistResult_(json, knownIds);
  assert_(results, "parseAssistResult_ never returns more than ASSIST_MAX_OPS ops",
    result.ops.length === ASSIST_MAX_OPS);
}

// --- Phase 8: mapAssistOpToFields_ ------------------------------------------

function test_mapAssistOpToFields_scheduleActivatesInboxTask_(results) {
  const fields = mapAssistOpToFields_({ op: "schedule", do_date: "2026-09-25" }, { status: "inbox" });
  assert_(results, "mapAssistOpToFields_ schedule sets do_date and bumps an inbox task to active",
    fields && fields.do_date === "2026-09-25" && fields.status === "active");
}

function test_mapAssistOpToFields_scheduleWithoutDateIsSkipped_(results) {
  const fields = mapAssistOpToFields_({ op: "schedule" }, { status: "active" });
  assert_(results, "mapAssistOpToFields_ drops a schedule op with no date to schedule to",
    fields === null);
}

function test_mapAssistOpToFields_unrecognisedOpReturnsNull_(results) {
  const fields = mapAssistOpToFields_({ op: "teleport" }, { status: "active" });
  assert_(results, "mapAssistOpToFields_ returns null for an op name it doesn't recognise",
    fields === null);
}

// --- Phase 8: selectAssistContextTasks_ -------------------------------------

function test_selectAssistContextTasks_prioritisesActiveAndDated_(results) {
  const tasks = [
    { id: "1", status: "someday" },
    { id: "2", status: "active" },
    { id: "3", status: "done", due_date: "2026-09-25" },
  ];
  const picked = selectAssistContextTasks_(tasks, 2);
  const ids = picked.map(function (t) { return t.id; });
  assert_(results, "selectAssistContextTasks_ keeps active/inbox/due-dated tasks over others when trimming",
    picked.length === 2 && ids.indexOf("1") === -1);
}

function test_selectAssistContextTasks_returnsAllWhenUnderCap_(results) {
  const tasks = [{ id: "1", status: "active" }, { id: "2", status: "someday" }];
  const picked = selectAssistContextTasks_(tasks, 10);
  assert_(results, "selectAssistContextTasks_ returns every task unchanged when there's room for all of them",
    picked.length === 2);
}
