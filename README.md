# thedarkknightcodes.github.io

# Central Task Planner

A zero-server, multi-device task planner and backlog organizer designed for cross-platform access across iPad, Android, Windows, and Mac.

## Architecture
- **Backend (Single Source of Truth):** Google Sheets
- **API Middleware:** Google Apps Script Web App (REST `doGet` and `doPost`)
- **Frontend:** Single-page vanilla HTML5 / Tailwind CSS hosted on GitHub Pages
- **State Management:** Optimistic local rendering synced asynchronously via `fetch`

## Database Schema (Google Sheet)
| Column | Name | Type | Notes |
| :--- | :--- | :--- | :--- |
| A | `id` | String | Unique ID (`TSK-XXX` or timestamp) |
| B | `task` | String | Task title |
| C | `category` | String | One of 9 primary categories |
| D | `subcategory` | String | Secondary group (e.g. Grooming, Refunds) |
| E | `status` | String | `Backlog`, `Scheduled`, or `Done` |
| F | `scheduled_day` | String | `Backlog`, `Sunday`, `Monday`, ... |
| G | `estimated_min` | Number | Duration in minutes |

## Visual Categorization Tokens
- **Career & Learning:** `Violet`
- **Finances & Subscriptions:** `Emerald`
- **Health & Personal Care:** `Rose`
- **Household & Chores:** `Amber`
- **Shopping & Groceries:** `Sky`
- **Holidays & Travel:** `Teal`
- **Leisure & Pending Experiences:** `Fuchsia`
- **Admin & Organization:** `Slate`
- **Relationship & Family:** `Pink`

## Instructions for LLM Collaborators
1. Keep dependencies zero-install: use CDN Tailwind and native Browser APIs only.
2. Google Apps Script redirects `POST` requests through a 302 code. Any `fetch` call saving to Google Apps Script must use `mode: "no-cors"` with `headers: { "Content-Type": "text/plain" }`.
3. Optimistic UI updates must always precede the backend `fetch` call to prevent network latency in drag-and-drop interactions.
