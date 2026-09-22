# What we built: secretary mode (Phase 8)

## The problem

Even with AI capture, changing anything still meant knowing which SCREEN
to open — tap a task to move it, open Someday to park something. That's
exactly the small navigation friction that makes an ADHD brain give up on
a task manager: the less fiddling with the app itself, the better.

## What changed

The one capture box now understands three kinds of thing, not just one:

- **A brain-dump** ("renew passport by friday, buy soap") — creates tasks,
  same as before.
- **A command** ("move the dentist to friday", "I did the recycling",
  "put the photo albums in someday", "drop the spanish thing") — changes
  existing tasks.
- **A question** ("what's due this week?", "what should I do in the next
  20 minutes?") — gets a short, plain-English answer, no changes at all.

You can also mix them in one go ("I did the rubbish, and remind me to
call mum sunday") — the app sorts out which bits are which.

## How it decides, and how it stays safe

One backend action, `assist`, sends Gemini your wording plus a compact
list of your existing tasks (id, title, status, category, dates). Gemini
replies with new tasks to create, "ops" (changes) for existing tasks by
id, and/or a short reply. The app double-checks everything before it
touches your data: an id Gemini wasn't shown, or an unrecognised
operation, is quietly dropped, never guessed at. Unsure which task you
mean? It asks instead.

Nothing here is riskier than tapping through the screens yourself — every
change is the same kind of task update a hand-edit makes, so a misread
command is one **Undo** away (right in the reply card), and nothing is
ever deleted regardless.

## What you'll notice

The box says "Thinking…" while it works something out. A command or
question gets a small reply card under the box — dismissable, and it
fades on its own after a confirmation but stays for a question until you
close it. Nothing else about Today, Week or Someday changed.
