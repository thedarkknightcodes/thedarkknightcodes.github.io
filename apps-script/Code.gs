/**
 * Task Planner — backend (Google Apps Script)
 *
 * WHY THIS FILE EXISTS
 * The old version of this script had no password check at all — anyone who
 * found the URL (and it was sitting in a public GitHub repo) could read or
 * change every task. This version adds a "device key" check, and a few
 * defensive habits explained inline as we go.
 *
 * PHASE 0 SCOPE: this only adds `ping` and `list` (read-only). Writing new
 * data comes in a later phase. `list` reads the OLD sheet tab so you can
 * confirm the connection works with real data before anything is migrated.
 */

// Bump this whenever you deploy a meaningfully different version. `ping`
// returns it, so the phone/browser can show you which code it's talking to.
const CODE_VERSION = "0.1.0";

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
// ACTIONS
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
 * Reads the existing (legacy) task list from the first sheet tab, using row
 * A as the header. This is read-only and does not touch the sheet at all —
 * it exists so we can prove the connection works against real data before
 * building the new data model in a later phase.
 */
function doList(request) {
  const sheet = getSpreadsheet_().getSheets()[0];
  const tasks = readLegacySheetAsObjects_(sheet);
  return { ok: true, tasks: tasks };
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
