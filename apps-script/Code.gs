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
 */

// Bump this whenever you deploy a meaningfully different version. `ping`
// returns it, so the phone/browser can show you which code it's talking to.
const CODE_VERSION = "0.2.0";

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
const LOG_HEADERS = ["at", "source", "raw_text", "result"];
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

    return { ok: true, task: rowToTask_(headers, values) };
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

    return { ok: true, task: rowToTask_(headers, newValues) };
  } finally {
    lock.releaseLock();
  }
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
