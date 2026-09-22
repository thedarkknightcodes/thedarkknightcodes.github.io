/**
 * sheets.js — the three <dialog> popups: the action sheet (tap a task),
 * the edit form (opened from it), and the settings sheet (gear icon).
 *
 * Split out of ui.js purely to keep each file a readable size — this is
 * "everything about the popups that sit on top of the screen", while
 * ui.js is "everything about the screen itself".
 */

import { CATEGORIES } from "./logic.js";

function el(id) { return document.getElementById(id); }
function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function showDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}
function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}
function backdropCloseHandler(dialog) {
  // Clicking the ::backdrop (or the dialog's own padding, outside any
  // child element) fires a click with target === the dialog itself —
  // that's the standard trick for "tap outside to close" with <dialog>.
  return function (e) { if (e.target === dialog) closeDialog(dialog); };
}

function addSheetButton(container, label, onClick, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sheet-btn" + (extraClass ? " " + extraClass : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  container.appendChild(btn);
  return btn;
}

function labeledField(labelText, inputEl) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = labelText;
  wrap.appendChild(span);
  wrap.appendChild(inputEl);
  return wrap;
}

// ---------------------------------------------------------------------------
// action sheet
// ---------------------------------------------------------------------------

export function openActionSheet(task, handlers) {
  const dialog = el("action-sheet");
  clearChildren(dialog);

  const heading = document.createElement("h2");
  heading.className = "sheet-title";
  heading.textContent = task.title;
  dialog.appendChild(heading);

  const actions = document.createElement("div");
  actions.className = "sheet-actions";
  addSheetButton(actions, "Today", function () { handlers.onMove(task, "today"); closeDialog(dialog); });
  addSheetButton(actions, "Tomorrow", function () { handlers.onMove(task, "tomorrow"); closeDialog(dialog); });

  const pickRow = document.createElement("label");
  pickRow.className = "sheet-date-row";
  const pickText = document.createElement("span");
  pickText.textContent = "Pick a day";
  pickRow.appendChild(pickText);
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "sheet-date-input";
  dateInput.addEventListener("change", function () {
    if (dateInput.value) { handlers.onPickDay(task, dateInput.value); closeDialog(dialog); }
  });
  pickRow.appendChild(dateInput);
  actions.appendChild(pickRow);

  addSheetButton(actions, "Unschedule", function () { handlers.onUnschedule(task); closeDialog(dialog); });
  addSheetButton(actions, "Someday", function () { handlers.onSomeday(task); closeDialog(dialog); });
  addSheetButton(actions, "Edit", function () { closeDialog(dialog); openEditForm(task, handlers); });
  addSheetButton(actions, "Drop", function () { handlers.onDrop(task); closeDialog(dialog); }, "sheet-btn-quiet");
  dialog.appendChild(actions);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "sheet-close";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", function () { closeDialog(dialog); });
  dialog.appendChild(closeBtn);

  dialog.addEventListener("click", backdropCloseHandler(dialog), { once: true });
  showDialog(dialog);
}

// ---------------------------------------------------------------------------
// edit form
// ---------------------------------------------------------------------------

function openEditForm(task, handlers) {
  const dialog = el("edit-sheet");
  clearChildren(dialog);

  const heading = document.createElement("h2");
  heading.className = "sheet-title";
  heading.textContent = "Edit task";
  dialog.appendChild(heading);

  const form = document.createElement("form");
  form.className = "edit-form";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.required = true;
  titleInput.value = task.title || "";
  titleInput.maxLength = 300;
  form.appendChild(labeledField("Title", titleInput));

  const notesInput = document.createElement("textarea");
  notesInput.rows = 3;
  notesInput.value = task.notes || "";
  form.appendChild(labeledField("Notes", notesInput));

  const categorySelect = document.createElement("select");
  for (const cat of CATEGORIES) {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    if (cat === task.category) opt.selected = true;
    categorySelect.appendChild(opt);
  }
  form.appendChild(labeledField("Category", categorySelect));

  const estInput = document.createElement("input");
  estInput.type = "number";
  estInput.min = "0";
  estInput.step = "5";
  estInput.value = task.est_min != null ? String(task.est_min) : "";
  form.appendChild(labeledField("Est. minutes", estInput));

  const dueDateInput = document.createElement("input");
  dueDateInput.type = "date";
  dueDateInput.value = task.due_date || "";
  form.appendChild(labeledField("Due date", dueDateInput));

  const dueTimeInput = document.createElement("input");
  dueTimeInput.type = "time";
  dueTimeInput.value = task.due_time || "";
  form.appendChild(labeledField("Due time", dueTimeInput));

  const buttons = document.createElement("div");
  buttons.className = "sheet-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "Save";
  buttons.appendChild(saveBtn);
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-quiet";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", function () { closeDialog(dialog); });
  buttons.appendChild(cancelBtn);
  form.appendChild(buttons);

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const title = titleInput.value.trim();
    if (!title) return;
    const estValue = estInput.value.trim();
    handlers.onEditSave(task.id, {
      title: title,
      notes: notesInput.value,
      category: categorySelect.value,
      est_min: estValue ? Number(estValue) : null,
      due_date: dueDateInput.value || "",
      due_time: dueTimeInput.value || "",
    });
    closeDialog(dialog);
  });

  dialog.appendChild(form);
  dialog.addEventListener("click", backdropCloseHandler(dialog), { once: true });
  showDialog(dialog);
  titleInput.focus();
}

// ---------------------------------------------------------------------------
// settings sheet
// ---------------------------------------------------------------------------

let settingsInfoRefs = null;

export function openSettingsSheet(info, handlers) {
  const dialog = el("settings-sheet");
  clearChildren(dialog);

  const heading = document.createElement("h2");
  heading.className = "sheet-title";
  heading.textContent = "Settings";
  dialog.appendChild(heading);

  // App version is the code running in THIS tab right now (from sw.js's
  // CACHE_VERSION) — separate from "Backend" below, which is whatever
  // version the Apps Script server last reported over the network.
  const appVersionLine = document.createElement("p");
  appVersionLine.className = "settings-line";
  appVersionLine.textContent = "App version: " + (info.appVersion || "unknown");
  dialog.appendChild(appVersionLine);

  const versionLine = document.createElement("p");
  versionLine.className = "settings-line";
  const timeLine = document.createElement("p");
  timeLine.className = "settings-line";
  dialog.appendChild(versionLine);
  dialog.appendChild(timeLine);
  settingsInfoRefs = { versionLine: versionLine, timeLine: timeLine };
  updateSettingsInfo(info);

  const actions = document.createElement("div");
  actions.className = "sheet-actions";
  // Only shown once Android/Chrome has told us the app is installable
  // (captured earlier as the "beforeinstallprompt" event) — there's no
  // point offering a button that can't do anything yet.
  if (info.canInstall) addSheetButton(actions, "Install app", handlers.onInstall);
  addSheetButton(actions, "Refresh", handlers.onRefresh);
  addSheetButton(actions, "Forget key on this device", handlers.onForgetKey, "sheet-btn-quiet");
  dialog.appendChild(actions);

  // iOS has no install button at all — Safari only offers "Add to Home
  // Screen" from its own Share sheet, so the best the app can do is tell
  // you where to find it.
  if (info.showIosInstallHint) {
    const iosHint = document.createElement("p");
    iosHint.className = "settings-line";
    iosHint.textContent = "To install: Share → Add to Home Screen.";
    dialog.appendChild(iosHint);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "sheet-close";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", function () { closeDialog(dialog); });
  dialog.appendChild(closeBtn);

  dialog.addEventListener("click", backdropCloseHandler(dialog), { once: true });
  showDialog(dialog);
}

export function updateSettingsInfo(info) {
  if (!settingsInfoRefs) return;
  settingsInfoRefs.versionLine.textContent = "Backend: " + (info.version || "…") + " (" + (info.mode || "") + ")";
  settingsInfoRefs.timeLine.textContent = info.time ? "Server time: " + info.time : "";
}

export function closeSettings() {
  closeDialog(el("settings-sheet"));
}
