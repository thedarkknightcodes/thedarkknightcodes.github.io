/**
 * api.js — everything about talking to the server (or, in mock mode, a
 * fake stand-in for it).
 *
 * The `api()` function and the fetch options below are lifted almost
 * unchanged from spike.js (Phase 0) — see the comments there for why this
 * shape (text/plain body, no no-cors, following redirects) matters. What's
 * new here is `?mock=1`: a fully in-memory fake backend so the UI can be
 * built and tested without a real Apps Script deployment or device key.
 */

import { todayStr, addDays } from "./logic.js";

const DEVICE_KEY_STORAGE_KEY = "planner.deviceKey";
const API_MODE_STORAGE_KEY = "planner.api";
const PLACEHOLDER_URL = "PASTE_PROD_EXEC_URL_HERE";

// --- error types -------------------------------------------------------
// Three different "something went wrong" shapes, so callers can react
// differently: a config mistake, a network problem (worth retrying), or
// the server deliberately saying no (usually not worth retrying blindly).

export function ConfigError(message) {
  this.name = "ConfigError";
  this.message = message;
}
ConfigError.prototype = Object.create(Error.prototype);

export function NetworkError(message) {
  this.name = "NetworkError";
  this.message = message;
}
NetworkError.prototype = Object.create(Error.prototype);

export function ApiError(code) {
  this.name = "ApiError";
  this.code = code;
  this.message = "Server said: " + code;
}
ApiError.prototype = Object.create(Error.prototype);

// --- device key storage --------------------------------------------------
// Wrapped in try/catch everywhere: private browsing, locked-down browsers,
// or a full storage quota can make localStorage throw instead of quietly
// failing, and a settings screen breaking the whole app is worse than a
// key that doesn't save.

export function loadDeviceKey() {
  try {
    return localStorage.getItem(DEVICE_KEY_STORAGE_KEY) || "";
  } catch (err) {
    return "";
  }
}

export function saveDeviceKey(key) {
  try {
    localStorage.setItem(DEVICE_KEY_STORAGE_KEY, key);
    return true;
  } catch (err) {
    return false;
  }
}

export function forgetDeviceKey() {
  try {
    localStorage.removeItem(DEVICE_KEY_STORAGE_KEY);
  } catch (err) {
    // Nothing more we can do — worst case the key stays in storage.
  }
}

function loadApiModePreference() {
  try {
    return localStorage.getItem(API_MODE_STORAGE_KEY) || "";
  } catch (err) {
    return "";
  }
}

function pickApiUrl() {
  const config = (typeof window !== "undefined" && window.PLANNER_CONFIG) || {};
  const params = new URLSearchParams(window.location.search);
  const queryMode = params.get("api");
  const mode = queryMode || loadApiModePreference();
  if (mode === "staging") {
    return { url: config.stagingUrl || "", mode: "staging" };
  }
  return { url: config.prodUrl || "", mode: "prod" };
}

// --- mock mode switch --------------------------------------------------

export function isMockMode() {
  try {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  } catch (err) {
    return false;
  }
}

/** `?mock=1&fallback=1` forces every mock capture down the fallback path
 * (one task, straight into the Inbox) — the easiest way to see and test
 * that side of the flow without having to break anything for real. */
function isMockFallbackForced() {
  try {
    return new URLSearchParams(window.location.search).get("fallback") === "1";
  } catch (err) {
    return false;
  }
}

/** `?mock=1&review=1` seeds a sample weekly review (as if Claude had
 * already written one), so the review card can be seen and clicked through
 * without a real backend or waiting for Monday. Without it, review_get
 * just returns null, same as "no review yet" on a real server. */
function isMockReviewSeeded() {
  try {
    return new URLSearchParams(window.location.search).get("review") === "1";
  } catch (err) {
    return false;
  }
}

// --- the real network call ------------------------------------------------

async function realCall(action, payload) {
  const target = pickApiUrl();
  if (!target.url || target.url === PLACEHOLDER_URL) {
    throw new ConfigError(
      "config.js not filled in yet — paste your Apps Script /exec URL into " +
      (target.mode === "staging" ? "stagingUrl" : "prodUrl") + "."
    );
  }

  const token = loadDeviceKey();
  const body = Object.assign({ token: token, action: action }, payload || {});

  let response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow",
      mode: "cors",
    });
  } catch (err) {
    throw new NetworkError("Couldn't reach the server (offline, or the script crashed).");
  }

  try {
    return await response.json();
  } catch (err) {
    throw new NetworkError("Server responded, but not with valid JSON.");
  }
}

// --- the mock backend --------------------------------------------------
// A believable-looking set of seeded tasks so every screen has something
// to show: a couple of things due soon, a couple already on today, a
// finished-today task, some parked in Someday, and a handful unscheduled
// across different categories. Lives only in memory — a page reload gets a
// fresh copy.

let mockTasks = null;

function seedMockTasks() {
  const today = todayStr();
  const now = new Date().toISOString();
  const doneAt = today + "T08:15:00.000Z";
  function row(fields) {
    return Object.assign({
      notes: "", est_min: null, do_date: "", due_date: "", due_time: "",
      sort: "", created_at: now, updated_at: now, completed_at: "",
      calendar_event_id: "", source: "seed", raw_input: "", op_id: "",
    }, fields);
  }
  return [
    row({ id: "seed-1", title: "Renew car insurance", category: "Finances & Subscriptions", status: "active", due_date: addDays(today, 2), due_time: "17:00", est_min: 20 }),
    row({ id: "seed-2", title: "Book dentist check-up", category: "Health & Personal Care", status: "active", due_date: addDays(today, 5), est_min: 10 }),
    row({ id: "seed-3", title: "Plan a weekend trip to the coast", category: "Holidays & Travel", status: "someday" }),
    row({ id: "seed-4", title: "Learn a few basic Spanish phrases", category: "Career & Learning", status: "someday" }),
    row({ id: "seed-5", title: "Sort through old photo albums", category: "Admin & Organization", status: "someday" }),
    row({ id: "seed-6", title: "Morning stretch routine", category: "Health & Personal Care", status: "done", do_date: today, completed_at: doneAt }),
    row({ id: "seed-7", title: "Water the plants", category: "Household & Chores", status: "active", do_date: today, est_min: 5 }),
    row({ id: "seed-8", title: "Reply to Sam about the weekend", category: "Relationship & Family", status: "active", do_date: today, est_min: 10 }),
    row({ id: "seed-9", title: "Buy a birthday present for Mum", category: "Shopping & Groceries", status: "active", est_min: 15 }),
    row({ id: "seed-10", title: "Read a chapter of that design book", category: "Leisure & Pending Experiences", status: "active", est_min: 25 }),
    row({ id: "seed-11", title: "File this month's expense receipts", category: "Finances & Subscriptions", status: "active", est_min: 10 }),
    row({ id: "seed-12", title: "Tidy the garage shelf", category: "Household & Chores", status: "active", est_min: 45 }),
    row({ id: "seed-13", title: "Update CV with the new project", category: "Career & Learning", status: "active", est_min: 30 }),
    row({ id: "seed-14", title: "Something to sort into a proper category later", category: "Inbox", status: "active" }),
  ];
}

function ensureMockSeed() {
  if (!mockTasks) mockTasks = seedMockTasks();
  return mockTasks;
}

function cloneTask(t) {
  return Object.assign({}, t);
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function mockAdd(tasks, payload) {
  const input = (payload && payload.task) || {};
  const id = String(input.id || "");
  if (!id) return { ok: false, error: "missing_id" };
  const title = String(input.title || "").trim();
  if (!title) return { ok: false, error: "missing_title" };

  const existing = tasks.find(function (t) { return t.id === id; });
  if (existing) return { ok: true, task: cloneTask(existing), duplicate: true };

  const now = new Date().toISOString();
  const row = {
    id: id,
    title: title,
    notes: String(input.notes || ""),
    category: input.category || "Inbox",
    est_min: input.est_min || null,
    status: input.status || "active",
    do_date: input.do_date || "",
    due_date: input.due_date || "",
    due_time: input.due_time || "",
    sort: "",
    created_at: now,
    updated_at: now,
    completed_at: input.status === "done" ? now : "",
    calendar_event_id: "",
    source: input.source || "typed",
    raw_input: "",
    op_id: String(payload.op_id || ""),
  };
  tasks.push(row);
  return { ok: true, task: cloneTask(row) };
}

function mockUpdate(tasks, payload) {
  const id = String((payload && payload.id) || "");
  const fields = (payload && payload.fields && typeof payload.fields === "object") ? payload.fields : {};
  if (!id) return { ok: false, error: "missing_id" };

  const task = tasks.find(function (t) { return t.id === id; });
  if (!task) return { ok: false, error: "not_found" };

  if ("title" in fields) {
    const t = String(fields.title || "").trim();
    if (!t) return { ok: false, error: "empty_title" };
    task.title = t;
  }
  const wasDone = task.status === "done";
  const editable = ["notes", "category", "est_min", "status", "do_date", "due_date", "due_time", "sort"];
  for (const key of editable) {
    if (key in fields) task[key] = fields[key];
  }
  const now = new Date().toISOString();
  if (task.status === "done" && !wasDone) task.completed_at = now;
  if (task.status !== "done") task.completed_at = "";
  task.updated_at = now;

  return { ok: true, task: cloneTask(task) };
}

// --- fake weekly review (mock review_get/apply/dismiss) -----------------
// A believable sample review, referencing a few of seedMockTasks()'s own
// ids, so "Apply ticked" has something real to act on and titles actually
// resolve. `undefined` means "not decided yet" (seed on first ask, once);
// `null` means "no review" — either never seeded, or already applied/
// dismissed this session.

let mockReview; // undefined until ensureMockReview()'s first call

function mondayOfMock_(dateStr) {
  const parts = String(dateStr).split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return isoDate_(d);
}

function isoDate_(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dd;
}

function seedMockReview() {
  const today = todayStr();
  return {
    week_start: mondayOfMock_(today),
    source: "claude",
    created_at: new Date().toISOString(),
    summary: "A steady week — you kept on top of the small stuff without letting it pile up. Nice and calm.",
    wins: ["Kept up the morning stretch routine", "Replied to Sam about the weekend"],
    suggested: [
      { id: "seed-9", reason: "a gift takes some planning — worth getting ahead of it" },
      { id: "seed-11", reason: "a quick 10-minute tidy" },
    ],
    someday: [
      { id: "seed-3", reason: "no rush — a nice one to dream about later" },
      { id: "seed-4", reason: "whenever you feel like it, not urgent" },
    ],
    drop: [
      { id: "seed-14", reason: "sat unsorted a while — might not matter any more" },
    ],
    generated_by: "claude",
  };
}

function ensureMockReview() {
  if (mockReview === undefined) {
    mockReview = isMockReviewSeeded() ? seedMockReview() : null;
  }
  return mockReview;
}

function mockReviewApply(tasks, payload) {
  const accept = (payload && payload.accept && typeof payload.accept === "object") ? payload.accept : {};
  const today = todayStr();
  const now = new Date().toISOString();
  const updated = [];

  function applyOne(id, fields) {
    const task = tasks.find(function (t) { return t.id === id; });
    if (!task) return;
    Object.assign(task, fields, { updated_at: now });
    if (task.status === "done") task.completed_at = task.completed_at || now;
    if (task.status !== "done") task.completed_at = "";
    updated.push(cloneTask(task));
  }

  const suggestedIds = Array.isArray(accept.suggested) ? accept.suggested : [];
  const somedayIds = Array.isArray(accept.someday) ? accept.someday : [];
  const dropIds = Array.isArray(accept.drop) ? accept.drop : [];
  for (const id of suggestedIds) applyOne(id, { status: "active", do_date: today });
  for (const id of somedayIds) applyOne(id, { status: "someday", do_date: "" });
  for (const id of dropIds) applyOne(id, { status: "dropped" });

  mockReview = null;
  return { ok: true, tasks: updated };
}

// --- fake brain-dump splitter (mock capture) --------------------------
// A rough stand-in for what Gemini does server-side: cut the ramble into
// pieces on the obvious separators, and guess a category from a few
// keywords per piece. It doesn't need to be smart — it only exists so
// `?mock=1` can demonstrate the whole capture flow (pending row, toast,
// highlight, fallback) without a real backend or API key.

const MOCK_CATEGORY_RULES = [
  [/dentist|doctor|\bgp\b|prescription|workout|gym|health|meds|medicine|checkup/i, "Health & Personal Care"],
  [/\bbill\b|invoice|\bbank\b|\bpay\b|subscription|renew|insurance|\btax\b/i, "Finances & Subscriptions"],
  [/clean|laundry|dishes|hoover|\bbin\b|tidy|garden|fix\b|chore/i, "Household & Chores"],
  [/\bbuy\b|\bshop\b|groceries|\bmilk\b|present|\bgift\b/i, "Shopping & Groceries"],
  [/flight|holiday|\btrip\b|hotel|passport|travel/i, "Holidays & Travel"],
  [/\bread\b|\bwatch\b|\bfilm\b|movie|\bgame\b|hobby|book\b/i, "Leisure & Pending Experiences"],
  [/\bemail\b|\bform\b|\badmin\b|\bfile\b|appointment|\bcall\b/i, "Admin & Organization"],
  [/\bmum\b|\bdad\b|sister|brother|\bfriend\b|family|partner|birthday/i, "Relationship & Family"],
  [/\bcourse\b|\blearn\b|\bstudy\b|\bcv\b|resume|\bwork\b|project/i, "Career & Learning"],
];

function guessMockCategory(text) {
  for (const rule of MOCK_CATEGORY_RULES) {
    if (rule[0].test(text)) return rule[1];
  }
  return "Inbox";
}

function splitMockBrainDump(raw) {
  return String(raw || "")
    .split(/\n|,| and /i)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; })
    .slice(0, 15);
}

function makeMockId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "mock-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
}

function mockCaptureFallbackRow(raw, opId, now) {
  const firstLine = raw.split("\n")[0].trim() || raw.trim();
  const title = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
  return {
    id: makeMockId(), title: title, notes: raw, category: "Inbox", est_min: null,
    status: "inbox", do_date: "", due_date: "", due_time: "", sort: "",
    created_at: now, updated_at: now, completed_at: "", calendar_event_id: "",
    source: "fallback", raw_input: raw, op_id: opId,
  };
}

function mockCapture(tasks, payload) {
  const opId = String((payload && payload.op_id) || "");
  const raw = String((payload && payload.raw) || "").trim();

  // Idempotency, same contract as the real backend: a retried op_id gets
  // back whatever was already saved, instead of a second copy.
  if (opId) {
    const existing = tasks.filter(function (t) { return t.op_id === opId; });
    if (existing.length) {
      const dupSource = existing[0].source === "fallback" ? "fallback" : "ai";
      return { ok: true, tasks: existing.map(cloneTask), source: dupSource, duplicate: true };
    }
  }
  if (!raw) return { ok: false, error: "missing_text" };

  const now = new Date().toISOString();
  const pieces = splitMockBrainDump(raw);
  const useFallback = isMockFallbackForced() || pieces.length === 0;

  let rows;
  let source;
  if (useFallback) {
    rows = [mockCaptureFallbackRow(raw, opId, now)];
    source = "fallback";
  } else {
    rows = pieces.map(function (line) {
      const title = line.length > 80 ? line.slice(0, 80) : line;
      return {
        id: makeMockId(), title: title, notes: "", category: guessMockCategory(line),
        est_min: 15, status: "active", do_date: "", due_date: "", due_time: "", sort: "",
        created_at: now, updated_at: now, completed_at: "", calendar_event_id: "",
        source: "ai", raw_input: raw, op_id: opId,
      };
    });
    source = "ai";
  }

  for (const row of rows) tasks.push(row);
  return { ok: true, tasks: rows.map(cloneTask), source: source };
}

// --- fake secretary mode (mock assist) -----------------------------------
// A rough stand-in for what the real `assist` action does: read a little
// intent out of the wording (a completion, a "someday", a "move X to
// day", a question) and act on the FIRST real task title it finds. Not
// smart at all — it only exists so `?mock=1` can demonstrate all four
// reply-card states (a plain capture, a command, a question, and "didn't
// understand") without a real backend or Gemini key.

const MOCK_WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Resolves "friday"/"tomorrow"/"today"/etc, relative to `todayStr_`, to a
 * real YYYY-MM-DD — a tiny stand-in for what the real assist prompt asks
 * Gemini to do properly with full date reasoning. */
function mockResolveDay_(word, todayStr_) {
  if (word === "today") return todayStr_;
  if (word === "tomorrow") return addDays(todayStr_, 1);
  const targetIdx = MOCK_WEEKDAY_NAMES.indexOf(word);
  if (targetIdx === -1) return todayStr_;
  const parts = todayStr_.split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  let diff = targetIdx - d.getDay();
  if (diff <= 0) diff += 7; // "friday" always means the NEXT Friday, never today/already-passed this week
  return addDays(todayStr_, diff);
}

/** Finds the first non-dropped task whose title contains this fragment —
 * the mock's very rough version of the real assist prompt's "match
 * generously" id-matching rule. */
function mockFindTaskByFragment(tasks, fragment) {
  const f = String(fragment || "").trim().toLowerCase();
  if (!f) return null;
  return tasks.find(function (t) { return t.status !== "dropped" && t.title.toLowerCase().indexOf(f) !== -1; }) || null;
}

function mockAssist(tasks, payload) {
  const raw = String((payload && payload.raw) || "").trim();
  if (!raw) return { ok: false, error: "missing_text" };

  const lower = raw.toLowerCase();
  const now = new Date().toISOString();
  const today = todayStr();

  // "I did the X" / "did the X" / "done with X" / "finished the X" -> complete
  let m = lower.match(/\b(?:i did|did the|done with|finished)\s+(?:the\s+)?([a-z0-9 '&-]{3,40})/);
  if (m) {
    const task = mockFindTaskByFragment(tasks, m[1]);
    if (task) {
      task.status = "done";
      task.completed_at = task.completed_at || now;
      task.updated_at = now;
      return { ok: true, intent: "command", reply: "Nice — marked \"" + task.title + "\" done.", tasks: [], updated: [cloneTask(task)], source: "ai" };
    }
  }

  // "put/move the X in(to)/to someday" -> someday
  m = lower.match(/\b(?:put|move)\s+(?:the\s+)?([a-z0-9 '&-]{3,40}?)\s+(?:in(?:to)?|to)\s+someday\b/);
  if (m) {
    const task = mockFindTaskByFragment(tasks, m[1]);
    if (task) {
      task.status = "someday";
      task.do_date = "";
      task.updated_at = now;
      return { ok: true, intent: "command", reply: "Parked \"" + task.title + "\" in Someday.", tasks: [], updated: [cloneTask(task)], source: "ai" };
    }
  }

  // "move the X to friday/tomorrow/..." -> schedule
  m = lower.match(/\bmove\s+(?:the\s+)?([a-z0-9 '&-]{3,40}?)\s+to\s+(friday|monday|tuesday|wednesday|thursday|saturday|sunday|tomorrow|today)\b/);
  if (m) {
    const task = mockFindTaskByFragment(tasks, m[1]);
    if (task) {
      task.do_date = mockResolveDay_(m[2], today);
      if (task.status === "inbox" || task.status === "someday") task.status = "active";
      task.updated_at = now;
      return { ok: true, intent: "command", reply: "Done — \"" + task.title + "\" moved to " + m[2] + ".", tasks: [], updated: [cloneTask(task)], source: "ai" };
    }
  }

  // A plain question -> a canned, data-flavoured answer, no changes at all
  if (/what'?s due|what is due|\?\s*$/.test(lower)) {
    const dueSoon = tasks
      .filter(function (t) { return t.status === "active" && t.due_date && t.due_date >= today; })
      .sort(function (a, b) { return String(a.due_date).localeCompare(String(b.due_date)); });
    const reply = dueSoon.length
      ? "Coming up: " + dueSoon.slice(0, 3).map(function (t) { return t.title; }).join(", ") + "."
      : "Nothing due that I can see — a clean stretch ahead.";
    return { ok: true, intent: "question", reply: reply, tasks: [], updated: [], source: "ai" };
  }

  // Nothing above matched — treat it as a plain brain-dump, via the same
  // fake splitter `capture` already uses.
  const captured = mockCapture(tasks, payload);
  return Object.assign({}, captured, { intent: "capture", reply: "", updated: [] });
}

async function mockCall(action, payload) {
  await delay(260 + Math.random() * 80);
  const tasks = ensureMockSeed();
  const today = todayStr();

  if (action === "ping") {
    return { ok: true, version: "mock-0.3.0", time: new Date().toISOString(), tz: "Mock/Local" };
  }
  if (action === "list") {
    return { ok: true, tasks: tasks.map(cloneTask), server_time: new Date().toISOString(), today: today };
  }
  if (action === "add") return mockAdd(tasks, payload);
  if (action === "update") return mockUpdate(tasks, payload);
  if (action === "capture") {
    // The real Gemini call takes a few seconds — fake that so the pending
    // row / "Sorting…" state actually has something to show off.
    await delay(900 + Math.random() * 300);
    return mockCapture(tasks, payload);
  }
  if (action === "assist") {
    // Phase 8: same fake "thinking time" as capture, so the pending row's
    // "Thinking…" state actually has something to show off too.
    await delay(900 + Math.random() * 300);
    return mockAssist(tasks, payload);
  }
  if (action === "review_get") return { ok: true, review: ensureMockReview() };
  if (action === "review_dismiss") { mockReview = null; return { ok: true }; }
  if (action === "review_apply") return mockReviewApply(tasks, payload);
  return { ok: false, error: "unknown_action" };
}

// --- the one function everything else calls ---------------------------

/**
 * Sends one action to the server (or the mock), and either returns
 * `{ data, elapsedMs }` on success or throws one of the error types above.
 * Every caller in this app goes through this function — nothing else in
 * the codebase calls fetch() directly.
 */
export async function api(action, payload) {
  const started = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const data = isMockMode() ? await mockCall(action, payload) : await realCall(action, payload);
  const elapsedMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started);

  if (!data || data.ok !== true) {
    const code = data && data.error ? data.error : "unknown_error";
    throw new ApiError(code);
  }
  return { data: data, elapsedMs: elapsedMs };
}
