# Task Planner

A personal task planner: capture tasks in one place, see what's relevant
today, and stop losing things in a giant backlog. Backed by a Google Sheet
(so the data is always yours and easy to look at directly) via a small
Google Apps Script backend, with a plain HTML/JS frontend on GitHub Pages —
no build step, no frameworks, no third-party scripts.

This is a rebuild-in-progress. The original version worked but had real
security and reliability problems (see `docs/00-what-we-built-security.md`
for the first one fixed). It's being replaced a phase at a time, with each
phase actually used for a while before the next one starts.

## Current status: Phase 0 — security + transport spike

Phase 0 replaces the backend with one that requires a device key on every
request and always replies with real, readable JSON (even when something
goes wrong) — and neutralises the old, unprotected deployment. It does not
yet do anything with real task data beyond reading it.

See the full phase list and architecture in the project plan (kept outside
this repo, with the person driving the rebuild).

## File map

| Path | What it is |
|---|---|
| `spike.html` / `spike.js` | Phase 0 connection-test page: save a device key, Ping the server, List tasks. |
| `config.js` | Public config — the Apps Script URL(s). Safe to commit (see comment in the file for why). |
| `apps-script/Code.gs` | The Google Apps Script backend (paste into the Apps Script editor). |
| `apps-script/appsscript.json` | The Apps Script project manifest (timezone, web app settings). |
| `index.html` | The old (pre-Phase-0) app. Kept for reference only — not deployed. |
| `docs/RUNBOOK.md` | Exact click-by-click steps: setup, deploying changes, rotating the device key, testing. |
| `docs/00-what-we-built-security.md` | Plain-English explanation of what Phase 0 fixed and why. |

## Getting started

Follow `docs/RUNBOOK.md`, section A, from the top. It assumes no prior
Apps Script experience.

## A note on secrets

Nothing in this repo should ever be a real secret. The device key lives
only in Script Properties (server side) and in each device's local
storage — never in a committed file. If you ever see a device key,
password, or other credential in a file in this repo, treat it as
compromised and rotate it (see `docs/RUNBOOK.md`, section E).
