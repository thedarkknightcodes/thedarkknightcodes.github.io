// Plain-node test for the pure functions in js/logic.js.
// Run with: node test/logic.test.mjs
// No test framework, no build step — just node:assert and a PASS/FAIL log,
// so it stays runnable by someone who has never installed a testing tool.

import assert from "node:assert/strict";
import {
  todayStr,
  addDays,
  isoDate,
  captureText,
  splitTodayTasks,
  shouldShowPickThree,
  isWelcomeBack,
  pickThree,
  weekDates,
  unscheduledActiveTasks,
  filterTasksByText,
  groupByCategory,
  inboxTasks,
  randomId,
  sourceBadge,
} from "../js/logic.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("PASS - " + name);
  } catch (err) {
    failed++;
    console.log("FAIL - " + name);
    console.log("       " + err.message);
  }
}

// --- date helpers ------------------------------------------------------

test("isoDate formats a Date as local YYYY-MM-DD", () => {
  const d = new Date(2026, 2, 5, 23, 30); // 5 Mar 2026, 23:30 local
  assert.equal(isoDate(d), "2026-03-05");
});

test("todayStr defaults to now, but accepts an injected date", () => {
  const d = new Date(2026, 0, 9);
  assert.equal(todayStr(d), "2026-01-09");
});

test("addDays moves forward across a month boundary", () => {
  assert.equal(addDays("2026-01-30", 3), "2026-02-02");
});

test("addDays moves backward", () => {
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("addDays(x, 0) is a no-op", () => {
  assert.equal(addDays("2026-06-15", 0), "2026-06-15");
});

// --- captureText -----------------------------------------------------------

test("captureText makes one task per non-empty line", () => {
  const tasks = captureText("Buy milk\n\n  Call dentist  \n", { today: "2026-05-01" });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "Buy milk");
  assert.equal(tasks[1].title, "Call dentist"); // trimmed
});

test("captureText sets do_date to today when the Today toggle is on", () => {
  const tasks = captureText("Water plants", { today: "2026-05-01", todayOn: true });
  assert.equal(tasks[0].do_date, "2026-05-01");
  assert.equal(tasks[0].status, "active");
  assert.equal(tasks[0].source, "typed");
});

test("captureText leaves do_date blank when the Today toggle is off", () => {
  const tasks = captureText("Water plants", { today: "2026-05-01", todayOn: false });
  assert.equal(tasks[0].do_date, "");
});

test("captureText gives every task a unique id", () => {
  const tasks = captureText("One\nTwo\nThree", { today: "2026-05-01" });
  const ids = new Set(tasks.map((t) => t.id));
  assert.equal(ids.size, 3);
});

test("captureText returns an empty array for blank input", () => {
  assert.deepEqual(captureText("   \n\n  ", { today: "2026-05-01" }), []);
});

test("randomId produces a non-empty, unique-looking string", () => {
  const a = randomId();
  const b = randomId();
  assert.ok(a.length > 10);
  assert.notEqual(a, b);
});

// --- splitTodayTasks ---------------------------------------------------

test("splitTodayTasks separates scheduled, due-today and done-today", () => {
  const today = "2026-05-01";
  const tasks = [
    { id: "1", status: "active", do_date: today, due_date: "", created_at: "2026-04-30T10:00:00.000Z" },
    { id: "2", status: "active", do_date: "", due_date: today, created_at: "2026-04-30T09:00:00.000Z" },
    { id: "3", status: "done", do_date: today, completed_at: today + "T08:00:00.000Z", created_at: "2026-04-29T00:00:00.000Z" },
    { id: "4", status: "active", do_date: "2026-05-02", due_date: "", created_at: "2026-04-30T11:00:00.000Z" },
  ];
  const result = splitTodayTasks(tasks, today);
  assert.deepEqual(result.scheduled.map((t) => t.id), ["1"]);
  assert.deepEqual(result.dueToday.map((t) => t.id), ["2"]);
  assert.deepEqual(result.doneToday.map((t) => t.id), ["3"]);
});

test("splitTodayTasks does not double-count a task both scheduled and due today", () => {
  const today = "2026-05-01";
  const tasks = [
    { id: "1", status: "active", do_date: today, due_date: today, created_at: "2026-04-30T10:00:00.000Z" },
  ];
  const result = splitTodayTasks(tasks, today);
  assert.equal(result.scheduled.length, 1);
  assert.equal(result.dueToday.length, 0);
});

test("splitTodayTasks sorts scheduled tasks by creation order", () => {
  const today = "2026-05-01";
  const tasks = [
    { id: "later", status: "active", do_date: today, created_at: "2026-04-30T12:00:00.000Z" },
    { id: "earlier", status: "active", do_date: today, created_at: "2026-04-30T09:00:00.000Z" },
  ];
  const result = splitTodayTasks(tasks, today);
  assert.deepEqual(result.scheduled.map((t) => t.id), ["earlier", "later"]);
});

// --- Pick 3 visibility ---------------------------------------------------

test("shouldShowPickThree is true when Today is empty", () => {
  assert.equal(shouldShowPickThree({ todayTaskCount: 0, lastOpenStr: "2026-05-01", today: "2026-05-01" }), true);
});

test("shouldShowPickThree is true with no record of a previous open", () => {
  assert.equal(shouldShowPickThree({ todayTaskCount: 2, lastOpenStr: "", today: "2026-05-01" }), true);
});

test("shouldShowPickThree is true on first open of a new day, even with tasks already on it", () => {
  assert.equal(shouldShowPickThree({ todayTaskCount: 2, lastOpenStr: "2026-04-30", today: "2026-05-01" }), true);
});

test("shouldShowPickThree is false once already opened today with tasks present", () => {
  assert.equal(shouldShowPickThree({ todayTaskCount: 2, lastOpenStr: "2026-05-01", today: "2026-05-01" }), false);
});

test("isWelcomeBack is false for a same-day or one-day gap", () => {
  assert.equal(isWelcomeBack({ lastOpenStr: "2026-05-01", today: "2026-05-01" }), false);
  assert.equal(isWelcomeBack({ lastOpenStr: "2026-04-30", today: "2026-05-01" }), false);
});

test("isWelcomeBack is true after a 3+ day gap", () => {
  assert.equal(isWelcomeBack({ lastOpenStr: "2026-04-27", today: "2026-05-01" }), true);
});

// --- pickThree -----------------------------------------------------------

const fixedRng = () => 0; // always picks index 0 — deterministic for tests

test("pickThree picks the nearest due date within 7 days first", () => {
  const today = "2026-05-01";
  const tasks = [
    { id: "far", status: "active", due_date: "2026-05-10", category: "A" },
    { id: "near", status: "active", due_date: "2026-05-03", category: "B" },
    { id: "ignored-done", status: "done", due_date: "2026-05-02", category: "C" },
  ];
  const picks = pickThree(tasks, today, fixedRng);
  assert.equal(picks[0].task.id, "near");
  assert.equal(picks[0].reason, "due soon");
});

test("pickThree ignores a due date more than 7 days out", () => {
  const today = "2026-05-01";
  const tasks = [{ id: "too-far", status: "active", due_date: "2026-05-20", category: "A" }];
  const picks = pickThree(tasks, today, fixedRng);
  assert.equal(picks.some((p) => p.reason === "due soon"), false);
});

test("pickThree includes a quick win (est_min <= 15)", () => {
  const today = "2026-05-01";
  const tasks = [
    { id: "long", status: "active", est_min: 60, category: "A" },
    { id: "quick", status: "active", est_min: 10, category: "B" },
  ];
  const picks = pickThree(tasks, today, fixedRng);
  assert.ok(picks.some((p) => p.task.id === "quick" && p.reason === "quick win"));
});

test("pickThree fills remaining slots from unscheduled active tasks, preferring fresh categories", () => {
  const today = "2026-05-01";
  const tasks = [
    { id: "due", status: "active", due_date: "2026-05-02", category: "Travel" },
    { id: "sameCat", status: "active", category: "Travel" },
    { id: "otherCat", status: "active", category: "Household" },
  ];
  const picks = pickThree(tasks, today, fixedRng);
  const ids = picks.map((p) => p.task.id);
  assert.ok(ids.includes("due"));
  assert.equal(ids.length, 3);
  // The fresh category (Household) should be preferred over the repeat (Travel)
  // when both are candidates for the same remaining slot.
  const fillIds = ids.filter((id) => id !== "due");
  assert.ok(fillIds.includes("otherCat"));
});

test("pickThree never returns more than 3 suggestions", () => {
  const today = "2026-05-01";
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    id: "t" + i, status: "active", category: "Cat" + i, est_min: 5,
  }));
  const picks = pickThree(tasks, today, fixedRng);
  assert.ok(picks.length <= 3);
});

test("pickThree returns nothing when there are no active tasks", () => {
  const picks = pickThree([{ id: "1", status: "done" }], "2026-05-01", fixedRng);
  assert.deepEqual(picks, []);
});

// --- week helpers -----------------------------------------------------

test("weekDates returns 7 consecutive days starting today", () => {
  const dates = weekDates("2026-05-01");
  assert.equal(dates.length, 7);
  assert.equal(dates[0], "2026-05-01");
  assert.equal(dates[6], "2026-05-07");
});

test("unscheduledActiveTasks only includes active tasks with no do_date", () => {
  const tasks = [
    { id: "1", status: "active", do_date: "" },
    { id: "2", status: "active", do_date: "2026-05-01" },
    { id: "3", status: "someday", do_date: "" },
  ];
  assert.deepEqual(unscheduledActiveTasks(tasks).map((t) => t.id), ["1"]);
});

test("filterTasksByText matches title, notes or category, case-insensitively", () => {
  const tasks = [
    { id: "1", title: "Buy Milk", notes: "", category: "Shopping & Groceries" },
    { id: "2", title: "Call bank", notes: "about the milk debt", category: "Finances & Subscriptions" },
    { id: "3", title: "Unrelated", notes: "", category: "Inbox" },
  ];
  const found = filterTasksByText(tasks, "milk");
  assert.deepEqual(found.map((t) => t.id).sort(), ["1", "2"]);
});

test("filterTasksByText with an empty query returns everything unchanged", () => {
  const tasks = [{ id: "1", title: "A" }];
  assert.deepEqual(filterTasksByText(tasks, ""), tasks);
});

test("inboxTasks returns only status:inbox tasks, oldest first", () => {
  const tasks = [
    { id: "1", status: "inbox", created_at: "2026-05-01T10:00:00.000Z" },
    { id: "2", status: "active", created_at: "2026-05-01T09:00:00.000Z" },
    { id: "3", status: "inbox", created_at: "2026-05-01T08:00:00.000Z" },
  ];
  assert.deepEqual(inboxTasks(tasks).map((t) => t.id), ["3", "1"]);
});

test("groupByCategory groups in fixed category order and drops empty ones", () => {
  const tasks = [
    { id: "1", category: "Inbox" },
    { id: "2", category: "Career & Learning" },
    { id: "3", category: "Career & Learning" },
    { id: "4", category: "Not A Real Category" }, // falls back to Inbox
  ];
  const groups = groupByCategory(tasks);
  const names = groups.map((g) => g[0]);
  assert.ok(names.indexOf("Career & Learning") < names.indexOf("Inbox"));
  const inboxGroup = groups.find((g) => g[0] === "Inbox");
  assert.equal(inboxGroup[1].length, 2); // id 1 and the unknown-category id 4
});

// --- sourceBadge (Phase 9) -------------------------------------------------

test("sourceBadge shows 'from calendar' with no time limit", () => {
  const task = { source: "calendar", created_at: "2020-01-01T00:00:00.000Z" };
  assert.equal(sourceBadge(task, Date.now()), "from calendar");
});

test("sourceBadge shows 'from voice' within 24h of created_at", () => {
  const now = Date.parse("2026-05-01T12:00:00.000Z");
  const task = { source: "voice", created_at: "2026-05-01T11:00:00.000Z" };
  assert.equal(sourceBadge(task, now), "from voice");
});

test("sourceBadge hides 'from voice' after 24h", () => {
  const now = Date.parse("2026-05-03T12:00:00.000Z");
  const task = { source: "voice", created_at: "2026-05-01T11:00:00.000Z" };
  assert.equal(sourceBadge(task, now), "");
});

test("sourceBadge shows nothing for a typed/ai task", () => {
  const task = { source: "ai", created_at: new Date().toISOString() };
  assert.equal(sourceBadge(task, Date.now()), "");
});

// --- summary -------------------------------------------------------------

console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
