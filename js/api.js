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

async function mockCall(action, payload) {
  await delay(260 + Math.random() * 80);
  const tasks = ensureMockSeed();
  const today = todayStr();

  if (action === "ping") {
    return { ok: true, version: "mock-0.2.0", time: new Date().toISOString(), tz: "Mock/Local" };
  }
  if (action === "list") {
    return { ok: true, tasks: tasks.map(cloneTask), server_time: new Date().toISOString(), today: today };
  }
  if (action === "add") return mockAdd(tasks, payload);
  if (action === "update") return mockUpdate(tasks, payload);
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
