# Phase 2 — what we built and why

## Real dates, not weekday names

The old app stored tasks against a weekday ("Monday", "Tuesday"). That
sounds convenient but breaks down fast: it can't tell this Monday from
next Monday, so nothing could ever be "due", and nothing could roll
forward automatically. Every task now has real `YYYY-MM-DD` dates
(`do_date` for "show this on X day", `due_date` for "this actually needs
to happen by X day"). Real dates are what makes a Week view, a due-soon
suggestion, or a calendar reminder (later) possible at all.

## Why client-made ids make retries safe

Every task gets its id in the browser, before it's ever sent to the
server (a UUID, made by `crypto.randomUUID()`). That one choice is what
makes it safe to retry a failed save. If your connection drops right as
you tap Add, the app doesn't know whether the server got the request —
so it just tries again with the *same* id. The server checks "do I
already have a task with this id?" before creating anything, so a retry
either creates one task or finds the one it already made. Without a
client-made id, a retry would risk creating the same task twice.

## What "optimistic UI + queue" means

Tapping "done", dragging a task to tomorrow, or adding a task all update
the screen **immediately** — before the server has replied at all. That's
the "optimistic" part: the app assumes the save will work, because most
of the time it will, and waiting for a round-trip before showing anything
would make a phone on patchy signal feel broken.

Underneath, every change also gets written to a small queue
(`planner.queue` in this browser's storage) as an "op" — a description
of exactly one `add` or `update` call still owed to the server. The app
works through that queue in order, one at a time. If a call fails because
you're offline, the op just stays in the queue and gets retried later
(after 2, then 5, then 15, then 60 seconds, and again as soon as the
phone reconnects) — nothing is lost, and closing the app doesn't clear
the queue either, since it's saved to storage, not just memory.

## Why no overdue badges or counts

This app is deliberately built to never say "you have 14 things waiting"
or mark anything red for being late. Overdue badges are designed to
create urgency, and urgency is the opposite of what an ADHD-friendly tool
needs — a wall of red numbers makes it *harder* to start, not easier. A
task that didn't get done today just quietly stops being "on today"
(handled by the backend's nightly tidy-up) and waits, unjudged, in the
unscheduled list until you're ready for it. The only "count" anywhere in
the UI is the done-today line, and that one exists on purpose — it's the
one number designed to feel good.
