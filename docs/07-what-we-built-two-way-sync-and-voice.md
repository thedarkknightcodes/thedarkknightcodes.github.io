# What we built: two-way calendar sync + voice via Google Tasks (Phase 9)

## The problem

Reminders only ever flowed one way: change a task in the app, and a
calendar event appears. But real life happens in the calendar too — you
drag an event to tomorrow, or delete one, or a partner adds one straight
into the Tasks calendar — and none of that reached the app. And a lot of
"I just thought of something" moments happen with your hands full, where
the fastest tool isn't this app at all, it's saying it out loud to a
Google speaker or your phone.

## What changed

**Calendar, both ways now.** Moving an event in your Tasks calendar moves
the task's due date to match, within about 10 minutes. Deleting an event
just clears the task's due date — the task itself is never deleted, same
as everywhere else in this app. Adding a brand new event by hand creates a
new task for it, tagged "from calendar" so you know where it came from.

**Voice, via two ordinary Google Tasks lists.** "Hey Google, add renew
passport to my Planner Inbox list" runs it through the exact same AI
sorting as typing into the capture box, then the voice-only copy deletes
itself — Planner Inbox is a mailbox, not a real list. "Planner Today"
mirrors today's plan, so "what's on my Planner Today list?" reads it out,
and ticking one off there completes it in the app too.

## How it avoids going in circles

A moved event only updates the task when the EVENT was touched more
recently than the task itself — otherwise it's the task's own edit still
waiting to reach the calendar the normal way, not something to pull back.
And once the app pulls a change in from the calendar, it never writes that
same change straight back out to the event — that would be the app
talking to itself forever over one edit.

## What you'll notice

Two new lines in Settings explaining both halves in plain English. A task
that arrived by voice shows a small "from voice" note for its first day,
then it fades — you don't need reminding forever. A task from a hand-made
calendar event shows "from calendar" for as long as it exists, since
that's also where you'd go to change it. Nothing else about Today, Week or
Someday changed, and nothing is ever deleted by any of this.
