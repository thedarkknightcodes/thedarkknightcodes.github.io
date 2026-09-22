# What we built: weekly review (Phase 7)

## Why it's written by an outside reviewer, not the app itself

A weekly review needs judgement — which few things are actually worth
doing next, what's fine to let rest — and that's not something a pile of
`if` statements does well. So instead of the app guessing, it hands a
trimmed export of your tasks to an LLM (Gemini automatically, or Claude
via your own scheduled task) and asks for a short, structured verdict back.

## Why two writers, and why Claude wins

Gemini runs every Monday at 08:00 with no setup needed — a safety net that
always exists. Claude runs on your own schedule (Sunday evening, by
default) via a local scheduled task using your own subscription, and
writes the better review because it has more context. If both wrote a
review for the same week, Claude's is kept — Gemini's Monday run checks
first and quietly does nothing if Claude already got there.

## Why every review goes through one validation gate before saving

Neither writer is trusted blindly. `validateReview_` checks every review
before it touches the sheet: a missing summary rejects it outright, but
everything else is fixed rather than failed — an id that doesn't belong to
a real task (hallucinated, or for a task since dropped) is quietly left
out, and every list is clamped to its max length. This is what makes it
safe to save an LLM's output directly, with no human reviewing it first.

## Why the review never mentions how much is left undone

Same rule as the nightly digest: the summary is asked to name 1–3 concrete
wins and never a count of what's still open. The "Looks stale" list is the
one place a task could get dropped, so — unlike the other two lists — it
starts unticked. Nothing is ever deleted by mistake with a single tap.

## Why a review quietly expires instead of piling up

If a review sits unopened for more than 10 days, `review_get` stops
offering it — treating it exactly like "no review" rather than showing a
stale card about a week that's long gone. Dismissing it (or applying it)
does the same thing immediately, so at most one review is ever on screen.
