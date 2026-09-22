# What we built: AI capture (Phase 4)

## What "structured output" means

Normally, asking an AI a question gets you back a paragraph of text — great
to read, terrible to reliably pull data out of. "Structured output" is
asking the model to fill in a fixed shape instead (here: a list of tasks,
each with a title, category, and so on) and having it refuse to send back
anything else. We describe that shape once (in `GEMINI_RESPONSE_SCHEMA` in
`Code.gs`) and Gemini's API enforces it — so the code never has to guess-
parse free text or handle "the AI answered in the wrong format" as its own
category of bug.

## Why your raw text is logged before anything else

`doCapture` writes your ramble to the Log tab as its very first step —
before it even tries calling Gemini. If Gemini is down, the network drops,
or there's a bug in this code, your words are already sitting safely in the
spreadsheet. Nothing about "trying to be clever with AI" is allowed to be
the reason a thought gets lost. You can always open the Log tab and read
back exactly what you typed, no matter what happened next.

## What "fallback" means

If Gemini fails for any reason — down, a bad key, or a reply that doesn't
parse — the app doesn't show an error. It saves your **entire ramble as one
task**, dropped into the Inbox, with a gentle "you can split it later"
message instead of an alarming one. Nothing is lost, it just isn't tidied
up yet. You sort it by hand whenever you're ready, the same way you'd sort
any other Inbox item.

## Why the app never blocks on the AI

Gemini can take a few seconds to reply. Rather than make you sit and stare
at a spinner, the app confirms your capture *instantly* ("Got it ✓") and
gets on with sorting it in the background — you can keep typing the next
thing straight away. A small "Sorting…" row shows what's still in flight,
and disappears once the tasks land. If you're offline, the ramble just
waits in the outgoing queue (the same one everything else in this app
already uses) until there's a signal — it isn't sent anywhere, and isn't
lost, until then.
