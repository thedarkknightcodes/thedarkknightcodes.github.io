# What we built: security (Phase 0)

**What was wrong before:** the app's URL — the address of the Google Apps
Script that reads and writes your Google Sheet — was hardcoded in plain
text inside `index.html`, which lived in a *public* GitHub repository.
Anyone who found that repo could see the URL and use it directly, with no
password, to read or change every task in the sheet. On top of that, saves
from the app used a fetch mode called `no-cors`, which tells the browser
"send this, but don't let my JavaScript see whether it worked." So the app
always showed "Synced" — even on a totally failed save.

**What a device key is:** a long, random password (64 random characters)
that lives only in your password manager and in your browser's local
storage on each device — never in the code, never in git. Every request to
the server now has to include it. The server checks it before doing
anything else, and refuses everything if it's missing or wrong. Losing the
URL is no longer enough to get in.

**What a CORS "simple request" is, in one paragraph:** normally, when a web
page calls a server on a different domain, the browser first sends a
background "is this even allowed?" check (called a preflight) before your
real request goes out — and Apps Script's Web Apps can't answer that check
the way a real API would. But a small category of request — a `POST` with
only a `Content-Type` of `text/plain` and nothing unusual in the headers —
counts as a "simple request" and skips the preflight entirely. That's why
our requests are deliberately kept plain and boring: it's what lets the
browser read the actual JSON response back, instead of just failing with no
explanation.

**What "try/catch, always return JSON" is for:** if the server code hits an
unexpected error and doesn't catch it, Google Apps Script's default
response is an HTML error page — which has no CORS permission headers on
it. The browser then refuses to show that page's contents to our
JavaScript at all, and all we'd see is a vague "Failed to fetch," with no
clue what actually went wrong. Wrapping the entire server function in one
big try/catch means *every* outcome — success, a wrong password, a bug in
our own code — comes back as readable JSON that the app can show you
plainly.
