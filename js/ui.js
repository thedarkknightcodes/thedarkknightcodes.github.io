/**
 * ui.js — rendering for the three screens (Today / Week / Someday), the
 * top bar, the undo toast, and the key screen.
 *
 * Rule followed throughout: every piece of task data (titles, notes,
 * categories a user typed) is placed with `textContent`, never
 * `innerHTML`. That's what keeps a task title that happens to contain
 * `<script>` from ever being treated as markup.
 *
 * The action sheet, edit form and settings sheet live in sheets.js
 * (re-exported from here) — split out purely to keep this file a
 * readable size. app.js owns *when* things change (state, network
 * calls); this file only knows *how* to draw a given state and report
 * back which button got pressed, via the `handlers` object passed to
 * init().
 */

export { openActionSheet, openSettingsSheet, updateSettingsInfo, closeSettings } from "./sheets.js";

const refs = {};
let toastTimer = null;

function el(id) { return document.getElementById(id); }
function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ---------------------------------------------------------------------------
// init — cache DOM refs, wire the parts of the page that never change shape
// ---------------------------------------------------------------------------

export function init(handlers) {
  refs.keyScreen = el("key-screen");
  refs.mainScreen = el("main-screen");
  refs.deviceKeyInput = el("device-key-input");
  refs.saveKeyBtn = el("save-key-btn");
  refs.keyScreenMessage = el("key-screen-message");

  refs.syncDot = el("sync-dot");
  refs.gearBtn = el("gear-btn");
  refs.gearBtnMobile = el("gear-btn-mobile");

  refs.tabButtons = Array.from(document.querySelectorAll(".tab-btn"));

  refs.captureForm = el("capture-form");
  refs.captureInput = el("capture-input");
  refs.todayToggle = el("today-toggle");
  refs.captureFeedback = el("capture-feedback");

  refs.migrationNotice = el("migration-notice");
  refs.pickThreeCard = el("pick-three-card");
  refs.todayList = el("today-list");
  refs.doneTodayToggle = el("done-today-toggle");
  refs.doneTodayList = el("done-today-list");

  refs.weekStrip = el("week-strip");
  refs.unscheduledDrawer = el("unscheduled-drawer");
  refs.unscheduledFilter = el("unscheduled-filter");
  refs.unscheduledGroups = el("unscheduled-groups");

  refs.somedayList = el("someday-list");

  refs.toast = el("toast");

  refs.saveKeyBtn.addEventListener("click", function () {
    const value = refs.deviceKeyInput.value.trim();
    if (!value) return;
    handlers.onSaveKey(value);
    refs.deviceKeyInput.value = "";
  });
  refs.deviceKeyInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); refs.saveKeyBtn.click(); }
  });

  for (const btn of refs.tabButtons) {
    btn.addEventListener("click", function () { handlers.onTabChange(btn.dataset.tab); });
  }

  refs.gearBtn.addEventListener("click", handlers.onOpenSettings);
  refs.gearBtnMobile.addEventListener("click", handlers.onOpenSettings);

  refs.captureInput.addEventListener("input", function () {
    refs.captureInput.style.height = "auto";
    refs.captureInput.style.height = refs.captureInput.scrollHeight + "px";
  });
  refs.captureInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      refs.captureForm.requestSubmit();
    }
    // Shift+Enter falls through and inserts a newline, as normal.
  });
  refs.captureForm.addEventListener("submit", function (e) {
    e.preventDefault();
    const raw = refs.captureInput.value;
    if (!raw.trim()) return;
    handlers.onCapture(raw, refs.todayToggle.checked);
    refs.captureInput.value = "";
    refs.captureInput.style.height = "auto";
    refs.captureInput.focus();
  });

  refs.doneTodayToggle.addEventListener("click", handlers.onToggleDoneToday);

  let filterDebounce = null;
  refs.unscheduledFilter.addEventListener("input", function () {
    clearTimeout(filterDebounce);
    const value = refs.unscheduledFilter.value;
    filterDebounce = setTimeout(function () { handlers.onUnscheduledFilter(value); }, 150);
  });
}

// ---------------------------------------------------------------------------
// key screen / main screen
// ---------------------------------------------------------------------------

export function showKeyScreen(message) {
  refs.keyScreenMessage.textContent = message || "";
  refs.keyScreen.hidden = false;
  refs.mainScreen.hidden = true;
  refs.deviceKeyInput.focus();
}

export function showMainScreen() {
  refs.keyScreen.hidden = true;
  refs.mainScreen.hidden = false;
}

// ---------------------------------------------------------------------------
// sync dot + tabs
// ---------------------------------------------------------------------------

export function renderSyncDot(status) {
  refs.syncDot.className = "sync-dot sync-dot-" + status;
  const labels = { idle: "Synced", saving: "Saving…", retry: "Will save when back online" };
  refs.syncDot.title = labels[status] || "Synced";
}

export function setActiveTab(tab) {
  for (const btn of refs.tabButtons) {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-current", isActive ? "page" : "false");
  }
  document.querySelectorAll(".panel").forEach(function (panel) {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

// ---------------------------------------------------------------------------
// shared task row builder (used by Today, Week and Someday)
// ---------------------------------------------------------------------------

function buildTaskRow(task, opts, handlers) {
  const li = document.createElement("li");
  li.className = "task-row" + (task.status === "done" ? " is-done" : "");
  li.dataset.id = task.id;

  const check = document.createElement("button");
  check.type = "button";
  check.className = "check-btn";
  check.setAttribute("aria-label", task.status === "done" ? "Mark not done" : "Mark done");
  check.setAttribute("aria-pressed", String(task.status === "done"));
  check.addEventListener("click", function (e) {
    e.stopPropagation();
    li.classList.add("checking");
    setTimeout(function () { li.classList.remove("checking"); }, 260);
    handlers.onToggleDone(task);
  });
  li.appendChild(check);

  const body = document.createElement("div");
  body.className = "task-body";
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title;
  body.appendChild(title);

  const bits = [];
  if (task.category && task.category !== "Inbox") bits.push(task.category);
  if (task.est_min) bits.push(task.est_min + " min");
  if (opts.showDueTag) bits.push("due today");
  if (bits.length) {
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = bits.join(" · ");
    body.appendChild(meta);
  }
  li.appendChild(body);

  if (opts.extraAction) {
    const extra = document.createElement("button");
    extra.type = "button";
    extra.className = "task-extra-btn";
    extra.textContent = opts.extraAction.label;
    extra.addEventListener("click", function (e) {
      e.stopPropagation();
      opts.extraAction.onClick(task);
    });
    li.appendChild(extra);
  }

  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.addEventListener("click", function () { handlers.onOpen(task); });
  li.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handlers.onOpen(task); }
  });

  attachSwipe(li, function () { handlers.onSwipeDone(task); });

  return li;
}

function attachSwipe(el, onDone) {
  const THRESHOLD = 80;
  let tracking = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;

  el.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    tracking = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
  });
  el.addEventListener("pointermove", function (e) {
    if (!tracking || e.pointerId !== pointerId) return;
    const moveX = e.clientX - startX;
    const moveY = e.clientY - startY;
    if (Math.abs(moveY) > Math.abs(moveX) + 10) return; // vertical scroll wins
    dx = moveX;
    if (dx > 0) {
      el.style.transform = "translateX(" + Math.min(dx, 120) + "px)";
      el.style.opacity = String(Math.max(1 - dx / 300, 0.4));
    }
  });
  function reset() {
    tracking = false;
    pointerId = null;
    el.style.transform = "";
    el.style.opacity = "";
  }
  el.addEventListener("pointerup", function (e) {
    if (!tracking || e.pointerId !== pointerId) return;
    const finalDx = dx;
    reset();
    if (finalDx > THRESHOLD) onDone();
  });
  el.addEventListener("pointercancel", reset);
}

// ---------------------------------------------------------------------------
// Today panel
// ---------------------------------------------------------------------------

export function renderToday(vm, handlers) {
  refs.migrationNotice.hidden = !vm.needsMigration;

  clearChildren(refs.todayList);
  const rowHandlers = { onOpen: handlers.onOpenSheet, onToggleDone: handlers.onToggleDone, onSwipeDone: handlers.onToggleDone };

  for (const t of vm.scheduled) {
    refs.todayList.appendChild(buildTaskRow(t, { showDueTag: false }, rowHandlers));
  }
  for (const t of vm.dueToday) {
    refs.todayList.appendChild(buildTaskRow(t, { showDueTag: true }, rowHandlers));
  }
  if (!vm.scheduled.length && !vm.dueToday.length) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "Nothing scheduled for today yet.";
    refs.todayList.appendChild(empty);
  }

  renderDoneToday(vm.doneToday, vm.doneTodayOpen, rowHandlers, handlers);
  renderPickThree(vm.pickThree, handlers);
}

function renderDoneToday(doneToday, isOpen, rowHandlers, handlers) {
  if (!doneToday.length) {
    refs.doneTodayToggle.hidden = true;
    refs.doneTodayList.hidden = true;
    return;
  }
  refs.doneTodayToggle.hidden = false;
  refs.doneTodayToggle.textContent = "Done today ✓ (" + doneToday.length + ")";
  refs.doneTodayToggle.setAttribute("aria-expanded", String(isOpen));

  clearChildren(refs.doneTodayList);
  for (const t of doneToday) {
    refs.doneTodayList.appendChild(buildTaskRow(t, { showDueTag: false }, rowHandlers));
  }
  refs.doneTodayList.hidden = !isOpen;
}

function renderPickThree(pt, handlers) {
  clearChildren(refs.pickThreeCard);
  if (!pt.visible || !pt.suggestions.length) {
    refs.pickThreeCard.hidden = true;
    return;
  }
  refs.pickThreeCard.hidden = false;

  const heading = document.createElement("h2");
  heading.className = "card-title";
  heading.textContent = "Pick 3 for me";
  refs.pickThreeCard.appendChild(heading);

  const copy = document.createElement("p");
  copy.className = "card-copy";
  copy.textContent = pt.welcome
    ? "Welcome back. No catching up needed — here are three easy places to start."
    : "Three small places to start today.";
  refs.pickThreeCard.appendChild(copy);

  const list = document.createElement("ul");
  list.className = "suggestion-list";
  for (const s of pt.suggestions) {
    const li = document.createElement("li");
    li.className = "suggestion-row";
    const title = document.createElement("span");
    title.className = "suggestion-title";
    title.textContent = s.task.title;
    li.appendChild(title);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-small";
    addBtn.textContent = "Add to today";
    addBtn.addEventListener("click", function () { handlers.onAddToToday(s.task); });
    li.appendChild(addBtn);
    list.appendChild(li);
  }
  refs.pickThreeCard.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const shuffleBtn = document.createElement("button");
  shuffleBtn.type = "button";
  shuffleBtn.className = "btn btn-quiet";
  shuffleBtn.textContent = "Shuffle";
  shuffleBtn.addEventListener("click", handlers.onShuffle);
  const notNowBtn = document.createElement("button");
  notNowBtn.type = "button";
  notNowBtn.className = "btn btn-quiet";
  notNowBtn.textContent = "Not now";
  notNowBtn.addEventListener("click", handlers.onNotNow);
  actions.appendChild(shuffleBtn);
  actions.appendChild(notNowBtn);
  refs.pickThreeCard.appendChild(actions);
}

// ---------------------------------------------------------------------------
// Week panel
// ---------------------------------------------------------------------------

const DAY_LABEL_FORMAT = { weekday: "short", day: "numeric", month: "short" };

function labelForDate(dateStr, today) {
  const parts = dateStr.split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const label = d.toLocaleDateString(undefined, DAY_LABEL_FORMAT);
  return dateStr === today ? "Today · " + label : label;
}

export function renderWeek(vm, handlers) {
  clearChildren(refs.weekStrip);
  const rowHandlers = { onOpen: handlers.onOpenSheet, onToggleDone: handlers.onToggleDone, onSwipeDone: handlers.onToggleDone };

  for (const day of vm.days) {
    const col = document.createElement("section");
    col.className = "week-day";
    if (day.date === vm.today) col.classList.add("is-today");

    const heading = document.createElement("h3");
    heading.className = "week-day-heading";
    heading.textContent = labelForDate(day.date, vm.today);
    col.appendChild(heading);

    const list = document.createElement("ul");
    list.className = "task-list task-list-compact";
    if (!day.tasks.length) {
      const empty = document.createElement("p");
      empty.className = "empty-hint empty-hint-small";
      empty.textContent = "Nothing here.";
      list.appendChild(empty);
    } else {
      for (const t of day.tasks) list.appendChild(buildTaskRow(t, { showDueTag: false }, rowHandlers));
    }
    col.appendChild(list);
    refs.weekStrip.appendChild(col);
  }

  if (refs.unscheduledFilter.value !== vm.unscheduled.filterValue) {
    refs.unscheduledFilter.value = vm.unscheduled.filterValue;
  }

  clearChildren(refs.unscheduledGroups);
  if (!vm.unscheduled.groups.length) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "Nothing unscheduled right now.";
    refs.unscheduledGroups.appendChild(empty);
  }
  for (const entry of vm.unscheduled.groups) {
    const category = entry[0];
    const tasks = entry[1];
    const group = document.createElement("div");
    group.className = "category-group";
    const heading = document.createElement("h4");
    heading.className = "category-heading";
    heading.textContent = category;
    group.appendChild(heading);
    const list = document.createElement("ul");
    list.className = "task-list task-list-compact";
    for (const t of tasks) list.appendChild(buildTaskRow(t, { showDueTag: false }, rowHandlers));
    group.appendChild(list);
    refs.unscheduledGroups.appendChild(group);
  }
}

// ---------------------------------------------------------------------------
// Someday panel
// ---------------------------------------------------------------------------

export function renderSomeday(vm, handlers) {
  clearChildren(refs.somedayList);
  const rowHandlers = { onOpen: handlers.onOpenSheet, onToggleDone: handlers.onToggleDone, onSwipeDone: handlers.onToggleDone };
  if (!vm.tasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "Nothing parked here right now.";
    refs.somedayList.appendChild(empty);
    return;
  }
  for (const t of vm.tasks) {
    const opts = { showDueTag: false, extraAction: { label: "Bring back", onClick: handlers.onBringBack } };
    refs.somedayList.appendChild(buildTaskRow(t, opts, rowHandlers));
  }
}

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------

export function showToast(message, undoLabel, onUndo) {
  clearChildren(refs.toast);
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  refs.toast.appendChild(text);

  if (undoLabel && onUndo) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-undo";
    btn.textContent = undoLabel;
    btn.addEventListener("click", function () {
      onUndo();
      hideToast();
    });
    refs.toast.appendChild(btn);
  }

  refs.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  refs.toast.hidden = true;
  clearChildren(refs.toast);
}
