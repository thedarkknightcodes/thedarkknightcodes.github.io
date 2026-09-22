/**
 * app.js — wires store + api + logic + ui together. This is the only file
 * that knows about all four of the others; each of them stays usable (and
 * testable) on its own.
 *
 * The shape of a mutation, everywhere in this file, is always the same
 * four steps ("optimistic UI + queue" from the docs):
 *   1. change it locally right away (store.patchTask / upsertTask)
 *   2. queue an op describing the same change for the server
 *   3. try to send the queue
 *   4. show an Undo toast that, if pressed, does the same four steps in
 *      reverse
 * The screen never waits on the network for step 1 — that's what makes the
 * app feel instant even on a slow connection.
 */

import * as api from "./api.js";
import * as store from "./store.js";
import * as logic from "./logic.js";
import * as ui from "./ui.js";

const RETRY_DELAYS_MS = [2000, 5000, 15000, 60000];

// Shown in Settings so you can tell at a glance whether a device has
// picked up the latest app shell yet. Keep this in sync by hand with
// CACHE_VERSION in sw.js whenever you bump one — they're two separate
// files (this one runs on the page, that one runs in the background) so
// there's no automatic way to share a single constant between them.
const APP_VERSION = "planner-v1";

let currentTab = "today";
let doneTodayOpen = false;
let unscheduledFilterValue = "";
let pickThreeDismissed = false;
// The "Pick 3" suggestions must stay put between re-renders (every save
// re-draws the screen) — otherwise the list keeps changing under your
// finger. Only the Shuffle button changes this seed.
let pickSeed = 1;
function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let flushing = false;
let retryAttempt = 0;
let retryTimer = null;
let deferredInstallPrompt = null; // captured "beforeinstallprompt" event, Android/Chrome only

// Ids of tasks that just landed via an AI capture, so Today can give them a
// brief highlight. Purely visual, never persisted — a reload just means you
// miss the highlight, which is fine.
let highlightedTaskIds = new Set();

// Read once at startup, before we overwrite it with today's date — this is
// what lets Pick 3 tell "opened yesterday" from "haven't opened in a week".
const initialLastOpen = store.getLastOpen();

// ---------------------------------------------------------------------------
// queue flushing
// ---------------------------------------------------------------------------

function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt++;
  retryTimer = setTimeout(function () { flushQueue(); }, delay);
}

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const op = store.peekOp();
      if (!op) {
        store.setSyncStatus("idle");
        retryAttempt = 0;
        break;
      }
      store.setSyncStatus("saving");
      try {
        const result = await api.api(op.action, op.payload);
        if (op.action === "capture") applyCaptureResult(op, result.data);
        store.dequeueOp(op.op_id);
        retryAttempt = 0;
      } catch (err) {
        if (err instanceof api.NetworkError) {
          store.setSyncStatus("retry");
          scheduleRetry();
          return;
        }
        if (err instanceof api.ApiError && (err.code === "invalid_token" || err.code === "locked")) {
          store.setSyncStatus("retry");
          ui.showKeyScreen(err.code === "locked" ? "Too many attempts — try again in a few minutes." : "");
          return;
        }
        if (op.action === "capture") {
          // The server refused this outright (e.g. an empty raw somehow
          // got this far) rather than a network blip — nothing was saved,
          // and nothing here can succeed by retrying, so just say so.
          store.dequeueOp(op.op_id);
          ui.showToast("That capture didn't save — try again.");
          continue;
        }
        // Some other ApiError: this op can never succeed as-is. Drop it,
        // quietly refetch the truth from the server, and say so gently
        // rather than leaving the screen showing a change that never saved.
        store.dequeueOp(op.op_id);
        await refreshTasks();
        ui.showToast("That change didn't save — refreshed.");
      }
    }
  } finally {
    flushing = false;
  }
}

async function refreshTasks() {
  try {
    const result = await api.api("list", {});
    const data = result.data;
    store.setTasks(data.tasks || []);
    store.setServerMeta({ today: data.today, serverTime: data.server_time, needsMigration: !!data.needs_migration });
  } catch (err) {
    if (err instanceof api.ApiError && (err.code === "invalid_token" || err.code === "locked")) {
      ui.showKeyScreen(err.code === "locked" ? "Too many attempts — try again in a few minutes." : "");
    }
    // A network hiccup on a background refresh just leaves the cached
    // tasks on screen — no need to alarm anyone over it.
  }
}

// ---------------------------------------------------------------------------
// mutation helpers
// ---------------------------------------------------------------------------

function queueUpdate(id, fields) {
  const opId = logic.randomId();
  store.enqueueOp({ op_id: opId, action: "update", payload: { id: id, fields: fields, op_id: opId } });
  flushQueue();
}

/** Applies a field change optimistically, queues it, and offers Undo. */
function applyFieldUpdate(task, fields, toastMessage) {
  const previous = store.patchTask(task.id, fields);
  if (!previous) return;
  queueUpdate(task.id, fields);
  ui.showToast(toastMessage, "Undo", function () {
    const undoFields = {};
    for (const key of Object.keys(fields)) {
      undoFields[key] = previous[key] !== undefined ? previous[key] : "";
    }
    store.patchTask(task.id, undoFields);
    queueUpdate(task.id, undoFields);
  });
}

/**
 * The main capture flow (Phase 4): one messy ramble goes to the backend as
 * a single `capture` op, and Gemini splits it into tasks server-side. We
 * never wait for that reply before confirming — the op is queued (so it
 * survives a reload and retries itself if you're offline) and a toast
 * fires immediately. `todayOn` is remembered on the op itself so that, once
 * the AI result eventually comes back, we can honour the "Today" chip for
 * whichever of ITS tasks the AI left undated (see applyCaptureResult).
 */
/**
 * `sourceHint` is "typed" (the normal capture box, the default) or "share"
 * (Phase 5: arrived via Android's share sheet — see readShareTarget()
 * below). It rides along on the capture payload purely so the backend's
 * Log tab can tell the two apart later ("capture:share" vs
 * "capture:typed") — it changes nothing else about how the capture is
 * handled.
 */
function handleCapture(raw, todayOn, sourceHint) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return;

  const today = store.getState().serverToday;
  const opId = logic.randomId();

  store.enqueueOp({
    op_id: opId,
    action: "capture",
    payload: { raw: trimmed, op_id: opId, today_hint: today, source_hint: sourceHint || "typed" },
    todayOn: !!todayOn,
  });
  flushQueue();

  ui.showToast("Got it ✓");
}

/**
 * Runs once a `capture` op's server response comes back. Merges the new
 * tasks into the store, honours the "Today" chip for any the AI left
 * undated, tells you gently if it had to fall back to one Inbox note, and
 * gives the new tasks a brief highlight on the Today screen.
 */
function applyCaptureResult(op, data) {
  const tasks = data.tasks || [];
  const today = store.getState().serverToday;

  for (const task of tasks) {
    store.upsertTask(task);
  }

  if (op.todayOn) {
    for (const task of tasks) {
      // Only fill in a date the AI left blank — an AI-chosen date (or one
      // it correctly left off because it was a "someday" kind of item)
      // always wins over the chip.
      if (!task.do_date && !task.due_date) {
        store.patchTask(task.id, { do_date: today });
        queueUpdate(task.id, { do_date: today });
      }
    }
  }

  if (data.source === "fallback") {
    ui.showToast("Saved as one note for now — you can split it later.");
  }

  highlightTaskIds(tasks.map(function (t) { return t.id; }));
}

/** Marks a set of task ids as "just arrived" for one render, then clears
 * it — see the .task-row-new rule in styles.css for the actual highlight
 * (which the page's reduced-motion rule already neutralises when needed). */
function highlightTaskIds(ids) {
  if (!ids.length) return;
  for (const id of ids) highlightedTaskIds.add(id);
  render();
  setTimeout(function () {
    for (const id of ids) highlightedTaskIds.delete(id);
    render();
  }, 1600);
}

function handleToggleDone(task) {
  const wasDone = task.status === "done";
  const fields = wasDone
    ? { status: "active", completed_at: "" }
    : { status: "done", completed_at: new Date().toISOString() };
  applyFieldUpdate(task, fields, wasDone ? "Marked not done" : "Nice — done!");
}

// ---------------------------------------------------------------------------
// view models — turn store state into what ui.js needs to draw a screen
// ---------------------------------------------------------------------------

function buildPendingCaptures(state) {
  return state.queue
    .filter(function (op) { return op.action === "capture"; })
    .map(function (op) {
      const raw = (op.payload && op.payload.raw) || "";
      return {
        op_id: op.op_id,
        preview: raw.slice(0, 40),
        waiting: state.syncStatus === "retry",
      };
    });
}

function buildTodayViewModel(state) {
  const today = state.serverToday;
  const split = logic.splitTodayTasks(state.tasks, today);
  const activeAll = state.tasks.filter(function (t) { return t.status === "active"; });

  const showPick = !pickThreeDismissed && logic.shouldShowPickThree({
    todayTaskCount: split.scheduled.length + split.dueToday.length,
    lastOpenStr: initialLastOpen,
    today: today,
  });
  const welcome = logic.isWelcomeBack({ lastOpenStr: initialLastOpen, today: today });

  const alreadyToday = new Set(split.scheduled.map(function (t) { return t.id; }).concat(split.dueToday.map(function (t) { return t.id; })));
  const candidates = activeAll.filter(function (t) { return !alreadyToday.has(t.id); });
  const suggestions = showPick ? logic.pickThree(candidates, today, seededRandom(pickSeed)) : [];

  return {
    scheduled: split.scheduled,
    dueToday: split.dueToday,
    doneToday: split.doneToday,
    doneTodayOpen: doneTodayOpen,
    needsMigration: state.needsMigration,
    pickThree: { visible: showPick && suggestions.length > 0, welcome: welcome, suggestions: suggestions },
    pendingCaptures: buildPendingCaptures(state),
    inboxCount: state.tasks.filter(function (t) { return t.status === "inbox"; }).length,
    highlightedIds: highlightedTaskIds,
  };
}

function buildWeekViewModel(state) {
  const today = state.serverToday;
  const dates = logic.weekDates(today, 7);
  const byDate = new Map(dates.map(function (d) { return [d, []]; }));
  for (const t of state.tasks) {
    if (t.status === "active" && byDate.has(t.do_date)) byDate.get(t.do_date).push(t);
  }
  const days = dates.map(function (d) { return { date: d, tasks: byDate.get(d) }; });

  const unscheduled = logic.unscheduledActiveTasks(state.tasks);
  const filtered = logic.filterTasksByText(unscheduled, unscheduledFilterValue);
  const groups = logic.groupByCategory(filtered);
  const inbox = logic.inboxTasks(state.tasks);

  return { today: today, days: days, inbox: inbox, unscheduled: { groups: groups, filterValue: unscheduledFilterValue } };
}

function buildSomedayViewModel(state) {
  return { tasks: state.tasks.filter(function (t) { return t.status === "someday"; }) };
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

const todayHandlers = {
  onOpenSheet: function (task) { ui.openActionSheet(task, sheetHandlers); },
  onToggleDone: handleToggleDone,
  onAddToToday: function (task) {
    applyFieldUpdate(task, { do_date: store.getState().serverToday }, "Added to today");
  },
  onShuffle: function () { pickSeed += 1; render(); },
  onNotNow: function () { pickThreeDismissed = true; render(); },
  onOpenInboxLink: function () {
    currentTab = "week";
    render();
    ui.openUnscheduledDrawer();
  },
};

const weekHandlers = {
  onOpenSheet: function (task) { ui.openActionSheet(task, sheetHandlers); },
  onToggleDone: handleToggleDone,
};

const somedayHandlers = {
  onOpenSheet: function (task) { ui.openActionSheet(task, sheetHandlers); },
  onToggleDone: handleToggleDone,
  onBringBack: function (task) { applyFieldUpdate(task, { status: "active", do_date: "" }, "Back on the list"); },
};

/** A task sitting in the Inbox (an unsorted AI-fallback capture) is, by
 * definition, "sorted" the moment you schedule, edit or otherwise decide
 * what it is from its action sheet — this bumps it from "inbox" to
 * "active" whenever that happens, so it leaves the Inbox section instead
 * of sitting there forever even after you've dealt with it. */
function withSortedStatus(task, fields) {
  return task.status === "inbox" ? Object.assign({}, fields, { status: "active" }) : fields;
}

const sheetHandlers = {
  onMove: function (task, when) {
    const today = store.getState().serverToday;
    const date = when === "today" ? today : logic.addDays(today, 1);
    applyFieldUpdate(task, withSortedStatus(task, { do_date: date }), when === "today" ? "Moved to today" : "Moved to tomorrow");
  },
  onPickDay: function (task, dateStr) { applyFieldUpdate(task, withSortedStatus(task, { do_date: dateStr }), "Scheduled"); },
  onUnschedule: function (task) { applyFieldUpdate(task, { do_date: "" }, "Unscheduled"); },
  onSomeday: function (task) { applyFieldUpdate(task, { status: "someday", do_date: "" }, "Moved to Someday"); },
  onDrop: function (task) { applyFieldUpdate(task, { status: "dropped" }, "Dropped"); },
  onEditSave: function (id, fields) {
    const task = store.getState().tasks.find(function (t) { return t.id === id; });
    if (task) applyFieldUpdate(task, withSortedStatus(task, fields), "Saved");
  },
};

function render() {
  const state = store.getState();
  ui.renderSyncDot(state.syncStatus);
  ui.setActiveTab(currentTab);
  if (currentTab === "today") ui.renderToday(buildTodayViewModel(state), todayHandlers);
  else if (currentTab === "week") ui.renderWeek(buildWeekViewModel(state), weekHandlers);
  else ui.renderSomeday(buildSomedayViewModel(state), somedayHandlers);
}

// ---------------------------------------------------------------------------
// top-level handlers (key screen, tabs, settings, capture, done-today)
// ---------------------------------------------------------------------------

async function openSettings() {
  const info = {
    version: "…",
    time: "",
    mode: api.isMockMode() ? "mock (?mock=1)" : "live",
    appVersion: APP_VERSION,
    canInstall: !!deferredInstallPrompt,
    showIosInstallHint: isIosNotInstalled(),
  };
  ui.openSettingsSheet(info, {
    onRefresh: function () {
      refreshTasks();
      pingForSettings();
    },
    onForgetKey: function () {
      api.forgetDeviceKey();
      ui.closeSettings();
      ui.showKeyScreen("");
    },
    onInstall: function () {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      // A device only lets a given prompt be used once — clear it either
      // way so we don't try to reuse a spent one.
      deferredInstallPrompt.userChoice.finally(function () { deferredInstallPrompt = null; });
    },
  });
  pingForSettings();
}

async function pingForSettings() {
  try {
    const result = await api.api("ping", {});
    ui.updateSettingsInfo({ version: result.data.version, time: result.data.time, mode: api.isMockMode() ? "mock (?mock=1)" : "live" });
  } catch (err) {
    ui.updateSettingsInfo({ version: "unavailable", time: "", mode: api.isMockMode() ? "mock (?mock=1)" : "live" });
  }
}

const topHandlers = {
  onSaveKey: function (key) {
    api.saveDeviceKey(key);
    ui.showMainScreen();
    refreshTasks().then(flushQueue);
  },
  onTabChange: function (tab) { currentTab = tab; render(); },
  onOpenSettings: openSettings,
  onCapture: handleCapture,
  onToggleDoneToday: function () { doneTodayOpen = !doneTodayOpen; render(); },
  onUnscheduledFilter: function (value) { unscheduledFilterValue = value; render(); },
};

// ---------------------------------------------------------------------------
// PWA bits: install-to-home-screen, the service worker, and the "opened
// from the installed app" URL param
// ---------------------------------------------------------------------------

/** True on an iPhone/iPad's Safari that hasn't been added to the home
 * screen yet — the signal for showing the "Share → Add to Home Screen"
 * hint, since iOS has no `beforeinstallprompt` event to hook into. */
function isIosNotInstalled() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return isIos && navigator.standalone === false;
}

/** Chrome/Android fires this once, early, if the app is installable —
 * capture it so a later tap of "Install app" in Settings can replay it
 * (the browser's own install banner can only be triggered from a real
 * user gesture, not from code running on page load). */
function wireInstallPrompt() {
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
}

/** `manifest.webmanifest`'s start_url is `/?source=pwa`, purely so we can
 * tell "opened from the installed icon" apart from "opened in a normal
 * browser tab" if that's ever useful. Nothing in the app currently reads
 * it, so strip it from the visible URL right away rather than leave a
 * confusing query string sitting in the address bar. */
function stripPwaSourceParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("source")) return;
  url.searchParams.delete("source");
  window.history.replaceState({}, "", url.pathname + (url.search || "") + url.hash);
}

/**
 * Phase 5: manifest.webmanifest declares a `share_target`, so "Share to
 * Task Planner" from any Android app opens this page with `title`, `text`
 * and/or `url` tacked onto the address as a query string. Different apps
 * fill these in differently — Chrome shares a page as `title` + `url`, but
 * a lot of apps (voice memo apps, Keep, Rambler, etc.) dump everything
 * into `text` and leave `url` empty — so rather than trust any one field,
 * we read all three and use whichever ones actually have something in
 * them, in that order.
 *
 * Returns the text to capture ("" if this wasn't a share at all), and —
 * critically — strips title/text/url from the visible URL BEFORE returning
 * anything, using history.replaceState. That happens first, unconditionally,
 * so that reloading the page (or the browser restoring this tab later)
 * can never re-run the same capture a second time.
 */
function readShareTarget() {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  if (!params.has("title") && !params.has("text") && !params.has("url")) return "";

  const rawParts = [params.get("title"), params.get("text"), params.get("url")]
    .map(function (p) { return (p || "").trim(); })
    .filter(function (p) { return p.length > 0; });

  // De-duplicate while keeping the first-seen order — Chrome, for example,
  // often shares a page as the SAME string in both `text` and `url`, and a
  // capture with the same line twice is just noise.
  const seen = new Set();
  const parts = [];
  for (const p of rawParts) {
    if (seen.has(p)) continue;
    seen.add(p);
    parts.push(p);
  }

  params.delete("title");
  params.delete("text");
  params.delete("url");
  window.history.replaceState({}, "", url.pathname + (params.toString() ? "?" + params.toString() : "") + url.hash);

  return parts.join("\n");
}

/** Registers the service worker that makes the app shell available
 * offline (see sw.js). Harmless to call in `?mock=1` mode too — it just
 * caches the same static files either way. */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then(function (registration) {
    registration.addEventListener("updatefound", function () {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", function () {
        // "installed" + an existing controller means this ISN'T the very
        // first install — it's a newer version sitting ready in the
        // background while the old one still runs this open tab. That's
        // exactly the moment to offer a reload, and only that moment.
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          ui.showToast("Update ready — tap to reload", "Reload", function () { window.location.reload(); });
        }
      });
    });
  }).catch(function () {
    // No service worker this session (unsupported browser, blocked, etc.)
    // — the app still works fully online, it just won't work offline.
  });
}

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

async function init() {
  stripPwaSourceParam();
  // Read (and immediately strip) any share-target params before anything
  // else touches the URL — see readShareTarget()'s comment for why the
  // stripping has to happen up front rather than after we act on it.
  const sharedRaw = readShareTarget();
  wireInstallPrompt();
  registerServiceWorker();

  ui.init(topHandlers);
  store.subscribe(render);

  const hasKey = api.isMockMode() || !!api.loadDeviceKey();
  if (hasKey) ui.showMainScreen();
  else ui.showKeyScreen("");

  render();

  window.addEventListener("online", function () { flushQueue(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    flushQueue();
    if (Date.now() - store.getState().lastSync > 60000) refreshTasks();
  });

  // Record "opened today" for next visit's Pick 3 logic, using local today
  // — we don't need to wait for the server's clock just for this.
  store.setLastOpen(logic.todayStr());

  // A shared capture behaves exactly like typing it into the box with
  // "Today" checked: instant "Got it ✓" toast, a "Sorting…" row while it's
  // in flight, queued (and retried) the same as everything else if
  // there's no signal right now.
  if (sharedRaw) handleCapture(sharedRaw, true, "share");

  if (hasKey) {
    await refreshTasks();
    flushQueue();
  }
}

document.addEventListener("DOMContentLoaded", init);
