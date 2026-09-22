# What we built: share target + reminders (Phase 5 & 6)

## Why the share target reads three separate fields

Android's share sheet can hand a web app up to three pieces of text —
`title`, `text`, `url` — but every app fills them in differently. Chrome
shares a page as a title + a link; a lot of other apps (voice memos, Keep,
transcription apps) dump everything into `text` and leave the rest blank.
Rather than guess which one app you'll share from, the app reads all
three, drops any that are empty or duplicates of each other, and stitches
together whatever's actually there.

## Why the URL gets cleaned up before anything else happens

The shared text arrives as part of the page's own address
(`?title=...&text=...`). If that stayed in the address bar, reloading the
page — or the phone reopening an old tab later — would capture the exact
same thing a second time. So the very first thing that happens is
stripping those params out of the URL, before the app does anything with
what they said. After that, a shared capture behaves exactly like typing
into the box yourself.

## Why reminders live in their own Google Calendar

Every dated task gets a real calendar event now — but in a calendar called
**"Tasks"** that this app creates and manages itself, never your everyday
personal calendar. That's on purpose: this app should never be the reason
an unrelated meeting pops up in the wrong place, and you can hide or mute
the Tasks calendar independently any time without affecting anything else.

## Why a calendar problem can never lose a task

Calendar access is a separate step that happens *after* a task is already
safely saved to the sheet, and it's wrapped so that any failure — Calendar
being briefly down, a quota hiccup, anything — is only ever logged, never
allowed to undo or block the save that already happened.

## Why the nightly tidy fades things instead of flagging them

Once a day, anything left un-done on a day that's passed quietly goes back
to unscheduled (no "overdue" label — this app doesn't do those), and
anything untouched for three weeks fades to Someday. Nothing is ever
deleted, and the one-line 07:30 digest that follows only ever talks about
today — never how much is waiting.
