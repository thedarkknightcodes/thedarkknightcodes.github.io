/**
 * logic.js — PURE functions only. No DOM, no fetch, no localStorage.
 *
 * WHY THIS FILE IS KEPT SEPARATE
 * Everything in here can be tested by just calling a function and checking
 * what comes back (see test/logic.test.mjs, which runs with plain `node`,
 * no browser needed). That matters most for the two trickiest bits of this
 * app — "what goes in Today" and "what should Pick 3 suggest" — because
 * those are exactly the kind of logic that's easy to get subtly wrong, and
 * a fast test that runs in a second is how you catch that.
 */

// The 10 categories, copied from apps-script/Code.gs. Kept in sync by hand
// (both files are small and this rarely changes) rather than fetched at
// runtime, so the category picker still works the moment the page loads.
export const CATEGORIES = [
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

export const STATUSES = ["inbox", "active", "someday", "done", "dropped"];

// --- id generation -----------------------------------------------------
// A client-made id is what makes retries safe: if "add" is sent twice with
// the same id (e.g. a flaky connection made the client retry), the server
// just finds the existing row instead of creating a duplicate task.

export function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older browsers/runtimes without crypto.randomUUID. Good
  // enough for a client-side id — it never needs to be cryptographically
  // unguessable, just unique.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// --- date helpers --------------------------------------------------------
// Dates are plain "YYYY-MM-DD" strings everywhere in this app (matching the
// backend). We always work in the browser's LOCAL time when turning a Date
// into one of these strings — using UTC would show "tomorrow" as still
// "today" for part of the evening, which is exactly the kind of small
// wrongness that erodes trust in a task list.

export function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

export function todayStr(now) {
  return isoDate(now || new Date());
}

export function addDays(dateStr, n) {
  const parts = String(dateStr).split("-").map(Number);
  // Noon, not midnight — sidesteps daylight-saving clock changes nudging
  // the date backward or forward by one when we add/subtract days.
  const dt = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  dt.setDate(dt.getDate() + n);
  return isoDate(dt);
}

function daysBetween(aStr, bStr) {
  const a = String(aStr).split("-").map(Number);
  const b = String(bStr).split("-").map(Number);
  const da = new Date(a[0], a[1] - 1, a[2], 12, 0, 0);
  const db = new Date(b[0], b[1] - 1, b[2], 12, 0, 0);
  return Math.round((db - da) / 86400000);
}

function dateOnly(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

// --- capture ---------------------------------------------------------------

/**
 * LEGACY / OFFLINE FALLBACK — not used by the main capture flow any more.
 *
 * This was the whole of Phase 2 capture: no AI sorting, just "each line is
 * a task" — plain and predictable. Phase 4 replaced the main flow with a
 * `capture` call to the backend, which asks Gemini to split a ramble into
 * tasks itself (see app.js's handleCapture). This function is kept around
 * (with its tests) as a simple, dependency-free splitter that still works
 * with no network at all — nothing currently calls it, but it's a natural
 * fit if a fully-offline capture mode is ever added later.
 */
export function captureText(raw, opts) {
  opts = opts || {};
  const today = opts.today || todayStr();
  const todayOn = opts.todayOn !== false;
  const now = opts.now || new Date().toISOString();
  const makeId = opts.makeId || randomId;

  const lines = String(raw || "")
    .split("\n")
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length > 0; });

  return lines.map(function (line) {
    return {
      id: makeId(),
      title: line,
      notes: "",
      category: "Inbox",
      est_min: null,
      status: "active",
      do_date: todayOn ? today : "",
      due_date: "",
      due_time: "",
      source: "typed",
      created_at: now,
      updated_at: now,
      completed_at: "",
    };
  });
}

// --- Today screen grouping --------------------------------------------------

/**
 * Splits tasks into the three buckets the Today screen shows: things
 * scheduled for today, things merely due today (not otherwise scheduled),
 * and things already finished today (which collapse into one line).
 */
export function splitTodayTasks(tasks, today) {
  const scheduled = tasks
    .filter(function (t) { return t.status === "active" && t.do_date === today; })
    .sort(sortByDoDateThenCreated);

  const dueToday = tasks
    .filter(function (t) {
      return t.status === "active" && t.due_date === today && t.do_date !== today;
    })
    .sort(sortByCreated);

  const doneToday = tasks
    .filter(function (t) { return t.status === "done" && dateOnly(t.completed_at) === today; })
    .sort(sortByCreated);

  return { scheduled: scheduled, dueToday: dueToday, doneToday: doneToday };
}

function sortByCreated(a, b) {
  return String(a.created_at || "").localeCompare(String(b.created_at || ""));
}

function sortByDoDateThenCreated(a, b) {
  if (a.do_date !== b.do_date) return String(a.do_date).localeCompare(String(b.do_date));
  return sortByCreated(a, b);
}

// --- "Pick 3 for me" ---------------------------------------------------------

/**
 * Decides whether the Pick 3 card should show at all. Three independent
 * triggers, any one is enough: Today is empty, it's the first time the app
 * has been opened today, or there's no record of ever opening it before.
 * (Whether to use the gentler "welcome back" copy is a separate question —
 * see isWelcomeBack — so a first-open-of-the-day after just one day away
 * still gets a card, just not the welcome-back wording.)
 */
export function shouldShowPickThree(opts) {
  const todayTaskCount = opts.todayTaskCount;
  const lastOpenStr = opts.lastOpenStr;
  const today = opts.today;
  if (todayTaskCount === 0) return true;
  if (!lastOpenStr) return true;
  return lastOpenStr !== today;
}

/**
 * Whether to use the "welcome back, no catching up needed" copy instead of
 * the plain Pick 3 copy — only once it's been a genuine break (3+ days).
 */
export function isWelcomeBack(opts) {
  const lastOpenStr = opts.lastOpenStr;
  const today = opts.today;
  if (!lastOpenStr) return false;
  return daysBetween(lastOpenStr, today) >= 3;
}

function shuffle(list, rng) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

/**
 * Suggests up to three tasks to put on today, in priority order:
 *   1. whatever's due soonest, within the next week
 *   2. one "quick win" (15 minutes or less) — an easy place to start
 *   3. fill remaining slots from unscheduled active tasks, preferring a
 *      category not already picked, so the three suggestions aren't all
 *      the same kind of task
 * `rng` defaults to Math.random but can be swapped for a seeded function in
 * tests so the result is reproducible.
 */
export function pickThree(tasks, today, rng) {
  rng = rng || Math.random;
  const active = tasks.filter(function (t) { return t.status === "active"; });
  const picks = [];
  const usedIds = new Set();
  const usedCategories = new Set();

  function take(task, reason) {
    picks.push({ task: task, reason: reason });
    usedIds.add(task.id);
    if (task.category) usedCategories.add(task.category);
  }

  const weekOut = addDays(today, 7);
  const dueSoon = active
    .filter(function (t) { return t.due_date && t.due_date >= today && t.due_date <= weekOut; })
    .sort(function (a, b) { return String(a.due_date).localeCompare(String(b.due_date)); });
  if (dueSoon.length) take(dueSoon[0], "due soon");

  if (picks.length < 3) {
    const quickWins = active.filter(function (t) {
      return !usedIds.has(t.id) && typeof t.est_min === "number" && t.est_min > 0 && t.est_min <= 15;
    });
    if (quickWins.length) {
      take(quickWins[Math.floor(rng() * quickWins.length)], "quick win");
    }
  }

  if (picks.length < 3) {
    const pool = active.filter(function (t) { return !usedIds.has(t.id) && !t.do_date; });
    const fresh = pool.filter(function (t) { return !usedCategories.has(t.category); });
    const rest = pool.filter(function (t) { return usedCategories.has(t.category); });
    const ordered = shuffle(fresh, rng).concat(shuffle(rest, rng));
    for (let i = 0; i < ordered.length && picks.length < 3; i++) {
      take(ordered[i], "open a category");
    }
  }

  return picks.slice(0, 3);
}

// --- Week screen -------------------------------------------------------------

export function weekDates(today, days) {
  days = days || 7;
  const out = [];
  for (let i = 0; i < days; i++) out.push(addDays(today, i));
  return out;
}

export function unscheduledActiveTasks(tasks) {
  return tasks.filter(function (t) { return t.status === "active" && !t.do_date; });
}

/**
 * Tasks captured but not yet sorted (status "inbox") — the fallback path
 * lands here when the AI couldn't split a ramble, and the person hasn't
 * gone through and re-categorised it yet. Sorted oldest-first, same as the
 * other lists, so the earliest capture doesn't get buried under new ones.
 */
export function inboxTasks(tasks) {
  return tasks
    .filter(function (t) { return t.status === "inbox"; })
    .sort(function (a, b) { return String(a.created_at || "").localeCompare(String(b.created_at || "")); });
}

export function filterTasksByText(tasks, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter(function (t) {
    return (
      (t.title || "").toLowerCase().indexOf(q) !== -1 ||
      (t.notes || "").toLowerCase().indexOf(q) !== -1 ||
      (t.category || "").toLowerCase().indexOf(q) !== -1
    );
  });
}

/**
 * Groups tasks by category, in the fixed CATEGORIES order, dropping any
 * category with nothing in it (an empty "Household & Chores" heading with
 * nothing under it is just visual noise).
 */
export function groupByCategory(tasks) {
  const map = new Map();
  for (const cat of CATEGORIES) map.set(cat, []);
  for (const t of tasks) {
    const cat = CATEGORIES.indexOf(t.category) !== -1 ? t.category : "Inbox";
    map.get(cat).push(t);
  }
  return Array.from(map.entries()).filter(function (entry) { return entry[1].length > 0; });
}
