/**
 * store.js — in-memory app state, a localStorage cache of it, and the
 * outgoing-changes queue.
 *
 * Why cache tasks in localStorage at all: it lets the Today screen paint
 * instantly on next open, using yesterday's data, while the real `list`
 * call happens quietly in the background — instead of a blank screen for
 * a second or two every single time the app opens.
 *
 * Why a queue at all: "optimistic UI" means a tap changes what's on screen
 * immediately, before the server has confirmed anything. The queue is the
 * paper trail of promises still owed to the server — each entry is one
 * `add` or `update` call that needs to go out, in order, and stays in the
 * queue (surviving a reload, since it's in localStorage too) until the
 * server has actually accepted it.
 */

import { todayStr } from "./logic.js";

const TASKS_KEY = "planner.tasks";
const QUEUE_KEY = "planner.queue";
const LAST_OPEN_KEY = "planner.lastOpen";
const LAST_SYNC_KEY = "planner.lastSync";

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage full or blocked — the app keeps working from memory for the
    // rest of this session, it just won't survive a reload.
  }
}

const state = {
  tasks: readJson(TASKS_KEY, []),
  queue: readJson(QUEUE_KEY, []),
  serverToday: todayStr(),
  serverTime: null,
  syncStatus: "idle", // "idle" | "saving" | "retry"
  needsMigration: false,
  lastSync: Number(readJson(LAST_SYNC_KEY, 0)) || 0,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return function unsubscribe() { listeners.delete(fn); };
}

function notify() {
  for (const fn of listeners) fn(state);
}

export function getState() {
  return state;
}

// --- tasks -----------------------------------------------------------------

export function setTasks(tasks) {
  state.tasks = tasks;
  writeJson(TASKS_KEY, state.tasks);
  notify();
}

/** Adds a task, or replaces it if a task with that id already exists. */
export function upsertTask(task) {
  const idx = state.tasks.findIndex(function (t) { return t.id === task.id; });
  if (idx === -1) state.tasks.push(task);
  else state.tasks[idx] = task;
  writeJson(TASKS_KEY, state.tasks);
  notify();
}

/**
 * Merges `fields` into the task with this id and returns the task as it
 * was BEFORE the change — callers use that to build an Undo. Returns null
 * if the task isn't known locally (shouldn't normally happen, but a
 * mutation racing a delete-from-view is possible).
 */
export function patchTask(id, fields) {
  const idx = state.tasks.findIndex(function (t) { return t.id === id; });
  if (idx === -1) return null;
  const previous = Object.assign({}, state.tasks[idx]);
  state.tasks[idx] = Object.assign({}, state.tasks[idx], fields, { updated_at: new Date().toISOString() });
  writeJson(TASKS_KEY, state.tasks);
  notify();
  return previous;
}

export function setServerMeta(meta) {
  if (meta.today) state.serverToday = meta.today;
  if (meta.serverTime) state.serverTime = meta.serverTime;
  state.needsMigration = !!meta.needsMigration;
  state.lastSync = Date.now();
  writeJson(LAST_SYNC_KEY, state.lastSync);
  notify();
}

export function setSyncStatus(status) {
  state.syncStatus = status;
  notify();
}

// --- outgoing op queue -------------------------------------------------

export function enqueueOp(op) {
  state.queue.push(op);
  writeJson(QUEUE_KEY, state.queue);
  notify();
}

export function dequeueOp(opId) {
  state.queue = state.queue.filter(function (op) { return op.op_id !== opId; });
  writeJson(QUEUE_KEY, state.queue);
  notify();
}

export function peekOp() {
  return state.queue.length ? state.queue[0] : null;
}

export function hasQueuedOps() {
  return state.queue.length > 0;
}

// --- "when did I last open this" (drives Pick 3's welcome-back copy) ----

export function getLastOpen() {
  try {
    return localStorage.getItem(LAST_OPEN_KEY) || "";
  } catch (err) {
    return "";
  }
}

export function setLastOpen(dateStr) {
  try {
    localStorage.setItem(LAST_OPEN_KEY, dateStr);
  } catch (err) {
    // Not critical — worst case Pick 3's welcome-back copy is wrong once.
  }
}
